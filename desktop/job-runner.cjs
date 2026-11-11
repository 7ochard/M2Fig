"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn: spawnProcess } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

function createJobRunner({ repoRoot, python, node, onEvent, spawn = spawnProcess }) {
  if (typeof repoRoot !== "string" || !repoRoot.trim()) throw new TypeError("缺少 Bridge 工程目录。");
  for (const [name, executable] of [["Python", python], ["Node.js", node]]) {
    if (typeof executable !== "string" || !path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
      throw new TypeError(`未找到已配置的 ${name} 运行时。`);
    }
  }
  if (typeof onEvent !== "function") throw new TypeError("缺少导出事件接收器。");
  const root = fs.realpathSync(repoRoot);
  const worker = path.join(root, "tools", "desktop_bridge_worker.py");
  let running = false;

  function start(input) {
    if (running) throw new Error("已有导出任务正在运行，请等待结束。");
    if (!input || typeof input.links !== "string" || !input.links.trim()) throw new TypeError("请填写 MasterGo 文件链接。");
    if (typeof input.outputDir !== "string" || !input.outputDir.trim()) throw new TypeError("请选择保存目录。");
    const outputDir = path.resolve(input.outputDir);
    if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) throw new Error("保存目录不存在或不是文件夹。");

    const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    const previousPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = [path.dirname(python), path.dirname(node), previousPath].join(path.delimiter);
    running = true;
    let child;
    try {
      child = spawn(python, ["-X", "utf8", "-u", worker], {
        cwd: root, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      running = false;
      throw error;
    }

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let pending = "", stderrTail = "", finalEvent = null, processError = null, protocolError = null, closed = false;
    const appendStderr = text => { stderrTail = (stderrTail + text).slice(-8000); };
    function parseLine(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch (_) { protocolError ||= "导出进程返回了无效的 JSON 事件。"; return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        protocolError ||= "导出进程返回了无效事件。";
      } else if (event.type === "log" && typeof event.message === "string") {
        onEvent({ type: "log", message: event.message });
      } else if ((event.type === "error" && typeof event.message === "string") ||
          (event.type === "complete" && event.result && typeof event.result === "object" && !Array.isArray(event.result) &&
            ["complete", "partial", "failed"].includes(event.result.status))) {
        if (finalEvent) protocolError ||= "导出进程返回了多个结束事件。";
        else finalEvent = event.type === "error" ? { type: "error", message: event.message || "导出未完成。" } : { type: "complete", result: event.result };
      } else {
        protocolError ||= "导出进程事件格式不正确。";
      }
    }
    function appendStdout(text) {
      pending += text;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        parseLine(line);
      }
    }
    child.stdout.on("data", chunk => { if (!closed) appendStdout(stdoutDecoder.write(chunk)); });
    child.stderr.on("data", chunk => { if (!closed) appendStderr(stderrDecoder.write(chunk)); });
    child.on("error", error => { processError ||= error; });
    child.stdin.on("error", error => { processError ||= error; });
    child.on("close", (code, signal) => {
      if (closed) return;
      closed = true;
      appendStdout(stdoutDecoder.end());
      if (pending.trim()) parseLine(pending);
      appendStderr(stderrDecoder.end());
      const exitLabel = signal ? "信号 " + signal : "退出码 " + code;
      let error = processError ? `导出进程异常：${processError.message}` :
        (code !== 0 || signal) ? (finalEvent?.type === "error" ? `${finalEvent.message}（${exitLabel}）。` : `导出进程未正常结束（${exitLabel}）。`) :
        protocolError || (!finalEvent ? "导出进程未返回结束状态。" : finalEvent.type === "error" ? finalEvent.message : null);
      if (error && stderrTail.trim()) error += "\n" + stderrTail.trim();
      running = false;
      onEvent(error ? { type: "error", message: error } : finalEvent);
    });
    const payload = { links: input.links, outputDir };
    if (typeof input.figmaLinks === "string" && input.figmaLinks.trim()) {
      payload.figmaLinks = input.figmaLinks.trim();
    }
    try { child.stdin.end(JSON.stringify(payload) + "\n", "utf8"); }
    catch (error) { processError ||= error; }
    return { started: true };
  }

  return { start, isRunning: () => running };
}

module.exports = { createJobRunner };
