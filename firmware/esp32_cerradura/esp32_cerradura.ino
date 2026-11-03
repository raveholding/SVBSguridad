/*
 * Sistemas VB Seguridad — Controlador de cerradura para ESP32 (Almacén Rave)
 * ------------------------------------------------------------------
 * NO hace falta editar este código: se configura desde el celular.
 *
 *  1) Grabar este sketch tal cual (Arduino IDE 2 + "esp32 by Espressif", placa "ESP32 Dev Module").
 *  2) Al encenderlo por primera vez crea la red WiFi  "SVB-Puerta-XXXX"  (clave: svbpuerta).
 *     Conectate desde el celular: se abre la página de configuración (o entrá a http://192.168.4.1).
 *     Elegí el WiFi del local y su clave → Guardar. El ESP32 se reinicia y se conecta.
 *  3) En el panel Sistemas VB: ⚙ → Configuración → Cerradura → "Buscar y vincular cerradura".
 *     El panel la encuentra en la red y la vincula con una clave segura automáticamente.
 *
 *  Volver a configurar: mantener apretado el botón BOOT 5 segundos (borra WiFi y vínculo).
 *
 * Hardware:
 *   - Módulo relé 1 canal 5V → GPIO 26
 *   - Cerradura eléctrica 12V con fuente propia (diodo 1N4007 en paralelo con la bobina)
 *       · Cerradura de pestillo (tipo Kallay)  → contacto NA (NO) del relé
 *       · Electroimán (traba con energía)       → contacto NC
 *   - Sensor magnético de puerta (reed) → GPIO 27 a GND (opcional)
 *   - Pulsador de salida interior        → GPIO 25 a GND (opcional)
 *
 * API (la usa el servidor Sistemas VB):
 *   GET  /status                       estado (puerta, vínculo, IP)
 *   POST /open?ms=3000   X-Token: …    abrir
 *   POST /pair  (body = clave)         vincular (solo sin vincular y dentro de 10 min de encendido)
 *   Serie 115200: "OPEN 3000" | "STATUS"  (app de escritorio por USB)
 */
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>

const int  PIN_RELAY    = 26;
const int  PIN_DOOR     = 27;
const int  PIN_EXIT_BTN = 25;
const int  PIN_BOOT     = 0;
const bool RELAY_ACTIVE_LOW = true;   // la mayoría de los módulos relé se activan con LOW
const uint32_t MIN_MS = 100, MAX_MS = 10000, DEFAULT_MS = 3000;
const uint32_t PAIR_WINDOW_MS = 10UL * 60UL * 1000UL;
const char* AP_PASS  = "svbpuerta";
const char* HOSTNAME = "svb-puerta";

WebServer server(80);
DNSServer dns;
Preferences prefs;
String wifiSsid, wifiPass, token;
bool apMode = false;
uint32_t relayUntil = 0, opens = 0;

void relayWrite(bool on) { digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }
bool doorClosed() { return digitalRead(PIN_DOOR) == LOW; }

void openDoor(uint32_t ms) {
  ms = constrain(ms, MIN_MS, MAX_MS);
  relayWrite(true);
  relayUntil = millis() + ms;
  if (relayUntil == 0) relayUntil = 1;
  opens++;
  Serial.printf("OPENED %lu\n", (unsigned long)ms);
}

String chipId() { uint64_t m = ESP.getEfuseMac(); char b[7]; snprintf(b, sizeof(b), "%04X", (uint16_t)(m >> 32)); return String(b); }

String jsonEscape(const String& s) { String o; for (char c : s) { if (c == '"' || c == '\\') o += '\\'; if ((uint8_t)c >= 32) o += c; } return o; }

String statusJson() {
  return String("{\"ok\":true,\"device\":\"svb-puerta\",\"id\":\"") + chipId() + "\",\"paired\":" + (token.length() ? "true" : "false") +
         ",\"relay\":" + (relayUntil ? "true" : "false") + ",\"door\":\"" + (doorClosed() ? "cerrada" : "abierta") + "\"" +
         ",\"opens\":" + opens + ",\"rssi\":" + WiFi.RSSI() + ",\"ip\":\"" + WiFi.localIP().toString() + "\",\"wifi\":\"" + jsonEscape(wifiSsid) + "\"}";
}

