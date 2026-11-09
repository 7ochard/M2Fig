#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { writeZip } = require("./convertWholeFile.js");
const { validateV2Package } = require("../ReceiveFromMasterGo/src/ui/packageValidation.js");

const digest = (bytes, algorithm = "sha256") => crypto.createHash(algorithm).update(bytes).digest("hex");
const json = value => Buffer.from(JSON.stringify(value));
const decode = bytes => JSON.parse(Buffer.from(bytes).toString("utf8"));
const CDN = "https://image-resource.mastergo.com";
const RETRYABLE_IMAGE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_IMAGE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const IMAGE_EXTENSIONS = { JPEG: "jpg", MPO: "jpg", PNG: "png", GIF: "gif", WEBP: "webp", AVIF: "avif", BMP: "bmp", TIFF: "tiff", ICO: "ico", HEIF: "heif", HEIC: "heic" };
// Bump this policy revision when upgrading Pillow or changing its validation
// policy. The fingerprint also binds the inspection code and HEIF dependency.
const IMAGE_VALIDATION_POLICY_VERSION = 1;
let imageValidatorFingerprint;
const imageInfoMemo = new Map();

function imageSource(raw) {
  if (typeof raw !== "string" || !raw || /[?#\\\s]/.test(raw) || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) throw new Error("Invalid native image path");
  const url = new URL(raw, CDN + "/");
  if (url.origin !== CDN || url.username || url.password || url.port || url.search || url.hash ||
      /(?:^|[\/._-])mini(?:[\/._-]|$)/i.test(url.pathname) || /thumbnail/i.test(url.pathname)) throw new Error("Only exact native original CDN paths are allowed; mini/external paths rejected");
  const imageRef = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (!imageRef || !/^[A-Za-z0-9._/-]+$/.test(url.pathname)) throw new Error("Invalid native image reference");
  return { url: url.href, imageRef };
}

function readSource(reportPath, sourceId) {
  const report = decode(fs.readFileSync(reportPath));
  if (!Array.isArray(report.documents)) throw new Error("cache report must contain documents[]");
  const matches = report.documents.filter(item => String(item.sourceId) === String(sourceId));
  if (matches.length !== 1) throw new Error("Expected one exact sourceId in cache report");
  const item = matches[0], evidence = item.identityEvidence;
  if (item.status !== "extracted" || typeof item.sourceName !== "string" || !item.sourceName.trim() || !/^\d+$/.test(String(sourceId)) || !Number.isSafeInteger(Number(sourceId))) throw new Error("Source is not a named extracted document");
  if (!evidence || !/^[a-f0-9-]{36}$/i.test(evidence.fileKey || "") ||
      ![`/data/${evidence.fileKey}`, `https://mastergo.com/data/${evidence.fileKey}`].includes(evidence.dataPath) ||
      evidence.metadataPath !== `/api/v1/documents/${sourceId}`) throw new Error("Missing exact fileKey/dataPath/metadataPath identity evidence");
  if (!item.metadata || String(item.metadata.id) !== String(sourceId) || item.metadata.fileKey !== evidence.fileKey ||
      (item.metadata.name !== undefined && item.metadata.name !== item.sourceName)) throw new Error("Metadata source identity mismatch");
  if (!item.snapshotTime || !Number.isFinite(Date.parse(item.snapshotTime))) throw new Error("Missing snapshot time");
  if (!/^[a-f0-9]{64}$/i.test(item.documentSha256 || "")) throw new Error("Missing document SHA-256");
  const documentPath = path.resolve(path.dirname(reportPath), item.documentPath);
  const bytes = fs.readFileSync(documentPath);
  if (digest(bytes) !== item.documentSha256.toLowerCase()) throw new Error("Document SHA-256 mismatch");
  if (item.metadata?.fileId !== undefined && String(item.metadata.fileId) !== String(sourceId)) throw new Error("Metadata source identity mismatch");
  return { item, bytes, documentPath };
}

function decodeDocument(bytes, sourceId, sourceName) {
  const filename = path.resolve(__dirname, "../ReceiveFromMasterGo/src/ui/mgPackage.js");
  let source = fs.readFileSync(filename, "utf8");
  for (const [target, observation] of [
    ["if (kind === 5 && image && image.path) {", " global.__imagePaths.push(image.path);"],
    ["imageAliasByRef[paint.imageRef] = alias;", " global.__imageAliases[paint.imageRef] = alias;"]
  ]) {
    if (source.split(target).length !== 2) throw new Error("Native observation hook no longer matches existing decoder");
    source = source.replace(target, target + observation);
  }
  // Cache exports have exact native paths but no embedded image files. Keep
  // those paths as identities until v2 aliases are assigned: two paths may
  // share a basename while serving different bytes. The shared decoder stays
  // unchanged for native .mg packages with basename-addressed embedded files.
  const imageRefTarget = "mgMakeImagePaint(mgBasename(image.path),";
  if (source.split(imageRefTarget).length !== 2) throw new Error("Native image identity hook no longer matches existing decoder");
  source = source.replace(imageRefTarget, "mgMakeImagePaint(image.path,");
  const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, DataView, console, __imagePaths: [], __imageAliases: {} });
  vm.runInContext(source, context, { filename });
  const entries = context.MasterGoMg.convertMgPackageToV2Entries({ document: bytes,
    "meta.json": json({ fileId: Number(sourceId) }) }, sourceName + ".mg", { wholeFile: true, slimInstanceDescendants: true });
  return { entries, imagePaths: Array.from(new Set(context.__imagePaths)), imageAliases: { ...context.__imageAliases } };
}

