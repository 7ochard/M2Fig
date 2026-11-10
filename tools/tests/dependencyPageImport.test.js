const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");

const pluginCode = process.env.BRIDGE_BASELINE_BUNDLE ? fs.readFileSync(process.env.BRIDGE_BASELINE_BUNDLE, "utf8") : esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/src/code.ts")],
  bundle: true,
  write: false,
  target: "es2017",
  logLevel: "silent"
}).outputFiles[0].text;

// Exercise the shipped session/chunk message interface with a small Figma host.
// Components own real mock instances, so deleting a master or page is observable.
function createHost(options = {}) {
  let nextId = 0;
  const messages = [];
  const notifications = [];
  const calls = { createFrame: 0, createInstance: 0 };
  const root = { type: "DOCUMENT", name: "Target file", children: [] };
  function makeNode(type) {
    const node = {
      id: String(++nextId), type, name: type, removed: false, children: [], parent: null,
      x: 0, y: 0, width: 100, height: 100, fills: [], strokes: [], layoutMode: "NONE",
      appendChild(child) { this.insertChild(this.children.length, child); },
      insertChild(index, child) {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
        this.children.splice(index, 0, child);
        child.parent = this;
      },
      remove() {
        for (const child of [...this.children]) child.remove();
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
        this.removed = true;
      },
      loadAsync: async () => {},
      findAll(predicate) {
        return this.children.flatMap(child => [
          ...(predicate(child) ? [child] : []), ...child.findAll(predicate)
        ]);
      },
      getPluginData: () => "",
      setPluginData: () => {},
      resize(width, height) { this.width = width; this.height = height; }
    };
    if (type === "PAGE") {
      root.children.push(node);
      node.parent = root;
    }
    if (type === "COMPONENT") {
      node.createInstance = () => {
        if (options.failInstances) throw new Error("Cannot create instance");
        calls.createInstance++;
        const instance = makeNode("INSTANCE");
        instance.mainComponent = node;
        instance.getMainComponentAsync = async () => node;
        const copy = source => {
          const clone = makeNode(source.type);
          clone.name = source.name;
          for (const child of source.children) clone.appendChild(copy(child));
          return clone;
        };
        for (const child of node.children) instance.appendChild(copy(child));
        return instance;
      };
    }
    return node;
  }
  const previousPage = makeNode("PAGE");
  previousPage.name = "Existing design";
  const figma = {
    root,
    fileKey: "target-key",
    currentPage: previousPage,
    showUI: () => {},
    ui: { postMessage: message => messages.push(message) },
    createPage: () => makeNode("PAGE"),
    createComponent: () => makeNode("COMPONENT"),
    createFrame: () => { calls.createFrame++; return makeNode("FRAME"); },
    setCurrentPageAsync: async page => { figma.currentPage = page; },
    viewport: { scrollAndZoomIntoView(nodes) {
      if (options.failFinalizeViewport) throw new Error("Viewport failed");
      this.lastNodes = nodes;
    } },
    notify: message => notifications.push(message),
    listAvailableFontsAsync: async () => {
      if (options.failFonts) throw new Error("Font catalog failed");
      return [{ fontName: { family: "Inter", style: "Regular" } }];
    },
    mixed: Symbol("mixed")
  };
  const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
  new Function("figma", "__html__", "console", "setTimeout", pluginCode)(
    figma, "", quietConsole, callback => { callback(); return 0; }
  );
  const send = message => figma.ui.onmessage({ transferId: "test", requestId: "test", ...message });
  return { figma, messages, notifications, previousPage, send, calls };
}

function record(id, type, extra = {}) {
  return { version: 2, id, name: id, parentId: null, index: 0, childIds: [],
    props: { id, type: type === "INSTANCE" ? "FRAME" : type, sourceType: type, name: id }, ...extra };
}

function page(id, records, isDependencyPage = false) {
  return { schema: "mastergo2figma.page.v2", version: 2, id, name: id, folder: id,
    rootNodeIds: records.filter(item => !item.parentId).map(item => item.id),
    layerChunks: [], layerCount: records.length, isDependencyPage };
}

async function start(host, pages, extra = {}) {
  await host.send({ type: "import-session-start", totalPages: pages.length,
    totalNodes: pages.reduce((sum, item) => sum + item.layerCount, 0),
    manifest: { schema: "mastergo2figma.package.v2", version: 2, pages, assets: {} }, ...extra });
}

