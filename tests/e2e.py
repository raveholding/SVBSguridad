"""
Prueba de punta a punta del sistema completo SVB Seguridad.

Levanta:
  - un "grabador Dahua falso": go2rtc sirviendo 4 canales RTSP H.264 de prueba,
  - un ESP32 simulado (cerradura) y una API de Telegram simulada,
  - el servidor SVB real (que levanta su propio go2rtc y se conecta al grabador falso),
y maneja el panel con Chromium (cámara web simulada).

Uso:  python3 tests/e2e.py            (requiere server/bin/go2rtc y ffmpeg)
"""
import json, os, random, shutil, signal, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GO2RTC = os.environ.get("GO2RTC_BIN", os.path.join(ROOT, "server", "bin", "go2rtc"))
SHOTS = os.path.join(ROOT, "tests", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
calls = {"esp": [], "tg": []}
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"  {'✔' if cond else '✘'} {name}" + (f"  [{detail}]" if detail and not cond else ""))


class Esp(BaseHTTPRequestHandler):
    def do_POST(self):
        calls["esp"].append((self.path, self.headers.get("X-Token")))
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass


class Tg(BaseHTTPRequestHandler):
    def do_GET(self):
        calls["tg"].append((self.path, ""))
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(b'{"ok":true,"result":[{"message":{"chat":{"id":4242,"first_name":"Nico"}}}]}')
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n)
        calls["tg"].append((self.path, body.decode("latin1")))
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass


class Dvr(BaseHTTPRequestHandler):
    """CGI del grabador: eventos (movimiento canal 2), PTZ e info."""
    protocol_version = "HTTP/1.0"
    def do_GET(self):
        calls.setdefault("dvr", []).append(self.path)
        if "eventManager" in self.path:
            self.send_response(200); self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=myboundary"); self.end_headers()
            try:
                while True:
                    time.sleep(2)
                    e = b"Code=VideoMotion;action=Start;index=1"
                    self.wfile.write(b"--myboundary\r\nContent-Type: text/plain\r\n\r\n" + e + b"\r\n\r\n"); self.wfile.flush()
            except Exception:
                return
        body = {"getDeviceType": b"type=DH-XVR1A04\r\n", "getSoftwareVersion": b"version=4.001\r\n", "ptz.cgi": b"OK\r\n", "getSerialNo": b"sn=X\r\n"}
        out = next((v for k, v in body.items() if k in self.path), b"")
        self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass


class Cmb(BaseHTTPRequestHandler):
    """CallMeBot (WhatsApp) simulado."""
    def do_GET(self):
        calls.setdefault("wa", []).append(self.path)
        self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(b"Message queued.")
    def log_message(self, *a): pass


