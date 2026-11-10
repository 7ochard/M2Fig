const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Reuse the existing public session/chunk test host without registering its
// tests or modifying its owner's file. Extend only the mock's nested-instance
// behavior and allow a controlled event-loop yield for cancellation auditing.
const hostPath = path.join(__dirname, "dependencyPageImport.test.js");
let hostSource = fs.readFileSync(hostPath, "utf8").split("\ntest(")[0];
hostSource = hostSource.replace("clone.name = source.name;", `clone.name = source.name;
          if (source.type === "INSTANCE") {
            clone.mainComponent = source.mainComponent;
            clone.getMainComponentAsync = async () => clone.mainComponent;
            clone.swapComponent = target => { clone.mainComponent = target; };
          }`);
hostSource = hostSource.replace("callback => { callback(); return 0; }", "callback => options.deferYield ? options.deferYield(callback) : (callback(), 0)");
hostSource = hostSource.replace('getPluginData: () => "",', `clone() {
        const twin = makeNode(this.type);
        twin.name = this.name; twin.fills = this.fills; twin.strokes = this.strokes; twin.isMask = this.isMask;
        return twin;
      }, getPluginData: () => "",`);
const { createHost, record, page, start, transferPage, complete } = new Function("require", "__dirname", hostSource + "\nreturn { createHost, record, page, start, transferPage, complete };")(require, __dirname);

test("cross-page nested component work blocks cloning its owner until descendants are ready", async () => {
  const host = createHost();
  const outsideLeaf = record("outside-leaf", "FRAME", { parentId: "outside-inner", props: { type: "FRAME", name: "outside-leaf", scence: { visible: false } } });
  const records = [
    [record("outside", "INSTANCE", { mainComponentId: "A", childIds: ["outside-inner"] }),
      record("outside-inner", "INSTANCE", { parentId: "outside", mainComponentId: "B", childIds: ["outside-leaf"] }), outsideLeaf],
    [record("A", "COMPONENT", { childIds: ["A-inner"] }),
      record("A-inner", "INSTANCE", { parentId: "A", mainComponentId: "B", childIds: ["A-leaf"] }), record("A-leaf", "FRAME", { parentId: "A-inner" })],
    [record("B", "COMPONENT", { childIds: ["B-leaf"] }), record("B-leaf", "FRAME", { parentId: "B" })]
  ];
  const pages = records.map((items, index) => page(`Page ${index}`, items));
  await start(host, pages, { componentIds: ["A", "B"] });
  await transferPage(host, 0, pages[0], records[0]);
  await transferPage(host, 1, pages[1], records[1]);
  assert.equal(host.calls.createInstance, 0, "owner A is not ready while A-inner is deferred");
  await transferPage(host, 2, pages[2], records[2]);
  const result = await complete(host);
  const outside = host.figma.root.children[1].children[0];
  assert.equal(outside.type, "INSTANCE");
  assert.equal(outside.mainComponent.name, "A");
  assert.equal(outside.children[0].type, "INSTANCE");
  assert.equal(outside.children[0].mainComponent.name, "B");
  assert.equal(outside.children[0].children.length, 1);
  assert.equal(outside.children[0].children[0].visible, false, "deep positional override survives owner deferral");
  assert.equal(result.layerCount, 8);
  assert.equal(result.unresolvedInstanceCount, 0);
});

test("cyclic component promises terminate with one editable fallback instead of recursive clones", { timeout: 2000 }, async () => {
  const host = createHost();
  const records = [record("A", "COMPONENT", { childIds: ["A-inner"] }),
    record("A-inner", "INSTANCE", { parentId: "A", mainComponentId: "B", childIds: ["A-leaf"] }), record("A-leaf", "FRAME", { parentId: "A-inner" }),
    record("B", "COMPONENT", { childIds: ["B-inner"] }),
    record("B-inner", "INSTANCE", { parentId: "B", mainComponentId: "A", childIds: ["B-leaf"] }), record("B-leaf", "FRAME", { parentId: "B-inner" })];
  const design = page("Cycles", records);
  await start(host, [design], { componentIds: ["A", "B"] });
  await transferPage(host, 0, design, records);
  const result = await complete(host);
  assert.equal(result.layerCount, records.length);
  assert.equal(result.unresolvedInstanceCount, 1);
  const all = host.figma.currentPage.findAll(() => true);
  assert.ok(all.some(node => node.name === "A-leaf" || node.name === "B-leaf"));
  assert.ok(all.length < 20, "cycle handling must remain finite");
});

test("nested promised definitions that never arrive expand each deferred editable subtree once", async () => {
  const host = createHost();
  const records = [record("outer", "INSTANCE", { mainComponentId: "absent-A", childIds: ["inner"] }),
    record("inner", "INSTANCE", { parentId: "outer", mainComponentId: "absent-B", childIds: ["leaf"] }), record("leaf", "FRAME", { parentId: "inner" })];
  const design = page("Missing", records);
  await start(host, [design], { componentIds: ["absent-A", "absent-B"] });
  await transferPage(host, 0, design, records);
  assert.equal(host.calls.createFrame, 1);
  const result = await complete(host);
  assert.equal(host.calls.createFrame, 3);
  assert.equal(host.figma.currentPage.children[0].children[0].children[0].name, "leaf");
  assert.equal(result.unresolvedInstanceCount, 2);
});

