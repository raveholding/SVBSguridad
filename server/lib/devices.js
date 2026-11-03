'use strict';
/**
 * Sistemas VB Seguridad — Inventario de equipos de video (data/devices.json).
 *
 * Varios grabadores y cámaras de cualquier marca conviven con el grabador Dahua "principal" del .env.
 * Cada canal recibe un número global estable (17, 18, …; del 1 al 16 quedan para el grabador principal)
 * que el panel usa para la grilla, el orden, los nombres y las fotos. go2rtc publica cada canal como
 * svb_ch<N> (secundario) y svb_ch<N>_hd (principal).
 *
 * Las claves de los equipos se guardan cifradas con la bóveda (AES-256-GCM) cuando hay una disponible.
 */
const fs = require('fs');
const crypto = require('crypto');
const { RTSP_TEMPLATES } = require('./onvif');

const FIRST_CH = 17;
const MAX_CH = 256;
const VENDORS = ['onvif', 'dahua', 'hikvision', 'uniview', 'axis', 'reolink', 'xmeye', 'rtsp'];

const clean = (s, n = 40) => String(s || '').replace(/[\r\n"\\]/g, ' ').trim().slice(0, n);
const validHost = (h) => /^[\w.-]{1,253}$/.test(String(h || ''));

/** URL de un canal por plantilla de marca (cuando el equipo no tiene ONVIF). */
function templateUrl(vendor, { host, user, pass, channel, sub = false }) {
  let t = RTSP_TEMPLATES[vendor];
  if (!t || vendor === 'onvif') return null;
  if (sub) {
    t = t.replace('subtype=0', 'subtype=1').replace('Channels/{channel}01', 'Channels/{channel}02').replace('/s0/', '/s1/').replace('_main', '_sub').replace('stream=0.sdp', 'stream=1.sdp');
  }
  return t.replace('{user}', encodeURIComponent(user || '')).replace('{pass}', encodeURIComponent(pass || '')).replace('{host}', host).replace(/\{channel\}/g, String(channel));
}

class DeviceStore {
  constructor(file, { vault = null } = {}) {
    this.file = file; this.vault = vault;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primera vez */ }
    this.devices = Array.isArray(d.devices) ? d.devices : [];
    this.wizard = d.wizard && typeof d.wizard === 'object' ? d.wizard : { done: false };
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices, wizard: this.wizard }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  _seal(p) { return this.vault && p ? this.vault.encrypt(p) : p; }
  pass(dev) {
    const p = dev.pass || '';
    if (p.startsWith('enc:v1:') && !this.vault) return '';
    try { return this.vault ? this.vault.decrypt(p) : p; } catch { return ''; }
  }
  /** Cambia la bóveda (activar/desactivar el cifrado) volviendo a guardar las claves. */
  setVault(v) {
    const plain = this.devices.map((d) => this.pass(d));
    this.vault = v;
    this.devices.forEach((d, i) => { d.pass = this._seal(plain[i]); });
    if (this.devices.length) this.save();
  }
  _nextCh(n) {
    const used = new Set(this.devices.flatMap((d) => d.channels.map((c) => c.ch)));
    const out = [];
    for (let ch = FIRST_CH; ch <= MAX_CH && out.length < n; ch++) if (!used.has(ch)) out.push(ch);
    if (out.length < n) throw new Error('Se alcanzó el máximo de cámaras');
    return out;
  }
  get(id) { return this.devices.find((d) => d.id === id); }
  findByHost(host, port) { return this.devices.find((d) => d.host === host && (!port || d.port === port)); }

  /**
   * Alta de un equipo.
   * @param {object} b { name, host, port, user, pass, vendor, mode:'onvif'|'template'|'rtsp', channels:[{name, main, sub, token, ptz}] | count, info, ptzUrl, mediaUrl }
   */
  add(b) {
    if (!validHost(b.host)) throw new Error('Dirección del equipo inválida');
    const vendor = VENDORS.includes(b.vendor) ? b.vendor : b.mode === 'onvif' ? 'onvif' : 'rtsp';
    const port = Math.max(1, Math.min(65535, parseInt(b.port, 10) || 80));
    if (this.findByHost(b.host, port)) throw new Error('Ese equipo ya está agregado');
    let chans;
    if (Array.isArray(b.channels) && b.channels.length) {
      chans = b.channels.slice(0, 64).map((c, i) => ({ name: clean(c.name || `Cámara ${i + 1}`, 30), main: String(c.main || ''), sub: String(c.sub || c.main || ''), token: c.token ? clean(c.token, 64) : null, ptz: !!c.ptz }));
    } else {
      const n = Math.max(1, Math.min(64, parseInt(b.count, 10) || 1));
      if (vendor === 'rtsp' || vendor === 'onvif') throw new Error('Para este equipo cargá la dirección RTSP o usá ONVIF');
      chans = Array.from({ length: n }, (_, i) => ({ name: `Cámara ${i + 1}`, tplChannel: i + 1, ptz: false }));
    }
    chans.forEach((c) => { if (c.main && !/^(rtsps?|onvif|rtmp|https?):\/\//i.test(c.main)) throw new Error('URL de video inválida'); });
    const nums = this._nextCh(chans.length);
    const dev = {
      id: crypto.randomBytes(5).toString('hex'), name: clean(b.name || (b.info && [b.info.manufacturer, b.info.model].filter(Boolean).join(' ')) || `Equipo ${b.host}`, 40),
      vendor, mode: b.mode === 'onvif' ? 'onvif' : vendor === 'rtsp' ? 'rtsp' : 'template', host: b.host, port, user: clean(b.user, 64), pass: this._seal(String(b.pass || '')),
      info: b.info ? { manufacturer: clean(b.info.manufacturer), model: clean(b.info.model), firmware: clean(b.info.firmware), serial: clean(b.info.serial) } : null,
      ptzUrl: b.ptzUrl || null, added: new Date().toISOString(),
      channels: chans.map((c, i) => ({ ch: nums[i], enabled: true, ...c })),
    };
    this.devices.push(dev); this.save();
    return dev;
  }
  update(id, b) {
    const d = this.get(id); if (!d) throw new Error('Equipo inexistente');
    if (b.name !== undefined) d.name = clean(b.name, 40) || d.name;
    if (b.user !== undefined) d.user = clean(b.user, 64);
    if (b.pass) d.pass = this._seal(String(b.pass));
    if (Array.isArray(b.channels)) b.channels.forEach((u) => { const c = d.channels.find((x) => x.ch === +u.ch); if (!c) return; if (u.name !== undefined) c.name = clean(u.name, 30) || c.name; if (u.enabled !== undefined) c.enabled = !!u.enabled; });
    this.save(); return d;
  }
  remove(id) { const n = this.devices.length; this.devices = this.devices.filter((d) => d.id !== id); if (n !== this.devices.length) this.save(); return n !== this.devices.length; }

  /** URL efectiva (con credenciales) de un canal. */
  urls(dev, c) {
    const pass = this.pass(dev);
    if (c.tplChannel) return { main: templateUrl(dev.vendor, { host: dev.host, user: dev.user, pass, channel: c.tplChannel }), sub: templateUrl(dev.vendor, { host: dev.host, user: dev.user, pass, channel: c.tplChannel, sub: true }) };
    const inject = (u) => { try { const x = new URL(u); if (/^rtsps?:$/.test(x.protocol) && dev.user && !x.username) { x.username = encodeURIComponent(dev.user); x.password = encodeURIComponent(pass); } return x.toString(); } catch { return u; } };
    return { main: inject(c.main), sub: inject(c.sub || c.main) };
  }
  /** Canales habilitados para el panel y go2rtc. */
  streams() {
    const out = [];
    this.devices.forEach((d) => d.channels.filter((c) => c.enabled).forEach((c) => out.push({
      ch: c.ch, name: c.name, sd: `svb_ch${c.ch}`, hd: `svb_ch${c.ch}_hd`, device: d.id, deviceName: d.name, vendor: d.vendor,
      caps: { ptz: !!(c.ptz && c.token && d.ptzUrl), playback: false, dvr: false },
    })));
    return out;
  }
  channel(ch) { for (const d of this.devices) { const c = d.channels.find((x) => x.ch === +ch); if (c) return { dev: d, c }; } return null; }
  /** Vista pública: sin claves; URLs sin credenciales. */
  view(d) {
    const strip = (u) => { try { const x = new URL(u); x.username = ''; x.password = ''; return x.toString(); } catch { return u || ''; } };
    return { id: d.id, name: d.name, vendor: d.vendor, mode: d.mode, host: d.host, port: d.port, user: d.user, passSet: !!d.pass, info: d.info, ptz: !!d.ptzUrl, added: d.added,
      channels: d.channels.map((c) => ({ ch: c.ch, name: c.name, enabled: c.enabled, ptz: !!c.ptz, url: c.tplChannel ? strip(templateUrl(d.vendor, { host: d.host, user: '', pass: '', channel: c.tplChannel })) : strip(c.main) })) };
  }
}

module.exports = { DeviceStore, templateUrl, FIRST_CH, VENDORS };
