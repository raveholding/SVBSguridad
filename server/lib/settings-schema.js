'use strict';
/**
 * Esquema de TODA la configuración del servidor (lo que antes había que editar en .env).
 * El panel arma los formularios a partir de esta lista: agregar un campo aquí lo vuelve configurable.
 *
 * type: text | pin | secret | int | bool | url | names
 * apply: subsistema a reiniciar al cambiar (cam | doorbell | telegram)
 */
const GROUPS = [
  { id: 'negocio', title: 'Negocio', help: 'Nombre que aparece en alertas, en el portero y en el panel.' },
  { id: 'seguridad', title: 'PINs y acceso al panel', help: 'PINs de la puerta y del administrador. Usuario y contraseña opcionales para abrir el panel desde otros equipos de la red.' },
  { id: 'grabador', title: 'Grabador Dahua (DMSS)', help: 'Los mismos datos que muestra la app DMSS. Con "auto" el sistema encuentra la IP solo por el número de serie.' },
  { id: 'cerradura', title: 'Cerradura (ESP32)', help: 'Dirección del ESP32 en la red y su clave. Vacío = apertura simulada.' },
  { id: 'alertas', title: 'Avisos a los dueños: WhatsApp, notificación push y Telegram', help: 'Timbre, SOS, coacción, sabotaje y movimiento con el sistema armado.' },
  { id: 'portero', title: 'Portero digital QR / NFC', help: 'Timbre desde el celular del cliente.' },
];

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v) => v === true || v === '1' || v === 'true' || v === 1;