void sendCors(int code, const String& type, const String& body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "X-Token, Content-Type");
  server.send(code, type, body);
}

// ───────── Página de configuración (modo punto de acceso) ─────────
const char PAGE_HEAD[] PROGMEM = R"HTML(<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVB Puerta</title><style>body{margin:0;background:#000;color:#e0e0e0;font-family:system-ui,Arial;padding:24px}h1{color:#fff;font-weight:500;font-size:22px}
label{display:block;margin:16px 0 6px;font-size:13px;color:#8a8a8a;letter-spacing:1px;text-transform:uppercase}input,select{width:100%;box-sizing:border-box;min-height:52px;
border-radius:12px;border:1px solid #333;background:#0a0a0a;color:#fff;font-size:17px;padding:0 14px}button{margin-top:22px;width:100%;min-height:56px;border:0;border-radius:14px;
background:#fff;color:#000;font-size:17px;font-weight:700}p{color:#8a8a8a;line-height:1.5}</style></head><body>)HTML";

void handleRoot() {
  String h = FPSTR(PAGE_HEAD);
  h += "<h1>Cerradura Sistemas VB · configuración</h1><p>Elegí el WiFi del local. Después, en el panel Sistemas VB tocá <b>Buscar y vincular cerradura</b>.</p><form method='POST' action='/save'><label>Red WiFi</label><select name='s'>";
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) { String s = WiFi.SSID(i); s.replace("<", ""); s.replace(">", ""); h += "<option" + String(s == wifiSsid ? " selected" : "") + ">" + s + "</option>"; }
  h += "</select><label>…o escribí el nombre</label><input name='s2' placeholder='(opcional)'><label>Clave del WiFi</label><input name='p' type='password'><button>Guardar y conectar</button></form>";
  h += "<p>Equipo " + chipId() + "</p></body></html>";
  server.send(200, "text/html; charset=utf-8", h);
}

void handleSave() {
  String s = server.arg("s2").length() ? server.arg("s2") : server.arg("s");
  if (!s.length()) { server.send(400, "text/plain", "Falta la red WiFi"); return; }
  prefs.putString("ssid", s);
  prefs.putString("pass", server.arg("p"));
  String h = FPSTR(PAGE_HEAD);
  h += "<h1>Guardado ✔</h1><p>La cerradura se reinicia y se conecta a <b>" + s + "</b>.<br>Volvé al WiFi del local y en el panel Sistemas VB tocá <b>Buscar y vincular cerradura</b>.</p></body></html>";
  server.send(200, "text/html; charset=utf-8", h);
  delay(1500);
  ESP.restart();
}

// ───────── API ─────────
void handleOpen() {
  if (server.method() == HTTP_OPTIONS) { sendCors(204, "text/plain", ""); return; }
  if (!token.length() || server.header("X-Token") != token) { sendCors(401, "application/json", "{\"ok\":false,\"error\":\"token\"}"); return; }
  openDoor(server.hasArg("ms") ? server.arg("ms").toInt() : DEFAULT_MS);
  sendCors(200, "application/json", statusJson());
}

void handlePair() {
  if (token.length()) { sendCors(409, "application/json", "{\"ok\":false,\"error\":\"ya vinculada: mantener BOOT 5 s para reiniciar\"}"); return; }
  if (millis() > PAIR_WINDOW_MS) { sendCors(403, "application/json", "{\"ok\":false,\"error\":\"tiempo de vinculación vencido: reiniciar la cerradura\"}"); return; }
  String t = server.arg("plain"); t.trim();
  if (t.length() < 16 || t.length() > 64) { sendCors(400, "application/json", "{\"ok\":false,\"error\":\"clave invalida\"}"); return; }
  token = t; prefs.putString("token", token);
  sendCors(200, "application/json", statusJson());
}

