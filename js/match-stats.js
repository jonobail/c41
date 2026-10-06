// C41 — colour / grain / leak statistics for "Match a photo" (pure, no DOM; runs in Node, workers
// and the main thread). The pool statistics (poolStats / statDistance) are the single source of
// truth shared with the Node fitter: calibration/stats.mjs re-exports them from here.

export const QUANTILES = [0.01, 0.03, 0.07, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.93, 0.97, 0.99];
export const LUMA_BINS = [0, 0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0001];
export const HUE_BANDS = [0, 30, 60, 120, 180, 240, 270, 300]; // matches film-transform HSL bands

const LR = 0.2126, LG = 0.7152, LB = 0.0722;

/** Deterministic LCG subsample of a uint8 RGB triplet buffer → Float32Array of sRGB 0..1 triplets. */
export function poolFromU8(u8, max = Infinity, seed = 7) {
  const n = Math.floor(u8.length / 3);
  const take = Math.min(n, max);
  const out = new Float32Array(take * 3);
  let s = seed >>> 0;
  for (let i = 0; i < take; i++) {
    let j = i;
    if (take < n) { s = (s * 1664525 + 1013904223) >>> 0; j = s % n; }
    out[i * 3] = u8[j * 3] / 255; out[i * 3 + 1] = u8[j * 3 + 1] / 255; out[i * 3 + 2] = u8[j * 3 + 2] / 255;
  }
  return out;
}

