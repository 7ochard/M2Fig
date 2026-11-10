const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { convertCachedMasterGo, readSource, imageSource, fetchRequiredImages } = require("../convertCachedMasterGo.js");
const { readZipEntries } = require("../read_zip_entries.js");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-cached-convert-"));
  const document = Buffer.from("\x010:1\0\x02Page\0\x03a0\0\x011:1\0\x020:1\0\x03a0\0\x04FRAME\0\x1c\x07\x03\0\0\0\x1d\x01\0");
  const documentPath = path.join(directory, "snapshot.document");
  fs.writeFileSync(documentPath, document);
  const documents = ["123", "456"].map(sourceId => ({ sourceId, sourceName: "Same name 1st class", status: "extracted", documentPath,
    documentSha256: sha(document), snapshotTime: "2026-11-05T01:02:03+08:00",
    identityEvidence: { fileKey: "12345678-1234-1234-1234-123456789abc", dataPath: "/data/12345678-1234-1234-1234-123456789abc", metadataPath: `/api/v1/documents/${sourceId}` },
    metadata: { id: sourceId, name: "Same name 1st class", fileKey: "12345678-1234-1234-1234-123456789abc" } }));
  const report = path.join(directory, "report.json");
  fs.writeFileSync(report, JSON.stringify({ documents }));
  return { directory, report, documents, documentPath };
}

test("same-named sources retain separate identities, native records and cache diagnostics with verified ZIP readback", async () => {
  const item = setup();
  for (const id of ["123", "456"]) {
    const output = path.join(item.directory, id + ".zip");
    const result = await convertCachedMasterGo(item.report, id, output, { fetch() { throw Error("zero-image source must not fetch"); } });
    const entries = readZipEntries(output), manifest = JSON.parse(entries["manifest.json"]);
    assert.equal(manifest.documentName, "Same name 1st class");
    assert.equal(manifest.documentId, Number(id));
    assert.equal(result.status, "verified");
    assert.ok(result.records > 0);
    assert.equal(result.sha256, sha(fs.readFileSync(output)));
    assert.equal(result.images.length, 0);
    assert.equal(manifest.diagnostics.filter(d => d.code === "CACHE_SNAPSHOT_FRESHNESS_UNVERIFIED")[0].sourceId, id);
    assert.match(manifest.diagnostics.find(d => d.code === "CACHE_SNAPSHOT_FRESHNESS_UNVERIFIED").message, /2026-11-05.*云端最新/);
    assert.equal(result.verifiedCloudLatest, false);
    assert.equal(fs.existsSync(result.reportPath), true);
  }
});

test("source SHA, duplicate identity and fileKey/dataPath mismatches fail before conversion", () => {
  const item = setup();
  fs.appendFileSync(item.documentPath, "corrupted");
  assert.throws(() => readSource(item.report, "123"), /SHA-256 mismatch/);
  item.documents[0].identityEvidence.dataPath = "/data/wrong";
  fs.writeFileSync(item.report, JSON.stringify({ documents: item.documents }));
  assert.throws(() => readSource(item.report, "123"), /identity evidence/);
  fs.writeFileSync(item.report, JSON.stringify({ documents: [item.documents[1], item.documents[1]] }));
  assert.throws(() => readSource(item.report, "456"), /one exact sourceId/);
});

test("existing output and raw source cannot be overwritten", async () => {
  const item = setup(), output = path.join(item.directory, "existing.zip");
  fs.writeFileSync(output, "keep");
  await assert.rejects(convertCachedMasterGo(item.report, "123", output), /refusing overwrite/);
  assert.equal(fs.readFileSync(output, "utf8"), "keep");
  const before = fs.readFileSync(item.documentPath);
  await assert.rejects(convertCachedMasterGo(item.report, "123", item.documentPath), /refusing overwrite/);
  assert.deepEqual(fs.readFileSync(item.documentPath), before);
});

test("metadata document id, opaque key and API path must all identify the selected source", () => {
  const item = setup();
  for (const change of [entry => { entry.metadata.id = "999"; },
    entry => { entry.metadata.fileKey = "87654321-1234-1234-1234-123456789abc"; },
    entry => { entry.identityEvidence.metadataPath = "/api/v1/documents/999"; },
    entry => { entry.sourceName = 17; }]) {
    const entry = structuredClone(item.documents[0]); change(entry);
    fs.writeFileSync(item.report, JSON.stringify({ documents: [entry] }));
    assert.throws(() => readSource(item.report, "123"), /identity|named extracted/);
  }
});

