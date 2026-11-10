"use strict";

const ui = Object.fromEntries([
  "version", "export-form", "links", "figma-links", "output-dir",
  "choose-directory", "use-default-dir", "start-export", "open-output", "open-figma", "task-status",
  "status", "progress", "copy-plugin", "plugin-path", "log", "log-empty",
].map((id) => [id, document.getElementById(id)]));
const optionalUi = {
  openMasterGo: document.getElementById("open-mastergo"),
  figmaReadyHint: document.getElementById("figma-ready-hint"),
};
const desktopBridge = window.bridge;
let ready = false;
let busy = false;
let choosing = false;
let pluginManifest = "";
let lastTargetUrl = "";
let logLines = [];
const MAX_LOG_LINES = 800;
const MAX_LOG_CHARS = 100000;

function firstLineUrl(value) {
  if (!value) return "";
  const match = String(value).match(/(?:https?|mastergo|figma):\/\/[^\s<>\[\]"']+/i);
  return match ? match[0] : "";
}

function updateControls() {
  ui.links.readOnly = busy;
  if (ui["figma-links"]) ui["figma-links"].readOnly = busy;
  ui["choose-directory"].disabled = !ready || busy || choosing;
  if (ui["use-default-dir"]) ui["use-default-dir"].disabled = !ready || busy || choosing;
  ui["start-export"].disabled = !ready || busy || choosing;
  ui["open-output"].disabled = !ready || !ui["output-dir"].value;
  if (optionalUi.openMasterGo) {
    const mgCandidate = firstLineUrl(ui.links.value);
    optionalUi.openMasterGo.disabled = !ready || !mgCandidate;
  }
  const typedFigmaUrl = ui["figma-links"] ? firstLineUrl(ui["figma-links"].value) : "";
  const activeFigmaUrl = lastTargetUrl || typedFigmaUrl;
  if (ui["open-figma"]) {
    ui["open-figma"].hidden = !activeFigmaUrl;
    ui["open-figma"].disabled = !ready || !activeFigmaUrl;
  }
  if (optionalUi.figmaReadyHint) {
    optionalUi.figmaReadyHint.hidden = Boolean(activeFigmaUrl);
  }
  ui["copy-plugin"].disabled = !ready || !pluginManifest;
  const hasFigmaLink = Boolean(ui["figma-links"] && ui["figma-links"].value.trim());
  ui["start-export"].textContent = busy ? "正在导出…" : (hasFigmaLink ? "一键导出并直连 Figma" : "开始导出 ZIP");
  ui["export-form"].setAttribute("aria-busy", String(busy));
  ui.progress.hidden = !busy;
}

function status(message, state = "idle") {
  ui.status.textContent = String(message);
  ui["task-status"].dataset.state = state;
}

function appendLog(message) {
  const log = ui.log;
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
  const text = String(message).slice(-MAX_LOG_CHARS);
  logLines.push(...text.split(/\r?\n/));
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  let joined = logLines.join("\n");
  if (joined.length > MAX_LOG_CHARS) {
    joined = joined.slice(-MAX_LOG_CHARS);
    logLines = joined.split("\n");
  }
  log.textContent = joined;
  log.hidden = false;
  ui["log-empty"].hidden = true;
  if (atEnd) log.scrollTop = log.scrollHeight;
}

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  status(message, "error");
  appendLog(message);
}

function finish(result) {
  busy = false;
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const matchedTarget = sources.find((item) => item && item.status === "verified" && item.targetUrl);
  lastTargetUrl = matchedTarget ? String(matchedTarget.targetUrl) : "";
  updateControls();
  const total = sources.length;
  const count = Number.isFinite(result.verifiedCount) ? result.verifiedCount : 0;
  const summary = `${count}/${total} 个文件`;
  if (result.status === "complete" && count === total && total > 0) {
    if (lastTargetUrl) {
      status(`导出完成 · ${summary}，已开启本地直连，正在调起 Figma 桌面客户端…`, "success");
      if (typeof desktopBridge.openFigmaTarget === "function") {
        desktopBridge.openFigmaTarget(lastTargetUrl).catch(() => {});
      }
    } else {
      status(`导出完成 · ${summary}，可在 Figma 桌面端插件中导入。`, "success");
    }
  } else if (result.status === "partial" || (result.status === "complete" && count < total)) {
    status(`部分完成 · ${summary}，请查看处理记录。`, "partial");
  } else if (result.status === "failed") {
    status(`导出未完成 · ${summary}，请查看处理记录。`, "error");
  } else {
    status("导出已结束，请查看处理记录确认结果。", "partial");
  }
  appendLog(ui.status.textContent);
  if (result.summaryPath) appendLog(`本次说明：${result.summaryPath}`);
}

ui.links.addEventListener("input", () => {
  ui.links.removeAttribute("aria-invalid");
  updateControls();
});

if (ui["figma-links"]) {
  ui["figma-links"].addEventListener("input", () => {
    ui["figma-links"].removeAttribute("aria-invalid");
    updateControls();
  });
}

if (ui["use-default-dir"]) {
  ui["use-default-dir"].addEventListener("click", async () => {
    if (busy || choosing || !ready || typeof desktopBridge.useDefaultDirectory !== "function") return;
    choosing = true;
    updateControls();
    try {
      const directory = await desktopBridge.useDefaultDirectory();
      if (directory) ui["output-dir"].value = directory;
    } catch (error) {
      reportError(error);
    } finally {
      choosing = false;
      updateControls();
    }
  });
}

if (ui["open-figma"]) {
  ui["open-figma"].addEventListener("click", async () => {
    const targetUrl = lastTargetUrl || (ui["figma-links"] ? firstLineUrl(ui["figma-links"].value) : "");
    if (!ready || !targetUrl || typeof desktopBridge.openFigmaTarget !== "function") return;
    try {
      await desktopBridge.openFigmaTarget(targetUrl);
    } catch (error) {
      reportError(error);
    }
  });
}

if (optionalUi.openMasterGo) {
  optionalUi.openMasterGo.addEventListener("click", async () => {
    const mgUrl = firstLineUrl(ui.links.value);
    if (!ready || !mgUrl || typeof desktopBridge.openMasterGoTarget !== "function") return;
    try {
      await desktopBridge.openMasterGoTarget(mgUrl);
    } catch (error) {
      reportError(error);
    }
  });
}

ui["choose-directory"].addEventListener("click", async () => {
  if (busy || choosing || !ready) return;
  choosing = true;
  updateControls();
  try {
    const directory = await desktopBridge.chooseDirectory();
    if (directory) ui["output-dir"].value = directory;
  } catch (error) {
    reportError(error);
  } finally {
    choosing = false;
    updateControls();
  }
});

ui["export-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ready || busy || choosing) return;
  const links = ui.links.value.trim();
  const figmaLinks = ui["figma-links"] ? ui["figma-links"].value.trim() : "";
  const outputDir = ui["output-dir"].value;
  if (!links) {
    ui.links.setAttribute("aria-invalid", "true");
    status("请先填写 MasterGo 文件链接，每行一个。", "error");
    ui.links.focus();
    return;
  }
  if (!outputDir) {
    status("请先选择迁移 ZIP 的保存目录。", "error");
    ui["choose-directory"].focus();
    return;
  }
  busy = true;
  lastTargetUrl = "";
  updateControls();
  status("正在读取客户端快照…", "busy");
  appendLog("开始新任务；每个源独立导出，已有文件不会被覆盖。");
  try {
    const startPayload = figmaLinks ? { links, outputDir, figmaLinks } : { links, outputDir };
    const response = await desktopBridge.startExport(startPayload);
    if (!response || response.started !== true) throw new Error("本地导出任务未能启动，请重试。");
  } catch (error) {
    busy = false;
    updateControls();
    reportError(error);
  }
});

