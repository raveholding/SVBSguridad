'use strict';
/**
 * Seguridad del servidor: fuerza bruta del PIN de administración (cualquier ruta), bloqueo global,
 * contraseña del panel, DNS rebinding, CSRF, encabezados de seguridad, límite de avisos,
 * y video portero en modo servidor (la foto del aviso es la cara del visitante).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');
const { createNtfy } = require('./fake-ntfy');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'svb-sec-'));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function raw(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
    });
    req.on('error', reject); req.end(data);
  });
}
async function boot(t, env = {}) {
  const dir = tmp();
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0', ...env }), { log: () => {}, envFile: path.join(dir, '.env') });
  await app.start(); t.after(() => app.stop());
  return { app, port: app.server.address().port };
}

test('El PIN de administración no se puede adivinar por ninguna ruta', async (t) => {
  const { app, port } = await boot(t);
  for (let i = 0; i < 5; i++) assert.strictEqual((await raw(port, 'GET', '/api/setup', { headers: { 'X-Admin-Pin': String(1000 + i) } })).status, 403);
  // Bloqueado: ni el PIN correcto entra desde esa IP durante 60 s
  assert.strictEqual((await raw(port, 'GET', '/api/setup', { headers: { 'X-Admin-Pin': '1234' } })).status, 403);
  assert.strictEqual((await raw(port, 'GET', '/api/v1/tokens', { headers: { 'X-Admin-Pin': '1234' } })).status, 403);
  assert.strictEqual((await raw(port, 'POST', '/api/door/open', { body: { pin: '2580' } })).status, 429, 'tampoco la puerta');
  assert.ok(app.readEvents(20).filter((e) => e.type === 'ADMIN_DENIED').length >= 5);
});

test('Bloqueo global ante intentos desde muchas IPs', async (t) => {
  const { app, port } = await boot(t);
  // 30 intentos fallidos en 10 minutos (se limpia el bloqueo por IP para simular IPs distintas)
  for (let i = 0; i < 30; i++) { app.state.failures.delete('127.0.0.1'); await raw(port, 'GET', '/api/setup', { headers: { 'X-Admin-Pin': '0001' } }); }
  app.state.failures.delete('127.0.0.1');
  const r = await raw(port, 'POST', '/api/door/open', { body: { pin: '2580' } });
  assert.strictEqual(r.status, 429, 'bloqueo global aunque la IP esté limpia');
  assert.ok(app.readEvents(80).some((e) => e.type === 'GLOBAL_LOCKOUT'));
});

test('Contraseña del panel con bloqueo por intentos', async (t) => {
  const { port } = await boot(t, { PANEL_USER: 'dueno', PANEL_PASS: 'clave-larga' });
  const bad = { Authorization: 'Basic ' + Buffer.from('dueno:mala').toString('base64') };
  const good = { Authorization: 'Basic ' + Buffer.from('dueno:clave-larga').toString('base64') };
  for (let i = 0; i < 5; i++) assert.strictEqual((await raw(port, 'GET', '/api/status', { headers: bad })).status, 401);
  assert.strictEqual((await raw(port, 'GET', '/api/status', { headers: good })).status, 401, 'bloqueada tras 5 intentos');
});

test('DNS rebinding, CSRF y encabezados de seguridad', async (t) => {
  const { app, port } = await boot(t);
  // Host de un dominio externo (rebinding) → rechazado
  assert.strictEqual((await raw(port, 'GET', '/api/status', { headers: { Host: 'atacante.com' } })).status, 421);
  assert.strictEqual((await raw(port, 'GET', '/api/status', { headers: { Host: 'oficina-pc' } })).status, 200, 'nombre de la PC');
  assert.strictEqual((await raw(port, 'GET', '/api/status', { headers: { Host: 'panel.mi-red.ts.net' } })).status, 200, 'Tailscale');
  assert.strictEqual((await raw(port, 'GET', '/api/status', { headers: { Host: '192.168.1.50:8080' } })).status, 200);
  // Otro sitio intenta abrir la puerta o mandar avisos desde el navegador del panel → bloqueado
  let r = await raw(port, 'POST', '/api/door/open', { headers: { Origin: 'https://sitio-malicioso.com' }, body: { pin: '2580' } });
  assert.strictEqual(r.status, 403);
  r = await raw(port, 'POST', '/api/alert', { headers: { Origin: 'https://sitio-malicioso.com' }, body: { type: 'SOS', message: 'falso' } });
  assert.strictEqual(r.status, 403);
  assert.ok(app.readEvents(10).some((e) => e.type === 'CSRF_BLOCKED'));
  // Mismo origen → permitido
  r = await raw(port, 'POST', '/api/door/open', { headers: { Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` }, body: { pin: '2580' } });
  assert.strictEqual(r.status, 200);
  // Encabezados
  r = await raw(port, 'GET', '/index.html');
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
});

test('Límite de avisos y eventos sin PIN', async (t) => {
  const { port } = await boot(t);
  let last;
  for (let i = 0; i < 14; i++) last = await raw(port, 'POST', '/api/alert', { body: { type: 'TEST_SPAM', message: 'x' } });
  assert.strictEqual(last.status, 429);
});

test('Video portero con servidor: el aviso lleva la cara del visitante y el panel recibe la señalización', async (t) => {
  const { server: ntfy } = createNtfy(); const nPort = await listen(ntfy); const nUrl = `http://127.0.0.1:${nPort}`;
  t.after(() => ntfy.close());
  const tg = []; const tgSrv = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { tg.push({ url: req.url, body: Buffer.concat(c) }); res.end('{"ok":true,"result":[]}'); }); });
  const tgPort = await listen(tgSrv); t.after(() => tgSrv.close());
  const { port } = await boot(t, { DOORBELL: '1', DOORBELL_TOPIC: 'svb-video-topic', NTFY_URL: nUrl, DOORBELL_COOLDOWN: '0', TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_CHAT_ID: '9', TELEGRAM_API: `http://127.0.0.1:${tgPort}` });
  // Panel escuchando eventos
  const ctl = new AbortController(); let sse = '';
  fetch(`http://127.0.0.1:${port}/api/live`, { signal: ctl.signal }).then(async (res) => { const rd = res.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; sse += Buffer.from(value).toString(); } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  // El celular del visitante: timbre con video + foto en partes por el tema propio del timbre
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('CARA-DEL-VISITANTE'.repeat(400))]);
  const data = 'data:image/jpeg;base64,' + jpeg.toString('base64');
  const parts = data.match(/.{1,3000}/g);
  await fetch(`${nUrl}/svb-video-topic`, { method: 'POST', body: JSON.stringify({ type: 'ring', id: 'vis123', name: 'Ana', video: true }) });
  for (let i = 0; i < parts.length; i++) await fetch(`${nUrl}/svb-video-topic-vvis123`, { method: 'POST', body: JSON.stringify({ type: 'sig', id: 'vis123', kind: 'photo', i, n: parts.length, d: parts[i] }) });
  let photo = null;
  for (let i = 0; i < 80 && !photo; i++) { await new Promise((r) => setTimeout(r, 100)); photo = tg.find((x) => x.url.includes('sendPhoto')); }
  ctl.abort();
  assert.ok(photo, 'Telegram recibe foto');
  assert.ok(photo.body.includes(Buffer.from('CARA-DEL-VISITANTE')), 'la foto es la del celular del visitante, no la de la cámara de la puerta');
  assert.match(sse, /event: ring\ndata: .*"video":true.*"sig":"svb-video-topic-vvis123"/);
  assert.ok(!/"sig":"svb-video-topic"[,}]/.test(sse), 'no expone el tema principal');
});
