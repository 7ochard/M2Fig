const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { inspectLargeBridgePackage } = require("../inspectLargeBridgePackage.js");

function fixture({ brokenRoot = false, collectedStats = false, danglingRef } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-large-inspect-"));
  const zip = path.join(directory, "design.zip");
  const pages = [{ id: "p1", name: "Components", pageFile: "p1/index.json", layerCount: 2 },
    { id: "p2", name: "Design", pageFile: "p2/index.json", layerCount: 1 }];
  const records = [[{ id: "master", parentId: null, childIds: ["paint"], props: { type: "COMPONENT" } },
    { id: "paint", parentId: "master", index: 0, childIds: [], fillStyleRef: "style", props: { type: "RECTANGLE",
      geometry: { fills: [{ type: "IMAGE", imageRef: "alias" }] } } }],
    [{ id: "instance", parentId: null, childIds: [], mainComponentId: "master", props: { type: "INSTANCE" } }]];
  const entries = { "manifest.json": { schema: "mastergo2figma.package.v2", version: 2, documentId: 123,
    documentName: "Large inspection fixture", pages, assets: { raw: { path: "images/a.bin" }, alias: { path: "images/a.bin" },
      other: { path: "images/b.bin" } }, diagnostics: [{ code: "SOURCE_NOTICE", message: "Fixture" }], stats: { layerCount: 3 } },
    "styles.json": { schema: "mastergo2figma.styles.v1", version: 1, styles: [{ id: "style", styleType: "PAINT", paints: [] }] } };
  if (collectedStats) {
    records[0].push({ id: "empty", parentId: null, childIds: [], props: { type: "COMPONENT" } });
    records[1].push({ id: "fallback", parentId: null, childIds: [], instanceStructureFallback: true,
      props: { type: "FRAME", sourceType: "INSTANCE" } });
    pages[0].layerCount = 3;
    pages[0].isDependencyPage = true;
    pages[1].layerCount = 2;
    // The instance precedes its component to require deferred reference checks.
    pages.reverse(); records.reverse();
    entries["manifest.json"].stats.layerCount = 5;
    entries["styles.json"].styles[0].paints = [{ type: "IMAGE", imageRef: "raw" }];
  }
  const painted = records.flat().find(record => record.id === "paint");
  if (danglingRef === "image") painted.props.geometry.fills[0].imageRef = "unlisted-image";
  if (danglingRef === "style") painted.textStyleRanges = [{ start: 0, end: 1, styleRef: "unlisted-style" }];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    entries[page.pageFile] = { schema: "mastergo2figma.page.v2", version: 2, id: page.id,
      rootNodeIds: brokenRoot && i === 1 ? ["absent"] : records[i].filter(record => record.parentId === null).map(record => record.id),
      layerChunks: [page.id + "/layers.json"] };
    entries[page.id + "/layers.json"] = { schema: "mastergo2figma.layers.v2", version: 2, records: records[i] };
  }
  const data = path.join(directory, "fixture.json");
  fs.writeFileSync(data, JSON.stringify(entries));
  const code = ["import sys,json,zipfile", "entries=json.load(open(sys.argv[1],encoding='utf8'))",
    "with zipfile.ZipFile(sys.argv[2],'x',allowZip64=True) as z:",
    " for name,value in entries.items():",
    "  info=zipfile.ZipInfo(name); info.compress_type=zipfile.ZIP_DEFLATED",
    "  with z.open(info,'w',force_zip64=True) as f: f.write(json.dumps(value).encode('utf8'))",
    " for name,value in [('images/a.bin',3),('images/b.bin',7)]:",
    "  with z.open(name,'w',force_zip64=True) as f:",
    "   for i in range(8): f.write(bytes([value])*65536)",
    "with zipfile.ZipFile(sys.argv[2]) as z,open(sys.argv[2],'rb') as stream:",
    " infos=z.infolist(); json_entries=[]",
    " for info in infos:",
    "  if not info.filename.endswith('.json'): continue",
    "  stream.seek(info.header_offset+26); lengths=stream.read(4)",
    "  start=info.header_offset+30+int.from_bytes(lengths[:2],'little')+int.from_bytes(lengths[2:],'little')",
    "  json_entries.append(dict(name=info.filename,start=start,end=start+info.compress_size,size=info.file_size))",
    " directory_bytes=sum(46+len(i.filename.encode('utf8'))+len(i.extra)+len(i.comment) for i in infos)",
    " print(json.dumps(dict(jsonEntries=json_entries,entryCount=len(infos),directoryBytes=directory_bytes)))"].join("\n");
  const result = spawnSync("python", ["-c", code, data, zip], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { directory, zip, output: path.join(directory, "inspection.json"), ...JSON.parse(result.stdout) };
}

