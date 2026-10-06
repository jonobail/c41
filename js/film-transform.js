// C41 — pure film colour transform (no DOM; runs in Node and the browser).
// See docs/ARCHITECTURE.md §1 for the contract.

export const LUT_SIZE = 33;
export const LUT_HEADROOM = 2.0; // LUT input u∈[0,1] encodes linear = srgbToLinear(u) * 2.0

export const FILM_DEFAULTS = Object.freeze({
  type: 'color',
  exposure: 0,
  temp: 0, tint: 0,
  matrix: null,
  bwMix: [0.30, 0.59, 0.11],
  contrast: 0,
  shadows: 0, highlights: 0,
  rolloff: 0,
  fade: 0,
  whitePoint: 1,
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  sat: 1, vibrance: 0, satShadows: 1, satHighlights: 1,
  hsl: {},
  splitShadow: null,
  splitHighlight: null,
  grain: { amount: 0.3, size: 1, color: 0.3 },
  halation: { amount: 0.05, color: [1, 0.35, 0.15] },
  bloom: 0,
  // --- extended tone / colour model (all optional; null / 0 = no-op) ---
  filmic: null,      // { slope, toe, shoulder, blackDensity } characteristic curve (replaces rolloff + contrast)
  curve: null,       // master tone curve [[x,y],...] in encoded 0..1 (monotone cubic)
  curveR: null, curveG: null, curveB: null, // per-channel curves (colour only; ignored for B&W)
  density: 0,        // 0..1 subtractive dye density: darkens saturated colours
  densityHue: null,  // { band: multiplier } hue weighting of `density` (8 HSL bands, default 1)
  chromaCurve: null, // [5] saturation multipliers at luma 0, .25, .5, .75, 1
  lumaLock: false,   // true: sat / hsl stages preserve Rec.709 luma (hsl lum = luma scale) and
                     // compress out-of-gamut chroma instead of clipping channels. Recommended for fits.
  hueKeep: null,     // { band: [hueShiftDeg, chromaMul] } keyed by the SCENE's (input) hue: rotates /
                     // scales a pixel's chroma relative to the film's neutral at constant luma, after
                     // the casts. Lets a look keep skies blue / foliage green under a strong cast.
});

export const FILMIC_DEFAULTS = Object.freeze({ slope: 1, toe: 0.3, shoulder: 0.25, blackDensity: 2.5 });

export const HSL_BANDS = Object.freeze({
  red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 270, magenta: 300,
});

// Rec.709 luma weights
const LR = 0.2126, LG = 0.7152, LB = 0.0722;

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  if (!(v > 0)) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// ---------------------------------------------------------------------------
// Half-float conversion (IEEE 754 binary16, round-to-nearest-even)
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

export function floatToHalf(f) {
  _f32[0] = f;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;

  if (exp === 0xff) { // Inf / NaN
    return sign | 0x7c00 | (mant ? 0x200 : 0);
  }
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (e <= 0) { // subnormal half or zero
    if (e < -10) return sign; // too small → ±0
    mant |= 0x800000; // implicit leading 1
    const shift = 14 - e; // 14..24
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (h & 1))) h++;
    return sign | h; // carry into exponent field is correct
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++; // may carry to Inf: correct
  return sign | h;
}

export function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * Math.pow(2, -24);
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

// ---------------------------------------------------------------------------
function hsvToRgb(h, s, v, out) {
  h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i) {
    case 0: out[0] = v; out[1] = t; out[2] = p; break;
    case 1: out[0] = q; out[1] = v; out[2] = p; break;
    case 2: out[0] = p; out[1] = v; out[2] = t; break;
    case 3: out[0] = p; out[1] = q; out[2] = v; break;
    case 4: out[0] = t; out[1] = p; out[2] = v; break;
    default: out[0] = v; out[1] = p; out[2] = q; break;
  }
  return out;
}

// Chroma-only part of a fully saturated hue (colour minus its luma).
function toneChroma(hue) {
  const c = hsvToRgb(hue, 1, 1, [0, 0, 0]);
  const y = LR * c[0] + LG * c[1] + LB * c[2];
  return [c[0] - y, c[1] - y, c[2] - y];
}

// Build 361-entry tables (1°) of [hueShift, satMul, lumAdd] by piecewise-linear circular interp.
function buildHslTables(hsl) {
  const names = Object.keys(HSL_BANDS);
  const pts = names.map((n) => {
    const v = hsl[n] || [0, 1, 0];
    return { h: HSL_BANDS[n], d: +v[0] || 0, s: v[1] == null ? 1 : +v[1], l: +v[2] || 0 };
  });
  const n = pts.length;
  const H = new Float32Array(361), S = new Float32Array(361), L = new Float32Array(361);
  for (let deg = 0; deg <= 360; deg++) {
    const hd = deg % 360;
    let a = pts[n - 1], b = pts[0], span = 360 - a.h + b.h, t = (hd - a.h + 360) % 360 / span;
    for (let i = 0; i < n; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n];
      const end = i === n - 1 ? p1.h + 360 : p1.h;
      if (hd >= p0.h && hd < end) { a = p0; b = p1; span = end - p0.h; t = (hd - p0.h) / span; break; }
    }
    H[deg] = a.d + (b.d - a.d) * t;
    S[deg] = a.s + (b.s - a.s) * t;
    L[deg] = a.l + (b.l - a.l) * t;
  }
  return { H, S, L };
}

