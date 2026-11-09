const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const validation = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

function loadModule(relative, globals = {}) {
  const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, relative)], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["heic-to/csp"], logLevel: "silent" }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "require", ...Object.keys(globals), code)(mod, mod.exports, require, ...Object.values(globals));
  return mod.exports;
}
const { openZipBlobSource, preflightV2Source } = loadModule("../../ReceiveFromMasterGo/ui-src/zipBlobSource.js");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function archive(files, { zip64 = false, shift = 0, comment = Buffer.alloc(0) } = {}) {
  const locals = [], central = [], payloads = new Map(), centralOffsets = [];
  let offset = shift, centralLength = 0;
  for (const file of files) {
    const name = file.nameBytes || Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(typeof file.data === "string" ? file.data : JSON.stringify(file.data));
    const compressed = file.method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    const flags = file.flags ?? 0x800;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(45, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(file.method || 0, 8); local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    payloads.set(file.name, offset + local.length + name.length);
    locals.push(local, name, compressed);
    let extra = file.extra || Buffer.alloc(0);
    if (zip64) {
      const sizes = Buffer.alloc(28);
      sizes.writeUInt16LE(1); sizes.writeUInt16LE(24, 2);
      sizes.writeBigUInt64LE(BigInt(data.length), 4); sizes.writeBigUInt64LE(BigInt(compressed.length), 12); sizes.writeBigUInt64LE(BigInt(offset), 20);
      extra = Buffer.concat([extra, sizes]);
    }
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(45, 4); entry.writeUInt16LE(45, 6); entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(file.method || 0, 10); entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20); entry.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt16LE(extra.length, 30); entry.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centralOffsets.push(centralLength);
    central.push(entry, name, extra);
    centralLength += 46 + name.length + extra.length;
    offset += 30 + name.length + compressed.length;
  }
  const directoryOffset = offset, tail = [];
  if (zip64) {
    const end64 = Buffer.alloc(56), locator = Buffer.alloc(20);
    end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4);
    end64.writeBigUInt64LE(BigInt(files.length), 24); end64.writeBigUInt64LE(BigInt(files.length), 32);
    end64.writeBigUInt64LE(BigInt(centralLength), 40); end64.writeBigUInt64LE(BigInt(directoryOffset), 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(directoryOffset + centralLength), 8); locator.writeUInt32LE(1, 16);
    tail.push(end64, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(zip64 ? 0xffff : files.length, 8); end.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : centralLength, 12); end.writeUInt32LE(zip64 ? 0xffffffff : directoryOffset, 16); end.writeUInt16LE(comment.length, 20);
  return { bytes: Buffer.concat([...locals, ...central, ...tail, end, comment]), shift, payloads, directoryOffset,
    centralOffsets: centralOffsets.map(value => directoryOffset + value) };
}
function trackedFile(fixture, name = "设计.zip") {
  const ranges = [];
  return { name, size: fixture.shift + fixture.bytes.length, ranges,
    arrayBuffer() { throw new Error("Whole-file arrayBuffer must never be used"); },
    slice(start, end) {
      ranges.push([start, end]);
      assert.ok(start >= 0 && end <= fixture.shift + fixture.bytes.length);
      assert.ok(end - start <= Math.max(fixture.bytes.length, 65577), "reader attempted a whole sparse archive read");
      const bytes = Buffer.alloc(end - start);
      const first = Math.max(start, fixture.shift), last = Math.min(end, fixture.shift + fixture.bytes.length);
      if (last > first) fixture.bytes.copy(bytes, first - start, first - fixture.shift, last - fixture.shift);
      return new Blob([bytes]);
    } };
}
function packageFiles({ damagedOtherPage = false, largeAssets = false, diagnostics = [] } = {}) {
  const pages = ["first", "second"].map(id => ({ id, name: id, pageFile: `${id}/index.json`, layerCount: 1 }));
  const files = [{ name: "manifest.json", data: { schema: "mastergo2figma.package.v2", version: 2,
    documentName: "源文件原名", documentId: 123, pages, diagnostics,
    assets: largeAssets ? { a: { path: "images/a.png" }, b: { path: "images/b.png" } } : {}, stats: { layerCount: 2 } }, method: 8 }];
  for (const page of pages) {
    const id = page.id === "first" ? "instance" : "master";
    files.push({ name: page.pageFile, data: { schema: "mastergo2figma.page.v2", version: 2, id: page.id, name: page.name,
      rootNodeIds: [damagedOtherPage && page.id === "second" ? "absent" : id], layerChunks: [`${page.id}/layers.json`] } });
    files.push({ name: `${page.id}/layers.json`, data: { schema: "mastergo2figma.layers.v2", version: 2,
      pageId: page.id, records: [{ id, parentId: null, childIds: [], mainComponentId: page.id === "first" ? "master" : undefined,
        props: { type: page.id === "first" ? "INSTANCE" : "COMPONENT", sourceType: page.id === "first" ? "INSTANCE" : "COMPONENT",
          ...(largeAssets ? { geometry: { fills: [{ type: "IMAGE", imageRef: page.id === "first" ? "a" : "b" }] } } : {}) } }] } });
  }
  if (largeAssets) files.push({ name: "images/a.png", data: Buffer.alloc(2 * 1024 * 1024, 3) }, { name: "images/b.png", data: Buffer.alloc(2 * 1024 * 1024, 7) });
  return files;
}

