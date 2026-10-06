// "Match a photo" — matcher unit tests (no browser).  node --test tests/match.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeFilm, srgbToLinear, FIT_SPEC, getPath } from '../js/film-transform.js';
import { getFilm } from '../js/films.js';
import * as MS from '../js/match-stats.js';
import * as CS from '../calibration/stats.mjs';
import { fitLook, analyse, renderPool, AbortError } from '../js/match-worker.js';

const POOL = fileURLToPath(new URL('../assets/baseline-pool.bin', import.meta.url));
const baseU8 = new Uint8Array(readFileSync(POOL));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- verbatim copy of the original calibration/stats.mjs statistics (reference for the port) ----
const R = {
  QUANTILES: [0.01, 0.03, 0.07, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.93, 0.97, 0.99],
  LUMA_BINS: [0, 0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0001],
  HUE_BANDS: [0, 30, 60, 120, 180, 240, 270, 300],
};
function hueOf(r, g, b, mx, c) {
  let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
function nearestBand(h) {
  let best = 0, bd = 999;
  for (let i = 0; i < R.HUE_BANDS.length; i++) {
    const d = Math.min(Math.abs(h - R.HUE_BANDS[i]), 360 - Math.abs(h - R.HUE_BANDS[i]));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function refPoolStats(px) {
  const n = px.length / 3;
  const Y = new Float32Array(n);
  const nb = R.LUMA_BINS.length - 1;
  const cast = Array.from({ length: nb }, () => [0, 0, 0]), chroma = new Array(nb).fill(0), cnt = new Array(nb).fill(0);
  const band = R.HUE_BANDS.map(() => [0, 0, 0]);
  let mono = 0;
  for (let i = 0; i < n; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = y;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let k = 0; while (k < nb - 1 && y >= R.LUMA_BINS[k + 1]) k++;
    cast[k][0] += r - y; cast[k][1] += g - y; cast[k][2] += b - y; chroma[k] += c; cnt[k]++;
    mono += c;
    if (c > 0.08) { const bi = nearestBand(hueOf(r, g, b, mx, c)); band[bi][0] += c; band[bi][1] += y; band[bi][2]++; }
  }
  Y.sort();
  return {
    q: R.QUANTILES.map((p) => Y[Math.min(n - 1, Math.floor(p * n))]),
    cast: cast.map((c, k) => (cnt[k] > 50 ? c.map((v) => v / cnt[k]) : null)),
    chroma: chroma.map((c, k) => (cnt[k] > 50 ? c / cnt[k] : null)),
    band: band.map(([c, y, m]) => (m > 100 ? [c / m, y / m, m / n] : null)),
    mono: mono / n,
  };
}
function refStatDistance(a, b, { bw = false } = {}) {
  let d = 0;
  for (let i = 0; i < a.q.length; i++) d += 4 * (a.q[i] - b.q[i]) ** 2;
  if (bw) return d;
  for (let k = 0; k < a.cast.length; k++) {
    if (a.cast[k] && b.cast[k]) for (let c = 0; c < 3; c++) d += 6 * (a.cast[k][c] - b.cast[k][c]) ** 2;
    if (a.chroma[k] != null && b.chroma[k] != null) d += 3 * (a.chroma[k] - b.chroma[k]) ** 2;
  }
  for (let i = 0; i < a.band.length; i++) {
    if (!a.band[i] || !b.band[i]) continue;
    const w = Math.min(1, 20 * Math.min(a.band[i][2], b.band[i][2]));
    d += w * (1.5 * (a.band[i][0] - b.band[i][0]) ** 2 + 0.75 * (a.band[i][1] - b.band[i][1]) ** 2);
  }
  return d;
}

function synthPool(n, seed) {
  const r = rng(seed), px = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = r();
    if (t < 0.3) { const v = r(); px[i * 3] = v; px[i * 3 + 1] = v * (0.9 + 0.2 * r()); px[i * 3 + 2] = v * 0.95; }
    else for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.round(r() ** (1 + c * 0.3) * 255) / 255;
  }
  return px;
}

// ---- synthetic RGBA images ----
function makeImage(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y), i = (y * w + x) * 4;
    d[i] = Math.round(c[0] * 255); d[i + 1] = Math.round(c[1] * 255); d[i + 2] = Math.round(c[2] * 255); d[i + 3] = 255;
  }
  return d;
}
// port of the renderer's grain noise (js/renderer.js grainAt, cell 1 px)
const pcg = (v) => { const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0; const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
const hashf = (x, y, ch) => pcg((x ^ pcg((y ^ pcg((3 + ch) >>> 0)) >>> 0)) >>> 0) * (2 / 4294967295) - 1;
const vnoise = (x, y, ch) => {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const cx = ix + 65536, cy = iy + 65536;
  const a = hashf(cx, cy, ch), b = hashf(cx + 1, cy, ch), d = hashf(cx, cy + 1, ch), e = hashf(cx + 1, cy + 1, ch);
  return (a + (b - a) * ux) * (1 - uy) + (d + (e - d) * ux) * uy;
};
const grainAt = (x, y, ch) => (vnoise(x + 0.5, y + 0.5, ch) + 0.5 * vnoise((x + 0.5) / 2.3 + 31.7, (y + 0.5) / 2.3 + 31.7, ch + 7)) * 1.25;
/** smooth scene + renderer grain at film amount × slider = `level`, colour = `color` */
function grainyImage(w, h, level, color) {
  const amp = level * 0.12 * Math.max(0.5, Math.sqrt(MS.GRAIN_SHORT_EDGE * 0.00045));
  return makeImage(w, h, (x, y) => {
    const L = 0.3 + 0.35 * (x / w) + 0.1 * Math.sin(y / 40);
    const wt = 0.15 + 0.85 * Math.min(1, 4 * L * (1 - L));
    const m = grainAt(x, y, 0);
    const g = [m, (1 - color) * m + color * grainAt(x, y, 1), (1 - color) * m + color * grainAt(x, y, 2)];
    return [L * 1.05 + g[0] * amp * wt, L + g[1] * amp * wt, L * 0.92 + g[2] * amp * wt];
  });
}

// ------------------------------------------------------------------------------------------------
test('stats port: poolStats / statDistance equal the original calibration/stats.mjs code', () => {
  assert.deepEqual(MS.QUANTILES, R.QUANTILES);
  assert.deepEqual(MS.LUMA_BINS, R.LUMA_BINS);
  assert.deepEqual(MS.HUE_BANDS, R.HUE_BANDS);
  const a = synthPool(20000, 1), b = synthPool(15000, 2);
  const sa = refPoolStats(a), sb = refPoolStats(b);
  assert.deepEqual(MS.poolStats(a), sa);
  assert.deepEqual(CS.poolStats(a), sa);
  assert.equal(MS.statDistance(MS.poolStats(a), MS.poolStats(b)), refStatDistance(sa, sb));
  assert.equal(CS.statDistance(sa, sb, { bw: true }), refStatDistance(sa, sb, { bw: true }));
  // matchStats carries the same q/cast/chroma/band + extras
  const m = MS.matchStats(a);
  assert.deepEqual({ q: m.q, cast: m.cast, chroma: m.chroma, band: m.band }, { q: sa.q, cast: sa.cast, chroma: sa.chroma, band: sa.band });
  assert.equal(m.binFrac.length, 7);
  assert.ok(Math.abs(m.binFrac.reduce((s, v) => s + v, 0) - 1) < 1e-9);
});

test('stats port: loadPool (Node) == poolFromU8 (browser) on the baseline pool', () => {
  assert.deepEqual(CS.loadPool(POOL, 3000), MS.poolFromU8(baseU8, 3000));
  assert.deepEqual(CS.loadPool(POOL), MS.poolFromU8(baseU8));
  assert.equal(CS.loadPool('/nonexistent/pool.bin'), null);
});

test('fit: recovers stats of a synthetic Portra 400 target (distance drops > 80 %)', () => {
  const s = MS.poolFromU8(baseU8, 9000, 99); // a different subsample than the fitter uses
  const target = MS.matchStats(renderPool(s.map(srgbToLinear), getFilm('kodak-portra-400').params));
  const r = fitLook(baseU8, target);
  assert.ok(r.distance.fitted < 0.2 * r.distance.identity, `match distance ${r.distance.identity} → ${r.distance.fitted}`);
  assert.ok(r.raw.fitted < 0.2 * r.raw.identity, `stat distance ${r.raw.identity} → ${r.raw.fitted}`);
  assert.equal(r.params.lumaLock, true);
  for (const q of [0, 6, 12]) assert.ok(Math.abs(r.fittedStats.q[q] - target.q[q]) < 0.03, `quantile ${q}`);
});

test('fit: deterministic', () => {
  const s = MS.poolFromU8(baseU8, 4000, 5);
  const target = MS.matchStats(renderPool(s.map(srgbToLinear), getFilm('kodak-gold-200').params));
  const o = { steps: [0.25, 0.1], sweeps: 1 };
  const a = fitLook(baseU8, target, o), b = fitLook(baseU8, target, o);
  assert.deepEqual(a.params, b.params);
  assert.equal(a.distance.fitted, b.distance.fitted);
  assert.equal(a.evals, b.evals);
});

test('fit: abort via shouldStop throws AbortError; deadline returns best-so-far', () => {
  const target = MS.matchStats(MS.poolFromU8(baseU8, 3000, 3));
  let n = 0;
  assert.throws(() => fitLook(baseU8, target, { shouldStop: () => ++n > 25 }), (e) => e instanceof AbortError && e.name === 'AbortError');
  assert.ok(n <= 27);
  let t = 0;
  const r = fitLook(baseU8, target, { deadline: 50, now: () => (t += 1) }); // fake clock: 1 ms per call
  assert.equal(r.timedOut, true);
  assert.ok(r.evals < 120);
});

test('analyse: complete film param set, effects shape, progress', () => {
  const w = 240, h = 180;
  // warm, lifted, low-contrast scene
  const data = makeImage(w, h, (x, y) => {
    const v = 0.25 + 0.6 * (x / w), t = y / h;
    return [Math.min(1, v * 1.08 + 0.03), v * (0.92 + 0.1 * t), v * 0.8 + 0.05 * t];
  });
  const prog = [];
  const r = analyse(baseU8, { small: { w, h, data }, rect: MS.trimBorderRect(data, w, h), grain: { w, h, data } },
    { steps: [0.25], sweeps: 1, onProgress: (p) => prog.push(p) });
  assert.ok(prog.length > 2 && prog.at(-1) === 1 && prog.every((p, i) => i === 0 || p >= prog[i - 1]));
  const f = r.film;
  // every colour key explicit (the UI merges `film` shallowly over the base stock's params)
  for (const k of ['type', 'exposure', 'temp', 'tint', 'matrix', 'contrast', 'shadows', 'highlights', 'rolloff', 'fade', 'whitePoint',
    'lift', 'gamma', 'gain', 'sat', 'vibrance', 'satShadows', 'satHighlights', 'hsl', 'splitShadow', 'splitHighlight',
    'filmic', 'curve', 'curveR', 'curveG', 'curveB', 'density', 'densityHue', 'chromaCurve', 'lumaLock', 'grain']) assert.ok(k in f, k);
  assert.equal(f.lumaLock, true);
  assert.equal(f.filmic, null); assert.equal(f.splitShadow, null); assert.equal(f.matrix, null);
  assert.equal(Object.keys(f.hsl).length, 8);
  for (const s of FIT_SPEC) assert.equal(typeof getPath(f, s.path), 'number', s.path);
  // merged over Portra 400 it renders exactly like on its own
  const portra = getFilm('kodak-portra-400').params;
  const a = makeFilm({ ...portra, ...f }), b = makeFilm(f), oa = [0, 0, 0], ob = [0, 0, 0];
  const rr = rng(4);
  for (let i = 0; i < 200; i++) {
    const c = [rr(), rr(), rr()];
    a(c[0], c[1], c[2], oa); b(c[0], c[1], c[2], ob);
    assert.deepEqual(oa, ob);
  }
  assert.deepEqual(Object.keys(r.effects).sort(), ['grain', 'leak', 'leakStyle']);
  assert.deepEqual(Object.keys(r.grainParams).sort(), ['amount', 'color', 'size']);
  assert.deepEqual(r.grainParams, f.grain);
  assert.ok(r.stats.distance.fitted < r.stats.distance.identity);
  assert.ok(JSON.stringify(r).length < 20000); // storable in localStorage
});

test('grain: estimator recovers renderer grain level; mono vs colour; clean image ≈ 0', () => {
  const w = 512, h = 512;
  for (const level of [0.3, 0.6, 1.2]) {
    const est = MS.grainEstimate(grainyImage(w, h, level, 0), w, h);
    const p = MS.grainToParams(est);
    assert.ok(est.confident);
    assert.ok(Math.abs(p.level - level) < 0.3 * level, `level ${level} → ${p.level}`);
    assert.equal(p.color, 0);
    assert.equal(p.amount, Math.min(1, p.level));
    assert.equal(p.slider, p.level > 1 ? p.level : 1);
  }
  const col = MS.grainToParams(MS.grainEstimate(grainyImage(w, h, 0.6, 0.6), w, h));
  assert.ok(col.color >= 0.3, `colour grain → ${col.color}`);
  const clean = MS.grainToParams(MS.grainEstimate(grainyImage(w, h, 0, 0), w, h));
  assert.ok(clean.level < 0.05 && clean.amount === 0, `clean → ${clean.level}`);
});

test('leaks: prism (warm one edge, mint opposite) vs none', () => {
  const w = 400, h = 300;
  const scene = (x, y) => { const v = 0.45 + 0.2 * Math.sin(x / 70) * Math.cos(y / 50); return [v * 1.05, v, v * 0.9]; };
  const screen = (c, l) => c.map((v, k) => 1 - (1 - v) * (1 - l[k]));
  const prism = makeImage(w, h, (x, y) => {
    const u = x / w, gl = Math.exp(-((u / 0.12) ** 2)), gr = Math.exp(-(((1 - u) / 0.12) ** 2));
    return screen(scene(x, y), [0.55 * gl, 0.25 * gl + 0.3 * gr, 0.15 * gl + 0.25 * gr]);
  });
  const L = MS.edgeLeaks(prism, w, h);
  assert.equal(L.leakStyle, 'prism');
  assert.equal(L.warmSide, 'left');
  assert.ok(L.leak > 0.3 && L.leak <= 1);
  const none = MS.edgeLeaks(makeImage(w, h, scene), w, h);
  assert.equal(none.leak, 0);
});

test('trimBorderRect strips scan borders; samplePixels is deterministic', () => {
  const w = 300, h = 200;
  const d = makeImage(w, h, (x, y) => (x < 12 || x >= w - 9 || y < 7 || y >= h - 5 ? [0.01, 0.01, 0.01] : [0.5, 0.4, 0.3]));
  const r = MS.trimBorderRect(d, w, h);
  assert.ok(r.trimmed);
  assert.ok(r.x >= 12 && r.y >= 7 && r.x + r.w <= w - 9 && r.y + r.h <= h - 5);
  const px = MS.samplePixels(d, w, h, r, 5000);
  assert.equal(px.length, 15000);
  for (let i = 0; i < px.length; i += 3) assert.ok(Math.abs(px[i] - 0.5) < 0.01);
  assert.deepEqual(px, MS.samplePixels(d, w, h, r, 5000));
  const plain = MS.trimBorderRect(makeImage(50, 40, () => [0.5, 0.5, 0.5]), 50, 40);
  assert.deepEqual(plain, { x: 0, y: 0, w: 50, h: 40, trimmed: false });
});
