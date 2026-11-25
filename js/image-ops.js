// C41 — Digital Image Processing math, defaults, curve LUTs, HSL packing,
// auto-tone analysis, histogram/waveform scopes, geometry math & edit history.
// Pure ES module (no DOM at import time — Node-safe for unit tests).

import { monotoneCurve, srgbToLinear, linearToSrgb } from './film-transform.js';

export const HSL_BANDS = Object.freeze([
  { id: 'red',     label: 'Red',     hue: 0,   color: '#ff4d4d' },
  { id: 'orange',  label: 'Orange',  hue: 30,  color: '#ff9436' },
  { id: 'yellow',  label: 'Yellow',  hue: 60,  color: '#f7d438' },
  { id: 'green',   label: 'Green',   hue: 120, color: '#46cf6b' },
  { id: 'aqua',    label: 'Aqua',    hue: 180, color: '#38d4d4' },
  { id: 'blue',    label: 'Blue',    hue: 240, color: '#4d8bff' },
  { id: 'purple',  label: 'Purple',  hue: 270, color: '#9c66ff' },
  { id: 'magenta', label: 'Magenta', hue: 300, color: '#f056b7' },
]);

export const ASPECT_PRESETS = Object.freeze([
  { id: 'auto',   label: 'Camera',   ratio: null },
  { id: 'orig',   label: 'Original', ratio: 0 },
  { id: '1:1',    label: '1:1',      ratio: 1 },
  { id: '4:5',    label: '4:5',      ratio: 1.25 },
  { id: '4:3',    label: '4:3',      ratio: 4 / 3 },
  { id: '3:2',    label: '3:2',      ratio: 1.5 },
  { id: '16:9',   label: '16:9',     ratio: 16 / 9 },
  { id: '2.39:1', label: '2.39:1',   ratio: 2.39 },
]);

export const CURVE_PRESETS = Object.freeze([
  { id: 'linear', label: 'Linear', pts: [[0, 0], [1, 1]] },
  { id: 's-curve', label: 'S-Curve', pts: [[0, 0], [0.25, 0.21], [0.5, 0.5], [0.75, 0.79], [1, 1]] },
  { id: 'matte', label: 'Matte', pts: [[0, 0.08], [0.22, 0.20], [0.5, 0.5], [0.78, 0.80], [1, 0.96]] },
  { id: 'punch', label: 'Punch', pts: [[0, 0], [0.18, 0.12], [0.5, 0.52], [0.82, 0.88], [1, 1]] },
  { id: 'soft', label: 'Soft', pts: [[0, 0.04], [0.28, 0.32], [0.72, 0.69], [1, 0.97]] },
]);

export function defaultCurves() {
  return {
    rgb: [[0, 0], [1, 1]],
    r: [[0, 0], [1, 1]],
    g: [[0, 0], [1, 1]],
    b: [[0, 0], [1, 1]],
  };
}

export function defaultHsl() {
  const o = {};
  for (const b of HSL_BANDS) o[b.id] = [0, 0, 0]; // [hueDeg (-30..30), sat (-1..1), lum (-0.5..0.5)]
  return o;
}

export function defaultDevelop() {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    fade: 0,
    warmth: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
    clarity: 0,
    sharpen: 0,
    dehaze: 0,
    denoise: 0,
    vignette: 0,
    splitShadowHue: 220,
    splitShadowAmt: 0,
    splitHighlightHue: 45,
    splitHighlightAmt: 0,
    splitBalance: 0,
    curves: defaultCurves(),
    hsl: defaultHsl(),
    rotate: 0,       // 0 | 90 | 180 | 270 (clockwise)
    flipH: false,
    flipV: false,
    straighten: 0,   // -45..45 degrees
    aspect: 'auto',  // ASPECT_PRESETS id
  };
}

