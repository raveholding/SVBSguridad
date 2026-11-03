'use strict';
/**
 * Sistemas VB Seguridad v2 — pruebas de la plataforma multi-sector:
 * cifrado AES-256, ONVIF WS-Discovery, analítica (filtro rural, EPP, caídas, patentes), API v1 con tokens,
 * aforo, escenas, geocercas, webhooks firmados, MQTT + Home Assistant + Frigate y vigilante de video.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { readConfig } = require('../lib/env');
const { Vault } = require('../lib/vault');
const { parseProbeMatch, wsDiscover, parseArp, vendorFromMac, suggestUrl } = require('../lib/onvif');
const { parsePackets, packet, str, topicMatch } = require('../lib/mqtt');
const { verify } = require('../lib/webhooks');
const { AnalyticsEngine, fromDahua, fromFrigate, fromApi } = require('../lib/analytics');
const { canonPlate, plateFormat, haversine } = require('../lib/platform');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'svbv2-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function call(port, method, p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const ADMIN = { 'X-Admin-Pin': '1234' };
const baseEnv = (dataDir, extra = {}) => ({ PORT: '0', HOST: '127.0.0.1', GO2RTC_DISABLED: '1', DATA_DIR: dataDir, DOORBELL: '0', TELEGRAM_POLL: '0', PUSH_ENABLED: '0', DVR_ALERT_COOLDOWN: '0', ...extra });

const PROBE_MATCH = `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><wsa:EndpointReference><wsa:Address>urn:uuid:4d454930-0000-1000-8000-bcad28aabbcc</wsa:Address></wsa:EndpointReference>
<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/Profile/T onvif://www.onvif.org/name/HIKVISION%20DS-2CD2143G2 onvif://www.onvif.org/hardware/DS-2CD2143G2-I onvif://www.onvif.org/location/city/Salta</d:Scopes>
<d:XAddrs>http://127.0.0.1:8899/onvif/device_service</d:XAddrs><d:MetadataVersion>10</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

test('Bóveda AES-256-GCM: cifra, detecta alteraciones, migra el .env y protege access.json', async (t) => {
  const dir = tmp();
  const v = new Vault({ dataDir: dir });
  const c = v.encrypt('clave-del-grabador');
  assert.match(c, /^enc:v1:/);
  assert.notStrictEqual(v.encrypt('x'), v.encrypt('x'), 'IV aleatorio');
  assert.strictEqual(v.decrypt(c), 'clave-del-grabador');
  assert.strictEqual(v.decrypt('texto plano'), 'texto plano', 'compatible con valores viejos');
  const bad = c.slice(0, -4) + (c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => v.decrypt(bad), 'GCM detecta modificación');
  assert.strictEqual(fs.statSync(path.join(dir, 'master.key')).mode & 0o777, 0o600);
  const other = new Vault({ key: 'ab'.repeat(32) });
  assert.throws(() => other.decrypt(c), 'otra clave no descifra');

  // Activar el cifrado desde el panel: migra los secretos del .env y cifra las personas
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'CAM_USER=admin\nCAM_PASS=secreta123\nESP32_TOKEN=tok\nWHATSAPP_TO=+5493871111111:1234\nBUSINESS_NAME=Negocio\n');
  const app = createApp(readConfig(baseEnv(dir)), { log: () => {}, envFile });
  await app.start(); t.after(() => app.stop());
  const port = app.server.address().port;
  let r = await call(port, 'POST', '/api/people', { name: 'Nico', role: 'Dueño' }, ADMIN);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  r = await call(port, 'PUT', `/api/people/${r.body.id}`, { pin: '4321' }, ADMIN);
  assert.strictEqual(r.body.hasPin, true);
  r = await call(port, 'POST', '/api/setup', { SECRETS_ENCRYPT: true }, ADMIN);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /CAM_PASS=enc:v1:/); assert.match(env, /ESP32_TOKEN=enc:v1:/); assert.match(env, /WHATSAPP_TO=enc:v1:/);
  assert.match(env, /CAM_USER=admin/, 'lo que no es secreto queda legible');
  assert.ok(!env.includes('secreta123'));
  assert.match(fs.readFileSync(path.join(dir, 'access.json'), 'utf8'), /^enc:v1:/, 'plantillas y PINs cifrados');
  const env2 = {}; env.split('\n').forEach((l) => { const m = l.match(/^(\w+)=(.*)$/); if (m) env2[m[1]] = m[2]; });
  new Vault({ dataDir: dir }).decryptEnv(env2);
  assert.strictEqual(env2.CAM_PASS, 'secreta123');
  // Un secreto nuevo se guarda cifrado
  r = await call(port, 'POST', '/api/setup', { WEBHOOK_SECRET: 'firma-123' }, ADMIN);
  assert.match(fs.readFileSync(envFile, 'utf8'), /WEBHOOK_SECRET=enc:v1:/);
  // El PIN de la persona sigue funcionando y el archivo cifrado se vuelve a leer
  assert.strictEqual((await call(port, 'POST', '/api/door/open', { pin: '4321' })).body.result, 'open');
  const { AccessStore } = require('../lib/access');
  const again = new AccessStore(path.join(dir, 'access.json'), { vault: new Vault({ dataDir: dir }), encrypt: true });
  assert.strictEqual(again.people[0].name, 'Nico');
  assert.throws(() => new AccessStore(path.join(dir, 'access.json')), /clave maestra/);
});

test('ONVIF WS-Discovery, ARP y huella de fabricante', async (t) => {
  const m = parseProbeMatch(PROBE_MATCH);
  assert.strictEqual(m.host, '127.0.0.1'); assert.strictEqual(m.port, 8899);
  assert.strictEqual(m.name, 'HIKVISION DS-2CD2143G2'); assert.strictEqual(m.hardware, 'DS-2CD2143G2-I');
  assert.deepStrictEqual(m.profiles, ['S', 'T']);
  assert.strictEqual(parseProbeMatch('<x/>'), null);
  // Cámara ONVIF simulada que responde al Probe por UDP
  const cam = dgram.createSocket('udp4');
  await new Promise((r) => cam.bind(0, '127.0.0.1', r));
  let probe = '';
  cam.on('message', (msg, rinfo) => { probe = msg.toString(); cam.send(Buffer.from(PROBE_MATCH), rinfo.port, rinfo.address); });
  t.after(() => cam.close());
  const found = await wsDiscover({ timeout: 800, target: { address: '127.0.0.1', port: cam.address().port } });
  assert.match(probe, /NetworkVideoTransmitter/); assert.match(probe, /discovery\/Probe/);
  assert.strictEqual(found.length, 1, 'deduplica las dos respuestas');
  assert.strictEqual(found[0].uuid, '4d454930-0000-1000-8000-bcad28aabbcc');
  // ARP Linux y Windows
  const arp = parseArp('IP address HW type Flags HW address Mask Device\n192.168.1.108 0x1 0x2 3c:ef:8c:12:34:56 * wlan0\n192.168.1.1 0x1 0x0 00:00:00:00:00:00 * wlan0\n  192.168.1.64          bc-ad-28-01-02-03     dinámico\n');
  assert.deepStrictEqual(arp.map((a) => a.ip), ['192.168.1.108', '192.168.1.64']);
  assert.strictEqual(vendorFromMac(arp[0].mac), 'dahua'); assert.strictEqual(vendorFromMac(arp[1].mac), 'hikvision');
  assert.strictEqual(suggestUrl({ ip: '192.168.1.64', vendor: 'hikvision', ports: [554] }), 'rtsp://{user}:{pass}@192.168.1.64:554/Streaming/Channels/101');
  assert.strictEqual(suggestUrl({ ip: '10.0.0.9', vendor: null, onvif: { port: 8899 }, ports: [80] }), 'onvif://{user}:{pass}@10.0.0.9:8899');
});

test('Analítica: filtro rural, clima, persistencia, EPP, caídas, velocidad y normalizadores', () => {
  const cfg = { sector: 'campo', minConf: 0.55, ruralFilter: false, persistN: 2, persistS: 10, speedLimit: 20, crowdMin: 8, armed: true };
  const e = new AnalyticsEngine(() => cfg);
  const T = 1_000_000;
  assert.strictEqual(e.evaluate({ kind: 'animal', label: 'cow', camera: 'Tranquera', confidence: 0.9 }, T).filtered, 'fauna');
  assert.strictEqual(e.evaluate({ kind: 'person', label: 'person', camera: 'Tranquera', confidence: 0.3 }, T + 10).filtered, 'baja confianza');
  assert.strictEqual(e.evaluate({ kind: 'person', label: 'person', camera: 'Galpón', confidence: 0.7 }, T + 20).filtered, 'confirmando');
  const r = e.evaluate({ kind: 'person', label: 'person', camera: 'Galpón', confidence: 0.72 }, T + 3000);
  assert.strictEqual(r.type, 'INTRUSION'); assert.strictEqual(r.notify, true);
  assert.strictEqual(e.evaluate({ kind: 'vehicle', label: 'car', camera: 'Lote 4', confidence: 0.95 }, T + 4000).type, 'INTRUSION', 'confianza muy alta no espera confirmación');
  // Ráfaga de detecciones dudosas = viento / lluvia / vegetación
  let storm = null;
  for (let i = 0; i < 12; i++) { const x = e.evaluate({ kind: 'person', camera: 'Alambrado', confidence: 0.56 }, T + 5000 + i * 1000); if (x.type === 'ANALYTICS_NOISE') storm = x; }
  assert.ok(storm, 'detecta ruido climático'); assert.strictEqual(storm.notify, false);
  assert.strictEqual(e.evaluate({ kind: 'person', camera: 'Alambrado', confidence: 0.8 }, T + 30000).filtered, 'clima/vegetación');
  assert.ok(e.stats.byReason.fauna >= 1);
  // Industria
  cfg.sector = 'industria';
  assert.strictEqual(e.evaluate({ kind: 'ppe', camera: 'Planta', missing: [], confidence: 0.9 }, T).filtered, 'epp completo');
  const ppe = e.evaluate(fromApi({ kind: 'ppe', camera: 'Planta', zone: 'Soldadura', missing: ['helmet', 'chaleco'], confidence: 88 }), T);
  assert.strictEqual(ppe.type, 'PPE_MISSING'); assert.match(ppe.message, /casco, chaleco/); assert.match(ppe.message, /88%/);
  assert.strictEqual(e.evaluate({ kind: 'fall', camera: 'Depósito', confidence: 0.8 }, T).type, 'FALL_DETECTED');
  assert.strictEqual(e.evaluate({ kind: 'speed', camera: 'Playa', speed: 15, confidence: 0.9 }, T).filtered, 'velocidad normal');
  assert.match(e.evaluate({ kind: 'speed', camera: 'Playa', speed: 42, plate: 'AB123CD', confidence: 0.9 }, T).message, /42 km\/h.*AB123CD/);
  assert.strictEqual(e.evaluate({ kind: 'fire', camera: 'Galpón', confidence: 0.9 }, T).level, 'CRITICAL');
  assert.throws(() => fromApi({ kind: 'cualquiera' }), /kind inválido/);
  // Dahua ANPR (TrafficJunction) y SMD
  const d = fromDahua({ code: 'TrafficJunction', channel: 2, label: 'TrafficJunction', data: '{\n "TrafficCar": {"PlateNumber":"AB 123 CD","Speed":30,"VehicleColor":"Blanco"},\n "Object":{"Confidence":92}\n}' }, 'Portón');
  assert.strictEqual(d.kind, 'plate'); assert.strictEqual(d.plate, 'AB 123 CD'); assert.strictEqual(d.confidence, 0.92); assert.strictEqual(d.speed, 30);
  assert.strictEqual(fromDahua({ code: 'SmartMotionHuman', channel: 1 }, 'Puerta').kind, 'person');
  assert.strictEqual(fromDahua({ code: 'VideoMotion', channel: 1 }, 'Puerta'), null, 'movimiento simple sigue el camino de siempre');
  // Frigate: solo el evento nuevo, y la patente la primera vez que aparece
  const seen = new Set();
  assert.strictEqual(fromFrigate({ type: 'new', after: { id: 'a1', camera: 'entrada', label: 'car', top_score: 0.81 } }, seen).kind, 'vehicle');
  assert.strictEqual(fromFrigate({ type: 'update', after: { id: 'a1', camera: 'entrada', label: 'car' } }, seen), null);
  assert.strictEqual(fromFrigate({ type: 'update', after: { id: 'a1', camera: 'entrada', label: 'car', recognized_license_plate: ['AE456FG', 0.9] } }, seen).plate, 'AE456FG');
  assert.strictEqual(fromFrigate({ type: 'new', after: { id: 'a2', label: 'person', false_positive: true } }, seen), null);
  // Patentes argentinas y confusiones de OCR
  assert.strictEqual(plateFormat('AB123CD'), 'mercosur'); assert.strictEqual(plateFormat('ABC123'), 'ar-1995'); assert.strictEqual(plateFormat('A123BCD'), 'moto');
  assert.strictEqual(canonPlate('A8I23CO'), canonPlate('AB123C0'));
  assert.ok(Math.abs(haversine({ lat: -24.7821, lng: -65.4232 }, { lat: -24.7821, lng: -65.4122 }) - 1111) < 15);
  assert.ok(topicMatch('frigate/+', 'frigate/events') && topicMatch('a/#', 'a/b/c') && !topicMatch('a/+', 'a/b/c'));
});

test('API v1: tokens con permisos, aforo, escenas, pánico, patentes, geocercas, stream y descubrimiento', async (t) => {
  const dir = tmp();
  let relayCalls = 0;
  const esp = http.createServer((req, res) => { if (req.url.startsWith('/open')) relayCalls++; res.end('{"ok":true}'); });
  const espPort = await listen(esp);
  const tg = []; const tgSrv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { tg.push(req.url + ' ' + b); res.end('{"ok":true,"result":[]}'); }); });
  const tgPort = await listen(tgSrv);
  const app = createApp(readConfig(baseEnv(dir, { PANEL_USER: 'svb', PANEL_PASS: 'secreto', ESP32_URL: `http://127.0.0.1:${espPort}`, ESP32_TOKEN: 'x', TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_CHAT_ID: '9', TELEGRAM_API: `http://127.0.0.1:${tgPort}`, OCCUPANCY_MAX: '3', PLATE_AUTO_OPEN: '1', SECTOR: 'industria' })), { log: () => {}, envFile: path.join(dir, '.env') });
  await app.start();
  t.after(async () => { await app.stop(); esp.close(); tgSrv.close(); });
  const port = app.server.address().port;
  const basic = { Authorization: 'Basic ' + Buffer.from('svb:secreto').toString('base64') };
  const A = { ...basic, ...ADMIN };

  assert.strictEqual((await call(port, 'GET', '/api/v1/status')).status, 401, 'panel protegido');
  let r = await call(port, 'GET', '/api/v1', null, basic);
  assert.strictEqual(r.body.product, 'Sistemas VB Seguridad'); assert.strictEqual(r.body.developer.email, 'vincularbusiness@gmail.com');
  r = await call(port, 'GET', '/api/v1/openapi.json', null, basic);
  assert.strictEqual(r.body.openapi, '3.0.3'); assert.ok(r.body.paths['/api/v1/analytics/events'].post);
  // Tokens
  assert.strictEqual((await call(port, 'POST', '/api/v1/tokens', { name: 'ERP', scopes: ['read'] }, basic)).status, 403, 'solo admin crea tokens');
  const readTok = (await call(port, 'POST', '/api/v1/tokens', { name: 'ERP', scopes: ['read'] }, A)).body;
  const ctlTok = (await call(port, 'POST', '/api/v1/tokens', { name: 'Home Assistant', scopes: ['read', 'control'] }, A)).body;
  const ingTok = (await call(port, 'POST', '/api/v1/tokens', { name: 'Jetson campo', scopes: 'ingest' }, A)).body;
  assert.match(readTok.token, /^svb_/);
  const list = (await call(port, 'GET', '/api/v1/tokens', null, A)).body;
  assert.strictEqual(list.length, 3); assert.ok(!JSON.stringify(list).includes(readTok.token), 'el token no se vuelve a mostrar');
  assert.ok(!fs.readFileSync(path.join(dir, 'platform.json'), 'utf8').includes(readTok.token), 'en disco solo el hash');
  const B = (tk) => ({ Authorization: `Bearer ${tk.token}` });
  r = await call(port, 'GET', '/api/v1/status', null, B(readTok));
  assert.strictEqual(r.status, 200, 'el token entra aunque el panel tenga usuario y contraseña');
  assert.strictEqual(r.body.sector, 'industria'); assert.strictEqual(r.body.occupancy.max, 3);
  assert.strictEqual((await call(port, 'POST', '/api/v1/arm', { armed: true }, B(readTok))).status, 401, 'read no puede armar');
  assert.strictEqual((await call(port, 'GET', '/api/status', null, B(readTok))).status, 401, 'el token no abre la API interna');
  assert.strictEqual((await call(port, 'GET', '/api/v1/status', null, { Authorization: 'Bearer svb_falsofalsofalsofalsofalso' })).status, 401);
  r = await call(port, 'GET', '/api/v1/health', null, B(readTok));
  assert.ok(r.body.components.video && r.body.components.mqtt);

  // Stream SSE (API v1) recibe los eventos de auditoría
  const ctl = new AbortController(); let streamTxt = '';
  fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: B(readTok), signal: ctl.signal }).then(async (res) => { const rd = res.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; streamTxt += Buffer.from(value).toString(); } }).catch(() => {});
  await sleep(200);

  // Escenas
  r = await call(port, 'POST', '/api/v1/scenes/noche', {}, B(ctlTok));
  assert.deepStrictEqual([r.body.armed, r.body.night], [true, true]);
  assert.strictEqual((await call(port, 'POST', '/api/v1/scenes/llegada', { pin: '0000' }, basic)).status, 403);
  r = await call(port, 'POST', '/api/v1/scenes/llegada', { pin: '2580' }, basic);
  assert.strictEqual(r.body.armed, false);
  assert.strictEqual((await call(port, 'POST', '/api/v1/scenes/inventada', {}, B(ctlTok))).status, 400);
  assert.strictEqual((await call(port, 'GET', `/api/v1/status?token=${readTok.token}`, null, basic)).status, 401, 'token por URL solo en telemetría');
  const nAlerts = tg.length;
  r = await call(port, 'POST', '/api/v1/scenes/noche', { pin: '9999' }, basic);
  assert.strictEqual(r.body.armed, true, 'con PIN de coacción la escena se ve normal');
  await sleep(300);
  assert.ok(tg.slice(nAlerts).some((x) => x.includes('PÁNICO')), 'y avisa en silencio');
  await call(port, 'POST', '/api/v1/scenes/llegada', { pin: '2580' }, basic);
  r = await call(port, 'POST', '/api/v1/scenes/panico', { pin: '2580' }, basic);
  assert.deepStrictEqual(r.body, { ok: true, scene: 'panico' }, 'respuesta neutra');
  await sleep(300);
  assert.ok(tg.some((x) => x.includes('PÁNICO')), 'pánico avisa al dueño');
  // Puerta por API (control)
  const before = relayCalls;
  r = await call(port, 'POST', '/api/v1/door/open', { reason: 'Proveedor Coca-Cola, remito 123' }, B(ctlTok));
  assert.strictEqual(r.body.ok, true); assert.strictEqual(relayCalls, before + 1);

  // Aforo
  for (let i = 0; i < 3; i++) await call(port, 'POST', '/api/v1/occupancy', { delta: 1 }, B(ingTok));
  r = await call(port, 'GET', '/api/v1/occupancy', null, B(readTok));
  assert.deepStrictEqual([r.body.count, r.body.full, r.body.inToday], [3, true, 3]);
  await sleep(200);
  assert.ok(tg.some((x) => x.includes('aforo completo')));
  r = await call(port, 'POST', '/api/v1/occupancy', { delta: -5 }, B(ctlTok));
  assert.strictEqual(r.body.count, 0, 'nunca negativo');

  // Analítica por API: EPP en industria
  r = await call(port, 'POST', '/api/v1/analytics/events', { kind: 'ppe', camera: 'Planta', missing: 'casco', confidence: 0.9 }, B(ingTok));
  assert.strictEqual(r.body.type, 'PPE_MISSING'); assert.strictEqual(r.body.notified, true);
  assert.strictEqual((await call(port, 'POST', '/api/v1/analytics/events', { kind: 'ppe' }, B(readTok))).status, 401, 'read no puede inyectar');
  r = await call(port, 'POST', '/api/v1/analytics/events', { events: [{ kind: 'dwell', seconds: 120, zone: 'Caja' }, { kind: 'dwell', seconds: 60, zone: 'Caja' }, { kind: 'nada' }] }, B(ingTok));
  assert.strictEqual(r.body.length, 3); assert.strictEqual(r.body[2].ok, false);
  assert.strictEqual((await call(port, 'GET', '/api/v1/occupancy', null, B(readTok))).body.dwell.avgS, 90);

  // Patentes: autorizada abre (en horario), bloqueada alerta, parecida no abre
  await call(port, 'POST', '/api/v1/plates', { plate: 'ab-123-cd', list: 'allow', name: 'Camión reparto' }, A);
  await call(port, 'POST', '/api/v1/plates', { plate: 'AE456FG', list: 'deny', name: 'Robo denunciado', note: 'Avisar a la policía' }, A);
  assert.strictEqual((await call(port, 'POST', '/api/v1/plates', { plate: 'X1' }, A)).status, 400);
  const rb = relayCalls;
  r = await call(port, 'POST', '/api/v1/analytics/events', { kind: 'plate', plate: 'AB123CD', camera: 'Portón', confidence: 0.9 }, B(ingTok));
  assert.strictEqual(r.body.plate.result, 'open'); assert.strictEqual(relayCalls, rb + 1);
  r = await call(port, 'POST', '/api/v1/analytics/events', { kind: 'plate', plate: 'A8I23CD', camera: 'Portón', confidence: 0.9 }, B(ingTok));
  assert.deepStrictEqual([r.body.plate.result, r.body.plate.match], ['unknown', 'probable']); assert.strictEqual(relayCalls, rb + 1, 'lectura dudosa no abre');
  r = await call(port, 'POST', '/api/v1/analytics/events', { kind: 'plate', plate: 'AE 456 FG', camera: 'Portón', confidence: 0.9 }, B(ingTok));
  assert.strictEqual(r.body.plate.result, 'deny');
  await sleep(200);
  assert.ok(tg.some((x) => x.includes('patente bloqueada AE456FG')));

  // Geocercas + telemetría (estilo Traccar/OsmAnd por GET con ?token=)
  const g = (await call(port, 'POST', '/api/v1/geofences', { name: 'Lote 7', lat: -24.80, lng: -65.40, radius: 500 }, A)).body;
  assert.ok(g.id);
  r = await call(port, 'GET', `/api/v1/telemetry?id=tractor1&lat=-24.8001&lon=-65.4001&token=${ingTok.token}`, null);
  assert.deepStrictEqual(r.body.events, []);
  r = await call(port, 'POST', '/api/v1/telemetry', { id: 'tractor1', name: 'Tractor John Deere', lat: -24.82, lng: -65.40 }, B(ingTok));
  assert.deepStrictEqual(r.body.events, [{ fence: 'Lote 7', event: 'exit' }]);
  await sleep(200);
  assert.ok(tg.some((x) => x.includes('Tractor John Deere salió de la geocerca')));

  // Descubrimiento multi-marca (barrido acotado a localhost)
  r = await call(port, 'POST', '/api/v1/discovery', { scan: '127.0.0.1' }, A);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.scanned >= 1, true);
  assert.strictEqual((await call(port, 'POST', '/api/v1/discovery', {}, B(ctlTok))).status, 403);

  // Revocar
  await call(port, 'DELETE', `/api/v1/tokens?id=${readTok.id}`, null, A);
  assert.strictEqual((await call(port, 'GET', '/api/v1/status', null, B(readTok))).status, 401, 'token revocado');

  await sleep(200); ctl.abort();
  assert.match(streamTxt, /event: hello/);
  assert.match(streamTxt, /event: scene/); assert.match(streamTxt, /event: occupancy/);
  assert.match(streamTxt, /event: event\ndata: .*PPE_MISSING/);
  // La auditoría guarda todo
  const evs = app.readEvents(300).map((e) => e.type);
  ['CRITICAL_PANIC_EVENT', 'OCCUPANCY_FULL', 'PLATE_DENY', 'GEOFENCE_ALERT', 'API_TOKEN_CREATED', 'SCENE'].forEach((ty) => assert.ok(evs.includes(ty), ty));
});

test('El panel de la puerta no recibe los eventos de coacción ni pánico por SSE', async (t) => {
  const dir = tmp();
  const app = createApp(readConfig(baseEnv(dir)), { log: () => {}, envFile: path.join(dir, '.env') });
  await app.start(); t.after(() => app.stop());
  const port = app.server.address().port;
  const ctl = new AbortController(); let txt = '';
  fetch(`http://127.0.0.1:${port}/api/live`, { signal: ctl.signal }).then(async (res) => { const rd = res.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; txt += Buffer.from(value).toString(); } }).catch(() => {});
  await sleep(150);
  await call(port, 'POST', '/api/door/open', { pin: '9999' });
  await call(port, 'POST', '/api/v1/scenes/panico', { pin: '2580' });
  await sleep(300); ctl.abort();
  assert.ok(!/DURESS|PANIC|coacci|nico/i.test(txt.replace(/hello.*\n/, '')), txt);
});

test('Webhooks firmados con HMAC y reintentos', async (t) => {
  const got = []; let fails = 1;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { if (fails-- > 0) { res.writeHead(500); return res.end(); } got.push({ h: req.headers, b }); res.end('ok'); });
  });
  const p = await listen(srv); t.after(() => srv.close());
  const dir = tmp();
  const app = createApp(readConfig(baseEnv(dir, { WEBHOOK_URLS: `http://127.0.0.1:${p}/svb`, WEBHOOK_SECRET: 'firma', WEBHOOK_MIN_LEVEL: 'HIGH' })), { log: () => {}, envFile: path.join(dir, '.env') });
  app.webhooks.delays = [100, 100, 100];
  app.addEvent({ type: 'DOOR_OPEN', level: 'INFO', message: 'no se envía (nivel bajo)' });
  app.addEvent({ type: 'CRITICAL_DURESS_EVENT', level: 'CRITICAL', message: 'coacción', ip: '1.2.3.4' });
  for (let i = 0; i < 30 && !got.length; i++) await sleep(50);
  assert.strictEqual(got.length, 1, 'reintenta tras el error 500 y filtra por nivel');
  const body = JSON.parse(got[0].b);
  assert.strictEqual(body.event.type, 'CRITICAL_DURESS_EVENT'); assert.strictEqual(body.source, 'sistemas-vb-seguridad');
  assert.ok(!('ip' in body.event), 'no se envían IPs');
  assert.ok(verify('firma', got[0].h, got[0].b), 'firma válida');
  assert.ok(!verify('otra', got[0].h, got[0].b));
  const r = await app.webhooks.test({ type: 'WEBHOOK_TEST', level: 'INFO' });
  assert.strictEqual(r[0].ok, true);
});

/** Broker MQTT mínimo para la prueba. */
function fakeBroker() {
  const st = { connects: [], pubs: [], subs: [], clients: new Set() };
  const srv = net.createServer((sock) => {
    st.clients.add(sock); let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      const r = parsePackets(Buffer.concat([buf, d])); buf = Buffer.from(r.rest);
      r.packets.forEach((pk) => {
        if (pk.type === 1) { st.connects.push(pk.body.toString('latin1')); sock.write(Buffer.from([0x20, 2, 0, 0])); }
        if (pk.type === 3) { const l = pk.body.readUInt16BE(0); st.pubs.push({ topic: pk.body.subarray(2, 2 + l).toString(), payload: pk.body.subarray(2 + l).toString(), retain: !!(pk.flags & 1) }); }
        if (pk.type === 8) { const id = pk.body.readUInt16BE(0); const l = pk.body.readUInt16BE(2); st.subs.push(pk.body.subarray(4, 4 + l).toString()); sock.write(Buffer.from([0x90, 3, id >> 8, id & 255, 0])); }
        if (pk.type === 12) sock.write(Buffer.from([0xd0, 0]));
      });
    });
    sock.on('error', () => {}); sock.on('close', () => st.clients.delete(sock));
  });
  st.send = (topic, payload) => st.clients.forEach((s) => s.write(packet(0x30, Buffer.concat([str(topic), Buffer.from(payload)]))));
  return { srv, st };
}

