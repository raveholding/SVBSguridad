#!/usr/bin/env bash
# SVB Seguridad — inicio en Linux / Raspberry Pi / mini PC
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Falta Node.js (>=18): https://nodejs.org"; exit 1; }
[ -f .env ] || { cp .env.example .env; echo "Se creó .env: completá CAM_SERIAL, CAM_PASS y PINs, y volvé a ejecutar."; exit 0; }
[ -x server/bin/go2rtc ] || node server/scripts/get-go2rtc.js
exec node server/server.js
