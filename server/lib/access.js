'use strict';
/**
 * Accesos del personal y horario de atención (traído del Portero Cannabismática, versión servidor).
 *
 *  - Personas con PIN propio (guardado con scrypt, nunca en texto plano), rol y habilitación.
 *  - Horario de atención semanal: varias franjas por día, también cruzando la medianoche.
 *    Fuera de horario se bloquean pases de visita y timbre; el personal puede entrar si se permite.
 *  - Huella del personal con passkeys (WebAuthn): el servidor verifica la firma con la clave pública.
 *    La huella nunca sale del celular o del sensor.
 *  - Reconocimiento facial: plantillas numéricas de face-api (128 valores) comparadas en el servidor.
 *    No se guardan fotos.
 *
 * Todo se guarda en data/access.json (fuera del repositorio).
 */
const fs = require('fs');
const crypto = require('crypto');

const ROLES = ['Dueño', 'Empleado', 'Proveedor'];
const BIO_ROLES = ['Dueño', 'Empleado'];
const DAYN = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const H = (from, to) => [{ from, to }];
const DEFAULT_HOURS = { mode: 'always', staffOff: true, autoArm: false, sched: { 0: [], 1: H('09:00', '21:00'), 2: H('09:00', '21:00'), 3: H('09:00', '21:00'), 4: H('09:00', '21:00'), 5: H('09:00', '21:00'), 6: H('09:00', '21:00') } };
const DEFAULT_BIO = { pk: false, face: false, faceThr: 0.5, faceLive: true };

/* ───────────── Horario ───────────── */
const tm = (x) => { const [a, b] = String(x || '0:0').split(':').map(Number); return a * 60 + b; };
/** ¿Está dentro de alguna franja? Si "hasta" <= "desde" la franja cruza la medianoche (00:00 a 00:00 = 24 h). */
function schedActive(sched, d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes(); const day = d.getDay(); const prev = (day + 6) % 7;
  const hit = (list, over) => (list || []).some((r) => { const f = tm(r.from); const t = tm(r.to); if (f < t) return !over && m >= f && m < t; return over ? m < t : m >= f; });
  return hit(sched[day], false) || hit(sched[prev], true);
}
function isOpen(hours, d = new Date()) {
  if (hours.mode === 'off') return false;
  if (hours.mode === 'sched') return schedActive(hours.sched, d);
  return true;
}
function hoursText(hours) {
  if (hours.mode === 'always') return 'Las 24 horas';
  if (hours.mode === 'off') return 'Cerrado temporalmente';
  const order = [1, 2, 3, 4, 5, 6, 0]; const g = {};
  order.forEach((d) => {
    const l = hours.sched[d] || []; if (!l.length) return;
    const k = l.map((r) => (r.from === r.to ? '24 h' : `${r.from} a ${r.to} h`)).join(' y ');
    (g[k] = g[k] || []).push(d);
  });
  const parts = Object.entries(g).map(([k, ds]) => {
    const idx = ds.map((d) => order.indexOf(d));
    const cons = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    const n = ds.length === 1 ? DAYN[ds[0]] : cons ? `${DAYN[ds[0]]} a ${DAYN[ds[ds.length - 1]]}` : ds.map((d) => DAYN[d]).join(', ');
    return `${n} · ${k}`;
  });
  return parts.join(' | ') || 'Sin horarios cargados';
}
function normalizeHours(b, prev = DEFAULT_HOURS) {
  const out = { ...prev, sched: { ...prev.sched } };
  if (b.mode !== undefined) {
    if (!['always', 'sched', 'off'].includes(b.mode)) throw new Error('Modo de horario no válido');
    out.mode = b.mode;
  }
  if (b.staffOff !== undefined) out.staffOff = !!b.staffOff;
  if (b.autoArm !== undefined) out.autoArm = !!b.autoArm;
  if (b.sched !== undefined) {
    const s = {};
    for (let d = 0; d < 7; d++) {
      const list = Array.isArray(b.sched[d]) ? b.sched[d] : [];
      if (list.length > 4) throw new Error(`${DAYN[d]}: máximo 4 franjas por día`);
      s[d] = list.map((r) => {
        const from = String(r.from || ''); const to = String(r.to || '');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(to)) throw new Error(`${DAYN[d]}: horario no válido (usar HH:MM)`);
        return { from, to };
      });
    }
    out.sched = s;
  }
  return out;
}