test("Blob reader leaves image payloads unread until needed and never calls whole-file arrayBuffer", async () => {
  const fixture = archive(packageFiles({ largeAssets: true }));
  const file = trackedFile(fixture), source = await openZipBlobSource(file);
  const checked = await preflightV2Source(source, "manifest.json");
  assert.equal(checked.ok, true);
  assert.equal(checked.recordCount, 2);
  assert.deepEqual(checked.componentRecords, [{ id: "master", pageId: "second" }]);
  assert.equal(checked.records, undefined, "preflight must not retain full record props");
  assert.ok(source.stats.rangeReadBytes < 100000, source.stats.rangeReadBytes);
  assert.ok(source.stats.maxEntryBytes < 2000);
  const before = source.stats.entryReadBytes;
  const a = await source.read("images/a.png");
  assert.equal(a.length, 2 * 1024 * 1024);
  assert.equal(source.stats.entryReadBytes - before, a.length);
  assert.equal(source.stats.maxEntryBytes, a.length);
  assert.equal(source.stats.entryReadCount, source.stats.crcValidatedEntries);
  const again = await source.read("images/a.png");
  assert.notEqual(again.buffer, a.buffer, "payloads must not be retained in a cache");
});

test("ZIP64 offsets beyond 4 GiB use bounded Blob ranges, preserving exact stored/deflated bytes", async () => {
  const fixture = archive([{ name: "stored", data: "stored" }, { name: "deflated", data: "deflated".repeat(20), method: 8 }], { zip64: true, shift: 2 ** 32, comment: Buffer.from("false PK\x05\x06 end") });
  const file = trackedFile(fixture), source = await openZipBlobSource(file);
  assert.equal(Buffer.from(await source.read("stored")).toString(), "stored");
  assert.equal(Buffer.from(await source.read("deflated")).toString(), "deflated".repeat(20));
  assert.ok(file.ranges.every(([start, end]) => end - start <= 65577));
});

test("CRC corruption is detected when a lazy image is read", async () => {
  const fixture = archive(packageFiles({ largeAssets: true }));
  fixture.bytes[fixture.payloads.get("images/b.png")] ^= 1;
  const source = await openZipBlobSource(trackedFile(fixture));
  assert.equal((await preflightV2Source(source, "manifest.json")).ok, true);
  await assert.rejects(source.read("images/b.png"), /CRC/);
});

test("all pages are structurally validated before selection or any host write", async () => {
  const source = await openZipBlobSource(trackedFile(archive(packageFiles({ damagedOtherPage: true }))));
  const checked = await preflightV2Source(source, "manifest.json");
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(item => item.code === "ROOT_OR_CHILD_MISSING"));
  assert.ok(checked.errors.some(item => item.code === "NODE_UNREACHABLE"));
});

