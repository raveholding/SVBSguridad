'use strict';
/**
 * Sistemas VB Seguridad — Datos de la plataforma (data/platform.json):
 *   - Perfiles por sector (comercio, industria, campo, residencial) y sus módulos.
 *   - Listas de patentes (permitidas / bloqueadas) con tolerancia a errores de lectura OCR.
 *   - Tokens de API para integraciones (solo se guarda el hash SHA-256).
 *   - Aforo (personas dentro), permanencias y geocercas para maquinaria/vehículos.
 */
const fs = require('fs');
const crypto = require('crypto');

const SECTORS = {
  comercio: { label: 'Comercio', panelMode: 'corp', modules: ['aforo', 'permanencia', 'pases', 'merodeo', 'patentes', 'portero'], help: 'Aforo, tiempos de permanencia, pases QR para proveedores y auditoría de aperturas.' },
  industria: { label: 'Industria / Empresa', panelMode: 'corp', modules: ['epp', 'aforo', 'patentes', 'caidas', 'pases', 'velocidad'], help: 'Control de EPP (casco, chaleco, botas), caídas, ingreso vehicular por patente y aforo por sector.' },
  campo: { label: 'Campo / Finca', panelMode: 'corp', modules: ['filtroRural', 'patentes', 'geocercas', 'perimetro'], help: 'Filtro de falsas alarmas (fauna, viento, vegetación), perímetro extendido, geocercas para maquinaria y enlaces satelitales.' },
  residencial: { label: 'Residencial / Hogar', panelMode: 'home', modules: ['escenas', 'vecinal', 'panico', 'asistentes'], help: 'Escenas Llegué a casa / Modo noche / Salgo, pánico silencioso, red de alerta vecinal y asistentes de voz.' },
};

