#!/usr/bin/env node
'use strict';
/**
 * Descarga el binario oficial de go2rtc (github.com/AlexxIT/go2rtc, licencia MIT)
 * para el sistema operativo actual y lo deja en server/bin/.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = process.env.GO2RTC_VERSION || 'latest';
const base = VERSION === 'latest'
  ? 'https://github.com/AlexxIT/go2rtc/releases/latest/download/'
  : `https://github.com/AlexxIT/go2rtc/releases/download/${VERSION}/`;

const map = {
  'win32-x64': 'go2rtc_win64.zip',
  'win32-ia32': 'go2rtc_win32.zip',
  'win32-arm64': 'go2rtc_win_arm64.zip',
  'linux-x64': 'go2rtc_linux_amd64',
  'linux-arm64': 'go2rtc_linux_arm64',
  'linux-arm': 'go2rtc_linux_arm',
  'darwin-arm64': 'go2rtc_mac_arm64.zip',
  'darwin-x64': 'go2rtc_mac_amd64.zip',
};

(async () => {
  const key = `${process.platform}-${process.arch}`;
  const asset = map[key];
  if (!asset) { console.error(`Plataforma no soportada: ${key}. Descargá go2rtc a mano y definí GO2RTC_BIN.`); process.exit(1); }
  const binDir = path.join(__dirname, '..', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc');
  if (fs.existsSync(exe) && !process.argv.includes('--force')) { console.log(`go2rtc ya instalado: ${exe}`); return; }

  console.log(`Descargando ${asset} ...`);
  const r = await fetch(base + asset);
  if (!r.ok) { console.error(`Error HTTP ${r.status} al descargar ${asset}`); process.exit(1); }
  const buf = Buffer.from(await r.arrayBuffer());
  if (asset.endsWith('.zip')) {
    const zip = path.join(binDir, asset);
    fs.writeFileSync(zip, buf);
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zip}' -DestinationPath '${binDir}'`], { stdio: 'inherit' });
    } else {
      execFileSync('unzip', ['-o', zip, '-d', binDir], { stdio: 'inherit' });
    }
    fs.unlinkSync(zip);
  } else {
    fs.writeFileSync(exe, buf);
  }
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  console.log(`Listo: ${exe}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
