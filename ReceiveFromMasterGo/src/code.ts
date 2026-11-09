import { normalizeMasterGoSizeLimit } from "../../shared/layoutLimits";
import { restoreLegacyWrapLayout } from "./legacyWrapLayout";
import { ImportLayerRecord, ImportManifest, ImportPageIndex, MissingFontTextRestoreResult, UnresolvedInstanceDetail } from "../../shared/types";
import { state } from "./state";
import { isBackdropCoverageMask, isDefaultMaskFill, isGradientCoverageMask } from "./appliers/maskFill";
import {
  ensureLayerRulesLoaded, hasValidLayerRules, getLayerRuleStatus
} from "./layerRules";
import { restoreMissingFontTextLayers, applyInstanceTextFormatting, registerMissingFontTextCandidate } from "./appliers/text";
import {
  applyDeferredConnectorRestores,
  applyConnectorTextFallback,
  createConnectorVectorNetworkFromData
} from "./appliers/connector";
import {
  deferLayoutRestore,
  applyDeferredLayoutRestores,
  applyDeferredSingleChildAutoSpaceAlignmentFixes
} from "./deferredLayout";
import { loadFontCached, refreshAvailableFonts, ensureAvailableFontsLoaded, resolveAvailableFontName } from "./fontLoader";
import { preflightImportFonts } from "./importFontPreflight";
import { readImportReport, saveImportReport } from "./importReportStorage";
import {
  cleanupImportedContainerShells, createNodeFromData,
  appendRestoredNode, safeRemove, hasUsableVectorNetwork
} from "./nodeCreator";
import { applyProperties } from "./propertyApplier";
import { safeSetFills, safeSetStrokes } from "./appliers/universal";
import {
  shouldRestoreBooleanOperationTree,
  shouldRestoreBooleanVectorAsFrame,
  restoreBooleanOperationTree,
  createBooleanFrameFallbackProps,
  shouldRestoreGroupNode,
  restoreGroupNode,
  shouldRestoreComponentSetNode,
  restoreComponentSetNode
} from "./appliers/container";
import { yieldToEventLoop, setMutationObserver } from "../../shared/utils";

const RESTORE_PROGRESS_NODE_INTERVAL = 100;
const RESTORE_PROGRESS_TIME_INTERVAL_MS = 500;
const PAGE_POSTPROCESS_STAGE_COUNT = 3;
const RESTORE_BATCH_BUDGET_MS = 50;
const RECEIVER_VERSION = "2026.11.06-r4.0";

type TextChildContainerDetail = { sourceId: string; name: string; childCount: number; pageName: string };
type RetainedImportSummary = {
  status: "partial" | "failed";
  pages: { sourcePageId: string; sourcePageName: string; targetPageId: string | null; targetPageName: string | null;
    status: "completed" | "partial" | "pending"; sourceRecordCount: number }[];
  completedPageCount: number; partialPageCount: number; pendingPageCount: number; retainedPageCount: number;
  completedSourceRecordCount: number; reportedRestoredRecordCount: number; totalSourceRecordCount: number;
  cleanupWarnings: string[];
};

type ImportSession = {
  transferId: string;
  manifest: ImportManifest;
  totalPages: number;
  totalNodes: number;
  restoredNodes: number;
  postProcessedNodes: number;
  restoredPages: PageNode[];
  designPages: PageNode[];
  dependencyPages: PageNode[];
  previousCurrentPage: PageNode;
  timings: { [phase: string]: number };
  timingCounts: { [phase: string]: number };
  clientTimings: any;
  activePageRequest?: { requestId?: string; pageIndex: number; pageName: string };
  abortReason?: string;
  // record id → restored node, for component/instance re-linking (native .mg
  // imports carry mainComponentId on instance records)
  restoredNodeById: { [id: string]: SceneNode };
  // Instance records whose component wasn't restored yet when they were
  // reached (use-before-definition INSIDE one page root — the root-level topo
  // sort can't reorder those). They restore as frame shells first and get
  // swapped for real instances after the page finishes.
  deferredInstanceRelinks: { [componentId: string]: DeferredInstanceRelink[] };
  knownComponentIds: Set<string>;
  pendingComponentWork: { [componentId: string]: number };
  finalizingDeferredFallbacks: boolean;
  // Keep the shell reference until finalize: later relinks or replacement of
  // an ancestor can remove it, in which case it is no longer an unresolved instance.
  instanceFallbacks: { [id: string]: { node: SceneNode; detail: UnresolvedInstanceDetail } };
  // Node ids of masks whose record says MasterGo does NOT render their own
  // fill (record.maskRendersFill === false) — paintFilledMaskTwins skips them.
  maskFillSuppressedNodeIds: { [nodeId: string]: true };
  maskFillExplicitNodeIds: { [nodeId: string]: true };
  // library style ref (prefixed .mg style record id) → created Figma style id
  // (native .mg imports ship a styles.json payload; records reference styles
  // via fillStyleRef/strokeStyleRef/effectStyleRef/textStyleRef)
  figmaStyleIdByRef: { [ref: string]: string };
  textChildContainerDetails: TextChildContainerDetail[];
  pageStates: { page: PageNode; completed: boolean }[];
  retainingFailedImport?: boolean;
  retentionWarnings: string[];
};

type DeferredInstanceRelink = {
  id: string;
  node: SceneNode;
  layers: { [id: string]: ImportLayerRecord };
  lightweight: boolean;
  dependencies: string[];
  ownerComponentId: string | null;
};

type PendingAsset = {
  path: string;
  keys: string[];
  size: number;
  chunks: Uint8Array[];
};

type PendingPage = {
  pageIndex: number;
  page: ImportPageIndex;
  layers: { [id: string]: ImportLayerRecord };
  recordCount: number;
  error?: string;
};

const UI_SETTINGS_STORAGE_KEY = "mastergo2figma.receive.settings";

let activeImportSession: ImportSession | null = null;
let lastRetainedImport: { transferId: string; summary: RetainedImportSummary } | null = null;
const pendingImportAssets: { [path: string]: PendingAsset } = {};
const pendingImportPages: { [pageIndex: string]: PendingPage } = {};
let importOperationQueue: Promise<void> = Promise.resolve();

showImportUI();

function showImportUI() {
  ensureLayerRulesLoaded();
  figma.showUI(__html__, { width: 400, height: 620 });
  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "ui-ready") {
      await postInitUI();
      return;
    }

    if (message.type === "close") {
      figma.closePlugin();
      return;
    }

    if (message.type === "resize") {
      const width = typeof message.width === "number" ? message.width : 400;
      const height = typeof message.height === "number" ? message.height : 504;
      figma.ui.resize(width, height);
      return;
    }

    if (message.type === "import-session-start") {
      await handleImportRequest(message, () => startImportSession(message));
      return;
    }

    if (message.type === "import-session-abort") {
      // The operation queue may currently be awaiting a long page restore.
      // Mark cancellation on receipt so that continuation stops at its next
      // host await/yield; the queued operation still owns session cleanup.
      const session = activeImportSession?.transferId === message.transferId ? activeImportSession : null;
      if (session) session.abortReason = String(message.error || "用户取消导入");
      await enqueueImportOperation(() => abortImportSession(message, session));
      return;
    }

    if (message.type === "import-styles") {
      await handleImportRequest(message, () => importSessionStyles(message));
      return;
    }

    if (message.type === "import-asset-start") {
      await handleImportRequest(message, () => startImportAsset(message));
      return;
    }

    if (message.type === "import-asset-chunk") {
      appendImportAssetChunk(message);
      return;
    }

    if (message.type === "import-asset-end") {
      await handleImportRequest(message, () => finishImportAsset(message));
      return;
    }

    if (message.type === "import-page-start") {
      await handleImportRequest(message, () => startImportPage(message));
      return;
    }

    if (message.type === "import-page-chunk") {
      appendImportPageChunk(message);
      return;
    }

    if (message.type === "import-page-end") {
      await handleImportRequest(message, () => finishImportPage(message));
      return;
    }

    if (message.type === "import-session-complete") {
      await enqueueImportOperation(() => completeImportSession(message));
      return;
    }

    if (message.type === "refresh-fonts") {
      await refreshMissingFontsInDocument();
      return;
    }

    if (message.type === "import-client-timing") {
      recordClientTiming(message);
      return;
    }

    if (message.type === "set-settings") {
      try {
        await figma.clientStorage.setAsync(UI_SETTINGS_STORAGE_KEY, message.settings || {});
      } catch (error) {
        console.error("Failed to save settings:", error);
      }
      return;
    }

    if (message.type === "save-import-report") {
      await saveImportReport(figma.clientStorage, message.report);
      return;
    }

    if (message.type === "start-import") {
      figma.ui.postMessage({
        type: "error",
        message: "当前测试版只支持 session/chunk 流式导入"
      });
      return;
    }
  };
}

async function refreshMissingFontsInDocument() {
  // The user may have installed fonts since the import — drop cached
  // rejections so the retry really re-asks Figma.
  state.fontLoadPromises = {};
  try {
    await ensureLayerRulesLoaded();
    if (!hasValidLayerRules()) throw new Error("请先导入有效的图层转换规则 JSON");

    await refreshAvailableFonts();
    const pages = figma.root.children.filter(node => node.type === "PAGE") as PageNode[];
    const missingFontRestoreResult = await restoreMissingFontTextLayers(pages);
    logMissingFontRefreshDiagnostics(missingFontRestoreResult);
    figma.ui.postMessage({
      type: "refresh-fonts-complete",
      scannedTextNodeCount: missingFontRestoreResult.scannedTextNodeCount,
      candidateTextNodeCount: missingFontRestoreResult.candidateTextNodeCount,
      manuallyResolvedTextNodeCount: missingFontRestoreResult.manuallyResolvedTextNodeCount,
      restoredTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
      failedTextNodeCount: missingFontRestoreResult.failedTextNodeCount,
      missingFonts: missingFontRestoreResult.missingFonts
    });
    const details: string[] = [];
    if (missingFontRestoreResult.manuallyResolvedTextNodeCount) {
      details.push(`${missingFontRestoreResult.manuallyResolvedTextNodeCount} manually resolved`);
    }
    if (missingFontRestoreResult.restoredTextNodeCount) {
      details.push(`${missingFontRestoreResult.restoredTextNodeCount} restored`);
    }
    if (missingFontRestoreResult.failedTextNodeCount) {
      details.push(`${missingFontRestoreResult.failedTextNodeCount} still missing`);
    }
    figma.notify(details.length > 0 ? `Font refresh complete. ${details.join("; ")}` : "Font refresh complete.");
  } catch (error) {
    console.error("Refresh fonts failed:", error);
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "刷新字体失败，请查看控制台"
    });
  }
}

