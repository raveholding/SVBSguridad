'use strict';
/**
 * Accesos del personal (traído del Portero Cannabismática):
 * horario de atención, personas con PIN propio, pases con usos, huella (passkeys verificadas
 * en el servidor), rostro (plantillas comparadas en el servidor), timbre fuera de horario,
 * armado automático y cola de reintento de avisos.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');
const { schedActive, hoursText, normalizeHours, b64u, DEFAULT_HOURS } = require('../lib/access');
const { createNtfy } = require('./fake-ntfy');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
async function req(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const admin = { 'X-Admin-Pin': '1234' };
const at = (day, hh, mm = 0) => { const d = new Date(2026, 10, 1 + day, hh, mm); return d; }; // 1/11/2026 es domingo

test('Horario: franjas, cruce de medianoche y texto', () => {
  const sched = { ...DEFAULT_HOURS.sched, 5: [{ from: '09:00', to: '13:00' }, { from: '22:00', to: '02:00' }], 6: [] };
  assert.strictEqual(schedActive(sched, at(5, 10)), true); // viernes 10:00
  assert.strictEqual(schedActive(sched, at(5, 14)), false); // viernes 14:00
  assert.strictEqual(schedActive(sched, at(5, 23)), true); // viernes 23:00
  assert.strictEqual(schedActive(sched, at(6, 1, 30)), true); // sábado 01:30 (sigue la franja del viernes)
  assert.strictEqual(schedActive(sched, at(6, 3)), false);
  assert.strictEqual(schedActive({ 0: [{ from: '00:00', to: '00:00' }] }, at(0, 15)), true); // 24 h
  assert.match(hoursText({ mode: 'sched', sched: DEFAULT_HOURS.sched }), /Lun a Sáb · 09:00 a 21:00 h/);
  assert.throws(() => normalizeHours({ sched: { 1: [{ from: '25:00', to: '10:00' }] } }), /no válido/);
});

async function boot(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-acc-'));
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0', ...env }), { log: () => {}, envFile: path.join(dataDir, '.env') });
  const srv = await app.start();
  t.after(() => app.stop());
  return { app, port: srv.address().port, dataDir };
}

test('Personas con PIN propio, horario y pases con usos', async (t) => {
  const { app, port, dataDir } = await boot(t);
  const open = (pin) => req(port, 'POST', '/api/door/open', { pin, source: 'teclado' });

  // Alta de personas (solo admin)
  assert.strictEqual((await req(port, 'POST', '/api/people', { name: 'Juan', role: 'Empleado' })).status, 403);
  const juan = (await req(port, 'POST', '/api/people', { name: 'Juan', role: 'Empleado' }, admin)).body;
  const prov = (await req(port, 'POST', '/api/people', { name: 'Distribuidora', role: 'Proveedor' }, admin)).body;
  assert.strictEqual((await req(port, 'PUT', `/api/people/${juan.id}`, { pin: '4321' }, admin)).status, 200);
  assert.strictEqual((await req(port, 'PUT', `/api/people/${prov.id}`, { pin: '4321' }, admin)).body.error, 'Ese PIN ya lo usa otra persona. Elegí otro.');
  assert.match((await req(port, 'PUT', `/api/people/${prov.id}`, { pin: '9999' }, admin)).body.error, /reservado/);
  await req(port, 'PUT', `/api/people/${prov.id}`, { pin: '7777' }, admin);

  // El PIN no se guarda en texto plano y no sale en la API
  const file = fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8');
  assert.ok(!file.includes('4321') && !file.includes('7777'));
  const list = (await req(port, 'GET', '/api/people', null, admin)).body;
  assert.strictEqual(list.people.length, 2);
  assert.ok(!JSON.stringify(list).includes('"s"') && list.people[0].hasPin);

  // Abre con su PIN y queda registrado quién entró
  let r = await open('4321');
  assert.strictEqual(r.body.result, 'open'); assert.strictEqual(r.body.visitor, 'Juan');
  assert.ok(app.readEvents(5).some((e) => /Juan — Empleado/.test(e.message)));

  // Deshabilitado → no entra
  await req(port, 'PUT', `/api/people/${juan.id}`, { on: false }, admin);
  assert.strictEqual((await open('4321')).body.result, 'denied');
  await req(port, 'PUT', `/api/people/${juan.id}`, { on: true }, admin);

  // Pase con 2 usos
  const pass = (await req(port, 'POST', '/api/visitors', { name: 'Coca-Cola', hours: 4, max: 2 }, admin)).body;
  assert.strictEqual(pass.max, 2);
  assert.strictEqual((await open(pass.code)).body.result, 'open');
  assert.strictEqual((await open(pass.code)).body.result, 'open');
  assert.strictEqual((await open(pass.code)).body.result, 'denied'); // agotado

  // Fuera de horario (apagado manual)
  assert.strictEqual((await req(port, 'PUT', '/api/hours', { mode: 'off' }, admin)).status, 200);
  const st = (await req(port, 'GET', '/api/access/info')).body;
  assert.strictEqual(st.open, false); assert.strictEqual(st.text, 'Cerrado temporalmente');
  assert.strictEqual((await open('4321')).body.result, 'open'); // empleado: permitido (staffOff)
  r = await open('7777');
  assert.strictEqual(r.body.result, 'closed'); assert.strictEqual(r.status, 403); // proveedor: no
  const pass2 = (await req(port, 'POST', '/api/visitors', { name: 'Visita', hours: 1 }, admin)).body;
  assert.strictEqual((await open(pass2.code)).body.result, 'closed'); // pases bloqueados
  assert.strictEqual((await open('2580')).body.result, 'open'); // PIN general siempre
  r = await open('9999'); // coacción: igual que el PIN general
  assert.strictEqual(r.body.result, 'open'); assert.strictEqual(r.body._c, 1);
  await req(port, 'PUT', '/api/hours', { staffOff: false }, admin);
  assert.strictEqual((await open('4321')).body.result, 'closed'); // empleado ya no
  assert.ok(app.readEvents(30).some((e) => e.type === 'OFFHOURS_DENIED'));

  // Los PIN de configuración no pueden pisar el de una persona
  const s = await req(port, 'POST', '/api/setup', { DURESS_PIN: '4321' }, admin);
  assert.strictEqual(s.status, 400); assert.match(s.body.error, /persona/);

  // Tarjeta NFC propia (con horario abierto)
  await req(port, 'PUT', '/api/hours', { mode: 'always' }, admin);
  assert.strictEqual((await req(port, 'PUT', `/api/people/${juan.id}`, { nfc: '04:a2:19:7c:11:22:80' }, admin)).body.nfc, '04A2197C112280');
  assert.match((await req(port, 'PUT', `/api/people/${prov.id}`, { nfc: '04a2197c112280' }, admin)).body.error, /otra persona/);
  r = await req(port, 'POST', '/api/door/open', { nfc: '04-A2-19-7C-11-22-80' });
  assert.strictEqual(r.body.result, 'open'); assert.strictEqual(r.body.visitor, 'Juan');
  r = await req(port, 'POST', '/api/door/open', { nfc: '04:00:00:00:00:00:01' });
  assert.strictEqual(r.body.result, 'denied'); assert.match(r.body.reason, /no registrada/);

  // Eliminar borra todo
  assert.strictEqual((await req(port, 'DELETE', `/api/people/${juan.id}`, null, admin)).status, 200);
  assert.strictEqual((await req(port, 'GET', '/api/people', null, admin)).body.people.length, 1);
});

/** Autenticador simulado: arma clientDataJSON y authenticatorData y firma como un celular real. */
function fakeAuthenticator(origin) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = b64u.enc(crypto.randomBytes(32));
  const rpId = new URL(origin).hostname;
  let counter = 0;
  return {
    reg: { id, pub: b64u.enc(publicKey.export({ format: 'der', type: 'spki' })), alg: -7, kind: 'Celular', origin, rpId },
    sign(challenge, { flags = 0x05, originOverride, rpOverride } = {}) {
      const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: originOverride || origin }));
      const ad = Buffer.alloc(37);
      crypto.createHash('sha256').update(rpOverride || rpId).digest().copy(ad, 0);
      ad[32] = flags; ad.writeUInt32BE(++counter, 33);
      const sig = crypto.sign('sha256', Buffer.concat([ad, crypto.createHash('sha256').update(cdj).digest()]), privateKey);
      return { id, clientDataJSON: b64u.enc(cdj), authenticatorData: b64u.enc(ad), signature: b64u.enc(sig) };
    },
  };
}