test("structural JSON is read once while visitors retain page and reference statistics", async () => {
  const item = fixture({ collectedStats: true }), openAsBlob = fs.openAsBlob;
  const payloads = new Map(item.jsonEntries.map(entry => [`${entry.start}:${entry.end}`, entry.name]));
  const reads = Object.fromEntries(item.jsonEntries.map(entry => [entry.name, 0]));
  let rangeReadBytes = 0;
  fs.openAsBlob = async function(filename, ...args) {
    const blob = await openAsBlob.call(this, filename, ...args);
    if (path.resolve(filename) !== item.zip) return blob;
    return { size: blob.size, slice(start, end) {
      rangeReadBytes += end - start;
      const name = payloads.get(`${start}:${end}`);
      if (name) reads[name]++;
      return blob.slice(start, end);
    } };
  };
  let report;
  try { report = await inspectLargeBridgePackage(item.zip, item.output); } finally { fs.openAsBlob = openAsBlob; }
  assert.deepEqual(reads, Object.fromEntries(item.jsonEntries.map(entry => [entry.name, 1])));
  assert.equal(report.sourceStats.entryReadCount, item.jsonEntries.length);
  assert.equal(report.sourceStats.entryReadBytes, item.jsonEntries.reduce((sum, entry) => sum + entry.size, 0));
  const expectedBytes = Math.min(fs.statSync(item.zip).size, 22 + 65535 + 20) + item.directoryBytes + item.entryCount * 30 +
    item.jsonEntries.reduce((sum, entry) => sum + entry.end - entry.start, 0);
  assert.equal(rangeReadBytes, expectedBytes, "directory/header reads plus each structural JSON payload once");
  assert.equal(report.sourceStats.rangeReadBytes, rangeReadBytes);
  assert.deepEqual(report.pages.map(page => [page.id, page.rootCount]), [["p2", 2], ["p1", 2]]);
  assert.equal(report.designPageCount, 1);
  assert.equal(report.dependencyPageCount, 1);
  assert.equal(report.recordCount, 5);
  assert.equal(report.componentCount, 2);
  assert.deepEqual(report.emptyComponentIds, ["empty"]);
  assert.equal(report.sourceInstanceCount, 2);
  assert.equal(report.structureFallbackCount, 1);
  assert.deepEqual(report.unresolvedMainIds, ["missing"]);
  assert.deepEqual(report.unresolvedImageRefs, []);
  assert.deepEqual(report.unresolvedStyleRefs, []);
  assert.equal(report.styleCount, 1);
  assert.equal(report.crc.crcValidatedEntries, item.entryCount);
});

test("record visitors preserve unresolved nested image and mixed-text style rejection", async () => {
  for (const danglingRef of ["image", "style"]) {
    const item = fixture({ collectedStats: true, danglingRef });
    await assert.rejects(inspectLargeBridgePackage(item.zip, item.output), /Unresolved style\/image references/);
    assert.equal(fs.existsSync(item.output), false);
  }
});

