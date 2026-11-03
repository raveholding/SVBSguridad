'use strict';
/**
 * Sistemas VB Seguridad — Cliente MQTT 3.1.1 mínimo (sin dependencias).
 *
 * Alcanza para integrarse con Home Assistant, Node-RED, Frigate y sistemas ERP/SCADA:
 * CONNECT (usuario/clave, last-will), PUBLISH QoS 0 con retain, SUBSCRIBE, PUBACK para QoS 1 entrante,
 * keep-alive con PINGREQ y reconexión con espera exponencial. mqtt:// (1883) o mqtts:// (TLS, 8883).
 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const str = (s) => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
function encLen(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0);
  return Buffer.from(out);
}
const packet = (first, body) => Buffer.concat([Buffer.from([first]), encLen(body.length), body]);

/** Extrae paquetes completos de un buffer. Devuelve { packets:[{type, flags, body}], rest } */
function parsePackets(buf) {
  const packets = []; let off = 0;
  while (off + 2 <= buf.length) {
    let mul = 1; let len = 0; let i = off + 1; let b;
    do { if (i >= buf.length) return { packets, rest: buf.subarray(off) }; b = buf[i++]; len += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    if (i + len > buf.length) break;
    packets.push({ type: buf[off] >> 4, flags: buf[off] & 0x0f, body: buf.subarray(i, i + len) });
    off = i + len;
  }
  return { packets, rest: buf.subarray(off) };
}

class MqttClient extends EventEmitter {
  /**
   * @param {{url:string, user?:string, pass?:string, clientId?:string, keepalive?:number,
   *          will?:{topic:string, payload:string, retain?:boolean}, log?:Function}} o
   */
  constructor(o) {
    super();
    const u = new URL(o.url);
    this.tls = u.protocol === 'mqtts:';
    this.host = u.hostname; this.port = parseInt(u.port, 10) || (this.tls ? 8883 : 1883);
    this.insecure = u.searchParams.get('insecure') === '1';
    this.user = o.user || decodeURIComponent(u.username || ''); this.pass = o.pass || decodeURIComponent(u.password || '');
    this.clientId = o.clientId || 'svb-' + crypto.randomBytes(4).toString('hex');
    this.keepalive = o.keepalive || 30; this.will = o.will || null; this.log = o.log || (() => {});
    this.connected = false; this.stopped = true; this.backoff = 2000; this.subs = new Set(); this.pid = 1; this.sock = null;
  }
  start() { this.stopped = false; this._connect(); return this; }
  stop() {
    this.stopped = true; clearInterval(this.ping); clearTimeout(this.retryT);
    if (this.sock) { try { if (this.connected) this.sock.write(Buffer.from([0xe0, 0])); } catch { /* cerrado */ } this.sock.destroy(); }
    this.connected = false;
  }
  _connect() {
    if (this.stopped) return;
    let buf = Buffer.alloc(0);
    const opts = { host: this.host, port: this.port };
    const sock = this.tls ? tls.connect({ ...opts, servername: this.host, rejectUnauthorized: !this.insecure }) : net.connect(opts);
    this.sock = sock;
    sock.setTimeout((this.keepalive * 1.5 + 5) * 1000, () => sock.destroy(new Error('sin respuesta del broker')));
    sock.once(this.tls ? 'secureConnect' : 'connect', () => {
      let flags = 0x02; // clean session
      const payload = [str(this.clientId)];
      if (this.will) { flags |= 0x04 | (this.will.retain ? 0x20 : 0); payload.push(str(this.will.topic), str(this.will.payload)); }
      if (this.user) { flags |= 0x80; payload.push(str(this.user)); }
      if (this.pass) { flags |= 0x40; payload.push(str(this.pass)); }
      const ka = Buffer.alloc(2); ka.writeUInt16BE(this.keepalive);
      sock.write(packet(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), ka, ...payload])));
    });
    sock.on('data', (d) => {
      const r = parsePackets(Buffer.concat([buf, d])); buf = Buffer.from(r.rest);
      r.packets.forEach((p) => this._onPacket(p));
    });
    const fail = (e) => {
      if (this.sock !== sock) return;
      clearInterval(this.ping);
      const was = this.connected; this.connected = false; this.sock = null;
      if (was) this.emit('offline');
      if (e && e.message) this.log(`MQTT: ${e.message}`);
      if (this.stopped) return;
      this.retryT = setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(60000, this.backoff * 2);
    };
    sock.on('error', fail); sock.on('close', () => fail());
  }
  _onPacket(p) {
    if (p.type === 2) { // CONNACK
      const rc = p.body[1];
      if (rc !== 0) { this.log(`MQTT: el broker rechazó la conexión (código ${rc}${rc === 4 || rc === 5 ? ': usuario o clave' : ''})`); this.emit('rejected', rc); this.sock.destroy(); return; }
      this.connected = true; this.backoff = 2000;
      this.ping = setInterval(() => { try { this.sock.write(Buffer.from([0xc0, 0])); } catch { /* reconecta */ } }, this.keepalive * 1000);
      this.subs.forEach((t) => this._sub(t));
      this.emit('connect');
    } else if (p.type === 3) { // PUBLISH entrante
      const qos = (p.flags >> 1) & 3;
      const tl = p.body.readUInt16BE(0);
      const topic = p.body.subarray(2, 2 + tl).toString('utf8');
      let off = 2 + tl;
      if (qos > 0) { const id = p.body.readUInt16BE(off); off += 2; this.sock.write(Buffer.from([0x40, 2, id >> 8, id & 0xff])); }
      this.emit('message', topic, p.body.subarray(off).toString('utf8'));
    }
  }
  _sub(topic) {
    const id = this.pid = (this.pid % 65535) + 1;
    const b = Buffer.alloc(2); b.writeUInt16BE(id);
    this.sock.write(packet(0x82, Buffer.concat([b, str(topic), Buffer.from([0])])));
  }
  subscribe(topic) { this.subs.add(topic); if (this.connected) this._sub(topic); }
  /** Publica con QoS 0. Devuelve false si no hay conexión (los estados retenidos se reenvían al reconectar). */
  publish(topic, payload, { retain = false } = {}) {
    if (!this.connected) return false;
    const body = Buffer.concat([str(topic), Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')]);
    this.sock.write(packet(0x30 | (retain ? 1 : 0), body));
    return true;
  }
}

/** ¿Coincide un tópico con un filtro MQTT (+ y #)? */
function topicMatch(filter, topic) {
  const f = filter.split('/'); const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

module.exports = { MqttClient, parsePackets, packet, str, encLen, topicMatch };
