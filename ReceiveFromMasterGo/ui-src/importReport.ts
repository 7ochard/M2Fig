export interface ImportTarget {
  documentName: string | null
  fileKey: string | null
}

export interface ImportPerformanceReport {
  schemaVersion?: number
  totalMs?: number
  preparationMs?: number
  endToEndActiveMs?: number
  sourceRecordCount?: number
  apiCreationCount?: number
  stagesMs?: Record<string, number>
  targetDocumentName?: string | null
  targetFileKey?: string | null
  [key: string]: unknown
}

export interface SavedImportReport {
  schemaVersion: 1
  sourceName: string
  completedAt: string
  target: ImportTarget
  performanceReport: ImportPerformanceReport
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)
}

export function normalizeSavedImportReport(value: unknown): SavedImportReport | null {
  try {
    if (!isRecord(value)) return null
    const { schemaVersion, sourceName, completedAt, target, performanceReport } = value
    if (schemaVersion !== 1 || typeof sourceName !== "string" || !sourceName.trim() ||
      typeof completedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(completedAt) ||
      !Number.isFinite(Date.parse(completedAt)) || !isRecord(target) ||
      !isRecord(performanceReport) || performanceReport.schemaVersion !== 1) return null
    const { documentName, fileKey } = target
    if ((documentName !== null && typeof documentName !== "string") ||
      (fileKey !== null && typeof fileKey !== "string")) return null
    const savedPerformance = JSON.parse(JSON.stringify(performanceReport))
    if (!isRecord(savedPerformance) || savedPerformance.schemaVersion !== 1) return null
    return { schemaVersion: 1, sourceName, completedAt, target: { documentName, fileKey }, performanceReport: savedPerformance }
  } catch {
    return null
  }
}

const PROGRESS_STAGE_LABELS: Record<string, string> = {
  prepare: "准备",
  fonts: "字体检查",
  assets: "处理图片",
  pageSend: "发送页面",
  restore: "还原图层",
  postprocess: "布局后处理",
  finalize: "收尾",
}

export function progressStageLabel(stage: string): string {
  return Object.prototype.hasOwnProperty.call(PROGRESS_STAGE_LABELS, stage) ? PROGRESS_STAGE_LABELS[stage] : "准备"
}

export function progressWaitingSeconds(lastUpdateAt: unknown, now: number): number {
  if (typeof lastUpdateAt !== "number" || !Number.isFinite(lastUpdateAt) || lastUpdateAt <= 0 ||
    !Number.isFinite(now) || now < lastUpdateAt || now - lastUpdateAt < 15000) return 0
  return Math.floor((now - lastUpdateAt) / 1000)
}

export function singleSourceError(count: number): string | null {
  if (count === 1) return null
  return count > 1
    ? "一次仅导入一个源文件，请为每个源文件分别打开对应的 Figma 文件。"
    : "请选择一个源文件"
}

export function sourceDocumentName(info: { documentName?: string; fileNames: string[] }): string {
  return info.documentName?.trim()
    ? info.documentName
    : (info.fileNames[0] || "未知源文件").replace(/\.(mg|zip)$/i, "")
}

export function formatDuration(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${(value / 1000).toFixed(2)} 秒`
    : "未提供"
}

export function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "未提供"
}

const STAGE_LABELS: Record<string, string> = {
  "prepare.fontsMs": "字体预检",
  "ui.file.arrayBufferMs": "读取文件",
  "ui.zip.readEntriesMs": "读取归档内容",
  "ui.zip.directoryMs": "读取 ZIP 目录",
  "ui.zip.structurePreflightMs": "校验全部页面结构",
  "ui.manifest.parseMs": "解析清单",
  "ui.asset.readMs": "读取并校验当前图片",
  "ui.asset.sendMs": "准备及传输图片",
  "ui.prepare.pageDataMs": "准备当前页面",
  "ui.prepare.totalMs": "页面准备汇总",
  "ui.session.startAckMs": "建立导入会话",
  "ui.page.startAckMs": "开始当前页面",
  "ui.page.chunkPostMs": "传输页面记录",
  "ui.page.restoreWaitMs": "等待页面恢复",
  "ui.import.untilCompletePostMs": "发送完成请求前耗时",
  "asset.concatBytesMs": "图片数据准备",
  "asset.createImageMs": "创建图片资源",
  "page.receiveChunkMs": "接收页面数据",
  "restore.createPageMs": "创建页面",
  "restore.nodesMs": "还原节点",
  "restore.createNodeMs": "创建节点",
  "restore.appendNodeMs": "挂载节点",
  "restore.applyPropertiesMs": "应用节点属性",
  "restore.deferredRelinkMs": "恢复组件关联",
  "restore.progressMs": "更新进度",
  "postprocess.deferredLayoutMs": "恢复布局",
  "postprocess.cleanupShellsMs": "整理容器",
  "postprocess.singleChildAutoSpaceMs": "处理自动间距",
  "finalize.connectorsMs": "恢复连接线",
  "finalize.deferredInstancesMs": "收尾组件及缺失依赖",
  "finalize.deferredLayoutMs": "收尾布局",
  "finalize.cleanupShellsMs": "收尾容器",
  "finalize.singleChildAutoSpaceMs": "收尾自动间距",
  "finalize.missingFontsMs": "处理缺失字体",
  "finalize.viewportMs": "定位导入页面",
}

export function stageRows(report: ImportPerformanceReport) {
  const rows = Object.entries(report.stagesMs || {}).map(([key, value]) => ({
    key, label: STAGE_LABELS[key] || key, duration: formatDuration(value),
  }))
  for (const [section, prefix] of [["preparationClientTimings", "文件准备"], ["clientTimings", "导入传输"]]) {
    const timings = report[section]
    if (!timings || typeof timings !== "object" || !("totalsMs" in timings)) continue
    const totals = timings.totalsMs
    if (!totals || typeof totals !== "object") continue
    for (const [key, value] of Object.entries(totals)) {
      rows.push({ key: `${section}:${key}`, label: `${prefix} · ${STAGE_LABELS[key] || key}`, duration: formatDuration(value) })
    }
  }
  return rows
}

export function performanceReportJson(sourceName: string, target: ImportTarget, report: ImportPerformanceReport): string {
  return JSON.stringify({
    schemaVersion: 1,
    sourceDocumentName: sourceName,
    target,
    performanceReport: report,
  }, null, 2)
}
