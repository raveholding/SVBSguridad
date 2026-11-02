'use strict';
/** Relevo ntfy simulado (subset de la API de ntfy.sh) para pruebas. Uso: node fake-ntfy.js [puerto] */
const http = require('http');
const crypto = require('crypto');

function createNtfy() {
  const msgs = []; const subs = new Set();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const parts = u.pathname.split('/').filter(Boolean);
    const topic = decodeURIComponent(parts[0] || '');
    if ((req.method === 'POST' || req.method === 'PUT') && parts.length <= 1) {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const base = { id: crypto.randomBytes(6).toString('hex'), time: Math.floor(Date.now() / 1000), event: 'message' };
        let m;
        if (parts.length === 0) { // publicación JSON en la raíz (como ntfy.sh)
          const j = JSON.parse(raw.toString());
          m = { ...base, topic: j.topic, message: j.message || '', title: j.title, priority: j.priority, tags: j.tags, actions: j.actions };
        } else if (req.method === 'PUT') { // adjunto
          m = { ...base, topic, message: 'archivo', title: req.headers.title, attachment: { name: req.headers.filename, size: raw.length } };
        } else m = { ...base, topic, message: raw.toString() };
        msgs.push(m);
        subs.forEach((x) => x.topics.includes(m.topic) && x.send(m));
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(m));
      });
      return;
    }
    if (req.method === 'GET' && (parts[1] === 'json' || parts[1] === 'sse')) {
      const sse = parts[1] === 'sse';
      const sinceRaw = u.searchParams.get('since') || '';
      const since = sinceRaw === 'all' ? 0 : /^\d+s$/.test(sinceRaw) ? Math.floor(Date.now() / 1000) - parseInt(sinceRaw, 10) : parseInt(sinceRaw, 10) || Math.floor(Date.now() / 1000);
      res.writeHead(200, { ...cors, 'Content-Type': sse ? 'text/event-stream' : 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const send = (m) => res.write(sse ? `event: message\ndata: ${JSON.stringify(m)}\n\n` : JSON.stringify(m) + '\n');
      res.write(sse ? `event: open\ndata: {"event":"open"}\n\n` : JSON.stringify({ event: 'open', topic }) + '\n');
      const topics = topic.split(','); // varios temas separados por coma, como ntfy.sh
      msgs.filter((m) => topics.includes(m.topic) && m.time >= since).forEach(send);
      if (u.searchParams.get('poll') === '1') return res.end();
      const sub = { topic, topics, send }; subs.add(sub);
      const ka = setInterval(() => res.write(sse ? ': ka\n\n' : JSON.stringify({ event: 'keepalive' }) + '\n'), 15000);
      req.on('close', () => { clearInterval(ka); subs.delete(sub); });
      return;
    }
    res.writeHead(404, cors); res.end();
  });
  return { server, msgs };
}

if (require.main === module) {
  const { server } = createNtfy();
  server.listen(parseInt(process.argv[2], 10) || 0, '127.0.0.1', () => console.log(server.address().port));
}
module.exports = { createNtfy };
