import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFilm, buildLut, floatToHalf, halfToFloat, srgbToLinear, linearToSrgb,
  FILM_DEFAULTS, LUT_SIZE, LUT_HEADROOM, HSL_BANDS,
  FILMIC_DEFAULTS, monotoneCurve, makeFilmicCurve, getPath, setPath, paramVector, applyVector, specBounds,
  FIT_SPEC, FIT_SPEC_FILMIC, FIT_SPEC_BW, CURVE_X,
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
    // extended model keys
    for (const k of ['curve', 'curveR', 'curveG', 'curveB']) {
      if (p[k] != null) {
        assert.ok(Array.isArray(p[k]), `${f.id} ${k}`);
        for (const pt of p[k]) assert.ok(pt.length === 2 && pt.every((v) => v >= 0 && v <= 1), `${f.id} ${k} point`);
      }
    }
    if (p.filmic != null) {
      for (const k of Object.keys(p.filmic)) assert.ok(k in FILMIC_DEFAULTS, `${f.id} filmic.${k}`);
    }
    if (p.density != null) assert.ok(p.density >= 0 && p.density <= 1, `${f.id} density`);
    if (p.densityHue != null) for (const b of Object.keys(p.densityHue)) assert.ok(bands.has(b), `${f.id} densityHue.${b}`);
    if (p.chromaCurve != null) assert.equal(p.chromaCurve.length, 5, `${f.id} chromaCurve`);
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

// ───────────────────────────── extended model ─────────────────────────────
const enc = (x) => linearToSrgb(x);
const grey = (fn, x) => { const o = [0, 0, 0]; fn(x, x, x, o); return o; };
function assertGreyMonotone(fn, label, tol = 1e-3) {
  const o = [0, 0, 0];
  let prev = -Infinity;
  for (let i = 0; i <= 400; i++) {
    const x = (i / 400) * LUT_HEADROOM;
    fn(x, x, x, o);
    const y = luma(o);
    assert.ok(y >= prev - tol, `${label}: luma drops at x=${x.toFixed(3)} (${prev} → ${y})`);
    prev = y;
  }
}

test('new schema keys at their defaults are a no-op', () => {
  const a = makeFilm({}), b = makeFilm({
    filmic: null, curve: null, curveR: null, curveG: null, curveB: null, density: 0, densityHue: null,
    chromaCurve: [1, 1, 1, 1, 1], curveR2: 1,
  });
  const c = makeFilm({ curve: [[0, 0], [0.5, 0.5], [1, 1]], curveG: [] });
  const r = rng(11), oa = [0, 0, 0], ob = [0, 0, 0], oc = [0, 0, 0];
  for (let i = 0; i < 300; i++) {
    const x = [r() * 2, r() * 2, r() * 2];
    a(...x, oa); b(...x, ob); c(...x, oc);
    assert.deepEqual(oa, ob);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(oa[k] - oc[k]) < 1e-6);
  }
});

test('monotoneCurve: interpolates points, monotone, sanitises bad input', () => {
  const pts = [[0, 0.05], [0.25, 0.18], [0.5, 0.52], [0.75, 0.8], [1, 0.97]];
  const f = monotoneCurve(pts);
  for (const [x, y] of pts) assert.ok(Math.abs(f(x) - y) < 1e-9);
  const r = rng(5);
  for (let t = 0; t < 200; t++) {
    const n = 1 + ((r() * 8) | 0);
    const raw = Array.from({ length: n }, () => [r() * 1.4 - 0.2, r() * 1.4 - 0.2]);
    if (t % 7 === 0) raw.push('junk', [NaN, 1], [0.5]);
    const g = monotoneCurve(raw);
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const y = g(i / 200);
      assert.ok(Number.isFinite(y) && y >= 0 && y <= 1);
      assert.ok(y >= prev - 1e-12, `curve ${JSON.stringify(raw)} not monotone`);
      prev = y;
    }
  }
  // decreasing points get pooled, implicit endpoints
  const d = monotoneCurve([[0.3, 0.6], [0.6, 0.4]]);
  assert.equal(d(0), 0); assert.equal(d(1), 1);
  assert.ok(Math.abs(d(0.3) - 0.5) < 1e-9 && Math.abs(d(0.6) - 0.5) < 1e-9);
  assert.equal(monotoneCurve(null)(0.3), 0.3);
});