test('Huella (passkey): registro con consentimiento y verificación en el servidor', async (t) => {
  const { port } = await boot(t);
  const ana = (await req(port, 'POST', '/api/people', { name: 'Ana', role: 'Dueño' }, admin)).body;
  const auth = fakeAuthenticator('https://panel.negocio.ts.net');
  const ch = async () => (await req(port, 'POST', '/api/webauthn/challenge')).body.challenge;
  const open = async (wa) => req(port, 'POST', '/api/door/open', { webauthn: wa });

  // Sin consentimiento no se puede registrar
  let r = await req(port, 'POST', `/api/people/${ana.id}/passkey`, auth.reg, admin);
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /consentimiento/);
  await req(port, 'PUT', `/api/people/${ana.id}`, { consent: true }, admin);
  r = await req(port, 'POST', `/api/people/${ana.id}/passkey`, auth.reg, admin);
  assert.strictEqual(r.status, 201); assert.strictEqual(r.body.pk.length, 1);

  // Desactivada → rechaza aunque la firma sea buena
  assert.strictEqual((await open(auth.sign(await ch()))).body.result, 'denied');
  await req(port, 'PUT', '/api/bio', { pk: true }, admin);
  assert.strictEqual((await req(port, 'GET', '/api/access/info')).body.pk, true);

  // Firma válida → abre y dice quién
  const c1 = await ch();
  r = await open(auth.sign(c1));
  assert.strictEqual(r.body.result, 'open'); assert.strictEqual(r.body.visitor, 'Ana');
  // El desafío es de un solo uso
  assert.strictEqual((await open(auth.sign(c1))).body.result, 'denied');
  // Origen distinto, sin verificación biométrica, dominio distinto o firma de otra clave → rechaza
  assert.strictEqual((await open(auth.sign(await ch(), { originOverride: 'https://evil.example' }))).body.result, 'denied');
  assert.strictEqual((await open(auth.sign(await ch(), { flags: 0x01 }))).body.result, 'denied');
  const other = fakeAuthenticator('https://panel.negocio.ts.net');
  for (let i = 0; i < 9; i++) other.sign('x'); // contador alto: que falle por la firma, no por el contador
  const forged = other.sign(await ch()); forged.id = auth.reg.id;
  r = await open(forged);
  assert.strictEqual(r.body.result, 'denied'); assert.match(r.body.reason, /Firma inválida/);
  r = await open(auth.sign(await ch(), { rpOverride: 'evil.example' }));
  assert.strictEqual(r.body.result, 'locked'); // 5º intento fallido seguido → bloqueo 60 s
});

