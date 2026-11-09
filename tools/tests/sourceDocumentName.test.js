const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../SendToFigma/node_modules/esbuild");

const bundled = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../../SendToFigma/src/transferStream.ts")],
  bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent"
}).outputFiles[0].text;

function manifestFor(document) {
  const module = { exports: {} };
  new Function("module", "exports", "require", "mg", bundled)(module, module.exports, require, { documentId: 123, document });
  return module.exports.createBaseExportManifest({ scope: "all-pages" }, 1);
}

test("MasterGo exports the documented file title, independently of current page name", () => {
  const manifest = manifestFor({ name: "菜单", currentPage: { name: "页面 1" } });
  assert.equal(manifest.documentName, "菜单");
  assert.equal(manifest.documentId, 123);
});

test("missing, empty or unreadable MasterGo file titles are omitted without guessing a page title", () => {
  for (const document of [{ currentPage: { name: "页面 1" } }, { name: "  " },
    { get name() { throw new Error("not available"); }, currentPage: { name: "页面 1" } }]) {
    assert.equal(Object.hasOwn(manifestFor(document), "documentName"), false);
  }
});
