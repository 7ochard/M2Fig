const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { convertMgPackageToV2Entries } = require("../../ReceiveFromMasterGo/src/ui/mgPackage.js");
const { validateV2Package } = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");
const { readZipEntries } = require("../read_zip_entries.js");
const { convertWholeFile } = require("../convertWholeFile.js");

const cli = path.resolve(__dirname, "../convertWholeFile.js");
const decode = bytes => JSON.parse(Buffer.from(bytes).toString("utf8"));
const page = (id, name, code) => Buffer.from(`\x01${id}\0\x02${name}\0\x03${code}\0`);
function node(id, parent, subtype, reference, code = "a0") {
  return Buffer.concat([
    Buffer.from(`\x01${id}\0${parent ? `\x02${parent}\0` : ""}${code ? `\x03${code}\0` : ""}\x04${subtype}\0${reference ? `\x1a${reference}\0` : ""}`),
    Buffer.from([0x1c, 7, 3, 0,
      ...(subtype === "COMPONENT" ? [5, 1] : subtype === "INSTANCE" ? [6, 1]
        : subtype === "COMPONENT_SET" ? [7, 1, ...Buffer.from("Variants\0"), 0] : []),
      0, 0, 0x1d, 1, 0])
  ]);
}
function fixture() {
  return { document: Buffer.concat([
    page("0:1", "设计 / First", "a0"), page("0:2", "组件 / Library", "a1"), page("0:3", "空页", "a2"),
    node("1:1", "0:1", "INSTANCE", "2:2"),
    node("2:1", "0:2", "COMPONENT_SET"),
    node("2:2", "2:1", "COMPONENT"), node("2:3", "2:1", "COMPONENT", undefined, "a1"),
    node("2:4", "2:2", "INSTANCE", "9:2"), node("2:8", "0:2", "INSTANCE", "9:2", "a1"),
    node("2:9", "0:2", "FRAME", undefined, "a2"),
    node("9:1", null, "COMPONENT_SET", undefined, ""),
    node("9:2", "9:1", "COMPONENT"), node("9:3", "9:1", "COMPONENT", undefined, "a1"),
    node("9:4", "9:2", "INSTANCE", "9:5"),
    node("9:5", null, "COMPONENT", undefined, ""), node("9:6", "9:5", "FRAME")
  ]), "images/design-resource.bin": Buffer.from([0, 255, 7, 64, 128, 13, 10, 35]) };
}
function nativeArchive(directory, entries) {
  for (const [name, bytes] of Object.entries(entries)) {
    const destination = path.join(directory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const source = path.join(directory, "input.mg");
  const result = spawnSync("python", ["-c", [
    "import sys, pathlib, zipfile",
    "root, output = pathlib.Path(sys.argv[1]), sys.argv[2]",
    "with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:",
    "    for name in sys.argv[3:]: archive.write(root / name, name)"
  ].join("\n"), directory, source, ...Object.keys(entries)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return source;
}
function run(source, output, options = {}) {
  return spawnSync(process.execPath, [cli, source, output], { encoding: "utf8", ...options });
}

test("whole-file decoder retains all pages and one transitive variant dependency closure", () => {
  const entries = convertMgPackageToV2Entries(fixture(), "whole.mg", { wholeFile: true });
  const validation = validateV2Package(entries);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.deepEqual(validation.manifest.pages.map(p => p.name), ["迁移依赖", "设计 / First", "组件 / Library", "空页"]);
  const records = Array.from(validation.records.values(), item => item.record);
  const byId = new Map(records.map(record => [record.id, record]));
  assert.equal(records.filter(record => record.id === "9:2").length, 1);
  assert.deepEqual(byId.get("9:1").childIds, ["9:2", "9:3"]);
  assert.equal(byId.get("1:1").mainComponentId, "2:2");
  assert.equal(byId.get("2:8").mainComponentId, "9:2");
  assert.equal(byId.get("9:4").mainComponentId, "9:5");
  assert.ok(byId.has("2:9"));
  assert.ok(byId.has("9:6"));
  assert.equal(records.some(record => record.libraryMaster || record.id.startsWith("mgdep-")), false);
});

test("whole-file decoder accepts an entirely empty native file without a preview pass", () => {
  const entries = convertMgPackageToV2Entries({ document: page("0:1", "空页", "a0") }, "empty.mg", { wholeFile: true });
  const validation = validateV2Package(entries);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.manifest.pages.map(p => [p.name, p.layerCount]), [["空页", 0]]);
});

test("whole-file ZIP CLI preserves image bytes, source bytes, page order and component references", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-whole-file-"));
  const input = fixture();
  const source = nativeArchive(directory, input);
  const sourceBytes = fs.readFileSync(source);
  const output = path.join(directory, "out", "完整迁移.zip");
  const result = run(source, output);
  assert.equal(result.status, 0, result.stderr);
  const entries = readZipEntries(output);
  const validation = validateV2Package(entries);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.manifest.documentName, "input");
  assert.deepEqual(validation.manifest.pages.map(p => p.name), ["迁移依赖", "设计 / First", "组件 / Library", "空页"]);
  assert.deepEqual(entries["images/design-resource.bin"], input["images/design-resource.bin"]);
  assert.equal(validation.records.get("1:1").record.mainComponentId, "2:2");
  assert.equal(validation.records.get("2:8").record.mainComponentId, "9:2");
  assert.deepEqual(fs.readFileSync(source), sourceBytes);
  assert.equal(fs.readdirSync(path.dirname(output)).some(name => name.endsWith(".part")), false);
});

test("whole-file ZIP CLI refuses existing output and the source path without overwriting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-no-clobber-"));
  const source = nativeArchive(directory, fixture());
  const original = fs.readFileSync(source);
  const output = path.join(directory, "existing.zip");
  fs.writeFileSync(output, "existing output");
  assert.notEqual(run(source, output).status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "existing output");
  assert.notEqual(run(source, source).status, 0);
  assert.deepEqual(fs.readFileSync(source), original);
});