test("only exact native official original paths are allowed without team/project guessing", () => {
  assert.equal(imageSource("old-team/old-project/ref").url, "https://image-resource.mastergo.com/old-team/old-project/ref");
  for (const raw of ["https://evil.example/team/ref", "http://image-resource.mastergo.com/team/ref", "team/ref?x=1", "team/mini/ref", "team/ref-mini.png", "team/../ref", "team/%2e%2e/ref", "https://user:pass@image-resource.mastergo.com/ref"]) {
    assert.throws(() => imageSource(raw), /path|paths|Invalid/i, raw);
  }
});

function png(directory, name, color) {
  const filename = path.join(directory, name);
  const result = spawnSync("python", ["-c", "from PIL import Image; import sys; Image.new('RGB',(2,3),sys.argv[2]).save(sys.argv[1],'PNG')", filename, color], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(filename);
}

test("image fetch is bounded, anonymous, format-preserving and retries reuse validated cached bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-fetch-"));
  const bytes = png(directory, "sample.png", "red");
  let active = 0, peak = 0, calls = 0;
  const fetch = async (url, options) => {
    assert.ok(url.startsWith("https://image-resource.mastergo.com/actual/"));
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET");
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const refs = new Set(Array.from({ length: 7 }, (_, i) => "ref" + i));
  const native = Array.from(refs, ref => "actual/source/" + ref);
  native.push("https://unrelated.example/mini/unused");
  const first = await fetchRequiredImages(refs, native, directory, fetch);
  assert.equal(calls, 7); assert.ok(peak <= 4);
  assert.equal(first.length, 7);
  for (const image of first) {
    assert.deepEqual(image.bytes, bytes); assert.equal(image.format, "PNG");
    assert.deepEqual([image.width, image.height, image.extension], [2, 3, "png"]);
    assert.equal(image.isThumbnail, false); assert.equal(image.isOriginalBytesConfirmed, false);
  }
  const again = await fetchRequiredImages(refs, native, directory, () => { throw Error("must reuse cached bytes"); });
  assert.equal(again.every(image => image.cacheHit), true);
});

test("same ref conflicting native paths fail unless a real MD5 match proves the backing bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-conflict-"));
  const red = png(directory, "red.png", "red"), blue = png(directory, "blue.png", "blue");
  const fetch = async url => ({ ok: true, arrayBuffer: async () => url.includes("/red/") ? red : blue });
  await assert.rejects(fetchRequiredImages(new Set(["same"]), ["red/project/same", "blue/project/same"], directory, fetch), /unresolved/);
  const md5 = crypto.createHash("md5").update(red).digest("hex");
  const verified = await fetchRequiredImages(new Set([md5]), [`blue/project/${md5}`, `red/project/${md5}`], directory, fetch);
  assert.equal(verified[0].isOriginalBytesConfirmed, true);
  assert.deepEqual(verified[0].bytes, red);
  assert.equal(verified[0].nativePaths.length, 2);
  const extension = await fetchRequiredImages(new Set([md5 + ".png"]), [`blue/project/${md5}.png`, `red/project/${md5}.png`], directory, fetch);
  assert.equal(extension[0].isOriginalBytesConfirmed, true);
  await assert.rejects(fetchRequiredImages(new Set(["missing"]), [], directory, fetch), /unresolved/);
  await assert.rejects(fetchRequiredImages(new Set(["required"]), ["team/mini/required"], directory, fetch), /mini/);
});