function collectImageRefs(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.imageRef === "string" && value.imageRef) output.add(value.imageRef);
  for (const item of Object.values(value)) collectImageRefs(item, output);
  return output;
}

// Async process probe: probing used to be spawnSync from inside the 4-way
// image fetch concurrency, which serialized every inspection on the event
// loop. Non-blocking spawn lets the existing workers overlap their probes.
function runProbe(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [], stderrChunks = [];
    let settled = false, timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", chunk => stdoutChunks.push(chunk));
    child.stderr.on("data", chunk => stderrChunks.push(chunk));
    child.on("error", error => finish(reject, error));
    child.on("close", code => finish(resolve, {
      status: code === null ? 1 : code,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8")
    }));
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        const error = new Error("Image probe timed out");
        error.code = "ETIMEDOUT";
        finish(reject, error);
      }, timeoutMs);
    }
  });
}

async function imageInfo(filename, bytes) {
  // HEIF/HEIC originals cannot be read by a Pillow install without its HEIF
  // plugin: skip the doomed Pillow spawn and decode directly with the
  // receiver's bundled helper, whose full-pixel verification semantics are
  // unchanged.
  if (require("./inspectHeifImage.js").isHeif(bytes)) {
    const heif = await runProbe(process.execPath, [path.join(__dirname, "inspectHeifImage.js"), filename], 60000);
    if (heif.status !== 0) throw new Error("HEIF pixel validation failed: " + heif.stderr.trim());
    return JSON.parse(heif.stdout);
  }
  const code = ["import sys,json", "from PIL import Image", "im=Image.open(sys.argv[1]); im.verify(); im=Image.open(sys.argv[1])",
    "info=dict(format=im.format,width=im.width,height=im.height,frameCount=getattr(im,'n_frames',1))",
    "if im.format=='MPO': im.load()", "print(json.dumps(info))"].join("\n");
  const result = await runProbe("python", ["-c", code, filename]);
  if (result.status !== 0) throw new Error("Image format validation failed: " + result.stderr.trim());
  const info = JSON.parse(result.stdout);
  if (!IMAGE_EXTENSIONS[info.format] || !(info.width > 0 && info.height > 0)) throw new Error("Unsupported actual image format/dimensions: " + JSON.stringify(info));
  return { ...info, extension: IMAGE_EXTENSIONS[info.format] };
}

