const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");

const root = path.resolve(__dirname, "../..");
const pluginCode = esbuild.buildSync({ entryPoints: [path.join(root, "ReceiveFromMasterGo/src/code.ts")],
  bundle: true, write: false, target: "es2017", logLevel: "silent" }).outputFiles[0].text;

function host() {
  let nextId = 0;
  const raw = new WeakMap(), messages = [], stats = { mainComponentReads: 0, swaps: 0 };
  const document = { type: "DOCUMENT", name: "Target", children: [] };
  function make(type) {
    const children = [];
    const node = { id: String(++nextId), type, name: type, removed: false, parent: null,
      x: 0, y: 0, width: 100, height: 100, visible: true, fills: [], strokes: [], layoutMode: "NONE", childrenReads: 0,
      get children() { this.childrenReads++; return children.slice(); },
      appendChild(child) { this.insertChild(children.length, child); },
      insertChild(index, child) {
        if (child.parent) {
          const siblings = raw.get(child.parent);
          siblings.splice(siblings.indexOf(child), 1);
        }
        children.splice(index, 0, child); child.parent = this;
      },
      remove() {
        for (const child of children.slice()) child.remove();
        if (this.parent) { const siblings = raw.get(this.parent); siblings.splice(siblings.indexOf(this), 1); }
        this.parent = null; this.removed = true;
      },
      resize(width, height) { this.width = width; this.height = height; },
      loadAsync: async () => {}, getPluginData: () => "", setPluginData() {},
      findAll(predicate) { return children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.findAll(predicate)]); }
    };
    raw.set(node, children);
    if (type === "PAGE") { document.children.push(node); node.parent = document; }
    if (type === "INSTANCE") {
      node.getMainComponentAsync = async () => { stats.mainComponentReads++; return node.mainComponent; };
      node.swapComponent = component => {
        stats.swaps++;
        for (const child of children.slice()) child.remove();
        node.mainComponent = component;
        for (const child of raw.get(component)) node.appendChild(copy(child));
      };
    }
    if (type === "COMPONENT") node.createInstance = () => {
      const instance = make("INSTANCE"); instance.mainComponent = node;
      for (const child of children) instance.appendChild(copy(child));
      return instance;
    };
    return node;
  }
  function copy(source) {
    const node = make(source.type); node.name = source.name;
    if (source.type === "INSTANCE") node.mainComponent = source.mainComponent;
    for (const child of raw.get(source)) node.appendChild(copy(child));
    return node;
  }
  const figma = { root: document, currentPage: make("PAGE"), fileKey: "test-key", mixed: Symbol("mixed"),
    showUI() {}, ui: { postMessage: message => messages.push(message) },
    createPage: () => make("PAGE"), createFrame: () => make("FRAME"), createComponent: () => make("COMPONENT"),
    setCurrentPageAsync: async page => { figma.currentPage = page; },
    viewport: { scrollAndZoomIntoView() {} }, notify() {},
    listAvailableFontsAsync: async () => [{ fontName: { family: "Inter", style: "Regular" } }], loadFontAsync: async () => {}
  };
  const quiet = { log() {}, info() {}, warn() {}, error() {} };
  new Function("figma", "__html__", "console", "setTimeout", pluginCode)(figma, "", quiet, callback => { callback(); return 0; });
  return { figma, messages, stats, send: message => figma.ui.onmessage({ transferId: "r3", requestId: "r3", ...message }) };
}

const record = (id, type = "FRAME", extra = {}) => ({ version: 2, id, name: id, parentId: null,
  index: 0, childIds: [], props: { id, type: type === "INSTANCE" ? "FRAME" : type, sourceType: type, name: id }, ...extra });
const page = (id, records) => ({ id, name: id, layerCount: records.length, rootNodeIds: records.filter(r => !r.parentId).map(r => r.id) });
async function start(h, pages) {
  await h.send({ type: "import-session-start", totalNodes: pages.reduce((n, p) => n + p.layerCount, 0), totalPages: pages.length,
    manifest: { schema: "mastergo2figma.package.v2", version: 2, pages, assets: {} } });
}
async function transfer(h, index, p, records) {
  await h.send({ type: "import-page-start", pageIndex: index, page: p });
  await h.send({ type: "import-page-chunk", pageIndex: index, records });
  await h.send({ type: "import-page-end", pageIndex: index });
  assert.equal(h.messages.some(m => m.type === "import-ack" && m.success === false), false);
}

test("ordinary roots avoid whole-page children snapshots while retaining source order", async t => {
  const h = host(), records = Array.from({ length: 100 }, (_, i) => record("root-" + i)), p = page("Flat", records);
  await start(h, [p]); await transfer(h, 0, p, records);
  const reads = h.figma.currentPage.childrenReads;
  assert.ok(reads <= 1, `100 ordinary roots took ${reads} page children snapshots`);
  assert.deepEqual(h.figma.currentPage.children.map(n => n.name), records.map(r => r.id));
  t.diagnostic(JSON.stringify({ roots: records.length, pageChildrenSnapshots: reads }));
});

test("component-first restoration still restores the original root order and real instance association", async () => {
  const h = host(), records = [record("instance", "INSTANCE", { mainComponentId: "master" }), record("master", "COMPONENT"), record("tail")];
  const p = page("Reorder", records); await start(h, [p]); await transfer(h, 0, p, records);
  const nodes = h.figma.currentPage.children;
  assert.deepEqual(nodes.map(n => n.name), ["instance", "master", "tail"]);
  assert.equal(nodes[0].type, "INSTANCE"); assert.equal(nodes[0].mainComponent, nodes[1]);
});

