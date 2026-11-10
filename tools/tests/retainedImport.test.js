const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Exercise the real session/chunk importer with the existing small Figma host.
// These assertions replace the old all-or-nothing policy at the user's request.
const source = fs.readFileSync(path.join(__dirname, "dependencyPageImport.test.js"), "utf8").split("\ntest(")[0];
const { createHost, record, page, start, transferPage, complete } = new Function(
  "require", "__dirname", source + "\nreturn { createHost, record, page, start, transferPage, complete };"
)(require, __dirname);

function assertRetainedSummary(host, message, sourcePages, statuses, counts) {
  const summary = message?.retainedImport;
  assert.ok(summary && typeof summary === "object", "the terminating message must explain the content it kept");
  assert.equal(summary.status, counts.status || "partial");
  assert.equal(summary.pages.length, sourcePages.length);
  assert.deepEqual(summary.pages.map(item => item.status), statuses);
  for (let index = 0; index < sourcePages.length; index++) {
    const sourcePage = sourcePages[index];
    const item = summary.pages[index];
    assert.equal(item.sourcePageId, sourcePage.id);
    assert.equal(item.sourcePageName, sourcePage.name);
    assert.equal(item.sourceRecordCount, sourcePage.layerCount);
    if (item.status === "pending") {
      assert.equal(item.targetPageId, null);
      assert.equal(item.targetPageName, null);
    } else {
      assert.equal(typeof item.targetPageId, "string");
      const retained = host.figma.root.children.find(node => node.id === item.targetPageId);
      assert.ok(retained && !retained.removed, "every advertised target must still exist");
      assert.equal(item.targetPageName, retained.name);
    }
  }
  for (const status of ["completed", "partial", "pending"]) {
    assert.equal(summary[status + "PageCount"], statuses.filter(value => value === status).length);
  }
  assert.equal(summary.retainedPageCount, statuses.filter(value => value !== "pending").length);
  assert.equal(summary.completedSourceRecordCount, sourcePages.reduce((sum, item, index) => sum + (statuses[index] === "completed" ? item.layerCount : 0), 0));
  assert.equal(summary.totalSourceRecordCount, sourcePages.reduce((sum, item) => sum + item.layerCount, 0));
  assert.equal(summary.reportedRestoredRecordCount, counts.reportedRestoredRecordCount);
  assert.ok(Array.isArray(summary.cleanupWarnings));
  assert.ok(summary.cleanupWarnings.every(warning => typeof warning === "string"));
  return summary;
}

test("a later restore failure preserves completed pages and valid nodes in the partial page", async () => {
  const host = createHost();
  const existingNode = host.figma.createFrame();
  existingNode.name = "user-owned existing node";
  host.previousPage.appendChild(existingNode);
  const records = [[record("shared", "COMPONENT")],
    [record("valid-before-error", "FRAME"), record("bad", "UNSUPPORTED")]];
  const pages = [page("Dependencies", records[0], true), page("Partial", records[1])];
  await start(host, pages);
  await transferPage(host, 0, pages[0], records[0]);
  const completedPage = host.figma.root.children[1];
  const master = completedPage.children[0];
  await transferPage(host, 1, pages[1], records[1]);
  const failure = host.messages.findLast(message => message.type === "import-ack" && message.success === false);
  assert.ok(failure, "invalid node must remain an error");
  assert.equal(completedPage.removed, false, "a later page must not erase an already imported dependency page");
  assert.equal(master.removed, false);
  const partial = host.figma.root.children.find(node => node !== host.previousPage && node !== completedPage);
  assert.ok(partial && !partial.removed, "keep the valid content produced before the failed node");
  assert.deepEqual(partial.children.map(node => node.name), ["valid-before-error"]);
  assert.equal(existingNode.removed, false);
  assert.equal(existingNode.parent, host.previousPage);
  assert.equal(host.messages.some(message => message.type === "complete"), false, "retention is not whole-file success");
  assertRetainedSummary(host, failure, pages, ["completed", "partial"], { reportedRestoredRecordCount: 2 });
});

test("a final viewport failure cannot delete all successfully restored content", async () => {
  const host = createHost({ failFinalizeViewport: true });
  const records = [[record("master", "COMPONENT")], [record("design", "FRAME")]];
  const pages = records.map((items, index) => page(`Page ${index}`, items, index === 0));
  await start(host, pages);
  for (let i = 0; i < pages.length; i++) await transferPage(host, i, pages[i], records[i]);
  const imported = host.figma.root.children.slice(1);
  await complete(host);
  assert.ok(host.messages.some(message => message.type === "error"), "final failure must still be reported");
  assert.ok(imported.every(node => !node.removed), "finishing/viewport errors must preserve imported pages");
  assert.deepEqual(imported.map(node => node.children[0].name), ["master", "design"]);
  assert.equal(host.previousPage.removed, false);
  const failure = host.messages.findLast(message => message.type === "error");
  assertRetainedSummary(host, failure, pages, ["completed", "completed"], { reportedRestoredRecordCount: 2 });
  assert.equal(host.messages.some(message => message.type === "complete"), false);
});

