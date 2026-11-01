'use strict';
/**
 * Pruebas de las funciones tipo DMSS: eventos del grabador (push), armado, PTZ,
 * información del equipo, reproducción y configuración desde el panel (.env).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');
const { parseDigest } = require('../lib/dahua');
const { parseEvents } = require('../lib/dahua-events');

const USER = 'admin'; const PASS = 'clave'; const SERIAL = 'SERIE123';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDvr(calls) {
  const realm = 'R'; const nonce = 'n0nce';
  return http.createServer((req, res) => {
    const h = req.headers.authorization || '';
    const p = h.startsWith('Digest ') ? parseDigest(h.slice(7)) : null;
    const ok = p && p.response === md5(`${md5(`${USER}:${realm}:${PASS}`)}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${md5(`GET:${p.uri}`)}`);
    if (!ok) { res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"` }); return res.end(); }
    calls.push(req.url);
    if (req.url.includes('eventManager.cgi')) {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary' });
      const evs = ['Code=VideoMotion;action=Start;index=1', 'Code=VideoMotion;action=Stop;index=1', 'Code=VideoBlind;action=Start;index=0', 'Code=NewFile;action=Pulse;index=0'];
      let i = 0;
      const t = setInterval(() => {
        const e = evs[i++ % evs.length];
        res.write(`--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${e.length}\r\n\r\n${e}\r\n\r\n`);
      }, 150);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (req.url.includes('getSerialNo')) return res.end(`sn=${SERIAL}\r\n`);
    if (req.url.includes('getDeviceType')) return res.end('type=DH-XVR1A04\r\n');
    if (req.url.includes('getSoftwareVersion')) return res.end('version=4.001.0000000.1\r\n');
    if (req.url.includes('storageDevice.cgi')) return res.end('list.info[0].Detail[0].TotalBytes=1000204886016\r\nlist.info[0].Detail[0].UsedBytes=850000000000\r\nlist.info[0].Detail[0].IsError=false\r\n');
    if (req.url.includes('ptz.cgi')) return res.end('OK\r\n');
    res.writeHead(404); res.end();
  });
}
function fakeTelegram(calls, { withChat = true } = {}) {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c.toString('latin1'); });
    req.on('end', () => {
      calls.push({ url: req.url, body });
      if (req.url.endsWith('/getUpdates')) return res.end(JSON.stringify({ ok: true, result: withChat ? [{ message: { chat: { id: 777, first_name: 'Nico' } } }] : [] }));
      res.end('{"ok":true}');
    });
  });
}
async function call(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('parseEvents interpreta el formato Dahua', () => {
  const e = parseEvents('--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=CrossRegionDetection;action=Start;index=2;data={\n   "Name" : "Zona1"\n}\r\n--myboundary\r\nCode=VideoLoss;action=Stop;index=0\r\n');
  assert.deepStrictEqual(e.map((x) => [x.code, x.action, x.index]), [['CrossRegionDetection', 'Start', 2], ['VideoLoss', 'Stop', 0]]);
});

test('Funciones DMSS: eventos push, armado, PTZ, equipo, reproducción, configuración', async (t) => {
  const dvrCalls = []; const tgCalls = [];
  const dvr = fakeDvr(dvrCalls); const dvrPort = await listen(dvr);
  const tg = fakeTelegram(tgCalls); const tgPort = await listen(tg);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-dvr-'));
  const envFile = path.join(dataDir, '.env');
  fs.writeFileSync(envFile, 'CAM_USER=admin\nCAM_PASS=clave\nDOOR_PIN=2580\n');
  const cfg = readConfig({ PORT: '0', HOST: '127.0.0.1', CAM_HOST: 'auto', CAM_SERIAL: SERIAL, CAM_PASS: PASS, CAM_SCAN: '127.0.0.1', CAM_HTTP_PORT: String(dvrPort), CAM_RTSP_PORT: '1',
    GO2RTC_DISABLED: '1', DATA_DIR: dataDir, TELEGRAM_API: `http://127.0.0.1:${tgPort}`, DVR_ALERT_COOLDOWN: '0', DOORBELL: '0', TELEGRAM_POLL: '0' });
  const app = createApp(cfg, { log: () => {}, envFile });
  const port = (await app.start()).address().port;
  t.after(async () => { await app.stop(); dvr.close(); tg.close(); });
  const admin = { 'X-Admin-Pin': '1234' };

  // Recuerda la IP encontrada para el próximo arranque
  assert.match(fs.readFileSync(envFile, 'utf8'), /CAM_LAST_HOST=127\.0\.0\.1/);

  // SSE: el panel recibe eventos del grabador en vivo
  const got = [];
  const ctl = new AbortController();
  const live = fetch(`http://127.0.0.1:${port}/api/live`, { signal: ctl.signal }).then(async (r) => {
    const rd = r.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read(); if (done) break; got.push(dec.decode(value)); }
  }).catch(() => {});
  await sleep(1200);
  const stream = got.join('');
  assert.match(stream, /event: hello/);
  assert.match(stream, /event: dvr\ndata: .*"code":"VideoMotion".*"channel":2/);
  assert.ok(!/NewFile/.test(stream), 'ignora eventos internos');

  let ev = await call(port, 'GET', '/api/dvr/events');
  assert.ok(ev.body.some((e) => e.code === 'VideoBlind' && e.channel === 1 && e.label.includes('sabotaje')));

  // Configurar Telegram desde el panel con solo el token (detecta el chat)
  let r = await call(port, 'POST', '/api/setup/telegram', { token: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ12345' }, admin);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.name, 'Nico');
  assert.match(fs.readFileSync(envFile, 'utf8'), /TELEGRAM_CHAT_ID=777/);
  assert.ok(tgCalls.some((c) => c.url.includes('sendMessage') && c.body.includes('777')));

  // Desarmado: el movimiento NO avisa al celular; el sabotaje SÍ
  tgCalls.length = 0;
  await sleep(1000);
  assert.ok(!tgCalls.some((c) => c.body.includes('Movimiento')), 'sin aviso de movimiento con sistema desarmado');
  assert.ok(tgCalls.some((c) => c.body.includes('sabotaje')), 'sabotaje avisa siempre');

  // Armar con PIN incorrecto → rechazado; con PIN de puerta → armado y avisos de movimiento
  r = await call(port, 'POST', '/api/arm', { armed: true, pin: '0000' });
  assert.strictEqual(r.status, 403);
  r = await call(port, 'POST', '/api/arm', { armed: true, pin: '2580' });
  assert.strictEqual(r.body.armed, true);
  tgCalls.length = 0;
  await sleep(1000);
  assert.ok(tgCalls.some((c) => c.body.includes('Movimiento') && c.body.includes('ARMADO')), 'armado avisa movimiento');
  assert.match(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), /"armed":true/);
  assert.match(stream + got.join(''), /event: arm/);
  await call(port, 'POST', '/api/arm', { armed: false, pin: '2580' });

  // Información del equipo y disco
  r = await call(port, 'GET', '/api/device', null, admin);
  assert.strictEqual(r.body.model, 'DH-XVR1A04');
  assert.strictEqual(r.body.firmware, '4.001.0000000.1');
  assert.strictEqual(r.body.disks[0].totalGB, 1000.2);
  assert.strictEqual((await call(port, 'GET', '/api/device')).status, 403);

  // PTZ
  r = await call(port, 'POST', '/api/ptz', { ch: 2, code: 'Left', action: 'start', speed: 5 });
  assert.strictEqual(r.body.ok, true);
  assert.ok(dvrCalls.some((u) => u.includes('ptz.cgi?action=start&channel=2&code=Left&arg1=0&arg2=5')));
  assert.strictEqual((await call(port, 'POST', '/api/ptz', { ch: 1, code: 'rm -rf' })).status, 400);

  // Configuración desde el panel: PINs, contraseña del grabador, nombres
  r = await call(port, 'POST', '/api/setup', { DOOR_PIN: '4455', DURESS_PIN: '4455' }, admin);
  assert.strictEqual(r.status, 400, 'puerta y coacción no pueden ser iguales');
  r = await call(port, 'POST', '/api/setup', { DOOR_PIN: '12' }, admin);
  assert.strictEqual(r.status, 400);
  r = await call(port, 'POST', '/api/setup', { DOOR_PIN: '4455', DURESS_PIN: '7788', ADMIN_PIN: '9090', CAM_NAMES: 'Entrada,Caja,Depósito,Calle', HACK: 'x' }, admin);
  assert.strictEqual(r.status, 200);
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /DOOR_PIN=4455/); assert.match(env, /DURESS_PIN=7788/); assert.match(env, /ADMIN_PIN=9090/);
  assert.match(env, /CAM_USER=admin/, 'conserva lo existente');
  assert.ok(!env.includes('HACK'), 'solo claves permitidas');
  assert.strictEqual((await call(port, 'POST', '/api/door/open', { pin: '4455' })).body.result, 'open', 'PIN nuevo vale al instante');
  assert.strictEqual((await call(port, 'POST', '/api/door/open', { pin: '2580' })).status, 403, 'PIN viejo ya no vale');
  assert.strictEqual((await call(port, 'GET', '/api/setup', null, admin)).status, 403, 'el PIN admin viejo ya no vale');
  const st = await call(port, 'GET', '/api/status');
  assert.strictEqual(st.body.cameras.channels[0].name, 'Entrada');
  const log = await call(port, 'GET', '/api/events?limit=500', null, { 'X-Admin-Pin': '9090' });
  const cfgEv = log.body.find((e) => e.type === 'CONFIG_CHANGED');
  assert.ok(cfgEv && !cfgEv.message.includes('4455'), 'el log no muestra PINs');
  ctl.abort(); await live;
});
