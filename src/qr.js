'use strict';
// Minimal dependency-free QR Code encoder: byte mode, error-correction level M, versions 1-6.
// Returns an array of strings ('1' = dark module) so it is easy to send as JSON and draw as SVG.

const VERSIONS = {
  1: { total: 26, ec: 10, blocks: 1, align: [] },
  2: { total: 44, ec: 16, blocks: 1, align: [6, 18] },
  3: { total: 70, ec: 26, blocks: 1, align: [6, 22] },
  4: { total: 100, ec: 18, blocks: 2, align: [6, 26] },
  5: { total: 134, ec: 24, blocks: 2, align: [6, 30] },
  6: { total: 172, ec: 16, blocks: 4, align: [6, 34] },
};

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = ng;
  }
  return g;
}

function rsRemainder(data, n) {
  const g = rsGenerator(n);
  const res = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ res[0];
    res.shift();
    res.push(0);
    if (f) for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], f);
  }
  return res;
}

function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    const info = VERSIONS[v];
    const dataCw = info.total - info.ec * info.blocks;
    if (bytes.length <= dataCw - 2) { version = v; break; }
  }
  if (!version) throw new Error('QR payload too long');
  const info = VERSIONS[version];
  const dataCw = info.total - info.ec * info.blocks;

  // --- bit stream
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cws = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cws.push(b);
  }
  for (let pad = 0xec; cws.length < dataCw; pad ^= 0xec ^ 0x11) cws.push(pad);

  // --- split into blocks, add EC, interleave
  const per = dataCw / info.blocks;
  const dBlocks = [];
  const eBlocks = [];
  for (let b = 0; b < info.blocks; b++) {
    const blk = cws.slice(b * per, (b + 1) * per);
    dBlocks.push(blk);
    eBlocks.push(rsRemainder(blk, info.ec));
  }
  const final = [];
  for (let i = 0; i < per; i++) dBlocks.forEach((blk) => final.push(blk[i]));
  for (let i = 0; i < info.ec; i++) eBlocks.forEach((blk) => final.push(blk[i]));
  const dataBits = [];
  final.forEach((c) => { for (let i = 7; i >= 0; i--) dataBits.push((c >>> i) & 1); });

  // --- matrix
  const size = 17 + 4 * version;
  const mod = Array.from({ length: size }, () => new Array(size).fill(0));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { mod[y][x] = dark ? 1 : 0; isFn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = info.align;
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  const drawFormat = (mask) => {
    const data = (0 << 3) | mask; // EC level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);

  // zig-zag data placement
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && k < dataBits.length) mod[y][x] = dataBits[k++];
      }
    }
  }

  const MASKS = [
    (y, x) => (y + x) % 2 === 0,
    (y) => y % 2 === 0,
    (y, x) => x % 3 === 0,
    (y, x) => (y + x) % 3 === 0,
    (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
    (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
    (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[m](y, x)) mod[y][x] ^= 1;
  };

  const penalty = () => {
    let score = 0;
    const lines = [];
    for (let y = 0; y < size; y++) lines.push(mod[y].join(''));
    for (let x = 0; x < size; x++) { let s = ''; for (let y = 0; y < size; y++) s += mod[y][x]; lines.push(s); }
    for (const s of lines) {
      const runs = s.match(/0+|1+/g);
      for (const r of runs) if (r.length >= 5) score += 3 + (r.length - 5);
      for (const pat of ['10111010000', '00001011101']) {
        let idx = s.indexOf(pat);
        while (idx !== -1) { score += 40; idx = s.indexOf(pat, idx + 1); }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
    }
    let dark = 0;
    for (const row of mod) for (const c of row) dark += c;
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  };

  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestScore) { bestScore = p; best = m; }
    applyMask(m); // undo
  }
  applyMask(best); drawFormat(best);
  return mod.map((r) => r.join(''));
}

function toSvg(rows, { border = 4, dark = '#000', light = '#fff' } = {}) {
  const n = rows.length + border * 2;
  let d = '';
  rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '1') d += `M${x + border},${y + border}h1v1h-1z`; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { encode, toSvg };