test('MQTT: Home Assistant discovery, estado retenido, comandos y eventos de Frigate', async (t) => {
  const { srv, st } = fakeBroker();
  const p = await listen(srv);
  const dir = tmp();
  const app = createApp(readConfig(baseEnv(dir, { MQTT_URL: `mqtt://127.0.0.1:${p}`, MQTT_USER: 'ha', MQTT_PASS: 'clave', FRIGATE_TOPIC: 'frigate/events', BUSINESS_NAME: 'Mi Negocio', SECTOR: 'campo', MQTT_ALLOW_OPEN: '1' })), { log: () => {}, envFile: path.join(dir, '.env') });
  await app.start();
  t.after(async () => { await app.stop(); srv.close(); });
  for (let i = 0; i < 40 && !st.pubs.some((x) => x.topic.endsWith('/sector')); i++) await sleep(50);
  assert.match(st.connects[0], /MQTT/); assert.match(st.connects[0], /ha/); assert.match(st.connects[0], /sistemasvb\/status.*offline/, 'last will');
  assert.ok(st.subs.includes('sistemasvb/cmd/#') && st.subs.includes('frigate/events'));
  const disc = st.pubs.filter((x) => x.topic.startsWith('homeassistant/'));
  assert.ok(disc.length >= 8 && disc.every((x) => x.retain));
  const sw = JSON.parse(disc.find((x) => x.topic.includes('/switch/')).payload);
  assert.strictEqual(sw.command_topic, 'sistemasvb/cmd/arm'); assert.strictEqual(sw.device.manufacturer, 'Vincular Business'); assert.match(sw.device.name, /Sistemas VB Seguridad/);
  assert.ok(st.pubs.some((x) => x.topic === 'sistemasvb/status' && x.payload === 'online' && x.retain));
  assert.ok(st.pubs.some((x) => x.topic === 'sistemasvb/sector' && x.payload === 'campo'));
  // Comandos desde Home Assistant / Alexa / Google
  st.send('sistemasvb/cmd/arm', 'ON'); await sleep(150);
  assert.strictEqual(app.state.armed, true);
  assert.ok(st.pubs.some((x) => x.topic === 'sistemasvb/armed' && x.payload === 'ON'));
  st.send('sistemasvb/cmd/scene', 'llegada'); await sleep(150);
  assert.strictEqual(app.state.armed, false);
  st.send('sistemasvb/cmd/open', '{"pin":"0000"}'); await sleep(100);
  st.send('sistemasvb/cmd/open', '{"pin":"2580"}'); await sleep(150);
  const ev = app.readEvents(50);
  assert.ok(ev.some((e) => e.type === 'ACCESS_DENIED' && /MQTT/.test(e.message)));
  assert.ok(ev.some((e) => e.type === 'DOOR_OPEN' && /MQTT/.test(e.message)));
  // Frigate en el campo: la vaca se filtra, la persona confirmada se registra
  app.state.armed = true;
  st.send('frigate/events', JSON.stringify({ type: 'new', after: { id: 'f1', camera: 'tranquera', label: 'cow', top_score: 0.9 } }));
  st.send('frigate/events', JSON.stringify({ type: 'new', after: { id: 'f2', camera: 'tranquera', label: 'person', top_score: 0.93 } }));
  await sleep(300);
  assert.ok(app.engine.stats.byReason.fauna >= 1);
  assert.ok(app.readEvents(50).some((e) => e.type === 'INTRUSION' && /tranquera/.test(e.message)));
  assert.ok(st.pubs.some((x) => x.topic === 'sistemasvb/event' && x.payload.includes('INTRUSION')));
  assert.ok(st.pubs.some((x) => x.topic === 'sistemasvb/last_event' && x.retain));
});

