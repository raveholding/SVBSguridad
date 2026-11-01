@echo off
chcp 65001 >nul
title SVB Seguridad - Almacen Rave
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Falta Node.js. Instalalo desde https://nodejs.org (version LTS) y volve a abrir este archivo.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [!] Se creo el archivo .env. Completa CAM_SERIAL, CAM_PASS y los PINs, guarda y volve a abrir.
  notepad ".env"
  exit /b 0
)

if not exist "server\bin\go2rtc.exe" (
  echo Descargando go2rtc...
  node server\scripts\get-go2rtc.js
)

echo.
echo  Panel:  http://localhost:8080
echo  Para cerrar: cerrar esta ventana.
echo.
start "" http://localhost:8080
node server\server.js
pause