test("stale import messages cannot roll back a different active session", async () => {
  const host = createHost();
  const design = page("New", [record("new-frame", "FRAME")]);
  await start(host, [design]);
  await host.send({ type: "import-page-start", transferId: "stale", pageIndex: 0, page: design });
  await transferPage(host, 0, design, [record("new-frame", "FRAME")]);
  const result = await complete(host);
  assert.ok(result, "the legitimate active session must survive a stale message");
  assert.equal(result.layerCount, 1);
});

test("an abort queued during a page restore isolates the next session and its metrics", async () => {
  let pause = true;
  const yields = [];
  const host = createHost({ deferYield(callback) { if (pause) yields.push(callback); else callback(); return 0; } });
  const oldRecords = Array.from({ length: 101 }, (_, index) => record(`old-${index}`, "FRAME"));
  const oldPage = page("Old", oldRecords);
  await start(host, [oldPage]);
  await host.send({ type: "import-page-start", pageIndex: 0, page: oldPage });
  await host.send({ type: "import-page-chunk", pageIndex: 0, records: oldRecords });
  const pending = host.send({ type: "import-page-end", pageIndex: 0 });
  for (let count = 0; !yields.length && count < 20; count++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(yields.length, "expected restore to yield before all old records finish");
  const aborted = host.send({ type: "import-session-abort" });
  await new Promise(resolve => setImmediate(resolve));
  const newPage = page("New", [record("new", "FRAME")]);
  const replacementStarted = start(host, [newPage], { transferId: "replacement" });
  pause = false;
  for (const resume of yields.splice(0)) resume();
  await pending;
  await aborted;
  await replacementStarted;
  for (const message of [{ type: "import-page-start", pageIndex: 0, page: newPage },
    { type: "import-page-chunk", pageIndex: 0, records: [record("new", "FRAME")] },
    { type: "import-page-end", pageIndex: 0 }, { type: "import-session-complete" }]) {
    await host.send({ ...message, transferId: "replacement" });
  }
  const result = host.messages.findLast(message => message.type === "complete" && message.transferId === "replacement");
  assert.ok(result, "a cancelled async continuation must not clear replacement import state");
  assert.equal(result.performanceReport.apiCreationCount, 2, "old work must not increment replacement session metrics");
  assert.equal(host.figma.currentPage.children[0].name, "new");
});

test("a mask materialized at finalize retains its explicit no-painted-fill flag", async () => {
  const host = createHost();
  const records = [record("outer", "INSTANCE", { mainComponentId: "absent", childIds: ["mask"] }),
    record("mask", "FRAME", { parentId: "outer", maskRendersFill: false,
      props: { type: "FRAME", name: "mask", blend: { isMask: true }, geometry: { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] } } })];
  const design = page("Late mask", records);
  await start(host, [design], { componentIds: ["absent"] });
  await transferPage(host, 0, design, records);
  const result = await complete(host);
  assert.ok(result);
  const children = host.figma.currentPage.children[0].children;
  assert.equal(children.length, 1, "suppressed mask must not acquire a visible painted twin");
  assert.equal(children[0].isMask, true);
});

test("a nested SPACE_BETWEEN frame materialized at finalize receives the single-child correction", async () => {
  const host = createHost();
  const records = [record("outer", "INSTANCE", { mainComponentId: "absent", childIds: ["auto"] }),
    record("auto", "FRAME", { parentId: "outer", childIds: ["leaf"],
      props: { type: "FRAME", name: "auto", layout: { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", width: 100, height: 100 } } }),
    record("leaf", "FRAME", { parentId: "auto" })];
  const design = page("Late layout", records);
  await start(host, [design], { componentIds: ["absent"] });
  await transferPage(host, 0, design, records);
  await complete(host);
  const auto = host.figma.currentPage.children[0].children[0];
  assert.equal(auto.children.length, 1);
  assert.equal(auto.primaryAxisAlignItems, "MIN");
});

for (const count of [1, 2]) test(`a deferred SPACE_BETWEEN root rechecks its layout after ${count} children arrive`, async () => {
  const host = createHost();
  const children = Array.from({ length: count }, (_, index) => `child-${index}`);
  const records = [record("outer", "INSTANCE", { mainComponentId: "absent", childIds: children,
    props: { type: "FRAME", sourceType: "INSTANCE", name: "outer", layout: { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", width: 100, height: 100 } } }),
  ...children.map(id => record(id, "FRAME", { parentId: "outer" }))];
  const design = page("Late root layout", records);
  await start(host, [design], { componentIds: ["absent"] });
  await transferPage(host, 0, design, records);
  await complete(host);
  const outer = host.figma.currentPage.children[0];
  assert.equal(outer.children.length, count);
  assert.equal(outer.primaryAxisAlignItems, count === 1 ? "MIN" : "SPACE_BETWEEN");
});