function enqueueImportOperation(action: () => Promise<void> | void): Promise<void> {
  const next = importOperationQueue.then(action);
  importOperationQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function handleImportRequest(message: any, action: () => Promise<void> | void) {
  return enqueueImportOperation(async () => {
  const previousSession = activeImportSession;
  try {
    await action();
    figma.ui.postMessage({
      type: "import-ack",
      requestId: message.requestId,
      transferId: message.transferId,
      success: true
    });
  } catch (error) {
    console.error("Import request failed:", error);
    const ownedSession = message.type === "import-session-start"
      ? (previousSession ? null : activeImportSession) : previousSession;
    const retainedImport = ownedSession && ownedSession === activeImportSession && ownedSession.transferId === message.transferId
      ? await retainImportSession(ownedSession) : undefined;
    if (ownedSession && retainedImport) releaseImportSession(ownedSession);
    figma.ui.postMessage({
      type: "import-ack",
      requestId: message.requestId,
      transferId: message.transferId,
      success: false,
      ...(retainedImport ? { retainedImport } : {}),
      error: error instanceof Error ? error.message : "导入失败，请查看控制台"
    });
  }
  });
}

async function startImportSession(message: any) {
  if (state.importInProgress) throw new Error("已有导入任务正在运行");
  await ensureLayerRulesLoaded();
  if (!hasValidLayerRules()) throw new Error("请先导入有效的图层转换规则 JSON");

  const manifest = message.manifest as ImportManifest;
  if (!manifest || manifest.schema !== "mastergo2figma.package.v2" || manifest.version !== 2) {
    throw new Error("当前只支持 v2 导出包，请用新版 SendToFigma 重新导出。");
  }

  const totalNodes = Number(message.totalNodes ?? manifest.stats?.layerCount ?? 0);
  const totalPages = Number(message.totalPages ?? manifest.pages?.length ?? 0);
  if (!Number.isInteger(totalNodes) || totalNodes < 0 || !Number.isInteger(totalPages) || totalPages <= 0) {
    throw new Error("导入页面或图层数量无效");
  }

  state.importInProgress = true;
  state.reset();
  // Font-load results (including cached failures) are per session.
  state.fontLoadPromises = {};
  state.resetRestoreRuntimeStats(totalNodes, totalPages);
  setMutationObserver((operation, written) => {
    const stats = state.activeRestoreStats;
    if (!state.importInProgress || !stats) return;
    if (operation === "set") {
      if (written) stats.safeSetWriteCount++; else stats.safeSetSkipCount++;
    } else {
      if (written) stats.resizeWriteCount++; else stats.resizeSkipCount++;
    }
  });
  clearPendingImportAssets();
  clearPendingImportPages();
  pendingInstanceLayoutOverrides.length = 0;
  instanceLayoutPageCursor = 0;
  activeImportSession = {
    transferId: String(message.transferId || ""),
    manifest,
    totalPages,
    totalNodes,
    restoredNodes: 0,
    postProcessedNodes: 0,
    restoredPages: [],
    designPages: [],
    dependencyPages: [],
    previousCurrentPage: figma.currentPage,
    timings: {},
    timingCounts: {},
    clientTimings: message.clientTimings || null,
    restoredNodeById: {},
    deferredInstanceRelinks: {},
    knownComponentIds: new Set(Array.isArray(message.componentIds) ? message.componentIds.filter((id: any) => typeof id === "string") : []),
    pendingComponentWork: {},
    finalizingDeferredFallbacks: false,
    instanceFallbacks: {},
    maskFillSuppressedNodeIds: {},
    maskFillExplicitNodeIds: {},
    figmaStyleIdByRef: {},
    textChildContainerDetails: [],
    pageStates: [],
    retentionWarnings: []
  };

  if (Array.isArray(message.fontRequests)) {
    const session = activeImportSession;
    const startedAt = Date.now();
    figma.ui.postMessage({ type: "progress", transferId: session.transferId, stage: "fonts",
      operationLabel: "字体检查：读取可用字体目录", current: 0, total: totalNodes });
    const fonts = await preflightImportFonts(message.fontRequests, (font, index, total) => {
      figma.ui.postMessage({ type: "progress", transferId: session.transferId, stage: "fonts",
        operationLabel: `字体检查：${font.family} · ${font.style}（${index}/${total}）`, current: 0, total: totalNodes });
    });
    addImportTiming(session, "prepare.fontsMs", Date.now() - startedAt);
    addImportTimingCount(session, "prepare.fontsLoaded", fonts.loaded);
    addImportTimingCount(session, "prepare.fontsFailed", fonts.failed);
    addImportTimingCount(session, "prepare.fontsMissing", fonts.missing);
  }

  figma.ui.postMessage({
    type: "progress",
    transferId: activeImportSession.transferId,
    stage: "restore",
    current: 0,
    total: totalNodes
  });
}

// Recreate the .mg package's library styles as local Figma styles. Values
// were materialized inline by the converter, so a failed style creation only
// loses the BINDING, never the visual. Effect blendMode arrives normalized to
// PASS_THROUGH (layer semantics) — Figma effects only accept NORMAL there.
async function importSessionStyles(message: any): Promise<void> {
  const session = requireImportSession(message.transferId);
  const styles = Array.isArray(message.styles) ? message.styles : [];
  let created = 0;
  for (const style of styles) {
    if (!style || typeof style.id !== "string" || !style.name) continue;
    try {
      if (style.styleType === "PAINT" && Array.isArray(style.paints) && style.paints.length > 0) {
        const paintStyle = figma.createPaintStyle();
        paintStyle.name = String(style.name);
        try {
          paintStyle.paints = sanitizeStylePaints(style.paints);
        } catch (error) {
          paintStyle.remove();
          throw error;
        }
        session.figmaStyleIdByRef[style.id] = paintStyle.id;
      } else if (style.styleType === "EFFECT" && Array.isArray(style.effects) && style.effects.length > 0) {
        const effectStyle = figma.createEffectStyle();
        effectStyle.name = String(style.name);
        try {
          effectStyle.effects = style.effects.map((effect: any) => {
            const clone = { ...effect };
            if (clone.blendMode === "PASS_THROUGH") clone.blendMode = "NORMAL";
            return clone;
          });
        } catch (error) {
          effectStyle.remove();
          throw error;
        }
        session.figmaStyleIdByRef[style.id] = effectStyle.id;
      } else if (style.styleType === "TEXT" && style.fontName) {
        const requestedFont = { family: String(style.fontName.family || "Inter"), style: String(style.fontName.style || "Regular") };
        await ensureAvailableFontsLoaded();
        const fontName = resolveAvailableFontName(requestedFont) || requestedFont;
        await loadFontCached(fontName);
        const textStyle = figma.createTextStyle();
        textStyle.name = String(style.name);
        try {
          textStyle.fontName = fontName;
          if (typeof style.fontSize === "number" && style.fontSize > 0) textStyle.fontSize = style.fontSize;
          if (style.lineHeight && style.lineHeight.unit === "PIXELS" && typeof style.lineHeight.value === "number") {
            textStyle.lineHeight = { unit: "PIXELS", value: style.lineHeight.value };
          } else {
            textStyle.lineHeight = { unit: "AUTO" };
          }
          if (style.letterSpacing && typeof style.letterSpacing.value === "number") {
            textStyle.letterSpacing = {
              unit: style.letterSpacing.unit === "PIXELS" ? "PIXELS" : "PERCENT",
              value: style.letterSpacing.value
            };
          }
          if (style.textCase && style.textCase !== "ORIGINAL") textStyle.textCase = style.textCase;
          if (style.textDecoration && style.textDecoration !== "NONE") textStyle.textDecoration = style.textDecoration;
        } catch (error) {
          textStyle.remove();
          throw error;
        }
        session.figmaStyleIdByRef[style.id] = textStyle.id;
      } else {
        continue;
      }
      created++;
    } catch (error) {
      console.warn("[mg-style] 样式创建失败(跳过):", style && style.name, error);
    }
  }
  console.info("[mg-style] created", created, "/", styles.length, "library styles");
}

// Solid/gradient paints from styles.json map 1:1 onto Figma Paint minus the
// exporter-only fields; anything unrecognized is dropped (a style with zero
// valid paints is skipped by the caller's try/catch via the setter throwing).
function sanitizeStylePaints(paints: any[]): Paint[] {
  const out: Paint[] = [];
  for (const paint of paints) {
    if (!paint || typeof paint !== "object") continue;
    const visible = paint.visible !== false;
    const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
    if (paint.type === "SOLID" && paint.color) {
      out.push({ type: "SOLID", visible, opacity, color: { r: paint.color.r || 0, g: paint.color.g || 0, b: paint.color.b || 0 } });
      continue;
    }
    if (typeof paint.type === "string" && paint.type.indexOf("GRADIENT_") === 0 && Array.isArray(paint.gradientStops)) {
      out.push({
        type: paint.type,
        visible,
        opacity,
        gradientTransform: Array.isArray(paint.gradientTransform) ? paint.gradientTransform : [[1, 0, 0], [0, 1, 0]],
        gradientStops: paint.gradientStops.map((stop: any) => ({
          position: stop.position || 0,
          color: { r: stop.color?.r || 0, g: stop.color?.g || 0, b: stop.color?.b || 0, a: stop.color?.a === undefined ? 1 : stop.color.a }
        }))
      } as Paint);
      continue;
    }
  }
  return out;
}

// Re-bind restored nodes to the recreated library styles. Runs AFTER
// applyProperties: the raw values are already applied, so binding only
// attaches the style reference (mutating a bound property later would detach
// it — nothing in the pipeline mutates these afterwards except deferred
// layout, which touches geometry only).
async function applyImportedStyleBindings(node: SceneNode, layerRecord: ImportLayerRecord): Promise<void> {
  const session = activeImportSession;
  if (!session) return;
  const map = session.figmaStyleIdByRef;
  const fillRef = (layerRecord as any).fillStyleRef;
  const strokeRef = (layerRecord as any).strokeStyleRef;
  const effectRef = (layerRecord as any).effectStyleRef;
  const textRef = (layerRecord as any).textStyleRef;
  const textRanges = (layerRecord as any).textStyleRanges || [];
  if (!fillRef && !strokeRef && !effectRef && !textRef && textRanges.length === 0) return;
  try {
    if (fillRef && map[fillRef] && "setFillStyleIdAsync" in node) await (node as any).setFillStyleIdAsync(map[fillRef]);
  } catch (error) { /* binding is cosmetic — values already applied */ }
  try {
    if (strokeRef && map[strokeRef] && "setStrokeStyleIdAsync" in node) await (node as any).setStrokeStyleIdAsync(map[strokeRef]);
  } catch (error) { /* ignore */ }
  try {
    if (effectRef && map[effectRef] && "setEffectStyleIdAsync" in node) await (node as any).setEffectStyleIdAsync(map[effectRef]);
  } catch (error) { /* ignore */ }
  try {
    if (textRef && map[textRef] && node.type === "TEXT" && "setTextStyleIdAsync" in node) {
      await (node as any).setTextStyleIdAsync(map[textRef]);
    }
  } catch (error) { /* ignore */ }
  if (node.type === "TEXT") {
    for (const range of textRanges) {
      if (!map[range.styleRef] || range.start < 0 || range.end > node.characters.length || range.end <= range.start) continue;
      try { await node.setRangeTextStyleIdAsync(range.start, range.end, map[range.styleRef]); }
      catch (error) { /* keep already restored per-range typography */ }
    }
  }
}

function startImportAsset(message: any) {
  const session = requireImportSession(message.transferId);
  const path = String(message.path || "");
  if (!path) throw new Error("图片资源缺少路径");
  pendingImportAssets[path] = {
    path,
    keys: Array.isArray(message.keys) ? message.keys.filter((key: any) => typeof key === "string") : [],
    size: Number(message.size || 0),
    chunks: []
  };
  void session;
}

function appendImportAssetChunk(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  const path = String(message.path || "");
  const pending = pendingImportAssets[path];
  if (!pending) return;
  const bytes = normalizeBytes(message.bytes);
  if (bytes) pending.chunks.push(bytes);
}

function finishImportAsset(message: any) {
  const session = requireImportSession(message.transferId);
  const path = String(message.path || "");
  const pending = pendingImportAssets[path];
  if (!pending) throw new Error(`图片资源传输不存在：${path}`);

  try {
    const concatStartedAt = Date.now();
    const bytes = concatBytes(pending.chunks, pending.size);
    addImportTiming(session, "asset.concatBytesMs", Date.now() - concatStartedAt);
    const imageStartedAt = Date.now();
    const image = figma.createImage(bytes);
    addImportTiming(session, "asset.createImageMs", Date.now() - imageStartedAt);
    addImportTimingCount(session, "asset.createImageCount", 1);
    for (const key of pending.keys) state.imageHashByAssetName[key] = image.hash;
    if (pending.keys.length === 0) state.imageHashByAssetName[path] = image.hash;
  } catch (error) {
    console.warn("Unable to create Figma image from streamed asset:", path, error);
    for (const key of pending.keys.length > 0 ? pending.keys : [path]) recordStreamedMissingImage(key);
  } finally {
    delete pendingImportAssets[path];
  }
}

function startImportPage(message: any) {
  requireImportSession(message.transferId);
  const pageIndex = Number(message.pageIndex || 0);
  const importPage = message.page as ImportPageIndex;
  if (!importPage || !Array.isArray(importPage.rootNodeIds)) throw new Error("页面导入数据不完整");
  pendingImportPages[String(pageIndex)] = {
    pageIndex,
    page: importPage,
    layers: {},
    recordCount: 0,
    error: undefined
  };
}

function appendImportPageChunk(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  const startedAt = Date.now();
  const pageIndex = String(Number(message.pageIndex || 0));
  const pending = pendingImportPages[pageIndex];
  if (!pending || !Array.isArray(message.records)) return;
  for (const record of message.records as ImportLayerRecord[]) {
    if (record && record.id) {
      if (pending.layers[record.id]) {
        pending.error = `页面分块包含重复图层：${record.id}`;
        continue;
      }
      pending.layers[record.id] = record;
      pending.recordCount++;
    }
  }
  addImportTiming(activeImportSession, "page.receiveChunkMs", Date.now() - startedAt);
  addImportTimingCount(activeImportSession, "page.receiveChunkCount", 1);
}

async function finishImportPage(message: any) {
  const session = requireImportSession(message.transferId);
  const pageIndex = Number(message.pageIndex || 0);
  const pendingKey = String(pageIndex);
  const pending = pendingImportPages[pendingKey];
  if (!pending) throw new Error(`页面传输不存在：${pendingKey}`);
  session.activePageRequest = { requestId: message.requestId, pageIndex, pageName: pending.page.name || pending.page.id };
  try {
    if (pending.error) throw new Error(pending.error);
    const expectedCount = Number(pending.page.layerCount || 0);
    if (expectedCount > 0 && Object.keys(pending.layers).length !== expectedCount) {
      throw new Error(`页面图层数量不一致：expected=${expectedCount}, actual=${Object.keys(pending.layers).length}`);
    }
    addImportTimingCount(session, "page.receivedRecordCount", pending.recordCount);
    await restoreImportPageData(pending.page, pending.layers, pageIndex);
    if (session.pageStates[pageIndex]) session.pageStates[pageIndex].completed = true;
  } finally {
    session.activePageRequest = undefined;
    delete pendingImportPages[pendingKey];
  }
}

async function restoreImportPageData(importPage: ImportPageIndex, layers: { [id: string]: ImportLayerRecord }, pageIndex = 0) {
  if (!activeImportSession) throw new Error("导入会话不存在或已重置");
  const session = activeImportSession;
  const pageName = createRestoredPageName(importPage.name);
  const pageNodeCount = countLayerRecords(layers);
  if (importPage.layerCount !== undefined && pageNodeCount !== Number(importPage.layerCount)) {
    throw new Error(`页面记录数量不一致：expected=${importPage.layerCount}, actual=${pageNodeCount}`);
  }
  restoreLegacyWrapLayout(layers);
  const postprocessStart = session.postProcessedNodes;
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "restore",
    ...pageProgressContext(session),
    current: session.restoredNodes,
    total: session.totalNodes
  });

  const pageCreateStartedAt = Date.now();
  const restoredPage = figma.createPage();
  state.recordNodeCreation("page");
  restoredPage.name = pageName;
  if (importPage.background) {
    const bg = importPage.background;
    try {
      restoredPage.backgrounds = [{ type: "SOLID", color: { r: bg.r, g: bg.g, b: bg.b }, opacity: bg.a }];
    } catch (error) {
      // keep the default canvas color if the runtime rejects the paint
    }
  }
  session.restoredPages.push(restoredPage);
  session.pageStates[pageIndex] = { page: restoredPage, completed: false };
  if (importPage.isDependencyPage) session.dependencyPages.push(restoredPage);
  else session.designPages.push(restoredPage);
  await figma.setCurrentPageAsync(restoredPage);
  throwIfImportAborted(session);
  addImportTiming(session, "restore.createPageMs", Date.now() - pageCreateStartedAt);

  const nodeRestoreStartedAt = Date.now();
  // One discovery pass over the page feeds the component root set, the mask
  // candidates (replacing a later full re-scan) and a cheap "has any
  // component reference" flag (skipping the topological DFS on plain pages).
  const maskFillExplicitIds: string[] = [];
  const maskFillSuppressedIds: string[] = [];
  let hasComponentReferences = false;
  for (const id in layers) {
    const record = layers[id];
    if (record?.props?.type === "COMPONENT") session.knownComponentIds.add(id);
    const maskFill = record?.maskRendersFill;
    if (maskFill === true) maskFillExplicitIds.push(id);
    else if (maskFill === false) maskFillSuppressedIds.push(id);
    if (!hasComponentReferences && record?.mainComponentId) hasComponentReferences = true;
  }
  let restoredOnPage = 0;
  // Restore component/component-set roots FIRST so instances elsewhere on the
  // page can re-link to them (native .mg imports carry mainComponentId), then
  // put the page children back into the package's root order.
  const rootIds = importPage.rootNodeIds;
  const isComponentRoot = (id: string) => {
    const record = layers[id];
    const type = record && record.props ? record.props.type : null;
    return type === "COMPONENT" || type === "COMPONENT_SET";
  };
  const baseOrder = [...rootIds.filter(isComponentRoot), ...rootIds.filter(id => !isComponentRoot(id))];
  let restoreOrder: string[] = baseOrder;
  if (hasComponentReferences) {
    // Components before instances is not enough: components NEST instances of
    // other components (Tesla: "map" instantiates "en route"). Order roots
    // topologically by mainComponentId dependencies — restoring a dependent
    // first makes createInstance miss and bakes a frame-shell fallback into
    // the component, which every instance of it then clones. Cycles (or deps
    // already satisfied on earlier pages) keep the base order. Pages without
    // any component reference skip this DFS entirely.
    const rootOfRecord: { [id: string]: string } = {};
    for (const rootId of rootIds) {
      const stack = [rootId];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (rootOfRecord[cur] !== undefined) continue;
        rootOfRecord[cur] = rootId;
        const rec = layers[cur];
        for (const cid of (rec && rec.childIds) || []) stack.push(cid);
      }
    }
    const dependsOn: { [rootId: string]: { [dep: string]: true } } = {};
    for (const rootId of rootIds) dependsOn[rootId] = {};
    for (const id in rootOfRecord) {
      const rec = layers[id];
      const target = rec ? rec.mainComponentId : undefined;
      if (!target) continue;
      const fromRoot = rootOfRecord[id];
      const toRoot = rootOfRecord[target];
      if (toRoot !== undefined && toRoot !== fromRoot && dependsOn[fromRoot]) dependsOn[fromRoot][toRoot] = true;
    }
    restoreOrder = [];
    const rootVisitState: { [id: string]: number } = {};
    const visitRoot = (rootId: string) => {
      if (rootVisitState[rootId]) return;
      rootVisitState[rootId] = 1;
      for (const dep in dependsOn[rootId]) visitRoot(dep);
      restoreOrder.push(rootId);
    };
    for (const rootId of baseOrder) visitRoot(rootId);
  } else {
    addImportTimingCount(session, "restore.topologySkippedPages", 1);
  }
  const needsRootReorder = restoreOrder.length !== rootIds.length || restoreOrder.some((id, i) => id !== rootIds[i]);
  const restoredRootNodes: { [id: string]: SceneNode } = {};
  for (const rootId of restoreOrder) {
    const childCountBefore = needsRootReorder ? restoredPage.children.length : 0;
    const restored = await restoreImportedNode(rootId, restoredPage, layers, session.restoredNodes, session.totalNodes);
    if (needsRootReorder) {
      const children = restoredPage.children;
      if (children.length > childCountBefore) restoredRootNodes[rootId] = children[childCountBefore];
    }
    restoredOnPage += restored;
    session.restoredNodes += restored;
  }
  if (needsRootReorder) {
    try {
      for (let rootIndex = 0; rootIndex < rootIds.length; rootIndex++) {
        const node = restoredRootNodes[rootIds[rootIndex]];
        if (node && !node.removed && node.parent === restoredPage && restoredPage.children[rootIndex] !== node) {
          restoredPage.insertChild(rootIndex, node);
        }
      }
    } catch (error) {
      console.warn("Unable to reorder page roots after component-first restore:", error);
    }
  }
  if (restoredOnPage !== pageNodeCount) throw new Error(`页面还原数量不一致：expected=${pageNodeCount}, actual=${restoredOnPage}`);
  addImportTiming(session, "restore.nodesMs", Date.now() - nodeRestoreStartedAt);
  addImportTimingCount(session, "restore.pageCount", 1);
  // Same-root use-before-definition: every component on the page exists now,
  // so shells that fell back can be swapped for real instances. Runs BEFORE
  // applyDeferredLayoutRestores so layout registrations from the swap are
  // consumed by the pass below.
  const relinkStartedAt = Date.now();
  await retryDeferredInstanceRelinks(layers);
  addImportTiming(session, "restore.deferredRelinkMs", Date.now() - relinkStartedAt);
  // Register mask-fill shells after relinks so swapped instances contribute
  // their final node ids. Only the discovery-pass candidates are visited:
  // plain pages no longer pay a second full record scan per restore.
  for (const id of maskFillExplicitIds) {
    const maskNode = session.restoredNodeById[id];
    if (maskNode && !maskNode.removed) session.maskFillExplicitNodeIds[maskNode.id] = true;
  }
  for (const id of maskFillSuppressedIds) {
    const maskNode = session.restoredNodeById[id];
    if (maskNode && !maskNode.removed) session.maskFillSuppressedNodeIds[maskNode.id] = true;
  }

  await reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 0, 0, 1);
  const layoutStartedAt = Date.now();
  await applyDeferredLayoutRestores((done, total) => {
    return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 0, done, total);
  });
  addImportTiming(session, "postprocess.deferredLayoutMs", Date.now() - layoutStartedAt);
  flushInstanceChildLayoutOverrides(false);
  const cleanupStartedAt = Date.now();
  await cleanupImportedContainerShells(restoredPage, (done, total) => {
    return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 1, done, total);
  }, state.shellPlaceholderCandidates);
  state.shellPlaceholderCandidates = [];
  addImportTiming(session, "postprocess.cleanupShellsMs", Date.now() - cleanupStartedAt);
  const autoSpaceStartedAt = Date.now();
  await applyDeferredSingleChildAutoSpaceAlignmentFixes((done, total) => {
    return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 2, done, total);
  });
  addImportTiming(session, "postprocess.singleChildAutoSpaceMs", Date.now() - autoSpaceStartedAt);
  session.postProcessedNodes = Math.min(session.totalNodes, postprocessStart + pageNodeCount);
  await reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, PAGE_POSTPROCESS_STAGE_COUNT - 1, 1, 1);
  // Both maps are strictly page-scoped: every reader (group-offset
  // normalization, vector layout-box checks, deferred layout passes,
  // component-set finalize, SPACE_BETWEEN fixes) runs within this page's
  // restore/postprocess, and Figma node ids never repeat across pages. The
  // session-finalize steps (connectors/fonts) only use restoredNodeIdBySourceId.
  // Releasing them per page keeps multi-page imports from pinning every
  // page's parsed layout objects until the session ends.
  state.restoredLayoutByNodeId = {};
  state.nativeGroupOffsetByNodeId = {};
  await yieldToEventLoop();
  throwIfImportAborted(session);
}