test("abort retains a completed page and materializes promised-instance fallback children", async () => {
  const host = createHost();
  const instanceRecords = [record("instance", "INSTANCE", { mainComponentId: "later-master", childIds: ["override"] }),
    record("override", "FRAME", { parentId: "instance" })];
  const laterRecords = [record("later-master", "COMPONENT")];
  const pages = [page("Retained design", instanceRecords), page("Not yet sent", laterRecords)];
  await start(host, pages, { componentIds: ["later-master"] });
  await transferPage(host, 0, pages[0], instanceRecords);
  const design = host.figma.root.children[1];
  assert.equal(design.children[0].children.length, 0, "precondition: unresolved promised master uses a light shell");
  await host.send({ type: "import-session-abort", error: "upstream transport failed" });
  assert.equal(design.removed, false, "an upstream abort cannot remove the imported page");
  assert.equal(design.children[0].children[0]?.name, "override", "retained shell must not lose deferred editable content");
  assert.equal(host.figma.root.children.some(node => node.name === "Not yet sent"), false);
  const abort = host.messages.findLast(message => message.type === "import-ack");
  assert.equal(abort.success, true, "the cleanup request can complete while the import itself remains partial");
  const summary = assertRetainedSummary(host, abort, pages, ["completed", "pending"], { reportedRestoredRecordCount: 2 });
  assert.deepEqual(summary.cleanupWarnings, []);
});

test("the UI catch's follow-up abort cannot erase retained content and the session can be retried", async () => {
  const host = createHost();
  const good = [record("retained", "FRAME")];
  const bad = [record("bad", "UNSUPPORTED")];
  const pages = [page("Good", good), page("Bad", bad)];
  await start(host, pages);
  await transferPage(host, 0, pages[0], good);
  const retained = host.figma.root.children[1];
  await transferPage(host, 1, pages[1], bad);
  const failedAck = host.messages.findLast(message => message.type === "import-ack" && message.success === false);
  const failureSummary = assertRetainedSummary(host, failedAck, pages, ["completed", "partial"], { reportedRestoredRecordCount: 1 });
  await host.send({ type: "import-session-abort", error: "forwarded UI error" });
  assert.equal(retained.removed, false);
  const repeatedAbort = host.messages.findLast(message => message.type === "import-ack");
  assert.equal(repeatedAbort.success, true);
  assert.deepEqual(repeatedAbort.retainedImport, failureSummary, "same-transfer cleanup must return the cached retention summary");
  const retry = page("Retry", []);
  await host.send({ type: "import-session-start", transferId: "retry", totalPages: 1, totalNodes: 0,
    manifest: { schema: "mastergo2figma.package.v2", version: 2, pages: [retry], assets: {} } });
  const retryAck = host.messages.findLast(message => message.type === "import-ack" && message.transferId === "retry");
  assert.equal(retryAck.success, true, "failed session must release state and pending buffers for a later run");
  await host.send({ type: "import-session-abort", error: "stale old transfer cleanup" });
  const staleAbort = host.messages.findLast(message => message.type === "import-ack" && message.transferId === "test");
  assert.equal(staleAbort.success, true);
  assert.deepEqual(staleAbort.retainedImport, failureSummary);
  await host.send({ type: "import-page-start", transferId: "retry", pageIndex: 0, page: retry });
  await host.send({ type: "import-page-end", transferId: "retry", pageIndex: 0 });
  await host.send({ type: "import-session-complete", transferId: "retry" });
  const retryComplete = host.messages.findLast(message => message.type === "complete" && message.transferId === "retry");
  assert.ok(retryComplete, "a stale old abort must not terminate the new transfer");
  assert.equal(retained.removed, false);
});

test("a failure before any target page exists reports pending pages and no retained content", async () => {
  const host = createHost({ failFonts: true });
  const pages = [page("Unstarted", [record("unused", "FRAME")])];
  await start(host, pages, { fontRequests: [{ family: "Unavailable", style: "Regular" }] });
  const failure = host.messages.findLast(message => message.type === "import-ack" && message.success === false);
  assert.ok(failure);
  assertRetainedSummary(host, failure, pages, ["pending"], { status: "failed", reportedRestoredRecordCount: 0 });
  assert.deepEqual(host.figma.root.children, [host.previousPage]);
});

