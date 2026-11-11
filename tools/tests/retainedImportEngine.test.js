const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const validation = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

// Reuse the ZIP fixtures/loader, then run the real parser and transport engine.
const zipHelpers = fs.readFileSync(path.join(__dirname, "zipBlobSource.test.js"), "utf8").split('test("')[0];
const { loadModule, archive, trackedFile, packageFiles } = new Function("require", "__dirname", zipHelpers +
  "\nreturn { loadModule, archive, trackedFile, packageFiles };")(require, __dirname);

function retained(status = "partial") {
  const partial = status === "partial";
  return { status, pages: ["first", "second", "third"].map((id, index) => ({
    sourcePageId: `zip_0_${id}`, sourcePageName: id,
    targetPageId: partial && index < 2 ? `target-${id}` : null,
    targetPageName: partial && index < 2 ? `Target ${id}` : null,
    status: partial && index === 0 ? "completed" : partial && index === 1 ? "partial" : "pending",
    sourceRecordCount: 1,
  })), completedPageCount: partial ? 1 : 0, partialPageCount: partial ? 1 : 0,
  pendingPageCount: partial ? 1 : 3, retainedPageCount: partial ? 2 : 0,
  completedSourceRecordCount: partial ? 1 : 0, reportedRestoredRecordCount: partial ? 1 : 0,
  totalSourceRecordCount: 3, cleanupWarnings: [] };
}

function sourceFile() {
  const files = packageFiles();
  const manifest = files.find(file => file.name === "manifest.json").data;
  manifest.pages.push({ id: "third", name: "third", pageFile: "third/index.json", layerCount: 1 });
  manifest.stats.layerCount = 3;
  files.push({ name: "third/index.json", data: { schema: "mastergo2figma.page.v2", version: 2,
    id: "third", name: "third", rootNodeIds: ["third-node"], layerChunks: ["third/layers.json"] } },
  { name: "third/layers.json", data: { schema: "mastergo2figma.layers.v2", version: 2, pageId: "third",
    records: [{ id: "third-node", parentId: null, childIds: [], props: { type: "FRAME" } }] } });
  return trackedFile(archive(files));
}

async function host(onSend, file = sourceFile()) {
  const sent = [], results = [], errors = [];
  const window = { MasterGoMg: { isMgPackage: () => false }, MasterGoPackageValidation: validation };
  const deliver = message => window.onmessage({ data: { pluginMessage: message } });
  const parent = { postMessage({ pluginMessage }) {
    const message = structuredClone(pluginMessage);
    sent.push(message);
    if (onSend?.(message, deliver) === false) return;
    if (message.requestId) queueMicrotask(() => deliver({ type: "import-ack", requestId: message.requestId,
      transferId: message.transferId, success: true }));
    if (message.type === "import-session-complete") queueMicrotask(() => deliver({ type: "complete",
      transferId: message.transferId, pageCount: 3, layerCount: 3 }));
  } };
  const engine = loadModule("../../ReceiveFromMasterGo/ui-src/engine.js", { window, parent });
  engine.initEngine({ onComplete: value => results.push(value), onImportError: (message, summary) => errors.push({ message, summary }) });
  const preview = await engine.parseFiles([file]);
  return { engine, sent, results, errors, deliver, preview,
    run: () => engine.startImport(preview.pages.map(page => page.id)),
  };
}

function ack(message, extra) {
  return { type: "import-ack", requestId: message.requestId, transferId: message.transferId, ...extra };
}
const rejection = promise => promise.then(() => assert.fail("import must not succeed"), error => error);

test("failed page ACK preserves retained summary and stops before pending pages without false completion", async () => {
  const summary = retained();
  const h = await host((message, deliver) => {
    if (message.type !== "import-page-end" || message.pageIndex !== 1) return;
    queueMicrotask(() => deliver(ack(message, { success: false, error: "page restore failed", retainedImport: summary })));
    return false;
  });
  const error = await rejection(h.run());
  assert.equal(error.message, "page restore failed");
  assert.deepEqual(error.retainedImport, summary);
  assert.deepEqual(h.sent.filter(message => message.type === "import-page-start").map(message => message.pageIndex), [0, 1]);
  assert.equal(h.sent.some(message => message.type === "import-session-complete"), false);
  assert.equal(h.results.length, 0);
  assert.equal(h.engine.hasPackage(), true);
});

