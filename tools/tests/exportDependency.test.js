const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../SendToFigma/node_modules/esbuild");
const { validateV2Package } = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

function compile(file, globals = {}) {
  const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, "../..", file)],
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" }).outputFiles[0].text;
  const module = { exports: {} };
  new Function("module", "exports", "require", ...Object.keys(globals), code)(
    module, module.exports, require, ...Object.values(globals));
  return module.exports;
}

function node(id, type, children = [], extra = {}) {
  const result = { id, type, name: id, children, parent: null, width: 100, height: 100, x: 0, y: 0,
    layoutGrids: [{ pattern: "GRID", sectionSize: 8, isVisible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } }],
    ...extra };
  for (const child of children) child.parent = result;
  return result;
}
const children = value => value.children || [];
const getMetadata = (api, value) => {
  const record = { id: value.id };
  api.applyExportInstanceMetadata(record);
  return record;
};

test("API export collects one external component set, all variants and nested definitions without writing source nodes", async () => {
  const nested = node("icon", "COMPONENT");
  const nestedInstance = node("nested-instance", "INSTANCE", [], { mainComponent: nested });
  const first = node("variant-a", "COMPONENT", [nestedInstance]);
  const second = node("variant-b", "COMPONENT");
  const set = node("set", "COMPONENT_SET", [first, second]);
  const instance = node("instance", "INSTANCE", [node("copy", "INSTANCE", [], { mainComponent: nested })], { mainComponent: first });
  const design = node("design", "PAGE", [instance]);
  for (const value of [nested, nestedInstance, first, second, set, instance, ...instance.children, design]) {
    Object.freeze(value.children);
    Object.freeze(value);
  }
  const api = compile("SendToFigma/src/exportDependencies.ts", { mg: { getNodeById: () => null } });
  const plan = await api.prepareExportDependencies([{ page: design }], children);
  assert.equal(plan.hasInstances, true);
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.targets[0].isDependencyPage, true);
  assert.deepEqual(plan.targets[0].page.children.map(value => value.id), ["set", "icon"]);
  assert.equal(plan.targets[1].page, design);
  assert.equal(getMetadata(api, instance).mainComponentId, "variant-a");
  assert.equal(getMetadata(api, instance).instanceStructureFallback, undefined);
  assert.equal(api.resolveExportNode("variant-a"), first);
  assert.equal(api.resolveExportNode("variant-b"), second);
  assert.equal(api.resolveExportNode("nested-instance"), nestedInstance);
  assert.deepEqual(plan.diagnostics, []);
});

test("masters already on selected pages stay there and two pages share one identity", async () => {
  const master = node("master", "COMPONENT");
  const first = node("first", "INSTANCE", [], { mainComponent: master });
  const second = node("second", "INSTANCE", [], { mainComponent: master });
  const designA = node("a", "PAGE", [first]);
  const designB = node("b", "PAGE", [master, second]);
  const api = compile("SendToFigma/src/exportDependencies.ts", { mg: { getNodeById: () => null } });
  const targets = [{ page: designA }, { page: designB }];
  const plan = await api.prepareExportDependencies(targets, children);
  assert.equal(plan.targets, targets);
  assert.equal(getMetadata(api, first).mainComponentId, "master");
  assert.equal(getMetadata(api, second).mainComponentId, "master");
  assert.equal(master.parent, designB);
});

test("missing definitions and incompatible instance trees produce explicit fallback metadata", async () => {
  const master = node("master", "COMPONENT", [node("expected", "RECTANGLE")]);
  const changed = node("changed", "INSTANCE", [node("actual", "TEXT")], { mainComponent: master });
  const missing = node("missing", "INSTANCE");
  const api = compile("SendToFigma/src/exportDependencies.ts", { mg: { getNodeById: () => null } });
  const plan = await api.prepareExportDependencies([{ page: node("page", "PAGE", [changed, missing]) }], children);
  assert.equal(getMetadata(api, changed).instanceStructureFallback, true);
  assert.equal(getMetadata(api, missing).instanceStructureFallback, true);
  assert.deepEqual(plan.diagnostics.map(item => item.code), ["COMPONENT_DEFINITION_MISSING", "INSTANCE_STRUCTURE_FALLBACK"]);
  await api.prepareExportDependencies([{ page: node("other", "PAGE") }], children);
  assert.deepEqual(getMetadata(api, changed), { id: "changed" });
  assert.equal(api.resolveExportNode("master"), null);
});