function hasHsl(hsl) {
  if (!hsl) return false;
  for (const k of Object.keys(hsl)) {
    const v = hsl[k];
    if (v && ((+v[0] || 0) !== 0 || (v[1] != null && +v[1] !== 1) || (+v[2] || 0) !== 0)) return true;
  }
  return false;
}

const arr3 = (v, d) => (Array.isArray(v) && v.length === 3 ? v.map(Number) : d.slice());

// ---------------------------------------------------------------------------
// Monotone curves

/**
 * Normalise control points into a monotone non-decreasing set covering x∈[0,1].
 * Invalid entries are skipped; x,y clamped to 0..1; duplicate x averaged; implicit
 * (0,0) / (1,1) endpoints added when the points don't reach 0 / 1; y made monotone
 * by isotonic regression (pool-adjacent-violators, i.e. violators are averaged).
 * @returns {{xs:number[], ys:number[]}|null} null when the curve is identity / absent
 */
function normaliseCurve(points) {
  if (!Array.isArray(points)) return null;
  const pts = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    let x = +p[0], y = +p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    y = y < 0 ? 0 : y > 1 ? 1 : y;
    pts.push([x, y]);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a[0] - b[0]);
  const xs = [], ys = [], ws = [];
  for (const [x, y] of pts) {
    const k = xs.length - 1;
    if (k >= 0 && Math.abs(xs[k] - x) < 1e-6) { ys[k] = (ys[k] * ws[k] + y) / (ws[k] + 1); ws[k]++; }
    else { xs.push(x); ys.push(y); ws.push(1); }
  }
  if (xs[0] > 1e-6) { xs.unshift(0); ys.unshift(0); ws.unshift(1); }
  if (xs[xs.length - 1] < 1 - 1e-6) { xs.push(1); ys.push(1); ws.push(1); }
  // PAV isotonic regression on ys
  const bv = [], bw = [], bn = [];
  for (let i = 0; i < ys.length; i++) {
    bv.push(ys[i]); bw.push(ws[i]); bn.push(1);
    while (bv.length > 1 && bv[bv.length - 2] > bv[bv.length - 1]) {
      const v1 = bv.pop(), w1 = bw.pop(), n1 = bn.pop();
      const j = bv.length - 1;
      bv[j] = (bv[j] * bw[j] + v1 * w1) / (bw[j] + w1); bw[j] += w1; bn[j] += n1;
    }
  }
  let k = 0;
  for (let j = 0; j < bv.length; j++) for (let c = 0; c < bn[j]; c++) ys[k++] = bv[j];
  let ident = true;
  for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i] - ys[i]) > 1e-9) { ident = false; break; }
  return ident ? null : { xs, ys };
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolant through control points
 * [[x,y],...] in 0..1 (see normaliseCurve for sanitising rules).
 * Returns a function x→y on 0..1 (x clamped), non-decreasing, C1.
 */
export function monotoneCurve(points) {
  const c = normaliseCurve(points);
  if (!c) return (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const { xs, ys } = c;
  const n = xs.length;
  const d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (!(x > 0)) x = 0; else if (x > 1) x = 1;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const hgt = xs[i + 1] - xs[i], t = (x - xs[i]) / hgt, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hgt * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hgt * m[i + 1];
    return y < 0 ? 0 : y > 1 ? 1 : y;
  };
}

// ---------------------------------------------------------------------------
// Filmic characteristic curve (log exposure → print density → display)

const MID = 0.18, DMID = Math.log10(1 / MID);
function softplus(v, w) { return v > 0 ? v + w * Math.log1p(Math.exp(-v / w)) : w * Math.log1p(Math.exp(v / w)); }

/**
 * Build the filmic curve: linear scene value x ≥ 0 → linear display value 0..1.
 *   E    = log10(x / 0.18)                         (log exposure re mid grey)
 *   Dlin = log10(1/0.18) + off − slope·E            (straight-line portion, density units)
 *   D1   = softplus(Dlin, shoulder)                 (shoulder: density can't go below paper white)
 *   D    = Db − softplus(Db − D1, toe)              (toe: density saturates at blackDensity = Db)
 *   y    = 10^−(D − Dw), Dw = D at x→∞              (normalised so white → 1 asymptotically)
 * `off` is solved so x = 0.18 → y = 0.18 (mid grey pinned). Black (x = 0) → 10^−(Db − Dw).
 */
export function makeFilmicCurve(f) {
  const F = { ...FILMIC_DEFAULTS, ...(f || {}) };
  const slope = clampN(F.slope, 0.2, 4, 1);
  const ws = clampN(F.shoulder, 0.005, 3, FILMIC_DEFAULTS.shoulder);
  const wt = clampN(F.toe, 0.005, 3, FILMIC_DEFAULTS.toe);
  const Db = clampN(F.blackDensity, 0.5, 5, FILMIC_DEFAULTS.blackDensity);
  const Dw = Db - softplus(Db, wt);
  const dens = (E, off) => Db - softplus(Db - softplus(DMID + off - slope * E, ws), wt);
  let lo = -4, hi = 4; // D(0) increasing in off
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (dens(0, mid) - Dw < DMID) lo = mid; else hi = mid; }
  const off = (lo + hi) / 2;
  const black = Math.pow(10, -(Db - Dw));
  return (x) => {
    if (!(x > 1e-7)) return black;
    const y = Math.pow(10, -(dens(Math.log10(x / MID), off) - Dw));
    return y > 1 ? 1 : y;
  };
}

