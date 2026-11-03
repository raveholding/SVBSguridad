'use strict';
/** Avisos a los dueños por WhatsApp (CallMeBot) y notificación push (ntfy) con botones de respuesta. */
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

test('WhatsApp de los dueños + push con botones', async (t) => {
  const { server: ntfy, msgs } = createNtfy(); const nPort = await listen(ntfy);
  const wa = [];
  const cmb = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    wa.push({ phone: u.searchParams.get('phone'), text: u.searchParams.get('text'), apikey: u.searchParams.get('apikey') });
    res.end(u.searchParams.get('apikey') === 'badkey' ? 'APIKey is invalid' : 'Message queued. You will receive it in a few seconds.');
  });
  const cPort = await listen(cmb);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-ntf-'));
  const envFile = path.join(dataDir, '.env');
  const app = createApp(readConfig({
    PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, NTFY_URL: `http://127.0.0.1:${nPort}`, CALLMEBOT_API: `http://127.0.0.1:${cPort}`,
    WHATSAPP_TO: '+5493871111111:111111,+5493872222222:222222', DOORBELL_COOLDOWN: '0', DOORBELL_WHATSAPP: '+54 9 387 333-3333', TELEGRAM_POLL: '0',
  }), { log: () => {}, envFile });
  const port = (await app.start()).address().port;
  t.after(async () => { await app.stop(); ntfy.close(); cmb.close(); });
  const admin = { 'X-Admin-Pin': '1234' };
  await sleep(500);

  const env = fs.readFileSync(envFile, 'utf8');
  const own = (env.match(/PUSH_TOPIC=(svb-own-[0-9a-f]{24})/) || [])[1];
  const bellTopic = (env.match(/DOORBELL_TOPIC=(svb-[0-9a-f]{24})/) || [])[1];
  assert.ok(own && bellTopic && own !== bellTopic, 'temas secretos distintos para dueños y clientes');

  // Datos para suscribirse desde la app ntfy
  let r = await call(port, 'GET', '/api/setup', null, admin);
  assert.strictEqual(r.body.push.topic, own);
  assert.strictEqual(r.body.push.link, `ntfy://127.0.0.1:${nPort}/${own}`);
  const waField = r.body.fields.find((f) => f.key === 'WHATSAPP_TO');
  assert.deepStrictEqual(waField.value, [{ phone: '+5493871111111', keySet: true }, { phone: '+5493872222222', keySet: true }], 'no expone las claves');

  // Botón de WhatsApp en la página del cliente
  r = await call(port, 'GET', '/api/doorbell', null, admin);
  assert.strictEqual(new URL(r.body.url).searchParams.get('w'), '5493873333333');

  // Timbre del cliente → WhatsApp a ambos dueños + push con foto/acciones
  await fetch(`http://127.0.0.1:${nPort}/${bellTopic}`, { method: 'POST', body: JSON.stringify({ type: 'ring', id: 'r1', name: 'Ana', msg: 'Proveedor' }) });
  await sleep(800);
  assert.deepStrictEqual(wa.map((x) => x.phone).sort(), ['+5493871111111', '+5493872222222']);
  assert.match(wa[0].text, /Tocan el timbre[\s\S]*Ana[\s\S]*Proveedor/);
  const push = msgs.filter((m) => m.topic === own);
  assert.ok(push.length >= 1, 'notificación push');
  const p = push.at(-1);
  assert.match(p.title, /Tocan el timbre/);
  assert.deepStrictEqual(p.actions.map((a) => a.label), ['Ya voy', 'Un momento', 'Dejar en puerta']);
  assert.strictEqual(p.actions[0].url, `http://127.0.0.1:${nPort}/${own}-c`);

  // El dueño toca "Ya voy" en la notificación → le llega al cliente
  await fetch(p.actions[0].url, { method: 'POST', body: p.actions[0].body });
  await sleep(500);
  const reply = msgs.filter((m) => m.topic === bellTopic + '-r').map((m) => JSON.parse(m.message)).find((x) => x.id === 'r1');
  assert.strictEqual(reply && reply.code, 'voy');
  // "pase" (abrir puerta) NUNCA se acepta desde la notificación
  await fetch(p.actions[0].url, { method: 'POST', body: JSON.stringify({ type: 'reply', id: 'r1', code: 'pase' }) });
  await sleep(400);
  assert.ok(!msgs.some((m) => m.topic === bellTopic + '-r' && m.message.includes('"pase"')));

  // Filtro "solo timbre" para WhatsApp: una alarma no va por WhatsApp
  await call(port, 'POST', '/api/setup', { WHATSAPP_EVENTS: 'timbre' }, admin);
  wa.length = 0;
  await call(port, 'POST', '/api/alert', { type: 'TAMPER_ALERT', message: 'Cámara tapada' });
  await sleep(300);
  assert.strictEqual(wa.length, 0);
  assert.ok(msgs.filter((m) => m.topic === own).some((m) => `${m.title} ${m.message}`.includes('Cámara tapada')), 'push sí recibe todo');

  // Editar la lista conservando claves (":*") y agregar uno nuevo
  r = await call(port, 'POST', '/api/setup', { WHATSAPP_TO: '+5493871111111:*,+5493874444444:444444' }, admin);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.match(fs.readFileSync(envFile, 'utf8'), /WHATSAPP_TO=\+5493871111111:111111,\+5493874444444:444444/);
  assert.strictEqual((await call(port, 'POST', '/api/setup', { WHATSAPP_TO: '3871111111' }, admin)).status, 400, 'sin clave → error claro');

  // Prueba de todos los canales, con resultado por número
  await call(port, 'POST', '/api/setup', { WHATSAPP_TO: '+5493871111111:*,+5493875555555:badkey' }, admin);
  r = await call(port, 'POST', '/api/check/notify', null, admin);
  assert.deepStrictEqual(r.body.whatsapp.map((x) => x.ok), [true, false], 'informa qué número falló');
  assert.ok(r.body.whatsapp[1].phone.endsWith('5555'));
  assert.strictEqual(r.body.push.ok, true);
});
