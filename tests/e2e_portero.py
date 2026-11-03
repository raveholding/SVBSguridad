"""
Portero QR/NFC y avisos al celular SIN servidor SVB (el equipo de la puerta lo hace todo):
  - relevo ntfy simulado, CallMeBot simulado y el panel servido como página estática (como GitHub Pages);
  - el cliente abre timbre.html en "su celular", toca el timbre y ve la respuesta;
  - a los dueños les llega la notificación push con foto y botones, y el WhatsApp;
  - respuesta desde el panel y desde el botón de la notificación; fuera de horario; SOS; prueba de avisos.

Uso:  python3 tests/e2e_portero.py      (requiere Node.js y Playwright)
"""
import json, os, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
ok = []
def check(name, cond, extra=''):
    ok.append((name, bool(cond))); print(('  ✔' if cond else '  ✘'), name, '' if cond else extra)
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

# Relevo ntfy simulado (el mismo de las pruebas del servidor)
NPORT = free_port()
ntfy = subprocess.Popen(['node', os.path.join(ROOT, 'server', 'test', 'fake-ntfy.js'), str(NPORT)], stdout=subprocess.PIPE, text=True)
ntfy.stdout.readline()
NTFY = f'http://127.0.0.1:{NPORT}'

# CallMeBot simulado
wa_calls = []
class Cmb(BaseHTTPRequestHandler):
    def do_GET(self):
        wa_calls.append(parse_qs(urlparse(self.path).query)); self.send_response(200); self.end_headers(); self.wfile.write(b'Message queued')
    def log_message(self, *a): pass
cmb = ThreadingHTTPServer(('127.0.0.1', 0), Cmb); threading.Thread(target=cmb.serve_forever, daemon=True).start()
CMB = f'http://127.0.0.1:{cmb.server_address[1]}'

# Panel como página estática (sin servidor SVB, como GitHub Pages)
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
web = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=ROOT)); threading.Thread(target=web.serve_forever, daemon=True).start()
WEB = f'http://localhost:{web.server_address[1]}'

def ntfy_msgs(topic):
    with urlopen(f'{NTFY}/{topic}/json?since=all&poll=1', timeout=3) as r:
        out = []
        for line in r.read().decode().splitlines():
            try:
                m = json.loads(line)
                if m.get('event') == 'message': out.append(m)
            except Exception: pass
        return out
def wait(fn, t=8):
    end = time.time() + t
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.2)
    return fn()

