'use strict';
/**
 * Pruebas de integración del servidor puente.
 *  - Simula un grabador Dahua (HTTP Digest + número de serie) para el autodescubrimiento.
 *  - Simula el ESP32 de la cerradura y la API de Telegram.
 *  - Si hay go2rtc + ffmpeg disponibles, levanta un "grabador falso" RTSP y verifica video real.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');
const dahua = require('../lib/dahua');
const { discover } = require('../lib/discover');

const SERIAL = 'TESTSERIAL0001';
const USER = 'admin';
const PASS = 'clave-de-prueba';

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Grabador Dahua simulado con Digest auth real. */
function fakeDahua() {
  const realm = 'Login to TEST'; const nonce = crypto.randomBytes(8).toString('hex');
  return http.createServer((req, res) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="abc"` });
      return res.end();
    }
    const p = dahua.parseDigest(h.slice(7));
    const ha1 = md5(`${USER}:${realm}:${PASS}`); const ha2 = md5(`GET:${p.uri}`);
    const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    if (p.response !== expected || p.username !== USER) { res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"` }); return res.end(); }
    if (req.url.includes('getSerialNo')) { res.end(`sn=${SERIAL}\r\n`); return; }
    if (req.url.includes('getDeviceType')) { res.end('type=DH-XVR5104HS\r\n'); return; }
    res.writeHead(404); res.end();
  });
}

function fakeEsp32(calls) {
  return http.createServer((req, res) => {
    calls.push({ url: req.url, token: req.headers['x-token'] });
    if (req.headers['x-token'] !== 'tok') { res.writeHead(401); return res.end(); }
    res.end('{"ok":true}');
  });
}

function fakeTelegram(calls) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { calls.push({ url: req.url, body: Buffer.concat(chunks).toString('latin1') }); res.end('{"ok":true}'); });
  });
}

async function req(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : ct.includes('image') ? Buffer.from(await r.arrayBuffer()) : await r.text() };
}

test('Digest + lectura de número de serie Dahua', async () => {
  const d = fakeDahua(); const port = await listen(d);
  const ok = await dahua.getSerial({ host: '127.0.0.1', port, user: USER, pass: PASS });
  assert.deepStrictEqual(ok, { ok: true, serial: SERIAL });
  const bad = await dahua.getSerial({ host: '127.0.0.1', port, user: USER, pass: 'mal' });
  assert.strictEqual(bad.ok, false);
  d.close();
});

test('URL RTSP Dahua y ocultamiento de contraseñas', () => {
  const u = dahua.rtspUrl({ user: 'admin', pass: 'p@ss#1', host: '192.168.1.20', channel: 2, subtype: 1 });
  assert.strictEqual(u, 'rtsp://admin:p%40ss%231@192.168.1.20:554/cam/realmonitor?channel=2&subtype=1');
  assert.ok(!dahua.redact(u).includes('p%40ss'));
});

test('Autodescubrimiento encuentra el grabador por número de serie', async () => {
  const d = fakeDahua(); const port = await listen(d);
  const r = await discover({ scan: '127.0.0.1', httpPort: port, rtspPort: 1, user: USER, pass: PASS, serial: SERIAL.toLowerCase() });
  assert.ok(r.found, 'debería encontrarlo');
  assert.strictEqual(r.found.host, '127.0.0.1');
  assert.strictEqual(r.found.type, 'DH-XVR5104HS');
  d.close();
});

