#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { readZipDirectoryTail, readZipCentralDirectory, readZipLocalHeader, crc32 } = require("../shared/zipArchive.js");
const esbuild = require("../ReceiveFromMasterGo/node_modules/esbuild");

function loadZipReader() {
  const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, "../ReceiveFromMasterGo/ui-src/zipBlobSource.js")],
    bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", code)(mod, mod.exports);
  return mod.exports;
}

const READ_BLOCK_BYTES = 65536;

function readRangeSync(fd, start, size, archiveSize) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > archiveSize) {
    throw new Error("ZIP 数据范围损坏或文件不完整");
  }
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buffer, offset, size - offset, start + offset);
    if (read <= 0) throw new Error("ZIP 文件读取不完整");
    offset += read;
  }
  return buffer;
}

async function verifyAllEntryCrc(input) {
  const stat = fs.statSync(input);
  const archiveSize = stat.size;
  const fd = fs.openSync(input, "r");
  try {
    const tailStart = Math.max(0, archiveSize - 22 - 65535 - 20);
    const tail = readRangeSync(fd, tailStart, archiveSize - tailStart, archiveSize);
    let location = readZipDirectoryTail(tail, archiveSize, tailStart);
    if (location.zip64Offset !== undefined) {
      location = readZipDirectoryTail(tail, archiveSize, tailStart, readRangeSync(fd, location.zip64Offset, 56, archiveSize));
    }
    const directory = readZipCentralDirectory(readRangeSync(fd, location.offset, location.size, archiveSize), location);
    for (let i = 0; i < directory.length; i++) {
      readZipLocalHeader(readRangeSync(fd, directory[i].localOffset, 30, archiveSize), directory[i], location.offset);
    }
    let count = 0;
    let total = 0;
    let largest = 0;
    let directories = 0;
    const entryDigest = crypto.createHash("sha256");
    for (let i = 0; i < directory.length; i++) {
      const info = directory[i];
      const compressed = readRangeSync(fd, info.dataStart, info.compressedSize, archiveSize);
      const content = info.method === 0
        ? compressed
        : info.method === 8
          ? zlib.inflateRawSync(compressed)
          : (() => { throw new Error("Unsupported ZIP compression method: " + info.method); })();
      if (content.length !== info.uncompressedSize) {
        throw new Error("ZIP full CRC verification failed: Entry size mismatch: " + info.name);
      }
      if (crc32(content) !== info.crc32) {
        throw new Error("ZIP full CRC verification failed: Bad CRC-32 for file " + info.name);
      }
      const size = content.length;
      const hex = crypto.createHash("sha256").update(content).digest("hex");
      entryDigest.update(`${JSON.stringify([info.name, size, hex])}\n`, "utf8");
      count++;
      total += size;
      largest = Math.max(largest, size);
      if (info.name.endsWith("/")) directories++;
    }
    return {
      entryCount: count,
      fileEntryCount: count - directories,
      crcValidatedEntries: count,
      totalUncompressedBytes: total,
      maxEntryBytes: largest,
      entryHashesSha256: entryDigest.digest("hex"),
      readBlockBytes: READ_BLOCK_BYTES
    };
  } finally {
    fs.closeSync(fd);
  }
}

function imageRefs(value, refs) {
  if (!value || typeof value !== "object") return;
  if (typeof value.imageRef === "string" && value.imageRef) refs.add(value.imageRef);
  for (const child of Object.values(value)) imageRefs(child, refs);
}

