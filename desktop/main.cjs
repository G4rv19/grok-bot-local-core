'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, protocol, session } = electron;
const { createHost } = require('./host.cjs');

const smoke = process.argv.includes('--smoke-test');
const demo = smoke || process.argv.includes('--demo');
const origin = 'app://desktop';
const page = origin + '/index.html';
const assets = new Set(['/index.html', '/renderer.js', '/style.css']);
let window;
let host;
let smokeDirectory;

app.setName('Grok Bot Local');
if (demo) {
  smokeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-desktop-demo-'));
  app.setPath('userData', smokeDirectory);
} else {
  const dataDirectory = path.join(app.getPath('appData'), 'Grok Bot Local Open Source');
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', dataDirectory);
}
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

async function launch() {
  protocol.handle('app', request => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.host !== 'desktop' || !assets.has(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(__dirname, url.pathname)).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  host = await createHost({
    dataDir: app.getPath('userData'),
    electron,
    demo,
    selectFiles: smoke ? async () => {
      const fixture = path.join(smokeDirectory, 'verification.txt');
      fs.writeFileSync(fixture, 'Desktop attachment fixture');
      return [fixture];
    } : async () => (await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach files',
    })).filePaths,
    publish(type, detail) {
      if (window && !window.isDestroyed()) window.webContents.send('desktop:changed', { type, detail: type === 'error' ? detail : undefined });
    },
    async approve(detail) {
      if (!window?.isVisible()) return false;
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Approve local action',
        message: 'Allow this action?',
        detail,
        buttons: ['Cancel', 'Allow once'],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
  });
  ipcMain.handle('desktop:invoke', (event, action, payload) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== page) {
      throw new Error('Untrusted desktop request');
    }
    return host.invoke(action, payload);
  });
  const events = {
    'lock-screen': { locked: true },
    'unlock-screen': { locked: false },
    suspend: { suspended: true },
    resume: { suspended: false },
  };
  for (const [event, state] of Object.entries(events)) powerMonitor.on(event, () => host.power(state));
  host.power({ locked: powerMonitor.getSystemIdleState(1) === 'locked' });
  window = new BrowserWindow({
    width: 1240,
    height: 825,
    minWidth: 730,
    minHeight: 550,
    show: !smoke,
    backgroundColor: '#f6f3ec',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadURL(page);
  if (smoke) {
    await require('./smoke.cjs').verify(window.webContents);
    app.quit();
  }
}

if (!demo && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('activate', () => window?.show());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => host?.close());
  app.on('quit', () => {
    if (smokeDirectory) fs.rmSync(smokeDirectory, { recursive: true, force: true });
  });
  app.whenReady().then(launch).catch(error => {
    console.error(error);
    app.exit(1);
  });
}
