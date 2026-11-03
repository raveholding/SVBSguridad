'use strict';
/**
 * Sistemas VB Seguridad — Cliente ONVIF (Profile S / T) sin dependencias.
 *
 * Con la IP, el usuario y la clave de una cámara o grabador de cualquier marca:
 *   1. GetSystemDateAndTime  → diferencia de reloj (WS-Security la exige).
 *   2. GetDeviceInformation  → fabricante, modelo, firmware, número de serie.
 *   3. GetCapabilities       → direcciones de los servicios Media y PTZ.
 *   4. GetProfiles           → perfiles de video agrupados por fuente (= canal del grabador).
 *   5. GetStreamUri          → URL RTSP exacta de cada perfil (principal y secundario).
 * Autenticación: WS-Security UsernameToken (PasswordDigest) y, si el equipo la rechaza, HTTP Digest.
 * También mueve cámaras PTZ (ContinuousMove / Stop).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { parseDigest, buildDigestHeader } = require('./dahua');

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"';

/* ── XML mínimo (los prefijos de namespace cambian según la marca) ── */
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function blocks(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', body: m[2] || '' });
  return out;
}
const first = (xml, name) => { const b = blocks(xml, name)[0]; return b ? unesc(b.body.trim()) : ''; };
const attr = (attrs, name) => { const m = String(attrs).match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : ''; };

/** Cabecera WS-Security UsernameToken con PasswordDigest = Base64(SHA1(nonce + created + clave)). */
function wsse(user, pass, offsetMs = 0) {
  if (!user) return '';
  const nonce = crypto.randomBytes(16);
  const created = new Date(Date.now() + offsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(String(pass || ''))])).digest('base64');
  return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
    + `<UsernameToken><Username>${esc(user)}</Username>`
    + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
    + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
    + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
}

function post(url, body, { auth, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) };
    if (auth) headers.Authorization = auth;
    const req = lib.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers, timeout, rejectUnauthorized: false }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('el equipo no responde')));
    req.on('error', reject);
    req.end(body);
  });
}