function countLayerRecords(layers: { [id: string]: ImportLayerRecord }): number {
  return layers && typeof layers === "object" ? Object.keys(layers).length : 0;
}

async function reportPagePostprocessProgress(
  session: ImportSession,
  pageIndex: number,
  pagePostprocessStart: number,
  pageNodeCount: number,
  stageIndex: number,
  done: number,
  total: number
) {
  throwIfImportAborted(session);
  const stageRatio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 1;
  const completedRatio = Math.max(0, Math.min(1, (stageIndex + stageRatio) / PAGE_POSTPROCESS_STAGE_COUNT));
  const postprocessCurrent = Math.min(session.totalNodes, pagePostprocessStart + pageNodeCount * completedRatio);
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "postprocess",
    pageIndex,
    ...pageProgressContext(session),
    current: session.restoredNodes,
    total: session.totalNodes,
    postprocessCurrent,
    postprocessTotal: session.totalNodes
  });
}

async function completeImportSession(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  const session = activeImportSession;
  if (message.clientTimings) session.clientTimings = message.clientTimings;
  try {
    if (session.restoredPages.length !== session.totalPages) {
      throw new Error(`会话页面数量不一致：expected=${session.totalPages}, actual=${session.restoredPages.length}`);
    }
    if (session.restoredNodes !== session.totalNodes) {
      throw new Error(`会话图层数量不一致：expected=${session.totalNodes}, actual=${session.restoredNodes}`);
    }
    const finalRelinkStartedAt = Date.now();
    await retryDeferredInstanceRelinks({}, true);
    addImportTiming(session, "finalize.deferredInstancesMs", Date.now() - finalRelinkStartedAt);
    // A promised component may be unavailable/cyclic or reject createInstance.
    // Only then materialize its deferred editable subtree, once.
    const finalLayoutStartedAt = Date.now();
    await applyDeferredLayoutRestores();
    addImportTiming(session, "finalize.deferredLayoutMs", Date.now() - finalLayoutStartedAt);
    const finalCleanupStartedAt = Date.now();
    for (const page of session.restoredPages) {
      await cleanupImportedContainerShells(page, undefined, state.shellPlaceholderCandidates);
    }
    state.shellPlaceholderCandidates = [];
    addImportTiming(session, "finalize.cleanupShellsMs", Date.now() - finalCleanupStartedAt);
    const finalAutoSpaceStartedAt = Date.now();
    await applyDeferredSingleChildAutoSpaceAlignmentFixes();
    addImportTiming(session, "finalize.singleChildAutoSpaceMs", Date.now() - finalAutoSpaceStartedAt);
    postFinalizeProgress(session, 0, 4);
    const connectorStartedAt = Date.now();
    await applyDeferredConnectorRestores();
    addImportTiming(session, "finalize.connectorsMs", Date.now() - connectorStartedAt);
    postFinalizeProgress(session, 1, 4);
    const missingFontStartedAt = Date.now();
    const missingFontRestoreResult = await restoreMissingFontTextLayers(session.restoredPages, state.missingFontTextCandidates);
    addImportTiming(session, "finalize.missingFontsMs", Date.now() - missingFontStartedAt);
    postFinalizeProgress(session, 2, 4);

    // Re-assert instance-sublayer auto-layout overrides now that every page's
    // deferred layout has settled (see flushInstanceChildLayoutOverrides), give
    // filled mask layers back their paint. Dependency masters stay in the
    // document so their instances remain editable and linked.
    flushInstanceChildLayoutOverrides(true);
    paintFilledMaskTwins(session);

    const viewportStartedAt = Date.now();
    if (session.designPages.length > 0) {
      await figma.setCurrentPageAsync(session.designPages[0]);
      const children = session.designPages[0].children as SceneNode[];
      if (children.length > 0) figma.viewport.scrollAndZoomIntoView(children);
    }
    addImportTiming(session, "finalize.viewportMs", Date.now() - viewportStartedAt);
    postFinalizeProgress(session, 4, 4);

    const unresolvedInstanceDetails = collectUnresolvedInstanceDetails(session);
    figma.ui.postMessage({
      type: "complete",
      transferId: session.transferId,
      pageCount: session.designPages.length,
      dependencyPageCount: session.dependencyPages.length,
      dependencyComponentCount: countDependencyComponents(session.dependencyPages),
      layerCount: session.restoredNodes,
      unresolvedInstanceCount: unresolvedInstanceDetails.length,
      unresolvedInstanceDetails,
      textChildContainerDetails: session.textChildContainerDetails,
      missingImageAssetCount: state.missingImageAssetCount,
      fallbackConnectorCount: state.fallbackConnectorCount,
      restoredMissingFontTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
      failedMissingFontTextNodeCount: missingFontRestoreResult.failedTextNodeCount,
      performanceReport: buildImportPerformanceReport(session)
    });

    logMissingImportDiagnostics(missingFontRestoreResult);
    state.logRestorePerformanceSummary(session.restoredNodes, session.restoredPages.length);
    logImportPerformanceSummary(session, missingFontRestoreResult);
    figma.notify(unresolvedInstanceDetails.length > 0
      ? `迁移完成，${unresolvedInstanceDetails.length} 个实例已还原为普通图层，请查看迁移报告。`
      : "Restore complete!");
  } catch (error) {
    const retainedImport = await retainImportSession(session);
    console.error("Import failed:", error);
    figma.ui.postMessage({
      type: "error",
      transferId: session.transferId,
      retainedImport,
      message: error instanceof Error ? error.message : "导入失败，请查看控制台"
    });
  } finally {
    releaseImportSession(session);
  }
}

