"""
Instalación de fábrica en navegador real: asistente de instalación (negocio, PINs, cámaras ONVIF de cualquier
marca con un grabador simulado, cerradura, avisos), sección Equipos y cámaras, grilla con los canales nuevos,
PTZ solo en la cámara motorizada, periféricos detectados y perfiles de pantalla automáticos
(tablet de pared, celular, PC, monitor).

Uso:  python3 tests/e2e_instalacion.py      (Node.js + Playwright; no usa go2rtc)
"""
import json, os, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
tmp = tempfile.mkdtemp(prefix='svb-e2e-inst-'); open(os.path.join(tmp, '.env'), 'w').close()
onvif = subprocess.Popen(['node', 'test/fake-onvif.js'], cwd=os.path.join(ROOT, 'server'), stdout=subprocess.PIPE, text=True)
OPORT = int(onvif.stdout.readline().strip())
env = {**os.environ, 'PORT': str(PORT), 'HOST': '127.0.0.1', 'GO2RTC_DISABLED': '1', 'DATA_DIR': os.path.join(tmp, 'data'), 'DOORBELL': '0', 'WIZARD_AUTO': '1', 'TELEGRAM_POLL': '0', 'PUSH_ENABLED': '0', 'SVB_ENV_FILE': os.path.join(tmp, '.env')}
srv = subprocess.Popen(['node', 'server.js'], cwd=os.path.join(ROOT, 'server'), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
URL = f'http://localhost:{PORT}/'
errs, ok = [], []
def check(name, cond, extra=''):
    ok.append((name, bool(cond))); print(('✔' if cond else '✘'), name, extra if not cond else '')
def api(path, pin='1234'):
    req = urllib.request.Request(URL.rstrip('/') + path, headers={'X-Admin-Pin': pin})
    with urllib.request.urlopen(req, timeout=20) as r: return json.loads(r.read())
def keys(pg, digits):
    for k in digits: pg.locator(f'#adminKeys [data-k="{k}"]').click()
    pg.locator('#adminKeys [data-k="OK"]').click()
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        # Tablet de pared (táctil)
        ctx = b.new_context(viewport={'width': 1280, 'height': 800}, has_touch=True, permissions=['camera', 'microphone'])
        pg = ctx.new_page()
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        pg.goto(URL + "?consola=1"); pg.wait_for_timeout(2000)
        check('tablet táctil → perfil pared', pg.evaluate("document.body.classList.contains('prof-pared')"))
        check('logo propio del sistema', pg.evaluate("document.querySelector('#logo').src").endswith('assets/rave-logo.jpg'))
        check('marca de fábrica neutra', pg.locator('#bizName').inner_text() == 'Almacén Rave')
        check('sin cámaras: indica dónde agregarlas', 'Equipos y cámaras' in (pg.locator('.tab[data-view="cctv"]').click() or pg.wait_for_timeout(600) or pg.locator('#cctvGrid').inner_text()))
        pg.locator('.tab[data-view="door"]').click()
        # Primer ingreso a administración → asistente
        pg.locator('#btnAdmin').click(); pg.wait_for_timeout(300); keys(pg, '1234'); pg.wait_for_timeout(1500)
        check('el asistente se abre solo la primera vez', pg.locator('#wizOv').is_visible())
        pg.screenshot(path=SHOTS + '/inst-01-asistente.png')
        pg.fill('#wzBiz', 'Ferretería El Tornillo'); pg.select_option('#wzSector', 'comercio')
        pg.locator('#wizNext').click(); pg.wait_for_timeout(1200)
        check('paso 1 guarda negocio', 'BUSINESS_NAME=Ferretería El Tornillo' in open(os.path.join(tmp, '.env')).read() and pg.locator('#bizName').inner_text() == 'Ferretería El Tornillo')
        pg.locator('#wizNext').click(); pg.wait_for_timeout(500)
        check('exige cambiar los PINs de fábrica', 'cambiá los PINs' in pg.locator('#wzOut').inner_text())
        pg.fill('#wzDoor', '4826'); pg.fill('#wzDuress', '7391'); pg.fill('#wzAdmin', '5150')
        check('contraseña del panel marcada por defecto', pg.locator('#wzPanelOn').is_checked())
        pg.locator('#wizNext').click(); pg.wait_for_timeout(800)
        check('exige completar la contraseña del panel o desmarcar', 'Completá usuario' in pg.locator('#wzOut').inner_text())
        pg.locator('#wzPanelOn').uncheck()  # en la prueba el navegador automatizado no puede responder el pedido de contraseña
        pg.locator('#wizNext').click(); pg.wait_for_timeout(1200)
        check('PINs nuevos guardados', 'DOOR_PIN=4826' in open(os.path.join(tmp, '.env')).read())
        # Cámaras: agregar el grabador ONVIF a mano (en la prueba no hay multicast)
        pg.locator('#wizOv [data-eq="manual"]').click(); pg.wait_for_timeout(300)
        f = pg.locator('#wizOv [data-eqform] .cfgcard')
        f.locator('[data-af="host"]').fill('127.0.0.1'); f.locator('[data-af="port"]').fill(str(OPORT)); f.locator('[data-af="pass"]').fill('mal')
        f.locator('[data-eq="probe"]').click(); pg.wait_for_timeout(1500)
        check('clave incorrecta: mensaje claro', 'contraseña' in f.locator('[data-eqout]').inner_text())
        f.locator('[data-af="pass"]').fill('clave-onvif'); f.locator('[data-eq="probe"]').click(); pg.wait_for_timeout(1500)
        check('Probar muestra marca, modelo y canales', 'Hikvision DS-7608NI' in f.inner_text() and '1920x1080' in f.inner_text(), f.inner_text()[:300])
        f.locator('[data-af="name"]').fill('NVR salón')
        f.locator('[data-eq="add"]').click(); pg.wait_for_timeout(2000)
        check('equipo agregado desde el asistente', '✔ Hay 2 cámara(s)' in pg.locator('#wizBody').inner_text(), pg.locator('#wizBody').inner_text()[:200])
        pg.screenshot(path=SHOTS + '/inst-02-camaras.png')
        pg.locator('#wizNext').click(); pg.wait_for_timeout(400)
        check('paso cerradura', 'Cerradura' in pg.locator('#wizBody').inner_text())
        pg.locator('#wizNext').click(); pg.wait_for_timeout(400)
        pg.locator('#wizNext').click(); pg.wait_for_timeout(600)
        summary = pg.locator('#wizBody').inner_text()
        check('resumen final', '¡Listo!' in summary and 'Cámaras' in summary)
        pg.locator('#wizNext').click(); pg.wait_for_timeout(900)
        check('asistente terminado y guardado', not pg.locator('#wizOv').is_visible() and api('/api/v1/wizard', '5150')['done'] is True)
        # Equipos y cámaras
        pg.locator('#adminNav [data-go="equipos"]').click(); pg.wait_for_timeout(1200)
        eq = pg.locator('#eqList').inner_text()
        check('lista de equipos con 2 canales', 'NVR salón' in eq and 'canal 17' in eq and 'canal 18' in eq and 'motorizada' in eq, eq[:300])
        pg.locator('#eqList [data-ch-name="18"]').fill('Depósito'); pg.locator('#eqList [data-eq="save"]').click(); pg.wait_for_timeout(1200)
        check('renombrar canal', any(c['name'] == 'Depósito' for d in api('/api/v1/devices', '5150') for c in d['channels']))
        peri = pg.locator('#eqPeri').inner_text()
        check('periféricos detectados', 'cámara(s)' in peri and 'Pantalla táctil' in peri and 'perfil tablet de pared' in peri, peri)
        pg.screenshot(path=SHOTS + '/inst-03-equipos.png', full_page=True)
        pg.locator('#adminClose').click(); pg.wait_for_timeout(500)
        # Grilla con las cámaras nuevas
        pg.locator('.tab[data-view="cctv"]').click(); pg.wait_for_timeout(1500)
        cells = pg.locator('#cctvGrid .cell[data-ch]')
        check('grilla con las 2 cámaras del NVR', cells.count() == 2, str(cells.count()))
        check('PTZ solo en la motorizada', pg.locator('#cctvGrid .cell[data-ch="17"] [data-act="ptz"]').count() == 1 and pg.locator('#cctvGrid .cell[data-ch="18"] [data-act="ptz"]').count() == 0)
        check('nombre de canal en la grilla', 'Depósito' in pg.locator('#cctvGrid').inner_text())
        pg.screenshot(path=SHOTS + '/inst-04-grilla.png')
        # El PIN de administración viejo ya no vale
        pg.locator('#btnAdmin').click(); pg.wait_for_timeout(300); keys(pg, '1234'); pg.wait_for_timeout(1000)
        check('PIN admin de fábrica ya no abre', not pg.locator('#adminOv').is_visible())
        ctx.close()
        # Otros dispositivos
        m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True); mp = m.new_page(); mp.goto(URL + "?consola=1"); mp.wait_for_timeout(1200)
        check('celular → perfil celular', mp.evaluate("document.body.classList.contains('prof-celular')"))
        check('celular sin desborde', mp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
        m.close()
        d = b.new_context(viewport={'width': 1600, 'height': 900}); dp = d.new_page(); dp.goto(URL + "?consola=1"); dp.wait_for_timeout(1200)
        check('PC con mouse → perfil PC', dp.evaluate("document.body.classList.contains('prof-pc')"))
        dp.goto(URL + '?pantalla=monitor'); dp.wait_for_timeout(1500)
        check('?pantalla=monitor → solo cámaras', dp.evaluate("document.body.classList.contains('prof-monitor')") and dp.locator('#view-cctv').is_visible() and not dp.locator('.side').is_visible())
        dp.screenshot(path=SHOTS + '/inst-05-monitor.png')
        d.close(); b.close()
finally:
    srv.terminate(); onvif.terminate()
real = [e for e in errs if 'favicon' not in e and 'net::ERR' not in e and 'Failed to load resource' not in e and 'WebSocket' not in e]
check('sin errores de JavaScript', not real, real[:5])
n = sum(1 for _, c in ok if c)
print(f'\nRESULTADO: {n}/{len(ok)} pruebas OK')
sys.exit(0 if n == len(ok) else 1)
