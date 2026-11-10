const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { File } = require("node:buffer");
const { createRequire } = require("node:module");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const uiRequire = createRequire(path.resolve(__dirname, "../../ReceiveFromMasterGo/package.json"));
const React = uiRequire("react");

const bundle = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/ui-src/App.tsx")],
  bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
  external: ["react", "react/jsx-runtime", "./engine"], logLevel: "silent"
}).outputFiles[0].text;

function find(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

function host({ zipEnabled = true, pending = false } = {}) {
  const slots = [], calls = [];
  let cursor = 0, pickCalls = 0, clipboardReads = 0, resolveParse;
  const parsePromise = new Promise(resolve => { resolveParse = resolve; });
  const hookHost = { ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) {
        let value = typeof initial === "function" ? initial() : initial;
        if (value && typeof value === "object" && "zipEnabled" in value && "suppressStartupNotice" in value) {
          value = { ...value, zipEnabled, suppressStartupNotice: true };
        }
        slots[index] = value;
      }
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      return this.useState(() => ({ current: initial === null ? { click() { pickCalls++; } } : initial }))[0];
    },
    useEffect(effect, deps) {
      if (typeof effect === "function" && (!deps || deps.length === 0)) effect();
    }
  };
  const info = files => ({ fileNames: files.map(file => file.name), documentName: "Source", pageCount: 1,
    layerCount: 1, pages: [{ id: "page", name: "Page", displayName: "Page", layerCount: 1 }] });
  let initCallbacks = null;
  const engine = {
    async parseFiles(files) { calls.push(files); return pending ? parsePromise : info(files); },
    initEngine(callbacks) { initCallbacks = callbacks; }, resetPackage() {}, saveSettings() {}
  };
  const navigator = new Proxy({}, { get(_target, key) {
    if (key === "clipboard") { clipboardReads++; throw new Error("paste must not read navigator.clipboard"); }
    return undefined;
  } });
  const mod = { exports: {} };
  new Function("module", "exports", "require", "window", "requestAnimationFrame", "navigator", bundle)(
    mod, mod.exports, name => name === "react" ? hookHost : name === "./engine" ? engine : uiRequire(name),
    { setTimeout(callback) { callback(); } }, callback => callback(), navigator);
  const render = () => { cursor = 0; return mod.exports.App(); };
  const idle = tree => find(tree, element => typeof element.props?.onDropFiles === "function");
  const textarea = tree => {
    const component = idle(tree);
    return component && find(component.type(component.props), element => element.type === "textarea" && element.props["aria-label"] === "在此粘贴迁移文件");
  };
  return { calls, render, idle, textarea,
    get pickCalls() { return pickCalls; }, get clipboardReads() { return clipboardReads; },
    complete() { resolveParse(info(calls[0] || [])); },
    openNotice() {
      this.render();
      assert.ok(initCallbacks && initCallbacks.onInit, "App must register its init callback");
      initCallbacks.onInit({ settings: { zipEnabled: true, suppressStartupNotice: false },
        targetDocumentName: null, targetFileKey: null, lastImportReport: null });
      return this.render();
    }
  };
}

function event(files, text = "") {
  const list = { length: files.length, item(index) { return files[index] || null; } };
  for (let index = 0; index < files.length; index++) list[index] = files[index];
  const result = { prevented: 0, stopped: 0,
    clipboardData: { files: list, types: files.length ? ["Files"] : ["text/plain"], getData() { return text; } },
    preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
  return result;
}

function paste(host, tree, e) {
  const textarea = host.textarea(tree);
  assert.ok(textarea, "IdleView must provide the file-paste textarea");
  assert.equal(typeof textarea.props.onPaste, "function");
  textarea.props.onPaste(e);
  assert.equal(e.prevented, 1, "do not let the host canvas consume pasted data");
  assert.equal(e.stopped, 1, "do not bubble pasted files to the host canvas");
  return textarea.props.onPaste;
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const file = (name = "Source.zip") => new File(["synthetic design data"], name, { type: "application/zip" });

test("pasted single ZIP uses the existing engine with the original File and never opens the native picker", async () => {
  const app = host(), original = file();
  paste(app, app.render(), event([original]));
  await tick();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].length, 1);
  assert.equal(app.calls[0][0], original);
  assert.equal(app.pickCalls, 0);
  assert.equal(app.clipboardReads, 0);
});

test("pasting two files is rejected without merging or parsing either file", async () => {
  const app = host();
  paste(app, app.render(), event([file("A.zip"), file("B.zip")]));
  await tick();
  assert.equal(app.calls.length, 0);
  assert.match(app.idle(app.render()).props.dropHint, /一次.*一个源文件/);
});

test("path or text without a clipboard FileList gives an explicit hint and does not parse", async () => {
  for (const text of ["F:\\designs\\Source.zip", "普通文本"]) {
    const app = host(), e = event([], text);
    delete e.clipboardData.files;
    paste(app, app.render(), e);
    await tick();
    assert.equal(app.calls.length, 0);
    const hint = app.idle(app.render()).props.dropHint;
    assert.match(hint, /文件/);
    assert.match(hint, /路径|文本|复制|剪贴板/);
    assert.equal(app.clipboardReads, 0);
  }
});

test("paste preserves the laboratory ZIP gate", async () => {
  const app = host({ zipEnabled: false });
  paste(app, app.render(), event([file()]));
  await tick();
  assert.equal(app.calls.length, 0);
  assert.match(app.idle(app.render()).props.dropHint, /ZIP.*启用|启用.*ZIP/);
});

test("another paste while parsing is busy cannot restart parsing", async () => {
  const app = host({ pending: true });
  paste(app, app.render(), event([file("A.zip")]));
  await tick();
  assert.equal(app.calls.length, 1);
  const busy = app.render();
  assert.equal(app.idle(busy).props.parsing, true);
  paste(app, busy, event([file("B.zip")]));
  await tick();
  assert.equal(app.calls.length, 1);
  app.complete();
  await tick();
});

test("an open startup notice prevents a paste from starting parsing until dismissed", async () => {
  const app = host();
  const tree = app.openNotice();
  const notice = find(tree, element => element.props && typeof element.props.onDismiss === "function");
  assert.ok(notice, "the startup notice overlay must be open");
  const dismiss = notice && find(notice.type(notice.props), element => element.props && element.props.children === "知道了");
  assert.ok(dismiss, "the startup notice must render its dismiss button");
  paste(app, tree, event([file()]));
  await tick();
  assert.equal(app.calls.length, 0);
  dismiss.props.onClick();
  const idleTree = app.render();
  paste(app, idleTree, event([file()]));
  await tick();
  assert.equal(app.calls.length, 1, "dismissing the notice must allow parsing again");
});

test("after leaving idle, a late paste callback cannot parse a second source", async () => {
  const app = host();
  const callback = paste(app, app.render(), event([file("A.zip")]));
  await tick();
  assert.equal(app.textarea(app.render()), null);
  const late = event([file("B.zip")]);
  callback(late);
  assert.equal(late.prevented, 1);
  assert.equal(late.stopped, 1);
  await tick();
  assert.equal(app.calls.length, 1);
});
