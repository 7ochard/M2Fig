import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  FileArchive,
  FileUp,
  Loader2,
  X,
} from "lucide-react"

import { Button } from "./components/ui/button"
import { Checkbox } from "./components/ui/checkbox"
import { Progress } from "./components/ui/progress"
import { Switch } from "./components/ui/switch"
import { ImportIdentity, ImportPerformance } from "./components/import-summary"
import {
  normalizeSavedImportReport, progressStageLabel, progressWaitingSeconds, singleSourceError, sourceDocumentName,
  type ImportPerformanceReport, type ImportTarget, type SavedImportReport,
} from "./importReport"
import * as engine from "./engine"

type View = "idle" | "parsed" | "importing" | "success" | "error" | "lab"

interface PageItem {
  id: string
  name: string
  displayName: string
  layerCount: number
}

interface FileInfo {
  fileNames: string[]
  documentName?: string
  suggestedTargetName?: string
  pageCount: number
  layerCount: number
  pages: PageItem[]
}

interface ProgressState {
  percent: number
  stage: string
  layersDone: number
  layersTotal: number
  pageName?: string
  operationLabel?: string
  lastUpdateAt?: number
}

interface ResultState {
  pageCount: number
  layerCount: number
  dependencyPageCount: number
  dependencyComponentCount: number
  unresolvedInstanceCount: number
  sourceWarningCount: number
  performanceReport?: ImportPerformanceReport
  details: string[]
}

interface ErrorState {
  kind: "read" | "import"
  message: string
  pagesDone: number
  pagesTotal: number
  retainedImport?: RetainedImport
}

interface RetainedImport {
  status: "partial" | "failed"
  pages: {
    sourcePageId: string
    sourcePageName: string
    targetPageId: string | null
    targetPageName: string | null
    status: "completed" | "partial" | "pending"
    sourceRecordCount: number
  }[]
  completedPageCount: number
  partialPageCount: number
  pendingPageCount: number
  retainedPageCount: number
  completedSourceRecordCount: number
  reportedRestoredRecordCount: number
  totalSourceRecordCount: number
  cleanupWarnings: string[]
}

interface PendingHandoff {
  jobId: string
  sourceId: string
  sourceName: string
  fileName: string
  bytes: number
  sha256: string
  recordCount: number
  designPageCount: number
  targetFileKey: string | null
  targetUrl: string | null
  autoStart: boolean
}

interface AppSettings {
  zipEnabled: boolean
  suppressStartupNotice: boolean
}

type Overlay = "notice" | null

const HELP_URL = "https://github.com/7ochard/Mg2Fig"
const CONTACT_EMAIL = "woshixwn@gmail.com"
const DEFAULT_SETTINGS: AppSettings = {
  zipEnabled: true,
  suppressStartupNotice: false,
}

// Settings persist via figma.clientStorage in the main thread (bridged
// through engine.saveSettings / the "init" message) rather than iframe
// localStorage, which Figma does not guarantee to preserve across plugin
// relaunches.
function parseSettings(raw: any): AppSettings {
  return {
    zipEnabled: raw?.zipEnabled === true,
    suppressStartupNotice: raw?.suppressStartupNotice === true,
  }
}

