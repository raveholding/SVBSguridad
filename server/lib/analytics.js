'use strict';
/**
 * Sistemas VB Seguridad — Motor de analítica de video (normalización + reglas + filtro de falsas alarmas).
 *
 * El sistema no reinventa los detectores: recibe detecciones de los motores que ya existen y las
 * unifica en un solo formato, aplica las reglas del sector y decide qué se avisa:
 *   - Grabador / cámaras Dahua (IVS, SMD, ANPR "TrafficJunction") por eventManager.cgi.
 *   - Frigate (MQTT "frigate/events") con YOLO/Coral, reconocimiento facial y de patentes.
 *   - Cualquier motor externo por HTTP (POST /api/v1/analytics/events): CodeProject.AI, DeepStack,
 *     Plate Recognizer, un Jetson en el campo, una cámara Hikvision con ISAPI, etc.
 *
 * Formato normalizado:
 *   { kind, label, camera, channel, confidence(0-1), plate, speed, direction, zone, missing[], count, seconds, attrs, source }
 */
const crypto = require('crypto');

const ANIMALS = new Set(['animal', 'dog', 'cat', 'bird', 'horse', 'cow', 'sheep', 'goat', 'pig', 'deer', 'bear', 'fox', 'rabbit', 'perro', 'gato', 'pajaro', 'ave', 'caballo', 'vaca', 'oveja', 'cabra', 'chancho', 'liebre', 'zorro', 'puma']);
const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'vehicle', 'auto', 'camion', 'camioneta', 'moto', 'tractor', 'license_plate']);
const PERSON = new Set(['person', 'persona', 'human', 'face']);
const PPE_ITEMS = { casco: 'casco', helmet: 'casco', hardhat: 'casco', chaleco: 'chaleco', vest: 'chaleco', botas: 'botas', boots: 'botas', guantes: 'guantes', gloves: 'guantes', anteojos: 'anteojos', goggles: 'anteojos' };

const KINDS = ['person', 'vehicle', 'animal', 'plate', 'ppe', 'fall', 'immobile', 'running', 'loitering', 'crowd', 'intrusion', 'line', 'speed', 'wrongway', 'count', 'dwell', 'face', 'tamper', 'fire', 'smoke', 'sign'];

// Códigos de eventos inteligentes de Dahua → tipo normalizado
const DAHUA_KIND = {
  SmartMotionHuman: 'person', HumanTrait: 'person', SmartMotionVehicle: 'vehicle',
  CrossLineDetection: 'line', CrossRegionDetection: 'intrusion', CrossFenceDetection: 'intrusion',
  TrafficJunction: 'plate', TrafficParking: 'plate', TrafficRetrograde: 'wrongway', TrafficOverSpeed: 'speed',
  WanderDetection: 'loitering', StayDetection: 'loitering', RioterDetection: 'crowd', CrowdDetection: 'crowd',
  MoveDetection: 'running', FastMoving: 'running', FallDetection: 'fall', ManStandDetection: 'immobile',
  FireWarning: 'fire', SmokeDetection: 'smoke', FaceRecognition: 'face',
};

const clamp01 = (x) => { const n = Number(x); if (!Number.isFinite(n)) return null; return Math.max(0, Math.min(1, n > 1 ? n / 100 : n)); };
const lc = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function classify(label) {
  const l = lc(label);
  if (PERSON.has(l)) return 'person';
  if (VEHICLES.has(l)) return 'vehicle';
  if (ANIMALS.has(l)) return 'animal';
  return null;
}

/** Evento Dahua (de dahua-events.js) → detección normalizada, o null si no es analítica. */
function fromDahua(e, camName) {
  const kind = DAHUA_KIND[e.code];
  if (!kind) return null;
  let data = {};
  if (e.data) { try { data = JSON.parse(e.data); } catch { /* bloque no JSON */ } }
  const obj = data.Object || {}; const car = data.TrafficCar || {};
  const plate = car.PlateNumber || (obj.ObjectType === 'Plate' || kind === 'plate' ? obj.Text : '') || data.PlateNumber || '';
  return {
    source: 'dahua', kind: kind === 'plate' && !plate ? 'vehicle' : kind, label: e.label || e.code,
    camera: camName, channel: e.channel, confidence: clamp01(obj.Confidence ?? car.Confidence ?? data.Confidence) ?? 0.8,
    plate, speed: Number(car.Speed || data.Speed) || null, direction: data.Direction || car.Direction || null,
    zone: data.Name || '', attrs: { code: e.code, vehicle: car.VehicleType || car.Category || obj.Category || null, color: car.VehicleColor || null, brand: car.VehicleSign || null, text: obj.Text || null },
  };
}

