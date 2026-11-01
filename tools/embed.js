#!/usr/bin/env node
'use strict';
/**
 * Mantiene index.html como archivo único autosuficiente:
 * inserta el codificador QR (tests/qr-encoder.js) y el firmware ESP32 (firmware/…/*.ino)
 * entre sus marcadores. Uso: node tools/embed.js   |   node tools/embed.js --check
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const qr = fs.readFileSync(path.join(ROOT, 'tests', 'qr-encoder.js'), 'utf8')
  .replace(/\nif \(typeof module[^\n]*\n?/, '\n').trim();
const fw = fs.readFileSync(path.join(ROOT, 'firmware', 'esp32_cerradura', 'esp32_cerradura.ino'), 'utf8').trim();
if (fw.includes('</script')) throw new Error('El firmware no puede contener </script');

const out = html
  .replace(/\/\*@@QR_BEGIN\*\/[\s\S]*?\/\*@@QR_END\*\//, () => `/*@@QR_BEGIN*/\n${qr}\n/*@@QR_END*/`)
  .replace(/<!--@@FW_BEGIN-->[\s\S]*?<!--@@FW_END-->/, () => `<!--@@FW_BEGIN--><script type="text/plain" id="fw-src">${fw}\n</script><!--@@FW_END-->`);

if (process.argv.includes('--check')) {
  if (out !== html) { console.error('index.html desactualizado: ejecutar node tools/embed.js'); process.exit(1); }
  console.log('index.html sincronizado');
} else {
  fs.writeFileSync(htmlPath, out);
  console.log('index.html actualizado');
}