test('Vigilante de video: avisa cortes por cámara y reinicia go2rtc colgado', async (t) => {
  let mode = 'ok';
  const g2 = http.createServer((req, res) => {
    if (mode === 'hang') { req.socket.destroy(); return; }
    const online = mode === 'ok';
    res.end(JSON.stringify({ svb_ch1: { producers: [{ state: online ? 'connected' : 'connecting' }], consumers: [{}] }, svb_ch1_hd: { producers: [], consumers: [] }, svb_ch2: { producers: [], consumers: [] } }));
  });
  const gp = await listen(g2); t.after(() => g2.close());
  const dir = tmp();
  const app = createApp(readConfig(baseEnv(dir, { GO2RTC_DISABLED: '0', GO2RTC_API: `127.0.0.1:${gp}`, GO2RTC_BIN: '/no/existe', CAM_CHANNELS: '2' })), { log: () => {}, envFile: path.join(dir, '.env') });
  t.after(() => app.stop());
  app.state.camHost = '10.0.0.5'; app.state.go2rtc.running = true;
  await app.watchdogTick();
  assert.strictEqual(app.state.streams[1].online, true);
  assert.strictEqual(app.state.streams[2], undefined, 'canal sin espectadores no se evalúa');
  mode = 'down';
  for (let i = 0; i < 3; i++) await app.watchdogTick();
  assert.strictEqual(app.state.streams[1].online, false);
  assert.ok(app.readEvents(20).some((e) => e.type === 'STREAM_DOWN' && /Puerta/.test(e.message)));
  mode = 'ok'; await app.watchdogTick();
  assert.ok(app.readEvents(20).some((e) => e.type === 'STREAM_RECOVERED'));
  mode = 'hang';
  for (let i = 0; i < 3; i++) { app.state.go2rtc.running = true; await app.watchdogTick(); }
  assert.ok(app.readEvents(20).some((e) => e.type === 'VIDEO_SERVER_RESTART'), 'reinicia el servidor de video');
});