test("null JSON indexes cannot bypass preflight on an empty page", async () => {
  const fixture = archive([
    { name: "manifest.json", data: { schema: "mastergo2figma.package.v2", version: 2,
      pages: [{ id: "empty", name: "empty", pageFile: "empty.json", layerCount: 0 }], assets: {}, stats: { layerCount: 0 } } },
    { name: "empty.json", data: "null" }
  ]);
  const checked = await preflightV2Source(await openZipBlobSource(trackedFile(fixture)), "manifest.json");
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(item => item.code === "PAGE_INDEX_JSON"));
});

test("central path, duplicate, local-header and ZIP64 bounds safeguards remain active", async () => {
  for (const files of [[{ name: "../escape", data: "x" }], [{ name: "same", data: "x" }, { name: "same", data: "y" }]]) {
    await assert.rejects(openZipBlobSource(trackedFile(archive(files))), /路径|重复/);
  }
  const local = archive([{ name: "file", data: "x" }]);
  local.bytes.writeUInt32LE(0, 0);
  await assert.rejects(openZipBlobSource(trackedFile(local)), /本地文件头/);
  const unsafe = archive([{ name: "file", data: "x" }], { zip64: true });
  unsafe.bytes.writeBigUInt64LE(2n ** 53n, unsafe.centralOffsets[0] + 46 + 4 + 4);
  await assert.rejects(openZipBlobSource(trackedFile(unsafe)), /ZIP64/);
});

test("Windows Chinese names and validated Unicode path extras share the original decoder", async () => {
  const raw = Buffer.concat([Buffer.from("pages/"), Buffer.from("d6d0cec4", "hex"), Buffer.from(".json")]);
  const renamed = Buffer.from("pages/正式.json"), extra = Buffer.alloc(9 + renamed.length);
  extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5 + renamed.length, 2); extra[4] = 1;
  extra.writeUInt32LE(crc32(raw), 5); renamed.copy(extra, 9);
  for (const [fields, expected] of [[{ flags: 0, nameBytes: raw }, "pages/中文.json"], [{ flags: 0, nameBytes: raw, extra }, "pages/正式.json"]]) {
    const source = await openZipBlobSource(trackedFile(archive([{ name: expected, data: "ok", ...fields }])));
    assert.equal(Buffer.from(await source.read(expected)).toString(), "ok");
  }
});

function engineHost({ globals = {}, onSend = () => {} } = {}) {
  const sent = [], results = [], progress = [];
  const window = { MasterGoMg: { isMgPackage: () => false }, MasterGoPackageValidation: validation };
  const deliver = message => window.onmessage({ data: { pluginMessage: message } });
  const parent = { postMessage({ pluginMessage }) {
    const message = structuredClone(pluginMessage);
    sent.push(message);
    onSend(message, deliver);
    if (message.requestId) queueMicrotask(() => deliver({ type: "import-ack", transferId: message.transferId, requestId: message.requestId, success: true }));
    if (message.type === "import-session-complete") queueMicrotask(() => deliver({ type: "complete", transferId: message.transferId, pageCount: 2, layerCount: 2,
      performanceReport: { schemaVersion: 1, mainMs: 10, sourceRecordCount: 2, apiCreationCount: 2, stagesMs: { "restore.nodesMs": 9 } } }));
  } };
  const engine = loadModule("../../ReceiveFromMasterGo/ui-src/engine.js", { window, parent, ...globals });
  engine.initEngine({ onComplete: result => results.push(result), onProgress: value => progress.push(value) });
  return { engine, sent, results, progress };
}