export const DEVELOP_SCALAR_KEYS = Object.freeze([
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'fade',
  'warmth', 'tint', 'vibrance', 'saturation',
  'clarity', 'sharpen', 'dehaze', 'denoise', 'vignette',
  'splitShadowHue', 'splitShadowAmt', 'splitHighlightHue', 'splitHighlightAmt', 'splitBalance',
  'rotate', 'flipH', 'flipV', 'straighten', 'aspect',
]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** True if all 4 curve channels are effectively linear identity. */
export function isCurveIdentity(curves) {
  if (!curves || typeof curves !== 'object') return true;
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    const pts = curves[ch];
    if (!Array.isArray(pts) || pts.length < 2) continue;
    for (const pt of pts) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      if (Math.abs(pt[0] - pt[1]) > 0.002) return false;
    }
  }
  return true;
}

/**
 * Evaluate the 4 tone curve channels (r, g, b, rgb master) into a 256×1 RGBA8 LUT texture.
 * Channel layout: R = red curve, G = green curve, B = blue curve, A = master RGB curve.
 */
export function buildCurveLut(curves, size = 256) {
  const out = new Uint8Array(size * 4);
  const c = curves || {};
  const fnR = monotoneCurve(c.r);
  const fnG = monotoneCurve(c.g);
  const fnB = monotoneCurve(c.b);
  const fnM = monotoneCurve(c.rgb);
  const inv = 1 / Math.max(1, size - 1);
  for (let i = 0; i < size; i++) {
    const x = i * inv;
    const o = i * 4;
    out[o]     = Math.round(clamp(fnR ? fnR(x) : x, 0, 1) * 255);
    out[o + 1] = Math.round(clamp(fnG ? fnG(x) : x, 0, 1) * 255);
    out[o + 2] = Math.round(clamp(fnB ? fnB(x) : x, 0, 1) * 255);
    out[o + 3] = Math.round(clamp(fnM ? fnM(x) : x, 0, 1) * 255);
  }
  return out;
}

/** True when any HSL band has a non-zero adjustment. */
export function hasActiveHsl(hsl) {
  if (!hsl || typeof hsl !== 'object') return false;
  for (const b of HSL_BANDS) {
    const v = hsl[b.id];
    if (Array.isArray(v) && (Math.abs(v[0] || 0) > 0.05 || Math.abs(v[1] || 0) > 0.002 || Math.abs(v[2] || 0) > 0.002)) {
      return true;
    }
  }
  return false;
}

/** Pack 8 HSL bands into a Float32Array(24): [hueDeg, satDelta, lumDelta] per band. */
export function packHslUniforms(hsl) {
  const out = new Float32Array(24);
  if (!hsl || typeof hsl !== 'object') return out;
  for (let i = 0; i < HSL_BANDS.length; i++) {
    const v = hsl[HSL_BANDS[i].id];
    if (!Array.isArray(v)) continue;
    out[i * 3]     = clamp(Number(v[0]) || 0, -45, 45);
    out[i * 3 + 1] = clamp(Number(v[1]) || 0, -1, 1);
    out[i * 3 + 2] = clamp(Number(v[2]) || 0, -0.5, 0.5);
  }
  return out;
}

/** Convert hue (0..360) to saturated RGB [r, g, b] in 0..1 for split-toning uniforms. */
export function hueToRgb(deg) {
  const h = (((Number(deg) || 0) % 360) + 360) % 360 / 60;
  const f = h - Math.floor(h);
  switch (Math.floor(h)) {
    case 0: return [1, f, 0];
    case 1: return [1 - f, 1, 0];
    case 2: return [0, 1, f];
    case 3: return [0, 1 - f, 1];
    case 4: return [f, 0, 1];
    default: return [1, 0, 1 - f];
  }
}

/**
 * Exact minimum uniform scale factor (≥ 1) so that a rectangle of size w×h rotated
 * by angleDeg remains completely inscribed inside the original w×h bounds (no black corners).
 */
export function inscribedZoom(w, h, angleDeg) {
  const a = Math.abs((Number(angleDeg) || 0) * Math.PI / 180);
  if (a < 1e-6 || !(w > 0 && h > 0)) return 1;
  const c = Math.cos(a), s = Math.sin(a);
  const zx = c + (h / w) * s;
  const zy = c + (w / h) * s;
  return Math.max(1, zx, zy);
}

