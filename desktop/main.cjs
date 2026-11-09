const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createJobRunner } = require('./job-runner.cjs');

const APP_URL = 'bridge://app/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'bridge', privileges: { standard: true, secure: true } }]);
let window;
let runner;
let outputDir = '';

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
    throw new Error('无法读取本机运行配置。请在完整 M2Fig 目录运行 SetupM2Fig.cmd 后重试。');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.portable === true) {
    throw new Error('请先在完整 M2Fig 目录运行 SetupM2Fig.cmd，初始化本机 Python、Node.js 和插件路径。');
  }
  for (const key of ['repoRoot', 'python', 'node']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || !fs.existsSync(config[key])) {
      throw new Error(`运行文件缺失：${key}。请保留完整工程及本机运行时，运行 SetupM2Fig.cmd 更新本机配置。`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, 'pluginManifest')) {
    if (typeof config.pluginManifest !== 'string' || !path.isAbsolute(config.pluginManifest) || !fs.existsSync(config.pluginManifest)) {
      throw new Error('Figma 插件配置无效或文件缺失：pluginManifest。请运行 tools/packageBridgeR4.ps1 重新打包 M2Fig r4。');
    }
  } else {
    const manifests = ['dist/M2Fig-r4-local/manifest.json', 'dist/MasterGo-Figma-Bridge-r4-local/manifest.json'];
    config.pluginManifest = manifests.map((manifest) => path.join(config.repoRoot, manifest)).find((manifest) => fs.existsSync(manifest));
  }
  if (!config.pluginManifest) throw new Error('未找到 M2Fig r4 插件 manifest。请运行 tools/packageBridgeR4.ps1 重新打包。');
  let pluginManifest;
  try {
    pluginManifest = JSON.parse(fs.readFileSync(config.pluginManifest, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Figma 插件 manifest 无法读取。请运行 tools/packageBridgeR4.ps1 重新打包 M2Fig r4。');
  }
  if (pluginManifest?.id !== '2712095548761342') {
    throw new Error('Figma 插件不是 M2Fig r4。请将 pluginManifest 指向 dist/M2Fig-r4-local/manifest.json。');
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
  const allowedFiles = new Set(['index.html', 'styles.css', 'app.js', 'assets/m2fig-logo-24.svg', 'assets/details-marker.svg']);
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
    width: 1100, height: 573, minWidth: 920, minHeight: 573, useContentSize: true,
    title: 'M2Fig · 本地迁移工具', icon: path.join(__dirname, 'assets', 'm2fig.ico'), backgroundColor: '#141414', show: false,
    autoHideMenuBar: true, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#161616', symbolColor: '#cfcfcf', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  runner = createJobRunner({ ...config, onEvent: (event) => {
    if (!window.isDestroyed()) window.webContents.send('bridge:event', event);
  } });
  handle('context', () => ({ repoRoot: config.repoRoot, pluginManifest: config.pluginManifest, version: app.getVersion() }));
  handle('choose-directory', async () => {
    if (runner.isRunning()) throw new Error('导出进行中，请等待任务结束。');
    const result = await dialog.showOpenDialog(window, { title: '选择迁移 ZIP 保存目录', properties: ['openDirectory'] });
    if (result.canceled) return null;
    outputDir = result.filePaths[0];
    return outputDir;
  });
  handle('start', (request) => {
    if (!request || request.outputDir !== outputDir || !outputDir) throw new Error('请先选择保存目录。');
    return runner.start({ links: request.links, outputDir });
  });
  handle('open-output', async () => {
    if (!outputDir || !fs.existsSync(outputDir)) throw new Error('请先选择保存目录。');
    const error = await shell.openPath(outputDir);
    if (error) throw new Error(error);
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
