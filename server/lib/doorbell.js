'use strict';
/**
 * Portero digital por QR / NFC.
 *
 * El cliente escanea el QR de la puerta con SU celular (datos móviles, fuera de la red del local).
 * La página pública timbre.html publica el timbre en un "tema" secreto de ntfy (relevo gratuito,
 * https://ntfy.sh). Este servidor escucha ese tema, hace sonar el panel y avisa por Telegram.
 * Las respuestas ("Ya voy", "Un momento"…) se publican en <tema>-r y la página del cliente las muestra.
 * No hace falta abrir puertos del router ni exponer la PC a internet.
 */
const { EventEmitter } = require('events');

const REPLIES = {
  voy: 'Ya voy, aguarde un momento 🙂',
  momento: 'Estamos atendiendo, enseguida lo atendemos.',
  cerrado: 'Ahora no podemos atender. Disculpe las molestias.',
  pase: 'Puerta abierta, puede pasar.',
  deje: 'Por favor deje el pedido en la puerta. ¡Gracias!',
};

/**
 * Foto del visitante enviada por su celular en partes por el tema de señalización <tema>-v<id>.
 * Espera hasta waitMs y devuelve el JPEG (Buffer) o null.
 */
async function fetchVisitorPhoto(base, sig, id, waitMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/${encodeURIComponent(sig)}/json?poll=1&since=5m`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const parts = []; let n = 0;
      (await r.text()).split('\n').forEach((l) => {
        try { const m = JSON.parse(l); if (m.event !== 'message') return; const p = JSON.parse(m.message); if (p.type === 'sig' && p.id === id && p.kind === 'photo') { n = Math.min(40, +p.n || 1); parts[+p.i] = String(p.d || '').slice(0, 3000); } } catch { /* otra línea */ }
      });
      if (!n || parts.filter(Boolean).length < n) continue;
      const data = parts.join('');
      const mt = data.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!mt || data.length > 150000) return null;
      return Buffer.from(mt[1], 'base64');
    } catch { /* reintenta */ }
  }
  return null;
}

class NtfyListener extends EventEmitter {
  constructor({ base, topic, log = () => {} }) {
    super();
    this.base = base.replace(/\/$/, ''); this.topic = topic; this.log = log;
    this.ctl = null; this.stopped = false; this.backoff = 2000; this.connected = false;
  }
  start() { this.stopped = false; this._run(); return this; }
  stop() { this.stopped = true; if (this.ctl) this.ctl.abort(); this.connected = false; }
  async _run() {
    while (!this.stopped) {
      this.ctl = new AbortController();
      let idle;
      try {
        const r = await fetch(`${this.base}/${encodeURIComponent(this.topic)}/json?since=30s`, { signal: this.ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.connected = true; this.backoff = 2000; this.emit('connected');
        const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        const kick = () => { clearTimeout(idle); idle = setTimeout(() => this.ctl.abort(), 90000); };
        kick();
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          kick();
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const m = JSON.parse(line);
              if (m.event !== 'message') continue;
              let p; try { p = JSON.parse(m.message); } catch { p = { type: 'ring', msg: m.message }; }
              if (p && typeof p === 'object') this.emit('data', p);
              if (p && p.type === 'ring') this.emit('ring', { id: String(p.id || m.id).slice(0, 40), name: String(p.name || '').slice(0, 40), msg: String(p.msg || '').slice(0, 200), video: p.video === true, ntfyId: m.id });
            } catch { /* línea inválida */ }
          }
        }
      } catch (e) {
        if (!this.stopped && e.name !== 'AbortError') this.log(`portero: ${e.message}`);
      } finally { clearTimeout(idle); }
      this.connected = false;
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, this.backoff));
      this.backoff = Math.min(60000, this.backoff * 2);
    }
  }
}

async function publish(base, topic, payload) {
  const r = await fetch(`${base.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, { method: 'POST', body: JSON.stringify(payload) });
  return r.ok;
}

module.exports = { fetchVisitorPhoto, NtfyListener, publish, REPLIES };