test('Con SECRETS_ENCRYPT=1 los secretos escritos a mano se cifran al arrancar y el servidor los sigue usando', async (t) => {
  const dir = tmp(); const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'SECRETS_ENCRYPT=1\nCAM_PASS=escrita-a-mano\nDOOR_PIN=2580\n');
  fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ people: [{ id: 'a1', name: 'Ana', role: 'Dueño', on: true, pin: null, consent: 0, pk: [], face: null }] }));
  const env = { ...baseEnv(dir), SECRETS_ENCRYPT: '1', CAM_PASS: 'escrita-a-mano' };
  const app = createApp(readConfig(env), { log: () => {}, envFile });
  await app.start(); await app.stop();
  const text = fs.readFileSync(envFile, 'utf8');
  assert.match(text, /CAM_PASS=enc:v1:/); assert.ok(!text.includes('escrita-a-mano'));
  // Simula el próximo arranque: el .env cifrado se descifra en memoria con la clave maestra
  const e2 = { CAM_PASS: text.match(/CAM_PASS=(.*)/)[1] };
  new Vault({ dataDir: dir }).decryptEnv(e2);
  assert.strictEqual(e2.CAM_PASS, 'escrita-a-mano');
  assert.match(fs.readFileSync(path.join(dir, 'access.json'), 'utf8'), /^enc:v1:/, 'personas existentes quedan cifradas');
});