void startAP() {
  apMode = true;
  String ssid = "SVB-Puerta-" + chipId();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(ssid.c_str(), AP_PASS);
  dns.start(53, "*", WiFi.softAPIP());   // portal cautivo: cualquier dirección abre la configuración
  Serial.println("Modo configuracion: red " + ssid + " clave " + AP_PASS);
}

bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  Serial.print("Conectando a " + wifiSsid);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  bool ok = WiFi.status() == WL_CONNECTED;
  Serial.println(ok ? "\nWiFi OK: " + WiFi.localIP().toString() : "\nNo se pudo conectar");
  return ok;
}

void factoryResetIfHeld() {
  uint32_t t0 = millis();
  while (digitalRead(PIN_BOOT) == LOW) {
    if (millis() - t0 > 5000) {
      prefs.clear(); Serial.println("Configuracion borrada"); delay(300); ESP.restart();
    }
    delay(20);
  }
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false);                       // arranca trabada
  pinMode(PIN_DOOR, INPUT_PULLUP);
  pinMode(PIN_EXIT_BTN, INPUT_PULLUP);
  pinMode(PIN_BOOT, INPUT_PULLUP);
  Serial.begin(115200);
  prefs.begin("svb", false);
  factoryResetIfHeld();
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  token    = prefs.getString("token", "");

  if (!wifiSsid.length() || !connectWifi()) startAP();
  if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);

  const char* hdrs[] = {"X-Token"};
  server.collectHeaders(hdrs, 1);
  server.on("/", HTTP_GET, []() { if (apMode) handleRoot(); else sendCors(200, "application/json", statusJson()); });
  server.on("/save", HTTP_POST, handleSave);
  server.on("/status", HTTP_GET, []() { sendCors(200, "application/json", statusJson()); });
  server.on("/open", handleOpen);
  server.on("/pair", HTTP_POST, handlePair);
  server.onNotFound([]() {
    if (apMode) { server.sendHeader("Location", "http://192.168.4.1/"); server.send(302, "text/plain", ""); }
    else sendCors(404, "application/json", "{\"ok\":false}");
  });
  server.begin();
}

String serialBuf;
void loop() {
  if (apMode) dns.processNextRequest();
  server.handleClient();

  if (relayUntil && (int32_t)(millis() - relayUntil) >= 0) { relayWrite(false); relayUntil = 0; Serial.println("LOCKED"); }

  static uint32_t lastBtn = 0;
  if (digitalRead(PIN_EXIT_BTN) == LOW && millis() - lastBtn > 1500) { lastBtn = millis(); openDoor(DEFAULT_MS); }

  static uint32_t bootDown = 0;
  if (digitalRead(PIN_BOOT) == LOW) { if (!bootDown) bootDown = millis(); else if (millis() - bootDown > 5000) { prefs.clear(); ESP.restart(); } } else bootDown = 0;

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      serialBuf.trim();
      if (serialBuf.startsWith("OPEN")) openDoor(serialBuf.length() > 5 ? serialBuf.substring(5).toInt() : DEFAULT_MS);
      else if (serialBuf == "STATUS") Serial.println(statusJson());
      serialBuf = "";
    } else if (serialBuf.length() < 32) serialBuf += c;
  }

  static uint32_t lastWifi = 0;
  if (!apMode && WiFi.status() != WL_CONNECTED && millis() - lastWifi > 30000) { lastWifi = millis(); WiFi.reconnect(); }
  // Si arrancó en modo configuración porque el router estaba apagado, sigue intentando y vuelve solo
  if (apMode && wifiSsid.length() && millis() - lastWifi > 60000) {
    lastWifi = millis();
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  }
  if (apMode && wifiSsid.length() && WiFi.status() == WL_CONNECTED) {
    apMode = false; dns.stop(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA);
    Serial.println("WiFi OK: " + WiFi.localIP().toString());
  }
}
