import { prepareImageAssetBytes } from "./imageAssets.js";
import { readZipDirectory } from "../../shared/zipArchive.js";
import { openZipBlobSource, memoryPackageSource, preflightV2Source, collectRecordFonts } from "./zipBlobSource.js";

// Framework-free import engine, ported verbatim from the old ui.template.html
// inline script. Owns the package state (manifest/entries), the zip/.mg
// parsing, and the chunked import stream to the plugin main thread. The React
// layer only renders state received through the callbacks passed to
// initEngine(); message protocol and memory behavior are unchanged.

let ui = {};

let manifest = null;
let packageSources = [];
let importComponentIds = [];
let sourceCache = new WeakMap();
let importLibraryStyles = [];
let importFontRequests = [];
let importPageName = "";
let importOperationLabel = "";
let lastProgressSignature = "";
let lastProgressUpdateAt = 0;
let receiverVersion = "未知接收端";
let pages = [];
let previewPageIds = [];
let sourceFiles = [];
let importActive = false;
let importFailed = false;
let importFailure = null;
let failedImportTransferId = "";
let importStreamPending = false;
let restoreStartMs = 0;
let importProgressMode = "idle";
let importProgressStage = "idle";
let importPrepareUnitsTotal = 0;
let importPrepareUnitsDone = 0;
let importRestoreTotal = 0;
let importAssetBytesTotal = 0;
let importAssetBytesDone = 0;
let importPageRecordsTotal = 0;
let importPageRecordsDone = 0;
let importRestoredNodesDone = 0;
let importPostprocessUnitsDone = 0;
let importFinalizeUnitsDone = 0;
let activeImportTransferId = "";
let lastDisplayedPercent = 0;
let importTransferSeq = 0;
let importRequestSeq = 0;
let activeImportClientTimings = null;
let pendingImportClientTimings = null;
let preparationMs = 0;
let preparationClientTimings = null;
let parseStartedAt = null;
let importStartedAt = null;
const monotonicNow = () => typeof performance !== "undefined" ? performance.now() : Date.now();
const importAckResolvers = {};
const IMPORT_CHUNK_SIZE = 128 * 1024;
const IMPORT_YIELD_EVERY_CHUNKS = 32;
const PAGE_RESTORE_IDLE_TIMEOUT_MS = 120000;
const PAGE_RESTORE_MAX_TIMEOUT_MS = 45 * 60 * 1000;
const IMPORT_PROGRESS_STAGES = {
  prepare: { offset: 0, weight: 5 },
  assets: { offset: 5, weight: 20 },
  pageSend: { offset: 25, weight: 10 },
  restore: { offset: 35, weight: 55 },
  postprocess: { offset: 90, weight: 8 },
  finalize: { offset: 98, weight: 2 }
};

function send(pluginMessage) {
  if (pluginMessage.type?.startsWith("import-") && pluginMessage.type !== "import-session-abort") {
    assertImportMayContinue(pluginMessage.transferId);
  }
  parent.postMessage({ pluginMessage }, "*");
}

function rememberImportFailure(error, transferId = activeImportTransferId) {
  if (!importFailure) {
    importFailure = error;
    failedImportTransferId = transferId;
  } else if (!importFailure.retainedImport && error.retainedImport) {
    importFailure.retainedImport = error.retainedImport;
  }
  importFailed = true;
  return importFailure;
}

function assertImportMayContinue(transferId) {
  if (importFailure) throw importFailure;
  if (!importActive || (transferId && transferId !== activeImportTransferId)) {
    throw new Error("导入会话已结束或被替换");
  }
}

export function initEngine(callbacks) {
  ui = callbacks || {};
  window.onmessage = (event) => {
    const message = event.data && event.data.pluginMessage;
    if (!message) return;

    if (message.type === "init") {
      if (typeof message.receiverVersion === "string") receiverVersion = message.receiverVersion;
      if (ui.onInit) ui.onInit(message);
      return;
    }

    if (message.type === "import-ack") {
      resolveImportAck(message);
      return;
    }

    if (message.type === "progress") {
      handleRestoreProgressMessage(message);
      return;
    }

    if (message.type === "complete") {
      if (importFailed || !isCurrentImportMessage(message)) return;
      lastDisplayedPercent = 100;
      const missingImageAssetCount = message.missingImageAssetCount || 0;
      const fallbackConnectorCount = message.fallbackConnectorCount || 0;
      const restoredMissingFontTextNodeCount = message.restoredMissingFontTextNodeCount || 0;
      const failedMissingFontTextNodeCount = message.failedMissingFontTextNodeCount || 0;
      const unresolvedInstanceCount = message.unresolvedInstanceCount || 0;
      const sourceDiagnostics = manifest?.diagnostics || [];
      const textChildContainerDetails = message.textChildContainerDetails || [];
      const totalMs = importStartedAt === null ? undefined : Math.max(0, Math.round(monotonicNow() - importStartedAt));
      const performanceReport = {
        ...(message.performanceReport || {}),
        schemaVersion: 1,
        ...(totalMs !== undefined ? { totalMs, preparationMs, endToEndActiveMs: preparationMs + totalMs } : {}),
        sourceRecordCount: message.performanceReport?.sourceRecordCount ?? message.layerCount ?? activeImportClientTimings?.selectedLayerCount,
        stagesMs: message.performanceReport?.stagesMs || {},
        stageCounts: message.performanceReport?.stageCounts || {},
        clientTimings: message.performanceReport?.clientTimings || activeImportClientTimings,
        preparationClientTimings,
        zipSources: packageSources.filter(Boolean).map(item => item.source.stats).filter(Boolean).map(stats => ({ ...stats })),
        ...(parseStartedAt !== null ? { parseStartToCompleteMs: Math.max(0, Math.round(monotonicNow() - parseStartedAt)) } : {})
      };
      const details = sourceDiagnostics.map(formatSourceDiagnostic);
      for (const item of textChildContainerDetails) {
        details.push(`${item.pageName || "源页面"} · ${item.name || item.sourceId}（${item.sourceId}）：文本包含 ${item.childCount} 个子层，已增加透明容器保留可编辑文本和全部子层；请核对叠放。`);
      }
      if (missingImageAssetCount) details.push(`${missingImageAssetCount} 个图片缺失`);
      if (fallbackConnectorCount) details.push(`${fallbackConnectorCount} 个连接线已降级为折线`);
      if (restoredMissingFontTextNodeCount) details.push(`${restoredMissingFontTextNodeCount} 个文本字体已恢复`);
      if (failedMissingFontTextNodeCount) details.push(`${failedMissingFontTextNodeCount} 个文本字体仍缺失`);
      if (unresolvedInstanceCount) {
        details.push(`${unresolvedInstanceCount} 个实例未恢复组件关系，保留为可编辑图层`);
        const reasons = {
          "missing-component": "源主组件缺失",
          "component-unavailable": "主组件未能恢复",
          "instance-creation-failed": "实例创建失败",
          "structure-fallback": "实例结构需要展开"
        };
        for (const item of message.unresolvedInstanceDetails || []) {
          details.push(`${item.name || item.sourceId}：${reasons[item.reason] || item.reason}（主组件 ${item.mainComponentId || "缺失"}）`);
        }
      }
      const savedReport = {
        schemaVersion: 1,
        sourceName: manifest?.documentName || "未知源文件",
        completedAt: new Date().toISOString(),
        target: { documentName: performanceReport.targetDocumentName || null, fileKey: performanceReport.targetFileKey || null },
        performanceReport
      };
      send({ type: "save-import-report", report: savedReport });
      if (ui.onImportReport) ui.onImportReport(savedReport);
      resetImportProgressMode();
      importActive = false;
      if (ui.onComplete) ui.onComplete({
        pageCount: message.pageCount || 0,
        layerCount: message.layerCount || 0,
        dependencyPageCount: message.dependencyPageCount || 0,
        dependencyComponentCount: message.dependencyComponentCount || 0,
        unresolvedInstanceCount,
        sourceWarningCount: sourceDiagnostics.length + textChildContainerDetails.length,
        sourceDiagnostics,
        performanceReport,
        details
      });
      return;
    }

    if (message.type === "refresh-fonts-complete") {
      const failedTextNodeCount = message.failedTextNodeCount || 0;
      const restoredTextNodeCount = message.restoredTextNodeCount || 0;
      const manuallyResolvedTextNodeCount = message.manuallyResolvedTextNodeCount || 0;
      const candidateTextNodeCount = message.candidateTextNodeCount || 0;
      const details = [`扫描到 ${candidateTextNodeCount} 个缺失字体文本图层`];
      if (manuallyResolvedTextNodeCount) details.push(`${manuallyResolvedTextNodeCount} 个已手动处理`);
      if (restoredTextNodeCount) details.push(`${restoredTextNodeCount} 个已替换`);
      if (failedTextNodeCount) details.push(`${failedTextNodeCount} 个仍缺失`);
      if (ui.onRefreshFontsComplete) ui.onRefreshFontsComplete(details.join("，"));
      return;
    }

    if (message.type === "error") {
      if (!isCurrentImportMessage(message)) return;
      const error = new Error(message.message || "还原失败");
      if (message.retainedImport) error.retainedImport = message.retainedImport;
      const failure = rememberImportFailure(error);
      resetImportProgressMode();
      // Settle every in-flight request so the stream loop exits now instead
      // of hanging until its own (possibly minutes-long) ack timeout.
      rejectAllImportAcks(failure);
      if (!importStreamPending) importActive = false;
      if (ui.onImportError) ui.onImportError(failure.message, failure.retainedImport);
    }
  };
  send({ type: "ui-ready" });
}

