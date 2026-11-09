const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Use the actual ZIP engine and session queue. Only the clock and host ACK
// timing are controlled; no importer or watchdog behavior is mocked.
const zipTests = fs.readFileSync(path.join(__dirname, "zipBlobSource.test.js"), "utf8");
let zipHost = zipTests.slice(0, zipTests.indexOf('test("')) + zipTests.slice(
  zipTests.indexOf("function engineHost("), zipTests.indexOf('test("engine reuses'));
zipHost = zipHost.replace("if (message.requestId) queueMicrotask", 'if (message.requestId && message.type !== "import-page-end") queueMicrotask');
zipHost = zipHost.replace("return { engine, sent, results, progress };", "return { engine, sent, results, progress, deliver };");
const { engineHost, archive, trackedFile, packageFiles } = new Function("require", "__dirname", zipHost +
  "\nreturn { engineHost, archive, trackedFile, packageFiles };"
)(require, __dirname);

function clock() {
  let now = 1000000, id = 0;
  const timers = new Map();
  class ClockDate extends Date { static now() { return now; } }
  const globals = {
    Date: ClockDate,
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout(key) { timers.delete(key); }
  };
  return { globals, async advance(ms) {
    const until = now + ms;
    for (;;) {
      const first = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      now = first[1].at;
      timers.delete(first[0]);
      first[1].callback();
      await new Promise(resolve => setImmediate(resolve));
    }
    now = until;
    await new Promise(resolve => setImmediate(resolve));
  } };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), "expected actual engine/session operation to reach its boundary");
}

async function waitingPage() {
  const timer = clock(), host = engineHost({ globals: timer.globals });
  host.deliver({ type: "init", receiverVersion: "2026.11.05-restore.3" });
  const preview = await host.engine.parseFiles([trackedFile(archive(packageFiles()))]);
  let outcome;
  const running = host.engine.startImport(preview.pages.map(page => page.id)).then(
    () => { outcome = { ok: true }; }, error => { outcome = { error: error.message }; });
  await waitFor(() => host.sent.some(message => message.type === "import-page-end"));
  const request = host.sent.find(message => message.type === "import-page-end");
  return { ...host, timer, request, running, outcome: () => outcome,
    progressMessage(extra = {}) {
      host.deliver({ type: "progress", transferId: request.transferId, pageIndex: request.pageIndex,
        requestId: request.requestId, receiverVersion: "2026.11.05-restore.3", pageName: "first",
        stage: "restore", current: 1, total: 2, ...extra });
    },
    ack(message = request) {
      host.deliver({ type: "import-ack", transferId: message.transferId, requestId: message.requestId, success: true });
    }
  };
}

test("a slow page with real scoped restore/layout increments survives the former fixed deadline", async () => {
  const h = await waitingPage();
  await h.timer.advance(110000);
  h.progressMessage();
  await h.timer.advance(110000);
  assert.equal(h.outcome(), undefined, "real progress must extend the no-progress window");
  h.progressMessage({ stage: "postprocess", postprocessCurrent: 0.5 });
  await h.timer.advance(110000);
  assert.equal(h.outcome(), undefined);
  h.ack();
  await waitFor(() => h.sent.filter(message => message.type === "import-page-end").length === 2);
  h.ack(h.sent.findLast(message => message.type === "import-page-end"));
  await h.running;
  assert.deepEqual(h.outcome(), { ok: true });
  assert.equal(h.results.length, 1);
  assert.equal(h.sent.some(message => message.type === "import-session-abort"), false);
});

test("a page without completed-work increments times out, requests abort and reports real diagnostics", async () => {
  const h = await waitingPage();
  h.progressMessage({ current: 0, operationLabel: "waiting for actual work" });
  await h.timer.advance(120000);
  assert.ok(h.outcome(), "the no-progress deadline must settle the import");
  await h.running;
  assert.match(h.outcome().error, /页面还原超时.*first.*无进展/);
  assert.match(h.outcome().error, /0\/2.*waiting for actual work.*2026\.11\.05-restore\.3/);
  assert.equal(h.sent.filter(message => message.type === "import-session-abort").length, 1);
  assert.equal(h.sent.some(message => message.type === "import-session-complete"), false);
});

test("repeated counters, changing labels, wrong session/page/request and unscoped legacy progress cannot renew a page", async () => {
  const h = await waitingPage();
  await h.timer.advance(10000);
  h.progressMessage();
  await h.timer.advance(119000);
  assert.equal(h.outcome(), undefined);
  for (const extra of [
    { operationLabel: "different label" },
    { current: 2, transferId: "stale" },
    { current: 2, pageIndex: 1 },
    { current: 2, requestId: "another-request" },
    { current: 2, pageIndex: undefined, requestId: undefined },
    { current: 2, stage: "fonts" }
  ]) h.progressMessage(extra);
  await h.timer.advance(1000);
  assert.ok(h.outcome(), "irrelevant progress must not postpone the deadline");
  await h.running;
  assert.match(h.outcome().error, /无进展/);
  assert.equal(h.sent.filter(message => message.type === "import-session-abort").length, 1);
});

