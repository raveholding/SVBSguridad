@echo off
chcp 65001 >nul
title SVB Seguridad - Actualizar

rem Se copia a TEMP y se ejecuta desde ahi, porque este mismo archivo se reemplaza al actualizar.
if not "%~1"=="" goto :update
copy /y "%~f0" "%TEMP%\svb-actualizar.bat" >nul
"%TEMP%\svb-actualizar.bat" "%~dp0."

:update
set "DEST=%~f1"
set "TMPD=%TEMP%\svb-update"
echo.
echo  Actualizando SVB Seguridad en:
echo  %DEST%
echo  Tu configuracion .env, los registros y las fotos NO se tocan.
echo.
if exist "%TMPD%" rmdir /s /q "%TMPD%"
mkdir "%TMPD%"
echo Descargando la ultima version...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/raveholding/SVBSguridad/archive/refs/heads/main.zip' -OutFile '%TMPD%\svb.zip'; Expand-Archive -Force -Path '%TMPD%\svb.zip' -DestinationPath '%TMPD%'"
if errorlevel 1 goto :fail
if not exist "%TMPD%\SVBSguridad-main\index.html" goto :fail

echo Instalando...
robocopy "%TMPD%\SVBSguridad-main" "%DEST%" /E /XF .env /XD data bin node_modules .git /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :fail
rmdir /s /q "%TMPD%"

echo.
echo  =============================================
echo   LISTO: SVB Seguridad actualizado.
echo   1. Cerra la ventana negra del sistema si esta abierta.
echo   2. Abri de nuevo iniciar-windows.
echo   3. En el navegador apreta Ctrl + F5.
echo  =============================================
echo.
pause
exit

:fail
echo.
echo [!] No se pudo actualizar. Revisa la conexion a internet y volve a intentar.
pause
exit
