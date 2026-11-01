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
const { discover } = require('./lib/discover');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ino': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
// Solo esto se publica por HTTP. Nunca .env, data/, server/.
const PUBLIC_FILES = new Set(['/index.html', '/manifest.webmanifest', '/sw.js']);
const PUBLIC_DIRS = ['/assets/', '/firmware/'];
// Endpoints de go2rtc permitidos a través del proxy (no exponer /api/config ni /api/streams: tienen contraseñas).
const GO2RTC_ALLOWED = [/^\/video-stream\.js$/, /^\/video-rtc\.js$/, /^\/api\/ws$/, /^\/api\/frame\.jpeg$/, /^\/api\/stream\.(mp4|m3u8|mjpeg)$/, /^\/api\/hls\//];

function createApp(cfg, opts = {}) {
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const dataDir = cfg.dataDir || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const visitorsFile = path.join(dataDir, 'visitors.json');

  const state = {
    camHost: cfg.cam.host && cfg.cam.host !== 'auto' ? cfg.cam.host : '',
    discovery: null,
    go2rtc: { running: false, pid: null, restarts: 0, lastError: '' },
    failures: new Map(), // ip -> {count, until}
    startedAt: Date.now(),
  };

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
  function restartGo2rtc() {
    if (child) { child.removeAllListeners('exit'); child.kill(); child = null; }
    state.go2rtc.running = false;
    startGo2rtc();
  }

  async function resolveCameraHost() {
    if (state.camHost || !cfg.cam.serial || !cfg.cam.pass) return state.camHost;
    log('[cámaras] CAM_HOST=auto → buscando grabador Dahua con serie', cfg.cam.serial.slice(0, 4) + '…');
    const r = await discover({ scan: cfg.cam.scan, httpPort: cfg.cam.httpPort, rtspPort: cfg.cam.rtspPort, user: cfg.cam.user, pass: cfg.cam.pass, serial: cfg.cam.serial, log: (m) => log('[cámaras]', m) });
    state.discovery = { at: new Date().toISOString(), scanned: r.scanned, devices: r.devices.map((d) => ({ host: d.host, type: d.type, match: !!d.match, rtsp: d.rtsp, note: d.auth || d.error })) };
    if (r.found) {
      state.camHost = r.found.host;
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
  async function notify(text, photo) {
    const t = cfg.telegram;
    if (!t.token || !t.chatId) return { sent: false, reason: 'Telegram no configurado' };
    try {
      let r;
      if (photo) {
        const fd = new FormData();
        fd.append('chat_id', t.chatId);
        fd.append('caption', text.slice(0, 1000));
        fd.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'evidencia.jpg');
        r = await fetch(`${t.api}/bot${t.token}/sendPhoto`, { method: 'POST', body: fd });
      } else {
        r = await fetch(`${t.api}/bot${t.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: t.chatId, text }) });
      }
      return { sent: r.ok, status: r.status };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
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
      const source = String(body.source || 'teclado').slice(0, 20);
      let mode = null; let visitor = null;
      if (pin && safeEq(pin, cfg.duressPin)) mode = 'duress';
      else if (pin && safeEq(pin, cfg.doorPin)) mode = 'normal';
      else if (/^\d{6}$/.test(pin)) {
        visitor = activeVisitors().find((v) => safeEq(v.code, pin));
        if (visitor) mode = 'visitor';
      }
      if (!mode) {
        const locked = registerFailure(ip);
        addEvent({ type: 'ACCESS_DENIED', level: 'WARN', message: `PIN incorrecto (${source})`, ip });
        if (locked) {
          addEvent({ type: 'KEYPAD_LOCKOUT', level: 'HIGH', message: 'Teclado bloqueado 60s por 5 intentos fallidos', ip });
          notify(`⚠️ ${cfg.businessName}: 5 PIN incorrectos seguidos. Teclado bloqueado 60s.`);
        }
        return send(res, 403, { ok: false, result: locked ? 'locked' : 'denied', retryIn: locked ? 60 : 0 });
      }
      state.failures.delete(ip);
      const relay = await triggerRelay(body.ms);
      if (mode === 'duress') {
        // Respuesta idéntica a una apertura normal: el agresor no ve diferencias.
        addEvent({ type: 'CRITICAL_DURESS_EVENT', level: 'CRITICAL', message: 'Apertura con PIN de coacción', ip, source });
        (async () => {
          // 1) aviso inmediato, 2) tres fotos del canal 1 (puerta) como evidencia
          await notify(`🚨 COACCIÓN en ${cfg.businessName}. Alguien abrió con el PIN de coacción a las ${new Date().toLocaleTimeString('es-AR')}. Llamá al 911.`);
          for (let i = 0; i < 3; i++) {
            try {
              const photo = await snapshot(1, true);
              addEvent({ type: 'DURESS_PHOTO', level: 'CRITICAL', message: `Foto encubierta ${i + 1}/3 (canal 1)` });
              if (i === 0) await notify(`📷 Evidencia coacción ${cfg.businessName}`, photo);
            } catch { /* sin cámara */ }
            await new Promise((r) => setTimeout(r, 1000));
          }
        })();
      } else {
        addEvent({ type: mode === 'visitor' ? 'VISITOR_ACCESS' : 'DOOR_OPEN', message: mode === 'visitor' ? `Acceso de visita: ${visitor.name}` : `Puerta abierta (${source})`, ip });
      }
      return send(res, 200, { ok: true, result: 'open', relay: { ok: relay.ok, simulated: relay.simulated, ms: relay.ms }, ...(mode === 'visitor' ? { visitor: visitor.name } : {}), _c: mode === 'duress' ? 1 : 0 });
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
      const n = await notify(`${b.emoji || '🔔'} ${cfg.businessName}: ${String(b.message || type).slice(0, 500)}`, photo);
      return send(res, 200, { ok: true, notified: n.sent });
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
        if (!/^\d{6}$/.test(code)) code = String(crypto.randomInt(100000, 999999));
        if (code === cfg.doorPin || code === cfg.duressPin) return send(res, 400, { error: 'Código reservado' });
        const v = { id: crypto.randomUUID(), name: String(b.name || 'Visita').slice(0, 60), code, expires: new Date(Date.now() + hours * 3600e3).toISOString() };
        writeVisitors([...activeVisitors(), v]);
        addEvent({ type: 'VISITOR_CREATED', message: `Pase temporal para ${v.name} (${hours} h)` });
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
      if (!cfg.cam.pass) return send(res, 400, { error: 'Falta CAM_PASS en .env' });
      const prev = state.camHost;
      state.camHost = '';
      await resolveCameraHost();
      if (!state.camHost) state.camHost = prev;
      else if (state.camHost !== prev) restartGo2rtc();
      return send(res, 200, { found: !!state.discovery && state.discovery.devices.some((d) => d.match), discovery: state.discovery });
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
    await new Promise((r) => server.listen(cfg.port, cfg.host, r));
    log(`SVB Seguridad · ${cfg.businessName} → http://localhost:${server.address().port}`);
    return server;
  }
  async function stop() {
    stopping = true;
    if (child) child.kill();
    await new Promise((r) => server.close(r));
  }

  return { server, start, stop, state, go2rtcYaml, addEvent, readEvents, triggerRelay, notify };
}

if (require.main === module) {
  loadEnv(path.join(ROOT, '.env'));
  const app = createApp(readConfig());
  app.start();
  const bye = () => app.stop().finally(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { createApp };