function postFinalizeProgress(session: ImportSession, current: number, total: number) {
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "finalize",
    current,
    total,
    finalizeCurrent: current,
    finalizeTotal: total
  });
}

function addImportTiming(session: ImportSession | null, phase: string, ms: number) {
  if (!session || !Number.isFinite(ms)) return;
  session.timings[phase] = (session.timings[phase] || 0) + Math.max(0, Math.round(ms));
  session.timingCounts[phase] = (session.timingCounts[phase] || 0) + 1;
}

function addImportTimingCount(session: ImportSession | null, phase: string, count: number) {
  if (!session || !Number.isFinite(count)) return;
  session.timingCounts[phase] = (session.timingCounts[phase] || 0) + Math.max(0, Math.round(count));
}

function recordClientTiming(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  activeImportSession.clientTimings = message.clientTimings || activeImportSession.clientTimings;
}

function logImportPerformanceSummary(session: ImportSession, missingFontRestoreResult: any) {
  const durationMs = Math.max(Date.now() - (state.activeRestoreStats?.startedAt || Date.now()), 1);
  const nodesPerSecond = Math.round((session.restoredNodes / durationMs) * 10000) / 10;
  const summary = {
    transferId: session.transferId,
    durationMs,
    nodesPerSecond,
    totalNodes: session.totalNodes,
    restoredNodes: session.restoredNodes,
    pageCount: session.designPages.length,
    dependencyPageCount: session.dependencyPages.length,
    dependencyComponentCount: countDependencyComponents(session.dependencyPages),
    unresolvedInstanceDetails: collectUnresolvedInstanceDetails(session),
    timingsMs: session.timings,
    timingCounts: session.timingCounts,
    clientTimings: session.clientTimings,
    restoreStats: state.activeRestoreStats,
    missingFonts: missingFontRestoreResult,
    missingImageAssetCount: state.missingImageAssetCount,
    fallbackConnectorCount: state.fallbackConnectorCount,
    booleanFallbackCount: state.booleanFallbackCount
  };
  console.log("[MasterGo2Figma] Import performance detail", summary);
  console.log("[MasterGo2Figma] Import performance detail JSON " + JSON.stringify(summary));
}

function getTargetDocumentInfo() {
  let targetDocumentName: string | null = null;
  let targetFileKey: string | null = null;
  try { if (typeof figma.root.name === "string") targetDocumentName = figma.root.name; } catch (_) { /* unavailable */ }
  try { if (typeof figma.fileKey === "string") targetFileKey = figma.fileKey; } catch (_) { /* unavailable */ }
  return { targetDocumentName, targetFileKey };
}

function buildImportPerformanceReport(session: ImportSession) {
  const stats = state.activeRestoreStats;
  return {
    schemaVersion: 1,
    receiverVersion: RECEIVER_VERSION,
    mainMs: Math.max(0, Date.now() - (stats?.startedAt || Date.now())),
    sourceRecordCount: session.restoredNodes,
    textChildContainerDetails: session.textChildContainerDetails,
    apiCreationCount: stats?.apiCreationCount || 0,
    creationCountMeaning: "successful direct node factory calls; SVG/instance implicit descendants are not separate API calls",
    stagesMs: { ...session.timings },
    stageCounts: { ...session.timingCounts },
    restoreStats: stats ? { ...stats, restoredNodes: session.restoredNodes,
      pageCount: session.restoredPages.length, creationCounts: { ...stats.creationCounts } } : null,
    clientTimings: session.clientTimings,
    sourceDocumentName: session.manifest.documentName || null,
    ...getTargetDocumentInfo()
  };
}

async function abortImportSession(message: any, cancelledSession: ImportSession | null = null) {
  const session = activeImportSession;
  const previous = lastRetainedImport && lastRetainedImport.transferId === message.transferId ? lastRetainedImport.summary : undefined;
  if (previous && (!session || session.transferId !== message.transferId)) {
    // A late UI abort is idempotent and cannot touch a newer import session.
    figma.ui.postMessage({ type: "import-ack", requestId: message.requestId,
      transferId: message.transferId, success: true, retainedImport: previous });
    return;
  }
  if (!session || session.transferId !== message.transferId) {
    figma.ui.postMessage({ type: "import-ack", requestId: message.requestId,
      transferId: message.transferId, success: false, error: "导入会话不存在或已重置" });
    return;
  }
  if (cancelledSession && cancelledSession !== session) return;
  const retainedImport = await retainImportSession(session);
  releaseImportSession(session);
  figma.ui.postMessage({ type: "import-ack", requestId: message.requestId,
    transferId: message.transferId, success: true, retainedImport });
}

function requireImportSession(transferId: string): ImportSession {
  if (!activeImportSession || activeImportSession.transferId !== transferId) {
    throw new Error("导入会话不存在或已重置");
  }
  throwIfImportAborted(activeImportSession);
  return activeImportSession;
}

function throwIfImportAborted(session: ImportSession | null = activeImportSession) {
  if (session?.abortReason) throw new Error(`导入已取消：${session.abortReason}`);
}

function pageProgressContext(session: ImportSession | null) {
  return { ...(session?.activePageRequest || {}), receiverVersion: RECEIVER_VERSION };
}

