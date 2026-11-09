const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const validation = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

function bundle(relative) {
  return esbuild.buildSync({ entryPoints: [path.resolve(__dirname, relative)], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["heic-to/csp"], logLevel: "silent" }).outputFiles[0].text;
}
const engineCode = bundle("../../ReceiveFromMasterGo/ui-src/engine.js");
const storageModule = { exports: {} };
new Function("module", "exports", bundle("../../ReceiveFromMasterGo/src/importReportStorage.ts"))(storageModule, storageModule.exports);
const { saveImportReport, readImportReport } = storageModule.exports;

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sourceFile() {
  const files = {
    "manifest.json": { schema: "mastergo2figma.package.v2", version: 2, source: "mastergo", documentName: "Report fixture",
      pages: [{ id: "page", name: "Fixture page", pageFile: "page/index.json", layerCount: 1 }], assets: {},
      stats: { pageCount: 1, layerCount: 1 }, diagnostics: [{ code: "SOURCE_WARNING", message: "已有源诊断" }] },
    "page/index.json": { schema: "mastergo2figma.page.v2", version: 2, id: "page", name: "Fixture page",
      rootNodeIds: ["root"], layerChunks: ["page/layers.json"] },
    "page/layers.json": { schema: "mastergo2figma.layers.v2", version: 2, pageId: "page",
      records: [{ id: "root", parentId: null, childIds: [], props: { type: "FRAME" } }] }
  };
  const locals = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(JSON.stringify(value));
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc32(bytes), 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); central.push(entry, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...locals, directory, end])], "report-fixture.zip");
}

async function engineHost() {
  const sent = [], results = [], reports = [], writes = [], warnings = [], values = new Map();
  const storage = { getAsync: async key => values.get(key), setAsync: async (key, value) => { values.set(key, value); } };
  const window = { MasterGoMg: { isMgPackage: () => false }, MasterGoPackageValidation: validation };
  const parent = { postMessage({ pluginMessage }) {
    const message = structuredClone(pluginMessage);
    sent.push(message);
    if (message.type === "save-import-report") writes.push(saveImportReport(storage, message.report, warning => warnings.push(warning)));
  } };
  const mod = { exports: {} };
  new Function("module", "exports", "require", "window", "parent", engineCode)(mod, mod.exports, require, window, parent);
  mod.exports.initEngine({ onComplete: result => results.push(result), onImportReport: report => reports.push(report) });
  await mod.exports.parseFiles([sourceFile()]);
  return { sent, results, reports, warnings,
    async complete(message) {
      window.onmessage({ data: { pluginMessage: { type: "complete", pageCount: 1, layerCount: 9,
        missingImageAssetCount: 1, fallbackConnectorCount: 1, restoredMissingFontTextNodeCount: 2,
        failedMissingFontTextNodeCount: 3, unresolvedInstanceCount: 1,
        unresolvedInstanceDetails: [{ sourceId: "missing-instance", name: "Missing instance", mainComponentId: "missing-master", reason: "missing-component" }],
        ...message } } });
      await Promise.all(writes);
      return results.at(-1);
    },
    readSaved: () => readImportReport(storage, warning => warnings.push(warning))
  };
}

const textChildContainerDetails = [{ sourceId: "zip_0_text-parent", name: "Text with vectors", childCount: 8, pageName: "Fixture page" }];
function performanceReport(withDetails = false) {
  return { schemaVersion: 1, receiverVersion: "test-r3", mainMs: 10, sourceRecordCount: 9, apiCreationCount: 11,
    targetDocumentName: "Target fixture", targetFileKey: "fixture-key", stagesMs: {}, stageCounts: {},
    ...(withDetails ? { textChildContainerDetails: structuredClone(textChildContainerDetails) } : {}) };
}

function assertOriginalDetails(result) {
  const details = result.details.join("\n");
  assert.match(details, /已有源诊断/);
  assert.match(details, /1 个图片缺失/);
  assert.match(details, /1 个连接线已降级为折线/);
  assert.match(details, /2 个文本字体已恢复/);
  assert.match(details, /3 个文本字体仍缺失/);
  assert.match(details, /源主组件缺失.*missing-master/);
  assert.equal(result.unresolvedInstanceCount, 1);
  assert.equal(result.sourceDiagnostics.length, 1);
  assert.equal(result.sourceDiagnostics[0].message, "已有源诊断");
}

test("TEXT-child compatibility adds actionable completion details without replacing existing diagnostics", async () => {
  const host = await engineHost();
  const result = await host.complete({ textChildContainerDetails, performanceReport: performanceReport(true) });
  assertOriginalDetails(result);
  assert.equal(result.sourceWarningCount, 2, "one compatibility parent adds one warning to the existing source diagnostic");
  const warning = result.details.find(line => line.includes("zip_0_text-parent"));
  assert.ok(warning, "the compatibility detail must identify the source record");
  assert.match(warning, /Text with vectors/);
  assert.match(warning, /8/);
  assert.match(warning, /透明.*容器|容器.*透明/);
  assert.match(warning, /叠放|层叠|堆叠/);
  assert.match(warning, /核对|检查|确认/);
});

test("completed performance reports retain TEXT-child details through the actual persistence round trip", async () => {
  const host = await engineHost();
  const result = await host.complete({ textChildContainerDetails, performanceReport: performanceReport(true) });
  const sent = host.sent.find(message => message.type === "save-import-report").report;
  assert.deepEqual(sent.performanceReport.textChildContainerDetails, textChildContainerDetails);
  assert.deepEqual(host.reports[0].performanceReport.textChildContainerDetails, textChildContainerDetails);
  assert.deepEqual(result.performanceReport.textChildContainerDetails, textChildContainerDetails);
  const saved = await host.readSaved();
  assert.deepEqual(saved.performanceReport.textChildContainerDetails, textChildContainerDetails);
  assert.equal(saved.sourceName, "Report fixture");
  assert.deepEqual(saved.target, { documentName: "Target fixture", fileKey: "fixture-key" });
  assert.equal(saved.performanceReport.apiCreationCount, 11);
  assert.deepEqual(host.warnings, []);
});

test("legacy complete messages without TEXT-child fields retain their warning count, details and saved report", async () => {
  const host = await engineHost();
  const result = await host.complete({ performanceReport: performanceReport() });
  assertOriginalDetails(result);
  assert.equal(result.sourceWarningCount, 1);
  assert.equal(result.details.length, 7);
  assert.doesNotMatch(result.details.join("\n"), /透明.*容器|叠放|层叠|堆叠/);
  assert.equal(result.performanceReport.textChildContainerDetails, undefined);
  const saved = await host.readSaved();
  assert.equal(saved.performanceReport.textChildContainerDetails, undefined);
  assert.equal(saved.performanceReport.sourceRecordCount, 9);
  assert.deepEqual(host.warnings, []);
});