/** Mensaje de Frigate (tópico frigate/events) → detección normalizada. */
function fromFrigate(msg, seen) {
  let m = msg;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return null; } }
  const a = m && m.after;
  if (!a || a.false_positive) return null;
  const plate = Array.isArray(a.recognized_license_plate) ? a.recognized_license_plate[0] : a.recognized_license_plate || '';
  const key = `${a.id}:${plate ? 'p' : ''}`;
  // Solo el evento nuevo (o la primera vez que aparece la patente) para no repetir avisos
  if (m.type !== 'new' && !(plate && !seen.has(key))) return null;
  seen.add(key); if (seen.size > 2000) seen.clear();
  const sub = Array.isArray(a.sub_label) ? a.sub_label[0] : a.sub_label;
  const kind = plate ? 'plate' : sub && classify(a.label) === 'person' ? 'face' : classify(a.label) || 'person';
  return {
    source: 'frigate', kind, label: a.label, camera: a.camera, channel: null,
    confidence: clamp01(a.top_score ?? a.score) ?? 0.7, plate, zone: (a.current_zones || [])[0] || '',
    attrs: { id: a.id, face: kind === 'face' ? sub : null },
  };
}

/** Cuerpo JSON de un motor externo → detección normalizada (valida y recorta). */
function fromApi(b) {
  const kind = KINDS.includes(b.kind) ? b.kind : classify(b.label);
  if (!kind) throw new Error(`kind inválido. Usar: ${KINDS.join(', ')}`);
  const missing = (Array.isArray(b.missing) ? b.missing : String(b.missing || '').split(',')).map((x) => PPE_ITEMS[lc(x).trim()] || null).filter(Boolean);
  return {
    source: String(b.source || 'api').slice(0, 30), kind, label: String(b.label || kind).slice(0, 40),
    camera: String(b.camera || '').slice(0, 40), channel: parseInt(b.channel, 10) || null,
    confidence: clamp01(b.confidence) ?? 0.8, plate: String(b.plate || '').slice(0, 12),
    speed: Number(b.speed) || null, direction: b.direction ? String(b.direction).slice(0, 20) : null,
    zone: String(b.zone || '').slice(0, 30), missing: [...new Set(missing)], count: parseInt(b.count, 10) || null,
    delta: parseInt(b.delta, 10) || 0, seconds: Number(b.seconds) || null, text: b.text ? String(b.text).slice(0, 80) : null,
    attrs: b.attrs && typeof b.attrs === 'object' && JSON.stringify(b.attrs).length <= 2000 ? b.attrs : {},
  };
}

/**
 * Motor de reglas. getCfg() devuelve la configuración vigente:
 *   { sector, minConf, ruralFilter, persistN, persistS, speedLimit, crowdMin, armed }
 * evaluate(det) → { det, filtered?:string, type, level, message, notify, alertKind }
 */
class AnalyticsEngine {
  constructor(getCfg) {
    this.getCfg = getCfg;
    this.hits = new Map();   // camara:clase → [ts]
    this.noise = new Map();  // camara → {ts:[], conf:[], until}
    this.recent = [];        // últimas detecciones (para el panel)
    this.stats = { in: 0, filtered: 0, alerts: 0, byReason: {} };
  }
  _filter(reason) { this.stats.filtered++; this.stats.byReason[reason] = (this.stats.byReason[reason] || 0) + 1; return reason; }

  /** ¿Es ruido de viento/lluvia/vegetación? Muchas detecciones de baja confianza en la misma cámara. */
  _noisy(cam, conf, now) {
    const n = this.noise.get(cam) || { ts: [], conf: [], until: 0, flagged: false };
    n.ts.push(now); n.conf.push(conf);
    while (n.ts.length && now - n.ts[0] > 60000) { n.ts.shift(); n.conf.shift(); }
    this.noise.set(cam, n);
    if (n.until > now) return 'storm';
    const avg = n.conf.reduce((a, b) => a + b, 0) / n.conf.length;
    if (n.ts.length >= 12 && avg < 0.6) { n.until = now + 5 * 60000; n.flagged = true; return 'storm-start'; }
    return null;
  }

