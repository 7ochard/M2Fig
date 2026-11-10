const test = require("node:test");
const assert = require("node:assert/strict");
const { convertMgPackageToV2Entries, __test } = require("../../ReceiveFromMasterGo/src/ui/mgPackage.js");
const { validateV2Package } = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

const decode = bytes => JSON.parse(Buffer.from(bytes).toString("utf8"));
const records = entries => Object.entries(entries)
  .filter(([path]) => path.includes("/layers/"))
  .flatMap(([, bytes]) => decode(bytes).records);

function page(id, name, code) {
  return Buffer.from(`\x01${id}\0\x02${name}\0\x03${code}\0`);
}

function node(id, parent, subtype, reference, code = "a0") {
  return Buffer.concat([
    Buffer.from(`\x01${id}\0${parent ? `\x02${parent}\0` : ""}${code ? `\x03${code}\0` : ""}\x04${subtype}\0${reference ? `\x1a${reference}\0` : ""}`),
    Buffer.from([0x1c, 7, 3, 0,
      ...(subtype === "COMPONENT" ? [5, 1] : subtype === "INSTANCE" ? [6, 1]
        : subtype === "COMPONENT_SET" ? [7, 1, ...Buffer.from("Variants\0"), 0] : []),
      0, 0, 0x1d, 1, 0])
  ]);
}

function fixture(extra = []) {
  return { document: Buffer.concat([
    page("0:1", "Screen", "a0"), page("0:2", "Library", "a1"), page("0:3", "Empty", "a2"),
    node("1:1", "0:1", "INSTANCE", "2:1"),
    node("2:1", "0:2", "COMPONENT"),
    node("2:9", "0:2", "FRAME"),
    ...extra
  ]) };
}

test("native preview exposes stable source page ids without materializing layer packages", () => {
  const input = fixture();
  const original = Buffer.from(input.document);
  const entries = convertMgPackageToV2Entries(input, "selection.mg", { previewOnly: true });
  assert.deepEqual(Object.keys(entries), ["manifest.json"]);
  assert.deepEqual(decode(entries["manifest.json"]).pages.map(p => [p.id, p.name, p.layerCount]), [
    ["mgpage-0", "Screen", 1], ["mgpage-1", "Library", 2], ["mgpage-2", "Empty", 0]
  ]);
  assert.deepEqual(input.document, original);
});

test("a single page includes its cross-page master once on a persistent dependency page", () => {
  const entries = convertMgPackageToV2Entries(fixture(), "selection.mg", {
    selectedPageIds: ["mgpage-0"], slimInstanceDescendants: true
  });
  const manifest = decode(entries["manifest.json"]);
  assert.deepEqual(manifest.pages.map(p => p.id), ["mg-dependencies", "mgpage-0"]);
  assert.equal(manifest.pages[0].isDependencyPage, true);
  assert.equal(decode(entries[manifest.pages[0].pageFile]).isDependencyPage, true);
  const result = records(entries);
  assert.deepEqual(result.map(r => r.id), ["2:1", "1:1"]);
  assert.equal(result.find(r => r.id === "1:1").mainComponentId, "2:1");
  assert.equal(result.find(r => r.id === "2:1").libraryMaster, undefined);
  assert.equal(result.find(r => r.id === "2:1").parentId, null);
  assert.equal(validateV2Package(entries).ok, true);
});

test("selecting the master page reuses the source master without a dependency duplicate", () => {
  const entries = convertMgPackageToV2Entries(fixture(), "selection.mg", {
    selectedPageIds: ["mgpage-0", "mgpage-1"]
  });
  const manifest = decode(entries["manifest.json"]);
  assert.deepEqual(manifest.pages.map(p => p.id), ["mgpage-0", "mgpage-1"]);
  assert.equal(records(entries).filter(r => r.id === "2:1").length, 1);
  assert.equal(records(entries).find(r => r.id === "1:1").mainComponentId, "2:1");
  assert.equal(validateV2Package(entries).ok, true);
});

test("selecting a later or empty page preserves its preview id and excludes other content", () => {
  const entries = convertMgPackageToV2Entries(fixture(), "selection.mg", { selectedPageIds: ["mgpage-2"] });
  assert.deepEqual(decode(entries["manifest.json"]).pages.map(p => [p.id, p.layerCount]), [["mgpage-2", 0]]);
  assert.deepEqual(records(entries), []);
  assert.equal(validateV2Package(entries).ok, true);
});

test("a native file containing only empty pages supports preview and explicit selection", () => {
  const input = { document: page("0:1", "Empty", "a0") };
  const preview = convertMgPackageToV2Entries(input, "empty.mg", { previewOnly: true });
  assert.deepEqual(decode(preview["manifest.json"]).pages, [{ id: "mgpage-0", name: "Empty", layerCount: 0 }]);
  const entries = convertMgPackageToV2Entries(input, "empty.mg", { selectedPageIds: ["mgpage-0"] });
  assert.equal(validateV2Package(entries).ok, true);
  assert.deepEqual(records(entries), []);
});

test("invalid or empty page selections fail before returning a package", () => {
  assert.throws(() => convertMgPackageToV2Entries(fixture(), "selection.mg", { selectedPageIds: [] }), /页面/);
  assert.throws(() => convertMgPackageToV2Entries(fixture(), "selection.mg", { selectedPageIds: ["mgpage-99"] }), /页面/);
});