export function saveSettings(settings) {
  send({ type: "set-settings", settings });
}

export function hasPackage() {
  return !!manifest;
}

export function getPages() {
  return pages;
}

function createImportClientTimings() {
  return {
    totalsMs: {},
    counts: {},
    bytes: {},
    startedAt: Date.now()
  };
}

function cloneImportClientTimings(timings) {
  return {
    totalsMs: { ...((timings && timings.totalsMs) || {}) },
    counts: { ...((timings && timings.counts) || {}) },
    bytes: { ...((timings && timings.bytes) || {}) },
    startedAt: Date.now()
  };
}

function addClientTiming(name, ms, count) {
  const timings = activeImportClientTimings || pendingImportClientTimings;
  if (!timings || !Number.isFinite(ms)) return;
  timings.totalsMs[name] = (timings.totalsMs[name] || 0) + Math.max(0, Math.round(ms));
  timings.counts[name] = (timings.counts[name] || 0) + (count === undefined ? 1 : Math.max(0, Math.round(count)));
}

function setClientTimingCount(name, count) {
  const timings = activeImportClientTimings || pendingImportClientTimings;
  if (!timings || !Number.isFinite(count)) return;
  timings.counts[name] = Math.max(0, Math.round(count));
}

function addClientTimingBytes(name, bytes) {
  const timings = activeImportClientTimings || pendingImportClientTimings;
  if (!timings || !Number.isFinite(bytes)) return;
  timings.bytes[name] = (timings.bytes[name] || 0) + Math.max(0, Math.round(bytes));
}

function postClientTimings(transferId) {
  if (!activeImportClientTimings) return;
  send({
    type: "import-client-timing",
    transferId,
    clientTimings: activeImportClientTimings
  });
}

function emitProgress(percent) {
  const signature = [percent, importProgressStage, importRestoredNodesDone, importAssetBytesDone,
    importPageRecordsDone, importPostprocessUnitsDone, importFinalizeUnitsDone, importPageName, importOperationLabel].join("\n");
  if (signature !== lastProgressSignature) {
    lastProgressSignature = signature;
    lastProgressUpdateAt = Date.now();
  }
  if (ui.onProgress) ui.onProgress({
    percent: Math.round(percent),
    stage: importProgressStage,
    layersDone: importRestoredNodesDone,
    layersTotal: importRestoreTotal,
    pageName: importPageName,
    operationLabel: importOperationLabel,
    lastUpdateAt: lastProgressUpdateAt
  });
}

function setProgress(current, total) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  setDisplayedProgress(percent);
}

function setStageProgress(stage, current, total) {
  const config = IMPORT_PROGRESS_STAGES[stage] || { offset: 0, weight: 100 };
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const percent = config.offset + ratio * config.weight + (stage === "restore" && importRestoreTotal > 0
    ? (importPostprocessUnitsDone / importRestoreTotal) * IMPORT_PROGRESS_STAGES.postprocess.weight : 0);
  importProgressStage = stage;
  if (stage !== "fonts") importOperationLabel = "";
  setDisplayedProgress(percent);
}

function setDisplayedProgress(percent) {
  percent = Math.max(0, Math.min(100, Math.round(percent)));
  if (activeImportTransferId) percent = Math.max(lastDisplayedPercent, percent);
  lastDisplayedPercent = percent;
  emitProgress(percent);
}

function beginImportPrepareProgress(selectedPages, transferId) {
  importProgressMode = "prepare";
  importProgressStage = "prepare";
  activeImportTransferId = transferId || "";
  lastDisplayedPercent = 0;
  importPrepareUnitsDone = 0;
  importRestoreTotal = selectedPages.reduce((sum, page) => sum + (page.layerCount || 0), 0);
  importPrepareUnitsTotal = Math.max(1, selectedPages.reduce((sum, page) => {
    return sum + (page.layerCount || 0) * 2 + 20;
  }, 0));
  importAssetBytesTotal = 0;
  importAssetBytesDone = 0;
  importPageRecordsTotal = 0;
  importPageRecordsDone = 0;
  importRestoredNodesDone = 0;
  importPostprocessUnitsDone = 0;
  importFinalizeUnitsDone = 0;
  setPrepareProgress();
}

function setPrepareProgress() {
  if (importProgressMode !== "prepare") return;
  setStageProgress("prepare", Math.min(importPrepareUnitsDone, importPrepareUnitsTotal), importPrepareUnitsTotal);
}

function advancePrepareProgress(units) {
  if (importProgressMode !== "prepare") return;
  importPrepareUnitsDone = Math.min(importPrepareUnitsTotal, importPrepareUnitsDone + Math.max(0, units || 0));
  setPrepareProgress();
}

function beginImportRestoreProgress() {
  importProgressMode = "restore";
  importProgressStage = "restore";
  setStageProgress("restore", importRestoredNodesDone, importRestoreTotal);
}