/**
 * Build the 2×3 affine transform from logical (oriented/straightened) image px
 * back to raw source image px:
 *   src.x = mat[0] * lx + mat[1] * ly + off[0]
 *   src.y = mat[2] * lx + mat[3] * ly + off[1]
 * Also returns logical image dimensions `logImg = [LW, LH]` and `active` flag.
 */
export function buildGeometry(W, H, { rotate = 0, flipH = false, flipV = false, straighten = 0 } = {}) {
  const rot = (((Math.round(Number(rotate) || 0) % 360) + 360) % 360);
  const swap = rot === 90 || rot === 270;
  const LW = swap ? H : W;
  const LH = swap ? W : H;
  const ang = clamp(Number(straighten) || 0, -45, 45);
  const active = rot !== 0 || !!flipH || !!flipV || Math.abs(ang) > 1e-4;
  if (!active) {
    return { active: false, logImg: [W, H], mat: [1, 0, 0, 1], off: [0, 0], zoom: 1 };
  }

  // Step 1: Straighten around logical centre (LW/2, LH/2) with inscribed zoom
  const zoom = inscribedZoom(LW, LH, ang);
  const rad = -ang * Math.PI / 180; // inverse rotation to sample source
  const cs = Math.cos(rad) / zoom;
  const sn = Math.sin(rad) / zoom;
  // u = cs*(lx - cx) - sn*(ly - cy) + cx
  // v = sn*(lx - cx) + cs*(ly - cy) + cy
  const cx = LW * 0.5, cy = LH * 0.5;
  let a = cs, b = -sn, tx = cx - cs * cx + sn * cy;
  let c = sn, d = cs,  ty = cy - sn * cx - cs * cy;

  // Step 2: Flip in logical oriented space
  if (flipH) {
    a = -a; b = -b; tx = LW - tx;
  }
  if (flipV) {
    c = -c; d = -d; ty = LH - ty;
  }

  // Step 3: Inverse of clockwise 90/180/270 rotation mapping logical (u,v) -> raw (sx, sy)
  // rot 0:   sx = u,      sy = v
  // rot 90:  forward (sx,sy)->(H-sy, sx)  => inverse sx = v,     sy = H - u
  // rot 180: forward (sx,sy)->(W-sx,H-sy) => inverse sx = W - u, sy = H - v
  // rot 270: forward (sx,sy)->(sy, W-sx)  => inverse sx = W - v, sy = u
  let m0, m1, m2, m3, ox, oy;
  if (rot === 90) {
    m0 = c;  m1 = d;  ox = ty;
    m2 = -a; m3 = -b; oy = H - tx;
  } else if (rot === 180) {
    m0 = -a; m1 = -b; ox = W - tx;
    m2 = -c; m3 = -d; oy = H - ty;
  } else if (rot === 270) {
    m0 = -c; m1 = -d; ox = W - ty;
    m2 = a;  m3 = b;  oy = tx;
  } else {
    m0 = a; m1 = b; ox = tx;
    m2 = c; m3 = d; oy = ty;
  }
  return { active: true, logImg: [LW, LH], mat: [m0, m1, m2, m3], off: [ox, oy], zoom };
}

/** Map a logical image point (lx, ly) to raw source image px via buildGeometry() result. */
export function geoPoint(G, lx, ly) {
  return [
    G.mat[0] * lx + G.mat[1] * ly + G.off[0],
    G.mat[2] * lx + G.mat[3] * ly + G.off[1],
  ];
}