function validatorFingerprint() {
  if (!imageValidatorFingerprint) {
    const heicRoot = path.join(__dirname, "../ReceiveFromMasterGo/node_modules/heic-to");
    imageValidatorFingerprint = digest(json({
      policyVersion: IMAGE_VALIDATION_POLICY_VERSION,
      inspection: imageInfo.toString(), extensions: IMAGE_EXTENSIONS,
      heifHelperSha256: digest(fs.readFileSync(path.join(__dirname, "inspectHeifImage.js"))),
      heicToVersion: decode(fs.readFileSync(path.join(heicRoot, "package.json"))).version,
      libheifSha256: digest(fs.readFileSync(path.join(heicRoot, "src/lib/libheif-without-unsafe-eval.js")))
    }));
  }
  return imageValidatorFingerprint;
}

function validImageInfo(info) {
  return info && typeof info === "object" && !Array.isArray(info) &&
    Object.prototype.hasOwnProperty.call(IMAGE_EXTENSIONS, info.format) && IMAGE_EXTENSIONS[info.format] === info.extension &&
    Number.isSafeInteger(info.width) && info.width > 0 && Number.isSafeInteger(info.height) && info.height > 0 &&
    Number.isSafeInteger(info.frameCount) && info.frameCount > 0;
}

async function validatedImageInfo(filename, bytes, cacheDirectory, contentSha256) {
  const fingerprint = validatorFingerprint();
  const memoKey = JSON.stringify([path.resolve(cacheDirectory), contentSha256, fingerprint]);
  // Memoize the promise instead of the resolved info: identical bytes fetched
  // concurrently now overlap their async probes instead of racing duplicate
  // inspections. A rejected probe is not memoized, so a later retry re-runs it.
  const existing = imageInfoMemo.get(memoKey);
  if (existing) return existing;
  const pending = (async () => {
    const metadataPath = path.join(cacheDirectory, contentSha256 + ".image-info.json");
    const payload = info => ({ schemaVersion: 1, contentSha256, validatorFingerprint: fingerprint,
      info: { format: info.format, width: info.width, height: info.height, frameCount: info.frameCount, extension: info.extension } });
    try {
      const cached = decode(fs.readFileSync(metadataPath));
      if (cached.schemaVersion === 1 && cached.contentSha256 === contentSha256 && cached.validatorFingerprint === fingerprint &&
          validImageInfo(cached.info) && cached.metadataSha256 === digest(json(payload(cached.info)))) {
        return cached.info;
      }
    } catch (_) { /* Old or malformed metadata is only a cache miss. */ }
    const info = await imageInfo(filename, bytes);
    if (!validImageInfo(info)) throw new Error("Invalid inspected image metadata: " + JSON.stringify(info));
    const metadata = payload(info);
    fs.writeFileSync(metadataPath, json({ ...metadata, metadataSha256: digest(json(metadata)) }));
    return metadata.info;
  })();
  imageInfoMemo.set(memoKey, pending);
  try {
    return await pending;
  } catch (error) {
    imageInfoMemo.delete(memoKey);
    throw error;
  }
}

function saveExclusive(filename, bytes) {
  try { fs.writeFileSync(filename, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || digest(fs.readFileSync(filename)) !== digest(bytes)) throw error;
  }
}

