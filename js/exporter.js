// C41 — full-resolution strip export (docs/ARCHITECTURE.md §9).
//
// The output is rendered in horizontal strips (≈4 MP incl. pad rows above/below so
// neighbourhood effects are seamless) and streamed into the JPEG worker, keeping peak
// memory at a few strips — iOS Safari can't hold a 12–48 MP canvas.
//
// Geometry (params.layout from overlays.frameLayout, optional): the camera FRAME is a crop rect
// of the source image; the OUTPUT is the frame plus an optional border. Everything is planned
// in full-res px and scaled by `s` (≤ 1, to fit GPU limits). For each strip of output rows we
// draw the matching source rows (frame columns ± pad, clamped to the image) into a reusable
// 2D canvas, and — if there is a border — the matching rows of the border into a second canvas.
// The pad is PAD + renderer.lensReach (distortion / blur / CA can sample far from a pixel).
//
// renderRegion coords are OUTPUT-render px: full = whole image × s, crop = frame × s,
// inner = frame origin in output, scale = s, params.fullShort = frame short edge (full res),
// so grain etc. size identically to the preview.
//
// Remapped lenses (camera.grid / camera.fisheye) sample the source far away from each output
// pixel, so the fixed "frame columns ± pad" band doesn't work. For them each strip uploads the
// source rect renderer.remapSourceRect() says it needs (the JS twin of the shader's mapping, plus
// the lens reach), aligned to a 32 px grid so the mip pyramids of neighbouring strips line up,
// and — where the remap minifies (grid cells) — downsampled by a power of two (texK) so it stays
// small; the shader picks the mip level from texK, just as the preview does from the proxy.
//
// NOTE: the Uint8Array returned by renderer.renderRegion is transferred to the worker
// (its buffer is detached) — the renderer must return a fresh array per call.

import { lensReach, remapGeometry, remapSourceRect } from './renderer.js';

export const PAD = 64;
const STRIP_PIXELS = 4_000_000;
const REMAP_SRC_PIXELS = 16_000_000;   // cap for one remapped strip's source upload
const ALIGN = 32;

/**
 * Source upload for one strip of a remapped lens (render px). G = planExport result,
 * RG = remapGeometry in render px, reach = lens reach in lens px, maxDim = GPU limit.
 * Returns { x, y, w, h, texK } — rect in whole-image render px (aligned, clamped) and the texels
 * per render px to draw it at. Exported for tests.
 */
export function remapStripSource(G, RG, y0, hs, reach, maxDim = 16384, budget = REMAP_SRC_PIXELS) {
  const pad = PAD;
  const fy0 = y0 - G.inner[1] - pad, fy1 = y0 + hs - G.inner[1] + pad;
  const fr = [-pad, fy0, G.crop[2] + pad, fy1];
  const r = remapSourceRect(RG, fr, reach);
  const iw = Math.round(G.img[0]), ih = Math.round(G.img[1]);
  if (!r) return { x: 0, y: 0, w: Math.min(iw, ALIGN), h: Math.min(ih, ALIGN), texK: 1 };
  let [x0, y0r, x1, y1] = r.rect;
  x0 = Math.max(0, Math.floor((x0 - pad) / ALIGN) * ALIGN);
  y0r = Math.max(0, Math.floor((y0r - pad) / ALIGN) * ALIGN);
  x1 = Math.min(iw, Math.ceil((x1 + pad) / ALIGN) * ALIGN);
  y1 = Math.min(ih, Math.ceil((y1 + pad) / ALIGN) * ALIGN);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0r);
  // texels per render px: the remap never needs more than 1 / jMin (rounded to a power of two)
  let texK = Math.min(1, Math.pow(2, -Math.floor(Math.log2(Math.max(1, r.jMin)))));
  while (texK > 1 / 64 && (w * h * texK * texK > budget || Math.max(w, h) * texK > maxDim)) texK /= 2;
  return { x: x0, y: y0r, w, h, texK };
}
const MAX_IN_FLIGHT = 2;

function abortError() {
  try { return new DOMException('Export aborted', 'AbortError'); } catch {
    const e = new Error('Export aborted'); e.name = 'AbortError'; return e;
  }
}

const nextTask = () => new Promise((r) => setTimeout(r, 0));

/**
 * Output geometry for an image of W×H under renderer limits. Exported for tests.
 * layout: { crop: [x,y,w,h], inner: [l,t], out: [w,h] } in full-res px (default: whole image).
 * reach: extra neighbourhood (frame px at full res) the lens may sample — see lensReach.
 */
