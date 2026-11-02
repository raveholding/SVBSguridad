#!/usr/bin/env node
'use strict';
/**
 * SVB Seguridad — Servidor puente para Almacén Rave.
 *
 *  - Sirve el panel (index.html / PWA).
 *  - Levanta go2rtc y le pasa las cámaras Dahua (RTSP) → el navegador las ve por WebRTC/MSE.
 *  - Valida PINs de puerta (normal / coacción / visitas) del lado servidor, con bloqueo anti fuerza bruta.
 *  - Acciona la cerradura vía ESP32 (WiFi) y manda alertas con foto a Telegram.
 *  - Guarda el log de auditoría en disco (data/events.jsonl).
 *
 * Sin dependencias npm: solo Node.js >= 18.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { loadEnv, readConfig } = require('./lib/env');
const { rtspUrl, redact, DEFAULT_RTSP_TEMPLATE } = require('./lib/dahua');
const { discover, candidateHosts, portOpen } = require('./lib/discover');
const { DahuaEvents } = require('./lib/dahua-events');
const { digestGet, parseKV } = require('./lib/dahua');
const { NtfyListener, publish, REPLIES } = require('./lib/doorbell');
const SCHEMA = require('./lib/settings-schema');
const { parseRecipients, sendWhatsApp, sendPush } = require('./lib/notifiers');
const { AccessStore, BIO_ROLES } = require('./lib/access');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ino': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
// Solo esto se publica por HTTP. Nunca .env, data/, server/.
const PUBLIC_FILES = new Set(['/index.html', '/manifest.webmanifest', '/sw.js', '/timbre.html']);
const PUBLIC_DIRS = ['/assets/', '/firmware/', '/face/'];
// Endpoints de go2rtc permitidos a través del proxy (no exponer /api/config ni /api/streams: tienen contraseñas).
const GO2RTC_ALLOWED = [/^\/video-stream\.js$/, /^\/video-rtc\.js$/, /^\/api\/ws$/, /^\/api\/frame\.jpeg$/, /^\/api\/stream\.(mp4|m3u8|mjpeg)$/, /^\/api\/hls\//];

function createApp(cfg, opts = {}) {
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const dataDir = cfg.dataDir || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const visitorsFile = path.join(dataDir, 'visitors.json');
  // Personas con PIN propio, huella, rostro y horario de atención
  const access = new AccessStore(path.join(dataDir, 'access.json'));

  const state = {
    camHost: cfg.cam.host && cfg.cam.host !== 'auto' ? cfg.cam.host : '',
    discovery: null,
    go2rtc: { running: false, pid: null, restarts: 0, lastError: '' },
    failures: new Map(), // ip -> {count, until}
    startedAt: Date.now(),
    armed: false,
    dvrEvents: [],      // últimos eventos del grabador
    dvrConnected: false,
    cooldown: new Map(), // code:canal -> último aviso
  };
  const sse = new Set();
  const stateFile = path.join(dataDir, 'state.json');
  const panelFile = path.join(dataDir, 'panel-settings.json');
  // Ajustes del panel que se comparten (los PINs de respaldo y preferencias del dispositivo NO)
  const SHARED_KEYS = ['biz', 'mode', 'logo', 'emergency', 'familyName', 'familyPhone', 'familyWa', 'officePhone', 'ringCall', 'wakeOn', 'wake', 'lang', 'sens', 'rate',
    'chime', 'vol', 'relayMs', 'gridQ', 'motion', 'loiter', 'face', 'aiNotify', 'camNames', 'camOrder', 'ringCam', 'split'];
  try { state.armed = !!JSON.parse(fs.readFileSync(stateFile, 'utf8')).armed; } catch { /* primera vez */ }
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify({ armed: state.armed }));
  function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    sse.forEach((res) => { try { res.write(msg); } catch { sse.delete(res); } });
  }

  // ───────────── Persistencia ─────────────
  function addEvent(ev) {
    const e = { id: crypto.randomUUID(), ts: new Date().toISOString(), level: 'INFO', ...ev };
    fs.appendFileSync(eventsFile, JSON.stringify(e) + '\n');
    return e;
  }
  function readEvents(limit = 200) {
    if (!fs.existsSync(eventsFile)) return [];
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  }
  function readVisitors() {
    try { return JSON.parse(fs.readFileSync(visitorsFile, 'utf8')); } catch { return []; }
  }
  function writeVisitors(v) { fs.writeFileSync(visitorsFile, JSON.stringify(v, null, 2)); }
  function activeVisitors() {
    const now = Date.now();
    const v = readVisitors().filter((x) => new Date(x.expires).getTime() > now);
    return v;
  }

  // ───────────── Cámaras / go2rtc ─────────────
  function streamNames() {
    const out = [];
    for (let ch = 1; ch <= cfg.cam.channels; ch++) out.push({ ch, name: cfg.cam.names[ch - 1] || `Canal ${ch}`, sd: `rave_ch${ch}`, hd: `rave_ch${ch}_hd` });
    return out;
  }
  function go2rtcYaml() {
    const lines = [
      '# Generado automáticamente por server.js — NO subir al repositorio (contiene credenciales).',
      // origin "*": el WebSocket llega a través del proxy de este servidor; la API solo escucha en localhost.
      'api:', `  listen: "${cfg.go2rtc.api}"`, '  origin: "*"',
      'rtsp:', '  listen: ""',
      'webrtc:', `  listen: ":${cfg.go2rtc.webrtcPort}"`,
      'log:', '  level: warn',
      'streams:',
    ];
    if (state.camHost) {
      streamNames().forEach(({ ch, sd, hd }) => {
        const common = { template: cfg.cam.rtspTemplate || DEFAULT_RTSP_TEMPLATE, user: cfg.cam.user, pass: cfg.cam.pass, host: state.camHost, port: cfg.cam.rtspPort, channel: ch };
        lines.push(`  ${sd}: "${rtspUrl({ ...common, subtype: 1 })}"`);
        lines.push(`  ${hd}: "${rtspUrl({ ...common, subtype: 0 })}"`);
      });
    }
    return lines.join('\n') + '\n';
  }

  let child = null;
  let stopping = false;
  function findGo2rtc() {
    const candidates = [cfg.go2rtc.bin, path.join(__dirname, 'bin', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc')].filter(Boolean);
    return candidates.find((c) => fs.existsSync(c)) || null;
  }
  function startGo2rtc() {
    if (cfg.go2rtc.disabled) return;
    const bin = findGo2rtc();
    if (!bin) {
      state.go2rtc.lastError = 'go2rtc no instalado: ejecutá "npm run setup" en /server';
      log('[go2rtc]', state.go2rtc.lastError);
      return;
    }
    const conf = path.join(dataDir, 'go2rtc.yaml');
    fs.writeFileSync(conf, go2rtcYaml(), { mode: 0o600 });
    child = spawn(bin, ['-config', conf], { stdio: ['ignore', 'pipe', 'pipe'] });
    state.go2rtc = { ...state.go2rtc, running: true, pid: child.pid, lastError: '' };
    const onOut = (d) => String(d).split('\n').filter(Boolean).forEach((l) => log('[go2rtc]', redact(l)));
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    child.on('exit', (code) => {
      state.go2rtc.running = false;
      state.go2rtc.pid = null;
      if (stopping) return;
      state.go2rtc.lastError = `go2rtc terminó (código ${code}); reiniciando...`;
      state.go2rtc.restarts++;
      setTimeout(startGo2rtc, Math.min(30000, 2000 * state.go2rtc.restarts));
    });
  }
  // ───────────── Eventos del grabador (como las notificaciones push de DMSS) ─────────────
  let dvr = null;
  function startDvrEvents() {
    if (dvr) { dvr.stop(); dvr = null; }
    state.dvrConnected = false;
    if (!state.camHost || !cfg.cam.pass || cfg.cam.events === false) return;
    dvr = new DahuaEvents({ host: state.camHost, port: cfg.cam.httpPort, user: cfg.cam.user, pass: cfg.cam.pass, log: (m) => log('[grabador]', m) });
    dvr.on('connected', () => { state.dvrConnected = true; log('[grabador] recibiendo eventos (movimiento, intrusión, sabotaje)'); broadcast('status', { dvrConnected: true }); });
    dvr.on('event', onDvrEvent);
    dvr.start();
  }
  function onDvrEvent(e) {
    if (e.action !== 'Start' && e.action !== 'Pulse') return;
    const name = cfg.cam.names[e.channel - 1] || `Canal ${e.channel}`;
    const ev = { ts: new Date().toISOString(), code: e.code, label: e.label, channel: e.channel, camera: name, armed: state.armed };
    state.dvrEvents.unshift(ev);
    if (state.dvrEvents.length > 200) state.dvrEvents.length = 200;
    broadcast('dvr', ev);
    const notifyIt = e.always || state.armed;
    const key = `${e.code}:${e.channel}`;
    const last = state.cooldown.get(key) || 0;
    if (Date.now() - last < cfg.dvrCooldown * 1000) return;
    state.cooldown.set(key, Date.now());
    addEvent({ type: 'DVR_' + e.code.toUpperCase(), level: notifyIt ? 'HIGH' : 'INFO', message: `${e.label} · ${name}${state.armed ? ' (armado)' : ''}` });
    if (!notifyIt) return;
    (async () => {
      let photo = null;
      try { photo = await snapshot(e.channel, true); } catch { /* sin foto */ }
      await alertAll(`${e.always ? '⚠️' : '🚨'} ${e.label} en ${name} — ${cfg.businessName}${state.armed ? ' (sistema ARMADO)' : ''}`, photo, { kind: e.always ? 'alarm' : 'motion' });
    })();
  }


  // ───────────── Portero digital (QR / NFC desde el celular del cliente) ─────────────
  let bell = null;
  const rings = new Map(); // id -> {ts, name, msg, answered}
  let lastRing = 0; let lastOffRing = 0;
  function doorbellUrl() {
    const d = cfg.doorbell;
    if (!d.topic) return null;
    const u = new URL(d.page);
    u.searchParams.set('t', d.topic);
    u.searchParams.set('n', cfg.businessName);
    if (d.ntfy !== 'https://ntfy.sh') u.searchParams.set('h', d.ntfy);
    if (d.whatsapp) u.searchParams.set('w', d.whatsapp.replace(/\D/g, ''));
    return u.toString();
  }
  function startDoorbell() {
    if (bell) { bell.stop(); bell = null; }
    const d = cfg.doorbell;
    if (!d.enabled) return;
    if (!d.topic) {
      d.topic = 'rave-' + crypto.randomBytes(12).toString('hex');
      try { writeEnv({ DOORBELL_TOPIC: d.topic }); } catch { /* sin permisos */ }
    }
    bell = new NtfyListener({ base: d.ntfy, topic: d.topic, log: (m) => log('[portero]', m) });
    bell.on('connected', () => log('[portero] listo: escuchando timbres por QR/NFC'));
    bell.on('ring', (r) => onRing({ ...r, source: 'qr' }));
    bell.start();
  }
  async function onRing({ id, name, msg, source, force }) {
    const now = Date.now();
    if (!force && !access.isOpen()) {
      // Fuera de horario: el cliente ve el horario en su celular y no suena el panel.
      const text = `Estamos cerrados. Horario de atención: ${access.info().text}`;
      if (source === 'qr' && cfg.doorbell.topic && id) await publish(cfg.doorbell.ntfy, cfg.doorbell.topic + '-r', { type: 'reply', id, code: 'cerrado', text }).catch(() => {});
      if (now - lastOffRing > 60000) {
        lastOffRing = now;
        addEvent({ type: 'DOORBELL_OFFHOURS', message: `Timbre fuera de horario${name ? ': ' + name : ''}${msg ? ' — ' + msg : ''}` });
        alertAll(`🔕 ${cfg.businessName}: tocaron el timbre fuera de horario${name ? ` (${name})` : ''}. Se le mostró el horario al cliente.`, null, { kind: 'info' });
      }
      return { ok: false, reason: 'closed' };
    }
    if (now - lastRing < cfg.doorbell.cooldown * 1000) return { ok: false, reason: 'cooldown' };
    lastRing = now;
    id = id || crypto.randomBytes(6).toString('hex');
    const ring = { id, ts: new Date().toISOString(), name, msg, source, answered: null };
    rings.set(id, ring);
    if (rings.size > 50) rings.delete(rings.keys().next().value);
    addEvent({ type: 'DOORBELL_QR', message: `Timbre desde ${source === 'qr' ? 'el celular del cliente' : source}${name ? ': ' + name : ''}${msg ? ' — ' + msg : ''}` });
    broadcast('ring', ring);
    let photo = null;
    try { photo = await snapshot(cfg.doorbell.camera, true); } catch { /* sin cámara */ }
    const kb = { inline_keyboard: [[{ text: '🙂 Ya voy', callback_data: `r:${id}:voy` }, { text: '⏳ Un momento', callback_data: `r:${id}:momento` }], [{ text: '📦 Dejar en la puerta', callback_data: `r:${id}:deje` }, { text: '🚫 No atendemos', callback_data: `r:${id}:cerrado` }], [{ text: '🔓 Abrir puerta', callback_data: `r:${id}:pase` }]] };
    await alertAll(`🔔 Tocan el timbre en ${cfg.businessName}${name ? `\n👤 ${name}` : ''}${msg ? `\n💬 ${msg}` : ''}\nRespondé con los botones:`, photo, { kind: 'ring', kb, ringId: id });
    return { ok: true, id };
  }
  async function replyRing(id, code, by) {
    const ring = rings.get(id);
    if (!ring) return { ok: false, error: 'Timbre vencido o inexistente' };
    if (!REPLIES[code]) return { ok: false, error: 'Respuesta inválida' };
    ring.answered = code;
    let relay = null;
    if (code === 'pase') relay = await triggerRelay();
    if (ring.source === 'qr' && cfg.doorbell.topic) await publish(cfg.doorbell.ntfy, cfg.doorbell.topic + '-r', { type: 'reply', id, code, text: REPLIES[code] }).catch(() => {});
    addEvent({ type: code === 'pase' ? 'DOOR_OPEN' : 'DOORBELL_REPLY', level: code === 'pase' ? 'HIGH' : 'INFO', message: `Respuesta al timbre (${by}): ${REPLIES[code]}` });
    broadcast('ring-reply', { id, code, text: REPLIES[code], by });
    return { ok: true, relay };
  }

  // ───────────── Telegram: botones y comandos del dueño ─────────────
  let tgCtl = null; let tgOffset = 0; let tgRun = 0;
  function startTelegramPoll() {
    tgRun++; if (tgCtl) tgCtl.abort();
    const run = tgRun;
    if (!cfg.telegramPoll || !cfg.telegram.token || !cfg.telegram.chatId) return;
    (async () => {
      while (run === tgRun && !stopping) {
        const t0 = Date.now();
        try {
          tgCtl = new AbortController();
          const r = await fetch(`${cfg.telegram.api}/bot${cfg.telegram.token}/getUpdates?timeout=25&offset=${tgOffset}&allowed_updates=${encodeURIComponent('["callback_query","message"]')}`, { signal: tgCtl.signal });
          const j = await r.json();
          for (const u of j.result || []) {
            if (typeof u.update_id === 'number') tgOffset = Math.max(tgOffset, u.update_id + 1);
            await handleTelegram(u).catch((e) => log('[telegram]', e.message));
          }
        } catch (e) { if (e.name !== 'AbortError') await new Promise((res) => setTimeout(res, 3000)); }
        if (Date.now() - t0 < 1000) await new Promise((res) => setTimeout(res, 1000));
      }
    })();
  }
  async function tg(method, body) {
    return fetch(`${cfg.telegram.api}/bot${cfg.telegram.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  }
  async function handleTelegram(u) {
    const owner = String(cfg.telegram.chatId);
    if (u.callback_query) {
      const q = u.callback_query;
      const chat = String((q.message && q.message.chat && q.message.chat.id) || (q.from && q.from.id));
      if (chat !== owner) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'No autorizado' });
      const m = String(q.data || '').match(/^r:([\w-]+):(\w+)$/);
      if (!m) return;
      const r = await replyRing(m[1], m[2], 'Telegram');
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: r.ok ? (m[2] === 'pase' ? 'Puerta abierta' : 'Respuesta enviada al cliente') : r.error });
      if (r.ok) await tg('sendMessage', { chat_id: owner, text: `✅ Respondiste: ${REPLIES[m[2]]}` });
      return;
    }
    const msg = u.message;
    if (!msg || String(msg.chat && msg.chat.id) !== owner || !msg.text) return;
    const cmd = msg.text.trim().toLowerCase().split(/[\s@]/)[0];
    if (cmd === '/foto' || cmd === 'foto') {
      for (let ch = 1; ch <= cfg.cam.channels; ch++) {
        try { await notify(`📷 ${cfg.cam.names[ch - 1] || 'Canal ' + ch}`, await snapshot(ch, true)); } catch { /* canal sin imagen */ }
      }
    } else if (cmd === '/armar' || cmd === '/desarmar') {
      state.armed = cmd === '/armar'; saveState();
      addEvent({ type: state.armed ? 'SYSTEM_ARMED' : 'SYSTEM_DISARMED', level: 'HIGH', message: `${state.armed ? 'Armado' : 'Desarmado'} desde Telegram` });
      broadcast('arm', { armed: state.armed });
      await notify(state.armed ? '🔒 Sistema ARMADO' : '🔓 Sistema desarmado');
    } else if (cmd === '/estado' || cmd === '/start' || cmd === '/ayuda') {
      await notify(`🛡 ${cfg.businessName}\nSistema: ${state.armed ? 'ARMADO' : 'desarmado'}\nGrabador: ${state.camHost ? 'conectado' : 'sin conexión'} · eventos ${state.dvrConnected ? 'activos' : 'inactivos'}\nPortero QR: ${bell && bell.connected ? 'activo' : 'inactivo'}\nHorario: ${access.isOpen() ? 'ABIERTO' : 'CERRADO'} (${access.info().text})\n\nComandos: /foto /armar /desarmar /estado`);
    }
  }

  function restartGo2rtc() {
    if (child) { child.removeAllListeners('exit'); child.kill(); child = null; }
    state.go2rtc.running = false;
    startGo2rtc();
  }

  // ───────────── .env (configuración desde el panel) ─────────────
  const envFile = opts.envFile || process.env.SVB_ENV_FILE || path.join(ROOT, '.env');
  function writeEnv(changes) {
    let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    Object.entries(changes).forEach(([k, v]) => {
      const line = `${k}=${String(v).replace(/[\r\n]/g, '')}`;
      const re = new RegExp(`^${k}=.*$`, 'm');
      text = re.test(text) ? text.replace(re, line) : text + (text && !text.endsWith('\n') ? nl : '') + line + nl;
    });
    fs.writeFileSync(envFile, text);
  }
  function rememberHost(host) {
    // Guarda la última IP encontrada para arrancar más rápido (sigue en modo auto si cambia)
    try { writeEnv({ CAM_LAST_HOST: host }); } catch { /* sin permisos */ }
  }

  async function resolveCameraHost() {
    if (!state.camHost && cfg.cam.lastHost && cfg.cam.serial && cfg.cam.pass) {
      try {
        const { getSerial } = require('./lib/dahua');
        const r = await getSerial({ host: cfg.cam.lastHost, port: cfg.cam.httpPort, user: cfg.cam.user, pass: cfg.cam.pass, timeout: 2500 });
        if (r.ok && r.serial && r.serial.toUpperCase() === cfg.cam.serial.toUpperCase()) { state.camHost = cfg.cam.lastHost; log('[cámaras] grabador en', state.camHost); return state.camHost; }
      } catch { /* cambió de IP: buscar */ }
    }
    if (state.camHost || !cfg.cam.serial || !cfg.cam.pass) return state.camHost;
    log('[cámaras] CAM_HOST=auto → buscando grabador Dahua con serie', cfg.cam.serial.slice(0, 4) + '…');
    const r = await discover({ scan: cfg.cam.scan, httpPort: cfg.cam.httpPort, rtspPort: cfg.cam.rtspPort, user: cfg.cam.user, pass: cfg.cam.pass, serial: cfg.cam.serial, log: (m) => log('[cámaras]', m) });
    state.discovery = { at: new Date().toISOString(), scanned: r.scanned, devices: r.devices.map((d) => ({ host: d.host, type: d.type, match: !!d.match, rtsp: d.rtsp, note: d.auth || d.error })) };
    if (r.found) {
      state.camHost = r.found.host;
      if (cfg.cam.host === 'auto') rememberHost(r.found.host);
      addEvent({ type: 'CAMERA_DISCOVERED', message: `Grabador Dahua encontrado en ${r.found.host}` });
    } else {
      log('[cámaras] No se encontró el grabador. Definí CAM_HOST con la IP local del equipo.');
    }
    return state.camHost;
  }

  function go2rtcRequest(pathname, method = 'GET') {
    const [h, p] = cfg.go2rtc.api.split(':');
    return new Promise((resolve, reject) => {
      const req = http.request({ host: h, port: +p, path: pathname, method, timeout: 8000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }
  async function snapshot(ch = 1, hd = false) {
    const name = `rave_ch${ch}${hd ? '_hd' : ''}`;
    const r = await go2rtcRequest(`/api/frame.jpeg?src=${name}`);
    if (r.status !== 200 || !String(r.headers['content-type'] || '').includes('image')) throw new Error(`Sin imagen del canal ${ch} (HTTP ${r.status})`);
    return r.body;
  }
  async function streamsStatus() {
    try {
      const r = await go2rtcRequest('/api/streams');
      const data = JSON.parse(r.body.toString() || '{}');
      const out = {};
      Object.entries(data).forEach(([k, v]) => {
        out[k] = { producers: (v.producers || []).length, online: (v.producers || []).some((p) => p.state === 'connected' || (p.receivers && p.receivers.length)), consumers: (v.consumers || []).length };
      });
      return out;
    } catch { return null; }
  }

  // ───────────── Telegram (alerta silenciosa al dueño) ─────────────
  async function notify(text, photo, replyMarkup) {
    const t = cfg.telegram;
    if (!t.token || !t.chatId) return { sent: false, reason: 'Telegram no configurado' };
    try {
      let r;
      if (photo) {
        const fd = new FormData();
        fd.append('chat_id', t.chatId);
        fd.append('caption', text.slice(0, 1000));
        fd.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'evidencia.jpg');
        if (replyMarkup) fd.append('reply_markup', JSON.stringify(replyMarkup));
        r = await fetch(`${t.api}/bot${t.token}/sendPhoto`, { method: 'POST', body: fd });
      } else {
        r = await fetch(`${t.api}/bot${t.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: t.chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }) });
      }
      return { sent: r.ok, status: r.status };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }
  // ───────────── Avisos a TODOS los canales del dueño (Telegram + WhatsApp + push) ─────────────
  // kind: ring | sos | duress | alarm | motion | info | test
  const IMPORTANT = new Set(['ring', 'sos', 'duress', 'alarm', 'test']);
  const RETRY = new Set(['ring', 'sos', 'duress', 'alarm']); // si se corta internet se reintentan 15 min
  const wants = (pref, kind) => pref === 'todo' || (pref === 'importantes' && IMPORTANT.has(kind)) || (pref === 'timbre' && (kind === 'ring' || kind === 'test'));
  const retryQ = [];
  function queueRetry(label, fn) { if (retryQ.length >= 30) retryQ.shift(); retryQ.push({ ts: Date.now(), label, fn }); }
  async function flushRetry() {
    const now = Date.now(); const keep = [];
    for (const j of retryQ.splice(0)) {
      if (now - j.ts > 15 * 60000) { log('[avisos] sin conexión 15 min: se descarta', j.label); continue; }
      let ok = false; try { ok = await j.fn(); } catch { /* sigue sin conexión */ }
      if (ok) log('[avisos] enviado con demora:', j.label); else keep.push(j);
    }
    retryQ.push(...keep);
    return retryQ.length;
  }
  const late = (t, ts) => `${t}\n(enviado con demora · ocurrió a las ${new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })})`;
  async function alertAll(text, photo, { kind = 'info', kb = null, ringId = null } = {}) {
    const ts = Date.now();
    const out = { telegram: await notify(text, photo, kb) };
    if (RETRY.has(kind) && out.telegram.reason && out.telegram.reason !== 'Telegram no configurado') queueRetry('telegram', async () => (await notify(late(text, ts), photo)).sent);
    const wa = parseRecipients(cfg.whatsapp.to);
    if (wa.length && wants(cfg.whatsapp.events, kind)) {
      let t = text.replace(/\nRespondé con los botones:?/, '');
      if (kind === 'ring') t += '\nRespondé desde el panel, Telegram o la notificación push.';
      out.whatsapp = await sendWhatsApp(cfg.whatsapp.api, wa, t);
      if (RETRY.has(kind)) {
        out.whatsapp.forEach((r, i) => { if (r.error) queueRetry('whatsapp ' + r.phone, async () => (await sendWhatsApp(cfg.whatsapp.api, [wa[i]], late(t, ts)))[0].ok); });
      }
    }
    if (cfg.push.enabled && cfg.push.topic && wants(cfg.push.events, kind)) {
      const [title, ...rest] = text.split('\n');
      const actions = ringId ? [{ label: 'Ya voy', body: { type: 'reply', id: ringId, code: 'voy' } }, { label: 'Un momento', body: { type: 'reply', id: ringId, code: 'momento' } }, { label: 'Dejar en puerta', body: { type: 'reply', id: ringId, code: 'deje' } }] : [];
      const msg = {
        title: title.slice(0, 120), message: rest.join('\n').replace(/\nRespondé con los botones:?/, '').trim() || cfg.businessName,
        priority: kind === 'duress' || kind === 'sos' ? 5 : kind === 'info' || kind === 'motion' ? 3 : 4,
        tags: [{ ring: 'bell', sos: 'rotating_light', duress: 'rotating_light', alarm: 'warning', motion: 'eyes', test: 'white_check_mark' }[kind] || 'shield'],
        photo, actions, controlTopic: cfg.push.topic + '-c',
      };
      out.push = await sendPush(cfg.doorbell.ntfy, cfg.push.topic, msg);
      if (RETRY.has(kind) && out.push.error) queueRetry('push', async () => (await sendPush(cfg.doorbell.ntfy, cfg.push.topic, { ...msg, message: late(msg.message, ts), actions: [] })).ok);
    }
    return out;
  }

  // ───────────── Horario: aviso de apertura/cierre y armado automático ─────────────
  let hoursOpen = access.isOpen();
  function tickHours(d = new Date()) {
    const open = access.isOpen(d);
    if (open === hoursOpen) return null;
    hoursOpen = open;
    addEvent({ type: open ? 'HOURS_OPEN' : 'HOURS_CLOSED', message: open ? 'Comienza el horario de atención' : 'Termina el horario de atención' });
    broadcast('access', access.info());
    if (access.hours.autoArm && state.armed === open) {
      state.armed = !open; saveState();
      addEvent({ type: state.armed ? 'SYSTEM_ARMED' : 'SYSTEM_DISARMED', level: 'HIGH', message: `${state.armed ? 'Armado' : 'Desarmado'} automático por horario` });
      broadcast('arm', { armed: state.armed });
      alertAll(state.armed ? `🔒 ${cfg.businessName}: terminó el horario, sistema ARMADO automáticamente` : `🔓 ${cfg.businessName}: comenzó el horario, sistema desarmado automáticamente`, null, { kind: 'info' });
    }
    return open;
  }
  // Botones de la notificación push → llegan por el tema de control
  let pushCtl = null;
  function startPush() {
    if (pushCtl) { pushCtl.stop(); pushCtl = null; }
    if (!cfg.push.enabled) return;
    if (!cfg.push.topic) {
      cfg.push.topic = 'rave-own-' + crypto.randomBytes(12).toString('hex');
      try { writeEnv({ PUSH_TOPIC: cfg.push.topic }); } catch { /* sin permisos */ }
    }
    pushCtl = new NtfyListener({ base: cfg.doorbell.ntfy, topic: cfg.push.topic + '-c', log: (m) => log('[push]', m) });
    pushCtl.on('data', (p) => {
      if (p.type === 'reply' && p.code !== 'pase') replyRing(String(p.id || ''), String(p.code || ''), 'notificación push').catch(() => {});
    });
    pushCtl.start();
  }


  // ───────────── Cerradura (ESP32) ─────────────
  async function triggerRelay(ms) {
    const dur = Math.max(100, Math.min(10000, parseInt(ms, 10) || cfg.relayMs));
    if (!cfg.esp32Url) return { ok: true, simulated: true, ms: dur };
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(`${cfg.esp32Url}/open?ms=${dur}`, { method: 'POST', headers: { 'X-Token': cfg.esp32Token }, signal: ctl.signal });
      clearTimeout(to);
      return { ok: r.ok, simulated: false, ms: dur, status: r.status };
    } catch (e) {
      return { ok: false, simulated: false, ms: dur, error: e.name === 'AbortError' ? 'ESP32 no responde' : e.message };
    }
  }

  // ───────────── Seguridad ─────────────
  const safeEq = (a, b) => {
    const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  };
  function clientIp(req) { return (req.socket.remoteAddress || '').replace('::ffff:', ''); }
  function lockStatus(ip) {
    const f = state.failures.get(ip);
    if (f && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
    return 0;
  }
  function registerFailure(ip) {
    const f = state.failures.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 5) { f.until = Date.now() + 60000; f.count = 0; }
    state.failures.set(ip, f);
    return f.until > Date.now();
  }
  function checkPanelAuth(req) {
    if (!cfg.panelUser || !cfg.panelPass) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    return safeEq(u, cfg.panelUser) && safeEq(rest.join(':'), cfg.panelPass);
  }
  const isAdmin = (req) => safeEq(req.headers['x-admin-pin'] || '', cfg.adminPin);

  // ───────────── HTTP ─────────────
  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(payload);
  }
  function readBody(req, max = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('Body demasiado grande')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { const s = Buffer.concat(chunks).toString(); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(new Error('JSON inválido')); } });
      req.on('error', reject);
    });
  }
  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    const ok = PUBLIC_FILES.has(pathname) || PUBLIC_DIRS.some((d) => pathname.startsWith(d));
    if (!ok || pathname.includes('..')) return send(res, 404, 'No encontrado');
    const file = path.join(ROOT, decodeURIComponent(pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'No encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'public, max-age=60' });
    fs.createReadStream(file).pipe(res);
  }
  function proxyGo2rtc(req, res, subpath, search) {
    if (!GO2RTC_ALLOWED.some((re) => re.test(subpath))) return send(res, 403, 'Bloqueado');
    const [h, p] = cfg.go2rtc.api.split(':');
    const headers = { ...req.headers, host: cfg.go2rtc.api };
    delete headers.authorization;
    const preq = http.request({ host: h, port: +p, path: subpath + search, method: req.method, headers }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => send(res, 502, { error: 'go2rtc no disponible' }));
    req.pipe(preq);
  }

  async function api(req, res, pathname, query) {
    const m = req.method;
    const ip = clientIp(req);

    if (pathname === '/api/health') return send(res, 200, { ok: true, uptime: Math.round((Date.now() - state.startedAt) / 1000) });

    if (pathname === '/api/status' && m === 'GET') {
      return send(res, 200, {
        business: cfg.businessName,
        server: true,
        door: { relay: cfg.esp32Url ? 'esp32' : 'simulado', relayMs: cfg.relayMs },
        telegram: !!(cfg.telegram.token && cfg.telegram.chatId),
        armed: state.armed,
        dvrEvents: state.dvrConnected,
        ptz: true,
        doorbell: !!(bell && bell.connected),
        access: access.info(),
        cameras: {
          configured: !!state.camHost,
          host: state.camHost ? state.camHost.replace(/\.\d+$/, '.x') : null,
          serialHint: cfg.cam.serial ? cfg.cam.serial.slice(0, 4) + '…' + cfg.cam.serial.slice(-3) : null,
          channels: streamNames(),
          go2rtc: { running: state.go2rtc.running, error: state.go2rtc.lastError },
          streams: await streamsStatus(),
          discovery: state.discovery,
        },
      });
    }

    if (pathname === '/api/door/open' && m === 'POST') {
      const lock = lockStatus(ip);
      if (lock) return send(res, 429, { ok: false, result: 'locked', retryIn: lock });
      const body = await readBody(req);
      const pin = String(body.pin || '');
      let source = String(body.source || 'teclado').slice(0, 20);
      let mode = null; let visitor = null; let person = null; let fail = 'PIN incorrecto';
      if (body.webauthn) { // huella (passkey)
        source = 'huella';
        if (!access.bio.pk) fail = 'Ingreso con huella desactivado';
        else {
          const r = access.verifyPasskey(body.webauthn);
          if (r.error) fail = `Huella rechazada: ${r.error}`;
          else { person = r.person; mode = 'person'; }
        }
      } else if (body.face) { // rostro (plantilla de face-api)
        source = 'rostro';
        if (!access.bio.face) fail = 'Ingreso con rostro desactivado';
        else if (access.bio.faceLive && body.face.live !== true) fail = 'Rostro sin parpadeo (posible foto)';
        else {
          const r = access.matchFace(body.face.d);
          if (r.error) fail = `${r.error}${r.dist ? ` (distancia ${r.dist})` : ''}`;
          else { person = r.person; mode = 'person'; }
        }
      } else if (body.nfc) { // tarjeta NFC propia de la persona
        source = 'nfc';
        person = access.findByNfc(body.nfc);
        if (person) mode = 'person'; else fail = 'Tarjeta NFC no registrada';
      } else if (pin && safeEq(pin, cfg.duressPin)) mode = 'duress';
      else if (pin && safeEq(pin, cfg.doorPin)) mode = 'normal';
      else if (/^\d{4,8}$/.test(pin) && (person = access.findByPin(pin))) mode = 'person';
      else if (/^\d{6}$/.test(pin)) {
        visitor = activeVisitors().find((v) => safeEq(v.code, pin) && !(v.max && (v.used || 0) >= v.max));
        if (visitor) mode = 'visitor';
      }
      if (mode === 'person' && (!person.on || ((source === 'huella' || source === 'rostro') && !(person.consent && BIO_ROLES.includes(person.role))))) {
        fail = `${person.name}: acceso deshabilitado`; mode = null;
      }
      if (!mode) {
        const locked = registerFailure(ip);
        addEvent({ type: source === 'huella' || source === 'rostro' ? 'BIO_FAIL' : 'ACCESS_DENIED', level: 'WARN', message: `${fail} (${source})`, ip });
        if (locked) {
          addEvent({ type: 'KEYPAD_LOCKOUT', level: 'HIGH', message: 'Teclado bloqueado 60s por 5 intentos fallidos', ip });
          alertAll(`⚠️ ${cfg.businessName}: 5 intentos de acceso fallidos seguidos. Teclado bloqueado 60s.`, null, { kind: 'alarm' });
        }
        return send(res, 403, { ok: false, result: locked ? 'locked' : 'denied', retryIn: locked ? 60 : 0, reason: ['huella', 'rostro', 'nfc'].includes(source) ? fail : undefined });
      }
      state.failures.delete(ip);
      // Horario de atención: fuera de horario solo entran el PIN general, el dueño y (si se permite) los empleados.
      // El PIN de coacción se comporta igual que el PIN general: siempre abre.
      if (!access.isOpen() && (mode === 'visitor' || (mode === 'person' && !access.offHoursOk(person.role)))) {
        const who = person ? `${person.name} (${person.role})` : `visita ${visitor.name}`;
        addEvent({ type: 'OFFHOURS_DENIED', level: 'WARN', message: `Intento fuera de horario: ${who} (${source})`, ip });
        alertAll(`⛔ ${cfg.businessName}: intento de ingreso fuera de horario — ${who}`, null, { kind: 'info' });
        return send(res, 403, { ok: false, result: 'closed', hours: access.info().text });
      }
      const relay = await triggerRelay(body.ms);
      if (mode === 'duress') {
        // Respuesta idéntica a una apertura normal: el agresor no ve diferencias.
        addEvent({ type: 'CRITICAL_DURESS_EVENT', level: 'CRITICAL', message: 'Apertura con PIN de coacción', ip, source });
        (async () => {
          // 1) aviso inmediato, 2) tres fotos del canal 1 (puerta) como evidencia
          await alertAll(`🚨 COACCIÓN en ${cfg.businessName}\nAlguien abrió con el PIN de coacción a las ${new Date().toLocaleTimeString('es-AR')}. Llamá al 911.`, null, { kind: 'duress' });
          for (let i = 0; i < 3; i++) {
            try {
              const photo = await snapshot(1, true);
              addEvent({ type: 'DURESS_PHOTO', level: 'CRITICAL', message: `Foto encubierta ${i + 1}/3 (canal 1)` });
              if (i === 0) await notify(`📷 Evidencia coacción ${cfg.businessName}`, photo);
            } catch { /* sin cámara */ }
            await new Promise((r) => setTimeout(r, 1000));
          }
        })();
      } else if (mode === 'visitor') {
        const all = readVisitors(); const v = all.find((x) => x.id === visitor.id);
        if (v) { v.used = (v.used || 0) + 1; writeVisitors(all); }
        addEvent({ type: 'VISITOR_ACCESS', message: `Acceso de visita: ${visitor.name}${visitor.max ? ` (uso ${(v || visitor).used}/${visitor.max})` : ''}`, ip });
      } else if (mode === 'person') {
        access.touch(person);
        addEvent({ type: 'DOOR_OPEN', message: `Puerta abierta (${source}) · ${person.name} — ${person.role}`, ip, who: person.name });
      } else {
        addEvent({ type: 'DOOR_OPEN', message: `Puerta abierta (${source})`, ip });
      }
      const name = mode === 'visitor' ? visitor.name : mode === 'person' ? person.name : undefined;
      return send(res, 200, { ok: true, result: 'open', relay: { ok: relay.ok, simulated: relay.simulated, ms: relay.ms }, ...(name ? { visitor: name } : {}), _c: mode === 'duress' ? 1 : 0 });
    }

    // ── Huella: desafío de un solo uso (vence en 2 minutos) ──
    if (pathname === '/api/webauthn/challenge' && m === 'POST') {
      const lock = lockStatus(ip);
      if (lock) return send(res, 429, { ok: false, retryIn: lock });
      return send(res, 200, { challenge: access.newChallenge() });
    }
    // ── Horario y biometría visibles en la pantalla principal (sin datos personales) ──
    if (pathname === '/api/access/info' && m === 'GET') return send(res, 200, access.info());

    // ── Horario de atención ──
    if (pathname === '/api/hours') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      if (m === 'GET') return send(res, 200, { ...access.hours, info: access.info() });
      if (m === 'PUT') {
        try { access.setHours(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
        addEvent({ type: 'HOURS_CHANGED', level: 'HIGH', message: `Horario de atención: ${access.info().text}` });
        hoursOpen = access.isOpen();
        broadcast('access', access.info());
        return send(res, 200, { ok: true, ...access.hours, info: access.info() });
      }
    }
    // ── Personas: PIN propio, huella y rostro ──
    if (pathname === '/api/bio' && m === 'PUT') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      try { access.setBio(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
      addEvent({ type: 'CONFIG_CHANGED', level: 'HIGH', message: `Biometría: huella ${access.bio.pk ? 'activada' : 'desactivada'}, rostro ${access.bio.face ? 'activado' : 'desactivado'} (exigencia ${access.bio.faceThr})` });
      broadcast('access', access.info());
      return send(res, 200, { ok: true, bio: access.bio });
    }
    if (pathname === '/api/people' || pathname.startsWith('/api/people/')) {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const [, , , id, sub] = pathname.split('/');
      try {
        if (!id) {
          if (m === 'GET') return send(res, 200, { people: access.people.map((p) => access.view(p)), bio: access.bio, info: access.info() });
          if (m === 'POST') {
            const b = await readBody(req);
            const p = access.create(b);
            addEvent({ type: 'PERSON_CREATED', level: 'HIGH', message: `Persona agregada: ${p.name} (${p.role})` });
            return send(res, 201, access.view(p));
          }
        }
        const p = id && access.get(id);
        if (!p) return send(res, 404, { error: 'Persona inexistente' });
        if (!sub && m === 'PUT') {
          const b = await readBody(req);
          const hadBio = (p.pk || []).length || p.face;
          const pin = b.pin !== undefined ? String(b.pin || '') : null;
          if (pin) {
            if (!/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'El PIN debe tener de 4 a 8 números' });
            if (pin === cfg.duressPin || pin === cfg.adminPin || pin === cfg.doorPin) return send(res, 400, { error: 'Ese PIN está reservado (general, coacción o administración). Elegí otro.' });
            const dup = access.findByPin(pin);
            if (dup && dup.id !== p.id) return send(res, 400, { error: 'Ese PIN ya lo usa otra persona. Elegí otro.' });
            if (activeVisitors().some((v) => v.code === pin)) return send(res, 400, { error: 'Ese PIN coincide con un pase de visita activo. Elegí otro.' });
          }
          access.update(p, b);
          if (pin !== null) access.setPin(p, pin);
          if (hadBio && !((p.pk || []).length || p.face)) addEvent({ type: 'BIO_DELETE', level: 'HIGH', message: `Datos biométricos borrados · ${p.name}` });
          if (b.consent !== undefined) addEvent({ type: 'BIO_CONSENT', level: 'HIGH', message: `${p.name}: consentimiento biométrico ${b.consent ? 'registrado' : 'retirado'}` });
          addEvent({ type: 'PERSON_UPDATED', message: `Persona modificada: ${p.name}${b.pin !== undefined ? (b.pin ? ' (PIN nuevo)' : ' (PIN quitado)') : ''}` });
          broadcast('access', access.info());
          return send(res, 200, access.view(p));
        }
        if (!sub && m === 'DELETE') {
          access.remove(p.id);
          addEvent({ type: 'PERSON_DELETED', level: 'HIGH', message: `Persona eliminada (con sus datos biométricos): ${p.name}` });
          broadcast('access', access.info());
          return send(res, 200, { ok: true });
        }
        if (sub === 'passkey' && m === 'POST') {
          const b = await readBody(req);
          access.addPasskey(p, b);
          addEvent({ type: 'BIO_ENROLL', level: 'HIGH', message: `Huella registrada · ${p.name} (${b.kind === 'Celular' ? 'su celular' : 'este dispositivo'})` });
          broadcast('access', access.info());
          return send(res, 201, access.view(p));
        }
        if (sub === 'passkey' && m === 'DELETE') {
          access.removePasskey(p, String(query.get('cid') || ''));
          addEvent({ type: 'BIO_DELETE', level: 'HIGH', message: `Huella quitada · ${p.name}` });
          broadcast('access', access.info());
          return send(res, 200, access.view(p));
        }
        if (sub === 'face' && m === 'POST') {
          const b = await readBody(req);
          access.setFace(p, b.d);
          addEvent({ type: 'BIO_ENROLL', level: 'HIGH', message: `Rostro registrado · ${p.name} (${b.d.length} muestras, sin fotos)` });
          broadcast('access', access.info());
          return send(res, 201, access.view(p));
        }
        if (sub === 'face' && m === 'DELETE') {
          access.removeFace(p);
          addEvent({ type: 'BIO_DELETE', level: 'HIGH', message: `Rostro quitado · ${p.name}` });
          broadcast('access', access.info());
          return send(res, 200, access.view(p));
        }
      } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 405, { error: 'Método no permitido' });
    }

    if (pathname === '/api/admin/check' && m === 'POST') {
      const lock = lockStatus(ip);
      if (lock) return send(res, 429, { ok: false, retryIn: lock });
      if (isAdmin(req)) { state.failures.delete(ip); return send(res, 200, { ok: true }); }
      registerFailure(ip);
      addEvent({ type: 'ADMIN_DENIED', level: 'WARN', message: 'PIN de administrador incorrecto', ip });
      return send(res, 403, { ok: false });
    }

    if (pathname === '/api/events' && m === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      return send(res, 200, readEvents(Math.min(5000, parseInt(query.get('limit'), 10) || 200)));
    }
    if (pathname === '/api/events' && m === 'POST') {
      const b = await readBody(req);
      const type = String(b.type || 'EVENT').replace(/[^A-Z0-9_]/gi, '').slice(0, 40);
      const e = addEvent({ type, level: String(b.level || 'INFO').slice(0, 10), message: String(b.message || '').slice(0, 500), source: 'panel' });
      return send(res, 201, e);
    }

    if (pathname === '/api/alert' && m === 'POST') {
      const b = await readBody(req);
      const type = String(b.type || 'ALERT').replace(/[^A-Z0-9_]/gi, '').slice(0, 40);
      let photo = null;
      if (b.snapshot && /^data:image\/jpeg;base64,/.test(b.snapshot)) photo = Buffer.from(b.snapshot.split(',')[1], 'base64');
      if (!photo && b.camera) { try { photo = await snapshot(parseInt(b.camera, 10) || 1, true); } catch { /* sin cámara */ } }
      addEvent({ type, level: String(b.level || 'HIGH').slice(0, 10), message: String(b.message || '').slice(0, 500) });
      const kind = /SOS/.test(type) ? 'sos' : type === 'DOORBELL' ? 'ring' : /LOITER|TAMPER|LOCKOUT/.test(type) ? 'alarm' : 'info';
      const n = await alertAll(`${b.emoji || '🔔'} ${cfg.businessName}: ${String(b.message || type).slice(0, 500)}`, photo, { kind });
      return send(res, 200, { ok: true, notified: !!(n.telegram.sent || (n.whatsapp || []).some((x) => x.ok) || (n.push && n.push.ok)) });
    }

    const snap = pathname.match(/^\/api\/snapshot\/(\d+)$/);
    if (snap && m === 'GET') {
      try {
        const img = await snapshot(+snap[1], query.get('hd') === '1');
        return send(res, 200, img, { 'Content-Type': 'image/jpeg' });
      } catch (e) { return send(res, 503, { error: e.message }); }
    }

    if (pathname === '/api/visitors') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      if (m === 'GET') return send(res, 200, activeVisitors());
      if (m === 'POST') {
        const b = await readBody(req);
        const hours = Math.max(1, Math.min(720, parseInt(b.hours, 10) || 24));
        let code = String(b.code || '');
        const taken = (c) => c === cfg.doorPin || c === cfg.duressPin || c === cfg.adminPin || activeVisitors().some((v) => v.code === c) || !!access.findByPin(c);
        if (/^\d{6}$/.test(code) && taken(code)) return send(res, 400, { error: 'Código reservado o en uso' });
        for (let i = 0; !/^\d{6}$/.test(code) || taken(code); i++) { if (i > 20) return send(res, 500, { error: 'No se pudo generar el código' }); code = String(crypto.randomInt(100000, 999999)); }
        const max = Math.max(0, Math.min(50, parseInt(b.max, 10) || 0)); // 0 = sin límite de usos
        const v = { id: crypto.randomUUID(), name: String(b.name || 'Visita').slice(0, 60), code, expires: new Date(Date.now() + hours * 3600e3).toISOString(), max, used: 0 };
        writeVisitors([...activeVisitors(), v]);
        addEvent({ type: 'VISITOR_CREATED', message: `Pase temporal para ${v.name} (${hours} h${max ? `, ${max} uso${max > 1 ? 's' : ''}` : ''})` });
        return send(res, 201, v);
      }
      if (m === 'DELETE') {
        const id = query.get('id');
        writeVisitors(activeVisitors().filter((v) => v.id !== id));
        return send(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/relay/test' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const b = await readBody(req);
      const r = await triggerRelay(b.ms);
      addEvent({ type: 'RELAY_TEST', message: `Prueba de relé ${r.ms} ms (${r.simulated ? 'simulado' : r.ok ? 'OK' : 'falló'})` });
      return send(res, 200, r);
    }

    if (pathname === '/api/telegram/test' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const n = await notify(`✅ Prueba de alertas de ${cfg.businessName}: funcionando.`);
      return send(res, 200, n);
    }

    if (pathname === '/api/discover' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      if (!cfg.cam.pass) return send(res, 400, { error: 'Falta la contraseña del grabador (Configuración → Grabador Dahua)' });
      const prev = state.camHost;
      state.camHost = '';
      await resolveCameraHost();
      if (!state.camHost) state.camHost = prev;
      else if (state.camHost !== prev) { restartGo2rtc(); startDvrEvents(); }
      return send(res, 200, { found: !!state.discovery && state.discovery.devices.some((d) => d.match), discovery: state.discovery });
    }

    // ── Portero digital ──
    if (pathname === '/api/doorbell' && m === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      return send(res, 200, { enabled: cfg.doorbell.enabled, connected: !!(bell && bell.connected), url: doorbellUrl(), page: cfg.doorbell.page, camera: cfg.doorbell.camera });
    }
    if (pathname === '/api/doorbell/regenerate' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      cfg.doorbell.topic = ''; startDoorbell();
      addEvent({ type: 'DOORBELL_REGENERATED', level: 'HIGH', message: 'Código del portero regenerado: los QR/NFC viejos dejan de funcionar' });
      return send(res, 200, { ok: true, url: doorbellUrl() });
    }
    if (pathname === '/api/doorbell/test' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      lastRing = 0;
      return send(res, 200, await onRing({ name: 'Prueba', msg: 'Timbre de prueba desde administración', source: 'prueba', force: true }));
    }
    if (pathname === '/api/doorbell/reply' && m === 'POST') {
      const b = await readBody(req);
      const code = String(b.code || '');
      if (code === 'pase') {
        const lock = lockStatus(ip);
        if (lock) return send(res, 429, { ok: false, retryIn: lock });
        const pin = String(b.pin || '');
        if (!(pin && (safeEq(pin, cfg.doorPin) || safeEq(pin, cfg.adminPin)))) { registerFailure(ip); return send(res, 403, { ok: false, error: 'PIN incorrecto' }); }
      }
      return send(res, 200, await replyRing(String(b.id || ''), code, 'panel'));
    }

    // ── Eventos en vivo para el panel (Server-Sent Events) ──
    if (pathname === '/api/live' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ armed: state.armed, dvrConnected: state.dvrConnected })}\n\n`);
      sse.add(res);
      const hb = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(hb); sse.delete(res); });
      return;
    }
    if (pathname === '/api/dvr/events' && m === 'GET') return send(res, 200, state.dvrEvents.slice(0, 100));

    // ── Armar / desarmar (alertas de movimiento al celular) ──
    if (pathname === '/api/arm' && m === 'POST') {
      const lock = lockStatus(ip);
      if (lock) return send(res, 429, { ok: false, retryIn: lock });
      const b = await readBody(req);
      const pin = String(b.pin || '');
      if (!(isAdmin(req) || (pin && (safeEq(pin, cfg.doorPin) || safeEq(pin, cfg.adminPin))))) {
        registerFailure(ip);
        return send(res, 403, { ok: false });
      }
      state.armed = !!b.armed; saveState();
      addEvent({ type: state.armed ? 'SYSTEM_ARMED' : 'SYSTEM_DISARMED', level: 'HIGH', message: state.armed ? 'Sistema ARMADO: avisos de movimiento activos' : 'Sistema desarmado' });
      broadcast('arm', { armed: state.armed });
      alertAll(state.armed ? `🔒 ${cfg.businessName}: sistema ARMADO` : `🔓 ${cfg.businessName}: sistema desarmado`, null, { kind: 'info' });
      return send(res, 200, { ok: true, armed: state.armed });
    }

    // ── Información del grabador ──
    if (pathname === '/api/device' && m === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      if (!state.camHost) return send(res, 200, { connected: false });
      const g = async (p) => { try { const r = await digestGet({ host: state.camHost, port: cfg.cam.httpPort, user: cfg.cam.user, pass: cfg.cam.pass, path: p, timeout: 4000 }); return r.status === 200 ? parseKV(r.body.toString()) : {}; } catch { return {}; } };
      const [type, sw, hdd] = await Promise.all([g('/cgi-bin/magicBox.cgi?action=getDeviceType'), g('/cgi-bin/magicBox.cgi?action=getSoftwareVersion'), g('/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo')]);
      const disks = [];
      Object.entries(hdd).forEach(([k, v]) => {
        const mm = k.match(/^list\.info\[(\d+)\]\.Detail\[(\d+)\]\.(TotalBytes|UsedBytes|IsError)$/);
        if (!mm) return;
        const id = `${mm[1]}.${mm[2]}`;
        let d = disks.find((x) => x.id === id); if (!d) { d = { id }; disks.push(d); }
        d[mm[3]] = mm[3] === 'IsError' ? v === 'true' : parseFloat(v);
      });
      return send(res, 200, { connected: true, model: type.type || null, firmware: sw.version || null, serialHint: cfg.cam.serial ? cfg.cam.serial.slice(0, 4) + '…' + cfg.cam.serial.slice(-3) : null, host: state.camHost, channels: cfg.cam.channels, events: state.dvrConnected, disks: disks.map((d) => ({ totalGB: d.TotalBytes ? +(d.TotalBytes / 1e9).toFixed(1) : null, usedGB: d.UsedBytes ? +(d.UsedBytes / 1e9).toFixed(1) : null, error: !!d.IsError })) });
    }

    // ── PTZ (cámaras motorizadas) ──
    if (pathname === '/api/ptz' && m === 'POST') {
      if (!state.camHost) return send(res, 400, { error: 'Grabador no conectado' });
      const b = await readBody(req);
      const codes = ['Up', 'Down', 'Left', 'Right', 'LeftUp', 'RightUp', 'LeftDown', 'RightDown', 'ZoomTele', 'ZoomWide', 'FocusNear', 'FocusFar'];
      const code = codes.includes(b.code) ? b.code : null;
      const ch = Math.max(1, Math.min(cfg.cam.channels, parseInt(b.ch, 10) || 1));
      if (!code) return send(res, 400, { error: 'Comando PTZ inválido' });
      const action = b.action === 'stop' ? 'stop' : 'start';
      const speed = Math.max(1, Math.min(8, parseInt(b.speed, 10) || 4));
      try {
        const r = await digestGet({ host: state.camHost, port: cfg.cam.httpPort, user: cfg.cam.user, pass: cfg.cam.pass, timeout: 4000, path: `/cgi-bin/ptz.cgi?action=${action}&channel=${ch}&code=${code}&arg1=0&arg2=${speed}&arg3=0` });
        return send(res, 200, { ok: r.status === 200 && /OK/i.test(r.body.toString()), status: r.status });
      } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
    }

    // ── Reproducción de grabaciones del disco del grabador ──
    if (pathname === '/api/playback' && (m === 'POST' || m === 'DELETE')) {
      if (!state.camHost) return send(res, 400, { error: 'Grabador no conectado' });
      if (m === 'DELETE') { await go2rtcRequest('/api/streams?src=rave_pb', 'DELETE').catch(() => {}); return send(res, 200, { ok: true }); }
      const b = await readBody(req);
      const ch = Math.max(1, Math.min(cfg.cam.channels, parseInt(b.ch, 10) || 1));
      const start = new Date(String(b.start || ''));
      if (isNaN(start)) return send(res, 400, { error: 'Fecha inválida' });
      const mins = Math.max(1, Math.min(240, parseInt(b.minutes, 10) || 60));
      const end = new Date(start.getTime() + mins * 60000);
      const f = (d) => `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}_${String(d.getMinutes()).padStart(2, '0')}_${String(d.getSeconds()).padStart(2, '0')}`;
      const tpl = cfg.cam.playbackTemplate || 'rtsp://{user}:{pass}@{host}:{port}/cam/playback?channel={channel}&subtype=0&starttime={start}&endtime={end}';
      const url = tpl.replace('{user}', encodeURIComponent(cfg.cam.user)).replace('{pass}', encodeURIComponent(cfg.cam.pass)).replace('{host}', state.camHost)
        .replace('{port}', String(cfg.cam.rtspPort)).replace('{channel}', String(ch)).replace('{start}', f(start)).replace('{end}', f(end));
      await go2rtcRequest('/api/streams?src=rave_pb', 'DELETE').catch(() => {});
      const r = await go2rtcRequest(`/api/streams?name=rave_pb&src=${encodeURIComponent(url)}`, 'PUT').catch((e) => ({ status: 502, body: Buffer.from(e.message) }));
      if (r.status !== 200) return send(res, 502, { error: 'go2rtc no disponible' });
      addEvent({ type: 'PLAYBACK', message: `Reproducción canal ${ch} desde ${start.toLocaleString('es-AR')}` });
      return send(res, 200, { ok: true, stream: 'rave_pb', channel: ch });
    }

    // ── Configuración desde el panel (escribe .env) ──
    if (pathname === '/api/setup' && m === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      return send(res, 200, {
        groups: SCHEMA.GROUPS, fields: SCHEMA.describe(cfg),
        telegram: !!(cfg.telegram.token && cfg.telegram.chatId),
        push: cfg.push.enabled && cfg.push.topic ? { server: cfg.doorbell.ntfy, topic: cfg.push.topic, link: `ntfy://${cfg.doorbell.ntfy.replace(/^https?:\/\//, '')}/${cfg.push.topic}`, web: `${cfg.doorbell.ntfy}/${cfg.push.topic}`, connected: !!(pushCtl && pushCtl.connected) } : null,
        defaultPins: { door: cfg.doorPin === '2580', duress: cfg.duressPin === '9999', admin: cfg.adminPin === '1234' },
        status: {
          camera: { connected: !!state.camHost, host: state.camHost || null, events: state.dvrConnected, go2rtc: state.go2rtc.running, error: state.go2rtc.lastError || null },
          door: cfg.esp32Url ? 'esp32' : 'simulado', doorbell: !!(bell && bell.connected), telegram: !!(cfg.telegram.token && cfg.telegram.chatId),
        },
        envFile,
      });
    }
    if (pathname === '/api/setup' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const b = await readBody(req);
      const ch = {}; const vals = {};
      if (typeof b.WHATSAPP_TO === 'string' && b.WHATSAPP_TO.includes(':*')) {
        const old = parseRecipients(cfg.whatsapp.to);
        b.WHATSAPP_TO = b.WHATSAPP_TO.split(',').map((x) => { const [ph, k] = x.split(':'); if (k !== '*') return x; const o = old.find((r) => r.phone.replace('+', '') === ph.replace(/[^\d]/g, '')); return o ? `${ph}:${o.apikey}` : `${ph}:`; }).join(',');
      }
      for (const [k, raw] of Object.entries(b)) {
        const f = SCHEMA.FIELDS.find((x) => x.key === k);
        if (!f) continue;
        if ((raw === '' || raw === null || raw === undefined) && !f.clearable) continue; // vacío = sin cambios
        const r = SCHEMA.normalize(f, raw);
        if (r.error) return send(res, 400, { error: r.error, field: k });
        vals[k] = r.value; ch[k] = SCHEMA.toEnv(f, r.value);
      }
      if (!Object.keys(ch).length) return send(res, 400, { error: 'Sin cambios' });
      const pins = { door: vals.DOOR_PIN || cfg.doorPin, duress: vals.DURESS_PIN || cfg.duressPin, admin: vals.ADMIN_PIN || cfg.adminPin };
      if (pins.door === pins.duress) return send(res, 400, { error: 'El PIN de puerta y el de coacción deben ser distintos', field: 'DURESS_PIN' });
      for (const k of ['DOOR_PIN', 'DURESS_PIN', 'ADMIN_PIN']) {
        if (vals[k] && access.findByPin(vals[k])) return send(res, 400, { error: 'Ese PIN ya lo usa una persona de Accesos. Elegí otro.', field: k });
      }
      const panelUser = 'PANEL_USER' in vals ? vals.PANEL_USER : cfg.panelUser;
      const panelPass = 'PANEL_PASS' in vals ? vals.PANEL_PASS : cfg.panelPass;
      if (!!panelUser !== !!panelPass) return send(res, 400, { error: 'Para proteger el panel completá usuario y contraseña (o dejá los dos vacíos)', field: 'PANEL_PASS' });
      try { writeEnv(ch); } catch (e) { return send(res, 500, { error: 'No se pudo guardar la configuración: ' + e.message }); }
      const applies = new Set();
      for (const [k, v] of Object.entries(vals)) { const f = SCHEMA.FIELDS.find((x) => x.key === k); f.set(cfg, v); if (f.apply) applies.add(f.apply); }
      if (applies.has('cam')) {
        state.camHost = cfg.cam.host && cfg.cam.host !== 'auto' ? cfg.cam.host : '';
        if (!state.camHost && cfg.cam.pass) await resolveCameraHost().catch(() => {});
        restartGo2rtc(); startDvrEvents();
      }
      if (applies.has('doorbell')) { startDoorbell(); startPush(); }
      if (applies.has('push')) startPush();
      if (applies.has('telegram')) startTelegramPoll();
      addEvent({ type: 'CONFIG_CHANGED', level: 'HIGH', message: `Configuración modificada: ${Object.keys(ch).map((k) => (/(PIN|PASS|TOKEN)$/.test(k) ? k + '=****' : k)).join(', ')}` });
      broadcast('config', { keys: Object.keys(ch) });
      return send(res, 200, { ok: true, saved: Object.keys(ch), camera: { connected: !!state.camHost } });
    }
    if (pathname === '/api/check/notify' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      let photo = null; try { photo = await snapshot(cfg.doorbell.camera, true); } catch { /* sin cámara */ }
      const r = await alertAll(`✅ Prueba de avisos de ${cfg.businessName}\nSi te llegó este mensaje, los avisos funcionan.`, photo, { kind: 'test' });
      addEvent({ type: 'NOTIFY_TEST', message: 'Prueba de avisos enviada' });
      return send(res, 200, { telegram: r.telegram, whatsapp: r.whatsapp || [], push: r.push || null });
    }
    // ── Buscar la cerradura ESP32 en la red y vincularla sola ──
    if (pathname === '/api/esp32/discover' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const b = await readBody(req);
      const port = parseInt(process.env.ESP32_SCAN_PORT, 10) || 80;
      const hosts = candidateHosts(typeof b.scan === 'string' && /^[\d.,/ ]+$/.test(b.scan) ? b.scan : cfg.cam.scan);
      const open = [];
      for (let i = 0; i < hosts.length; i += 64) {
        const chunk = await Promise.all(hosts.slice(i, i + 64).map(async (h) => ((await portOpen(h, port, 400)) ? h : null)));
        open.push(...chunk.filter(Boolean));
      }
      const found = [];
      for (const h of open) {
        try {
          const url = `http://${h}${port === 80 ? '' : ':' + port}`;
          const r = await fetch(`${url}/status`, { signal: AbortSignal.timeout(1500) });
          const j = await r.json();
          if (j && j.device === 'svb-puerta') found.push({ url, ...j });
        } catch { /* no es una cerradura SVB */ }
      }
      if (!found.length) return send(res, 200, { ok: false, scanned: hosts.length, error: 'No se encontró ninguna cerradura SVB en la red. Verificá que esté encendida y conectada al WiFi del local.' });
      const free = found.find((f) => !f.paired);
      const mine = found.find((f) => f.url === cfg.esp32Url);
      if (!free) return send(res, 200, { ok: !!mine, found: found.map((f) => ({ url: f.url, id: f.id, paired: f.paired })), message: mine ? 'La cerradura ya está vinculada a este sistema.' : 'Hay una cerradura ya vinculada a otro sistema. Para volver a vincularla mantené apretado su botón BOOT 5 segundos y configurala de nuevo.' });
      const token = crypto.randomBytes(24).toString('hex');
      try {
        const r = await fetch(`${free.url}/pair`, { method: 'POST', body: token, headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(3000) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); return send(res, 200, { ok: false, error: j.error || `La cerradura rechazó el vínculo (HTTP ${r.status})` }); }
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      cfg.esp32Url = free.url; cfg.esp32Token = token;
      writeEnv({ ESP32_URL: free.url, ESP32_TOKEN: token });
      addEvent({ type: 'ESP32_PAIRED', level: 'HIGH', message: `Cerradura ${free.id} vinculada en ${free.url}` });
      return send(res, 200, { ok: true, paired: true, url: free.url, id: free.id, door: free.door });
    }
    // ── Pruebas de conexión ──
    if (pathname === '/api/check/esp32' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      if (!cfg.esp32Url) return send(res, 200, { ok: false, error: 'Sin ESP32 configurado (modo simulado)' });
      try {
        const r = await fetch(`${cfg.esp32Url}/status`, { signal: AbortSignal.timeout(4000) });
        const j = await r.json().catch(() => ({}));
        return send(res, 200, { ok: r.ok, info: j });
      } catch (e) { return send(res, 200, { ok: false, error: e.name === 'TimeoutError' ? 'El ESP32 no responde' : e.message }); }
    }
    if (pathname === '/api/check/doorbell-page' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      try {
        const r = await fetch(cfg.doorbell.page, { signal: AbortSignal.timeout(8000) });
        const t = await r.text();
        return send(res, 200, { ok: r.ok && t.includes('Portero digital'), status: r.status });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    // ── Ajustes del panel compartidos entre todos los dispositivos ──
    if (pathname === '/api/panel-settings' && m === 'GET') {
      try { return send(res, 200, JSON.parse(fs.readFileSync(panelFile, 'utf8'))); } catch { return send(res, 200, { v: 0, settings: {} }); }
    }
    if (pathname === '/api/panel-settings' && m === 'PUT') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const b = await readBody(req, 3 * 1024 * 1024);
      const settings = {};
      Object.entries(b.settings || {}).forEach(([k, v]) => { if (SHARED_KEYS.includes(k)) settings[k] = v; });
      let v = 0; try { v = JSON.parse(fs.readFileSync(panelFile, 'utf8')).v || 0; } catch { /* nuevo */ }
      const doc = { v: v + 1, by: String(b.device || '').slice(0, 40), at: new Date().toISOString(), settings };
      fs.writeFileSync(panelFile, JSON.stringify(doc));
      broadcast('settings', { v: doc.v, by: doc.by });
      return send(res, 200, { ok: true, v: doc.v });
    }
    if (pathname === '/api/setup/telegram' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'PIN admin requerido' });
      const b = await readBody(req);
      const token = String(b.token || '').trim();
      if (!/^\d+:[\w-]{20,}$/.test(token)) return send(res, 400, { error: 'El token no tiene el formato correcto (números:letras)' });
      try {
        const r = await fetch(`${cfg.telegram.api}/bot${token}/getUpdates`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) return send(res, 400, { error: 'Telegram rechazó el token. Copialo de nuevo desde @BotFather.' });
        const chats = (j.result || []).map((u) => (u.message || u.my_chat_member || u.channel_post || {}).chat).filter(Boolean);
        const chat = chats[chats.length - 1];
        if (!chat) return send(res, 409, { error: 'Token correcto. Ahora abrí tu bot en Telegram, tocá INICIAR (o mandale "hola") y volvé a tocar Detectar.' });
        cfg.telegram.token = token; cfg.telegram.chatId = String(chat.id);
        writeEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: String(chat.id) });
        tgOffset = Math.max(tgOffset, ...(j.result || []).map((u) => (u.update_id || 0) + 1));
        startTelegramPoll();
        const n = await notify(`✅ ${cfg.businessName}: alertas de seguridad conectadas. Vas a recibir aquí avisos de coacción, SOS, timbre y eventos de cámaras.`);
        addEvent({ type: 'TELEGRAM_LINKED', message: `Telegram vinculado (${chat.first_name || chat.title || 'chat'})` });
        return send(res, 200, { ok: true, name: chat.first_name || chat.title || '', sent: n.sent });
      } catch (e) { return send(res, 502, { error: 'Sin conexión con Telegram: ' + e.message }); }
    }

    return send(res, 404, { error: 'No existe' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!checkPanelAuth(req)) return send(res, 401, 'Autenticación requerida', { 'WWW-Authenticate': 'Basic realm="SVB Seguridad"' });
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams);
      if (url.pathname.startsWith('/go2rtc/')) return proxyGo2rtc(req, res, url.pathname.slice(7), url.search);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      log('[error]', e.message);
      if (!res.headersSent) send(res, 400, { error: e.message });
    }
  });

  // WebSocket (video WebRTC/MSE) → go2rtc
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (!checkPanelAuth(req) || url.pathname !== '/go2rtc/api/ws') { socket.destroy(); return; }
    const [h, p] = cfg.go2rtc.api.split(':');
    const up = net.connect(+p, h, () => {
      const headers = Object.entries(req.headers).filter(([k]) => k !== 'authorization').map(([k, v]) => `${k}: ${k === 'host' ? cfg.go2rtc.api : v}`);
      up.write(`GET /api/ws${url.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const kill = () => { up.destroy(); socket.destroy(); };
    up.on('error', kill); socket.on('error', kill);
  });

  async function start() {
    await resolveCameraHost().catch((e) => log('[cámaras]', e.message));
    startGo2rtc();
    startDvrEvents();
    startDoorbell();
    startPush();
    startTelegramPoll();
    hoursTimer = setInterval(() => { tickHours(); if (retryQ.length) flushRetry(); }, 30000);
    await new Promise((r) => server.listen(cfg.port, cfg.host, r));
    log(`SVB Seguridad · ${cfg.businessName} → http://localhost:${server.address().port}`);
    return server;
  }
  let hoursTimer = null;
  async function stop() {
    stopping = true;
    clearInterval(hoursTimer);
    if (child) child.kill();
    if (dvr) dvr.stop();
    if (bell) bell.stop();
    if (pushCtl) pushCtl.stop();
    tgRun++; if (tgCtl) tgCtl.abort();
    sse.forEach((r) => r.end());
    await new Promise((r) => server.close(r));
  }

  return { server, start, stop, state, go2rtcYaml, addEvent, readEvents, triggerRelay, notify, access, tickHours, flushRetry, alertAll, retryQ };
}

if (require.main === module) {
  loadEnv(process.env.SVB_ENV_FILE || path.join(ROOT, '.env'));
  const app = createApp(readConfig());
  app.start();
  const bye = () => app.stop().finally(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { createApp };