test("native paint paths keep different same-named images bound to their own layers", async () => {
  const item = setup();
  const red = png(item.directory, "red.png", "red"), blue = png(item.directory, "blue.png", "blue");
  const paths = ["red/project/same.png", "blue/project/same.png"];
  const node = (id, ref, code) => Buffer.from(`\x01${id}\0\x020:1\0\x03${code}\0\x04FRAME\0\x15${ref}\0\x1c\x07\x03\0\0\0\x1d\x01\0`);
  const paint = (id, ref, nativePath) => Buffer.from(`\x01${id}\0\x02${ref}\0\x03a0\0\x05\x05\x0b\x03${nativePath}\0\0\0`);
  const document = Buffer.concat([Buffer.from("\x010:1\0\x02Images\0\x03a0\0"),
    node("1:1", "9:1", "a0"), node("1:2", "9:3", "a1"),
    paint("9:2", "9:1", paths[0]), paint("9:4", "9:3", paths[1])]);
  fs.writeFileSync(item.documentPath, document);
  item.documents[0].documentSha256 = sha(document);
  fs.writeFileSync(item.report, JSON.stringify({ documents: item.documents }));
  const output = path.join(item.directory, "separate-images.zip");
  const result = await convertCachedMasterGo(item.report, "123", output, {
    fetch: async url => ({ ok: true, arrayBuffer: async () => url.includes("/red/") ? red : blue })
  });
  const entries = readZipEntries(output), manifest = JSON.parse(entries["manifest.json"]);
  const records = Object.entries(entries).filter(([name]) => name.includes("/layers/"))
    .flatMap(([, bytes]) => JSON.parse(bytes).records);
  for (const [id, expected, nativePath] of [["1:1", red, paths[0]], ["1:2", blue, paths[1]]]) {
    const record = records.find(record => record.id === id);
    const ref = record.props.geometry.fills[0].imageRef;
    assert.deepEqual(entries[manifest.assets[ref].path], expected);
    assert.deepEqual(result.images.find(image => image.sha256 === sha(expected)).nativePaths,
      ["https://image-resource.mastergo.com/" + nativePath]);
  }
  assert.equal(manifest.stats.imageAssetCount, 2);
  assert.equal(result.status, "verified");
});

test("path-scoped identities still confirm original bytes using the native basename MD5", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-path-md5-"));
  const bytes = png(directory, "sample.png", "green");
  const md5 = crypto.createHash("md5").update(bytes).digest("hex");
  const nativePath = `original/project/${md5}.png`;
  const result = await fetchRequiredImages(new Set([nativePath]), [nativePath], directory,
    async () => ({ ok: true, arrayBuffer: async () => bytes }));
  assert.equal(result[0].isOriginalBytesConfirmed, true);
  assert.equal(result[0].imageRef, nativePath);
  assert.deepEqual(result[0].bytes, bytes);
});

test("temporary GET and response-body failures retry the same anonymous native URL at most three times", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-retry-success-"));
  const bytes = png(directory, "sample.png", "red"), nativePath = "actual/source/retry.png";
  const calls = [];
  const result = await fetchRequiredImages(new Set([nativePath]), [nativePath], directory, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new TypeError("private network detail", { cause: { code: "ECONNRESET" } });
    return { ok: true, arrayBuffer: async () => {
      if (calls.length === 2) throw new TypeError("private body detail", { cause: { code: "UND_ERR_SOCKET" } });
      return bytes;
    } };
  });
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.url)).size, 1);
  assert.equal(calls[0].url, "https://image-resource.mastergo.com/" + nativePath);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
  }
  assert.equal(new Set(calls.map(call => call.options.signal)).size, 3);
  assert.deepEqual(result[0].bytes, bytes);
});

test("only temporary HTTP statuses and explicit TimeoutError are retried", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-http-retry-"));
  const bytes = png(directory, "sample.png", "red");
  for (const status of [408, 429, 500, 502, 503, 504, "TimeoutError"]) {
    let calls = 0, canceled = 0;
    const nativePath = "actual/source/" + status + ".png";
    await fetchRequiredImages(new Set([nativePath]), [nativePath], directory, async () => {
      calls++;
      if (calls === 1) {
        if (status === "TimeoutError") throw new DOMException("private timeout detail", "TimeoutError");
        return { ok: false, status, body: { cancel: async () => { canceled++; } } };
      }
      return { ok: true, arrayBuffer: async () => bytes };
    });
    assert.equal(calls, 2, String(status));
    assert.equal(canceled, status === "TimeoutError" ? 0 : 1);
  }
});

