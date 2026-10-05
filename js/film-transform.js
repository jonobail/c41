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
});

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

// Fast sRGB encode for x∈[0,1]: table sampled in sqrt(x) domain (well-conditioned near 0).
const ENC_N = 2048;
const ENC = new Float32Array(ENC_N + 2);
for (let i = 0; i <= ENC_N; i++) { const q = i / ENC_N; ENC[i] = linearToSrgb(q * q); }
ENC[ENC_N + 1] = ENC[ENC_N];
function encFast(x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return x === 1 ? 1 : linearToSrgb(x);
  const f = Math.sqrt(x) * ENC_N, i = f | 0;
  return ENC[i] + (ENC[i + 1] - ENC[i]) * (f - i);
}

const arr3 = (v, d) => (Array.isArray(v) && v.length === 3 ? v.map(Number) : d.slice());

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

  // --- rolloff shoulder
  const roll = Math.min(1, Math.max(0, +p.rolloff || 0));
  const knee = 1 - 0.55 * roll;
  const kw = 1 - knee;
  const shoulder = roll > 0
    ? (x) => (x <= knee ? x : knee + kw * (1 - Math.exp(-(x - knee) / kw)))
    : (x) => (x < 1 ? x : 1);

  // --- encoded-domain tone curve (contrast + shadows/highlights), tabulated
  const c = Math.max(-1, Math.min(1, +p.contrast || 0));
  const sh = +p.shadows || 0, hi = +p.highlights || 0;
  const SK = 7;
  const lg = (x) => 1 / (1 + Math.exp(-SK * (x - 0.5)));
  const l0 = lg(0), l1 = lg(1), lsp = l1 - l0;
  const TN = 1024;
  const tone = new Float32Array(TN + 2);
  for (let i = 0; i <= TN; i++) {
    const x = i / TN;
    let y = x + c * ((lg(x) - l0) / lsp - x);
    const ym = 1 - y;
    y += sh * 0.6 * y * ym * ym;
    y += hi * 0.6 * y * y * ym;
    tone[i] = y;
  }
  tone[TN + 1] = tone[TN];
  const toneFn = (x) => {
    if (x <= 0) return tone[0];
    if (x >= 1) return tone[TN];
    const f = x * TN, i = f | 0, t = f - i;
    return tone[i] + (tone[i + 1] - tone[i]) * t;
  };

  // --- LGG
  const lift = arr3(p.lift, FILM_DEFAULTS.lift);
  const gamma = arr3(p.gamma, FILM_DEFAULTS.gamma);
  const gain = arr3(p.gain, FILM_DEFAULTS.gain);
  const ig0 = 1 / (gamma[0] || 1), ig1 = 1 / (gamma[1] || 1), ig2 = 1 / (gamma[2] || 1);
  const lggId = lift.every((v) => v === 0) && gain.every((v) => v === 1);
  const gamId = ig0 === 1 && ig1 === 1 && ig2 === 1;

  // --- saturation
  const sat = +p.sat, satS = +p.satShadows, satH = +p.satHighlights, vib = +p.vibrance || 0;
  const doSat = !isBW && (sat !== 1 || satS !== 1 || satH !== 1 || vib !== 0);

  // --- HSL
  const doHsl = !isBW && hasHsl(p.hsl);
  const hslT = doHsl ? buildHslTables(p.hsl) : null;
  const HT = hslT && hslT.H, ST = hslT && hslT.S, LT = hslT && hslT.L;

  // --- split toning
  const sS = p.splitShadow && +p.splitShadow.amt ? p.splitShadow : null;
  const sH = p.splitHighlight && +p.splitHighlight.amt ? p.splitHighlight : null;
  const sc = sS ? toneChroma(+sS.hue || 0).map((v) => v * +sS.amt) : null;
  const hc = sH ? toneChroma(+sH.hue || 0).map((v) => v * +sH.amt) : null;

  // --- fade / white point
  const fade = +p.fade || 0;
  const wp = p.whitePoint == null ? 1 : +p.whitePoint;
  const fscale = wp - fade;

  return function film(rIn, gIn, bIn, out) {
    // linear: WB + matrix + exposure
    let r = m00 * rIn + m01 * gIn + m02 * bIn;
    let g = m10 * rIn + m11 * gIn + m12 * bIn;
    let b = m20 * rIn + m21 * gIn + m22 * bIn;
    if (isBW) { r = g = b = bw0 * r + bw1 * g + bw2 * b; }
    if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
    r = shoulder(r); g = isBW ? r : shoulder(g); b = isBW ? r : shoulder(b);

    // encode + tone curve
    r = toneFn(encFast(r));
    if (isBW) { g = b = r; } else { g = toneFn(encFast(g)); b = toneFn(encFast(b)); }

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

    // saturation / vibrance
    if (doSat) {
      const Y = LR * r + LG * g + LB * b;
      const Yc = Y < 0 ? 0 : Y > 1 ? 1 : Y;
      const iy = 1 - Yc;
      let s = sat * (iy * iy * satS + 2 * Yc * iy + Yc * Yc * satH);
      if (vib !== 0) {
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        let ch = (mx - mn) * 1.5; if (ch > 1) ch = 1;
        s *= 1 + vib * (1 - ch);
      }
      if (s < 0) s = 0;
      r = Y + (r - Y) * s; g = Y + (g - Y) * s; b = Y + (b - Y) * s;
    }

    // 8-band HSL (in HSV)
    if (doHsl) {
      if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const d = mx - mn;
      if (d > 1e-6 && mx > 0) {
        let h;
        if (mx === r) h = 60 * (((g - b) / d) % 6);
        else if (mx === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
        let s = d / mx, v = mx;
        const fi = h, i0 = fi | 0, t = fi - i0, i1 = i0 + 1;
        const dh = HT[i0] + (HT[i1] - HT[i0]) * t;
        const sm = ST[i0] + (ST[i1] - ST[i0]) * t;
        const la = LT[i0] + (LT[i1] - LT[i0]) * t;
        h += dh * s;
        v += la * s * v;
        s *= sm; if (s > 1) s = 1; if (s < 0) s = 0;
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
      }
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

    // fade / white point + clamp
    r = fade + r * fscale; g = fade + g * fscale; b = fade + b * fscale;
    out[0] = r < 0 ? 0 : r > 1 ? 1 : r;
    out[1] = g < 0 ? 0 : g > 1 ? 1 : g;
    out[2] = b < 0 ? 0 : b > 1 ? 1 : b;
    return out;
  };
}

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