test('Rostro: plantilla comparada en el servidor, parpadeo y margen entre personas', async (t) => {
  const { port } = await boot(t);
  const rnd = () => Array.from({ length: 128 }, () => Math.random() * 0.2 - 0.1);
  const near = (v, e = 0.01) => v.map((x) => x + (Math.random() * 2 - 1) * e);
  const base = rnd();
  const luis = (await req(port, 'POST', '/api/people', { name: 'Luis', role: 'Empleado' }, admin)).body;
  const prov = (await req(port, 'POST', '/api/people', { name: 'Prov', role: 'Proveedor' }, admin)).body;
  await req(port, 'PUT', `/api/people/${luis.id}`, { consent: true }, admin);
  await req(port, 'PUT', `/api/people/${prov.id}`, { consent: true }, admin);
  assert.match((await req(port, 'POST', `/api/people/${prov.id}/face`, { d: [base, base, base] }, admin)).body.error, /dueños y empleados/);
  const enr = await req(port, 'POST', `/api/people/${luis.id}/face`, { d: [near(base), near(base), near(base), near(base), near(base)] }, admin);
  assert.strictEqual(enr.status, 201); assert.strictEqual(enr.body.face.n, 5);
  assert.ok(!JSON.stringify((await req(port, 'GET', '/api/people', null, admin)).body).includes(String(base[0]).slice(0, 7)), 'la plantilla no se expone');
  await req(port, 'PUT', '/api/bio', { face: true }, admin);

  const open = (d, live = true) => req(port, 'POST', '/api/door/open', { face: { d, live } });
  assert.strictEqual((await open(near(base), false)).body.result, 'denied'); // sin parpadeo
  let r = await open(near(base));
  assert.strictEqual(r.body.result, 'open'); assert.strictEqual(r.body.visitor, 'Luis');
  assert.strictEqual((await open(rnd().map((x) => x * 8))).body.result, 'denied'); // otra cara
  // Retirar el consentimiento borra la plantilla
  r = await req(port, 'PUT', `/api/people/${luis.id}`, { consent: false }, admin);
  assert.strictEqual(r.body.face, null);
});