test("abort ACK can enrich a legacy failure while preserving the original error", async () => {
  const summary = retained();
  const h = await host((message, deliver) => {
    if (message.type === "import-page-end" && message.pageIndex === 1) {
      queueMicrotask(() => deliver(ack(message, { success: false, error: "original transport error" })));
      return false;
    }
    if (message.type === "import-session-abort") {
      queueMicrotask(() => deliver(ack(message, { success: true, retainedImport: summary })));
      return false;
    }
  });
  const error = await rejection(h.run());
  assert.equal(error.message, "original transport error");
  assert.deepEqual(error.retainedImport, summary);
  assert.equal(h.sent.filter(message => message.type === "import-session-abort").length, 1);
  assert.equal(h.results.length, 0);
});

test("an ACK with a matching request but wrong transfer cannot poison the current rejection or its summary", async () => {
  const summary = retained();
  const h = await host((message, deliver) => {
    if (message.type !== "import-page-end" || message.pageIndex !== 1) return;
    queueMicrotask(() => {
      deliver(ack(message, { transferId: "stale-transfer", success: false, error: "foreign error", retainedImport: retained("failed") }));
      deliver(ack(message, { success: false, error: "current error", retainedImport: summary }));
    });
    return false;
  });
  const error = await rejection(h.run());
  assert.equal(error.message, "current error");
  assert.deepEqual(error.retainedImport, summary);
});

test("final error forwards retained state, ignores other transfers and cannot later become a success", async () => {
  const summary = retained();
  const h = await host((message, deliver) => {
    if (message.type !== "import-page-end" || message.pageIndex !== 1) return;
    queueMicrotask(() => {
      deliver({ type: "error", transferId: "old-transfer", message: "foreign final", retainedImport: retained("failed") });
      deliver({ type: "error", transferId: message.transferId, message: "current final", retainedImport: summary });
    });
    return false;
  });
  const error = await rejection(h.run());
  assert.equal(error.message, "current final");
  assert.deepEqual(error.retainedImport, summary);
  assert.deepEqual(h.errors, [{ message: "current final", summary }]);
  h.deliver({ type: "complete", pageCount: 3, layerCount: 3 });
  assert.equal(h.results.length, 0, "late unscoped legacy completion must not replace the failure");
});

test("a failed retained summary stays failed, while legacy errors remain readable without invented retained state", async () => {
  for (const summary of [retained("failed"), undefined]) {
    const h = await host((message, deliver) => {
      if (message.type !== "import-page-end") return;
      queueMicrotask(() => deliver(ack(message, { success: false, error: "legacy-compatible error",
        ...(summary ? { retainedImport: summary } : {}) })));
      return false;
    });
    const error = await rejection(h.run());
    assert.equal(error.message, "legacy-compatible error");
    assert.deepEqual(error.retainedImport, summary);
    assert.equal(h.results.length, 0);
  }
});

test("parsed original page IDs remain selectable after an interrupted subset without reparsing the file", async () => {
  let failures = 1;
  const h = await host((message, deliver) => {
    if (message.type !== "import-page-end" || !failures) return;
    failures--;
    queueMicrotask(() => deliver(ack(message, { success: false, error: "subset stopped", retainedImport: retained() })));
    return false;
  });
  await rejection(h.engine.startImport([h.preview.pages[0].id]));
  await h.engine.startImport([h.preview.pages[2].id]);
  assert.equal(h.sent.filter(message => message.type === "import-session-start").length, 2);
  assert.equal(h.results.length, 1);
});

const appHelpers = fs.readFileSync(path.join(__dirname, "importProgressR3Ui.test.js"), "utf8")
  .split("const progressView")[0]
  .replace("resetPackage() {},", "hasPackage() { return true; }, resetPackage() {},")
  .replace("return { render, copied, intervals,", "return { engine, render, copied, intervals,");