test("uniformly scaled instance geometry is exported as native instanceScale", async () => {
  const master = node("master", "COMPONENT", [node("expected", "RECTANGLE", [], { width: 20, height: 30, x: 10, y: 5 })]);
  const instance = node("scaled", "INSTANCE", [node("actual", "RECTANGLE", [], { width: 10, height: 15, x: 5, y: 2.5 })],
    { mainComponent: master, width: 50, height: 50 });
  const api = compile("SendToFigma/src/exportDependencies.ts", { mg: { getNodeById: () => null } });
  await api.prepareExportDependencies([{ page: node("page", "PAGE", [instance]) }], children);
  assert.deepEqual(getMetadata(api, instance), { id: "scaled", mainComponentId: "master", instanceScale: 0.5 });
});

test("native scaleFactor takes precedence over independently resized outer bounds", async () => {
  const master = node("master", "COMPONENT", [node("expected", "RECTANGLE")]);
  const instance = node("scaled", "INSTANCE", [node("actual", "RECTANGLE", [], { width: 60, height: 50 })],
    { mainComponent: master, width: 60.46, height: 48, scaleFactor: 0.625 });
  const api = compile("SendToFigma/src/exportDependencies.ts", { mg: { getNodeById: () => null } });
  await api.prepareExportDependencies([{ page: node("page", "PAGE", [instance]) }], children);
  assert.deepEqual(getMetadata(api, instance), { id: "scaled", mainComponentId: "master", instanceScale: 0.625 });
});

test("deep equivalent trees retain their instance relation without expanding structural strings exponentially", async () => {
  let expected = node("expected-leaf", "RECTANGLE");
  let actual = node("actual-leaf", "RECTANGLE");
  for (let depth = 0; depth < 80; depth++) {
    expected = node(`expected-${depth}`, "FRAME", [expected]);
    actual = node(`actual-${depth}`, "FRAME", [actual]);
  }
  const master = node("master", "COMPONENT", [expected]);
  const instance = node("instance", "INSTANCE", [actual], { mainComponent: master });
  const api = compile("SendToFigma/src/exportDependencies.ts", { mg: { getNodeById: () => null } });
  const plan = await api.prepareExportDependencies([{ page: node("page", "PAGE", [instance]) }], children);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(getMetadata(api, instance), { id: "instance", mainComponentId: "master" });
});

