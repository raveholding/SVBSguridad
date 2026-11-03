"""
Prueba en navegador de Sistemas VB Seguridad v2 (plataforma multi-sector):
marca y datos del desarrollador, escenas del hogar con PIN, aforo en vivo, alerta vecinal en pantalla,
sección Integraciones y analítica (estado, aforo, patentes, tokens, geocercas, descubrimiento),
grupos Sector e Integraciones del Centro de configuración y vista celular.

Uso:  python3 tests/e2e_plataforma.py      (solo requiere Node.js y Playwright; no usa go2rtc)
"""
import json, os, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
tmp = tempfile.mkdtemp(prefix='svb-e2e-v2-')
open(os.path.join(tmp, '.env'), 'w').write('SECTOR=residencial\nOCCUPANCY_MAX=5\n')
env = {**os.environ, 'PORT': str(PORT), 'HOST': '127.0.0.1', 'GO2RTC_DISABLED': '1', 'DATA_DIR': os.path.join(tmp, 'data'), 'DOORBELL': '0', 'TELEGRAM_POLL': '0', 'PUSH_ENABLED': '0', 'SVB_ENV_FILE': os.path.join(tmp, '.env')}
srv = subprocess.Popen(['node', 'server.js'], cwd=os.path.join(ROOT, 'server'), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
URL = f'http://localhost:{PORT}/'
import urllib.request as _u; _u.urlopen(_u.Request(URL + 'api/v1/wizard', data=b'{"done":true}', headers={'Content-Type':'application/json','X-Admin-Pin':'1234'}, method='POST'), timeout=10).read()  # asistente ya completado (prueba de la instalación de fábrica en e2e_instalacion.py)
errs, ok = [], []
def check(name, cond, extra=''):
    ok.append((name, bool(cond))); print(('✔' if cond else '✘'), name, extra if not cond else '')
def api(path, body=None, method=None, headers=None):
    h = {'Content-Type': 'application/json', 'X-Admin-Pin': '1234', **(headers or {})}
    req = urllib.request.Request(URL.rstrip('/') + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method or ('POST' if body is not None else 'GET'))
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return {'_status': e.code, **json.loads(e.read() or b'{}')}
def pin(pg, digits):
    for k in digits: pg.locator(f'#adminKeys [data-k="{k}"]').click()
    pg.locator('#adminKeys [data-k="OK"]').click()
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = b.new_context(viewport={'width': 1366, 'height': 820}, permissions=['camera', 'microphone'])
        pg = ctx.new_page()
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        pg.goto(URL + "?consola=1"); pg.wait_for_timeout(2500)
        check('título con el nombre del sistema', pg.title().startswith('Sistemas VB Seguridad'), pg.title())
        check('línea del desarrollador', 'Vincular Business · (387) 4484132' in pg.locator('.devline').inner_text())
        check('perfil por sector en el encabezado', pg.locator('#modeLabel').text_content().strip() == 'Hogar · doméstico', pg.locator('#modeLabel').text_content())
        check('escenas visibles en hogar', pg.locator('#sceneActs').is_visible())
        # Escena con PIN incorrecto y correcto
        pg.locator('#sceneActs [data-scene="noche"]').click(); pg.wait_for_timeout(300)
        pin(pg, '0000'); pg.wait_for_timeout(800)
        check('escena con PIN incorrecto no arma', api('/api/v1/status')['armed'] is False)
        pg.locator('#sceneActs [data-scene="noche"]').click(); pg.wait_for_timeout(300)
        pin(pg, '2580'); pg.wait_for_timeout(1200)
        st = api('/api/v1/status')
        check('modo noche arma y activa noche', st['armed'] and st['night'])
        check('el panel pasa a visión nocturna', pg.evaluate("document.body.classList.contains('ir')"))
        check('botón Armar del monitor se actualiza', pg.locator('#armLbl').inner_text() == 'ARMADO')
        # Aforo en vivo por la API
        for _ in range(5): api('/api/v1/occupancy', {'delta': 1})
        pg.wait_for_timeout(700)
        check('pill de aforo en vivo', pg.locator('#stOcc').is_visible() and pg.locator('#stOcc span').inner_text() == '5/5', pg.locator('#stOcc').inner_text())
        check('aforo completo marcado', 'warn' in (pg.locator('#stOcc').get_attribute('class') or ''))
        pg.screenshot(path=SHOTS + '/v2-01-hogar-noche.png')
        # Escena "llegué" por voz pide PIN
        pg.evaluate("SVB.handleVoice('llegué a casa')"); pg.wait_for_timeout(300)
        check('voz «llegué a casa» pide PIN', pg.locator('#pinOv').is_visible())
        pin(pg, '2580'); pg.wait_for_timeout(1000)
        check('llegada desarma y apaga noche', api('/api/v1/status')['armed'] is False and not pg.evaluate("document.body.classList.contains('ir')"))
        # Administración
        pg.locator('#btnAdmin').click(); pg.wait_for_timeout(300); pin(pg, '1234'); pg.wait_for_timeout(1500)
        check('19 secciones (con Equipos e Integraciones)', pg.locator('#adminNav .nb').count() == 19)
        pg.wait_for_selector('#cfgForm .cfgcard', timeout=8000)
        titles = pg.locator('#cfgForm .cfgcard h3').all_inner_texts()
        check('grupo Sector e IA', 'Sector e inteligencia artificial' in titles, titles)
        check('grupo Integraciones', any(t.startswith('Integraciones') for t in titles), titles)
        sec = pg.locator('.cfgcard[data-group="sector"]')
        sec.locator('[data-key="SECTOR"]').select_option('comercio')
        sec.locator('[data-save="sector"]').click(); pg.wait_for_timeout(1500)
        check('cambiar sector desde el panel', 'SECTOR=comercio' in open(os.path.join(tmp, '.env')).read(), open(os.path.join(tmp, '.env')).read())
        check('el encabezado toma el sector nuevo', pg.locator('#modeLabel').text_content().strip() == 'Comercio · alta seguridad', pg.locator('#modeLabel').text_content())
        check('escenas se ocultan en comercio', not pg.locator('#sceneActs').is_visible())
        pg.locator('#adminNav [data-go="integra"]').click(); pg.wait_for_timeout(1500)
        box = pg.locator('#integraBox').inner_text()
        check('estado de componentes', 'Estado del sistema' in box and 'Sistemas VB Seguridad v2.3.0' in box, box[:300])
        check('aforo en la sección', pg.locator('#igOcc').inner_text().startswith('5'))
        pg.locator('[data-ig="occ-"]').click(); pg.wait_for_timeout(600)
        check('−1 sale actualiza', pg.locator('#igOcc').inner_text().startswith('4') and pg.locator('#stOcc span').inner_text() == '4/5')
        pg.fill('#igPlate', 'ab123cd'); pg.fill('#igPlName', 'Camión reparto'); pg.locator('[data-ig="plateAdd"]').click(); pg.wait_for_timeout(900)
        check('patente agregada', 'AB123CD' in pg.locator('#integraBox').inner_text())
        pg.fill('#igTkName', 'Sistema de caja'); pg.locator('[data-scope="ingest"]').check(); pg.locator('[data-ig="tokAdd"]').click(); pg.wait_for_timeout(1200)
        tok = pg.locator('.ig-tok').inner_text().strip()
        check('token creado y mostrado una vez', tok.startswith('svb_'), tok)
        r = api('/api/v1/analytics/events', {'kind': 'plate', 'plate': 'AB123CD', 'camera': 'Portón', 'confidence': 0.95}, headers={'Authorization': 'Bearer ' + tok, 'X-Admin-Pin': ''})
        check('token del panel sirve para la API', r.get('plate', {}).get('result') == 'allow', r)
        pg.fill('#igGfName', 'Lote 7'); pg.fill('#igGfLat', '-24.80'); pg.fill('#igGfLng', '-65.40'); pg.locator('[data-ig="gfAdd"]').click(); pg.wait_for_timeout(900)
        check('geocerca creada', 'Lote 7' in pg.locator('#integraBox').inner_text())
        pg.fill('#igScan', '127.0.0.1'); pg.locator('[data-ig="disc"]').click()
        pg.wait_for_function("document.querySelector('#igDiscOut').textContent.includes('direcciones revisadas')", timeout=60000)
        check('descubrimiento multi-marca responde', 'ONVIF' in pg.locator('#igDiscOut').inner_text())
        pg.locator('#adminNav [data-go="integra"]').click(); pg.wait_for_timeout(1200)
        check('analítica reciente muestra la patente', 'PLATE_READ' in pg.locator('#integraBox').inner_text())
        pg.screenshot(path=SHOTS + '/v2-02-integraciones.png', full_page=True)
        pg.locator('#adminNav [data-go="soporte"]').click(); pg.wait_for_timeout(300)
        sup = pg.locator('[data-pane="soporte"]').inner_text()
        check('soporte con datos del desarrollador', 'vincularbusiness@gmail.com' in sup and '(387) 4484132' in sup and 'Sistemas VB Seguridad v2.2' in sup)
        check('sin instrucciones internas del desarrollador en pantalla', 'Settings → Pages' not in pg.content() and 'GitHub Pages' not in pg.locator('#adminOv').inner_text())
        # Vista celular
        m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        mp = m.new_page(); mp.goto(URL + "?consola=1"); mp.wait_for_timeout(2000)
        check('vista celular sin desborde horizontal', mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
        mp.screenshot(path=SHOTS + '/v2-03-celular.png', full_page=True)
        b.close()
finally:
    srv.terminate()
real = [e for e in errs if 'favicon' not in e and 'net::ERR' not in e and 'Failed to load resource' not in e]
check('sin errores de JavaScript', not real, real[:5])
n = sum(1 for _, c in ok if c)
print(f'\nRESULTADO: {n}/{len(ok)} pruebas OK')
sys.exit(0 if n == len(ok) else 1)
