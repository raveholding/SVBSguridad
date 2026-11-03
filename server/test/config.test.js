'use strict';
/** Centro de configuración: todo el .env editable desde el panel + ajustes compartidos entre dispositivos. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
async function call(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('Configuración total desde el panel', async (t) => {
  const esp = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, door: 'cerrada', ip: '192.168.100.60' })); });
  const espPort = await listen(esp);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-cfg-'));
  const envFile = path.join(dataDir, '.env');
  fs.writeFileSync(envFile, '# mi config\r\nCAM_USER=admin\r\n');
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, DOORBELL: '0', TELEGRAM_POLL: '0' }), { log: () => {}, envFile });
  const port = (await app.start()).address().port;
  t.after(async () => { await app.stop(); esp.close(); });
  const admin = { 'X-Admin-Pin': '1234' };

  // Esquema completo, sin secretos
  let r = await call(port, 'GET', '/api/setup', null, admin);
  const keys = r.body.fields.map((f) => f.key);
  ['BUSINESS_NAME', 'DOOR_PIN', 'PANEL_USER', 'CAM_HOST', 'CAM_SERIAL', 'CAM_PASS', 'CAM_CHANNELS', 'CAM_NAMES', 'ESP32_URL', 'ESP32_TOKEN', 'RELAY_MS', 'TELEGRAM_POLL', 'DOORBELL', 'DOORBELL_CAMERA'].forEach((k) => assert.ok(keys.includes(k), `falta ${k}`));
  assert.ok(r.body.groups.length >= 6);
  const pass = r.body.fields.find((f) => f.key === 'CAM_PASS');
  assert.ok(!('value' in pass) && pass.isSet === false, 'secretos no se devuelven');
  assert.ok(!('value' in r.body.fields.find((f) => f.key === 'DOOR_PIN')), 'PINs no se devuelven');
  assert.deepStrictEqual(r.body.defaultPins, { door: true, duress: true, admin: true });

  // Validaciones
  assert.strictEqual((await call(port, 'POST', '/api/setup', { CAM_CHANNELS: 40 }, admin)).body.field, 'CAM_CHANNELS');
  assert.strictEqual((await call(port, 'POST', '/api/setup', { RELAY_MS: 50 }, admin)).status, 400);
  assert.strictEqual((await call(port, 'POST', '/api/setup', { ESP32_URL: 'ftp://x' }, admin)).status, 400);
  assert.strictEqual((await call(port, 'POST', '/api/setup', { CAM_HOST: 'a b;rm' }, admin)).status, 400);
  assert.strictEqual((await call(port, 'POST', '/api/setup', { PANEL_USER: 'svb' }, admin)).body.field, 'PANEL_PASS', 'usuario sin contraseña');

  // Guardar varios grupos a la vez y aplicar en caliente
  r = await call(port, 'POST', '/api/setup', {
    BUSINESS_NAME: 'Mi Negocio Centro', ESP32_URL: `http://127.0.0.1:${espPort}`, ESP32_TOKEN: 'clave-esp', RELAY_MS: 4500,
    CAM_SERIAL: 'ABC123', CAM_CHANNELS: 8, DVR_ALERT_COOLDOWN: 30, DOORBELL_CAMERA: 2, TELEGRAM_POLL: false, CAM_EVENTS: false, NOEXISTE: 'x',
  }, admin);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^# mi config\r\nCAM_USER=admin\r\n/, 'respeta el archivo y sus saltos de línea');
  assert.match(env, /BUSINESS_NAME=Mi Negocio Centro\r\n/);
  assert.match(env, /RELAY_MS=4500/); assert.match(env, /TELEGRAM_POLL=0/); assert.match(env, /CAM_EVENTS=0/); assert.match(env, /CAM_CHANNELS=8/);
  assert.ok(!env.includes('NOEXISTE'));
  const st = await call(port, 'GET', '/api/status');
  assert.strictEqual(st.body.business, 'Mi Negocio Centro');
  assert.strictEqual(st.body.door.relay, 'esp32');
  assert.strictEqual(st.body.door.relayMs, 4500);
  assert.strictEqual(st.body.cameras.channels.length, 8);
  r = await call(port, 'GET', '/api/setup', null, admin);
  assert.strictEqual(r.body.fields.find((f) => f.key === 'ESP32_TOKEN').isSet, true);
  assert.strictEqual(r.body.fields.find((f) => f.key === 'TELEGRAM_POLL').value, false);

  // Prueba de conexión con el ESP32
  r = await call(port, 'POST', '/api/check/esp32', null, admin);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.info.door, 'cerrada');

  // Vaciar un campo permitido (volver a cerradura simulada)
  r = await call(port, 'POST', '/api/setup', { ESP32_URL: '' }, admin);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call(port, 'GET', '/api/status')).body.door.relay, 'simulado');
  // Campos obligatorios vacíos se ignoran (no borran)
  r = await call(port, 'POST', '/api/setup', { CAM_USER: '', BUSINESS_NAME: 'Negocio' }, admin);
  assert.deepStrictEqual(r.body.saved, ['BUSINESS_NAME']);

  // Proteger el panel con usuario y contraseña → exige Basic auth al instante
  r = await call(port, 'POST', '/api/setup', { PANEL_USER: 'svb', PANEL_PASS: 'secreta' }, admin);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call(port, 'GET', '/api/health')).status, 401);
  const auth = { ...admin, Authorization: 'Basic ' + Buffer.from('svb:secreta').toString('base64') };
  assert.strictEqual((await call(port, 'GET', '/api/health', null, auth)).status, 200);
  r = await call(port, 'POST', '/api/setup', { PANEL_USER: '', PANEL_PASS: '' }, auth);
  assert.strictEqual((await call(port, 'GET', '/api/health')).status, 200, 'se puede volver a quitar');

  // Ajustes del panel compartidos entre dispositivos (sin PINs)
  assert.strictEqual((await call(port, 'PUT', '/api/panel-settings', { settings: { biz: 'X' } })).status, 403);
  r = await call(port, 'PUT', '/api/panel-settings', { device: 'tablet', settings: { biz: 'Negocio', familyPhone: '+5493871234567', chime: 3, camOrder: [2, 1, 3, 4], doorPin: '1111', server: 'http://x' } }, admin);
  assert.strictEqual(r.body.v, 1);
  r = await call(port, 'GET', '/api/panel-settings');
  assert.strictEqual(r.body.settings.familyPhone, '+5493871234567');
  assert.deepStrictEqual(r.body.settings.camOrder, [2, 1, 3, 4]);
  assert.ok(!('doorPin' in r.body.settings) && !('server' in r.body.settings), 'PINs y ajustes del dispositivo no se comparten');
  assert.strictEqual(r.body.by, 'tablet');

  // Log sin secretos
  const log = await call(port, 'GET', '/api/events?limit=500', null, admin);
  assert.ok(log.body.filter((e) => e.type === 'CONFIG_CHANGED').every((e) => !/secreta|clave-esp/.test(e.message)));
});

test('Buscar y vincular la cerradura ESP32 automáticamente', async (t) => {
  // ESP32 simulado con la misma API que el firmware
  let token = ''; const opens = [];
  const esp = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/status') return res.end(JSON.stringify({ ok: true, device: 'svb-puerta', id: 'A1B2', paired: !!token, door: 'cerrada' }));
      if (req.url === '/pair' && req.method === 'POST') { if (token) { res.statusCode = 409; return res.end('{"ok":false,"error":"ya vinculada"}'); } token = body.trim(); return res.end('{"ok":true}'); }
      if (req.url.startsWith('/open')) { if (req.headers['x-token'] !== token) { res.statusCode = 401; return res.end('{}'); } opens.push(req.url); return res.end('{"ok":true}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  const espPort = await listen(esp);
  process.env.ESP32_SCAN_PORT = String(espPort);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-esp-'));
  const envFile = path.join(dataDir, '.env');
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0' }), { log: () => {}, envFile });
  const port = (await app.start()).address().port;
  t.after(async () => { await app.stop(); esp.close(); delete process.env.ESP32_SCAN_PORT; });
  const admin = { 'X-Admin-Pin': '1234' };

  let r = await call(port, 'POST', '/api/esp32/discover', { scan: '127.0.0.1' }, admin);
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
  assert.strictEqual(r.body.url, `http://127.0.0.1:${espPort}`);
  assert.strictEqual(token.length, 48, 'clave segura generada');
  assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`ESP32_TOKEN=${token}`));
  // La puerta abre con la clave vinculada
  r = await call(port, 'POST', '/api/door/open', { pin: '2580', ms: 2000 });
  assert.strictEqual(r.body.relay.ok, true);
  assert.deepStrictEqual(opens, ['/open?ms=2000']);
  // Volver a buscar: ya vinculada a este sistema
  r = await call(port, 'POST', '/api/esp32/discover', { scan: '127.0.0.1' }, admin);
  assert.match(r.body.message, /ya está vinculada/);
  assert.strictEqual((await call(port, 'POST', '/api/esp32/discover', { scan: '127.0.0.1' })).status, 403);
});
