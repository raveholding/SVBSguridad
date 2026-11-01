/*
 * SVB Seguridad — Controlador de cerradura para ESP32 (Almacén Rave)
 * ------------------------------------------------------------------
 * Hardware:
 *   - ESP32 DevKit (ESP32-WROOM-32)
 *   - Módulo relé 1 canal 5V (optoacoplado) → GPIO 26
 *   - Cerradura electromagnética / electroimán 12V (alimentación propia + diodo 1N4007 en paralelo)
 *   - Sensor magnético de puerta (reed, NC) → GPIO 27 a GND (opcional)
 *   - Pulsador de salida interior → GPIO 25 a GND (opcional)
 *
 * Control:
 *   - WiFi:  POST http://svb-puerta.local/open?ms=3000   con header  X-Token: <ESP32_TOKEN>
 *            GET  http://svb-puerta.local/status
 *   - USB/Serie (115200): "OPEN 3000"  |  "STATUS"   (modo escritorio Electron)
 *
 * Compilar: Arduino IDE 2.x + "esp32 by Espressif Systems" (Placa: ESP32 Dev Module).
 * Completar WIFI_SSID, WIFI_PASS y TOKEN antes de grabar. TOKEN debe coincidir con ESP32_TOKEN del .env.
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ====== CONFIGURACIÓN ======
const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASS = "TU_CLAVE_WIFI";
const char* TOKEN     = "cambiar-este-token-largo";
const char* HOSTNAME  = "svb-puerta";

const int  PIN_RELAY     = 26;
const int  PIN_DOOR      = 27;     // reed switch (LOW = cerrada)
const int  PIN_EXIT_BTN  = 25;     // pulsador de salida
const bool RELAY_ACTIVE_LOW = true; // la mayoría de módulos relé chinos se activan con LOW
// Cableado: cerradura eléctrica de pestillo (tipo Kallay/cerradero) → contacto NA (NO) del relé.
//           Electroimán (traba con energía) → contacto NC: al activar el relé se corta y abre.
const uint32_t MIN_MS = 100, MAX_MS = 10000, DEFAULT_MS = 3000;
// ===========================

WebServer server(80);
volatile uint32_t relayUntil = 0;
uint32_t opens = 0;

void relayWrite(bool on) {
  digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void openDoor(uint32_t ms) {
  ms = constrain(ms, MIN_MS, MAX_MS);
  relayWrite(true);
  relayUntil = millis() + ms;
  opens++;
  Serial.printf("OPENED %lu\n", (unsigned long)ms);
}

bool doorClosed() { return digitalRead(PIN_DOOR) == LOW; }

String statusJson() {
  return String("{\"ok\":true,\"relay\":") + (relayUntil ? "true" : "false") +
         ",\"door\":\"" + (doorClosed() ? "cerrada" : "abierta") + "\"" +
         ",\"opens\":" + opens + ",\"rssi\":" + WiFi.RSSI() + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
}

void sendCors(int code, const String& body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "X-Token, Content-Type");
  server.send(code, "application/json", body);
}

void handleOpen() {
  if (server.method() == HTTP_OPTIONS) { sendCors(204, ""); return; }
  if (server.header("X-Token") != TOKEN) { sendCors(401, "{\"ok\":false,\"error\":\"token\"}"); return; }
  uint32_t ms = server.hasArg("ms") ? server.arg("ms").toInt() : DEFAULT_MS;
  openDoor(ms);
  sendCors(200, statusJson());
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Conectando WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWiFi OK: " + WiFi.localIP().toString() : "\nSin WiFi (sigue funcionando por USB)");
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false);                 // arranca trabada
  pinMode(PIN_DOOR, INPUT_PULLUP);
  pinMode(PIN_EXIT_BTN, INPUT_PULLUP);
  Serial.begin(115200);
  connectWifi();
  if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);
  const char* hdrs[] = {"X-Token"};
  server.collectHeaders(hdrs, 1);
  server.on("/open", handleOpen);
  server.on("/status", []() { sendCors(200, statusJson()); });
  server.onNotFound([]() { sendCors(404, "{\"ok\":false}"); });
  server.begin();
}

String serialBuf;
void loop() {
  server.handleClient();

  if (relayUntil && (int32_t)(millis() - relayUntil) >= 0) { relayWrite(false); relayUntil = 0; Serial.println("LOCKED"); }

  static uint32_t lastBtn = 0;
  if (digitalRead(PIN_EXIT_BTN) == LOW && millis() - lastBtn > 1500) { lastBtn = millis(); openDoor(DEFAULT_MS); }

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
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifi > 30000) { lastWifi = millis(); WiFi.reconnect(); }
}