test("the streamed API package preserves dependency flags, instance links and styles in one relay namespace", async () => {
  const masterChild = node("master-child", "FRAME");
  const master = node("master", "COMPONENT", [masterChild]);
  const broken = { id: "13:79", get type() { throw new Error('The node with id "13:79" does not exist'); } };
  const unusedVariant = node("13:74", "COMPONENT", [broken]);
  const set = node("set", "COMPONENT_SET", [master, unusedVariant]);
  const instanceChild = node("instance-child", "FRAME");
  const instance = node("instance", "INSTANCE", [instanceChild], { mainComponent: master, fillStyleId: "paint",
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, isVisible: true }] });
  const design = node("design", "PAGE", [instance], { selection: [] });
  const nodes = { design, instance, "instance-child": instanceChild };
  const files = {}, pending = {}, messages = [];
  let api;
  const mg = { document: { children: [design], currentPage: design }, documentId: 7,
    getNodeById: id => nodes[id] || null,
    getStyleById: id => id === "paint" ? { id, name: "Brand", type: "PAINT", paints: [
      { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, isVisible: true }
    ] } : null,
    ui: { postMessage(message) {
      messages.push(message);
      if (message.type === "export-file-start") pending[message.index] = { path: message.path, chunks: [] };
      if (message.type === "export-file-chunk") pending[message.index].chunks.push(Buffer.from(message.bytes || message.content));
      if (message.type === "export-file-end") {
        const value = pending[message.index];
        files[value.path] = Buffer.concat(value.chunks);
        queueMicrotask(() => api.resolveExportFileAck({ ...message, success: true }));
      }
      if (message.type === "export-transfer-complete") {
        queueMicrotask(() => api.resolveExportTransferAck({ ...message, success: true }));
      }
    } }
  };
  const fs = require("node:fs");
  const source = fs.readFileSync(path.resolve(__dirname, "../../SendToFigma/src/transferStream.ts"), "utf8");
  const code = esbuild.buildSync({ stdin: {
    contents: source + '\nexport { initializeRules } from "./layerRules";',
    resolveDir: path.resolve(__dirname, "../../SendToFigma/src"), loader: "ts"
  }, bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" }).outputFiles[0].text;
  const module = { exports: {} };
  new Function("module", "exports", "require", "mg", code)(module, module.exports, require, mg);
  api = module.exports;
  api.initializeRules();
  await api.streamJsonExportPackage({ scope: "all-pages", pageIds: [], transferMode: "local-json-stream", relayUrl: "http://localhost" });
  const manifest = JSON.parse(files["manifest.json"]);
  assert.equal(messages.filter(message => message.type === "export-transfer-start").length, 1);
  assert.deepEqual(manifest.pages.map(page => page.isDependencyPage === true), [true, false]);
  assert.equal(JSON.parse(files[manifest.pages[0].pageFile]).isDependencyPage, true);
  const records = Object.entries(files).filter(([name]) => name.includes("/layers/")).flatMap(([, bytes]) => JSON.parse(bytes).records);
  assert.equal(records.find(record => record.id === "instance").mainComponentId, "master");
  assert.equal(records.find(record => record.id === "instance").fillStyleRef, "paint");
  assert.equal(records.filter(record => record.id === "master").length, 1);
  assert.equal(records.filter(record => record.id === "master-child").length, 1);
  assert.equal(records.some(record => record.id === "13:79"), false);
  assert.equal(records.find(record => record.id === "13:74").childIds.length, 0);
  assert.equal(records.find(record => record.id === "instance").instanceStructureFallback, undefined);
  assert.deepEqual(manifest.diagnostics.filter(item => item.code === "UNREADABLE_SOURCE_NODE"), [
    { code: "UNREADABLE_SOURCE_NODE", id: "13:79", parent: "13:74", index: 0,
      error: 'The node with id "13:79" does not exist' }
  ]);
  assert.equal(JSON.parse(files["styles.json"]).styles[0].name, "Brand");
  assert.equal(validateV2Package(files).ok, true);
  assert.equal(design.children[0], instance);
  assert.equal(instance.mainComponent, master);
  assert.equal(master.parent, set);
  assert.equal(unusedVariant.children[0], broken);
});

test("an unreadable connector getter is reported during counting and excluded from later serialization", async () => {
  const broken = node("broken-connector", "CONNECTOR");
  Object.defineProperty(broken, "width", { get() { throw new Error('The node with id "broken-connector" does not exist'); } });
  const design = node("page", "PAGE", [broken]);
  const source = require("node:fs").readFileSync(path.resolve(__dirname, "../../SendToFigma/src/transferStream.ts"), "utf8");
  const code = esbuild.buildSync({ stdin: { contents: source + '\nexport * from "./exportDependencies"; export { getSafeExportableChildren } from "./nodeTraverser";',
    resolveDir: path.resolve(__dirname, "../../SendToFigma/src"), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" }).outputFiles[0].text;
  const module = { exports: {} };
  new Function("module", "exports", "require", "mg", code)(module, module.exports, require, { getNodeById: () => null });
  const api = module.exports;
  const plan = await api.prepareExportDependencies([{ page: design }], api.getSafeExportableChildren);
  await api.countNodes(broken, "page", 0);
  assert.deepEqual(api.getSafeExportableChildren(design), []);
  assert.equal(plan.diagnostics[0].code, "UNREADABLE_SOURCE_NODE");
  assert.equal(plan.diagnostics[0].id, "broken-connector");
  assert.equal(plan.diagnostics[0].parent, "page");
});