export function planExport(W, H, limits, layout = null, reach = 0, stripPixels = STRIP_PIXELS) {
  const lim = limits || {};
  const vp = Array.isArray(lim.maxViewport) ? lim.maxViewport : [lim.maxViewport, lim.maxViewport];
  const cands = [lim.maxTexture, lim.maxRenderbuffer, vp[0], vp[1]].filter((v) => Number.isFinite(v) && v > 0);
  const maxDim = cands.length ? Math.min(...cands) : 4096;
  const crop = layout && layout.crop ? layout.crop : [0, 0, W, H];
  const inner = layout && layout.inner ? layout.inner : [0, 0];
  const out = layout && layout.out ? layout.out : [crop[2], crop[3]];
  let s = Math.min(1, maxDim / Math.max(out[0], out[1]));
  let pad = PAD + Math.ceil(reach * s);
  // the source strip canvas spans the frame columns ± pad: keep that inside the limits too
  if (Math.min(W * s, crop[2] * s + 2 * pad) > maxDim) {
    s = Math.min(s, Math.max(maxDim / W, (maxDim - 2 * pad) / crop[2]));
    pad = PAD + Math.ceil(reach * s);
  }
  const outW = Math.min(maxDim, Math.max(1, Math.round(out[0] * s)));
  const outH = Math.min(maxDim, Math.max(1, Math.round(out[1] * s)));
  const stripH = Math.max(16, Math.floor((stripPixels / outW - 2 * pad) / 16) * 16);
  // no layout: the frame is the whole (rounded) output — identical to the pre-crop contract
  const plain = !layout;
  const img = plain ? [outW, outH] : [W * s, H * s];
  const cropR = plain ? [0, 0, outW, outH] : crop.map((v) => v * s);
  const innerR = inner.map((v) => v * s);
  // source canvas columns (render px of the whole image), integer, in-bounds
  const sx0 = Math.max(0, Math.floor(cropR[0] - pad));
  const sx1 = Math.min(Math.round(img[0]), Math.ceil(cropR[0] + cropR[2] + pad));
  return {
    s, outW, outH, stripH, pad, img, crop: cropR, inner: innerR, sx0, srcW: Math.max(1, sx1 - sx0),
    scale: plain ? Math.min(outW, outH) / Math.min(W, H) : s, fullShort: Math.min(crop[2], crop[3]),
  };
}

