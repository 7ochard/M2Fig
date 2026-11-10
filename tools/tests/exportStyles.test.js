const test = require("node:test");
const assert = require("node:assert/strict");
const esbuild = require("../../SendToFigma/node_modules/esbuild");
const code = esbuild.buildSync({
  entryPoints: [require.resolve("../../SendToFigma/src/styleExporter.ts")],
  bundle: true, platform: "node", format: "cjs", write: false
}).outputFiles[0].text;

function setup(source) {
  const calls = [];
  const mg = { mixed: Symbol("mg.mixed"), getStyleById(id) { calls.push(id); return source[id] || null; } };
  const mod = { exports: {} };
  new Function("module", "exports", "require", "mg", code)(mod, mod.exports, require, mg);
  return { ...mod.exports, mg, calls };
}

const paint = (id = "paint") => ({
  id, type: "PAINT", name: "品牌/颜色", paints: [
    { type: "SOLID", color: { r: 0.2, g: 0.3, b: 0.4, a: 0.6 }, isVisible: true, alpha: 1, blendMode: "PASS_THROUGH" }
  ]
});
const text = (id = "text") => ({
  id, type: "TEXT", name: "Typography/Heading", fontName: { family: "Inter", style: "SemiBold" },
  fontSize: 20, lineHeight: { unit: "PERCENT", value: 150 },
  letterSpacing: 2, letterSpacingUnit: "PERCENT", textCase: "UPPER", decoration: "UNDERLINE"
});

test("shared source paints and typography export once and attach source style references", () => {
  const source = { paint: paint(), text: text() };
  const api = setup(source);
  const first = {};
  api.collectNodeStyleRefs({ id: "shape", type: "RECTANGLE", fillStyleId: "paint", strokeFillStyleId: "paint" }, first);
  const second = {};
  api.collectNodeStyleRefs({ id: "heading", type: "TEXT", fillStyleId: "paint", characters: "Title",
    textStyles: [{ start: 0, end: 5, textStyleId: "text" }] }, second);
  assert.deepEqual(first, { fillStyleRef: "paint", strokeStyleRef: "paint" });
  assert.deepEqual(second, { fillStyleRef: "paint", textStyleRef: "text" });
  assert.deepEqual(api.calls, ["paint", "text"]);
  const exported = api.getExportStyles();
  assert.equal(exported.length, 2);
  assert.equal(exported[0].paints[0].opacity, 0.6);
  assert.equal(exported[0].paints[0].blendMode, "NORMAL");
  assert.deepEqual(exported[1].fontName, { family: "Inter", style: "Semi Bold" });
  assert.deepEqual(exported[1].lineHeight, { unit: "PIXELS", value: 30 });
  assert.deepEqual(exported[1].letterSpacing, { unit: "PERCENT", value: 2 });
  assert.equal(exported[1].textDecoration, "UNDERLINE");
  source.paint.paints[0].color.r = 1;
  source.text.fontName.family = "Changed";
  assert.equal(exported[0].paints[0].color.r, 0.2);
  assert.equal(exported[1].fontName.family, "Inter");
  assert.deepEqual(api.getExportStyleDiagnostics(), []);
});

test("mixed text style ranges use UTF-16 offsets after ordered-list marker removal", () => {
  const api = setup({ heading: text("heading"), body: text("body") });
  const record = {};
  api.collectNodeStyleRefs({ id: "mixed", type: "TEXT", characters: "😀A\n\u{F0010}BC", listStyles: [{ start: 3, end: 6, type: "ORDERED", level: 0 }],
    textStyles: [{ start: 0, end: 3, textStyleId: "heading" }, { start: 3, end: 6, textStyleId: "body" }] }, record);
  assert.equal(record.textStyleRef, undefined);
  assert.deepEqual(record.textStyleRanges, [{ start: 0, end: 4, styleRef: "heading" }, { start: 4, end: 6, styleRef: "body" }]);
});

test("missing, empty, unsupported and incompatible styles do not bind empty replacements", () => {
  const api = setup({
    image: { id: "image", type: "PAINT", name: "Image", paints: [{ type: "IMAGE", imageRef: "asset" }] },
    empty: { id: "empty", type: "PAINT", name: "Empty", paints: [] },
    malformed: { id: "malformed", type: "PAINT", name: "Malformed", paints: [{ type: "SOLID" }] },
    grid: { id: "grid", type: "GRID", name: "Grid", layoutGrids: [] },
    text: text()
  });
  for (const id of ["absent", "image", "empty", "malformed", "grid", "text"]) {
    const record = { props: { geometry: { fills: [{ type: "SOLID" }] } } };
    api.collectNodeStyleRefs({ id: `node-${id}`, type: "RECTANGLE", fillStyleId: id }, record);
    assert.equal(record.fillStyleRef, undefined);
    assert.deepEqual(record.props.geometry.fills, [{ type: "SOLID" }]);
  }
  api.collectNodeStyleRefs({ id: "repeat", type: "RECTANGLE", fillStyleId: "absent" }, {});
  assert.equal(api.calls.filter(id => id === "absent").length, 1);
  assert.equal(api.getExportStyleDiagnostics().length, 6);
  assert.equal(api.getExportStyles().some(style => style.styleType === "PAINT"), false);
});

test("an unreadable optional stroke getter cannot suppress a valid fill binding", () => {
  const api = setup({ paint: paint() });
  const record = {};
  api.collectNodeStyleRefs({ id: "partial", type: "RECTANGLE", fillStyleId: "paint",
    get strokePaintStyleId() { throw Error("unsupported getter"); } }, record);
  assert.deepEqual(record, { fillStyleRef: "paint" });
  assert.equal(api.getExportStyleDiagnostics()[0].code, "STYLE_REFERENCE_UNREADABLE");
});

test("effect styles normalize visibility and retained references, and reset isolates exports", () => {
  const api = setup({ effect: { id: "effect", name: "阴影", type: "EFFECT", effects: [{
    type: "DROP_SHADOW", isVisible: false, radius: 8, spread: 2,
    color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, blendMode: "MULTIPLY"
  }] } });
  const record = {};
  api.collectNodeStyleRefs({ id: "shadow", type: "RECTANGLE", effectStyleId: "effect", fillStyleId: api.mg.mixed }, record);
  assert.deepEqual(record, { effectStyleRef: "effect" });
  assert.equal(api.getExportStyles()[0].effects[0].visible, false);
  assert.equal(api.getExportStyles()[0].effects[0].blendMode, "MULTIPLY");
  api.resetExportStyles();
  assert.deepEqual(api.getExportStyles(), []);
  assert.deepEqual(api.getExportStyleDiagnostics(), []);
  api.collectNodeStyleRefs({ id: "another", type: "RECTANGLE", effectStyleId: "effect" }, {});
  assert.equal(api.calls.length, 2);
});
