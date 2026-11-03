"""
Video portero en navegador real (sin servidor, como GitHub Pages):
  - el visitante abre la página del portero en su celular (cámara simulada), toca LLAMAR;
  - el panel suena, muestra la FOTO del visitante y después su VIDEO EN VIVO (WebRTC);
  - el aviso push a los dueños lleva la cara del visitante; "Hablar y escuchar"; al cerrar se apaga la cámara del visitante;
  - teclado de PC en la ventana de PIN y en el teclado principal (incluido el numérico);
  - el almacenamiento no se mezcla con otro sistema publicado en el mismo dominio.

Uso:  python3 tests/e2e_videoportero.py      (Node.js + Playwright)
"""
import json, os, socket, subprocess, sys, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
ok = []
def check(name, cond, extra=''):
    ok.append((name, bool(cond))); print(('✔' if cond else '✘'), name, '' if cond else extra)
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
NPORT = free_port()
ntfy = subprocess.Popen(['node', os.path.join(ROOT, 'server', 'test', 'fake-ntfy.js'), str(NPORT)], stdout=subprocess.PIPE, text=True); ntfy.stdout.readline()
NTFY = f'http://127.0.0.1:{NPORT}'
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
web = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=ROOT)); threading.Thread(target=web.serve_forever, daemon=True).start()
WEB = f'http://localhost:{web.server_address[1]}'
def msgs(topic):
    with urlopen(f'{NTFY}/{topic}/json?since=all&poll=1', timeout=3) as r:
        return [m for m in (json.loads(l) for l in r.read().decode().splitlines() if l.strip()) if m.get('event') == 'message']
def wait(fn, t=10):
    end = time.time() + t
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.25)
    return fn()