export function App() {
  const [view, setView] = React.useState<View>("idle")
  const [prevView, setPrevView] = React.useState<View>("idle")
  const [settings, setSettings] = React.useState<AppSettings>(() => ({ ...DEFAULT_SETTINGS }))
  const [overlay, setOverlay] = React.useState<Overlay>(null)
  const [noticeDontShowAgain, setNoticeDontShowAgain] = React.useState(false)
  const [parsing, setParsing] = React.useState(false)
  const [dropHint, setDropHint] = React.useState<string | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [fileInfo, setFileInfo] = React.useState<FileInfo | null>(null)
  const [target, setTarget] = React.useState<ImportTarget>({ documentName: null, fileKey: null })
  const [lastImportReport, setLastImportReport] = React.useState<SavedImportReport | null>(null)
  const [progressNow, setProgressNow] = React.useState(() => Date.now())
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [progress, setProgress] = React.useState<ProgressState>({
    percent: 0,
    stage: "prepare",
    layersDone: 0,
    layersTotal: 0,
  })
  const [result, setResult] = React.useState<ResultState | null>(null)
  const [error, setError] = React.useState<ErrorState | null>(null)
  const [retainedImport, setRetainedImport] = React.useState<RetainedImport | null>(null)
  const [fontBusy, setFontBusy] = React.useState(false)
  const [fontMsg, setFontMsg] = React.useState<string | null>(null)
  const [pendingHandoff, setPendingHandoff] = React.useState<PendingHandoff | null>(null)
  const [activeHandoff, setActiveHandoff] = React.useState<PendingHandoff | null>(null)

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const viewRef = React.useRef(view)
  viewRef.current = view
  const pagesDoneRef = React.useRef(0)
  const pagesTotalRef = React.useRef(0)
  const activeHandoffRef = React.useRef<PendingHandoff | null>(null)
  activeHandoffRef.current = activeHandoff
  const zipEnabled = settings.zipEnabled

  React.useEffect(() => {
    engine.initEngine({
      onProgress: (p: ProgressState) => {
        if (viewRef.current === "importing") {
          setProgress({ ...p, lastUpdateAt: typeof p.lastUpdateAt === "number" && Number.isFinite(p.lastUpdateAt) ? p.lastUpdateAt : Date.now() })
        }
      },
      onImportReport: (value: unknown) => {
        const saved = normalizeSavedImportReport(value)
        if (saved) setLastImportReport(saved)
      },
      onPageDone: (done: number) => {
        pagesDoneRef.current = done
      },
      onComplete: (r: ResultState) => {
        setResult(r)
        if (r.performanceReport) {
          const report = r.performanceReport
          setTarget((previous) => ({
            documentName: report.targetDocumentName === undefined ? previous.documentName : report.targetDocumentName,
            fileKey: report.targetFileKey === undefined ? previous.fileKey : report.targetFileKey,
          }))
        }
        if (activeHandoffRef.current) {
          void engine.notifyDesktopImportComplete(activeHandoffRef.current, r)
          setPendingHandoff(null)
          setActiveHandoff(null)
        }
        setView("success")
      },
      onImportError: (message: string, retained?: RetainedImport) => failImport(message, retained),
      onRefreshFontsComplete: (text: string) => {
        setFontBusy(false)
        setFontMsg(text)
      },
      onInit: (message: { settings?: unknown; targetDocumentName?: string | null; targetFileKey?: string | null; lastImportReport?: unknown }) => {
        const loaded = parseSettings(message.settings)
        setSettings(loaded)
        const fileKey = message.targetFileKey || null
        setTarget({ documentName: message.targetDocumentName || null, fileKey })
        const saved = normalizeSavedImportReport(message.lastImportReport)
        if (saved) setLastImportReport(saved)
        if (!loaded.suppressStartupNotice) setOverlay("notice")
        if (typeof window !== "undefined" && typeof window.fetch === "function") {
          void engine.checkPendingDesktopImport(fileKey).then((pending) => {
            if (!pending) return
            setPendingHandoff(pending as PendingHandoff)
            if (pending.autoStart && loaded.suppressStartupNotice && viewRef.current === "idle") {
              void runHandoffImport(pending as PendingHandoff, true)
            }
          })
        }
      },
    })
  }, [])

  React.useEffect(() => {
    if (view !== "importing") return
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [view])

  function failImport(message: string, retained?: RetainedImport) {
    const currentView = viewRef.current
    if (currentView !== "importing" && currentView !== "error") return
    setError((previous) => {
      if (currentView === "error" && previous?.kind !== "import") return previous
      return {
        kind: "import", message,
        pagesDone: pagesDoneRef.current,
        pagesTotal: pagesTotalRef.current,
        retainedImport: retained || previous?.retainedImport,
      }
    })
    if (retained) setRetainedImport(retained)
    setView("error")
  }

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0 || parsing) return
    const files = Array.from(list)
    const selectionError = singleSourceError(files.length)
    if (selectionError) {
      setDropHint(selectionError)
      return
    }
    const unsupported = files.find((f) => !/\.(mg|zip)$/i.test(f.name))
    const hasZip = files.some((f) => /\.zip$/i.test(f.name))
    if (unsupported) {
      setDropHint(zipEnabled ? "仅支持 .mg 或 .zip 文件" : "仅支持 .mg 文件")
      return
    }
    if (hasZip && !zipEnabled) {
      setDropHint("ZIP 导入需要先在实验室中启用")
      return
    }
    void parseFiles(files)
  }

  function handlePasteFiles(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (viewRef.current !== "idle" || parsing || overlay) return
    const files = event.clipboardData.files
    if (!files || files.length === 0) {
      setDropHint("剪贴板中没有文件。请在资源管理器中复制一个文件后粘贴；不支持粘贴文件路径。")
      return
    }
    handleFiles(files)
  }

  async function parseFiles(files: File[], autoStartAll = false) {
    setParsing(true)
    setDropHint(null)
    // Let React paint and the compositor start the spinner before decoding.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => window.setTimeout(resolve, 0))
    })
    try {
      const info = (await engine.parseFiles(files)) as FileInfo
      setFileInfo(info)
      setRetainedImport(null)
      const allIds = info.pages.map((p) => p.id)
      setSelected(new Set(allIds))
      if (autoStartAll && allIds.length > 0) {
        setParsing(false)
        pagesDoneRef.current = 0
        pagesTotalRef.current = allIds.length
        const now = Date.now()
        setProgressNow(now)
        setProgress({ percent: 0, stage: "prepare", layersDone: 0, layersTotal: 0, lastUpdateAt: now })
        setError(null)
        setView("importing")
        try {
          await engine.startImport(allIds)
        } catch (e: any) {
          failImport(String((e && e.message) || e), e?.retainedImport)
        }
        return
      }
      setView("parsed")
    } catch (e: any) {
      setError({ kind: "read", message: String((e && e.message) || e), pagesDone: 0, pagesTotal: 0 })
      setView("error")
    } finally {
      setParsing(false)
    }
  }

  async function runHandoffImport(handoff: PendingHandoff, autoStartAll = true) {
    if (parsing || viewRef.current === "importing") return
    setParsing(true)
    setDropHint(null)
    setActiveHandoff(handoff)
    try {
      const file = await engine.fetchPendingDesktopPackage(handoff)
      await parseFiles([file], autoStartAll)
    } catch (e: any) {
      setParsing(false)
      setDropHint(String((e && e.message) || e))
    }
  }

  function resetToIdle() {
    engine.resetPackage()
    setFileInfo(null)
    setSelected(new Set())
    setResult(null)
    setError(null)
    setRetainedImport(null)
    setDropHint(null)
    setView("idle")
  }

  function returnToPageSelection() {
    if (!fileInfo || !error?.retainedImport) return
    const pending = new Set(error.retainedImport.pages.filter((page) => page.status === "pending").map((page) => page.sourcePageId))
    setSelected(new Set(fileInfo.pages.filter((page) => pending.has(page.id)).map((page) => page.id)))
    setError(null)
    setView("parsed")
  }

  function downloadErrorReport() {
    if (!error?.retainedImport) return
    const sourceName = fileInfo ? sourceDocumentName(fileInfo) : "未知源文件"
    const report = { schemaVersion: 1, sourceName, recordedAt: new Date().toISOString(), target,
      status: error.retainedImport.status, error: error.message, retainedImport: error.retainedImport }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${sourceName}-中断导入报告.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function startImport() {
    if (!fileInfo) return
    const selectionError = singleSourceError(fileInfo.fileNames.length)
    if (selectionError) {
      setError({ kind: "read", message: selectionError, pagesDone: 0, pagesTotal: 0 })
      setView("error")
      return
    }
    const ids = fileInfo!.pages.map((p) => p.id).filter((id) => selected.has(id))
    if (ids.length === 0) return
    pagesDoneRef.current = 0
    pagesTotalRef.current = ids.length
    const now = Date.now()
    setProgressNow(now)
    setProgress({ percent: 0, stage: "prepare", layersDone: 0, layersTotal: 0, lastUpdateAt: now })
    setError(null)
    setView("importing")
    try {
      await engine.startImport(ids)
    } catch (e: any) {
      failImport(String((e && e.message) || e), e?.retainedImport)
    }
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(fileInfo!.pages.map((p) => p.id)) : new Set())
  }

  function togglePage(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function openLab() {
    setPrevView(view === "lab" ? "idle" : view)
    setFontMsg(null)
    setView("lab")
  }

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((previous) => {
      const next = { ...previous, ...patch }
      engine.saveSettings(next)
      return next
    })
  }

  function dismissStartupNotice() {
    updateSettings({ suppressStartupNotice: noticeDontShowAgain })
    setOverlay(null)
    if (pendingHandoff?.autoStart && viewRef.current === "idle") {
      void runHandoffImport(pendingHandoff, true)
    }
  }

  function resetSettings() {
    const defaults = { ...DEFAULT_SETTINGS }
    engine.saveSettings(defaults)
    setSettings(defaults)
    setNoticeDontShowAgain(false)
    setDropHint(null)
    setOverlay("notice")
  }

  const accept = zipEnabled ? ".mg,.zip,application/zip" : ".mg"

  return (
    <div className="flex h-screen w-full flex-col">
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {view === "idle" && (
          <>
            {pendingHandoff && (
              <div className="flex items-center justify-between gap-2.5 rounded-xl border border-primary bg-primary px-3.5 py-2.5 text-xs text-primary-foreground">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">
                    桌面端已就绪：{pendingHandoff.sourceName}
                  </div>
                  <div className="truncate text-[11px] opacity-80">
                    {pendingHandoff.designPageCount} 个设计页 · {pendingHandoff.recordCount} 个图层
                  </div>
                </div>
                <Button size="sm" variant="secondary" className="shrink-0 rounded-full" disabled={parsing} onClick={() => void runHandoffImport(pendingHandoff, true)}>
                  一键直连导入
                </Button>
              </div>
            )}
            <IdleView
              zipEnabled={zipEnabled}
              parsing={parsing}
              dropHint={dropHint}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onDropFiles={handleFiles}
              onPasteFiles={handlePasteFiles}
              onPick={() => fileInputRef.current?.click()}
            />
            {lastImportReport && <LastImportReportView report={lastImportReport} />}
          </>
        )}

        {view === "parsed" && fileInfo && (
          <ParsedView
            fileInfo={fileInfo}
            target={target}
            selected={selected}
            retainedImport={retainedImport}
            onToggleAll={toggleAll}
            onTogglePage={togglePage}
            onRemove={resetToIdle}
            onImport={() => void startImport()}
          />
        )}

        {view === "importing" && <ImportingView progress={progress} now={progressNow} />}

        {view === "success" && result && (
          <ResultView
            result={result}
            sourceName={fileInfo ? sourceDocumentName(fileInfo) : "未知源文件"}
            target={target}
            onDone={() => engine.closePlugin()}
            onRestart={resetToIdle}
          />
        )}

        {view === "error" && error && (
          <>
            {fileInfo && error.kind === "import" && <FileRow fileInfo={fileInfo} />}
            <ErrorView
              error={error}
              onRestart={resetToIdle}
              onReturn={error.retainedImport && fileInfo && engine.hasPackage() ? returnToPageSelection : undefined}
              onDownload={error.retainedImport ? downloadErrorReport : undefined}
            />
          </>
        )}

        {view === "lab" && (
          <LabView
            zipEnabled={zipEnabled}
            onZipEnabledChange={(v) => {
              updateSettings({ zipEnabled: v })
              setDropHint(null)
            }}
            fontBusy={fontBusy}
            fontMsg={fontMsg}
            onRefreshFonts={() => {
              setFontBusy(true)
              setFontMsg(null)
              engine.refreshFonts()
            }}
            onResetSettings={resetSettings}
            onBack={() => setView(prevView)}
          />
        )}
      </main>

      {(view === "idle" || view === "parsed" || view === "importing" || view === "success" || view === "error") && (
        <footer className="flex h-10 shrink-0 items-center justify-between border-t px-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <button
              className="hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              disabled={view === "importing"}
              onClick={openLab}
            >
              实验室
            </button>
            <span aria-hidden>·</span>
            <a className="hover:text-foreground" href={HELP_URL} target="_blank" rel="noreferrer">
              Github（禁止未署名二次分发）
            </a>
          </div>
          <span title="2026.11.10-v3.0">Mg2Fig V3</span>
        </footer>
      )}

      {overlay === "notice" && (
        <StartupNotice
          dontShowAgain={noticeDontShowAgain}
          onDontShowAgainChange={setNoticeDontShowAgain}
          onDismiss={dismissStartupNotice}
        />
      )}
    </div>
  )
}