const FIELDS = [
  { key: 'BUSINESS_NAME', group: 'negocio', label: 'Nombre del negocio', type: 'text', max: 60, get: (c) => c.businessName, set: (c, v) => { c.businessName = v; }, apply: 'doorbell' },

  { key: 'DOOR_PIN', group: 'seguridad', label: 'PIN de puerta', type: 'pin', get: (c) => c.doorPin, set: (c, v) => { c.doorPin = v; } },
  { key: 'DURESS_PIN', group: 'seguridad', label: 'PIN de coacción (abre y avisa en silencio)', type: 'pin', get: (c) => c.duressPin, set: (c, v) => { c.duressPin = v; } },
  { key: 'ADMIN_PIN', group: 'seguridad', label: 'PIN de administración', type: 'pin', get: (c) => c.adminPin, set: (c, v) => { c.adminPin = v; } },
  { key: 'PANEL_USER', group: 'seguridad', label: 'Usuario para abrir el panel (vacío = sin contraseña)', type: 'text', clearable: true, max: 40, get: (c) => c.panelUser, set: (c, v) => { c.panelUser = v; } },
  { key: 'PANEL_PASS', group: 'seguridad', label: 'Contraseña para abrir el panel', type: 'secret', clearable: true, get: (c) => c.panelPass, set: (c, v) => { c.panelPass = v; } },

  { key: 'CAM_HOST', group: 'grabador', label: 'IP del grabador ("auto" = buscar sola)', type: 'text', max: 64, get: (c) => c.cam.host, set: (c, v) => { c.cam.host = v; }, apply: 'cam', validate: (v) => v === 'auto' || /^[\w.-]+$/.test(v) },
  { key: 'CAM_SERIAL', group: 'grabador', label: 'Número de serie (DMSS)', type: 'text', clearable: true, max: 40, get: (c) => c.cam.serial, set: (c, v) => { c.cam.serial = v; }, apply: 'cam', private: true },
  { key: 'CAM_USER', group: 'grabador', label: 'Usuario del grabador', type: 'text', max: 40, get: (c) => c.cam.user, set: (c, v) => { c.cam.user = v; }, apply: 'cam' },
  { key: 'CAM_PASS', group: 'grabador', label: 'Contraseña del grabador', type: 'secret', get: (c) => c.cam.pass, set: (c, v) => { c.cam.pass = v; }, apply: 'cam' },
  { key: 'CAM_CHANNELS', group: 'grabador', label: 'Cantidad de cámaras', type: 'int', min: 1, max: 16, get: (c) => c.cam.channels, set: (c, v) => { c.cam.channels = v; }, apply: 'cam' },
  { key: 'CAM_NAMES', group: 'grabador', label: 'Nombres de las cámaras', type: 'names', get: (c) => c.cam.names.join(','), set: (c, v) => { c.cam.names = v.split(',').map((x) => x.trim()); } },
  { key: 'CAM_EVENTS', group: 'grabador', label: 'Recibir eventos del grabador (movimiento, intrusión, sabotaje)', type: 'bool', get: (c) => c.cam.events !== false, set: (c, v) => { c.cam.events = v; }, apply: 'cam' },
  { key: 'DVR_ALERT_COOLDOWN', group: 'grabador', label: 'Segundos mínimos entre avisos de la misma cámara', type: 'int', min: 0, max: 3600, get: (c) => c.dvrCooldown, set: (c, v) => { c.dvrCooldown = v; } },
  { key: 'CAM_RTSP_PORT', group: 'grabador', label: 'Puerto RTSP', type: 'int', min: 1, max: 65535, advanced: true, get: (c) => c.cam.rtspPort, set: (c, v) => { c.cam.rtspPort = v; }, apply: 'cam' },
  { key: 'CAM_HTTP_PORT', group: 'grabador', label: 'Puerto HTTP', type: 'int', min: 1, max: 65535, advanced: true, get: (c) => c.cam.httpPort, set: (c, v) => { c.cam.httpPort = v; }, apply: 'cam' },

  { key: 'ESP32_URL', group: 'cerradura', label: 'Dirección del ESP32 (ej. http://192.168.100.60)', type: 'url', clearable: true, get: (c) => c.esp32Url, set: (c, v) => { c.esp32Url = v.replace(/\/$/, ''); } },
  { key: 'ESP32_TOKEN', group: 'cerradura', label: 'Clave del ESP32 (la misma que cargaste en el ESP32)', type: 'secret', clearable: true, get: (c) => c.esp32Token, set: (c, v) => { c.esp32Token = v; } },
  { key: 'RELAY_MS', group: 'cerradura', label: 'Tiempo de apertura (ms)', type: 'int', min: 100, max: 10000, get: (c) => c.relayMs, set: (c, v) => { c.relayMs = v; } },

  { key: 'WHATSAPP_TO', group: 'alertas', label: 'WhatsApp de los dueños', type: 'whatsapp', clearable: true, get: (c) => c.whatsapp.to, set: (c, v) => { c.whatsapp.to = v; } },
  { key: 'WHATSAPP_EVENTS', group: 'alertas', label: 'Qué avisos van por WhatsApp', type: 'select', options: [['importantes', 'Importantes: timbre, SOS, coacción, sabotaje, alarmas'], ['todo', 'Todo (incluye cada movimiento con sistema armado)'], ['timbre', 'Solo el timbre del portero']], get: (c) => c.whatsapp.events, set: (c, v) => { c.whatsapp.events = v; } },
  { key: 'PUSH_ENABLED', group: 'alertas', label: 'Notificación push al celular (app ntfy)', type: 'bool', get: (c) => c.push.enabled, set: (c, v) => { c.push.enabled = v; }, apply: 'push' },
  { key: 'PUSH_EVENTS', group: 'alertas', label: 'Qué avisos van como notificación push', type: 'select', options: [['todo', 'Todo'], ['importantes', 'Importantes'], ['timbre', 'Solo el timbre del portero']], get: (c) => c.push.events, set: (c, v) => { c.push.events = v; } },
  { key: 'CALLMEBOT_API', group: 'alertas', label: 'Servidor de WhatsApp (CallMeBot)', type: 'url', advanced: true, get: (c) => c.whatsapp.api, set: (c, v) => { c.whatsapp.api = v.replace(/\/$/, ''); } },
  { key: 'TELEGRAM_POLL', group: 'alertas', label: 'Botones y comandos de Telegram (/foto, /armar…)', type: 'bool', get: (c) => c.telegramPoll, set: (c, v) => { c.telegramPoll = v; }, apply: 'telegram' },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'alertas', label: 'Token del bot', type: 'secret', clearable: true, hidden: true, get: (c) => c.telegram.token, set: (c, v) => { c.telegram.token = v; }, apply: 'telegram' },
  { key: 'TELEGRAM_CHAT_ID', group: 'alertas', label: 'Chat', type: 'text', clearable: true, hidden: true, get: (c) => c.telegram.chatId, set: (c, v) => { c.telegram.chatId = v; }, apply: 'telegram' },

  { key: 'DOORBELL', group: 'portero', label: 'Portero digital activado', type: 'bool', get: (c) => c.doorbell.enabled, set: (c, v) => { c.doorbell.enabled = v; }, apply: 'doorbell' },
  { key: 'DOORBELL_CAMERA', group: 'portero', label: 'Cámara de la puerta (número de canal)', type: 'int', min: 1, max: 16, get: (c) => c.doorbell.camera, set: (c, v) => { c.doorbell.camera = v; } },
  { key: 'DOORBELL_WHATSAPP', group: 'portero', label: 'WhatsApp para que el cliente escriba (botón en la página del timbre, vacío = sin botón)', type: 'phone', clearable: true, get: (c) => c.doorbell.whatsapp, set: (c, v) => { c.doorbell.whatsapp = v; }, apply: 'doorbell' },
  { key: 'DOORBELL_COOLDOWN', group: 'portero', label: 'Segundos mínimos entre timbres', type: 'int', min: 0, max: 600, get: (c) => c.doorbell.cooldown, set: (c, v) => { c.doorbell.cooldown = v; } },
  { key: 'DOORBELL_PAGE', group: 'portero', label: 'Página pública del portero', type: 'url', advanced: true, get: (c) => c.doorbell.page, set: (c, v) => { c.doorbell.page = v; }, apply: 'doorbell' },
  { key: 'NTFY_URL', group: 'portero', label: 'Servidor de relevo (ntfy)', type: 'url', advanced: true, get: (c) => c.doorbell.ntfy, set: (c, v) => { c.doorbell.ntfy = v.replace(/\/$/, ''); }, apply: 'doorbell' },
];

