const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const child = require("node:child_process");

const converterPath = path.resolve(__dirname, "../convertCachedMasterGo.js");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const md5 = bytes => crypto.createHash("md5").update(bytes).digest("hex");
// The same self-generated 16x16 red image used in heifImageInspection.test.js.
const HEIC = Buffer.from("AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABOm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABWgAAABYAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAL5pcHJwAAAAoGlwY28AAAB0aHZjQwEBYAAAAJAAAAAAAB7wAPz9+PgAAA8DoAABABhAAQwB//8BYAAAAwCQAAADAAADAB6VmAmhAAEAKEIBAQFgAAADAJAAAAMAAAMAHqCIRZZWaryvAWgIAAADAAgAAAMACECiAAEABkQBwXPQiQAAABRpc3BlAAAAAAAAABAAAAAQAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBggMAAAAebWRhdAAAABIoAa8TgPUko/9oe7/OHn+hf4A=", "base64");

function loadConverter() {
  const calls = { python: 0, heif: 0 };
  const original = child.spawn;
  child.spawn = (executable, args, options) => {
    if (executable === "python" && args[1]?.includes("im=Image.open")) calls.python++;
    if (args[0]?.endsWith("inspectHeifImage.js")) calls.heif++;
    return original(executable, args, options);
  };
  try {
    delete require.cache[converterPath];
    return { ...require(converterPath), calls };
  } finally {
    child.spawn = original;
  }
}

function setup(format = "PNG") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-validation-cache-"));
  const filename = path.join(directory, "synthetic." + format.toLowerCase());
  if (format === "HEIC") fs.writeFileSync(filename, HEIC);
  else {
    const script = "from PIL import Image; import sys; a=Image.new('RGB',(2,3),'red'); b=Image.new('RGB',(2,3),'blue'); a.save(sys.argv[1],format=sys.argv[2],**(dict(save_all=True,append_images=[b]) if sys.argv[2]=='MPO' else {}))";
    const created = child.spawnSync("python", ["-c", script, filename, format], { encoding: "utf8", windowsHide: true });
    assert.equal(created.status, 0, created.stderr);
  }
  const bytes = fs.readFileSync(filename);
  const nativePath = `synthetic/source/${md5(bytes)}.${format.toLowerCase()}`;
  return { directory, bytes, nativePath };
}

async function obtain(api, item, nativePath = item.nativePath) {
  return (await api.fetchRequiredImages(new Set([nativePath]), [nativePath], item.directory,
    async () => ({ ok: true, arrayBuffer: async () => item.bytes })))[0];
}

async function cached(api, item, nativePath = item.nativePath) {
  return (await api.fetchRequiredImages(new Set([nativePath]), [nativePath], item.directory,
    () => { throw Error("A validated disk cache must not download"); }))[0];
}

function metadataFile(item) {
  const names = fs.readdirSync(item.directory).filter(name => name.endsWith(".image-info.json"));
  assert.equal(names.length, 1, "validated image metadata must be content-addressed");
  return path.join(item.directory, names[0]);
}

test("validated bytes reuse their format inspection after a fresh converter process boundary", async () => {
  const item = setup(), first = loadConverter();
  const original = await obtain(first, item);
  assert.deepEqual(first.calls, { python: 1, heif: 0 });
  const second = loadConverter();
  const reused = await cached(second, item);
  assert.deepEqual(second.calls, { python: 0, heif: 0 });
  assert.equal(reused.cacheHit, true);
  assert.deepEqual(reused.bytes, original.bytes);
  assert.deepEqual([reused.format, reused.width, reused.height, reused.extension], ["PNG", 2, 3, "png"]);
});

