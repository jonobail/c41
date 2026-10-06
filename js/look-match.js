// C41 — "Match a photo": fit a film look to any reference photo, on-device.
// See docs/LOOKS.md. Decodes + downscales on the main thread (canvas), fits in a module worker
// (js/match-worker.js) against assets/baseline-pool.bin.
import { trimBorderRect, GRAIN_SHORT_EDGE } from './match-stats.js';

const SMALL_EDGE = 768;          // colour stats / leaks: long edge ≤ 768 px
const GRAIN_MAX_PX = 1.3e6;      // grain analysis: cap pixel count (centre crop beyond this)
const DEADLINE_MS = 11000;       // fit refinement budget; the best fit so far is returned after it

function abortError() {
  try { return new DOMException('Aborted', 'AbortError'); } catch { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) return { c, ctx };
    } catch { /* fall through (Safari < 16.4: no 2d OffscreenCanvas) */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
    } catch { /* fall back to <img> (e.g. options unsupported, HEIC in some engines) */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode failed')); });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function draw(src, sx, sy, sw, sh, w, h) {
  const { ctx } = makeCanvas(w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { w, h, data: d.data };
}

/** Decode + prepare the worker input (exported for tests / tooling). */
export async function prepareReference(file) {
  const im = await decode(file);
  try {
    if (!im.w || !im.h) throw new Error('could not decode image');
    // 1. small copy (whole picture) → border trim, colour sample, edge leaks
    const s = Math.min(1, SMALL_EDGE / Math.max(im.w, im.h));
    const sw = Math.max(1, Math.round(im.w * s)), sh = Math.max(1, Math.round(im.h * s));
    const small = draw(im.src, 0, 0, im.w, im.h, sw, sh);
    const rect = trimBorderRect(small.data, sw, sh);
    // 2. trimmed picture at GRAIN_SHORT_EDGE (never upscaled) → grain
    const fx = im.w / sw, fy = im.h / sh;
    let rx = rect.x * fx, ry = rect.y * fy, rw = rect.w * fx, rh = rect.h * fy;
    const g = Math.min(1, GRAIN_SHORT_EDGE / Math.min(rw, rh));
    let gw = Math.round(rw * g), gh = Math.round(rh * g);
    if (gw * gh > GRAIN_MAX_PX) { // centre crop, same scale
      const k = Math.sqrt(GRAIN_MAX_PX / (gw * gh));
      const cw = Math.round(gw * k), ch = Math.round(gh * k);
      rx += (rw - cw / g) / 2; ry += (rh - ch / g) / 2; rw = cw / g; rh = ch / g; gw = cw; gh = ch;
    }
    const grain = gw >= 64 && gh >= 64 ? draw(im.src, rx, ry, rw, rh, gw, gh) : null;
    return { small, rect, grain, size: [im.w, im.h] };
  } finally {
    im.close();
  }
}

/**
 * Fit a look to a reference photo.
 * @param {File|Blob} file
 * @param {{ onProgress?: (p:number)=>void, signal?: AbortSignal, deadlineMs?: number }} [opts]
 * @returns {Promise<{ film, effects: {grain, leak, leakStyle}, grainParams: {amount,size,color}, stats }>}
 *   Rejects with an AbortError (name === 'AbortError') when `signal` aborts.
 */
export async function matchLook(file, { onProgress, signal, deadlineMs = DEADLINE_MS } = {}) {
  const t0 = performance.now();
  const report = (p) => { try { onProgress && onProgress(Math.max(0, Math.min(1, p))); } catch { /* ignore UI errors */ } };
  if (signal && signal.aborted) throw abortError();
  report(0);
  const ref = await prepareReference(file);
  if (signal && signal.aborted) throw abortError();
  const tDecode = performance.now() - t0;
  report(0.05);

  const worker = new Worker(new URL('./match-worker.js', import.meta.url), { type: 'module' });
  let onAbort = null;
  try {
    const result = await new Promise((resolve, reject) => {
      onAbort = () => { worker.terminate(); reject(abortError()); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') report(0.05 + 0.95 * m.p);
        else if (m.type === 'result') resolve(m.result);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => { e.preventDefault && e.preventDefault(); reject(new Error(e.message || 'match worker failed')); };
      const transfer = [ref.small.data.buffer];
      if (ref.grain) transfer.push(ref.grain.data.buffer);
      worker.postMessage({ type: 'match', small: ref.small, rect: ref.rect, grain: ref.grain, opts: { deadline: deadlineMs } }, transfer);
    });
    result.stats.timings = { decodeMs: Math.round(tDecode), totalMs: Math.round(performance.now() - t0) };
    result.stats.size = ref.size;
    report(1);
    return result;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    worker.terminate();
  }
}
