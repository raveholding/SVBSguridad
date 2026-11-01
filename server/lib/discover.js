'use strict';
/**
 * Descubrimiento automático del grabador Dahua en la red local del almacén.
 * La app DMSS se conecta por P2P (nube Dahua) usando el número de serie, pero el
 * puente necesita la IP local. Este módulo barre la red /24 de cada interfaz,
 * busca equipos con HTTP abierto y consulta su número de serie (Digest auth)
 * hasta encontrar el que coincide con CAM_SERIAL.
 */
const net = require('net');
const os = require('os');
const { getSerial, getDeviceType } = require('./dahua');

function portOpen(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Lista de IPs candidatas. scan acepta "192.168.1.0/24", "10.0.0.5,10.0.0.9" o vacío (auto). */
function candidateHosts(scan) {
  const hosts = new Set();
  const addCidr24 = (base) => {
    const p = base.split('.').slice(0, 3).join('.');
    for (let i = 1; i < 255; i++) hosts.add(`${p}.${i}`);
  };
  if (scan && scan.trim()) {
    scan.split(',').map((s) => s.trim()).filter(Boolean).forEach((item) => {
      if (item.endsWith('/24')) addCidr24(item.replace('/24', ''));
      else hosts.add(item);
    });
    return [...hosts];
  }
  const ifs = os.networkInterfaces();
  Object.values(ifs).flat().forEach((i) => {
    if (i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) addCidr24(i.address);
  });
  return [...hosts];
}

async function pool(items, size, fn) {
  const out = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) {
      const my = items[idx++];
      out.push(await fn(my));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @returns {Promise<{found: object|null, devices: object[], scanned: number}>}
 */
async function discover({ scan, httpPort = 80, rtspPort = 554, user, pass, serial, timeout = 400, concurrency = 64, log = () => {} }) {
  const hosts = candidateHosts(scan);
  log(`Escaneando ${hosts.length} direcciones (puerto HTTP ${httpPort})...`);
  const open = (await pool(hosts, concurrency, async (h) => ((await portOpen(h, httpPort, timeout)) ? h : null))).filter(Boolean);
  const devices = [];
  for (const host of open) {
    try {
      const r = await getSerial({ host, port: httpPort, user, pass, timeout: 2500 });
      if (!r.ok) {
        devices.push({ host, auth: r.status === 401 ? 'credenciales rechazadas' : `HTTP ${r.status}` });
        continue;
      }
      const type = await getDeviceType({ host, port: httpPort, user, pass, timeout: 2500 }).catch(() => null);
      const rtsp = await portOpen(host, rtspPort, 800);
      const dev = { host, serial: r.serial, type, rtsp, match: !!serial && r.serial && r.serial.toUpperCase() === serial.toUpperCase() };
      devices.push(dev);
      if (dev.match) {
        log(`Equipo encontrado: ${host} (${type || 'Dahua'})`);
        return { found: dev, devices, scanned: hosts.length };
      }
    } catch (e) {
      devices.push({ host, error: e.message });
    }
  }
  return { found: null, devices, scanned: hosts.length };
}

module.exports = { discover, candidateHosts, portOpen };
