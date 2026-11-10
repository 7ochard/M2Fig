const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");

const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/ui-src/importReport.ts")],
  bundle: true, format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
const moduleValue = { exports: {} };
new Function("module", "exports", code)(moduleValue, moduleValue.exports);
const { normalizeSavedImportReport, progressStageLabel, progressWaitingSeconds, stageRows } = moduleValue.exports;

function savedReport() {
  return { schemaVersion: 1, sourceName: "Previous source", completedAt: "2026-11-05T08:30:00.000Z",
    target: { documentName: "Previous target", fileKey: "previous-key" },
    performanceReport: { schemaVersion: 1, totalMs: 1200, sourceRecordCount: 42, apiCreationCount: 9,
      stagesMs: { "prepare.fontsMs": 300 }, futureMetric: { count: 7 } } };
}

test("saved report normalization preserves its original source, target and optional metrics", () => {
  const input = savedReport(), normalized = normalizeSavedImportReport(input);
  assert.deepEqual(normalized, input);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.performanceReport, input.performanceReport);
  input.target.documentName = "Current target"; input.target.fileKey = "current-key";
  input.performanceReport.futureMetric.count = 99;
  assert.equal(normalized.sourceName, "Previous source");
  assert.deepEqual(normalized.target, { documentName: "Previous target", fileKey: "previous-key" });
  assert.deepEqual(normalized.performanceReport.futureMetric, { count: 7 });
  const unknownTarget = savedReport(); unknownTarget.target = { documentName: null, fileKey: null };
  assert.deepEqual(normalizeSavedImportReport(unknownTarget).target, unknownTarget.target);
});

test("missing, old and malformed saved reports are ignored without an exception", () => {
  const invalid = [undefined, null, [], {}, { ...savedReport(), schemaVersion: 2 },
    { ...savedReport(), sourceName: " " }, { ...savedReport(), completedAt: "yesterday" },
    { ...savedReport(), target: {} }, { ...savedReport(), target: { documentName: 2, fileKey: null } },
    { ...savedReport(), performanceReport: [] }, { ...savedReport(), performanceReport: { schemaVersion: 2 } }];
  for (const value of invalid) assert.equal(normalizeSavedImportReport(value), null);
  const circular = savedReport(); circular.performanceReport.self = circular.performanceReport;
  assert.equal(normalizeSavedImportReport(circular), null);
});

test("all import stages have concrete Chinese labels and unknown stages retain the prepare fallback", () => {
  const labels = { prepare: "准备", fonts: "字体检查", assets: "处理图片", pageSend: "发送页面",
    restore: "还原图层", postprocess: "布局后处理", finalize: "收尾" };
  for (const [stage, label] of Object.entries(labels)) assert.equal(progressStageLabel(stage), label);
  for (const stage of ["", "future-stage", "constructor", "__proto__"]) assert.equal(progressStageLabel(stage), "准备");
});

test("waiting seconds use the supplied clock and never invent a stale wait for old or future timestamps", () => {
  const updatedAt = 1000000;
  assert.equal(progressWaitingSeconds(updatedAt, updatedAt + 14999), 0);
  assert.equal(progressWaitingSeconds(updatedAt, updatedAt + 15000), 15);
  assert.equal(progressWaitingSeconds(updatedAt, updatedAt + 19999), 19);
  assert.equal(progressWaitingSeconds(updatedAt, updatedAt - 1), 0);
  assert.equal(progressWaitingSeconds(updatedAt, NaN), 0);
  for (const missing of [undefined, null, NaN, Infinity, -1, 0, "1000000", {}]) {
    assert.equal(progressWaitingSeconds(missing, updatedAt + 60000), 0);
  }
});

test("stage rows name font preflight while preserving existing and future measurements", () => {
  assert.deepEqual(stageRows({ stagesMs: { "prepare.fontsMs": 300, "restore.nodesMs": 500, "future.ms": 17 } }), [
    { key: "prepare.fontsMs", label: "字体预检", duration: "0.30 秒" },
    { key: "restore.nodesMs", label: "还原节点", duration: "0.50 秒" },
    { key: "future.ms", label: "future.ms", duration: "0.02 秒" },
  ]);
});