def serve(handler):
    s = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def wait_http(url, t=20):
    import urllib.request
    end = time.time() + t
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=1); return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    tmp = tempfile.mkdtemp(prefix="svb-e2e-")
    base_port = random.randint(20000, 40000)
    rtsp = base_port; fake_api = base_port + 1; g_api = base_port + 2; webrtc = base_port + 3; web = base_port + 4
    with open(os.path.join(tmp, "fake.yaml"), "w") as f:
        f.write(f'api:\n  listen: "127.0.0.1:{fake_api}"\nrtsp:\n  listen: "127.0.0.1:{rtsp}"\nwebrtc:\n  listen: ""\nstreams:\n')
        for c in range(1, 5):
            f.write(f'  fake{c}: ""\n')
    procs = [subprocess.Popen([GO2RTC, "-config", os.path.join(tmp, "fake.yaml")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    time.sleep(1)
    # 4 cámaras siempre transmitiendo (como un DVR real): ffmpeg publica H.264 al grabador falso
    for c in range(1, 5):
        procs.append(subprocess.Popen(["ffmpeg", "-loglevel", "error", "-re", "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=15",
            "-vf", f"drawtext=text='CANAL {c}':fontsize=48:fontcolor=white:x=20:y=20", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-g", "15", "-pix_fmt", "yuv420p", "-f", "rtsp", "-rtsp_transport", "tcp", f"rtsp://127.0.0.1:{rtsp}/fake{c}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    esp, tg, dvr, cmb = serve(Esp), serve(Tg), serve(Dvr), serve(Cmb)
    ntfy_proc = subprocess.Popen(["node", os.path.join(ROOT, "server", "test", "fake-ntfy.js")], stdout=subprocess.PIPE, text=True)
    ntfy_port = int(ntfy_proc.stdout.readline().strip())
    time.sleep(2)
    for c in range(1, 5):
        for _ in range(5):
            if subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name", "-of", "csv", f"rtsp://127.0.0.1:{rtsp}/fake{c}"], capture_output=True, timeout=20).returncode == 0:
                break
            time.sleep(1)
    env = dict(os.environ, PORT=str(web), HOST="127.0.0.1", CAM_HOST="127.0.0.1", CAM_PASS="x", CAM_CHANNELS="4", CAM_RTSP_PORT=str(rtsp),
               CAM_RTSP_TEMPLATE="rtsp://{user}:{pass}@{host}:{port}/fake{channel}", GO2RTC_BIN=GO2RTC, GO2RTC_API=f"127.0.0.1:{g_api}",
               GO2RTC_WEBRTC_PORT=str(webrtc), DATA_DIR=tmp, ESP32_URL=f"http://127.0.0.1:{esp.server_port}", ESP32_TOKEN="tok",
               TELEGRAM_BOT_TOKEN="T", TELEGRAM_CHAT_ID="1", TELEGRAM_API=f"http://127.0.0.1:{tg.server_port}",
               CAM_HTTP_PORT=str(dvr.server_port), CAM_PLAYBACK_TEMPLATE="rtsp://{host}:{port}/fake{channel}?t={start}",
               SVB_ENV_FILE=os.path.join(tmp, ".env"), DVR_ALERT_COOLDOWN="0",
               NTFY_URL=f"http://127.0.0.1:{ntfy_port}", DOORBELL_COOLDOWN="0", CALLMEBOT_API=f"http://127.0.0.1:{cmb.server_port}")
    srv_log = open(os.path.join(tmp, "server.log"), "w")
    procs.append(ntfy_proc)
    procs.append(subprocess.Popen(["node", os.path.join(ROOT, "server", "server.js")], env=env, stdout=srv_log, stderr=subprocess.STDOUT))
    url = f"http://127.0.0.1:{web}/"
    assert wait_http(url + "api/health"), "el servidor no arrancó"
    time.sleep(2)
    errors = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
            ctx = b.new_context(viewport={"width": 1366, "height": 800}, permissions=["camera", "microphone"], accept_downloads=True)
            ctx.add_init_script("localStorage.setItem('svb.settings', JSON.stringify({loiter:5}))")
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: m.type == "error" and errors.append(m.text + " @ " + str(m.location.get("url"))))
            page.on("response", lambda r: r.status >= 400 and errors.append(f"HTTP {r.status} {r.url}"))

            print("\n[1] Arranque")
            page.goto(url)
            page.wait_for_function("window.SVB && SVB.net.online", timeout=15000)
            check("Panel carga y se conecta al servidor", True)
            page.wait_for_function("document.querySelector('#stCams').classList.contains('on')", timeout=15000)
            check("Pill cámaras Dahua en verde", True)
            page.wait_for_function("document.querySelector('#localVideo').readyState >= 2", timeout=10000)
            check("Cámara de puerta local en vivo", True)
            check("Logo Rave cargado", page.evaluate("document.querySelector('#logo').naturalWidth") > 100)

            print("[2] Edge AI")
            page.wait_for_timeout(2500)
            mot = page.inner_text("#tMotion")
            check("Detección de movimiento activa", "movimiento" in mot.lower(), mot)
            page.wait_for_function("SVB.audit().some(e => e.type === 'LOITERING_ALERT')", timeout=20000)
            check("Alerta de merodeo (>5 s de presencia sin interacción)", True)
            page.screenshot(path=os.path.join(SHOTS, "01-puerta.png"))

            print("[3] Teclado y cerradura")
            def type_pin(pin):
                for d in pin:
                    page.click(f"#keypad .key[data-k='{d}']")
                page.click("#keypad .key[data-k='OK']")
            type_pin("2580")
            page.wait_for_selector("#flashOv.show", timeout=5000)
            check("PIN correcto → ACCESO CONCEDIDO", page.inner_text("#flashTitle") == "ACCESO CONCEDIDO")
            time.sleep(0.5)
            check("ESP32 recibió la orden con token", calls["esp"] and calls["esp"][-1] == ("/open?ms=3000", "tok"), str(calls["esp"][-1:]))
            page.wait_for_timeout(2400)
            type_pin("1111")
            page.wait_for_selector("#flashOv.show", timeout=5000)
            check("PIN incorrecto → ACCESO DENEGADO", page.inner_text("#flashTitle") == "ACCESO DENEGADO")
            page.wait_for_timeout(2400)

            print("[4] PIN de coacción 9999")
            n_esp = len(calls["esp"])
            type_pin("9999")
            page.wait_for_selector("#flashOv.show", timeout=5000)
            check("Coacción muestra lo mismo que una apertura normal", page.inner_text("#flashTitle") == "ACCESO CONCEDIDO")
            check("Coacción abre la puerta", len(calls["esp"]) == n_esp + 1)
            page.wait_for_function("SVB.audit().some(e => e.type === 'CRITICAL_DURESS_EVENT' && e.hidden)", timeout=5000)
            check("Evento CRITICAL_DURESS_EVENT registrado (oculto)", True)
            check("El ticker NO delata la coacción", "DURESS" not in page.inner_text("#ticker"))
            page.wait_for_function("SVB.Vault.all().then(a => a.filter(x => x.reason === 'DURESS').length >= 3)", timeout=8000)
            check("3 fotos encubiertas en la bóveda", True)
            time.sleep(1.5)
            check("Alerta silenciosa a Telegram", any("COACCI" in body for _, body in calls["tg"]))
            page.wait_for_timeout(1500)

            print("[5] SOS 911")
            page.click("#btnSos")
            check("Cuenta regresiva visible", page.is_visible("#sosOv") and page.inner_text("#sosCount") in ("3", "2"))
            page.click("#sosCancel")
            check("SOS se puede cancelar", not page.is_visible("#sosOv"))
            page.click("#btnSos")
            page.wait_for_function("SVB.audit().some(e => e.type === 'SOS_911')", timeout=8000)
            check("SOS ejecutado tras 3 s", True)
            time.sleep(1.5)
            check("Alerta SOS con foto a Telegram", any(path.endswith("sendPhoto") and "SOS" in body for path, body in calls["tg"]))

            print("[6] Monitor de cámaras (estilo DMSS)")
            page.goto(url)
            page.wait_for_function("window.SVB && SVB.net.online", timeout=15000)
            page.click(".tab[data-view='cctv']")
            check("Teclado oculto en vista cámaras (pantalla ancha)", not page.is_visible("#keypad"))
            page.wait_for_function("document.querySelectorAll('#cctvGrid .cell svb-stream').length === 4", timeout=10000)
            check("4 canales en la grilla", True)
            w = page.evaluate("document.querySelector('#cctvGrid').getBoundingClientRect().width")
            check("Grilla ocupa todo el ancho", w > 1250, str(w))
            try:
                page.wait_for_function("[...document.querySelectorAll('#cctvGrid svb-stream video')].filter(v => v.readyState >= 2 && v.videoWidth > 0).length === 4", timeout=45000)
                check("Los 4 canales reproducen video", True)
            except Exception:
                st = page.evaluate("[...document.querySelectorAll('#cctvGrid .cell')].map(c => { const v = c.querySelector('video'); return [c.querySelector('.st') && c.querySelector('.st').textContent, v && v.readyState] })")
                check("Los 4 canales reproducen video", False, json.dumps(st))
            t1 = page.evaluate("document.querySelector('#cctvGrid svb-stream video').currentTime")
            page.wait_for_timeout(1500)
            t2 = page.evaluate("document.querySelector('#cctvGrid svb-stream video').currentTime")
            check("Video en vivo avanza", t2 > t1, f"{t1}->{t2}")
            page.screenshot(path=os.path.join(SHOTS, "02-camaras.png"))

            # divisiones 9 y 16
            page.click("#splitSeg [data-split='9']")
            page.wait_for_function("document.querySelectorAll('#cctvGrid .cell').length === 9", timeout=5000)
            page.click("#splitSeg [data-split='16']")
            page.wait_for_function("document.querySelectorAll('#cctvGrid .cell').length === 16", timeout=5000)
            check("Divisiones 9 y 16 (vista previa múltiple)", True)
            page.click("#splitSeg [data-split='4']")
            page.wait_for_function("document.querySelectorAll('#cctvGrid .cell svb-stream').length === 4", timeout=5000)

            # ordenar arrastrando (canal 1 sobre canal 2)
            vis = "[...document.querySelectorAll('#cctvGrid .cell')].sort((a, b) => a.style.order - b.style.order).map(c => c.dataset.ch).join(',')"
            before = page.evaluate(vis)
            h = page.locator("#cctvGrid .cell[data-ch='1'] .drag").bounding_box()
            t = page.locator("#cctvGrid .cell[data-ch='2']").bounding_box()
            page.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2); page.mouse.down()
            page.mouse.move(t["x"] + t["width"] / 2, t["y"] + t["height"] / 2, steps=8); page.mouse.up()
            after = page.evaluate(vis)
            check("Arrastrar ordena las cámaras", before == "1,2,3,4" and after == "2,1,3,4", f"{before} -> {after}")
            check("Orden guardado", page.evaluate("JSON.parse(localStorage.getItem('svb.settings')).camOrder.join(',')") == "2,1,3,4")
            page.wait_for_timeout(1000)
            vs = page.evaluate("[...document.querySelectorAll('#cctvGrid svb-stream video')].map(v => [v.readyState, v.paused, Math.round(v.currentTime)])")
            check("Video sigue en vivo tras ordenar", all(r >= 2 and not p for r, p, _ in vs), json.dumps(vs))

            # herramientas por cámara: foto
            page.click("#cctvGrid .cell[data-ch='2']")
            with page.expect_download() as dl:
                page.locator("#cctvGrid .cell[data-ch='2'] [data-act=snap]").click()
            check("Foto de cámara descargada", dl.value.suggested_filename.endswith(".jpg"))
            # PTZ
            page.locator("#cctvGrid .cell[data-ch='2'] [data-act=ptz]").click()
            btn = page.locator("#cctvGrid .cell[data-ch='2'] [data-ptz=Left]")
            btn.dispatch_event("pointerdown"); page.wait_for_timeout(300); btn.dispatch_event("pointerup"); page.wait_for_timeout(500)
            check("PTZ envía comandos al grabador", any("ptz.cgi?action=start&channel=2&code=Left" in u for u in calls.get("dvr", [])) and any("action=stop" in u for u in calls.get("dvr", [])))
            page.locator("#cctvGrid .cell[data-ch='2'] [data-act=ptz]").click()

            # IR
            page.click("#tgIr")
            check("Modo IR / noche aplicado", page.evaluate("document.body.classList.contains('ir')"))
            page.click("#tgIr")

            # ampliar (doble clic) y volver
            page.dblclick("#cctvGrid .cell[data-ch='3']")
            page.wait_for_function("document.querySelectorAll('#cctvGrid .cell').length === 1", timeout=3000)
            page.wait_for_function("(() => { const v = document.querySelector('#cctvGrid svb-stream video'); return v && v.readyState >= 2; })()", timeout=20000)
            check("Doble clic amplía la cámara en HD", "_hd" in page.evaluate("document.querySelector('#cctvGrid svb-stream').wsURL"))
            page.dblclick("#cctvGrid .cell >> nth=0")
            page.wait_for_function("document.querySelectorAll('#cctvGrid .cell').length === 4", timeout=3000)
            check("Doble clic vuelve a la grilla", True)

            # eventos push del grabador
            page.wait_for_function("document.querySelectorAll('#evList .evi').length > 0", timeout=10000)
            check("Eventos del grabador en vivo", "Movimiento" in page.inner_text("#evList"))
            check("Contador de eventos", page.is_visible("#evBadge"))
            page.wait_for_selector("#cctvGrid .cell.motion", timeout=6000)
            check("La cámara con movimiento se resalta", page.evaluate("document.querySelector('#cctvGrid .cell.motion').dataset.ch") == "2")
            page.click("#btnEvents")
            check("Panel de eventos se abre", page.is_visible("#evDrawer"))
            page.screenshot(path=os.path.join(SHOTS, "02b-monitor-eventos.png"))
            page.click("#btnEvents")

            # armar con PIN
            page.click("#btnArm")
            for d in "2580":
                page.click(f"#adminKeys .key[data-k='{d}']")
            page.click("#adminKeys .key[data-k='OK']")
            page.wait_for_function("document.querySelector('#armLbl').textContent === 'ARMADO'", timeout=5000)
            check("Armar con PIN", True)
            n_tg = len(calls["tg"]); time.sleep(3)
            check("Armado: movimiento avisa a Telegram con foto", any("sendPhoto" in pth and "Movimiento" in body for pth, body in calls["tg"][n_tg:]))
            page.wait_for_timeout(2300)
            page.click("#btnArm")
            for d in "2580":
                page.click(f"#adminKeys .key[data-k='{d}']")
            page.click("#adminKeys .key[data-k='OK']")
            page.wait_for_function("document.querySelector('#armLbl').textContent === 'Desarmado'", timeout=5000)
            check("Desarmar con PIN", True)
            page.wait_for_timeout(2300)

            # grabaciones
            page.click("#btnPlayback")
            page.select_option("#pbCh", "3")
            page.click("#pbPlay")
            page.wait_for_function("(() => { const v = document.querySelector('#pbStage svb-stream video'); return v && v.readyState >= 2; })()", timeout=25000)
            check("Reproducción de grabaciones", True)
            page.screenshot(path=os.path.join(SHOTS, "02c-grabaciones.png"))
            page.click("#pbClose")
            check("Cerrar reproducción", not page.is_visible("#pbOv"))

            print("[7] Voz (comandos)")
            page.evaluate("SVB.handleVoice('ver puerta')")
            check("«ver puerta» cambia de vista", page.is_visible("#view-door"))
            page.evaluate("SVB.handleVoice('ver cámaras')")
            check("«ver cámaras» cambia de vista", page.is_visible("#view-cctv"))
            page.evaluate("SVB.handleVoice('abrir puerta dos cinco ocho cero')")
            page.wait_for_selector("#flashOv.show", timeout=5000)
            check("«abrir puerta dos cinco ocho cero» abre", page.inner_text("#flashTitle") == "ACCESO CONCEDIDO")
            page.wait_for_timeout(2400)

            print("[8] Administración")
            page.click("#btnAdmin")
            for d in "0000":
                page.click(f"#adminKeys .key[data-k='{d}']")
            page.click("#adminKeys .key[data-k='OK']")
            check("PIN admin incorrecto rechazado", not page.is_visible("#adminOv"))
            for d in "1234":
                page.click(f"#adminKeys .key[data-k='{d}']")
            page.click("#adminKeys .key[data-k='OK']")
            page.wait_for_selector("#adminOv.show", timeout=5000)
            check("PIN 1234 abre el panel de ingeniería", True)
            check("13 secciones de administración", page.locator("#adminNav .nb").count() == 13)
            page.click("[data-go='firmware']")
            check("Firmware ESP32 visible", "WebServer server(80)" in page.inner_text("#fwView"))
            page.click("[data-go='camaras']")
            check("Estado del grabador en admin", "4 canales" in page.inner_text("#camStatusTxt"), page.inner_text("#camStatusTxt"))
            page.click("[data-go='nfcqr']")
            page.fill("#vName", "Proveedor Coca")
            page.fill("#vHours", "2")
            page.click("#vCreate")
            page.wait_for_selector("#vOut", state="visible")
            code = page.inner_text("#vCode")
            check("Pase temporal de 6 dígitos creado", len(code) == 6 and code.isdigit(), code)
            page.locator("#vQr").screenshot(path=os.path.join(SHOTS, "qr-pase.png"))
            page.screenshot(path=os.path.join(SHOTS, "03-admin-qr.png"))
            page.click("[data-go='auditoria']")
            page.wait_for_function("document.querySelectorAll('#logBody tr').length > 5", timeout=5000)
            check("Log de auditoría muestra eventos del servidor", "servidor" in page.inner_text("#logBody"))
            check("Log incluye CRITICAL_DURESS_EVENT", "CRITICAL_DURESS_EVENT" in page.inner_text("#logBody"))
            with page.expect_download() as dl:
                page.click("#logExport")
            data = json.load(open(dl.value.path()))
            check("Exportación JSON del log", len(data["eventos"]) > 5)
            page.click("[data-go='rele']")
            page.click("#sRelayTest")
            page.wait_for_timeout(800)
            check("Prueba de relé desde admin", len(calls["esp"]) >= 4)
            page.screenshot(path=os.path.join(SHOTS, "04-admin-auditoria.png"))
            # Centro de configuración: todo desde el panel (escribe .env en el servidor)
            page.click("[data-go='setup']")
            page.wait_for_selector("#cfgForm .cfgcard", timeout=8000)
            check("Centro de configuración con 6 grupos", page.locator("#cfgForm .cfgcard").count() == 6)
            check("Aviso de PINs de fábrica", "PINs de fábrica" in page.inner_text("#setupWarn"))
            page.fill("#suTgToken", "123456:ABCdefGHIjklMNOpqrSTUvwxYZ12345")
            page.click("#suTgDetect")
            try:
                page.wait_for_function("document.querySelector('#suTgOut') && document.querySelector('#suTgOut').textContent.includes('Conectado')", timeout=10000)
            except Exception:
                print("DEBUG suTgOut:", page.evaluate("document.querySelector('#suTgOut') && document.querySelector('#suTgOut').textContent"))
            check("Telegram se conecta solo con el token", "Nico" in page.inner_text("#suTgOut") and "TELEGRAM_CHAT_ID=4242" in open(env["SVB_ENV_FILE"]).read())
            page.fill("[data-key='DOOR_PIN']", "4455"); page.fill("[data-key='DURESS_PIN']", "4455")
            page.click("[data-save='seguridad']")
            page.wait_for_function("document.querySelector('[data-out=seguridad]').textContent.length > 3", timeout=5000)
            check("Valida PIN de puerta ≠ coacción", "distintos" in page.inner_text("[data-out='seguridad']"))
            page.fill("[data-key='DURESS_PIN']", "7788")
            page.click("[data-save='seguridad']")
            page.wait_for_function("document.querySelector('[data-out=seguridad]').textContent.includes('Guardado')", timeout=5000)
            page.fill("[data-key='CAM_NAMES'] input[data-i='0']", "Entrada")
            page.click("[data-save='grabador']")
            page.wait_for_function("document.querySelector('[data-out=grabador]').textContent.includes('Guardado')", timeout=8000)
            # WhatsApp de los dueños
            page.click("[data-wa-add]")
            page.fill(".waRow [data-wa-phone]", "+54 9 387 123-4567"); page.fill(".waRow [data-wa-key]", "123456")
            page.click("[data-save='alertas']")
            page.wait_for_function("document.querySelector('[data-out=alertas]').textContent.includes('Guardado')", timeout=8000)
            check("WhatsApp de dueño guardado", "WHATSAPP_TO=+5493871234567:123456" in open(env["SVB_ENV_FILE"]).read())
            check("QR para suscribir la notificación push", page.is_visible("#pushQr") and "rave-own-" in page.inner_text("[data-group='alertas']"))
            page.click("[data-act-cfg='testNotify']")
            page.wait_for_function("document.querySelector('#cfgNotifyOut').textContent.includes('push')", timeout=15000)
            out = page.inner_text("#cfgNotifyOut")
            check("Aviso de prueba por WhatsApp, push y Telegram", "WhatsApp" in out and out.count("✔") >= 3 and any("phone=%2B5493871234567" in u and "apikey=123456" in u for u in calls.get("wa", [])), out)
            envtxt = open(env["SVB_ENV_FILE"]).read()
            check("PINs, nombres y Telegram guardados en .env", "DOOR_PIN=4455" in envtxt and "DURESS_PIN=7788" in envtxt and "TELEGRAM_CHAT_ID=4242" in envtxt and "CAM_NAMES=Entrada," in envtxt)
            page.locator("[data-group='alertas']").screenshot(path=os.path.join(SHOTS, "04d-avisos-whatsapp-push.png"))
            # Ajustes compartidos: cambiar un contacto aquí → aparece en otro equipo
            page.click("[data-go='contactos']")
            page.fill("#sFamilyPhone", "+5493879999999")
            page.wait_for_timeout(1800)
            otro = b.new_context(viewport={"width": 1280, "height": 760}); op2 = otro.new_page()
            op2.goto(url); op2.wait_for_function("window.SVB && SVB.net.online", timeout=10000)
            op2.wait_for_function("SVB.S.familyPhone === '+5493879999999'", timeout=8000)
            check("Ajustes compartidos llegan a otro equipo", True)
            check("Los PINs de respaldo NO se comparten", op2.evaluate("SVB.S.doorPin") == "2580")
            otro.close()
            page.click("[data-go='setup']")
            page.wait_for_selector("#cfgForm .cfgcard", timeout=8000)
            page.screenshot(path=os.path.join(SHOTS, "04b-config.png"), full_page=True)
            page.click("[data-go='camaras']")
            page.wait_for_function("document.querySelector('#devInfo').textContent.includes('XVR1A04')", timeout=6000)
            check("Info del grabador (modelo/firmware)", True)

            # Portero QR / NFC
            page.click("[data-go='portero']")
            page.wait_for_function("document.querySelector('#dbUrl').textContent.includes('timbre.html?t=rave-')", timeout=8000)
            check("Portero activo y con enlace secreto", "activo" in page.inner_text("#dbState"))
            db_url = page.inner_text("#dbUrl")
            page.locator("#dbQr").screenshot(path=os.path.join(SHOTS, "qr-portero.png"))
            with page.expect_popup() as pop:
                page.click("#dbPrint")
            poster = pop.value; poster.wait_for_load_state()
            check("Cartel imprimible para la puerta", "TOCÁ EL TIMBRE" in poster.content())
            poster.screenshot(path=os.path.join(SHOTS, "06-cartel-portero.png")); poster.close()
            page.screenshot(path=os.path.join(SHOTS, "04c-portero-admin.png"))
            page.click("#adminClose")
            page.click(".tab[data-view='door']")
            type_pin("4455")
            page.wait_for_selector("#flashOv.show", timeout=5000)
            check("PIN nuevo funciona al instante", page.inner_text("#flashTitle") == "ACCESO CONCEDIDO")
            page.wait_for_timeout(2400)

            print("[8b] Portero: el cliente toca el timbre desde SU celular")
            from urllib.parse import urlparse, parse_qs
            topic = parse_qs(urlparse(db_url).query)["t"][0]
            cel = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            cp = cel.new_page(); cp.on("pageerror", lambda e: errors.append("timbre: " + str(e)))
            cp.goto(f"{url}timbre.html?t={topic}&n=Almac%C3%A9n%20Rave&h=http://127.0.0.1:{ntfy_port}")
            check("Página del portero muestra el negocio", cp.inner_text("#biz") == "Almacén Rave")
            cp.click(".chip[data-m='Delivery / pedido']"); cp.fill("#name", "Juan")
            n_tg = len(calls["tg"])
            cp.click("#bell")
            cp.wait_for_function("document.querySelector('#status b').textContent.includes('enviado')", timeout=8000)
            page.wait_for_selector("#ringOv.show", timeout=8000)
            check("El panel suena y muestra quién toca", "Juan" in page.inner_text("#ringWho") and "Delivery" in page.inner_text("#ringWho"))
            time.sleep(1.5)
            check("Aviso a Telegram con botones de respuesta", any("Tocan el timbre" in body and "callback_data" in body for _, body in calls["tg"][n_tg:]))
            cp.screenshot(path=os.path.join(SHOTS, "07-timbre-celular-esperando.png"))
            page.screenshot(path=os.path.join(SHOTS, "08-panel-timbre.png"))
            page.click("#ringOv [data-reply='voy']")
            cp.wait_for_function("document.querySelector('#status').classList.contains('reply')", timeout=8000)
            check("El cliente ve la respuesta en su celular", "Ya voy" in cp.inner_text("#status"))
            check("Se cierra el aviso en el panel", not page.is_visible("#ringOv"))
            cp.screenshot(path=os.path.join(SHOTS, "07b-timbre-celular-respuesta.png"))
            # segundo timbre → abrir la puerta con PIN
            cp.evaluate("document.querySelector('#bell').disabled = false")
            n_esp = len(calls["esp"])
            cp.click("#bell")
            page.wait_for_selector("#ringOv.show", timeout=8000)
            page.click("#ringOv [data-reply='pase']")
            for d in "4455":
                page.click(f"#adminKeys .key[data-k='{d}']")
            page.click("#adminKeys .key[data-k='OK']")
            cp.wait_for_function("document.querySelector('#status').textContent.includes('Puerta abierta')", timeout=8000)
            check("Abrir puerta desde el timbre (con PIN)", len(calls["esp"]) > n_esp)
            cel.close()
            page.wait_for_timeout(2400)

            print("[9] Pase de visita en la puerta")
            type_pin(code)
            page.wait_for_selector("#flashOv.show", timeout=5000)
            check("Código de visita abre y saluda", "Proveedor Coca" in page.inner_text("#flashSub"), page.inner_text("#flashSub"))
            page.wait_for_timeout(2400)

            print("[10] Sabotaje de lente")
            page.evaluate("""() => { const c = document.createElement('canvas'); c.width = 320; c.height = 240;
                const x = c.getContext('2d'); setInterval(() => { x.fillStyle = '#050505'; x.fillRect(0, 0, 320, 240); }, 100);
                document.querySelector('#localVideo').srcObject = c.captureStream(10); }""")
            page.wait_for_function("SVB.audit().some(e => e.type === 'TAMPER_ALERT')", timeout=10000)
            check("Alerta por cámara tapada", "BLOQUEADO" in page.inner_text("#tTamper"))

            print("[11] Seguridad")
            for path in [".env", "server/server.js", "data/events.jsonl", "go2rtc/api/config", "go2rtc/api/streams"]:
                r = page.request.get(url + path)
                check(f"/{path} bloqueado", r.status in (403, 404), str(r.status))
            st = page.request.get(url + "api/status").json()
            check("API no expone contraseñas", "x@" not in json.dumps(st))

            print("[12] Celular (vertical)")
            m = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, permissions=["camera"])
            mp = m.new_page(); mp.goto(url); mp.wait_for_timeout(2500)
            mp.screenshot(path=os.path.join(SHOTS, "05-celular.png"), full_page=True)
            check("Vista celular renderiza", mp.is_visible("#keypad"))
            m.close()

            print("[13] Modo autónomo (sin servidor, file://)")
            o = b.new_context(viewport={"width": 1280, "height": 760}, permissions=["camera"])
            op = o.new_page(); op.on("pageerror", lambda e: errors.append("offline: " + str(e)))
            op.goto("file://" + os.path.join(ROOT, "index.html"))
            op.wait_for_function("window.SVB", timeout=5000)
            check("Abre sin servidor", not op.evaluate("SVB.net.online"))
            for d in "2580":
                op.click(f"#keypad .key[data-k='{d}']")
            op.click("#keypad .key[data-k='OK']")
            op.wait_for_selector("#flashOv.show", timeout=5000)
            check("PIN local funciona sin servidor", op.inner_text("#flashTitle") == "ACCESO CONCEDIDO")
            op.click(".tab[data-view='cctv']")
            check("Grilla avisa que falta el servidor", "Instale el servidor" in op.inner_text("#cctvGrid"))
            o.close()

            b.close()
    finally:
        for pr in procs:
            pr.send_signal(signal.SIGTERM)
        time.sleep(0.5)
        for pr in procs:
            pr.kill()
        srv_log.close()
        print("\n--- log servidor (últimas líneas) ---")
        print("".join(open(os.path.join(tmp, "server.log")).readlines()[-8:]))
        shutil.rmtree(tmp, ignore_errors=True)

    # 403 esperados: las pruebas de PIN incorrecto y de archivos bloqueados.
    # "[VideoRTC] Video error": fallo transitorio del decodificador por software de Chromium headless;
    # el vigilante del panel reconecta el canal (cubierto por las pruebas de video).
    real_errors = [e for e in errors if "favicon" not in e and "403" not in e and not ("400" in e and "/api/setup" in e) and "[VideoRTC] Video error" not in e]
    check("Sin errores de JavaScript en consola", not real_errors, " | ".join(real_errors[:5]))
    ok = sum(1 for _, r in results if r)
    print(f"\nRESULTADO: {ok}/{len(results)} pruebas OK")
    sys.exit(0 if ok == len(results) else 1)


if __name__ == "__main__":
    main()
