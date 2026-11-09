#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { readZipEntries } = require("./read_zip_entries.js");
const { convertMgPackageToV2Entries } = require("../ReceiveFromMasterGo/src/ui/mgPackage.js");
const { validateV2Package } = require("../ReceiveFromMasterGo/src/ui/packageValidation.js");

// Entries travel as length-prefixed metadata followed by raw bytes. A zero
// metadata length commits the stream; an unexpected EOF leaves only .part.
const ZIP_WRITER = `
import json, sys, zipfile
stream = sys.stdin.buffer
def exact(size):
    result = stream.read(size)
    if len(result) != size: raise EOFError('Incomplete ZIP input')
    return result
with zipfile.ZipFile(sys.argv[1], 'x', allowZip64=True) as archive:
    while True:
        length = int.from_bytes(exact(4), 'big')
        if length == 0: break
        if length > 65536: raise ValueError('ZIP metadata is too large')
        item = json.loads(exact(length).decode('utf-8'))
        size = item['size']
        if not isinstance(size, int) or size < 0: raise ValueError('Invalid entry size')
        info = zipfile.ZipInfo(item['name'])
        info.file_size = size
        info.compress_type = zipfile.ZIP_DEFLATED if item['name'].endswith('.json') else zipfile.ZIP_STORED
        with archive.open(info, 'w', force_zip64=size >= zipfile.ZIP64_LIMIT) as entry:
            remaining = size
            while remaining:
                data = exact(min(65536, remaining))
                entry.write(data)
                remaining -= len(data)
`;

async function writeZip(entries, partialPath) {
  const child = spawn("python", ["-c", ZIP_WRITER, partialPath], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-8192); });
  const finished = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `ZIP writer exited with ${code}`)));
  });
  finished.catch(() => {});
  child.stdin.on("error", () => {});
  const write = bytes => new Promise((resolve, reject) => {
    child.stdin.write(bytes, error => error ? reject(error) : resolve());
  });
  try {
    for (const [name, bytes] of Object.entries(entries)) {
      const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const metadata = Buffer.from(JSON.stringify({ name, size: body.length }), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(metadata.length);
      await write(header);
      await write(metadata);
      // Awaiting each write callback applies backpressure with at most 64 KiB
      // in flight, including for a single multi-gigabyte image entry.
      for (let offset = 0; offset < body.length; offset += 65536) {
        await write(body.subarray(offset, offset + 65536));
      }
    }
    await write(Buffer.alloc(4));
    child.stdin.end();
    await finished;
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    await finished.catch(() => {});
    throw error;
  }
}

async function convertWholeFile(inputPath, outputPath, options = {}) {
  const started = performance.now();
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const identity = name => process.platform === "win32" ? name.toLowerCase() : name;
  if (identity(input) === identity(output)) throw new Error("输入与输出路径不能相同");
  if (fs.existsSync(output)) throw new Error(`输出已存在，拒绝覆盖：${output}`);
  const documentName = options.documentName === undefined
    ? path.basename(input, path.extname(input)) : options.documentName;
  if (typeof documentName !== "string" || !documentName.trim()) throw new Error("documentName 必须是非空文件名称");

  let sourceEntries = readZipEntries(input);
  const entries = convertMgPackageToV2Entries(sourceEntries, path.basename(input), { wholeFile: true, slimInstanceDescendants: true });
  sourceEntries = null;
  const namedManifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  namedManifest.documentName = documentName;
  entries["manifest.json"] = Buffer.from(JSON.stringify(namedManifest), "utf8");
  let validation = validateV2Package(entries);
  if (!validation.ok) throw new Error(`迁移包校验失败：${JSON.stringify(validation.errors)}`);
  const manifest = validation.manifest;
  const result = {
    output,
    documentName,
    designPages: manifest.pages.filter(page => !page.isDependencyPage).length,
    dependencyPages: manifest.pages.filter(page => page.isDependencyPage).length,
    records: validation.records.size,
    resources: manifest.stats.imageAssetCount,
    diagnostics: (manifest.diagnostics || []).length,
    canonicalDigest: validation.canonicalDigest
  };
  validation = null;

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const partialPath = `${output}.${process.pid}.${randomUUID()}.part`;
  try {
    await writeZip(entries, partialPath);
    // link is an atomic no-clobber publish, including if another process
    // creates the destination after the initial existence check.
    fs.linkSync(partialPath, output);
  } catch (error) {
    if (fs.existsSync(partialPath)) error.message += `\n未完成文件保留：${partialPath}`;
    throw error;
  }
  try { fs.unlinkSync(partialPath); }
  catch (_) { result.retainedPartPath = partialPath; }
  result.bytes = fs.statSync(output).size;
  result.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  result.nodePeakRssMiB = Number((Math.max(process.resourceUsage().maxRSS * 1024, process.memoryUsage().rss) / 1048576).toFixed(1));
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!(args.length === 2 || (args.length === 4 && args[2] === "--document-name" && args[3].trim()))) {
    console.error("Usage: node tools/convertWholeFile.js <input.mg> <output.zip> [--document-name 名称]");
    process.exitCode = 2;
  } else {
    convertWholeFile(args[0], args[1], args.length === 4 ? { documentName: args[3] } : {})
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { convertWholeFile, writeZip };