/** Bounding rect [x0, y0, x1, y1] in raw source px for a logical rect [lx0, ly0, lx1, ly1]. */
export function geoSourceRect(G, rect, pad = 0) {
  const corners = [
    geoPoint(G, rect[0] - pad, rect[1] - pad),
    geoPoint(G, rect[2] + pad, rect[1] - pad),
    geoPoint(G, rect[0] - pad, rect[3] + pad),
    geoPoint(G, rect[2] + pad, rect[3] + pad),
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of corners) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Compute RGB + Rec.709 Luminance histograms and highlight/shadow clipping stats from RGBA pixels.
 */
export function computeHistogram(rgba, width, height) {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  const total = Math.max(1, width * height);
  let clippedShadows = 0, clippedHighlights = 0;

  for (let i = 0; i < rgba.length; i += 4) {
    const rv = rgba[i], gv = rgba[i + 1], bv = rgba[i + 2];
    r[rv]++; g[gv]++; b[bv]++;
    const y = Math.min(255, Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv));
    luma[y]++;
    if (rv <= 2 && gv <= 2 && bv <= 2) clippedShadows++;
    if (rv >= 253 || gv >= 253 || bv >= 253) clippedHighlights++;
  }

  // Smooth max for vertical normalization (ignore extreme spike bins 0 and 255)
  let maxVal = 1;
  for (let i = 2; i < 254; i++) {
    if (r[i] > maxVal) maxVal = r[i];
    if (g[i] > maxVal) maxVal = g[i];
    if (b[i] > maxVal) maxVal = b[i];
    if (luma[i] > maxVal) maxVal = luma[i];
  }
  // Fallback if image is almost entirely pure black/white
  if (maxVal < total * 0.002) {
    for (let i = 0; i < 256; i++) {
      if (luma[i] > maxVal) maxVal = luma[i];
    }
  }

  return {
    r, g, b, luma,
    maxVal,
    total,
    clippedShadows: clippedShadows / total,
    clippedHighlights: clippedHighlights / total,
  };
}

/**
 * Compute RGB Parade waveform density grids (cols × rows per channel, row 0 = bottom/0, row rows-1 = top/255).
 */
export function computeWaveform(rgba, width, height, cols = 96, rows = 64) {
  const r = new Uint16Array(cols * rows);
  const g = new Uint16Array(cols * rows);
  const b = new Uint16Array(cols * rows);
  if (!(width > 0 && height > 0)) return { r, g, b, cols, rows, maxVal: 1 };

  const rowScale = (rows - 1) / 255;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowOff + x * 4;
      const cx = Math.min(cols - 1, Math.floor((x / width) * cols));
      const ry = Math.round(rgba[i] * rowScale);
      const gy = Math.round(rgba[i + 1] * rowScale);
      const by = Math.round(rgba[i + 2] * rowScale);
      r[ry * cols + cx]++;
      g[gy * cols + cx]++;
      b[by * cols + cx]++;
    }
  }

  let maxVal = 1;
  for (let i = 0; i < r.length; i++) {
    if (r[i] > maxVal) maxVal = r[i];
    if (g[i] > maxVal) maxVal = g[i];
    if (b[i] > maxVal) maxVal = b[i];
  }
  return { r, g, b, cols, rows, maxVal };
}

/**
 * Smart Auto-Tone & Auto-White-Balance analysis from raw source RGBA pixels.
 * Uses luminance percentiles (p1, p10, p50, p90, p99), dynamic range spread,
 * midtone chromaticity, and saturation statistics to compute natural, balanced adjustments.
 */
