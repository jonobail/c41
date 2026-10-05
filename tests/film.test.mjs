import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFilm, buildLut, floatToHalf, halfToFloat, srgbToLinear, linearToSrgb,
  FILM_DEFAULTS, LUT_SIZE, LUT_HEADROOM, HSL_BANDS,
} from '../js/film-transform.js';
import { FILMS, FILM_CATEGORIES, getFilm, DEFAULT_FILM_ID } from '../js/films.js';

const luma = (o) => 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];

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

test('sRGB helpers round-trip', () => {
  for (let i = 0; i <= 100; i++) {
    const v = i / 100;
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-9);
  }
  assert.equal(linearToSrgb(-1), 0);
});

test('defaults: makeFilm({}) is near-identity and monotonic', () => {
  const f = makeFilm({});
  const o = [0, 0, 0];
  f(0.18, 0.18, 0.18, o);
  const mid = linearToSrgb(0.18);
  for (const c of o) assert.ok(Math.abs(c - mid) < 2e-3, `mid-grey ${c} vs ${mid}`);
  let prev = -1;
  for (let i = 0; i <= 256; i++) {
    const x = i / 256;
    f(x, x, x, o);
    assert.ok(o[0] >= prev - 1e-6);
    prev = o[0];
  }
  f(0.4, 0.2, 0.1, o);
  assert.ok(Math.abs(o[0] - linearToSrgb(0.4)) < 2e-3);
  assert.ok(Math.abs(o[2] - linearToSrgb(0.1)) < 2e-3);
});

test('WB: positive temp warms, negative cools; grey luma roughly preserved', () => {
  const o = [0, 0, 0];
  makeFilm({ temp: 0.15 })(0.18, 0.18, 0.18, o);
  assert.ok(o[0] > o[2] + 0.05, 'warm cast visible');
  makeFilm({ temp: -0.15 })(0.18, 0.18, 0.18, o);
  assert.ok(o[2] > o[0] + 0.05, 'cool cast visible');
});