const appApi = new Function("require", "__dirname", appHelpers +
  "\nreturn { host, find, React, renderToStaticMarkup };")(require, __dirname);

function appHost() {
  const h = appApi.host();
  let resets = 0;
  h.engine.hasPackage = () => true;
  h.engine.resetPackage = () => { resets++; };
  h.engine.parseFiles = async files => ({ fileNames: files.map(file => file.name), documentName: "Retained fixture",
    pageCount: 3, layerCount: 3, pages: retained().pages.map(page => ({ id: page.sourcePageId,
      name: page.sourcePageName, displayName: page.sourcePageName, layerCount: 1 })) });
  Object.defineProperty(h, "resets", { get: () => resets });
  return h;
}

test("retained App error lists real targets and returns to only pending selections without resetting the source", async () => {
  const h = appHost();
  await h.importing();
  h.callbacks.onImportError("page restore interrupted", retained());
  const errorView = appApi.find(h.render(), element => element.props?.error?.kind === "import");
  assert.ok(errorView);
  const markup = appApi.renderToStaticMarkup(appApi.React.createElement(errorView.type, errorView.props));
  assert.match(markup, /导入中断，已保留部分内容/);
  assert.match(markup, /target-first/);
  assert.match(markup, /target-second/);
  assert.match(markup, /已完成|完成页/);
  assert.match(markup, /部分保留/);
  assert.match(markup, /未开始/);
  assert.match(markup, /下载.*JSON/);
  assert.doesNotMatch(markup, /已回滚|会回滚|迁移完成/);
  assert.equal(typeof errorView.props.onReturn, "function");
  errorView.props.onReturn();
  const parsed = appApi.find(h.render(), element => element.props?.selected instanceof Set);
  assert.deepEqual([...parsed.props.selected], ["zip_0_third"]);
  assert.equal(h.resets, 0);
  assert.equal(h.starts, 1, "returning to selection must not start another import");
  const parsedMarkup = appApi.renderToStaticMarkup(appApi.React.createElement(parsed.type, parsed.props));
  assert.match(parsedMarkup, /再次选择.*新增|重新选择.*新增/);
});

test("no pending pages means no automatic import and an empty selection until the user explicitly chooses", async () => {
  const h = appHost();
  await h.importing();
  const summary = retained();
  summary.pages = summary.pages.filter(page => page.status !== "pending");
  summary.pendingPageCount = 0;
  h.callbacks.onImportError("stopped on last page", summary);
  const errorView = appApi.find(h.render(), element => element.props?.error?.kind === "import");
  assert.equal(typeof errorView.props.onReturn, "function");
  errorView.props.onReturn();
  const parsed = appApi.find(h.render(), element => element.props?.selected instanceof Set);
  assert.equal(parsed.props.selected.size, 0);
  assert.equal(h.starts, 1);
  assert.equal(h.resets, 0);
});

test("reopened partial and failed reports show retained status and count only validated pages as completed records", () => {
  for (const status of ["partial", "failed"]) {
    const h = appHost();
    h.callbacks.onInit({ settings: { zipEnabled: true, suppressStartupNotice: true }, lastImportReport: {
      schemaVersion: 1, sourceName: "Interrupted source", completedAt: "2026-11-06T08:00:00.000Z",
      target: { documentName: "Retained target", fileKey: "retained-key" },
      performanceReport: { schemaVersion: 1, sourceRecordCount: 999999, apiCreationCount: 17, retainedImport: retained(status) },
    } });
    const history = appApi.find(h.render(), element => element.props?.report?.sourceName === "Interrupted source");
    assert.ok(history);
    const markup = appApi.renderToStaticMarkup(appApi.React.createElement(history.type, history.props));
    assert.match(markup, status === "partial" ? /已保留部分内容/ : /未保留页面/);
    assert.match(markup, /保留内容不等于整文件成功/);
    assert.match(markup, /已完成.*页.*部分保留.*页.*未开始.*页/);
    assert.match(markup, new RegExp(`通过页校验的源记录<\\/dt><dd[^>]*>${status === "partial" ? 1 : 0}`));
    assert.match(markup, /API 创建次数<\/dt><dd[^>]*>17/);
    assert.doesNotMatch(markup, /999999/);
  }
});

