const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("../../SendToFigma/node_modules/esbuild");

const code = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../../SendToFigma/src/transferStream.ts")],
  bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent"
}).outputFiles[0].text;

function createApi() {
  const pages = [
    { id: "first", name: "封面", children: [] },
    { id: "process", name: "foo_Process", children: [] },
    { id: "last", name: "结束页", children: [] }
  ];
  const module = { exports: {} };
  new Function("module", "exports", "require", "mg", code)(module, module.exports, require,
    { document: { children: pages, currentPage: pages[1] } });
  return { api: module.exports, pages };
}

test("the page list preserves legitimate _Process page names and document order", () => {
  const { api } = createApi();
  assert.deepEqual(api.getDocumentPageSummaries().map(page => [page.id, page.name, page.isCurrent]), [
    ["first", "封面", false], ["process", "foo_Process", true], ["last", "结束页", false]
  ]);
});

test("whole-file export includes _Process pages and explicit selections retain source order", () => {
  const { api, pages } = createApi();
  assert.deepEqual(api.getExportTargets({ scope: "all-pages", pageIds: [] }).map(target => target.page), pages);
  assert.deepEqual(api.getExportTargets({ scope: "partial-pages", pageIds: ["last", "process"] })
    .map(target => [target.page.id, target.page.name]), [["process", "foo_Process"], ["last", "结束页"]]);
  assert.deepEqual(api.getExportTargets({ scope: "all-pages", pageIds: ["process"] })
    .map(target => target.page.id), ["process"]);
});