function hueOf(r, g, b, mx, c) {
  let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function nearestBand(h) {
  let best = 0, bd = 999;
  for (let i = 0; i < HUE_BANDS.length; i++) {
    const d = Math.min(Math.abs(h - HUE_BANDS[i]), 360 - Math.abs(h - HUE_BANDS[i]));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Stats of an sRGB pool:
 *  q:     luma quantiles (QUANTILES)
 *  cast:  per luma bin, mean (r-Y, g-Y, b-Y)       — colour casts by tone
 *  chroma:per luma bin, mean (max-min)              — saturation by tone
 *  band:  per hue band, [mean chroma, mean luma, fraction] of pixels with chroma > 0.08
 *  mono:  overall mean chroma (B&W detection)
 */
export function poolStats(px) {
  const n = px.length / 3;
  const Y = new Float32Array(n);
  const nb = LUMA_BINS.length - 1;
  const cast = Array.from({ length: nb }, () => [0, 0, 0]), chroma = new Array(nb).fill(0), cnt = new Array(nb).fill(0);
  const band = HUE_BANDS.map(() => [0, 0, 0]);
  let mono = 0;
  for (let i = 0; i < n; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = y;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let k = 0; while (k < nb - 1 && y >= LUMA_BINS[k + 1]) k++;
    cast[k][0] += r - y; cast[k][1] += g - y; cast[k][2] += b - y; chroma[k] += c; cnt[k]++;
    mono += c;
    if (c > 0.08) { const bi = nearestBand(hueOf(r, g, b, mx, c)); band[bi][0] += c; band[bi][1] += y; band[bi][2]++; }
  }
  Y.sort();
  return {
    q: QUANTILES.map((p) => Y[Math.min(n - 1, Math.floor(p * n))]),
    cast: cast.map((c, k) => (cnt[k] > 50 ? c.map((v) => v / cnt[k]) : null)),
    chroma: chroma.map((c, k) => (cnt[k] > 50 ? c / cnt[k] : null)),
    band: band.map(([c, y, m]) => (m > 100 ? [c / m, y / m, m / n] : null)),
    mono: mono / n,
  };
}

/** Weighted squared distance between two stat objects (skips bins missing on either side). */
export function statDistance(a, b, { bw = false } = {}) {
  let d = 0;
  for (let i = 0; i < a.q.length; i++) d += 4 * (a.q[i] - b.q[i]) ** 2;
  if (bw) return d;
  for (let k = 0; k < a.cast.length; k++) {
    if (a.cast[k] && b.cast[k]) for (let c = 0; c < 3; c++) d += 6 * (a.cast[k][c] - b.cast[k][c]) ** 2;
    if (a.chroma[k] != null && b.chroma[k] != null) d += 3 * (a.chroma[k] - b.chroma[k]) ** 2;
  }
  for (let i = 0; i < a.band.length; i++) {
    if (!a.band[i] || !b.band[i]) continue;
    const w = Math.min(1, 20 * Math.min(a.band[i][2], b.band[i][2])); // trust populated bands more
    d += w * (1.5 * (a.band[i][0] - b.band[i][0]) ** 2 + 0.75 * (a.band[i][1] - b.band[i][1]) ** 2);
  }
  return d;
}

/**
 * Stats for single-photo matching: poolStats' q / cast / chroma / band plus
 *  ncast:   per luma bin, mean (r-Y, g-Y, b-Y) of the 35 % least chromatic pixels of that bin —
 *           what neutrals (walls, white objects, grey) become: the look's cast, largely free of
 *           the scene's dominant colours (skin, foliage).
 *  binFrac: fraction of pixels per luma bin.
 */
export function matchStats(px) {
  const n = px.length / 3, nb = LUMA_BINS.length - 1, CH = 64;
  const Y = new Float32Array(n), C = new Float32Array(n), K = new Uint8Array(n);
  const cast = Array.from({ length: nb }, () => [0, 0, 0]), chroma = new Array(nb).fill(0), cnt = new Array(nb).fill(0);
  const hist = Array.from({ length: nb }, () => new Uint32Array(CH));
  const band = HUE_BANDS.map(() => [0, 0, 0]);
  let mono = 0;
  for (let i = 0; i < n; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    const y = LR * r + LG * g + LB * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let k = 0; while (k < nb - 1 && y >= LUMA_BINS[k + 1]) k++;
    Y[i] = y; C[i] = c; K[i] = k;
    cast[k][0] += r - y; cast[k][1] += g - y; cast[k][2] += b - y; chroma[k] += c; cnt[k]++;
    hist[k][Math.min(CH - 1, Math.floor(c * CH))]++;
    mono += c;
    if (c > 0.08) { const bi = nearestBand(hueOf(r, g, b, mx, c)); band[bi][0] += c; band[bi][1] += y; band[bi][2]++; }
  }
  // per-bin chroma threshold for the least chromatic 35 %
  const thr = hist.map((h, k) => {
    const want = cnt[k] * 0.35; let acc = 0;
    for (let j = 0; j < CH; j++) { acc += h[j]; if (acc >= want) return (j + 1) / CH; }
    return 1;
  });
  const ncast = Array.from({ length: nb }, () => [0, 0, 0]), ncnt = new Array(nb).fill(0);
  for (let i = 0; i < n; i++) {
    const k = K[i];
    if (C[i] > thr[k]) continue;
    const y = Y[i];
    ncast[k][0] += px[i * 3] - y; ncast[k][1] += px[i * 3 + 1] - y; ncast[k][2] += px[i * 3 + 2] - y; ncnt[k]++;
  }
  const Ys = Y.slice().sort();
  return {
    q: QUANTILES.map((p) => Ys[Math.min(n - 1, Math.floor(p * n))]),
    cast: cast.map((c, k) => (cnt[k] > 50 ? c.map((v) => v / cnt[k]) : null)),
    ncast: ncast.map((c, k) => (cnt[k] > 50 && ncnt[k] > 10 ? c.map((v) => v / ncnt[k]) : null)),
    chroma: chroma.map((c, k) => (cnt[k] > 50 ? c / cnt[k] : null)),
    band: band.map(([c, y, m]) => (m > 100 ? [c / m, y / m, m / n] : null)),
    mono: mono / n,
    binFrac: cnt.map((c) => c / n),
  };
}

// ---------------------------------------------------------------------------------------------
// Single-photo match distance. One reference photo's *content* (a high-key nursery, a sunset)
// biases its luma distribution, but its black floor and white ceiling are the look: weight the
// extreme quantiles up and the content-driven middle down. Likewise the cast of the reference's
// near-neutral pixels (ncast) defines the look's tint far better than the mean cast (skin, a
// lavender shirt…), so ncast carries most of the cast weight. Per-tone-band terms are weighted
// by how well the band is populated in the reference; hue bands only count when both sides have
// a decent population.
export const MATCH_QW = [12, 10, 7, 4, 2.4, 1.6, 1.4, 1.6, 2.4, 4, 7, 10, 12];
const BAND_MIN_FRAC = 0.03;

/** `t` is the target (reference) stats — its population decides the per-bin trust. */
export function matchDistance(s, t) {
  let d = 0;
  for (let i = 0; i < t.q.length; i++) d += MATCH_QW[i] * (s.q[i] - t.q[i]) ** 2;
  for (let k = 0; k < t.cast.length; k++) {
    const f = t.binFrac ? t.binFrac[k] : 1;
    const w = Math.min(1, f * 12); // a bin holding ≥ 8 % of the reference counts fully
    if (w <= 0) continue;
    if (s.ncast && t.ncast && s.ncast[k] && t.ncast[k]) for (let c = 0; c < 3; c++) d += 12 * w * (s.ncast[k][c] - t.ncast[k][c]) ** 2;
    if (s.cast[k] && t.cast[k]) for (let c = 0; c < 3; c++) d += 2 * w * (s.cast[k][c] - t.cast[k][c]) ** 2;
    if (s.chroma[k] != null && t.chroma[k] != null) d += 4 * w * (s.chroma[k] - t.chroma[k]) ** 2;
  }
  for (let i = 0; i < t.band.length; i++) {
    if (!s.band[i] || !t.band[i]) continue;
    const m = Math.min(s.band[i][2], t.band[i][2]);
    if (m < BAND_MIN_FRAC) continue;
    const w = Math.min(1, 12 * m);
    d += w * (1.2 * (s.band[i][0] - t.band[i][0]) ** 2 + 0.5 * (s.band[i][1] - t.band[i][1]) ** 2);
  }
  return d;
}

// ---------------------------------------------------------------------------------------------
// Image analysis on RGBA (ImageData-like) buffers. `rect` = { x, y, w, h } in pixels.

/** Port of calibration/measure.py trim_border: strip near-black / near-white uniform scan borders. */
export function trimBorderRect(rgba, w, h) {
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / (3 * 255);
      rows[y] += v; cols[x] += v;
    }
  }
  for (let y = 0; y < h; y++) rows[y] /= w;
  for (let x = 0; x < w; x++) cols[x] /= h;
  const edge = (arr, rev, limit) => {
    let n = 0;
    for (let k = 0; k < limit; k++) {
      const v = arr[rev ? arr.length - 1 - k : k];
      if (v < 0.07 || v > 0.95) n++; else break;
    }
    return n;
  };
  const t = edge(rows, false, Math.floor(h / 6)), b = edge(rows, true, Math.floor(h / 6));
  const l = edge(cols, false, Math.floor(w / 6)), r = edge(cols, true, Math.floor(w / 6));
  const trimmed = t + b + l + r > 0;
  const ph = trimmed ? Math.floor(h * 0.01) : 0, pw = trimmed ? Math.floor(w * 0.01) : 0;
  const x0 = l + pw, y0 = t + ph;
  return { x: x0, y: y0, w: Math.max(1, w - r - pw - x0), h: Math.max(1, h - b - ph - y0), trimmed };
}

/** Deterministic sample of ~n sRGB 0..1 triplets from `rect` shrunk by `margin` (fraction) per side. */
export function samplePixels(rgba, w, h, rect, n = 12000, margin = 0.06, seed = 12345) {
  const mx = Math.floor(rect.w * margin), my = Math.floor(rect.h * margin);
  const x0 = rect.x + mx, y0 = rect.y + my, rw = Math.max(1, rect.w - 2 * mx), rh = Math.max(1, rect.h - 2 * my);
  const total = rw * rh, take = Math.min(n, total);
  const out = new Float32Array(take * 3);
  let s = seed >>> 0;
  for (let i = 0; i < take; i++) {
    let k = i;
    if (take < total) { s = (s * 1664525 + 1013904223) >>> 0; k = s % total; }
    const px = x0 + (k % rw), py = y0 + Math.floor(k / rw);
    const j = (py * w + px) * 4;
    out[i * 3] = rgba[j] / 255; out[i * 3 + 1] = rgba[j + 1] / 255; out[i * 3 + 2] = rgba[j + 2] / 255;
  }
  return out;
}

// separable Gaussian blur of a Float32Array plane (clamped edges), in place via `tmp`
function blurPlane(src, w, h, sigma, tmp, dst) {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; a += k[i + r] * src[o + xx]; }
      tmp[o + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; a += k[i + r] * tmp[yy * w + x]; }
      dst[y * w + x] = a;
    }
  }
}

