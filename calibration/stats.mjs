// Colour statistics shared by the offline calibration fitter: computed identically on a reference
// film pool and on the baseline pool after it has been pushed through makeFilm.
import { readFileSync, existsSync } from 'node:fs';

export const QUANTILES = [0.01, 0.03, 0.07, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.93, 0.97, 0.99];
export const LUMA_BINS = [0, 0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0001];
export const HUE_BANDS = [0, 30, 60, 120, 180, 240, 270, 300];

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
    const w = Math.min(1, 20 * Math.min(a.band[i][2], b.band[i][2]));
    d += w * (1.5 * (a.band[i][0] - b.band[i][0]) ** 2 + 0.75 * (a.band[i][1] - b.band[i][1]) ** 2);
  }
  return d;
}

/** Load a measured pool as Float32Array of sRGB 0..1 triplets, optionally subsampled to `max` pixels. */
export function loadPool(path, max = Infinity, seed = 7) {
  if (!existsSync(path)) return null;
  return poolFromU8(readFileSync(path), max, seed);
}