/* ───────────── PIN ───────────── */
function hashPin(pin) {
  const salt = crypto.randomBytes(12);
  return { s: salt.toString('base64'), h: crypto.scryptSync(String(pin), salt, 32, { N: 4096 }).toString('base64') };
}
function checkPin(pin, rec) {
  if (!rec || !rec.s || !rec.h) return false;
  const h = crypto.scryptSync(String(pin), Buffer.from(rec.s, 'base64'), 32, { N: 4096 });
  const want = Buffer.from(rec.h, 'base64');
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

/* ───────────── WebAuthn (passkeys) ───────────── */
const b64u = {
  enc: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
/** Verifica una firma de passkey (navigator.credentials.get) contra la clave pública guardada. */
function verifyAssertion(cred, a, challenge) {
  try {
    const cdj = b64u.dec(a.clientDataJSON);
    const cd = JSON.parse(cdj.toString('utf8'));
    if (cd.type !== 'webauthn.get') return { ok: false, error: 'Tipo de firma inválido' };
    if (cd.challenge !== challenge) return { ok: false, error: 'Desafío inválido o vencido' };
    if (cd.origin !== cred.origin) return { ok: false, error: 'La huella se registró desde otra dirección web' };
    const ad = b64u.dec(a.authenticatorData);
    if (ad.length < 37) return { ok: false, error: 'Datos del autenticador incompletos' };
    if (!ad.subarray(0, 32).equals(sha256(cred.rpId))) return { ok: false, error: 'Dominio no coincide' };
    const flags = ad[32];
    if (!(flags & 1) || !(flags & 4)) return { ok: false, error: 'Falta la verificación biométrica' };
    const counter = ad.readUInt32BE(33);
    if (counter && cred.counter && counter <= cred.counter) return { ok: false, error: 'Contador de la passkey no válido (posible copia)' };
    const data = Buffer.concat([ad, sha256(cdj)]);
    const key = crypto.createPublicKey({ key: b64u.dec(cred.pub), format: 'der', type: 'spki' });
    const ok = crypto.verify('sha256', data, cred.alg === -7 ? { key, dsaEncoding: 'der' } : key, b64u.dec(a.signature));
    return ok ? { ok: true, counter } : { ok: false, error: 'Firma inválida' };
  } catch (e) { return { ok: false, error: 'Firma ilegible' }; }
}

/* ───────────── Rostro ───────────── */
const validDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 2);
const fdist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };

