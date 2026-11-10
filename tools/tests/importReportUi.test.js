const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");
const uiRequire = createRequire(path.resolve(__dirname, "../../ReceiveFromMasterGo/package.json"));
const React = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");

function loadUi(relative, stubEngine = false, overrides = {}) {
  const bundled = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "../../ReceiveFromMasterGo/ui-src", relative)],
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    external: ["react", "react/jsx-runtime", ...(stubEngine ? ["./engine"] : [])], logLevel: "silent"
  }).outputFiles[0].text;
  const module = { exports: {} };
  new Function("module", "exports", "require", "window", "requestAnimationFrame", bundled)(module, module.exports,
    name => name === "react" && overrides.react ? overrides.react :
      stubEngine && name === "./engine" ? overrides.engine || { initEngine() {} } : uiRequire(name),
    { setTimeout(callback) { callback(); } }, callback => callback());
  return module.exports;
}

const helpers = loadUi("importReport.ts");
const { ImportIdentity, ImportPerformance } = loadUi("components/import-summary.tsx");
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const target = { documentName: "Untitled", fileKey: "DEMOFIGMAFILEKEY" };

test("upload accepts one source and the actual App input cannot select multiple files", () => {
  assert.equal(helpers.singleSourceError(1), null);
  assert.match(helpers.singleSourceError(2), /一次仅导入一个源文件/);
  assert.match(helpers.singleSourceError(0), /请选择/);
  const { App } = loadUi("App.tsx", true);
  const html = render(App, {});
  const input = html.match(/<input\b[^>]*type="file"[^>]*>/)[0];
  assert.doesNotMatch(input, /\bmultiple(?:=|\s|>)/);
  assert.match(html, /一个源文件/);
});

test("dragging two sources into App shows the rejection and never calls the import engine", async () => {
  const slots = [];
  let cursor = 0, parsed = 0;
  const hookHost = { ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { return this.useState(() => ({ current: initial }))[0]; },
    useEffect() {}
  };
  const engine = { async parseFiles(files) { parsed++; return { fileNames: files.map(file => file.name), pages: [] }; } };
  const { App } = loadUi("App.tsx", true, { react: hookHost, engine });
  function dropSurface(element) {
    if (!element || typeof element !== "object") return null;
    if (element.props?.onDropFiles) return element;
    const children = element.props?.children;
    for (const child of Array.isArray(children) ? children.flat() : [children]) {
      const found = dropSurface(child);
      if (found) return found;
    }
    return null;
  }
  const before = dropSurface(App());
  assert.ok(before);
  before.props.onDropFiles([{ name: "示例设计.zip" }, { name: "示例活动.zip" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parsed, 0);
  cursor = 0;
  assert.match(dropSurface(App()).props.dropHint, /一次仅导入一个源文件/);
});

test("preview shows exact source title, actual target title/key and a naming mismatch", () => {
  const html = render(ImportIdentity, { sourceName: "示例设计", target });
  assert.match(html, /源文件名称/);
  assert.match(html, /示例设计/);
  assert.match(html, /Untitled/);
  assert.match(html, /DEMOFIGMAFILEKEY/);
  assert.match(html, /按源名称.*新建的目标文件/);
  const unknown = render(ImportIdentity, { sourceName: "示例设计", target: { documentName: null, fileKey: null } });
  assert.match(unknown, /未知/);
  assert.doesNotMatch(unknown, /新建的目标文件/);
  assert.equal(helpers.sourceDocumentName({ documentName: "原稿", fileNames: ["alias.zip"] }), "原稿");
  assert.equal(helpers.sourceDocumentName({ fileNames: ["示例设计.zip"] }), "示例设计");
});

test("results keep measured durations and source records distinct from API creations", () => {
  const report = { schemaVersion: 1, totalMs: 1250, preparationMs: 350, endToEndActiveMs: 1600,
    sourceRecordCount: 1000, apiCreationCount: 17, stagesMs: { "restore.nodesMs": 500 } };
  const html = render(ImportPerformance, { sourceName: "示例设计", target, report });
  assert.match(html, /导入耗时<\/dt><dd[^>]*>1\.25 秒/);
  assert.match(html, /文件准备<\/dt><dd[^>]*>0\.35 秒/);
  assert.match(html, /活动总耗时<\/dt><dd[^>]*>1\.60 秒/);
  assert.match(html, /源记录数<\/dt><dd[^>]*>1000/);
  assert.match(html, /API 创建次数<\/dt><dd[^>]*>17/);
  assert.match(html, /还原节点/);
  assert.match(html, /复制数值 JSON/);
  assert.match(html, /下载 JSON/);
  const rows = helpers.stageRows({ preparationClientTimings: { totalsMs: { "ui.zip.structurePreflightMs": 42 } },
    clientTimings: { totalsMs: { "ui.asset.readMs": 13 } } });
  assert.deepEqual(rows.map(row => row.label), ["文件准备 · 校验全部页面结构", "导入传输 · 读取并校验当前图片"]);
});

test("legacy completion without performance is honest and does not invent zero timings", () => {
  const html = render(ImportPerformance, { sourceName: "示例设计", target });
  assert.match(html, /未提供性能数据/);
  assert.doesNotMatch(html, /0\.00 秒|API 创建次数|复制数值 JSON/);
  assert.equal(helpers.formatDuration(undefined), "未提供");
  assert.equal(helpers.formatDuration(NaN), "未提供");
  assert.equal(helpers.formatDuration(-1), "未提供");
  assert.equal(helpers.formatDuration(0), "0.00 秒");
  assert.equal(helpers.formatCount(undefined), "未提供");
  assert.equal(helpers.formatCount(1.2), "未提供");
  assert.equal(helpers.formatCount(0), "0");
});

test("report JSON keeps numeric values, identity and raw counters without synthesizing missing fields", () => {
  const report = { schemaVersion: 1, totalMs: 1250.375, sourceRecordCount: 1000, apiCreationCount: 17,
    stagesMs: { "restore.nodesMs": 512.25 }, stageCounts: { "restore.nodesMs": 2 },
    restoreStats: { componentInstances: 1 }, clientTimings: { bytes: { input: 9000 } } };
  const parsed = JSON.parse(helpers.performanceReportJson("示例设计", target, report));
  assert.equal(parsed.sourceDocumentName, "示例设计");
  assert.deepEqual(parsed.target, target);
  assert.deepEqual(parsed.performanceReport, report);
  assert.equal(typeof parsed.performanceReport.totalMs, "number");
  assert.equal(parsed.performanceReport.endToEndActiveMs, undefined);
});