export function computeAutoTone(rgba, width, height) {
  const hist = computeHistogram(rgba, width, height);
  const { luma, total } = hist;

  const pctAt = (p) => {
    const target = total * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += luma[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };

  const p01 = pctAt(0.01);
  const p05 = pctAt(0.05);
  const p15 = pctAt(0.15);
  const p50 = pctAt(0.50);
  const p85 = pctAt(0.85);
  const p95 = pctAt(0.95);
  const p99 = pctAt(0.99);

  // Target median luminance ~0.46 (pleasant natural photographic midtone)
  const medLin = Math.max(0.02, srgbToLinear(p50));
  const targetLin = srgbToLinear(0.46);
  const rawExpo = Math.log2(targetLin / medLin) * 0.55;
  const exposure = clamp(Math.round(rawExpo * 20) / 20, -1.1, 1.1);

  // Dynamic range & contrast
  const spread = p95 - p05;
  let contrast = 0;
  if (spread < 0.65) contrast = clamp((0.65 - spread) * 0.85, 0, 0.42);
  else if (spread > 0.88) contrast = clamp((0.88 - spread) * 0.6, -0.2, 0);

  // Highlights recovery if top end is hot, or gentle lift if dull
  let highlights = 0;
  if (p99 > 0.94 && p85 > 0.72) highlights = clamp(-(p99 - 0.90) * 3.5, -0.55, 0);
  else if (p99 < 0.82) highlights = clamp((0.84 - p99) * 1.4, 0, 0.35);

  // Shadow recovery if shadows are crushed
  let shadows = 0;
  if (p15 < 0.14) shadows = clamp((0.16 - p15) * 2.8, 0, 0.5);
  else if (p05 > 0.18) shadows = clamp(-(p05 - 0.14) * 1.2, -0.25, 0);

  // Whites & Blacks endpoint expansion (gentle)
  let whites = 0;
  if (p99 < 0.90) whites = clamp((0.92 - p99) * 1.2, 0, 0.35);
  else if (p99 > 0.985) whites = -0.15;

  let blacks = 0;
  if (p01 > 0.06) blacks = clamp(-(p01 - 0.03) * 2.2, -0.45, 0);
  else if (p01 < 0.01 && p05 < 0.04) blacks = 0.12;

  // Gray-world / low-chroma white balance estimate (only average mid-luminance pixels)
  let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
  let satSum = 0, satCnt = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const rv = rgba[i] / 255, gv = rgba[i + 1] / 255, bv = rgba[i + 2] / 255;
    const mx = Math.max(rv, gv, bv), mn = Math.min(rv, gv, bv);
    const l = 0.2126 * rv + 0.7152 * gv + 0.0722 * bv;
    if (mx > 0.05) { satSum += (mx - mn) / mx; satCnt++; }
    if (l > 0.12 && l < 0.88) {
      // Down-weight super saturated colors so strong colored objects don't skew WB
      const s = mx > 0.01 ? (mx - mn) / mx : 0;
      const w = s < 0.45 ? 1 : 0.2;
      sumR += srgbToLinear(rv) * w;
      sumG += srgbToLinear(gv) * w;
      sumB += srgbToLinear(bv) * w;
      cnt += w;
    }
  }

  let warmth = 0, tint = 0;
  if (cnt > 10) {
    const mr = sumR / cnt, mg = sumG / cnt, mb = sumB / cnt;
    const avg = (mr + mg + mb) / 3 || 0.18;
    // Gently pull 45% toward neutral so sunset/warm scenes keep their natural mood
    const rErr = (avg - mr) / avg;
    const bErr = (avg - mb) / avg;
    const gErr = (avg - mg) / avg;
    warmth = clamp((rErr - bErr) * 0.45, -0.35, 0.35);
    tint = clamp(-gErr * 0.40, -0.28, 0.28);
  }

  // Subtle vibrance boost for flat/low-sat photos
  const meanSat = satCnt > 0 ? satSum / satCnt : 0.3;
  const vibrance = meanSat < 0.32 ? clamp((0.35 - meanSat) * 0.8, 0, 0.28) : 0;

  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    exposure: r2(exposure),
    contrast: r2(contrast),
    highlights: r2(highlights),
    shadows: r2(shadows),
    whites: r2(whites),
    blacks: r2(blacks),
    warmth: r2(warmth),
    tint: r2(tint),
    vibrance: r2(vibrance),
  };
}

/**
 * Simple immutable snapshot Undo / Redo history stack.
 */
export class HistoryStack {
  constructor(max = 50) {
    this.max = max;
    this.stack = [];
    this.index = -1;
  }

  reset(initialState) {
    this.stack = [JSON.stringify(initialState)];
    this.index = 0;
  }

  push(state) {
    const snap = JSON.stringify(state);
    if (this.index >= 0 && this.stack[this.index] === snap) return false;
    this.stack.length = this.index + 1;
    this.stack.push(snap);
    if (this.stack.length > this.max) {
      this.stack.shift();
    } else {
      this.index++;
    }
    return true;
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index >= 0 && this.index < this.stack.length - 1; }

  undo() {
    if (!this.canUndo) return null;
    this.index--;
    return JSON.parse(this.stack[this.index]);
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    return JSON.parse(this.stack[this.index]);
  }
}

export { linearToSrgb, srgbToLinear };