function clampN(v, lo, hi, d) {
  v = +v;
  if (!Number.isFinite(v)) v = d;
  return v < lo ? lo : v > hi ? hi : v;
}

function hueOf(r, g, b, mx, d) {
  let h;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}

// Per-channel tone table domain: x∈[0, TONE_XMAX] linear, sampled in sqrt(x) (fine near black).
const TONE_N = 4096, TONE_XMAX = 8, TONE_INV = 1 / TONE_XMAX;
const DENSITY_K = 0.45;
// neutral-axis tracing: NEUT_K ramp samples over linear 0..NEUT_XMAX, NEUT_N luma nodes
const NEUT_K = 8192, NEUT_XMAX = LUT_HEADROOM * 1.25, NEUT_N = 1024, NEUT_EPS = 5e-4;
const HSL_CFADE = 0.06; // lumaLock: relative chroma below which hsl band effects fade out

// ---------------------------------------------------------------------------
/**
 * Compile film params into a fast per-pixel closure.
 * @returns {(r:number,g:number,b:number,out:Float32Array|number[])=>typeof out}
 *   inputs are linear light (may exceed 1, up to LUT_HEADROOM); writes sRGB-encoded 0..1.
 */
export function makeFilm(params) {
  const p = { ...FILM_DEFAULTS, ...(params || {}) };
  const isBW = p.type === 'bw';

  // --- white balance gains (linear), normalised to unit luma
  const temp = +p.temp || 0, tint = +p.tint || 0;
  const KT = 1.0, KTINT = 0.5;
  let wr = Math.exp(KT * temp + 0.5 * KTINT * tint);
  let wg = Math.exp(-KTINT * tint);
  let wb = Math.exp(-KT * temp + 0.5 * KTINT * tint);
  const wl = LR * wr + LG * wg + LB * wb;
  wr /= wl; wg /= wl; wb /= wl;

  // --- matrix (WB folded in) + exposure
  const ex = Math.pow(2, +p.exposure || 0);
  const M = Array.isArray(p.matrix) && p.matrix.length === 9 ? p.matrix.map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const m00 = M[0] * wr * ex, m01 = M[1] * wg * ex, m02 = M[2] * wb * ex;
  const m10 = M[3] * wr * ex, m11 = M[4] * wg * ex, m12 = M[5] * wb * ex;
  const m20 = M[6] * wr * ex, m21 = M[7] * wg * ex, m22 = M[8] * wb * ex;

  // --- B&W mix
  const bm = arr3(p.bwMix, FILM_DEFAULTS.bwMix);
  const bsum = bm[0] + bm[1] + bm[2] || 1;
  const bw0 = bm[0] / bsum, bw1 = bm[1] / bsum, bw2 = bm[2] / bsum;

  // --- tone stage (per channel, linear → encoded): [filmic | rolloff → encode → contrast]
  //     → shadows/highlights → curve → curveR/G/B.  Tabulated into one table per channel.
  const filmic = p.filmic && typeof p.filmic === 'object' ? makeFilmicCurve(p.filmic) : null;
  const roll = Math.min(1, Math.max(0, +p.rolloff || 0));
  const knee = 1 - 0.55 * roll;
  const kw = 1 - knee;
  const shoulder = roll > 0
    ? (x) => (x <= knee ? x : knee + kw * (1 - Math.exp(-(x - knee) / kw)))
    : (x) => (x < 1 ? x : 1);
  const c = filmic ? 0 : Math.max(-1, Math.min(1, +p.contrast || 0));
  const sh = +p.shadows || 0, hi = +p.highlights || 0;
  const SK = 7;
  const lg = (x) => 1 / (1 + Math.exp(-SK * (x - 0.5)));
  const l0 = lg(0), l1 = lg(1), lsp = l1 - l0;
  const toneEnc = (x) => { // encoded → encoded (contrast + shadows/highlights)
    let y = x + c * ((lg(x) - l0) / lsp - x);
    const ym = 1 - y;
    y += sh * 0.6 * y * ym * ym;
    y += hi * 0.6 * y * y * ym;
    return y;
  };
  const cM = normaliseCurve(p.curve) ? monotoneCurve(p.curve) : null;
  const chCurves = isBW ? [null, null, null]
    : [p.curveR, p.curveG, p.curveB].map((q) => (normaliseCurve(q) ? monotoneCurve(q) : null));
  const toneMaster = (x) => {
    let y = filmic ? linearToSrgb(filmic(x)) : linearToSrgb(shoulder(x));
    y = toneEnc(y);
    return cM ? cM(y) : y;
  };
  const toneCh = (x, ch) => { const y = toneMaster(x); return chCurves[ch] ? chCurves[ch](y) : y; };
  const buildTable = (ch) => {
    const T = new Float32Array(TONE_N + 2);
    for (let i = 0; i <= TONE_N; i++) { const u = i / TONE_N; T[i] = toneCh(u * u * TONE_XMAX, ch); }
    T[TONE_N + 1] = T[TONE_N];
    return T;
  };
  const Tm = buildTable(-1);
  const T0 = chCurves[0] ? buildTable(0) : Tm;
  const T1 = chCurves[1] ? buildTable(1) : Tm;
  const T2 = chCurves[2] ? buildTable(2) : Tm;
  const look = (T, x, ch) => {
    if (!(x > 0)) return T[0];
    if (x >= TONE_XMAX) return toneCh(x, ch);
    const f = Math.sqrt(x * TONE_INV) * TONE_N, i = f | 0;
    return T[i] + (T[i + 1] - T[i]) * (f - i);
  };

  // --- LGG
  const lift = arr3(p.lift, FILM_DEFAULTS.lift);
  const gamma = arr3(p.gamma, FILM_DEFAULTS.gamma);
  const gain = arr3(p.gain, FILM_DEFAULTS.gain);
  const ig0 = 1 / (gamma[0] || 1), ig1 = 1 / (gamma[1] || 1), ig2 = 1 / (gamma[2] || 1);
  const lggId = lift.every((v) => v === 0) && gain.every((v) => v === 1);
  const gamId = ig0 === 1 && ig1 === 1 && ig2 === 1;

  // --- saturation (+ chromaCurve: 5 sat multipliers over luma, piecewise linear)
  const sat = +p.sat, satS = +p.satShadows, satH = +p.satHighlights, vib = +p.vibrance || 0;
  let cc = null;
  if (Array.isArray(p.chromaCurve) && p.chromaCurve.length >= 2) {
    const v = p.chromaCurve.map((q) => clampN(q, 0, 4, 1));
    if (v.some((q) => q !== 1)) cc = Float64Array.from(v.concat([v[v.length - 1]]));
  }
  const ccN = cc ? cc.length - 2 : 0;
  const doSat = !isBW && (sat !== 1 || satS !== 1 || satH !== 1 || vib !== 0 || cc !== null);

  // --- HSL (table values clamped: hue ±60°, sat× 0..4, lum ±0.5 so heavy fits stay sane)
  const doHsl = !isBW && hasHsl(p.hsl);
  const hslT = doHsl ? buildHslTables(p.hsl) : null;
  if (hslT) {
    for (let i = 0; i <= 360; i++) {
      hslT.H[i] = clampN(hslT.H[i], -60, 60, 0);
      hslT.S[i] = clampN(hslT.S[i], 0, 4, 1);
      hslT.L[i] = clampN(hslT.L[i], -0.5, 0.5, 0);
    }
  }
  const HT = hslT && hslT.H, ST = hslT && hslT.S, LT = hslT && hslT.L;
  const lock = !isBW && !!p.lumaLock;

  // --- subtractive dye density
  const dens = isBW ? 0 : clampN(p.density, 0, 1, 0) * DENSITY_K;
  let DH = null;
  if (dens > 0 && p.densityHue && typeof p.densityHue === 'object') {
    const hs = {};
    for (const [k, v] of Object.entries(p.densityHue)) if (k in HSL_BANDS) hs[k] = [0, clampN(v, 0, 3, 1), 0];
    if (hasHsl(hs)) DH = buildHslTables(hs).S;
  }

  // --- split toning
  const sS = p.splitShadow && +p.splitShadow.amt ? p.splitShadow : null;
  const sH = p.splitHighlight && +p.splitHighlight.amt ? p.splitHighlight : null;
  const sc = sS ? toneChroma(+sS.hue || 0).map((v) => v * +sS.amt) : null;
  const hc = sH ? toneChroma(+sH.hue || 0).map((v) => v * +sH.amt) : null;

  // --- fade / white point
  const fade = +p.fade || 0;
  const wp = p.whitePoint == null ? 1 : +p.whitePoint;
  const fscale = wp - fade;

  // front half: WB/matrix/exposure → tone stage → LGG → saturation. Writes o, returns o.
  const front = (rIn, gIn, bIn, o) => {
    // linear: WB + matrix + exposure
    let r = m00 * rIn + m01 * gIn + m02 * bIn;
    let g = m10 * rIn + m11 * gIn + m12 * bIn;
    let b = m20 * rIn + m21 * gIn + m22 * bIn;

    // tone stage → encoded
    if (isBW) { r = g = b = look(T0, bw0 * r + bw1 * g + bw2 * b, 0); }
    else { r = look(T0, r, 0); g = look(T1, g, 1); b = look(T2, b, 2); }

    // lift / gamma / gain
    if (!lggId) {
      r = gain[0] * r + lift[0] * (1 - r);
      g = gain[1] * g + lift[1] * (1 - g);
      b = gain[2] * b + lift[2] * (1 - b);
    }
    if (!gamId) {
      r = Math.pow(r > 0 ? r : 0, ig0);
      g = Math.pow(g > 0 ? g : 0, ig1);
      b = Math.pow(b > 0 ? b : 0, ig2);
    }

    // saturation / vibrance / chroma-vs-luma curve
    if (doSat) {
      const Y = LR * r + LG * g + LB * b;
      const Yc = Y < 0 ? 0 : Y > 1 ? 1 : Y;
      const iy = 1 - Yc;
      let s = sat * (iy * iy * satS + 2 * Yc * iy + Yc * Yc * satH);
      if (cc) { const f = Yc * ccN, i = f | 0; s *= cc[i] + (cc[i + 1] - cc[i]) * (f - i); }
      if (vib !== 0) {
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        let ch = (mx - mn) * 1.5; if (ch > 1) ch = 1;
        s *= 1 + vib * (1 - ch);
      }
      if (s < 0) s = 0;
      if (lock) { // shrink s so no channel leaves 0..1 (luma + hue kept)
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mn < Y && s * (Y - mn) > Y) s = Y > 0 ? Y / (Y - mn) : 0;
        if (mx > Y && s * (mx - Y) > 1 - Y) s = Y < 1 ? (1 - Y) / (mx - Y) : 0;
      }
      r = Y + (r - Y) * s; g = Y + (g - Y) * s; b = Y + (b - Y) * s;
    }
    o[0] = r; o[1] = g; o[2] = b;
    return o;
  };

  // --- neutral axis: the grey ramp traced through `front`, tabulated by luma (0..1, NEUT_N
  //     steps). density, and hsl band weights under lumaLock, use chroma RELATIVE to this
  //     neutral, so the film's own neutral (casts / crossovers) is left untouched.
  // --- hueKeep: band tables indexed by input hue (degrees 0..360)
  const doKeep = !isBW && hasHsl(Object.fromEntries(Object.entries(p.hueKeep || {})
    .filter(([k, v]) => k in HSL_BANDS && Array.isArray(v)).map(([k, v]) => [k, [+v[0] || 0, v[1] == null ? 1 : +v[1], 0]])));
  let KH = null, KS = null;
  if (doKeep) {
    const hs = {};
    for (const [k, v] of Object.entries(p.hueKeep)) if (k in HSL_BANDS && Array.isArray(v)) hs[k] = [clampN(v[0], -90, 90, 0), clampN(v[1], 0, 4, 1), 0];
    const t = buildHslTables(hs); KH = t.H; KS = t.S;
  }

  const relC = !isBW && (dens > 0 || (lock && doHsl) || doKeep);
  let NT = null, NTOL = null;
  const chromaOf = (dr, dg, db) => {
    const mx = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    const mn = dr < dg ? (dr < db ? dr : db) : (dg < db ? dg : db);
    return mx - mn;
  };
  if (relC) {
    const K = NEUT_K, ys = new Float64Array(K + 1), cs = new Float64Array((K + 1) * 3), o = [0, 0, 0];
    for (let i = 0; i <= K; i++) {
      const u = i / K, x = u * u * NEUT_XMAX;
      front(x, x, x, o);
      let y = LR * o[0] + LG * o[1] + LB * o[2];
      if (!(y >= 0)) y = 0;
      ys[i] = i > 0 && y < ys[i - 1] ? ys[i - 1] : y;
      cs[i * 3] = o[0]; cs[i * 3 + 1] = o[1]; cs[i * 3 + 2] = o[2];
    }
    NT = new Float32Array((NEUT_N + 2) * 3);
    let k = 0;
    for (let j = 0; j <= NEUT_N + 1; j++) {
      const yq = Math.min(j, NEUT_N) / NEUT_N;
      while (k < K && ys[k + 1] < yq) k++;
      let t = 0, i0 = k, i1 = k;
      if (yq <= ys[0]) { i0 = i1 = 0; } else if (k >= K) { i0 = i1 = K; } else {
        i1 = k + 1; const dy = ys[i1] - ys[i0]; t = dy > 1e-12 ? (yq - ys[i0]) / dy : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
      }
      for (let c = 0; c < 3; c++) NT[j * 3 + c] = cs[i0 * 3 + c] + (cs[i1 * 3 + c] - cs[i0 * 3 + c]) * t;
    }
    // tolerance: how far real ramp samples sit from the interpolated neutral, per node
    NTOL = new Float32Array(NEUT_N + 2).fill(NEUT_EPS);
    for (let i = 0; i <= K; i++) {
      const y = ys[i] < 1 ? ys[i] : 1, f = y * NEUT_N, j = f | 0, t = f - j, q = j * 3;
      const dev = chromaOf(
        cs[i * 3] - (NT[q] + (NT[q + 3] - NT[q]) * t),
        cs[i * 3 + 1] - (NT[q + 1] + (NT[q + 4] - NT[q + 1]) * t),
        cs[i * 3 + 2] - (NT[q + 2] + (NT[q + 5] - NT[q + 2]) * t)) + NEUT_EPS;
      if (dev > NTOL[j]) NTOL[j] = dev;
      if (dev > NTOL[j + 1]) NTOL[j + 1] = dev;
    }
    // also cover the stretch between consecutive samples (neighbouring nodes)
    const tmp = NTOL.slice();
    for (let j = 0; j < NTOL.length; j++) NTOL[j] = Math.max(tmp[j], j > 0 ? tmp[j - 1] : 0, j + 1 < tmp.length ? tmp[j + 1] : 0);
  }

  return function film(rIn, gIn, bIn, out) {
    const o = front(rIn, gIn, bIn, out);
    let r = o[0], g = o[1], b = o[2];

    // hueKeep: classify by the scene's hue (linear input), edit chroma relative to the neutral
    if (doKeep) {
      const mx = rIn > gIn ? (rIn > bIn ? rIn : bIn) : (gIn > bIn ? gIn : bIn);
      const mn = rIn < gIn ? (rIn < bIn ? rIn : bIn) : (gIn < bIn ? gIn : bIn);
      const dIn = mx - mn;
      if (dIn > 1e-6 && mx > 0) {
        let w = (dIn / mx - 0.1) / 0.25; w = w <= 0 ? 0 : w >= 1 ? 1 : w * w * (3 - 2 * w);
        if (w > 0) {
          const h = hueOf(rIn, gIn, bIn, mx, dIn), i0 = h | 0, t = h - i0;
          const th = (KH[i0] + (KH[i0 + 1] - KH[i0]) * t) * w * (Math.PI / 180);
          const sc = 1 + (KS[i0] + (KS[i0 + 1] - KS[i0]) * t - 1) * w;
          let Y = LR * r + LG * g + LB * b; Y = Y > 0 ? (Y < 1 ? Y : 1) : 0;
          const f = Y * NEUT_N, i = f | 0, u = f - i, j = i * 3;
          const nr = NT[j] + (NT[j + 3] - NT[j]) * u, ng = NT[j + 1] + (NT[j + 4] - NT[j + 1]) * u, nb = NT[j + 2] + (NT[j + 5] - NT[j + 2]) * u;
          const dr = r - nr, dg = g - ng, db = b - nb;
          const yd = LR * dr + LG * dg + LB * db, cb = db - yd, cr = dr - yd;
          const cs = Math.cos(th) * sc, sn = Math.sin(th) * sc;
          const cb2 = cb * cs - cr * sn, cr2 = cb * sn + cr * cs;
          const r2 = nr + yd + cr2, b2 = nb + yd + cb2;
          const g2 = ng + (yd - LR * (yd + cr2) - LB * (yd + cb2)) / LG;
          // keep inside 0..1 by pulling toward this luma (hue kept)
          const Yo = LR * r2 + LG * g2 + LB * b2;
          let k = 1;
          const m2 = r2 > g2 ? (r2 > b2 ? r2 : b2) : (g2 > b2 ? g2 : b2);
          const n2 = r2 < g2 ? (r2 < b2 ? r2 : b2) : (g2 < b2 ? g2 : b2);
          if (m2 > 1 && m2 > Yo) k = Math.min(k, (1 - Yo) / (m2 - Yo));
          if (n2 < 0 && n2 < Yo) k = Math.min(k, Yo / (Yo - n2));
          r = Yo + (r2 - Yo) * k; g = Yo + (g2 - Yo) * k; b = Yo + (b2 - Yo) * k;
        }
      }
    }

    // chroma relative to the film's neutral at this luma (density / lumaLock-hsl weighting)
    let Crel = 0;
    if (relC) {
      let Y = LR * r + LG * g + LB * b;
      Y = Y > 0 ? (Y < 1 ? Y : 1) : 0;
      const f = Y * NEUT_N, i = f | 0, t = f - i, j = i * 3;
      const dr = r - (NT[j] + (NT[j + 3] - NT[j]) * t);
      const dg = g - (NT[j + 1] + (NT[j + 4] - NT[j + 1]) * t);
      const db = b - (NT[j + 2] + (NT[j + 5] - NT[j + 2]) * t);
      Crel = chromaOf(dr, dg, db) - (NTOL[i] + (NTOL[i + 1] - NTOL[i]) * t);
      Crel = Crel > 0 ? (Crel < 1 ? Crel : 1) : 0;
    }

    // 8-band HSL (in HSV)
    if (doHsl) {
      if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const d = mx - mn;
      if (d > 1e-6 && mx > 0) {
        let h = hueOf(r, g, b, mx, d);
        let s = d / mx, v = mx;
        const i0 = h | 0, t = h - i0, i1 = i0 + 1;
        // lumaLock: fade band effects in by chroma relative to the film's neutral, so the
        // neutral axis (with its casts) is never hue/sat/lum-edited
        let w = 1;
        if (lock && Crel < HSL_CFADE) { const u = Crel / HSL_CFADE; w = u * u * (3 - 2 * u); }
        const dh = HT[i0] + (HT[i1] - HT[i0]) * t;
        const sm = ST[i0] + (ST[i1] - ST[i0]) * t;
        const la = LT[i0] + (LT[i1] - LT[i0]) * t;
        const Yt = lock ? (LR * r + LG * g + LB * b) * (1 + la * s * w) : 0;
        h += dh * s * w;
        v += la * s * w * v;
        s *= 1 + (sm - 1) * w; if (s > 1) s = 1; if (s < 0) s = 0;
        if (v < 0) v = 0;
        // inline hsv → rgb
        h = ((h % 360) + 360) % 360 / 60;
        const k = Math.floor(h), f = h - k;
        const pp = v * (1 - s), q = v * (1 - s * f), tt = v * (1 - s * (1 - f));
        switch (k) {
          case 0: r = v; g = tt; b = pp; break;
          case 1: r = q; g = v; b = pp; break;
          case 2: r = pp; g = v; b = tt; break;
          case 3: r = pp; g = q; b = v; break;
          case 4: r = tt; g = pp; b = v; break;
          default: r = v; g = pp; b = q; break;
        }
        if (lock) { // restore luma (hue / sat edits luma-neutral), then compress chroma into gamut
          const Y1 = LR * r + LG * g + LB * b;
          if (Yt >= 1) { r = g = b = 1; }
          else if (Y1 > 1e-9) {
            const k = Yt / Y1;
            r *= k; g *= k; b *= k;
            const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
            if (m > 1) { const f = (1 - Yt) / (m - Yt); r = Yt + (r - Yt) * f; g = Yt + (g - Yt) * f; b = Yt + (b - Yt) * f; }
          }
        }
      }
    }

    // subtractive dye density: darken by chroma relative to the neutral (hue & HSV sat kept)
    if (dens > 0 && Crel > 1e-6) {
      let k = dens * Crel * (0.4 + 0.6 * Crel);
      if (DH) {
        const rr = r > 0 ? r : 0, gg = g > 0 ? g : 0, bb = b > 0 ? b : 0;
        const mx = rr > gg ? (rr > bb ? rr : bb) : (gg > bb ? gg : bb);
        const mn = rr < gg ? (rr < bb ? rr : bb) : (gg < bb ? gg : bb);
        if (mx - mn > 1e-6) { const h = hueOf(rr, gg, bb, mx, mx - mn), i0 = h | 0; k *= DH[i0] + (DH[i0 + 1] - DH[i0]) * (h - i0); }
      }
      const f = k < 0.9 ? 1 - k : 0.1;
      r *= f; g *= f; b *= f;
    }

    // split toning (chroma-only additions; fade out at pure black / white)
    if (sc || hc) {
      let Y = LR * r + LG * g + LB * b;
      Y = Y < 0 ? 0 : Y > 1 ? 1 : Y;
      if (sc) {
        const iy = 1 - Y;
        let w = iy * iy; const e = Y * 8; if (e < 1) w *= e;
        r += sc[0] * w; g += sc[1] * w; b += sc[2] * w;
      }
      if (hc) {
        let w = Y * Y; const e = (1 - Y) * 8; if (e < 1) w *= e;
        r += hc[0] * w; g += hc[1] * w; b += hc[2] * w;
      }
    }

    // lumaLock: compress any out-of-gamut chroma about luma instead of clipping channels
    if (lock) {
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx > 1 || mn < 0) {
        let Y = LR * r + LG * g + LB * b;
        Y = Y > 0 ? (Y < 1 ? Y : 1) : 0;
        let f = 1;
        if (mx > 1 && mx > Y) f = (1 - Y) / (mx - Y);
        if (mn < 0 && mn < Y) { const f2 = Y / (Y - mn); if (f2 < f) f = f2; }
        r = Y + (r - Y) * f; g = Y + (g - Y) * f; b = Y + (b - Y) * f;
      }
    }

    // fade / white point + clamp (NaN → 0)
    r = fade + r * fscale; g = fade + g * fscale; b = fade + b * fscale;
    out[0] = !(r > 0) ? 0 : r > 1 ? 1 : r;
    out[1] = !(g > 0) ? 0 : g > 1 ? 1 : g;
    out[2] = !(b > 0) ? 0 : b > 1 ? 1 : b;
    return out;
  };
}