async function obtainImage(nativeSource, cacheDirectory, fetchImpl) {
  const source = imageSource(nativeSource), key = digest(source.url);
  const indexPath = path.join(cacheDirectory, key + ".json");
  if (fs.existsSync(indexPath)) {
    const cached = decode(fs.readFileSync(indexPath));
    if (cached.url !== source.url || path.basename(cached.fileName || "") !== cached.fileName) throw new Error("Image cache identity mismatch");
    const filename = path.join(cacheDirectory, cached.fileName), bytes = fs.readFileSync(filename);
    if (digest(bytes) !== cached.sha256 || digest(bytes, "md5") !== cached.md5) throw new Error("Image cache SHA/MD5 mismatch");
    return { ...source, ...(await validatedImageInfo(filename, bytes, cacheDirectory, cached.sha256)), bytes, sha256: cached.sha256, md5: cached.md5, cacheHit: true };
  }
  let bytes, attempts;
  for (attempts = 1; attempts <= 3; attempts++) {
    try {
      const response = await fetchImpl(source.url, { method: "GET", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch (_) { /* Release the response without reading its body. */ }
        const error = new Error("Image HTTP failure");
        error.httpStatus = response.status;
        throw error;
      }
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      const rawCode = error.cause?.code ?? error.code;
      const causeCode = error.name === "TimeoutError" ? "TIMEOUT" :
        typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : null;
      const httpStatus = Number.isInteger(error.httpStatus) ? error.httpStatus : null;
      if (attempts === 3 || !(error.name === "TimeoutError" || RETRYABLE_IMAGE_CODES.has(causeCode) || RETRYABLE_IMAGE_HTTP.has(httpStatus))) {
        const failure = new Error(httpStatus ? `Image HTTP ${httpStatus} after ${attempts} attempt(s)` : `Image GET failed (${causeCode || "NETWORK_ERROR"}) after ${attempts} attempt(s)`);
        Object.assign(failure, { causeCode, httpStatus, attempts });
        throw failure;
      }
      await new Promise(resolve => setTimeout(resolve, attempts * 250));
    }
  }
  const sha256 = digest(bytes), md5 = digest(bytes, "md5");
  const probe = path.join(cacheDirectory, sha256 + "." + crypto.randomUUID() + ".probe");
  saveExclusive(probe, bytes);
  let info;
  try { info = await validatedImageInfo(probe, bytes, cacheDirectory, sha256); }
  catch (error) { error.attempts = attempts; throw error; }
  const fileName = sha256 + "." + info.extension;
  saveExclusive(path.join(cacheDirectory, fileName), bytes);
  saveExclusive(indexPath, json({ url: source.url, sha256, md5, fileName }));
  fs.unlinkSync(probe);
  return { ...source, ...info, bytes, sha256, md5, cacheHit: false };
}

async function fetchRequiredImages(refs, imagePaths, cacheDirectory, fetchImpl) {
  const byRef = new Map();
  for (const raw of imagePaths) {
    if (typeof raw !== "string") continue;
    const clean = raw.split(/[?#]/, 1)[0].replaceAll("\\", "/");
    if (!refs.has(raw) && !refs.has(clean.slice(clean.lastIndexOf("/") + 1))) continue;
    const source = imageSource(raw);
    for (const ref of [raw, source.imageRef]) if (refs.has(ref)) {
      if (!byRef.has(ref)) byRef.set(ref, new Set());
      byRef.get(ref).add(source.url);
    }
  }
  const work = Array.from(refs), results = [], errors = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
    while (next < work.length && errors.length === 0) {
      const ref = work[next++], paths = Array.from(byRef.get(ref) || []), candidates = [], failures = [];
      for (const url of paths) {
        try { candidates.push(await obtainImage(url, cacheDirectory, fetchImpl)); }
        catch (error) { failures.push({ url, message: error.message, causeCode: error.causeCode ?? null, httpStatus: error.httpStatus ?? null, attempts: error.attempts ?? 0 }); }
      }
      const bareRef = path.posix.parse(path.posix.basename(ref)).name.toLowerCase();
      const matches = candidates.filter(item => /^[a-f0-9]{32}$/.test(bareRef) && item.md5.toLowerCase() === bareRef);
      if (!paths.length || !candidates.length || (!matches.length && paths.length > 1 &&
          (failures.length || new Set(candidates.map(item => item.sha256)).size > 1))) {
        errors.push({ imageRef: ref, reason: !paths.length ? "native-path-missing" : "unavailable-or-conflicting-native-paths", paths, failures });
        continue;
      }
      const selected = matches[0] || candidates[0];
      results.push({ ...selected, imageRef: ref, nativePaths: paths, failures,
        candidateSources: candidates.map(({ bytes, ...metadata }) => metadata),
        isOriginalBytesConfirmed: matches.length > 0, isThumbnail: false });
    }
  }));
  if (errors.length) { const error = new Error(`Required images unresolved: ${errors.length}`); error.imageFailures = errors; throw error; }
  return results;
}