ui["open-output"].addEventListener("click", async () => {
  if (!ready) return;
  try { await desktopBridge.openOutput(); } catch (error) { reportError(error); }
});
ui["copy-plugin"].addEventListener("click", async () => {
  if (!ready || !pluginManifest) return;
  try {
    await desktopBridge.copyPluginPath();
    ui["copy-plugin"].textContent = "已复制";
    window.setTimeout(() => { ui["copy-plugin"].textContent = "复制路径"; }, 1800);
  } catch (error) { reportError(error); }
});

async function initialize() {
  if (!desktopBridge) {
    status("桌面连接不可用，请从安装的本地程序重新打开。", "error");
    ui["plugin-path"].textContent = "桌面连接不可用";
    return;
  }
  const unsubscribe = desktopBridge.onEvent((event) => {
    if (event.type === "log") {
      appendLog(event.message);
      if (busy) status(String(event.message).split(/\r?\n/)[0], "busy");
    } else if (event.type === "complete") {
      finish(event.result);
    } else if (event.type === "handoff-complete") {
      const msg = `Figma 直连导入完成：${event.sourceName || "文件"}（${event.pageCount || 0} 页 · ${event.layerCount || 0} 个图层）`;
      status(msg, "success");
      appendLog(msg);
    } else if (event.type === "error") {
      busy = false;
      updateControls();
      reportError(event.message);
    }
  });
  window.addEventListener("beforeunload", () => unsubscribe(), { once: true });
  try {
    const context = await desktopBridge.getContext();
    pluginManifest = String(context.pluginManifest || "");
    ui["plugin-path"].textContent = pluginManifest || "未找到插件 manifest，请检查安装目录。";
    ui["plugin-path"].title = pluginManifest;
    if (context.version && ui.version) ui.version.textContent = "V3";
    ready = true;
    status("填写链接并选择保存目录，即可导出。");
    updateControls();
  } catch (error) {
    ui["plugin-path"].textContent = "无法读取本地插件位置";
    reportError(error);
  }
}

initialize();
