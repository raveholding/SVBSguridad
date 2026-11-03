'use strict';
/** Grabador ONVIF simulado para las pruebas (valida WS-Security de verdad). Uso suelto: node test/fake-onvif.js → imprime el puerto. */
const http = require('http');
const crypto = require('crypto');
const { first } = require('../lib/onvif-client');

/** Grabador ONVIF simulado: 2 fuentes de video × (principal 1080p + secundario 352p), PTZ en el canal 1. */
function fakeOnvif({ user = 'admin', pass = 'clave-onvif' } = {}) {
  const calls = [];
  const env = (b) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="x" xmlns:trt="y" xmlns:tt="z"><SOAP-ENV:Body>${b}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const op = (body.match(/<s:Body><(?:\w+:)?(\w+)/) || [])[1];
      calls.push({ op, path: req.url, body });
      const ok = (b) => { res.writeHead(200, { 'Content-Type': 'application/soap+xml' }); res.end(env(b)); };
      if (op === 'GetSystemDateAndTime') {
        const d = new Date(Date.now() + 3600e3); // reloj del equipo 1 h adelantado
        return ok(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
      }
      // WS-Security UsernameToken PasswordDigest
      const u = first(body, 'Username'); const pw = first(body, 'Password'); const nonce = first(body, 'Nonce'); const created = first(body, 'Created');
      const exp = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(pass)])).digest('base64');
      const skew = Math.abs(Date.parse(created) - (Date.now() + 3600e3));
      if (u !== user || pw !== exp || skew > 30000) { res.writeHead(400, { 'Content-Type': 'application/soap+xml' }); return res.end(env('<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text>Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>')); }
      const base = `http://127.0.0.1:${srv.address().port}`;
      if (op === 'GetDeviceInformation') return ok('<tds:GetDeviceInformationResponse><tds:Manufacturer>Hikvision</tds:Manufacturer><tds:Model>DS-7608NI</tds:Model><tds:FirmwareVersion>V4.30</tds:FirmwareVersion><tds:SerialNumber>DS7608-TEST</tds:SerialNumber></tds:GetDeviceInformationResponse>');
      if (op === 'GetCapabilities') return ok(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>${base}/onvif/Media</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>${base}/onvif/PTZ</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>`);
      const prof = (tok, src, w, h, ptz) => `<trt:Profiles token="${tok}" fixed="true"><tt:Name>${tok}</tt:Name><tt:VideoSourceConfiguration token="V${src}"><tt:SourceToken>VideoSource_${src}</tt:SourceToken></tt:VideoSourceConfiguration><tt:VideoEncoderConfiguration token="E${tok}"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>${ptz ? '<tt:PTZConfiguration token="P1"/>' : ''}</trt:Profiles>`;
      if (op === 'GetProfiles') return ok(`<trt:GetProfilesResponse>${prof('Sub1', 1, 352, 288, true)}${prof('Main1', 1, 1920, 1080, true)}${prof('Main2', 2, 2560, 1440, false)}${prof('Sub2', 2, 640, 360, false)}</trt:GetProfilesResponse>`);
      if (op === 'GetStreamUri') { const tok = first(body, 'ProfileToken'); const n = tok.replace(/\D/g, ''); return ok(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:554/Streaming/Channels/${n}0${tok.startsWith('Main') ? 1 : 2}?transportmode=unicast&amp;profile=${tok}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`); }
      if (op === 'ContinuousMove' || op === 'Stop') return ok(`<tptz:${op}Response/>`);
      res.writeHead(400); res.end(env('<SOAP-ENV:Fault><SOAP-ENV:Reason><SOAP-ENV:Text>Acción no soportada</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>'));
    });
  });
  return { srv, calls };
}


module.exports = { fakeOnvif };
if (require.main === module) { const { srv } = fakeOnvif(); srv.listen(0, '127.0.0.1', () => console.log(srv.address().port)); }