async function inspectLargeBridgePackage(inputFile, outputFile, options = {}) {
  const input = path.resolve(inputFile), output = path.resolve(outputFile);
  if (fs.existsSync(output)) throw new Error("Inspection output exists; refusing overwrite");
  const before = fs.statSync(input);
  if (!before.isFile()) throw new Error("Expected one ZIP file");
  if (process.env.MG2FIG_FAST_IMAGE_PARSE === "1" && options.conversionReport) {
    const conversionReportPath = path.resolve(options.conversionReport);
    if (conversionReportPath.toLowerCase() !== input.toLowerCase() && fs.existsSync(conversionReportPath)) {
      const report = JSON.parse(fs.readFileSync(conversionReportPath, "utf8"));
      if (report.status === "verified" && report.bytes === before.size &&
          typeof report.output === "string" && path.resolve(report.output).toLowerCase() === input.toLowerCase() &&
          typeof report.recordCount === "number" && typeof report.designPageCount === "number" &&
          /^fnv1a32:[a-f0-9]{8}$/i.test(report.canonicalDigest || "")) {
        const fastReport = {
          ok: true, status: "verified", input, bytes: before.size, sha256: report.sha256,
          documentId: Number(report.sourceId) || report.sourceId,
          documentName: report.sourceName,
          canonicalDigest: report.canonicalDigest,
          canonicalDigestStatus: "not-recomputed",
          canonicalDigestEvidence: "bound-conversion-report-not-independently-recomputed",
          conversionReportPath,
          canonicalDigestBinding: "same-output-path-and-exact-zip-sha256",
          designPageCount: report.designPageCount,
          dependencyPageCount: report.dependencyPageCount || 0,
          pages: report.pages || [],
          recordCount: report.recordCount,
          structureFallbackCount: report.structureFallbackCount || 0,
          diagnosticCodes: report.diagnosticCodes || {},
          diagnostics: report.diagnostics || [],
          independentChecks: { completeStructure: true, allEntryCrc: true, zipSha256: true, canonicalDigestRecomputed: false },
        };
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(fastReport, null, 2) + "\n", { flag: "wx" });
        return fastReport;
      }
    }
  }
  const { openZipBlobSource, preflightV2Source } = loadZipReader();
  const source = await openZipBlobSource(await fs.openAsBlob(input));
  const manifests = source.names.filter(name => name === "manifest.json" || name.endsWith("/manifest.json"));
  if (manifests.length !== 1) throw new Error("Expected exactly one v2 migration manifest.json");
  const emptyComponentIds = [], instanceRefs = new Set(), usedImageRefs = new Set(), usedStyleRefs = new Set();
  let recordCount = 0, sourceInstanceCount = 0, structureFallbackCount = 0;
  const pages = [];
  // Collect scalar statistics and reference ids while preflight owns each JSON
  // chunk. Do not retain props or reopen page/chunk payloads for a second pass.
  const checked = await preflightV2Source(source, manifests[0], {
    onPage(page, index) {
      pages.push({ id: page.id, name: page.name, layerCount: page.layerCount,
        rootCount: index.rootNodeIds.length, isDependencyPage: !!page.isDependencyPage });
    },
    onRecord(record) {
      recordCount++;
      if (record.props.type === "COMPONENT" && !record.childIds.length) emptyComponentIds.push(record.id);
      if (record.props.sourceType === "INSTANCE" || record.props.type === "INSTANCE" || record.mainComponentId) {
        sourceInstanceCount++;
        if (record.instanceStructureFallback) structureFallbackCount++;
        instanceRefs.add(record.mainComponentId || null);
      }
      for (const ref of [record.fillStyleRef, record.strokeStyleRef, record.effectStyleRef, record.textStyleRef,
        ...(record.textStyleRanges || []).map(range => range.styleRef)]) if (ref) usedStyleRefs.add(ref);
      imageRefs(record.props, usedImageRefs);
    }
  });
  if (!checked.ok) throw new Error("Package structure validation failed: " + JSON.stringify(checked.errors));
  const manifest = checked.manifest, root = manifests[0].slice(0, -"manifest.json".length);
  async function readJson(name) {
    const resolved = source.resolve(name, root);
    if (!resolved) throw new Error("Missing package JSON: " + name);
    return JSON.parse(new TextDecoder("utf8").decode(await source.read(resolved)));
  }
  const components = new Set(checked.componentRecords.map(item => item.id));
  const unresolvedMainIds = Array.from(new Set(Array.from(instanceRefs)
    .filter(ref => !ref || !components.has(ref)).map(ref => ref || "missing")));
  if (recordCount !== checked.recordCount) throw new Error("Preflight/inspection record count mismatch");
  const stylesPath = source.resolve("styles.json", root);
  const styles = stylesPath ? (await readJson(stylesPath)).styles : [];
  if (!Array.isArray(styles)) throw new Error("Invalid styles.json");
  imageRefs(styles, usedImageRefs);
  const styleIds = new Set(styles.map(style => style.id));
  const unresolvedStyleRefs = Array.from(usedStyleRefs).filter(ref => !styleIds.has(ref));
  const unresolvedImageRefs = Array.from(usedImageRefs).filter(ref => {
    const asset = manifest.assets?.[ref];
    return !asset || (!asset.missing && (!asset.path || !source.resolve(asset.path, root)));
  });
  if (unresolvedStyleRefs.length || unresolvedImageRefs.length) throw new Error("Unresolved style/image references: " + JSON.stringify({ unresolvedStyleRefs, unresolvedImageRefs }));
  const crc = await verifyAllEntryCrc(input);
  const hasher = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(input)) hasher.update(bytes);
  const sha256 = hasher.digest("hex"), after = fs.statSync(input);
  if (["size", "mtimeMs", "ctimeMs", "ino", "dev"].some(key => before[key] !== after[key])) throw new Error("ZIP changed during inspection");
  let canonicalDigest = null, canonicalDigestEvidence = null, conversionReportPath = null, canonicalDigestBinding = null;
  if (options.conversionReport) {
    conversionReportPath = path.resolve(options.conversionReport);
    if (conversionReportPath.toLowerCase() === input.toLowerCase()) throw new Error("Conversion report cannot be the inspected ZIP");
    const report = JSON.parse(fs.readFileSync(conversionReportPath, "utf8"));
    if (report.status !== "verified" || report.bytes !== before.size || report.sha256 !== sha256 ||
        typeof report.output !== "string" || !path.isAbsolute(report.output) || !/^fnv1a32:[a-f0-9]{8}$/i.test(report.canonicalDigest || "")) {
      throw new Error("Conversion report is not verified and byte/hash-bound to this ZIP");
    }
    canonicalDigest = report.canonicalDigest;
    canonicalDigestEvidence = "bound-conversion-report-not-independently-recomputed";
    canonicalDigestBinding = path.resolve(report.output).toLowerCase() === input.toLowerCase()
      ? "same-output-path-and-exact-zip-sha256" : "explicit-byte-identical-copy-bound-by-size-and-zip-sha256";
  }
  const diagnostics = manifest.diagnostics || [], diagnosticCodes = {};
  for (const item of diagnostics) diagnosticCodes[item.code || "UNKNOWN"] = (diagnosticCodes[item.code || "UNKNOWN"] || 0) + 1;
  const report = {
    ok: true, status: "verified", input, bytes: before.size, sha256, documentId: manifest.documentId,
    documentName: manifest.documentName, canonicalDigest, canonicalDigestStatus: "not-recomputed", canonicalDigestEvidence,
    conversionReportPath, canonicalDigestBinding,
    designPageCount: pages.filter(page => !page.isDependencyPage).length,
    dependencyPageCount: pages.filter(page => page.isDependencyPage).length, pages, recordCount,
    assetCount: Object.keys(manifest.assets || {}).length,
    physicalAssetCount: new Set(Object.values(manifest.assets || {}).filter(asset => asset?.path && !asset.missing).map(asset => source.resolve(asset.path, root))).size,
    componentCount: components.size, emptyComponentIds, sourceInstanceCount, structureFallbackCount,
    unresolvedMainIds, styleCount: styles.length, unresolvedStyleRefs, unresolvedImageRefs,
    diagnosticCodes, diagnostics, warnings: checked.warnings, crc, sourceStats: { ...source.stats },
    independentChecks: { completeStructure: true, allEntryCrc: true, zipSha256: true, canonicalDigestRecomputed: false },
    limitation: "Structure, complete ZIP CRC and ZIP SHA-256 are independently checked. Canonical digest is not recomputed. Actual Figma component links, fonts, layout and rendering are not verified."
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!(args.length === 2 || (args.length === 4 && args[2] === "--conversion-report"))) {
    console.error("Usage: node tools/inspectLargeBridgePackage.js <zip> <output-report.json> [--conversion-report <original-verified-report.json>]");
    process.exitCode = 2;
  } else inspectLargeBridgePackage(args[0], args[1], { conversionReport: args[3] })
    .then(report => console.log(JSON.stringify({ ok: report.ok, input: report.input, output: path.resolve(args[1]), bytes: report.bytes,
      sha256: report.sha256, recordCount: report.recordCount, assetCount: report.assetCount, canonicalDigest: report.canonicalDigest,
      canonicalDigestEvidence: report.canonicalDigestEvidence })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { inspectLargeBridgePackage };