test("continuous genuine layout increments cannot extend a page beyond the 45 minute hard limit", async () => {
  const h = await waitingPage();
  h.progressMessage();
  for (let minute = 1; minute <= 44; minute++) {
    await h.timer.advance(60000);
    h.progressMessage({ stage: "postprocess", postprocessCurrent: minute / 100 });
    assert.equal(h.outcome(), undefined, `page should still be active at minute ${minute}`);
  }
  await h.timer.advance(60000);
  assert.ok(h.outcome(), "the hard deadline must settle the import");
  await h.running;
  assert.match(h.outcome().error, /页面还原超时.*总上限/);
  assert.equal(h.sent.filter(message => message.type === "import-session-abort").length, 1);
});

test("the page-end request preserves the real record count after chunk ownership is released", async () => {
  const h = await waitingPage();
  const actual = h.sent.filter(message => message.type === "import-page-chunk" && message.pageIndex === 0)
    .reduce((sum, message) => sum + message.records.length, 0);
  assert.equal(h.request.recordCount, actual);
  assert.equal(actual, 1);
  h.ack();
  await waitFor(() => h.sent.filter(message => message.type === "import-page-end").length === 2);
  h.ack(h.sent.findLast(message => message.type === "import-page-end"));
  await h.running;
});

function sessionHost() {
  let source = fs.readFileSync(path.join(__dirname, "dependencyPageImport.test.js"), "utf8").split('test("')[0];
  return new Function("require", "__dirname", source + "\nreturn {createHost,record,page,start,transferPage,complete};")(require, __dirname);
}

test("real main-thread page progress carries the active page request identity and receiver version", async () => {
  const api = sessionHost(), h = api.createHost();
  const records = [api.record("frame", "FRAME")], page = api.page("Scoped page", records);
  await api.start(h, [page]);
  await h.send({ type: "import-page-start", pageIndex: 0, page });
  await h.send({ type: "import-page-chunk", pageIndex: 0, records });
  await h.send({ type: "import-page-end", pageIndex: 0, requestId: "page-end-42" });
  const progress = h.messages.filter(message => message.type === "progress" && message.pageIndex === 0);
  assert.ok(progress.length > 1);
  for (const message of progress) {
    assert.equal(message.requestId, "page-end-42");
    assert.equal(message.receiverVersion, "2026.11.06-r4.0");
    assert.equal(message.pageName, "Scoped page");
  }
});

test("an abort received during an awaited host call stops node creation and retains the partial page", async () => {
  const api = sessionHost(), h = api.createHost();
  const records = Array.from({ length: 10 }, (_, index) => api.record(`frame-${index}`, "FRAME"));
  const page = api.page("Interrupted", records);
  await api.start(h, [page]);
  let resume, reached, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; });
  const original = h.figma.setCurrentPageAsync;
  h.figma.setCurrentPageAsync = async current => {
    if (current.name === "Interrupted" && !pausedOnce) { pausedOnce = true; reached(); await new Promise(resolve => { resume = resolve; }); }
    return original(current);
  };
  await h.send({ type: "import-page-start", pageIndex: 0, page });
  await h.send({ type: "import-page-chunk", pageIndex: 0, records });
  const restoring = h.send({ type: "import-page-end", pageIndex: 0, requestId: "interrupted-page" });
  await paused;
  const aborted = h.send({ type: "import-session-abort", requestId: "abort-page", error: "no real progress" });
  resume();
  await restoring;
  await aborted;
  assert.equal(h.calls.createFrame, 0, "the queued abort must be observed before any subsequent node is created");
  assert.equal(h.figma.root.children.length, 2);
  const partialPage = h.figma.root.children[1];
  assert.equal(partialPage.name, "Interrupted");
  assert.deepEqual(partialPage.children, []);
  assert.equal(h.figma.currentPage, partialPage);
  assert.equal(h.previousPage.removed, false);
  assert.equal(h.messages.findLast(message => message.type === "import-ack" && message.requestId === "interrupted-page").success, false);
  const abortAck = h.messages.findLast(message => message.type === "import-ack" && message.requestId === "abort-page");
  assert.equal(abortAck.success, true);
  assert.equal(abortAck.retainedImport.partialPageCount, 1);
  assert.equal(abortAck.retainedImport.completedSourceRecordCount, 0);
  const next = api.page("Next", [api.record("next", "FRAME")]);
  await api.start(h, [next], { transferId: "retry" });
  for (const message of [{ type: "import-page-start", pageIndex: 0, page: next },
    { type: "import-page-chunk", pageIndex: 0, records: [api.record("next", "FRAME")] },
    { type: "import-page-end", pageIndex: 0 }, { type: "import-session-complete" }]) await h.send({ ...message, transferId: "retry" });
  assert.ok(h.messages.some(message => message.type === "complete" && message.transferId === "retry"));
});