function concatBytes(chunks: Uint8Array[], expectedSize: number): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (expectedSize > 0 && size !== expectedSize) {
    throw new Error(`图片资源传输不完整：expected=${expectedSize}, actual=${size}`);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function clearPendingImportAssets() {
  for (const path in pendingImportAssets) delete pendingImportAssets[path];
}

function clearPendingImportPages() {
  for (const pageIndex in pendingImportPages) delete pendingImportPages[pageIndex];
}

function releaseImportSession(session: ImportSession) {
  if (activeImportSession !== session) return;
  state.importInProgress = false;
  setMutationObserver(null);
  activeImportSession = null;
  clearPendingImportAssets();
  clearPendingImportPages();
  pendingInstanceLayoutOverrides.length = 0;
  instanceLayoutPageCursor = 0;
  session.deferredInstanceRelinks = {};
}

async function retainImportSession(session: ImportSession): Promise<RetainedImportSummary> {
  const cleanupWarnings = session.retentionWarnings;
  const aborted = session.abortReason;
  session.abortReason = undefined;
  session.retainingFailedImport = true;
  // A completed early page can still have light instance shells awaiting a
  // master on a later page. Materialize their original records before releasing
  // them; a failed child must never remove the siblings already restored.
  const deferred: DeferredInstanceRelink[] = [];
  for (const key of Object.keys(session.deferredInstanceRelinks)) deferred.push(...session.deferredInstanceRelinks[key]);
  session.deferredInstanceRelinks = {};
  for (const entry of deferred) {
    try { await materializeDeferredFallback(session, entry); }
    catch (_) { /* Materialization recorded its failure and partial page; retain other entries. */ }
    finally { settleDeferredOwner(session, entry); }
  }
  try { await applyDeferredLayoutRestores(); }
  catch (error) { cleanupWarnings.push(`布局收尾：${error instanceof Error ? error.message : String(error)}`); }
  session.abortReason = aborted;
  const pages: RetainedImportSummary["pages"] = session.manifest.pages.map((source, index) => {
    const progress = session.pageStates[index];
    const page = progress?.page && !progress.page.removed ? progress.page : null;
    return { sourcePageId: source.id, sourcePageName: source.name,
      targetPageId: page?.id || null, targetPageName: page?.name || null,
      status: !page ? "pending" : progress.completed ? "completed" : "partial",
      sourceRecordCount: Number(source.layerCount) || 0 };
  });
  const completed = pages.filter(page => page.status === "completed");
  const partial = pages.filter(page => page.status === "partial");
  const summary: RetainedImportSummary = {
    status: completed.length + partial.length > 0 ? "partial" : "failed", pages,
    completedPageCount: completed.length, partialPageCount: partial.length,
    pendingPageCount: pages.length - completed.length - partial.length,
    retainedPageCount: completed.length + partial.length,
    completedSourceRecordCount: completed.reduce((sum, page) => sum + page.sourceRecordCount, 0),
    reportedRestoredRecordCount: session.restoredNodes, totalSourceRecordCount: session.totalNodes, cleanupWarnings
  };
  lastRetainedImport = { transferId: session.transferId, summary };
  const target = session.designPages.find(page => !page.removed) || session.restoredPages.find(page => !page.removed) || session.previousCurrentPage;
  try { if (target && !target.removed) await figma.setCurrentPageAsync(target); }
  catch (error) { cleanupWarnings.push(`页面定位：${error instanceof Error ? error.message : String(error)}`); }
  const report = { ...buildImportPerformanceReport(session), sourceRecordCount: session.totalNodes, retainedImport: summary };
  await saveImportReport(figma.clientStorage, { schemaVersion: 1, sourceName: session.manifest.documentName || "未知源文件",
    completedAt: new Date().toISOString(), target: { documentName: report.targetDocumentName, fileKey: report.targetFileKey }, performanceReport: report });
  return summary;
}

function recordStreamedMissingImage(assetName: string) {
  if (state.missingImageAssetNames[assetName]) return;
  state.missingImageAssetNames[assetName] = true;
  state.missingImageAssetCount++;
}

async function postInitUI() {
  await ensureLayerRulesLoaded();
  let settings: any = null;
  try {
    settings = await figma.clientStorage.getAsync(UI_SETTINGS_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
  figma.ui.postMessage({
    type: "init",
    rules: getLayerRuleStatus(),
    settings,
    receiverVersion: RECEIVER_VERSION,
    lastImportReport: await readImportReport(figma.clientStorage),
    ...getTargetDocumentInfo()
  });
}

function normalizeBytes(value: any): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value.length === "number") return new Uint8Array(value);
  if (typeof value === "object") {
    const keys = Object.keys(value).filter(key => /^\d+$/.test(key));
    if (keys.length > 0) {
      const bytes = new Uint8Array(keys.length);
      keys.sort((a, b) => Number(a) - Number(b));
      for (let index = 0; index < keys.length; index++) {
        bytes[index] = Number(value[keys[index]]) || 0;
      }
      return bytes;
    }
  }
  return null;
}

function createRestoredPageName(name: string): string {
  // Figma percent-encodes an ASCII slash in PageNode names as "%2F".
  // Use the visually equivalent division slash only for page names so the
  // source hierarchy remains readable without changing layer names or paths.
  return (name || "Imported Page").replace(/\//g, "∕");
}

async function maybeReportRestoreProgress(current: number, total: number, force = false) {
  throwIfImportAborted();
  const now = Date.now();
  const progState = state.activeProgressState || {
    total,
    lastCurrent: 0,
    lastPostedAt: 0,
    lastYieldAt: now
  };
  current = Math.min(current, total);
  const shouldPost = force ||
    (current >= total && progState.lastCurrent < total) ||
    current - progState.lastCurrent >= RESTORE_PROGRESS_NODE_INTERVAL ||
    now - progState.lastPostedAt >= RESTORE_PROGRESS_TIME_INTERVAL_MS;

  if (shouldPost) {
    figma.ui.postMessage({
      type: "progress",
      transferId: activeImportSession ? activeImportSession.transferId : undefined,
      ...pageProgressContext(activeImportSession),
      stage: "restore", current, total
    });
    progState.total = total;
    progState.lastCurrent = current;
    progState.lastPostedAt = now;
  }
  state.activeProgressState = progState;
  if (force || now - (progState.lastYieldAt ?? now) >= RESTORE_BATCH_BUDGET_MS) {
    await yieldToEventLoop();
    throwIfImportAborted();
    progState.lastYieldAt = Date.now();
    if (state.activeRestoreStats) state.activeRestoreStats.restoreBatchYieldCount++;
  }
}

function logMissingImportDiagnostics(missingFontRestoreResult: MissingFontTextRestoreResult) {
  logMissingFontRefreshDiagnostics(missingFontRestoreResult);

  const missingImageNames = Object.keys(state.missingImageAssetNames).sort();
  if (missingImageNames.length > 0) {
    console.warn("[MasterGo2Figma] 缺失图片资源（去重）", missingImageNames);
  }

  if (state.missingImageAssetDetails.length > 0) {
    console.warn("[MasterGo2Figma] 缺失图片影响图层", state.missingImageAssetDetails.map(detail => ({
      assetName: detail.assetName,
      layerName: detail.nodeName,
      layerPath: detail.layerPath,
      nodeId: detail.nodeId,
      nodeType: detail.nodeType,
      paintTarget: detail.paintTarget,
      x: detail.x,
      y: detail.y,
      width: detail.width,
      height: detail.height
    })));
  } else if (missingImageNames.length > 0) {
    console.warn("[MasterGo2Figma] 缺失图片影响图层未能定位；资源可能在传输阶段创建失败。");
  }
}

function logMissingFontRefreshDiagnostics(missingFontRestoreResult: MissingFontTextRestoreResult) {
  if (missingFontRestoreResult.missingFonts.length > 0) {
    console.warn("[MasterGo2Figma] 缺失字体（去重）", missingFontRestoreResult.missingFonts.map(font => ({
      family: font.family,
      style: font.style,
      textNodeCount: font.count
    })));
    return;
  }
  console.info("[MasterGo2Figma] 缺失字体（去重）", []);
}

function applyManifestLayoutToProps(props: any, _meta: ImportLayerRecord): any {
  return props;
}

function isConnectorRestoreData(data: any): boolean {
  return !!data && (data.sourceType === "CONNECTOR" || data.type === "CONNECTOR" || data.restoreType === "CONNECTOR");
}

function prepareConnectorPolylineFallbackProps(data: any, parent: PageNode | SceneNode, layers: { [id: string]: ImportLayerRecord }): any {
  if (!isConnectorRestoreData(data)) return data;

  const props = { ...data };
  props.connectorFallbackPolyline = true;
  // Route through the gap between attached nodes, not the midpoint between
  // ports (which can run through the wider source or destination node).
  for (const key of ["connectorStart", "connectorEnd"]) {
    const endpoint = props[key];
    const layout = layers[endpoint?.endpointNodeId]?.props?.layout;
    const transform = layout?.relativeTransform;
    if (layout && (!transform || (transform[0][0] === 1 && transform[0][1] === 0 &&
        transform[1][0] === 0 && transform[1][1] === 1))) {
      props[key] = { ...endpoint, width: layout.width };
    }
  }
  if (!hasUsableVectorNetwork(props.vectorNetwork)) {
    props.vectorNetwork = createConnectorVectorNetworkFromData(props, parent);
  }
  return props;
}

function shouldPreserveVectorLayoutBoxForAutoLayout(data: any, parent: PageNode | SceneNode): boolean {
  if (!data || !data.vectorNetwork) return false;
  const sourceType = data.sourceType || data.type;
  if (sourceType !== "PEN" && sourceType !== "VECTOR") return false;
  if (!parent || !("id" in parent)) return false;
  const restoredParentLayout = state.restoredLayoutByNodeId[(parent as SceneNode).id];
  const parentLayoutMode = restoredParentLayout && restoredParentLayout.layoutMode;
  if (parentLayoutMode && parentLayoutMode !== "NONE") return true;
  return "layoutMode" in parent && (parent as any).layoutMode !== "NONE";
}

function markVectorAutoLayoutBox(data: any): any {
  return {
    ...data,
    vectorAutoLayoutBox: true
  };
}

async function restoreImportedNode(
  nodeId: string,
  parent: PageNode | SceneNode,
  layers: { [id: string]: ImportLayerRecord },
  restoredBefore: number,
  totalNodes: number
): Promise<number> {
  throwIfImportAborted();
  const layerRecord = layers[nodeId];
  if (!layerRecord || !layerRecord.props) {
    throw new Error(`缺少图层记录：${nodeId}`);
  }

  // Native .mg imports mark instance records with the component's record id.
  // When that component was already restored in this session, recreate a REAL
  // InstanceNode (component.createInstance) instead of a frame shell; any
  // failure falls through to the ordinary restore path below.
  if (layerRecord.mainComponentId && !layerRecord.instanceStructureFallback) {
    const instanceRestored = await tryRestoreAsInstance(layerRecord, parent, layers, restoredBefore, totalNodes);
    if (instanceRestored > 0) return instanceRestored;
  }
  const deferInstanceChildren = !!(activeImportSession && !activeImportSession.finalizingDeferredFallbacks &&
    layerRecord.mainComponentId && !layerRecord.instanceStructureFallback &&
    unavailableInstanceDependency(layerRecord, layers, activeImportSession));

  let nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
  if (shouldRestoreBooleanOperationTree(nodeProps, layerRecord)) {
    return await restoreBooleanOperationTree(
      nodeProps,
      parent,
      layerRecord,
      layers,
      restoredBefore,
      totalNodes,
      restoreImportedNode,
      applyProperties,
      maybeReportRestoreProgress
    );
  }

  if (shouldRestoreGroupNode(nodeProps)) {
    return await restoreGroupNode(
      nodeProps,
      parent,
      layerRecord,
      layers,
      restoredBefore,
      totalNodes,
      restoreImportedNode,
      applyProperties,
      maybeReportRestoreProgress
    );
  }

  if (shouldRestoreComponentSetNode(nodeProps)) {
    return await restoreComponentSetNode(
      nodeProps,
      parent,
      layerRecord,
      layers,
      restoredBefore,
      totalNodes,
      restoreImportedNode,
      applyProperties,
      maybeReportRestoreProgress
    );
  }

  if (shouldRestoreBooleanVectorAsFrame(nodeProps, layerRecord)) {
    nodeProps = createBooleanFrameFallbackProps(nodeProps);
  }
  nodeProps = prepareConnectorPolylineFallbackProps(nodeProps, parent, layers);
  if (shouldPreserveVectorLayoutBoxForAutoLayout(nodeProps, parent)) {
    nodeProps = markVectorAutoLayoutBox(nodeProps);
  }

  const createStartedAt = Date.now();
  const newNode = await createNodeFromData(nodeProps);
  addImportTiming(activeImportSession, "restore.createNodeMs", Date.now() - createStartedAt);
  if (!newNode) throw new Error(`无法创建图层：${nodeProps?.name || layerRecord.name || nodeId}`);

  const childIds = nodeProps.omitChildrenOnRestore || deferInstanceChildren ? [] : (layerRecord.childIds || []);
  let restoredNode = newNode;
  let textWrapper: FrameNode | null = null;
  try {
    const appendStartedAt = Date.now();
    // Some source snapshots retain editable vector children on a TEXT record.
    // A native Figma text cannot own them: retain both in a transparent frame,
    // rather than silently skipping the children or counting absent nodes.
    if (newNode.type === "TEXT" && childIds.length > 0) {
      textWrapper = figma.createFrame();
      state.recordNodeCreation("text-child-container");
      textWrapper.setPluginData("mastergo2figma.textChildContainer", "1");
      if (!appendRestoredNode(parent, textWrapper)) throw new Error(`无法挂载文本容器：${nodeId}`);
      await applyProperties(textWrapper, {
        id: nodeProps.id, name: nodeProps.name, layout: nodeProps.layout,
        constraints: nodeProps.constraints, scence: nodeProps.scence, blend: nodeProps.blend,
        geometry: { fills: [], strokes: [] }, clipsContent: false
      });
      textWrapper.appendChild(newNode);
      restoredNode = textWrapper;
    } else if (!appendRestoredNode(parent, newNode)) {
      throw new Error(`无法挂载图层：${nodeProps?.name || layerRecord.name || nodeId}`);
    }
    addImportTiming(activeImportSession, "restore.appendNodeMs", Date.now() - appendStartedAt);
    const applyStartedAt = Date.now();
    await applyProperties(newNode as any, textWrapper ? {
      ...nodeProps, id: undefined, constraints: undefined,
      scence: { visible: true, locked: false },
      blend: { opacity: 1, blendMode: "NORMAL", isMask: false, effects: [] },
      layout: { width: nodeProps.layout?.width, height: nodeProps.layout?.height,
        x: 0, y: 0, rotation: 0, relativeTransform: [[1, 0, 0], [0, 1, 0]] }
    } : nodeProps);
    addImportTiming(activeImportSession, "restore.applyPropertiesMs", Date.now() - applyStartedAt);
  } catch (error) {
    console.warn("Unable to restore node, removing partial node:", nodeProps?.name || layerRecord.name || nodeId, error);
    safeRemove(newNode);
    if (textWrapper) safeRemove(textWrapper);
    throw error;
  }
  if (activeImportSession) {
    activeImportSession.restoredNodeById[nodeId] = restoredNode;
    if (textWrapper) activeImportSession.textChildContainerDetails.push({
      sourceId: nodeId, name: String(nodeProps.name || layerRecord.name || nodeId),
      childCount: childIds.length, pageName: activeImportSession.activePageRequest?.pageName || ""
    });
    recordInstanceFallback(activeImportSession, layerRecord, newNode);
    // Reaching here with a mainComponentId means tryRestoreAsInstance fell
    // back (component not restored yet — same-root use-before-definition).
    // Remember the shell; retryDeferredInstanceRelinks swaps it after the
    // page finishes. Parents register before their children restore, so the
    // relink pass sees outer shells first and inner ones become no-ops.
    if (layerRecord.mainComponentId && !layerRecord.instanceStructureFallback && !activeImportSession.finalizingDeferredFallbacks) {
      queueDeferredInstance(activeImportSession, layerRecord, newNode, layers, deferInstanceChildren);
    }
  }
  if (textWrapper) {
    await applyImportedStyleBindings(newNode, { ...layerRecord, effectStyleRef: undefined });
    await applyImportedStyleBindings(textWrapper, { ...layerRecord, fillStyleRef: undefined,
      strokeStyleRef: undefined, textStyleRef: undefined, textStyleRanges: [] });
  } else {
    await applyImportedStyleBindings(newNode, layerRecord);
  }

  let restoredCount = deferInstanceChildren ? 1 + countRecordDescendants(layerRecord, layers)
    : 1 + applyConnectorTextFallback(newNode, layerRecord, layers);
  const currentCount = restoredBefore + restoredCount;
  const progressStartedAt = Date.now();
  await maybeReportRestoreProgress(currentCount, totalNodes);
  addImportTiming(activeImportSession, "restore.progressMs", Date.now() - progressStartedAt);

  if (canContainRestoredChildren(restoredNode)) {
    for (const childId of childIds) {
      restoredCount += await restoreImportedNode(childId, restoredNode, layers, restoredBefore + restoredCount, totalNodes);
    }
  }

  return restoredCount;
}

function canContainRestoredChildren(node: SceneNode): boolean {
  return !!node && "appendChild" in node;
}

// Recreate an instance record as a REAL InstanceNode when its component was
// already restored in this session. Children come from the component; the
// import records' per-child state is applied as instance OVERRIDES by
// positional matching (record childIds order == component child order — both
// derive from the same sort codes). Returns the number of records this node
// accounts for (itself + all skipped descendant records), or 0 to fall back
// to the ordinary frame-shell restore.
async function tryRestoreAsInstance(
  layerRecord: ImportLayerRecord,
  parent: PageNode | SceneNode,
  layers: { [id: string]: ImportLayerRecord },
  restoredBefore: number,
  totalNodes: number
): Promise<number> {
  const session = activeImportSession;
  if (!session || !layerRecord.mainComponentId) return 0;
  if (session.retainingFailedImport) return 0;
  if (unavailableInstanceDependency(layerRecord, layers, session)) return 0;
  const componentNode = session.restoredNodeById[layerRecord.mainComponentId];
  if (!componentNode || componentNode.removed || componentNode.type !== "COMPONENT") {
    console.warn(
      "[mg-instance] frame fallback:", layerRecord.id, layerRecord.props?.name || layerRecord.name,
      "→ component", layerRecord.mainComponentId,
      !componentNode ? "未还原(不在 restoredNodeById)" : componentNode.removed ? "已被移除" : `类型=${componentNode.type}`
    );
    return 0;
  }
  let instance: InstanceNode | null = null;
  try {
    instance = (componentNode as ComponentNode).createInstance();
    state.recordNodeCreation("instance");
    if (!appendRestoredNode(parent, instance)) throw new Error("无法挂载实例");
  } catch (error) {
    console.warn("[mg-instance] createInstance 失败,回退 Frame 壳:", layerRecord.id, layerRecord.props?.name || layerRecord.name, error);
    if (instance) safeRemove(instance);
    return 0;
  }
  // From here on the InstanceNode exists and is parented — keep it even if
  // property/override application partially fails (the component-instance
  // relationship is the point; a partially styled instance beats a frame shell).
  await applyInstanceRecordState(instance, layerRecord, layers);
  session.restoredNodeById[layerRecord.id] = instance;
  console.info("[mg-instance] restored:", layerRecord.id, layerRecord.props?.name || layerRecord.name, "→ instance of", layerRecord.mainComponentId);
  const accounted = 1 + countRecordDescendants(layerRecord, layers);
  await maybeReportRestoreProgress(restoredBefore + accounted, totalNodes);
  return accounted;
}

// Shared instance state application: MasterGo's uniform instance scale cannot
// be expressed through child geometry (instance children are locked to the
// component) — replay it with rescale() BEFORE the exact root resize in
// applyProperties, then apply per-child overrides positionally.
async function applyInstanceRecordState(
  instance: InstanceNode,
  layerRecord: ImportLayerRecord,
  layers: { [id: string]: ImportLayerRecord }
): Promise<void> {
  let rescaled = false;
  if (typeof layerRecord.instanceScale === "number" && isFinite(layerRecord.instanceScale) &&
      layerRecord.instanceScale > 0 && Math.abs(layerRecord.instanceScale - 1) > 1e-6) {
    try {
      instance.rescale(layerRecord.instanceScale);
      rescaled = true;
    } catch (error) {
      console.warn("[mg-instance] rescale 失败(继续):", layerRecord.id, layerRecord.instanceScale, error);
    }
  }
  try {
    const nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
    await applyProperties(instance as any, nodeProps);
  } catch (error) {
    console.warn("[mg-instance] applyProperties 部分失败(实例保留):", layerRecord.id, error);
  }
  await applyImportedStyleBindings(instance, layerRecord);
  try {
    await applyInstanceChildOverrides(instance, layerRecord, layers, rescaled);
  } catch (error) {
    console.warn("[mg-instance] 子覆盖应用失败(实例保留):", layerRecord.id, error);
  }
}

// After a page finishes restoring, swap frame-shell fallbacks for real
// instances. Masters on later pages keep their pending entries until a later
// page completes. Entries whose shell was already discarded
// (an outer shell got swapped first) are skipped.
function isComponentReady(session: ImportSession, id: string): boolean {
  const node = session.restoredNodeById[id];
  return !!node && !node.removed && node.type === "COMPONENT" && !session.pendingComponentWork[id];
}

function captureInstanceRecords(record: ImportLayerRecord, layers: { [id: string]: ImportLayerRecord }) {
  const subtree: { [id: string]: ImportLayerRecord } = {};
  const stack = [record.id];
  while (stack.length) {
    const id = stack.pop() as string;
    if (subtree[id] || !layers[id]) continue;
    subtree[id] = layers[id];
    stack.push(...(layers[id].childIds || []));
  }
  return subtree;
}

function unavailableInstanceDependency(record: ImportLayerRecord, layers: { [id: string]: ImportLayerRecord }, session: ImportSession): string | null {
  const stack = [record.id];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = layers[id];
    if (!item) continue;
    const target = item.instanceStructureFallback ? null : item.mainComponentId;
    // Only defer definitions promised by the actual selected source. A genuinely
    // missing definition keeps the ordinary, editable structural fallback.
    if (target && session.knownComponentIds.has(target) && !isComponentReady(session, target)) return target;
    stack.push(...(item.childIds || []));
  }
  return null;
}

function queueDeferredInstance(session: ImportSession, record: ImportLayerRecord, node: SceneNode,
  layers: { [id: string]: ImportLayerRecord }, lightweight: boolean) {
  const subtree = captureInstanceRecords(record, layers);
  const dependencies: string[] = Array.from(new Set<string>(Object.keys(subtree).map(id => subtree[id])
    .filter(item => !item.instanceStructureFallback && item.mainComponentId)
    .map(item => item.mainComponentId as string)));
  let ownerComponentId: string | null = null;
  let ancestorId = record.parentId;
  const seen = new Set<string>();
  while (ancestorId && !seen.has(ancestorId)) {
    seen.add(ancestorId);
    const ancestor = layers[ancestorId];
    if (!ancestor) break;
    if (ancestor.props?.type === "COMPONENT") { ownerComponentId = ancestor.id; break; }
    ancestorId = ancestor.parentId;
  }
  const entry: DeferredInstanceRelink = { id: record.id, node, layers: subtree, lightweight, dependencies, ownerComponentId };
  if (ownerComponentId) session.pendingComponentWork[ownerComponentId] = (session.pendingComponentWork[ownerComponentId] || 0) + 1;
  const key = dependencies.find(id => !isComponentReady(session, id)) || record.mainComponentId as string;
  (session.deferredInstanceRelinks[key] ||= []).push(entry);
}

function settleDeferredOwner(session: ImportSession, entry: DeferredInstanceRelink) {
  if (entry.ownerComponentId) {
    session.pendingComponentWork[entry.ownerComponentId] = Math.max(0, (session.pendingComponentWork[entry.ownerComponentId] || 0) - 1);
  }
}

async function materializeDeferredFallback(session: ImportSession, entry: DeferredInstanceRelink) {
  if (!entry.lightweight || entry.node.removed) return;
  session.finalizingDeferredFallbacks = true;
  try {
    const record = entry.layers[entry.id];
    // The empty shell already completed its page's layout pass. Re-register
    // its source layout before adding children so final sizing and single-child
    // spacing use the populated container, including layouts cleared per page.
    const layout = applyManifestLayoutToProps(record.props, record).layout;
    if (layout) {
      state.restoredLayoutByNodeId[entry.node.id] = layout;
      deferLayoutRestore(entry.node, layout, false);
    }
    for (const childId of record.childIds || []) {
      await restoreImportedNode(childId, entry.node, entry.layers, session.restoredNodes, session.totalNodes);
    }
    // These records did not have native nodes when their page registered mask
    // semantics. Preserve the source render bit for late editable fallbacks.
    for (const id of Object.keys(entry.layers)) {
      const node = session.restoredNodeById[id];
      if (!node || node.removed) continue;
      if (entry.layers[id].maskRendersFill === false) session.maskFillSuppressedNodeIds[node.id] = true;
      if (entry.layers[id].maskRendersFill === true) session.maskFillExplicitNodeIds[node.id] = true;
    }
  } catch (error) {
    session.retentionWarnings.push(`${entry.id}：${error instanceof Error ? error.message : String(error)}`);
    let page: BaseNode | null = entry.node;
    while (page && page.type !== "PAGE") page = page.parent;
    for (const progress of session.pageStates) if (progress?.page === page) progress.completed = false;
    throw error;
  } finally {
    session.finalizingDeferredFallbacks = false;
    entry.lightweight = false;
  }
}

async function retryDeferredInstanceRelinks(_layers: { [id: string]: ImportLayerRecord }, final = false): Promise<void> {
  const session = activeImportSession;
  if (!session) return;
  const failed = new Set<DeferredInstanceRelink>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of Object.keys(session.deferredInstanceRelinks)) {
      if (!isComponentReady(session, key)) continue;
      const pending = session.deferredInstanceRelinks[key];
      delete session.deferredInstanceRelinks[key];
      for (const entry of pending) {
        const record = entry.layers[entry.id];
        const shell = entry.node;
        if (!record || shell.removed || !shell.parent) { settleDeferredOwner(session, entry); changed = true; continue; }
        const waitingFor = entry.dependencies.find(id => !isComponentReady(session, id));
        if (waitingFor || failed.has(entry)) {
          (session.deferredInstanceRelinks[waitingFor || key] ||= []).push(entry);
          continue;
        }
        const parent = shell.parent as PageNode | SceneNode;
        const component = session.restoredNodeById[record.mainComponentId as string] as ComponentNode;
        let instance: InstanceNode | null = null;
        try {
          const index = (parent as ChildrenMixin).children.indexOf(shell);
          instance = component.createInstance();
          state.recordNodeCreation("instance");
          (parent as any).insertChild(Math.max(0, index), instance);
        } catch (error) {
          if (instance) safeRemove(instance);
          const fallback = session.instanceFallbacks[record.id];
          if (fallback) fallback.detail.reason = "instance-creation-failed";
          failed.add(entry);
          (session.deferredInstanceRelinks[key] ||= []).push(entry);
          continue;
        }
        await applyInstanceRecordState(instance, record, entry.layers);
        session.restoredNodeById[record.id] = instance;
        safeRemove(shell);
        settleDeferredOwner(session, entry);
        changed = true;
      }
    }
    if (final && !changed) {
      const key = Object.keys(session.deferredInstanceRelinks)[0];
      if (key !== undefined) {
        const entry = session.deferredInstanceRelinks[key].shift() as DeferredInstanceRelink;
        if (!session.deferredInstanceRelinks[key].length) delete session.deferredInstanceRelinks[key];
        await materializeDeferredFallback(session, entry);
        settleDeferredOwner(session, entry);
        changed = true;
      }
    }
  }
}

