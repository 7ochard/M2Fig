const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const validation = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");
const bundle = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/ui-src/engine.js")],
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["heic-to/csp"], logLevel: "silent"
}).outputFiles[0].text;

function engineHost() {
  const sent = [], results = [];
  const window = { MasterGoMg: { isMgPackage: () => false }, MasterGoPackageValidation: validation };
  const deliver = message => window.onmessage({ data: { pluginMessage: message } });
  const parent = { postMessage({ pluginMessage: message }) {
    sent.push(structuredClone(message));
    if (message.requestId) queueMicrotask(() => deliver({ type: "import-ack", transferId: message.transferId,
      requestId: message.requestId, success: true }));
    if (message.type === "import-session-complete") queueMicrotask(() => deliver({ type: "complete",
      transferId: message.transferId, pageCount: 1, layerCount: 1, unresolvedInstanceCount: 0 }));
  } };
  const mod = { exports: {} };
  new Function("module", "exports", "require", "window", "parent", bundle)(mod, mod.exports, require, window, parent);
  mod.exports.initEngine({ onComplete: result => results.push(result) });
  return { engine: mod.exports, sent, results };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function archive(files) {
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
  return Buffer.concat([...locals, directory, end]);
}

function sourceFile(name = "source.zip", diagnostics) {
  const pages = ["selected", "other"].map(id => ({ id, name: id, pageFile: `${id}/index.json`, layerCount: 1 }));
  const files = { "manifest.json": { schema: "mastergo2figma.package.v2", version: 2, source: "mastergo", pages,
    assets: {}, stats: { pageCount: 2, layerCount: 2 }, diagnostics } };
  for (const page of pages) {
    const nodeId = page.id === "selected" ? "parent" : "other-node";
    files[page.pageFile] = { schema: "mastergo2figma.page.v2", version: 2, id: page.id,
      name: page.name, rootNodeIds: [nodeId], layerChunks: [`${page.id}/layers.json`] };
    files[`${page.id}/layers.json`] = { schema: "mastergo2figma.layers.v2", version: 2, pageId: page.id, records: [{ id: nodeId, parentId: null, childIds: [],
      props: { type: "FRAME", layout: { width: 10, height: 10 } } }] };
  }
  return new File([archive(files)], name);
}

const warnings = [
  { code: "UNREADABLE_SOURCE_NODE", nodeId: "unreadable", parent: { id: "parent", name: "Parent" }, error: { message: "getLayerProperties failed" } },
  { code: "COMPONENT_DEFINITION_MISSING", nodeId: "parent", componentId: "missing-master" },
  { code: "INSTANCE_STRUCTURE_FALLBACK", nodeId: "other-node", componentId: "master" },
  { code: "STYLE_EXPORT_MISSING", nodeId: "other-node", styleId: "missing-style", message: "源样式未导出" },
  { code: "SOURCE_WARNING", message: "未能定位到页面的源警告" }
];

test("ZIP diagnostics retain source provenance, filter omitted pages and reach completion details", async () => {
  const host = engineHost();
  await host.engine.parseFiles([sourceFile("design.zip", warnings)]);
  await host.engine.startImport(["zip_0_selected"]);
  const manifest = host.sent.find(message => message.type === "import-session-start").manifest;
  assert.deepEqual(manifest.diagnostics.map(item => item.code), [
    "UNREADABLE_SOURCE_NODE", "COMPONENT_DEFINITION_MISSING", "STYLE_EXPORT_MISSING", "SOURCE_WARNING"
  ]);
  const missing = manifest.diagnostics[0];
  assert.equal(missing.sourceFile, "design.zip");
  assert.equal(missing.sourceNamespace, "zip_0_");
  assert.equal(missing.sourceNodeId, "unreadable");
  assert.equal(missing.nodeId, "zip_0_unreadable");
  assert.equal(missing.parent.id, "zip_0_parent");
  assert.equal(missing.pageId, "zip_0_selected");
  assert.equal(missing.sourceScope, "page");
  assert.equal(manifest.diagnostics[2].sourceScope, "source");
  const result = host.results[0];
  assert.equal(result.sourceWarningCount, 4);
  assert.deepEqual(result.sourceDiagnostics, manifest.diagnostics);
  assert.match(result.details.join("\n"), /源图层 unreadable 无法读取.*getLayerProperties failed/);
  assert.match(result.details.join("\n"), /主组件 missing-master 不可用/);
  assert.match(result.details.join("\n"), /源文件级记录.*源样式 missing-style 关联降级/);
  assert.equal(result.details.some(line => line.includes("结构已展开")), false);
});

test("structure warnings are shown for their selected page and reset between source files", async () => {
  const host = engineHost();
  await host.engine.parseFiles([sourceFile("first.zip", warnings)]);
  await host.engine.startImport(["zip_0_other"]);
  assert.equal(host.results[0].sourceWarningCount, 3);
  assert.match(host.results[0].details.join("\n"), /源实例 other-node 的结构已展开/);
  assert.equal(host.results[0].details.some(line => line.includes("源图层 unreadable")), false);
  await host.engine.parseFiles([sourceFile("clean.zip", [])]);
  await host.engine.startImport(["zip_0_selected"]);
  assert.equal(host.results[1].sourceWarningCount, 0);
  assert.deepEqual(host.results[1].sourceDiagnostics, []);
});

test("identical node and style ids from separate ZIP files retain source provenance in separate sessions", async () => {
  const host = engineHost();
  for (const name of ["one.zip", "two.zip"]) {
    await host.engine.parseFiles([sourceFile(name, warnings)]);
    await host.engine.startImport(["zip_0_selected"]);
    const result = host.results.at(-1);
    assert.equal(result.sourceWarningCount, 4);
    const missing = result.sourceDiagnostics.filter(item => item.code === "UNREADABLE_SOURCE_NODE");
    assert.deepEqual(missing.map(item => [item.sourceFile, item.nodeId]), [[name, "zip_0_unreadable"]]);
  }
});