test('curve: master curve shapes tone after contrast; applies to B&W', () => {
  const mid = enc(0.18);
  const s = makeFilm({ curve: [[0, 0], [0.25, 0.15], [0.75, 0.88], [1, 1]] });
  assert.ok(grey(s, srgbToLinear(0.25))[0] < 0.16 && grey(s, srgbToLinear(0.25))[0] > 0.14);
  assert.ok(Math.abs(grey(s, srgbToLinear(0.75))[0] - 0.88) < 2e-3);
  const lifted = makeFilm({ curve: [[0, 0.1], [1, 0.9]] });
  assert.ok(Math.abs(grey(lifted, 0)[0] - 0.1) < 1e-4 && Math.abs(grey(lifted, 1)[0] - 0.9) < 1e-4);
  // applied after contrast: identity curve keeps contrast result
  const c1 = makeFilm({ contrast: 0.5 }), c2 = makeFilm({ contrast: 0.5, curve: [[0, 0], [1, 1]] });
  assert.deepEqual(grey(c1, 0.3), grey(c2, 0.3));
  // B&W stocks differ by curve, stay neutral
  const bwA = makeFilm({ type: 'bw', curve: [[0.5, 0.4]] }), bwB = makeFilm({ type: 'bw', curve: [[0.5, 0.6]] });
  const oa = grey(bwA, 0.18), ob = grey(bwB, 0.18);
  assert.ok(ob[0] - oa[0] > 0.15);
  assert.ok(oa[0] === oa[1] && oa[1] === oa[2]);
  assert.ok(mid > 0.4);
});

test('curveR/G/B: per-channel crossovers, ignored for B&W', () => {
  const f = makeFilm({ curveR: [[0.5, 0.6]], curveB: [[0.25, 0.2], [0.75, 0.7]] });
  const o = grey(f, srgbToLinear(0.5));
  assert.ok(Math.abs(o[0] - 0.6) < 2e-3 && Math.abs(o[1] - 0.5) < 2e-3 && o[2] < 0.5);
  const o2 = grey(f, srgbToLinear(0.75));
  assert.ok(Math.abs(o2[2] - 0.7) < 2e-3 && Math.abs(o2[1] - 0.75) < 2e-3);
  const bw = makeFilm({ type: 'bw', curveR: [[0.5, 0.9]], curveG: [[0.5, 0.1]] });
  const r = rng(2), ob = [0, 0, 0];
  for (let i = 0; i < 100; i++) {
    bw(r() * 2, r() * 2, r() * 2, ob);
    assert.ok(ob[0] === ob[1] && ob[1] === ob[2]);
  }
  assert.ok(Math.abs(grey(bw, srgbToLinear(0.5))[0] - 0.5) < 2e-3);
});

test('filmic: mid grey pinned, compressed highlights, toe-lifted blacks, slope = contrast', () => {
  const mid = enc(0.18);
  for (const fp of [{}, { slope: 1.6 }, { slope: 0.6, toe: 1, shoulder: 1, blackDensity: 1.2 }]) {
    const f = makeFilm({ filmic: fp });
    assert.ok(Math.abs(grey(f, 0.18)[0] - mid) < 2e-3, `mid ${JSON.stringify(fp)}`);
    assertGreyMonotone(f, `filmic ${JSON.stringify(fp)}`, 1e-6);
  }
  const f = makeFilm({ filmic: {} });
  // highlights: compressed, still separating above 1.0 (latitude), never above 1
  const h1 = grey(f, 1)[0], h2 = grey(f, 2)[0];
  assert.ok(h1 < 0.95 && h2 > h1 + 0.03 && h2 < 1);
  // blacks: lifted to 10^-(Db - Dw)
  const lin = makeFilmicCurve({ blackDensity: 2 })(0);
  assert.ok(lin > 0.005 && lin < 0.02);
  assert.ok(grey(makeFilm({ filmic: { blackDensity: 1.5 } }), 0)[0] > grey(makeFilm({ filmic: { blackDensity: 3 } }), 0)[0] + 0.05);
  // slope raises midtone contrast
  const lo = makeFilm({ filmic: { slope: 0.7 } }), hi = makeFilm({ filmic: { slope: 1.5 } });
  const span = (fn) => grey(fn, 0.36)[0] - grey(fn, 0.09)[0];
  assert.ok(span(hi) > span(lo) + 0.08);
  // replaces contrast + rolloff
  assert.deepEqual(grey(makeFilm({ filmic: {}, contrast: 0.8, rolloff: 1 }), 0.7), grey(f, 0.7));
  // B&W stocks diverge by characteristic curve, stay neutral
  const b1 = makeFilm({ type: 'bw', filmic: { slope: 0.8, blackDensity: 1.8 } });
  const b2 = makeFilm({ type: 'bw', filmic: { slope: 1.5, toe: 0.1 } });
  const o1 = grey(b1, 0.03), o2 = grey(b2, 0.03);
  assert.ok(o1[0] - o2[0] > 0.08 && o1[0] === o1[2] && o2[1] === o2[2]);
});