test("mask registration reads every record once instead of rescanning the page", async t => {
  const h = host();
  const reads = new Map();
  const records = Array.from({ length: 100 }, (_, i) => {
    const rec = record("mask-" + i);
    const value = i < 3 ? true : i === 7 ? false : undefined;
    Object.defineProperty(rec, "maskRendersFill", { enumerable: true,
      get() { reads.set("mask-" + i, (reads.get("mask-" + i) || 0) + 1); return value; } });
    return rec;
  });
  const p = page("Masks", records); await start(h, [p]); await transfer(h, 0, p, records);
  assert.equal(h.figma.currentPage.children.length, records.length);
  const totalReads = [...reads.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(totalReads, records.length, "the discovery pass must read the mask flag once per record, with no second full scan");
  t.diagnostic(JSON.stringify({ records: records.length, maskReads: totalReads }));
});

test("plain pages skip the component-dependency DFS and report the skip in stage counts", async () => {
  const h = host();
  const records = Array.from({ length: 60 }, (_, i) => record("plain-" + i));
  const p = page("Plain", records); await start(h, [p]); await transfer(h, 0, p, records);
  await h.send({ type: "import-session-complete" });
  const complete = h.messages.find(message => message.type === "complete");
  assert.ok(complete, "the session must post its complete message");
  assert.equal(complete.performanceReport.stageCounts["restore.topologySkippedPages"], 1);
  assert.deepEqual(h.figma.currentPage.children.map(node => node.name), records.map(item => item.id));
});

test("new root instances skip redundant main-component reads but nested swaps and overrides still run", async t => {
  const h = host();
  const masters = [record("A", "COMPONENT", { childIds: ["A-child"] }),
    record("A-child", "INSTANCE", { parentId: "A", mainComponentId: "B", childIds: ["A-leaf"] }), record("A-leaf", "FRAME", { parentId: "A-child" }),
    record("B", "COMPONENT", { childIds: ["B-leaf"] }), record("B-leaf", "FRAME", { parentId: "B" }),
    record("C", "COMPONENT", { childIds: ["C-leaf"] }), record("C-leaf", "FRAME", { parentId: "C" })];
  const design = [record("outer", "INSTANCE", { mainComponentId: "A", childIds: ["override-child"] }),
    record("override-child", "INSTANCE", { parentId: "outer", mainComponentId: "C", childIds: ["override-leaf"] }),
    record("override-leaf", "FRAME", { parentId: "override-child", props: { type: "FRAME", scence: { visible: false } } })];
  const pages = [page("Masters", masters), page("Design", design)]; await start(h, pages); await transfer(h, 0, pages[0], masters);
  h.stats.mainComponentReads = 0; h.stats.swaps = 0;
  await transfer(h, 1, pages[1], design);
  const outer = h.figma.currentPage.children[0], nested = outer.children[0];
  assert.equal(h.stats.mainComponentReads, 1, "only the nested instance needs a component check");
  assert.equal(h.stats.swaps, 1); assert.equal(nested.mainComponent.name, "C");
  assert.equal(nested.children[0].visible, false);
  t.diagnostic(JSON.stringify({ rootInstances: 1, nestedInstances: 1, mainComponentReads: h.stats.mainComponentReads, nestedSwaps: h.stats.swaps }));
});

function fontApi() {
  const code = esbuild.buildSync({ stdin: { contents: 'export * from "./ReceiveFromMasterGo/src/fontLoader"; export {state} from "./ReceiveFromMasterGo/src/state";',
    resolveDir: root }, bundle: true, format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
  const module = { exports: {} }, available = [{ fontName: { family: "Refreshed", style: "Regular" } }];
  new Function("module", "exports", "figma", code)(module, module.exports, { listAvailableFontsAsync: async () => available });
  return module.exports;
}

test("warm font checks avoid index enumeration and still rebuild on replacement, clearing and refresh", async t => {
  const api = fontApi();
  api.state.documentFonts = Array.from({ length: 500 }, (_, i) => ({ fontName: { family: "Font" + i, style: "Regular" } }));
  api.rebuildAvailableFontIndex();
  const keys = Object.keys; let enumerations = 0;
  Object.keys = value => { if (value === api.state.availableFontKeys) enumerations++; return keys(value); };
  try { for (let i = 0; i < 100; i++) await api.ensureAvailableFontsLoaded(); }
  finally { Object.keys = keys; }
  assert.equal(enumerations, 0, "a valid cached catalog must not enumerate every font per text");
  api.state.documentFonts = [{ fontName: { family: "NewList", style: "Regular" } }];
  await api.ensureAvailableFontsLoaded(); assert.equal(api.state.availableFontKeys["NewList\nRegular"], true);
  api.state.availableFontKeys = {};
  await api.ensureAvailableFontsLoaded(); assert.equal(api.state.availableFontKeys["NewList\nRegular"], true);
  await api.refreshAvailableFonts(); assert.equal(api.state.availableFontKeys["Refreshed\nRegular"], true);
  assert.equal(api.state.availableFontKeys["NewList\nRegular"], undefined);
  api.state.reset(); await api.ensureAvailableFontsLoaded();
  assert.equal(api.state.availableFontKeys["Refreshed\nRegular"], true, "session reset retains the valid font index");
  t.diagnostic(JSON.stringify({ fontEntries: 500, warmChecks: 100, indexEnumerations: enumerations }));
});
