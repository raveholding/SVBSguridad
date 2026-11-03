"""
Frente del portero (pantalla de inicio táctil): marca del sistema, accesos (timbre, PIN, pase, NFC, voz, emergencia),
PIN con el teclado de la PC, paso a la consola de cámaras y vuelta, fuera de horario, celular y monitor.

Uso:  python3 tests/e2e_frente.py      (Node.js + Playwright; no usa go2rtc)
"""
import json, os, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
tmp = tempfile.mkdtemp(prefix='svb-e2e-frente-'); open(os.path.join(tmp, '.env'), 'w').close()
env = {**os.environ, 'PORT': str(PORT), 'HOST': '127.0.0.1', 'GO2RTC_DISABLED': '1', 'DATA_DIR': os.path.join(tmp, 'data'), 'DOORBELL': '0', 'TELEGRAM_POLL': '0', 'PUSH_ENABLED': '0', 'SVB_ENV_FILE': os.path.join(tmp, '.env')}
srv = subprocess.Popen(['node', 'server.js'], cwd=os.path.join(ROOT, 'server'), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
URL = f'http://localhost:{PORT}/'
errs, ok = [], []
def check(name, cond, extra=''):
    ok.append((name, bool(cond))); print(('✔' if cond else '✘'), name, extra if not cond else '')
def api(path, pin='1234'):
    req = urllib.request.Request(URL.rstrip('/') + path, headers={'X-Admin-Pin': pin})
    with urllib.request.urlopen(req, timeout=20) as r: return json.loads(r.read())
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = b.new_context(viewport={'width': 1580, 'height': 690}, has_touch=True, permissions=['camera', 'microphone'])
        pg = ctx.new_page()
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        pg.goto(URL); pg.wait_for_timeout(2500)
        fr = pg.locator('#front')
        check('el frente es la pantalla de inicio', fr.is_visible())
        txt = fr.inner_text()
        check('marca neutra del sistema', 'Almacén Rave' in txt and pg.evaluate("document.querySelector('#frLogo').src").endswith('assets/rave-logo.jpg'))
        for t in ['Tocar timbre', 'Llamar a oficina', 'Ingresar con PIN', 'Tengo un pase', 'Tarjeta NFC', 'Asistente de voz', 'Emergencia']:
            if t in ('Tocar timbre',): continue
            check(f'botón «{t}»', t in txt)
        check('datos del desarrollador', 'Vincular Business' in txt and 'vincularbusiness@gmail.com' in txt and '(387) 4484132' in txt)
        check('sin instrucciones internas del desarrollador', 'GitHub' not in txt and 'Settings' not in txt)
        check('botones táctiles ≥ 48 px', pg.evaluate("[...document.querySelectorAll('#front .fr-tile, #front .fr-ibtn')].every(b => b.getBoundingClientRect().height >= 48)"))
        pg.screenshot(path=SHOTS + '/frente-01-inicio.png')
        # Timbre
        pg.locator('[data-fr=bell]').click(); pg.wait_for_timeout(1500)
        ev = json.dumps(api('/api/events'))
        check('el botón de timbre dispara el aviso', 'DOORBELL' in ev)
        # PIN con la pantalla táctil
        pg.locator('[data-fr=pin]').click(); pg.wait_for_timeout(300)
        check('PIN: se abre el teclado', pg.locator('#dpOv').is_visible())
        for k in '12': pg.locator(f'#dpKeys [data-k="{k}"]').click()
        check('PIN: puntos en pantalla', pg.locator('#dpDisplay .dot.f').count() == 2)
        pg.locator('#dpClose').click(); pg.wait_for_timeout(200)
        check('PIN: cerrar limpia lo escrito', not pg.locator('#dpOv').is_visible() and pg.evaluate("pin") == '')
        # Teclado de la PC: tipear abre el PIN solo
        for k in '2580': pg.keyboard.press(k)
        check('teclado de PC: abre el PIN al tipear', pg.locator('#dpOv').is_visible() and pg.locator('#dpDisplay .dot.f').count() == 4)
        pg.keyboard.press('Backspace'); check('teclado de PC: Backspace borra', pg.locator('#dpDisplay .dot.f').count() == 0)
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        check('teclado de PC: Escape cierra', not pg.locator('#dpOv').is_visible())
        for k in '0000': pg.keyboard.press(k)
        pg.keyboard.press('Enter'); pg.wait_for_timeout(800)
        check('PIN incorrecto: acceso denegado', 'DENEGADO' in pg.locator('#flashTitle').inner_text().upper() or 'INCORRECTO' in pg.locator('#flashTitle').inner_text().upper())
        check('PIN: se cierra al enviar', not pg.locator('#dpOv').is_visible())
        pg.wait_for_timeout(2500)
        for k in '2580': pg.keyboard.press(k)
        pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
        check('PIN correcto: acceso concedido', 'CONCEDIDO' in pg.locator('#flashTitle').inner_text().upper())
        pg.wait_for_timeout(2500)
        # Pase y emergencia
        pg.locator('[data-fr=pass]').click(); pg.wait_for_timeout(600)
        check('«Tengo un pase» abre el lector', pg.locator('#scanOv').is_visible())
        pg.locator('#scanCancel').click(); pg.wait_for_timeout(300)
        pg.locator('[data-fr=sos]').click(); pg.wait_for_timeout(500)
        check('emergencia: cuenta regresiva con opción de cancelar', pg.locator('#sosOv').is_visible())
        pg.locator('#sosCancel').click(); pg.wait_for_timeout(300)
        check('emergencia: se cancela', not pg.locator('#sosOv').is_visible())
        # Consola y vuelta
        pg.locator('[data-fr=console]').click(); pg.wait_for_timeout(500)
        check('la consola con cámaras queda a un toque', not pg.locator('#front').is_visible() and pg.locator('.tab[data-view="cctv"]').is_visible())
        pg.locator('#btnHome').click(); pg.wait_for_timeout(300)
        check('botón de inicio vuelve al frente', pg.locator('#front').is_visible())
        # Datos del negocio propios
        pg.evaluate("S.biz='Ferretería El Tornillo'; S.tagline='Todo para tu obra'; S.addr='Av. Belgrano 123, Salta'; SVB.paintFront()")
        t2 = pg.locator('#front').inner_text()
        check('nombre, frase y dirección del cliente', 'Ferretería' in t2 and 'Todo para tu obra' in t2 and 'Av. Belgrano 123' in t2)
        # Fuera de horario
        pg.evaluate("ACC.mode='off'; ACC.text='Lun a Vie 9 a 18 h'; paintAccess()"); pg.wait_for_timeout(300)
        t3 = pg.locator('#front').inner_text()
        check('fuera de horario: aviso y estado', 'Fuera de horario' in t3 and pg.locator('[data-fr=bell].blocked').count() == 1)
        check('fuera de horario: la emergencia sigue disponible', pg.locator('[data-fr=sos]').is_enabled())
        pg.screenshot(path=SHOTS + '/frente-02-cerrado.png')
        # "Ver cámaras" por voz pasa a la consola
        pg.evaluate("ACC.mode='always'; paintAccess(); handleVoice('ver cámaras')"); pg.wait_for_timeout(400)
        check('voz «ver cámaras» muestra la consola', not pg.locator('#front').is_visible())
        ctx.close()
        # Celular
        m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True); mp = m.new_page(); mp.goto(URL); mp.wait_for_timeout(1500)
        check('celular: frente sin desborde horizontal', mp.evaluate("document.querySelector('#front').scrollWidth <= innerWidth + 1"))
        check('celular: se llega a la emergencia', mp.evaluate("(() => { const e = document.querySelector('[data-fr=sos]'); e.scrollIntoView(); const r = e.getBoundingClientRect(); return r.bottom <= innerHeight + 2 && r.height >= 48; })()"))
        mp.screenshot(path=SHOTS + '/frente-03-celular.png'); m.close()
        # Monitor y consola directa
        d = b.new_context(viewport={'width': 1600, 'height': 900}); dp = d.new_page(); dp.goto(URL + '?pantalla=monitor'); dp.wait_for_timeout(1500)
        check('monitor de cámaras: sin frente', not dp.locator('#front').is_visible() and dp.locator('#view-cctv').is_visible())
        dp.goto(URL + '?consola=1'); dp.wait_for_timeout(1200)
        check('?consola=1 abre la consola', not dp.locator('#front').is_visible() and dp.locator('.side').is_visible())
        d.close(); b.close()
finally:
    srv.terminate()
real = [e for e in errs if 'favicon' not in e and 'net::ERR' not in e and 'Failed to load resource' not in e and 'WebSocket' not in e]
check('sin errores de JavaScript', not real, real[:5])
n = sum(1 for _, c in ok if c)
print(f'\nRESULTADO: {n}/{len(ok)} pruebas OK')
sys.exit(0 if n == len(ok) else 1)