function handleRestoreProgressMessage(message) {
  if (!isCurrentImportMessage(message)) return;
  updatePageRestoreDeadline(message);
  const current = message.current || 0;
  const total = message.total || 0;
  if (typeof message.pageName === "string") importPageName = message.pageName;
  importOperationLabel = message.operationLabel || "";
  if (message.stage === "fonts") {
    importProgressStage = "fonts";
    emitProgress(lastDisplayedPercent);
    return;
  }
  if (message.stage === "postprocess") {
    importProgressMode = "restore";
    importRestoredNodesDone = Math.max(importRestoredNodesDone, current);
    importPostprocessUnitsDone = Math.max(importPostprocessUnitsDone, message.postprocessCurrent || 0);
    const percent = IMPORT_PROGRESS_STAGES.restore.offset +
      (importRestoreTotal > 0 ? (importRestoredNodesDone / importRestoreTotal) * IMPORT_PROGRESS_STAGES.restore.weight : 0) +
      (importRestoreTotal > 0 ? (importPostprocessUnitsDone / importRestoreTotal) * IMPORT_PROGRESS_STAGES.postprocess.weight : 0);
    importProgressStage = "postprocess";
    setDisplayedProgress(percent);
    return;
  }
  if (message.stage === "finalize") {
    importProgressMode = "restore";
    importFinalizeUnitsDone = Math.max(importFinalizeUnitsDone, message.finalizeCurrent || current || 0);
    setStageProgress("finalize", importFinalizeUnitsDone, message.finalizeTotal || total || 1);
    return;
  }
  if (message.stage === "restore" && current <= 0 && importProgressMode === "prepare") {
    return;
  }
  if (message.stage === "restore" || current > 0) {
    importRestoredNodesDone = Math.max(importRestoredNodesDone, current);
    if (importProgressMode === "prepare") {
      beginImportRestoreProgress();
    }
    setStageProgress("restore", importRestoredNodesDone, total || importRestoreTotal);
    return;
  }
  setProgress(current, total);
}

function resetImportProgressMode() {
  importProgressMode = "idle";
  importProgressStage = "idle";
  importPrepareUnitsTotal = 0;
  importPrepareUnitsDone = 0;
  importRestoreTotal = 0;
  importAssetBytesTotal = 0;
  importAssetBytesDone = 0;
  importPageRecordsTotal = 0;
  importPageRecordsDone = 0;
  importRestoredNodesDone = 0;
  importPostprocessUnitsDone = 0;
  importFinalizeUnitsDone = 0;
  activeImportTransferId = "";
  lastDisplayedPercent = 0;
  importPageName = "";
  importOperationLabel = "";
  lastProgressSignature = "";
  lastProgressUpdateAt = 0;
}

function isCurrentImportMessage(message) {
  if (!message || !message.transferId) return true;
  // No active transfer (idle, or reset after a local failure): drop late
  // main-thread progress — it used to repaint over the error status with
  // stale "页面完成" labels and zeroed totals.
  return !!activeImportTransferId && message.transferId === activeImportTransferId;
}

export async function parseFiles(files) {
  if (files.length !== 1) {
    resetPackage();
    throw new Error("每次只能导入一个源文件，请分别选择 .mg 或 ZIP 文件");
  }
  parseStartedAt = monotonicNow();
  const info = await loadFiles(files);
  preparationMs = Math.max(0, Math.round(monotonicNow() - parseStartedAt));
  preparationClientTimings = pendingImportClientTimings;
  // File handles keep the original compressed source available for a fresh,
  // selection-aware decode without retaining a second full node tree.
  sourceFiles = Array.from(files);
  previewPageIds = info.pages.map(page => page.id);
  return info;
}

function sourceDiagnosticParentId(item) {
  return typeof item.parent === "string" ? item.parent : item.parent?.id || item.parentId || "";
}

function collectSourceDiagnostics(sourceManifest, zipEntries, zipRoot, selectedIds, sourceFile, prefix, nodePageLookup) {
  const source = sourceManifest.diagnostics;
  if (source === undefined) return [];
  const items = (Array.isArray(source) ? source : [{
    code: "SOURCE_DIAGNOSTICS_INVALID", message: "源文件诊断格式无效，无法逐项核对", value: source
  }]).map(item => item && typeof item === "object" ? item : { code: "SOURCE_DIAGNOSTIC", message: String(item) });
  if (!items.length) return [];
  const pageByNode = nodePageLookup || new Map(sourceManifest.pages.map(page => [page.id, page.id]));
  const wanted = new Set();
  for (const item of items) {
    if (item.nodeId) wanted.add(item.nodeId);
    const parentId = sourceDiagnosticParentId(item);
    if (parentId) wanted.add(parentId);
  }
  // Missing source nodes have no layer record. Their readable parent can
  // still locate the warning on a page; genuinely unlocatable warnings stay
  // explicitly file-scoped instead of disappearing when users choose pages.
  if (!nodePageLookup) for (const page of sourceManifest.pages) {
    const pageBytes = zipEntries[`${zipRoot}${page.pageFile}`];
    if (!pageBytes) continue;
    const index = JSON.parse(decodeUtf8(pageBytes));
    for (const chunkPath of index.layerChunks || []) {
      const chunkBytes = zipEntries[`${zipRoot}${chunkPath}`];
      if (!chunkBytes) continue;
      const chunk = JSON.parse(decodeUtf8(chunkBytes));
      for (const record of chunk.records || []) {
        if (wanted.has(record.id)) pageByNode.set(record.id, page.id);
      }
    }
  }
  const result = [];
  for (const item of items) {
    const parentId = sourceDiagnosticParentId(item);
    // Failed styles may have been deduplicated at export using only the
    // first affected node, and unsupported bindings are absent from records.
    // That first node alone cannot prove the warning belongs to one page.
    const isStyle = String(item.code || "").startsWith("STYLE_") || item.type === "STYLE";
    const pageId = isStyle ? null : pageByNode.get(item.nodeId) || pageByNode.get(parentId) || pageByNode.get(item.pageId);
    if (selectedIds && pageId && !selectedIds.includes(pageId)) continue;
    const merged = { ...item, sourceFile, sourceNamespace: prefix, sourceScope: pageId ? "page" : "source" };
    for (const [field, original] of [["nodeId", item.nodeId], ["componentId", item.componentId], ["styleId", item.styleId]]) {
      if (!original) continue;
      merged[`source${field[0].toUpperCase()}${field.slice(1)}`] = original;
      merged[field] = `${prefix}${original}`;
    }
    if (parentId) {
      merged.sourceParentId = parentId;
      if (typeof item.parent === "string") merged.parent = `${prefix}${parentId}`;
      else if (item.parent && typeof item.parent === "object") merged.parent = { ...item.parent, id: `${prefix}${parentId}` };
      if (item.parentId) merged.parentId = `${prefix}${parentId}`;
    }
    if (pageId) {
      merged.sourcePageId = pageId;
      merged.pageId = `${prefix}${pageId}`;
    }
    result.push(merged);
  }
  return result;
}

function formatSourceDiagnostic(item) {
  const file = `${item.sourceFile || "源文件"}${item.sourceScope === "source" ? "（源文件级记录）" : ""}`;
  const node = item.sourceNodeId || "未定位";
  const reason = item.message || (typeof item.error === "string" ? item.error : item.error?.message) || "";
  let summary;
  if (item.code === "UNREADABLE_SOURCE_NODE") {
    summary = `源图层 ${node} 无法读取，已跳过${item.sourceParentId ? `（父节点 ${item.sourceParentId}）` : ""}`;
  } else if (item.code === "COMPONENT_DEFINITION_MISSING") {
    summary = `源图层 ${node} 的主组件 ${item.sourceComponentId || "缺失"} 不可用`;
  } else if (item.code === "INSTANCE_STRUCTURE_FALLBACK") {
    summary = `源实例 ${node} 的结构已展开，组件关系降级`;
  } else if (String(item.code || "").startsWith("STYLE_") || item.type === "STYLE") {
    summary = `源样式 ${item.sourceStyleId || "未定位"} 关联降级${item.sourceNodeId ? `（图层 ${node}）` : ""}`;
  } else {
    summary = `源导出诊断 ${item.code || "SOURCE_DIAGNOSTIC"}${item.sourceNodeId ? `（图层 ${node}）` : ""}`;
  }
  return `${file}：${summary}${reason ? `：${reason}` : ""}`;
}