test("missing master diagnostics retain source identity and full editable fallback fields", () => {
  const input = { document: Buffer.concat([
    page("0:1", "Screen", "a0"),
    node("1:1", "0:1", "INSTANCE", "9:9"),
    node("1:2", "1:1", "FRAME")
  ]) };
  const entries = convertMgPackageToV2Entries(input, "missing.mg", {
    selectedPageIds: ["mgpage-0"], slimInstanceDescendants: true
  });
  const manifest = decode(entries["manifest.json"]);
  assert.deepEqual(manifest.diagnostics, [{ code: "COMPONENT_DEFINITION_MISSING", nodeId: "1:1", componentId: "9:9" }]);
  const result = records(entries);
  const instance = result.find(r => r.id === "1:1");
  assert.equal(instance.missingMainComponentId, "9:9");
  assert.equal(instance.instanceStructureFallback, true);
  assert.equal(instance.mainComponentId, undefined);
  assert.equal(result.find(r => r.id === "1:2").props.geometry.strokeWeight, 1);
  assert.equal(validateV2Package(entries).ok, true);
});

test("selected dependency closure retains sets, nested dependencies and cycles without unrelated page roots", () => {
  const makeNode = (id, subtype, parent, templateRef) => ({ id, type: "FRAME", parent, templateRef, containerMeta: { subtype } });
  const nodes = {
    instance: makeNode("instance", "INSTANCE", "screen", "variant"),
    set: makeNode("set", "COMPONENT_SET", "library"),
    variant: makeNode("variant", "COMPONENT", "set"),
    alternate: makeNode("alternate", "COMPONENT", "set"),
    nested: makeNode("nested", "INSTANCE", "variant", "icon"),
    icon: makeNode("icon", "COMPONENT", "registry"),
    cycle: makeNode("cycle", "INSTANCE", "icon", "variant"),
    unused: makeNode("unused", "FRAME", "library")
  };
  const children = { set: ["variant", "alternate"], variant: ["nested"], icon: ["cycle"] };
  const pages = [{ id: "mgpage-0", name: "Screen", roots: ["instance"] }, { id: "mgpage-1", name: "Library", roots: ["set", "unused"] }];
  const plan = __test.planPageSelection(pages, nodes, children, ["mgpage-0"]);
  assert.deepEqual(plan.pages.map(p => p.id), ["mg-dependencies", "mgpage-0"]);
  assert.deepEqual(plan.pages[0].roots, ["set", "icon"]);
  assert.deepEqual(Object.keys(plan.reachable).sort(), ["alternate", "cycle", "icon", "instance", "nested", "set", "variant"]);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(children.set, ["variant", "alternate"]);
  assert.deepEqual(pages[1].roots, ["set", "unused"]);
});

test("shared external definitions are emitted once for the whole selected source file", () => {
  const input = fixture([node("3:1", "0:3", "INSTANCE", "2:1")]);
  const entries = convertMgPackageToV2Entries(input, "selection.mg", { selectedPageIds: ["mgpage-0", "mgpage-2"] });
  const result = records(entries);
  assert.equal(result.filter(r => r.id === "2:1").length, 1);
  assert.deepEqual(result.filter(r => r.props.sourceType === "INSTANCE").map(r => r.mainComponentId), ["2:1", "2:1"]);
  assert.equal(validateV2Package(entries).ok, true);
});

test("native referenced variants include their owning set and siblings on the dependency page", () => {
  const input = { document: Buffer.concat([
    page("0:1", "Screen", "a0"), page("0:2", "Library", "a1"),
    node("1:1", "0:1", "INSTANCE", "2:2"),
    node("2:1", "0:2", "COMPONENT_SET"),
    node("2:2", "2:1", "COMPONENT"), node("2:3", "2:1", "COMPONENT", undefined, "a1"),
    node("2:9", "0:2", "FRAME", undefined, "a1")
  ]) };
  const entries = convertMgPackageToV2Entries(input, "variants.mg", { selectedPageIds: ["mgpage-0"] });
  const result = Object.fromEntries(records(entries).map(r => [r.id, r]));
  assert.equal(result["2:1"].props.type, "COMPONENT_SET");
  assert.deepEqual(result["2:1"].childIds, ["2:2", "2:3"]);
  assert.equal(result["2:2"].parentId, "2:1");
  assert.equal(result["1:1"].mainComponentId, "2:2");
  assert.equal(result["2:9"], undefined);
  assert.equal(validateV2Package(entries).ok, true);
});

test("native off-canvas library masters persist once instead of receiving per-page aliases", () => {
  const input = { document: Buffer.concat([
    page("0:1", "First", "a0"), page("0:2", "Second", "a1"),
    node("1:1", "0:1", "INSTANCE", "3:1"), node("2:1", "0:2", "INSTANCE", "3:1"),
    node("3:1", null, "COMPONENT", undefined, "")
  ]) };
  const entries = convertMgPackageToV2Entries(input, "library.mg", { selectedPageIds: ["mgpage-0", "mgpage-1"] });
  const result = records(entries);
  assert.deepEqual(decode(entries["manifest.json"]).pages.map(p => p.id), ["mg-dependencies", "mgpage-0", "mgpage-1"]);
  assert.equal(result.filter(r => r.id === "3:1").length, 1);
  assert.equal(result.some(r => r.libraryMaster || r.id.startsWith("mgdep-")), false);
  assert.deepEqual(result.filter(r => r.props.sourceType === "INSTANCE").map(r => r.mainComponentId), ["3:1", "3:1"]);
  assert.equal(validateV2Package(entries).ok, true);
});
