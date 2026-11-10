const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createJobRunner } = require('./job-runner.cjs');

const APP_URL = 'bridge://app/index.html';
const HANDOFF_PORT = 8765;
protocol.registerSchemesAsPrivileged([{ scheme: 'bridge', privileges: { standard: true, secure: true } }]);
let window;
let runner;
let outputDir = '';
let handoffServer = null;
const pendingHandoffTasks = [];

function registerHandoffResult(result) {
  if (!result || !Array.isArray(result.sources)) return;
  for (const src of result.sources) {
    if (src && src.status === 'verified' && src.zipPath && fs.existsSync(src.zipPath)) {
      pendingHandoffTasks.unshift({
        jobId: result.jobId,
        sourceId: String(src.sourceId),
        sourceName: src.sourceName || String(src.sourceId),
        zipPath: src.zipPath,
        fileName: path.basename(src.zipPath),
        bytes: src.bytes || fs.statSync(src.zipPath).size,
        sha256: src.sha256 || '',
        recordCount: src.recordCount || 0,
        designPageCount: src.designPageCount || 0,
        targetFileKey: src.targetFileKey || null,
        targetUrl: src.targetUrl || null,
        createdAt: new Date().toISOString(),
        imported: false,
      });
    }
  }
  if (pendingHandoffTasks.length > 20) pendingHandoffTasks.length = 20;
}

