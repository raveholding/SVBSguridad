'use strict';
/**
 * Sistemas VB Seguridad — Descubrimiento multi-marca de cámaras y grabadores en la red local.
 *
 * Cuatro técnicas combinadas (de la más precisa a la más bruta):
 *   1. ONVIF WS-Discovery: Probe multicast a 239.255.255.250:3702 (Profile S/G/T). Devuelve XAddrs,
 *      nombre, hardware y perfiles que anuncia cada equipo.
 *   2. Tabla ARP del sistema: IP ↔ MAC → fabricante probable por OUI (Hikvision, Dahua, Axis, ESP32…).
 *   3. Huella de puertos: 554 RTSP, 80/8080 HTTP, 8000 Hikvision SDK, 37777 Dahua, 34567 XMeye, 1935 RTMP.
 *   4. Respaldo por rango de IPs (/24 de cada interfaz o CAM_SCAN).
 * Con eso propone la URL RTSP/ONVIF de cada equipo para cargarla en go2rtc.
 * Sin dependencias: dgram + net + child_process.
 */
const dgram = require('dgram');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { candidateHosts, portOpen } = require('./discover');

const WSD_ADDR = '239.255.255.250';
const WSD_PORT = 3702;

function probeMessage(id = crypto.randomUUID()) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
}

const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`)); return m ? m[1].trim() : ''; };

/** Interpreta una respuesta ProbeMatches de WS-Discovery. */
function parseProbeMatch(xml) {
  if (!/ProbeMatch/.test(xml)) return null;
  const xaddrs = tag(xml, 'XAddrs').split(/\s+/).filter(Boolean);
  const scopes = tag(xml, 'Scopes').split(/\s+/).filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const scope = (k) => { const s = scopes.find((x) => x.toLowerCase().startsWith(`onvif://www.onvif.org/${k}/`)); return s ? s.split('/').slice(4).join('/') : ''; };
  const profiles = [...new Set(scopes.filter((s) => /onvif:\/\/www\.onvif\.org\/profile\//i.test(s)).map((s) => s.split('/').pop().toUpperCase()))];
  let host = ''; let port = 80;
  try { const u = new URL(xaddrs[0]); host = u.hostname; port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80); } catch { /* sin XAddrs */ }
  return {
    uuid: (tag(xml, 'Address').match(/[0-9a-f-]{36}/i) || [''])[0],
    host, port, xaddrs,
    name: scope('name'), hardware: scope('hardware'), location: scope('location'),
    profiles: profiles.map((p) => (p === 'STREAMING' ? 'S' : p)),
    types: tag(xml, 'Types'),
  };
}

/**
 * WS-Discovery. Envía el Probe por multicast (o a target, para pruebas) y junta respuestas.
 * @returns {Promise<object[]>}
 */
function wsDiscover({ timeout = 2500, target = null, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve([]); }
    const done = () => { try { sock.close(); } catch { /* cerrado */ } resolve([...found.values()]); };
    sock.on('error', (e) => { log(`WS-Discovery: ${e.message}`); done(); });
    sock.on('message', (buf, rinfo) => {
      const m = parseProbeMatch(buf.toString('utf8'));
      if (!m) return;
      if (!m.host) m.host = rinfo.address;
      found.set(m.uuid || m.host, m);
    });
    sock.bind(0, () => {
      try { if (!target) { sock.setBroadcast(true); sock.setMulticastTTL(2); } } catch { /* sin multicast */ }
      const msg = Buffer.from(probeMessage());
      const to = target || { address: WSD_ADDR, port: WSD_PORT };
      // Se envía dos veces: UDP puede perderse en WiFi
      sock.send(msg, to.port, to.address, () => {});
      setTimeout(() => { try { sock.send(msg, to.port, to.address, () => {}); } catch { /* cerrado */ } }, 300);
      setTimeout(done, timeout);
    });
  });
}

/** Tabla ARP del sistema operativo → [{ip, mac}] */
function readArp() {
  return new Promise((resolve) => {
    try {
      const t = fs.readFileSync('/proc/net/arp', 'utf8');
      return resolve(parseArp(t));
    } catch { /* no es Linux */ }
    execFile('arp', ['-a'], { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? [] : parseArp(String(out))));
  });
}
function parseArp(text) {
  const out = []; const seen = new Set();
  text.split(/\r?\n/).forEach((l) => {
    const ip = (l.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) || [])[1];
    const mac = (l.match(/\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i) || [])[1];
    if (!ip || !mac || /^(00[:-]){5}00$/i.test(mac) || /^ff[:-]ff/i.test(mac) || seen.has(ip)) return;
    seen.add(ip); out.push({ ip, mac: mac.toUpperCase().replace(/-/g, ':') });
  });
  return out;
}

// Prefijos OUI conocidos (indicativo: los fabricantes compran rangos nuevos con el tiempo).
const OUI = {
  hikvision: ['44:19:B6', 'BC:AD:28', 'C0:56:E3', '4C:BD:8F', '28:57:BE', '54:C4:15', '18:68:CB', 'A4:14:37'],
  dahua: ['3C:EF:8C', '90:02:A9', '4C:11:BF', 'E0:50:8B', 'A0:BD:1D', '14:A7:8B', '38:AF:29', '9C:14:63'],
  axis: ['00:40:8C', 'AC:CC:8E', 'B8:A4:4F'],
  reolink: ['EC:71:DB'],
  espressif: ['24:0A:C4', '30:AE:A4', 'A4:CF:12', '24:6F:28', '7C:9E:BD', '84:CC:A8', '08:3A:F2', 'C8:C9:A3'],
};
function vendorFromMac(mac) {
  const p = String(mac || '').toUpperCase().slice(0, 8);
  return Object.keys(OUI).find((v) => OUI[v].includes(p)) || null;
}