function countRecordDescendants(record: ImportLayerRecord, layers: { [id: string]: ImportLayerRecord }): number {
  let count = 0;
  const seen: { [id: string]: true } = {};
  const stack = [...(record.childIds || [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen[id]) continue;
    seen[id] = true;
    const child = layers[id];
    if (!child) continue;
    count++;
    for (const grandChild of child.childIds || []) stack.push(grandChild);
  }
  return count;
}

function recordInstanceFallback(session: ImportSession, record: ImportLayerRecord, node: SceneNode): void {
  if (!record.mainComponentId && !record.missingMainComponentId &&
      record.props?.sourceType !== "INSTANCE" && record.props?.type !== "INSTANCE") return;
  const target = record.mainComponentId ? session.restoredNodeById[record.mainComponentId] : null;
  let reason: UnresolvedInstanceDetail["reason"] = "component-unavailable";
  if (record.missingMainComponentId || !record.mainComponentId) reason = "missing-component";
  else if (record.instanceStructureFallback) reason = "structure-fallback";
  else if (target && !target.removed && target.type === "COMPONENT") reason = "instance-creation-failed";
  session.instanceFallbacks[record.id] = {
    node,
    detail: {
      sourceId: record.id,
      name: record.name || record.props?.name || record.id,
      mainComponentId: record.mainComponentId || record.missingMainComponentId || null,
      reason
    }
  };
}

function collectUnresolvedInstanceDetails(session: ImportSession): UnresolvedInstanceDetail[] {
  return Object.keys(session.instanceFallbacks)
    .map(id => session.instanceFallbacks[id])
    .filter(entry => !entry.node.removed && entry.node.type !== "INSTANCE")
    .map(entry => entry.detail);
}

function countDependencyComponents(pages: PageNode[]): number {
  let count = 0;
  for (const page of pages) {
    const stack = [...page.children];
    while (stack.length > 0) {
      const node = stack.pop() as SceneNode;
      if (node.removed) continue;
      if (node.type === "COMPONENT") count++;
      if (node.type !== "INSTANCE" && "children" in node) stack.push(...node.children);
    }
  }
  return count;
}

// MasterGo PAINTS a mask layer's own fill; a Figma mask only contributes alpha,
// so a filled mask — the gradient circle sitting behind the tab-bar logo — just
// disappears on import (both the .mg and the zip carry `isMask: true`, so this
// is a renderer-semantics gap, not a decode gap). Reproduce the MasterGo render
// by inserting a plain, non-mask twin directly BELOW each filled mask: the mask
// still clips the siblings above it, the twin supplies the paint.
//
// Runs at session finalize so it happens after every instance has been created
// and positionally override-matched — adding the twin to a COMPONENT then
// propagates into its instances on its own.
function paintFilledMaskTwins(session: ImportSession): number {
  let added = 0;
  const hasVisiblePaint = (paints: any): boolean =>
    Array.isArray(paints) && paints.some((paint: any) =>
      paint && paint.visible !== false && (paint.opacity === undefined || paint.opacity > 0));

  const visit = (node: SceneNode) => {
    // Instance children are locked; their component already got the twin.
    if (node.type === "INSTANCE") return;
    if ("children" in node) for (const child of [...(node as ChildrenMixin).children]) visit(child);
    const nodeAny = node as any;
    if (nodeAny.isMask !== true) return;
    // Native .mg records carry the render bit (legacy `1e 01`, or the
    // newer paired `2f 01 36 01` spelling decoded into maskRendersFill);
    // a mask without it is shape-only — MasterGo never draws its fill (临时测试
    // 橙卡: the twin painted a #FFB283 base the design doesn't have).
    if (session.maskFillSuppressedNodeIds[node.id]) return;
    if (!hasVisiblePaint(nodeAny.fills) && !hasVisiblePaint(nodeAny.strokes)) return;
    if (isDefaultMaskFill(nodeAny.fills) && !hasVisiblePaint(nodeAny.strokes)) return;
    const parent = node.parent;
    if (!parent || !("insertChild" in parent)) return;
    if (!session.maskFillExplicitNodeIds[node.id] && isGradientCoverageMask(nodeAny.fills, nodeAny.strokes,
        [...parent.children].slice(parent.children.indexOf(node) + 1))) return;
    if (!session.maskFillExplicitNodeIds[node.id] &&
        isBackdropCoverageMask(nodeAny.fills, nodeAny.strokes, (parent as any).effects)) return;
    try {
      const twin = (node as any).clone() as SceneNode;
      state.recordNodeCreation("clone");
      (twin as any).isMask = false;
      const index = parent.children.indexOf(node);
      parent.insertChild(index >= 0 ? index : 0, twin);
      // clone() parents the copy under figma.currentPage and insertChild
      // re-interprets its x/y against the new parent — and inserting into a
      // GROUP re-normalizes every sibling's coordinates on top of that. Re-anchor
      // the twin onto the mask AFTER insertion, when the two finally share a
      // parent and a coordinate space (0806 tab bar: the circle otherwise lands
      // 14px left of the mask it duplicates).
      (twin as any).relativeTransform = (node as any).relativeTransform;
      if (Math.abs(twin.x - node.x) > 0.01 || Math.abs(twin.y - node.y) > 0.01) {
        console.warn("[mg-mask] twin did not land on its mask:", node.name,
          `twin=(${twin.x},${twin.y}) mask=(${node.x},${node.y})`);
      }
      added++;
    } catch (error) {
      console.warn("Unable to paint filled mask:", node.name, error);
    }
  };

  for (const page of session.restoredPages) for (const child of [...page.children]) visit(child);
  if (added > 0) console.info("[mg-mask] painted filled masks:", added);
  return added;
}

// Positional override application: walk the instance's real children next to
// the record tree; on any structural drift (count mismatch) skip that subtree
// — the component state is still a faithful base. Only override-safe
// properties are touched, each guarded individually.
async function applyInstanceChildOverrides(
  instance: InstanceNode,
  record: ImportLayerRecord,
  layers: { [id: string]: ImportLayerRecord },
  rescaled: boolean
): Promise<void> {
  const pairs: Array<{ node: SceneNode; rec: ImportLayerRecord }> = [];
  const collect = async (node: SceneNode, rec: ImportLayerRecord): Promise<void> => {
    // The root was just created from its known component. Nested instances may
    // have instance-swap overrides and still need their actual master checked.
    if (node !== instance && node.type === "INSTANCE" && rec.mainComponentId) {
      const target = activeImportSession?.restoredNodeById[rec.mainComponentId];
      if (target && target.type === "COMPONENT") {
        const current = await node.getMainComponentAsync();
        if (current?.id !== target.id) node.swapComponent(target);
      }
    }
    if (!("children" in node)) return;
    const childIds = rec.childIds || [];
    let children = (node as ChildrenMixin & SceneNode).children;
    if (node.type === "FRAME" && rec.props?.type === "TEXT" && children[0]?.type === "TEXT" &&
        node.getPluginData("mastergo2figma.textChildContainer") === "1") {
      // The compatibility wrapper is an implementation child, not a source
      // child. Keep text paint/typography off that transparent frame and match
      // the source vector records against the remaining inherited children.
      const wrapperPair = pairs[pairs.length - 1];
      if (wrapperPair?.node === node) wrapperPair.rec = { ...rec,
        props: { ...rec.props, geometry: undefined }, fillStyleRef: undefined,
        strokeStyleRef: undefined, textStyleRef: undefined, textStyleRanges: [] };
      pairs.push({ node: children[0], rec: { ...rec, effectStyleRef: undefined, childIds: [], props: {
        ...rec.props, id: undefined, constraints: undefined, scence: { visible: true, locked: false },
        blend: { opacity: 1, blendMode: "NORMAL", isMask: false, effects: [] },
        layout: { width: rec.props.layout?.width, height: rec.props.layout?.height,
          x: 0, y: 0, rotation: 0, relativeTransform: [[1, 0, 0], [0, 1, 0]] }
      } } });
      children = children.slice(1);
    }
    if (childIds.length !== children.length) {
      // Structural overrides can leave inherited text unmatched. Restrict the
      // compatibility scan to this exceptional subtree, not every imported page.
      const candidates = (node as any).findAllWithCriteria
        ? (node as any).findAllWithCriteria({ types: ["TEXT"] })
        : (node as any).findAll?.((child: SceneNode) => child.type === "TEXT") || [];
      for (const text of candidates) registerMissingFontTextCandidate(text);
      return;
    }
    for (let i = 0; i < childIds.length; i++) {
      const childRec = layers[childIds[i]];
      if (!childRec || !childRec.props) continue;
      pairs.push({ node: children[i], rec: childRec });
      await collect(children[i], childRec);
    }
  };
  await collect(instance, record);
  for (const { node, rec } of pairs) {
    const props = rec.props;
    if (node.type === "ELLIPSE" && props.arcData) {
      try { node.arcData = props.arcData; } catch (error) { console.warn("[mg-instance] arc override rejected:", rec.id, error); }
    }
    try {
      applyConnectorTextFallback(node, rec, layers);
    } catch (error) { /* instance sublayer name may not be overridable */ }
    try {
      if (props.scence && props.scence.visible === false && node.visible !== false) node.visible = false;
      else if (props.scence && props.scence.visible === true && node.visible === false) node.visible = true;
    } catch (error) { /* not overridable */ }
    try {
      const opacity = props.blend ? props.blend.opacity : undefined;
      if (typeof opacity === "number" && "opacity" in node && Math.abs((node as any).opacity - opacity) > 0.001) {
        (node as any).opacity = opacity;
      }
    } catch (error) { /* not overridable */ }
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      registerMissingFontTextCandidate(textNode);
      let charsOverridden = false;
      // An explicit empty override clears the template's placeholder text.
      if (typeof props.characters === "string") {
        try {
          if (textNode.characters !== props.characters && textNode.fontName !== figma.mixed) {
            await loadFontCached(textNode.fontName as FontName);
            textNode.characters = props.characters;
            charsOverridden = true;
          }
        } catch (error) { /* font unavailable or locked — keep component text */ }
      }
      // In a rescaled instance Figma re-hugs auto-resize text around the scaled
      // font with its own anchor rules (box lands 1px above the scaled spot
      // whenever fract(scaled lineHeight) > 0.5), and instance children cannot
      // be repositioned. textAutoResize IS overridable: pinning it to NONE
      // restores the exact scaled box, which is also MasterGo's glyph truth —
      // MasterGo's own instance hug is center-preserving, so glyphs sit at the
      // pure-scale position and only the integer-rounded bounding box differs
      // (< 0.5px). Texts whose characters were overridden keep hugging so the
      // box wraps the new content.
      if (rescaled && !charsOverridden &&
          (textNode.textAutoResize === "WIDTH_AND_HEIGHT" || textNode.textAutoResize === "HEIGHT")) {
        try {
          const len = textNode.characters.length;
          if (len > 0) {
            for (const font of textNode.getRangeAllFontNames(0, len)) await loadFontCached(font);
          }
          textNode.textAutoResize = "NONE";
        } catch (error) { /* fonts missing — keep hug behavior */ }
      }
    }
    // Paint overrides (e.g. a recolored key): apply record fills/strokes only
    // when they differ from the component-inherited paints, so untouched
    // children keep a clean (non-overridden) state. IMAGE paints need the
    // asset pipeline and are skipped here.
    const geometry = props.geometry;
    if (geometry) {
      try {
        if (Array.isArray(geometry.fills) && "fills" in node) {
          const want = comparablePaintKey(geometry.fills);
          const have = comparablePaintKey((node as any).fills);
          if (want !== null && want !== have) safeSetFills(node as any, geometry.fills);
        }
      } catch (error) { /* not overridable */ }
      try {
        if (Array.isArray(geometry.strokes) && "strokes" in node) {
          const want = comparablePaintKey(geometry.strokes);
          const have = comparablePaintKey((node as any).strokes);
          if (want !== null && want !== have) safeSetStrokes(node as any, geometry.strokes);
        }
      } catch (error) { /* not overridable */ }
    }
    // Run fills must land after the whole-node paint override above.
    if (node.type === "TEXT") {
      try {
        await applyInstanceTextFormatting(node, props);
      } catch (error) { /* font unavailable or locked — preserve master formatting */ }
    }
    // Auto-layout spacing/padding is overridable on instance sublayers and
    // MasterGo stores the instance's own value on the child record (0806 tab
    // bar: gap 20 / padding 24 against the component's 38 / 40, which is what
    // makes its five items 124.4 wide instead of 103.6). It cannot be applied
    // HERE: the component side gets its auto-layout from
    // applyDeferredLayoutRestores, which runs after instances are created, so
    // right now every one of these nodes is still layoutMode NONE and the
    // assignment would silently no-op. Queue it for the post-layout flush.
    // layoutGrow / layoutAlign are per-CHILD overrides (0920: a DatePicker
    // instance inside a Form Item instance stores grow 1 and must fill the
    // 264px item; the component's own 320 otherwise overflows it). They need
    // the PARENT's layoutMode, which the same deferred pass supplies.
    if (props.layout && (
        ("layoutMode" in node && INSTANCE_LAYOUT_OVERRIDE_KEYS.some(key => typeof props.layout[key] === "number")) ||
        typeof props.layout.layoutGrow === "number" || typeof props.layout.layoutAlign === "string" ||
        typeof props.layout.layoutPositioning === "string")) {
      pendingInstanceLayoutOverrides.push({ node: node, layout: props.layout });
    }
    await applyImportedStyleBindings(node, rec);
  }
}