NS = "'svbi:'+location.pathname.replace(/[^/]*$/,'')+':svb.settings'"
SETTINGS = {'ntfyUrl': NTFY, 'dbPage': f'{WEB}/timbre.html', 'nPush': True}
errs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 1366, 'height': 820}, permissions=['camera', 'microphone'])
        # Otro sistema del mismo dominio dejó su configuración en el almacenamiento "viejo" sin espacio propio
        ctx.add_init_script("localStorage.setItem('svb.settings', JSON.stringify({biz:'Otro Cliente SA', logo:'data:image/png;base64,iVBORw0KGgo='}))")
        ctx.add_init_script(f"if (!localStorage.getItem({NS})) localStorage.setItem({NS}, JSON.stringify({json.dumps(SETTINGS)}))")
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(WEB + '/index.html'); pg.wait_for_timeout(2500)
        check('no toma el nombre de otro sistema del mismo dominio', pg.locator('#bizName').inner_text() == 'Almacén Rave', pg.locator('#bizName').inner_text())
        check('no toma el logo de otro sistema', pg.evaluate("document.querySelector('#logo').src").endswith('assets/rave-logo.jpg'))
        # Teclado de PC: teclado principal (fila de números y numérico)
        pg.keyboard.press('2'); pg.keyboard.press('Numpad5'); pg.keyboard.press('Digit8')
        check('teclado de PC en el PIN de la puerta (incluye numérico)', pg.locator('#pinDisplay .dot.f').count() == 3, str(pg.locator('#pinDisplay .dot.f').count()))
        pg.keyboard.press('Escape')
        # Teclado de PC en la ventana de PIN de administración
        pg.evaluate('askAdmin()'); pg.wait_for_timeout(500)
        pg.keyboard.type('12'); pg.keyboard.press('Numpad3'); pg.keyboard.press('4'); pg.keyboard.press('Enter'); pg.wait_for_timeout(1200)
        check('teclado de PC en la ventana de PIN de administración', pg.locator('#adminOv').is_visible())
        pg.locator('#adminNav [data-go="portero"]').click(); pg.wait_for_timeout(1500)
        url = pg.text_content('#dbUrl'); topic = pg.evaluate('S.dbTopic'); own = pg.evaluate('S.nTopic')
        pg.locator('#adminClose').click(); pg.wait_for_timeout(500)

        # El visitante llama desde su celular con la cámara
        mctx = b.new_context(viewport={'width': 390, 'height': 820}, is_mobile=True, has_touch=True, permissions=['camera', 'microphone'])
        mob = mctx.new_page(); mob.on('pageerror', lambda e: errs.append('MOB ' + str(e)))
        mob.goto(url); mob.wait_for_timeout(800)
        check('página del visitante es un portero digital con cámara', mob.locator('h1').inner_text() == 'Almacén Rave' and mob.locator('#cam').is_visible() and 'LLAMAR' in mob.locator('#bell').inner_text())
        mob.fill('#name', 'Lucía')
        mob.locator('#bell').click()
        pg.wait_for_selector('#ringOv.show', timeout=10000)
        check('el panel suena con el nombre', 'Lucía' in pg.inner_text('#ringWho'))
        face = wait(lambda: pg.evaluate("(() => { const i = document.querySelector('#ringCam img'); const v = document.querySelector('#ringCam video.visitor'); return (i && i.src.startsWith('data:image/jpeg')) || !!v; })()"), 12)
        check('el panel muestra la cara del visitante (foto desde su celular)', face)
        live = wait(lambda: pg.evaluate("(() => { const v = document.querySelector('#ringCam video.visitor'); return !!(v && v.videoWidth > 0 && !v.paused); })()"), 20)
        check('video EN VIVO del celular del visitante (WebRTC)', live)
        check('el visitante ve que está en llamada', wait(lambda: mob.evaluate("document.querySelector('#cam').classList.contains('on')"), 10))
        pg.screenshot(path=SHOTS + '/vp-01-panel-video.png'); mob.screenshot(path=SHOTS + '/vp-02-celular-visitante.png')
        push = wait(lambda: [m for m in msgs(own) if 'Tocan el timbre' in (m.get('title') or '') or 'Tocan el timbre' in (m.get('message') or '')], 10)
        sig = [m for m in msgs(f'{topic}-v' + pg.evaluate('curRing && curRing.id'))] if pg.evaluate('!!curRing') else []
        check('foto y señalización por el tema propio del timbre', any('"photo"' in m['message'] for m in sig) and any('"offer"' in m['message'] for m in sig) and any('"answer"' in m['message'] for m in sig))
        check('aviso push a los dueños con la foto', bool(push) and wait(lambda: any(m.get('attachment') for m in msgs(own))), json.dumps(msgs(own))[:300])
        pg.locator('#ringTalk').click(); pg.wait_for_timeout(400)
        check('Hablar y escuchar: activa el micrófono del panel', pg.evaluate("VD && VD.mic && VD.mic.getAudioTracks().every((t) => t.enabled)") and pg.locator('#ringTalk').inner_text().startswith('🔇'))
        pg.locator('[data-reply="voy"]').click(); pg.wait_for_timeout(1500)
        check('el visitante recibe la respuesta', 'Ya voy' in mob.inner_text('#status'))
        check('al responder se cierra la llamada y se apaga la cámara del visitante', wait(lambda: mob.evaluate("!document.querySelector('#me').srcObject"), 10))
        # Visitante sin cámara: igual funciona como timbre
        mob.reload(); mob.wait_for_timeout(8500)  # el panel ignora timbres repetidos dentro de 8 s
        mob.locator('#camOn').click(); mob.locator('#bell').click()
        pg.wait_for_selector('#ringOv.show', timeout=10000); pg.wait_for_timeout(1500)
        check('sin cámara: suena igual y no intenta video', not pg.evaluate("!!document.querySelector('#ringCam video.visitor')"))
        pg.locator('#ringClose').click()
        b.close()
finally:
    ntfy.terminate()
check('sin errores de JavaScript', not errs, errs[:5])
n = sum(1 for _, c in ok if c)
print(f'\nRESULTADO: {n}/{len(ok)} pruebas OK')
sys.exit(0 if n == len(ok) else 1)