test("fallback cleanup errors keep already materialized children and identify incomplete cleanup", async () => {
  const host = createHost();
  const deferred = [record("instance", "INSTANCE", { mainComponentId: "later-master", childIds: ["kept-child", "bad-child"] }),
    record("kept-child", "FRAME", { parentId: "instance" }), record("bad-child", "UNSUPPORTED", { parentId: "instance" })];
  const later = [record("later-master", "COMPONENT")];
  const pages = [page("Deferred design", deferred), page("Not sent", later)];
  await start(host, pages, { componentIds: ["later-master"] });
  await transferPage(host, 0, pages[0], deferred);
  const design = host.figma.root.children[1];
  await host.send({ type: "import-session-abort", error: "transport stopped before master" });
  assert.equal(design.removed, false);
  const shell = design.children[0];
  assert.equal(shell.removed, false);
  assert.equal(shell.children[0]?.name, "kept-child", "a later invalid child cannot clear a successful fallback sibling");
  const abort = host.messages.findLast(message => message.type === "import-ack");
  assert.equal(abort.success, true);
  assert.ok(abort.retainedImport?.cleanupWarnings.length > 0);
  assert.ok(abort.retainedImport.cleanupWarnings.every(item => typeof item === "string"));
  assert.equal(abort.retainedImport.pages[0].status, "partial", "a missing deferred child cannot leave its page marked completed");
  assert.equal(abort.retainedImport.completedSourceRecordCount, 0);
  assert.equal(host.messages.some(message => message.type === "complete"), false);
});

test("the real report storage preserves completed, partial and pending targets for a later plugin opening", async () => {
  const host = createHost();
  const saved = new Map();
  host.figma.clientStorage = {
    getAsync: async key => saved.get(key),
    setAsync: async (key, value) => { saved.set(key, structuredClone(value)); }
  };
  const records = [[record("good", "FRAME")], [record("bad", "UNSUPPORTED")], [record("not-started", "FRAME")]];
  const pages = records.map((items, index) => page(`Source ${index}`, items));
  await start(host, pages);
  await transferPage(host, 0, pages[0], records[0]);
  await transferPage(host, 1, pages[1], records[1]);
  const failure = host.messages.findLast(message => message.type === "import-ack" && message.success === false);
  const summary = assertRetainedSummary(host, failure, pages, ["completed", "partial", "pending"], { reportedRestoredRecordCount: 1 });
  const stored = saved.get("mastergo2figma.receive.lastImportReport.v1");
  assert.ok(stored, "partial results must leave a durable import receipt");
  assert.deepEqual(stored.performanceReport.retainedImport, summary);
  assert.equal(stored.performanceReport.sourceRecordCount, 3, "sourceRecordCount describes source scope, not created nodes");
  assert.equal(stored.performanceReport.retainedImport.completedSourceRecordCount, 1);
  assert.notEqual(stored.performanceReport.apiCreationCount, stored.performanceReport.retainedImport.completedSourceRecordCount);
  // ui-ready takes the same readImportReport path used by a later plugin UI.
  await host.send({ type: "ui-ready" });
  const reopened = host.messages.findLast(message => message.type === "init");
  assert.ok(reopened?.lastImportReport);
  assert.deepEqual(reopened.lastImportReport.performanceReport.retainedImport, summary);
  assert.equal(reopened.lastImportReport.performanceReport.retainedImport.pages[0].targetPageId, host.figma.root.children[1].id);
});

test("final deferred materialization failures mark the owning page partial after the entry leaves its queue", async () => {
  const host = createHost({ failInstances: true });
  const records = [[record("instance", "INSTANCE", { mainComponentId: "master", childIds: ["kept", "bad"] }),
    record("kept", "FRAME", { parentId: "instance" }), record("bad", "UNSUPPORTED", { parentId: "instance" })],
    [record("master", "COMPONENT")]];
  const pages = records.map((items, index) => page(`Page ${index}`, items));
  await start(host, pages, { componentIds: ["master"] });
  for (let index = 0; index < pages.length; index++) await transferPage(host, index, pages[index], records[index]);
  await complete(host);
  const failure = host.messages.findLast(message => message.type === "error");
  assert.ok(failure);
  assert.equal(host.figma.root.children[1].children[0].children[0].name, "kept");
  assert.equal(failure.retainedImport.pages[0].status, "partial");
  assert.equal(failure.retainedImport.pages[1].status, "completed");
  assert.equal(failure.retainedImport.completedSourceRecordCount, 1);
  assert.ok(failure.retainedImport.cleanupWarnings.length > 0);
});