function IdleView(props: {
  zipEnabled: boolean
  parsing: boolean
  dropHint: string | null
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onDropFiles: (files: FileList | null) => void
  onPasteFiles: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onPick: () => void
}) {
  const { zipEnabled, parsing, dropHint, dragOver, setDragOver, onDropFiles, onPasteFiles, onPick } = props
  const typeText = zipEnabled ? ".mg 或 .zip" : ".mg"
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div
        className={
          "flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/40 px-5 py-6 transition-all " +
          (dragOver ? "border-primary bg-accent/80" : "border-border hover:border-primary/40 hover:bg-card/80")
        }
        onClick={() => !parsing && onPick()}
        onDragOver={(e) => {
          e.preventDefault()
          if (!parsing) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (!parsing) onDropFiles(e.dataTransfer.files)
        }}
      >
        {parsing ? (
          <>
            <LoadingSpinner />
            <div className="text-sm font-medium">正在解析文件…</div>
          </>
        ) : (
          <>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-foreground shadow-sm">
              <FileUp className="h-5 w-5" />
            </div>
            <div className="text-sm font-semibold tracking-tight">拖入或选择 {typeText} 文件</div>
            <div className="text-center text-xs text-muted-foreground">一次一个源文件，分别导入对应的 Figma 文件（支持桌面端双链接直连）</div>
            <Button
              variant="secondary"
              size="sm"
              className="mt-0.5 px-4 font-medium"
              onClick={(e) => {
                e.stopPropagation()
                onPick()
              }}
            >
              选择文件
            </Button>
          </>
        )}
      </div>
      <textarea
        aria-label="在此粘贴迁移文件"
        placeholder={`快捷方式：在资源管理器复制 ${typeText} 文件后，点击此处按 Ctrl+V 直接粘贴`}
        value=""
        onChange={() => {}}
        onPaste={onPasteFiles}
        disabled={parsing}
        rows={1}
        className="w-full resize-none rounded-lg border border-border bg-card/60 px-3 py-2 text-center text-xs text-muted-foreground outline-none transition-colors hover:border-primary/40 focus-visible:border-primary focus-visible:text-foreground"
      />
      {dropHint && (
        <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {dropHint}
        </div>
      )}
    </div>
  )
}

