#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { randomUUID, createHash } = require("node:crypto");
const { crc32 } = require("../shared/zipArchive.js");
const { readZipEntries } = require("./read_zip_entries.js");
const { convertMgPackageToV2Entries } = require("../ReceiveFromMasterGo/src/ui/mgPackage.js");
const { validateV2Package } = require("../ReceiveFromMasterGo/src/ui/packageValidation.js");

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

function hasUsableEnvPath() {
  const envPath = process.env.PATH ?? process.env.Path ?? "";
  return typeof envPath === "string" && envPath.trim().length > 0;
}

// Native V3 Node.js ZIP/ZIP64 writer using C-backed zlib.deflateRawSync and
// lookup-table CRC32, eliminating external Python subprocess + pipe overhead.
async function writeZip(entries, partialPath) {
  if (!hasUsableEnvPath()) {
    throw new Error("ZIP writer environment PATH is missing");
  }
  await new Promise(resolve => setImmediate(resolve));
  const fd = fs.openSync(partialPath, "wx");
  const centralParts = [];
  const zipHasher = createHash("sha256");
  const entryCrcs = Object.create(null);
  let offset = 0;
  let centralLength = 0;
  const entryNames = Object.keys(entries);
  try {
    for (let i = 0; i < entryNames.length; i++) {
      const name = entryNames[i];
      if (!name || typeof name !== "string") throw new Error("Invalid ZIP entry name");
      const rawBytes = entries[name];
      const body = Buffer.isBuffer(rawBytes)
        ? rawBytes
        : Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
      const nameBytes = Buffer.from(name, "utf8");
      if (nameBytes.length > UINT16_MAX) throw new Error("ZIP metadata is too large");
      const uncompressedSize = body.length;
      const isJson = name.endsWith(".json");
      const method = isJson ? 8 : 0;
      const compressed = isJson
        ? zlib.deflateRawSync(body, { level: zlib.constants.Z_BEST_SPEED })
        : body;
      const compressedSize = compressed.length;
      const entryCrc = crc32(body);
      entryCrcs[name] = entryCrc;
      const flags = 0x800; // UTF-8 filename
      const localOffset = offset;
      const useZip64Local = uncompressedSize >= UINT32_MAX || compressedSize >= UINT32_MAX;
      const useZip64Central = useZip64Local || localOffset >= UINT32_MAX;
      const versionNeeded = useZip64Central ? 45 : 20;

      let localExtra = Buffer.alloc(0);
      if (useZip64Local) {
        localExtra = Buffer.alloc(20);
        localExtra.writeUInt16LE(0x0001, 0);
        localExtra.writeUInt16LE(16, 2);
        localExtra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
        localExtra.writeBigUInt64LE(BigInt(compressedSize), 12);
      }

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(versionNeeded, 4);
      localHeader.writeUInt16LE(flags, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(entryCrc, 14);
      localHeader.writeUInt32LE(useZip64Local ? UINT32_MAX : compressedSize, 18);
      localHeader.writeUInt32LE(useZip64Local ? UINT32_MAX : uncompressedSize, 22);
      localHeader.writeUInt16LE(nameBytes.length, 26);
      localHeader.writeUInt16LE(localExtra.length, 28);

      const writeBuffers = localExtra.length
        ? [localHeader, nameBytes, localExtra, compressed]
        : [localHeader, nameBytes, compressed];
      fs.writevSync(fd, writeBuffers);
      for (let b = 0; b < writeBuffers.length; b++) zipHasher.update(writeBuffers[b]);
      offset += 30 + nameBytes.length + localExtra.length + compressedSize;

      const zip64Fields = [];
      if (uncompressedSize >= UINT32_MAX) zip64Fields.push(BigInt(uncompressedSize));
      if (compressedSize >= UINT32_MAX) zip64Fields.push(BigInt(compressedSize));
      if (localOffset >= UINT32_MAX) zip64Fields.push(BigInt(localOffset));
      let centralExtra = Buffer.alloc(0);
      if (zip64Fields.length > 0) {
        centralExtra = Buffer.alloc(4 + zip64Fields.length * 8);
        centralExtra.writeUInt16LE(0x0001, 0);
        centralExtra.writeUInt16LE(zip64Fields.length * 8, 2);
        for (let f = 0; f < zip64Fields.length; f++) {
          centralExtra.writeBigUInt64LE(zip64Fields[f], 4 + f * 8);
        }
      }

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(versionNeeded, 4);
      centralHeader.writeUInt16LE(versionNeeded, 6);
      centralHeader.writeUInt16LE(flags, 8);
      centralHeader.writeUInt16LE(method, 10);
      centralHeader.writeUInt16LE(0, 12);
      centralHeader.writeUInt16LE(0, 14);
      centralHeader.writeUInt32LE(entryCrc, 16);
      centralHeader.writeUInt32LE(compressedSize >= UINT32_MAX ? UINT32_MAX : compressedSize, 20);
      centralHeader.writeUInt32LE(uncompressedSize >= UINT32_MAX ? UINT32_MAX : uncompressedSize, 24);
      centralHeader.writeUInt16LE(nameBytes.length, 28);
      centralHeader.writeUInt16LE(centralExtra.length, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(localOffset >= UINT32_MAX ? UINT32_MAX : localOffset, 42);

      centralParts.push(centralHeader, nameBytes);
      if (centralExtra.length) centralParts.push(centralExtra);
      centralLength += 46 + nameBytes.length + centralExtra.length;
    }

    const centralOffset = offset;
    const entryCount = entryNames.length;
    const useZip64End = entryCount >= UINT16_MAX || centralLength >= UINT32_MAX || centralOffset >= UINT32_MAX;
    if (useZip64End) {
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeUInt32LE(0, 16);
      end64.writeUInt32LE(0, 20);
      end64.writeBigUInt64LE(BigInt(entryCount), 24);
      end64.writeBigUInt64LE(BigInt(entryCount), 32);
      end64.writeBigUInt64LE(BigInt(centralLength), 40);
      end64.writeBigUInt64LE(BigInt(centralOffset), 48);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(centralOffset + centralLength), 8);
      locator.writeUInt32LE(1, 16);
      centralParts.push(end64, locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entryCount >= UINT16_MAX ? UINT16_MAX : entryCount, 8);
    eocd.writeUInt16LE(entryCount >= UINT16_MAX ? UINT16_MAX : entryCount, 10);
    eocd.writeUInt32LE(centralLength >= UINT32_MAX ? UINT32_MAX : centralLength, 12);
    eocd.writeUInt32LE(centralOffset >= UINT32_MAX ? UINT32_MAX : centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    centralParts.push(eocd);

    const centralBuf = Buffer.concat(centralParts);
    fs.writeFileSync(fd, centralBuf);
    zipHasher.update(centralBuf);
    return {
      count: entryCount,
      zipBytes: centralOffset + centralBuf.length,
      zipSha256: zipHasher.digest("hex"),
      entryCrcs
    };
  } finally {
    fs.closeSync(fd);
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
