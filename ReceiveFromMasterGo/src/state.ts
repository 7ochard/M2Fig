import { RestorePerformanceStats, RestoreProgressState, CachedLayerConversionRules, LayerConversionRule } from "../../shared/types";

export type MissingImageAssetDetail = {
    assetName: string;
    nodeId: string;
    nodeName: string;
    layerPath: string;
    nodeType: string;
    paintTarget: "fill" | "stroke" | "image";
    x: number | null;
    y: number | null;
    width: number | null;
    height: number | null;
};

class RestorerState {
    public documentFonts: Font[] = [];
    public restoredLayoutByNodeId: { [id: string]: any } = {};
    public importInProgress = false;
    public cachedLayerRules: CachedLayerConversionRules | null = null;
    public layerRulesBySourceType: { [sourceType: string]: LayerConversionRule } | null = null;
    public layerRulesLoadPromise: Promise<void> | null = null;
    public activeImportAssets: { [fileName: string]: Uint8Array } = {};
    public imageHashByAssetName: { [fileName: string]: string } = {};
    public missingImageAssetNames: { [fileName: string]: boolean } = {};
    public missingImageAssetDetailKeys: { [key: string]: boolean } = {};
    public missingImageAssetDetails: MissingImageAssetDetail[] = [];
    public missingImageAssetCount = 0;
    public placeholderImageHash: string | null = null;
    public restoredNodeIdBySourceId: { [sourceId: string]: string } = {};
    public nativeGroupOffsetByNodeId: { [nodeId: string]: { x: number; y: number } } = {};
    public deferredConnectorRestores: Array<{ node: ConnectorNode; data: any }> = [];
    public deferredLayoutRestores: Array<{ node: SceneNode; layout: any; isGroup: boolean }> = [];
    // Nodes whose restored layout uses SPACE_BETWEEN on the primary axis,
    // recorded at deferLayoutRestore time and drained per page — replaces the
    // full-page tree walk in applyDeferredSingleChildAutoSpaceAlignmentFixes.
    public singleChildAutoSpaceCandidates: SceneNode[] = [];
    public shellPlaceholderCandidates: SceneNode[] = [];
    public missingFontTextCandidates: TextNode[] = [];
    public fontLoadPromises: { [key: string]: Promise<void> } = {};
    public availableFontKeys: { [key: string]: boolean } = {};
    public fallbackConnectorCount = 0;
    public booleanFallbackCount = 0;
    public connectorFallbackLogged = false;
    public activeRestoreStats: RestorePerformanceStats | null = null;
    public activeProgressState: RestoreProgressState | null = null;

    public reset() {
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

    public resetRestoreRuntimeStats(totalNodes: number, pageCount: number) {
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

    public recordNodeCreation(kind = "node") {
        const stats = this.activeRestoreStats;
        if (!stats) return;
        stats.apiCreationCount++;
        stats.creationCounts[kind] = (stats.creationCounts[kind] || 0) + 1;
        if (kind === "instance") stats.instanceCreationCount++;
        if (kind === "clone") stats.cloneCallCount++;
    }

    public recordNodeRemoval() {
        if (this.activeRestoreStats) this.activeRestoreStats.transientRemovalCount++;
    }

    public logRestorePerformanceSummary(restoredNodes: number, pageCount: number) {
        if (!this.activeRestoreStats) return;

        this.activeRestoreStats.restoredNodes = restoredNodes;
        this.activeRestoreStats.pageCount = pageCount;
        const durationMs = Math.max(Date.now() - this.activeRestoreStats.startedAt, 1);
        const nodesPerSecond = Math.round((restoredNodes / durationMs) * 10000) / 10;
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
}

export const state = new RestorerState();
