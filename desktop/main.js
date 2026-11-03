'use strict';
/**
 * Sistemas VB Seguridad — App de escritorio para Windows (Electron).
 *  - Arranca el servidor puente (cámaras Dahua, cerradura, alertas) dentro de la app.
 *  - Abre el panel en modo kiosco opcional.
 *  - Expone a la página: minimizar, cerrar, kiosco, llamadas tel:, y relé por puerto serie (ESP32 por USB).
 */
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'svb') : path.join(__dirname, '..');
const KIOSK = process.argv.includes('--kiosk') || process.env.SVB_KIOSK === '1';
let win = null;
let serverApp = null;
let port = null;

async function startServer() {
  try {
    const { loadEnv, readConfig } = require(path.join(ROOT, 'server', 'lib', 'env.js'));
    const { createApp } = require(path.join(ROOT, 'server', 'server.js'));
    // .env junto al ejecutable (instalado) o en la raíz del repo (desarrollo)
    const envCandidates = [path.join(path.dirname(process.execPath), '.env'), path.join(app.getPath('userData'), '.env'), path.join(ROOT, '.env')];
    const envFile = envCandidates.find((f) => fs.existsSync(f)) || envCandidates[1];
    loadEnv(envFile);
    const cfg = readConfig();
    if (!cfg.dataDir) cfg.dataDir = path.join(app.getPath('userData'), 'data');
    serverApp = createApp(cfg, { envFile });
    await serverApp.start();
    return `http://127.0.0.1:${cfg.port}/`;
  } catch (e) {
    console.error('Servidor no iniciado:', e.message);
    return null;
  }
}

async function createWindow() {
  const url = process.env.SVB_URL || (await startServer());
  win = new BrowserWindow({
    width: 1366, height: 820, backgroundColor: '#000000', autoHideMenuBar: true,
    kiosk: KIOSK, fullscreen: KIOSK, title: 'Sistemas VB Seguridad',
    icon: path.join(ROOT, 'assets', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Cámara y micrófono sin preguntar (tótem / tablet de pared)
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'microphone', 'camera', 'fullscreen', 'notifications'].includes(perm)));
  if (url) await win.loadURL(url);
  else await win.loadFile(path.join(ROOT, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
}

// ── Relé por puerto serie (ESP32 conectado por USB) ──
async function serialRelay(ms) {
  let SerialPort;
  try { ({ SerialPort } = require('serialport')); } catch { throw new Error('Módulo serialport no instalado'); }
  if (!port || !port.isOpen) {
    const list = await SerialPort.list();
    const wanted = process.env.SVB_SERIAL_PORT;
    const info = wanted ? list.find((p) => p.path === wanted) : list.find((p) => /CP210|CH340|USB|Silicon|wch/i.test(`${p.manufacturer} ${p.friendlyName || ''}`));
    if (!info) throw new Error('No se encontró el ESP32 por USB');
    port = new SerialPort({ path: info.path, baudRate: 115200 });
    await new Promise((res, rej) => { port.once('open', res); port.once('error', rej); });
  }
  port.write(`OPEN ${Math.max(100, Math.min(10000, parseInt(ms, 10) || 3000))}\n`);
  return true;
}

ipcMain.handle('svb:minimize', () => win && win.minimize());
ipcMain.handle('svb:close', () => app.quit());
ipcMain.handle('svb:kiosk', () => { if (!win) return; const k = !win.isKiosk(); win.setKiosk(k); win.setFullScreen(k); return k; });
ipcMain.handle('svb:open', (_e, url) => { if (/^(tel:|https:\/\/wa\.me\/|https:\/\/maps\.google\.com)/.test(url)) shell.openExternal(url); });
ipcMain.handle('svb:relay', (_e, ms) => serialRelay(ms));
ipcMain.handle('svb:ports', async () => { try { const { SerialPort } = require('serialport'); return SerialPort.list(); } catch { return []; } });

app.whenReady().then(createWindow);
app.on('window-all-closed', async () => { if (serverApp) await serverApp.stop().catch(() => {}); app.quit(); });
app.setLoginItemSettings && process.env.SVB_AUTOSTART === '1' && app.setLoginItemSettings({ openAtLogin: true, args: ['--kiosk'] });
