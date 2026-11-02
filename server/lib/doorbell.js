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
              if (p && p.type === 'ring') this.emit('ring', { id: String(p.id || m.id).slice(0, 40), name: String(p.name || '').slice(0, 40), msg: String(p.msg || '').slice(0, 200), ntfyId: m.id });
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

module.exports = { NtfyListener, publish, REPLIES };
