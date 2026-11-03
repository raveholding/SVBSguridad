'use strict';
/**
 * Inventario multi-marca: alta por ONVIF (con un grabador ONVIF simulado que valida WS-Security de verdad),
 * por marca (plantilla Hikvision/Dahua), por URL RTSP; canales en la grilla y en go2rtc; PTZ por ONVIF;
 * claves cifradas; asistente de instalación.
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
const { blocks, first, ptzVector, withCredentials } = require('../lib/onvif-client');
const { templateUrl } = require('../lib/devices');
const { fakeOnvif } = require('./fake-onvif');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'svb-dev-'));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function call(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Pin': '1234', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}

test('Utilidades ONVIF y plantillas por marca', () => {
  assert.deepStrictEqual(blocks('<a:Profiles token="x"><b:Name>N</b:Name></a:Profiles><Profiles token="y"/>', 'Profiles').map((b) => b.attrs.trim()), ['token="x"', 'token="y"']);
  assert.strictEqual(first('<tt:Uri>rtsp://h/a?x=1&amp;y=2</tt:Uri>', 'Uri'), 'rtsp://h/a?x=1&y=2');
  assert.deepStrictEqual(ptzVector('LeftUp', 4), { x: -0.5, y: 0.5 }); assert.deepStrictEqual(ptzVector('ZoomWide', 8), { zoom: -1 });
  assert.strictEqual(withCredentials('rtsp://10.0.0.5:554/live', 'admin', 'c@ve'), 'rtsp://admin:c%40ve@10.0.0.5:554/live');
  assert.strictEqual(templateUrl('hikvision', { host: '10.0.0.9', user: 'admin', pass: 'x', channel: 3 }), 'rtsp://admin:x@10.0.0.9:554/Streaming/Channels/301');
  assert.strictEqual(templateUrl('hikvision', { host: '10.0.0.9', user: 'admin', pass: 'x', channel: 3, sub: true }), 'rtsp://admin:x@10.0.0.9:554/Streaming/Channels/302');
  assert.strictEqual(templateUrl('dahua', { host: 'h', user: 'u', pass: 'p', channel: 2, sub: true }), 'rtsp://u:p@h:554/cam/realmonitor?channel=2&subtype=1');
});

test('Agregar equipos de cualquier marca: ONVIF, plantilla y RTSP; grilla, go2rtc, PTZ y cifrado', async (t) => {
  const { srv, calls } = fakeOnvif();
  const op = await listen(srv);
  const dir = tmp();
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0', SECRETS_ENCRYPT: '1', WIZARD_AUTO: '1' }), { log: () => {}, envFile: path.join(dir, '.env') });
  await app.start();
  t.after(async () => { await app.stop(); srv.close(); });
  const port = app.server.address().port;

  let st = (await call(port, 'GET', '/api/status')).body;
  assert.strictEqual(st.cameras.configured, false, 'sin equipos todavía');
  // Clave incorrecta
  let r = await call(port, 'POST', '/api/v1/devices/probe', { host: '127.0.0.1', port: op, user: 'admin', pass: 'mal' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.denied, true); assert.match(r.body.error, /contraseña/);
  // Consulta sin agregar
  r = await call(port, 'POST', '/api/v1/devices/probe', { host: '127.0.0.1', port: op, user: 'admin', pass: 'clave-onvif' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.info.manufacturer, 'Hikvision');
  assert.strictEqual(r.body.channels.length, 2, 'agrupa perfiles por fuente de video');
  assert.strictEqual(r.body.channels[0].resolution, '1920x1080', 'principal = mayor resolución');
  assert.match(r.body.channels[0].sub, /Channels\/102/, 'secundario = menor resolución');
  assert.ok(!JSON.stringify(r.body).includes('clave-onvif'), 'no devuelve la clave');
  assert.ok(calls.some((c) => c.op === 'GetSystemDateAndTime'), 'ajusta la diferencia de reloj');
  // Alta por ONVIF
  r = await call(port, 'POST', '/api/v1/devices', { mode: 'onvif', host: '127.0.0.1', port: op, user: 'admin', pass: 'clave-onvif', name: 'NVR depósito' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const nvr = r.body;
  assert.deepStrictEqual(nvr.channels.map((c) => c.ch), [17, 18]);
  assert.strictEqual(nvr.channels[0].ptz, true); assert.strictEqual(nvr.channels[1].ptz, false);
  assert.strictEqual((await call(port, 'POST', '/api/v1/devices', { mode: 'onvif', host: '127.0.0.1', port: op, user: 'admin', pass: 'clave-onvif' })).status, 400, 'no duplica');
  // Por marca (sin ONVIF) y por URL
  r = await call(port, 'POST', '/api/v1/devices', { vendor: 'dahua', host: '192.168.1.108', user: 'admin', pass: 'dh', count: 2, name: 'XVR Dahua' });
  assert.deepStrictEqual(r.body.channels.map((c) => c.ch), [19, 20]);
  assert.strictEqual(r.body.channels[1].url, 'rtsp://192.168.1.108:554/cam/realmonitor?channel=2&subtype=0', 'la vista no muestra credenciales');
  r = await call(port, 'POST', '/api/v1/devices', { host: '192.168.1.70', url: 'rtsp://192.168.1.70:554/h264Preview_01_main', user: 'admin', pass: 'reo', name: 'Reolink patio' });
  const reo = r.body;
  assert.strictEqual(reo.channels[0].ch, 21);
  // Grilla del panel y go2rtc
  st = (await call(port, 'GET', '/api/status')).body;
  assert.strictEqual(st.cameras.configured, true);
  assert.deepStrictEqual(st.cameras.channels.map((c) => c.ch), [17, 18, 19, 20, 21], 'sin grabador principal solo aparecen los del inventario');
  let yaml = app.go2rtcYaml();
  assert.match(yaml, /svb_ch17: "rtsp:\/\/admin:clave-onvif@127\.0\.0\.1:554\/Streaming\/Channels\/102/);
  assert.match(yaml, /svb_ch17_hd: "rtsp:\/\/admin:clave-onvif@127\.0\.0\.1:554\/Streaming\/Channels\/101/);
  assert.match(yaml, /svb_ch20: "rtsp:\/\/admin:dh@192\.168\.1\.108:554\/cam\/realmonitor\?channel=2&subtype=1"/);
  assert.match(yaml, /svb_ch21_hd: "rtsp:\/\/admin:reo@192\.168\.1\.70:554\/h264Preview_01_main"/);
  // Las claves quedan cifradas en disco
  const disk = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8');
  assert.ok(!disk.includes('clave-onvif') && !disk.includes('"dh"'), 'claves cifradas');
  assert.match(disk, /enc:v1:/);
  // PTZ por ONVIF
  r = await call(port, 'POST', '/api/ptz', { ch: 17, code: 'LeftUp', speed: 4 });
  assert.strictEqual(r.body.onvif, true, JSON.stringify(r.body));
  const mv = calls.find((c) => c.op === 'ContinuousMove');
  assert.match(mv.body, /ProfileToken>Main1</); assert.match(mv.body, /PanTilt x="-0\.5" y="0\.5"/); assert.strictEqual(mv.path, '/onvif/PTZ');
  await call(port, 'POST', '/api/ptz', { ch: 17, code: 'LeftUp', action: 'stop' });
  assert.ok(calls.some((c) => c.op === 'Stop'));
  assert.strictEqual((await call(port, 'POST', '/api/ptz', { ch: 18, code: 'Up' })).status, 400, 'canal sin motor');
  // Renombrar y deshabilitar
  r = await call(port, 'PATCH', `/api/v1/devices/${nvr.id}`, { channels: [{ ch: 18, enabled: false }, { ch: 17, name: 'Domo entrada' }] });
  assert.strictEqual(r.body.channels[0].name, 'Domo entrada');
  yaml = app.go2rtcYaml();
  assert.ok(!/svb_ch18/.test(yaml), 'canal deshabilitado fuera de go2rtc');
  assert.strictEqual((await call(port, 'GET', '/api/status')).body.cameras.channels.find((c) => c.ch === 17).name, 'Domo entrada');
  // Lista (permiso read) y baja
  assert.strictEqual((await call(port, 'GET', '/api/v1/devices')).body.length, 3);
  assert.strictEqual((await call(port, 'POST', '/api/v1/devices', { vendor: 'dahua', host: 'x', count: 1 }, { 'X-Admin-Pin': '0000' })).status, 403);
  await call(port, 'DELETE', `/api/v1/devices/${reo.id}`);
  assert.ok(!/svb_ch21/.test(app.go2rtcYaml()));
  const ev = app.readEvents(50).map((e) => e.type);
  assert.ok(ev.includes('DEVICE_ADDED') && ev.includes('DEVICE_REMOVED'));
  // Asistente de instalación
  r = await call(port, 'GET', '/api/v1/wizard');
  assert.deepStrictEqual([r.body.done, r.body.checks.camaras, r.body.checks.pins, r.body.checks.negocio], [false, true, false, true]);
  r = await call(port, 'POST', '/api/v1/wizard', { done: true });
  assert.strictEqual(r.body.done, true);
});

test('Instalaciones existentes: WIZARD_AUTO=0 evita que el asistente se abra solo', async (t) => {
  const dir = tmp();
  const app = createApp(readConfig({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0', WIZARD_AUTO: '0' }), { log: () => {}, envFile: path.join(dir, '.env') });
  await app.start();
  t.after(() => app.stop());
  const r = await call(app.server.address().port, 'GET', '/api/v1/wizard');
  assert.strictEqual(r.body.done, true, 'no se abre solo');
  assert.strictEqual(readConfig({}).wizardAuto, false, 'en RAVE no se abre solo por defecto');
});