  evaluate(det, now = Date.now()) {
    const c = this.getCfg();
    this.stats.in++;
    det.id = crypto.randomUUID(); det.ts = new Date(now).toISOString();
    const cam = det.camera || `canal ${det.channel || '?'}`;
    const rural = c.ruralFilter || c.sector === 'campo';
    const out = (o) => { this.recent.unshift({ ...det, filtered: o.filtered || null, type: o.type || null }); if (this.recent.length > 100) this.recent.length = 100; return { det, ...o }; };

    // 1) Filtro de falsas alarmas (siempre en campo; opcional en otros sectores)
    if (rural && ['person', 'vehicle', 'intrusion', 'line', 'animal'].includes(det.kind)) {
      if (det.kind === 'animal' || classify(det.label) === 'animal') return out({ filtered: this._filter('fauna') });
      const nz = this._noisy(cam, det.confidence, now);
      if (nz === 'storm-start') return out({ filtered: this._filter('clima/vegetación'), type: 'ANALYTICS_NOISE', level: 'INFO', message: `${cam}: muchas detecciones dudosas (viento, lluvia o vegetación). Se pausan 5 min las de baja confianza.`, notify: false });
      if (nz === 'storm' && det.confidence < 0.85) return out({ filtered: this._filter('clima/vegetación') });
      if (det.confidence < c.minConf) return out({ filtered: this._filter('baja confianza') });
      // Persistencia: N detecciones en la ventana (salvo confianza muy alta)
      if (det.confidence < 0.85 && c.persistN > 1) {
        const k = `${cam}:${det.kind}`; const arr = (this.hits.get(k) || []).filter((t) => now - t <= c.persistS * 1000);
        arr.push(now); this.hits.set(k, arr);
        if (arr.length < c.persistN) return out({ filtered: this._filter('confirmando') });
        this.hits.set(k, []);
      }
    } else if (det.confidence < Math.min(c.minConf, 0.4) && !['count', 'dwell'].includes(det.kind)) {
      return out({ filtered: this._filter('baja confianza') });
    }

    // 2) Reglas por tipo
    const where = det.zone ? `${cam} · ${det.zone}` : cam;
    const pct = det.confidence != null ? ` (${Math.round(det.confidence * 100)}%)` : '';
    const R = (type, level, message, notify, alertKind = 'alarm') => { if (notify) this.stats.alerts++; return out({ type, level, message, notify, alertKind }); };
    switch (det.kind) {
      case 'plate': return out({ type: 'PLATE_READ', level: 'INFO', message: `Patente ${det.plate} en ${where}${pct}`, notify: false, plate: true });
      case 'ppe': {
        if (!det.missing || !det.missing.length) return out({ filtered: this._filter('epp completo') });
        return R('PPE_MISSING', 'HIGH', `EPP incompleto en ${where}: falta ${det.missing.join(', ')}${pct}`, c.sector === 'industria' || c.ppeAlways);
      }
      case 'fall': return R('FALL_DETECTED', 'HIGH', `Posible caída de una persona en ${where}${pct}`, true);
      case 'immobile': return R('PERSON_IMMOBILE', 'HIGH', `Persona inmóvil en el piso en ${where}${det.seconds ? ` (${Math.round(det.seconds)} s)` : ''}`, true);
      case 'running': return R('RUNNING', 'WARN', `Carrera repentina en ${where}${pct}`, c.armed);
      case 'loitering': return R('LOITERING', 'WARN', `Merodeo en ${where}${det.seconds ? ` (${Math.round(det.seconds)} s)` : ''}`, c.armed || c.sector !== 'residencial');
      case 'crowd': {
        if (det.count && det.count < c.crowdMin) return out({ filtered: this._filter('grupo chico') });
        return R('CROWD', 'WARN', `Aglomeración en ${where}${det.count ? `: ${det.count} personas` : ''}`, true);
      }
      case 'speed': {
        if (det.speed && det.speed <= c.speedLimit) return out({ filtered: this._filter('velocidad normal') });
        return R('SPEEDING', 'HIGH', `Exceso de velocidad en ${where}: ${det.speed || '?'} km/h (límite ${c.speedLimit})${det.plate ? ' · ' + det.plate : ''}`, true);
      }
      case 'wrongway': return R('WRONG_WAY', 'HIGH', `Vehículo en contramano en ${where}${det.plate ? ' · ' + det.plate : ''}`, true);
      case 'fire': case 'smoke': return R('FIRE_ALERT', 'CRITICAL', `${det.kind === 'fire' ? 'Fuego' : 'Humo'} detectado en ${where}${pct}`, true, 'sos');
      case 'tamper': return R('CAMERA_TAMPER', 'HIGH', `Sabotaje de cámara en ${where}`, true);
      case 'count': return out({ type: 'OCCUPANCY_COUNT', level: 'INFO', message: `Conteo ${det.delta > 0 ? '+' : ''}${det.delta || det.count || 0} en ${where}`, notify: false, occupancy: true });
      case 'dwell': return out({ type: 'DWELL', level: 'INFO', message: `Permanencia ${Math.round(det.seconds || 0)} s en ${where}`, notify: false, dwell: true });
      case 'face': return out({ type: 'FACE_SEEN', level: 'INFO', message: `Rostro ${det.attrs && det.attrs.face ? 'reconocido: ' + det.attrs.face : 'detectado'} en ${where}`, notify: false });
      case 'sign': return out({ type: 'SIGN_READ', level: 'INFO', message: `Rotulación leída en ${where}: «${det.text || det.label}»`, notify: false });
      case 'animal': return out({ type: 'ANIMAL', level: 'INFO', message: `Animal (${det.label}) en ${where}`, notify: false });
      default: { // person, vehicle, intrusion, line
        const what = { person: 'Persona', vehicle: 'Vehículo', intrusion: 'Intrusión', line: 'Cruce de línea' }[det.kind] || det.label;
        return R(c.armed ? 'INTRUSION' : 'DETECTION', c.armed ? 'HIGH' : 'INFO', `${what} en ${where}${pct}${c.armed ? ' — sistema ARMADO' : ''}`, c.armed, 'motion');
      }
    }
  }
}

module.exports = { AnalyticsEngine, fromDahua, fromFrigate, fromApi, classify, KINDS, DAHUA_KIND };