/* ───────────── Patentes ───────────── */
const normPlate = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
// Caracteres que el OCR confunde: se llevan a una forma canónica para detectar coincidencias "probables".
const CONFUSE = { O: '0', D: '0', Q: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6' };
const canonPlate = (p) => normPlate(p).replace(/[ODQILBSZG]/g, (c) => CONFUSE[c]);
/** Formato argentino: AB123CD (Mercosur), ABC123 (anterior), A123BCD / 123ABC (motos). */
const plateFormat = (p) => (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(p) ? 'mercosur' : /^[A-Z]{3}\d{3}$/.test(p) ? 'ar-1995' : /^([A-Z]\d{3}[A-Z]{3}|\d{3}[A-Z]{3})$/.test(p) ? 'moto' : 'otro');

/* ───────────── Geocercas ───────────── */
function haversine(a, b) {
  const R = 6371000; const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const TOKEN_SCOPES = ['read', 'control', 'ingest'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class PlatformStore {
  constructor(file) {
    this.file = file;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primera vez */ }
    this.plates = Array.isArray(d.plates) ? d.plates : [];
    this.tokens = Array.isArray(d.tokens) ? d.tokens : [];
    this.occupancy = { count: 0, inToday: 0, outToday: 0, day: '', peak: 0, ...(d.occupancy || {}) };
    this.dwell = Array.isArray(d.dwell) ? d.dwell.slice(-500) : [];
    this.geofences = Array.isArray(d.geofences) ? d.geofences : [];
    this.assets = d.assets && typeof d.assets === 'object' ? d.assets : {};
    this._t = null;
  }
  save(now = false) {
    const write = () => {
      this._t = null;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ plates: this.plates, tokens: this.tokens, occupancy: this.occupancy, dwell: this.dwell, geofences: this.geofences, assets: this.assets }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    };
    if (now) { clearTimeout(this._t); return write(); }
    if (!this._t) this._t = setTimeout(write, 500);
  }
  flush() { if (this._t) { clearTimeout(this._t); this.save(true); } }

  /* Patentes */
  addPlate({ plate, list = 'allow', name = '', note = '' }) {
    const p = normPlate(plate);
    if (p.length < 5) throw new Error('Patente inválida (mínimo 5 caracteres, ej. AB123CD)');
    if (!['allow', 'deny'].includes(list)) throw new Error('Lista inválida: allow o deny');
    const prev = this.plates.find((x) => x.plate === p);
    if (prev) Object.assign(prev, { list, name: String(name || prev.name).slice(0, 60), note: String(note || prev.note || '').slice(0, 120) });
    else this.plates.push({ id: crypto.randomUUID(), plate: p, list, name: String(name).slice(0, 60), note: String(note).slice(0, 120), created: new Date().toISOString() });
    this.save(true);
    return this.plates.find((x) => x.plate === p);
  }
  removePlate(id) { const n = this.plates.length; this.plates = this.plates.filter((p) => p.id !== id && p.plate !== normPlate(id)); this.save(true); return n !== this.plates.length; }
  /** → { plate, format, match: 'exact'|'probable'|null, entry } */
  matchPlate(raw) {
    const p = normPlate(raw); const c = canonPlate(p);
    const exact = this.plates.find((x) => x.plate === p);
    if (exact) return { plate: p, format: plateFormat(p), match: 'exact', entry: exact };
    const prob = this.plates.find((x) => canonPlate(x.plate) === c);
    return { plate: p, format: plateFormat(p), match: prob ? 'probable' : null, entry: prob || null };
  }

  /* Tokens de API */
  createToken({ name, scopes }) {
    const sc = (Array.isArray(scopes) ? scopes : String(scopes || 'read').split(',')).map((s) => s.trim()).filter((s) => TOKEN_SCOPES.includes(s));
    if (!sc.length) throw new Error('Elegí al menos un permiso: read, control o ingest');
    const secret = 'svb_' + crypto.randomBytes(24).toString('base64url');
    const t = { id: crypto.randomUUID(), name: String(name || 'Integración').slice(0, 40), scopes: [...new Set(sc)], hash: sha(secret), prefix: secret.slice(0, 9), created: new Date().toISOString(), lastUsed: null };
    this.tokens.push(t); this.save(true);
    return { ...this.viewToken(t), token: secret };
  }
  viewToken(t) { return { id: t.id, name: t.name, scopes: t.scopes, prefix: t.prefix, created: t.created, lastUsed: t.lastUsed }; }
  revokeToken(id) { const n = this.tokens.length; this.tokens = this.tokens.filter((t) => t.id !== id); this.save(true); return n !== this.tokens.length; }
  verifyToken(secret, scope) {
    if (!/^svb_[\w-]{20,}$/.test(String(secret || ''))) return null;
    const h = Buffer.from(sha(secret));
    const t = this.tokens.find((x) => { const b = Buffer.from(x.hash); return b.length === h.length && crypto.timingSafeEqual(b, h); });
    if (!t || (scope && !t.scopes.includes(scope))) return null;
    const now = Date.now();
    if (!t.lastUsed || now - Date.parse(t.lastUsed) > 60000) { t.lastUsed = new Date(now).toISOString(); this.save(); }
    return t;
  }

  /* Aforo */
  _rollDay(d = new Date()) {
    const day = d.toISOString().slice(0, 10);
    if (this.occupancy.day !== day) Object.assign(this.occupancy, { day, inToday: 0, outToday: 0, peak: this.occupancy.count });
  }
  /** delta: +n entra, -n sale. set: fija el número (corrección manual). */
  updateOccupancy({ delta = 0, set = null } = {}) {
    this._rollDay();
    const o = this.occupancy; const before = o.count;
    if (set !== null && set !== undefined) o.count = Math.max(0, parseInt(set, 10) || 0);
    else {
      const d = parseInt(delta, 10) || 0;
      o.count = Math.max(0, o.count + d);
      if (d > 0) o.inToday += d; else o.outToday += -d;
    }
    o.peak = Math.max(o.peak || 0, o.count); o.updated = new Date().toISOString();
    this.save();
    return { before, ...o };
  }
  addDwell(seconds, zone = '') {
    const s = Math.max(0, Math.min(86400, Number(seconds) || 0));
    this.dwell.push({ ts: Date.now(), s, zone: String(zone).slice(0, 30) });
    if (this.dwell.length > 500) this.dwell.splice(0, this.dwell.length - 500);
    this.save();
  }
  dwellStats(hours = 24) {
    const from = Date.now() - hours * 3600e3;
    const xs = this.dwell.filter((d) => d.ts >= from).map((d) => d.s).sort((a, b) => a - b);
    if (!xs.length) return { n: 0 };
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { n: xs.length, avgS: Math.round(avg), p90S: xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))], maxS: xs[xs.length - 1] };
  }

  /* Geocercas */
  addGeofence({ name, lat, lng, radius, mode = 'inside' }) {
    const g = { id: crypto.randomUUID(), name: String(name || 'Lote').slice(0, 40), lat: Number(lat), lng: Number(lng), radius: Math.max(20, Math.min(50000, Number(radius) || 500)), mode: mode === 'outside' ? 'outside' : 'inside' };
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng) || Math.abs(g.lat) > 90 || Math.abs(g.lng) > 180) throw new Error('Coordenadas inválidas');
    this.geofences.push(g); this.save(true); return g;
  }
  removeGeofence(id) { const n = this.geofences.length; this.geofences = this.geofences.filter((g) => g.id !== id); this.save(true); return n !== this.geofences.length; }
  /**
   * Posición de un activo (tractor, camioneta, cosechadora). Devuelve las transiciones:
   * [{fence, event:'exit'|'enter', distance}] — "inside" avisa al salir, "outside" avisa al entrar.
   */
  trackAsset({ id, name, lat, lng, speed }) {
    const aid = String(id || '').slice(0, 40);
    if (!aid) throw new Error('Falta el id del activo');
    const pos = { lat: Number(lat), lng: Number(lng) };
    if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) throw new Error('Coordenadas inválidas');
    const prev = this.assets[aid] || { inside: {} };
    const inside = {}; const changes = [];
    this.geofences.forEach((g) => {
      const dist = haversine(pos, g); const now = dist <= g.radius;
      inside[g.id] = now;
      const was = prev.inside[g.id];
      if (was === undefined) return; // primera posición: solo registra
      if (g.mode === 'inside' && was && !now) changes.push({ fence: g, event: 'exit', distance: Math.round(dist) });
      if (g.mode === 'outside' && !was && now) changes.push({ fence: g, event: 'enter', distance: Math.round(dist) });
      if (g.mode === 'inside' && !was && now) changes.push({ fence: g, event: 'back', distance: Math.round(dist) });
    });
    this.assets[aid] = { name: String(name || prev.name || aid).slice(0, 40), ...pos, speed: Number(speed) || null, ts: new Date().toISOString(), inside };
    this.save();
    return changes;
  }
}

module.exports = { PlatformStore, SECTORS, normPlate, canonPlate, plateFormat, haversine, TOKEN_SCOPES };
