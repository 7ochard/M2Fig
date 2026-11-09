const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { fetchRequiredImages } = require("../convertCachedMasterGo.js");

test("MPO bytes from concurrent PNG/JPG source paths stay unchanged, use jpg and retry from cache", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-synthetic-mpo-"));
  const fixture = path.join(directory, "red-blue.mpo");
  const generated = spawnSync("python", ["-B", "-c", [
    "from PIL import Image",
    "import json,sys",
    "red=Image.new('RGB',(2,3),'red'); blue=Image.new('RGB',(2,3),'blue')",
    "red.save(sys.argv[1],format='MPO',save_all=True,append_images=[blue])",
    "im=Image.open(sys.argv[1])",
    "print(json.dumps(dict(format=im.format,width=im.width,height=im.height,frameCount=im.n_frames)))"
  ].join(";"), fixture], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(JSON.parse(generated.stdout), { format: "MPO", width: 2, height: 3, frameCount: 2 });
  const bytes = fs.readFileSync(fixture);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], "MPO retains a JPEG-compatible primary image signature");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const refs = new Set(["source.png", "source.jpg"]);
  const paths = Array.from(refs, ref => `synthetic/brand/${ref}`);
  let calls = 0, active = 0, peak = 0;
  const fetch = async (url, options) => {
    assert.ok(paths.some(source => url === `https://image-resource.mastergo.com/${source}`));
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const first = await fetchRequiredImages(refs, paths, directory, fetch);
  assert.equal(calls, 2);
  assert.equal(peak, 2, "the two native source paths must overlap in flight");
  assert.equal(first.length, 2);
  for (const image of first) {
    assert.equal(image.format, "MPO");
    assert.equal(image.frameCount, 2);
    assert.deepEqual([image.width, image.height, image.extension], [2, 3, "jpg"]);
    assert.deepEqual(image.bytes, bytes);
    assert.equal(image.sha256, sha256);
    assert.equal(crypto.createHash("sha256").update(image.bytes).digest("hex"), sha256);
    assert.equal(image.candidateSources[0].format, "MPO");
    assert.equal(image.candidateSources[0].frameCount, 2);
    assert.equal(image.isOriginalBytesConfirmed, false);
  }
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith(".jpg")), [sha256 + ".jpg"]);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".probe")), false, "concurrent identical bytes must not leave conflicting probe files");
  assert.deepEqual(fs.readFileSync(path.join(directory, sha256 + ".jpg")), bytes);
  const again = await fetchRequiredImages(refs, paths, directory, () => { throw new Error("cache retry must not fetch"); });
  assert.equal(again.every(image => image.cacheHit && image.format === "MPO" && image.frameCount === 2), true);
  assert.equal(again.every(image => image.sha256 === sha256 && image.bytes.equals(bytes)), true);
});
