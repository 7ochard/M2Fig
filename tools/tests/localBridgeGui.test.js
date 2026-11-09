const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("local GUI validates links, preserves outputs and runs the fixed export/inspection workflow", () => {
  const result = spawnSync("python", ["-B", path.join(__dirname, "local_bridge_gui_test.py")],
    { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 11 tests/);
});