class OnvifDevice {
  /** @param {{host:string, port?:number, user?:string, pass?:string, https?:boolean, timeout?:number}} o */
  constructor(o) {
    this.host = o.host; this.port = o.port || 80; this.user = o.user || ''; this.pass = o.pass || '';
    this.timeout = o.timeout || 5000;
    this.deviceUrl = o.xaddr || `${o.https ? 'https' : 'http'}://${this.host}:${this.port}/onvif/device_service`;
    this.offset = 0; this.useDigest = false; this.media = null; this.ptz = null;
  }
  /** Llamada SOAP con WS-Security; si el equipo responde 401, reintenta con HTTP Digest. */
  async call(url, inner) {
    const env = (head) => `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}>${head}<s:Body>${inner}</s:Body></s:Envelope>`;
    let r = await post(url, env(this.useDigest ? '' : wsse(this.user, this.pass, this.offset)), { timeout: this.timeout });
    if (r.status === 401 && this.user) {
      const ch = String(r.headers['www-authenticate'] || '');
      if (/^digest/i.test(ch)) {
        const u = new URL(url);
        const auth = buildDigestHeader({ user: this.user, pass: this.pass, method: 'POST', uri: u.pathname + u.search, challenge: parseDigest(ch.replace(/^digest\s+/i, '')) });
        r = await post(url, env(''), { auth, timeout: this.timeout });
        if (r.status < 400) this.useDigest = true;
        this.digestAuth = auth;
      }
    }
    if (r.status >= 400) {
      const reason = first(r.body, 'Text') || first(r.body, 'Reason') || `HTTP ${r.status}`;
      const denied = r.status === 401 || /NotAuthorized|not authorized|Unauthorized/i.test(r.body);
      const e = new Error(denied ? 'Usuario o contraseña incorrectos (o el usuario no tiene permiso ONVIF)' : reason);
      e.denied = denied;
      e.status = r.status; throw e;
    }
    return r.body;
  }
  async syncTime() {
    try {
      const x = await post(this.deviceUrl, `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Body><tds:GetSystemDateAndTime/></s:Body></s:Envelope>`, { timeout: this.timeout });
      const utc = blocks(x.body, 'UTCDateTime')[0];
      if (!utc) return 0;
      const n = (k) => parseInt(first(utc.body, k), 10);
      const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
      if (Number.isFinite(t)) this.offset = t - Date.now();
    } catch { /* sin hora: se usa la local */ }
    return this.offset;
  }
  async info() {
    const x = await this.call(this.deviceUrl, '<tds:GetDeviceInformation/>');
    return { manufacturer: first(x, 'Manufacturer'), model: first(x, 'Model'), firmware: first(x, 'FirmwareVersion'), serial: first(x, 'SerialNumber'), hardware: first(x, 'HardwareId') };
  }
  async capabilities() {
    const x = await this.call(this.deviceUrl, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    const xa = (sec) => { const b = blocks(x, sec)[0]; return b ? first(b.body, 'XAddr') : ''; };
    this.media = xa('Media') || this.deviceUrl.replace(/device_service.*$/, 'Media');
    this.ptz = xa('PTZ') || null;
    return { media: this.media, ptz: this.ptz, events: xa('Events') || null };
  }
  async profiles() {
    if (!this.media) await this.capabilities();
    const x = await this.call(this.media, '<trt:GetProfiles/>');
    return blocks(x, 'Profiles').map((p) => {
      const src = blocks(p.body, 'VideoSourceConfiguration')[0];
      const enc = blocks(p.body, 'VideoEncoderConfiguration')[0];
      const res = enc ? blocks(enc.body, 'Resolution')[0] : null;
      return {
        token: attr(p.attrs, 'token'), name: first(p.body, 'Name'),
        source: src ? first(src.body, 'SourceToken') || attr(src.attrs, 'token') : 'default',
        encoding: enc ? first(enc.body, 'Encoding') : '', width: res ? parseInt(first(res.body, 'Width'), 10) || 0 : 0, height: res ? parseInt(first(res.body, 'Height'), 10) || 0 : 0,
        ptz: blocks(p.body, 'PTZConfiguration').length > 0,
      };
    });
  }
  async streamUri(token) {
    const x = await this.call(this.media, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetStreamUri>`);
    return first(x, 'Uri');
  }
  /**
   * Todo junto: datos del equipo y canales con URL principal (mayor resolución) y secundaria (menor).
   * @returns {Promise<{info, ptz:boolean, channels:[{source, name, main, sub, mainToken, ptz, resolution}]}>}
   */
  async probe() {
    await this.syncTime();
    const info = await this.info().catch((e) => { if (e.denied) throw e; return {}; });
    await this.capabilities();
    const profs = await this.profiles();
    if (!profs.length) throw new Error('El equipo no informa perfiles de video ONVIF');
    const bySrc = new Map();
    profs.forEach((p) => { if (!bySrc.has(p.source)) bySrc.set(p.source, []); bySrc.get(p.source).push(p); });
    const channels = [];
    let i = 0;
    for (const [source, list] of bySrc) {
      i++;
      list.sort((a, b) => b.width * b.height - a.width * a.height);
      const main = list[0]; const sub = list[list.length - 1];
      const mainUri = await this.streamUri(main.token);
      const subUri = sub.token === main.token ? mainUri : await this.streamUri(sub.token).catch(() => mainUri);
      channels.push({ source, name: bySrc.size > 1 ? `Canal ${i}` : (info.model || 'Cámara'), main: mainUri, sub: subUri, mainToken: main.token, ptz: !!(this.ptz && main.ptz), resolution: main.width ? `${main.width}x${main.height}` : '', encoding: main.encoding });
    }
    return { info, ptz: !!this.ptz, ptzUrl: this.ptz, mediaUrl: this.media, channels };
  }
  /** PTZ: velocidades -1..1. */
  async move(token, { x = 0, y = 0, zoom = 0 }) {
    if (!this.ptz) await this.capabilities();
    if (!this.ptz) throw new Error('La cámara no tiene PTZ');
    return this.call(this.ptz, `<tptz:ContinuousMove><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:Velocity>`
      + `${x || y ? `<tt:PanTilt x="${x}" y="${y}"/>` : ''}${zoom ? `<tt:Zoom x="${zoom}"/>` : ''}</tptz:Velocity></tptz:ContinuousMove>`);
  }
  async stop(token) {
    if (!this.ptz) await this.capabilities();
    return this.call(this.ptz, `<tptz:Stop><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
  }
}

/** Inserta usuario y clave en una URL RTSP (las que devuelve ONVIF vienen sin credenciales). */
function withCredentials(uri, user, pass) {
  try {
    const u = new URL(uri);
    if (!/^rtsps?:$/.test(u.protocol)) return uri;
    if (user && !u.username) { u.username = encodeURIComponent(user); u.password = encodeURIComponent(pass || ''); }
    return u.toString();
  } catch { return uri; }
}

/** Código PTZ del panel (Up, LeftDown, ZoomTele…) → velocidades ONVIF. */
function ptzVector(code, speed = 4) {
  const v = Math.max(0.1, Math.min(1, speed / 8));
  const m = { Up: [0, v], Down: [0, -v], Left: [-v, 0], Right: [v, 0], LeftUp: [-v, v], RightUp: [v, v], LeftDown: [-v, -v], RightDown: [v, -v] };
  if (code === 'ZoomTele') return { zoom: v };
  if (code === 'ZoomWide') return { zoom: -v };
  const [x, y] = m[code] || [0, 0];
  return { x, y };
}

module.exports = { OnvifDevice, wsse, blocks, first, withCredentials, ptzVector };
