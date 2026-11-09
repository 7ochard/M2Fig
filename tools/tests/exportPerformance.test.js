const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("../../SendToFigma/node_modules/esbuild");
const { validateV2Package } = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

const source = fs.readFileSync(path.resolve(__dirname, "../../SendToFigma/src/transferStream.ts"), "utf8");
const bundled = esbuild.buildSync({ stdin: {
  contents: source + '\nexport { initializeRules } from "./layerRules"; export { state } from "./state";',
  resolveDir: path.resolve(__dirname, "../../SendToFigma/src"), loader: "ts"
}, bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" }).outputFiles[0].text;

function host() {
  const metrics = { selectionWrites: 0, pageWrites: 0, childrenReads: 0, lookups: 0, svgExports: 0 };
  const nodes = new Map(), files = {}, pending = {}, messages = [];
  let api, currentPage;
  function node(id, type, children = [], extra = {}) {
    const value = { id, type, name: id, parent: null, width: 100, height: 100, x: 0, y: 0,
      layoutGrids: [], opacity: 1,
      get children() { metrics.childrenReads++; return children; }, ...extra };
    for (const child of children) child.parent = value;
    nodes.set(id, value);
    return value;
  }
  function page(id, children) {
    let selection = [];
    const value = node(id, "PAGE", children);
    Object.defineProperty(value, "selection", {
      get() { return selection; },
      set(next) { metrics.selectionWrites++; selection = next; }
    });
    return value;
  }
  const document = { children: [], get currentPage() { return currentPage; },
    set currentPage(value) { metrics.pageWrites++; currentPage = value; } };
  const mg = { documentId: 123, document,
    getNodeById(id) { metrics.lookups++; return nodes.get(id) || null; },
    ui: { postMessage(message) {
      messages.push(message);
      if (message.type === "export-file-start") pending[message.index] = { path: message.path, chunks: [] };
      if (message.type === "export-file-chunk") pending[message.index].chunks.push(Buffer.from(message.bytes || message.content));
      if (message.type === "export-file-end") {
        const item = pending[message.index];
        files[item.path] = Buffer.concat(item.chunks);
        queueMicrotask(() => api.resolveExportFileAck({ ...message, success: true }));
      }
      if (message.type === "export-transfer-complete") {
        queueMicrotask(() => api.resolveExportTransferAck({ ...message, success: true }));
      }
    } }
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", "mg", bundled)(module, module.exports, require, mg);
  api = module.exports;
  api.initializeRules();
  async function run(pages, mode = "direct-zip") {
    document.children = pages;
    currentPage = pages[0];
    const started = performance.now();
    await api.streamJsonExportPackage({ scope: "all-pages", pageIds: [], transferMode: mode });
    return { elapsedMs: performance.now() - started, metrics, files, messages,
      manifest: JSON.parse(files["manifest.json"]), validation: validateV2Package(files) };
  }
  return { node, page, run, metrics, api, messages, files };
}

test("whole-file export never selects empty-grid containers and reads each child list once", async () => {
  const h = host();
  const leaves = Array.from({ length: 300 }, (_, index) => h.node(`frame-${index}`, "FRAME"));
  const result = await h.run([h.page("page", leaves)]);
  if (process.env.BRIDGE_PERF_REPORT) fs.writeFileSync(process.env.BRIDGE_PERF_REPORT, JSON.stringify({
    fixture: "300 empty-grid frames, immediate mock file ACKs", ...result.metrics,
    elapsedMs: result.elapsedMs, messageCount: result.messages.length,
    canonicalDigest: result.validation.canonicalDigest,
    limitation: "Synthetic host counters and wall time; not a real MasterGo speed or memory measurement."
  }, null, 2));
  assert.equal(result.validation.ok, true);
  assert.equal(result.metrics.selectionWrites, 0);
  assert.equal(result.metrics.pageWrites, 0);
  assert.equal(result.metrics.childrenReads, 301);
  const diagnostics = result.manifest.diagnostics.filter(item => item.code === "LAYOUT_GRID_UNRESOLVED");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].affectedNodeCount, 300);
  assert.equal(diagnostics[0].nodeId, undefined);
});

test("one package preserves cross-page components and a connector captured during the single scan", async () => {
  const h = host();
  const grids = [{ pattern: "GRID", sectionSize: 8, isVisible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } }];
  const master = h.node("master", "COMPONENT", [h.node("master-child", "RECTANGLE")], { layoutGrids: grids });
  const instance = h.node("instance", "INSTANCE", [h.node("copy", "RECTANGLE")], { mainComponent: master, layoutGrids: grids });
  const svg = '<svg viewBox="0 0 102 102"><path d="M1 1L101 101"/></svg>';
  const connector = h.node("connector", "CONNECTOR", [], {
    absoluteTransform: [[1, 0, 10], [0, 1, 20]], absoluteRenderBounds: { x: 9, y: 19, width: 102, height: 102 },
    exportAsync: async () => { h.metrics.svgExports++; return svg; }
  });
  const result = await h.run([h.page("first", [instance, connector]), h.page("second", [master])], "local-json-stream");
  const records = Object.entries(result.files).filter(([name]) => name.includes("/layers/"))
    .flatMap(([, bytes]) => JSON.parse(bytes).records);
  assert.equal(result.validation.ok, true);
  assert.equal(result.messages.filter(item => item.type === "export-transfer-start").length, 1);
  assert.deepEqual(result.manifest.pages.map(item => item.id), ["first", "second"]);
  assert.equal(records.find(item => item.id === "instance").mainComponentId, "master");
  assert.equal(records.find(item => item.id === "instance").instanceStructureFallback, undefined);
  assert.deepEqual(records.find(item => item.id === "connector").props.connectorSvg, {
    markup: svg, offset: { x: -1, y: -1 }, width: 102, height: 102
  });
  assert.equal(result.metrics.svgExports, 1);
  assert.equal(result.metrics.childrenReads, 7);
});