test("exhausted transient retries persist stable cause, HTTP status and attempt count without raw errors", async () => {
  const item = setup(), nativePath = "actual/source/retry.png";
  const document = Buffer.concat([Buffer.from("\x010:1\0\x02Images\0\x03a0\0"),
    Buffer.from("\x011:1\0\x020:1\0\x03a0\0\x04FRAME\0\x159:1\0\x1c\x07\x03\0\0\0\x1d\x01\0"),
    Buffer.from(`\x019:2\0\x029:1\0\x03a0\0\x05\x05\x0b\x03${nativePath}\0\0\0`)]);
  fs.writeFileSync(item.documentPath, document);
  item.documents[0].documentSha256 = sha(document);
  fs.writeFileSync(item.report, JSON.stringify({ documents: item.documents }));
  const output = path.join(item.directory, "retry-failed.zip");
  let calls = 0;
  await assert.rejects(convertCachedMasterGo(item.report, "123", output, { fetch: async () => {
    calls++;
    throw new TypeError("SYNTHETIC_AUTH_HEADER_SECRET", { cause: { code: "ETIMEDOUT" } });
  } }), /Required images unresolved/);
  assert.equal(calls, 3);
  assert.equal(fs.existsSync(output), false);
  const reportPath = fs.readdirSync(item.directory).find(name => name.startsWith("retry-failed.zip.") && name.endsWith(".report.json"));
  const text = fs.readFileSync(path.join(item.directory, reportPath), "utf8"), report = JSON.parse(text);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.imageFailures[0].failures.map(({ causeCode, httpStatus, attempts }) => ({ causeCode, httpStatus, attempts })),
    [{ causeCode: "ETIMEDOUT", httpStatus: null, attempts: 3 }]);
  assert.equal(text.includes("SYNTHETIC_AUTH_HEADER_SECRET"), false);
  let httpCalls = 0;
  await assert.rejects(fetchRequiredImages(new Set([nativePath]), [nativePath], item.directory, async () => {
    httpCalls++;
    return { ok: false, status: 503 };
  }), error => {
    assert.deepEqual(error.imageFailures[0].failures.map(({ causeCode, httpStatus, attempts }) => ({ causeCode, httpStatus, attempts })),
      [{ causeCode: null, httpStatus: 503, attempts: 3 }]);
    return true;
  });
  assert.equal(httpCalls, 3);
});

test("permanent HTTP, redirects, TLS and unclassified network failures are not retried", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-no-retry-"));
  const failures = [403, 404, 302, "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ENOTFOUND", null];
  for (const failure of failures) {
    let calls = 0;
    const nativePath = "actual/source/no-retry-" + failure + ".png";
    await assert.rejects(fetchRequiredImages(new Set([nativePath]), [nativePath], directory, async () => {
      calls++;
      if (typeof failure === "number") return { ok: false, status: failure };
      throw new TypeError("SYNTHETIC_AUTH_HEADER_SECRET", { cause: { code: failure } });
    }), error => {
      const recorded = error.imageFailures[0].failures[0];
      assert.equal(recorded.attempts, 1, String(failure));
      assert.equal(recorded.httpStatus, typeof failure === "number" ? failure : null);
      assert.equal(recorded.causeCode, typeof failure === "string" ? failure : null);
      assert.equal(JSON.stringify(error.imageFailures).includes("SYNTHETIC_AUTH_HEADER_SECRET"), false);
      return true;
    });
    assert.equal(calls, 1, String(failure));
  }
});

test("format and cached-byte validation failures never trigger a network retry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mg-image-validation-no-retry-"));
  const invalidPath = "actual/source/invalid.png";
  let invalidCalls = 0;
  await assert.rejects(fetchRequiredImages(new Set([invalidPath]), [invalidPath], directory, async () => {
    invalidCalls++;
    return { ok: true, arrayBuffer: async () => Buffer.from("not an image") };
  }), /unresolved/);
  assert.equal(invalidCalls, 1);
  const bytes = png(directory, "valid.png", "blue"), nativePath = "actual/source/cached.png";
  const [image] = await fetchRequiredImages(new Set([nativePath]), [nativePath], directory,
    async () => ({ ok: true, arrayBuffer: async () => bytes }));
  fs.writeFileSync(path.join(directory, image.sha256 + ".png"), "corrupted");
  let cacheCalls = 0;
  await assert.rejects(fetchRequiredImages(new Set([nativePath]), [nativePath], directory, async () => {
    cacheCalls++;
    return { ok: true, arrayBuffer: async () => bytes };
  }), error => {
    assert.match(error.imageFailures[0].failures[0].message, /SHA\/MD5 mismatch/);
    return true;
  });
  assert.equal(cacheCalls, 0);
});