async function transferPage(host, pageIndex, pageData, records) {
  await host.send({ type: "import-page-start", pageIndex, page: pageData });
  await host.send({ type: "import-page-chunk", pageIndex, records });
  await host.send({ type: "import-page-end", pageIndex });
}

async function complete(host) {
  await host.send({ type: "import-session-complete" });
  return host.messages.findLast(message => message.type === "complete");
}

test("a dependency master persists, design-page masters stay in place, and the first design page is focused", async () => {
  const host = createHost();
  const dependencies = [record("shared", "COMPONENT", { libraryMaster: true })];
  const design = [record("instance", "INSTANCE", { mainComponentId: "shared" }),
    record("local", "COMPONENT"), record("local-instance", "INSTANCE", { mainComponentId: "local" })];
  const pages = [page("Dependencies", dependencies, true), page("Design", design)];
  await start(host, pages);
  await transferPage(host, 0, pages[0], dependencies);
  await transferPage(host, 1, pages[1], design);
  const result = await complete(host);
  const [, dependencyPage, designPage] = host.figma.root.children;
  const master = dependencyPage.children[0];
  assert.equal(master.type, "COMPONENT");
  assert.equal(master.removed, false);
  assert.equal(designPage.children[0].type, "INSTANCE");
  assert.equal(designPage.children[0].mainComponent, master);
  assert.equal(designPage.children[1].parent, designPage);
  assert.equal(designPage.children[2].mainComponent, designPage.children[1]);
  assert.equal(host.figma.currentPage, designPage);
  assert.equal(host.figma.viewport.lastNodes, designPage.children);
  assert.equal(result.pageCount, 1);
  assert.equal(result.dependencyPageCount, 1);
  assert.equal(result.dependencyComponentCount, 1);
  assert.equal(result.layerCount, 4);
  assert.equal(result.unresolvedInstanceCount, 0);
});

test("two design pages share one persistent dependency definition", async () => {
  const host = createHost();
  const records = [[record("shared", "COMPONENT", { libraryMaster: true })],
    [record("first", "INSTANCE", { mainComponentId: "shared" })],
    [record("second", "INSTANCE", { mainComponentId: "shared" })]];
  const pages = records.map((items, index) => page(`Page ${index}`, items, index === 0));
  await start(host, pages);
  for (let index = 0; index < pages.length; index++) await transferPage(host, index, pages[index], records[index]);
  const result = await complete(host);
  const [, dependencies, first, second] = host.figma.root.children;
  assert.equal(first.children[0].mainComponent, dependencies.children[0]);
  assert.equal(second.children[0].mainComponent, dependencies.children[0]);
  assert.equal(result.pageCount, 2);
  assert.equal(result.dependencyPageCount, 1);
  assert.equal(result.dependencyComponentCount, 1);
  assert.equal(host.figma.currentPage, first);
});

test("missing definitions and structural instance fallbacks are reported without losing editable children", async () => {
  const host = createHost();
  const records = [record("missing", "INSTANCE", { missingMainComponentId: "absent", instanceStructureFallback: true, childIds: ["child"] }),
    record("child", "FRAME", { parentId: "missing" }),
    record("structure", "INSTANCE", { mainComponentId: "master", instanceStructureFallback: true }),
    record("master", "COMPONENT")];
  const design = page("Design", records);
  await start(host, [design]);
  await transferPage(host, 0, design, records);
  const result = await complete(host);
  const fallback = host.figma.currentPage.children.find(node => node.name === "missing");
  assert.equal(fallback.type, "FRAME");
  assert.equal(fallback.children[0].name, "child");
  assert.equal(result.unresolvedInstanceCount, 2);
  assert.deepEqual(result.unresolvedInstanceDetails, [
    { sourceId: "missing", name: "missing", mainComponentId: "absent", reason: "missing-component" },
    { sourceId: "structure", name: "structure", mainComponentId: "master", reason: "structure-fallback" }
  ]);
  assert.match(host.notifications.at(-1), /2.*普通图层/);
});