function verifyReferences(entries, checked) {
  const manifest = checked.manifest, styles = entries["styles.json"] ? decode(entries["styles.json"]).styles : [];
  const styleIds = new Set(styles.map(style => style.id));
  for (const { record } of checked.records.values()) {
    if (record.mainComponentId && checked.records.get(record.mainComponentId)?.record.props?.type !== "COMPONENT") throw new Error("Unresolved mainComponentId: " + record.id);
    for (const ref of [record.fillStyleRef, record.strokeStyleRef, record.effectStyleRef, record.textStyleRef,
      ...(record.textStyleRanges || []).map(range => range.styleRef)]) if (ref && !styleIds.has(ref)) throw new Error("Unresolved style reference: " + ref);
  }
  for (const [name, bytes] of Object.entries(entries)) if (name.endsWith(".json")) {
    for (const ref of collectImageRefs(decode(bytes))) {
      const asset = manifest.assets[ref];
      if (!asset || asset.missing || !entries[asset.path]?.length) throw new Error("Unresolved image reference: " + ref);
    }
  }
}

function readbackZip(filename, expected) {
  const code = ["import sys,zipfile,hashlib,json", "out=[]", "with zipfile.ZipFile(sys.argv[1]) as z:",
    " for i in z.infolist():", "  h=hashlib.sha256(); size=0", "  with z.open(i) as f:",
    "   while True:", "    b=f.read(65536)", "    if not b: break", "    h.update(b); size+=len(b)",
    "  out.append(dict(name=i.filename,size=size,sha256=h.hexdigest()))", "print(json.dumps(out))"].join("\n");
  const result = spawnSync("python", ["-c", code, filename], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("ZIP CRC/readback failed: " + result.stderr.trim());
  const actual = JSON.parse(result.stdout);
  if (actual.length !== Object.keys(expected).length) throw new Error("ZIP readback entry count mismatch");
  for (const item of actual) if (!expected[item.name] || expected[item.name].length !== item.size || digest(expected[item.name]) !== item.sha256) throw new Error("ZIP readback SHA mismatch: " + item.name);
  return actual.length;
}

async function convertCachedMasterGo(reportFile, sourceId, outputFile, options = {}) {
  const reportFilePath = path.resolve(reportFile), output = path.resolve(outputFile);
  if (fs.existsSync(output) || output.toLowerCase() === reportFilePath.toLowerCase()) throw new Error("Output exists or conflicts with source; refusing overwrite");
  const { item, bytes, documentPath } = readSource(reportFilePath, sourceId);
  if (output.toLowerCase() === documentPath.toLowerCase()) throw new Error("Output conflicts with source document");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const runId = crypto.randomUUID(), reportPath = `${output}.${runId}.report.json`;
  const report = { schemaVersion: 1, sourceId: String(sourceId), sourceName: item.sourceName, snapshotTime: item.snapshotTime,
    documentSha256: item.documentSha256, identityEvidence: { fileKey: item.identityEvidence.fileKey, dataPath: item.identityEvidence.dataPath, metadataPath: item.identityEvidence.metadataPath }, documentPath, output,
    verifiedCloudLatest: false, status: "preparing", images: [] };
  const partialPath = `${output}.${runId}.part`;
  try {
    const decoded = decodeDocument(bytes, sourceId, item.sourceName), entries = decoded.entries;
    const required = new Set();
    for (const [name, data] of Object.entries(entries)) if (name.endsWith(".json") && name !== "manifest.json") collectImageRefs(decode(data), required);
    const reverseAliases = Object.fromEntries(Object.entries(decoded.imageAliases).map(([ref, alias]) => [alias, ref]));
    const nativeRefs = new Set(Array.from(required, ref => reverseAliases[ref] || ref));
    const cacheDirectory = path.join(path.dirname(reportFilePath), "source-images");
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const images = await fetchRequiredImages(nativeRefs, decoded.imagePaths, cacheDirectory, options.fetch || globalThis.fetch);
    const manifest = decode(entries["manifest.json"]);
    manifest.documentName = item.sourceName;
    manifest.assets = {};
    manifest.diagnostics = [...(manifest.diagnostics || []), { code: "CACHE_SNAPSHOT_FRESHNESS_UNVERIFIED", scope: "file", sourceId: String(sourceId), snapshotTime: item.snapshotTime,
      message: `源自客户端缓存快照（${item.snapshotTime}），未验证为云端最新版本。` }];
    for (const image of images) {
      const assetPath = `images/${image.sha256}.${image.extension}`;
      entries[assetPath] = image.bytes;
      for (const key of [image.imageRef, decoded.imageAliases[image.imageRef]].filter(Boolean)) manifest.assets[key] = { key, fileName: path.basename(assetPath), path: assetPath };
      const { bytes: imageBytes, ...metadata } = image;
      report.images.push(metadata);
      if (image.format === "MPO") manifest.diagnostics.push({ code: "IMAGE_MPO_PRIMARY_FRAME_ONLY", scope: "file", imageRef: image.imageRef,
        frameCount: image.frameCount, sourceKind: "official-native-source-path",
        message: `图片 ${image.imageRef} 实际为 MPO（${image.frameCount} 帧），完整原始字节按 JPEG 兼容资源保存，未重新编码；需核对 Figma 中的主图显示，附加图像及其语义未验收。` });
      if (!image.isOriginalBytesConfirmed) manifest.diagnostics.push({ code: "IMAGE_ORIGINAL_BYTES_UNVERIFIED", scope: "file", imageRef: image.imageRef, sourceKind: "official-native-source-path", nativePaths: image.nativePaths,
        message: `图片 ${image.imageRef} 使用原生记录中的官方源路径完整图，未重新编码，但未通过源引用 MD5 验证原始上传字节。` });
    }
    manifest.stats.imageAssetCount = new Set(images.map(image => image.sha256)).size;
    manifest.stats.missingImageAssetCount = 0;
    entries["manifest.json"] = json(manifest);
    const checked = validateV2Package(entries);
    if (!checked.ok) throw new Error("v2 validation failed: " + JSON.stringify(checked.errors));
    if (!manifest.pages.length || (!checked.records.size && bytes[0] !== 9)) throw new Error("Unsupported native snapshot: no verified records/pages from this document format");
    verifyReferences(entries, checked);
    report.pages = manifest.pages.map(page => ({ id: page.id, name: page.name, layerCount: page.layerCount, isDependencyPage: !!page.isDependencyPage }));
    report.records = checked.records.size;
    report.canonicalDigest = checked.canonicalDigest;
    report.diagnostics = manifest.diagnostics;
    await writeZip(entries, partialPath);
    report.verifiedEntryCount = readbackZip(partialPath, entries);
    const hasher = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(partialPath)) hasher.update(chunk);
    report.sha256 = hasher.digest("hex");
    report.bytes = fs.statSync(partialPath).size;
    fs.linkSync(partialPath, output);
    fs.unlinkSync(partialPath);
    report.status = "verified";
    report.reportPath = reportPath;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    if (error.imageFailures) report.imageFailures = error.imageFailures;
    if (fs.existsSync(partialPath)) report.retainedPartPath = partialPath;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    error.message += `\nFailure report: ${reportPath}`;
    throw error;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 3) { console.error("Usage: node tools/convertCachedMasterGo.js <cache-report.json> <sourceId> <output.zip>"); process.exitCode = 2; }
  else convertCachedMasterGo(...args).then(result => console.log(JSON.stringify({ status: result.status, output: result.output, reportPath: result.reportPath, records: result.records, images: result.images.length, bytes: result.bytes, sha256: result.sha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { convertCachedMasterGo, readSource, imageSource, decodeDocument, fetchRequiredImages };