async function loadFiles(files, selectedIds) {
  pendingImportClientTimings = createImportClientTimings();
  activeImportClientTimings = null;

  importLibraryStyles = [];
  importFontRequests = [];
  const requestedFonts = new Map();
  const mergedManifest = {
    schema: "mastergo2figma.package.v2",
    version: 2,
    source: "mastergo",
    exportedAt: new Date().toISOString(),
    scope: "composite-pages",
    pages: [],
    diagnostics: [],
    assets: {},
    stats: {
      pageCount: 0,
      layerCount: 0,
      imageAssetCount: 0,
      missingImageAssetCount: 0
    }
  };

  packageSources = [];
  importComponentIds = [];
  const fileNames = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePrefix = `zip_${i}_`;
      const selectedSourceIds = selectedIds
        ? Array.from(selectedIds).filter(id => id.startsWith(filePrefix)).map(id => id.slice(filePrefix.length))
        : null;
      if (selectedSourceIds && selectedSourceIds.length === 0) continue;
      fileNames.push(file.name);

      let prepared = sourceCache.get(file);
      let zipEntries = null;
      let isNative = /\.mg$/i.test(file.name);
      if (!prepared && !isNative) {
        const directoryStartedAt = Date.now();
        const source = await openZipBlobSource(file);
        addClientTiming("ui.zip.directoryMs", Date.now() - directoryStartedAt, source.names.length);
        const manifestPath = findManifestPath(source);
        if (!manifestPath && source.resolve("document")) isNative = true;
        else {
          if (!manifestPath) throw new Error(`文件 "${file.name}" 中没有 manifest.json`);
          const preflightStartedAt = Date.now();
          const validation = await preflightV2Source(source, manifestPath);
          addClientTiming("ui.zip.structurePreflightMs", Date.now() - preflightStartedAt, validation.recordCount || 0);
          if (!validation.ok) {
            const first = validation.errors[0];
            throw new Error(`文件 "${file.name}" 校验失败：${first.code}（${first.path}）`);
          }
          prepared = { source, manifestPath, manifest: validation.manifest, diagnosticPageByNode: validation.diagnosticPageByNode,
            componentRecords: validation.componentRecords, fontRequestsByPage: validation.fontRequestsByPage };
          sourceCache.set(file, prepared);
        }
      }
      if (isNative) {
        const fileReadStartedAt = Date.now();
        const buffer = await file.arrayBuffer();
        addClientTiming("ui.file.arrayBufferMs", Date.now() - fileReadStartedAt);
        addClientTimingBytes("ui.file.bytes", buffer.byteLength || 0);
        const zipReadStartedAt = Date.now();
        zipEntries = await readZipEntries(buffer);
        addClientTiming("ui.zip.readEntriesMs", Date.now() - zipReadStartedAt, Object.keys(zipEntries).length);
      }
      if (isNative) {
        zipEntries = window.MasterGoMg.convertMgPackageToV2Entries(zipEntries, file.name,
          selectedSourceIds
            ? { selectedPageIds: selectedSourceIds, slimInstanceDescendants: true }
            : { previewOnly: true });
      }

      const source = isNative ? memoryPackageSource(zipEntries) : prepared.source;
      const manifestPath = isNative ? findManifestPath(source) : prepared.manifestPath;
      if (!manifestPath) {
        throw new Error(`文件 "${file.name}" 中没有 manifest.json`);
      }

      const zipPackageRoot = manifestPath.slice(0, manifestPath.length - "manifest.json".length);

      const manifestBytes = isNative ? zipEntries[manifestPath] : null;
      if (isNative && !manifestBytes) {
        throw new Error(`无法读取 "${file.name}" 的 manifest.json`);
      }

      const manifestParseStartedAt = Date.now();
      const zipManifest = isNative ? JSON.parse(decodeUtf8(manifestBytes)) : prepared.manifest;
      addClientTiming("ui.manifest.parseMs", Date.now() - manifestParseStartedAt);
      // Native preview contains only the page listing. Full records are
      // generated and validated after the selection is known, before writes.
      let componentRecords = prepared?.componentRecords || [];
      if (isNative && selectedSourceIds) {
        const validation = window.MasterGoPackageValidation.validateV2Package(zipEntries, { manifestPath });
        if (!validation.ok) {
          const first = validation.errors[0];
          throw new Error(`文件 "${file.name}" 校验失败：${first.code}（${first.path}）`);
        }
        componentRecords = [];
        for (const item of validation.records.values()) {
          collectRecordFonts(item.record, requestedFonts);
          if (item.record.props?.type === "COMPONENT") componentRecords.push({ id: item.record.id, pageId: item.pageId });
        }
      } else if (!isNative) {
        for (const [pageId, fonts] of prepared.fontRequestsByPage || []) {
          if (selectedSourceIds && !selectedSourceIds.includes(pageId)) continue;
          for (const font of fonts) requestedFonts.set(`${font.family}\n${font.style}`, font);
        }
      }
      for (const component of componentRecords) {
        if (isNative || !selectedSourceIds || selectedSourceIds.includes(component.pageId)) importComponentIds.push(`${filePrefix}${component.id}`);
      }

      packageSources[i] = { source, root: zipPackageRoot, preflightVerified: !isNative && Boolean(prepared) };
      if (files.length === 1) {
        mergedManifest.documentId = zipManifest.documentId;
        mergedManifest.documentName = typeof zipManifest.documentName === "string" && zipManifest.documentName
          ? zipManifest.documentName : file.name.replace(/\.(mg|zip)$/i, "");
      }

      // Library styles payload (native .mg conversions emit styles.json).
      // Style ids get the same per-zip prefix as record ids so the
      // record-level style refs keep resolving after the merge.
      const stylesPath = source.resolve("styles.json", zipPackageRoot);
      const stylesBytes = stylesPath ? await source.read(stylesPath) : null;
      if (stylesBytes) {
        try {
          const parsedStyles = JSON.parse(decodeUtf8(stylesBytes));
          if (parsedStyles && Array.isArray(parsedStyles.styles)) {
            for (const style of parsedStyles.styles) {
              if (style && style.id) {
                importLibraryStyles.push({ ...style, id: `zip_${i}_${style.id}` });
                if (style.styleType === "TEXT") collectRecordFonts({ props: style }, requestedFonts);
              }
            }
          }
        } catch (e) { /* styles are additive — ignore malformed payloads */ }
      }

      // Merge pages
      for (const page of zipManifest.pages) {
        if (selectedSourceIds && !isNative && !selectedSourceIds.includes(page.id)) continue;
        const mergedPage = {
          ...page,
          id: `zip_${i}_${page.id}`,
          pageFile: page.pageFile ? `zip_${i}/${source.resolve(page.pageFile, zipPackageRoot)}` : "",
          zipIndex: i,
          zipPackageRoot: zipPackageRoot
        };
        mergedManifest.pages.push(mergedPage);
      }
      mergedManifest.diagnostics.push(...collectSourceDiagnostics(
        zipManifest, zipEntries, zipPackageRoot, selectedSourceIds, file.name, filePrefix, prepared?.diagnosticPageByNode
      ));

      // Merge assets
      if (zipManifest.assets && typeof zipManifest.assets === "object") {
        for (const key in zipManifest.assets) {
          const asset = zipManifest.assets[key];
          if (asset) {
            const mergedKey = `zip_${i}_${key}`;
            mergedManifest.assets[mergedKey] = {
              ...asset,
              key: mergedKey,
              path: asset.path ? `zip_${i}/${source.resolve(asset.path, zipPackageRoot)}` : ""
            };
          }
        }
      }

      // Accumulate stats
      mergedManifest.stats.pageCount += zipManifest.stats?.pageCount || zipManifest.pages.length || 0;
      mergedManifest.stats.layerCount += zipManifest.stats?.layerCount || 0;
      mergedManifest.stats.imageAssetCount += zipManifest.stats?.imageAssetCount || 0;
      mergedManifest.stats.missingImageAssetCount += zipManifest.stats?.missingImageAssetCount || 0;
    }
  } catch (error) {
    resetPackage();
    throw error;
  }

  importFontRequests = [...requestedFonts.values()];
  manifest = mergedManifest;
  pages = mergedManifest.pages;

  return {
    fileNames,
    documentName: manifest.documentName,
    suggestedTargetName: manifest.documentName,
    pageCount: manifest.pages.length,
    layerCount: manifest.stats.layerCount || 0,
    pages: manifest.pages.map(page => ({
      id: page.id,
      name: page.name,
      displayName: page.originalName || page.name,
      layerCount: page.layerCount || 0
    }))
  };
}