test("different exact native URLs with identical bytes share one inspection and keep their identities", async () => {
  const item = setup(), api = loadConverter();
  const refs = new Set([item.nativePath, "another/source/" + path.posix.basename(item.nativePath)]);
  const result = await api.fetchRequiredImages(refs, [...refs], item.directory,
    async () => ({ ok: true, arrayBuffer: async () => item.bytes }));
  assert.equal(result.length, 2);
  assert.equal(new Set(result.map(image => image.sha256)).size, 1);
  assert.equal(new Set(result.map(image => image.nativePaths[0])).size, 2);
  assert.deepEqual(api.calls, { python: 1, heif: 0 });
});

test("legacy caches without inspection metadata are checked once and upgraded compatibly", async () => {
  const item = setup(), url = "https://image-resource.mastergo.com/" + item.nativePath;
  const fileName = sha(item.bytes) + ".png";
  fs.writeFileSync(path.join(item.directory, fileName), item.bytes);
  fs.writeFileSync(path.join(item.directory, sha(Buffer.from(url)) + ".json"),
    JSON.stringify({ url, sha256: sha(item.bytes), md5: md5(item.bytes), fileName }));
  const first = loadConverter();
  assert.equal((await cached(first, item)).cacheHit, true);
  assert.deepEqual(first.calls, { python: 1, heif: 0 });
  assert.ok(fs.existsSync(metadataFile(item)));
  const second = loadConverter();
  await cached(second, item);
  assert.deepEqual(second.calls, { python: 0, heif: 0 });
});

test("malformed, stale, incomplete and altered metadata cause a real inspection rather than acceptance", async () => {
  const item = setup();
  await obtain(loadConverter(), item);
  const filename = metadataFile(item), valid = JSON.parse(fs.readFileSync(filename));
  const invalid = [
    "{bad-json",
    JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, contentSha256: "0".repeat(64) }),
    JSON.stringify({ ...valid, validatorFingerprint: "stale-validator" }),
    JSON.stringify({ ...valid, info: { ...valid.info, width: valid.info.width + 1 } }),
    JSON.stringify({ ...valid, info: { format: "PNG" } }),
    JSON.stringify({ ...valid, info: { ...valid.info, frameCount: 0 } })
  ];
  for (const body of invalid) {
    fs.writeFileSync(filename, body);
    const api = loadConverter();
    const result = await cached(api, item);
    assert.deepEqual(api.calls, { python: 1, heif: 0 });
    assert.deepEqual([result.width, result.height], [2, 3]);
    assert.deepEqual(result.bytes, item.bytes);
  }
  const afterRepair = loadConverter();
  await cached(afterRepair, item);
  assert.deepEqual(afterRepair.calls, { python: 0, heif: 0 });
});

test("image byte corruption is still rejected before metadata can skip inspection", async () => {
  const item = setup(), api = loadConverter();
  const first = await obtain(api, item);
  fs.writeFileSync(path.join(item.directory, first.sha256 + ".png"), Buffer.from("corrupt"));
  const next = loadConverter();
  await assert.rejects(cached(next, item), error => {
    assert.match(error.imageFailures[0].failures[0].message, /SHA\/MD5 mismatch/);
    return true;
  });
  assert.deepEqual(next.calls, { python: 0, heif: 0 });
});

test("HEIC and MPO cache reuse keeps original bytes and validated frame metadata", async () => {
  for (const format of ["HEIC", "MPO"]) {
    const item = setup(format), first = loadConverter();
    const image = await obtain(first, item);
    assert.equal(image.format, format);
    assert.equal(image.frameCount, format === "MPO" ? 2 : 1);
    // HEIF originals skip the doomed Pillow probe entirely and decode directly.
    assert.deepEqual(first.calls, { python: format === "MPO" ? 1 : 0, heif: format === "HEIC" ? 1 : 0 });
    const second = loadConverter();
    const reused = await cached(second, item);
    assert.deepEqual(second.calls, { python: 0, heif: 0 });
    assert.deepEqual(reused.bytes, item.bytes);
    assert.equal(reused.sha256, sha(item.bytes));
    assert.equal(reused.md5, md5(item.bytes));
    assert.equal(reused.frameCount, image.frameCount);
    assert.equal(reused.extension, image.extension);
  }
});
