import { readZipDirectoryTail, readZipCentralDirectory, readZipLocalHeader } from "../../shared/zipArchive.js";

const decoder = new TextDecoder("utf-8");
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[index] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) value = (value >>> 8) ^ crcTable[(value ^ bytes[index]) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

// Retains a Blob and ZIP metadata only. No entry payload is cached: callers
// own each returned buffer and can release it after validation or transfer.
export async function openZipBlobSource(blob) {
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 22 || typeof blob.slice !== "function") throw new Error("不是有效的 ZIP 文件");
  const stats = { rangeReadCount: 0, rangeReadBytes: 0, entryReadCount: 0, entryReadBytes: 0, maxEntryBytes: 0, crcValidatedEntries: 0 };
  async function range(start, size) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > blob.size) throw new Error("ZIP 数据范围损坏或文件不完整");
    const bytes = new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
    if (bytes.length !== size) throw new Error("ZIP 文件读取不完整");
    stats.rangeReadCount++;
    stats.rangeReadBytes += bytes.length;
    return bytes;
  }
  const tailStart = Math.max(0, blob.size - 22 - 65535 - 20);
  const tail = await range(tailStart, blob.size - tailStart);
  let location = readZipDirectoryTail(tail, blob.size, tailStart);
  if (location.zip64Offset !== undefined) location = readZipDirectoryTail(tail, blob.size, tailStart, await range(location.zip64Offset, 56));
  const directory = readZipCentralDirectory(await range(location.offset, location.size), location);
  // All local-header offsets/methods are checked before an importer may write.
  // Bounded batches avoid thousands of serial File I/O round trips without
  // reading the image payloads between those headers.
  for (let index = 0; index < directory.length; index += 16) {
    await Promise.all(directory.slice(index, index + 16).map(async entry => {
      readZipLocalHeader(await range(entry.localOffset, 30), entry, location.offset);
    }));
  }
  const entries = new Map(directory.filter(entry => !entry.name.endsWith("/")).map(entry => [entry.name, entry]));
  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    size: name => entries.get(name)?.uncompressedSize,
    stats,
    resolve(name, root = "") {
      if (root && entries.has(root + name)) return root + name;
      if (entries.has(name)) return name;
      return this.names.find(path => path.endsWith("/" + name)) || "";
    },
    async read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const compressed = await range(entry.dataStart, entry.compressedSize);
      let content;
      if (entry.method === 0) content = compressed;
      else if (entry.method === 8 && typeof DecompressionStream === "function") {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        content = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error("暂不支持此 zip 压缩方式，请使用 SendToFigma 导出的 zip");
      if (content.length !== entry.uncompressedSize) throw new Error("ZIP 解压后的文件尺寸不一致");
      if (crc32(content) !== entry.crc32) throw new Error(`ZIP 文件 CRC 校验失败：${entry.name}`);
      stats.entryReadCount++;
      stats.entryReadBytes += content.length;
      stats.maxEntryBytes = Math.max(stats.maxEntryBytes, content.length);
      stats.crcValidatedEntries++;
      return content;
    }
  };
}

export function memoryPackageSource(entries) {
  return {
    names: Object.keys(entries), has: name => !!entries[name], size: name => entries[name]?.length,
    resolve(name, root = "") {
      if (root && entries[root + name]) return root + name;
      if (entries[name]) return name;
      return this.names.find(path => path.endsWith("/" + name)) || "";
    },
    async read(name) { return entries[name] || null; }
  };
}

export function collectRecordFonts(record, fonts) {
  const props = record?.props;
  if (!props) return;
  const add = font => {
    if (typeof font?.family === "string" && font.family && typeof font.style === "string" && font.style) {
      fonts.set(`${font.family}\n${font.style}`, { family: font.family, style: font.style });
    }
  };
  if (props.type === "TEXT") {
    add({ family: "Inter", style: "Regular" });
    add({ family: props.fontName?.family || "Inter", style: props.fontName?.style || "Regular" });
  } else add(props.fontName);
  for (const segment of Array.isArray(props.styledTextSegments) ? props.styledTextSegments : []) add(segment?.fontName);
}