// See applyInstanceChildOverrides: instance-sublayer spacing has to land after
// the deferred auto-layout pass has given the component side a layoutMode.
const pendingInstanceLayoutOverrides: Array<{ node: SceneNode; layout: any }> = [];
let instanceLayoutPageCursor = 0;
// Must stay in sync with MG_SLIM_LAYOUT_KEYS in src/ui/mgPackage.js — the UI
// converts .mg with slimInstanceDescendants, so anything not on that keep-list
// arrives here as undefined and the override silently never happens.
const INSTANCE_LAYOUT_OVERRIDE_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"];

// Runs TWICE: once per page right after the deferred layout pass, then again at
// session finalize. The retry is not belt-and-braces — writing the component's
// layoutMode makes Figma re-push the component's spacing onto every instance,
// and that push lands after this synchronous write, silently restoring the
// component's gap. The finalize pass re-checks once everything has settled.
// Idempotent by construction: it only writes values that differ.
function flushInstanceChildLayoutOverrides(final: boolean): number {
  let applied = 0, deferred = 0, rejected = 0;
  const keep: Array<{ node: SceneNode; layout: any }> = [];
  const entries = final ? pendingInstanceLayoutOverrides : pendingInstanceLayoutOverrides.slice(instanceLayoutPageCursor);
  for (const entry of entries) {
    const node = entry.node as any;
    if (!node || node.removed) continue;
    keep.push(entry);
    // Child-side overrides: valid once the PARENT is auto-layout.
    const parent = node.parent as any;
    if (parent && parent.layoutMode && parent.layoutMode !== "NONE") {
      for (const key of ["layoutPositioning", "layoutGrow", "layoutAlign"]) {
        const want = entry.layout[key];
        if (want === undefined || want === null || node[key] === want) continue;
        try {
          node[key] = want;
          if (node[key] === want) applied++; else rejected++;
        } catch (error) {
          rejected++;
          console.warn("[mg-instance] child layout override rejected:", node.name, key, error);
        }
      }
    }
    // The component side gets its layoutMode from applyDeferredLayoutRestores;
    // until that has run, writing spacing here is a no-op. Retry at finalize.
    if (!("layoutMode" in node) || node.layoutMode === "NONE" || node.layoutMode === undefined) {
      deferred++;
      continue;
    }
    for (const key of INSTANCE_LAYOUT_OVERRIDE_KEYS) {
      const isLimit = /^(min|max)(Width|Height)$/.test(key);
      const want = isLimit ? normalizeMasterGoSizeLimit(entry.layout[key]) : entry.layout[key];
      if (want === undefined || (!isLimit && (typeof want !== "number" || !isFinite(want)))) continue;
      if (node[key] === want || (typeof want === "number" && typeof node[key] === "number" && Math.abs(node[key] - want) <= 0.01)) continue;
      try {
        node[key] = want;
      } catch (error) {
        rejected++;
        console.warn("[mg-instance] auto-layout override rejected:", node.name, key, error);
        continue;
      }
      // Assignment can be silently ignored on a locked sublayer — verify.
      if (want === null ? node[key] !== null : Math.abs(node[key] - want) > 0.01) {
        rejected++;
        console.warn("[mg-instance] auto-layout override did not stick:", node.name, key, "got", node[key], "wanted", want);
        continue;
      }
      applied++;
    }
  }
  if (final) {
    pendingInstanceLayoutOverrides.length = 0;
    instanceLayoutPageCursor = 0;
  } else {
    instanceLayoutPageCursor = pendingInstanceLayoutOverrides.length;
  }
  if (applied || deferred || rejected) {
    console.info("[mg-instance] instance-child auto-layout overrides:",
      JSON.stringify({ pass: final ? "finalize" : "page", applied, deferred, rejected, queued: keep.length }));
  }
  return applied;
}

