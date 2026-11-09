const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const uiRequire = createRequire(path.resolve(__dirname, "../../ReceiveFromMasterGo/package.json"));
const React = uiRequire("react"), { renderToStaticMarkup } = uiRequire("react-dom/server");
const bundle = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/ui-src/App.tsx")],
  bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
  external: ["react", "react/jsx-runtime", "./engine"], logLevel: "silent" }).outputFiles[0].text;

function find(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found; }
  return null;
}

function host() {
  const slots = [], effects = [], intervals = new Map(), copied = [];
  let cursor = 0, clock = 100000, callbacks, nextTimer = 0, starts = 0;
  const hooks = { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { return hooks.useState(() => ({ current: initial }))[0]; },
    useEffect(effect, deps) { const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects.push(() => {
        previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() };
      }); }
  };
  class ClockDate extends Date { static now() { return clock; } }
  const engine = { initEngine(value) { callbacks = value; }, saveSettings() {}, resetPackage() {},
    async parseFiles(files) { return { fileNames: files.map(file => file.name), documentName: "Current source", pageCount: 1,
      layerCount: 68638, pages: [{ id: "p", name: "Page", displayName: "Page", layerCount: 68638 }] }; },
    startImport() { starts++; return new Promise(() => {}); }
  };
  const win = { setTimeout(callback) { callback(); },
    setInterval(callback, ms) { assert.equal(ms, 1000); intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { intervals.delete(id); } };
  const module = { exports: {} };
  new Function("module", "exports", "require", "window", "requestAnimationFrame", "navigator", "Date", bundle)(module, module.exports,
    name => name === "react" ? hooks : name === "./engine" ? engine : uiRequire(name), win, callback => callback(),
    { clipboard: { writeText: async text => copied.push(text) } }, ClockDate);
  const render = () => { cursor = 0; const tree = module.exports.App(); for (const run of effects.splice(0)) run(); return tree; };
  render();
  callbacks.onInit({ settings: { zipEnabled: true, suppressStartupNotice: true }, targetDocumentName: "Current target", targetFileKey: "current-key" });
  return { render, copied, intervals, get callbacks() { return callbacks; }, get starts() { return starts; },
    advance(ms) { clock += ms; for (const callback of intervals.values()) callback(); },
    async importing() { find(render(), element => element.props?.onDropFiles).props.onDropFiles([{ name: "Source.zip" }]);
      await new Promise(resolve => setImmediate(resolve));
      find(render(), element => element.props?.onImport).props.onImport(); return render(); }
  };
}
const progressView = tree => find(tree, element => element.props?.progress && typeof element.type === "function");
const html = element => renderToStaticMarkup(React.createElement(element.type, element.props));
const history = tree => find(tree, element => element.props?.report?.completedAt && element.props.report?.sourceName);
const saved = () => ({ schemaVersion: 1, sourceName: "Original source", completedAt: "2026-11-05T08:00:00.000Z",
  target: { documentName: "Original target", fileKey: "original-key" },
  performanceReport: { schemaVersion: 1, totalMs: 123, preparationMs: 10, endToEndActiveMs: 133, sourceRecordCount: 68638, apiCreationCount: 20000 } });

test("font phase names its actual operation and a 1s clock reports waiting without moving progress or restarting", async () => {
  const h = host(); await h.importing();
  h.callbacks.onProgress({ percent: 0, stage: "fonts", layersDone: 0, layersTotal: 68638,
    operationLabel: "字体检查：HarmonyOS Sans SC · Thin（2/3）", pageName: "", lastUpdateAt: 100000 });
  let markup = html(progressView(h.render()));
  assert.match(markup, /字体检查/); assert.match(markup, /HarmonyOS Sans SC/); assert.match(markup, /Thin/); assert.match(markup, /字体服务/);
  assert.equal(h.intervals.size, 1); h.advance(14000);
  assert.doesNotMatch(html(progressView(h.render())), /未收到新进度/);
  h.advance(2000); const view = progressView(h.render()); markup = html(view);
  assert.match(markup, /16 秒未收到新进度/); assert.equal(view.props.progress.percent, 0); assert.equal(h.starts, 1);
  h.callbacks.onProgress({ percent: 55, stage: "postprocess", layersDone: 22499, layersTotal: 68638,
    pageName: "产品/护具", operationLabel: "恢复容器布局", lastUpdateAt: 116000 });
  markup = html(progressView(h.render()));
  assert.match(markup, /产品\/护具/); assert.match(markup, /布局后处理/); assert.match(markup, /22499\/68638/);
  assert.doesNotMatch(markup, /未收到新进度/);
  h.callbacks.onComplete({ pageCount: 1, layerCount: 68638, dependencyPageCount: 0, dependencyComponentCount: 0,
    unresolvedInstanceCount: 0, sourceWarningCount: 0, details: [] });
  h.render(); assert.equal(h.intervals.size, 0, "stop the clock after import leaves the progress view");
});

test("legacy progress fields still display the real layer count and stage", async () => {
  const h = host(); await h.importing();
  h.callbacks.onProgress({ percent: 55, stage: "restore", layersDone: 22499, layersTotal: 68638 });
  const markup = html(progressView(h.render()));
  assert.match(markup, /还原图层/); assert.match(markup, /22499\/68638/); assert.match(markup, /55/);
});

test("history keeps its own source and target and reuses the numeric report copy action", async () => {
  const h = host();
  h.callbacks.onInit({ settings: { zipEnabled: true, suppressStartupNotice: true }, targetDocumentName: "Current target",
    targetFileKey: "current-key", lastImportReport: saved() });
  const element = history(h.render()); assert.ok(element, "the saved report must be available from idle");
  const tree = element.type(element.props), markup = html(element);
  assert.match(markup, /上次迁移报告/); assert.match(markup, /Original source/); assert.match(markup, /Original target/);
  assert.match(markup, /original-key/); assert.doesNotMatch(markup, /Current target|current-key/);
  assert.match(markup, /2026/); assert.match(markup, /下载 JSON/);
  const performance = find(tree, node => node.props?.sourceName && node.props?.target && node.props?.report);
  const copy = find(performance.type(performance.props), node => node.props?.children === "复制数值 JSON");
  await copy.props.onClick();
  const json = JSON.parse(h.copied[0]); assert.equal(json.sourceDocumentName, "Original source");
  assert.equal(json.target.fileKey, "original-key"); assert.equal(h.starts, 0);
  assert.equal(typeof h.callbacks.onImportReport, "function");
  const newer = saved(); newer.sourceName = "Next source";
  h.callbacks.onImportReport(newer); assert.equal(history(h.render()).props.report.sourceName, "Next source");
  h.callbacks.onImportReport({ schemaVersion: 99 }); assert.equal(history(h.render()).props.report.sourceName, "Next source");
});

test("old or invalid init reports are ignored and the visible build marker identifies r4", () => {
  for (const lastImportReport of [undefined, null, { schemaVersion: 99 }, { ...saved(), target: {} }]) {
    const h = host(); h.callbacks.onInit({ settings: { suppressStartupNotice: true }, lastImportReport });
    const tree = h.render(); assert.equal(history(tree), null);
    const footer = find(tree, element => element.type === "footer");
    assert.match(renderToStaticMarkup(footer), /本地 r4/);
  }
});