test('API: puerta, coacción, visitas, bloqueo, seguridad de archivos', async (t) => {
  const espCalls = []; const tgCalls = [];
  const esp = fakeEsp32(espCalls); const espPort = await listen(esp);
  const tg = fakeTelegram(tgCalls); const tgPort = await listen(tg);
  const d = fakeDahua(); const dPort = await listen(d);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-'));
  const cfg = readConfig({
    PORT: '0', HOST: '127.0.0.1', CAM_SERIAL: SERIAL, CAM_PASS: PASS, CAM_SCAN: '127.0.0.1', CAM_HTTP_PORT: String(dPort), CAM_RTSP_PORT: '1',
    ESP32_URL: `http://127.0.0.1:${espPort}`, ESP32_TOKEN: 'tok', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', TELEGRAM_API: `http://127.0.0.1:${tgPort}`,
    GO2RTC_DISABLED: '1', DATA_DIR: dataDir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0',
  });
  const app = createApp(cfg, { log: () => {}, envFile: path.join(dataDir, '.env') });
  const srv = await app.start();
  const port = srv.address().port;
  t.after(async () => { await app.stop(); esp.close(); tg.close(); d.close(); });

  // Autodescubrimiento al arrancar → yaml de go2rtc con la IP encontrada
  assert.strictEqual(app.state.camHost, '127.0.0.1');
  const yaml = app.go2rtcYaml();
  assert.match(yaml, /svb_ch1: "rtsp:\/\/admin:clave-de-prueba@127\.0\.0\.1:1\/cam\/realmonitor\?channel=1&subtype=1"/);
  assert.match(yaml, /svb_ch4_hd:/);

  // Estado público sin credenciales
  const st = await req(port, 'GET', '/api/status');
  assert.strictEqual(st.status, 200);
  assert.ok(!JSON.stringify(st.body).includes(PASS));
  assert.ok(!JSON.stringify(st.body).includes(SERIAL));
  assert.strictEqual(st.body.cameras.channels.length, 4);

  // Archivos sensibles no se sirven
  fs.writeFileSync(path.join(__dirname, '..', '..', '.env.testprobe'), 'X=1');
  for (const p of ['/.env', '/.env.testprobe', '/server/server.js', '/data/events.jsonl', '/assets/../.env.testprobe', '/go2rtc/api/config', '/go2rtc/api/streams']) {
    const r = await req(port, 'GET', p);
    assert.ok([403, 404].includes(r.status), `${p} debería estar bloqueado (fue ${r.status})`);
  }
  fs.unlinkSync(path.join(__dirname, '..', '..', '.env.testprobe'));
  assert.strictEqual((await req(port, 'GET', '/')).status, 200);

  // PIN normal → relé ESP32
  let r = await req(port, 'POST', '/api/door/open', { pin: '2580', ms: 1500 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.result, 'open');
  assert.strictEqual(r.body.relay.simulated, false);
  assert.strictEqual(espCalls.at(-1).url, '/open?ms=1500');
  assert.strictEqual(espCalls.at(-1).token, 'tok');

  // PIN de coacción → misma respuesta visible + evento crítico + Telegram
  r = await req(port, 'POST', '/api/door/open', { pin: '9999' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.result, 'open');
  await new Promise((res) => setTimeout(res, 300));
  const admin = { 'X-Admin-Pin': '1234' };
  let ev = await req(port, 'GET', '/api/events', null, admin);
  assert.ok(ev.body.some((e) => e.type === 'CRITICAL_DURESS_EVENT' && e.level === 'CRITICAL'));
  assert.ok(tgCalls.some((c) => c.url === '/botT/sendMessage' && c.body.includes('COACCI')), 'alerta Telegram de coacción');

  // Eventos requieren PIN admin
  assert.strictEqual((await req(port, 'GET', '/api/events')).status, 403);

  // Pase de visita temporal
  const v = await req(port, 'POST', '/api/visitors', { name: 'Proveedor Coca', hours: 2 }, admin);
  assert.strictEqual(v.status, 201);
  assert.match(v.body.code, /^\d{6}$/);
  r = await req(port, 'POST', '/api/door/open', { pin: v.body.code, source: 'qr' });
  assert.strictEqual(r.body.visitor, 'Proveedor Coca');
  await req(port, 'DELETE', `/api/visitors?id=${v.body.id}`, null, admin);
  r = await req(port, 'POST', '/api/door/open', { pin: v.body.code });
  assert.strictEqual(r.status, 403);

  // Fuerza bruta → bloqueo 60 s + aviso
  let last;
  for (let i = 0; i < 5; i++) last = await req(port, 'POST', '/api/door/open', { pin: '0000' });
  assert.strictEqual(last.body.result, 'locked');
  r = await req(port, 'POST', '/api/door/open', { pin: '2580' });
  assert.strictEqual(r.status, 429, 'bloqueado incluso con PIN correcto');
  app.state.failures.clear();

  // Alerta SOS con foto adjunta → sendPhoto
  const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  r = await req(port, 'POST', '/api/alert', { type: 'SOS_911', message: 'SOS', snapshot: jpg, emoji: '🚨' });
  assert.strictEqual(r.body.notified, true);
  assert.ok(tgCalls.some((c) => c.url === '/botT/sendPhoto'));

  // Prueba de relé desde admin
  r = await req(port, 'POST', '/api/relay/test', { ms: 50 }, admin);
  assert.strictEqual(r.body.ms, 100, 'mínimo 100 ms');
  r = await req(port, 'POST', '/api/relay/test', { ms: 99999 }, admin);
  assert.strictEqual(r.body.ms, 10000, 'máximo 10000 ms');

  // Log persistido en disco
  ev = await req(port, 'GET', '/api/events?limit=500', null, admin);
  ['CAMERA_DISCOVERED', 'DOOR_OPEN', 'VISITOR_ACCESS', 'KEYPAD_LOCKOUT', 'SOS_911', 'RELAY_TEST'].forEach((type) => assert.ok(ev.body.some((e) => e.type === type), `falta ${type}`));
});

test('Basic auth del panel cuando PANEL_USER/PANEL_PASS están definidos', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-'));
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', PANEL_USER: 'svb', PANEL_PASS: 'secreto', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, DOORBELL: '0', PUSH_ENABLED: '0' }), { log: () => {} });
  const port = (await app.start()).address().port;
  t.after(() => app.stop());
  assert.strictEqual((await req(port, 'GET', '/api/health')).status, 401);
  const auth = { Authorization: 'Basic ' + Buffer.from('svb:secreto').toString('base64') };
  assert.strictEqual((await req(port, 'GET', '/api/health', null, auth)).status, 200);
});

// ───── Video real de punta a punta (requiere go2rtc + ffmpeg) ─────
const GO2RTC = process.env.GO2RTC_BIN || path.join(__dirname, '..', 'bin', 'go2rtc');
let hasFfmpeg = true;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

test('Video: grabador RTSP falso → go2rtc → snapshot y WebSocket por el servidor', { skip: !(fs.existsSync(GO2RTC) && hasFfmpeg) && 'go2rtc/ffmpeg no disponibles' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-fake-'));
  const fakeConf = path.join(tmp, 'fake.yaml');
  const rtspPort = 18600 + Math.floor(Math.random() * 300);
  fs.writeFileSync(fakeConf, `api:\n  listen: "127.0.0.1:${rtspPort + 1000}"\nrtsp:\n  listen: "127.0.0.1:${rtspPort}"\nwebrtc:\n  listen: ""\nstreams:\n${[1, 2].map((c) => `  fake${c}: "ffmpeg:virtual?video&size=640x360#video=h264"`).join('\n')}\n`);
  const fake = spawn(GO2RTC, ['-config', fakeConf], { stdio: 'ignore' });
  const apiPort = rtspPort + 2000;
  const app = createApp(readConfig({
    PORT: '0', HOST: '127.0.0.1', CAM_HOST: '127.0.0.1', CAM_PASS: 'x', CAM_CHANNELS: '2', CAM_RTSP_PORT: String(rtspPort),
    CAM_RTSP_TEMPLATE: 'rtsp://{user}:{pass}@{host}:{port}/fake{channel}', CAM_PLAYBACK_TEMPLATE: 'rtsp://{host}:{port}/fake{channel}?s={start}', GO2RTC_BIN: GO2RTC, GO2RTC_API: `127.0.0.1:${apiPort}`, GO2RTC_WEBRTC_PORT: String(apiPort + 1), DATA_DIR: tmp, DOORBELL: '0', PUSH_ENABLED: '0',
  }), { log: () => {} });
  const port = (await app.start()).address().port;
  t.after(async () => { await app.stop(); fake.kill(); });
  await new Promise((r) => setTimeout(r, 2500));

  let snap;
  for (let i = 0; i < 10; i++) {
    snap = await req(port, 'GET', '/api/snapshot/1');
    if (snap.status === 200) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.strictEqual(snap.status, 200, 'snapshot del canal 1');
  assert.strictEqual(snap.body[0], 0xff); assert.strictEqual(snap.body[1], 0xd8);
  assert.ok(snap.body.length > 2000, 'JPEG con contenido');

  const js = await req(port, 'GET', '/go2rtc/video-stream.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.body, /VideoStream|video-stream/);

  // Handshake WebSocket a través del proxy
  const ws = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/go2rtc/api/ws?src=svb_ch1', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
    r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    r.on('response', (res) => resolve(res.statusCode));
    r.on('error', reject);
    r.end();
  });
  assert.strictEqual(ws, 101);

  const st = await req(port, 'GET', '/api/status');
  assert.strictEqual(st.body.cameras.go2rtc.running, true);

  // Reproducción de grabaciones: stream dinámico svb_pb
  const pb = await req(port, 'POST', '/api/playback', { ch: 2, start: '2026-11-01T10:00', minutes: 30 });
  assert.strictEqual(pb.body.stream, 'svb_pb');
  let frame;
  for (let i = 0; i < 8; i++) { frame = await req(port, 'GET', '/go2rtc/api/frame.jpeg?src=svb_pb'); if (frame.status === 200) break; await new Promise((r) => setTimeout(r, 1000)); }
  assert.strictEqual(frame.status, 200, 'imagen de la reproducción');
  assert.strictEqual((await req(port, 'DELETE', '/api/playback')).body.ok, true);
});
