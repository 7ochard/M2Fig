const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");

const repoRoot = path.resolve(__dirname, "../..");
const pluginCode = esbuild.buildSync({
  stdin: {
    contents: 'import "./ReceiveFromMasterGo/src/code.ts"; import { state } from "./ReceiveFromMasterGo/src/state.ts"; (figma as any).__textChildrenTestState = state;',
    resolveDir: repoRoot, loader: "ts",
  },
  bundle: true, write: false, target: "es2017", logLevel: "silent",
}).outputFiles[0].text;
const existingHost = fs.readFileSync(path.join(__dirname, "dependencyPageImport.test.js"), "utf8");
const hostCode = existingHost.slice(existingHost.indexOf("function createHost("), existingHost.indexOf("function record("));
const baseHost = new Function("pluginCode", hostCode + "; return createHost;")(pluginCode);

function createHost(options = {}) {
  const host = baseHost();
  const frameFactory = host.figma.createFrame;
  const pageFactory = host.figma.createPage;
  const created = [];
  let vectors = 0;
  function primitive(type, leaf = false) {
    const node = frameFactory();
    node.type = type;
    Object.assign(node, { visible: true, locked: false, opacity: 1, blendMode: "NORMAL", effects: [],
      relativeTransform: [[1, 0, 0], [0, 1, 0]], constraints: { horizontal: "MIN", vertical: "MIN" } });
    if (leaf) {
      delete node.children;
      delete node.appendChild;
      delete node.insertChild;
      node.findAll = () => [];
      node.remove = function () {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
        this.removed = true;
      };
    }
    node.setFillStyleIdAsync = async id => { node.fillStyleId = id; };
    created.push(node);
    return node;
  }
  host.figma.createFrame = () => primitive("FRAME");
  host.figma.createPage = () => { const page = pageFactory(); created.push(page); return page; };
  host.figma.createText = () => {
    const node = primitive("TEXT", true);
    node.characters = "";
    node.setTextStyleIdAsync = async id => { node.textStyleId = id; };
    return node;
  };
  host.figma.createVector = () => {
    if (++vectors === options.failVectorAt) throw new Error("Cannot create VECTOR child");
    const node = primitive("VECTOR", true);
    node.setVectorNetworkAsync = async network => { node.vectorNetwork = network; };
    return node;
  };
  host.figma.createRectangle = () => primitive("RECTANGLE", true);
  host.figma.loadFontAsync = async () => {};
  host.figma.createPaintStyle = () => ({ id: "paint-style", remove() {} });
  host.figma.createTextStyle = () => ({ id: "text-style", remove() {} });
  return { ...host, created };
}

function record(id, type, parentId = null, childIds = [], props = {}) {
  return { version: 2, id, name: id, parentId, index: 0, childIds,
    props: { id, type, sourceType: type, name: id, ...props } };
}

function textFixture(childCount = 8) {
  const childIds = Array.from({ length: childCount }, (_, index) => `outline-${index}`);
  const parent = record("heading", "TEXT", null, childIds, {
    name: "Editable heading", characters: "Sample editable heading", fontName: { family: "Inter", style: "Regular" }, fontSize: 24,
    geometry: { fills: [{ type: "SOLID", color: { r: .2, g: .4, b: .6 }, opacity: .8 }], strokes: [] },
    layout: { x: 120, y: 80, width: 240, height: 72, relativeTransform: [[.8, .6, 120], [-.6, .8, 80]] },
    constraints: { horizontal: "CENTER", vertical: "CENTER" },
    scence: { visible: false, locked: true },
    blend: { opacity: .65, blendMode: "MULTIPLY", effects: [] },
  });
  parent.fillStyleRef = "ink";
  parent.textStyleRef = "heading-style";
  return [parent, ...childIds.map((id, index) => record(id, "VECTOR", "heading", [], {
    layout: { x: index * 13, y: index + 2, width: 10, height: 1,
      relativeTransform: [[1, 0, index * 13], [0, 1, index + 2]] },
  }))];
}

async function importRecords(host, records, { complete = true } = {}) {
  const page = { schema: "mastergo2figma.page.v2", version: 2, id: "design", name: "Synthetic design",
    folder: "design", rootNodeIds: [records[0].id], layerChunks: [], layerCount: records.length };
  await host.send({ type: "import-session-start", totalPages: 1, totalNodes: records.length,
    manifest: { schema: "mastergo2figma.package.v2", version: 2, pages: [page], assets: {} } });
  await host.send({ type: "import-styles", styles: [
    { id: "ink", name: "Ink", styleType: "PAINT", paints: records[0].props.geometry?.fills || [] },
    { id: "heading-style", name: "Heading", styleType: "TEXT", fontName: { family: "Inter", style: "Regular" }, fontSize: 24 },
  ] });
  await host.send({ type: "import-page-start", pageIndex: 0, page });
  await host.send({ type: "import-page-chunk", pageIndex: 0, records });
  await host.send({ type: "import-page-end", pageIndex: 0 });
  const rejected = host.messages.findLast(message => message.type === "import-ack" && message.success === false);
  if (!rejected && complete) await host.send({ type: "import-session-complete" });
  return { rejected, completed: host.messages.findLast(message => message.type === "complete") };
}

function assertRejectedWithoutTouchingOriginal(host, result) {
  assert.ok(result.rejected, "malformed or failed import must be rejected");
  assert.ok(host.figma.root.children.includes(host.previousPage));
  assert.equal(host.previousPage.removed, false, "the existing design must not be touched");
}