// Complete structural preflight, with only the graph fields retained across
// chunks. Props and chunk bytes are discarded before the next chunk. Image
// presence is checked here; its payload/CRC is checked on first use, and a
// later read failure must abort/roll back the whole host import session.
export async function preflightV2Source(source, manifestPath, visitors = {}) {
  const errors = [], warnings = [];
  const issue = (code, path, message) => errors.push({ code, path, message });
  const root = manifestPath.slice(0, -"manifest.json".length);
  async function readJson(name, missingCode, jsonCode) {
    const resolved = source.resolve(name, root);
    if (!resolved) { issue(missingCode, name, "package entry is missing"); return null; }
    const bytes = await source.read(resolved);
    try {
      const value = JSON.parse(decoder.decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
      return value;
    }
    catch (_) { issue(jsonCode, name, "package entry is invalid JSON"); return null; }
  }
  const manifest = await readJson(manifestPath, "MANIFEST_MISSING", "MANIFEST_JSON");
  if (!manifest) return { ok: false, errors, warnings };
  if (manifest.schema !== "mastergo2figma.package.v2" || manifest.version !== 2) issue("MANIFEST_SCHEMA", manifestPath, "expected mastergo2figma.package.v2 version 2");
  if (!Array.isArray(manifest.pages)) issue("PAGES_INVALID", manifestPath, "manifest.pages must be an array");
  if (errors.length) return { ok: false, manifest, errors, warnings };
  const wanted = new Set();
  for (const item of Array.isArray(manifest.diagnostics) ? manifest.diagnostics : []) {
    if (item?.nodeId) wanted.add(item.nodeId);
    const parent = typeof item?.parent === "string" ? item.parent : item?.parent?.id || item?.parentId;
    if (parent) wanted.add(parent);
  }
  const diagnosticPageByNode = new Map(manifest.pages.filter(Boolean).map(page => [page.id, page.id]));
  const records = new Map(), pageIds = new Set(), pages = [], componentRecords = [], fontRequestsByPage = new Map();
  for (const page of manifest.pages) {
    const pagePath = String(page?.pageFile || "");
    if (!page?.id || !pagePath) { issue("PAGE_INVALID", pagePath || "pages", "page id/pageFile is required"); continue; }
    if (pageIds.has(page.id)) issue("PAGE_DUPLICATE", page.id, "duplicate page id");
    pageIds.add(page.id);
    const index = await readJson(pagePath, "PAGE_INDEX_MISSING", "PAGE_INDEX_JSON");
    if (!index) continue;
    if (index.schema !== "mastergo2figma.page.v2" || index.version !== 2 || !Array.isArray(index.rootNodeIds) || !Array.isArray(index.layerChunks)) { issue("PAGE_INDEX_INVALID", pagePath, "invalid page index"); continue; }
    visitors.onPage?.(page, index);
    pages.push({ manifest: page, index, path: pagePath });
    let pageCount = 0;
    const pageFonts = new Map();
    for (const chunkPath of index.layerChunks) {
      const chunk = await readJson(chunkPath, "CHUNK_MISSING", "CHUNK_JSON");
      if (!chunk) continue;
      if (chunk.schema !== "mastergo2figma.layers.v2" || !Array.isArray(chunk.records)) { issue("CHUNK_INVALID", chunkPath, "invalid layer chunk"); continue; }
      for (const record of chunk.records) {
        if (!record?.id || !record.props || !Array.isArray(record.childIds)) { issue("RECORD_INVALID", chunkPath, "invalid v2 layer record"); continue; }
        if (records.has(record.id)) { issue("RECORD_DUPLICATE", record.id, "duplicate layer id"); continue; }
        records.set(record.id, { id: record.id, parentId: record.parentId, childIds: record.childIds, index: record.index, pageId: page.id });
        visitors.onRecord?.(record, page);
        collectRecordFonts(record, pageFonts);
        if (record.props.type === "COMPONENT") componentRecords.push({ id: record.id, pageId: page.id });
        if (wanted.has(record.id)) diagnosticPageByNode.set(record.id, page.id);
        pageCount++;
      }
    }
    fontRequestsByPage.set(page.id, [...pageFonts.values()]);
    if (page.layerCount !== undefined && Number(page.layerCount) !== pageCount) issue("PAGE_COUNT_INVALID", pagePath, "page layer count does not match records");
  }
  const reachable = new Set();
  for (const page of pages) {
    const stack = page.index.rootNodeIds.slice();
    while (stack.length) {
      const id = stack.pop(), record = records.get(id);
      if (!record) { issue("ROOT_OR_CHILD_MISSING", id, "referenced layer record is missing"); continue; }
      if (record.pageId !== page.manifest.id) issue("CROSS_PAGE_NODE", id, "node is referenced by a different page");
      if (reachable.has(id)) { issue("NODE_NOT_UNIQUE_REACHABLE", id, "node is reachable more than once"); continue; }
      reachable.add(id);
      if (record.parentId !== null && record.parentId !== undefined) {
        const parent = records.get(record.parentId);
        if (!parent || parent.pageId !== record.pageId || !parent.childIds.includes(id)) issue("PARENT_SYMMETRY", id, "parentId does not point back to child");
      }
      for (let index = record.childIds.length - 1; index >= 0; index--) {
        const childId = record.childIds[index], child = records.get(childId);
        if (child && child.parentId !== id) issue("CHILD_SYMMETRY", childId, "child parentId does not match container");
        stack.push(childId);
      }
    }
  }
  for (const [id, record] of records) {
    if (!reachable.has(id)) issue("NODE_UNREACHABLE", id, "layer record is not reachable from a page root");
    const parent = record.parentId && records.get(record.parentId);
    if (parent && Number.isFinite(record.index) && parent.childIds[record.index] !== id) issue("INDEX_MISMATCH", id, "record index does not match parent childIds");
  }
  for (const [key, asset] of Object.entries(manifest.assets || {})) {
    if (asset?.missing) { warnings.push({ code: "ASSET_DECLARED_MISSING", path: key }); continue; }
    if (!asset?.path || !source.resolve(asset.path, root)) issue("ASSET_MISSING", key, "asset path is missing");
  }
  const expected = Number(manifest.stats?.layerCount);
  if (Number.isFinite(expected) && expected !== records.size) issue("MANIFEST_LAYER_COUNT", "manifest.stats.layerCount", "layer count does not match records");
  return { ok: errors.length === 0, manifest, errors, warnings, diagnosticPageByNode, componentRecords, fontRequestsByPage, recordCount: records.size };
}