test('density: darkens saturated colours progressively, keeps greys and hue', () => {
  const base = makeFilm({}), d = makeFilm({ density: 1 });
  const ob = [0, 0, 0], od = [0, 0, 0];
  assert.deepEqual(grey(d, 0.3), grey(base, 0.3));
  const ratio = (c) => { base(...c, ob); d(...c, od); return luma(od) / luma(ob); };
  const mild = ratio([0.25, 0.18, 0.15]), strong = ratio([0.5, 0.06, 0.03]), pure = ratio([1, 0, 0]);
  assert.ok(mild < 1 && mild > 0.9, `mild ${mild}`);
  assert.ok(strong < mild && pure < strong && pure < 0.65, `${strong} ${pure}`);
  base(0.5, 0.2, 0.05, ob); d(0.5, 0.2, 0.05, od);
  assert.ok(Math.abs(ob[1] / ob[0] - od[1] / od[0]) < 1e-6, 'hue/sat ratio kept');
  // hue weighting
  const dh = makeFilm({ density: 1, densityHue: { red: 0, orange: 0, magenta: 0, yellow: 1, blue: 2 } });
  const o = [0, 0, 0];
  dh(1, 0, 0, o); assert.ok(o[0] > 0.999);
  dh(0, 0, 0.5, o); d(0, 0, 0.5, od); assert.ok(o[2] < od[2]);
  // B&W ignores density
  const bw = makeFilm({ type: 'bw', density: 1 }), bw0 = makeFilm({ type: 'bw' });
  bw(1, 0, 0, o); bw0(1, 0, 0, ob); assert.deepEqual(o, ob);
});

test('chromaCurve: saturation as a function of luma', () => {
  const f = makeFilm({ chromaCurve: [0, 0, 1, 1, 1] });
  const o = [0, 0, 0];
  f(0.02, 0.005, 0.005, o); // dark red → desaturated
  assert.ok(Math.abs(o[0] - o[1]) < 1e-6);
  f(0.5, 0.2, 0.2, o);
  const ref = [0, 0, 0]; makeFilm({})(0.5, 0.2, 0.2, ref);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(o[k] - ref[k]) < 1e-6);
  const boost = makeFilm({ chromaCurve: [1, 1, 1.6, 1, 1] });
  boost(0.3, 0.15, 0.1, o); makeFilm({})(0.3, 0.15, 0.1, ref);
  assert.ok(o[0] - o[2] > (ref[0] - ref[2]) * 1.2);
});

test('hsl safety: extreme band values stay finite, in range, grey-monotone', () => {
  const big = {};
  for (const b of Object.keys(HSL_BANDS)) big[b] = [500, 50, 9];
  const f = makeFilm({ hsl: big, sat: 2 });
  const r = rng(13), o = [0, 0, 0];
  for (let i = 0; i < 500; i++) {
    f(r() * 2, r() * 2, r() * 2, o);
    for (const v of o) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
  }
  assertGreyMonotone(f, 'hsl extreme');
});