test("engine reuses preview structural preflight, streams only required assets, namespaces components and reports real UI timings", async () => {
  const host = engineHost(), file = trackedFile(archive(packageFiles({ largeAssets: true })), "缓存快照.zip");
  const preview = await host.engine.parseFiles([file]);
  assert.equal(preview.documentName, "源文件原名");
  assert.equal(preview.suggestedTargetName, "源文件原名");
  const initialReads = file.ranges.length;
  await host.engine.startImport(preview.pages.map(page => page.id));
  const starts = host.sent.filter(message => message.type === "import-session-start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].componentIds, ["zip_0_master"]);
  const chunks = host.sent.filter(message => message.type === "import-page-chunk").flatMap(message => message.records);
  assert.equal(chunks.find(record => record.id === "zip_0_instance").mainComponentId, "zip_0_master");
  assert.equal(host.sent.filter(message => message.type === "import-asset-start").length, 2);
  assert.ok(file.ranges.length - initialReads < initialReads, "import should reuse directory/structural preflight");
  const result = host.results[0].performanceReport;
  assert.ok(result.totalMs >= 0);
  assert.equal(result.endToEndActiveMs, result.preparationMs + result.totalMs);
  assert.equal(result.apiCreationCount, 2);
  assert.equal(result.mainMs, 10);
  assert.equal(result.zipSources[0].maxEntryBytes, 2 * 1024 * 1024);
});

test("a corrupt later-page image aborts the whole host session rather than reporting success", async () => {
  const fixture = archive(packageFiles({ largeAssets: true }));
  fixture.bytes[fixture.payloads.get("images/b.png")] ^= 1;
  const host = engineHost();
  const preview = await host.engine.parseFiles([trackedFile(fixture)]);
  await assert.rejects(host.engine.startImport(preview.pages.map(page => page.id)), /CRC/);
  assert.equal(host.sent.filter(message => message.type === "import-page-end").length, 1);
  assert.equal(host.sent.filter(message => message.type === "import-session-abort").length, 1);
  assert.equal(host.sent.some(message => message.type === "import-session-complete"), false);
  assert.equal(host.results.length, 0);
});

test("wrapped ZIP packages retain page selection and do not promise unselected components", async () => {
  const host = engineHost();
  const files = packageFiles({ largeAssets: true }).map(file => ({ ...file, name: `中文目录/${file.name}` }));
  const preview = await host.engine.parseFiles([trackedFile(archive(files))]);
  await host.engine.startImport([preview.pages[0].id]);
  const start = host.sent.find(message => message.type === "import-session-start");
  assert.deepEqual(start.componentIds, []);
  assert.deepEqual(start.manifest.pages.map(page => page.name), ["first"]);
  assert.equal(host.sent.filter(message => message.type === "import-page-start").length, 1);
  assert.equal(host.sent.filter(message => message.type === "import-asset-start").length, 1);
});

test("engine rejects multi-source imports and preflight failures before starting a session", async () => {
  const host = engineHost();
  const file = trackedFile(archive(packageFiles()));
  await assert.rejects(host.engine.parseFiles([file, file]), /一个源文件/);
  await assert.rejects(host.engine.parseFiles([trackedFile(archive(packageFiles({ damagedOtherPage: true })))]), /校验失败/);
  assert.equal(host.sent.some(message => message.type === "import-session-start"), false);
});

function fontPackageFiles() {
  const files = packageFiles();
  const first = files.find(file => file.name === "first/layers.json").data.records[0];
  first.props.type = "TEXT";
  first.props.fontName = { family: "HarmonyOS Sans SC", style: "Bold" };
  first.props.styledTextSegments = [
    { fontName: { family: "HarmonyOS Sans SC", style: "Thin" } },
    { fontName: { family: "HarmonyOS Sans SC", style: "Bold" } }
  ];
  const second = files.find(file => file.name === "second/layers.json").data.records[0];
  second.props.fontName = { family: "Other page font", style: "Regular" };
  return files;
}

test("structural preflight collects distinct run fonts by page without rereading records", async () => {
  const source = await openZipBlobSource(trackedFile(archive(fontPackageFiles())));
  const checked = await preflightV2Source(source, "manifest.json");
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.fontRequestsByPage.get("first"), [
    { family: "Inter", style: "Regular" },
    { family: "HarmonyOS Sans SC", style: "Bold" },
    { family: "HarmonyOS Sans SC", style: "Thin" }
  ]);
  assert.deepEqual(checked.fontRequestsByPage.get("second"), [{ family: "Other page font", style: "Regular" }]);
  assert.equal(source.stats.entryReadCount, 5, "font collection must share the existing structural visits");
});