// Canonical key for a paint list, tolerant of float noise; null = not
// comparable here (image paints, unknown shapes) — those keep component state.
function comparablePaintKey(paints: any): string | null {
  if (!Array.isArray(paints)) return null;
  const round = (v: any) => Math.round(((typeof v === "number" ? v : 0)) * 1000) / 1000;
  const out: any[] = [];
  for (const paint of paints) {
    if (!paint || typeof paint !== "object") return null;
    const visible = paint.visible === undefined
      ? (paint.isVisible === undefined ? true : !!paint.isVisible)
      : !!paint.visible;
    if (paint.type === "SOLID") {
      const c = paint.color || {};
      out.push(["S", round(c.r), round(c.g), round(c.b), round(paint.opacity === undefined ? 1 : paint.opacity), visible ? 1 : 0]);
      continue;
    }
    if (typeof paint.type === "string" && paint.type.indexOf("GRADIENT_") === 0) {
      const stops = (paint.gradientStops || []).map((s: any) => [
        round(s.position),
        round(s.color && s.color.r), round(s.color && s.color.g),
        round(s.color && s.color.b), round(s.color && s.color.a)
      ]);
      out.push(["G", paint.type, stops, visible ? 1 : 0]);
      continue;
    }
    return null;
  }
  return JSON.stringify(out);
}