// Renderer grain weight by luma (renderer.js: w = 0.15 + 0.85 * clamp(4 L (1 - L)))
const grainLumaWeight = (L) => 0.15 + 0.85 * Math.min(1, Math.max(0, 4 * L * (1 - L)));

/**
 * Grain / noise level of an image: std of a fine high-pass (σ 1.5 px) in the flattest mid-tone
 * 16 px blocks (low percentile over blocks, so texture and edges don't count), normalised by the
 * renderer's grain luma weighting. Also the R/G/B high-pass correlation in those blocks
 * (≈ 1 → monochrome grain, lower → colour grain).
 * Intended input: the reference scaled to a short edge of GRAIN_SHORT_EDGE px.
 * @returns {{ std:number|null, corr:number|null, blocks:number }}
 */
export function grainEstimate(rgba, w, h, rect = { x: 0, y: 0, w, h }) {
  const W = rect.w, H = rect.h, N = W * H;
  const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const tmp = new Float32Array(N), bl = new Float32Array(N), smooth = new Float32Array(N);
  const hp = ch; // each channel plane becomes its high-pass in place
  const LW = [LR, LG, LB];
  for (let c = 0; c < 3; c++) {
    const p = ch[c];
    for (let y = 0; y < H; y++) {
      const ro = ((rect.y + y) * w + rect.x) * 4 + c;
      for (let x = 0; x < W; x++) p[y * W + x] = rgba[ro + x * 4] / 255;
    }
    blurPlane(p, W, H, 1.5, tmp, bl);
    for (let i = 0; i < N; i++) { p[i] -= bl[i]; smooth[i] += LW[c] * bl[i]; }
  }
  const B = 16, bx = Math.floor(W / B), by = Math.floor(H / B);
  const blocks = [];
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      let sy = 0, sy2 = 0, hy = 0, hy2 = 0, lo = 1, hi = 0;
      for (let y = j * B; y < j * B + B; y++) {
        for (let x = i * B; x < i * B + B; x++) {
          const k = y * W + x;
          const L = smooth[k];
          const v = LR * hp[0][k] + LG * hp[1][k] + LB * hp[2][k];
          sy += L; sy2 += L * L; hy += v; hy2 += v * v;
          if (L < lo) lo = L; if (L > hi) hi = L;
        }
      }
      const n = B * B, mean = sy / n;
      if (mean < 0.12 || mean > 0.88 || lo < 0.03 || hi > 0.97) continue; // avoid clipped blocks
      const lowStd = Math.sqrt(Math.max(0, sy2 / n - mean * mean));
      const hstd = Math.sqrt(Math.max(0, hy2 / n - (hy / n) ** 2));
      blocks.push({ i, j, mean, lowStd, hstd, s: hstd / grainLumaWeight(mean) });
    }
  }
  if (blocks.length < 12) return { std: null, corr: null, blocks: blocks.length, flat: 0, confident: false };
  // Flat blocks: no low-frequency variation beyond what grain itself causes (bokeh, walls, sky).
  // Grain lives everywhere, texture doesn't, so the lower part of the flat blocks' high-pass
  // distribution is the grain. Without enough flat blocks fall back to a low percentile of all
  // blocks (untrustworthy: fine texture — foliage, plaster, print — reads as grain).
  // Grain alone leaves lowStd ≈ 0.5 × its high-pass std (σ1.5 blur of the renderer's noise), so
  // the flatness gate scales with a global low percentile of the blocks' high-pass level.
  const hs = blocks.map((b) => b.hstd).sort((a, b) => a - b);
  const gate = Math.min(0.02, 0.006 + 0.6 * hs[Math.floor(hs.length * 0.1)]);
  const flat = blocks.filter((b) => b.lowStd < gate);
  const fs = flat.map((b) => b.s).sort((a, b) => a - b);
  // grain is spatially uniform: its flat blocks' levels are tightly clustered; texture isn't
  const tight = fs.length >= 12 ? fs[Math.floor(fs.length * 0.2)] / fs[Math.floor(fs.length * 0.6)] : 0;
  const confident = flat.length >= Math.max(12, blocks.length * 0.03);
  const src = (confident ? flat : blocks).slice().sort((a, b) => a.s - b.s);
  const std = src[Math.floor(src.length * (confident ? 0.3 : 0.05))].s;
  const sel = src.slice(0, Math.max(6, Math.round(src.length * (confident ? 0.5 : 0.1))));
  // channel correlation of the high-pass in the selected blocks
  let rg = 0, bg = 0, rr = 0, gg = 0, bb = 0;
  for (const { i, j } of sel) {
    for (let y = j * B; y < j * B + B; y++) {
      for (let x = i * B; x < i * B + B; x++) {
        const k = y * W + x, r = hp[0][k], g = hp[1][k], b = hp[2][k];
        rg += r * g; bg += b * g; rr += r * r; gg += g * g; bb += b * b;
      }
    }
  }
  const corr = 0.5 * (rg / Math.sqrt(rr * gg + 1e-20) + bg / Math.sqrt(bb * gg + 1e-20));
  return { std, corr, blocks: blocks.length, flat: flat.length / blocks.length, confident, tight };
}