function FileRow({ fileInfo, onRemove }: { fileInfo: FileInfo; onRemove?: () => void }) {
  const fileLabel =
    fileInfo.fileNames.length === 1 ? fileInfo.fileNames[0] : `${fileInfo.fileNames.length} 个文件`
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 rounded-lg border pl-3 pr-2">
      <FileArchive className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={fileInfo.fileNames.join("\n")}>
        {fileLabel}
      </span>
      {onRemove && (
        <Button variant="ghost" size="icon" className="h-7 w-7" title="移除文件" onClick={onRemove}>
          <X />
        </Button>
      )}
    </div>
  )
}

function ParsedView(props: {
  fileInfo: FileInfo
  target: ImportTarget
  selected: Set<string>
  retainedImport?: RetainedImport | null
  onToggleAll: (checked: boolean) => void
  onTogglePage: (id: string, checked: boolean) => void
  onRemove: () => void
  onImport: () => void
}) {
  const { fileInfo, target, selected, retainedImport, onToggleAll, onTogglePage, onRemove, onImport } = props
  const allChecked =
    selected.size === fileInfo.pages.length ? true : selected.size === 0 ? false : ("indeterminate" as const)

  return (
    <>
      <FileRow fileInfo={fileInfo} onRemove={onRemove} />
      <ImportIdentity sourceName={sourceDocumentName(fileInfo)} target={target} />

      <div className="text-xs text-muted-foreground">
        已读取 · {fileInfo.pageCount} 个页面 · {fileInfo.layerCount} 个图层
      </div>
      {retainedImport && (
        <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          上次已完成 {retainedImport.completedPageCount} 页、部分保留 {retainedImport.partialPageCount} 页，默认仅选未开始的页面。
          部分保留页请先在画布核对；再次选择已完成或部分保留页会新增页面，不会覆盖现有内容。
          {selected.size === 0 && "当前没有默认待导入页面，请手动选择后再导入。"}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <div
          className="flex h-10 shrink-0 cursor-pointer items-center gap-2.5 border-b bg-[hsl(var(--selection))] px-3 text-[hsl(var(--selection-foreground))]"
          onClick={() => onToggleAll(allChecked !== true)}
        >
          <Checkbox
            checked={allChecked}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={(checked) => onToggleAll(checked === true)}
          />
          <span className="flex-1 text-sm">全选</span>
          <span className="text-xs">已选 {selected.size} 页</span>
        </div>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto">
          {fileInfo.pages.map((page) => (
            <div
              key={page.id}
              className="flex h-10 cursor-pointer items-center gap-2.5 px-3 hover:bg-accent/50"
              onClick={() => onTogglePage(page.id, !selected.has(page.id))}
            >
              <Checkbox
                checked={selected.has(page.id)}
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={(checked) => onTogglePage(page.id, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate text-sm" title={page.name}>
                {page.displayName}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{page.layerCount}</span>
            </div>
          ))}
        </div>
      </div>

      <Button className="w-full" disabled={selected.size === 0} onClick={onImport}>
        {selected.size === 0 ? "请选择页面" : `导入 ${selected.size} 个页面`}
      </Button>
    </>
  )
}

// Animate an HTML layer, keeping the SVG static inside it so rotation can
// run on the compositor while synchronous package work occupies the UI thread.
function LoadingSpinner() {
  return (
    <span aria-hidden="true" className="block h-8 w-8 shrink-0 animate-spin text-muted-foreground [will-change:transform]">
      <Loader2 className="block h-8 w-8" />
    </span>
  )
}

function LastImportReportView({ report }: { report: SavedImportReport }) {
  return (
    <details className="max-h-[50%] shrink-0 overflow-y-auto rounded-lg border p-3 text-xs">
      <summary className="cursor-pointer font-medium">上次迁移报告</summary>
      <dl className="my-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">源文件</dt><dd className="break-words">{report.sourceName}</dd>
        <dt className="text-muted-foreground">已保存目标</dt><dd className="break-words">{report.target.documentName || "未知"}</dd>
        <dt className="text-muted-foreground">fileKey</dt><dd className="break-all font-mono">{report.target.fileKey || "未知"}</dd>
        <dt className="text-muted-foreground">{report.performanceReport.retainedImport ? "记录时间" : "完成时间"}</dt>
        <dd><time dateTime={report.completedAt}>{new Date(report.completedAt).toLocaleString("zh-CN")}</time></dd>
      </dl>
      <ImportPerformance sourceName={report.sourceName} target={report.target} report={report.performanceReport} />
    </details>
  )
}

function ImportingView({ progress, now }: { progress: ProgressState; now: number }) {
  const statusLine = progressStageLabel(progress.stage)
  const waitingSeconds = progressWaitingSeconds(progress.lastUpdateAt, now)

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border px-8">
      <LoadingSpinner />
      <div className="w-full truncate text-center text-sm font-medium" title={statusLine}>
        {statusLine}
      </div>
      {progress.pageName && <div className="w-full break-words text-center text-xs text-muted-foreground">当前页面：{progress.pageName}</div>}
      {progress.operationLabel && progress.operationLabel !== statusLine && (
        <div className="w-full break-words text-center text-xs text-muted-foreground">{progress.operationLabel}</div>
      )}
      <div className="text-xs tabular-nums text-muted-foreground">已还原图层 · {progress.layersDone}/{progress.layersTotal}</div>
      <Progress value={progress.percent} />
      <div className="text-xs tabular-nums text-muted-foreground">{progress.percent}%</div>
      {waitingSeconds > 0 && (
        <p role="status" className="text-center text-xs text-muted-foreground">{`已 ${waitingSeconds} 秒未收到新进度，正在等待当前操作。`}</p>
      )}
      {progress.stage === "fonts" && <p className="text-center text-xs text-muted-foreground">请确认 Figma 本地字体服务已启动。</p>}
    </div>
  )
}

function ResultView(props: {
  result: ResultState
  sourceName: string
  target: ImportTarget
  onDone: () => void
  onRestart: () => void
}) {
  const { result, sourceName, target, onDone, onRestart } = props
  const hasWarnings = result.unresolvedInstanceCount > 0 || result.sourceWarningCount > 0
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto rounded-lg border px-6 py-5 text-center">
        {hasWarnings
          ? <AlertCircle className="h-8 w-8 text-amber-600" />
          : <CheckCircle2 className="h-8 w-8 text-green-600" />}
        <div className="text-sm font-medium">
          {hasWarnings ? "导入完成，存在降级提示" : "导入完成"} · {result.pageCount} 个设计页 · {result.layerCount} 个图层
        </div>
        {result.dependencyPageCount > 0 && (
          <div className="text-xs text-muted-foreground">
            另建 {result.dependencyPageCount} 个迁移依赖页 · 保留 {result.dependencyComponentCount} 个主组件
          </div>
        )}
        <ImportPerformance sourceName={sourceName} target={target} report={result.performanceReport} />
        {result.details.length > 0 && (
          <ul className="space-y-0.5 text-left text-xs text-muted-foreground">
            {result.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex w-full flex-col gap-2">
        <Button className="w-full" onClick={onDone}>
          完成
        </Button>
        <Button variant="ghost" className="w-full" onClick={onRestart}>
          重新导入
        </Button>
      </div>
    </>
  )
}

function ErrorView(props: {
  error: ErrorState
  onRestart: () => void
  onReturn?: () => void
  onDownload?: () => void
}) {
  const { error, onRestart, onReturn, onDownload } = props
  const isRead = error.kind === "read"
  const retained = error.retainedImport
  const retainedGroups = [
    { status: "completed", label: "已完成" },
    { status: "partial", label: "部分保留，需核对" },
    { status: "pending", label: "未开始" },
  ] as const
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto rounded-lg border px-6 py-5 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <div className="text-sm font-medium">
          {isRead ? "无法读取文件" : retained
            ? retained.retainedPageCount > 0 ? "导入中断，已保留部分内容" : "导入中断，尚未保留页面"
            : `导入失败 · 已完成 ${error.pagesDone} / ${error.pagesTotal} 个页面`}
        </div>
        <div className="text-xs text-muted-foreground">
          {isRead ? "文件可能已损坏或格式不受支持" : retained
            ? retained.retainedPageCount > 0
              ? "已完成页面及已创建的有效图层保留在当前文件；错误后的页面未继续导入。请先核对部分保留页。"
              : "尚未创建可保留页面，后续页面未继续导入。修正错误后可返回页面选择。"
            : "请检查当前文件中的已导入内容，再重新选择文件；再次导入会新增页面。"}
        </div>
        {isRead && (
          <div className="text-xs text-muted-foreground">
            可以将错误的 mg 文件发送至
            <a className="underline underline-offset-2 hover:text-foreground" href={`mailto:${CONTACT_EMAIL}`}>
              作者邮箱
            </a>
            来帮助作者迭代插件
          </div>
        )}
        <div className="mt-3 max-h-24 max-w-full shrink-0 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-[hsl(var(--selection))] p-2 text-left text-xs text-[hsl(var(--selection-foreground))]">
          {error.message}
        </div>
        {retained && (
          <div className="w-full space-y-3 text-left text-xs">
            <p className="text-muted-foreground">
              已完成 {retained.completedPageCount} 页 · 部分保留 {retained.partialPageCount} 页 · 未开始 {retained.pendingPageCount} 页。
              完成页源记录 {retained.completedSourceRecordCount}/{retained.totalSourceRecordCount}；已报告还原进度 {retained.reportedRestoredRecordCount}。
            </p>
            {retainedGroups.map((group) => {
              const items = retained.pages.filter((page) => page.status === group.status)
              if (items.length === 0) return null
              return (
                <details key={group.status} open className="rounded-md border p-2">
                  <summary className="cursor-pointer font-medium">{group.label} · {items.length} 页</summary>
                  <ul className="mt-2 space-y-2">
                    {items.map((page) => (
                      <li key={page.sourcePageId} className="break-all">
                        <div>{page.sourcePageName || page.sourcePageId}</div>
                        <div className="text-muted-foreground">源 ID：{page.sourcePageId}</div>
                        <div className="text-muted-foreground">
                          {page.targetPageId ? `目标：${page.targetPageName || "未命名"} · ID：${page.targetPageId}` : "尚未创建目标页面"}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })}
            {retained.cleanupWarnings.length > 0 && (
              <details className="rounded-md border p-2">
                <summary className="cursor-pointer">保留检查提示 · {retained.cleanupWarnings.length} 项</summary>
                <ul className="mt-2 space-y-1 break-all">{retained.cleanupWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              </details>
            )}
          </div>
        )}
      </div>
      {onReturn && <Button className="w-full" onClick={onReturn}>返回页面选择</Button>}
      {onDownload && <Button variant="outline" className="w-full" onClick={onDownload}>下载中断报告 JSON</Button>}
      <Button variant={retained ? "ghost" : "default"} className="w-full" onClick={onRestart}>
        {isRead || retained ? "重新选择文件" : "重新导入"}
      </Button>
    </>
  )
}

function LabView(props: {
  zipEnabled: boolean
  onZipEnabledChange: (v: boolean) => void
  fontBusy: boolean
  fontMsg: string | null
  onRefreshFonts: () => void
  onResetSettings: () => void
  onBack: () => void
}) {
  const {
    zipEnabled,
    onZipEnabledChange,
    fontBusy,
    fontMsg,
    onRefreshFonts,
    onResetSettings,
    onBack,
  } = props
  const [contactCopied, setContactCopied] = React.useState(false)

  async function copyContactEmail() {
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL)
    } catch {
      const textarea = document.createElement("textarea")
      textarea.value = CONTACT_EMAIL
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      textarea.remove()
    }
    setContactCopied(true)
    window.setTimeout(() => setContactCopied(false), 1600)
  }

  return (
    <div className="flex flex-1 flex-col gap-4 text-card-foreground">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack} title="返回">
          <ChevronLeft />
        </Button>
        <span className="text-sm font-semibold">实验室</span>
      </div>

      <div className="text-xs text-muted-foreground">
        实验功能可能不稳定，使用前建议保留原始文件。
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">启用 ZIP 导入</div>
          <Switch checked={zipEnabled} onCheckedChange={onZipEnabledChange} />
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          允许主界面选择和拖入 .zip 文件。该功能可能存在兼容性问题。
        </div>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">字体工具</div>
          <Button variant="outline" size="sm" className={fontMsg ? "border-[hsl(var(--control-border))]" : "border-[hsl(var(--control-border))] bg-transparent text-card-foreground hover:bg-primary hover:text-primary-foreground"} disabled={fontBusy} onClick={onRefreshFonts}>
            {fontBusy && <Loader2 className="animate-spin" />}
            刷新字体
          </Button>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          重新读取本机字体，仅在新安装字体未被识别时使用。
        </div>
        {fontMsg && <div className="mt-1.5 text-xs text-foreground">字体列表已刷新 · {fontMsg}</div>}
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">恢复默认设置</div>
          <Button variant="outline" size="sm" className="border-[hsl(var(--control-border))] bg-transparent text-card-foreground hover:bg-primary hover:text-primary-foreground" onClick={onResetSettings}>
            恢复
          </Button>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          将实验功能和启动提示恢复为默认状态。
        </div>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">联系与许可</div>
          <div className="flex items-center gap-2">
            <a className="text-xs text-muted-foreground hover:text-foreground" href={HELP_URL} target="_blank" rel="noreferrer">
              Github
            </a>
            <Button variant="outline" size="sm" className={contactCopied ? "border-[hsl(var(--control-border))]" : "border-[hsl(var(--control-border))] bg-transparent text-card-foreground hover:bg-primary hover:text-primary-foreground"} onClick={copyContactEmail}>
              {contactCopied ? "已复制" : "复制邮箱"}
            </Button>
          </div>
        </div>
        <div className="mt-1.5 text-xs break-all text-muted-foreground">上游作者邮箱 · {CONTACT_EMAIL}</div>
      </div>
    </div>
  )
}

function StartupNotice(props: {
  dontShowAgain: boolean
  onDontShowAgainChange: (checked: boolean) => void
  onDismiss: () => void
}) {
  const { dontShowAgain, onDontShowAgainChange, onDismiss } = props
  return (
    <div
      className="fixed inset-0 z-50 flex h-full items-center justify-center bg-background/80 p-5 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="项目说明"
    >
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <div className="w-full space-y-3 text-left text-sm leading-6 text-muted-foreground">
          <p>
            本插件基于 Aaron Xu 的 MasterGo2Figma 修改，保留原作者署名及 CC BY-NC-SA 4.0 许可。不同设计稿可能存在还原差异。
          </p>
          <p>
            问题反馈欢迎在 M2Fig Github 提交 issue / PR。上游作者公开联系邮箱为{" "}
            <span className="text-foreground">{CONTACT_EMAIL}</span>
            （反馈时请提供仅包含问题图层的最小复现）。
          </p>
        </div>
        <div className="mt-6 grid w-full grid-cols-2 gap-2">
          <Button variant="outline" asChild>
            <a href={HELP_URL} target="_blank" rel="noreferrer">
              查看 Github
            </a>
          </Button>
          <Button onClick={onDismiss}>知道了</Button>
        </div>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={dontShowAgain} onCheckedChange={(checked) => onDontShowAgainChange(checked === true)} />
          <span>不再提示</span>
        </label>
      </div>
    </div>
  )
}