/* ───────────── Almacén ───────────── */
class AccessStore {
  /**
   * @param {string} file
   * @param {{vault?:object, encrypt?:boolean}} [opts] con vault + encrypt el archivo (plantillas biométricas,
   *   hashes de PIN, passkeys) se guarda cifrado con AES-256-GCM. Lee los dos formatos.
   */
  constructor(file, { vault = null, encrypt = false } = {}) {
    this.file = file; this.vault = vault; this.encrypt = !!(encrypt && vault);
    this.challenges = new Map(); // desafío -> vence
    let doc = {};
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (text.startsWith('enc:v1:')) {
        if (!vault) throw new Error('access.json está cifrado y falta la clave maestra (data/master.key o SVB_MASTER_KEY)');
        text = vault.decrypt(text.trim());
      }
      doc = JSON.parse(text);
    } catch (e) { if (e.code !== 'ENOENT' && /clave maestra|auth/i.test(e.message)) throw e; /* primera vez */ }
    this.people = Array.isArray(doc.people) ? doc.people : [];
    this.hours = normalizeHours(doc.hours || {}, DEFAULT_HOURS);
    this.bio = { ...DEFAULT_BIO, ...(doc.bio || {}) };
  }
  save() {
    const tmp = this.file + '.tmp';
    const json = JSON.stringify({ people: this.people, hours: this.hours, bio: this.bio }, null, 1);
    fs.writeFileSync(tmp, this.encrypt ? this.vault.encrypt(json) : json, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  isOpen(d) { return isOpen(this.hours, d); }
  /** ¿Puede entrar esta persona fuera de horario? El dueño siempre; el empleado si está permitido. */
  offHoursOk(role) { return role === 'Dueño' || (role === 'Empleado' && this.hours.staffOff); }
  info() {
    const bioPeople = this.people.filter((p) => p.on && p.consent && BIO_ROLES.includes(p.role));
    return {
      open: this.isOpen(), mode: this.hours.mode, text: hoursText(this.hours), sched: this.hours.sched, staffOff: this.hours.staffOff, autoArm: this.hours.autoArm,
      pk: this.bio.pk && bioPeople.some((p) => (p.pk || []).length), face: this.bio.face && bioPeople.some((p) => p.face && p.face.d && p.face.d.length),
      faceLive: this.bio.faceLive, people: this.people.length,
    };
  }
  /** Vista para el panel: sin hashes de PIN ni plantillas faciales. */
  view(p) {
    return { id: p.id, name: p.name, role: p.role, on: p.on, hasPin: !!p.pin, consent: p.consent || 0, created: p.created,
      nfc: p.nfc || '', pk: (p.pk || []).map((k) => ({ id: k.id, kind: k.kind, ts: k.ts, origin: k.origin })), face: p.face && p.face.d ? { n: p.face.d.length, ts: p.face.ts } : null, lastIn: p.lastIn || null };
  }
  get(id) { return this.people.find((p) => p.id === id); }
  findByNfc(sn) { const k = normNfc(sn); return (k && this.people.find((p) => p.nfc === k)) || null; }
  findByPin(pin) { return this.people.find((p) => p.pin && checkPin(pin, p.pin)) || null; }
  create({ name, role }) {
    if (this.people.length >= 200) throw new Error('Máximo 200 personas');
    const p = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(name), role: ROLES.includes(role) ? role : 'Empleado', on: true, pin: null, consent: 0, pk: [], face: null, created: new Date().toISOString() };
    this.people.push(p); this.save(); return p;
  }
  update(p, b) {
    if (b.name !== undefined) p.name = cleanName(b.name);
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) throw new Error('Rol no válido');
      p.role = b.role;
      if (!BIO_ROLES.includes(p.role)) this.wipeBio(p); // un proveedor no usa biometría
    }
    if (b.on !== undefined) p.on = !!b.on;
    if (b.nfc !== undefined) {
      const k = b.nfc ? normNfc(b.nfc) : '';
      if (b.nfc && !k) throw new Error('Número de tarjeta NFC no válido');
      if (k && this.people.some((x) => x.id !== p.id && x.nfc === k)) throw new Error('Esa tarjeta NFC ya es de otra persona');
      p.nfc = k;
    }
    if (b.consent !== undefined) { if (b.consent) p.consent = p.consent || Date.now(); else this.wipeBio(p); }
    this.save(); return p;
  }
  wipeBio(p) { p.consent = 0; p.pk = []; p.face = null; }
  remove(id) { const n = this.people.length; this.people = this.people.filter((p) => p.id !== id); if (n !== this.people.length) this.save(); return n !== this.people.length; }
  setPin(p, pin) { p.pin = pin ? hashPin(pin) : null; this.save(); }
  touch(p) { p.lastIn = new Date().toISOString(); this.save(); }

  /* huella */
  newChallenge() {
    const now = Date.now();
    for (const [k, t] of this.challenges) if (t < now) this.challenges.delete(k);
    if (this.challenges.size > 500) this.challenges.clear();
    const c = b64u.enc(crypto.randomBytes(32));
    this.challenges.set(c, now + 120000);
    return c;
  }
  useChallenge(c) { const t = this.challenges.get(c); this.challenges.delete(c); return !!t && t > Date.now(); }
  addPasskey(p, { id, pub, alg, kind, origin, rpId }) {
    if (!BIO_ROLES.includes(p.role)) throw new Error('Solo dueños y empleados pueden registrar huella');
    if (!p.consent) throw new Error('Falta marcar el consentimiento de la persona');
    if (!/^[\w-]{16,512}$/.test(String(id || ''))) throw new Error('Identificador de passkey inválido');
    if (![-7, -257].includes(alg)) throw new Error('Algoritmo no soportado');
    if (!/^https?:\/\/[^\s/]+$/.test(String(origin || '')) || !rpId || new URL(origin).hostname !== rpId) throw new Error('Origen inválido');
    try { crypto.createPublicKey({ key: b64u.dec(pub), format: 'der', type: 'spki' }); } catch { throw new Error('Clave pública inválida'); }
    if (this.people.some((x) => (x.pk || []).some((k) => k.id === id))) throw new Error('Esa passkey ya está registrada');
    if ((p.pk || []).length >= 5) throw new Error('Máximo 5 huellas por persona');
    p.pk = (p.pk || []).concat({ id, pub, alg, kind: kind === 'Celular' ? 'Celular' : 'Dispositivo', origin, rpId, counter: 0, ts: Date.now() });
    this.save();
  }
  removePasskey(p, cid) { p.pk = (p.pk || []).filter((k) => k.id !== cid); this.save(); }
  /** Devuelve { person } o { error } */
  verifyPasskey(a) {
    if (!a || typeof a !== 'object') return { error: 'Sin firma' };
    let challenge = '';
    try { challenge = JSON.parse(b64u.dec(a.clientDataJSON).toString('utf8')).challenge; } catch { return { error: 'Firma ilegible' }; }
    if (!this.useChallenge(challenge)) return { error: 'Desafío vencido: volvé a intentar' };
    const person = this.people.find((x) => (x.pk || []).some((k) => k.id === a.id));
    if (!person) return { error: 'Huella no registrada' };
    const cred = person.pk.find((k) => k.id === a.id);
    const r = verifyAssertion(cred, a, challenge);
    if (!r.ok) return { error: r.error, person };
    cred.counter = r.counter; cred.last = Date.now(); this.save();
    return { person };
  }

  /* rostro */
  setFace(p, d) {
    if (!BIO_ROLES.includes(p.role)) throw new Error('Solo dueños y empleados pueden registrar rostro');
    if (!p.consent) throw new Error('Falta marcar el consentimiento de la persona');
    if (!Array.isArray(d) || d.length < 3 || d.length > 10 || !d.every(validDescriptor)) throw new Error('Plantilla facial inválida');
    p.face = { d: d.map((x) => x.map((v) => +v.toFixed(4))), ts: Date.now() };
    this.save();
  }
  removeFace(p) { p.face = null; this.save(); }
  /** Compara la plantilla con todas las personas habilitadas. Exige margen frente al segundo más parecido. */
  matchFace(desc) {
    if (!validDescriptor(desc)) return { error: 'Plantilla inválida' };
    const thr = Math.max(0.3, Math.min(0.65, +this.bio.faceThr || 0.5));
    const scored = this.people.filter((p) => p.face && p.face.d && p.face.d.length)
      .map((p) => ({ p, m: Math.min(...p.face.d.map((x) => fdist(x, desc))) })).sort((a, b) => a.m - b.m);
    const [best, second] = scored;
    if (!best || best.m >= thr) return { error: 'Rostro no reconocido', dist: best ? +best.m.toFixed(3) : null };
    if (second && second.m - best.m < 0.04) return { error: 'Rostro dudoso: se parece a más de una persona', dist: +best.m.toFixed(3) };
    return { person: best.p, dist: +best.m.toFixed(3) };
  }
  setBio(b) {
    if (b.pk !== undefined) this.bio.pk = !!b.pk;
    if (b.face !== undefined) this.bio.face = !!b.face;
    if (b.faceLive !== undefined) this.bio.faceLive = !!b.faceLive;
    if (b.faceThr !== undefined) { const t = +b.faceThr; if (!(t >= 0.3 && t <= 0.65)) throw new Error('Exigencia entre 0,30 y 0,65'); this.bio.faceThr = t; }
    this.save();
  }
  setHours(b) { this.hours = normalizeHours(b, this.hours); this.save(); }
}
/** Número de serie de la tarjeta (ej. "04:a2:19:7c") normalizado. */
function normNfc(s) { const t = String(s || '').toUpperCase().replace(/[^0-9A-F]/g, ''); return t.length >= 8 && t.length <= 40 ? t : ''; }
function cleanName(s) { const n = String(s || '').replace(/[\r\n<>]/g, '').trim().slice(0, 40); if (!n) throw new Error('Falta el nombre'); return n; }

module.exports = { AccessStore, ROLES, BIO_ROLES, schedActive, isOpen, hoursText, normalizeHours, hashPin, checkPin, verifyAssertion, b64u, DEFAULT_HOURS };