test("whole-file relay output remains one namespace even without component instances", async () => {
  const h = host();
  const result = await h.run([h.page("first", [h.node("one", "RECTANGLE")]),
    h.page("second", [h.node("two", "RECTANGLE")])], "local-json-stream");
  assert.equal(result.validation.ok, true);
  assert.equal(result.messages.filter(item => item.type === "export-transfer-start").length, 1);
  assert.deepEqual(result.manifest.pages.map(item => item.id), ["first", "second"]);
});

test("unreadable connector roots and children are excluded before writing page indexes", async () => {
  const h = host();
  const brokenRoot = h.node("bad-root", "CONNECTOR");
  const brokenChild = h.node("bad-child", "CONNECTOR");
  for (const node of [brokenRoot, brokenChild]) {
    Object.defineProperty(node, "width", { get() { throw new Error(`The node with id "${node.id}" does not exist`); } });
  }
  const frame = h.node("frame", "FRAME", [brokenChild, h.node("good", "RECTANGLE")]);
  const result = await h.run([h.page("page", [brokenRoot, frame])]);
  assert.equal(result.validation.ok, true);
  const page = JSON.parse(result.files[result.manifest.pages[0].pageFile]);
  assert.deepEqual(page.rootNodeIds, ["frame"]);
  const records = page.layerChunks.flatMap(name => JSON.parse(result.files[name]).records);
  assert.deepEqual(records.map(record => record.id), ["frame", "good"]);
  assert.deepEqual(records[0].childIds, ["good"]);
  assert.equal(result.manifest.diagnostics.filter(item => item.code === "UNREADABLE_SOURCE_NODE").length, 2);
});

test("text transfer coalesces bounded parts without corrupting split UTF-16 pairs", async () => {
  const h = host();
  const parts = ['{"text":"', "中".repeat(16374), "\ud83d", "\ude00", "界".repeat(50000), '"}'];
  const manifest = h.api.createBaseExportManifest({ scope: "all-pages" }, 0);
  const transfer = h.api.createExportTransfer(manifest);
  await h.api.streamExportFileToUI(transfer, { path: "text.json", contentParts: parts });
  await h.api.drainPendingExportFileAck(transfer);
  assert.deepEqual(h.files["text.json"], Buffer.from(parts.join("")));
  assert.equal(JSON.parse(h.files["text.json"]).text, "中".repeat(16374) + "😀" + "界".repeat(50000));
  const chunks = h.messages.filter(item => item.type === "export-file-chunk");
  assert.equal(chunks.length, Math.ceil(parts.join("").length / 16384));
  for (const chunk of chunks) assert.ok(chunk.bytes.length <= 16384 * 3);
});

test("an oversized single record retains exact bytes under the bounded transfer", async () => {
  const h = host();
  const content = JSON.stringify({ records: [{ id: "large", text: "中文😀".repeat(50000) }] });
  const manifest = h.api.createBaseExportManifest({ scope: "all-pages" }, 0);
  const transfer = h.api.createExportTransfer(manifest);
  await h.api.streamExportFileToUI(transfer, { path: "large.json", contentParts: [content.slice(0, 12), content.slice(12)] });
  await h.api.drainPendingExportFileAck(transfer);
  assert.deepEqual(h.files["large.json"], Buffer.from(content));
  for (const chunk of h.messages.filter(item => item.type === "export-file-chunk")) {
    assert.ok(chunk.bytes.length <= 16384 * 3);
  }
});

test("empty files and exact-sized parts retain contiguous chunk indexes", async () => {
  const h = host();
  const manifest = h.api.createBaseExportManifest({ scope: "all-pages" }, 0);
  const transfer = h.api.createExportTransfer(manifest);
  for (const [name, parts] of [["empty", ["", ""]], ["boundary", ["a".repeat(16384), "b"]]]) {
    await h.api.streamExportFileToUI(transfer, { path: name, contentParts: parts });
    await h.api.drainPendingExportFileAck(transfer);
    assert.deepEqual(h.files[name], Buffer.from(parts.join("")));
  }
  for (const index of [0, 1]) {
    const chunks = h.messages.filter(item => item.type === "export-file-chunk" && item.index === index);
    assert.deepEqual(chunks.map(item => item.chunkIndex), index === 0 ? [0] : [0, 1]);
  }
});
