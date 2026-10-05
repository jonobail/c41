// C41 — full-resolution strip export (docs/ARCHITECTURE.md §9).
//
// The full image is rendered in horizontal strips (≈4 MP incl. PAD rows above/below so
// neighbourhood effects are seamless) and streamed into the JPEG worker, keeping peak
// memory at a few strips — iOS Safari can't hold a 12–48 MP canvas.
//
// Coordinates passed to renderRegion are in OUTPUT px (the image possibly downscaled by `s`
// to fit GPU limits): full = [outW, outH], scale = outShort / origShort, and
// params.fullShort = origShort (ORIGINAL short edge), so grain etc. size identically to preview.
//
// NOTE: the Uint8Array returned by renderer.renderRegion is transferred to the worker
// (its buffer is detached) — the renderer must return a fresh array per call.

export const PAD = 64;
const STRIP_PIXELS = 4_000_000;
const MAX_IN_FLIGHT = 2;

function abortError() {
  try { return new DOMException('Export aborted', 'AbortError'); } catch {
    const e = new Error('Export aborted'); e.name = 'AbortError'; return e;
  }
}

const nextTask = () => new Promise((r) => setTimeout(r, 0));

/** Output geometry for an image of W×H under renderer limits. Exported for tests. */
export function planExport(W, H, limits) {
  const lim = limits || {};
  const vp = Array.isArray(lim.maxViewport) ? lim.maxViewport : [lim.maxViewport, lim.maxViewport];
  const cands = [lim.maxTexture, lim.maxRenderbuffer, vp[0], vp[1]].filter((v) => Number.isFinite(v) && v > 0);
  const maxDim = cands.length ? Math.min(...cands) : 4096;
  const s = Math.min(1, maxDim / Math.max(W, H));
  const outW = Math.min(maxDim, Math.max(1, Math.round(W * s)));
  const outH = Math.min(maxDim, Math.max(1, Math.round(H * s)));
  const stripH = Math.max(16, Math.floor((STRIP_PIXELS / outW - 2 * PAD) / 16) * 16);
  return { s, outW, outH, stripH, scale: Math.min(outW, outH) / Math.min(W, H), fullShort: Math.min(W, H) };
}

export async function exportJpeg({
  renderer, image, params, quality = 92, exifDate = null,
  onProgress = () => {}, signal, proxy = null,
}) {
  if (signal?.aborted) throw abortError();
  const W = image.naturalWidth || image.videoWidth || image.width;
  const H = image.naturalHeight || image.videoHeight || image.height;
  if (!(W > 0 && H > 0)) throw new Error('export: image has no size');

  const { s, outW, outH, stripH, scale, fullShort } = planExport(W, H, renderer.limits);
  const canvasH = stripH + 2 * PAD;

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

    canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('export: 2D canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    renderer.setParams({ ...params, split: -1, showOriginal: false, fullShort });
    onProgress(0);

    for (let y0 = 0; y0 < outH; y0 += stripH) {
      while (inFlight >= MAX_IN_FLIGHT) await race(new Promise((r) => { wake = r; }));
      if (signal?.aborted) throw abortError();

      const hs = Math.min(stripH, outH - y0);
      const top = y0 - PAD;                                  // canvas row 0 in output px
      const vTop = Math.max(0, top);
      const vBot = Math.min(outH, y0 + stripH + PAD);
      ctx.clearRect(0, 0, outW, canvasH);
      // Only in-bounds source rects (Safari draws nothing for out-of-bounds ones).
      const sy = vTop / s;
      const sh = Math.min(H - sy, (vBot - vTop) / s);
      if (sh > 0) ctx.drawImage(image, 0, sy, W, sh, 0, vTop - top, outW, vBot - vTop);

      renderer.setSource(canvas);
      const px = renderer.renderRegion({
        srcOrigin: [0, top], srcSize: [outW, canvasH], full: [outW, outH],
        outOrigin: [0, y0], outSize: [outW, hs], scale,
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
    try {
      if (proxy) renderer.setSource(proxy);
      renderer.setParams(params);
    } catch { /* context lost etc. — app re-sends on restore */ }
  }
}