test('getPath / setPath create sensible containers', () => {
  const p = {};
  setPath(p, 'hsl.green.1', 1.3);
  setPath(p, 'lift.2', 0.02);
  setPath(p, 'curve.3.1', 0.4);
  setPath(p, 'filmic.slope', 1.2);
  setPath(p, 'chromaCurve.2', 0.8);
  assert.deepEqual(p.hsl.green, [0, 1.3, 0]);
  assert.deepEqual(p.lift, [0, 0, 0.02]);
  assert.deepEqual(p.curve[3], [0, 0.4]);
  assert.deepEqual(p.filmic, { ...FILMIC_DEFAULTS, slope: 1.2 });
  assert.deepEqual(p.chromaCurve, [1, 1, 0.8, 1, 1]);
  assert.equal(getPath(p, 'hsl.green.1'), 1.3);
  assert.equal(getPath(p, 'nope.x.1'), undefined);
  assert.notEqual(FILM_DEFAULTS.lift[2], 0.02);
});

test('paramVector / applyVector round-trip, bounds, no mutation, valid schema', () => {
  const keys = new Set(Object.keys(FILM_DEFAULTS));
  for (const spec of [FIT_SPEC, FIT_SPEC.concat(FIT_SPEC_FILMIC), FIT_SPEC_BW]) {
    const paths = spec.map((s) => s.path);
    assert.equal(new Set(paths).size, paths.length, 'unique paths');
    const { lo, hi } = specBounds(spec);
    for (let i = 0; i < spec.length; i++) {
      assert.ok(lo[i] < hi[i] && spec[i].def >= lo[i] && spec[i].def <= hi[i], spec[i].path);
    }
    // defaults vector from {} is the def column and is ≈ identity
    const v0 = paramVector(spec, {});
    for (let i = 0; i < spec.length; i++) assert.equal(v0[i], spec[i].def);
    const base = getFilm('kodak-portra-400').params;
    const snapshot = JSON.stringify(base);
    const r = rng(17);
    for (let t = 0; t < 20; t++) {
      const v = Float64Array.from(spec, (s) => s.min + r() * (s.max - s.min));
      const p = applyVector(spec, v, base);
      assert.equal(JSON.stringify(base), snapshot, 'base not mutated');
      const back = paramVector(spec, p);
      for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-12, spec[i].path);
      for (const k of Object.keys(p)) assert.ok(keys.has(k), `unknown key ${k}`);
      for (const b of Object.keys(p.hsl || {})) assert.equal(p.hsl[b].length, 3);
      for (const k of ['curve', 'curveR', 'curveG', 'curveB']) {
        for (const pt of p[k] || []) assert.ok(pt.length === 2 && pt.every(Number.isFinite), k);
      }
    }
    // clamping
    const out = applyVector(spec, Float64Array.from(spec, () => 1e9), {});
    const vb = paramVector(spec, out);
    for (let i = 0; i < spec.length; i++) assert.equal(vb[i], spec[i].max);
  }
  // curve x positions are fixed by the spec
  const p = applyVector(FIT_SPEC, paramVector(FIT_SPEC, {}), {});
  assert.deepEqual(p.curve.map((q) => q[0]), CURVE_X);
  // defaults applied → still ≈ identity
  const f = makeFilm(p), o = [0, 0, 0];
  f(0.18, 0.18, 0.18, o);
  for (const c of o) assert.ok(Math.abs(c - enc(0.18)) < 2e-3);
});

