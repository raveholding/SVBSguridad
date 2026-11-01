'use strict';
/**
 * Suscripción a eventos del grabador Dahua (lo mismo que dispara las notificaciones push de DMSS):
 *   GET /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5
 * El equipo mantiene la conexión abierta y envía bloques "Code=VideoMotion;action=Start;index=0".
 */
const http = require('http');
const { EventEmitter } = require('events');
const { parseDigest, buildDigestHeader } = require('./dahua');

const LABELS = {
  VideoMotion: 'Movimiento',
  SmartMotionHuman: 'Persona detectada',
  SmartMotionVehicle: 'Vehículo detectado',
  CrossLineDetection: 'Cruce de línea',
  CrossRegionDetection: 'Intrusión en zona',
  LeftDetection: 'Objeto abandonado',
  VideoBlind: 'Cámara tapada (sabotaje)',
  VideoLoss: 'Pérdida de video',
  VideoAbnormalDetection: 'Imagen anormal',
  AlarmLocal: 'Alarma (entrada)',
  FaceDetection: 'Rostro detectado',
  HumanTrait: 'Persona detectada',
  StorageNotExist: 'Disco no encontrado',
  StorageFailure: 'Falla de disco',
  StorageLowSpace: 'Disco casi lleno',
};
// Eventos que siempre avisan (aunque el sistema esté desarmado)
const ALWAYS = new Set(['VideoBlind', 'VideoLoss', 'AlarmLocal', 'StorageNotExist', 'StorageFailure', 'StorageLowSpace', 'VideoAbnormalDetection']);
const IGNORE = new Set(['NewFile', 'TimeChange', 'NTPAdjustTime', 'LoginFailure', 'Reboot', 'RtspSessionDisconnect', 'InterVideoAccess', 'SystemState']);

/** Extrae eventos de un bloque de texto. Devuelve [{code, action, index, data}] */
function parseEvents(text) {
  const out = [];
  const re = /Code=([A-Za-z0-9_]+);action=([A-Za-z]+);index=(\d+)(?:;data=(\{[\s\S]*?\n\}))?/g;
  let m;
  while ((m = re.exec(text))) out.push({ code: m[1], action: m[2], index: parseInt(m[3], 10), data: m[4] || null });
  return out;
}

class DahuaEvents extends EventEmitter {
  constructor({ host, port = 80, user, pass, log = () => {} }) {
    super();
    Object.assign(this, { host, port, user, pass, log });
    this.req = null; this.stopped = false; this.backoff = 2000; this.connected = false; this.buffer = '';
  }
  start() { this.stopped = false; this._connect(); return this; }
  stop() { this.stopped = true; if (this.req) this.req.destroy(); this.connected = false; }
  _retry() {
    this.connected = false;
    if (this.stopped) return;
    setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(60000, this.backoff * 2);
  }
  _connect(auth) {
    if (this.stopped) return;
    const path = '/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5';
    const headers = auth ? { Authorization: auth } : {};
    let finished = false;
    const fin = () => { if (finished) return; finished = true; this._retry(); };
    const req = http.request({ host: this.host, port: this.port, path, method: 'GET', headers }, (res) => {
      if (res.statusCode === 401 && !auth) {
        finished = true;
        res.resume();
        const wa = res.headers['www-authenticate'] || '';
        const a = /^basic/i.test(wa)
          ? 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64')
          : buildDigestHeader({ user: this.user, pass: this.pass, method: 'GET', uri: path, challenge: parseDigest(wa.replace(/^digest\s+/i, '')) });
        return this._connect(a);
      }
      if (res.statusCode !== 200) { this.log(`eventos: HTTP ${res.statusCode}`); res.resume(); return fin(); }
      this.connected = true; this.backoff = 2000; this.emit('connected');
      let idle = setTimeout(() => req.destroy(), 30000);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        clearTimeout(idle); idle = setTimeout(() => req.destroy(), 30000);
        this.buffer += chunk;
        if (this.buffer.length > 200000) this.buffer = this.buffer.slice(-50000);
        const cut = this.buffer.lastIndexOf('--myboundary');
        const ready = cut > 0 ? this.buffer.slice(0, cut) : '';
        if (!ready && !/index=\d+/.test(this.buffer)) return;
        const text = ready || this.buffer;
        this.buffer = ready ? this.buffer.slice(cut + 12) : '';
        parseEvents(text).forEach((e) => {
          if (IGNORE.has(e.code)) return;
          this.emit('event', { ...e, channel: e.index + 1, label: LABELS[e.code] || e.code, always: ALWAYS.has(e.code) });
        });
      });
      res.on('end', () => { clearTimeout(idle); fin(); });
      res.on('close', () => { clearTimeout(idle); fin(); });
      res.on('error', () => { clearTimeout(idle); fin(); });
    });
    req.on('error', (e) => { if (!finished) this.log(`eventos: ${e.message}`); fin(); });
    req.end();
    this.req = req;
  }
}

module.exports = { DahuaEvents, parseEvents, LABELS };
