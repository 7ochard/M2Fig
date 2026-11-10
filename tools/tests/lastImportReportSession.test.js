const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function host() {
  const source = fs.readFileSync(path.join(__dirname, "dependencyPageImport.test.js"), "utf8").split('test("')[0];
  return new Function("require", "__dirname", source + "\nreturn createHost();")(require, __dirname);
}
const summary = () => ({ schemaVersion: 1, sourceName: "Prior source", completedAt: "2026-11-05T08:00:00.000Z",
  target: { documentName: "Prior target", fileKey: "prior-key" },
  performanceReport: { schemaVersion: 1, receiverVersion: "test-r3", totalMs: 123, sourceRecordCount: 40,
    stagesMs: { "restore.nodesMs": 50 }, stageCounts: { "prepare.fontsLoaded": 2 } } });

test("saved report survives UI re-init while its previous target stays separate from the current target", async () => {
  const stored = new Map(), first = host();
  const storage = { getAsync: async key => stored.get(key), setAsync: async (key, value) => { stored.set(key, value); } };
  first.figma.clientStorage = storage;
  await first.send({ type: "save-import-report", report: summary() });
  assert.equal(stored.size, 1);
  const second = host(); second.figma.clientStorage = storage;
  await second.send({ type: "ui-ready" });
  const init = second.messages.findLast(message => message.type === "init");
  assert.deepEqual(init.lastImportReport, summary());
  assert.equal(init.targetDocumentName, "Target file");
  assert.equal(init.targetFileKey, "target-key");
  assert.notEqual(init.targetFileKey, init.lastImportReport.target.fileKey);
  assert.equal(second.messages.some(message => message.type === "complete"), false, "reading history must not restart an import");
});

test("storage failures and invalid saved values preserve successful imports and init still returns null history", async () => {
  const h = host();
  h.figma.clientStorage = { getAsync: async () => ({ schemaVersion: 99 }), setAsync: async () => { throw new Error("Storage unavailable"); } };
  await assert.doesNotReject(h.send({ type: "save-import-report", report: summary() }));
  await h.send({ type: "ui-ready" });
  assert.equal(h.messages.findLast(message => message.type === "init").lastImportReport, null);
  assert.equal(h.messages.some(message => message.type === "error" || message.success === false), false);
  h.figma.clientStorage.getAsync = async () => { throw new Error("Read unavailable"); };
  await h.send({ type: "ui-ready" });
  assert.equal(h.messages.findLast(message => message.type === "init").lastImportReport, null);
});