test('Timbre fuera de horario, armado automático y reintento de avisos', async (t) => {
  const { server: ntfy, msgs } = createNtfy(); const nPort = await listen(ntfy);
  const nUrl = `http://127.0.0.1:${nPort}`;
  t.after(() => ntfy.close());
  const { app, port } = await boot(t, { DOORBELL: '1', DOORBELL_TOPIC: 'svb-test-topic', NTFY_URL: nUrl, PUSH_ENABLED: '1', PUSH_TOPIC: 'own-topic', DOORBELL_COOLDOWN: '0' });

  // Cerrado: el cliente recibe el horario en su celular
  await req(port, 'PUT', '/api/hours', { mode: 'sched', autoArm: true, sched: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } }, admin);
  await new Promise((r) => setTimeout(r, 600));
  await fetch(`${nUrl}/svb-test-topic`, { method: 'POST', body: JSON.stringify({ type: 'ring', id: 'cli1', name: 'Pedro' }) });
  for (let i = 0; i < 40 && !msgs.some((m) => m.topic === 'svb-test-topic-r'); i++) await new Promise((r) => setTimeout(r, 100));
  const reply = msgs.find((m) => m.topic === 'svb-test-topic-r');
  assert.ok(reply, 'debería responder al cliente');
  assert.match(JSON.parse(reply.message).text, /Estamos cerrados/);
  assert.ok(app.readEvents(10).some((e) => e.type === 'DOORBELL_OFFHOURS'));

  // Transición de horario → arma al cerrar y desarma al abrir
  app.access.setHours({ mode: 'always' }); app.tickHours();
  assert.strictEqual(app.state.armed, false);
  app.access.setHours({ mode: 'off' }); app.tickHours();
  assert.strictEqual(app.state.armed, true);
  app.access.setHours({ mode: 'always' }); app.tickHours();
  assert.strictEqual(app.state.armed, false);

  // Sin internet: el aviso de SOS queda en cola y sale con demora cuando vuelve la conexión
  ntfy.close(); ntfy.closeAllConnections();
  await app.alertAll('🚨 Mi Negocio: BOTÓN SOS', null, { kind: 'sos' });
  assert.strictEqual(app.retryQ.length, 1);
  await new Promise((r) => ntfy.listen(nPort, '127.0.0.1', r));
  assert.strictEqual(await app.flushRetry(), 0);
  const late = msgs.filter((m) => m.topic === 'own-topic').pop();
  assert.match(late.message, /enviado con demora/);
});
