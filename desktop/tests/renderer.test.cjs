"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rendererDir = path.resolve(__dirname, "../renderer");
const source = fs.readFileSync(path.join(rendererDir, "app.js"), "utf8");
const html = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../main.cjs"), "utf8");
const runtimeRoot = path.resolve(__dirname, "runtime-fixture");

function runtimeFor(overrides, manifests, manifestContents = {}, host = {}) {
  const config = {
    repoRoot: runtimeRoot,
    python: path.join(runtimeRoot, "python.exe"),
    node: path.join(runtimeRoot, "node.exe"),
    ...overrides,
  };
  const resourcesPath = path.join(runtimeRoot, "resources");
  const configPath = host.isPackaged ? path.join(resourcesPath, "bridge-runtime.json") : path.resolve(__dirname, "../bridge-runtime.json");
  const configFiles = { [configPath]: JSON.stringify(config), ...host.configFiles };
  const existing = new Set([config.repoRoot, config.python, config.node, ...manifests, ...Object.keys(configFiles)]);
  const modules = {
    electron: {
      app: { isPackaged: Boolean(host.isPackaged), requestSingleInstanceLock() { return false; }, quit() {}, on() {} },
      protocol: { registerSchemesAsPrivileged() {} },
    },
    "node:fs": {
      readFileSync(file) {
        if (Object.hasOwn(configFiles, file)) return configFiles[file];
        assert.ok(manifests.includes(file), `Unexpected manifest ${file}`);
        return manifestContents[file] ?? JSON.stringify({ id: "2712095548761342" });
      },
      existsSync(file) { return existing.has(file); },
    },
    "node:path": path,
    "node:url": require("node:url"),
    "./job-runner.cjs": {},
  };
  return vm.runInNewContext(`${mainSource}\nruntime();`, {
    __dirname: path.resolve(__dirname, ".."),
    process: { env: host.env || {}, execPath: host.execPath || path.join(runtimeRoot, "M2Fig.exe"), resourcesPath },
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected module ${name}`); return modules[name]; },
  });
}

test("M2Fig names the desktop while MasterGo remains the source product", () => {
  assert.match(html, /<title>M2Fig · 本地迁移工具<\/title>/);
  assert.match(html, /class="brand">[\s\S]*?<span>M2Fig<\/span>/);
  assert.match(html, /<label for="links">MasterGo 文件链接<\/label>/);
});

test("runtime prefers the M2Fig r4 package and supports the previous r4 package", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const previous = path.join(runtimeRoot, "dist/MasterGo-Figma-Bridge-r4-local/manifest.json");
  assert.equal(runtimeFor({}, [current, previous]).pluginManifest, current);
  assert.equal(runtimeFor({}, [previous]).pluginManifest, previous);
});

test("runtime honors an existing explicit manifest and rejects invalid overrides without fallback", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const explicit = path.join(runtimeRoot, "custom/manifest.json");
  assert.equal(runtimeFor({ pluginManifest: explicit }, [explicit, current]).pluginManifest, explicit);
  for (const pluginManifest of [null, "", "relative/manifest.json", explicit]) {
    assert.throws(() => runtimeFor({ pluginManifest }, [current]), /pluginManifest.*packageBridgeR4\.ps1/);
  }
});

test("runtime never silently selects the frozen r3 plugin or source template", () => {
  assert.throws(() => runtimeFor({}, [
    path.join(runtimeRoot, "dist/MasterGo-Figma-Bridge-local/manifest.json"),
    path.join(runtimeRoot, "ReceiveFromMasterGo/manifest.json"),
  ]), /未找到 M2Fig r4.*packageBridgeR4\.ps1/);
});

test("runtime rejects an explicit r3 or unreadable manifest even when a valid r4 package exists", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const explicit = path.join(runtimeRoot, "custom/manifest.json");
  assert.throws(() => runtimeFor({ pluginManifest: explicit }, [explicit, current], {
    [explicit]: JSON.stringify({ id: "1662512589841230294" }),
  }), /不是 M2Fig r4/);
  assert.throws(() => runtimeFor({ pluginManifest: explicit }, [explicit, current], {
    [explicit]: "invalid JSON",
  }), /manifest 无法读取.*packageBridgeR4\.ps1/);
});

test("packaged runtime prefers a sidecar beside the original portable executable", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const portableDir = path.join(runtimeRoot, "released app");
  const sidecar = path.join(portableDir, "bridge-runtime.json");
  const portableConfig = JSON.stringify({ repoRoot: runtimeRoot, python: path.join(runtimeRoot, "python.exe"), node: path.join(runtimeRoot, "node.exe"), pluginManifest: current, marker: "sidecar" });
  for (const env of [{ PORTABLE_EXECUTABLE_DIR: portableDir }, { PORTABLE_EXECUTABLE_FILE: path.join(portableDir, "M2Fig.exe") }]) {
    const result = runtimeFor({}, [current], {}, { isPackaged: true, env, configFiles: { [sidecar]: portableConfig } });
    assert.equal(result.marker, "sidecar");
    assert.equal(result.pluginManifest, current);
  }
});

test("packaged runtime uses the executable directory outside the portable launcher", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const sidecar = path.join(runtimeRoot, "bridge-runtime.json");
  const result = runtimeFor({}, [current], {}, { isPackaged: true, configFiles: { [sidecar]: JSON.stringify({ repoRoot: runtimeRoot, python: path.join(runtimeRoot, "python.exe"), node: path.join(runtimeRoot, "node.exe"), pluginManifest: current, marker: "exe sidecar" }) } });
  assert.equal(result.marker, "exe sidecar");
});

test("an invalid sidecar does not fall back to a valid embedded runtime", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const sidecar = path.join(runtimeRoot, "bridge-runtime.json");
  assert.throws(() => runtimeFor({}, [current], {}, { isPackaged: true, configFiles: { [sidecar]: "invalid JSON" } }), /SetupM2Fig\.cmd/);
  assert.throws(() => runtimeFor({}, [current], {}, { isPackaged: true, configFiles: { [sidecar]: JSON.stringify({ portable: true }) } }), /先.*SetupM2Fig\.cmd/);
  const r3 = path.join(runtimeRoot, "dist/MasterGo-Figma-Bridge-local/manifest.json");
  const wrongPluginConfig = { repoRoot: runtimeRoot, python: path.join(runtimeRoot, "python.exe"), node: path.join(runtimeRoot, "node.exe"), pluginManifest: r3 };
  assert.throws(() => runtimeFor({}, [current, r3], { [r3]: JSON.stringify({ id: "1662512589841230294" }) }, { isPackaged: true, configFiles: { [sidecar]: JSON.stringify(wrongPluginConfig) } }), /不是 M2Fig r4/);
});

test("a portable template requires local setup while a legacy embedded runtime still works", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  const embedded = path.join(runtimeRoot, "resources/bridge-runtime.json");
  assert.throws(() => runtimeFor({}, [current], {}, { isPackaged: true, configFiles: { [embedded]: JSON.stringify({ portable: true }) } }), /先.*SetupM2Fig\.cmd/);
  assert.equal(runtimeFor({}, [current], {}, { isPackaged: true }).pluginManifest, current);
});

test("portable executable locations must be absolute even when embedded configuration is valid", () => {
  const current = path.join(runtimeRoot, "dist/M2Fig-r4-local/manifest.json");
  for (const env of [{ PORTABLE_EXECUTABLE_DIR: "relative" }, { PORTABLE_EXECUTABLE_FILE: "M2Fig.exe" }]) {
    assert.throws(() => runtimeFor({}, [current], {}, { isPackaged: true, env }), /Portable 程序位置无效/);
  }
});

class Element {
  constructor(tag) {
    this.value = "";
    this.textContent = "";
    this.dataset = {};
    this.disabled = /\sdisabled(?:\s|>)/.test(tag);
    this.hidden = /\shidden(?:\s|>)/.test(tag);
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 100;
    this.handlers = {};
    this.attributes = {};
  }
  set innerHTML(value) { assert.fail("Backend content must never use an HTML sink"); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  focus() { this.focused = true; }
}

async function host(startExport = async () => ({ started: true })) {
  const elements = Object.fromEntries([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map(match => [match[1], new Element(match[0])]));
  const calls = [];
  let receiveEvent;
  const exposedBridge = {
    async getContext() { return { repoRoot: "/repo", pluginManifest: "/repo/dist/M2Fig-r4-local/manifest.json", version: "0.4.0" }; },
    async chooseDirectory() { return "/output"; },
    async startExport(input) { calls.push(input); return startExport(input); },
    async openOutput() {}, async copyPluginPath() {},
    onEvent(callback) { receiveEvent = callback; return () => {}; },
  };
  const context = vm.createContext({
    document: { getElementById(id) { assert.ok(elements[id], `Missing control ${id}`); return elements[id]; } },
    __exposedBridge: exposedBridge,
    addEventListener() {}, setTimeout() {},
  });
  vm.runInContext(`
    globalThis.window = globalThis;
    Object.defineProperty(globalThis, "bridge", { value: __exposedBridge, configurable: false, writable: false });
    delete globalThis.__exposedBridge;
  `, context);
  vm.runInContext(source, context, { filename: "renderer/app.js" });
  await new Promise(setImmediate);
  return {
    context, elements, calls,
    emit(event) { receiveEvent(event); },
    submit() { return elements["export-form"].handlers.submit({ preventDefault() {} }); },
    async prepare() {
      elements.links.value = "https://mastergo.com/file/123";
      await elements["choose-directory"].handlers.click();
    },
  };
}

test("real renderer initializes beside a restricted contextBridge global; old binding fails the negative control", async () => {
  const h = await host();
  assert.equal(vm.runInContext("window === globalThis", h.context), true);
  assert.equal(vm.runInContext("Object.getOwnPropertyDescriptor(globalThis, 'bridge').configurable", h.context), false);
  assert.equal(vm.runInContext("Object.getOwnPropertyDescriptor(globalThis, 'bridge').writable", h.context), false);
  assert.equal(h.elements["start-export"].disabled, false);
  assert.equal(h.elements["plugin-path"].textContent, "/repo/dist/M2Fig-r4-local/manifest.json");
  assert.throws(() => vm.runInContext("const bridge = window.bridge;", h.context), {
    name: "SyntaxError", message: /bridge/,
  });
});

test("missing links or output directory cannot start a job and focus the required input", async () => {
  const h = await host();
  h.elements.links.value = "  \n  ";
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.equal(h.elements.links.focused, true);
  assert.equal(h.elements.links.attributes["aria-invalid"], "true");
  h.elements.links.value = "https://mastergo.com/file/123";
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.equal(h.elements["choose-directory"].focused, true);
});

test("one pending submit locks editing and duplicate starts until a terminal event", async () => {
  let accept;
  const h = await host(() => new Promise(resolve => { accept = resolve; }));
  await h.prepare();
  const pending = h.submit();
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].links, "https://mastergo.com/file/123");
  assert.equal(h.calls[0].outputDir, "/output");
  assert.equal(h.elements.links.readOnly, true);
  assert.equal(h.elements["start-export"].disabled, true);
  assert.equal(h.elements["choose-directory"].disabled, true);
  assert.equal(h.elements.progress.hidden, false);
  accept({ started: true });
  await pending;
  assert.equal(h.elements["start-export"].disabled, true, "IPC acceptance is not completion");
  h.emit({ type: "error", message: "worker stopped" });
  assert.equal(h.elements["task-status"].dataset.state, "error");
  assert.equal(h.elements.links.readOnly, false);
  assert.equal(h.elements["start-export"].disabled, false);
  assert.equal(h.elements["choose-directory"].disabled, false);
  assert.equal(h.elements["open-output"].disabled, false);
  assert.equal(h.elements.progress.hidden, true);
});

test("complete, partial, failed and inconsistent counts retain honest terminal states", async () => {
  for (const [status, count, total, expected] of [
    ["complete", 2, 2, "success"], ["partial", 1, 2, "partial"],
    ["failed", 0, 2, "error"], ["complete", 1, 2, "partial"],
    ["complete", 0, 0, "partial"],
  ]) {
    const h = await host();
    await h.prepare();
    await h.submit();
    h.emit({ type: "complete", result: {
      status, verifiedCount: count, sources: Array.from({ length: total }, () => ({})), summaryPath: "/report.json",
    } });
    assert.equal(h.elements["task-status"].dataset.state, expected, `${status}: ${count}/${total}`);
    assert.equal(h.elements["start-export"].disabled, false);
    assert.equal(h.elements.links.readOnly, false);
    assert.equal(h.elements.progress.hidden, true);
    assert.equal(h.elements["open-output"].disabled, false);
    assert.ok(h.elements.log.textContent.includes("/report.json"));
  }
});

test("backend markup stays literal text and never reaches an HTML sink", async () => {
  // This checks the renderer's text sinks, not browser HTML parsing or Electron isolation.
  const h = await host();
  const payload = '<img src=x onerror="globalThis.injected=true"><script>globalThis.injected=true</script>';
  h.emit({ type: "log", message: payload });
  assert.equal(h.elements.log.textContent, payload);
  h.emit({ type: "error", message: payload });
  assert.equal(h.elements.status.textContent, payload);
  assert.equal(vm.runInContext("globalThis.injected", h.context), undefined);
});

test("logs retain recent output within both line and character limits", async () => {
  const h = await host();
  h.emit({ type: "log", message: Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n") });
  assert.ok(h.elements.log.textContent.split("\n").length <= 800);
  assert.ok(h.elements.log.textContent.endsWith("line-999"));
  assert.equal(h.elements.log.textContent.includes("line-0\n"), false);
  h.emit({ type: "log", message: "x".repeat(150000) + "LATEST-RESULT" });
  assert.ok(h.elements.log.textContent.length <= 100000);
  assert.ok(h.elements.log.textContent.endsWith("LATEST-RESULT"));
  assert.equal(h.elements["log-empty"].hidden, true);
});

test("IPC rejection clears busy state and allows a later accepted retry", async () => {
  let attempts = 0;
  const h = await host(async () => {
    if (attempts++ === 0) throw new Error("IPC denied");
    return { started: true };
  });
  await h.prepare();
  await h.submit();
  assert.equal(h.elements["task-status"].dataset.state, "error");
  assert.match(h.elements.status.textContent, /IPC denied/);
  assert.equal(h.elements["start-export"].disabled, false);
  assert.equal(h.elements.links.readOnly, false);
  await h.submit();
  assert.equal(h.calls.length, 2);
  assert.equal(h.elements["start-export"].disabled, true);
  h.emit({ type: "complete", result: { status: "complete", verifiedCount: 1, sources: [{}] } });
  assert.equal(h.elements["task-status"].dataset.state, "success");
});