const PORTS = [554, 80, 8080, 8000, 37777, 34567, 1935, 8899];
function vendorFromPorts(open) {
  if (open.includes(37777)) return 'dahua';
  if (open.includes(8000) && open.includes(554)) return 'hikvision';
  if (open.includes(34567)) return 'xmeye';
  return null;
}
function vendorFromText(s) {
  const t = String(s || '').toLowerCase();
  if (/hikvision|hik-?connect|ezviz/.test(t)) return 'hikvision';
  if (/dahua|imou|dh-|ipc-hfw|ipc-hdw|nvr\d|xvr/.test(t)) return 'dahua';
  if (/axis/.test(t)) return 'axis';
  if (/reolink/.test(t)) return 'reolink';
  if (/uniview|unv/.test(t)) return 'uniview';
  return null;
}

/** Plantillas RTSP por marca. {user} {pass} {host} {port} {channel} */
const RTSP_TEMPLATES = {
  dahua: 'rtsp://{user}:{pass}@{host}:554/cam/realmonitor?channel={channel}&subtype=0',
  hikvision: 'rtsp://{user}:{pass}@{host}:554/Streaming/Channels/{channel}01',
  uniview: 'rtsp://{user}:{pass}@{host}:554/unicast/c{channel}/s0/live',
  axis: 'rtsp://{user}:{pass}@{host}:554/axis-media/media.amp',
  reolink: 'rtsp://{user}:{pass}@{host}:554/h264Preview_0{channel}_main',
  xmeye: 'rtsp://{host}:554/user={user}&password={pass}&channel={channel}&stream=0.sdp',
  onvif: 'onvif://{user}:{pass}@{host}:{port}',
};
function suggestUrl(dev) {
  const v = dev.vendor && RTSP_TEMPLATES[dev.vendor] ? dev.vendor : dev.onvif ? 'onvif' : null;
  if (!v) return dev.ports.includes(554) ? `rtsp://{user}:{pass}@${dev.ip}:554/` : null;
  return RTSP_TEMPLATES[v].replace('{host}', dev.ip).replace('{port}', String((dev.onvif && dev.onvif.port) || 80)).replace('{channel}', '1');
}

/**
 * Descubrimiento completo. Devuelve una lista unificada de equipos con fabricante probable,
 * datos ONVIF, puertos abiertos y URL sugerida (con {user}/{pass} para completar).
 */
async function discoverAll({ scan = '', timeout = 400, wsTimeout = 2500, ports = PORTS, wsTarget = null, log = () => {}, concurrency = 64 } = {}) {
  const t0 = Date.now();
  const [ws, arp] = await Promise.all([wsDiscover({ timeout: wsTimeout, target: wsTarget, log }), readArp()]);
  const byIp = new Map();
  const get = (ip) => { if (!byIp.has(ip)) byIp.set(ip, { ip, mac: null, vendor: null, onvif: null, ports: [] }); return byIp.get(ip); };
  ws.forEach((m) => { const d = get(m.host); d.onvif = m; d.vendor = d.vendor || vendorFromText(`${m.name} ${m.hardware}`); });
  arp.forEach(({ ip, mac }) => { if (byIp.has(ip) || vendorFromMac(mac)) { const d = get(ip); d.mac = mac; d.vendor = d.vendor || vendorFromMac(mac); } });
  // Puertos: equipos ya vistos + barrido del rango (respaldo)
  const hosts = [...new Set([...byIp.keys(), ...candidateHosts(scan)])];
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (idx < hosts.length) {
      const h = hosts[idx++];
      const open = [];
      // primero 554/80 (lo más común); el resto solo si respondió alguno
      for (const p of ports.slice(0, 2)) if (await portOpen(h, p, timeout)) open.push(p);
      if (open.length || byIp.has(h)) for (const p of ports.slice(2)) if (await portOpen(h, p, timeout)) open.push(p);
      if (!open.length && !byIp.has(h)) continue;
      const d = get(h); d.ports = open;
      d.vendor = d.vendor || vendorFromPorts(open);
    }
  }));
  const devices = [...byIp.values()]
    .filter((d) => d.onvif || d.ports.some((p) => [554, 8000, 37777, 34567, 1935, 8899].includes(p)) || ['espressif'].includes(d.vendor))
    .map((d) => ({ ...d, kind: d.vendor === 'espressif' ? 'esp32' : 'camara', url: d.vendor === 'espressif' ? null : suggestUrl(d) }))
    .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return { devices, scanned: hosts.length, onvif: ws.length, arp: arp.length, ms: Date.now() - t0 };
}

module.exports = { wsDiscover, parseProbeMatch, probeMessage, readArp, parseArp, vendorFromMac, vendorFromText, vendorFromPorts, discoverAll, RTSP_TEMPLATES, suggestUrl };
