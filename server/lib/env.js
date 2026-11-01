'use strict';
const fs = require('fs');

/** Carga un archivo .env simple (KEY=VALUE) sin pisar variables ya definidas. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
  return true;
}

function readConfig(env = process.env) {
  const int = (k, d) => (env[k] !== undefined && env[k] !== '' ? parseInt(env[k], 10) : d);
  return {
    port: int('PORT', 8080),
    host: env.HOST || '0.0.0.0',
    businessName: env.BUSINESS_NAME || 'Almacén Rave',
    panelUser: env.PANEL_USER || '',
    panelPass: env.PANEL_PASS || '',
    adminPin: env.ADMIN_PIN || '1234',
    doorPin: env.DOOR_PIN || '2580',
    duressPin: env.DURESS_PIN || '9999',
    relayMs: int('RELAY_MS', 3000),
    esp32Url: (env.ESP32_URL || '').replace(/\/$/, ''),
    esp32Token: env.ESP32_TOKEN || '',
    cam: {
      host: env.CAM_HOST || 'auto',
      serial: env.CAM_SERIAL || '',
      user: env.CAM_USER || 'admin',
      pass: env.CAM_PASS || '',
      channels: int('CAM_CHANNELS', 4),
      names: (env.CAM_NAMES || 'Puerta,Mostrador,Depósito,Vereda').split(',').map((s) => s.trim()),
      rtspPort: int('CAM_RTSP_PORT', 554),
      httpPort: int('CAM_HTTP_PORT', 80),
      rtspTemplate: env.CAM_RTSP_TEMPLATE || '',
      scan: env.CAM_SCAN || '',
    },
    go2rtc: {
      bin: env.GO2RTC_BIN || '',
      api: env.GO2RTC_API || '127.0.0.1:1984',
      webrtcPort: int('GO2RTC_WEBRTC_PORT', 8555),
      disabled: env.GO2RTC_DISABLED === '1',
    },
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN || '',
      chatId: env.TELEGRAM_CHAT_ID || '',
      api: (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, ''),
    },
    dataDir: env.DATA_DIR || '',
  };
}

module.exports = { loadEnv, readConfig };