test("whole-file API and optional CLI document name survive ZIP roundtrip without using the output filename", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-document-name-"));
  const source = nativeArchive(directory, { document: page("0:1", "页面 1", "a0") });
  const output = path.join(directory, "arbitrary-output.zip");
  const result = await convertWholeFile(source, output, { documentName: "菜单" });
  assert.equal(result.documentName, "菜单");
  assert.equal(decode(readZipEntries(output)["manifest.json"]).documentName, "菜单");
  const cliOutput = path.join(directory, "different-output.zip");
  const cliResult = spawnSync(process.execPath, [cli, source, cliOutput, "--document-name", "外卖运营设计归档"], { encoding: "utf8" });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(decode(readZipEntries(cliOutput)["manifest.json"]).documentName, "外卖运营设计归档");
  const invalidOutput = path.join(directory, "invalid-name.zip");
  await assert.rejects(convertWholeFile(source, invalidOutput, { documentName: " " }), /documentName/);
  assert.equal(fs.existsSync(invalidOutput), false);
});

test("a destination created during writing is preserved and the unpublished ZIP stays in .part", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-publish-race-"));
  const source = nativeArchive(directory, fixture());
  const output = path.join(directory, "racing.zip");
  const conversion = convertWholeFile(source, output);
  fs.writeFileSync(output, "created during conversion", { flag: "wx" });
  await assert.rejects(conversion, /EEXIST/);
  assert.equal(fs.readFileSync(output, "utf8"), "created during conversion");
  const partials = fs.readdirSync(directory).filter(name => name.endsWith(".part"));
  assert.equal(partials.length, 1);
  assert.equal(validateV2Package(readZipEntries(path.join(directory, partials[0]))).ok, true);
});

test("whole-file ZIP CLI writes a valid package when every source page is empty", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-empty-zip-"));
  const source = nativeArchive(directory, { document: page("0:1", "空页", "a0") });
  const output = path.join(directory, "empty.zip");
  const result = run(source, output);
  assert.equal(result.status, 0, result.stderr);
  const validation = validateV2Package(readZipEntries(output));
  assert.equal(validation.ok, true);
  assert.equal(validation.records.size, 0);
  assert.deepEqual(validation.manifest.pages.map(p => p.name), ["空页"]);
});

test("failed conversion and a missing ZIP writer never publish a formal output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-failed-"));
  const invalid = path.join(directory, "invalid.mg");
  fs.writeFileSync(invalid, "invalid native file");
  const invalidOutput = path.join(directory, "invalid.zip");
  assert.notEqual(run(invalid, invalidOutput).status, 0);
  assert.equal(fs.existsSync(invalidOutput), false);
  const source = nativeArchive(directory, fixture());
  const output = path.join(directory, "writer-failed.zip");
  const result = run(source, output, { env: { ...process.env, PATH: "", Path: "" } });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(output), false);
});
