const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const source = fs.readFileSync(require.resolve("../../ReceiveFromMasterGo/src/code.ts"), "utf8");

function extract(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0 && source.indexOf(end, offset) > offset);
  return esbuild.transformSync(source.slice(offset, source.indexOf(end, offset)), { loader: "ts", target: "es2017" }).code;
}

const bindingCode = extract("async function applyImportedStyleBindings(", "function startImportAsset(");
const stateCode = extract("async function applyInstanceRecordState(", "// After a page finishes restoring");
const childCode = extract("async function applyInstanceChildOverrides(", "// See applyInstanceChildOverrides:");

test("compatibility text containers keep instance text and vector overrides off the transparent wrapper", async () => {
  const paint = r => [{ type: "SOLID", color: { r, g: 0, b: 0 } }];
  const calls = [];
  const text = { type: "TEXT", characters: "template", fontName: { family: "Inter", style: "Regular" },
    opacity: 1, visible: true, textAutoResize: "NONE", fills: paint(.1),
    async setFillStyleIdAsync(id) { calls.push(["fill", id]); },
    async setTextStyleIdAsync(id) { calls.push(["text", id]); } };
  const vector = { type: "VECTOR", visible: true, fills: paint(.2) };
  const wrapper = { type: "FRAME", visible: true, opacity: 1, fills: [], children: [text, vector],
    getPluginData: key => key === "mastergo2figma.textChildContainer" ? "1" : "" };
  const instance = { type: "INSTANCE", children: [wrapper] };
  const session = { figmaStyleIdByRef: { paint: "P", body: "T" } };
  const bindings = new Function("activeImportSession", bindingCode + ";return applyImportedStyleBindings;")(session);
  const run = new Function("activeImportSession", "figma", "loadFontCached", "applyConnectorTextFallback", "comparablePaintKey",
    "safeSetFills", "safeSetStrokes", "applyInstanceTextFormatting", "applyImportedStyleBindings", "INSTANCE_LAYOUT_OVERRIDE_KEYS", "pendingInstanceLayoutOverrides", "registerMissingFontTextCandidate",
    childCode + ";return applyInstanceChildOverrides;")(
    session, { mixed: Symbol("mixed") }, async () => {}, () => {}, JSON.stringify,
    (node, fills) => { node.fills = fills; }, () => {}, async () => {}, bindings, [], [], () => {});
  const records = {
    heading: { id: "heading", props: { type: "TEXT", characters: "override", geometry: { fills: paint(.8) },
      scence: { visible: false }, blend: { opacity: .6 } }, childIds: ["outline"], fillStyleRef: "paint", textStyleRef: "body" },
    outline: { id: "outline", props: { type: "VECTOR", scence: { visible: false }, geometry: { fills: paint(.9) } }, childIds: [] }
  };
  await run(instance, { childIds: ["heading"] }, records, false);
  assert.deepEqual(wrapper.fills, []);
  assert.equal(wrapper.visible, false);
  assert.equal(wrapper.opacity, .6);
  assert.equal(text.characters, "override");
  assert.equal(text.visible, true);
  assert.equal(text.opacity, 1);
  assert.equal(vector.visible, false);
  assert.deepEqual(vector.fills, paint(.9));
  assert.deepEqual(calls, [["fill", "P"], ["text", "T"]]);
});

test("real instance roots bind their own local styles after properties, before sublayer overrides", async () => {
  const order = [];
  const instance = {
    type: "INSTANCE",
    async setFillStyleIdAsync(id) { order.push(["fill", id]); },
    async setStrokeStyleIdAsync(id) { order.push(["stroke", id]); },
    async setEffectStyleIdAsync(id) { order.push(["effect", id]); }
  };
  const session = { figmaStyleIdByRef: { paint: "P", stroke: "S", effect: "E" } };
  const run = new Function("activeImportSession", "applyManifestLayoutToProps", "applyProperties", "applyInstanceChildOverrides",
    bindingCode + stateCode + ";return applyInstanceRecordState;")(
    session, props => props, async () => order.push(["properties"]), async () => order.push(["children"]));
  await run(instance, { id: "instance", props: {}, fillStyleRef: "paint", strokeStyleRef: "stroke", effectStyleRef: "effect" }, {});
  assert.deepEqual(order, [["properties"], ["fill", "P"], ["stroke", "S"], ["effect", "E"], ["children"]]);
});

test("instance sublayers retain separate paint and mixed-range text style bindings", async () => {
  const calls = [];
  const fontCandidates = [];
  const rect = { type: "RECTANGLE", async setFillStyleIdAsync(id) { calls.push(["shape-style", id]); } };
  const text = { type: "TEXT", characters: "ABCD", fontName: { family: "Inter", style: "Regular" }, textAutoResize: "NONE",
    async setRangeTextStyleIdAsync(...args) { calls.push(["range-style", ...args]); } };
  const instance = { type: "INSTANCE", children: [rect, text] };
  const session = { figmaStyleIdByRef: { color: "Paint", body: "Body" } };
  const bindings = new Function("activeImportSession", bindingCode + ";return applyImportedStyleBindings;")(session);
  const run = new Function("activeImportSession", "figma", "loadFontCached", "applyConnectorTextFallback", "comparablePaintKey",
    "safeSetFills", "safeSetStrokes", "applyInstanceTextFormatting", "applyImportedStyleBindings", "INSTANCE_LAYOUT_OVERRIDE_KEYS", "pendingInstanceLayoutOverrides", "registerMissingFontTextCandidate",
    childCode + ";return applyInstanceChildOverrides;")(
    session, { mixed: Symbol("mixed") }, async () => {}, () => {}, () => null, () => {}, () => {},
    async () => calls.push(["typography"]), bindings, [], [], node => fontCandidates.push(node));
  const records = {
    shape: { id: "shape", props: {}, childIds: [], fillStyleRef: "color" },
    text: { id: "text", props: {}, childIds: [], textStyleRanges: [
      { start: 0, end: 2, styleRef: "body" }, { start: 2, end: 4, styleRef: "missing" }
    ] }
  };
  await run(instance, { childIds: ["shape", "text"] }, records, false);
  assert.deepEqual(calls, [["shape-style", "Paint"], ["typography"], ["range-style", 0, 2, "Body"]]);
  assert.deepEqual(fontCandidates, [text]);
});

test("a rejected instance style binding keeps applying child overrides", async () => {
  let childOverrides = 0;
  const session = { figmaStyleIdByRef: { missing: "Gone" } };
  const run = new Function("activeImportSession", "applyManifestLayoutToProps", "applyProperties", "applyInstanceChildOverrides",
    bindingCode + stateCode + ";return applyInstanceRecordState;")(
    session, props => props, async () => {}, async () => childOverrides++);
  await run({ type: "INSTANCE", async setFillStyleIdAsync() { throw Error("Style unavailable"); } },
    { id: "instance", props: {}, fillStyleRef: "missing" }, {});
  assert.equal(childOverrides, 1);
});
