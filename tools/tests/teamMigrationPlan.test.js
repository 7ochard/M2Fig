const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { planTeamMigration, resolveMigrationTarget } = require("../planTeamMigration.js");

const source = (id, name) => ({ id, name, url: `https://mastergo.com/file/${id}?page_id=M` });
const target = (fileKey, name) => ({ fileKey, name, url: `https://www.figma.com/design/${fileKey}/Untitled?node-id=0-1` });
const inventory = mastergo => ({ teamName: "示例品牌", mastergo });

test("source-only inventory plans a new Design file per source in source order", () => {
  const input = inventory([source("2", "菜单"), source("1", "封面")]);
  const plan = planTeamMigration(input);
  assert.equal(plan.teamName, "示例品牌");
  assert.equal(plan.scope, "whole-file");
  assert.deepEqual(plan.tasks.map(task => [task.source.id, task.target, task.scope, task.status]), [
    ["2", { mode: "create-new", fileName: "菜单", editorType: "design" }, "whole-file", "pending-source-zip"],
    ["1", { mode: "create-new", fileName: "封面", editorType: "design" }, "whole-file", "pending-source-zip"]
  ]);
});

test("different source IDs may have identical names and each gets a new target descriptor", () => {
  const plan = planTeamMigration(inventory([source("1", "菜单"), source("2", "菜单"), source("3", "Ａ　菜单")]));
  assert.deepEqual(plan.tasks.map(task => task.target.fileName), ["菜单", "菜单", "Ａ　菜单"]);
  assert.ok(plan.tasks.every(task => task.status === "pending-source-zip" && task.target.mode === "create-new"));
  assert.ok(plan.tasks.every(task => !("url" in task.target) && !("fileKey" in task.target)));
});

test("duplicate source IDs are rejected even when the names differ", () => {
  assert.throws(() => planTeamMigration(inventory([source("1", "菜单"), source("1", "封面")])), /Duplicate MasterGo id/);
});

test("an explicit target URL is retained without requiring a matching file name", () => {
  const destination = target("DemoTargetKey", "Untitled");
  const task = planTeamMigration(inventory([{ ...source("1", "菜单"), target: destination.url }])).tasks[0];
  assert.deepEqual(task.target, { mode: "existing", editorType: "design", fileKey: destination.fileKey, url: destination.url });
  assert.equal(task.source.name, "菜单");
  assert.equal(task.status, "pending-source-zip");
});

test("source invitation links and Figma id aliases resolve only consistent IDs", () => {
  const input = inventory([{ id: "12345", name: "菜单", url: "https://mastergo.com/goto/ExampleInvite?page_id=M&file=12345",
    target: { id: "DemoTargetKey", name: "Untitled", url: "https://www.figma.com/design/DemoTargetKey/Untitled" } }]);
  const task = planTeamMigration(input).tasks[0];
  assert.equal(task.source.id, "12345");
  assert.equal(task.target.fileKey, "DemoTargetKey");
  assert.equal(task.target.name, "Untitled");
  assert.equal(task.status, "pending-source-zip");
  assert.throws(() => planTeamMigration(inventory([{ ...source("1", "菜单"), id: "2" }])), /id does not match/);
  assert.throws(() => planTeamMigration(inventory([{ ...source("1", "菜单"), target: { ...target("One", "Untitled"), fileKey: "Other" } }])), /fileKey does not match/);
  assert.throws(() => planTeamMigration(inventory([{ ...source("1", "菜单"), target: { ...target("One", "Untitled"), id: "Other" } }])), /id does not match/);
});

test("invalid hosts, credentials, protocols and ambiguous or missing URL IDs are rejected", () => {
  for (const url of ["https://mastergo.com.evil.test/file/1", "http://mastergo.com/file/1", "https://user@mastergo.com/file/1",
    "https://mastergo.com/goto/invite", "https://mastergo.com/goto/invite?file=1&file=2", "https://mastergo.com/file/1?file=2"]) {
    assert.throws(() => planTeamMigration(inventory([{ ...source("1", "菜单"), url }])));
  }
  for (const url of ["https://figma.com.evil.test/design/One/Untitled", "https://figma.com/board/One/Untitled", "https://figma.com/design/",
    "https://figma.com:8443/design/One/Untitled"]) {
    assert.throws(() => planTeamMigration(inventory([{ ...source("1", "菜单"), target: url }])));
  }
});

test("planning is deterministic and does not mutate or alias the input inventory", () => {
  const input = inventory([{ ...source("1", "菜单"), target: target("One", "Untitled") }, source("2", "封面")]);
  const original = structuredClone(input);
  Object.freeze(input.mastergo[0].target);
  for (const file of input.mastergo) Object.freeze(file);
  Object.freeze(input.mastergo); Object.freeze(input);
  const first = planTeamMigration(input);
  assert.deepEqual(first, planTeamMigration(input));
  first.tasks[0].source.name = "changed";
  first.tasks[0].target.name = "changed";
  assert.deepEqual(input, original);
  assert.deepEqual(planTeamMigration(inventory([])), { teamName: "示例品牌", scope: "whole-file", tasks: [] });
});

