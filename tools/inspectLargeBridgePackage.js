#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const esbuild = require("../ReceiveFromMasterGo/node_modules/esbuild");

function loadZipReader() {
  const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, "../ReceiveFromMasterGo/ui-src/zipBlobSource.js")],
    bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", code)(mod, mod.exports);
  return mod.exports;
}

const ZIP_CRC_READER = [
  "import sys,zipfile,hashlib,json",
  "count=0; total=0; largest=0; directories=0; entry_digest=hashlib.sha256()",
  "with zipfile.ZipFile(sys.argv[1],allowZip64=True) as archive:",
  " for info in archive.infolist():",
  "  size=0; h=hashlib.sha256()",
  "  with archive.open(info) as stream:",
  "   while True:",
  "    data=stream.read(65536)",
  "    if not data: break",
  "    h.update(data); size+=len(data)",
  "  if size!=info.file_size: raise ValueError('Entry size mismatch: '+info.filename)",
  "  entry_digest.update((json.dumps([info.filename,size,h.hexdigest()],ensure_ascii=True,separators=(',',':'))+'\\n').encode('utf8'))",
  "  count+=1; total+=size; largest=max(largest,size); directories+=int(info.is_dir())",
  "print(json.dumps(dict(entryCount=count,fileEntryCount=count-directories,crcValidatedEntries=count,totalUncompressedBytes=total,maxEntryBytes=largest,entryHashesSha256=entry_digest.hexdigest(),readBlockBytes=65536)))"
].join("\n");

function verifyAllEntryCrc(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", ZIP_CRC_READER, input], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failed = false;
    child.stdout.on("data", bytes => {
      stdout += bytes.toString("utf8");
      if (stdout.length > 65536) { failed = true; child.kill(); }
    });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-8192); });
    child.on("error", reject);
    child.on("close", code => {
      if (failed || code !== 0) { reject(new Error("ZIP full CRC verification failed: " + (stderr.trim() || code))); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
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