test("font preflight mirrors the normal text fallback when a family has no explicit style", async () => {
  const files = fontPackageFiles();
  const props = files.find(file => file.name === "first/layers.json").data.records[0].props;
  props.fontName = { family: "Family without style" };
  props.styledTextSegments = [];
  const source = await openZipBlobSource(trackedFile(archive(files)));
  const checked = await preflightV2Source(source, "manifest.json");
  assert.deepEqual(checked.fontRequestsByPage.get("first"), [
    { family: "Inter", style: "Regular" }, { family: "Family without style", style: "Regular" }
  ]);
});

test("session font requests include selected pages and text styles, excluding unselected fonts", async () => {
  const files = fontPackageFiles();
  files.push({ name: "styles.json", data: { styles: [{ id: "style", styleType: "TEXT",
    fontName: { family: "Style font", style: "Medium" } }] } });
  const host = engineHost();
  const preview = await host.engine.parseFiles([trackedFile(archive(files))]);
  await host.engine.startImport([preview.pages[0].id]);
  assert.deepEqual(host.sent.find(message => message.type === "import-session-start").fontRequests, [
    { family: "Inter", style: "Regular" },
    { family: "HarmonyOS Sans SC", style: "Bold" },
    { family: "HarmonyOS Sans SC", style: "Thin" },
    { family: "Style font", style: "Medium" }
  ]);
});

test("completion sends the last report with source identity and final UI timings for persistence", async () => {
  const host = engineHost();
  const preview = await host.engine.parseFiles([trackedFile(archive(packageFiles()))]);
  await host.engine.startImport(preview.pages.map(page => page.id));
  const saved = host.sent.find(message => message.type === "save-import-report")?.report;
  assert.ok(saved, "a completed import must retain its measurable report beyond the result window");
  assert.equal(saved.sourceName, "源文件原名");
  assert.equal(saved.performanceReport.mainMs, 10);
  assert.equal(saved.performanceReport.endToEndActiveMs,
    saved.performanceReport.preparationMs + saved.performanceReport.totalMs);
  assert.ok(Number.isFinite(Date.parse(saved.completedAt)));
  assert.deepEqual(saved.target, { documentName: null, fileKey: null });
});

test("font startup has enough ACK budget and exposes its real waiting object without fake activity", async () => {
  const timeouts = [];
  const host = engineHost({
    globals: { setTimeout(callback, delay) { timeouts.push(delay); return setTimeout(callback, delay); } },
    onSend(message, deliver) {
      if (message.type !== "import-session-start") return;
      const progress = { type: "progress", transferId: message.transferId, stage: "fonts", current: 0, total: 2,
        operationLabel: "字体检查：HarmonyOS Sans SC · Thin（3/3）" };
      deliver(progress);
      deliver(progress);
    }
  });
  const preview = await host.engine.parseFiles([trackedFile(archive(fontPackageFiles()))]);
  await host.engine.startImport([preview.pages[0].id]);
  const fonts = host.progress.filter(item => item.stage === "fonts");
  assert.equal(fonts.length, 2);
  assert.match(fonts[0].operationLabel, /Thin/);
  assert.ok(fonts[0].lastUpdateAt > 0);
  assert.equal(fonts[0].lastUpdateAt, fonts[1].lastUpdateAt, "identical status must not pretend useful activity occurred");
  assert.ok(timeouts.includes(125000), "three fonts plus catalog each have a 30s native deadline and an ACK margin");
});

test("restore progress retains work finished on previous pages and identifies the current page", async () => {
  const host = engineHost({ onSend(message, deliver) {
    if (message.type !== "import-page-end") return;
    if (message.pageIndex === 0) deliver({ type: "progress", transferId: message.transferId,
      stage: "postprocess", current: 1, total: 2, postprocessCurrent: 1 });
    else deliver({ type: "progress", transferId: message.transferId, stage: "restore", current: 2, total: 2 });
  } });
  const preview = await host.engine.parseFiles([trackedFile(archive(packageFiles()))]);
  await host.engine.startImport(preview.pages.map(page => page.id));
  const restored = host.progress.find(item => item.stage === "restore" && item.layersDone === 2);
  assert.equal(restored.percent, 94, "completed earlier layout work must not disappear during next-page restore");
  assert.equal(restored.pageName, "second");
});