test("CLI accepts BOM inventory, writes a local plan once and refuses to overwrite", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-migration-plan-"));
  const input = path.join(directory, "inventory.json");
  const output = path.join(directory, "plan.json");
  const script = path.resolve(__dirname, "../planTeamMigration.js");
  const inputBytes = "\uFEFF" + JSON.stringify(inventory([source("1", "菜单")]));
  fs.writeFileSync(input, inputBytes);
  const first = spawnSync(process.execPath, [script, input, output], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const bytes = fs.readFileSync(output);
  assert.equal(JSON.parse(bytes).tasks[0].status, "pending-source-zip");
  assert.deepEqual(JSON.parse(bytes).tasks[0].target, { mode: "create-new", fileName: "菜单", editorType: "design" });
  const second = spawnSync(process.execPath, [script, input, output], { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal(fs.readFileSync(input, "utf8"), inputBytes);
});

test("only an observed empty wrong-title target gets a same-source-name replacement", () => {
  const existing = target("Old", "Untitled");
  const decision = resolveMigrationTarget("菜单", existing, { fileKey: "Old", fileName: "Untitled", isEmpty: true });
  assert.deepEqual(decision.target, { mode: "create-new", fileName: "菜单", editorType: "design" });
  assert.equal(decision.previousTarget.fileKey, "Old");
  assert.equal(decision.previousTarget.name, "Untitled");
  for (const observation of [undefined, { fileKey: "Old", fileName: "Untitled", isEmpty: false },
    { fileKey: "Old", fileName: "Untitled" }, { fileKey: "Old", fileName: null, isEmpty: true },
    { fileKey: "Old", fileName: "菜单", isEmpty: true }]) {
    assert.equal(resolveMigrationTarget("菜单", existing, observation).target.fileKey, "Old");
  }
  assert.throws(() => resolveMigrationTarget("菜单", existing, { fileKey: "Other", fileName: "Untitled", isEmpty: true }), /observation.*fileKey/i);
});

test("resume keeps the actual new target when inventory still references its preserved old target", () => {
  const prior = { teamName: "示例品牌", tasks: [{ source: source("1", "旧源名"), target: { ...target("New", "菜单"), fileName: "菜单" },
    previousTarget: target("Old", "Untitled"), status: "zip-ready", zipPath: "already-validated.zip" }] };
  const input = inventory([{ ...source("1", "菜单"), target: target("Old", "Untitled"),
    targetObservation: { fileKey: "Old", fileName: "Untitled", isEmpty: true } }]);
  const plan = planTeamMigration(input, prior);
  assert.equal(plan.tasks[0].target.fileKey, "New");
  assert.equal(plan.tasks[0].previousTarget.fileKey, "Old");
  assert.equal(plan.tasks[0].source.name, "菜单");
  assert.equal(plan.tasks[0].zipPath, "already-validated.zip");
  assert.equal(plan.tasks[0].status, "zip-ready");
  assert.equal(prior.tasks[0].source.name, "旧源名");
  assert.throws(() => planTeamMigration(inventory([{ ...source("1", "菜单"), target: target("Unrelated", "菜单") }]), prior), /conflict/i);
  assert.throws(() => planTeamMigration(input, { ...prior, teamName: "其他品牌" }), /teamName/);
});

test("explicit user confirmations skip resume even before API acceptance, without replacing its target", () => {
  for (const evidence of [{ userConfirmed: true }, { userReportedImportSuccess: true },
    { importCompleted: true, acceptanceEvidence: "用户确认导入成功" }, { importCompleted: true, userConfirmation: { method: "user" } }]) {
    const prior = { teamName: "示例品牌", tasks: [{ source: source("1", "菜单"), target: target("Real", "Untitled"),
      targetImportVerified: false, ...evidence }] };
    const plan = planTeamMigration(inventory([{ ...source("1", "菜单"), targetObservation: { fileKey: "Real", fileName: "Untitled", isEmpty: true } }]), prior);
    assert.equal(plan.tasks[0].status, "skipped-user-confirmed");
    assert.equal(plan.tasks[0].target.fileKey, "Real");
    assert.equal(plan.tasks[0].targetImportVerified, false);
    assert.equal(plan.tasks[0].importCompleted, true);
  }
  const noTarget = { teamName: "示例品牌", tasks: [{ source: source("1", "菜单"), userConfirmed: true }] };
  assert.throws(() => planTeamMigration(inventory([source("1", "菜单")]), noTarget), /confirmed.*target/i);
});

test("ordinary success text or missing confirmation evidence never marks an import as user-accepted", () => {
  for (const evidence of [{ status: "success" }, { status: "user-confirmed-success" }, { status: "skipped-user-confirmed" },
    { importCompleted: true }, { importCompleted: true, acceptanceEvidence: " " },
    { importCompleted: true, userConfirmation: {} }]) {
    const prior = { teamName: "示例品牌", tasks: [{ source: source("1", "菜单"), target: target("Real", "菜单"), ...evidence }] };
    const task = planTeamMigration(inventory([source("1", "菜单")]), prior).tasks[0];
    assert.notEqual(task.status, "skipped-user-confirmed");
    assert.equal(task.target.fileKey, "Real");
  }
});

test("CLI resume accepts BOM run data and reuses its real target without cloud actions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-migration-resume-"));
  const input = path.join(directory, "inventory.json"), previous = path.join(directory, "run.json"), output = path.join(directory, "plan.json");
  fs.writeFileSync(input, JSON.stringify(inventory([source("1", "菜单")])));
  fs.writeFileSync(previous, "\uFEFF" + JSON.stringify({ teamName: "示例品牌", tasks: [{ source: source("1", "菜单"), target: target("Real", "菜单"), userReportedImportSuccess: true, targetImportVerified: false }] }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../planTeamMigration.js"), input, output, "--resume", previous], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(fs.readFileSync(output, "utf8")).tasks[0];
  assert.equal(task.target.fileKey, "Real");
  assert.equal(task.status, "skipped-user-confirmed");
  assert.equal(task.targetImportVerified, false);
});
