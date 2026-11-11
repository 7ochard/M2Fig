const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");

const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/src/importReportStorage.ts")],
  bundle: true, format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
const moduleValue = { exports: {} };
new Function("module", "exports", code)(moduleValue, moduleValue.exports);
const { saveImportReport, readImportReport } = moduleValue.exports;

function report(sourceName = "Source A") {
  return { schemaVersion: 1, sourceName, completedAt: "2026-11-05T08:30:00.000Z",
    target: { documentName: "Actual target", fileKey: "actual-target-key" },
    performanceReport: { schemaVersion: 1, receiverVersion: "test-r3", mainMs: 12, totalMs: 20,
      sourceRecordCount: 42, apiCreationCount: 9, creationCountMeaning: "direct factory calls",
      sourceDocumentName: sourceName, targetDocumentName: "Actual target", targetFileKey: "actual-target-key",
      stagesMs: { "prepare.fontsMs": 2 }, stageCounts: { "prepare.fontsLoaded": 3 },
      restoreStats: { startedAt: 123, restoredNodes: 42, creationCounts: { frame: 9 } },
      clientTimings: { totalsMs: { read: 1 }, counts: { pages: 2 }, bytes: { source: 123 }, startedAt: 10,
        transferId: "session-a", selectedPageCount: 2, selectedLayerCount: 42 },
      preparationClientTimings: null,
      zipSources: [{ rangeReadCount: 2, rangeReadBytes: 123, entryReadCount: 1 }] } };
}
function storage() {
  const values = new Map(), writes = [], warnings = [];
  return { values, writes, warnings,
    getAsync: async key => values.get(key),
    setAsync: async (key, value) => { writes.push(key); values.set(key, value); },
    warn: (...args) => warnings.push(args) };
}

test("only the latest detached summary survives a fresh reader, with its actual source and target", async () => {
  const s = storage(), first = report();
  assert.equal(await readImportReport(s, s.warn), null);
  assert.equal(await saveImportReport(s, first, s.warn), true);
  first.target.fileKey = "later-current-file";
  assert.equal((await readImportReport(s, s.warn)).target.fileKey, "actual-target-key");
  const second = report("Source B"); second.target.documentName = null; second.target.fileKey = null;
  assert.equal(await saveImportReport(s, second, s.warn), true);
  const reader = { getAsync: async key => s.values.get(key), setAsync: s.setAsync };
  assert.deepEqual(await readImportReport(reader, s.warn), second);
  assert.equal(s.values.size, 1);
  assert.equal(new Set(s.writes).size, 1, "all reports must overwrite a stable independent key");
  assert.equal(s.warnings.length, 0);
});

test("invalid schema, date, source, target and performance data are rejected without writing", async () => {
  const invalid = [null, { ...report(), schemaVersion: 2 }, { ...report(), sourceName: " " },
    { ...report(), completedAt: "yesterday" }, { ...report(), target: { documentName: "x" } },
    { ...report(), target: { documentName: 3, fileKey: null } },
    { ...report(), performanceReport: { schemaVersion: 2 } },
    { ...report(), performanceReport: { schemaVersion: 1, totalMs: NaN } },
    { ...report(), performanceReport: { schemaVersion: 1, stagesMs: new Uint8Array([1, 2]) } }];
  for (const value of invalid) {
    const s = storage();
    assert.equal(await saveImportReport(s, value, s.warn), false);
    assert.equal(s.writes.length, 0);
    s.values.set("mastergo2figma.receive.lastImportReport.v1", value);
    assert.equal(await readImportReport(s, s.warn), null);
  }
});

test("the one-MiB cap counts UTF-8 bytes and rejects oversized input instead of truncating it", async () => {
  const s = storage(), value = report("汉".repeat(360000));
  assert.ok(JSON.stringify(value).length < 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024);
  assert.equal(await saveImportReport(s, value, s.warn), false);
  assert.equal(s.writes.length, 0);
  s.values.set("mastergo2figma.receive.lastImportReport.v1", value);
  assert.equal(await readImportReport(s, s.warn), null);
});

test("source bytes, package data and layer objects are excluded from persisted performance summaries", async () => {
  const s = storage(), value = report();
  value.sourceBytes = new Uint8Array([1, 2, 3]);
  value.performanceReport.zip = "private-package-content";
  value.performanceReport.layers = [{ id: "private-node", props: { text: "private design" } }];
  assert.equal(await saveImportReport(s, value, s.warn), true);
  const stored = await readImportReport(s, s.warn);
  assert.deepEqual(stored, report());
  assert.equal(JSON.stringify(stored).includes("private"), false);
});

test("storage read and write failures remain nonfatal and leave the preceding report intact", async () => {
  const s = storage(); await saveImportReport(s, report(), s.warn);
  const before = await readImportReport(s, s.warn);
  const brokenWriter = { getAsync: s.getAsync, setAsync: async () => { throw new Error("storage unavailable"); } };
  assert.equal(await saveImportReport(brokenWriter, report("New"), s.warn), false);
  assert.deepEqual(await readImportReport(s, s.warn), before);
  assert.equal(await readImportReport({ getAsync: async () => { throw new Error("cannot read"); }, setAsync: s.setAsync }, s.warn), null);
  assert.ok(s.warnings.length >= 2);
});
