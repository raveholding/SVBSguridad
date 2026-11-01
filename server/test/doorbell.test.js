'use strict';
/** Portero digital: celular del cliente → relevo ntfy → servidor → panel + Telegram → respuesta al cliente. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');
const { createNtfy } = require('./fake-ntfy');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('Portero digital por QR/NFC con respuesta desde el panel y desde Telegram', async (t) => {
  const { server: ntfy, msgs } = createNtfy(); const nPort = await listen(ntfy);
  const tgCalls = []; const tgQueue = []; let upd = 100;
  const tg = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c.toString('latin1'); });
    req.on('end', async () => {
      tgCalls.push({ url: req.url, body });
      if (req.url.includes('/getUpdates')) {
        if (!tgQueue.length) await sleep(300);
        return res.end(JSON.stringify({ ok: true, result: tgQueue.splice(0).map((x) => ({ update_id: upd++, ...x })) }));
      }
      res.end('{"ok":true}');
    });
  });
  const tgPort = await listen(tg);
  const espCalls = [];
  const esp = http.createServer((req, res) => { espCalls.push(req.url); res.end('{"ok":true}'); });
  const espPort = await listen(esp);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-bell-'));
  const envFile = path.join(dataDir, '.env');
  const cfg = readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, NTFY_URL: `http://127.0.0.1:${nPort}`, DOORBELL_COOLDOWN: '0',
    TELEGRAM_BOT_TOKEN: 'TK', TELEGRAM_CHAT_ID: '55', TELEGRAM_API: `http://127.0.0.1:${tgPort}`, ESP32_URL: `http://127.0.0.1:${espPort}`, ESP32_TOKEN: 'x' });
  const app = createApp(cfg, { log: () => {}, envFile });
  const port = (await app.start()).address().port;
  t.after(async () => { await app.stop(); ntfy.close(); tg.close(); esp.close(); });
  const admin = { 'X-Admin-Pin': '1234' };
  await sleep(500);

  // Tema secreto generado y guardado; URL pública para el QR
  const env = fs.readFileSync(envFile, 'utf8');
  const topic = (env.match(/DOORBELL_TOPIC=(rave-[0-9a-f]{24})/) || [])[1];
  assert.ok(topic, 'tema secreto en .env');
  const d = await call(port, 'GET', '/api/doorbell', null, admin);
  assert.strictEqual(d.body.connected, true);
  const u = new URL(d.body.url);
  assert.strictEqual(u.origin + u.pathname, 'https://raveholding.github.io/SVBSguridad/timbre.html');
  assert.strictEqual(u.searchParams.get('t'), topic);
  assert.strictEqual((await call(port, 'GET', '/api/doorbell')).status, 403, 'el enlace secreto solo lo ve admin');
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/timbre.html`)).status, 200);

  // SSE del panel
  const got = []; const ctl = new AbortController();
  const live = fetch(`http://127.0.0.1:${port}/api/live`, { signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); const dec = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; got.push(dec.decode(value)); } }).catch(() => {});

  // 1) El cliente toca el timbre desde su celular (publica en ntfy, como hace timbre.html)
  await fetch(`http://127.0.0.1:${nPort}/${topic}`, { method: 'POST', body: JSON.stringify({ type: 'ring', id: 'abc123', name: 'Juan', msg: 'Delivery / pedido' }) });
  await sleep(600);
  assert.match(got.join(''), /event: ring\ndata: .*"id":"abc123".*"name":"Juan"/, 'el panel recibe el timbre');
  const tgRing = tgCalls.find((c) => c.url.includes('sendMessage') && c.body.includes('Tocan el timbre'));
  assert.ok(tgRing, 'aviso a Telegram');
  assert.match(tgRing.body, /callback_data.*r:abc123:voy/, 'con botones de respuesta');

  // 2) Respuesta desde el panel → llega al celular del cliente (tema -r)
  let r = await call(port, 'POST', '/api/doorbell/reply', { id: 'abc123', code: 'voy' });
  assert.strictEqual(r.body.ok, true);
  const reply = msgs.find((m) => m.topic === topic + '-r');
  assert.deepStrictEqual(JSON.parse(reply.message), { type: 'reply', id: 'abc123', code: 'voy', text: 'Ya voy, aguarde un momento 🙂' });
  await sleep(200);
  assert.match(got.join(''), /event: ring-reply/);

  // Abrir puerta desde el panel exige PIN
  r = await call(port, 'POST', '/api/doorbell/reply', { id: 'abc123', code: 'pase', pin: '0000' });
  assert.strictEqual(r.status, 403);
  r = await call(port, 'POST', '/api/doorbell/reply', { id: 'abc123', code: 'pase', pin: '2580' });
  assert.strictEqual(r.body.ok, true);
  assert.ok(espCalls.some((x) => x.startsWith('/open')), 'abre la cerradura');

  // 3) Segundo timbre, respuesta con botón de Telegram del dueño
  await fetch(`http://127.0.0.1:${nPort}/${topic}`, { method: 'POST', body: JSON.stringify({ type: 'ring', id: 'zz9', name: '' }) });
  await sleep(500);
  tgQueue.push({ callback_query: { id: 'cb1', data: 'r:zz9:deje', from: { id: 999 }, message: { chat: { id: 999 } } } }); // extraño: rechazado
  tgQueue.push({ callback_query: { id: 'cb2', data: 'r:zz9:deje', from: { id: 55 }, message: { chat: { id: 55 } } } });
  await sleep(2500);
  const rep2 = msgs.filter((m) => m.topic === topic + '-r').map((m) => JSON.parse(m.message)).find((x) => x.id === 'zz9');
  assert.strictEqual(rep2 && rep2.code, 'deje', 'respuesta desde Telegram llega al cliente');
  assert.ok(tgCalls.some((c) => c.url.includes('answerCallbackQuery') && c.body.includes('No autorizado')), 'rechaza botones de otros chats');

  // 4) Comandos del dueño por Telegram
  tgQueue.push({ message: { chat: { id: 55 }, text: '/armar' } });
  await sleep(2500);
  assert.strictEqual(app.state.armed, true, '/armar desde Telegram');

  // 5) Regenerar el código invalida el QR anterior
  r = await call(port, 'POST', '/api/doorbell/regenerate', null, admin);
  assert.notStrictEqual(new URL(r.body.url).searchParams.get('t'), topic);
  ctl.abort(); await live;
});
