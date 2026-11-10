const STORAGE_KEY = "mastergo2figma.receive.lastImportReport.v1";
const MAX_REPORT_BYTES = 1024 * 1024;

type ReportStorage = {
  getAsync(key: string): Promise<any>;
  setAsync(key: string, value: any): Promise<void>;
};
type Warn = (message: string, error?: unknown) => void;
type Fields = { [key: string]: any };

export type ImportReportSummary = {
  schemaVersion: 1;
  sourceName: string;
  completedAt: string;
  target: { documentName: string | null; fileKey: string | null };
  performanceReport: Fields;
};

function object(value: any): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function numericMap(value: any): Fields {
  if (!object(value)) throw new Error("Expected numeric summary map");
  const result: Fields = Object.create(null);
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) throw new Error("Invalid summary number");
    result[key] = value[key];
  }
  return result;
}

function timingSummary(value: any): Fields | null {
  if (value === null) return null;
  if (!object(value)) throw new Error("Invalid client timing summary");
  const result: Fields = {};
  for (const key of ["totalsMs", "counts", "bytes"]) if (value[key] !== undefined) result[key] = numericMap(value[key]);
  for (const key of ["startedAt", "selectedPageCount", "selectedLayerCount"]) {
    if (value[key] !== undefined) Object.assign(result, numericMap({ [key]: value[key] }));
  }
  if (value.transferId !== undefined) {
    if (typeof value.transferId !== "string") throw new Error("Invalid transfer identity");
    result.transferId = value.transferId;
  }
  return result;
}

function performanceSummary(value: any): Fields {
  if (!object(value) || value.schemaVersion !== 1) throw new Error("Invalid performance report schema");
  const result: Fields = { schemaVersion: 1 };
  for (const key of ["receiverVersion", "creationCountMeaning", "sourceDocumentName", "targetDocumentName", "targetFileKey"]) {
    if (value[key] === undefined) continue;
    if (value[key] !== null && typeof value[key] !== "string") throw new Error("Invalid performance identity");
    result[key] = value[key];
  }
  for (const key of ["totalMs", "preparationMs", "endToEndActiveMs", "mainMs", "sourceRecordCount", "apiCreationCount", "parseStartToCompleteMs"]) {
    if (value[key] !== undefined) Object.assign(result, numericMap({ [key]: value[key] }));
  }
  for (const key of ["stagesMs", "stageCounts"]) if (value[key] !== undefined) result[key] = numericMap(value[key]);
  if (value.restoreStats !== undefined) {
    if (value.restoreStats === null) result.restoreStats = null;
    else {
      if (!object(value.restoreStats)) throw new Error("Invalid restore statistics");
      const stats: Fields = {};
      for (const key of Object.keys(value.restoreStats)) {
        if (key === "creationCounts") stats.creationCounts = numericMap(value.restoreStats.creationCounts);
        else Object.assign(stats, numericMap({ [key]: value.restoreStats[key] }));
      }
      result.restoreStats = stats;
    }
  }
  for (const key of ["clientTimings", "preparationClientTimings"]) {
    if (value[key] !== undefined) result[key] = timingSummary(value[key]);
  }
  if (value.zipSources !== undefined) {
    if (!Array.isArray(value.zipSources)) throw new Error("Invalid ZIP statistics");
    result.zipSources = value.zipSources.map(numericMap);
  }
  if (value.textChildContainerDetails !== undefined) {
    if (!Array.isArray(value.textChildContainerDetails)) throw new Error("Invalid text container details");
    result.textChildContainerDetails = value.textChildContainerDetails.map((item: any) => {
      if (!object(item) || ["sourceId", "name", "pageName"].some(key => typeof item[key] !== "string") ||
          !Number.isInteger(item.childCount) || item.childCount < 0) throw new Error("Invalid text container detail");
      return { sourceId: item.sourceId, name: item.name, childCount: item.childCount, pageName: item.pageName };
    });
  }
  if (value.retainedImport !== undefined) {
    const retained = value.retainedImport;
    if (!object(retained) || ["partial", "failed"].indexOf(retained.status) < 0 || !Array.isArray(retained.pages) ||
        !Array.isArray(retained.cleanupWarnings) || retained.cleanupWarnings.some((item: any) => typeof item !== "string")) {
      throw new Error("Invalid retained import summary");
    }
    const summary: Fields = { status: retained.status, cleanupWarnings: retained.cleanupWarnings.slice() };
    for (const key of ["completedPageCount", "partialPageCount", "pendingPageCount", "retainedPageCount",
      "completedSourceRecordCount", "reportedRestoredRecordCount", "totalSourceRecordCount"]) {
      if (!Number.isInteger(retained[key]) || retained[key] < 0) throw new Error("Invalid retained import count");
      summary[key] = retained[key];
    }
    summary.pages = retained.pages.map((page: any) => {
      if (!object(page) || typeof page.sourcePageId !== "string" || typeof page.sourcePageName !== "string" ||
          ["targetPageId", "targetPageName"].some(key => page[key] !== null && typeof page[key] !== "string") ||
          ["completed", "partial", "pending"].indexOf(page.status) < 0 || !Number.isInteger(page.sourceRecordCount) || page.sourceRecordCount < 0) {
        throw new Error("Invalid retained page summary");
      }
      return { sourcePageId: page.sourcePageId, sourcePageName: page.sourcePageName,
        targetPageId: page.targetPageId, targetPageName: page.targetPageName, status: page.status, sourceRecordCount: page.sourceRecordCount };
    });
    result.retainedImport = summary;
  }
  return result;
}

function reportSummary(value: any): ImportReportSummary | null {
  try {
    if (!object(value) || value.schemaVersion !== 1 || typeof value.sourceName !== "string" || !value.sourceName.trim() ||
        typeof value.completedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.completedAt) ||
        !Number.isFinite(Date.parse(value.completedAt)) || !object(value.target)) return null;
    for (const key of ["documentName", "fileKey"]) {
      if (value.target[key] !== null && typeof value.target[key] !== "string") return null;
    }
    // Check the incoming UTF-8 size before dropping unknown fields. The plugin
    // sandbox need not provide the browser's TextEncoder API.
    let size = 0;
    for (const character of JSON.stringify(value)) {
      const point = character.codePointAt(0) as number;
      size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
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
  } catch (_) { return null; }
}

export async function saveImportReport(storage: ReportStorage, value: unknown, warn: Warn = console.warn): Promise<boolean> {
  const summary = reportSummary(value);
  if (!summary) { warn("Unable to save invalid or oversized import report"); return false; }
  try {
    await storage.setAsync(STORAGE_KEY, summary);
    return true;
  } catch (error) {
    warn("Unable to save last import report", error);
    return false;
  }
}

export async function readImportReport(storage: ReportStorage, warn: Warn = console.warn): Promise<ImportReportSummary | null> {
  try {
    const value = await storage.getAsync(STORAGE_KEY);
    if (value === null || value === undefined) return null;
    const summary = reportSummary(value);
    if (!summary) warn("Ignoring invalid or oversized last import report");
    return summary;
  } catch (error) {
    warn("Unable to read last import report", error);
    return null;
  }
}
