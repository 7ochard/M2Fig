const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const mg = require("../../ReceiveFromMasterGo/src/ui/mgPackage.js");
const validation = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

const code = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/ui-src/engine.js")],
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["heic-to/csp"], logLevel: "silent"
}).outputFiles[0].text;

function nativeFixture() {
  const page = (id, name, code) => Buffer.from(`\x01${id}\0\x02${name}\0\x03${code}\0`);
  function node(id, parent, subtype, reference, code = "a0") {
    return Buffer.concat([
      Buffer.from(`\x01${id}\0\x02${parent}\0\x03${code}\0\x04${subtype}\0${reference ? `\x1a${reference}\0` : ""}`),
      Buffer.from([0x1c, 7, 3, 0, ...(subtype === "COMPONENT" ? [5, 1] : [6, 1]), 0, 0, 0x1d, 1, 0])
    ]);
  }
  // Synthetic native records exercise cross-page and nested component references.
  // No exported design, cached document, image or production identifier is used.
  const document = Buffer.concat([
    page("0:1", "Library", "a0"), page("0:2", "Screen", "a1"),
    node("2:1", "0:1", "COMPONENT"), node("2:2", "0:1", "COMPONENT", undefined, "a1"),
    node("2:3", "2:1", "INSTANCE", "2:2"), node("1:1", "0:2", "INSTANCE", "2:1")
  ]);
  let crc = 0xffffffff;
  for (const byte of document) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const name = Buffer.from("document"), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(document.length, 18); local.writeUInt32LE(document.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(document.length, 20); central.writeUInt32LE(document.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + document.length, 16);
  return Buffer.concat([local, name, document, central, name, end]);
}
const fixtureBytes = nativeFixture();

function createEngine() {
  const sent = [], conversions = [], results = [], pagesDone = [];
  const window = {
    MasterGoMg: { ...mg, convertMgPackageToV2Entries(entries, name, options) {
      conversions.push(options);
      return mg.convertMgPackageToV2Entries(entries, name, options);
    } },
    MasterGoPackageValidation: validation
  };
  const deliver = message => window.onmessage({ data: { pluginMessage: message } });
  const parent = { postMessage({ pluginMessage }) {
    const message = structuredClone(pluginMessage);
    sent.push(message);
    if (message.requestId) queueMicrotask(() => deliver({ type: "import-ack",
      transferId: message.transferId, requestId: message.requestId, success: true }));
    if (message.type === "import-session-complete") queueMicrotask(() => deliver({
      type: "complete", transferId: message.transferId,
      pageCount: 1, dependencyPageCount: 1, dependencyComponentCount: 2,
      unresolvedInstanceCount: 1,
      unresolvedInstanceDetails: [{ sourceId: "test", name: "Missing", mainComponentId: "absent", reason: "missing-component" }]
    }));
  } };
  const module = { exports: {} };
  new Function("module", "exports", "require", "window", "parent", code)(module, module.exports, require, window, parent);
  module.exports.initEngine({ onComplete: result => results.push(result), onPageDone: done => pagesDone.push(done) });
  return { engine: module.exports, sent, conversions, results, pagesDone };
}

test("GUI preview performs no document writes; selected import re-decodes source and streams dependency flags", async () => {
  const host = createEngine();
  let reads = 0;
  const file = { name: "public.mg", async arrayBuffer() {
    reads++;
    return fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength);
  } };
  const preview = await host.engine.parseFiles([file]);
  assert.equal(preview.pageCount, 2);
  assert.deepEqual(host.conversions, [{ previewOnly: true }]);
  assert.equal(host.sent.some(message => message.type.startsWith("import-")), false);
  assert.equal(reads, 1);
  await host.engine.startImport([preview.pages[1].id]);
  assert.equal(reads, 2);
  assert.deepEqual(host.conversions[1], { selectedPageIds: ["mgpage-1"], slimInstanceDescendants: true });
  const start = host.sent.find(message => message.type === "import-session-start");
  assert.deepEqual(start.manifest.pages.map(page => page.isDependencyPage), [true, false]);
  const componentIds = host.sent.filter(message => message.type === "import-page-chunk")
    .flatMap(message => message.records).filter(record => record.props?.type === "COMPONENT").map(record => record.id).sort();
  assert.equal(componentIds.length, 2);
  assert.deepEqual([...start.componentIds].sort(), componentIds);
  const pages = host.sent.filter(message => message.type === "import-page-start").map(message => message.page);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].isDependencyPage, true);
  assert.equal(pages[1].id, preview.pages[1].id);
  assert.deepEqual(host.pagesDone, [0, 1]);
  assert.equal(host.results[0].pageCount, 1);
  assert.equal(host.results[0].dependencyComponentCount, 2);
  assert.match(host.results[0].details.join(" "), /源主组件缺失/);
});

test("whole-file GUI imports preserve page order and component identities in separate source sessions", async () => {
  for (const name of ["one.mg", "two.mg"]) {
    const host = createEngine();
    const preview = await host.engine.parseFiles([new File([fixtureBytes], name)]);
    await host.engine.startImport(preview.pages.map(page => page.id));
    const manifest = host.sent.find(message => message.type === "import-session-start").manifest;
    assert.deepEqual(manifest.pages.filter(page => !page.isDependencyPage).map(page => page.id), preview.pages.map(page => page.id));
    const records = host.sent.filter(message => message.type === "import-page-chunk").flatMap(message => message.records);
    assert.equal(new Set(records.map(record => record.id)).size, records.length);
    const ids = new Set(records.map(record => record.id));
    for (const record of records) {
      assert.match(record.id, /^zip_0_/);
      if (record.mainComponentId) {
        assert.equal(ids.has(record.mainComponentId), true, record.mainComponentId);
        assert.equal(record.mainComponentId.slice(0, 6), record.id.slice(0, 6));
      }
    }
  }
});

test("invalid selection and damaged files fail before an import session is opened", async () => {
  const host = createEngine();
  const preview = await host.engine.parseFiles([new File([fixtureBytes], "valid.mg")]);
  await assert.rejects(host.engine.startImport([]), /选择/);
  await assert.rejects(host.engine.startImport([preview.pages[0].id, "unknown"]), /失效/);
  await assert.rejects(host.engine.parseFiles([new File(["broken"], "broken.mg")]));
  assert.equal(host.sent.some(message => message.type === "import-session-start"), false);
  assert.equal(host.engine.hasPackage(), false);
});