SETTINGS = {'ntfyUrl': NTFY, 'cmbUrl': CMB, 'dbPage': f'{WEB}/timbre.html', 'nPush': True, 'nWa': True,
            'nRecips': [{'id': 'r1', 'name': 'Nico', 'phone': '+5493874000000', 'key': '123456'}]}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = b.new_context(viewport={'width': 1366, 'height': 820}, permissions=['camera', 'microphone'])
        ctx.add_init_script(f"if (!localStorage.getItem('svbi:'+location.pathname.replace(/[^/]*$/,'')+':svb.settings')) localStorage.setItem('svbi:'+location.pathname.replace(/[^/]*$/,'')+':svb.settings', JSON.stringify({json.dumps(SETTINGS)}))")
        errs = []
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(WEB + '/index.html?consola=1'); pg.wait_for_timeout(2500)
        pg.evaluate("askAdmin()"); pg.wait_for_timeout(200)
        for k in '1234': pg.locator(f'#adminKeys [data-k="{k}"]').click()
        pg.locator('#adminKeys [data-k="OK"]').click(); pg.wait_for_timeout(800)
        pg.locator('#adminNav [data-go="portero"]').click(); pg.wait_for_timeout(1500)
        st = pg.inner_text('#dbState')
        check('Sección Portero funciona sin servidor', 'Portero activo en este equipo' in st, st)
        url = pg.text_content("#dbUrl")
        check('QR del portero con enlace del cliente', url.startswith(WEB + '/timbre.html?t=svb-'), url)
        topic = pg.evaluate('S.dbTopic'); own = pg.evaluate('S.nTopic')
        check('Configuración de avisos visible', pg.locator('#nQr').is_visible() and pg.locator('#nWaList .waRow').count() == 1)
        pg.screenshot(path=os.path.join(SHOTS, 'p1-portero-sin-servidor.png'), full_page=True)

        # Aviso de prueba a todos
        pg.locator('[data-dc="test"]').click()
        out = pg.wait_for_function("document.querySelector('#nOut').textContent.includes('Notificación push')", timeout=8000) and pg.inner_text('#nOut')
        check('Prueba: push enviada', 'enviada' in out, out)
        check('Prueba: WhatsApp a CallMeBot con número y clave', wait(lambda: any(c.get('apikey') == ['123456'] and c.get('phone') == ['+5493874000000'] for c in wa_calls)), wa_calls)
        check('Prueba: la notificación llegó al tema de los dueños', wait(lambda: any('Prueba de avisos' in (m.get('title') or '') for m in ntfy_msgs(own))))
        pg.locator('#adminClose').click(); pg.wait_for_timeout(500)

        # El cliente escanea el QR con su celular y toca el timbre
        mob = b.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True).new_page()
        mob.goto(url); mob.wait_for_timeout(800)
        check('Página del cliente con el nombre del local', 'Almacén Rave' in mob.inner_text('#biz'))
        mob.fill('#name', 'Pedro'); mob.locator('.chip[data-m="Delivery / pedido"]').click()
        n_wa = len(wa_calls)
        mob.locator('#bell').click()
        pg.wait_for_selector('#ringOv.show', timeout=8000)
        check('Suena en el panel con nombre y motivo', 'Pedro' in pg.inner_text('#ringWho') and 'Delivery' in pg.inner_text('#ringWho'), pg.inner_text('#ringWho'))
        pg.screenshot(path=os.path.join(SHOTS, 'p2-timbre-en-panel.png'))
        ring = wait(lambda: [m for m in ntfy_msgs(own) if 'Tocan el timbre' in (m.get('title') or '')])
        check('Push del timbre con botones Ya voy / Un momento / Dejar', ring and len(ring[-1].get('actions') or []) == 3, ring)
        check('Push del timbre con foto de la cámara', wait(lambda: any(m.get('attachment') for m in ntfy_msgs(own))))
        check('WhatsApp del timbre a los dueños', wait(lambda: any('Tocan el timbre' in (c.get('text') or [''])[0] for c in wa_calls[n_wa:])))
        pg.locator('#ringOv [data-reply="voy"]').click()
        mob.wait_for_function("document.querySelector('#status').textContent.includes('Ya voy')", timeout=8000)
        check('El cliente ve la respuesta del panel', 'Ya voy' in mob.inner_text('#status'))
        mob.screenshot(path=os.path.join(SHOTS, 'p3-cliente-respuesta.png'))

        # Responder con el botón de la notificación del celular del dueño
        mob.wait_for_timeout(9000)
        mob.reload(); mob.wait_for_timeout(600); mob.locator('#bell').click()
        pg.wait_for_selector('#ringOv.show', timeout=8000)
        act = wait(lambda: [m for m in ntfy_msgs(own) if m.get('actions')][1:])[-1]['actions'][1]
        urlopen(Request(act['url'], data=act['body'].encode(), method='POST'), timeout=3)
        mob.wait_for_function("document.querySelector('#status').textContent.includes('Estamos atendiendo')", timeout=8000)
        check('Botón «Un momento» de la notificación responde al cliente', True)
        pg.wait_for_function("!document.querySelector('#ringOv').classList.contains('show')", timeout=5000)
        check('El panel cierra el aviso al responder desde el celular', True)

        # Fuera de horario: el cliente ve el horario y no suena
        pg.evaluate("setAccess({ mode: 'off', text: 'Lun a Sáb · 09:00 a 21:00 h' })")
        mob.wait_for_timeout(9000)
        mob.reload(); mob.wait_for_timeout(600); mob.locator('#bell').click()
        mob.wait_for_function("document.querySelector('#status').textContent.includes('Estamos cerrados')", timeout=8000)
        check('Fuera de horario el cliente ve el horario', 'Lun a Sáb' in mob.inner_text('#status'))
        check('Fuera de horario no suena el panel', not pg.locator('#ringOv').is_visible())
        pg.evaluate("setAccess({ mode: 'always', text: 'Las 24 horas' })")

        # SOS sin servidor → push urgente y WhatsApp
        n_wa = len(wa_calls)
        pg.locator('#btnSos').click(); pg.wait_for_timeout(500); pg.locator('#sosCancel').click()
        check('SOS cancelado no avisa', not wait(lambda: any('SOS' in (m.get('title') or '') for m in ntfy_msgs(own)), 2))
        pg.evaluate("fireSos = (orig => async () => { await captureEvidence('SOS',1); notifyDirect('sos', '🚨 SOS · ' + S.biz, 'BOTÓN SOS PRESIONADO. Se llamó al 911.'); })(fireSos); fireSos()")
        sos = wait(lambda: [m for m in ntfy_msgs(own) if 'SOS' in (m.get('title') or '')])
        check('SOS: push con prioridad máxima', sos and sos[-1].get('priority') == 5, sos)
        check('SOS: WhatsApp', wait(lambda: any('SOS' in (c.get('text') or [''])[0] for c in wa_calls[n_wa:])))

        # Probar timbre desde administración (de punta a punta por el relevo)
        pg.evaluate("lastDirectRing = 0; askAdmin()"); pg.wait_for_timeout(200)
        for k in '1234': pg.locator(f'#adminKeys [data-k="{k}"]').click()
        pg.locator('#adminKeys [data-k="OK"]').click(); pg.wait_for_timeout(800)
        pg.locator('#adminNav [data-go="portero"]').click(); pg.wait_for_timeout(600)
        pg.locator('#dbTest').click()
        pg.wait_for_selector('#ringOv.show', timeout=8000)
        check('Probar timbre suena en el panel', 'Prueba' in pg.inner_text('#ringWho'))
        pg.locator('#ringClose').click()
        check('Sin errores de JavaScript', not errs, errs)
        b.close()
finally:
    ntfy.terminate(); cmb.shutdown(); web.shutdown()
print(f'RESULTADO {sum(1 for _, c in ok if c)} / {len(ok)}')
sys.exit(0 if all(c for _, c in ok) else 1)
