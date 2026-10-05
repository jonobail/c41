// node --test tests/jpeg.test.mjs   (C41_BENCH=1 also runs the 24 MP benchmark)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readExifDate } from '../js/exif.js';

const src = fs.readFileSync(new URL('../js/jpeg-worker.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const { createJpegEncoder, buildExifApp1, scaleQuantTable, TABLES, ZIGZAG } = mod.exports;

function synth(w, h, kind = 'grad') {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (kind === 'noise') {
      const v = Math.imul(x * 73856093 ^ y * 19349663, 0x9E3779B1) >>> 0;
      a[i] = v & 255; a[i + 1] = v >>> 8 & 255; a[i + 2] = v >>> 16 & 255;
    } else {
      a[i] = (x * 255 / Math.max(1, w - 1)) | 0;
      a[i + 1] = (y * 255 / Math.max(1, h - 1)) | 0;
      a[i + 2] = ((x + y) * 4) & 255;
    }
    a[i + 3] = 255;
  }
  return a;
}

function encode(w, h, rgba, stripRows = [h], opts = {}) {
  const enc = createJpegEncoder({ width: w, height: h, quality: 92, ...opts });
  let y = 0;
  for (const r of stripRows) {
    enc.addRows(rgba.subarray(y * w * 4, (y + r) * w * 4), r);
    y += r;
  }
  return Buffer.concat(enc.finish());
}

function strips(h, size) {
  const out = [];
  for (let y = 0; y < h; y += size) out.push(Math.min(size, h - y));
  return out;
}

/** Parse marker segments up to SOS; return list + scan bytes. */
function parse(buf) {
  assert.equal(buf.readUInt16BE(0), 0xFFD8, 'SOI');
  const segs = [];
  let p = 2;
  for (;;) {
    assert.equal(buf[p], 0xFF, `marker at ${p}`);
    const marker = buf[p + 1];
    const len = buf.readUInt16BE(p + 2);
    segs.push({ marker, data: buf.subarray(p + 4, p + 2 + len) });
    p += 2 + len;
    if (marker === 0xDA) break;
  }
  const scan = buf.subarray(p, buf.length - 2);
  assert.equal(buf.readUInt16BE(buf.length - 2), 0xFFD9, 'EOI');
  return { segs, scan };
}

test('Annex K Huffman tables are complete and consistent', () => {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  for (const [b, v, n] of [['DC_LUMA_BITS', 'DC_LUMA_VALS', 12], ['DC_CHROMA_BITS', 'DC_CHROMA_VALS', 12],
    ['AC_LUMA_BITS', 'AC_LUMA_VALS', 162], ['AC_CHROMA_BITS', 'AC_CHROMA_VALS', 162]]) {
    assert.equal(TABLES[b].length, 16);
    assert.equal(TABLES[v].length, n, v);
    assert.equal(sum(TABLES[b]), n, b);
  }
  // AC tables must cover every (run,size) symbol exactly once: 0x00, 0xF0 and run 0..15 × size 1..10
  const want = new Set([0x00, 0xF0]);
  for (let r = 0; r < 16; r++) for (let s = 1; s <= 10; s++) want.add(r << 4 | s);
  for (const v of ['AC_LUMA_VALS', 'AC_CHROMA_VALS']) {
    assert.deepEqual(new Set(TABLES[v]), want, v);
    assert.equal(new Set(TABLES[v]).size, 162);
  }
  // Kraft: canonical codes must fit (no length overflows, and no all-ones code)
  for (const b of ['DC_LUMA_BITS', 'DC_CHROMA_BITS', 'AC_LUMA_BITS', 'AC_CHROMA_BITS']) {
    let k = 0; TABLES[b].forEach((n, i) => { k += n / 2 ** (i + 1); });
    assert.ok(k < 1, b);
  }
  // zig-zag is a permutation
  assert.deepEqual([...ZIGZAG].sort((a, b) => a - b), [...Array(64).keys()]);
});

test('IJG quality scaling', () => {
  assert.deepEqual([...scaleQuantTable(TABLES.LUMA_Q, 50)], TABLES.LUMA_Q);
  assert.ok(scaleQuantTable(TABLES.LUMA_Q, 100).every((v) => v === 1));
  const q10 = scaleQuantTable(TABLES.LUMA_Q, 10);           // sf = 500
  assert.equal(q10[0], Math.floor((16 * 500 + 50) / 100));
  assert.ok(scaleQuantTable(TABLES.LUMA_Q, 1).every((v) => v <= 255 && v >= 1));
  const q92 = scaleQuantTable(TABLES.CHROMA_Q, 92);         // sf = 16
  assert.equal(q92[0], Math.floor((17 * 16 + 50) / 100));
});

test('marker structure, SOF0 dims, DQT/DHT/SOS contents', () => {
  for (const [w, h] of [[1, 1], [37, 53], [16, 16], [33, 17], [640, 480], [1, 300], [300, 1]]) {
    const buf = encode(w, h, synth(w, h), strips(h, 16), { quality: 75 });
    const { segs, scan } = parse(buf);
    const order = segs.map((s) => s.marker);
    assert.deepEqual(order, [0xE1, 0xDB, 0xC0, 0xC4, 0xDA], `${w}x${h}`);
    const sof = segs[2].data;
    assert.equal(sof[0], 8);
    assert.equal(sof.readUInt16BE(1), h);
    assert.equal(sof.readUInt16BE(3), w);
    assert.deepEqual([...sof.subarray(5)], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const dqt = segs[1].data;
    assert.equal(dqt.length, 130);
    const lq = scaleQuantTable(TABLES.LUMA_Q, 75);
    assert.equal(dqt[0], 0);
    for (let k = 0; k < 64; k++) assert.equal(dqt[1 + k], lq[ZIGZAG[k]]);
    assert.equal(dqt[65], 1);
    const dht = segs[3].data;
    assert.equal(dht.length, 4 * 17 + 12 + 12 + 162 + 162);
    assert.deepEqual([...segs[4].data], [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
    // byte stuffing: every 0xFF in the scan is followed by 0x00
    for (let i = 0; i < scan.length; i++) if (scan[i] === 0xFF) assert.equal(scan[++i], 0x00, `stuffing @${i}`);
    assert.ok(scan.length > 0);
  }
});

test('streaming: strip partitioning does not change output', () => {
  for (const [w, h] of [[37, 53], [100, 75], [129, 200]]) {
    const img = synth(w, h, 'noise');
    const ref = encode(w, h, img, [h]);
    assert.ok(ref.equals(encode(w, h, img, strips(h, 16))), `${w}x${h} 16-row strips`);
    assert.ok(ref.equals(encode(w, h, img, strips(h, 48))), `${w}x${h} 48-row strips`);
    assert.ok(ref.equals(encode(w, h, img, strips(h, 7))), `${w}x${h} 7-row strips (carry path)`);
    assert.ok(ref.equals(encode(w, h, img, strips(h, 1))), `${w}x${h} 1-row strips`);
  }
});

test('noise image exercises byte stuffing and multi-chunk output', () => {
  const w = 1200, h = 1000;
  const enc = createJpegEncoder({ width: w, height: h, quality: 100 });
  enc.addRows(synth(w, h, 'noise'), h);
  const chunks = enc.finish();
  assert.ok(chunks.length >= 2, `chunks=${chunks.length}`);
  const buf = Buffer.concat(chunks);
  const { scan } = parse(buf);
  let ff = 0;
  for (let i = 0; i < scan.length; i++) if (scan[i] === 0xFF) { ff++; assert.equal(scan[++i], 0); }
  assert.ok(ff > 100);
});

test('errors: bad dims, too many / too few rows, short data', () => {
  assert.throws(() => createJpegEncoder({ width: 0, height: 10 }));
  assert.throws(() => createJpegEncoder({ width: 70000, height: 10 }));
  const e1 = createJpegEncoder({ width: 4, height: 4 });
  assert.throws(() => e1.addRows(new Uint8Array(4 * 5 * 4), 5), /too many rows/);
  const e2 = createJpegEncoder({ width: 4, height: 4 });
  e2.addRows(new Uint8Array(4 * 2 * 4), 2);
  assert.throws(() => e2.finish(), /expected 4/);
  const e3 = createJpegEncoder({ width: 4, height: 4 });
  assert.throws(() => e3.addRows(new Uint8Array(10), 2), /too short/);
});

test('EXIF APP1 right after SOI; round-trips through readExifDate', async () => {
  const buf = encode(20, 20, synth(20, 20), [20], { exifDate: '2019:07:04 21:15:09' });
  assert.equal(buf.readUInt16BE(2), 0xFFE1);
  assert.equal(buf.toString('latin1', 6, 12), 'Exif\0\0');
  assert.equal(buf.toString('latin1', 12, 14), 'MM');
  const d = await readExifDate(new Blob([buf]));
  assert.ok(d instanceof Date);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()],
    [2019, 6, 4, 21, 15, 9]);
  assert.ok(buf.includes(Buffer.from('C41\0', 'latin1')));
  // no / invalid date: APP1 still present (Software), no date
  const nodate = encode(8, 8, synth(8, 8), [8], { exifDate: 'garbage' });
  assert.equal(nodate.readUInt16BE(2), 0xFFE1);
  assert.equal(await readExifDate(new Blob([nodate])), null);
  // segment length is self-consistent
  const seg = buildExifApp1('2020:01:01 00:00:00');
  assert.equal(seg.length, ((seg[2] << 8) | seg[3]) + 2);
});

test('benchmark: 24 MP encode (C41_BENCH=1)', { skip: !process.env.C41_BENCH }, () => {
  const W = 6000, H = 4000, strip = 368;
  const tile = synth(W, strip, 'grad');
  // add mild texture so the encoder sees realistic AC energy
  for (let i = 0; i < tile.length; i += 4) { const n = (Math.imul(i, 2654435761) >>> 27); tile[i] = (tile[i] + n) & 255; tile[i + 1] = (tile[i + 1] + n) & 255; }
  let best = Infinity, size = 0;
  for (let rep = 0; rep < 3; rep++) {
    const t = performance.now();
    const enc = createJpegEncoder({ width: W, height: H, quality: 92, exifDate: '2024:01:02 03:04:05' });
    for (let y = 0; y < H; y += strip) enc.addRows(tile, Math.min(strip, H - y));
    size = enc.finish().reduce((a, c) => a + c.length, 0);
    best = Math.min(best, performance.now() - t);
  }
  const mps = (W * H / 1e6) / (best / 1000);
  console.log(`# 24 MP q92: best ${best.toFixed(0)} ms = ${mps.toFixed(1)} MP/s, ${(size / 1e6).toFixed(2)} MB`);
  assert.ok(mps >= 15, `${mps.toFixed(1)} MP/s < 15`);
});
