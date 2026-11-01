/* SVB-QR: codificador QR minimalista (modo byte, corrección M, versiones 1–10). Sin dependencias.
   Esta misma función está embebida en index.html (bloque "QR ENCODER"); tests/qr.test.py verifica que decodifique. */
function qrEncode(text) {
  const data = Array.from(new TextEncoder().encode(text));
  // [total codewords, ec por bloque, [[nBloques, dataPorBloque], ...]] — nivel M
  const T = [null, [26, 10, [[1, 16]]], [44, 16, [[1, 28]]], [70, 26, [[1, 44]]], [100, 18, [[2, 32]]], [134, 24, [[2, 43]]],
    [172, 16, [[4, 27]]], [196, 18, [[4, 31]]], [242, 22, [[2, 38], [2, 39]]], [292, 22, [[3, 36], [2, 37]]], [346, 26, [[4, 43], [1, 44]]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = T[v][2].reduce((s, [n, d]) => s + n * d, 0);
    if (4 + (v < 10 ? 8 : 16) + data.length * 8 <= cap * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('Texto demasiado largo para QR');
  const [, ecLen, groups] = T[ver];
  const dataCap = groups.reduce((s, [n, d]) => s + n * d, 0);
  // Flujo de bits
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(data.length, ver < 10 ? 8 : 16); data.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; cw.length < dataCap; p++) cw.push(p % 2 ? 0x11 : 0xec);
  // Reed-Solomon GF(256)
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const g = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { g[j] ^= c; g[j + 1] ^= mul(c, EXP[i]); });
    gen = g;
  }
  const rs = (blk) => {
    const r = new Array(ecLen).fill(0);
    blk.forEach((b) => {
      const f = b ^ r.shift(); r.push(0);
      for (let j = 0; j < ecLen; j++) r[j] ^= mul(gen[j + 1], f);
    });
    return r;
  };
  const blocks = []; let off = 0;
  groups.forEach(([n, d]) => { for (let i = 0; i < n; i++) { const b = cw.slice(off, off + d); off += d; blocks.push({ d: b, e: rs(b) }); } });
  const final = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) blocks.forEach((b) => { if (i < b.d.length) final.push(b.d[i]); });
  for (let i = 0; i < ecLen; i++) blocks.forEach((b) => final.push(b.e[i]));
  // Matriz
  const N = ver * 4 + 17;
  const M = Array.from({ length: N }, () => new Array(N).fill(null));
  const fn = Array.from({ length: N }, () => new Array(N).fill(false));
  const set = (r, c, v) => { M[r][c] = v ? 1 : 0; fn[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= N || cc >= N) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
  for (let i = 8; i < N - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  const last = al.length - 1;
  al.forEach((r, i) => al.forEach((c, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }));
  set(N - 8, 8, 1); // módulo oscuro
  // Reservar formato / versión
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, 0); if (!fn[i][8]) set(i, 8, 0); }
  for (let i = 0; i < 8; i++) { set(8, N - 1 - i, 0); set(N - 1 - i, 8, 0); }
  if (ver >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(i, N - 11 + j, 0); set(N - 11 + j, i, 0); }
  // Datos en zigzag
  const dbits = [];
  final.forEach((b) => { for (let i = 7; i >= 0; i--) dbits.push((b >>> i) & 1); });
  let k = 0, up = true;
  for (let c = N - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    for (let i = 0; i < N; i++) {
      const r = up ? N - 1 - i : i;
      for (let d = 0; d < 2; d++) {
        const cc = c - d;
        if (!fn[r][cc]) { M[r][cc] = k < dbits.length ? dbits[k] : 0; k++; }
      }
    }
    up = !up;
  }
  const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  const bch = (val, poly, polyBits) => {
    let v = val << (polyBits - 1);
    for (let i = 31; i >= polyBits - 1; i--) if ((v >>> i) & 1) v ^= poly << (i - (polyBits - 1));
    return v;
  };
  const drawFormat = (G, mask) => {
    const data5 = (0 << 3) | mask; // M = 00
    const f = ((data5 << 10) | bch(data5, 0x537, 11)) ^ 0x5412;
    const bit = (i) => (f >>> i) & 1;
    for (let i = 0; i <= 5; i++) G[i][8] = bit(i);
    G[7][8] = bit(6); G[8][8] = bit(7); G[8][7] = bit(8);
    for (let i = 9; i < 15; i++) G[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) G[8][N - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) G[N - 15 + i][8] = bit(i);
    G[N - 8][8] = 1;
    if (ver >= 7) {
      const vbits = (ver << 12) | bch(ver, 0x1f25, 13);
      for (let i = 0; i < 18; i++) {
        const b = (vbits >>> i) & 1, a = Math.floor(i / 3), c = N - 11 + (i % 3);
        G[a][c] = b; G[c][a] = b;
      }
    }
  };
  const penalty = (G) => {
    let p = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < N; i++) {
      let run = 1;
      for (let j = 1; j < N; j++) {
        const a = pass ? G[j][i] : G[i][j], b = pass ? G[j - 1][i] : G[i][j - 1];
        if (a === b) { run++; if (j === N - 1 && run >= 5) p += run - 2; } else { if (run >= 5) p += run - 2; run = 1; }
      }
    }
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) { const s = G[i][j] + G[i + 1][j] + G[i][j + 1] + G[i + 1][j + 1]; if (s === 0 || s === 4) p += 3; }
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let i = 0; i < N; i++) for (let j = 0; j <= N - 11; j++) {
      let h1 = true, h2 = true, v1 = true, v2 = true;
      for (let q = 0; q < 11; q++) { if (G[i][j + q] !== pat[q]) h1 = false; if (G[i][j + q] !== pat2[q]) h2 = false; if (G[j + q][i] !== pat[q]) v1 = false; if (G[j + q][i] !== pat2[q]) v2 = false; }
      p += 40 * (h1 + h2 + v1 + v2);
    }
    let dark = 0; G.forEach((row) => row.forEach((v) => { dark += v; }));
    p += Math.floor(Math.abs((dark * 100) / (N * N) - 50) / 5) * 10;
    return p;
  };
  let best = null, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    const G = M.map((row, r) => row.map((v, c) => (fn[r][c] ? v : v ^ (MASKS[m](r, c) ? 1 : 0))));
    drawFormat(G, m);
    const p = penalty(G);
    if (p < bestP) { bestP = p; best = G; }
  }
  return { size: N, modules: best, version: ver };
}
if (typeof module !== 'undefined') module.exports = { qrEncode };