test('lumaLock: off = legacy; on = neutral axis untouched by hsl/density, luma kept', () => {
  const casts = { lift: [0.06, -0.02, 0.1], gamma: [0.8, 1.2, 0.9], curveR: [[0.5, 0.6]], sat: 1.6 };
  const big = {};
  for (const b of Object.keys(HSL_BANDS)) big[b] = [25, b === 'blue' ? 1.8 : 0.4, 0.1];
  const pre = makeFilm({ ...casts, lumaLock: true });
  const locked = makeFilm({ ...casts, hsl: big, density: 1, lumaLock: true });
  const o1 = [0, 0, 0], o2 = [0, 0, 0];
  for (let i = 0; i <= 200; i++) {
    const x = (i / 200) * LUT_HEADROOM;
    pre(x, x, x, o1); locked(x, x, x, o2);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(o1[k] - o2[k]) < 2e-3, `x=${x} ch${k} ${o1[k]} vs ${o2[k]}`);
  }
  // hsl sat edits preserve luma under lock (no clipping involved)
  const a = makeFilm({ lumaLock: true, hsl: { green: [0, 0.4, 0] } }), b0 = makeFilm({ lumaLock: true });
  a(0.1, 0.3, 0.1, o1); b0(0.1, 0.3, 0.1, o2);
  assert.ok(Math.abs(luma(o1) - luma(o2)) < 1e-3 && Math.abs(o1[1] - o1[0]) < Math.abs(o2[1] - o2[0]) * 0.8);
  // explicit lum column still scales luma
  const l = makeFilm({ lumaLock: true, hsl: { green: [0, 1, -0.2] } });
  l(0.1, 0.3, 0.1, o1);
  assert.ok(luma(o1) < luma(o2) - 0.02);
  // without lock the legacy HSV behaviour is unchanged (desaturating at fixed V brightens)
  const legacy = makeFilm({ hsl: { green: [0, 0.4, 0] } });
  legacy(0.1, 0.3, 0.1, o1);
  assert.ok(luma(o1) > luma(o2) + 0.02);
  // B&W ignores lock
  const bw = makeFilm({ type: 'bw', lumaLock: true }), bw0 = makeFilm({ type: 'bw' });
  bw(0.3, 0.1, 0.5, o1); bw0(0.3, 0.1, 0.5, o2); assert.deepEqual(o1, o2);
});

test('fuzz over FIT_SPEC bounds: finite, in range, grey-monotone, B&W neutral', () => {
  const r = rng(1234);
  const specs = [
    ['colour', FIT_SPEC, { lumaLock: true }],
    ['colour+filmic', FIT_SPEC.concat(FIT_SPEC_FILMIC), { lumaLock: true }],
    ['bw', FIT_SPEC_BW, { type: 'bw' }],
    ['bw+filmic', FIT_SPEC_BW.concat(FIT_SPEC_FILMIC), { type: 'bw' }],
  ];
  const o = new Float32Array(3);
  for (const [name, spec, base] of specs) {
    for (let t = 0; t < 60; t++) {
      // mix of uniform draws and extreme corners
      const v = Float64Array.from(spec, (s) => {
        const u = r();
        return t % 3 === 0 ? (u < 0.5 ? s.min : s.max) : s.min + u * (s.max - s.min);
      });
      const p = applyVector(spec, v, base);
      if (t % 4 === 1) p.densityHue = { red: r() * 2, green: r() * 2, blue: r() * 2 };
      const fn = makeFilm(p);
      assertGreyMonotone(fn, `${name} #${t}`);
      for (let i = 0; i < 300; i++) {
        const a = r() * LUT_HEADROOM, b = r() * LUT_HEADROOM, c = r() * LUT_HEADROOM;
        fn(a, b, c, o);
        for (const x of o) assert.ok(Number.isFinite(x) && x >= 0 && x <= 1, `${name} #${t}: ${x}`);
        if (p.type === 'bw') assert.ok(o[0] === o[1] && o[1] === o[2]);
      }
    }
  }
});

test('fuzz without lumaLock: still finite and in range', () => {
  const r = rng(77);
  const o = new Float32Array(3);
  for (let t = 0; t < 40; t++) {
    const spec = FIT_SPEC.concat(FIT_SPEC_FILMIC);
    const p = applyVector(spec, Float64Array.from(spec, (s) => s.min + r() * (s.max - s.min)), {});
    const fn = makeFilm(p);
    for (let i = 0; i < 300; i++) {
      fn(r() * 3, r() * 3, r() * 3, o);
      for (const x of o) assert.ok(Number.isFinite(x) && x >= 0 && x <= 1);
    }
  }
  // garbage params never produce NaN
  const g = makeFilm({ contrast: NaN, curve: [[NaN, 2]], filmic: { slope: NaN, toe: -1 }, density: 'x', chromaCurve: [NaN, 1] });
  g(0.5, 0.2, NaN, o);
  for (const x of o) assert.ok(Number.isFinite(x) && x >= 0 && x <= 1);
});
