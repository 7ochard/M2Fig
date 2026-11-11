const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const tool = path.resolve(__dirname, "../readMasterGoCache.py");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";

function fixture(entries) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mastergo-cache-reader-"));
  const cache = path.join(folder, "cache");
  fs.mkdirSync(cache);
  const table = Buffer.alloc(8192 + entries.length * 256), blocks = Buffer.alloc(8192 + 2 * 1024);
  let nextExternal = 1;
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index], offset = 8192 + index * 256;
    const key = Buffer.from(`prefix https://mastergo.com${item.route}`);
    const raw = Buffer.isBuffer(item.body) ? item.body : Buffer.from(JSON.stringify(item.body));
    const body = item.gzip ? zlib.gzipSync(raw) : raw;
    table.writeInt32LE(0, offset + 20);
    table.writeBigInt64LE(13400000000000000n, offset + 24);
    table.writeInt32LE(key.length, offset + 32);
    table.writeInt32LE(17, offset + 40); // stream 0: a forbidden block below
    table.writeInt32LE(item.declaredSize ?? body.length, offset + 44);
    table.writeUInt32LE(0xb0020001, offset + 56);
    if (item.internal) {
      assert.ok(body.length <= 1024);
      body.copy(blocks, 8192);
      table.writeUInt32LE(0xb0020000, offset + 60);
    } else {
      const number = item.external || nextExternal++;
      fs.writeFileSync(path.join(cache, `f_${number.toString(16).padStart(6, "0")}`), body);
      table.writeUInt32LE((0x80000000 | number) >>> 0, offset + 60);
    }
    assert.ok(key.length <= 160);
    key.copy(table, offset + 96);
  }
  Buffer.from("SYNTHETIC_COOKIE_SECRET").copy(blocks, 8192 + 1024);
  fs.writeFileSync(path.join(cache, "data_1"), table);
  fs.writeFileSync(path.join(cache, "data_2"), blocks);
  return { folder, cache };
}
function request(folder, ids) {
  const file = path.join(folder, "request.json");
  fs.writeFileSync(file, JSON.stringify({ teamName: "合成品牌", mastergo: ids.map(id => ({ id, url: `https://mastergo.com/file/${id}`, name: null })) }));
  return file;
}
function run(input, output, cache, guard = false) {
  const script = `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('reader',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
original=m.shared_read
def checked(path,offset=0,size=None):
    if path.name=='f_000099' or (path.name=='data_2' and offset==9216): raise RuntimeError('forbidden stream/body was read')
    return original(path,offset,size)
m.shared_read=checked
r=m.extract(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[4]))
print(json.dumps({'documents':[{'sourceId':x['sourceId'],'status':x['status']} for x in r['documents']]}))`;
  return spawnSync("python", guard ? ["-B", "-c", script, tool, input, output, cache] : ["-B", tool, input, output, "--cache-dir", cache], { encoding: "utf8", windowsHide: true });
}
const metadata = (id, key, name = "源文件") => ({ code: 200, data: { id, name, teamId: "100", projectId: "200", fileKey: key,
  token: "SYNTHETIC_TOKEN_SECRET", owner: { email: "SYNTHETIC_EMAIL_SECRET" } } });

test("reads requested stream-1 metadata and exact fileKey data body, excluding stream-0 and unrelated sources", () => {
  const native = Buffer.from("\x09native requested snapshot");
  const f = fixture([
    { route: "/api/v1/documents/123?access_token=SYNTHETIC_QUERY_SECRET", body: metadata("123", `https://mastergo.com/data/${A}?token=SYNTHETIC_KEY_SECRET`), internal: true },
    { route: `/data/${A}`, body: native, gzip: true },
    { route: "/api/v1/documents/789", body: metadata("789", B, "UNREQUESTED_NAME_SECRET"), external: 0x99 },
    { route: `/data/${B}`, body: Buffer.from("\x09UNREQUESTED_DESIGN_SECRET"), external: 0x99 }
  ]);
  const input = request(f.folder, ["123", "456"]), output = path.join(f.folder, "out");
  const result = run(input, output, f.cache, true);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(path.join(output, "report.json"), "utf8"), report = JSON.parse(text);
  assert.deepEqual(report.documents.map(item => [item.sourceId, item.status]), [["123", "extracted"], ["456", "missing-metadata"]]);
  const item = report.documents[0];
  assert.equal(item.sourceName, "源文件");
  assert.equal(item.identityEvidence.fileKey, A);
  assert.equal(item.identityEvidence.dataPath, `/data/${A}`);
  assert.deepEqual(fs.readFileSync(item.documentPath), native);
  assert.deepEqual(fs.readFileSync(item.cachedBodyPath), zlib.gzipSync(native));
  for (const secret of ["SYNTHETIC_TOKEN_SECRET", "SYNTHETIC_QUERY_SECRET", "SYNTHETIC_KEY_SECRET", "SYNTHETIC_COOKIE_SECRET", "SYNTHETIC_EMAIL_SECRET", "UNREQUESTED_NAME_SECRET", "UNREQUESTED_DESIGN_SECRET"]) {
    assert.equal((text + result.stdout + result.stderr).includes(secret), false, secret);
  }
  assert.equal(report.documents.length, 2);
  assert.equal(report.cloudFreshnessVerified, false);
});