test("TEXT plus eight vectors preserves nine source records, editable text, child transforms and actual creation counts", async () => {
  const host = createHost();
  const records = textFixture();
  const before = JSON.stringify(records);
  const result = await importRecords(host, records);
  assert.equal(result.rejected, undefined, result.rejected?.error);
  assert.ok(result.completed);
  assert.equal(result.completed.layerCount, 9);
  const [wrapper] = host.figma.root.children[1].children;
  assert.equal(wrapper.type, "FRAME");
  assert.equal(wrapper.name, "Editable heading");
  assert.deepEqual(wrapper.fills, []);
  assert.deepEqual(wrapper.strokes, []);
  assert.deepEqual(wrapper.relativeTransform, records[0].props.layout.relativeTransform);
  assert.equal(wrapper.width, 240);
  assert.equal(wrapper.height, 72);
  assert.deepEqual(wrapper.constraints, records[0].props.constraints);
  assert.equal(wrapper.visible, false);
  assert.equal(wrapper.locked, true);
  assert.equal(wrapper.opacity, .65);
  assert.equal(wrapper.blendMode, "MULTIPLY");
  assert.equal(wrapper.children.length, 9);
  const [text, ...vectors] = wrapper.children;
  assert.equal(text.type, "TEXT");
  assert.equal("appendChild" in text, false, "native TEXT remains a leaf");
  assert.equal(text.characters, records[0].props.characters);
  assert.equal(text.fontSize, 24);
  assert.equal(text.width, 240);
  assert.equal(text.height, 72);
  assert.deepEqual(text.relativeTransform, [[1, 0, 0], [0, 1, 0]]);
  assert.equal(text.visible, true);
  assert.equal(text.locked, false);
  assert.equal(text.opacity, 1);
  assert.equal(text.blendMode, "NORMAL");
  assert.equal(text.fills[0].type, "SOLID");
  assert.equal(text.fills[0].color.r, .2);
  assert.equal(text.fills[0].opacity, .8);
  assert.equal(text.fillStyleId, "paint-style");
  assert.equal(text.textStyleId, "text-style");
  assert.equal(wrapper.fillStyleId, undefined, "text paint must not bind to the transparent wrapper");
  assert.deepEqual(vectors.map(node => node.name), records[0].childIds);
  for (let index = 0; index < vectors.length; index++) {
    assert.equal(vectors[index].type, "VECTOR");
    assert.equal(vectors[index].parent, wrapper);
    assert.deepEqual(vectors[index].relativeTransform, records[index + 1].props.layout.relativeTransform);
  }
  assert.equal(host.figma.__textChildrenTestState.restoredNodeIdBySourceId.heading, wrapper.id);
  assert.equal(host.created.filter(node => node.type !== "PAGE").length, 10);
  assert.equal(result.completed.performanceReport.sourceRecordCount, 9);
  assert.equal(result.completed.performanceReport.apiCreationCount, host.created.length);
  assert.equal(result.completed.performanceReport.apiCreationCount, 11, "ten native scene nodes plus one page");
  const details = [{ sourceId: "heading", name: "Editable heading", childCount: 8, pageName: "Synthetic design" }];
  assert.deepEqual(result.completed.textChildContainerDetails, details);
  assert.deepEqual(result.completed.performanceReport.textChildContainerDetails, details);
  assert.equal(JSON.stringify(records), before, "source records must not be mutated");
});

test("ordinary TEXT remains one native editable text without a compatibility wrapper", async () => {
  const host = createHost();
  const records = textFixture(0);
  const result = await importRecords(host, records);
  assert.equal(result.rejected, undefined, result.rejected?.error);
  assert.equal(result.completed.layerCount, 1);
  assert.equal(host.figma.root.children[1].children[0].type, "TEXT");
  assert.equal(host.created.filter(node => node.type !== "PAGE").length, 1);
  assert.deepEqual(result.completed.textChildContainerDetails || [], []);
});

test("explicit omitted children still fail full record accounting without touching the original page", async () => {
  const host = createHost();
  const records = textFixture();
  records[0].props.omitChildrenOnRestore = true;
  assertRejectedWithoutTouchingOriginal(host, await importRecords(host, records));
});

test("missing child records and duplicate child edges remain invalid without touching the original page", async () => {
  for (const kind of ["missing", "duplicate"]) {
    const host = createHost();
    const records = textFixture();
    if (kind === "missing") records.pop();
    else records[0].childIds.push(records[0].childIds[0]);
    assertRejectedWithoutTouchingOriginal(host, await importRecords(host, records));
  }
});

test("native child creation failure reports the actual error without touching the original page", async () => {
  const host = createHost({ failVectorAt: 3 });
  const result = await importRecords(host, textFixture());
  assertRejectedWithoutTouchingOriginal(host, result);
  assert.match(result.rejected.error, /无法创建图层|Cannot create VECTOR/);
  assert.ok(host.created.some(node => node.type === "TEXT"));
  assert.equal(host.created.filter(node => node.type === "VECTOR").length, 2);
});

test("a non-text leaf with children remains rejected rather than gaining a generic wrapper", async () => {
  const host = createHost();
  const records = textFixture();
  records[0].props.type = records[0].props.sourceType = "RECTANGLE";
  assertRejectedWithoutTouchingOriginal(host, await importRecords(host, records));
  assert.equal(host.created.some(node => node.type === "FRAME"), false);
});
