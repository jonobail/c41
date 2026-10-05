// Browser checks for the JPEG worker / EXIF reader / exporter, in real Chromium.
//   node tests/jpeg.browser.mjs
// Serves the repo with a tiny static server, launches chromium via playwright, and:
//  - encodes synthetic images in js/jpeg-worker.js (as a real Worker), decodes them with
//    createImageBitmap and checks mean abs error vs source (< 3/255 at q=92),
//  - checks EXIF DateTimeOriginal round-trips through js/exif.js,
//  - runs js/exporter.js end-to-end with a pass-through mock Renderer (multi-strip, with and
//    without GPU-limit downscale) and checks geometry, pixels, seams, abort + restore.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__test.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><title>t</title><body>');
  }
  const f = path.join(root, path.normalize(decodeURIComponent(u.pathname)));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${base}/__test.html`);

  // ---- 1. worker encode → browser decode ----
  const enc = await page.evaluate(async () => {
    function synth(w, h) {
      const a = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, u = x / Math.max(1, w - 1), v = y / Math.max(1, h - 1);
        const blob = Math.exp(-((u - 0.6) ** 2 + (v - 0.4) ** 2) * 12);
        a[i] = 255 * u * (1 - blob) + 230 * blob;
        a[i + 1] = 255 * v * 0.8 + 30 * Math.sin(u * 6);
        a[i + 2] = 128 + 100 * Math.sin((u + v) * 4);
        a[i + 3] = 255;
      }
      return a;
    }
    async function run(w, h, stripRows, quality, exifDate) {
      const src = synth(w, h);
      const worker = new Worker('/js/jpeg-worker.js');
      const consumed = [];
      const blob = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.type === 'consumed') consumed.push(e.data.rows);
          else if (e.data.type === 'done') resolve(e.data.blob);
          else if (e.data.type === 'error') reject(new Error(e.data.message));
        };
        worker.postMessage({ type: 'start', width: w, height: h, quality, exifDate });
        for (let y = 0; y < h; y += stripRows) {
          const r = Math.min(stripRows, h - y);
          const part = new Uint8Array(src.buffer.slice(y * w * 4, (y + r) * w * 4));
          worker.postMessage({ type: 'rows', data: part, rows: r }, [part.buffer]);
        }
        worker.postMessage({ type: 'finish' });
      });
      worker.terminate();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const out = ctx.getImageData(0, 0, w, h).data;
      let err = 0;
      for (let i = 0; i < out.length; i += 4) err += Math.abs(out[i] - src[i]) + Math.abs(out[i + 1] - src[i + 1]) + Math.abs(out[i + 2] - src[i + 2]);
      const { readExifDate } = await import('/js/exif.js');
      const d = await readExifDate(blob);
      return { w, h, type: blob.type, size: blob.size, bw: bmp.width, bh: bmp.height,
        mae: err / (w * h * 3), consumed: consumed.reduce((a, b) => a + b, 0),
        date: d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join(',') };
    }
    const res = [];
    for (const [w, h, s] of [[1, 1, 16], [37, 53, 16], [37, 53, 53], [640, 480, 64], [1001, 777, 48], [17, 400, 32]]) {
      res.push(await run(w, h, s, 92, '2021:03:14 15:09:26'));
    }
    try { await run(4, 4, 16, 92, null); res.push({ nodate: true }); } catch (e) { res.push({ err: e.message }); }
    return res;
  });
  for (const r of enc) {
    if (r.nodate) { check(true, 'encode without exifDate'); continue; }
    if (r.err) { check(false, r.err); continue; }
    check(r.type === 'image/jpeg' && r.bw === r.w && r.bh === r.h, `${r.w}x${r.h} decodes at size (${r.size} B)`);
    check(r.mae < 3, `${r.w}x${r.h} q92 mean abs error ${r.mae.toFixed(3)} < 3`);
    check(r.consumed === r.h, `${r.w}x${r.h} consumed rows ${r.consumed}`);
    check(r.date === '2021,3,14,15,9,26', `${r.w}x${r.h} EXIF DateTimeOriginal round-trip (${r.date})`);
  }

  // ---- 2. worker error path ----
  const errMsg = await page.evaluate(() => new Promise((resolve) => {
    const w = new Worker('/js/jpeg-worker.js');
    w.onmessage = (e) => { if (e.data.type === 'error') resolve(e.data.message); if (e.data.type === 'done') resolve(null); };
    w.postMessage({ type: 'start', width: 8, height: 8, quality: 90 });
    w.postMessage({ type: 'rows', data: new Uint8Array(8 * 4 * 4), rows: 4 });
    w.postMessage({ type: 'finish' });
  }));
  check(/expected 8/.test(errMsg || ''), `worker posts error on short input (${errMsg})`);

  // ---- 3. exporter end-to-end with a pass-through mock renderer ----
  const exp = await page.evaluate(async () => {
    const { exportJpeg, PAD } = await import('/js/exporter.js');
    // source image: 3001×2003 smooth content, delivered as an HTMLImageElement
    const W = 3001, H = 2003;
    const sc = new OffscreenCanvas(W, H), sctx = sc.getContext('2d');
    const g = sctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#203a80'); g.addColorStop(0.5, '#e0a040'); g.addColorStop(1, '#40c070');
    sctx.fillStyle = g; sctx.fillRect(0, 0, W, H);
    const rg = sctx.createRadialGradient(1800, 900, 10, 1800, 900, 700);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = rg; sctx.fillRect(0, 0, W, H);
    const url = URL.createObjectURL(await sc.convertToBlob({ type: 'image/png' }));
    const image = new Image(); image.src = url; await image.decode();

    function mockRenderer(limits) {
      const log = { calls: [], sources: [], params: [] };
      let src = null;
      return {
        log, get limits() { return limits; },
        setSource(c) { src = c; log.sources.push(c === 'PROXY' ? 'PROXY' : 'canvas'); },
        setParams(p) { log.params.push(p); },
        renderRegion(r) {
          log.calls.push(JSON.parse(JSON.stringify(r)));
          const ctx = src.getContext('2d');
          // pass-through: the output rows are the source canvas rows at outOrigin - srcOrigin
          const d = ctx.getImageData(r.outOrigin[0] - r.srcOrigin[0], r.outOrigin[1] - r.srcOrigin[1], r.outSize[0], r.outSize[1]).data;
          // check PAD rows above the image are transparent (nothing drawn out of bounds)
          if (r.srcOrigin[1] < 0) {
            const above = ctx.getImageData(0, 0, src.width, -r.srcOrigin[1]).data;
            log.cleanAbove = above.every((v) => v === 0);
          }
          return new Uint8Array(d.buffer);
        },
      };
    }
    async function decode(blob) {
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0); return { w: bmp.width, h: bmp.height, d: x.getImageData(0, 0, bmp.width, bmp.height).data };
    }
    function compare(a, b, w, h) {
      let err = 0, worstRow = 0, worstY = -1;
      for (let y = 0; y < h; y++) {
        let re = 0;
        for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; re += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); }
        err += re; re /= w * 3; if (re > worstRow) { worstRow = re; worstY = y; }
      }
      return { mae: err / (w * h * 3), worstRow, worstY };
    }
    const out = { PAD };
    const params = { split: 0.5, showOriginal: true, seed: 1, fullShort: 1234 };
    for (const [name, limits] of [['full', { maxTexture: 16384, maxRenderbuffer: 16384, maxViewport: [16384, 16384] }],
      ['downscaled', { maxTexture: 4096, maxRenderbuffer: 2500, maxViewport: [16384, 16384] }]]) {
      const r = mockRenderer(limits);
      const progress = [];
      const blob = await exportJpeg({ renderer: r, image, params, quality: 92, exifDate: '2020:02:29 12:00:01',
        onProgress: (p) => progress.push(p), proxy: 'PROXY' });
      const dec = await decode(blob);
      const ref = new OffscreenCanvas(dec.w, dec.h).getContext('2d');
      ref.imageSmoothingQuality = 'high';
      ref.drawImage(image, 0, 0, dec.w, dec.h);
      const cmp = compare(dec.d, ref.getImageData(0, 0, dec.w, dec.h).data, dec.w, dec.h);
      const { readExifDate } = await import('/js/exif.js');
      const d = await readExifDate(blob);
      out[name] = { w: dec.w, h: dec.h, calls: r.log.calls, sources: r.log.sources, cleanAbove: r.log.cleanAbove,
        firstParams: r.log.params[0], lastParams: r.log.params.at(-1), cmp, progress: [progress[0], progress.at(-1)],
        monotonic: progress.every((p, i) => i === 0 || p >= progress[i - 1]), date: d && d.toISOString() };
    }
    // abort after the first strip
    {
      const r = mockRenderer({ maxTexture: 16384, maxRenderbuffer: 16384, maxViewport: [16384, 16384] });
      const ac = new AbortController();
      const orig = r.renderRegion; r.renderRegion = (x) => { ac.abort(); return orig.call(r, x); };
      try { await exportJpeg({ renderer: r, image, params, signal: ac.signal, proxy: 'PROXY' }); out.abort = 'resolved?!'; } catch (e) { out.abort = e.name; }
      out.abortRestored = r.log.sources.at(-1) === 'PROXY';
      const ac2 = new AbortController(); ac2.abort();
      try { await exportJpeg({ renderer: r, image, params, signal: ac2.signal }); } catch (e) { out.preAbort = e.name; }
    }
    return out;
  });

  const P = exp.PAD;
  for (const name of ['full', 'downscaled']) {
    const e = exp[name];
    const expW = name === 'full' ? 3001 : 2500, expH = name === 'full' ? 2003 : Math.round(2003 * 2500 / 3001);
    check(e.w === expW && e.h === expH, `${name}: output ${e.w}x${e.h} (want ${expW}x${expH})`);
    const stripH = Math.max(16, Math.floor((4e6 / expW - 2 * P) / 16) * 16);
    let y = 0, geomOk = true;
    for (const c of e.calls) {
      const hs = Math.min(stripH, expH - y);
      geomOk &&= c.srcOrigin[0] === 0 && c.srcOrigin[1] === y - P && c.srcSize[0] === expW && c.srcSize[1] === stripH + 2 * P &&
        c.outOrigin[1] === y && c.outSize[0] === expW && c.outSize[1] === hs && c.full[0] === expW && c.full[1] === expH &&
        Math.abs(c.scale - Math.min(expW, expH) / 2003) < 1e-9;
      y += hs;
    }
    check(geomOk && y === expH && e.calls.length >= 2, `${name}: ${e.calls.length} strips of ${stripH} rows, renderRegion geometry`);
    check(e.cleanAbove === true, `${name}: PAD rows above image left transparent`);
    check(e.firstParams.split === -1 && e.firstParams.showOriginal === false && e.firstParams.fullShort === 2003 && e.firstParams.seed === 1,
      `${name}: export params (split -1, showOriginal false, fullShort = original short edge)`);
    check(e.lastParams.split === 0.5 && e.lastParams.fullShort === 1234, `${name}: preview params restored`);
    check(e.sources.at(-1) === 'PROXY', `${name}: proxy source restored`);
    check(e.cmp.mae < 2, `${name}: pixels match source, MAE ${e.cmp.mae.toFixed(3)}`);
    check(e.cmp.worstRow < 4, `${name}: no strip seams, worst row MAE ${e.cmp.worstRow.toFixed(3)} @y=${e.cmp.worstY}`);
    check(e.progress[0] === 0 && e.progress[1] === 1 && e.monotonic, `${name}: progress 0 → 1 monotonic`);
    check(e.date === new Date(2020, 1, 29, 12, 0, 1).toISOString(), `${name}: EXIF date ${e.date}`);
  }
  check(exp.abort === 'AbortError', `abort mid-export rejects with ${exp.abort}`);
  check(exp.abortRestored, 'abort restores proxy source');
  check(exp.preAbort === 'AbortError', 'pre-aborted signal rejects with AbortError');
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