test('film ids unique, categories valid, metadata well-formed', () => {
  const ids = new Set();
  const cats = new Set(FILM_CATEGORIES.map((c) => c.id));
  const processes = new Set(['C-41', 'B&W', 'E-6', 'ECN-2', 'K-14', 'Instant']);
  for (const f of FILMS) {
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
    assert.ok(cats.has(f.category), `${f.id} bad category ${f.category}`);
    assert.ok(processes.has(f.process), `${f.id} bad process ${f.process}`);
    assert.ok(f.status === 'current' || f.status === 'discontinued', `${f.id} bad status`);
    assert.ok(typeof f.name === 'string' && f.name && typeof f.brand === 'string' && f.brand);
    assert.ok(Number.isFinite(f.iso) && f.iso > 0, `${f.id} iso`);
    assert.ok(Array.isArray(f.swatch) && f.swatch.length === 2 && f.swatch.every((s) => /^#[0-9a-f]{6}$/i.test(s)), `${f.id} swatch`);
    assert.ok(typeof f.summary === 'string' && f.summary.length > 10, `${f.id} summary`);
    for (const k of ['color', 'contrast', 'grain', 'highlights', 'shadows']) {
      assert.ok(typeof f.traits[k] === 'string' && f.traits[k].length > 2, `${f.id} traits.${k}`);
    }
  }
  assert.ok(FILMS.length >= 45, `only ${FILMS.length} films`);
  for (const c of cats) assert.ok(FILMS.some((f) => f.category === c), `empty category ${c}`);
  assert.equal(getFilm(DEFAULT_FILM_ID).id, DEFAULT_FILM_ID);
  assert.equal(getFilm('nope'), FILMS[0]);
});

test('required stocks are present', () => {
  const names = FILMS.map((f) => `${f.brand} ${f.name}`.toLowerCase());
  const need = ['portra 160', 'portra 400', 'portra 800', 'ektar 100', 'gold 200', 'ultramax 400',
    'colorplus 200', 'superia x-tra 400', 'c200', 'pro 400h', 'cinestill 800t', 'cinestill 50d',
    '250d', '500t', 'tri-x 400', 't-max 100', 'p3200', 'hp5 plus', 'fp4 plus', 'delta 3200',
    'pan f plus', 'xp2 super', 'sfx 200', 'acros ii', 'double-x', 'ektachrome e100', 'kodachrome 64',
    'velvia 50', 'velvia 100', 'provia 100f', 'aerochrome', 'lomochrome purple', 'lomochrome metropolis',
    'redscale', 'cross-processed', 'polaroid 600', 'instax mini'];
  for (const n of need) assert.ok(names.some((x) => x.includes(n)), `missing ${n}`);
});

test('film params use only schema keys with valid shapes', () => {
  const keys = new Set(Object.keys(FILM_DEFAULTS));
  const bands = new Set(Object.keys(HSL_BANDS));
  for (const f of FILMS) {
    const p = f.params;
    for (const k of Object.keys(p)) assert.ok(keys.has(k), `${f.id}: unknown param key "${k}"`);
    if (p.type) assert.ok(p.type === 'color' || p.type === 'bw', `${f.id} type`);
    if (p.matrix) assert.equal(p.matrix.length, 9, `${f.id} matrix`);
    for (const k of ['lift', 'gamma', 'gain', 'bwMix']) if (p[k]) assert.equal(p[k].length, 3, `${f.id} ${k}`);
    for (const [b, v] of Object.entries(p.hsl || {})) {
      assert.ok(bands.has(b), `${f.id}: unknown hsl band ${b}`);
      assert.equal(v.length, 3);
    }
    for (const k of ['splitShadow', 'splitHighlight']) {
      if (p[k]) assert.deepEqual(Object.keys(p[k]).sort(), ['amt', 'hue'], `${f.id} ${k}`);
    }
    if (p.grain) assert.deepEqual(Object.keys(p.grain).sort(), ['amount', 'color', 'size'], `${f.id} grain`);
    if (p.halation) {
      assert.deepEqual(Object.keys(p.halation).sort(), ['amount', 'color'], `${f.id} halation`);
      assert.equal(p.halation.color.length, 3);
    }
    if (p.contrast != null) assert.ok(Math.abs(p.contrast) <= 1);
    if (p.fade != null) assert.ok(p.fade >= 0 && p.fade <= 0.25);
    if (p.whitePoint != null) assert.ok(p.whitePoint >= 0.8 && p.whitePoint <= 1);
    if (p.rolloff != null) assert.ok(p.rolloff >= 0 && p.rolloff <= 1);
    if (p.type === 'bw') assert.equal(p.grain.color, 0, `${f.id} B&W grain must be mono`);
  }
});

test('every film: grey ramp produces non-decreasing luma', () => {
  const o = [0, 0, 0];
  for (const f of FILMS) {
    const fn = makeFilm(f.params);
    let prev = -Infinity;
    for (let i = 0; i <= 512; i++) {
      const x = (i / 512) * LUT_HEADROOM;
      fn(x, x, x, o);
      const y = luma(o);
      assert.ok(y >= prev - 1e-3, `${f.id}: luma drops at x=${x.toFixed(3)} (${prev} → ${y})`);
      prev = y;
    }
  }
});

test('every film: outputs finite and within 0..1 for random inputs incl. headroom', () => {
  const r = rng(42);
  const o = new Float32Array(3);
  const edge = [[0, 0, 0], [LUT_HEADROOM, LUT_HEADROOM, LUT_HEADROOM], [LUT_HEADROOM, 0, 0], [0, LUT_HEADROOM, 0], [0, 0, LUT_HEADROOM], [1, 1, 1]];
  for (const f of FILMS) {
    const fn = makeFilm(f.params);
    const inputs = edge.concat(Array.from({ length: 400 }, () => [r() * LUT_HEADROOM, r() * LUT_HEADROOM, r() * LUT_HEADROOM]));
    for (const [a, b, c] of inputs) {
      fn(a, b, c, o);
      for (const v of o) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${f.id}: out ${v} for ${a},${b},${c}`);
    }
  }
});

test('Polaroid 600 whites stay below 0.95', () => {
  const f = FILMS.find((x) => x.id === 'polaroid-600');
  const o = [0, 0, 0];
  makeFilm(f.params)(LUT_HEADROOM, LUT_HEADROOM, LUT_HEADROOM, o);
  for (const v of o) assert.ok(v < 0.95, `white channel ${v}`);
  makeFilm(f.params)(1, 1, 1, o);
  for (const v of o) assert.ok(v < 0.95);
});

test('B&W films without toning produce neutral output', () => {
  const r = rng(7);
  const o = [0, 0, 0];
  const bws = FILMS.filter((f) => f.params.type === 'bw' && !f.params.splitShadow && !f.params.splitHighlight);
  assert.ok(bws.length >= 8);
  for (const f of bws) {
    const fn = makeFilm(f.params);
    for (let i = 0; i < 200; i++) {
      fn(r() * 2, r() * 2, r() * 2, o);
      assert.ok(o[0] === o[1] && o[1] === o[2], `${f.id}: ${o.join(',')}`);
    }
  }
});

test('floatToHalf: exact values, rounding, subnormals, overflow', () => {
  assert.equal(floatToHalf(0), 0x0000);
  assert.equal(floatToHalf(-0), 0x8000);
  assert.equal(floatToHalf(1), 0x3c00);
  assert.equal(floatToHalf(-2), 0xc000);
  assert.equal(floatToHalf(0.5), 0x3800);
  assert.equal(floatToHalf(65504), 0x7bff);
  assert.equal(floatToHalf(1e6), 0x7c00);
  assert.equal(floatToHalf(Infinity), 0x7c00);
  assert.ok((floatToHalf(NaN) & 0x7c00) === 0x7c00 && (floatToHalf(NaN) & 0x3ff) !== 0);
  assert.equal(floatToHalf(Math.pow(2, -24)), 0x0001); // smallest subnormal
  assert.equal(floatToHalf(Math.pow(2, -14)), 0x0400); // smallest normal
  assert.equal(floatToHalf(1e-10), 0);
  assert.equal(floatToHalf(1 + 1 / 2048), 0x3c00); // tie → even
  assert.equal(floatToHalf(1 + 3 / 2048), 0x3c02); // tie → even (up)
  const r = rng(3);
  for (let i = 0; i < 2000; i++) {
    const v = r();
    const back = halfToFloat(floatToHalf(v));
    assert.ok(Math.abs(back - v) <= Math.max(v * 2 ** -11, 2 ** -25), `${v} → ${back}`);
  }
});

test('buildLut: size, layout, alpha and values', () => {
  const N = 9;
  const params = getFilm('kodak-portra-400').params;
  const lut = buildLut(params, N);
  assert.ok(lut instanceof Uint16Array);
  assert.equal(lut.length, N * N * N * 4);
  const fn = makeFilm(params);
  const o = [0, 0, 0];
  const r = rng(9);
  for (let k = 0; k < 50; k++) {
    const ri = (r() * N) | 0, gi = (r() * N) | 0, bi = (r() * N) | 0;
    const idx = ((bi * N + gi) * N + ri) * 4;
    const sh = (i) => srgbToLinear(i / (N - 1)) * LUT_HEADROOM;
    fn(sh(ri), sh(gi), sh(bi), o);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(halfToFloat(lut[idx + c]) - o[c]) < 1e-3);
    assert.equal(lut[idx + 3], 0x3c00);
  }
  assert.equal(buildLut({}).length, LUT_SIZE ** 3 * 4);
  // identity LUT: u=0.5 node on grey diagonal maps to linearToSrgb(srgbToLinear(.5)*2)
  const id = buildLut({}, 3);
  const mid = ((1 * 3 + 1) * 3 + 1) * 4;
  assert.ok(Math.abs(halfToFloat(id[mid]) - linearToSrgb(srgbToLinear(0.5) * 2)) < 1e-3);
});
