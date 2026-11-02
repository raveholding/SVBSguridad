'use strict';
/**
 * Canales de aviso a los dueños (además de Telegram):
 *  - WhatsApp vía CallMeBot (gratis, uso personal): cada número se activa una vez y recibe una "apikey".
 *  - Notificación push al celular vía la app ntfy (Android / iPhone): con foto y botones de respuesta.
 */

/** "+5493871234567:123456, +549...:654321" → [{phone, apikey}] */
function parseRecipients(s) {
  return String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const [phone, apikey] = x.split(':').map((y) => (y || '').trim());
    return { phone: phone.replace(/[^\d+]/g, ''), apikey };
  }).filter((r) => /^\+?\d{8,15}$/.test(r.phone) && /^[\w-]{4,20}$/.test(r.apikey || ''));
}
function validRecipients(s) {
  const items = String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  return items.length === parseRecipients(s).length;
}

async function sendWhatsApp(apiBase, recipients, text) {
  const results = [];
  for (const r of recipients) {
    const url = `${apiBase.replace(/\/$/, '')}/whatsapp.php?phone=${encodeURIComponent(r.phone.startsWith('+') ? r.phone : '+' + r.phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(r.apikey)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const body = await res.text();
      const ok = res.ok && !/error|invalid|not (allowed|activated)/i.test(body.slice(0, 400));
      results.push({ phone: r.phone.slice(0, -4).replace(/\d/g, '•') + r.phone.slice(-4), ok, status: res.status });
    } catch (e) { results.push({ phone: '…' + r.phone.slice(-4), ok: false, error: e.message }); }
  }
  return results;
}

/**
 * Push con ntfy. Si hay foto se publica primero como adjunto; luego el aviso con título, texto y botones.
 * actions: [{label, body}] → botones que publican body en el tema de control (el servidor los recibe).
 */
async function sendPush(base, topic, { title, message, priority = 4, tags = [], photo = null, actions = [], controlTopic = null }) {
  base = base.replace(/\/$/, '');
  try {
    if (photo) {
      await fetch(`${base}/${encodeURIComponent(topic)}`, { method: 'PUT', body: photo, headers: { Filename: 'camara.jpg', Title: 'Camara', Priority: String(priority) }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    }
    const payload = { topic, title, message, priority, tags };
    if (actions.length && controlTopic) {
      payload.actions = actions.slice(0, 3).map((a) => ({ action: 'http', label: a.label, url: `${base}/${encodeURIComponent(controlTopic)}`, method: 'POST', body: JSON.stringify(a.body), clear: true }));
    }
    const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { parseRecipients, validRecipients, sendWhatsApp, sendPush };
