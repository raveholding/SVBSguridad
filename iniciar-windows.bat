@echo off
chcp 65001 >nul
title SVB Seguridad - Almacen Rave
cd /d "%~dp0"

rem Comprobar que el ZIP fue extraido
if not exist "server\server.js" goto :nozip

rem Comprobar Node.js
where node >nul 2>nul
if errorlevel 1 goto :nonode
for /f "delims=" %%v in ('node -v') do echo Node.js %%v encontrado.

rem Crear .env si falta
if not exist ".env" goto :noenv

rem Descargar go2rtc la primera vez
if exist "server\bin\go2rtc.exe" goto :run
echo Descargando go2rtc - solo la primera vez...
node server\scripts\get-go2rtc.js
if errorlevel 1 goto :nogo2rtc

:run
echo.
echo  =============================================
echo   SVB Seguridad funcionando
echo   Panel: http://localhost:8080
echo   NO CIERRES ESTA VENTANA mientras uses el sistema
echo  =============================================
echo.
start "" "http://localhost:8080"
node server\server.js
echo.
echo El servidor se detuvo. Si ves un error arriba, sacale una foto.
pause
exit /b 0

:nozip
echo [!] Primero hay que EXTRAER el ZIP: clic derecho en SVB-Rave.zip, Extraer todo.
echo     Despues abri este archivo desde la carpeta extraida.
pause
exit /b 1

:nonode
echo [!] No se encontro Node.js.
echo     Instalalo desde https://nodejs.org - version LTS - y REINICIA la PC.
echo     Despues volve a abrir este archivo.
pause
exit /b 1

:noenv
copy ".env.example" ".env" >nul
echo [!] Se creo el archivo .env. Completa CAM_SERIAL, CAM_PASS y los PINs, guarda y volve a abrir este archivo.
notepad ".env"
pause
exit /b 0

:nogo2rtc
echo [!] No se pudo descargar go2rtc. Revisa la conexion a internet y volve a intentar.
pause
exit /b 1