export function resetPackage() {
  manifest = null;
  packageSources = [];
  importComponentIds = [];
  sourceCache = new WeakMap();
  importLibraryStyles = [];
  importFontRequests = [];
  pages = [];
  previewPageIds = [];
  sourceFiles = [];
  importFailed = false;
  importFailure = null;
  failedImportTransferId = "";
  importStreamPending = false;
  pendingImportClientTimings = null;
  activeImportClientTimings = null;
  importStartedAt = null;
  resetImportProgressMode();
}

export async function startImport(selectedIds) {
  if (importActive) throw new Error("导入正在进行中");
  if (!manifest) throw new Error("请先选择有效的 .mg 文件");
  const selectedSet = new Set(selectedIds);
  if (selectedSet.size === 0) throw new Error("请至少选择一个页面");
  if ([...selectedSet].some(id => !previewPageIds.includes(id))) throw new Error("页面选择已失效，请重新选择文件");

  importActive = true;
  importFailed = false;
  importFailure = null;
  failedImportTransferId = "";
  importStreamPending = true;
  importStartedAt = monotonicNow();
  restoreStartMs = Date.now();
  try {
    await loadFiles(sourceFiles, selectedSet);
    assertImportMayContinue();
    await streamImportPayload(manifest, pages);
    if (importFailure) throw importFailure;
  } catch (error) {
    const failure = rememberImportFailure(error);
    const transferId = activeImportTransferId || failedImportTransferId;
    if (transferId) {
      try {
        const aborted = await sendImportRequest({ type: "import-session-abort", transferId, error: failure.message }, 30000);
        if (aborted.retainedImport) failure.retainedImport = aborted.retainedImport;
      } catch (abortError) {
        if (abortError.retainedImport) failure.retainedImport = abortError.retainedImport;
        // Keep the original source/transport error, enriched with retained state.
      }
      activeImportTransferId = "";
    }
    resetImportProgressMode();
    importActive = false;
    throw failure;
  } finally {
    importStreamPending = false;
  }
}

export function refreshFonts() {
  send({ type: "refresh-fonts" });
}

export function closePlugin() {
  send({ type: "close" });
}

const DESKTOP_HANDOFF_ORIGIN = "http://localhost:8765";

