const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { inspectHeifImage, isHeif } = require("../inspectHeifImage.js");

// Self-generated 16x16 solid-red HEIC, not user content. FFmpeg libx265 encoded
// one synthetic lavfi color frame (-map_metadata -1); its hvcC and sample were
// placed in standard HEIF ftyp/meta/mdat boxes. Both libheif 1.23.2 and the
// installed heic-to 1.5.2/libheif 1.22.2 decoded it as solid red.
const RED_HEIC = Buffer.from("AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABOm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABWgAAABYAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAL5pcHJwAAAAoGlwY28AAAB0aHZjQwEBYAAAAJAAAAAAAB7wAPz9+PgAAA8DoAABABhAAQwB//8BYAAAAwCQAAADAAADAB6VmAmhAAEAKEIBAQFgAAADAJAAAAMAAAMAHqCIRZZWaryvAWgIAAADAAgAAAMACECiAAEABkQBwXPQiQAAABRpc3BlAAAAAAAAABAAAAAQAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBggMAAAAebWRhdAAAABIoAa8TgPUko/9oe7/OHn+hf4A=", "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64");
const cli = path.resolve(__dirname, "../inspectHeifImage.js");

function fixture(bytes = RED_HEIC, filename = "image.probe") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-heif-inspection-"));
  const file = path.join(directory, filename);
  fs.writeFileSync(file, bytes);
  return { directory, file };
}

function withDimensions(width, height) {
  const bytes = Buffer.from(RED_HEIC);
  const offset = bytes.indexOf(Buffer.from("ispe"));
  assert.ok(offset > 0);
  bytes.writeUInt32BE(width, offset + 8);
  bytes.writeUInt32BE(height, offset + 12);
  return bytes;
}

test("real HEIC rejected by the old Pillow seam fully decodes without changing its bytes", async () => {
  const item = fixture();
  const old = spawnSync("python", ["-B", "-c", "from PIL import Image; import sys; Image.open(sys.argv[1]).verify()", item.file],
    { encoding: "utf8", windowsHide: true });
  assert.notEqual(old.status, 0, "negative control: this is the actual unsupported-Pillow failure");
  assert.match(old.stderr, /UnidentifiedImageError/);
  assert.equal(isHeif(RED_HEIC), true);
  assert.deepEqual(await inspectHeifImage(item.file), { format: "HEIC", width: 16, height: 16, frameCount: 1, extension: "heic" });
  assert.deepEqual(fs.readFileSync(item.file), RED_HEIC);
  assert.deepEqual(fs.readdirSync(item.directory), ["image.probe"], "inspection must not write a converted image");
});

test("candidate detection validates ftyp brands rather than filenames and supports generic HEIF", async () => {
  assert.equal(isHeif(PNG), false);
  assert.equal(isHeif(Buffer.from("ftypheic")), false);
  const oversizedBox = Buffer.from(RED_HEIC);
  oversizedBox.writeUInt32BE(RED_HEIC.length + 1, 0);
  assert.equal(isHeif(oversizedBox), false);
  await assert.rejects(inspectHeifImage(fixture(PNG, "pretend.HEIC").file), /Not a HEIF/);
  const generic = Buffer.from(RED_HEIC);
  generic.write("mif1", 8, "ascii");
  generic.write("mif1", 20, "ascii");
  assert.deepEqual(await inspectHeifImage(fixture(generic).file), { format: "HEIF", width: 16, height: 16, frameCount: 1, extension: "heif" });
});

test("a real HEIC header with truncated payload is rejected rather than accepted as an image", async () => {
  const truncated = RED_HEIC.subarray(0, 64);
  assert.equal(isHeif(truncated), true, "a plausible ftyp alone only selects the decoder");
  await assert.rejects(inspectHeifImage(fixture(truncated).file), /HEIF/);
});

test("pixel decode rejects metadata dimensions that disagree with the encoded HEVC image", async () => {
  const item = fixture(withDimensions(32, 32));
  assert.equal(isHeif(fs.readFileSync(item.file)), true);
  await assert.rejects(inspectHeifImage(item.file), /pixel decode failed|incorrect dimensions/);
});

test("oversized dimensions are rejected before allocating the requested pixel buffer", async () => {
  await assert.rejects(inspectHeifImage(fixture(withDimensions(10000, 10000)).file), /dimensions exceed pixel limit/);
});

test("CLI emits only its JSON on stdout and keeps decoder diagnostics on stderr", () => {
  const good = spawnSync(process.execPath, [cli, fixture().file], { encoding: "utf8", windowsHide: true });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), { format: "HEIC", width: 16, height: 16, frameCount: 1, extension: "heic" });
  const bad = spawnSync(process.execPath, [cli, fixture(RED_HEIC.subarray(0, 64)).file],
    { encoding: "utf8", windowsHide: true });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /HEIF|Insufficient input/);
});

test("native HEIC fetch verifies pixels, preserves original bytes and reuses its validated cache", async () => {
  const { fetchRequiredImages } = require("../convertCachedMasterGo.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-heif-fetch-"));
  const md5 = crypto.createHash("md5").update(RED_HEIC).digest("hex");
  const sha256 = crypto.createHash("sha256").update(RED_HEIC).digest("hex");
  const nativePath = `synthetic/brand/${md5}.HEIC`;
  let calls = 0;
  const first = await fetchRequiredImages(new Set([nativePath]), [nativePath], directory, async (url, options) => {
    assert.equal(url, "https://image-resource.mastergo.com/" + nativePath);
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    calls++;
    return { ok: true, arrayBuffer: async () => RED_HEIC };
  });
  assert.equal(calls, 1);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].format, first[0].width, first[0].height, first[0].frameCount, first[0].extension], ["HEIC", 16, 16, 1, "heic"]);
  assert.equal(first[0].md5, md5);
  assert.equal(first[0].sha256, sha256);
  assert.equal(first[0].isOriginalBytesConfirmed, true);
  assert.deepEqual(first[0].bytes, RED_HEIC);
  assert.deepEqual(fs.readFileSync(path.join(directory, sha256 + ".heic")), RED_HEIC);
  const retry = await fetchRequiredImages(new Set([nativePath]), [nativePath], directory, () => {
    throw new Error("A cache retry must not download another image");
  });
  assert.equal(retry[0].cacheHit, true);
  assert.equal(retry[0].sha256, sha256);
  assert.deepEqual(retry[0].bytes, RED_HEIC);
  const truncatedPath = "synthetic/brand/truncated.HEIC";
  await assert.rejects(fetchRequiredImages(new Set([truncatedPath]), [truncatedPath], directory,
    async () => ({ ok: true, arrayBuffer: async () => RED_HEIC.subarray(0, 64) })), /unresolved/);
});
