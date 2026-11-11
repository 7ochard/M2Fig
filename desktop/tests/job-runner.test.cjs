"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { createJobRunner } = require("../job-runner.cjs");

const repoRoot = path.resolve(__dirname, "../..");
function host() {
  const events = [], calls = [], children = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-desktop-job-"));
  const runner = createJobRunner({ repoRoot, python: process.execPath, node: process.execPath, onEvent: event => events.push(event),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.input = ""; child.stdin.on("data", chunk => { child.input += chunk.toString(); });
      children.push(child);
      return child;
    } });
  const start = extra => runner.start({ links: "https://mastergo.com/file/123", outputDir, ...extra });
  return { runner, events, calls, children, outputDir, start };
}
function line(child, event, newline = true) { child.stdout.write(Buffer.from(JSON.stringify(event) + (newline ? "\n" : ""))); }

test("fixed worker argv, stdin JSON and runtime paths cannot be replaced by renderer fields", () => {
  const h = host();
  assert.deepEqual(h.start({ command: "untrusted.exe", script: "untrusted.py" }), { started: true });
  const call = h.calls[0], child = h.children[0];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ["-X", "utf8", "-u", path.join(repoRoot, "tools/desktop_bridge_worker.py")]);
  assert.equal(call.options.cwd, fs.realpathSync(repoRoot));
  assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(call.options.env.PYTHONIOENCODING, "utf-8");
  assert.ok(call.options.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter));
  assert.deepEqual(JSON.parse(child.input), { links: "https://mastergo.com/file/123", outputDir: h.outputDir });
  assert.equal(child.stdin.writableEnded, true);
  line(child, { type: "complete", result: { status: "complete" } }); child.emit("close", 0, null);
});

test("split UTF-8 Chinese lines stream logs but final success waits for close", () => {
  const h = host(); h.start(); const child = h.children[0];
  const bytes = Buffer.from(JSON.stringify({ type: "log", message: "正在导出：中文" }) + "\r\n" +
    JSON.stringify({ type: "complete", result: { status: "complete", sourceName: "中文" } }));
  const split = bytes.indexOf(Buffer.from("正")) + 1;
  child.stdout.write(bytes.subarray(0, split)); assert.equal(h.events.length, 0);
  child.stdout.write(bytes.subarray(split, split + 1)); assert.equal(h.events.length, 0);
  child.stdout.write(bytes.subarray(split + 1));
  assert.deepEqual(h.events, [{ type: "log", message: "正在导出：中文" }]);
  child.emit("exit", 0, null); assert.equal(h.runner.isRunning(), true);
  child.emit("close", 0, null);
  assert.equal(h.runner.isRunning(), false);
  assert.deepEqual(h.events[1], { type: "complete", result: { status: "complete", sourceName: "中文" } });
});

test("busy rejects duplicate starts until close, and old duplicate close cannot release a new job", () => {
  const h = host(); h.start(); const first = h.children[0];
  assert.throws(() => h.start(), /正在运行/); assert.equal(h.calls.length, 1);
  first.emit("error", new Error("spawn failure")); assert.equal(h.runner.isRunning(), true);
  assert.equal(h.events.length, 0); assert.throws(() => h.start(), /正在运行/);
  first.emit("close", -2, null); assert.equal(h.runner.isRunning(), false);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, "error");
  h.start(); assert.equal(h.runner.isRunning(), true);
  first.emit("close", -2, null); assert.equal(h.runner.isRunning(), true); assert.equal(h.events.length, 1);
  line(h.children[1], { type: "complete", result: { status: "complete" } }); h.children[1].emit("close", 0, null);
  assert.equal(h.runner.isRunning(), false);
});

test("nonzero exit overrides pending success and includes only bounded stderr tail", () => {
  const h = host(); h.start(); const child = h.children[0];
  line(child, { type: "complete", result: { status: "complete" } });
  child.stderr.write(Buffer.from("DISCARDED-HEADER" + "x".repeat(10000) + "最终错误"));
  child.emit("close", 7, null); child.emit("close", 7, null);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, "error");
  assert.match(h.events[0].message, /退出码 7/); assert.match(h.events[0].message, /最终错误/);
  assert.equal(h.events[0].message.includes("DISCARDED-HEADER"), false);
  assert.ok(h.events[0].message.length < 8100);
});