// ---------------------------------------------------------------------------
// Fitting helpers: map named numeric parameter paths ↔ flat Float64Array.

/** Read a dotted path ('hsl.green.1', 'curve.3.1', 'lift.0') from an object; undefined if absent. */
export function getPath(obj, path) {
  let o = obj;
  for (const k of String(path).split('.')) {
    if (o == null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

// Container created when a path's parent is missing.
function containerDefault(prefix, nextKey) {
  const segs = prefix.split('.');
  if (segs.length === 2 && segs[0] === 'hsl') return [0, 1, 0];
  if (prefix === 'filmic') return { ...FILMIC_DEFAULTS };
  if (prefix === 'chromaCurve') return [1, 1, 1, 1, 1];
  if (prefix === 'densityHue') return {};
  if (segs.length === 1 && prefix in FILM_DEFAULTS) {
    const d = FILM_DEFAULTS[prefix];
    if (d && typeof d === 'object') return JSON.parse(JSON.stringify(d));
  }
  if (segs.length === 2 && /^curve[RGB]?$/.test(segs[0])) return [0, 0];
  return /^\d+$/.test(nextKey) ? [] : {};
}

/** Set a dotted path in place, creating containers (hsl band → [0,1,0], lift → copy of default, ...). */
export function setPath(obj, path, value) {
  const ks = String(path).split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = containerDefault(ks.slice(0, i + 1).join('.'), ks[i + 1]);
    o = o[k];
  }
  o[ks[ks.length - 1]] = value;
  return obj;
}

const clone = (v) => (v == null ? {} : typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Lower / upper bound arrays for a spec. */
export function specBounds(spec) {
  return { lo: Float64Array.from(spec, (s) => s.min), hi: Float64Array.from(spec, (s) => s.max) };
}

/**
 * Read spec'd parameters from `params` into a Float64Array (missing → entry.def,
 * values clamped into [min,max]).
 */
export function paramVector(spec, params) {
  const v = new Float64Array(spec.length);
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i];
    let x = +getPath(params || {}, s.path);
    if (!Number.isFinite(x)) x = s.def;
    v[i] = x < s.min ? s.min : x > s.max ? s.max : x;
  }
  return v;
}

/**
 * Return a deep copy of `base` with each spec'd path set from `vec` (clamped into
 * [min,max]); each entry's optional `fixed: { path: value }` is also written
 * (e.g. the fixed x of a curve point).
 */
export function applyVector(spec, vec, base) {
  const p = clone(base);
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i];
    let x = +vec[i];
    if (!Number.isFinite(x)) x = s.def;
    x = x < s.min ? s.min : x > s.max ? s.max : x;
    if (s.fixed) for (const [fp, fv] of Object.entries(s.fixed)) setPath(p, fp, fv);
    setPath(p, s.path, x);
  }
  return p;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