function ensureHandoffServer() {
  if (handoffServer) return;
  let http;
  try {
    http = require('node:http');
  } catch {
    return;
  }
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
  const sendJson = (res, status, body) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(payload.length) });
    res.end(payload);
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${HANDOFF_PORT}`);
    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      sendJson(res, 200, { ok: true, mode: 'm2fig-desktop', pendingCount: pendingHandoffTasks.filter((t) => !t.imported).length });
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/api/pending-import') {
      const fileKey = (reqUrl.searchParams.get('fileKey') || '').trim();
      const available = pendingHandoffTasks.filter((t) => !t.imported && fs.existsSync(t.zipPath));
      let matched = null;
      let autoStart = false;
      if (fileKey) {
        matched = available.find((t) => t.targetFileKey === fileKey) || null;
        if (matched) autoStart = true;
      }
      if (!matched && available.length > 0) {
        matched = available.find((t) => !t.targetFileKey) || available[0];
        if (matched && matched.targetFileKey && !fileKey) autoStart = true;
      }
      if (!matched) {
        sendJson(res, 200, { ok: true, pending: null });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        pending: {
          jobId: matched.jobId,
          sourceId: matched.sourceId,
          sourceName: matched.sourceName,
          fileName: matched.fileName,
          bytes: matched.bytes,
          sha256: matched.sha256,
          recordCount: matched.recordCount,
          designPageCount: matched.designPageCount,
          targetFileKey: matched.targetFileKey,
          targetUrl: matched.targetUrl,
          autoStart,
        },
      });
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/api/pending-import/package') {
      const jobId = reqUrl.searchParams.get('jobId') || '';
      const sourceId = reqUrl.searchParams.get('sourceId') || '';
      const task = pendingHandoffTasks.find((t) => t.jobId === jobId && t.sourceId === sourceId) || pendingHandoffTasks.find((t) => !t.imported);
      if (!task || !fs.existsSync(task.zipPath)) {
        sendJson(res, 404, { ok: false, error: '未找到待导入的 ZIP 包' });
        return;
      }
      const stat = fs.statSync(task.zipPath);
      const startParam = reqUrl.searchParams.get('start');
      const endParam = reqUrl.searchParams.get('end');
      if (startParam !== null && endParam !== null) {
        const start = Number(startParam);
        const end = Number(endParam);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > stat.size) {
          sendJson(res, 416, { ok: false, error: '无效的 ZIP 读取范围' });
          return;
        }
        const length = end - start;
        const buf = Buffer.allocUnsafe(length);
        const fd = fs.openSync(task.zipPath, 'r');
        try {
          let offset = 0;
          while (offset < length) {
            const read = fs.readSync(fd, buf, offset, length - offset, start + offset);
            if (read <= 0) break;
            offset += read;
          }
          res.writeHead(200, {
            ...corsHeaders,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(offset),
          });
          res.end(offset === length ? buf : buf.subarray(0, offset));
        } finally {
          fs.closeSync(fd);
        }
        return;
      }
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/zip',
        'Content-Length': String(stat.size),
        'X-M2Fig-File-Name': encodeURIComponent(task.fileName),
      });
      fs.createReadStream(task.zipPath).pipe(res);
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/api/pending-import/complete') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const task = pendingHandoffTasks.find((t) => t.jobId === body.jobId && t.sourceId === String(body.sourceId || ''));
          if (task) task.imported = true;
          if (window && !window.isDestroyed()) {
            window.webContents.send('bridge:event', {
              type: 'handoff-complete',
              sourceName: task?.sourceName || body.sourceName || '设计文件',
              pageCount: body.pageCount || 0,
              layerCount: body.layerCount || 0,
            });
          }
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' });
  });
  server.on('error', () => {
    handoffServer = null;
  });
  server.listen(HANDOFF_PORT, () => {
    handoffServer = server;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.whenReady().then(createWindow).catch((error) => {
    dialog.showErrorBox('无法启动迁移工具', error.message);
    app.quit();
  });
}

function runtime() {
  let configPath = app.isPackaged ? path.join(process.resourcesPath, 'bridge-runtime.json') : path.join(__dirname, 'bridge-runtime.json');
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    if ((portableDir !== undefined && !path.isAbsolute(portableDir)) || (portableFile !== undefined && !path.isAbsolute(portableFile))) {
      throw new Error('Portable 程序位置无效。请从完整 M2Fig 目录启动软件。');
    }
    const executableDir = portableDir || path.dirname(portableFile || process.execPath);
    const sidecar = path.join(executableDir, 'bridge-runtime.json');
    if (fs.existsSync(sidecar)) configPath = sidecar;
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('无法读取本机运行配置。请在完整 M2Fig 目录运行 SetupMg2Fig.cmd 后重试。');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.portable === true) {
    throw new Error('请先在完整 M2Fig 目录运行 SetupMg2Fig.cmd，初始化本机 Python、Node.js 和插件路径。');
  }
  for (const key of ['repoRoot', 'python', 'node']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || !fs.existsSync(config[key])) {
      throw new Error(`运行文件缺失：${key}。请保留完整工程及本机运行时，运行 SetupMg2Fig.cmd 更新本机配置。`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, 'pluginManifest')) {
    if (typeof config.pluginManifest !== 'string' || !path.isAbsolute(config.pluginManifest) || !fs.existsSync(config.pluginManifest)) {
      throw new Error('Figma 插件配置无效或文件缺失：pluginManifest。请运行 tools/packageMg2FigV3.ps1（或 tools/packageBridgeR4.ps1）重新打包 Mg2Fig V3。');
    }
  } else {
    const manifests = ['dist/Mg2Fig-v3-local/manifest.json', 'dist/M2Fig-r4-local/manifest.json', 'dist/MasterGo-Figma-Bridge-r4-local/manifest.json'];
    config.pluginManifest = manifests.map((manifest) => path.join(config.repoRoot, manifest)).find((manifest) => fs.existsSync(manifest));
  }
  if (!config.pluginManifest) throw new Error('未找到 Mg2Fig V3 / M2Fig r4 插件 manifest。请运行 tools/packageMg2FigV3.ps1（或 tools/packageBridgeR4.ps1）重新打包。');
  let pluginManifest;
  try {
    pluginManifest = JSON.parse(fs.readFileSync(config.pluginManifest, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Figma 插件 manifest 无法读取。请运行 tools/packageMg2FigV3.ps1（或 tools/packageBridgeR4.ps1）重新打包 Mg2Fig V3。');
  }
  if (pluginManifest?.id !== '2712095548761342') {
    throw new Error('Figma 插件不是 Mg2Fig V3（或 M2Fig r4）。请将 pluginManifest 指向 dist/Mg2Fig-v3-local/manifest.json。');
  }
  return config;
}

function handle(name, callback) {
  ipcMain.handle(`bridge:${name}`, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL) {
      throw new Error('无法识别的窗口请求。');
    }
    return callback(...args);
  });
}

async function createWindow() {
  const config = runtime();
  const allowedFiles = new Set(['index.html', 'styles.css', 'app.js', 'assets/mg2fig-logo-20.svg', 'assets/mg2fig-logo-24.svg', 'assets/info-button.svg', 'assets/details-marker.svg']);
  protocol.handle('bridge', (request) => {
    const url = new URL(request.url);
    const name = url.pathname.slice(1);
    if (url.hostname !== 'app' || !allowedFiles.has(name)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, 'renderer', name)).href);
  });
  nativeTheme.themeSource = 'dark';
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    width: 694, height: 707, minWidth: 694, minHeight: 680, useContentSize: true,
    title: 'Mg2Fig · 本地迁移工具', icon: path.join(__dirname, 'assets', 'mg2fig.ico'), backgroundColor: '#121212', show: false,
    autoHideMenuBar: true, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#121212', symbolColor: '#cfcfcf', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  runner = createJobRunner({ ...config, onEvent: (event) => {
    if (event?.type === 'complete' && event.result) {
      registerHandoffResult(event.result);
      ensureHandoffServer();
    }
    if (!window.isDestroyed()) window.webContents.send('bridge:event', event);
  } });
  ensureHandoffServer();
  handle('context', () => ({ repoRoot: config.repoRoot, pluginManifest: config.pluginManifest, version: app.getVersion() }));
  handle('choose-directory', async () => {
    if (runner.isRunning()) throw new Error('导出进行中，请等待任务结束。');
    const result = await dialog.showOpenDialog(window, { title: '选择迁移 ZIP 保存目录', properties: ['openDirectory'] });
    if (result.canceled) return null;
    outputDir = result.filePaths[0];
    return outputDir;
  });
  handle('use-default-directory', () => {
    if (runner.isRunning()) throw new Error('导出进行中，请等待任务结束。');
    const fallbackDir = path.join(config.repoRoot, 'artifacts', 'exports');
    fs.mkdirSync(fallbackDir, { recursive: true });
    outputDir = fallbackDir;
    return outputDir;
  });
  handle('start', (request) => {
    if (!request || request.outputDir !== outputDir || !outputDir) throw new Error('请先选择保存目录。');
    const startPayload = { links: request.links, outputDir };
    if (typeof request.figmaLinks === 'string' && request.figmaLinks.trim()) {
      startPayload.figmaLinks = request.figmaLinks.trim();
    }
    return runner.start(startPayload);
  });
  handle('open-output', async () => {
    if (!outputDir || !fs.existsSync(outputDir)) throw new Error('请先选择保存目录。');
    const error = await shell.openPath(outputDir);
    if (error) throw new Error(error);
  });
  handle('open-figma-target', async (rawUrl) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('无效的 Figma 链接。');
    const trimmed = rawUrl.trim();
    if (/^figma:\/\/file\/[A-Za-z0-9]{10,128}(?:\/.*)?$/i.test(trimmed)) {
      await shell.openExternal(trimmed);
      return true;
    }
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('无效的 Figma 链接。');
    }
    if (parsed.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(parsed.hostname)) {
      throw new Error('仅支持打开 Figma 链接。');
    }
    const match = parsed.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]{10,128})(\/.*)?$/);
    if (match) {
      const desktopUri = `figma://file/${match[1]}${match[2] || ''}${parsed.search || ''}`;
      await shell.openExternal(desktopUri);
      return true;
    }
    await shell.openExternal(parsed.href);
    return true;
  });
  handle('open-mastergo-target', async (rawUrl) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('无效的 MasterGo 链接。');
    const trimmed = rawUrl.trim();
    if (/^mastergo:\/\//i.test(trimmed)) {
      await shell.openExternal(trimmed);
      return true;
    }
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('无效的 MasterGo 链接。');
    }
    if (parsed.protocol !== 'https:' || !['mastergo.com', 'www.mastergo.com'].includes(parsed.hostname)) {
      throw new Error('仅支持打开 MasterGo 链接。');
    }
    const match = parsed.pathname.match(/^\/file\/(\d+)\/?$/);
    const desktopUri = match ? `mastergo://mastergo.com/file/${match[1]}` : `mastergo://mastergo.com${parsed.pathname}${parsed.search || ''}`;
    await shell.openExternal(desktopUri);
    return true;
  });
  handle('copy-plugin-path', () => clipboard.writeText(config.pluginManifest));
  window.on('close', (event) => {
    if (runner.isRunning()) {
      event.preventDefault();
      dialog.showMessageBox(window, { type: 'info', title: '导出进行中', message: '请等待当前导出结束后再关闭。', detail: '大文件可能需要较长时间，处理记录会持续更新。' });
    }
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(APP_URL);
}

app.on('window-all-closed', () => app.quit());