test("a later-page relink removes the temporary fallback from the final report", async () => {
  const host = createHost();
  const records = [[record("instance", "INSTANCE", { mainComponentId: "master" })], [record("master", "COMPONENT")]];
  const pages = records.map((items, index) => page(`Design ${index}`, items));
  await start(host, pages);
  for (let index = 0; index < pages.length; index++) await transferPage(host, index, pages[index], records[index]);
  const result = await complete(host);
  assert.equal(host.figma.root.children[1].children[0].type, "INSTANCE");
  assert.equal(result.unresolvedInstanceCount, 0);
});

test("a failed instance creation remains visible in the result", async () => {
  const host = createHost({ failInstances: true });
  const records = [record("master", "COMPONENT"), record("instance", "INSTANCE", { mainComponentId: "master" })];
  const design = page("Design", records);
  await start(host, [design]);
  await transferPage(host, 0, design, records);
  const result = await complete(host);
  assert.equal(result.unresolvedInstanceCount, 1);
  assert.equal(result.unresolvedInstanceDetails[0].reason, "instance-creation-failed");
  assert.equal(host.figma.currentPage.children[1].type, "FRAME");
});

test("a later page restore failure preserves dependency and partial pages and focuses retained design", async () => {
  const host = createHost();
  const dependencies = [record("shared", "COMPONENT")];
  const invalid = [record("invalid", "UNSUPPORTED")];
  const pages = [page("Dependencies", dependencies, true), page("Broken", invalid)];
  await start(host, pages);
  await transferPage(host, 0, pages[0], dependencies);
  const dependencyPage = host.figma.root.children[1];
  await transferPage(host, 1, pages[1], invalid);
  assert.equal(dependencyPage.removed, false);
  const partialDesign = host.figma.root.children[2];
  assert.deepEqual(host.figma.root.children, [host.previousPage, dependencyPage, partialDesign]);
  assert.equal(dependencyPage.children[0].name, "shared");
  assert.equal(partialDesign.name, "Broken");
  assert.deepEqual(partialDesign.children, []);
  assert.equal(host.figma.currentPage, partialDesign);
  assert.equal(host.messages.at(-1).type, "import-ack");
  assert.equal(host.messages.at(-1).success, false);
  assert.deepEqual(host.messages.at(-1).retainedImport.pages.map(item => item.status), ["completed", "partial"]);
  assert.equal(host.messages.some(message => message.type === "complete"), false);
});

test("a finalize failure preserves imported pages and their completed status", async () => {
  const host = createHost({ failFinalizeViewport: true });
  const records = [[record("shared", "COMPONENT")], [record("design", "FRAME")]];
  const pages = records.map((items, index) => page(`Page ${index}`, items, index === 0));
  await start(host, pages);
  for (let index = 0; index < pages.length; index++) await transferPage(host, index, pages[index], records[index]);
  const dependencyPage = host.figma.root.children[1];
  assert.equal(await complete(host), undefined);
  assert.equal(dependencyPage.removed, false);
  const designPage = host.figma.root.children[2];
  assert.deepEqual(host.figma.root.children, [host.previousPage, dependencyPage, designPage]);
  assert.equal(dependencyPage.children[0].name, "shared");
  assert.equal(designPage.children[0].name, "design");
  assert.equal(host.figma.currentPage, designPage);
  assert.equal(host.messages.at(-1).type, "error");
  assert.deepEqual(host.messages.at(-1).retainedImport.pages.map(item => item.status), ["completed", "completed"]);
});

test("a known later-page master does not build and discard a full temporary instance subtree", async () => {
  const host = createHost();
  const instanceChildren = Array.from({ length: 100 }, (_, i) => `override-${i}`);
  const masterChildren = Array.from({ length: 100 }, (_, i) => `template-${i}`);
  const records = [
    [record("instance", "INSTANCE", { mainComponentId: "master", childIds: instanceChildren }),
      ...instanceChildren.map(id => record(id, "FRAME", { parentId: "instance" }))],
    [record("master", "COMPONENT", { childIds: masterChildren }),
      ...masterChildren.map(id => record(id, "FRAME", { parentId: "master" }))]
  ];
  const pages = records.map((items, i) => page(`Page ${i}`, items));
  await start(host, pages, { componentIds: ["master"] });
  await transferPage(host, 0, pages[0], records[0]);
  assert.equal(host.calls.createFrame, 1, "only the lightweight placeholder may be created before its master");
  await transferPage(host, 1, pages[1], records[1]);
  const result = await complete(host);
  const instance = host.figma.root.children[1].children[0];
  assert.equal(instance.type, "INSTANCE");
  assert.equal(instance.children.length, 100);
  assert.equal(host.calls.createFrame, 101, "100 master children plus the one placeholder");
  assert.equal(result.layerCount, 202);
  assert.equal(result.unresolvedInstanceCount, 0);
});

