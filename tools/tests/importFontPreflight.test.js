const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("../../ReceiveFromMasterGo/node_modules/esbuild");

const root = path.resolve(__dirname, "../..");
function fontApi(figma) {
  const code = esbuild.buildSync({ stdin: { contents: [
    'export * from "./ReceiveFromMasterGo/src/importFontPreflight";',
    'export { state } from "./ReceiveFromMasterGo/src/state";',
    'export { loadFontCached } from "./ReceiveFromMasterGo/src/fontLoader";'
  ].join("\n"), resolveDir: root }, bundle: true, format: "cjs", write: false, logLevel: "silent" }).outputFiles[0].text;
  const module = { exports: {} };
  new Function("module", "exports", "figma", code)(module, module.exports, figma);
  return module.exports;
}

function pluginHost() {
  let source = fs.readFileSync(path.join(__dirname, "dependencyPageImport.test.js"), "utf8").split('test("')[0];
  source = source.replace("callback => { callback(); return 0; }", "(callback, ms) => setTimeout(callback, Math.min(ms || 0, 5))");
  return new Function("require", "__dirname", source + "\nreturn {createHost,record,page,start,transferPage,complete};")(require, __dirname);
}

test("new session requests warm fonts before any page or node creation; old messages keep the old path", async () => {
  const api = pluginHost(), h = api.createHost(), calls = [];
  h.figma.loadFontAsync = async font => { assert.equal(h.figma.root.children.length, 1); calls.push(font); };
  const p = api.page("Empty", []);
  await api.start(h, [p], { fontRequests: [{ family: "Inter", style: "Regular" }, { family: "Inter", style: "Regular" }] });
  assert.deepEqual(calls, [{ family: "Inter", style: "Regular" }]);
  assert.ok(h.messages.some(m => m.type === "progress" && m.stage === "fonts" && /Inter.*Regular/.test(m.operationLabel)));
  await api.transferPage(h, 0, p, []); const result = await api.complete(h);
  assert.equal(result.performanceReport.stageCounts["prepare.fontsLoaded"], 1);
  assert.equal(result.performanceReport.stageCounts["prepare.fontsFailed"], 0);
  assert.equal(result.performanceReport.stageCounts["prepare.fontsMissing"], 0);
  assert.ok(result.performanceReport.stagesMs["prepare.fontsMs"] >= 0);

  const legacy = api.createHost(), legacyCalls = [];
  legacy.figma.loadFontAsync = async font => legacyCalls.push(font);
  await api.start(legacy, [p]);
  assert.deepEqual(legacyCalls, []);
  assert.equal(legacy.messages.some(m => m.stage === "fonts"), false);
});

test("resolved fonts deduplicate aliases while uninstalled fonts retain the existing missing-font path", async () => {
  const calls = [], progress = [], available = { family: "Example Sans", style: "Regular" };
  const api = fontApi({ listAvailableFontsAsync: async () => [{ fontName: available }],
    loadFontAsync: async font => calls.push(font) });
  const result = await api.preflightImportFonts([
    { family: "Example Sans", style: "Regular" }, { family: "examplesans", style: "regular" },
    { family: "Not Installed", style: "Bold" }, { family: "Not Installed", style: "Bold" }
  ], (font, index, total) => progress.push({ font, index, total }), 100);
  assert.deepEqual(result, { loaded: 1, failed: 0, missing: 1 });
  assert.deepEqual(calls, [available]);
  assert.deepEqual(progress, [{ font: available, index: 1, total: 1 }]);
});

test("an immediate font rejection stays cached without making a run-font preflight fatal", async () => {
  let loads = 0;
  const bad = { family: "Broken Local Font", style: "Thin" };
  const api = fontApi({ listAvailableFontsAsync: async () => [{ fontName: bad }],
    loadFontAsync: async () => { loads++; throw new Error("Font cannot be loaded"); } });
  assert.deepEqual(await api.preflightImportFonts([bad], () => {}, 100), { loaded: 0, failed: 1, missing: 0 });
  await assert.rejects(api.loadFontCached(bad), /cannot be loaded/);
  assert.equal(loads, 1, "existing text callsites should see the original cached rejection");
});

test("an explicit Inter fallback request is checked even when the font catalog omits it", async () => {
  const calls = [], inter = { family: "Inter", style: "Regular" };
  const api = fontApi({ listAvailableFontsAsync: async () => [], loadFontAsync: async font => calls.push(font) });
  const result = await api.preflightImportFonts([inter, { family: "Not Installed", style: "Thin" }], () => {}, 100);
  assert.deepEqual(result, { loaded: 1, failed: 0, missing: 1 });
  assert.deepEqual(calls, [inter], "missing source fonts must not create additional substituted requests");
});

test("a hung font fails before pages exist; late rejection cannot contaminate a retried session", async () => {
  const api = pluginHost(), h = api.createHost(), p = api.page("Empty", []);
  let rejectOld;
  h.figma.loadFontAsync = () => new Promise((_, reject) => { rejectOld = reject; });
  const request = { fontRequests: [{ family: "Inter", style: "Regular" }] };
  await api.start(h, [p], request);
  const failure = h.messages.findLast(m => m.type === "import-ack");
  assert.equal(failure.success, false);
  assert.match(failure.error, /字体服务未响应.*字体辅助程序/);
  assert.equal(h.figma.root.children.length, 1, "font timeout must precede all imported pages");

  h.figma.loadFontAsync = async () => {};
  await api.start(h, [p], { ...request, transferId: "retry" });
  rejectOld(new Error("Old delayed font failure"));
  await new Promise(resolve => setImmediate(resolve));
  await h.send({ type: "import-page-start", transferId: "retry", pageIndex: 0, page: p });
  await h.send({ type: "import-page-chunk", transferId: "retry", pageIndex: 0, records: [] });
  await h.send({ type: "import-page-end", transferId: "retry", pageIndex: 0 });
  await h.send({ type: "import-session-complete", transferId: "retry" });
  const result = h.messages.findLast(m => m.type === "complete");
  assert.equal(result.performanceReport.restoreStats.fontLoadFailureCount, 0);
  assert.equal(result.performanceReport.stageCounts["prepare.fontsLoaded"], 1);
});

test("a hung non-fallback font degrades to a cached failure instead of aborting the whole import", async () => {
  const hungFont = { family: "HarmonyOS Sans SC", style: "Light" };
  let loads = 0;
  const api = fontApi({
    listAvailableFontsAsync: async () => [{ fontName: hungFont }],
    loadFontAsync: font => {
      loads++;
      if (font.family === "HarmonyOS Sans SC" && font.style === "Light") {
        return new Promise(() => {});
      }
      return Promise.resolve();
    }
  });
  const result = await api.preflightImportFonts([{ family: "Inter", style: "Regular" }, hungFont], () => {}, 25);
  assert.deepEqual(result, { loaded: 1, failed: 1, missing: 0 });
  await assert.rejects(api.loadFontCached(hungFont), /字体服务未响应/);
  assert.equal(loads, 2, "subsequent loadFontCached calls must hit the cached timeout failure immediately");
});