export const CURVE_X = Object.freeze([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]);
export const CHANNEL_CURVE_X = Object.freeze([0.25, 0.5, 0.75]);

function curveSpec(key, xs, spread) {
  return xs.map((x, i) => ({
    path: `${key}.${i}.1`, min: r4(Math.max(0, x - spread)), max: r4(Math.min(1, x + spread)), def: x,
    fixed: { [`${key}.${i}.0`]: x },
  }));
}

const TONE_SPEC = [
  { path: 'exposure', min: -1, max: 1, def: 0 },
  { path: 'contrast', min: -0.6, max: 0.8, def: 0 },
  { path: 'shadows', min: -0.6, max: 0.6, def: 0 },
  { path: 'highlights', min: -0.6, max: 0.6, def: 0 },
  { path: 'rolloff', min: 0, max: 1, def: 0 },
  { path: 'fade', min: 0, max: 0.15, def: 0 },
  { path: 'whitePoint', min: 0.8, max: 1, def: 1 },
];

/** Default colour-fit parameter list (no filmic; concat FIT_SPEC_FILMIC to fit that instead of contrast/rolloff). */
export const FIT_SPEC = Object.freeze([
  ...TONE_SPEC,
  { path: 'temp', min: -0.4, max: 0.4, def: 0 },
  { path: 'tint', min: -0.4, max: 0.4, def: 0 },
  ...[0, 1, 2].map((i) => ({ path: `lift.${i}`, min: -0.05, max: 0.12, def: 0 })),
  ...[0, 1, 2].map((i) => ({ path: `gamma.${i}`, min: 0.75, max: 1.33, def: 1 })),
  ...[0, 1, 2].map((i) => ({ path: `gain.${i}`, min: 0.85, max: 1.15, def: 1 })),
  { path: 'sat', min: 0.3, max: 1.8, def: 1 },
  { path: 'vibrance', min: -0.5, max: 0.5, def: 0 },
  { path: 'satShadows', min: 0.4, max: 1.6, def: 1 },
  { path: 'satHighlights', min: 0.4, max: 1.6, def: 1 },
  ...[0, 1, 2, 3, 4].map((i) => ({ path: `chromaCurve.${i}`, min: 0.4, max: 1.8, def: 1 })),
  { path: 'density', min: 0, max: 1, def: 0 },
  ...Object.keys(HSL_BANDS).flatMap((b) => [
    { path: `hsl.${b}.0`, min: -25, max: 25, def: 0 },
    { path: `hsl.${b}.1`, min: 0.4, max: 1.8, def: 1 },
    { path: `hsl.${b}.2`, min: -0.1, max: 0.1, def: 0 },
  ]),
  ...curveSpec('curve', CURVE_X, 0.3),
  ...curveSpec('curveR', CHANNEL_CURVE_X, 0.12),
  ...curveSpec('curveG', CHANNEL_CURVE_X, 0.12),
  ...curveSpec('curveB', CHANNEL_CURVE_X, 0.12),
].map(Object.freeze));

