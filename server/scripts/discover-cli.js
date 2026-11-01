#!/usr/bin/env node
'use strict';
/** Busca el grabador Dahua en la red local: `npm run discover` */
const path = require('path');
const { loadEnv, readConfig } = require('../lib/env');
const { discover } = require('../lib/discover');

loadEnv(path.join(__dirname, '..', '..', '.env'));
const cfg = readConfig();
if (!cfg.cam.pass) { console.error('Falta CAM_PASS en el archivo .env'); process.exit(1); }

discover({ scan: cfg.cam.scan, httpPort: cfg.cam.httpPort, rtspPort: cfg.cam.rtspPort, user: cfg.cam.user, pass: cfg.cam.pass, serial: cfg.cam.serial, log: console.log })
  .then((r) => {
    console.log(`\nDirecciones revisadas: ${r.scanned}`);
    r.devices.forEach((d) => console.log(` - ${d.host}  ${d.type || ''}  ${d.match ? '← ES EL DE RAVE' : ''} ${d.auth || d.error || ''}`));
    if (r.found) console.log(`\n✔ Poné en .env:  CAM_HOST=${r.found.host}`);
    else console.log('\n✖ No se encontró. Revisá que esta PC esté en la misma red WiFi/cable que el grabador.');
  });