function chunkedFile(withAsset) {
  // Exact seam from review-error-stop-repro.cjs: 35 source chunks, one root
  // FRAME per chunk, so the first queued error runs at the 32-chunk UI yield.
  const ids = Array.from({ length: 35 }, (_, index) => `root-${index}`);
  const paths = ids.map((_, index) => `page/layers-${index}.json`);
  const files = [
    { name: "manifest.json", data: { schema: "mastergo2figma.package.v2", version: 2, documentName: "Synthetic transport",
      pages: [{ id: "page", name: "Page", pageFile: "page/index.json", layerCount: 35 }],
      assets: withAsset ? { image: { path: "images/test.png", size: 35 * 65536 } } : {}, stats: { layerCount: 35 } } },
    { name: "page/index.json", data: { schema: "mastergo2figma.page.v2", version: 2,
      id: "page", name: "Page", rootNodeIds: ids, layerChunks: paths } },
  ];
  for (let index = 0; index < ids.length; index++) files.push({ name: paths[index], data: {
    schema: "mastergo2figma.layers.v2", version: 2, pageId: "page", records: [{ id: ids[index], parentId: null,
      childIds: [], props: { type: "FRAME", ...(withAsset && index === 0
        ? { geometry: { fills: [{ type: "IMAGE", imageRef: "image" }] } } : {}) } }],
  } });
  if (withAsset) files.push({ name: "images/test.png", data: Buffer.alloc(35 * 65536) });
  return trackedFile(archive(files));
}

test("first async errors stop layer and asset batches at the next boundary, reject the stream and still allow retained abort cleanup", async () => {
  for (const stage of ["page-chunks", "asset-chunks", "session-ack", "legacy-error"]) {
    let queued = false, errorDelivered = false;
    const afterError = [];
    const firstSummary = { status: "failed", pages: [{ sourcePageId: "zip_0_page", sourcePageName: "Page",
      targetPageId: null, targetPageName: null, status: "pending", sourceRecordCount: 35 }], completedPageCount: 0,
      partialPageCount: 0, pendingPageCount: 1, retainedPageCount: 0, completedSourceRecordCount: 0,
      reportedRestoredRecordCount: 0, totalSourceRecordCount: 35, cleanupWarnings: [] };
    const abortSummary = { ...firstSummary, cleanupWarnings: ["Synthetic abort cleanup recorded"] };
    const h = await host((message, deliver) => {
      if (errorDelivered && message.type.startsWith("import-")) afterError.push({ type: message.type, chunkIndex: message.chunkIndex });
      if (message.type === "import-session-abort") {
        queueMicrotask(() => deliver(ack(message, { success: true, retainedImport: abortSummary })));
        return false;
      }
      const trigger = stage === "asset-chunks" ? message.type === "import-asset-chunk"
        : stage === "session-ack" ? message.type === "import-session-start" : message.type === "import-page-chunk";
      if (!trigger || queued) return;
      queued = true;
      if (stage === "session-ack") queueMicrotask(() => deliver(ack(message, { success: true })));
      queueMicrotask(() => {
        errorDelivered = true;
        deliver({ type: "error", ...(stage === "legacy-error" ? {} : { transferId: message.transferId }),
          message: "first async transport error", retainedImport: firstSummary });
      });
      if (stage === "session-ack") return false;
    }, chunkedFile(stage === "asset-chunks"));
    const outcome = await h.run().then(() => ({ resolved: true }), error => ({ error }));
    assert.ok(outcome.error, `${stage}: import falsely resolved; post-error transport=${JSON.stringify(afterError)}`);
    assert.equal(outcome.error.message, "first async transport error");
    assert.deepEqual(outcome.error.retainedImport, abortSummary);
    assert.deepEqual(afterError, [{ type: "import-session-abort", chunkIndex: undefined }], stage);
    assert.equal(h.results.length, 0);
    assert.equal(h.sent.some(message => message.type === "import-session-complete"), false);
  }
});