/** Valida y normaliza. Devuelve { value } o { error } */
function normalize(f, raw) {
  if (raw === null || raw === undefined || raw === '') {
    if (f.clearable) return { value: '' };
    return { error: `${f.label}: no puede quedar vacío` };
  }
  let v = typeof raw === 'string' ? raw.trim() : raw;
  switch (f.type) {
    case 'pin': if (!/^\d{4,8}$/.test(String(v))) return { error: `${f.label}: de 4 a 8 números` }; return { value: String(v) };
    case 'int': { const n = int(v, NaN); if (!Number.isFinite(n) || n < f.min || n > f.max) return { error: `${f.label}: entre ${f.min} y ${f.max}` }; return { value: n }; }
    case 'bool': return { value: bool(v) };
    case 'url': if (!/^https?:\/\/[^\s]+$/i.test(String(v))) return { error: `${f.label}: debe empezar con http:// o https://` }; return { value: String(v) };
    case 'whatsapp': {
      const { validRecipients } = require('./notifiers');
      const t = String(v).replace(/\s+/g, '');
      if (!validRecipients(t)) return { error: `${f.label}: cada dueño necesita número con código de país y su clave de CallMeBot (ej. +5493871234567:123456)` };
      return { value: t };
    }
    case 'phone': { const t = String(v).replace(/[^\d+]/g, ''); if (!/^\+?\d{8,15}$/.test(t)) return { error: `${f.label}: número con código de país, ej. +5493871234567` }; return { value: t }; }
    case 'select': if (!f.options.some(([k]) => k === v)) return { error: `${f.label}: opción no válida` }; return { value: v };
    case 'names': return { value: String(v).split(',').map((x) => x.trim().slice(0, 30)).join(',') };
    default: {
      const s = String(v).replace(/[\r\n]/g, '');
      if (f.max && s.length > f.max) return { error: `${f.label}: máximo ${f.max} caracteres` };
      if (f.validate && !f.validate(s)) return { error: `${f.label}: valor no válido` };
      return { value: s };
    }
  }
}
const toEnv = (f, v) => (f.type === 'bool' ? (v ? '1' : '0') : String(v));

/** Vista pública del esquema (sin secretos). */
function describe(cfg) {
  return FIELDS.filter((f) => !f.hidden).map((f) => {
    const v = f.get(cfg);
    const out = { key: f.key, group: f.group, label: f.label, type: f.type, clearable: !!f.clearable, advanced: !!f.advanced, min: f.min, max: f.max, options: f.options };
    if (f.type === 'secret' || f.type === 'pin') out.isSet = !!v;
    else if (f.type === 'whatsapp') out.value = String(v || '').split(',').filter(Boolean).map((x) => { const [p, k] = x.split(':'); return { phone: p, keySet: !!k }; });
    else out.value = v;
    return out;
  });
}

module.exports = { GROUPS, FIELDS, normalize, toEnv, describe };
