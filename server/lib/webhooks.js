'use strict';
/**
 * Sistemas VB Seguridad — Webhooks salientes para ERP, POS, CRM o auditoría externa.
 *
 * Cada evento del sistema se envía como POST JSON a las URLs configuradas, firmado con HMAC-SHA256:
 *   X-SVB-Event: DOOR_OPEN
 *   X-SVB-Timestamp: 1730600000
 *   X-SVB-Signature: sha256=<hex de HMAC(secreto, timestamp + "." + cuerpo)>
 * El receptor recalcula la firma y descarta mensajes de más de 5 minutos (evita reenvíos).
 * Reintentos: 3 intentos con espera 2 s / 10 s / 30 s. Cola acotada para no consumir memoria.
 */
const crypto = require('crypto');

const LEVELS = ['INFO', 'WARN', 'HIGH', 'CRITICAL'];
const rank = (l) => Math.max(0, LEVELS.indexOf(String(l || 'INFO').toUpperCase()));

function sign(secret, ts, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${ts}.${body}`).digest('hex');
}
/** Verificación para el receptor (también se usa en las pruebas). */
function verify(secret, headers, body, maxAgeSec = 300) {
  const ts = parseInt(headers['x-svb-timestamp'], 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > maxAgeSec) return false;
  const exp = Buffer.from(sign(secret, ts, body)); const got = Buffer.from(String(headers['x-svb-signature'] || ''));
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

class Webhooks {
  /** @param {{urls:string[]|string, secret?:string, minLevel?:string, business?:string, log?:Function, delays?:number[]}} o */
  constructor(o = {}) { this.configure(o); this.log = o.log || (() => {}); this.delays = o.delays || [2000, 10000, 30000]; this.pending = 0; this.stats = { sent: 0, failed: 0, last: null }; }
  configure({ urls = [], secret = '', minLevel = 'INFO', business = '' } = {}) {
    this.urls = (Array.isArray(urls) ? urls : String(urls).split(/[\s,]+/)).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    this.secret = secret; this.minLevel = minLevel; this.business = business;
  }
  get enabled() { return this.urls.length > 0; }
  /** Envía un evento (no bloquea). */
  dispatch(event) {
    if (!this.enabled || rank(event.level) < rank(this.minLevel)) return 0;
    if (this.pending > 200) { this.stats.failed++; return 0; }
    const body = JSON.stringify({ source: 'sistemas-vb-seguridad', business: this.business, event });
    this.urls.forEach((url) => { this.pending++; this._send(url, body, event.type, 0); });
    return this.urls.length;
  }
  /** Un intento a cada URL, esperando la respuesta (botón "Probar webhook"). */
  async test(event) {
    const body = JSON.stringify({ source: 'sistemas-vb-seguridad', business: this.business, event });
    return Promise.all(this.urls.map(async (url) => {
      const ts = Math.floor(Date.now() / 1000);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'SistemasVB-Seguridad/2.0', 'X-SVB-Event': event.type, 'X-SVB-Timestamp': String(ts) };
      if (this.secret) headers['X-SVB-Signature'] = sign(this.secret, ts, body);
      const safe = url.replace(/\/\/[^/]*@/, '//***@').replace(/\?.*/, '');
      try { const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) }); return { url: safe, ok: r.ok, status: r.status }; } catch (e) { return { url: safe, ok: false, error: e.message }; }
    }));
  }
  async _send(url, body, type, attempt) {
    const ts = Math.floor(Date.now() / 1000);
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'SistemasVB-Seguridad/2.0', 'X-SVB-Event': type, 'X-SVB-Timestamp': String(ts) };
    if (this.secret) headers['X-SVB-Signature'] = sign(this.secret, ts, body);
    let ok = false; let err = '';
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
      ok = r.status >= 200 && r.status < 300; if (!ok) err = `HTTP ${r.status}`;
    } catch (e) { err = e.name === 'TimeoutError' ? 'sin respuesta' : e.message; }
    if (ok) { this.pending--; this.stats.sent++; this.stats.last = { ok: true, url: url.replace(/\/\/[^/]*@/, '//***@'), at: new Date().toISOString() }; return; }
    if (attempt < this.delays.length) { setTimeout(() => this._send(url, body, type, attempt + 1), this.delays[attempt]); return; }
    this.pending--; this.stats.failed++; this.stats.last = { ok: false, url: url.replace(/\/\/[^/]*@/, '//***@'), error: err, at: new Date().toISOString() };
    this.log(`webhook ${type} → ${url.replace(/\?.*/, '')}: ${err}`);
  }
}

module.exports = { Webhooks, sign, verify, rank };