test("independent inspection counts pages/components/resource aliases without any full-ZIP readFileSync", async () => {
  const item = fixture(), read = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) {
    if (typeof filename === "string" && path.resolve(filename) === item.zip) throw new Error("Whole-ZIP readFileSync forbidden");
    return read.call(this, filename, ...args);
  };
  let report;
  try { report = await inspectLargeBridgePackage(item.zip, item.output); } finally { fs.readFileSync = read; }
  assert.equal(report.ok, true);
  assert.equal(report.designPageCount, 2);
  assert.equal(report.recordCount, 3);
  assert.equal(report.componentCount, 1);
  assert.equal(report.sourceInstanceCount, 1);
  assert.deepEqual(report.unresolvedMainIds, []);
  assert.equal(report.assetCount, 3);
  assert.equal(report.physicalAssetCount, 2);
  assert.equal(report.styleCount, 1);
  assert.equal(report.canonicalDigest, null);
  assert.equal(report.canonicalDigestStatus, "not-recomputed");
  assert.equal(report.crc.crcValidatedEntries, 8);
  assert.equal(report.crc.readBlockBytes, 65536);
  assert.ok(report.sourceStats.maxEntryBytes < 10000, "Node must only load structural JSON payloads");
  assert.equal(report.sha256, crypto.createHash("sha256").update(read(item.zip)).digest("hex"));
});

test("unreferenced image CRC corruption and broken graph are both rejected without a success report", async () => {
  const item = fixture();
  const code = ["import sys,zipfile,struct", "p=sys.argv[1]",
    "with zipfile.ZipFile(p) as z: i=z.getinfo('images/b.bin'); offset=i.header_offset",
    "with open(p,'r+b') as f:", " f.seek(offset+26); name,extra=struct.unpack('<HH',f.read(4))",
    " f.seek(offset+30+name+extra); value=f.read(1); f.seek(-1,1); f.write(bytes([value[0]^1]))"].join("\n");
  const changed = spawnSync("python", ["-c", code, item.zip], { encoding: "utf8" });
  assert.equal(changed.status, 0, changed.stderr);
  await assert.rejects(inspectLargeBridgePackage(item.zip, item.output), /CRC/);
  assert.equal(fs.existsSync(item.output), false);
  const broken = fixture({ brokenRoot: true });
  await assert.rejects(inspectLargeBridgePackage(broken.zip, broken.output), /ROOT_OR_CHILD_MISSING|NODE_UNREACHABLE/);
  assert.equal(fs.existsSync(broken.output), false);
});

test("optional canonical evidence binds exact size/SHA and clearly marks same-path and byte-identical-copy provenance", async () => {
  const item = fixture();
  const original = fs.readFileSync(item.zip), sha256 = crypto.createHash("sha256").update(original).digest("hex");
  const conversion = path.join(item.directory, "conversion.json");
  const verified = { status: "verified", output: item.zip, bytes: original.length, sha256, canonicalDigest: "fnv1a32:12345678" };
  fs.writeFileSync(conversion, JSON.stringify(verified));
  const report = await inspectLargeBridgePackage(item.zip, item.output, { conversionReport: conversion });
  assert.equal(report.canonicalDigest, verified.canonicalDigest);
  assert.equal(report.canonicalDigestEvidence, "bound-conversion-report-not-independently-recomputed");
  assert.equal(report.independentChecks.canonicalDigestRecomputed, false);
  assert.match(report.canonicalDigestBinding, /same-output-path/);
  const copy = path.join(item.directory, "copy.zip");
  fs.copyFileSync(item.zip, copy);
  const copied = await inspectLargeBridgePackage(copy, path.join(item.directory, "copy-inspection.json"), { conversionReport: conversion });
  assert.match(copied.canonicalDigestBinding, /explicit-byte-identical-copy/);
  for (const invalid of [{ ...verified, status: "failed" }, { ...verified, sha256: "0".repeat(64) },
    { ...verified, bytes: verified.bytes + 1 }, { ...verified, canonicalDigest: null }]) {
    fs.writeFileSync(conversion, JSON.stringify(invalid));
    const output = path.join(item.directory, crypto.randomUUID() + ".json");
    await assert.rejects(inspectLargeBridgePackage(item.zip, output, { conversionReport: conversion }), /byte\/hash-bound/);
    assert.equal(fs.existsSync(output), false);
  }
});

test("existing output is never overwritten", async () => {
  const item = fixture();
  fs.writeFileSync(item.output, "keep report");
  await assert.rejects(inspectLargeBridgePackage(item.zip, item.output), /refusing overwrite/);
  assert.equal(fs.readFileSync(item.output, "utf8"), "keep report");
});