export async function exportJpeg({
  renderer, image, params, quality = 92, exifDate = null,
  onProgress = () => {}, signal, proxy = null, previewFrame = null,
  stripPixels = STRIP_PIXELS,          // test hook: force small strips to check seams
}) {
  if (signal?.aborted) throw abortError();
  const W = image.naturalWidth || image.videoWidth || image.width;
  const H = image.naturalHeight || image.videoHeight || image.height;
  if (!(W > 0 && H > 0)) throw new Error('export: image has no size');

  const layout = params && params.layout && params.layout.crop ? params.layout : null;
  const crop0 = layout ? layout.crop : [0, 0, W, H];
  const reach = lensReach(params && params.camera, params && params.camAmt, crop0[2], crop0[3]);
  const camera = params && params.camera;
  const remap = !!(camera && (camera.grid || camera.fisheye));
  // remapped lenses don't use the column band (reach is applied per strip in remapStripSource)
  const G = planExport(W, H, renderer.limits, layout, remap ? 0 : reach, stripPixels);
  const { s, outW, outH, stripH, pad, scale, fullShort } = G;
  const canvasH = stripH + 2 * pad;
  const drawFrame = layout && typeof layout.draw === 'function' ? layout.draw : null;
  let fcanvas = null;

  let worker = null;
  let canvas = null;
  let onAbort = null;
  let fail;                                   // reject fn of the failure promise
  const failed = new Promise((_, rej) => { fail = rej; });
  failed.catch(() => {});
  let doneResolve;
  const done = new Promise((res) => { doneResolve = res; });
  let inFlight = 0;
  let wake = null;
  let consumedRows = 0;

  const race = (p) => Promise.race([p, failed]);

  try {
    if (signal) {
      onAbort = () => { worker?.terminate(); fail(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    worker = new Worker(new URL('./jpeg-worker.js', import.meta.url));
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'consumed') {
        inFlight--;
        consumedRows += m.rows;
        onProgress(Math.min(0.99, consumedRows / outH));
        if (wake) { const w = wake; wake = null; w(); }
      } else if (m.type === 'done') {
        doneResolve(m.blob);
      } else if (m.type === 'error') {
        fail(new Error('JPEG encoder: ' + m.message));
      }
    };
    worker.onerror = (e) => { e.preventDefault?.(); fail(new Error('JPEG worker failed: ' + (e.message || 'unknown error'))); };
    worker.postMessage({ type: 'start', width: outW, height: outH, quality, exifDate: exifDate || undefined });

    const lim = renderer.limits || {};
    const maxDim = Math.min(...[lim.maxTexture, lim.maxRenderbuffer].filter((v) => Number.isFinite(v) && v > 0), 16384);
    const RG = remap ? remapGeometry(camera, G.img, G.crop, params.seed ?? 1) : null;
    const reachR = remap ? Math.ceil(reach * s) : 0;
    canvas = document.createElement('canvas');
    canvas.width = remap ? 1 : G.srcW;
    canvas.height = remap ? 1 : canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('export: 2D canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    let fctx = null;
    if (drawFrame) {
      fcanvas = document.createElement('canvas');
      fcanvas.width = outW;
      fcanvas.height = stripH;
      fctx = fcanvas.getContext('2d');
    } else {
      renderer.setFrame?.(null);
    }

    renderer.setParams({ ...params, split: -1, showOriginal: false, fullShort });
    onProgress(0);

    const imgH = Math.round(G.img[1]);
    for (let y0 = 0; y0 < outH; y0 += stripH) {
      while (inFlight >= MAX_IN_FLIGHT) await race(new Promise((r) => { wake = r; }));
      if (signal?.aborted) throw abortError();

      const hs = Math.min(stripH, outH - y0);
      let srcOrigin, srcSize, texK = 1;
      if (RG) {
        const R = remapStripSource(G, RG, y0, hs, reachR, maxDim);
        const cw = Math.max(1, Math.round(R.w * R.texK)), chh = Math.max(1, Math.round(R.h * R.texK));
        if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh; }
        else ctx.clearRect(0, 0, cw, chh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const sx = R.x / s, sy = R.y / s;
        const sw = Math.min(W - sx, R.w / s), sh = Math.min(H - sy, R.h / s);
        if (sw > 0 && sh > 0) ctx.drawImage(image, sx, sy, sw, sh, 0, 0, cw, chh);
        srcOrigin = [R.x, R.y]; srcSize = [R.w, R.h]; texK = cw / R.w;
      } else {
        // canvas row 0 in whole-image render px (frame row = output row − inner, image = frame + crop)
        const top = Math.floor(y0 - G.inner[1] + G.crop[1]) - pad;
        const vTop = Math.max(0, top);
        const vBot = Math.min(imgH, top + canvasH);
        ctx.clearRect(0, 0, G.srcW, canvasH);
        // Only in-bounds source rects (Safari draws nothing for out-of-bounds ones).
        if (vBot > vTop) {
          const sy = vTop / s;
          const sh = Math.min(H - sy, (vBot - vTop) / s);
          const sx = G.sx0 / s;
          const sw = Math.min(W - sx, G.srcW / s);
          if (sh > 0 && sw > 0) ctx.drawImage(image, sx, sy, sw, sh, 0, vTop - top, G.srcW, vBot - vTop);
        }
        srcOrigin = [G.sx0, top]; srcSize = [G.srcW, canvasH];
      }
      renderer.setSource(canvas);

      if (fctx) {
        fctx.clearRect(0, 0, outW, stripH);
        drawFrame(fctx, 0, y0, s);
        renderer.setFrame({ canvas: fcanvas, origin: [0, y0], size: [outW, stripH] });
      }

      const px = renderer.renderRegion({
        srcOrigin, srcSize, full: G.img,
        crop: G.crop, inner: G.inner, outFull: [outW, outH],
        outOrigin: [0, y0], outSize: [outW, hs], scale, texK,
      });
      if (!px || px.length < outW * hs * 4) throw new Error('export: renderRegion returned no pixels');

      inFlight++;
      worker.postMessage({ type: 'rows', data: px, rows: hs }, [px.buffer]);
      await race(nextTask());                                // let the UI breathe
    }

    worker.postMessage({ type: 'finish' });
    const blob = await race(done);
    onProgress(1);
    return blob;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    worker?.terminate();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    if (fcanvas) { fcanvas.width = 0; fcanvas.height = 0; }
    try {
      if (proxy) renderer.setSource(proxy);
      if (fcanvas) renderer.setFrame?.(previewFrame || null);
      renderer.setParams(params);
    } catch { /* context lost etc. — app re-sends on restore */ }
  }
}