test("a promised master that never arrives still restores editable fallback children exactly once", async () => {
  const host = createHost();
  const records = [record("instance", "INSTANCE", { mainComponentId: "absent", childIds: ["first", "second"] }),
    record("first", "FRAME", { parentId: "instance" }), record("second", "FRAME", { parentId: "instance" })];
  const design = page("Design", records);
  await start(host, [design], { componentIds: ["absent"] });
  await transferPage(host, 0, design, records);
  assert.equal(host.calls.createFrame, 1);
  const result = await complete(host);
  assert.equal(host.calls.createFrame, 3);
  assert.deepEqual(host.figma.currentPage.children[0].children.map(node => node.name), ["first", "second"]);
  assert.equal(result.layerCount, 3);
  assert.equal(result.unresolvedInstanceCount, 1);
});

test("complete reports source records separately from successful direct factory calls and names the actual target", async () => {
  const host = createHost();
  const records = [record("frame", "FRAME")];
  const design = page("Design", records);
  await start(host, [design]);
  await transferPage(host, 0, design, records);
  const result = await complete(host);
  assert.equal(result.performanceReport.sourceRecordCount, 1);
  assert.equal(result.performanceReport.apiCreationCount, 2);
  assert.equal(result.performanceReport.restoreStats.restoredNodes, 1);
  assert.equal(result.performanceReport.restoreStats.pageCount, 1);
  assert.equal(result.performanceReport.targetDocumentName, "Target file");
  assert.equal(result.performanceReport.targetFileKey, "target-key");
  assert.ok(result.performanceReport.restoreStats.safeSetWriteCount > 0);
});

test("abort after a later resource error retains new pages, while stale abort does not affect the active transfer", async () => {
  const host = createHost();
  const design = page("Design", [record("frame", "FRAME")]);
  await start(host, [design]);
  await transferPage(host, 0, design, [record("frame", "FRAME")]);
  const importedPage = host.figma.root.children[1];
  await host.send({ type: "import-session-abort", transferId: "stale" });
  assert.equal(host.figma.root.children.length, 2);
  await host.send({ type: "import-session-abort", error: "asset CRC mismatch" });
  assert.deepEqual(host.figma.root.children, [host.previousPage, importedPage]);
  assert.equal(importedPage.children[0].name, "frame");
  assert.equal(host.figma.currentPage, importedPage);
  assert.equal(host.messages.at(-1).success, true);
  assert.equal(host.messages.at(-1).retainedImport.completedPageCount, 1);
  assert.equal(host.messages.some(message => message.type === "complete"), false);
});

test("a standalone empty design page imports and focuses successfully", async () => {
  const host = createHost();
  const empty = page("Empty", []);
  await start(host, [empty]);
  await transferPage(host, 0, empty, []);
  const result = await complete(host);
  assert.equal(result.pageCount, 1);
  assert.equal(result.layerCount, 0);
  assert.equal(result.dependencyPageCount, 0);
  assert.equal(result.dependencyComponentCount, 0);
  assert.equal(result.unresolvedInstanceCount, 0);
  assert.equal(host.figma.currentPage.name, "Empty");
  assert.deepEqual(host.figma.currentPage.children, []);
  assert.equal(host.figma.viewport.lastNodes, undefined);
});

test("invalid node counts are rejected before creating a page", async () => {
  for (const totalNodes of [-1, NaN, Infinity, "invalid", 0.5]) {
    const host = createHost();
    await host.send({ type: "import-session-start", totalNodes, totalPages: 1,
      manifest: { schema: "mastergo2figma.package.v2", version: 2, pages: [page("Empty", [])], assets: {} } });
    assert.equal(host.messages.at(-1).type, "import-ack");
    assert.equal(host.messages.at(-1).success, false);
    assert.deepEqual(host.figma.root.children, [host.previousPage]);
  }
});
