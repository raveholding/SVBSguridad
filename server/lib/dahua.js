'use strict';
/**
 * Utilidades para equipos Dahua (DVR/XVR/NVR/IPC) — usados por la app DMSS.
 *  - Autenticación HTTP Digest (RFC 2617) sin dependencias externas.
 *  - Lectura de número de serie / tipo de equipo vía CGI.
 *  - Armado de URLs RTSP estándar Dahua.
 */
const http = require('http');
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseDigest(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function buildDigestHeader({ user, pass, method, uri, challenge, nc = 1 }) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const qopList = (challenge.qop || '').split(',').map((s) => s.trim()).filter(Boolean);
  const qop = qopList.includes('auth') ? 'auth' : qopList[0];
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const ncHex = nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop
    ? md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (challenge.opaque) h += `, opaque="${challenge.opaque}"`;
  if (challenge.algorithm) h += `, algorithm=${challenge.algorithm}`;
  if (qop) h += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  return h;
}

function rawGet({ host, port = 80, path, headers = {}, timeout = 3000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET', headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** GET con Digest automático (también acepta Basic si el equipo lo pide). */
async function digestGet({ host, port = 80, path, user, pass, timeout = 3000 }) {
  const first = await rawGet({ host, port, path, timeout });
  if (first.status !== 401) return first;
  const wa = first.headers['www-authenticate'] || '';
  if (/^basic/i.test(wa)) {
    const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    return rawGet({ host, port, path, timeout, headers: { Authorization: auth } });
  }
  const challenge = parseDigest(wa.replace(/^digest\s+/i, ''));
  const auth = buildDigestHeader({ user, pass, method: 'GET', uri: path, challenge });
  return rawGet({ host, port, path, timeout, headers: { Authorization: auth } });
}

function parseKV(text) {
  const out = {};
  String(text).split(/\r?\n/).forEach((line) => {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

async function getSerial({ host, port, user, pass, timeout }) {
  const r = await digestGet({ host, port, user, pass, timeout, path: '/cgi-bin/magicBox.cgi?action=getSerialNo' });
  if (r.status !== 200) return { ok: false, status: r.status };
  const kv = parseKV(r.body.toString());
  return { ok: true, serial: kv.sn || null };
}

async function getDeviceType({ host, port, user, pass, timeout }) {
  const r = await digestGet({ host, port, user, pass, timeout, path: '/cgi-bin/magicBox.cgi?action=getDeviceType' });
  if (r.status !== 200) return null;
  return parseKV(r.body.toString()).type || null;
}

/**
 * URL RTSP Dahua. subtype 0 = principal (HD), 1 = secundario (liviano, ideal grilla).
 * La plantilla es configurable para otros fabricantes o para pruebas.
 */
const DEFAULT_RTSP_TEMPLATE = 'rtsp://{user}:{pass}@{host}:{port}/cam/realmonitor?channel={channel}&subtype={subtype}';
function rtspUrl({ template = DEFAULT_RTSP_TEMPLATE, user, pass, host, port = 554, channel = 1, subtype = 0 }) {
  return template
    .replace('{user}', encodeURIComponent(user || ''))
    .replace('{pass}', encodeURIComponent(pass || ''))
    .replace('{host}', host)
    .replace('{port}', String(port))
    .replace('{channel}', String(channel))
    .replace('{subtype}', String(subtype));
}

/** Oculta credenciales en cualquier URL para logs/API. */
function redact(s) {
  return String(s).replace(/\/\/([^:/@\s]+):([^@/\s]+)@/g, '//$1:****@');
}

module.exports = { parseDigest, buildDigestHeader, digestGet, getSerial, getDeviceType, rtspUrl, redact, DEFAULT_RTSP_TEMPLATE, md5, parseKV };