export async function checkPendingDesktopImport(fileKey) {
  if (typeof fetch !== "function") return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 1200) : null;
  try {
    const query = fileKey ? `?fileKey=${encodeURIComponent(fileKey)}` : "";
    const res = await fetch(`${DESKTOP_HANDOFF_ORIGIN}/api/pending-import${query}`, {
      method: "GET",
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok && data.pending ? data.pending : null;
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {any} pending
 * @returns {Promise<File>}
 */
export async function fetchPendingDesktopPackage(pending) {
  if (typeof fetch !== "function" || !pending) throw new Error("无法连接本地桌面端直连服务");
  const fileName = pending.fileName || `${pending.sourceName || pending.sourceId || "migration"}.zip`;
  const query = `?jobId=${encodeURIComponent(pending.jobId || "")}&sourceId=${encodeURIComponent(pending.sourceId || "")}`;
  if (Number.isSafeInteger(pending.bytes) && pending.bytes > 256 * 1024 * 1024) {
    return /** @type {any} */ ({
      name: fileName,
      size: pending.bytes,
      type: "application/zip",
      slice(start = 0, end = pending.bytes) {
        const s = Math.max(0, Math.min(pending.bytes, Number(start) || 0));
        const e = Math.max(s, Math.min(pending.bytes, Number(end) || pending.bytes));
        return {
          size: e - s,
          async arrayBuffer() {
            const rangeRes = await fetch(`${DESKTOP_HANDOFF_ORIGIN}/api/pending-import/package${query}&start=${s}&end=${e}`, { method: "GET" });
            if (!rangeRes.ok) throw new Error("无法从桌面端按范围读取大型迁移包");
            return rangeRes.arrayBuffer();
          }
        };
      }
    });
  }
  const res = await fetch(`${DESKTOP_HANDOFF_ORIGIN}/api/pending-import/package${query}`, { method: "GET" });
  if (!res.ok) throw new Error("无法从桌面端读取待导入的迁移包");
  const buffer = await res.arrayBuffer();
  return new File([buffer], fileName, { type: "application/zip" });
}

export async function notifyDesktopImportComplete(pending, result) {
  if (typeof fetch !== "function" || !pending) return;
  try {
    await fetch(`${DESKTOP_HANDOFF_ORIGIN}/api/pending-import/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: pending.jobId,
        sourceId: pending.sourceId,
        sourceName: pending.sourceName,
        pageCount: result?.pageCount || 0,
        layerCount: result?.layerCount || 0
      })
    });
  } catch (_) { /* ignore */ }
}

// Single recursive pass over a record's props doing what used to be three
// separate full-tree walks (prefixImageRefs + prefixConnectorEndpointNodeIds
// + collectImageRefs). The three mutations touch independent fields, so
// applying them in one visit per node yields identical results; imageRefs
// are collected after prefixing, matching the previous walk order.
function prepareImportProps(obj, prefix, assetKeys) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      prepareImportProps(obj[i], prefix, assetKeys);
    }
    return;
  }
  if (obj.type === "IMAGE" && typeof obj.imageRef === "string") {
    obj.imageRef = prefix + obj.imageRef;
    assetKeys[obj.imageRef] = true;
  }
  if (typeof obj.endpointNodeId === "string") {
    obj.endpointNodeId = prefix + obj.endpointNodeId;
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const val = obj[keys[i]];
    if (val && typeof val === "object") {
      prepareImportProps(val, prefix, assetKeys);
    }
  }
}

function prepareRecordForImport(record, prefix, assetKeys) {
  record.id = `${prefix}${record.id}`;
  if (record.parentId) record.parentId = `${prefix}${record.parentId}`;
  if (Array.isArray(record.childIds)) {
    record.childIds = record.childIds.map(cid => `${prefix}${cid}`);
  }
  // The component reference must be prefixed like every other record id:
  // the plugin resolves it against restoredNodeById, which is keyed by the
  // PREFIXED ids — an unprefixed ref silently misses and every instance
  // falls back to a frame shell.
  if (record.mainComponentId) record.mainComponentId = `${prefix}${record.mainComponentId}`;
  if (record.missingMainComponentId) record.missingMainComponentId = `${prefix}${record.missingMainComponentId}`;
  // Library style refs resolve against the per-zip prefixed style ids.
  if (record.fillStyleRef) record.fillStyleRef = `${prefix}${record.fillStyleRef}`;
  if (record.strokeStyleRef) record.strokeStyleRef = `${prefix}${record.strokeStyleRef}`;
  if (record.effectStyleRef) record.effectStyleRef = `${prefix}${record.effectStyleRef}`;
  if (record.textStyleRef) record.textStyleRef = `${prefix}${record.textStyleRef}`;
  for (const range of record.textStyleRanges || []) range.styleRef = `${prefix}${range.styleRef}`;
  if (record.props) {
    prepareImportProps(record.props, prefix, assetKeys);
  }
}

// Cheap pre-flight over all selected pages (page index files exist, parse
// and pass schema checks, every layer-chunk entry exists) so a broken
// package still fails BEFORE import-session-start — same failure timing as
// the old prepare-everything-first flow, without holding all pages' data.
async function verifyPageEntriesExist(selectedPages, transferId) {
  for (const page of selectedPages) {
    assertImportMayContinue(transferId);
    const sourceEntry = packageSources[page.zipIndex];
    if (sourceEntry && sourceEntry.preflightVerified) continue;
    if (!page.pageFile) throw new Error(`页面缺少索引文件：${page.name || page.id}`);
    const pageBytes = await getPackageEntry(page.pageFile);
    assertImportMayContinue(transferId);
    if (!pageBytes) throw new Error(`缺少页面索引文件：${page.pageFile}`);
    const pageIndex = JSON.parse(decodeUtf8(pageBytes));
    const isValidIndex = (pageIndex.schema === "mastergo2figma.page.v2" && pageIndex.version === 2) ||
      ((pageIndex.schema === "mg2fig.page.v3" || pageIndex.schema === "mastergo2figma.page.v3") && pageIndex.version === 3);
    if (!isValidIndex) {
      throw new Error(`页面索引格式不正确：${page.pageFile}`);
    }
    if (!Array.isArray(pageIndex.layerChunks)) throw new Error(`页面缺少图层分块索引：${page.pageFile}`);
    for (const chunkPath of pageIndex.layerChunks) {
      const fullChunkPath = `zip_${page.zipIndex}/${page.zipPackageRoot}${chunkPath}`;
      if (!locatePackageEntry(fullChunkPath)) throw new Error(`缺少图层分块文件：${fullChunkPath}`);
    }
  }
}

async function streamImportPayload(sourceManifest, selectedPages) {
  const transferId = `import_${Date.now()}_${++importTransferSeq}`;
  activeImportClientTimings = cloneImportClientTimings(pendingImportClientTimings);
  activeImportClientTimings.transferId = transferId;
  activeImportClientTimings.selectedPageCount = selectedPages.length;
  activeImportClientTimings.selectedLayerCount = selectedPages.reduce((sum, page) => sum + (page.layerCount || 0), 0);
  const importStartedAt = Date.now();
  beginImportPrepareProgress(selectedPages, transferId);
  const totalNodes = selectedPages.reduce((sum, page) => sum + (page.layerCount || 0), 0);
  const selectedManifest = {
    ...sourceManifest,
    pages: selectedPages.map(page => ({
      id: page.id,
      name: page.name,
      folder: page.folder,
      pageFile: page.pageFile,
      isDependencyPage: page.isDependencyPage === true,
      layerCount: page.layerCount || 0
    })),
    stats: {
      ...(sourceManifest.stats || {}),
      pageCount: selectedPages.length,
      layerCount: totalNodes
    }
  };

  setPrepareProgress();
  await verifyPageEntriesExist(selectedPages, transferId);
  assertImportMayContinue(transferId);
  setClientTimingCount("ui.prepare.selectedPages", selectedPages.length);
  setClientTimingCount("ui.prepare.selectedLayers", totalNodes);

  const sessionStartStartedAt = Date.now();
  await sendImportRequest({
    type: "import-session-start",
    transferId,
    manifest: selectedManifest,
    componentIds: importComponentIds,
    fontRequests: importFontRequests,
    totalPages: selectedPages.length,
    totalNodes,
    clientTimings: activeImportClientTimings
  }, importFontRequests.length ? (importFontRequests.length + 1) * 30000 + 5000 : 30000);
  assertImportMayContinue(transferId);
  addClientTiming("ui.session.startAckMs", Date.now() - sessionStartStartedAt);

  // Library styles go right after the session opens, before any page —
  // node records reference them during restore.
  if (importLibraryStyles.length > 0) {
    await sendImportRequest({
      type: "import-styles",
      transferId,
      styles: importLibraryStyles
    }, 30000);
    assertImportMayContinue(transferId);
  }

  // Pages are prepared lazily, one at a time, right before they are sent:
  // the UI's memory peak drops from "records of ALL selected pages at
  // once" to a single page. The on-the-wire message order is unchanged
  // (session-start; then per page: assets → page-start → chunks →
  // page-end). Only progress pacing differs, and the progress bar is
  // monotonic by construction (setDisplayedProgress clamps).
  const sentAssetPaths = {};
  for (let pageIndex = 0; pageIndex < selectedPages.length; pageIndex++) {
    assertImportMayContinue(transferId);
    const page = selectedPages[pageIndex];
    importPageName = page.originalName || page.name || "";
    setPrepareProgress();
    const pagePrepareStartedAt = Date.now();
    const pageData = await buildPageImportData(page, transferId);
    assertImportMayContinue(transferId);
    addClientTiming("ui.prepare.pageDataMs", Date.now() - pagePrepareStartedAt);
    addClientTiming("ui.prepare.totalMs", Date.now() - pagePrepareStartedAt);
    const assetTransfers = getRequiredAssetTransfers(sourceManifest, pageData.assetKeys, sentAssetPaths);
    importAssetBytesTotal += getAssetTransferBytes(assetTransfers);
    importPageRecordsTotal += getLayerChunkRecordCount(pageData.layerChunks);

    if (assetTransfers.length > 0) {
      setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);
    }
    for (const asset of assetTransfers) {
      await streamImportAsset(transferId, asset);
      assertImportMayContinue(transferId);
    }

    setStageProgress("pageSend", importPageRecordsDone, importPageRecordsTotal);
    const pageStartAckStartedAt = Date.now();
    await sendImportRequest({
      type: "import-page-start",
      transferId,
      pageIndex,
      page: pageData.page
    }, 30000);
    assertImportMayContinue(transferId);
    addClientTiming("ui.page.startAckMs", Date.now() - pageStartAckStartedAt);
    const pageChunkPostStartedAt = Date.now();
    for (let chunkIndex = 0; chunkIndex < pageData.layerChunks.length; chunkIndex++) {
      assertImportMayContinue(transferId);
      const records = pageData.layerChunks[chunkIndex];
      send({
        type: "import-page-chunk",
        transferId,
        pageIndex,
        chunkIndex,
        records
      });
      // Release the UI-side copy right away: the plugin main thread is
      // building its own copy of these records while this loop runs, and
      // on 200k-record pages holding both simultaneously OOMs the tab.
      pageData.layerChunks[chunkIndex] = null;
      importPageRecordsDone = Math.min(importPageRecordsTotal, importPageRecordsDone + records.length);
      setStageProgress("pageSend", importPageRecordsDone, importPageRecordsTotal);
      if ((chunkIndex + 1) % IMPORT_YIELD_EVERY_CHUNKS === 0) await waitForUIRelease();
      assertImportMayContinue(transferId);
    }
    addClientTiming("ui.page.chunkPostMs", Date.now() - pageChunkPostStartedAt);
    if (importProgressMode === "prepare") beginImportRestoreProgress();
    const pageRestoreWaitStartedAt = Date.now();
    await sendImportRequest({
      type: "import-page-end",
      transferId,
      pageIndex,
      recordCount: pageData.recordCount,
      pageName: pageData.page.name || pageData.page.id
    }, PAGE_RESTORE_IDLE_TIMEOUT_MS, `页面还原超时：${pageData.page.name || pageData.page.id}`);
    assertImportMayContinue(transferId);
    addClientTiming("ui.page.restoreWaitMs", Date.now() - pageRestoreWaitStartedAt);
    postClientTimings(transferId);
    if (ui.onPageDone) {
      ui.onPageDone(selectedPages.slice(0, pageIndex + 1).filter(p => !p.isDependencyPage).length,
        selectedPages.filter(p => !p.isDependencyPage).length);
    }
  }

  addClientTiming("ui.import.untilCompletePostMs", Date.now() - importStartedAt);
  assertImportMayContinue(transferId);
  send({ type: "import-session-complete", transferId, clientTimings: activeImportClientTimings });
}

async function buildPageImportData(page, transferId) {
  const assetKeys = {};
  if (!page.pageFile) throw new Error(`页面缺少索引文件：${page.name || page.id}`);
  const pageBytes = await getPackageEntry(page.pageFile);
  assertImportMayContinue(transferId);
  if (!pageBytes) throw new Error(`缺少页面索引文件：${page.pageFile}`);
  const pageIndex = JSON.parse(decodeUtf8(pageBytes));
  const isValidIndex = (pageIndex.schema === "mastergo2figma.page.v2" && pageIndex.version === 2) ||
    ((pageIndex.schema === "mg2fig.page.v3" || pageIndex.schema === "mastergo2figma.page.v3") && pageIndex.version === 3);
  if (!isValidIndex) {
    throw new Error(`页面索引格式不正确：${page.pageFile}`);
  }
  if (!Array.isArray(pageIndex.layerChunks)) throw new Error(`页面缺少图层分块索引：${page.pageFile}`);

  const zipIndex = page.zipIndex;
  const zipPackageRoot = page.zipPackageRoot;
  const prefix = `zip_${zipIndex}_`;

  pageIndex.id = `${prefix}${pageIndex.id}`;
  if (Array.isArray(pageIndex.rootNodeIds)) {
    pageIndex.rootNodeIds = pageIndex.rootNodeIds.map(rid => `${prefix}${rid}`);
  }

  // Records are parsed fresh from the zip bytes on every restore run, so
  // each record object has a single owner here and is prefixed in place —
  // the previous defensive deep clone (cloneJson) doubled memory and cost
  // a full stringify+parse of the whole page for nothing.
  const rawRecordsById = {};
  const sourceChunkRecords = [];
  for (let chunkIndex = 0; chunkIndex < pageIndex.layerChunks.length; chunkIndex++) {
    const chunkPath = pageIndex.layerChunks[chunkIndex];
    const fullChunkPath = `zip_${zipIndex}/${zipPackageRoot}${chunkPath}`;
    const bytes = await getPackageEntry(fullChunkPath);
    assertImportMayContinue(transferId);
    if (!bytes) throw new Error(`缺少图层分块文件：${fullChunkPath}`);
    const chunk = JSON.parse(decodeUtf8(bytes));

    const isValidChunk = chunk.schema === "mastergo2figma.layers.v2" ||
      chunk.schema === "mg2fig.layers.v3" ||
      chunk.schema === "mastergo2figma.layers.v3";
    if (!isValidChunk || !Array.isArray(chunk.records)) {
      throw new Error(`图层分块格式不正确：${chunkPath}`);
    }
    sourceChunkRecords.push(chunk.records);
    for (const record of chunk.records) {
      if (record && record.id) rawRecordsById[record.id] = record;
    }
    advancePrepareProgress(chunk.records.length);
  }

  const reachableIds = collectReachableLayerIds(pageIndex.rootNodeIds, rawRecordsById, prefix);
  const reachableCount = reachableIds.length;
  const reachableSet = {};
  for (const id of reachableIds) reachableSet[id] = true;

  // Emit message chunks following the source layer-chunk grouping: the
  // export side already bounds each chunk to <=16 records / ~64 KiB, so no
  // per-record JSON.stringify size probing is needed. Only the winning
  // occurrence of a duplicated id (last one in rawRecordsById) is emitted,
  // matching the previous by-id dedup. Grouping/order of import-page-chunk
  // messages is not part of the contract — the plugin accumulates records
  // into a dict and restores from rootNodeIds/childIds.
  const layerChunks = [];
  let organizedCount = 0;
  let lastOrganizedCount = 0;
  for (const records of sourceChunkRecords) {
    const emitted = [];
    for (const record of records) {
      if (!record || !record.id) continue;
      if (!reachableSet[record.id] || rawRecordsById[record.id] !== record) continue;
      prepareRecordForImport(record, prefix, assetKeys);
      emitted.push(record);
      organizedCount++;
      if (organizedCount % 100 === 0 || organizedCount === reachableCount) {
        advancePrepareProgress(organizedCount - lastOrganizedCount);
        lastOrganizedCount = organizedCount;
      }
    }
    if (emitted.length > 0) layerChunks.push(emitted);
  }

  if (Array.isArray(pageIndex.layerChunks)) {
    pageIndex.layerChunks = pageIndex.layerChunks.map(chunkPath => `zip_${zipIndex}/${zipPackageRoot}${chunkPath}`);
  }

  return {
    page: pageIndex,
    layerChunks,
    // Retain the actual count after the posting loop releases chunk arrays.
    recordCount: organizedCount,
    assetKeys
  };
}

function collectReachableLayerIds(rootNodeIds, recordsById, prefix) {
  const result = [];
  const seen = {};
  const stack = [];
  for (const prefixedRootId of rootNodeIds || []) {
    const rawRootId = stripPrefix(prefixedRootId, prefix);
    if (rawRootId) stack.push(rawRootId);
  }
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen[id] || !recordsById[id]) continue;
    seen[id] = true;
    result.push(id);
    const children = Array.isArray(recordsById[id].childIds) ? recordsById[id].childIds : [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]);
    }
  }
  return result;
}

function stripPrefix(value, prefix) {
  return typeof value === "string" && value.indexOf(prefix) === 0 ? value.slice(prefix.length) : value;
}

function getRequiredAssetTransfers(sourceManifest, assetKeys, sentAssetPaths) {
  const assetMap = sourceManifest.assets || {};
  const byPath = {};
  let hasNewPath = false;
  for (const key in assetKeys) {
    const asset = assetMap[key];
    if (!asset || asset.missing || !asset.path || sentAssetPaths[asset.path]) continue;
    if (byPath[asset.path]) continue;
    const entry = locatePackageEntry(asset.path);
    if (!entry) continue;
    byPath[asset.path] = {
      path: asset.path,
      size: entry.source.size(entry.name),
      keys: []
    };
    hasNewPath = true;
  }
  if (!hasNewPath) return [];
  for (const key in assetMap) {
    const asset = assetMap[key];
    if (asset && asset.path && byPath[asset.path]) byPath[asset.path].keys.push(key);
  }
  const transfers = [];
  for (const path in byPath) {
    sentAssetPaths[path] = true;
    transfers.push(byPath[path]);
  }
  return transfers;
}

function getAssetTransferBytes(assetTransfers) {
  return assetTransfers.reduce((sum, asset) => sum + (asset.size ?? asset.bytes?.length ?? 0), 0);
}

function getLayerChunkRecordCount(layerChunks) {
  return (layerChunks || []).reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0);
}

async function streamImportAsset(transferId, asset) {
  assertImportMayContinue(transferId);
  const assetSendStartedAt = Date.now();
  const readStartedAt = Date.now();
  const bytes = await getPackageEntry(asset.path);
  assertImportMayContinue(transferId);
  if (!bytes) throw new Error(`缺少图片资源：${asset.path}`);
  addClientTiming("ui.asset.readMs", Date.now() - readStartedAt);
  const preparedBytes = await prepareImageAssetBytes(bytes, asset.path);
  assertImportMayContinue(transferId);
  importAssetBytesTotal += preparedBytes.length - bytes.length;
  await sendImportRequest({
    type: "import-asset-start",
    transferId,
    path: asset.path,
    keys: asset.keys,
    size: preparedBytes.length
  });
  assertImportMayContinue(transferId);
  setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);

  for (let offset = 0, chunkIndex = 0; offset < preparedBytes.length; offset += IMPORT_CHUNK_SIZE, chunkIndex++) {
    assertImportMayContinue(transferId);
    const bytes = preparedBytes.slice(offset, offset + IMPORT_CHUNK_SIZE);
    send({
      type: "import-asset-chunk",
      transferId,
      path: asset.path,
      chunkIndex,
      bytes
    });
    importAssetBytesDone = Math.min(importAssetBytesTotal, importAssetBytesDone + bytes.length);
    setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);
    if ((chunkIndex + 1) % IMPORT_YIELD_EVERY_CHUNKS === 0) await waitForUIRelease();
    assertImportMayContinue(transferId);
  }

  await sendImportRequest({
    type: "import-asset-end",
    transferId,
    path: asset.path
  }, 60000);
  assertImportMayContinue(transferId);
  addClientTiming("ui.asset.sendMs", Date.now() - assetSendStartedAt);
  addClientTimingBytes("ui.asset.bytes", preparedBytes.length);
  setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);
}

function sendImportRequest(message, timeoutMs, timeoutLabel) {
  if (message.type !== "import-session-abort") assertImportMayContinue(message.transferId);
  return new Promise((resolve, reject) => {
    const requestId = `req_${++importRequestSeq}`;
    if (message.type === "import-page-end") {
      const now = Date.now();
      const resolver = { resolve, reject, timeout: null, transferId: message.transferId, pageRestore: {
        transferId: message.transferId, pageIndex: message.pageIndex, pageName: message.pageName,
        hardDeadline: now + PAGE_RESTORE_MAX_TIMEOUT_MS, idleDeadline: now + PAGE_RESTORE_IDLE_TIMEOUT_MS,
        current: importRestoredNodesDone, postprocessCurrent: importPostprocessUnitsDone,
        total: importRestoreTotal, operationLabel: "等待页面还原", receiverVersion
      } };
      importAckResolvers[requestId] = resolver;
      armPageRestoreDeadline(requestId, resolver);
      send({ ...message, requestId });
      return;
    }
    const timeout = setTimeout(() => {
      delete importAckResolvers[requestId];
      const timeoutSeconds = Math.round((timeoutMs || 30000) / 1000);
      reject(new Error(`${timeoutLabel || `导入消息超时：${message.type}`}（${timeoutSeconds}s），最后进度：${lastDisplayedPercent}%`));
    }, timeoutMs || 30000);
    importAckResolvers[requestId] = { resolve, reject, timeout, transferId: message.transferId };
    send({ ...message, requestId });
  });
}

function armPageRestoreDeadline(requestId, resolver) {
  const watch = resolver.pageRestore;
  clearTimeout(resolver.timeout);
  resolver.timeout = setTimeout(() => {
    delete importAckResolvers[requestId];
    const reason = Date.now() >= watch.hardDeadline ? "达到45分钟总上限" : "连续120秒无进展";
    resolver.reject(new Error(`页面还原超时：${watch.pageName || watch.pageIndex}（${reason}），` +
      `已还原 ${watch.current}/${watch.total}，布局 ${watch.postprocessCurrent}/${watch.total}，` +
      `最后操作：${watch.operationLabel}，接收端：${watch.receiverVersion}`));
  }, Math.max(0, Math.min(watch.idleDeadline, watch.hardDeadline) - Date.now()));
}

function updatePageRestoreDeadline(message) {
  const resolver = message.requestId ? importAckResolvers[message.requestId] : null;
  const watch = resolver?.pageRestore;
  if (!watch || message.transferId !== watch.transferId || message.pageIndex !== watch.pageIndex ||
      (message.stage !== "restore" && message.stage !== "postprocess")) return;
  // Old hosts without request/page scope remain readable, but cannot renew
  // this deadline with unrelated progress or repeated heartbeat labels.
  let advanced = false;
  if (Number.isInteger(message.current) && message.current > watch.current && message.current <= watch.total) {
    watch.current = message.current;
    advanced = true;
  }
  if (message.stage === "postprocess" && Number.isFinite(message.postprocessCurrent) &&
      message.postprocessCurrent > watch.postprocessCurrent && message.postprocessCurrent <= watch.total) {
    watch.postprocessCurrent = message.postprocessCurrent;
    advanced = true;
  }
  if (typeof message.operationLabel === "string" && message.operationLabel) watch.operationLabel = message.operationLabel;
  else watch.operationLabel = message.stage === "postprocess" ? "布局及页面收尾" : "创建图层及应用属性";
  if (typeof message.receiverVersion === "string") watch.receiverVersion = message.receiverVersion;
  if (advanced) {
    watch.idleDeadline = Date.now() + PAGE_RESTORE_IDLE_TIMEOUT_MS;
    armPageRestoreDeadline(message.requestId, resolver);
  }
}

function resolveImportAck(message) {
  const requestId = message.requestId;
  const resolver = requestId ? importAckResolvers[requestId] : null;
  if (!resolver) return false;
  if (message.transferId && resolver.transferId && message.transferId !== resolver.transferId) return false;
  clearTimeout(resolver.timeout);
  delete importAckResolvers[requestId];
  if (message.success) resolver.resolve(message);
  else {
    const error = new Error(message.error || "导入消息失败");
    if (message.retainedImport) error.retainedImport = message.retainedImport;
    resolver.reject(rememberImportFailure(error, resolver.transferId));
  }
  return true;
}

function rejectAllImportAcks(error) {
  for (const requestId in importAckResolvers) {
    const resolver = importAckResolvers[requestId];
    clearTimeout(resolver.timeout);
    delete importAckResolvers[requestId];
    resolver.reject(error);
  }
}

function waitForUIRelease() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function findManifestPath(source) {
  if (source.has("manifest.json")) return "manifest.json";
  return source.names.find(path => path.endsWith("/manifest.json")) || "";
}

function locatePackageEntry(path) {
  const match = /^zip_(\d+)\/(.*)$/.exec(path);
  const item = packageSources[match ? Number(match[1]) : 0];
  if (!item) return null;
  const name = item.source.resolve(match ? match[2] : path, item.root);
  return name ? { source: item.source, name } : null;
}

async function getPackageEntry(path) {
  const entry = locatePackageEntry(path);
  return entry ? entry.source.read(entry.name) : null;
}

const sharedUtf8Decoder = new TextDecoder("utf-8");
function decodeUtf8(bytes) {
  return sharedUtf8Decoder.decode(bytes);
}

async function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const result = Object.create(null);
  for (const entry of readZipDirectory(bytes)) {
    if (!entry.name.endsWith("/")) result[entry.name] = await readZipFileEntry(bytes, entry);
  }
  return result;
}

async function readZipFileEntry(bytes, entry) {
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8 && typeof DecompressionStream === "function") {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const content = new Uint8Array(await new Response(stream).arrayBuffer());
    if (content.length !== entry.uncompressedSize) throw new Error("ZIP 解压后的文件尺寸不一致");
    return content;
  }

  throw new Error("暂不支持此 zip 压缩方式，请使用 SendToFigma 导出的 zip");
}