/** Filmic characteristic-curve parameters (setting any of them enables `filmic`). */
export const FIT_SPEC_FILMIC = Object.freeze([
  { path: 'filmic.slope', min: 0.5, max: 2, def: FILMIC_DEFAULTS.slope },
  { path: 'filmic.toe', min: 0.02, max: 1.5, def: FILMIC_DEFAULTS.toe },
  { path: 'filmic.shoulder', min: 0.02, max: 1.5, def: FILMIC_DEFAULTS.shoulder },
  { path: 'filmic.blackDensity', min: 1, max: 3.5, def: FILMIC_DEFAULTS.blackDensity },
].map(Object.freeze));

/** B&W fit: tone + spectral mix (green weight fixed as the reference) + master curve. */
export const FIT_SPEC_BW = Object.freeze([
  ...TONE_SPEC,
  { path: 'bwMix.0', min: 0.05, max: 0.8, def: FILM_DEFAULTS.bwMix[0] },
  { path: 'bwMix.2', min: 0, max: 0.6, def: FILM_DEFAULTS.bwMix[2] },
  ...curveSpec('curve', CURVE_X, 0.3),
].map(Object.freeze));

/**
 * Bake a film into a 3D LUT. Input coordinate u∈[0,1] per axis encodes
 * linear = srgbToLinear(u) * LUT_HEADROOM. Output: half-float RGBA, A = 1.0,
 * index = ((b*N + g)*N + r)*4.
 */
export function buildLut(params, N = LUT_SIZE) {
  const film = makeFilm(params);
  const data = new Uint16Array(N * N * N * 4);
  const shaper = new Float64Array(N);
  for (let i = 0; i < N; i++) shaper[i] = srgbToLinear(i / (N - 1)) * LUT_HEADROOM;
  const out = new Float32Array(3);
  const ONE = 0x3c00;
  let o = 0;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        film(shaper[r], shaper[g], shaper[b], out);
        data[o] = floatToHalf(out[0]);
        data[o + 1] = floatToHalf(out[1]);
        data[o + 2] = floatToHalf(out[2]);
        data[o + 3] = ONE;
        o += 4;
      }
    }
  }
  return data;
}