test("missing and conflicting cache mappings never guess from binary ID hits or timestamps", () => {
  const f = fixture([
    { route: "/api/v1/documents/111", body: metadata("111", A) },
    { route: "/api/v1/documents/111", body: metadata("111", B) },
    { route: "/api/v1/documents/222", body: metadata("222", A) },
    { route: `/data/${A}`, body: Buffer.from("\x09version one includes 333") },
    { route: `/data/${A}`, body: Buffer.from("\x09version two includes 333") },
    { route: "/api/v1/documents/444", body: metadata("444", B) }
  ]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["111", "222", "333", "444"]), output, f.cache);
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(fs.readFileSync(path.join(output, "report.json")));
  assert.deepEqual(r.documents.map(item => item.status), ["metadata-conflict", "document-conflict", "missing-metadata", "missing-document"]);
  assert.equal(r.documents.every(item => item.documentPath === null), true);
  assert.deepEqual(fs.readdirSync(output), ["report.json"]);
});

test("existing output is refused and remains byte-for-byte unchanged", () => {
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) }, { route: `/data/${A}`, body: Buffer.from("\x09native") }]);
  const input = request(f.folder, ["123"]), output = path.join(f.folder, "out");
  assert.equal(run(input, output, f.cache).status, 0);
  const report = fs.readFileSync(path.join(output, "report.json"));
  const again = run(input, output, f.cache);
  assert.equal(again.status, 2);
  assert.deepEqual(fs.readFileSync(path.join(output, "report.json")), report);
});

test("truncated gzip is reported as incomplete document instead of missing document", () => {
  const compressed = zlib.gzipSync(Buffer.from("\x09requested native snapshot"));
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) },
    { route: `/data/${A}`, body: compressed.subarray(0, compressed.length - 8) }]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["123"]), output, f.cache, true);
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "incomplete-document");
  assert.equal(item.sourceName, "源文件");
  assert.equal(item.documentPath, null);
  assert.equal(item.cacheDiagnostics[0].code, "GZIP_INCOMPLETE");
  assert.deepEqual(fs.readdirSync(output), ["report.json"]);
});

test("gzip checksum failure is invalid document and never emits decoded partial data", () => {
  const compressed = zlib.gzipSync(Buffer.from("\x09requested native snapshot"));
  compressed[compressed.length - 8] ^= 0xff;
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) }, { route: `/data/${A}`, body: compressed }]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["123"]), output, f.cache);
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "invalid-document");
  assert.equal(item.cacheDiagnostics[0].code, "DOCUMENT_DECODE_FAILED");
  assert.equal(item.documentPath, null);
});

test("stale external stream length recovers only a stable complete gzip body with exact prefix", () => {
  const native = Buffer.from("\x09complete requested native snapshot");
  const compressed = zlib.gzipSync(native);
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) },
    { route: `/data/${A}`, body: compressed, declaredSize: compressed.length - 10 }]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["123"]), output, f.cache, true);
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "extracted");
  assert.deepEqual(fs.readFileSync(item.documentPath), native);
  assert.deepEqual(fs.readFileSync(item.cachedBodyPath), compressed);
  assert.equal(item.cachedBodyBytes, compressed.length);
  assert.equal(item.cacheDiagnostics[0].code, "EXTERNAL_GZIP_LENGTH_RECOVERED");
  assert.equal(item.cacheDiagnostics[0].declaredBodyBytes, compressed.length - 10);
});

test("a larger external file whose gzip stream is still incomplete is rejected", () => {
  const compressed = zlib.gzipSync(Buffer.from("\x09requested native snapshot"));
  const incomplete = compressed.subarray(0, compressed.length - 8);
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) },
    { route: `/data/${A}`, body: incomplete, declaredSize: 15 }]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["123"]), output, f.cache);
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "incomplete-document");
  assert.equal(item.documentPath, null);
  assert.deepEqual(fs.readdirSync(output), ["report.json"]);
});

test("an incomplete duplicate cannot silently fall back to a different valid snapshot", () => {
  const compressed = zlib.gzipSync(Buffer.from("\x09different in-flight snapshot"));
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) },
    { route: `/data/${A}`, body: Buffer.from("\x09older snapshot") },
    { route: `/data/${A}`, body: compressed.subarray(0, compressed.length - 8) }]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["123"]), output, f.cache);
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "incomplete-document");
  assert.equal(item.documentPath, null);
});

test("external length recovery refuses a file changed while its full body is being read", () => {
  const compressed = zlib.gzipSync(Buffer.from("\x09complete requested native snapshot"));
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) },
    { route: `/data/${A}`, body: compressed, declaredSize: compressed.length - 8 }]);
  const input = request(f.folder, ["123"]), output = path.join(f.folder, "out");
  const script = `import importlib.util,sys,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('reader',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
original=m.shared_read
def changed(path,offset=0,size=None):
    body=original(path,offset,size)
    if path.name=='f_000002' and size==${compressed.length}:
        path.write_bytes(body+b'changed-during-read')
    return body
m.shared_read=changed
m.extract(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[4]))`;
  const result = spawnSync("python", ["-B", "-c", script, tool, input, output, f.cache], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "incomplete-document");
  assert.equal(item.documentPath, null);
});

test("a declared body not yet fully written cannot silently select an older valid candidate", () => {
  const f = fixture([{ route: "/api/v1/documents/123", body: metadata("123", A) },
    { route: `/data/${A}`, body: Buffer.from("\x09older snapshot") },
    { route: `/data/${A}`, body: Buffer.from("\x1f\x8bpartial"), declaredSize: 500 }]);
  const output = path.join(f.folder, "out"), result = run(request(f.folder, ["123"]), output, f.cache);
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(fs.readFileSync(path.join(output, "report.json"))).documents[0];
  assert.equal(item.status, "incomplete-document");
  assert.equal(item.cacheDiagnostics[0].code, "DOCUMENT_BODY_UNREADABLE");
  assert.equal(item.documentPath, null);
});
