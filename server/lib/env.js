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
    wizardAuto: env.WIZARD_AUTO === '1', // 0 = instalaciones ya hechas: el asistente no se abre solo (sigue disponible a mano)
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
      lastHost: env.CAM_LAST_HOST || '',
      playbackTemplate: env.CAM_PLAYBACK_TEMPLATE || '',
      events: env.CAM_EVENTS !== '0',
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
    dvrCooldown: int('DVR_ALERT_COOLDOWN', 60),
    doorbell: {
      enabled: env.DOORBELL !== '0',
      topic: env.DOORBELL_TOPIC || '',
      ntfy: (env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, ''),
      page: env.DOORBELL_PAGE || 'https://raveholding.github.io/SeguridadRave/timbre.html',
      camera: int('DOORBELL_CAMERA', 1),
      cooldown: int('DOORBELL_COOLDOWN', 15),
      whatsapp: env.DOORBELL_WHATSAPP || '',
    },
    telegramPoll: env.TELEGRAM_POLL !== '0',
    whatsapp: {
      to: env.WHATSAPP_TO || '',
      events: env.WHATSAPP_EVENTS || 'importantes',
      api: (env.CALLMEBOT_API || 'https://api.callmebot.com').replace(/\/$/, ''),
    },
    push: { enabled: env.PUSH_ENABLED !== '0', topic: env.PUSH_TOPIC || '', events: env.PUSH_EVENTS || 'todo' },
    // ── Sistemas VB Seguridad: plataforma multi-sector ──
    sector: ['comercio', 'industria', 'campo', 'residencial'].includes(env.SECTOR) ? env.SECTOR : 'comercio',
    analytics: {
      minConf: Math.max(0.1, Math.min(0.95, int('ANALYTICS_MIN_CONF', 55) / 100)),
      ruralFilter: env.RURAL_FILTER === '1',
      persistN: Math.max(1, Math.min(5, int('ANALYTICS_PERSIST_N', 2))),
      persistS: Math.max(2, Math.min(120, int('ANALYTICS_PERSIST_S', 10))),
      speedLimit: int('SPEED_LIMIT', 20),
      crowdMin: int('CROWD_MIN', 8),
      plateAutoOpen: env.PLATE_AUTO_OPEN === '1',
    },
    occupancyMax: int('OCCUPANCY_MAX', 0),
    watchdog: env.STREAM_WATCHDOG !== '0',
    mqtt: {
      url: env.MQTT_URL || '', user: env.MQTT_USER || '', pass: env.MQTT_PASS || '',
      prefix: (env.MQTT_PREFIX || 'sistemasvb').replace(/[^\w/-]/g, '').replace(/\/+$/, '') || 'sistemasvb',
      haDiscovery: env.HA_DISCOVERY !== '0', frigateTopic: env.FRIGATE_TOPIC || '', allowOpen: env.MQTT_ALLOW_OPEN === '1',
    },
    webhooks: { urls: env.WEBHOOK_URLS || '', secret: env.WEBHOOK_SECRET || '', minLevel: env.WEBHOOK_MIN_LEVEL || 'INFO' },
    community: { topic: env.COMMUNITY_TOPIC || '', name: env.COMMUNITY_NAME || '' },
    secretsEncrypt: env.SECRETS_ENCRYPT === '1',
  };
}

module.exports = { loadEnv, readConfig };