// Analysis scale for grain: the reference is scaled so its (trimmed) short edge is this many px.
export const GRAIN_SHORT_EDGE = 1024;
// Estimator std per unit of the renderer's uGrain.x at that scale (cell 1 px, sub-pixel atten
// sqrt(1024*0.00045)≈0.68 included below). Calibrated by simulating the shader grain
// (tests/match.test.mjs re-derives it).
export const GRAIN_K = 0.32;
const GRAIN_ATTEN = Math.max(0.5, Math.sqrt(GRAIN_SHORT_EDGE * 0.00045));
// Typical noise floor of clean (denoised) iPhone JPEGs measured by grainEstimate at this scale.
export const GRAIN_FLOOR = 0.0025;

/**
 * Map a grainEstimate() to renderer grain parameters.
 * @returns {{ amount:number, slider:number, color:number, level:number, confidence:number }}
 *   amount → film.grain.amount (0..1), slider → effects.grain (0..2), color → film.grain.color.
 */
export function grainToParams(est) {
  if (!est || est.std == null) return { amount: 0.15, slider: 1, color: 0.3, level: 0, confidence: 0 };
  // colour grain: empirical corr → colour (shader simulation incl. 8-bit quantisation; JPEG 4:2:0
  // suppresses fine chroma noise, so this reads colour grain leniently)
  const dc = 1 - Math.min(1, Math.max(0, est.corr ?? 1));
  const color = dc < 0.16 ? 0 : Math.min(0.6, 0.1 + 0.5 * (dc - 0.16) / 0.5);
  // colour grain spreads energy across channels → less luma high-pass per unit amount
  const g = Math.sqrt(Math.max(0, est.std ** 2 - GRAIN_FLOOR ** 2));
  let level = g / (GRAIN_K * (1 - 0.55 * color) * 0.12 * GRAIN_ATTEN); // = film amount × slider
  // confidence that the measured high-pass is grain rather than fine texture: grain is uniform
  // (tight) and present in many flat blocks; scale the level down when that isn't the case
  const conf = !est.confident ? 0 : Math.min(1, Math.max(0, (est.tight - 0.65) / 0.2)) * Math.min(1, est.flat / 0.25);
  level *= 0.3 + 0.7 * conf;
  let amount = Math.min(1, level), slider = 1;
  if (level > 1) slider = Math.min(2, level);
  if (level < 0.03) amount = 0;
  return { amount: r3(amount), slider: r3(slider), color: r3(color), level: r3(level), confidence: r3(conf) };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Edge light-leak analysis. Leaks are tinted glows that are strongest at a frame edge and fade
 * inward, often only along part of the edge. Each side is cut into 4 segments; per segment the
 * chroma (rgb − Y) of an outer strip (0–6 % deep) is compared with a strip 15–30 % in, and the
 * 6–15 % strip must lie in between (a gradient, not a hard content edge). Comparing with the same
 * segment further in (instead of the picture centre) keeps the subject's colour out of it. The
 * film transform is spatially uniform, so these edge gradients can't be explained by the fit.
 * @returns {{ sides: object, leak: number, leakStyle: 'warm'|'prism', warmSide: string|null }}
 */
export function edgeLeaks(rgba, w, h, rect = { x: 0, y: 0, w, h }) {
  const mean = (x0, y0, x1, y1) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.max(x0 + 1, Math.round(x1)); y1 = Math.max(y0 + 1, Math.round(y1));
    let r = 0, g = 0, b = 0, n = 0;
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 3000)));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * w + x) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
      }
    }
    r /= 255 * n; g /= 255 * n; b /= 255 * n;
    const Y = LR * r + LG * g + LB * b;
    return { c: [r - Y, g - Y, b - Y], Y };
  };
  const { x, y, w: W, h: H } = rect;
  // strip of `side`, depth a..b (fraction of the perpendicular size), along-side span s0..s1
  const strip = (side, a, b, s0, s1) => {
    switch (side) {
      case 'left': return mean(x + a * W, y + s0 * H, x + b * W, y + s1 * H);
      case 'right': return mean(x + (1 - b) * W, y + s0 * H, x + (1 - a) * W, y + s1 * H);
      case 'top': return mean(x + s0 * W, y + a * H, x + s1 * W, y + b * H);
      default: return mean(x + s0 * W, y + (1 - b) * H, x + s1 * W, y + (1 - a) * H);
    }
  };
  const sides = {};
  for (const side of ['left', 'right', 'top', 'bottom']) {
    let best = null;
    for (let sg = 0; sg < 4; sg++) {
      const s0 = sg / 4, s1 = (sg + 1) / 4;
      const o = strip(side, 0, 0.06, s0, s1), m = strip(side, 0.06, 0.15, s0, s1), n = strip(side, 0.15, 0.3, s0, s1);
      const d = o.c.map((v, k) => v - n.c[k]);
      const mag = Math.hypot(...d);
      if (mag < 1e-6) continue;
      const u = d.map((v) => v / mag);
      const mid = ((m.c[0] - n.c[0]) * u[0] + (m.c[1] - n.c[1]) * u[1] + (m.c[2] - n.c[2]) * u[2]) / mag;
      const grad = mid > -0.1 && mid < 1.05 ? 1 : 0.3;          // gradual fall-off toward the inside
      const lift = o.Y - n.Y;
      const bright = Math.min(1, Math.max(0, 1 + lift / 0.1)); // leaks are screened on, never darken
      const score = mag * grad * bright; // ranks the segments of a side
      if (!best || score > best.score) {
        best = {
          seg: sg, tint: d.map(r4), mag: r4(mag), mid: r4(mid), lift: r4(lift), score: r4(score),
          warm: r4(d[0] - d[2]), cool: r4(0.5 * (d[1] + d[2]) - d[0]),
        };
      }
    }
    sides[side] = best || { seg: -1, tint: [0, 0, 0], mag: 0, mid: 0, lift: 0, score: 0, warm: 0, cool: 0 };
  }
  // A single photo can't tell a tinted edge from content (sky, a window, a wall), so require a
  // strong signature: PRISM = warm gradient on one edge AND cool/green gradient on the opposite
  // edge (min of the two); WARM = a strong, brightening warm gradient on one edge. Thresholds
  // were set on 130 ordinary iPhone photos (≈ 16 % false prism, ≈ 5 % false warm).
  const opp = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const okGrad = (q) => q.mid > -0.1 && q.mid < 1.05;
  let prism = 0, pWarm = null;
  for (const a of Object.keys(sides)) {
    const A = sides[a], B = sides[opp[a]];
    if (!okGrad(A) || !okGrad(B)) continue;
    const v = Math.min(A.warm, B.cool);
    if (v > prism) { prism = v; pWarm = a; }
  }
  let warm = 0, wSide = null;
  for (const a of Object.keys(sides)) {
    const A = sides[a];
    if (!okGrad(A) || A.lift < 0.05) continue;
    if (A.warm > warm) { warm = A.warm; wSide = a; }
  }
  let leak = 0, leakStyle = 'warm', warmSide = null;
  if (prism > LEAK_PRISM_T) {
    leakStyle = 'prism'; warmSide = pWarm;
    leak = Math.min(1, 0.35 + 20 * (prism - LEAK_PRISM_T));
  } else if (warm > LEAK_WARM_T) {
    warmSide = wSide;
    leak = Math.min(1, 0.3 + 3 * (warm - LEAK_WARM_T));
  }
  return { sides, leak: r3(leak), leakStyle, warmSide, score: { prism: r4(prism), warm: r4(warm) } };
}
export const LEAK_PRISM_T = 0.075;
export const LEAK_WARM_T = 0.27;


const r4 = (v) => Math.round(v * 1e4) / 1e4;
