// Real packaged Electron / preload / IPC / invalid worker checks, without exporting a design.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const audit = path.join(root, 'artifacts/m2fig-r4-20261109/electron-smoke');
const executable = path.join(root, 'dist/desktop-r4/win-unpacked/M2Fig.exe');
const result = { scope: 'packaged-electron-and-invalid-input-only', designExportStarted: false, screenshots: [], errors: [] };
fs.mkdirSync(audit, { recursive: true });
let app;
let page;

(async () => {
  app = await _electron.launch({ executablePath: executable, cwd: os.tmpdir(), env: { ...process.env, PATH: '' }, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => result.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') result.errors.push(message.text()); });
  await page.locator('#start-export:enabled').waitFor();
  assert.equal(await page.title(), 'M2Fig · 本地迁移工具');
  result.context = await page.evaluate(() => window.bridge.getContext());
  assert.equal(result.context.repoRoot, root);
  assert.ok(fs.existsSync(result.context.pluginManifest));
  assert.equal(await page.locator('#plugin-path').textContent(), result.context.pluginManifest);
  result.rendererIsolation = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
  assert.deepEqual(result.rendererIsolation, { require: 'undefined', process: 'undefined' });
  result.webPreferences = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.deepEqual(result.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });

  for (const [name, width, height] of [['default', 1100, 800], ['compact', 920, 680]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    const geometry = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      buttons: [...document.querySelectorAll('button')].map((button) => ({ text: button.textContent, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) }));
    assert.ok(geometry.document[0] <= geometry.viewport[0], `${name}: horizontal overflow`);
    assert.ok(geometry.buttons.every((button) => button.width > 0 && button.height >= 36), `${name}: clipped control`);
    await page.locator('#log-empty').scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollTo(0, 0));
    const filename = path.join(audit, `${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    result.screenshots.push({ name, filename, ...geometry });
  }

  await page.locator('#start-export').click();
  assert.match(await page.locator('#status').textContent(), /请先填写/);
  await page.locator('#links').fill('not a MasterGo link');
  await page.locator('#start-export').click();
  assert.match(await page.locator('#status').textContent(), /请先选择/);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-electron-smoke-'));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, output);
  await page.locator('#choose-directory').click();
  assert.equal(await page.locator('#output-dir').inputValue(), output);
  await page.locator('#start-export').click();
  await page.locator('#task-status[data-state="error"]').waitFor();
  await page.locator('#start-export:enabled').waitFor();
  result.invalidInputStatus = await page.locator('#status').textContent();
  assert.match(result.invalidInputStatus, /每行|链接/);
  assert.ok(!result.invalidInputStatus.includes('导出完成'));
  assert.deepEqual(fs.readdirSync(output), []);
  assert.ok(await page.locator('#progress').isHidden());
  await assert.rejects(page.evaluate(() => window.bridge.startExport({ links: 'https://mastergo.com/file/123', outputDir: 'C:/wrong-folder' })), /选择保存目录/);

  const previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await page.locator('#copy-plugin').click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), result.context.pluginManifest);
  } finally {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard);
  }
  const literal = '<img src=x onerror="window.injected=true">';
  await app.evaluate(({ BrowserWindow }, message) => BrowserWindow.getAllWindows()[0].webContents.send('bridge:event', { type: 'log', message }), literal);
  await page.waitForFunction((message) => document.getElementById('log').textContent.includes(message), literal);
  assert.equal(await page.locator('#log img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  for (const [status, verifiedCount, total, state] of [['failed', 0, 2, 'error'], ['partial', 1, 2, 'partial'], ['complete', 2, 2, 'success']]) {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('bridge:event', { type: 'complete', result: value }), { status, verifiedCount, sources: Array(total).fill({}) });
    await page.locator(`#task-status[data-state="${state}"]`).waitFor();
    assert.match(await page.locator('#status').textContent(), new RegExp(`${verifiedCount}/${total}`));
  }
  result.syntheticTerminalStates = ['failed', 'partial', 'complete'];
  assert.deepEqual(result.errors, []);
  result.ok = true;
})().catch(async (error) => {
  result.ok = false; result.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) {
    result.failureContent = await page.locator('body').innerText().catch(() => 'unavailable');
    result.failureContext = await page.evaluate(async () => {
      try { return { bridge: typeof window.bridge, context: await window.bridge?.getContext() }; }
      catch (error) { return { bridge: typeof window.bridge, error: error.message }; }
    }).catch(() => 'unavailable');
    await page.screenshot({ path: path.join(audit, 'failure.png'), fullPage: true }).catch(() => {});
  }
}).finally(async () => {
  if (app) await app.close();
  result.recordedAt = new Date().toISOString();
  fs.writeFileSync(path.join(audit, 'electron-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, report: path.join(audit, 'electron-smoke.json'), error: result.error }));
});
