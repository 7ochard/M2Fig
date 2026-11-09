import * as React from "react"

import { Button } from "./ui/button"
import {
  formatCount,
  formatDuration,
  performanceReportJson,
  stageRows,
  type ImportPerformanceReport,
  type ImportTarget,
} from "../importReport"

export function ImportIdentity({ sourceName, target }: { sourceName: string; target: ImportTarget }) {
  const mismatch = target.documentName && target.documentName !== sourceName
  return (
    <section aria-label="源文件与目标文件" className="w-full rounded-lg border bg-card p-3 text-left text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">源文件名称</dt>
        <dd className="break-words font-medium">{sourceName}</dd>
        <dt className="text-muted-foreground">当前 Figma 标题</dt>
        <dd className="break-words">{target.documentName || "未知（当前环境未提供）"}</dd>
        <dt className="text-muted-foreground">Figma fileKey</dt>
        <dd className="break-all font-mono">{target.fileKey || "未知（当前环境未提供）"}</dd>
      </dl>
      {mismatch && (
        <p className="mt-2 text-amber-300">
          标题与源文件不同；建议打开按源名称“{sourceName}”新建的目标文件后导入。当前插件不能修改文件标题。
        </p>
      )}
    </section>
  )
}

export function ImportPerformance(props: {
  sourceName: string
  target: ImportTarget
  report?: ImportPerformanceReport
}) {
  const { sourceName, target, report } = props
  const [copyMessage, setCopyMessage] = React.useState<string | null>(null)
  if (!report) {
    return <p className="text-xs text-muted-foreground">当前插件版本未提供性能数据。</p>
  }
  const json = performanceReportJson(sourceName, target, report)
  const stages = stageRows(report)
  const retained = report.retainedImport && typeof report.retainedImport === "object"
    ? report.retainedImport as Record<string, unknown> : null
  const interrupted = retained?.status === "partial" || retained?.status === "failed"

  async function copyReport() {
    let copied = false
    try {
      await navigator.clipboard.writeText(json)
      copied = true
    } catch {
      const textarea = document.createElement("textarea")
      textarea.value = json
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      try {
        textarea.select()
        copied = document.execCommand("copy")
      } catch {
        copied = false
      } finally {
        textarea.remove()
      }
    }
    setCopyMessage(copied ? "数值 JSON 已复制" : "复制失败，请下载 JSON")
  }

  function downloadReport() {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${sourceName}-迁移报告.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section aria-label="导入性能" className="w-full rounded-lg border p-3 text-left text-xs">
      {interrupted && (
        <div className="mb-3 space-y-1 rounded-md bg-muted p-2">
          <p className="font-medium">{retained.status === "partial" ? "导入中断，已保留部分内容" : "导入失败，未保留页面"}</p>
          <p className="text-muted-foreground">
            已完成 {formatCount(retained.completedPageCount)} 页 · 部分保留 {formatCount(retained.partialPageCount)} 页 · 未开始 {formatCount(retained.pendingPageCount)} 页。
          </p>
          <p className="text-muted-foreground">保留内容不等于整文件成功。请核对部分保留页，再选择未开始的页面继续。</p>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">导入耗时</dt>
        <dd className="text-right tabular-nums">{formatDuration(report.totalMs)}</dd>
        <dt className="text-muted-foreground">文件准备</dt>
        <dd className="text-right tabular-nums">{formatDuration(report.preparationMs)}</dd>
        <dt className="text-muted-foreground">活动总耗时</dt>
        <dd className="text-right tabular-nums">{formatDuration(report.endToEndActiveMs)}</dd>
        <dt className="text-muted-foreground">{interrupted ? "所选源记录总数" : "源记录数"}</dt>
        <dd className="text-right tabular-nums">{formatCount(interrupted ? retained.totalSourceRecordCount : report.sourceRecordCount)}</dd>
        {interrupted && (
          <>
            <dt className="text-muted-foreground">通过页校验的源记录</dt>
            <dd className="text-right tabular-nums">{formatCount(retained.completedSourceRecordCount)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">API 创建次数</dt>
        <dd className="text-right tabular-nums">{formatCount(report.apiCreationCount)}</dd>
      </dl>
      <p className="mt-2 text-muted-foreground">{interrupted
        ? "通过页校验的源记录仅计完成页；API 创建次数是调用统计，不代表成功源记录数。"
        : "活动总耗时不含预览等待；源记录数与创建 API 调用数口径不同。"}</p>
      {stages.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer">阶段耗时（{stages.length} 项）</summary>
          <p className="my-1.5 text-muted-foreground">阶段可能嵌套或并行，不能相加作为总耗时。</p>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
            {stages.map((stage) => (
              <React.Fragment key={stage.key}>
                <dt className="break-words" title={stage.key}>{stage.label}</dt>
                <dd className="tabular-nums">{stage.duration}</dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      ) : <p className="mt-2 text-muted-foreground">阶段耗时：未提供</p>}
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copyReport()}>复制数值 JSON</Button>
        <Button type="button" variant="outline" size="sm" onClick={downloadReport}>下载 JSON</Button>
      </div>
      {copyMessage && <p role="status" className="mt-1.5 text-muted-foreground">{copyMessage}</p>}
    </section>
  )
}