test("missing, malformed or duplicate final events never become success", () => {
  for (const kind of ["missing", "invalid-json", "duplicate", "bad-result"]) {
    const h = host(); h.start(); const child = h.children[0];
    if (kind === "invalid-json") { child.stdout.write("SYNTHETIC_SECRET-not-json\n"); line(child, { type: "complete", result: { status: "complete" } }); }
    if (kind === "duplicate") { line(child, { type: "complete", result: { status: "complete" } }); line(child, { type: "error", message: "late error" }); }
    if (kind === "bad-result") line(child, { type: "complete", result: { status: "running" } });
    child.emit("close", 0, null);
    assert.equal(h.events.length, 1, kind); assert.equal(h.events[0].type, "error", kind);
    assert.equal(h.events[0].message.includes("SYNTHETIC_SECRET"), false);
    assert.equal(h.runner.isRunning(), false);
  }
});

test("explicit worker errors are final once while partial/failed results preserve their status", () => {
  const h = host(); h.start(); line(h.children[0], { type: "error", message: "正文不完整" });
  h.children[0].emit("close", 0, null); assert.deepEqual(h.events, [{ type: "error", message: "正文不完整" }]);
  for (const status of ["partial", "failed"]) {
    h.start(); const child = h.children.at(-1); line(child, { type: "complete", result: { status, verifiedCount: 0 } });
    child.emit("close", 0, null); assert.deepEqual(h.events.at(-1), { type: "complete", result: { status, verifiedCount: 0 } });
  }
});

test("worker error messages survive a nonzero exit instead of being replaced by a generic code", () => {
  const h = host(); h.start(); line(h.children[0], { type: "error", message: "源文件正文不完整" });
  h.children[0].emit("close", 1, null);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, "error");
  assert.match(h.events[0].message, /正文不完整/); assert.match(h.events[0].message, /退出码 1/);
});

test("invalid request types and missing output directories do not spawn", () => {
  const h = host(); const file = path.join(h.outputDir, "not-directory.txt"); fs.writeFileSync(file, "fixture");
  for (const input of [null, {}, { links: [] }, { links: " " }, { links: "valid", outputDir: null },
    { links: "valid", outputDir: " " }, { links: "valid", outputDir: file },
    { links: "valid", outputDir: path.join(h.outputDir, "missing") }]) {
    assert.throws(() => h.runner.start(input)); assert.equal(h.runner.isRunning(), false);
  }
  assert.equal(h.calls.length, 0);
});

test("synchronous launch failure restores idle state without duplicate terminal event", () => {
  const events = [];
  const runner = createJobRunner({ repoRoot, python: process.execPath, node: process.execPath, onEvent: event => events.push(event), spawn() { throw new Error("spawn denied"); } });
  assert.throws(() => runner.start({ links: "valid", outputDir: os.tmpdir() }), /spawn denied/);
  assert.equal(runner.isRunning(), false); assert.deepEqual(events, []);
});

test("real worker rejects invalid JSON and an unrelated URL without reading a design", () => {
  const python = spawnSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", windowsHide: true });
  assert.equal(python.status, 0, python.stderr);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-real-worker-invalid-"));
  for (const input of ["not JSON", JSON.stringify({ links: "https://example.com/file/123", outputDir }), JSON.stringify({ links: [], outputDir })]) {
    const result = spawnSync(python.stdout.trim(), ["-X", "utf8", "-u", path.join(repoRoot, "tools/desktop_bridge_worker.py")],
      { input, encoding: "utf8", cwd: os.tmpdir(), windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(events.length, 1); assert.equal(events[0].type, "error"); assert.ok(events[0].message);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  }
});

test("actual runner waits for real worker failure close and returns to idle", async () => {
  const python = spawnSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", windowsHide: true });
  assert.equal(python.status, 0, python.stderr);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-real-runner-invalid-"));
  const events = [];
  let resolveFinal;
  const completed = new Promise(resolve => { resolveFinal = resolve; });
  const runner = createJobRunner({ repoRoot, python: python.stdout.trim(), node: process.execPath,
    onEvent(event) { events.push(event); if (event.type !== "log") resolveFinal(); } });
  runner.start({ links: "https://example.com/file/123", outputDir });
  assert.equal(runner.isRunning(), true);
  const timeout = setTimeout(() => resolveFinal(), 5000);
  await completed; clearTimeout(timeout);
  assert.equal(runner.isRunning(), false); assert.equal(events.length, 1); assert.equal(events[0].type, "error");
  assert.match(events[0].message, /链接无效/);
  assert.equal(events.some(event => event.type === "complete"), false); assert.deepEqual(fs.readdirSync(outputDir), []);
});
