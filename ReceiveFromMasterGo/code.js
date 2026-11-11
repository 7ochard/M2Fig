"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __pow = Math.pow;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

  // ../shared/layoutLimits.ts
  function normalizeMasterGoSizeLimit(value) {
    if (value === void 0) return void 0;
    if (value === null || value === 0) return null;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
  }

  // src/legacyWrapLayout.ts
  function restoreLegacyWrapLayout(layers) {
    let restored = 0;
    for (const id of Object.keys(layers)) {
      const record = layers[id];
      const layout = record.props && record.props.layout;
      if (!layout || layout.layoutMode !== "HORIZONTAL" || layout.layoutWrap !== void 0) continue;
      const children = (record.childIds || []).map((id2) => layers[id2]);
      if (children.some((child) => !child || !child.props)) continue;
      const flow = children.filter((child) => {
        var _a, _b;
        return ((_a = child.props.scence) == null ? void 0 : _a.visible) !== false && ((_b = child.props.layout) == null ? void 0 : _b.layoutPositioning) !== "ABSOLUTE";
      }).map((child) => child.props.layout);
      if (flow.length < 3 || flow.some((box) => !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || Math.abs(box.rotation || 0) > 0.01)) continue;
      const tolerance = 0.1;
      const first = flow[0];
      let rowY = first.y;
      let rowBottom = first.y + first.height;
      let previousRight = first.x + first.width;
      let rowCount = 1;
      const gaps = [];
      let valid = true;
      for (const box of flow.slice(1)) {
        if (Math.abs(box.y - rowY) <= tolerance && box.x >= previousRight - tolerance) {
          rowBottom = Math.max(rowBottom, box.y + box.height);
          previousRight = box.x + box.width;
          rowCount++;
        } else if (rowCount >= 2 && Math.abs(box.x - first.x) <= tolerance && box.y >= rowBottom - tolerance) {
          gaps.push(Math.max(0, box.y - rowBottom));
          rowY = box.y;
          rowBottom = box.y + box.height;
          previousRight = box.x + box.width;
          rowCount = 1;
        } else {
          valid = false;
          break;
        }
      }
      if (!valid || !gaps.length || gaps.some((gap) => Math.abs(gap - gaps[0]) > tolerance)) continue;
      layout.layoutWrap = "WRAP";
      if (layout.counterAxisSpacing === void 0) layout.counterAxisSpacing = gaps[0];
      restored++;
    }
    return restored;
  }

  // src/state.ts
  var RestorerState = class {
    constructor() {
      this.documentFonts = [];
      this.restoredLayoutByNodeId = {};
      this.importInProgress = false;
      this.cachedLayerRules = null;
      this.layerRulesBySourceType = null;
      this.layerRulesLoadPromise = null;
      this.activeImportAssets = {};
      this.imageHashByAssetName = {};
      this.missingImageAssetNames = {};
      this.missingImageAssetDetailKeys = {};
      this.missingImageAssetDetails = [];
      this.missingImageAssetCount = 0;
      this.placeholderImageHash = null;
      this.restoredNodeIdBySourceId = {};
      this.nativeGroupOffsetByNodeId = {};
      this.deferredConnectorRestores = [];
      this.deferredLayoutRestores = [];
      // Nodes whose restored layout uses SPACE_BETWEEN on the primary axis,
      // recorded at deferLayoutRestore time and drained per page — replaces the
      // full-page tree walk in applyDeferredSingleChildAutoSpaceAlignmentFixes.
      this.singleChildAutoSpaceCandidates = [];
      this.shellPlaceholderCandidates = [];
      this.missingFontTextCandidates = [];
      this.fontLoadPromises = {};
      this.availableFontKeys = {};
      this.fallbackConnectorCount = 0;
      this.booleanFallbackCount = 0;
      this.connectorFallbackLogged = false;
      this.activeRestoreStats = null;
      this.activeProgressState = null;
    }
    reset() {
      this.activeImportAssets = {};
      this.imageHashByAssetName = {};
      this.missingImageAssetNames = {};
      this.missingImageAssetDetailKeys = {};
      this.missingImageAssetDetails = [];
      this.missingImageAssetCount = 0;
      this.restoredNodeIdBySourceId = {};
      this.nativeGroupOffsetByNodeId = {};
      this.deferredConnectorRestores = [];
      this.deferredLayoutRestores = [];
      this.singleChildAutoSpaceCandidates = [];
      this.shellPlaceholderCandidates = [];
      this.missingFontTextCandidates = [];
      this.fallbackConnectorCount = 0;
      this.booleanFallbackCount = 0;
      this.connectorFallbackLogged = false;
    }
    resetRestoreRuntimeStats(totalNodes, pageCount) {
      this.activeRestoreStats = {
        startedAt: Date.now(),
        totalNodes,
        restoredNodes: 0,
        pageCount,
        textNodeCount: 0,
        fontListLoadCount: 0,
        fontLoadRequestCount: 0,
        fontLoadCacheHitCount: 0,
        fontLoadFailureCount: 0,
        deferredLayoutNodeCount: 0,
        deferredLayoutAppliedCount: 0,
        safeSetWriteCount: 0,
        safeSetSkipCount: 0,
        resizeWriteCount: 0,
        resizeSkipCount: 0,
        apiCreationCount: 0,
        instanceCreationCount: 0,
        cloneCallCount: 0,
        transientRemovalCount: 0,
        restoreBatchYieldCount: 0,
        creationCounts: {}
      };
      this.activeProgressState = {
        total: totalNodes,
        lastCurrent: 0,
        lastPostedAt: Date.now(),
        lastYieldAt: Date.now()
      };
    }
    recordNodeCreation(kind = "node") {
      const stats = this.activeRestoreStats;
      if (!stats) return;
      stats.apiCreationCount++;
      stats.creationCounts[kind] = (stats.creationCounts[kind] || 0) + 1;
      if (kind === "instance") stats.instanceCreationCount++;
      if (kind === "clone") stats.cloneCallCount++;
    }
    recordNodeRemoval() {
      if (this.activeRestoreStats) this.activeRestoreStats.transientRemovalCount++;
    }
    logRestorePerformanceSummary(restoredNodes, pageCount) {
      if (!this.activeRestoreStats) return;
      this.activeRestoreStats.restoredNodes = restoredNodes;
      this.activeRestoreStats.pageCount = pageCount;
      const durationMs = Math.max(Date.now() - this.activeRestoreStats.startedAt, 1);
      const nodesPerSecond = Math.round(restoredNodes / durationMs * 1e4) / 10;
      const summary = {
        durationMs,
        nodesPerSecond,
        pageCount,
        totalNodes: this.activeRestoreStats.totalNodes,
        restoredNodes: this.activeRestoreStats.restoredNodes,
        textNodeCount: this.activeRestoreStats.textNodeCount,
        fontListLoadCount: this.activeRestoreStats.fontListLoadCount,
        fontLoadRequestCount: this.activeRestoreStats.fontLoadRequestCount,
        fontLoadCacheHitCount: this.activeRestoreStats.fontLoadCacheHitCount,
        fontLoadFailureCount: this.activeRestoreStats.fontLoadFailureCount,
        deferredLayoutNodeCount: this.activeRestoreStats.deferredLayoutNodeCount,
        deferredLayoutAppliedCount: this.activeRestoreStats.deferredLayoutAppliedCount,
        safeSetWriteCount: this.activeRestoreStats.safeSetWriteCount,
        safeSetSkipCount: this.activeRestoreStats.safeSetSkipCount,
        resizeWriteCount: this.activeRestoreStats.resizeWriteCount,
        resizeSkipCount: this.activeRestoreStats.resizeSkipCount
      };
      console.log("[MasterGo2Figma] Restore performance", summary);
      console.log("[MasterGo2Figma] Restore performance JSON " + JSON.stringify(summary));
    }
  };
  var state = new RestorerState();

  // src/appliers/maskFill.ts
  function isBackdropCoverageMask(fills, strokes, effects) {
    var _a, _b, _c;
    if (!Array.isArray(effects) || !effects.some((fx) => fx.type === "BACKGROUND_BLUR" && fx.visible !== false && fx.radius > 0)) return false;
    const visible = (paints2) => Array.isArray(paints2) ? paints2.filter((p) => p && p.visible !== false && (p.opacity === void 0 || p.opacity > 0)) : [];
    if (visible(strokes).some((p) => {
      var _a2, _b2, _c2;
      return p.type !== "SOLID" || ((_a2 = p.color) == null ? void 0 : _a2.r) !== 1 || ((_b2 = p.color) == null ? void 0 : _b2.g) !== 1 || ((_c2 = p.color) == null ? void 0 : _c2.b) !== 1;
    })) return false;
    const paints = visible(fills);
    return paints.length === 1 && paints[0].type === "SOLID" && paints[0].opacity > 0 && paints[0].opacity < 1 && ((_a = paints[0].color) == null ? void 0 : _a.r) === 0 && ((_b = paints[0].color) == null ? void 0 : _b.g) === 0 && ((_c = paints[0].color) == null ? void 0 : _c.b) === 0;
  }
  function isDefaultMaskFill(paints) {
    if (!Array.isArray(paints) || paints.length !== 1 || !paints[0]) return false;
    const paint = paints[0];
    const isDefaultGray = (color) => color && [color.r, color.g, color.b].every(
      (value) => typeof value === "number" && Math.abs(value - 216 / 255) < 1e-3
    );
    if (paint.type === "SOLID") return !!isDefaultGray(paint.color);
    return typeof paint.type === "string" && paint.type.startsWith("GRADIENT_") && Array.isArray(paint.gradientStops) && paint.gradientStops.length > 1 && paint.gradientStops.every((stop) => isDefaultGray(stop.color)) && paint.gradientStops.some((stop) => stop.color.a < 1);
  }
  function isGradientCoverageMask(fills, strokes, siblings) {
    const visible = (paints2) => Array.isArray(paints2) ? paints2.filter((p) => p && p.visible !== false && (p.opacity === void 0 || p.opacity > 0)) : [];
    if (visible(strokes).length) return false;
    const paints = visible(fills);
    if (paints.length !== 1 || !String(paints[0].type).startsWith("GRADIENT_")) return false;
    const stops = paints[0].gradientStops;
    if (!Array.isArray(stops) || stops.length < 2 || !stops.some((s) => {
      var _a;
      return ((_a = s.color) == null ? void 0 : _a.a) < 1;
    })) return false;
    if (!stops.every((s) => {
      var _a, _b, _c;
      return ((_a = s.color) == null ? void 0 : _a.r) === 0 && ((_b = s.color) == null ? void 0 : _b.g) === 0 && ((_c = s.color) == null ? void 0 : _c.b) === 0;
    })) return false;
    return siblings.some((n) => n.visible !== false && !n.isMask && visible(n.fills).some((p) => {
      var _a, _b, _c;
      return p.type === "SOLID" && (((_a = p.color) == null ? void 0 : _a.r) > 0 || ((_b = p.color) == null ? void 0 : _b.g) > 0 || ((_c = p.color) == null ? void 0 : _c.b) > 0);
    }));
  }

  // ../shared/layerRulesConfig.ts
  var LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";
  var VALID_RECEIVE_CREATE_TYPES = [
    "VECTOR",
    "ELLIPSE",
    "RECTANGLE",
    "STAR",
    "LINE",
    "POLYGON",
    "TEXT",
    "SECTION",
    "SLICE",
    "FRAME",
    "COMPONENT",
    "COMPONENT_SET",
    "GROUP",
    "CONNECTOR",
    "BOOLEAN_OPERATION"
  ];
  var DEFAULT_LAYER_CONVERSION_CONFIG = {
    schema: LAYER_RULES_SCHEMA,
    version: 1,
    rules: {
      BOOLEAN_OPERATION: { sourceType: "BOOLEAN_OPERATION", restoreType: "BOOLEAN_OPERATION", sendStrategy: "booleanTree", receiveCreate: "BOOLEAN_OPERATION", isContainer: true, visualFrameSource: false },
      PEN: { sourceType: "PEN", restoreType: "VECTOR", sendStrategy: "penNetwork", receiveCreate: "VECTOR", isContainer: false, visualFrameSource: false },
      VECTOR: { sourceType: "VECTOR", restoreType: "VECTOR", sendStrategy: "penNetwork", receiveCreate: "VECTOR", isContainer: false, visualFrameSource: false },
      ELLIPSE: { sourceType: "ELLIPSE", restoreType: "ELLIPSE", sendStrategy: "ellipseArc", receiveCreate: "ELLIPSE", isContainer: false, visualFrameSource: false },
      RECTANGLE: { sourceType: "RECTANGLE", restoreType: "RECTANGLE", sendStrategy: "universalOnly", receiveCreate: "RECTANGLE", isContainer: false, visualFrameSource: false },
      STAR: { sourceType: "STAR", restoreType: "STAR", sendStrategy: "star", receiveCreate: "STAR", isContainer: false, visualFrameSource: false },
      LINE: { sourceType: "LINE", restoreType: "LINE", sendStrategy: "universalOnly", receiveCreate: "LINE", isContainer: false, visualFrameSource: false },
      POLYGON: { sourceType: "POLYGON", restoreType: "POLYGON", sendStrategy: "polygon", receiveCreate: "POLYGON", isContainer: false, visualFrameSource: false },
      TEXT: { sourceType: "TEXT", restoreType: "TEXT", sendStrategy: "text", receiveCreate: "TEXT", isContainer: false, visualFrameSource: false },
      FRAME: { sourceType: "FRAME", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: false },
      GROUP: { sourceType: "GROUP", restoreType: "GROUP", sendStrategy: "groupLike", receiveCreate: "GROUP", isContainer: true, visualFrameSource: false },
      SECTION: { sourceType: "SECTION", restoreType: "SECTION", sendStrategy: "frameLike", receiveCreate: "SECTION", isContainer: true, visualFrameSource: false },
      SLICE: { sourceType: "SLICE", restoreType: "SLICE", sendStrategy: "universalOnly", receiveCreate: "SLICE", isContainer: false, visualFrameSource: false },
      CONNECTOR: { sourceType: "CONNECTOR", restoreType: "CONNECTOR", sendStrategy: "connector", receiveCreate: "CONNECTOR", isContainer: false, visualFrameSource: false },
      COMPONENT: { sourceType: "COMPONENT", restoreType: "COMPONENT", sendStrategy: "frameLike", receiveCreate: "COMPONENT", isContainer: true, visualFrameSource: false },
      COMPONENT_SET: { sourceType: "COMPONENT_SET", restoreType: "COMPONENT_SET", sendStrategy: "frameLike", receiveCreate: "COMPONENT_SET", isContainer: true, visualFrameSource: false },
      INSTANCE: { sourceType: "INSTANCE", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true }
    }
  };

  // src/layerRules.ts
  function startLayerRulesLoad() {
    if (!state.layerRulesLoadPromise) {
      state.layerRulesLoadPromise = loadCachedLayerRules();
    }
    return state.layerRulesLoadPromise;
  }
  function ensureLayerRulesLoaded() {
    return __async(this, null, function* () {
      yield startLayerRulesLoad();
    });
  }
  function loadCachedLayerRules() {
    return __async(this, null, function* () {
      state.cachedLayerRules = {
        config: DEFAULT_LAYER_CONVERSION_CONFIG,
        fileName: "\u5185\u7F6E\u8F6C\u6362\u89C4\u5219",
        importedAt: ""
      };
      state.layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
    });
  }
  function createLayerRuleIndex(config) {
    const result = {};
    for (const sourceType in config.rules) {
      result[sourceType] = config.rules[sourceType];
    }
    return result;
  }
  function getLayerRuleStatus() {
    if (!state.cachedLayerRules || !state.layerRulesBySourceType) return { valid: false };
    return {
      valid: true,
      fileName: state.cachedLayerRules.fileName,
      importedAt: state.cachedLayerRules.importedAt,
      ruleCount: Object.keys(state.layerRulesBySourceType).length
    };
  }
  function hasValidLayerRules() {
    return !!state.layerRulesBySourceType;
  }
  function getLayerRule(sourceType) {
    if (!sourceType || !state.layerRulesBySourceType) return null;
    return state.layerRulesBySourceType[sourceType] || null;
  }
  function getRestoreType(data) {
    const sourceType = data.sourceType || data.type;
    if (data.restoreType) return data.restoreType;
    const rule = getLayerRule(sourceType) || getLayerRule(data.type);
    if (rule) return rule.restoreType;
    return data.type;
  }
  function getReceiveCreateType(data) {
    const override = data && data.receiveCreateOverride;
    if (override === "SVG" && typeof data.svgMarkup === "string" && data.svgMarkup.trim()) return "SVG";
    if (override && VALID_RECEIVE_CREATE_TYPES.indexOf(override) !== -1) return override;
    const sourceType = data.sourceType || data.type;
    const rule = getLayerRule(sourceType) || getLayerRule(data.restoreType) || getLayerRule(data.type);
    if (rule) return rule.receiveCreate;
    const restoreType = getRestoreType(data);
    if (restoreType === "PEN") return "VECTOR";
    return restoreType;
  }

  // src/fontLoader.ts
  function getFontKey(family, style) {
    return `${family}
${style}`;
  }
  var normalizedFontEntries = [];
  var fontResolutionCache = {};
  var indexedFontSource = null;
  function ensureAvailableFontsLoaded() {
    return __async(this, null, function* () {
      if (state.documentFonts.length === 0) {
        if (state.activeRestoreStats) {
          state.activeRestoreStats.fontListLoadCount++;
        }
        state.documentFonts = yield figma.listAvailableFontsAsync();
        rebuildAvailableFontIndex();
        return;
      }
      const firstFont = state.documentFonts[0].fontName;
      if (state.documentFonts !== indexedFontSource || !state.availableFontKeys[getFontKey(firstFont.family, firstFont.style)]) {
        rebuildAvailableFontIndex();
      }
    });
  }
  function refreshAvailableFonts() {
    return __async(this, null, function* () {
      if (state.activeRestoreStats) {
        state.activeRestoreStats.fontListLoadCount++;
      }
      state.documentFonts = yield figma.listAvailableFontsAsync();
      rebuildAvailableFontIndex();
    });
  }
  function rebuildAvailableFontIndex() {
    state.availableFontKeys = {};
    normalizedFontEntries = [];
    fontResolutionCache = {};
    for (const font of state.documentFonts) {
      const fontName = font.fontName;
      state.availableFontKeys[getFontKey(fontName.family, fontName.style)] = true;
      normalizedFontEntries.push({
        fontName,
        family: normalizeFontFamilyForMatch(fontName.family),
        style: normalizeFontStyleForMatch(fontName.style)
      });
    }
    indexedFontSource = state.documentFonts;
  }
  function loadFontCached(fontName) {
    return __async(this, null, function* () {
      const key = getFontKey(fontName.family, fontName.style);
      const existing = state.fontLoadPromises[key];
      if (existing) {
        if (state.activeRestoreStats) {
          state.activeRestoreStats.fontLoadCacheHitCount++;
        }
        yield existing;
        return;
      }
      if (state.activeRestoreStats) {
        state.activeRestoreStats.fontLoadRequestCount++;
      }
      const requestStats = state.activeRestoreStats;
      const promise = figma.loadFontAsync(fontName).catch((error) => {
        if (requestStats && state.fontLoadPromises[key] === promise) {
          requestStats.fontLoadFailureCount++;
        }
        throw error;
      });
      promise.catch(() => void 0);
      state.fontLoadPromises[key] = promise;
      yield promise;
    });
  }
  function cacheFontLoadFailure(fontName, error) {
    const key = getFontKey(fontName.family, fontName.style);
    if (state.activeRestoreStats) {
      state.activeRestoreStats.fontLoadFailureCount++;
    }
    const rejected = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    rejected.catch(() => void 0);
    state.fontLoadPromises[key] = rejected;
  }
  function resolveAvailableFontName(requested) {
    const requestedKey = getFontKey(requested.family, requested.style);
    if (state.availableFontKeys[requestedKey]) {
      return requested;
    }
    const cached = fontResolutionCache[requestedKey];
    if (cached !== void 0) return cached;
    const requestedFamily = normalizeFontFamilyForMatch(requested.family);
    const requestedStyle = normalizeFontStyleForMatch(requested.style);
    let bestMatch = null;
    for (const entry of normalizedFontEntries) {
      const familyScore = getNormalizedFamilyMatchScore(requestedFamily, entry.family);
      if (familyScore <= 0) continue;
      const styleForMatch = (requestedStyle === requestedFamily || requestedFamily === entry.family && requestedStyle === entry.family + entry.style) && requestedStyle.indexOf(entry.family) === 0 ? requestedStyle.slice(entry.family.length) : requestedStyle;
      const styleScore = getNormalizedStyleMatchScore(styleForMatch, entry.style);
      if (styleScore <= 0) continue;
      const score = familyScore + styleScore;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { fontName: entry.fontName, score };
      }
    }
    const result = bestMatch ? bestMatch.fontName : null;
    fontResolutionCache[requestedKey] = result;
    return result;
  }
  function getNormalizedFamilyMatchScore(requested, available) {
    if (!requested || !available) return 0;
    if (requested === available) return 100;
    if (available.indexOf(requested) === 0 || requested.indexOf(available) === 0) return 80;
    return 0;
  }
  function getNormalizedStyleMatchScore(requested, available) {
    if (!requested || !available) return 0;
    if (requested === available) return 50;
    return 0;
  }
  function normalizeFontFamilyForMatch(value) {
    const normalized = String(value || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
    return FONT_FAMILY_ALIASES[normalized] || normalized;
  }
  var FONT_FAMILY_ALIASES = {
    "\u82F9\u65B9\u7B80": "pingfangsc",
    "\u82F9\u65B9\u7E41": "pingfangtc",
    "\u82F9\u65B9\u6E2F": "pingfanghk",
    "\u82F9\u65B9\u6FB3": "pingfangmo"
  };
  var FONT_STYLE_ALIASES = {
    "\u5E38\u89C4": "regular",
    "\u4E2D\u7B49": "medium",
    "\u7C97\u4F53": "bold",
    "\u5E38\u89C4\u4F53": "regular",
    "\u4E2D\u9ED1\u4F53": "medium",
    "\u4E2D\u7C97\u4F53": "semibold",
    "\u7EC6\u4F53": "light",
    "\u7EA4\u7EC6\u4F53": "thin",
    "\u6781\u7EC6\u4F53": "extralight",
    normal: "regular",
    book: "regular",
    roman: "regular",
    regular: "regular",
    400: "regular",
    medium: "medium",
    500: "medium",
    semibold: "semibold",
    demibold: "semibold",
    600: "semibold",
    bold: "bold",
    700: "bold",
    heavy: "heavy",
    black: "black",
    900: "black",
    light: "light",
    300: "light",
    extralight: "extralight",
    ultralight: "extralight",
    200: "extralight",
    thin: "thin",
    100: "thin"
  };
  function normalizeFontStyleForMatch(value) {
    let normalized = String(value || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
    const withoutCharsetMarker = normalized.replace(/l\d+$/, "");
    if (withoutCharsetMarker) normalized = withoutCharsetMarker;
    return FONT_STYLE_ALIASES[normalized] || normalized;
  }
  function getNearbyAvailableFontsForLog(requested) {
    const requestedFamily = normalizeFontFamilyForMatch(requested.family);
    const nearby = [];
    for (const font of state.documentFonts) {
      const family = normalizeFontFamilyForMatch(font.fontName.family);
      if (family.indexOf(requestedFamily) !== -1 || requestedFamily.indexOf(family) !== -1 || familiesShareWords(requested.family, font.fontName.family)) {
        nearby.push(font.fontName);
      }
      if (nearby.length >= 20) break;
    }
    return nearby;
  }
  function familiesShareWords(left, right) {
    const leftWords = splitFontFamilyWords(left);
    const rightWords = splitFontFamilyWords(right);
    let sharedCount = 0;
    for (const word of leftWords) {
      if (rightWords.indexOf(word) !== -1) sharedCount++;
    }
    return sharedCount >= Math.min(2, leftWords.length, rightWords.length);
  }
  function splitFontFamilyWords(value) {
    return String(value || "").toLowerCase().split(/[\s_-]+/).filter(Boolean);
  }

  // ../shared/textRangeUtils.ts
  function normalizeCompleteTextRanges(characters, ranges) {
    const codePoints = Array.from(characters);
    if (codePoints.length === characters.length || !ranges.length) return ranges;
    let end = 0;
    for (const range of ranges) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start !== end || range.end <= range.start) return ranges;
      end = range.end;
    }
    if (end !== codePoints.length) return ranges;
    const offsets = [0];
    for (const character of codePoints) offsets.push(offsets[offsets.length - 1] + character.length);
    return ranges.map((range) => __spreadProps(__spreadValues({}, range), { start: offsets[range.start], end: offsets[range.end] }));
  }

  // src/appliers/text.ts
  var MISSING_FONT_NAME_PREFIX_PATTERN = /^\[Font Missing\]\[([^\]]+)\]\[([^\]]+)\]\s*/;
  function registerMissingFontTextCandidate(node) {
    if (!node.removed && MISSING_FONT_NAME_PREFIX_PATTERN.test(node.name)) state.missingFontTextCandidates.push(node);
  }
  function applyTextProperties(node, data) {
    return __async(this, null, function* () {
      var _a, _b;
      if (state.activeRestoreStats) {
        state.activeRestoreStats.textNodeCount++;
      }
      yield ensureAvailableFontsLoaded();
      const family = ((_a = data.fontName) == null ? void 0 : _a.family) || "Inter";
      const style = ((_b = data.fontName) == null ? void 0 : _b.style) || "Regular";
      const requestedFontName = { family, style };
      const resolvedFontName = resolveAvailableFontName(requestedFontName);
      yield loadFontCached({ family: "Inter", style: "Regular" });
      let activeFontName = resolvedFontName;
      if (activeFontName) {
        try {
          yield loadFontCached(activeFontName);
        } catch (error) {
          console.warn("Unable to load resolved font, falling back to Inter:", activeFontName, error);
          activeFontName = null;
        }
      }
      if (!activeFontName) {
        node.name = "[Font Missing][" + family + "][" + style + "] " + node.name;
      }
      registerMissingFontTextCandidate(node);
      node.fontName = activeFontName || { family: "Inter", style: "Regular" };
      node.characters = data.characters || "";
      node.fontSize = Number.isFinite(data.fontSize) && data.fontSize > 0 ? data.fontSize : 12;
      trySetText(() => {
        node.textAlignHorizontal = data.textAlignHorizontal || "LEFT";
      });
      trySetText(() => {
        node.textAlignVertical = data.textAlignVertical || "TOP";
      });
      const truncates = data.textAutoResize === "TRUNCATE" || data.textAutoResize === "TRUNCATE_AND_AUTO_HEIGHT";
      trySetText(() => {
        node.textAutoResize = truncates ? "NONE" : data.textAutoResize || "NONE";
      });
      trySetText(() => {
        node.textTruncation = truncates ? "ENDING" : "DISABLED";
      });
      trySetText(() => {
        node.paragraphIndent = data.paragraphIndent || 0;
      });
      trySetText(() => {
        node.paragraphSpacing = data.paragraphSpacing || 0;
      });
      trySetText(() => {
        node.autoRename = data.autoRename || false;
      });
      if (data.textCase) trySetText(() => {
        node.textCase = data.textCase;
      });
      if (data.textDecoration) trySetText(() => {
        node.textDecoration = data.textDecoration;
      });
      if (data.letterSpacing !== void 0) trySetText(() => {
        node.letterSpacing = data.letterSpacing;
      });
      if (data.lineHeight !== void 0) trySetText(() => {
        node.lineHeight = data.lineHeight;
      });
      if (Array.isArray(data.styledTextSegments) && data.styledTextSegments.length > 0) {
        yield applyStyledTextSegments(node, data.styledTextSegments, data.textRangeUnit);
      }
      applyTextListRanges(node, data.textListRanges);
    });
  }
  function applyStyledTextSegments(node, segments, rangeUnit) {
    return __async(this, null, function* () {
      var _a, _b;
      const charLength = node.characters.length;
      if (rangeUnit !== "UTF16") segments = normalizeCompleteTextRanges(node.characters, segments);
      const resolvedByKey = {};
      for (const segment of segments) {
        if (!segment || !segment.fontName) continue;
        const key = getFontKey(segment.fontName.family, segment.fontName.style);
        if (key in resolvedByKey) continue;
        const resolved = resolveAvailableFontName(segment.fontName);
        resolvedByKey[key] = resolved;
        if (resolved) {
          try {
            yield loadFontCached(resolved);
          } catch (error) {
            resolvedByKey[key] = null;
            console.warn("Unable to load run font for styled text:", segment.fontName, error);
          }
        }
      }
      for (const segment of segments) {
        if (!segment) continue;
        const start = Math.max(0, Math.floor((_a = segment.start) != null ? _a : 0));
        const end = Math.min(charLength, Math.floor((_b = segment.end) != null ? _b : 0));
        if (!(end > start)) continue;
        const fontKey = segment.fontName ? getFontKey(segment.fontName.family, segment.fontName.style) : "";
        const resolvedFont = fontKey ? resolvedByKey[fontKey] : null;
        if (resolvedFont) trySetRange(() => node.setRangeFontName(start, end, resolvedFont));
        if (typeof segment.fontSize === "number") trySetRange(() => node.setRangeFontSize(start, end, segment.fontSize));
        if (Array.isArray(segment.fills) && segment.fills.length > 0) {
          trySetRange(() => node.setRangeFills(start, end, segment.fills));
        }
        if (segment.textCase) trySetRange(() => node.setRangeTextCase(start, end, segment.textCase));
        if (segment.textDecoration) trySetRange(() => node.setRangeTextDecoration(start, end, segment.textDecoration));
        if (segment.letterSpacing !== void 0) trySetRange(() => node.setRangeLetterSpacing(start, end, segment.letterSpacing));
        if (segment.lineHeight !== void 0) trySetRange(() => node.setRangeLineHeight(start, end, segment.lineHeight));
      }
    });
  }
  function applyInstanceTextFormatting(node, data) {
    return __async(this, null, function* () {
      for (const segment of node.getStyledTextSegments(["fontName"])) {
        try {
          yield loadFontCached(segment.fontName);
        } catch (error) {
          console.warn("Unable to load instance text segment font:", segment.fontName, error);
        }
      }
      if (data.fontName) {
        yield ensureAvailableFontsLoaded();
        const resolved = resolveAvailableFontName(data.fontName);
        if (resolved) {
          try {
            yield loadFontCached(resolved);
            if (node.fontName === figma.mixed || node.fontName.family !== resolved.family || node.fontName.style !== resolved.style) {
              node.fontName = resolved;
            }
          } catch (error) {
            console.warn("Unable to load instance override font:", resolved, error);
          }
        }
      }
      if (Number.isFinite(data.fontSize) && data.fontSize > 0 && node.fontSize !== data.fontSize) {
        node.fontSize = data.fontSize;
      }
      for (const key of [
        "lineHeight",
        "letterSpacing",
        "textCase",
        "textDecoration",
        "textAlignHorizontal",
        "textAlignVertical",
        "paragraphIndent",
        "paragraphSpacing"
      ]) {
        if (data[key] !== void 0 && JSON.stringify(node[key]) !== JSON.stringify(data[key])) {
          trySetText(() => {
            node[key] = data[key];
          });
        }
      }
      if (Array.isArray(data.styledTextSegments) && data.styledTextSegments.length > 0) {
        yield applyStyledTextSegments(node, data.styledTextSegments, data.textRangeUnit);
      }
      applyTextListRanges(node, data.textListRanges);
    });
  }
  function applyTextListRanges(node, ranges) {
    if (!Array.isArray(ranges)) return;
    const length = node.characters.length;
    for (const range of ranges) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > length || ["ORDERED", "UNORDERED", "NONE"].indexOf(range.type) < 0) continue;
      trySetRange(() => node.setRangeListOptions(range.start, range.end, { type: range.type }));
      if (Number.isInteger(range.indentation) && range.indentation >= 0 && range.indentation <= 4) {
        trySetRange(() => node.setRangeIndentation(range.start, range.end, range.indentation));
      }
    }
  }
  function trySetRange(fn) {
    try {
      fn();
    } catch (error) {
    }
  }
  function trySetText(fn) {
    try {
      fn();
    } catch (_) {
    }
  }
  function parseMissingFontTextLayerName(name) {
    const match = MISSING_FONT_NAME_PREFIX_PATTERN.exec(name);
    if (!match) return null;
    return {
      family: match[1],
      style: match[2],
      restoredName: name.slice(match[0].length)
    };
  }
  function logMissingFontRestoreTargets(targets) {
    const requestedToResolved = {};
    for (const target of targets) {
      if (!requestedToResolved[target.requestedFontKey]) {
        requestedToResolved[target.requestedFontKey] = {
          requested: target.requestedFontName,
          resolved: target.resolvedFontName,
          count: 0
        };
      }
      requestedToResolved[target.requestedFontKey].count++;
    }
    const resolutions = Object.keys(requestedToResolved).map((key) => requestedToResolved[key]);
    for (const item of resolutions) {
      if (item.resolved) continue;
      console.warn("[MasterGo2Figma] No available font match for missing font", {
        requested: item.requested,
        nearbyAvailableFonts: getNearbyAvailableFontsForLog(item.requested)
      });
    }
  }
  function restoreMissingFontTextLayers(pages, candidates) {
    return __async(this, null, function* () {
      const result = {
        scannedTextNodeCount: 0,
        candidateTextNodeCount: 0,
        manuallyResolvedTextNodeCount: 0,
        restoredTextNodeCount: 0,
        failedTextNodeCount: 0,
        loadedFontCount: 0,
        failedFontCount: 0,
        missingFonts: []
      };
      const targets = [];
      yield ensureAvailableFontsLoaded();
      for (let pageIndex = 0; pageIndex < (candidates ? 1 : pages.length); pageIndex++) {
        let textNodes;
        if (candidates) {
          const seen = /* @__PURE__ */ new Set();
          textNodes = candidates.filter((node) => {
            if (node.removed || seen.has(node.id)) return false;
            seen.add(node.id);
            return true;
          });
        } else {
          const page = pages[pageIndex];
          yield page.loadAsync();
          textNodes = page.findAll((node) => node.type === "TEXT");
        }
        result.scannedTextNodeCount += textNodes.length;
        for (const node of textNodes) {
          const parsed = parseMissingFontTextLayerName(node.name);
          if (!parsed) continue;
          result.candidateTextNodeCount++;
          if (textNodeUsesNonInterFont(node)) {
            node.name = parsed.restoredName;
            result.manuallyResolvedTextNodeCount++;
            continue;
          }
          const requestedFontName = { family: parsed.family, style: parsed.style };
          const resolvedFontName = resolveAvailableFontName(requestedFontName);
          targets.push({
            node,
            requestedFontName,
            resolvedFontName,
            restoredName: parsed.restoredName,
            requestedFontKey: getFontKey(parsed.family, parsed.style),
            resolvedFontKey: resolvedFontName ? getFontKey(resolvedFontName.family, resolvedFontName.style) : ""
          });
        }
      }
      if (targets.length === 0) return result;
      logMissingFontRestoreTargets(targets);
      const fontLoadState = /* @__PURE__ */ new Map();
      const failedFontsByKey = {};
      for (const target of targets) {
        if (!target.resolvedFontName) {
          result.failedTextNodeCount++;
          recordFailedMissingFont(failedFontsByKey, target.requestedFontName);
          continue;
        }
        if (!fontLoadState.has(target.resolvedFontKey)) {
          try {
            yield loadFontCached(target.resolvedFontName);
            fontLoadState.set(target.resolvedFontKey, true);
            result.loadedFontCount++;
          } catch (error) {
            fontLoadState.set(target.resolvedFontKey, false);
            result.failedFontCount++;
            console.warn("Unable to restore missing font:", {
              requested: target.requestedFontName,
              resolved: target.resolvedFontName
            }, error);
          }
        }
        if (!fontLoadState.get(target.resolvedFontKey)) {
          result.failedTextNodeCount++;
          recordFailedMissingFont(failedFontsByKey, target.requestedFontName);
          continue;
        }
        try {
          target.node.fontName = target.resolvedFontName;
          target.node.name = target.restoredName;
          result.restoredTextNodeCount++;
        } catch (error) {
          result.failedTextNodeCount++;
          recordFailedMissingFont(failedFontsByKey, target.requestedFontName);
          console.warn("Unable to apply restored font:", target.node.name, {
            requested: target.requestedFontName,
            resolved: target.resolvedFontName
          }, error);
        }
      }
      result.missingFonts = Object.keys(failedFontsByKey).map((key) => failedFontsByKey[key]).sort((a, b) => `${a.family} ${a.style}`.localeCompare(`${b.family} ${b.style}`));
      return result;
    });
  }
  function textNodeUsesNonInterFont(node) {
    const fontName = node.fontName;
    if (isNonInterFontName(fontName)) return true;
    const textLength = node.characters.length;
    const getRangeAllFontNames = node.getRangeAllFontNames;
    if (textLength <= 0 || typeof getRangeAllFontNames !== "function") return false;
    try {
      const rangeFonts = getRangeAllFontNames.call(node, 0, textLength);
      return Array.isArray(rangeFonts) && rangeFonts.some(isNonInterFontName);
    } catch (_) {
      return false;
    }
  }
  function isNonInterFontName(fontName) {
    if (!fontName || fontName === figma.mixed) return false;
    return normalizeFontFamilyForMatch(fontName.family) !== "inter";
  }
  function recordFailedMissingFont(failedFontsByKey, fontName) {
    const key = getFontKey(fontName.family, fontName.style);
    if (!failedFontsByKey[key]) {
      failedFontsByKey[key] = {
        family: fontName.family,
        style: fontName.style,
        count: 0
      };
    }
    failedFontsByKey[key].count++;
  }

  // ../shared/utils.ts
  var mutationObserver = null;
  function setMutationObserver(observer) {
    mutationObserver = observer;
  }
  function recordMutation(operation, written) {
    try {
      if (mutationObserver) mutationObserver(operation, written);
    } catch (_) {
    }
  }
  function safeSet(node, key, value) {
    try {
      if (node[key] === value) {
        recordMutation("set", false);
        return false;
      }
      node[key] = value;
      recordMutation("set", true);
      return true;
    } catch (e) {
      return false;
    }
  }
  function safeResize(node, width, height) {
    try {
      if (node.width === width && node.height === height) {
        recordMutation("resize", false);
        return false;
      }
      node.resize(width, height);
      recordMutation("resize", true);
      return true;
    } catch (e) {
      return false;
    }
  }
  function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  function isSceneNode(node) {
    return !!(node && typeof node === "object" && typeof node.type === "string" && node.type !== "DOCUMENT" && node.type !== "PAGE");
  }

  // ../shared/connectorUtils.ts
  function normalizeConnectorPoint(point) {
    return {
      x: Number(point && point.x) || 0,
      y: Number(point && point.y) || 0
    };
  }
  function isSameConnectorAxis(start, end) {
    return Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01;
  }
  function shouldConnectorRouteStartHorizontal(start, end, startEndpoint, endEndpoint) {
    const startMagnet = startEndpoint && startEndpoint.magnet;
    if (startMagnet === "LEFT" || startMagnet === "RIGHT") return true;
    if (startMagnet === "TOP" || startMagnet === "BOTTOM") return false;
    const endMagnet = endEndpoint && endEndpoint.magnet;
    if (endMagnet === "TOP" || endMagnet === "BOTTOM") return true;
    if (endMagnet === "LEFT" || endMagnet === "RIGHT") return false;
    return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  }
  function dedupeConnectorPoints(points) {
    const result = [];
    for (const point of points) {
      const previous = result[result.length - 1];
      if (!previous || Math.abs(previous.x - point.x) >= 0.01 || Math.abs(previous.y - point.y) >= 0.01) {
        result.push(point);
      }
    }
    return result.length > 1 ? result : [points[0], points[points.length - 1]];
  }
  function getConnectorCornerRadius(points, index, requestedRadius) {
    const radius = Number(requestedRadius) || 0;
    if (radius <= 0) return 0;
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const previousLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const nextLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    return Math.min(radius, previousLength / 2, nextLength / 2);
  }
  function normalizeConnectorVectorStrokeCap(value) {
    if (value === "ARROW_EQUILATERAL" || value === "ARROW_LINES" || value === "TRIANGLE_FILLED" || value === "DIAMOND_FILLED" || value === "CIRCLE_FILLED" || value === "ROUND" || value === "SQUARE" || value === "NONE") {
      return value;
    }
    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
  }
  function normalizeMasterGoStrokeCapForFigma(value) {
    if (value === "NONE" || value === "ROUND" || value === "SQUARE" || value === "ARROW_LINES" || value === "ARROW_EQUILATERAL") {
      return value;
    }
    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW" || value === "TRIANGLE_FILLED") return "ARROW_EQUILATERAL";
    if (value === "ROUND_ARROW" || value === "RING") return "ROUND";
    if (value === "DIAMOND" || value === "DIAMOND_FILLED") return "ARROW_EQUILATERAL";
    if (value === "CIRCLE_FILLED") return "ROUND";
    return "NONE";
  }
  function createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType, bounds) {
    const startPoint = normalizeConnectorPoint(start);
    const endPoint = normalizeConnectorPoint(end);
    if (lineType !== "ELBOWED" || isSameConnectorAxis(startPoint, endPoint)) {
      return dedupeConnectorPoints([startPoint, endPoint]);
    }
    const sm = startEndpoint == null ? void 0 : startEndpoint.magnet;
    const em = endEndpoint == null ? void 0 : endEndpoint.magnet;
    if (bounds && sm === "BOTTOM" && endPoint.y < startPoint.y && em === "LEFT" && endPoint.x > startPoint.x && bounds.height > startPoint.y) {
      const edge = startPoint.x + (Number(startEndpoint == null ? void 0 : startEndpoint.width) || 0) / 2;
      const middleX = (edge + endPoint.x) / 2;
      return dedupeConnectorPoints([
        startPoint,
        { x: startPoint.x, y: bounds.height },
        { x: middleX, y: bounds.height },
        { x: middleX, y: endPoint.y },
        endPoint
      ]);
    }
    if (bounds && sm === "RIGHT" && em === "TOP" && endPoint.y < startPoint.y && endPoint.x > startPoint.x && endPoint.y > 0) {
      const edge = endPoint.x - (Number(endEndpoint == null ? void 0 : endEndpoint.width) || 0) / 2;
      const middleX = (startPoint.x + edge) / 2;
      return dedupeConnectorPoints([
        startPoint,
        { x: middleX, y: startPoint.y },
        { x: middleX, y: 0 },
        { x: endPoint.x, y: 0 },
        endPoint
      ]);
    }
    const horizontalFirst = shouldConnectorRouteStartHorizontal(startPoint, endPoint, startEndpoint, endEndpoint);
    const middlePoint = horizontalFirst ? { x: endPoint.x, y: startPoint.y } : { x: startPoint.x, y: endPoint.y };
    return dedupeConnectorPoints([startPoint, middlePoint, endPoint]);
  }

  // src/appliers/connector.ts
  function applyConnectorTextFallback(node, record, layers) {
    var _a, _b, _c;
    const props = record.props;
    if (node.type !== "VECTOR" || props.sourceType !== "CONNECTOR" && props.type !== "CONNECTOR" && props.restoreType !== "CONNECTOR") return 0;
    const labels = [];
    for (const childId of record.childIds || []) {
      const child = layers[childId];
      if (!child || ((_a = child.props) == null ? void 0 : _a.type) !== "TEXT" || (child.childIds || []).length > 0) continue;
      if (typeof child.props.characters !== "string") continue;
      labels.push(child.props.characters);
    }
    if (labels.length > 0) {
      node.name = `${(_c = (_b = props.name) != null ? _b : record.name) != null ? _c : node.name}_text in line: ${labels.join(" | ")}`;
    }
    return labels.length;
  }
  function normalizeConnectorMagnet(value) {
    if (value === "TOP" || value === "LEFT" || value === "BOTTOM" || value === "RIGHT" || value === "NONE" || value === "AUTO") {
      return value;
    }
    return null;
  }
  function resolveRestoredConnectorEndpointNodeId(sourceId) {
    if (typeof sourceId !== "string" || !sourceId) return null;
    if (state.restoredNodeIdBySourceId[sourceId]) {
      return state.restoredNodeIdBySourceId[sourceId];
    }
    return null;
  }
  function resolveConnectorEndpointNodeId(sourceId, allowExistingFallback) {
    return __async(this, null, function* () {
      const restoredId = resolveRestoredConnectorEndpointNodeId(sourceId);
      if (restoredId) return restoredId;
      if (!allowExistingFallback) return null;
      try {
        const existing = yield figma.getNodeByIdAsync(sourceId);
        if (existing && isSceneNode(existing)) return existing.id;
      } catch (error) {
      }
      return null;
    });
  }
  function hasUnresolvedConnectorEndpoint(endpoint) {
    return !!(endpoint && endpoint.endpointNodeId && !resolveRestoredConnectorEndpointNodeId(endpoint.endpointNodeId));
  }
  function normalizeConnectorStrokeCap(value) {
    if (value === "ARROW_EQUILATERAL" || value === "ARROW_LINES" || value === "TRIANGLE_FILLED" || value === "DIAMOND_FILLED" || value === "CIRCLE_FILLED" || value === "NONE") {
      return value;
    }
    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
  }
  function normalizeConnectorPosition(position) {
    if (!position || typeof position !== "object") return null;
    return {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0
    };
  }
  function getParentAbsoluteOrigin(parent) {
    if (!parent || parent.type === "PAGE") return { x: 0, y: 0 };
    const transform = parent.absoluteTransform;
    if (transform && transform[0] && transform[1]) {
      return {
        x: Number(transform[0][2]) || 0,
        y: Number(transform[1][2]) || 0
      };
    }
    return {
      x: Number(parent.x) || 0,
      y: Number(parent.y) || 0
    };
  }
  function getConnectorLocalPoint(data, parent, isStart) {
    const localKey = isStart ? "connectorStartLocal" : "connectorEndLocal";
    const localPoint = normalizeConnectorPosition(data[localKey]);
    if (localPoint) return localPoint;
    const endpoint = isStart ? data.connectorStart : data.connectorEnd;
    const absolutePoint = normalizeConnectorPosition(endpoint && endpoint.position);
    if (absolutePoint && parent && data.layout) {
      const parentOrigin = getParentAbsoluteOrigin(parent);
      return {
        x: absolutePoint.x - parentOrigin.x - (Number(data.layout.x) || 0),
        y: absolutePoint.y - parentOrigin.y - (Number(data.layout.y) || 0)
      };
    }
    const layout = data.layout || {};
    return isStart ? { x: 0, y: 0 } : { x: Number(layout.width) || 0, y: Number(layout.height) || 0 };
  }
  function createConnectorVectorNetworkFromData(data, parent) {
    const start = getConnectorLocalPoint(data, parent, true);
    const end = getConnectorLocalPoint(data, parent, false);
    const points = createConnectorRoutePoints(
      start,
      end,
      data.connectorStart,
      data.connectorEnd,
      data.connectorLineType || "ELBOWED",
      data.layout
    );
    const vertices = points.map((point, index) => {
      var _a, _b, _c;
      const vertex = { x: point.x, y: point.y };
      if (index === 0) {
        vertex.strokeCap = normalizeConnectorVectorStrokeCap(data.connectorStartStrokeCap || "NONE");
      }
      if (index === points.length - 1) {
        vertex.strokeCap = normalizeConnectorVectorStrokeCap(data.connectorEndStrokeCap || "NONE");
      }
      if (index > 0 && index < points.length - 1) {
        const radius = getConnectorCornerRadius(points, index, (_c = (_b = data.connectorCornerRadius) != null ? _b : (_a = data.corner) == null ? void 0 : _a.cornerRadius) != null ? _c : 0);
        if (radius > 0) vertex.cornerRadius = radius;
      }
      return vertex;
    });
    const segments = [];
    for (let index = 0; index < points.length - 1; index++) {
      segments.push({ start: index, end: index + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    }
    return { vertices, segments, regions: [] };
  }
  function normalizeConnectorEndpointForFigma(endpoint, allowExistingFallback) {
    return __async(this, null, function* () {
      if (!endpoint || typeof endpoint !== "object") return null;
      const endpointNodeId = yield resolveConnectorEndpointNodeId(endpoint.endpointNodeId, allowExistingFallback);
      const position = normalizeConnectorPosition(endpoint.position);
      if (endpointNodeId) {
        const magnet = normalizeConnectorMagnet(endpoint.magnet);
        if (magnet) return { endpointNodeId, magnet };
        if (position) return { endpointNodeId, position };
        return { endpointNodeId, magnet: "AUTO" };
      }
      if (position) return { position };
      return null;
    });
  }
  function applyConnectorProperties(node, data, deferUnresolved) {
    return __async(this, null, function* () {
      var _a, _b;
      safeSet(node, "connectorLineType", data.connectorLineType || "ELBOWED");
      safeSet(node, "cornerRadius", (_b = data.connectorCornerRadius) != null ? _b : (_a = data.corner) == null ? void 0 : _a.cornerRadius);
      if (data.connectorStartStrokeCap) {
        safeSet(node, "connectorStartStrokeCap", normalizeConnectorStrokeCap(data.connectorStartStrokeCap));
      }
      if (data.connectorEndStrokeCap) {
        safeSet(node, "connectorEndStrokeCap", normalizeConnectorStrokeCap(data.connectorEndStrokeCap));
      }
      const start = yield normalizeConnectorEndpointForFigma(data.connectorStart, !deferUnresolved);
      const end = yield normalizeConnectorEndpointForFigma(data.connectorEnd, !deferUnresolved);
      if (start) safeSet(node, "connectorStart", start);
      if (end) safeSet(node, "connectorEnd", end);
      if (deferUnresolved && (hasUnresolvedConnectorEndpoint(data.connectorStart) || hasUnresolvedConnectorEndpoint(data.connectorEnd))) {
        state.deferredConnectorRestores.push({ node, data });
      }
    });
  }
  function applyDeferredConnectorRestores() {
    return __async(this, null, function* () {
      if (state.deferredConnectorRestores.length === 0) return;
      const deferred = state.deferredConnectorRestores;
      state.deferredConnectorRestores = [];
      for (const item of deferred) {
        if (!item.node || item.node.removed) continue;
        yield applyConnectorProperties(item.node, item.data, false);
      }
    });
  }

  // src/deferredLayout.ts
  var INTERNAL_PROPS_PREFIX = "[PROPS]";
  var SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
  var POSTPROCESS_YIELD_INTERVAL_MS = 85;
  function deferLayoutRestore(node, layout, isGroup) {
    if (!node || !layout || !isSceneNode(node)) return;
    state.deferredLayoutRestores.push({ node, layout, isGroup });
    if (isAutoSpaceAlongPrimaryAxis(layout)) {
      state.singleChildAutoSpaceCandidates.push(node);
    }
    if (state.activeRestoreStats) {
      state.activeRestoreStats.deferredLayoutNodeCount++;
    }
  }
  function applyDeferredLayoutRestores(progress) {
    return __async(this, null, function* () {
      if (state.deferredLayoutRestores.length === 0) return;
      const records = state.deferredLayoutRestores;
      state.deferredLayoutRestores = [];
      refreshNativeGroupOffsets(records, state.nativeGroupOffsetByNodeId);
      const total = Math.max(1, records.length * 6);
      let done = 0;
      let lastYieldAt = Date.now();
      for (const record of records) {
        if (!isRemovedNode(record.node) && !record.isGroup && "layoutMode" in record.node) applyDeferredNodeAutoLayout(record);
        done++;
        const pending = maybeYieldPostprocess(done, total, lastYieldAt, progress);
        if (pending) lastYieldAt = yield pending;
      }
      const parentRecords = [];
      const fixedRecords = [];
      const stretchRecords = [];
      const positionRecords = [];
      for (const record of records) {
        const { node, layout, isGroup } = record;
        if (!isRemovedNode(node)) {
          const parent = node.parent;
          if (parent && hasAutoLayout(parent)) parentRecords.push(record);
          if (!isGroup) {
            if (hasAutoLayout(node) && layout.width !== void 0 && layout.height !== void 0) fixedRecords.push(record);
            if (parent && state.restoredLayoutByNodeId[parent.id]) {
              const constraints = "constraints" in node ? node.constraints : null;
              if (normalizeLayoutMode(layout.layoutMode) === "NONE" && ((constraints == null ? void 0 : constraints.horizontal) === "STRETCH" || (constraints == null ? void 0 : constraints.vertical) === "STRETCH")) stretchRecords.push(record);
              if (layout.layoutPositioning === "ABSOLUTE" && ((constraints == null ? void 0 : constraints.horizontal) === "MAX" || (constraints == null ? void 0 : constraints.horizontal) === "CENTER" || (constraints == null ? void 0 : constraints.vertical) === "MAX" || (constraints == null ? void 0 : constraints.vertical) === "CENTER")) positionRecords.push(record);
            }
          }
        }
        const pending = maybeYieldPostprocess(done, total, lastYieldAt, progress);
        if (pending) lastYieldAt = yield pending;
      }
      const phases = [
        { records: parentRecords, apply: applyDeferredParentAutoLayout },
        { records: fixedRecords, apply: finalizeDeferredAutoLayout },
        // Auto-layout activation temporarily changes parent bounds. Restore
        // source insets after the first fixed-size pass has settled them.
        { records: stretchRecords, apply: restoreAbsoluteStretchBox },
        // Stretch correction can resize an inner fixed auto-layout frame
        // through constraints. Reapply its explicit size before pinning.
        { records: fixedRecords, apply: finalizeDeferredAutoLayout },
        { records: positionRecords, apply: restoreAbsoluteConstrainedPosition }
      ];
      for (const phase of phases) {
        done += records.length - phase.records.length;
        for (const record of phase.records) {
          phase.apply(record);
          done++;
          const pending = maybeYieldPostprocess(done, total, lastYieldAt, progress);
          if (pending) lastYieldAt = yield pending;
        }
        if (phase.records.length === 0) {
          const pending = maybeYieldPostprocess(done, total, lastYieldAt, progress);
          if (pending) lastYieldAt = yield pending;
        }
      }
    });
  }
  function isRemovedNode(node) {
    return !node || !!node.removed;
  }
  function normalizeLayoutMode(value) {
    if (value === "ROW") return "HORIZONTAL";
    if (value === "COLUMN") return "VERTICAL";
    return value;
  }
  function normalizeAxisAlign(value) {
    if (value === "START" || value === "FLEX_START") return "MIN";
    if (value === "END" || value === "FLEX_END") return "MAX";
    if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
    return value;
  }
  function normalizeAxisSizingMode(value) {
    if (value === "HUG") return "AUTO";
    if (value === "FILL") return "FIXED";
    return value;
  }
  function normalizeLayoutAlign(value) {
    if (value === "STRETCH" || value === "INHERIT") return value;
    return normalizeAxisAlign(value);
  }
  function preserveAbsoluteAlignedBox(layout) {
    if (layout.layoutPositioning !== "ABSOLUTE" || !(layout.x < 0) || normalizeAxisAlign(layout.primaryAxisAlignItems) !== "MAX" || normalizeAxisSizingMode(layout.primaryAxisSizingMode) !== "AUTO") return layout;
    return __spreadProps(__spreadValues({}, layout), { primaryAxisSizingMode: "FIXED" });
  }
  function applyDeferredNodeAutoLayout(record) {
    const { node, isGroup } = record;
    const layout = preserveAbsoluteAlignedBox(record.layout);
    if (isRemovedNode(node) || isGroup || !("layoutMode" in node)) return;
    let applied = false;
    if (layout.layoutMode) {
      safeSet(node, "layoutMode", normalizeLayoutMode(layout.layoutMode));
      applied = true;
    }
    for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
      const limit = normalizeMasterGoSizeLimit(layout[key]);
      if (limit !== void 0 && key in node) safeSet(node, key, limit);
    }
    if (hasAutoLayout(node)) {
      if (layout.layoutWrap !== void 0) safeSet(node, "layoutWrap", layout.layoutWrap);
      if (layout.counterAxisSpacing !== void 0) safeSet(node, "counterAxisSpacing", layout.counterAxisSpacing);
      if (layout.primaryAxisSizingMode) {
        safeSet(node, "primaryAxisSizingMode", normalizeAxisSizingMode(layout.primaryAxisSizingMode));
        applied = true;
      }
      if (layout.counterAxisSizingMode) {
        safeSet(node, "counterAxisSizingMode", normalizeAxisSizingMode(layout.counterAxisSizingMode));
        applied = true;
      }
      if (layout.itemSpacing !== void 0) {
        safeSet(node, "itemSpacing", layout.itemSpacing);
        applied = true;
      }
      if (layout.paddingLeft !== void 0) {
        safeSet(node, "paddingLeft", layout.paddingLeft);
        applied = true;
      }
      if (layout.paddingRight !== void 0) {
        safeSet(node, "paddingRight", layout.paddingRight);
        applied = true;
      }
      if (layout.paddingTop !== void 0) {
        safeSet(node, "paddingTop", layout.paddingTop);
        applied = true;
      }
      if (layout.paddingBottom !== void 0) {
        safeSet(node, "paddingBottom", layout.paddingBottom);
        applied = true;
      }
      if (layout.primaryAxisAlignItems) {
        safeSet(node, "primaryAxisAlignItems", normalizeAxisAlign(layout.primaryAxisAlignItems));
        applied = true;
      }
      if (layout.counterAxisAlignItems) {
        safeSet(node, "counterAxisAlignItems", normalizeAxisAlign(layout.counterAxisAlignItems));
        applied = true;
      }
      if (layout.counterAxisAlignContent) {
        safeSet(node, "counterAxisAlignContent", layout.counterAxisAlignContent);
        applied = true;
      }
      if (layout.itemReverseZIndex !== void 0) {
        safeSet(node, "itemReverseZIndex", layout.itemReverseZIndex);
        applied = true;
      }
      if (layout.strokesIncludedInLayout !== void 0) {
        safeSet(node, "strokesIncludedInLayout", layout.strokesIncludedInLayout);
        applied = true;
      }
    }
    if (applied && state.activeRestoreStats) {
      state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
  }
  function applyDeferredParentAutoLayout(record) {
    const { node, layout } = record;
    if (isRemovedNode(node) || !hasAutoLayoutParent(node)) return;
    let applied = false;
    if (layout.layoutPositioning) {
      safeSet(node, "layoutPositioning", layout.layoutPositioning);
      applied = true;
    }
    if (layout.layoutAlign) {
      safeSet(node, "layoutAlign", rotatedStretchSize(layout, node.parent) ? "INHERIT" : normalizeLayoutAlign(layout.layoutAlign));
      applied = true;
    }
    if (layout.layoutGrow !== void 0) {
      safeSet(node, "layoutGrow", layout.layoutGrow);
      applied = true;
    }
    const hasRelativeTransform = hasFiniteRelativeTransform(layout);
    if (hasRelativeTransform) {
      safeSet(node, "relativeTransform", layout.relativeTransform);
      applied = true;
    } else if (layout.x !== void 0) {
      safeSet(node, "x", layout.x);
      applied = true;
    }
    if (!hasRelativeTransform && layout.y !== void 0) {
      safeSet(node, "y", layout.y);
      applied = true;
    }
    if (applied && state.activeRestoreStats) {
      state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
  }
  function finalizeDeferredAutoLayout(record) {
    const { node, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !hasAutoLayout(node)) return;
    const layout = preserveAbsoluteAlignedBox(normalizeDeferredLayoutForNativeGroupParent(node, record.layout));
    if (layout.width === void 0 || layout.height === void 0 || !shouldRestoreFixedSize(node, layout)) return;
    const rotated = rotatedStretchSize(layout, node.parent);
    if (rotated) {
      safeSet(node, "layoutAlign", "INHERIT");
      safeSet(node, "primaryAxisSizingMode", "FIXED");
      safeSet(node, "counterAxisSizingMode", "FIXED");
      safeResize(node, rotated.width, rotated.height);
      return;
    }
    const mode = normalizeLayoutMode(layout.layoutMode || node.layoutMode);
    const primaryFixed = normalizeAxisSizingMode(layout.primaryAxisSizingMode || node.primaryAxisSizingMode) === "FIXED";
    const counterFixed = normalizeAxisSizingMode(layout.counterAxisSizingMode || node.counterAxisSizingMode) === "FIXED";
    const horizontalPrimary = mode === "HORIZONTAL";
    const widthFixed = horizontalPrimary ? primaryFixed : counterFixed;
    const heightFixed = horizontalPrimary ? counterFixed : primaryFixed;
    const parentMode = hasAutoLayoutParent(node) && layout.layoutPositioning !== "ABSOLUTE" ? node.parent.layoutMode : "NONE";
    const fillWidth = parentMode === "VERTICAL" && layout.layoutAlign === "STRETCH" || parentMode === "HORIZONTAL" && layout.layoutGrow === 1;
    const fillHeight = parentMode === "HORIZONTAL" && layout.layoutAlign === "STRETCH" || parentMode === "VERTICAL" && layout.layoutGrow === 1;
    safeResize(node, widthFixed && !fillWidth ? layout.width : node.width, heightFixed && !fillHeight ? layout.height : node.height);
    if (layout.primaryAxisSizingMode) safeSet(node, "primaryAxisSizingMode", normalizeAxisSizingMode(layout.primaryAxisSizingMode));
    if (layout.counterAxisSizingMode) safeSet(node, "counterAxisSizingMode", normalizeAxisSizingMode(layout.counterAxisSizingMode));
    if (parentMode !== "NONE") {
      if (layout.layoutAlign !== void 0) safeSet(node, "layoutAlign", normalizeLayoutAlign(layout.layoutAlign));
      if (layout.layoutGrow !== void 0) safeSet(node, "layoutGrow", layout.layoutGrow);
    }
    if (hasFiniteRelativeTransform(layout)) {
      safeSet(node, "relativeTransform", layout.relativeTransform);
    } else {
      if (layout.x !== void 0) safeSet(node, "x", layout.x);
      if (layout.y !== void 0) safeSet(node, "y", layout.y);
    }
  }
  function rotatedStretchSize(layout, parent) {
    const m = layout.relativeTransform;
    if (layout.layoutAlign !== "STRETCH" || layout.layoutPositioning === "ABSOLUTE" || !m || Math.abs(m[0][0]) > 1e-6 || Math.abs(m[1][1]) > 1e-6 || Math.abs(Math.abs(m[0][1]) - 1) > 1e-6 || Math.abs(Math.abs(m[1][0]) - 1) > 1e-6 || !Number.isFinite(layout.width) || !Number.isFinite(layout.height)) return null;
    if ((parent == null ? void 0 : parent.layoutMode) === "VERTICAL") {
      return { width: Math.max(0.01, parent.width - (parent.paddingLeft || 0) - (parent.paddingRight || 0)), height: layout.height };
    }
    if ((parent == null ? void 0 : parent.layoutMode) === "HORIZONTAL") {
      return { width: layout.width, height: Math.max(0.01, parent.height - (parent.paddingTop || 0) - (parent.paddingBottom || 0)) };
    }
    return null;
  }
  function absoluteStretchSize(layout, parentLayout, parent, constraints) {
    const parentMode = normalizeLayoutMode((parent == null ? void 0 : parent.layoutMode) || (parentLayout == null ? void 0 : parentLayout.layoutMode));
    if (layout.layoutPositioning !== "ABSOLUTE" && parentMode !== "NONE" || normalizeLayoutMode(layout.layoutMode) !== "NONE" || !parentLayout) return null;
    const dimension = (axis, key) => {
      if ((constraints == null ? void 0 : constraints[axis]) !== "STRETCH" || !Number.isFinite(layout[key]) || !Number.isFinite(parentLayout[key])) return null;
      return Math.max(0.01, layout[key] + parent[key] - parentLayout[key]);
    };
    return { width: dimension("horizontal", "width"), height: dimension("vertical", "height") };
  }
  function absoluteConstrainedPosition(layout, parentLayout, parent, node) {
    var _a;
    if (layout.layoutPositioning !== "ABSOLUTE" || !parentLayout) return null;
    const result = {};
    for (const [axis, size, position] of [["horizontal", "width", "x"], ["vertical", "height", "y"]]) {
      if (![layout[position], layout[size], parentLayout[size], parent[size], node[size]].every(Number.isFinite)) continue;
      const constraint = (_a = node.constraints) == null ? void 0 : _a[axis];
      const delta = parent[size] - parentLayout[size] - (node[size] - layout[size]);
      if (constraint === "MAX") result[position] = layout[position] + delta;
      if (constraint === "CENTER") result[position] = layout[position] + delta / 2;
    }
    return result;
  }
  function restoreAbsoluteConstrainedPosition(record) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !node.parent) return;
    const position = absoluteConstrainedPosition(layout, state.restoredLayoutByNodeId[node.parent.id], node.parent, node);
    if ((position == null ? void 0 : position.x) !== void 0) safeSet(node, "x", position.x);
    if ((position == null ? void 0 : position.y) !== void 0) safeSet(node, "y", position.y);
  }
  function restoreAbsoluteStretchBox(record) {
    var _a, _b;
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !("constraints" in node) || !node.parent) return;
    const parent = node.parent;
    const size = absoluteStretchSize(layout, state.restoredLayoutByNodeId[parent.id], parent, node.constraints);
    if (!size || size.width === null && size.height === null) return;
    safeResize(node, (_a = size.width) != null ? _a : node.width, (_b = size.height) != null ? _b : node.height);
    if (hasFiniteRelativeTransform(layout)) safeSet(node, "relativeTransform", layout.relativeTransform);
  }
  function refreshNativeGroupOffsets(records, offsets) {
    const visited = /* @__PURE__ */ new Set();
    for (const { node } of records) {
      if (isRemovedNode(node)) continue;
      const parent = node.parent;
      if (!parent || parent.type !== "GROUP" || !offsets[parent.id] || visited.has(parent.id)) continue;
      visited.add(parent.id);
      if (Number.isFinite(parent.x) && Number.isFinite(parent.y)) {
        offsets[parent.id] = { x: parent.x, y: parent.y };
      }
    }
  }
  function normalizeDeferredLayoutForNativeGroupParent(node, layout) {
    const parent = node.parent;
    if (!parent || parent.type !== "GROUP") return layout;
    const offset = state.nativeGroupOffsetByNodeId[parent.id];
    if (!offset || !offset.x && !offset.y) return layout;
    const normalized = __spreadValues({}, layout);
    if (layout.x !== void 0) normalized.x = (layout.x || 0) + offset.x;
    if (layout.y !== void 0) normalized.y = (layout.y || 0) + offset.y;
    if (hasFiniteRelativeTransform(layout)) {
      normalized.relativeTransform = [
        [...layout.relativeTransform[0]],
        [...layout.relativeTransform[1]]
      ];
      normalized.relativeTransform[0][2] += offset.x;
      normalized.relativeTransform[1][2] += offset.y;
    }
    return normalized;
  }
  function hasFiniteRelativeTransform(layout) {
    return Array.isArray(layout == null ? void 0 : layout.relativeTransform) && Array.isArray(layout.relativeTransform[0]) && Array.isArray(layout.relativeTransform[1]) && Number.isFinite(layout.relativeTransform[0][0]) && Number.isFinite(layout.relativeTransform[0][1]) && Number.isFinite(layout.relativeTransform[0][2]) && Number.isFinite(layout.relativeTransform[1][0]) && Number.isFinite(layout.relativeTransform[1][1]) && Number.isFinite(layout.relativeTransform[1][2]);
  }
  function applySingleChildAutoSpaceAlignmentFix(node, layout) {
    if (!isAutoSpaceAlongPrimaryAxis(layout)) return;
    if (getRestorableChildCount(node) !== 1) return;
    safeSet(node, "primaryAxisAlignItems", "MIN");
  }
  function applyDeferredSingleChildAutoSpaceAlignmentFixes(progress) {
    return __async(this, null, function* () {
      const candidates = state.singleChildAutoSpaceCandidates;
      state.singleChildAutoSpaceCandidates = [];
      const total = Math.max(1, candidates.length);
      let done = 0;
      let lastYieldAt = Date.now();
      for (const node of candidates) {
        if (!isRemovedNode(node) && isSceneNode(node)) {
          const layout = state.restoredLayoutByNodeId[node.id];
          if (layout && hasAutoLayout(node)) applySingleChildAutoSpaceAlignmentFix(node, layout);
        }
        done++;
        const pending = maybeYieldPostprocess(done, total, lastYieldAt, progress);
        if (pending) lastYieldAt = yield pending;
      }
    });
  }
  function maybeYieldPostprocess(done, total, lastYieldAt, progress) {
    const now = Date.now();
    if (done < total && now - lastYieldAt < POSTPROCESS_YIELD_INTERVAL_MS) {
      return null;
    }
    return (() => __async(null, null, function* () {
      if (progress) yield progress(done, total);
      yield yieldToEventLoop();
      return Date.now();
    }))();
  }
  function isAutoSpaceAlongPrimaryAxis(layout) {
    return normalizeAxisAlign(layout.primaryAxisAlignItems) === "SPACE_BETWEEN" || normalizeAxisAlign(layout.mainAxisAlignItems) === "SPACE_BETWEEN";
  }
  function getRestorableChildCount(node) {
    if (!("children" in node)) return 0;
    let count = 0;
    for (const child of node.children) {
      if (!child.name.startsWith(INTERNAL_PROPS_PREFIX) && !child.name.startsWith(SIBLING_PROPS_PREFIX)) count++;
    }
    return count;
  }
  function hasAutoLayout(node) {
    return "layoutMode" in node && node.layoutMode !== "NONE";
  }
  function hasAutoLayoutParent(node) {
    const parent = node.parent;
    return !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  }
  function shouldRestoreFixedSize(node, layout) {
    if (!hasAutoLayout(node)) return true;
    const primarySizing = normalizeAxisSizingMode(layout.primaryAxisSizingMode || node.primaryAxisSizingMode);
    const counterSizing = normalizeAxisSizingMode(layout.counterAxisSizingMode || node.counterAxisSizingMode);
    return primarySizing === "FIXED" || counterSizing === "FIXED";
  }
  function applyAspectRatioLock(node, shouldLock) {
    if (typeof node.lockAspectRatio === "function" && typeof node.unlockAspectRatio === "function") {
      try {
        if (shouldLock) {
          node.lockAspectRatio();
        } else if (node.targetAspectRatio) {
          node.unlockAspectRatio();
        }
      } catch (e) {
      }
    }
  }

  // src/importFontPreflight.ts
  var FontPreflightTimeout = class extends Error {
  };
  var NON_FALLBACK_FONT_TIMEOUT_MS = 5e3;
  function isMandatoryFallbackFont(font) {
    return font.family === "Inter" && font.style === "Regular";
  }
  function waitForFont(promise, font, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new FontPreflightTimeout(
        `Figma \u5B57\u4F53\u670D\u52A1\u672A\u54CD\u5E94\uFF1A${font.family} \xB7 ${font.style}\u3002\u8BF7\u786E\u8BA4\u5B57\u4F53\u8F85\u52A9\u7A0B\u5E8F\u5DF2\u542F\u52A8\u540E\u91CD\u8BD5\u3002`
      )), timeoutMs);
      promise.then(() => {
        clearTimeout(timer);
        resolve();
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  function preflightImportFonts(requests, onProgress, timeoutMs = 3e4) {
    return __async(this, null, function* () {
      const counts = { loaded: 0, failed: 0, missing: 0 };
      if (!Array.isArray(requests) || requests.length === 0) return counts;
      const requested = /* @__PURE__ */ new Map();
      for (const font of requests) {
        if (font && typeof font.family === "string" && font.family && typeof font.style === "string" && font.style) {
          requested.set(getFontKey(font.family, font.style), { family: font.family, style: font.style });
        }
      }
      if (requested.size === 0) return counts;
      yield waitForFont(ensureAvailableFontsLoaded(), { family: "\u5B57\u4F53\u76EE\u5F55", style: "\u8BFB\u53D6" }, timeoutMs);
      const resolved = /* @__PURE__ */ new Map();
      requested.forEach((font) => {
        const available = resolveAvailableFontName(font) || (isMandatoryFallbackFont(font) ? font : null);
        if (available) resolved.set(getFontKey(available.family, available.style), available);
        else counts.missing++;
      });
      let index = 0;
      for (const font of resolved.values()) {
        onProgress(font, ++index, resolved.size);
        const perFontTimeout = isMandatoryFallbackFont(font) ? timeoutMs : Math.min(timeoutMs, NON_FALLBACK_FONT_TIMEOUT_MS);
        try {
          yield waitForFont(loadFontCached(font), font, perFontTimeout);
          counts.loaded++;
        } catch (error) {
          if (error instanceof FontPreflightTimeout) {
            if (isMandatoryFallbackFont(font)) throw error;
            cacheFontLoadFailure(font, error);
          }
          counts.failed++;
        }
      }
      return counts;
    });
  }

  // src/importReportStorage.ts
  var STORAGE_KEY = "mastergo2figma.receive.lastImportReport.v1";
  var MAX_REPORT_BYTES = 1024 * 1024;
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
  }
  function numericMap(value) {
    if (!object(value)) throw new Error("Expected numeric summary map");
    const result = /* @__PURE__ */ Object.create(null);
    for (const key of Object.keys(value)) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) throw new Error("Invalid summary number");
      result[key] = value[key];
    }
    return result;
  }
  function timingSummary(value) {
    if (value === null) return null;
    if (!object(value)) throw new Error("Invalid client timing summary");
    const result = {};
    for (const key of ["totalsMs", "counts", "bytes"]) if (value[key] !== void 0) result[key] = numericMap(value[key]);
    for (const key of ["startedAt", "selectedPageCount", "selectedLayerCount"]) {
      if (value[key] !== void 0) Object.assign(result, numericMap({ [key]: value[key] }));
    }
    if (value.transferId !== void 0) {
      if (typeof value.transferId !== "string") throw new Error("Invalid transfer identity");
      result.transferId = value.transferId;
    }
    return result;
  }
  function performanceSummary(value) {
    if (!object(value) || value.schemaVersion !== 1) throw new Error("Invalid performance report schema");
    const result = { schemaVersion: 1 };
    for (const key of ["receiverVersion", "creationCountMeaning", "sourceDocumentName", "targetDocumentName", "targetFileKey"]) {
      if (value[key] === void 0) continue;
      if (value[key] !== null && typeof value[key] !== "string") throw new Error("Invalid performance identity");
      result[key] = value[key];
    }
    for (const key of ["totalMs", "preparationMs", "endToEndActiveMs", "mainMs", "sourceRecordCount", "apiCreationCount", "parseStartToCompleteMs"]) {
      if (value[key] !== void 0) Object.assign(result, numericMap({ [key]: value[key] }));
    }
    for (const key of ["stagesMs", "stageCounts"]) if (value[key] !== void 0) result[key] = numericMap(value[key]);
    if (value.restoreStats !== void 0) {
      if (value.restoreStats === null) result.restoreStats = null;
      else {
        if (!object(value.restoreStats)) throw new Error("Invalid restore statistics");
        const stats = {};
        for (const key of Object.keys(value.restoreStats)) {
          if (key === "creationCounts") stats.creationCounts = numericMap(value.restoreStats.creationCounts);
          else Object.assign(stats, numericMap({ [key]: value.restoreStats[key] }));
        }
        result.restoreStats = stats;
      }
    }
    for (const key of ["clientTimings", "preparationClientTimings"]) {
      if (value[key] !== void 0) result[key] = timingSummary(value[key]);
    }
    if (value.zipSources !== void 0) {
      if (!Array.isArray(value.zipSources)) throw new Error("Invalid ZIP statistics");
      result.zipSources = value.zipSources.map(numericMap);
    }
    if (value.textChildContainerDetails !== void 0) {
      if (!Array.isArray(value.textChildContainerDetails)) throw new Error("Invalid text container details");
      result.textChildContainerDetails = value.textChildContainerDetails.map((item) => {
        if (!object(item) || ["sourceId", "name", "pageName"].some((key) => typeof item[key] !== "string") || !Number.isInteger(item.childCount) || item.childCount < 0) throw new Error("Invalid text container detail");
        return { sourceId: item.sourceId, name: item.name, childCount: item.childCount, pageName: item.pageName };
      });
    }
    if (value.retainedImport !== void 0) {
      const retained = value.retainedImport;
      if (!object(retained) || ["partial", "failed"].indexOf(retained.status) < 0 || !Array.isArray(retained.pages) || !Array.isArray(retained.cleanupWarnings) || retained.cleanupWarnings.some((item) => typeof item !== "string")) {
        throw new Error("Invalid retained import summary");
      }
      const summary = { status: retained.status, cleanupWarnings: retained.cleanupWarnings.slice() };
      for (const key of [
        "completedPageCount",
        "partialPageCount",
        "pendingPageCount",
        "retainedPageCount",
        "completedSourceRecordCount",
        "reportedRestoredRecordCount",
        "totalSourceRecordCount"
      ]) {
        if (!Number.isInteger(retained[key]) || retained[key] < 0) throw new Error("Invalid retained import count");
        summary[key] = retained[key];
      }
      summary.pages = retained.pages.map((page) => {
        if (!object(page) || typeof page.sourcePageId !== "string" || typeof page.sourcePageName !== "string" || ["targetPageId", "targetPageName"].some((key) => page[key] !== null && typeof page[key] !== "string") || ["completed", "partial", "pending"].indexOf(page.status) < 0 || !Number.isInteger(page.sourceRecordCount) || page.sourceRecordCount < 0) {
          throw new Error("Invalid retained page summary");
        }
        return {
          sourcePageId: page.sourcePageId,
          sourcePageName: page.sourcePageName,
          targetPageId: page.targetPageId,
          targetPageName: page.targetPageName,
          status: page.status,
          sourceRecordCount: page.sourceRecordCount
        };
      });
      result.retainedImport = summary;
    }
    return result;
  }
  function reportSummary(value) {
    try {
      if (!object(value) || value.schemaVersion !== 1 || typeof value.sourceName !== "string" || !value.sourceName.trim() || typeof value.completedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.completedAt) || !Number.isFinite(Date.parse(value.completedAt)) || !object(value.target)) return null;
      for (const key of ["documentName", "fileKey"]) {
        if (value.target[key] !== null && typeof value.target[key] !== "string") return null;
      }
      let size = 0;
      for (const character of JSON.stringify(value)) {
        const point = character.codePointAt(0);
        size += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
        if (size > MAX_REPORT_BYTES) return null;
      }
      const summary = {
        schemaVersion: 1,
        sourceName: value.sourceName,
        completedAt: value.completedAt,
        target: { documentName: value.target.documentName, fileKey: value.target.fileKey },
        // Keep timing/counter summaries only, never ZIP bytes or layer payloads.
        performanceReport: performanceSummary(value.performanceReport)
      };
      return JSON.parse(JSON.stringify(summary));
    } catch (_) {
      return null;
    }
  }
  function saveImportReport(_0, _1) {
    return __async(this, arguments, function* (storage, value, warn = console.warn) {
      const summary = reportSummary(value);
      if (!summary) {
        warn("Unable to save invalid or oversized import report");
        return false;
      }
      try {
        yield storage.setAsync(STORAGE_KEY, summary);
        return true;
      } catch (error) {
        warn("Unable to save last import report", error);
        return false;
      }
    });
  }
  function readImportReport(_0) {
    return __async(this, arguments, function* (storage, warn = console.warn) {
      try {
        const value = yield storage.getAsync(STORAGE_KEY);
        if (value === null || value === void 0) return null;
        const summary = reportSummary(value);
        if (!summary) warn("Ignoring invalid or oversized last import report");
        return summary;
      } catch (error) {
        warn("Unable to read last import report", error);
        return null;
      }
    });
  }

  // src/appliers/connectorSvg.ts
  function localConnectorSvg(data) {
    var _a, _b, _c, _d;
    const source = data == null ? void 0 : data.connectorSvg;
    if ((data == null ? void 0 : data.sourceType) !== "CONNECTOR" || typeof (source == null ? void 0 : source.markup) !== "string" || ((_b = (_a = data.blend) == null ? void 0 : _a.opacity) != null ? _b : 1) !== 1 || ((_d = (_c = data.blend) == null ? void 0 : _c.effects) == null ? void 0 : _d.length)) return null;
    const outer = source.markup.match(/^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i);
    if (!outer || /<(?:image|filter|mask|clipPath|text)\b/i.test(source.markup)) return null;
    const view = outer[1].match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
    const box = view == null ? void 0 : view[1].trim().split(/[\s,]+/).map(Number);
    const { width, height } = data.layout || {};
    const offset = source.offset;
    if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[0] !== 0 || box[1] !== 0 || ![width, height, offset == null ? void 0 : offset.x, offset == null ? void 0 : offset.y, source.width, source.height].every(Number.isFinite) || width <= 0 || height <= 0 || Math.abs(box[2] - source.width) >= 1 || Math.abs(box[3] - source.height) >= 1) return null;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g transform="translate(${offset.x},${offset.y})">${outer[2]}</g></svg>`;
  }

  // src/appliers/ellipseArcSvg.ts
  function localEllipseArcSvg(data) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if ((data == null ? void 0 : data.sourceType) !== "ELLIPSE" || typeof data.arcSvgMarkup !== "string") return null;
    if (((_b = (_a = data.blend) == null ? void 0 : _a.opacity) != null ? _b : 1) !== 1 || ((_d = (_c = data.blend) == null ? void 0 : _c.effects) == null ? void 0 : _d.length)) return null;
    const svg = data.arcSvgMarkup;
    const outer = svg.match(/^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i);
    if (!outer || /<(?:image|filter|mask|clipPath)\b/i.test(svg)) return null;
    const view = outer[1].match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
    const box = view == null ? void 0 : view[1].trim().split(/[\s,]+/).map(Number);
    const layout = data.layout;
    const m = layout == null ? void 0 : layout.relativeTransform;
    if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[0] !== 0 || box[1] !== 0 || !Number.isFinite(layout == null ? void 0 : layout.width) || !Number.isFinite(layout == null ? void 0 : layout.height) || Math.abs(box[2] - layout.width) > 0.01 || Math.abs(box[3] - layout.height) > 0.01 || !(box[2] > 0) || !(box[3] > 0) || !m || ![(_e = m[0]) == null ? void 0 : _e[0], (_f = m[0]) == null ? void 0 : _f[1], (_g = m[1]) == null ? void 0 : _g[0], (_h = m[1]) == null ? void 0 : _h[1]].every(Number.isFinite) || Math.abs(m[0][1]) > 1e-6 || Math.abs(m[1][0]) > 1e-6 || Math.abs(Math.abs(m[0][0]) - 1) > 1e-6 || Math.abs(Math.abs(m[1][1]) - 1) > 1e-6) return null;
    const sx = m[0][0] < 0 ? -1 : 1, sy = m[1][1] < 0 ? -1 : 1;
    const tx = sx < 0 ? box[2] : 0, ty = sy < 0 ? box[3] : 0;
    return `<svg${outer[1]}><g transform="matrix(${sx},0,0,${sy},${tx},${ty})">${outer[2]}</g></svg>`;
  }

  // src/appliers/roundedArc.ts
  function roundedArcNetwork(data) {
    var _a, _b;
    const arc = data.arcData;
    const radius = Number(data.arcCornerRadius);
    const width = Number((_a = data.layout) == null ? void 0 : _a.width), height = Number((_b = data.layout) == null ? void 0 : _b.height);
    if (!arc || !(radius > 0) || !(width > 0) || !(height > 0)) return null;
    const sweep = arc.endingAngle - arc.startingAngle;
    if (!Number.isFinite(sweep) || Math.abs(sweep) < 1e-8 || Math.abs(sweep) >= Math.PI * 2 - 1e-6) return null;
    const vertices = [], segments = [];
    const cx = width / 2, cy = height / 2;
    const point = (a, scale) => ({ x: cx + cx * scale * Math.cos(a), y: cy + cy * scale * Math.sin(a) });
    const add = (p, cornerRadius = 0) => {
      vertices.push(__spreadProps(__spreadValues({}, p), { cornerRadius }));
      return vertices.length - 1;
    };
    const line = (start, end) => segments.push({ start, end });
    const curve = (startAngle, delta, scale) => {
      const count = Math.ceil(Math.abs(delta) / (Math.PI / 2));
      const step = delta / count;
      let previous = add(point(startAngle, scale), radius);
      const first = previous;
      for (let i = 1; i <= count; i++) {
        const a = startAngle + step * (i - 1), b = startAngle + step * i;
        const next = add(point(b, scale), i === count ? radius : 0);
        const k = 4 / 3 * Math.tan(step / 4);
        segments.push({
          start: previous,
          end: next,
          tangentStart: { x: -cx * scale * Math.sin(a) * k, y: cy * scale * Math.cos(a) * k },
          tangentEnd: { x: cx * scale * Math.sin(b) * k, y: -cy * scale * Math.cos(b) * k }
        });
        previous = next;
      }
      return [first, previous];
    };
    const outer = curve(arc.startingAngle, sweep, 1);
    let loop;
    const outerCount = segments.length;
    if (arc.innerRadius > 0) {
      const inner = curve(arc.endingAngle, -sweep, arc.innerRadius);
      const curveCount = segments.length;
      line(outer[1], inner[0]);
      line(inner[1], outer[0]);
      loop = [
        ...Array(outerCount).keys(),
        curveCount,
        ...Array.from({ length: curveCount - outerCount }, (_, i) => outerCount + i)
      ];
      loop.push(curveCount + 1);
    } else {
      const center = add({ x: cx, y: cy }, radius);
      line(outer[1], center);
      line(center, outer[0]);
      loop = segments.map((_, i) => i);
    }
    return { vertices, segments, regions: [{ windingRule: "NONZERO", loops: [loop] }] };
  }

  // ../shared/vectorUtils.ts
  function normalizeVectorWindingRule(value) {
    if (value === "Evenodd" || value === "EVENODD") return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO") return "NONZERO";
    return "NONZERO";
  }
  function stripVectorNetworkVertexExtras(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object" || !Array.isArray(vectorNetwork.vertices)) return vectorNetwork;
    const result = {};
    for (const key in vectorNetwork) {
      if (Object.prototype.hasOwnProperty.call(vectorNetwork, key)) {
        result[key] = vectorNetwork[key];
      }
    }
    result.vertices = vectorNetwork.vertices.map((vertex) => {
      if (!vertex || typeof vertex !== "object") return vertex;
      const next = {};
      for (const key in vertex) {
        if (Object.prototype.hasOwnProperty.call(vertex, key)) {
          if (key === "strokeCap" || key === "cornerRadius") {
            next[key] = vertex[key];
          } else if (key === "x" || key === "y") {
            next[key] = Number(vertex[key]) || 0;
          }
        }
      }
      return next;
    });
    return result;
  }

  // src/appliers/vector.ts
  function normalizeVectorStrokeCap(value) {
    return normalizeConnectorVectorStrokeCap(value);
  }
  function applyVectorNetwork(node, vectorNetwork, data) {
    return __async(this, null, function* () {
      const normalized = normalizeVectorNetworkForFigma(createVectorNetworkWithLayoutBoxAnchors(vectorNetwork, data));
      try {
        yield node.setVectorNetworkAsync(normalized);
        return;
      } catch (error) {
        console.warn("Unable to set vectorNetwork, retrying without vertex stroke caps/corner radii:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
      }
      try {
        yield node.setVectorNetworkAsync(stripVectorNetworkVertexExtras(normalized));
      } catch (fallbackError) {
        console.warn("Unable to set fallback vectorNetwork:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", fallbackError);
      }
    });
  }
  function createVectorNetworkWithLayoutBoxAnchors(vectorNetwork, data) {
    var _a, _b;
    if (!(data == null ? void 0 : data.vectorAutoLayoutBox) || !vectorNetwork || typeof vectorNetwork !== "object") return vectorNetwork;
    const width = Number((_a = data == null ? void 0 : data.layout) == null ? void 0 : _a.width);
    const height = Number((_b = data == null ? void 0 : data.layout) == null ? void 0 : _b.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return vectorNetwork;
    const vertices = Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.slice() : [];
    const segments = Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.slice() : [];
    const startIndex = vertices.length;
    vertices.push(
      { x: 0, y: 0, strokeCap: "NONE" },
      { x: width, y: height, strokeCap: "NONE" }
    );
    segments.push(
      { start: startIndex, end: startIndex, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
      { start: startIndex + 1, end: startIndex + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }
    );
    return __spreadProps(__spreadValues({}, vectorNetwork), {
      vertices,
      segments
    });
  }
  function normalizeVectorNetworkForFigma(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object") return vectorNetwork;
    const result = {};
    for (const key in vectorNetwork) {
      if (Object.prototype.hasOwnProperty.call(vectorNetwork, key)) {
        result[key] = vectorNetwork[key];
      }
    }
    if (Array.isArray(vectorNetwork.vertices)) {
      result.vertices = vectorNetwork.vertices.map((vertex) => {
        if (!vertex || typeof vertex !== "object") return vertex;
        const next = {};
        for (const key in vertex) {
          if (Object.prototype.hasOwnProperty.call(vertex, key)) {
            next[key] = vertex[key];
          }
        }
        if (next.strokeCap !== void 0) {
          next.strokeCap = normalizeVectorStrokeCap(next.strokeCap);
        }
        return next;
      });
    }
    if (Array.isArray(vectorNetwork.regions)) {
      result.regions = vectorNetwork.regions.map((region) => {
        if (!region || typeof region !== "object") return region;
        const next = {};
        for (const key in region) {
          if (Object.prototype.hasOwnProperty.call(region, key)) {
            next[key] = region[key];
          }
        }
        next.windingRule = normalizeVectorWindingRule(next.windingRule);
        if (Array.isArray(region.loops)) {
          next.loops = region.loops.map((loop) => {
            if (!Array.isArray(loop)) return loop;
            return loop.map((value) => Number(value)).filter((value) => Number.isFinite(value));
          });
        }
        return next;
      });
    }
    return result;
  }

  // src/appliers/multilineText.ts
  function getFixedMixedTextLines(data) {
    var _a, _b, _c, _d;
    const text = data == null ? void 0 : data.characters;
    const lineHeight = data == null ? void 0 : data.lineHeight;
    const segments = data == null ? void 0 : data.styledTextSegments;
    if (typeof text !== "string" || !text.includes("\n") || text.includes("\r") || data.textAutoResize !== "WIDTH_AND_HEIGHT" || (lineHeight == null ? void 0 : lineHeight.unit) !== "PIXELS" || !(lineHeight.value > 0) || !Array.isArray(segments) || Array.isArray(data.textListRanges) && data.textListRanges.some((range) => (range == null ? void 0 : range.type) !== "NONE") || ((_a = data.blend) == null ? void 0 : _a.isMask) || !(((_b = data.layout) == null ? void 0 : _b.width) > 0) || (data.paragraphSpacing || 0) !== 0 || (data.paragraphIndent || 0) !== 0) return null;
    const lines = text.split("\n");
    if (lines.some((line) => !line) || Math.abs(((_c = data.layout) == null ? void 0 : _c.height) - lines.length * lineHeight.value) > 0.015 || !Number.isFinite((_d = data.layout) == null ? void 0 : _d.height)) return null;
    if (segments.some((segment) => segment.lineHeight && (segment.lineHeight.unit !== "PIXELS" || segment.lineHeight.value !== lineHeight.value))) return null;
    let offset = 0;
    const result = lines.map((characters) => {
      const start = offset;
      offset += characters.length + 1;
      const runs = segments.filter((s) => s.end > start && s.start < offset - 1).map((s) => __spreadProps(__spreadValues({}, s), { start: Math.max(0, s.start - start), end: Math.min(characters.length, s.end - start) }));
      return { characters, styledTextSegments: runs };
    });
    const sizes = result.map((line) => {
      let covered = 0;
      for (const run of line.styledTextSegments) {
        if (run.start !== covered) return null;
        covered = run.end;
      }
      if (covered !== line.characters.length) return null;
      const sizes2 = new Set(line.styledTextSegments.map((s) => {
        var _a2;
        return (_a2 = s.fontSize) != null ? _a2 : data.fontSize;
      }));
      return sizes2.size === 1 ? [...sizes2][0] : null;
    });
    return sizes.indexOf(null) >= 0 || new Set(sizes).size < 2 ? null : result;
  }

  // src/appliers/svgFallback.ts
  function unwrapSingleVectorSvg(root, data) {
    var _a;
    if ((data == null ? void 0 : data.vectorFallback) !== "svgMissingRegions" || root.children.length !== 1) return root;
    const child = root.children[0];
    if (child.type !== "VECTOR" || !root.parent || !("appendChild" in root.parent)) return root;
    const layout = data.layout;
    const transform = layout == null ? void 0 : layout.relativeTransform;
    if (!transform || ![layout.width, layout.height].every(Number.isFinite)) return root;
    const tolerance = 0.01;
    if (Math.abs(child.width - layout.width) > tolerance || Math.abs(child.height - layout.height) > tolerance) return root;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        if (!Number.isFinite((_a = transform[row]) == null ? void 0 : _a[col]) || Math.abs(child.relativeTransform[row][col] - transform[row][col]) > 1e-5) return root;
      }
    }
    root.parent.appendChild(child);
    root.remove();
    return child;
  }

  // src/nodeCreator.ts
  var POSTPROCESS_YIELD_INTERVAL_MS2 = 85;
  var SHELL_PLACEHOLDER_PLUGIN_DATA_KEY = "mastergo2figma.shellPlaceholder";
  function appendRestoredNode(parent, node) {
    if ("appendChild" in parent) {
      parent.appendChild(node);
      return true;
    }
    console.warn("Unable to append restored node because parent cannot contain children:", node.name, parent.name);
    safeRemove(node);
    return false;
  }
  function isRemovedNode2(node) {
    return !node || !!node.removed;
  }
  function safeRemove(node) {
    if (node.removed) return;
    try {
      node.remove();
      state.recordNodeRemoval();
    } catch (e) {
      console.warn("Unable to remove node:", node.name, e);
    }
  }
  function isShellContainer(node) {
    return node.type === "FRAME" || node.type === "GROUP" || node.type === "SECTION" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET";
  }
  function clearMaskFlag(node) {
    const nodeAny = node;
    if (!("isMask" in nodeAny)) return;
    try {
      nodeAny.isMask = false;
    } catch (e) {
      console.warn("Unable to clear mask before removing imported rectangle:", node.name, e);
    }
  }
  function markShellPlaceholderNode(node, data) {
    if (!data || data.shellPlaceholder !== true) return;
    const nodeAny = node;
    if (typeof nodeAny.setPluginData !== "function") return;
    try {
      nodeAny.setPluginData(SHELL_PLACEHOLDER_PLUGIN_DATA_KEY, "1");
      state.shellPlaceholderCandidates.push(node);
    } catch (e) {
      console.warn("Unable to mark shell placeholder:", node.name, e);
    }
  }
  function isShellPlaceholderNode(node) {
    const nodeAny = node;
    if (typeof nodeAny.getPluginData !== "function") return false;
    try {
      return nodeAny.getPluginData(SHELL_PLACEHOLDER_PLUGIN_DATA_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  function isInsideInstance(node) {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
      if (parent.type === "INSTANCE") return true;
      parent = parent.parent;
    }
    return false;
  }
  function cleanupImportedContainerShells(root, progress, candidates) {
    return __async(this, null, function* () {
      const nodes = candidates ? collectCandidateCleanupNodes(root, candidates) : collectCleanupNodes(root);
      const total = Math.max(1, nodes.length);
      let done = 0;
      let lastYieldAt = Date.now();
      for (let index = nodes.length - 1; index >= 0; index--) {
        cleanupImportedContainerShell(nodes[index]);
        done++;
        const pending = maybeYieldPostprocess2(done, total, lastYieldAt, progress);
        if (pending) lastYieldAt = yield pending;
      }
    });
  }
  function collectCandidateCleanupNodes(root, candidates) {
    if (isInsideInstance(root)) return [];
    const parents = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      if (isRemovedNode2(candidate) || candidate.type !== "RECTANGLE") continue;
      const parent = candidate.parent;
      if (!parent || parents.has(parent.id)) continue;
      let ancestor = parent;
      let depth = 0;
      while (ancestor && ancestor.type !== "INSTANCE" && ancestor !== root) {
        ancestor = ancestor.parent;
        depth++;
      }
      if (ancestor === root && root.type !== "INSTANCE") parents.set(parent.id, { node: parent, depth });
    }
    return [...parents.values()].sort((a, b) => a.depth - b.depth).map((entry) => entry.node);
  }
  function collectCleanupNodes(root) {
    const nodes = [];
    const rootInsideInstance = isInsideInstance(root);
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!("children" in node)) continue;
      if (isSceneNode(node) && (node.type === "INSTANCE" || rootInsideInstance)) continue;
      nodes.push(node);
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push(children[index]);
      }
    }
    return nodes;
  }
  function cleanupImportedContainerShell(root) {
    if (!isSceneNode(root) || !isShellContainer(root)) return;
    const shellChildren = root.children;
    for (const child of shellChildren) {
      if (child.type === "RECTANGLE" && isShellPlaceholderNode(child)) {
        clearMaskFlag(child);
        safeRemove(child);
        return;
      }
    }
  }
  function maybeYieldPostprocess2(done, total, lastYieldAt, progress) {
    const now = Date.now();
    if (done < total && now - lastYieldAt < POSTPROCESS_YIELD_INTERVAL_MS2) {
      return null;
    }
    return (() => __async(null, null, function* () {
      if (progress) yield progress(done, total);
      yield yieldToEventLoop();
      return Date.now();
    }))();
  }
  function recordCreatedNode(node) {
    state.recordNodeCreation("createNodeFromData");
    return node;
  }
  function hasUsableVectorNetwork(vectorNetwork) {
    return !!(vectorNetwork && Array.isArray(vectorNetwork.vertices) && vectorNetwork.vertices.length > 0 && Array.isArray(vectorNetwork.segments));
  }
  function createNodeFromData(data) {
    return __async(this, null, function* () {
      let node = null;
      const type = getReceiveCreateType(data);
      try {
        switch (type) {
          case "SVG":
            if (typeof data.svgMarkup === "string" && data.svgMarkup.trim()) {
              node = recordCreatedNode(figma.createNodeFromSvg(data.svgMarkup));
              node = unwrapSingleVectorSvg(node, data);
            } else {
              node = recordCreatedNode(figma.createFrame());
            }
            break;
          case "PEN":
          case "VECTOR":
            const vector = recordCreatedNode(figma.createVector());
            node = vector;
            break;
          case "ELLIPSE":
            const arcSvg = localEllipseArcSvg(data);
            if (arcSvg) {
              node = recordCreatedNode(figma.createNodeFromSvg(arcSvg));
              break;
            }
            if (roundedArcNetwork(data)) {
              node = recordCreatedNode(figma.createVector());
              break;
            }
            const ellipse = recordCreatedNode(figma.createEllipse());
            node = ellipse;
            if (data.arcData) safeSet(ellipse, "arcData", data.arcData);
            break;
          case "RECTANGLE":
            node = recordCreatedNode(figma.createRectangle());
            break;
          case "STAR":
            const star = recordCreatedNode(figma.createStar());
            node = star;
            safeSet(star, "pointCount", data.pointCount || 5);
            safeSet(star, "innerRadius", data.innerRadius || 0.38);
            break;
          case "LINE":
            node = recordCreatedNode(figma.createLine());
            break;
          case "POLYGON":
            const polygon = recordCreatedNode(figma.createPolygon());
            node = polygon;
            safeSet(polygon, "pointCount", data.pointCount || 3);
            break;
          case "TEXT":
            node = recordCreatedNode(getFixedMixedTextLines(data) ? figma.createFrame() : figma.createText());
            break;
          case "SECTION":
            node = recordCreatedNode(figma.createSection());
            break;
          case "COMPONENT":
            node = recordCreatedNode(figma.createComponent());
            break;
          case "SLICE":
            node = recordCreatedNode(figma.createSlice());
            break;
          case "CONNECTOR":
            const connectorSvg = localConnectorSvg(data);
            if (connectorSvg) {
              node = recordCreatedNode(figma.createNodeFromSvg(connectorSvg));
              break;
            }
            const connectorVector = recordCreatedNode(figma.createVector());
            node = connectorVector;
            if (!data.connectorFallbackPolyline) data.connectorFallbackPolyline = true;
            if (!data.connectorRouteExplicit || !hasUsableVectorNetwork(data.vectorNetwork)) {
              data.vectorNetwork = createConnectorVectorNetworkFromData(data, null);
            }
            if (data.vectorNetwork) yield applyVectorNetwork(connectorVector, data.vectorNetwork, data);
            state.fallbackConnectorCount++;
            if (!state.connectorFallbackLogged) {
              state.connectorFallbackLogged = true;
              console.warn("CONNECTOR restored as VECTOR polyline because createConnector is unavailable/disabled");
            }
            break;
          case "BOOLEAN_OPERATION":
            node = recordCreatedNode(figma.createFrame());
            break;
          case "FRAME":
            node = recordCreatedNode(figma.createFrame());
            break;
          case "GROUP":
            node = recordCreatedNode(figma.createFrame());
            node.name = "GROUP_PLACEHOLDER";
            break;
          default:
            console.warn("Unsupported type:", type);
            break;
        }
      } catch (error) {
        console.warn("Unable to create node, removing partial node:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || type, error);
        if (node) safeRemove(node);
        return null;
      }
      if (node) markShellPlaceholderNode(node, data);
      return node;
    });
  }

  // ../shared/layoutGridUtils.ts
  function normalizeLayoutGrids(grids) {
    var _a, _b, _c;
    if (!Array.isArray(grids)) return [];
    const result = [];
    for (const grid of grids) {
      if (!grid || typeof grid !== "object") continue;
      const pattern = grid.pattern || grid.gridType;
      if (["GRID", "ROWS", "COLUMNS"].indexOf(pattern) < 0) continue;
      const common = {
        pattern,
        visible: (_b = (_a = grid.visible) != null ? _a : grid.isVisible) != null ? _b : true,
        color: grid.color ? { r: grid.color.r, g: grid.color.g, b: grid.color.b, a: grid.color.a } : { r: 1, g: 0, b: 0, a: 0.1 }
      };
      const sectionSize = grid.sectionSize == null ? void 0 : grid.sectionSize;
      if (pattern === "GRID") {
        result.push(__spreadProps(__spreadValues({}, common), { sectionSize: sectionSize != null ? sectionSize : 10 }));
        continue;
      }
      const alignment = { LEFT: "MIN", RIGHT: "MAX" }[grid.alignment] || grid.alignment || "STRETCH";
      result.push(__spreadValues(__spreadProps(__spreadValues({}, common), {
        alignment,
        count: grid.count,
        gutterSize: grid.gutterSize,
        offset: (_c = grid.offset) != null ? _c : 0
      }), sectionSize === void 0 || alignment === "STRETCH" ? {} : { sectionSize }));
    }
    return result;
  }

  // ../shared/matrixUtils.ts
  function cloneTransform(transform) {
    if (!transform || !Array.isArray(transform) || transform.length < 2) {
      return [[1, 0, 0], [0, 1, 0]];
    }
    const r0 = transform[0] || [1, 0, 0];
    const r1 = transform[1] || [0, 1, 0];
    return [
      [typeof r0[0] === "number" ? r0[0] : 1, typeof r0[1] === "number" ? r0[1] : 0, typeof r0[2] === "number" ? r0[2] : 0],
      [typeof r1[0] === "number" ? r1[0] : 0, typeof r1[1] === "number" ? r1[1] : 1, typeof r1[2] === "number" ? r1[2] : 0]
    ];
  }

  // src/appliers/universal.ts
  function recordRestoredNode(data, node) {
    const sourceId = data && typeof data.id === "string" ? data.id : "";
    if (sourceId && node && typeof node.id === "string") {
      state.restoredNodeIdBySourceId[sourceId] = node.id;
    }
  }
  var MISSING_IMAGE_PLACEHOLDER_COLOR = { r: 0.82, g: 0.83, b: 0.85 };
  function normalizeImagePaint(paint, context) {
    if (!paint || paint.type !== "IMAGE") return normalizePaintForFigma(paint);
    const assetName = typeof paint.imageRef === "string" ? paint.imageRef : "";
    const imageHash = tryResolveImageHash(paint);
    if (!imageHash) {
      recordMissingImageAsset(assetName || "missing-image.png", context);
      const placeholder = {
        type: "SOLID",
        color: __spreadValues({}, MISSING_IMAGE_PLACEHOLDER_COLOR)
      };
      if (paint.visible !== void 0) placeholder.visible = paint.visible;
      if (paint.opacity !== void 0) placeholder.opacity = paint.opacity;
      if (paint.blendMode) placeholder.blendMode = paint.blendMode;
      return normalizePaintForFigma(placeholder);
    }
    const result = {
      type: "IMAGE",
      scaleMode: paint.scaleMode || "FILL",
      imageHash
    };
    if (paint.visible !== void 0) result.visible = paint.visible;
    if (paint.opacity !== void 0) result.opacity = paint.opacity;
    if (paint.blendMode) result.blendMode = paint.blendMode;
    const filters = normalizeImageFilters(paint.filters);
    if (filters) result.filters = filters;
    if (paint.rotation !== void 0) result.rotation = paint.rotation;
    if (paint.imageTransform) result.imageTransform = paint.imageTransform;
    if (paint.scalingFactor !== void 0) result.scalingFactor = paint.scalingFactor;
    else if (result.scaleMode === "TILE" && typeof paint.ratio === "number" && paint.ratio > 0) {
      result.scalingFactor = paint.ratio;
    }
    return normalizePaintForFigma(result);
  }
  function normalizeImageFills(fills, node, layout) {
    if (!Array.isArray(fills)) return fills;
    return fills.map((paint) => normalizeImagePaint(paint, { node, layout, paintTarget: "fill" })).filter(Boolean);
  }
  function normalizeImageStrokes(strokes, node, layout) {
    if (!Array.isArray(strokes)) return strokes;
    return strokes.map((paint) => normalizeImagePaint(paint, { node, layout, paintTarget: "stroke" })).filter(Boolean);
  }
  function normalizeImageFilters(filters) {
    if (!filters || typeof filters !== "object") return null;
    const result = {};
    const allowed = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
    for (const key of allowed) {
      if (typeof filters[key] === "number") result[key] = filters[key];
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  function tryResolveImageHash(fill) {
    const assetName = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!assetName || fill.missingAsset) return null;
    const existingHash = state.imageHashByAssetName[assetName];
    if (existingHash) return existingHash;
    const bytes = state.activeImportAssets[assetName];
    if (!bytes) return null;
    try {
      const image = figma.createImage(bytes);
      state.imageHashByAssetName[assetName] = image.hash;
      return image.hash;
    } catch (error) {
      console.warn("Unable to create Figma image from asset:", assetName, error);
      return null;
    }
  }
  function recordMissingImageAsset(assetName, context) {
    if (!state.missingImageAssetNames[assetName]) {
      state.missingImageAssetNames[assetName] = true;
      state.missingImageAssetCount++;
    }
    const detail = createMissingImageAssetDetail(assetName, context);
    if (!detail) return;
    const key = [
      detail.assetName,
      detail.nodeId,
      detail.layerPath,
      detail.paintTarget,
      detail.x,
      detail.y,
      detail.width,
      detail.height
    ].join("|");
    if (state.missingImageAssetDetailKeys[key]) return;
    state.missingImageAssetDetailKeys[key] = true;
    state.missingImageAssetDetails.push(detail);
  }
  function createMissingImageAssetDetail(assetName, context) {
    const node = context == null ? void 0 : context.node;
    if (!node) return null;
    const layout = (context == null ? void 0 : context.layout) || {};
    const absoluteTransform = node.absoluteTransform || node.relativeTransform;
    const x = toFiniteNumber(layout.x, absoluteTransform && absoluteTransform[0] && absoluteTransform[0][2]);
    const y = toFiniteNumber(layout.y, absoluteTransform && absoluteTransform[1] && absoluteTransform[1][2]);
    const width = toFiniteNumber(layout.width, node.width);
    const height = toFiniteNumber(layout.height, node.height);
    return {
      assetName,
      nodeId: typeof node.id === "string" ? node.id : "",
      nodeName: typeof node.name === "string" ? node.name : "Untitled",
      layerPath: getNodeLayerPath(node),
      nodeType: typeof node.type === "string" ? node.type : "UNKNOWN",
      paintTarget: (context == null ? void 0 : context.paintTarget) || "image",
      x,
      y,
      width,
      height
    };
  }
  function getNodeLayerPath(node) {
    const parts = [];
    let current = node;
    while (current && current.type !== "DOCUMENT") {
      if (typeof current.name === "string" && current.name) {
        parts.unshift(current.name);
      } else if (typeof current.type === "string") {
        parts.unshift(current.type);
      }
      current = current.parent;
    }
    return parts.join(" / ");
  }
  function toFiniteNumber(...values) {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.round(value * 100) / 100;
      }
    }
    return null;
  }
  function normalizeEffectsForNode(node, effects) {
    if (!Array.isArray(effects)) return effects;
    return effects.map((effect) => {
      if (!effect || typeof effect !== "object") return effect;
      const copy = {};
      for (const key in effect) {
        if (key !== "spread" || supportsEffectSpread(node)) copy[key] = effect[key];
      }
      if (copy.visible === void 0 && effect.isVisible !== void 0) copy.visible = effect.isVisible;
      if (copy.visible === void 0) copy.visible = true;
      if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
      if (copy.type === "DROP_SHADOW") {
        if (copy.showShadowBehindNode === void 0) copy.showShadowBehindNode = true;
      } else if (copy.showShadowBehindNode !== void 0) {
        delete copy.showShadowBehindNode;
      }
      return copy;
    });
  }
  function safeSetEffects(node, effects) {
    if (!("effects" in node)) return;
    const normalized = normalizeEffectsForNode(node, effects);
    try {
      node.effects = normalized;
      return;
    } catch (_) {
    }
    const withoutSpread = Array.isArray(normalized) ? normalized.map((effect) => {
      if (!effect || typeof effect !== "object") return effect;
      const copy = {};
      for (const key in effect) {
        if (key !== "spread") copy[key] = effect[key];
      }
      return copy;
    }) : normalized;
    try {
      node.effects = withoutSpread;
    } catch (_) {
    }
  }
  function supportsEffectSpread(node) {
    return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE" || node.type === "RECTANGLE" || node.type === "ELLIPSE" || node.type === "POLYGON" || node.type === "STAR" || node.type === "VECTOR" || node.type === "SECTION" || node.type === "TEXT";
  }
  function normalizeConstraints(value) {
    if (!value || typeof value !== "object") return value;
    const horizontal = normalizeConstraintType(value.horizontal);
    const vertical = normalizeConstraintType(value.vertical);
    if (!horizontal || !vertical) return void 0;
    return { horizontal, vertical };
  }
  function normalizeConstraintType(value) {
    if (value === "START" || value === "MIN") return "MIN";
    if (value === "END" || value === "MAX") return "MAX";
    if (value === "STARTANDEND" || value === "STRETCH") return "STRETCH";
    if (value === "CENTER" || value === "SCALE") return value;
    return void 0;
  }
  function safeSetFills(node, fills) {
    setPaintsIndependently(node, "fills", fills);
  }
  function safeSetStrokes(node, strokes) {
    setPaintsIndependently(node, "strokes", strokes);
  }
  function setPaintsIndependently(node, target, paints) {
    if (!(target in node)) return;
    const normalized = normalizePaintsForFigma(paints);
    try {
      node[target] = normalized;
      return;
    } catch (error) {
    }
    const accepted = [];
    for (const paint of normalized) {
      const candidates = [paint, ...stripUnsupportedPaintExtras([paint])];
      if (paint.type === "IMAGE") candidates.push({
        type: "SOLID",
        color: __spreadValues({}, MISSING_IMAGE_PLACEHOLDER_COLOR),
        visible: paint.visible,
        opacity: paint.opacity
      });
      let restored = false;
      for (const candidate of candidates) {
        try {
          node[target] = [...accepted, candidate];
          accepted.push(candidate);
          restored = true;
          break;
        } catch (error) {
        }
      }
      if (!restored) console.warn("Unable to set paint:", node.name, target, paint.type);
    }
    if (accepted.length === 0) {
      try {
        node[target] = [];
      } catch (error) {
      }
    }
  }
  function normalizePaintsForFigma(paints) {
    if (!Array.isArray(paints)) return paints;
    return paints.map(normalizePaintForFigma).filter(Boolean);
  }
  function normalizePaintForFigma(paint) {
    if (!paint || typeof paint !== "object") return paint;
    const copy = {};
    for (const key in paint) {
      if (key === "imageRef" || key === "missingAsset" || key === "isVisible") continue;
      if (paint[key] !== void 0) copy[key] = paint[key];
    }
    if (copy.visible === void 0 && paint.isVisible !== void 0) copy.visible = paint.isVisible;
    if (copy.visible === void 0) copy.visible = true;
    if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
    if (typeof copy.opacity === "number") copy.opacity = clamp01(copy.opacity);
    if (copy.type === "SOLID") {
      if (copy.color) copy.color = normalizePaintColor(copy.color);
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "color", "boundVariables"]);
    }
    if (copy.type === "GRADIENT_LINEAR" || copy.type === "GRADIENT_RADIAL" || copy.type === "GRADIENT_ANGULAR" || copy.type === "GRADIENT_DIAMOND") {
      if (Array.isArray(copy.gradientStops)) copy.gradientStops = copy.gradientStops.map(normalizeGradientStop).filter(Boolean);
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "gradientHandlePositions", "gradientStops", "gradientTransform", "boundVariables"]);
    }
    if (copy.type === "IMAGE") {
      if (!copy.imageHash) return null;
      if (copy.scaleMode === "TILE" && copy.scalingFactor === void 0 && typeof copy.ratio === "number" && copy.ratio > 0) {
        copy.scalingFactor = copy.ratio;
      }
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "scaleMode", "imageHash", "imageTransform", "scalingFactor", "rotation", "filters", "gifRef", "boundVariables"]);
    }
    if (copy.type === "VIDEO") {
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "scaleMode", "videoHash", "videoTransform", "scalingFactor", "rotation", "filters", "boundVariables"]);
    }
    return copy;
  }
  function stripUnsupportedPaintExtras(paints) {
    if (!Array.isArray(paints)) return paints;
    return paints.map((paint) => {
      if (!paint || typeof paint !== "object") return paint;
      if (paint.type === "IMAGE") {
        return pickDefined(paint, ["type", "visible", "opacity", "blendMode", "scaleMode", "imageHash"]);
      }
      if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
        return pickDefined(paint, ["type", "visible", "opacity", "blendMode", "gradientHandlePositions", "gradientStops"]);
      }
      return normalizePaintForFigma(paint);
    }).filter(Boolean);
  }
  function pickDefined(value, keys) {
    const result = {};
    for (const key of keys) {
      if (value[key] !== void 0) result[key] = value[key];
    }
    return result;
  }
  function normalizeGradientStop(stop) {
    if (!stop || typeof stop !== "object") return null;
    const result = {};
    result.position = clamp01(typeof stop.position === "number" ? stop.position : 0);
    result.color = normalizePaintColor(stop.color || {});
    if (stop.boundVariables !== void 0) result.boundVariables = stop.boundVariables;
    return result;
  }
  function normalizePaintColor(color) {
    return {
      r: clamp01(typeof color.r === "number" ? color.r : 0),
      g: clamp01(typeof color.g === "number" ? color.g : 0),
      b: clamp01(typeof color.b === "number" ? color.b : 0),
      a: clamp01(typeof color.a === "number" ? color.a : 1)
    };
  }
  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }
  function isNearlyZero(value) {
    return Math.abs(value) < 0.01;
  }
  function copyLayout(layout) {
    const copy = {};
    for (const key in layout) copy[key] = layout[key];
    return copy;
  }
  function axisBoundsDistance(value, size) {
    if (value < -size) return -size - value;
    if (value > size * 2) return value - size * 2;
    return 0;
  }
  function groupChildBoundsDistance(x, y, width, height) {
    return axisBoundsDistance(x, width) + axisBoundsDistance(y, height);
  }
  function isGroupChildOffsetImprovement(parent, x, y, normalizedX, normalizedY) {
    const restoredLayout = state.restoredLayoutByNodeId[parent.id] || {};
    const width = Math.max(restoredLayout.width || parent.width || 0, 1);
    const height = Math.max(restoredLayout.height || parent.height || 0, 1);
    const currentScore = groupChildBoundsDistance(x, y, width, height);
    const normalizedScore = groupChildBoundsDistance(normalizedX, normalizedY, width, height);
    return normalizedScore < currentScore && currentScore > 0;
  }
  function findNearestPositionedAncestor(group) {
    let ancestor = group.parent;
    while (ancestor && ancestor.type !== "PAGE" && ancestor.type !== "DOCUMENT") {
      if (ancestor.type !== "GROUP") return ancestor;
      ancestor = ancestor.parent;
    }
    return null;
  }
  function getGroupChildCanvasOffset(node, layout) {
    const parent = node.parent;
    if (!parent || parent.type !== "GROUP" || !layout) return null;
    if (layout.x === void 0 || layout.y === void 0) return null;
    const ancestor = findNearestPositionedAncestor(parent);
    if (!ancestor) return null;
    const ancestorTransform = ancestor.absoluteTransform || ancestor.relativeTransform;
    if (!ancestorTransform) return null;
    const offset = { x: ancestorTransform[0][2] || 0, y: ancestorTransform[1][2] || 0 };
    if (isNearlyZero(offset.x) && isNearlyZero(offset.y)) return null;
    const normalizedX = layout.x - offset.x;
    const normalizedY = layout.y - offset.y;
    if (!isGroupChildOffsetImprovement(parent, layout.x, layout.y, normalizedX, normalizedY)) return null;
    return offset;
  }
  function normalizeLayoutForParent(node, layout) {
    const offset = getGroupChildCanvasOffset(node, layout);
    if (!offset) return layout;
    const normalized = copyLayout(layout);
    normalized.x = (layout.x || 0) - offset.x;
    normalized.y = (layout.y || 0) - offset.y;
    if (layout.relativeTransform) {
      normalized.relativeTransform = cloneTransform(layout.relativeTransform);
      normalized.relativeTransform[0][2] -= offset.x;
      normalized.relativeTransform[1][2] -= offset.y;
    }
    return normalized;
  }
  function hasFiniteRelativeTransform2(layout) {
    return Array.isArray(layout == null ? void 0 : layout.relativeTransform) && Array.isArray(layout.relativeTransform[0]) && Array.isArray(layout.relativeTransform[1]) && Number.isFinite(layout.relativeTransform[0][0]) && Number.isFinite(layout.relativeTransform[0][1]) && Number.isFinite(layout.relativeTransform[0][2]) && Number.isFinite(layout.relativeTransform[1][0]) && Number.isFinite(layout.relativeTransform[1][1]) && Number.isFinite(layout.relativeTransform[1][2]);
  }
  function getUniformOpenVectorStrokeCap(vectorNetwork) {
    if (!vectorNetwork || !Array.isArray(vectorNetwork.vertices) || !Array.isArray(vectorNetwork.segments)) return null;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0) return null;
    if (vectorNetwork.segments.length < 1) return null;
    const firstSegment = vectorNetwork.segments[0];
    const lastSegment = vectorNetwork.segments[vectorNetwork.segments.length - 1];
    const startVertex = vectorNetwork.vertices[firstSegment && firstSegment.start];
    const endVertex = vectorNetwork.vertices[lastSegment && lastSegment.end];
    const startCap = startVertex && startVertex.strokeCap;
    const endCap = endVertex && endVertex.strokeCap;
    if (!startCap || startCap === "NONE") return null;
    if (endCap && endCap !== "NONE" && endCap !== startCap) return null;
    return normalizeMasterGoStrokeCapForFigma(startCap);
  }
  function applyUniversalProperties(node, data) {
    return __async(this, null, function* () {
      var _a, _b, _c, _d;
      if (!node || !data) return;
      safeSet(node, "name", data.name);
      recordRestoredNode(data, node);
      if (data.scence) {
        safeSet(node, "visible", (_a = data.scence.visible) != null ? _a : true);
        safeSet(node, "locked", (_b = data.scence.locked) != null ? _b : false);
      }
      if (data.blend) {
        safeSet(node, "opacity", (_c = data.blend.opacity) != null ? _c : 1);
        safeSet(node, "isMask", (_d = data.blend.isMask) != null ? _d : false);
        if (["ALPHA", "VECTOR", "LUMINANCE"].indexOf(data.blend.maskType) >= 0) {
          safeSet(node, "maskType", data.blend.maskType);
        }
        safeSet(node, "blendMode", data.blend.blendMode || "NORMAL");
        if (data.blend.effects) {
          safeSetEffects(node, data.blend.effects);
        }
      }
      const isGroup = node.type === "GROUP";
      const isBooleanOperation = node.type === "BOOLEAN_OPERATION";
      if (!isGroup && data.corner && node.type !== "LINE" && node.type !== "TEXT") {
        if (data.corner.cornerRadius === -1) {
          if ("topLeftRadius" in node) {
            safeSet(node, "topLeftRadius", data.corner.topLeftRadius || 0);
            safeSet(node, "topRightRadius", data.corner.topRightRadius || 0);
            safeSet(node, "bottomLeftRadius", data.corner.bottomLeftRadius || 0);
            safeSet(node, "bottomRightRadius", data.corner.bottomRightRadius || 0);
          }
        } else {
          safeSet(node, "cornerRadius", data.corner.cornerRadius || 0);
        }
        safeSet(node, "cornerSmoothing", data.corner.cornerSmoothing || 0);
      }
      if (!isGroup && data.geometry && !data.svgFallback) {
        if (data.geometry.fills) safeSetFills(node, normalizeImageFills(data.geometry.fills, node, data.layout));
        if (data.geometry.strokes) {
          safeSetStrokes(node, normalizeImageStrokes(data.geometry.strokes, node, data.layout));
        }
        if (data.geometry.strokeWeight !== void 0) {
          safeSet(node, "strokeWeight", data.geometry.strokeWeight);
        }
        if (node.strokeTopWeight !== void 0) {
          if (data.geometry.strokeTopWeight !== void 0) {
            try {
              node.strokeTopWeight = data.geometry.strokeTopWeight;
              node.strokeBottomWeight = data.geometry.strokeBottomWeight;
              node.strokeLeftWeight = data.geometry.strokeLeftWeight;
              node.strokeRightWeight = data.geometry.strokeRightWeight;
            } catch (e) {
            }
          }
        }
        if (data.geometry.strokeAlign) safeSet(node, "strokeAlign", data.geometry.strokeAlign);
        if (data.geometry.strokeJoin) safeSet(node, "strokeJoin", data.geometry.strokeJoin);
        if (data.geometry.dashPattern !== void 0) safeSet(node, "dashPattern", data.geometry.dashPattern);
        if (data.geometry.strokeCap && !data.connectorFallbackPolyline) {
          const vectorCap = data.geometry.strokeCap === "NONE" ? getUniformOpenVectorStrokeCap(data.vectorNetwork) : null;
          safeSet(node, "strokeCap", vectorCap || normalizeMasterGoStrokeCapForFigma(data.geometry.strokeCap));
        }
      }
      if (data.constraints) safeSet(node, "constraints", normalizeConstraints(data.constraints));
      if (data.exportSettings) safeSet(node, "exportSettings", data.exportSettings);
      if (data.layout) {
        const layout = normalizeLayoutForParent(node, data.layout);
        state.restoredLayoutByNodeId[node.id] = layout;
        if (layout.width !== void 0 && layout.height !== void 0) {
          if (isGroup || isBooleanOperation) {
          } else {
            safeResize(node, layout.width, layout.height);
          }
        }
        const hasRelativeTransform = hasFiniteRelativeTransform2(layout);
        if (hasRelativeTransform) {
          safeSet(node, "relativeTransform", layout.relativeTransform);
        } else {
          if (layout.x !== void 0) safeSet(node, "x", layout.x);
          if (layout.y !== void 0) safeSet(node, "y", layout.y);
          if (layout.rotation !== void 0) safeSet(node, "rotation", layout.rotation);
        }
        if (layout.constrainProportions !== void 0) {
          applyAspectRatioLock(node, layout.constrainProportions);
        }
        deferLayoutRestore(node, layout, isGroup);
      }
      if (data.layoutGrids !== void 0 && "layoutGrids" in node) safeSet(node, "layoutGrids", normalizeLayoutGrids(data.layoutGrids));
      if (data.clipsContent !== void 0) safeSet(node, "clipsContent", data.clipsContent);
    });
  }

  // src/propertyApplier.ts
  function applyProperties(node, data) {
    return __async(this, null, function* () {
      var _a, _b;
      if (!node || !data) return;
      if (data.sourceType === "CONNECTOR" && data.layout) {
        data = __spreadProps(__spreadValues({}, data), { layout: __spreadProps(__spreadValues({}, data.layout), { layoutPositioning: "ABSOLUTE" }) });
      }
      const arcSvgWrapper = node.type === "FRAME" && (localEllipseArcSvg(data) || localConnectorSvg(data));
      yield applyUniversalProperties(node, arcSvgWrapper ? __spreadProps(__spreadValues({}, data), { geometry: { fills: [], strokes: [], strokeWeight: 0 }, clipsContent: false }) : data);
      if (arcSvgWrapper) node.clipsContent = false;
      const fixedLines = node.type === "FRAME" ? getFixedMixedTextLines(data) : null;
      if (fixedLines) {
        const fills = node.fills;
        const strokes = node.strokes;
        node.fills = [];
        node.strokes = [];
        node.clipsContent = false;
        for (let index = 0; index < fixedLines.length; index++) {
          const line = figma.createText();
          state.recordNodeCreation("fixed-text-line");
          node.appendChild(line);
          line.name = fixedLines[index].characters;
          line.fills = fills;
          line.strokes = strokes;
          line.strokeWeight = (_b = (_a = data.geometry) == null ? void 0 : _a.strokeWeight) != null ? _b : 0;
          yield applyTextProperties(line, __spreadProps(__spreadValues(__spreadValues({}, data), fixedLines[index]), { textAutoResize: "NONE" }));
          line.resize(data.layout.width, data.lineHeight.value);
          line.x = 0;
          line.y = index * data.lineHeight.value;
        }
      }
      const arcNetwork = node.type === "VECTOR" ? roundedArcNetwork(data) : null;
      if (arcNetwork) yield applyVectorNetwork(node, arcNetwork, __spreadProps(__spreadValues({}, data), { vectorAutoLayoutBox: true }));
      if (node.type === "VECTOR" && data.vectorNetwork && !data.svgFallback) {
        yield applyVectorNetwork(node, data.vectorNetwork, data);
        reapplyVectorStrokeGeometry(node, data);
      }
      if (node.type === "TEXT" && data.characters !== void 0) {
        yield applyTextProperties(node, data);
      }
      if (node.type === "CONNECTOR") {
        yield applyConnectorProperties(node, data, true);
      }
    });
  }
  function reapplyVectorStrokeGeometry(node, data) {
    var _a, _b;
    const geometry = data && data.geometry;
    if (!geometry) return;
    if (geometry.strokeWeight !== void 0) safeSet(node, "strokeWeight", geometry.strokeWeight);
    if (geometry.strokeAlign) safeSet(node, "strokeAlign", geometry.strokeAlign);
    if (geometry.strokeJoin) safeSet(node, "strokeJoin", geometry.strokeJoin);
    if (geometry.dashPattern !== void 0) safeSet(node, "dashPattern", geometry.dashPattern);
    const hasVertexCaps = (_b = (_a = data.vectorNetwork) == null ? void 0 : _a.vertices) == null ? void 0 : _b.some((v) => v.strokeCap !== void 0);
    if (geometry.strokeCap && !data.connectorFallbackPolyline && !hasVertexCaps) {
      safeSet(node, "strokeCap", normalizeMasterGoStrokeCapForFigma(geometry.strokeCap));
    }
  }

  // src/appliers/booleanContours.ts
  var COINCIDENT_ENDPOINT_TOLERANCE = 1e-3;
  function closeCoincidentBooleanContour(network) {
    var _a, _b;
    if (!network || !Array.isArray(network.vertices) || !Array.isArray(network.segments) || network.segments.length < 3 || ((_a = network.regions) == null ? void 0 : _a.length)) return network;
    const vertices = network.vertices;
    const segments = network.segments;
    const edges = /* @__PURE__ */ new Map();
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (![segment.start, segment.end].every((index) => Number.isInteger(index) && index >= 0 && index < vertices.length) || segment.start === segment.end) return network;
      for (const index of [segment.start, segment.end]) {
        const vertex = vertices[index];
        if (!Number.isFinite(vertex == null ? void 0 : vertex.x) || !Number.isFinite(vertex == null ? void 0 : vertex.y)) return network;
        const incident = edges.get(index) || [];
        incident.push(i);
        if (incident.length > 2) return network;
        edges.set(index, incident);
      }
    }
    const ends = [...edges].filter(([, incident]) => incident.length === 1).map(([index]) => index);
    if (ends.length !== 2) return network;
    const first = vertices[ends[0]], last = vertices[ends[1]];
    if (Math.hypot(first.x - last.x, first.y - last.y) > COINCIDENT_ENDPOINT_TOLERANCE) return network;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const index of edges.keys()) {
      const vertex = vertices[index];
      minX = Math.min(minX, vertex.x);
      minY = Math.min(minY, vertex.y);
      maxX = Math.max(maxX, vertex.x);
      maxY = Math.max(maxY, vertex.y);
    }
    const width = maxX - minX, height = maxY - minY;
    if (width * height <= __pow(COINCIDENT_ENDPOINT_TOLERANCE, 2)) return network;
    const loop = [];
    const visited = /* @__PURE__ */ new Set();
    let current = ends[0];
    while (true) {
      const next = (_b = edges.get(current)) == null ? void 0 : _b.find((index) => !visited.has(index));
      if (next === void 0) break;
      visited.add(next);
      loop.push(next);
      const segment = segments[next];
      current = segment.start === current ? segment.end : segment.start;
    }
    if (visited.size !== segments.length || current !== ends[1]) return network;
    loop.push(segments.length);
    return __spreadProps(__spreadValues({}, network), {
      segments: [...segments, { start: ends[1], end: ends[0] }],
      regions: [{ windingRule: "EVENODD", loops: [loop] }]
    });
  }

  // src/appliers/container.ts
  function shouldRestoreBooleanVectorAsFrame(data, layerRecord) {
    if (!data || data.sourceType !== "BOOLEAN_OPERATION") return false;
    if (data.receiveCreateOverride || data.svgFallback) return false;
    if (data.type !== "VECTOR" && data.restoreType !== "VECTOR") return false;
    if (!layerRecord.childIds || layerRecord.childIds.length === 0) return false;
    return !hasUsableVectorNetwork(data.vectorNetwork);
  }
  function shouldRestoreBooleanOperationTree(data, layerRecord) {
    if (!data) return false;
    const hasBooleanChildren = data.sourceType === "BOOLEAN_OPERATION" && !!layerRecord && Array.isArray(layerRecord.childIds) && layerRecord.childIds.length > 0;
    return data.sourceType === "BOOLEAN_OPERATION" && (hasBooleanChildren || data.type === "BOOLEAN_OPERATION" || data.restoreType === "BOOLEAN_OPERATION" || data.receiveCreateOverride === "BOOLEAN_OPERATION");
  }
  function normalizeBooleanOperation(value) {
    if (value === "UNION" || value === "SUBTRACT" || value === "INTERSECT" || value === "EXCLUDE") {
      return value;
    }
    return null;
  }
  function clearGeometryPaint(geometry) {
    if (!geometry || typeof geometry !== "object") return geometry;
    return __spreadProps(__spreadValues({}, geometry), {
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeTopWeight: void 0,
      strokeBottomWeight: void 0,
      strokeLeftWeight: void 0,
      strokeRightWeight: void 0
    });
  }
  function createBooleanFrameFallbackProps(data) {
    return __spreadProps(__spreadValues({}, data), {
      type: "FRAME",
      restoreType: "FRAME",
      receiveCreateOverride: "FRAME",
      booleanFallback: "frameContainer",
      clipsContent: false,
      geometry: clearGeometryPaint(data.geometry)
    });
  }
  function createUntransformedContainerShellProps(data) {
    const props = createBooleanFrameFallbackProps(data);
    delete props.layout;
    delete props.constraints;
    return props;
  }
  function createContainerShellFrameProps(data) {
    return hasNonTranslationTransform(data == null ? void 0 : data.layout) ? createUntransformedContainerShellProps(data) : createBooleanFrameFallbackProps(data);
  }
  function createFinalizedContainerProps(data, preserveLayout = false) {
    const props = __spreadValues({}, data);
    if (!preserveLayout) {
      const layout = data && data.layout;
      if (layout) {
        const parentLayout = {};
        for (const key of ["layoutAlign", "layoutGrow", "layoutPositioning"]) {
          if (layout[key] !== void 0) parentLayout[key] = layout[key];
        }
        if (layout.layoutPositioning === "ABSOLUTE") {
          if (layout.x !== void 0) parentLayout.x = layout.x;
          if (layout.y !== void 0) parentLayout.y = layout.y;
        }
        props.layout = Object.keys(parentLayout).length > 0 ? parentLayout : void 0;
      }
    }
    return props;
  }
  function hasNonTranslationTransform(layout) {
    const transform = layout && layout.relativeTransform;
    if (!hasFiniteTransform(transform)) return false;
    return Math.abs(transform[0][0] - 1) > 1e-4 || Math.abs(transform[0][1]) > 1e-4 || Math.abs(transform[1][0]) > 1e-4 || Math.abs(transform[1][1] - 1) > 1e-4;
  }
  function hasFiniteTransform(transform) {
    return Array.isArray(transform) && Array.isArray(transform[0]) && Array.isArray(transform[1]) && Number.isFinite(transform[0][0]) && Number.isFinite(transform[0][1]) && Number.isFinite(transform[0][2]) && Number.isFinite(transform[1][0]) && Number.isFinite(transform[1][1]) && Number.isFinite(transform[1][2]);
  }
  function shouldRestoreComponentSetNode(data) {
    if (!data) return false;
    if (data.receiveCreateOverride === "SVG" || data.svgFallback) return false;
    return data.sourceType === "COMPONENT_SET" && (data.type === "COMPONENT_SET" || data.restoreType === "COMPONENT_SET" || data.receiveCreateOverride === "COMPONENT_SET");
  }
  function restoreComponentSetNode(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes, restoreNodeCallback, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      const shell = figma.createFrame();
      state.recordNodeCreation("container-shell");
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      const shellProps = createBooleanFrameFallbackProps(nodeProps);
      let appended = false;
      try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        yield applyPropertiesCallback(shell, shellProps);
      } catch (error) {
        console.warn("Unable to create component set restore shell:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return 0;
      }
      let restoredCount = 1;
      yield maybeReportProgressCallback(restoredBefore + restoredCount, totalNodes);
      for (const childId of childIds) {
        restoredCount += yield restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
      }
      yield finalizeComponentSetShell(shell, nodeProps, applyPropertiesCallback);
      return restoredCount;
    });
  }
  function finalizeComponentSetShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) {
        safeSet(shell, "name", data.name);
        return;
      }
      const components = shell.children.filter((child) => child.type === "COMPONENT");
      if (components.length < 1) {
        console.warn("Unable to create component set because it has no component children:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled");
        safeSet(shell, "name", data.name);
        return;
      }
      try {
        const parentIndex = parent.children.indexOf(shell);
        for (let index = 0; index < components.length; index++) {
          const component = components[index];
          safeSet(component, "name", createFigmaVariantName(component.name, index));
        }
        const componentSet = figma.combineAsVariants(
          components,
          parent,
          parentIndex >= 0 ? parentIndex : parent.children.length
        );
        state.recordNodeCreation("component-set");
        safeRemove(shell);
        yield applyPropertiesCallback(componentSet, data);
        restoreComponentSetChildLayouts(componentSet);
      } catch (error) {
        console.warn("Unable to create native component set, keeping frame fallback:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        safeSet(shell, "name", data.name);
      }
    });
  }
  function createFigmaVariantName(name, index) {
    const fallback = `Variant ${index + 1}`;
    if (!name) return `Property 1=${fallback}`;
    if (name.indexOf("=") > 0) {
      const pairs = name.split(",").map((pair) => {
        const equalsIndex = pair.indexOf("=");
        if (equalsIndex <= 0 || equalsIndex >= pair.length - 1) return null;
        const key = pair.slice(0, equalsIndex).replace(/(\[[^\]]*\])+\s*$/, "");
        return `${sanitizeVariantPropertyName(key)}=${sanitizeVariantValue(pair.slice(equalsIndex + 1), fallback)}`;
      });
      if (pairs.every((pair) => pair !== null)) return pairs.join(", ");
    }
    return `Property 1=${sanitizeVariantValue(name, fallback)}`;
  }
  function sanitizeVariantPropertyName(value) {
    const trimmed = String(value || "").trim();
    return trimmed || "Property 1";
  }
  function sanitizeVariantValue(value, fallback) {
    const trimmed = String(value || "").trim();
    return trimmed || fallback;
  }
  function restoreComponentSetChildLayouts(componentSet) {
    for (const child of componentSet.children) {
      if (child.type !== "COMPONENT") continue;
      const layout = state.restoredLayoutByNodeId[child.id];
      if (layout) {
        if (layout.width !== void 0 && layout.height !== void 0) {
          safeResize(child, layout.width, layout.height);
        }
        if (hasFiniteRelativeTransform3(layout)) {
          safeSet(child, "relativeTransform", layout.relativeTransform);
        } else {
          if (layout.x !== void 0) safeSet(child, "x", layout.x);
          if (layout.y !== void 0) safeSet(child, "y", layout.y);
        }
      }
    }
  }
  function hasFiniteRelativeTransform3(layout) {
    return Array.isArray(layout == null ? void 0 : layout.relativeTransform) && Array.isArray(layout.relativeTransform[0]) && Array.isArray(layout.relativeTransform[1]) && Number.isFinite(layout.relativeTransform[0][0]) && Number.isFinite(layout.relativeTransform[0][1]) && Number.isFinite(layout.relativeTransform[0][2]) && Number.isFinite(layout.relativeTransform[1][0]) && Number.isFinite(layout.relativeTransform[1][1]) && Number.isFinite(layout.relativeTransform[1][2]);
  }
  function shouldRestoreGroupNode(data) {
    if (!data) return false;
    if (data.receiveCreateOverride === "SVG" || data.svgFallback) return false;
    return data.sourceType === "GROUP" && (data.type === "GROUP" || data.restoreType === "GROUP" || data.receiveCreateOverride === "GROUP");
  }
  function restoreGroupNode(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes, restoreNodeCallback, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      const shell = figma.createFrame();
      state.recordNodeCreation("container-shell");
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      const shellProps = createContainerShellFrameProps(nodeProps);
      let appended = false;
      try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        yield applyPropertiesCallback(shell, shellProps);
      } catch (error) {
        console.warn("Unable to create group restore shell:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return 0;
      }
      let restoredCount = 1;
      yield maybeReportProgressCallback(restoredBefore + restoredCount, totalNodes);
      for (const childId of childIds) {
        restoredCount += yield restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
      }
      yield finalizeGroupShell(shell, nodeProps, applyPropertiesCallback);
      return restoredCount;
    });
  }
  function finalizeGroupShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      const children = [...shell.children];
      if (!parent || !("insertChild" in parent) || children.length < 1) {
        safeSet(shell, "name", data.name);
        return;
      }
      try {
        const parentIndex = parent.children.indexOf(shell);
        const group = figma.group(
          children,
          parent,
          parentIndex >= 0 ? parentIndex : parent.children.length
        );
        state.recordNodeCreation("group");
        safeRemove(shell);
        yield applyPropertiesCallback(group, createFinalizedContainerProps(data, hasNonTranslationTransform(data == null ? void 0 : data.layout)));
        if (!hasNonTranslationTransform(data == null ? void 0 : data.layout)) {
          state.nativeGroupOffsetByNodeId[group.id] = {
            x: Number.isFinite(group.x) ? group.x : 0,
            y: Number.isFinite(group.y) ? group.y : 0
          };
        }
      } catch (error) {
        console.warn("Unable to create native group, keeping frame fallback:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        safeSet(shell, "name", data.name);
      }
    });
  }
  function restoreBooleanOperationTree(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes, restoreNodeCallback, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      const shell = figma.createFrame();
      state.recordNodeCreation("container-shell");
      const shellProps = createBooleanFrameFallbackProps(nodeProps);
      let appended = false;
      try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        yield applyPropertiesCallback(shell, shellProps);
      } catch (error) {
        console.warn("Unable to create boolean restore shell:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return yield restoreBooleanFallbackNode(nodeProps, parent, layerRecord, restoredBefore, totalNodes, applyPropertiesCallback, maybeReportProgressCallback);
      }
      let restoredCount = 1;
      const currentCount = restoredBefore + restoredCount;
      yield maybeReportProgressCallback(currentCount, totalNodes);
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      for (const childId of childIds) {
        restoredCount += yield restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
      }
      const combined = yield combineBooleanShell(shell, nodeProps, applyPropertiesCallback);
      if (!combined) {
        yield restoreBooleanFallbackFromShell(shell, nodeProps, applyPropertiesCallback);
      }
      return restoredCount;
    });
  }
  function combineBooleanShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) return null;
      const children = [...shell.children];
      for (const child of children) {
        if (child.type !== "VECTOR") continue;
        const network = child.vectorNetwork;
        const closed = closeCoincidentBooleanContour(network);
        if (closed === network) continue;
        try {
          yield child.setVectorNetworkAsync(closed);
        } catch (error) {
          console.warn("Unable to close coincident boolean contour:", child.name, error);
        }
      }
      if (children.length === 1) {
        return yield promoteSingleBooleanChild(shell, children[0], data);
      }
      if (children.length < 1) {
        console.warn("Unable to restore boolean operation because it has no children:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled");
        return null;
      }
      const operation = normalizeBooleanOperation(data.booleanOperation);
      if (!operation) {
        console.warn("Unsupported boolean operation:", data == null ? void 0 : data.booleanOperation, (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled");
        return null;
      }
      try {
        const booleanChildren = flattenStrokeOnlyBooleanChildren(children, shell);
        const combined = createBooleanContainerNode(operation, booleanChildren, shell, parent);
        yield applyPropertiesCallback(combined, data);
        safeRemove(shell);
        return combined;
      } catch (error) {
        console.warn("Unable to combine boolean operation, falling back:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        return null;
      }
    });
  }
  function flattenStrokeOnlyBooleanChildren(children, parent) {
    const result = [];
    for (const child of children) {
      if (!shouldFlattenBooleanChild(child)) {
        result.push(child);
        continue;
      }
      try {
        const index = parent.children.indexOf(child);
        const flattened = figma.flatten([child], parent, index >= 0 ? index : parent.children.length);
        result.push(flattened);
      } catch (error) {
        console.warn("Unable to flatten stroked boolean child, keeping original:", child.name, error);
        result.push(child);
      }
    }
    return result;
  }
  function shouldFlattenBooleanChild(node) {
    if (!isStrokeOnlyWithoutVisibleFill(node)) return false;
    return hasClosedVectorRegion(node);
  }
  function hasClosedVectorRegion(node) {
    const vectorNetwork = node.vectorNetwork;
    return !!vectorNetwork && Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0;
  }
  function isStrokeOnlyWithoutVisibleFill(node) {
    if (!("strokes" in node)) return false;
    const strokes = node.strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) return false;
    if (!("fills" in node)) return true;
    const fills = node.fills;
    return !Array.isArray(fills) || fills.length === 0 || fills.every((fill) => !fill || fill.visible === false);
  }
  function createBooleanContainerNode(operation, children, shell, parent) {
    const parentIndex = parent.children.indexOf(shell);
    const operationNode = figma.createBooleanOperation();
    state.recordNodeCreation("boolean");
    safeSet(operationNode, "booleanOperation", operation);
    parent.insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, operationNode);
    for (const child of children) {
      operationNode.appendChild(child);
    }
    return operationNode;
  }
  function promoteSingleBooleanChild(shell, child, data) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) return null;
      try {
        const parentIndex = parent.children.indexOf(shell);
        const transform = composeSingleBooleanChildTransform(shell, child, data);
        parent.insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, child);
        if (transform) safeSet(child, "relativeTransform", transform);
        safeSet(child, "name", (data == null ? void 0 : data.name) || child.name);
        applyOuterBooleanPaint(child, data);
        safeRemove(shell);
        return child;
      } catch (error) {
        console.warn("Unable to promote single-child boolean operation:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        return null;
      }
    });
  }
  function applyOuterBooleanPaint(child, data) {
    if (!("fills" in child) || !("strokes" in child)) return;
    const geometry = data && data.geometry;
    const outerFills = geometry && geometry.fills;
    if (!geometry) return;
    if (Array.isArray(outerFills) && outerFills.some((f) => f && f.visible !== false)) {
      safeSetFills(child, normalizeImageFills(outerFills, child, data.layout));
    }
    const outerStrokes = geometry.strokes;
    if (Array.isArray(outerStrokes) && outerStrokes.length > 0) {
      safeSetStrokes(child, normalizeImageStrokes(outerStrokes, child, data.layout));
      if (geometry.strokeWeight !== void 0) safeSet(child, "strokeWeight", geometry.strokeWeight);
      if (geometry.strokeAlign !== void 0) safeSet(child, "strokeAlign", geometry.strokeAlign);
    }
  }
  function composeSingleBooleanChildTransform(shell, child, data) {
    var _a;
    const parentTransform = ((_a = data == null ? void 0 : data.layout) == null ? void 0 : _a.relativeTransform) || shell.relativeTransform;
    const childTransform = child.relativeTransform;
    if (!hasFiniteTransform(parentTransform) || !hasFiniteTransform(childTransform)) return null;
    return multiplyTransforms(parentTransform, childTransform);
  }
  function multiplyTransforms(parent, child) {
    return [
      [
        parent[0][0] * child[0][0] + parent[0][1] * child[1][0],
        parent[0][0] * child[0][1] + parent[0][1] * child[1][1],
        parent[0][0] * child[0][2] + parent[0][1] * child[1][2] + parent[0][2]
      ],
      [
        parent[1][0] * child[0][0] + parent[1][1] * child[1][0],
        parent[1][0] * child[0][1] + parent[1][1] * child[1][1],
        parent[1][0] * child[0][2] + parent[1][1] * child[1][2] + parent[1][2]
      ]
    ];
  }
  function restoreBooleanFallbackFromShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) return;
      state.booleanFallbackCount++;
      yield applyPropertiesCallback(shell, createBooleanFrameFallbackProps(data));
    });
  }
  function restoreBooleanFallbackNode(data, parent, layerRecord, restoredBefore, totalNodes, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      state.booleanFallbackCount++;
      const fallbackNode = figma.createFrame();
      state.recordNodeCreation("boolean-fallback");
      const fallbackProps = createBooleanFrameFallbackProps(data);
      try {
        if (!appendRestoredNode(parent, fallbackNode)) return 0;
        yield applyPropertiesCallback(fallbackNode, fallbackProps);
      } catch (error) {
        console.warn("Unable to restore boolean fallback:", (data == null ? void 0 : data.name) || layerRecord.name, error);
        safeRemove(fallbackNode);
        return 0;
      }
      const currentCount = restoredBefore + 1;
      yield maybeReportProgressCallback(currentCount, totalNodes);
      return 1;
    });
  }

  // src/code.ts
  var RESTORE_PROGRESS_NODE_INTERVAL = 100;
  var RESTORE_PROGRESS_TIME_INTERVAL_MS = 500;
  var PAGE_POSTPROCESS_STAGE_COUNT = 3;
  var RESTORE_BATCH_BUDGET_MS = 85;
  var RECEIVER_VERSION = "2026.11.10-v3.0";
  var UI_SETTINGS_STORAGE_KEY = "mastergo2figma.receive.settings";
  var activeImportSession = null;
  var lastRetainedImport = null;
  var pendingImportAssets = {};
  var pendingImportPages = {};
  var importOperationQueue = Promise.resolve();
  showImportUI();
  function showImportUI() {
    ensureLayerRulesLoaded();
    figma.showUI(__html__, { width: 400, height: 620 });
    figma.ui.onmessage = (message) => __async(null, null, function* () {
      if (!message || typeof message !== "object") return;
      if (message.type === "ui-ready") {
        yield postInitUI();
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
        yield handleImportRequest(message, () => startImportSession(message));
        return;
      }
      if (message.type === "import-session-abort") {
        const session = (activeImportSession == null ? void 0 : activeImportSession.transferId) === message.transferId ? activeImportSession : null;
        if (session) session.abortReason = String(message.error || "\u7528\u6237\u53D6\u6D88\u5BFC\u5165");
        yield enqueueImportOperation(() => abortImportSession(message, session));
        return;
      }
      if (message.type === "import-styles") {
        yield handleImportRequest(message, () => importSessionStyles(message));
        return;
      }
      if (message.type === "import-asset-start") {
        yield handleImportRequest(message, () => startImportAsset(message));
        return;
      }
      if (message.type === "import-asset-chunk") {
        appendImportAssetChunk(message);
        return;
      }
      if (message.type === "import-asset-end") {
        yield handleImportRequest(message, () => finishImportAsset(message));
        return;
      }
      if (message.type === "import-page-start") {
        yield handleImportRequest(message, () => startImportPage(message));
        return;
      }
      if (message.type === "import-page-chunk") {
        appendImportPageChunk(message);
        return;
      }
      if (message.type === "import-page-end") {
        yield handleImportRequest(message, () => finishImportPage(message));
        return;
      }
      if (message.type === "import-session-complete") {
        yield enqueueImportOperation(() => completeImportSession(message));
        return;
      }
      if (message.type === "refresh-fonts") {
        yield refreshMissingFontsInDocument();
        return;
      }
      if (message.type === "import-client-timing") {
        recordClientTiming(message);
        return;
      }
      if (message.type === "set-settings") {
        try {
          yield figma.clientStorage.setAsync(UI_SETTINGS_STORAGE_KEY, message.settings || {});
        } catch (error) {
          console.error("Failed to save settings:", error);
        }
        return;
      }
      if (message.type === "save-import-report") {
        yield saveImportReport(figma.clientStorage, message.report);
        return;
      }
      if (message.type === "start-import") {
        figma.ui.postMessage({
          type: "error",
          message: "\u5F53\u524D\u6D4B\u8BD5\u7248\u53EA\u652F\u6301 session/chunk \u6D41\u5F0F\u5BFC\u5165"
        });
        return;
      }
    });
  }
  function refreshMissingFontsInDocument() {
    return __async(this, null, function* () {
      state.fontLoadPromises = {};
      try {
        yield ensureLayerRulesLoaded();
        if (!hasValidLayerRules()) throw new Error("\u8BF7\u5148\u5BFC\u5165\u6709\u6548\u7684\u56FE\u5C42\u8F6C\u6362\u89C4\u5219 JSON");
        yield refreshAvailableFonts();
        const pages = figma.root.children.filter((node) => node.type === "PAGE");
        const missingFontRestoreResult = yield restoreMissingFontTextLayers(pages);
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
        const details = [];
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
          message: error instanceof Error ? error.message : "\u5237\u65B0\u5B57\u4F53\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
      }
    });
  }
  function enqueueImportOperation(action) {
    const next = importOperationQueue.then(action);
    importOperationQueue = next.then(() => void 0, () => void 0);
    return next;
  }
  function handleImportRequest(message, action) {
    return __async(this, null, function* () {
      return enqueueImportOperation(() => __async(null, null, function* () {
        const previousSession = activeImportSession;
        try {
          yield action();
          figma.ui.postMessage({
            type: "import-ack",
            requestId: message.requestId,
            transferId: message.transferId,
            success: true
          });
        } catch (error) {
          console.error("Import request failed:", error);
          const ownedSession = message.type === "import-session-start" ? previousSession ? null : activeImportSession : previousSession;
          const retainedImport = ownedSession && ownedSession === activeImportSession && ownedSession.transferId === message.transferId ? yield retainImportSession(ownedSession) : void 0;
          if (ownedSession && retainedImport) releaseImportSession(ownedSession);
          figma.ui.postMessage(__spreadProps(__spreadValues({
            type: "import-ack",
            requestId: message.requestId,
            transferId: message.transferId,
            success: false
          }, retainedImport ? { retainedImport } : {}), {
            error: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
          }));
        }
      }));
    });
  }
  function startImportSession(message) {
    return __async(this, null, function* () {
      var _a, _b, _c, _d, _e, _f;
      if (state.importInProgress) throw new Error("\u5DF2\u6709\u5BFC\u5165\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C");
      yield ensureLayerRulesLoaded();
      if (!hasValidLayerRules()) throw new Error("\u8BF7\u5148\u5BFC\u5165\u6709\u6548\u7684\u56FE\u5C42\u8F6C\u6362\u89C4\u5219 JSON");
      const manifest = message.manifest;
      const isValidManifest = manifest && (manifest.schema === "mastergo2figma.package.v2" && manifest.version === 2 || (manifest.schema === "mg2fig.package.v3" || manifest.schema === "mastergo2figma.package.v3") && manifest.version === 3);
      if (!isValidManifest) {
        throw new Error("\u5F53\u524D\u53EA\u652F\u6301 v2/v3 \u5BFC\u51FA\u5305\uFF0C\u8BF7\u7528\u65B0\u7248 Mg2Fig \u91CD\u65B0\u5BFC\u51FA\u3002");
      }
      const totalNodes = Number((_c = (_b = message.totalNodes) != null ? _b : (_a = manifest.stats) == null ? void 0 : _a.layerCount) != null ? _c : 0);
      const totalPages = Number((_f = (_e = message.totalPages) != null ? _e : (_d = manifest.pages) == null ? void 0 : _d.length) != null ? _f : 0);
      if (!Number.isInteger(totalNodes) || totalNodes < 0 || !Number.isInteger(totalPages) || totalPages <= 0) {
        throw new Error("\u5BFC\u5165\u9875\u9762\u6216\u56FE\u5C42\u6570\u91CF\u65E0\u6548");
      }
      state.importInProgress = true;
      state.reset();
      state.fontLoadPromises = {};
      state.resetRestoreRuntimeStats(totalNodes, totalPages);
      setMutationObserver((operation, written) => {
        const stats = state.activeRestoreStats;
        if (!state.importInProgress || !stats) return;
        if (operation === "set") {
          if (written) stats.safeSetWriteCount++;
          else stats.safeSetSkipCount++;
        } else {
          if (written) stats.resizeWriteCount++;
          else stats.resizeSkipCount++;
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
        knownComponentIds: new Set(Array.isArray(message.componentIds) ? message.componentIds.filter((id) => typeof id === "string") : []),
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
        figma.ui.postMessage({
          type: "progress",
          transferId: session.transferId,
          stage: "fonts",
          operationLabel: "\u5B57\u4F53\u68C0\u67E5\uFF1A\u8BFB\u53D6\u53EF\u7528\u5B57\u4F53\u76EE\u5F55",
          current: 0,
          total: totalNodes
        });
        const fonts = yield preflightImportFonts(message.fontRequests, (font, index, total) => {
          figma.ui.postMessage({
            type: "progress",
            transferId: session.transferId,
            stage: "fonts",
            operationLabel: `\u5B57\u4F53\u68C0\u67E5\uFF1A${font.family} \xB7 ${font.style}\uFF08${index}/${total}\uFF09`,
            current: 0,
            total: totalNodes
          });
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
    });
  }
  function importSessionStyles(message) {
    return __async(this, null, function* () {
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
              effectStyle.effects = style.effects.map((effect) => {
                const clone = __spreadValues({}, effect);
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
            yield ensureAvailableFontsLoaded();
            const fontName = resolveAvailableFontName(requestedFont) || requestedFont;
            yield loadFontCached(fontName);
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
          console.warn("[mg-style] \u6837\u5F0F\u521B\u5EFA\u5931\u8D25(\u8DF3\u8FC7):", style && style.name, error);
        }
      }
      console.info("[mg-style] created", created, "/", styles.length, "library styles");
    });
  }
  function sanitizeStylePaints(paints) {
    const out = [];
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
          gradientStops: paint.gradientStops.map((stop) => {
            var _a, _b, _c, _d;
            return {
              position: stop.position || 0,
              color: { r: ((_a = stop.color) == null ? void 0 : _a.r) || 0, g: ((_b = stop.color) == null ? void 0 : _b.g) || 0, b: ((_c = stop.color) == null ? void 0 : _c.b) || 0, a: ((_d = stop.color) == null ? void 0 : _d.a) === void 0 ? 1 : stop.color.a }
            };
          })
        });
        continue;
      }
    }
    return out;
  }
  function applyImportedStyleBindings(node, layerRecord) {
    return __async(this, null, function* () {
      const session = activeImportSession;
      if (!session) return;
      const map = session.figmaStyleIdByRef;
      const fillRef = layerRecord.fillStyleRef;
      const strokeRef = layerRecord.strokeStyleRef;
      const effectRef = layerRecord.effectStyleRef;
      const textRef = layerRecord.textStyleRef;
      const textRanges = layerRecord.textStyleRanges || [];
      if (!fillRef && !strokeRef && !effectRef && !textRef && textRanges.length === 0) return;
      try {
        if (fillRef && map[fillRef] && "setFillStyleIdAsync" in node) yield node.setFillStyleIdAsync(map[fillRef]);
      } catch (error) {
      }
      try {
        if (strokeRef && map[strokeRef] && "setStrokeStyleIdAsync" in node) yield node.setStrokeStyleIdAsync(map[strokeRef]);
      } catch (error) {
      }
      try {
        if (effectRef && map[effectRef] && "setEffectStyleIdAsync" in node) yield node.setEffectStyleIdAsync(map[effectRef]);
      } catch (error) {
      }
      try {
        if (textRef && map[textRef] && node.type === "TEXT" && "setTextStyleIdAsync" in node) {
          yield node.setTextStyleIdAsync(map[textRef]);
        }
      } catch (error) {
      }
      if (node.type === "TEXT") {
        for (const range of textRanges) {
          if (!map[range.styleRef] || range.start < 0 || range.end > node.characters.length || range.end <= range.start) continue;
          try {
            yield node.setRangeTextStyleIdAsync(range.start, range.end, map[range.styleRef]);
          } catch (error) {
          }
        }
      }
    });
  }
  function startImportAsset(message) {
    const session = requireImportSession(message.transferId);
    const path = String(message.path || "");
    if (!path) throw new Error("\u56FE\u7247\u8D44\u6E90\u7F3A\u5C11\u8DEF\u5F84");
    pendingImportAssets[path] = {
      path,
      keys: Array.isArray(message.keys) ? message.keys.filter((key) => typeof key === "string") : [],
      size: Number(message.size || 0),
      chunks: []
    };
    void session;
  }
  function appendImportAssetChunk(message) {
    if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
    const path = String(message.path || "");
    const pending = pendingImportAssets[path];
    if (!pending) return;
    const bytes = normalizeBytes(message.bytes);
    if (bytes) pending.chunks.push(bytes);
  }
  function finishImportAsset(message) {
    const session = requireImportSession(message.transferId);
    const path = String(message.path || "");
    const pending = pendingImportAssets[path];
    if (!pending) throw new Error(`\u56FE\u7247\u8D44\u6E90\u4F20\u8F93\u4E0D\u5B58\u5728\uFF1A${path}`);
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
  function startImportPage(message) {
    requireImportSession(message.transferId);
    const pageIndex = Number(message.pageIndex || 0);
    const importPage = message.page;
    if (!importPage || !Array.isArray(importPage.rootNodeIds)) throw new Error("\u9875\u9762\u5BFC\u5165\u6570\u636E\u4E0D\u5B8C\u6574");
    pendingImportPages[String(pageIndex)] = {
      pageIndex,
      page: importPage,
      layers: {},
      recordCount: 0,
      error: void 0
    };
  }
  function appendImportPageChunk(message) {
    if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
    const startedAt = Date.now();
    const pageIndex = String(Number(message.pageIndex || 0));
    const pending = pendingImportPages[pageIndex];
    if (!pending || !Array.isArray(message.records)) return;
    for (const record of message.records) {
      if (record && record.id) {
        if (pending.layers[record.id]) {
          pending.error = `\u9875\u9762\u5206\u5757\u5305\u542B\u91CD\u590D\u56FE\u5C42\uFF1A${record.id}`;
          continue;
        }
        pending.layers[record.id] = record;
        pending.recordCount++;
      }
    }
    addImportTiming(activeImportSession, "page.receiveChunkMs", Date.now() - startedAt);
    addImportTimingCount(activeImportSession, "page.receiveChunkCount", 1);
  }
  function finishImportPage(message) {
    return __async(this, null, function* () {
      const session = requireImportSession(message.transferId);
      const pageIndex = Number(message.pageIndex || 0);
      const pendingKey = String(pageIndex);
      const pending = pendingImportPages[pendingKey];
      if (!pending) throw new Error(`\u9875\u9762\u4F20\u8F93\u4E0D\u5B58\u5728\uFF1A${pendingKey}`);
      session.activePageRequest = { requestId: message.requestId, pageIndex, pageName: pending.page.name || pending.page.id };
      try {
        if (pending.error) throw new Error(pending.error);
        const expectedCount = Number(pending.page.layerCount || 0);
        if (expectedCount > 0 && Object.keys(pending.layers).length !== expectedCount) {
          throw new Error(`\u9875\u9762\u56FE\u5C42\u6570\u91CF\u4E0D\u4E00\u81F4\uFF1Aexpected=${expectedCount}, actual=${Object.keys(pending.layers).length}`);
        }
        addImportTimingCount(session, "page.receivedRecordCount", pending.recordCount);
        yield restoreImportPageData(pending.page, pending.layers, pageIndex);
        if (session.pageStates[pageIndex]) session.pageStates[pageIndex].completed = true;
      } finally {
        session.activePageRequest = void 0;
        delete pendingImportPages[pendingKey];
      }
    });
  }
  function restoreImportPageData(importPage, layers, pageIndex = 0) {
    return __async(this, null, function* () {
      var _a;
      if (!activeImportSession) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u91CD\u7F6E");
      const session = activeImportSession;
      const pageName = createRestoredPageName(importPage.name);
      const pageNodeCount = countLayerRecords(layers);
      if (importPage.layerCount !== void 0 && pageNodeCount !== Number(importPage.layerCount)) {
        throw new Error(`\u9875\u9762\u8BB0\u5F55\u6570\u91CF\u4E0D\u4E00\u81F4\uFF1Aexpected=${importPage.layerCount}, actual=${pageNodeCount}`);
      }
      restoreLegacyWrapLayout(layers);
      const postprocessStart = session.postProcessedNodes;
      figma.ui.postMessage(__spreadProps(__spreadValues({
        type: "progress",
        transferId: session.transferId,
        stage: "restore"
      }, pageProgressContext(session)), {
        current: session.restoredNodes,
        total: session.totalNodes
      }));
      const pageCreateStartedAt = Date.now();
      const restoredPage = figma.createPage();
      state.recordNodeCreation("page");
      restoredPage.name = pageName;
      if (importPage.background) {
        const bg = importPage.background;
        try {
          restoredPage.backgrounds = [{ type: "SOLID", color: { r: bg.r, g: bg.g, b: bg.b }, opacity: bg.a }];
        } catch (error) {
        }
      }
      session.restoredPages.push(restoredPage);
      session.pageStates[pageIndex] = { page: restoredPage, completed: false };
      if (importPage.isDependencyPage) session.dependencyPages.push(restoredPage);
      else session.designPages.push(restoredPage);
      yield figma.setCurrentPageAsync(restoredPage);
      throwIfImportAborted(session);
      addImportTiming(session, "restore.createPageMs", Date.now() - pageCreateStartedAt);
      const nodeRestoreStartedAt = Date.now();
      const maskFillExplicitIds = [];
      const maskFillSuppressedIds = [];
      let hasComponentReferences = false;
      for (const id in layers) {
        const record = layers[id];
        if (((_a = record == null ? void 0 : record.props) == null ? void 0 : _a.type) === "COMPONENT") session.knownComponentIds.add(id);
        const maskFill = record == null ? void 0 : record.maskRendersFill;
        if (maskFill === true) maskFillExplicitIds.push(id);
        else if (maskFill === false) maskFillSuppressedIds.push(id);
        if (!hasComponentReferences && (record == null ? void 0 : record.mainComponentId)) hasComponentReferences = true;
      }
      let restoredOnPage = 0;
      const rootIds = importPage.rootNodeIds;
      const isComponentRoot = (id) => {
        const record = layers[id];
        const type = record && record.props ? record.props.type : null;
        return type === "COMPONENT" || type === "COMPONENT_SET";
      };
      const baseOrder = [...rootIds.filter(isComponentRoot), ...rootIds.filter((id) => !isComponentRoot(id))];
      let restoreOrder = baseOrder;
      if (hasComponentReferences) {
        const rootOfRecord = {};
        for (const rootId of rootIds) {
          const stack = [rootId];
          while (stack.length > 0) {
            const cur = stack.pop();
            if (rootOfRecord[cur] !== void 0) continue;
            rootOfRecord[cur] = rootId;
            const rec = layers[cur];
            for (const cid of rec && rec.childIds || []) stack.push(cid);
          }
        }
        const dependsOn = {};
        for (const rootId of rootIds) dependsOn[rootId] = {};
        for (const id in rootOfRecord) {
          const rec = layers[id];
          const target = rec ? rec.mainComponentId : void 0;
          if (!target) continue;
          const fromRoot = rootOfRecord[id];
          const toRoot = rootOfRecord[target];
          if (toRoot !== void 0 && toRoot !== fromRoot && dependsOn[fromRoot]) dependsOn[fromRoot][toRoot] = true;
        }
        restoreOrder = [];
        const rootVisitState = {};
        const visitRoot = (rootId) => {
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
      const restoredRootNodes = {};
      for (const rootId of restoreOrder) {
        const childCountBefore = needsRootReorder ? restoredPage.children.length : 0;
        const restored = yield restoreImportedNode(rootId, restoredPage, layers, session.restoredNodes, session.totalNodes);
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
      if (restoredOnPage !== pageNodeCount) throw new Error(`\u9875\u9762\u8FD8\u539F\u6570\u91CF\u4E0D\u4E00\u81F4\uFF1Aexpected=${pageNodeCount}, actual=${restoredOnPage}`);
      addImportTiming(session, "restore.nodesMs", Date.now() - nodeRestoreStartedAt);
      addImportTimingCount(session, "restore.pageCount", 1);
      const relinkStartedAt = Date.now();
      yield retryDeferredInstanceRelinks(layers);
      addImportTiming(session, "restore.deferredRelinkMs", Date.now() - relinkStartedAt);
      for (const id of maskFillExplicitIds) {
        const maskNode = session.restoredNodeById[id];
        if (maskNode && !maskNode.removed) session.maskFillExplicitNodeIds[maskNode.id] = true;
      }
      for (const id of maskFillSuppressedIds) {
        const maskNode = session.restoredNodeById[id];
        if (maskNode && !maskNode.removed) session.maskFillSuppressedNodeIds[maskNode.id] = true;
      }
      yield reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 0, 0, 1);
      const layoutStartedAt = Date.now();
      yield applyDeferredLayoutRestores((done, total) => {
        return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 0, done, total);
      });
      addImportTiming(session, "postprocess.deferredLayoutMs", Date.now() - layoutStartedAt);
      flushInstanceChildLayoutOverrides(false);
      const cleanupStartedAt = Date.now();
      yield cleanupImportedContainerShells(restoredPage, (done, total) => {
        return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 1, done, total);
      }, state.shellPlaceholderCandidates);
      state.shellPlaceholderCandidates = [];
      addImportTiming(session, "postprocess.cleanupShellsMs", Date.now() - cleanupStartedAt);
      const autoSpaceStartedAt = Date.now();
      yield applyDeferredSingleChildAutoSpaceAlignmentFixes((done, total) => {
        return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 2, done, total);
      });
      addImportTiming(session, "postprocess.singleChildAutoSpaceMs", Date.now() - autoSpaceStartedAt);
      session.postProcessedNodes = Math.min(session.totalNodes, postprocessStart + pageNodeCount);
      yield reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, PAGE_POSTPROCESS_STAGE_COUNT - 1, 1, 1);
      state.restoredLayoutByNodeId = {};
      state.nativeGroupOffsetByNodeId = {};
      yield yieldToEventLoop();
      throwIfImportAborted(session);
    });
  }
  function countLayerRecords(layers) {
    return layers && typeof layers === "object" ? Object.keys(layers).length : 0;
  }
  function reportPagePostprocessProgress(session, pageIndex, pagePostprocessStart, pageNodeCount, stageIndex, done, total) {
    return __async(this, null, function* () {
      throwIfImportAborted(session);
      const stageRatio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 1;
      const completedRatio = Math.max(0, Math.min(1, (stageIndex + stageRatio) / PAGE_POSTPROCESS_STAGE_COUNT));
      const postprocessCurrent = Math.min(session.totalNodes, pagePostprocessStart + pageNodeCount * completedRatio);
      figma.ui.postMessage(__spreadProps(__spreadValues({
        type: "progress",
        transferId: session.transferId,
        stage: "postprocess",
        pageIndex
      }, pageProgressContext(session)), {
        current: session.restoredNodes,
        total: session.totalNodes,
        postprocessCurrent,
        postprocessTotal: session.totalNodes
      }));
    });
  }
  function completeImportSession(message) {
    return __async(this, null, function* () {
      if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
      const session = activeImportSession;
      if (message.clientTimings) session.clientTimings = message.clientTimings;
      try {
        if (session.restoredPages.length !== session.totalPages) {
          throw new Error(`\u4F1A\u8BDD\u9875\u9762\u6570\u91CF\u4E0D\u4E00\u81F4\uFF1Aexpected=${session.totalPages}, actual=${session.restoredPages.length}`);
        }
        if (session.restoredNodes !== session.totalNodes) {
          throw new Error(`\u4F1A\u8BDD\u56FE\u5C42\u6570\u91CF\u4E0D\u4E00\u81F4\uFF1Aexpected=${session.totalNodes}, actual=${session.restoredNodes}`);
        }
        const finalRelinkStartedAt = Date.now();
        yield retryDeferredInstanceRelinks({}, true);
        addImportTiming(session, "finalize.deferredInstancesMs", Date.now() - finalRelinkStartedAt);
        const finalLayoutStartedAt = Date.now();
        yield applyDeferredLayoutRestores();
        addImportTiming(session, "finalize.deferredLayoutMs", Date.now() - finalLayoutStartedAt);
        const finalCleanupStartedAt = Date.now();
        for (const page of session.restoredPages) {
          yield cleanupImportedContainerShells(page, void 0, state.shellPlaceholderCandidates);
        }
        state.shellPlaceholderCandidates = [];
        addImportTiming(session, "finalize.cleanupShellsMs", Date.now() - finalCleanupStartedAt);
        const finalAutoSpaceStartedAt = Date.now();
        yield applyDeferredSingleChildAutoSpaceAlignmentFixes();
        addImportTiming(session, "finalize.singleChildAutoSpaceMs", Date.now() - finalAutoSpaceStartedAt);
        postFinalizeProgress(session, 0, 4);
        const connectorStartedAt = Date.now();
        yield applyDeferredConnectorRestores();
        addImportTiming(session, "finalize.connectorsMs", Date.now() - connectorStartedAt);
        postFinalizeProgress(session, 1, 4);
        const missingFontStartedAt = Date.now();
        const missingFontRestoreResult = yield restoreMissingFontTextLayers(session.restoredPages, state.missingFontTextCandidates);
        addImportTiming(session, "finalize.missingFontsMs", Date.now() - missingFontStartedAt);
        postFinalizeProgress(session, 2, 4);
        flushInstanceChildLayoutOverrides(true);
        paintFilledMaskTwins(session);
        const viewportStartedAt = Date.now();
        if (session.designPages.length > 0) {
          yield figma.setCurrentPageAsync(session.designPages[0]);
          const children = session.designPages[0].children;
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
        figma.notify(unresolvedInstanceDetails.length > 0 ? `\u8FC1\u79FB\u5B8C\u6210\uFF0C${unresolvedInstanceDetails.length} \u4E2A\u5B9E\u4F8B\u5DF2\u8FD8\u539F\u4E3A\u666E\u901A\u56FE\u5C42\uFF0C\u8BF7\u67E5\u770B\u8FC1\u79FB\u62A5\u544A\u3002` : "Restore complete!");
      } catch (error) {
        const retainedImport = yield retainImportSession(session);
        console.error("Import failed:", error);
        figma.ui.postMessage({
          type: "error",
          transferId: session.transferId,
          retainedImport,
          message: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
      } finally {
        releaseImportSession(session);
      }
    });
  }
  function postFinalizeProgress(session, current, total) {
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
  function addImportTiming(session, phase, ms) {
    if (!session || !Number.isFinite(ms)) return;
    session.timings[phase] = (session.timings[phase] || 0) + Math.max(0, Math.round(ms));
    session.timingCounts[phase] = (session.timingCounts[phase] || 0) + 1;
  }
  function addImportTimingCount(session, phase, count) {
    if (!session || !Number.isFinite(count)) return;
    session.timingCounts[phase] = (session.timingCounts[phase] || 0) + Math.max(0, Math.round(count));
  }
  function recordClientTiming(message) {
    if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
    activeImportSession.clientTimings = message.clientTimings || activeImportSession.clientTimings;
  }
  function logImportPerformanceSummary(session, missingFontRestoreResult) {
    var _a;
    const durationMs = Math.max(Date.now() - (((_a = state.activeRestoreStats) == null ? void 0 : _a.startedAt) || Date.now()), 1);
    const nodesPerSecond = Math.round(session.restoredNodes / durationMs * 1e4) / 10;
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
    let targetDocumentName = null;
    let targetFileKey = null;
    try {
      if (typeof figma.root.name === "string") targetDocumentName = figma.root.name;
    } catch (_) {
    }
    try {
      if (typeof figma.fileKey === "string") targetFileKey = figma.fileKey;
    } catch (_) {
    }
    return { targetDocumentName, targetFileKey };
  }
  function buildImportPerformanceReport(session) {
    const stats = state.activeRestoreStats;
    return __spreadValues({
      schemaVersion: 1,
      receiverVersion: RECEIVER_VERSION,
      mainMs: Math.max(0, Date.now() - ((stats == null ? void 0 : stats.startedAt) || Date.now())),
      sourceRecordCount: session.restoredNodes,
      textChildContainerDetails: session.textChildContainerDetails,
      apiCreationCount: (stats == null ? void 0 : stats.apiCreationCount) || 0,
      creationCountMeaning: "successful direct node factory calls; SVG/instance implicit descendants are not separate API calls",
      stagesMs: __spreadValues({}, session.timings),
      stageCounts: __spreadValues({}, session.timingCounts),
      restoreStats: stats ? __spreadProps(__spreadValues({}, stats), {
        restoredNodes: session.restoredNodes,
        pageCount: session.restoredPages.length,
        creationCounts: __spreadValues({}, stats.creationCounts)
      }) : null,
      clientTimings: session.clientTimings,
      sourceDocumentName: session.manifest.documentName || null
    }, getTargetDocumentInfo());
  }
  function abortImportSession(message, cancelledSession = null) {
    return __async(this, null, function* () {
      const session = activeImportSession;
      const previous = lastRetainedImport && lastRetainedImport.transferId === message.transferId ? lastRetainedImport.summary : void 0;
      if (previous && (!session || session.transferId !== message.transferId)) {
        figma.ui.postMessage({
          type: "import-ack",
          requestId: message.requestId,
          transferId: message.transferId,
          success: true,
          retainedImport: previous
        });
        return;
      }
      if (!session || session.transferId !== message.transferId) {
        figma.ui.postMessage({
          type: "import-ack",
          requestId: message.requestId,
          transferId: message.transferId,
          success: false,
          error: "\u5BFC\u5165\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u91CD\u7F6E"
        });
        return;
      }
      if (cancelledSession && cancelledSession !== session) return;
      const retainedImport = yield retainImportSession(session);
      releaseImportSession(session);
      figma.ui.postMessage({
        type: "import-ack",
        requestId: message.requestId,
        transferId: message.transferId,
        success: true,
        retainedImport
      });
    });
  }
  function requireImportSession(transferId) {
    if (!activeImportSession || activeImportSession.transferId !== transferId) {
      throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u91CD\u7F6E");
    }
    throwIfImportAborted(activeImportSession);
    return activeImportSession;
  }
  function throwIfImportAborted(session = activeImportSession) {
    if (session == null ? void 0 : session.abortReason) throw new Error(`\u5BFC\u5165\u5DF2\u53D6\u6D88\uFF1A${session.abortReason}`);
  }
  function pageProgressContext(session) {
    return __spreadProps(__spreadValues({}, (session == null ? void 0 : session.activePageRequest) || {}), { receiverVersion: RECEIVER_VERSION });
  }
  function concatBytes(chunks, expectedSize) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (expectedSize > 0 && size !== expectedSize) {
      throw new Error(`\u56FE\u7247\u8D44\u6E90\u4F20\u8F93\u4E0D\u5B8C\u6574\uFF1Aexpected=${expectedSize}, actual=${size}`);
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
  function releaseImportSession(session) {
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
  function retainImportSession(session) {
    return __async(this, null, function* () {
      const cleanupWarnings = session.retentionWarnings;
      const aborted = session.abortReason;
      session.abortReason = void 0;
      session.retainingFailedImport = true;
      const deferred = [];
      for (const key of Object.keys(session.deferredInstanceRelinks)) deferred.push(...session.deferredInstanceRelinks[key]);
      session.deferredInstanceRelinks = {};
      for (const entry of deferred) {
        try {
          yield materializeDeferredFallback(session, entry);
        } catch (_) {
        } finally {
          settleDeferredOwner(session, entry);
        }
      }
      try {
        yield applyDeferredLayoutRestores();
      } catch (error) {
        cleanupWarnings.push(`\u5E03\u5C40\u6536\u5C3E\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      session.abortReason = aborted;
      const pages = session.manifest.pages.map((source, index) => {
        const progress = session.pageStates[index];
        const page = (progress == null ? void 0 : progress.page) && !progress.page.removed ? progress.page : null;
        return {
          sourcePageId: source.id,
          sourcePageName: source.name,
          targetPageId: (page == null ? void 0 : page.id) || null,
          targetPageName: (page == null ? void 0 : page.name) || null,
          status: !page ? "pending" : progress.completed ? "completed" : "partial",
          sourceRecordCount: Number(source.layerCount) || 0
        };
      });
      const completed = pages.filter((page) => page.status === "completed");
      const partial = pages.filter((page) => page.status === "partial");
      const summary = {
        status: completed.length + partial.length > 0 ? "partial" : "failed",
        pages,
        completedPageCount: completed.length,
        partialPageCount: partial.length,
        pendingPageCount: pages.length - completed.length - partial.length,
        retainedPageCount: completed.length + partial.length,
        completedSourceRecordCount: completed.reduce((sum, page) => sum + page.sourceRecordCount, 0),
        reportedRestoredRecordCount: session.restoredNodes,
        totalSourceRecordCount: session.totalNodes,
        cleanupWarnings
      };
      lastRetainedImport = { transferId: session.transferId, summary };
      const target = session.designPages.find((page) => !page.removed) || session.restoredPages.find((page) => !page.removed) || session.previousCurrentPage;
      try {
        if (target && !target.removed) yield figma.setCurrentPageAsync(target);
      } catch (error) {
        cleanupWarnings.push(`\u9875\u9762\u5B9A\u4F4D\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      const report = __spreadProps(__spreadValues({}, buildImportPerformanceReport(session)), { sourceRecordCount: session.totalNodes, retainedImport: summary });
      yield saveImportReport(figma.clientStorage, {
        schemaVersion: 1,
        sourceName: session.manifest.documentName || "\u672A\u77E5\u6E90\u6587\u4EF6",
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        target: { documentName: report.targetDocumentName, fileKey: report.targetFileKey },
        performanceReport: report
      });
      return summary;
    });
  }
  function recordStreamedMissingImage(assetName) {
    if (state.missingImageAssetNames[assetName]) return;
    state.missingImageAssetNames[assetName] = true;
    state.missingImageAssetCount++;
  }
  function postInitUI() {
    return __async(this, null, function* () {
      yield ensureLayerRulesLoaded();
      let settings = null;
      try {
        settings = yield figma.clientStorage.getAsync(UI_SETTINGS_STORAGE_KEY);
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
      figma.ui.postMessage(__spreadValues({
        type: "init",
        rules: getLayerRuleStatus(),
        settings,
        receiverVersion: RECEIVER_VERSION,
        lastImportReport: yield readImportReport(figma.clientStorage)
      }, getTargetDocumentInfo()));
    });
  }
  function normalizeBytes(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return new Uint8Array(value);
    if (typeof value.length === "number") return new Uint8Array(value);
    if (typeof value === "object") {
      const keys = Object.keys(value).filter((key) => /^\d+$/.test(key));
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
  function createRestoredPageName(name) {
    return (name || "Imported Page").replace(/\//g, "\u2215");
  }
  function maybeReportRestoreProgress(current, total, force = false) {
    return __async(this, null, function* () {
      var _a;
      throwIfImportAborted();
      const now = Date.now();
      const progState = state.activeProgressState || {
        total,
        lastCurrent: 0,
        lastPostedAt: 0,
        lastYieldAt: now
      };
      current = Math.min(current, total);
      const shouldPost = force || current >= total && progState.lastCurrent < total || current - progState.lastCurrent >= RESTORE_PROGRESS_NODE_INTERVAL || now - progState.lastPostedAt >= RESTORE_PROGRESS_TIME_INTERVAL_MS;
      if (shouldPost) {
        figma.ui.postMessage(__spreadProps(__spreadValues({
          type: "progress",
          transferId: activeImportSession ? activeImportSession.transferId : void 0
        }, pageProgressContext(activeImportSession)), {
          stage: "restore",
          current,
          total
        }));
        progState.total = total;
        progState.lastCurrent = current;
        progState.lastPostedAt = now;
      }
      state.activeProgressState = progState;
      if (force || now - ((_a = progState.lastYieldAt) != null ? _a : now) >= RESTORE_BATCH_BUDGET_MS) {
        yield yieldToEventLoop();
        throwIfImportAborted();
        progState.lastYieldAt = Date.now();
        if (state.activeRestoreStats) state.activeRestoreStats.restoreBatchYieldCount++;
      }
    });
  }
  function logMissingImportDiagnostics(missingFontRestoreResult) {
    logMissingFontRefreshDiagnostics(missingFontRestoreResult);
    const missingImageNames = Object.keys(state.missingImageAssetNames).sort();
    if (missingImageNames.length > 0) {
      console.warn("[MasterGo2Figma] \u7F3A\u5931\u56FE\u7247\u8D44\u6E90\uFF08\u53BB\u91CD\uFF09", missingImageNames);
    }
    if (state.missingImageAssetDetails.length > 0) {
      console.warn("[MasterGo2Figma] \u7F3A\u5931\u56FE\u7247\u5F71\u54CD\u56FE\u5C42", state.missingImageAssetDetails.map((detail) => ({
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
      console.warn("[MasterGo2Figma] \u7F3A\u5931\u56FE\u7247\u5F71\u54CD\u56FE\u5C42\u672A\u80FD\u5B9A\u4F4D\uFF1B\u8D44\u6E90\u53EF\u80FD\u5728\u4F20\u8F93\u9636\u6BB5\u521B\u5EFA\u5931\u8D25\u3002");
    }
  }
  function logMissingFontRefreshDiagnostics(missingFontRestoreResult) {
    if (missingFontRestoreResult.missingFonts.length > 0) {
      console.warn("[MasterGo2Figma] \u7F3A\u5931\u5B57\u4F53\uFF08\u53BB\u91CD\uFF09", missingFontRestoreResult.missingFonts.map((font) => ({
        family: font.family,
        style: font.style,
        textNodeCount: font.count
      })));
      return;
    }
    console.info("[MasterGo2Figma] \u7F3A\u5931\u5B57\u4F53\uFF08\u53BB\u91CD\uFF09", []);
  }
  function applyManifestLayoutToProps(props, _meta) {
    return props;
  }
  function isConnectorRestoreData(data) {
    return !!data && (data.sourceType === "CONNECTOR" || data.type === "CONNECTOR" || data.restoreType === "CONNECTOR");
  }
  function prepareConnectorPolylineFallbackProps(data, parent, layers) {
    var _a, _b;
    if (!isConnectorRestoreData(data)) return data;
    const props = __spreadValues({}, data);
    props.connectorFallbackPolyline = true;
    for (const key of ["connectorStart", "connectorEnd"]) {
      const endpoint = props[key];
      const layout = (_b = (_a = layers[endpoint == null ? void 0 : endpoint.endpointNodeId]) == null ? void 0 : _a.props) == null ? void 0 : _b.layout;
      const transform = layout == null ? void 0 : layout.relativeTransform;
      if (layout && (!transform || transform[0][0] === 1 && transform[0][1] === 0 && transform[1][0] === 0 && transform[1][1] === 1)) {
        props[key] = __spreadProps(__spreadValues({}, endpoint), { width: layout.width });
      }
    }
    if (!hasUsableVectorNetwork(props.vectorNetwork)) {
      props.vectorNetwork = createConnectorVectorNetworkFromData(props, parent);
    }
    return props;
  }
  function shouldPreserveVectorLayoutBoxForAutoLayout(data, parent) {
    if (!data || !data.vectorNetwork) return false;
    const sourceType = data.sourceType || data.type;
    if (sourceType !== "PEN" && sourceType !== "VECTOR") return false;
    if (!parent || !("id" in parent)) return false;
    const restoredParentLayout = state.restoredLayoutByNodeId[parent.id];
    const parentLayoutMode = restoredParentLayout && restoredParentLayout.layoutMode;
    if (parentLayoutMode && parentLayoutMode !== "NONE") return true;
    return "layoutMode" in parent && parent.layoutMode !== "NONE";
  }
  function markVectorAutoLayoutBox(data) {
    return __spreadProps(__spreadValues({}, data), {
      vectorAutoLayoutBox: true
    });
  }
  function restoreImportedNode(nodeId, parent, layers, restoredBefore, totalNodes) {
    return __async(this, null, function* () {
      var _a, _b, _c;
      throwIfImportAborted();
      const layerRecord = layers[nodeId];
      if (!layerRecord || !layerRecord.props) {
        throw new Error(`\u7F3A\u5C11\u56FE\u5C42\u8BB0\u5F55\uFF1A${nodeId}`);
      }
      if (layerRecord.mainComponentId && !layerRecord.instanceStructureFallback) {
        const instanceRestored = yield tryRestoreAsInstance(layerRecord, parent, layers, restoredBefore, totalNodes);
        if (instanceRestored > 0) return instanceRestored;
      }
      const deferInstanceChildren = !!(activeImportSession && !activeImportSession.finalizingDeferredFallbacks && layerRecord.mainComponentId && !layerRecord.instanceStructureFallback && unavailableInstanceDependency(layerRecord, layers, activeImportSession));
      let nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
      if (shouldRestoreBooleanOperationTree(nodeProps, layerRecord)) {
        return yield restoreBooleanOperationTree(
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
        return yield restoreGroupNode(
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
        return yield restoreComponentSetNode(
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
      const newNode = yield createNodeFromData(nodeProps);
      addImportTiming(activeImportSession, "restore.createNodeMs", Date.now() - createStartedAt);
      if (!newNode) throw new Error(`\u65E0\u6CD5\u521B\u5EFA\u56FE\u5C42\uFF1A${(nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name || nodeId}`);
      const childIds = nodeProps.omitChildrenOnRestore || deferInstanceChildren ? [] : layerRecord.childIds || [];
      let restoredNode = newNode;
      let textWrapper = null;
      try {
        const appendStartedAt = Date.now();
        if (newNode.type === "TEXT" && childIds.length > 0) {
          textWrapper = figma.createFrame();
          state.recordNodeCreation("text-child-container");
          textWrapper.setPluginData("mastergo2figma.textChildContainer", "1");
          if (!appendRestoredNode(parent, textWrapper)) throw new Error(`\u65E0\u6CD5\u6302\u8F7D\u6587\u672C\u5BB9\u5668\uFF1A${nodeId}`);
          yield applyProperties(textWrapper, {
            id: nodeProps.id,
            name: nodeProps.name,
            layout: nodeProps.layout,
            constraints: nodeProps.constraints,
            scence: nodeProps.scence,
            blend: nodeProps.blend,
            geometry: { fills: [], strokes: [] },
            clipsContent: false
          });
          textWrapper.appendChild(newNode);
          restoredNode = textWrapper;
        } else if (!appendRestoredNode(parent, newNode)) {
          throw new Error(`\u65E0\u6CD5\u6302\u8F7D\u56FE\u5C42\uFF1A${(nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name || nodeId}`);
        }
        addImportTiming(activeImportSession, "restore.appendNodeMs", Date.now() - appendStartedAt);
        const applyStartedAt = Date.now();
        yield applyProperties(newNode, textWrapper ? __spreadProps(__spreadValues({}, nodeProps), {
          id: void 0,
          constraints: void 0,
          scence: { visible: true, locked: false },
          blend: { opacity: 1, blendMode: "NORMAL", isMask: false, effects: [] },
          layout: {
            width: (_a = nodeProps.layout) == null ? void 0 : _a.width,
            height: (_b = nodeProps.layout) == null ? void 0 : _b.height,
            x: 0,
            y: 0,
            rotation: 0,
            relativeTransform: [[1, 0, 0], [0, 1, 0]]
          }
        }) : nodeProps);
        addImportTiming(activeImportSession, "restore.applyPropertiesMs", Date.now() - applyStartedAt);
      } catch (error) {
        console.warn("Unable to restore node, removing partial node:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name || nodeId, error);
        safeRemove(newNode);
        if (textWrapper) safeRemove(textWrapper);
        throw error;
      }
      if (activeImportSession) {
        activeImportSession.restoredNodeById[nodeId] = restoredNode;
        if (textWrapper) activeImportSession.textChildContainerDetails.push({
          sourceId: nodeId,
          name: String(nodeProps.name || layerRecord.name || nodeId),
          childCount: childIds.length,
          pageName: ((_c = activeImportSession.activePageRequest) == null ? void 0 : _c.pageName) || ""
        });
        recordInstanceFallback(activeImportSession, layerRecord, newNode);
        if (layerRecord.mainComponentId && !layerRecord.instanceStructureFallback && !activeImportSession.finalizingDeferredFallbacks) {
          queueDeferredInstance(activeImportSession, layerRecord, newNode, layers, deferInstanceChildren);
        }
      }
      const hasStyleRefs = Boolean(
        layerRecord.fillStyleRef || layerRecord.strokeStyleRef || layerRecord.effectStyleRef || layerRecord.textStyleRef || Array.isArray(layerRecord.textStyleRanges) && layerRecord.textStyleRanges.length > 0
      );
      if (hasStyleRefs) {
        if (textWrapper) {
          yield applyImportedStyleBindings(newNode, __spreadProps(__spreadValues({}, layerRecord), { effectStyleRef: void 0 }));
          yield applyImportedStyleBindings(textWrapper, __spreadProps(__spreadValues({}, layerRecord), {
            fillStyleRef: void 0,
            strokeStyleRef: void 0,
            textStyleRef: void 0,
            textStyleRanges: []
          }));
        } else {
          yield applyImportedStyleBindings(newNode, layerRecord);
        }
      }
      let restoredCount = deferInstanceChildren ? 1 + countRecordDescendants(layerRecord, layers) : 1 + applyConnectorTextFallback(newNode, layerRecord, layers);
      const currentCount = restoredBefore + restoredCount;
      const progressStartedAt = Date.now();
      yield maybeReportRestoreProgress(currentCount, totalNodes);
      addImportTiming(activeImportSession, "restore.progressMs", Date.now() - progressStartedAt);
      if (canContainRestoredChildren(restoredNode)) {
        for (const childId of childIds) {
          restoredCount += yield restoreImportedNode(childId, restoredNode, layers, restoredBefore + restoredCount, totalNodes);
        }
      }
      return restoredCount;
    });
  }
  function canContainRestoredChildren(node) {
    return !!node && "appendChild" in node;
  }
  function tryRestoreAsInstance(layerRecord, parent, layers, restoredBefore, totalNodes) {
    return __async(this, null, function* () {
      var _a, _b, _c;
      const session = activeImportSession;
      if (!session || !layerRecord.mainComponentId) return 0;
      if (session.retainingFailedImport) return 0;
      if (unavailableInstanceDependency(layerRecord, layers, session)) return 0;
      const componentNode = session.restoredNodeById[layerRecord.mainComponentId];
      if (!componentNode || componentNode.removed || componentNode.type !== "COMPONENT") {
        console.warn(
          "[mg-instance] frame fallback:",
          layerRecord.id,
          ((_a = layerRecord.props) == null ? void 0 : _a.name) || layerRecord.name,
          "\u2192 component",
          layerRecord.mainComponentId,
          !componentNode ? "\u672A\u8FD8\u539F(\u4E0D\u5728 restoredNodeById)" : componentNode.removed ? "\u5DF2\u88AB\u79FB\u9664" : `\u7C7B\u578B=${componentNode.type}`
        );
        return 0;
      }
      let instance = null;
      try {
        instance = componentNode.createInstance();
        state.recordNodeCreation("instance");
        if (!appendRestoredNode(parent, instance)) throw new Error("\u65E0\u6CD5\u6302\u8F7D\u5B9E\u4F8B");
      } catch (error) {
        console.warn("[mg-instance] createInstance \u5931\u8D25,\u56DE\u9000 Frame \u58F3:", layerRecord.id, ((_b = layerRecord.props) == null ? void 0 : _b.name) || layerRecord.name, error);
        if (instance) safeRemove(instance);
        return 0;
      }
      yield applyInstanceRecordState(instance, layerRecord, layers);
      session.restoredNodeById[layerRecord.id] = instance;
      console.info("[mg-instance] restored:", layerRecord.id, ((_c = layerRecord.props) == null ? void 0 : _c.name) || layerRecord.name, "\u2192 instance of", layerRecord.mainComponentId);
      const accounted = 1 + countRecordDescendants(layerRecord, layers);
      yield maybeReportRestoreProgress(restoredBefore + accounted, totalNodes);
      return accounted;
    });
  }
  function applyInstanceRecordState(instance, layerRecord, layers) {
    return __async(this, null, function* () {
      let rescaled = false;
      if (typeof layerRecord.instanceScale === "number" && isFinite(layerRecord.instanceScale) && layerRecord.instanceScale > 0 && Math.abs(layerRecord.instanceScale - 1) > 1e-6) {
        try {
          instance.rescale(layerRecord.instanceScale);
          rescaled = true;
        } catch (error) {
          console.warn("[mg-instance] rescale \u5931\u8D25(\u7EE7\u7EED):", layerRecord.id, layerRecord.instanceScale, error);
        }
      }
      try {
        const nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
        yield applyProperties(instance, nodeProps);
      } catch (error) {
        console.warn("[mg-instance] applyProperties \u90E8\u5206\u5931\u8D25(\u5B9E\u4F8B\u4FDD\u7559):", layerRecord.id, error);
      }
      yield applyImportedStyleBindings(instance, layerRecord);
      try {
        yield applyInstanceChildOverrides(instance, layerRecord, layers, rescaled);
      } catch (error) {
        console.warn("[mg-instance] \u5B50\u8986\u76D6\u5E94\u7528\u5931\u8D25(\u5B9E\u4F8B\u4FDD\u7559):", layerRecord.id, error);
      }
    });
  }
  function isComponentReady(session, id) {
    const node = session.restoredNodeById[id];
    return !!node && !node.removed && node.type === "COMPONENT" && !session.pendingComponentWork[id];
  }
  function captureInstanceRecords(record, layers) {
    const subtree = {};
    const stack = [record.id];
    while (stack.length) {
      const id = stack.pop();
      if (subtree[id] || !layers[id]) continue;
      subtree[id] = layers[id];
      stack.push(...layers[id].childIds || []);
    }
    return subtree;
  }
  function unavailableInstanceDependency(record, layers, session) {
    const stack = [record.id];
    const seen = /* @__PURE__ */ new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const item = layers[id];
      if (!item) continue;
      const target = item.instanceStructureFallback ? null : item.mainComponentId;
      if (target && session.knownComponentIds.has(target) && !isComponentReady(session, target)) return target;
      stack.push(...item.childIds || []);
    }
    return null;
  }
  function queueDeferredInstance(session, record, node, layers, lightweight) {
    var _a, _b;
    const subtree = captureInstanceRecords(record, layers);
    const dependencies = Array.from(new Set(Object.keys(subtree).map((id) => subtree[id]).filter((item) => !item.instanceStructureFallback && item.mainComponentId).map((item) => item.mainComponentId)));
    let ownerComponentId = null;
    let ancestorId = record.parentId;
    const seen = /* @__PURE__ */ new Set();
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      const ancestor = layers[ancestorId];
      if (!ancestor) break;
      if (((_a = ancestor.props) == null ? void 0 : _a.type) === "COMPONENT") {
        ownerComponentId = ancestor.id;
        break;
      }
      ancestorId = ancestor.parentId;
    }
    const entry = { id: record.id, node, layers: subtree, lightweight, dependencies, ownerComponentId };
    if (ownerComponentId) session.pendingComponentWork[ownerComponentId] = (session.pendingComponentWork[ownerComponentId] || 0) + 1;
    const key = dependencies.find((id) => !isComponentReady(session, id)) || record.mainComponentId;
    ((_b = session.deferredInstanceRelinks)[key] || (_b[key] = [])).push(entry);
  }
  function settleDeferredOwner(session, entry) {
    if (entry.ownerComponentId) {
      session.pendingComponentWork[entry.ownerComponentId] = Math.max(0, (session.pendingComponentWork[entry.ownerComponentId] || 0) - 1);
    }
  }
  function materializeDeferredFallback(session, entry) {
    return __async(this, null, function* () {
      if (!entry.lightweight || entry.node.removed) return;
      session.finalizingDeferredFallbacks = true;
      try {
        const record = entry.layers[entry.id];
        const layout = applyManifestLayoutToProps(record.props, record).layout;
        if (layout) {
          state.restoredLayoutByNodeId[entry.node.id] = layout;
          deferLayoutRestore(entry.node, layout, false);
        }
        for (const childId of record.childIds || []) {
          yield restoreImportedNode(childId, entry.node, entry.layers, session.restoredNodes, session.totalNodes);
        }
        for (const id of Object.keys(entry.layers)) {
          const node = session.restoredNodeById[id];
          if (!node || node.removed) continue;
          if (entry.layers[id].maskRendersFill === false) session.maskFillSuppressedNodeIds[node.id] = true;
          if (entry.layers[id].maskRendersFill === true) session.maskFillExplicitNodeIds[node.id] = true;
        }
      } catch (error) {
        session.retentionWarnings.push(`${entry.id}\uFF1A${error instanceof Error ? error.message : String(error)}`);
        let page = entry.node;
        while (page && page.type !== "PAGE") page = page.parent;
        for (const progress of session.pageStates) if ((progress == null ? void 0 : progress.page) === page) progress.completed = false;
        throw error;
      } finally {
        session.finalizingDeferredFallbacks = false;
        entry.lightweight = false;
      }
    });
  }
  function retryDeferredInstanceRelinks(_layers, final = false) {
    return __async(this, null, function* () {
      var _a, _b, _c;
      const session = activeImportSession;
      if (!session) return;
      const failed = /* @__PURE__ */ new Set();
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
            if (!record || shell.removed || !shell.parent) {
              settleDeferredOwner(session, entry);
              changed = true;
              continue;
            }
            const waitingFor = entry.dependencies.find((id) => !isComponentReady(session, id));
            if (waitingFor || failed.has(entry)) {
              ((_a = session.deferredInstanceRelinks)[_b = waitingFor || key] || (_a[_b] = [])).push(entry);
              continue;
            }
            const parent = shell.parent;
            const component = session.restoredNodeById[record.mainComponentId];
            let instance = null;
            try {
              const index = parent.children.indexOf(shell);
              instance = component.createInstance();
              state.recordNodeCreation("instance");
              parent.insertChild(Math.max(0, index), instance);
            } catch (error) {
              if (instance) safeRemove(instance);
              const fallback = session.instanceFallbacks[record.id];
              if (fallback) fallback.detail.reason = "instance-creation-failed";
              failed.add(entry);
              ((_c = session.deferredInstanceRelinks)[key] || (_c[key] = [])).push(entry);
              continue;
            }
            yield applyInstanceRecordState(instance, record, entry.layers);
            session.restoredNodeById[record.id] = instance;
            safeRemove(shell);
            settleDeferredOwner(session, entry);
            changed = true;
          }
        }
        if (final && !changed) {
          const key = Object.keys(session.deferredInstanceRelinks)[0];
          if (key !== void 0) {
            const entry = session.deferredInstanceRelinks[key].shift();
            if (!session.deferredInstanceRelinks[key].length) delete session.deferredInstanceRelinks[key];
            yield materializeDeferredFallback(session, entry);
            settleDeferredOwner(session, entry);
            changed = true;
          }
        }
      }
    });
  }
  function countRecordDescendants(record, layers) {
    let count = 0;
    const seen = {};
    const stack = [...record.childIds || []];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen[id]) continue;
      seen[id] = true;
      const child = layers[id];
      if (!child) continue;
      count++;
      for (const grandChild of child.childIds || []) stack.push(grandChild);
    }
    return count;
  }
  function recordInstanceFallback(session, record, node) {
    var _a, _b, _c;
    if (!record.mainComponentId && !record.missingMainComponentId && ((_a = record.props) == null ? void 0 : _a.sourceType) !== "INSTANCE" && ((_b = record.props) == null ? void 0 : _b.type) !== "INSTANCE") return;
    const target = record.mainComponentId ? session.restoredNodeById[record.mainComponentId] : null;
    let reason = "component-unavailable";
    if (record.missingMainComponentId || !record.mainComponentId) reason = "missing-component";
    else if (record.instanceStructureFallback) reason = "structure-fallback";
    else if (target && !target.removed && target.type === "COMPONENT") reason = "instance-creation-failed";
    session.instanceFallbacks[record.id] = {
      node,
      detail: {
        sourceId: record.id,
        name: record.name || ((_c = record.props) == null ? void 0 : _c.name) || record.id,
        mainComponentId: record.mainComponentId || record.missingMainComponentId || null,
        reason
      }
    };
  }
  function collectUnresolvedInstanceDetails(session) {
    return Object.keys(session.instanceFallbacks).map((id) => session.instanceFallbacks[id]).filter((entry) => !entry.node.removed && entry.node.type !== "INSTANCE").map((entry) => entry.detail);
  }
  function countDependencyComponents(pages) {
    let count = 0;
    for (const page of pages) {
      const stack = [...page.children];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.removed) continue;
        if (node.type === "COMPONENT") count++;
        if (node.type !== "INSTANCE" && "children" in node) stack.push(...node.children);
      }
    }
    return count;
  }
  function paintFilledMaskTwins(session) {
    let added = 0;
    const hasVisiblePaint = (paints) => Array.isArray(paints) && paints.some((paint) => paint && paint.visible !== false && (paint.opacity === void 0 || paint.opacity > 0));
    const visit = (node) => {
      if (node.type === "INSTANCE") return;
      if ("children" in node) for (const child of [...node.children]) visit(child);
      const nodeAny = node;
      if (nodeAny.isMask !== true) return;
      if (session.maskFillSuppressedNodeIds[node.id]) return;
      if (!hasVisiblePaint(nodeAny.fills) && !hasVisiblePaint(nodeAny.strokes)) return;
      if (isDefaultMaskFill(nodeAny.fills) && !hasVisiblePaint(nodeAny.strokes)) return;
      const parent = node.parent;
      if (!parent || !("insertChild" in parent)) return;
      if (!session.maskFillExplicitNodeIds[node.id] && isGradientCoverageMask(
        nodeAny.fills,
        nodeAny.strokes,
        [...parent.children].slice(parent.children.indexOf(node) + 1)
      )) return;
      if (!session.maskFillExplicitNodeIds[node.id] && isBackdropCoverageMask(nodeAny.fills, nodeAny.strokes, parent.effects)) return;
      try {
        const twin = node.clone();
        state.recordNodeCreation("clone");
        twin.isMask = false;
        const index = parent.children.indexOf(node);
        parent.insertChild(index >= 0 ? index : 0, twin);
        twin.relativeTransform = node.relativeTransform;
        if (Math.abs(twin.x - node.x) > 0.01 || Math.abs(twin.y - node.y) > 0.01) {
          console.warn(
            "[mg-mask] twin did not land on its mask:",
            node.name,
            `twin=(${twin.x},${twin.y}) mask=(${node.x},${node.y})`
          );
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
  function applyInstanceChildOverrides(instance, record, layers, rescaled) {
    return __async(this, null, function* () {
      const pairs = [];
      const collect = (node, rec) => __async(null, null, function* () {
        var _a, _b, _c, _d, _e;
        if (node !== instance && node.type === "INSTANCE" && rec.mainComponentId) {
          const target = activeImportSession == null ? void 0 : activeImportSession.restoredNodeById[rec.mainComponentId];
          if (target && target.type === "COMPONENT") {
            const current = yield node.getMainComponentAsync();
            if ((current == null ? void 0 : current.id) !== target.id) node.swapComponent(target);
          }
        }
        if (!("children" in node)) return;
        const childIds = rec.childIds || [];
        let children = node.children;
        if (node.type === "FRAME" && ((_a = rec.props) == null ? void 0 : _a.type) === "TEXT" && ((_b = children[0]) == null ? void 0 : _b.type) === "TEXT" && node.getPluginData("mastergo2figma.textChildContainer") === "1") {
          const wrapperPair = pairs[pairs.length - 1];
          if ((wrapperPair == null ? void 0 : wrapperPair.node) === node) wrapperPair.rec = __spreadProps(__spreadValues({}, rec), {
            props: __spreadProps(__spreadValues({}, rec.props), { geometry: void 0 }),
            fillStyleRef: void 0,
            strokeStyleRef: void 0,
            textStyleRef: void 0,
            textStyleRanges: []
          });
          pairs.push({ node: children[0], rec: __spreadProps(__spreadValues({}, rec), { effectStyleRef: void 0, childIds: [], props: __spreadProps(__spreadValues({}, rec.props), {
            id: void 0,
            constraints: void 0,
            scence: { visible: true, locked: false },
            blend: { opacity: 1, blendMode: "NORMAL", isMask: false, effects: [] },
            layout: {
              width: (_c = rec.props.layout) == null ? void 0 : _c.width,
              height: (_d = rec.props.layout) == null ? void 0 : _d.height,
              x: 0,
              y: 0,
              rotation: 0,
              relativeTransform: [[1, 0, 0], [0, 1, 0]]
            }
          }) }) });
          children = children.slice(1);
        }
        if (childIds.length !== children.length) {
          const candidates = node.findAllWithCriteria ? node.findAllWithCriteria({ types: ["TEXT"] }) : ((_e = node.findAll) == null ? void 0 : _e.call(node, (child) => child.type === "TEXT")) || [];
          for (const text of candidates) registerMissingFontTextCandidate(text);
          return;
        }
        for (let i = 0; i < childIds.length; i++) {
          const childRec = layers[childIds[i]];
          if (!childRec || !childRec.props) continue;
          pairs.push({ node: children[i], rec: childRec });
          yield collect(children[i], childRec);
        }
      });
      yield collect(instance, record);
      for (const { node, rec } of pairs) {
        const props = rec.props;
        if (node.type === "ELLIPSE" && props.arcData) {
          try {
            node.arcData = props.arcData;
          } catch (error) {
            console.warn("[mg-instance] arc override rejected:", rec.id, error);
          }
        }
        try {
          applyConnectorTextFallback(node, rec, layers);
        } catch (error) {
        }
        try {
          if (props.scence && props.scence.visible === false && node.visible !== false) node.visible = false;
          else if (props.scence && props.scence.visible === true && node.visible === false) node.visible = true;
        } catch (error) {
        }
        try {
          const opacity = props.blend ? props.blend.opacity : void 0;
          if (typeof opacity === "number" && "opacity" in node && Math.abs(node.opacity - opacity) > 1e-3) {
            node.opacity = opacity;
          }
        } catch (error) {
        }
        if (node.type === "TEXT") {
          const textNode = node;
          registerMissingFontTextCandidate(textNode);
          let charsOverridden = false;
          if (typeof props.characters === "string") {
            try {
              if (textNode.characters !== props.characters && textNode.fontName !== figma.mixed) {
                yield loadFontCached(textNode.fontName);
                textNode.characters = props.characters;
                charsOverridden = true;
              }
            } catch (error) {
            }
          }
          if (rescaled && !charsOverridden && (textNode.textAutoResize === "WIDTH_AND_HEIGHT" || textNode.textAutoResize === "HEIGHT")) {
            try {
              const len = textNode.characters.length;
              if (len > 0) {
                for (const font of textNode.getRangeAllFontNames(0, len)) yield loadFontCached(font);
              }
              textNode.textAutoResize = "NONE";
            } catch (error) {
            }
          }
        }
        const geometry = props.geometry;
        if (geometry) {
          try {
            if (Array.isArray(geometry.fills) && "fills" in node) {
              const want = comparablePaintKey(geometry.fills);
              const have = comparablePaintKey(node.fills);
              if (want !== null && want !== have) safeSetFills(node, geometry.fills);
            }
          } catch (error) {
          }
          try {
            if (Array.isArray(geometry.strokes) && "strokes" in node) {
              const want = comparablePaintKey(geometry.strokes);
              const have = comparablePaintKey(node.strokes);
              if (want !== null && want !== have) safeSetStrokes(node, geometry.strokes);
            }
          } catch (error) {
          }
        }
        if (node.type === "TEXT") {
          try {
            yield applyInstanceTextFormatting(node, props);
          } catch (error) {
          }
        }
        if (props.layout && ("layoutMode" in node && INSTANCE_LAYOUT_OVERRIDE_KEYS.some((key) => typeof props.layout[key] === "number") || typeof props.layout.layoutGrow === "number" || typeof props.layout.layoutAlign === "string" || typeof props.layout.layoutPositioning === "string")) {
          pendingInstanceLayoutOverrides.push({ node, layout: props.layout });
        }
        if (rec.fillStyleRef || rec.strokeStyleRef || rec.effectStyleRef || rec.textStyleRef || Array.isArray(rec.textStyleRanges) && rec.textStyleRanges.length > 0) {
          yield applyImportedStyleBindings(node, rec);
        }
      }
    });
  }
  var pendingInstanceLayoutOverrides = [];
  var instanceLayoutPageCursor = 0;
  var INSTANCE_LAYOUT_OVERRIDE_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"];
  function flushInstanceChildLayoutOverrides(final) {
    let applied = 0, deferred = 0, rejected = 0;
    const keep = [];
    const entries = final ? pendingInstanceLayoutOverrides : pendingInstanceLayoutOverrides.slice(instanceLayoutPageCursor);
    for (const entry of entries) {
      const node = entry.node;
      if (!node || node.removed) continue;
      keep.push(entry);
      const parent = node.parent;
      if (parent && parent.layoutMode && parent.layoutMode !== "NONE") {
        for (const key of ["layoutPositioning", "layoutGrow", "layoutAlign"]) {
          const want = entry.layout[key];
          if (want === void 0 || want === null || node[key] === want) continue;
          try {
            node[key] = want;
            if (node[key] === want) applied++;
            else rejected++;
          } catch (error) {
            rejected++;
            console.warn("[mg-instance] child layout override rejected:", node.name, key, error);
          }
        }
      }
      if (!("layoutMode" in node) || node.layoutMode === "NONE" || node.layoutMode === void 0) {
        deferred++;
        continue;
      }
      for (const key of INSTANCE_LAYOUT_OVERRIDE_KEYS) {
        const isLimit = /^(min|max)(Width|Height)$/.test(key);
        const want = isLimit ? normalizeMasterGoSizeLimit(entry.layout[key]) : entry.layout[key];
        if (want === void 0 || !isLimit && (typeof want !== "number" || !isFinite(want))) continue;
        if (node[key] === want || typeof want === "number" && typeof node[key] === "number" && Math.abs(node[key] - want) <= 0.01) continue;
        try {
          node[key] = want;
        } catch (error) {
          rejected++;
          console.warn("[mg-instance] auto-layout override rejected:", node.name, key, error);
          continue;
        }
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
      console.info(
        "[mg-instance] instance-child auto-layout overrides:",
        JSON.stringify({ pass: final ? "finalize" : "page", applied, deferred, rejected, queued: keep.length })
      );
    }
    return applied;
  }
  function comparablePaintKey(paints) {
    if (!Array.isArray(paints)) return null;
    const round = (v) => Math.round((typeof v === "number" ? v : 0) * 1e3) / 1e3;
    const out = [];
    for (const paint of paints) {
      if (!paint || typeof paint !== "object") return null;
      const visible = paint.visible === void 0 ? paint.isVisible === void 0 ? true : !!paint.isVisible : !!paint.visible;
      if (paint.type === "SOLID") {
        const c = paint.color || {};
        out.push(["S", round(c.r), round(c.g), round(c.b), round(paint.opacity === void 0 ? 1 : paint.opacity), visible ? 1 : 0]);
        continue;
      }
      if (typeof paint.type === "string" && paint.type.indexOf("GRADIENT_") === 0) {
        const stops = (paint.gradientStops || []).map((s) => [
          round(s.position),
          round(s.color && s.color.r),
          round(s.color && s.color.g),
          round(s.color && s.color.b),
          round(s.color && s.color.a)
        ]);
        out.push(["G", paint.type, stops, visible ? 1 : 0]);
        continue;
      }
      return null;
    }
    return JSON.stringify(out);
  }
})();
