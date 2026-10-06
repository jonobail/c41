// Browser end-to-end check for "Match a photo" (js/look-match.js + js/match-worker.js) in Chromium.
//   node tests/match.browser.mjs
// Starts scripts/serve.mjs on a free localhost port (and kills only that process afterwards),
// builds synthetic JPEGs in the page and calls matchLook(): result shape, timing, progress,
// border trimming, abort.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs')], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { // wait for the server
  try { if ((await fetch(`${base}/js/look-match.js`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.route(`${base}/__match_test.html`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>t</title><body>' }));
  await page.goto(`${base}/__match_test.html`);

  const r = await page.evaluate(async () => {
    const { matchLook } = await import('/js/look-match.js');
    // warm, faded, grainy synthetic photo with a black scan border, 1600×1200 JPEG
    async function jpeg(w, h, border) {
      const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
      const im = ctx.createImageData(w, h), d = im.data;
      let s = 1;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < border || y < border || x >= w - border || y >= h - border) { d[i] = d[i + 1] = d[i + 2] = 4; d[i + 3] = 255; continue; }
        const u = x / w, v = y / h, n = (rnd() - 0.5) * 18;
        const L = 70 + 150 * (0.5 + 0.5 * Math.sin(u * 5) * Math.cos(v * 3));
        d[i] = L * 1.08 + 12 + n; d[i + 1] = L * 0.97 + 8 + n; d[i + 2] = L * 0.82 + 10 + n; d[i + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
      return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    }
    const blob = await jpeg(1600, 1200, 40);
    const prog = [];
    const t0 = performance.now();
    const res = await matchLook(blob, { onProgress: (p) => prog.push(p) });
    const ms = performance.now() - t0;
    // abort mid-fit
    const ac = new AbortController();
    let abortErr = null, abortMs = 0;
    const t1 = performance.now();
    try {
      await matchLook(blob, { signal: ac.signal, onProgress: (p) => { if (p > 0.3) ac.abort(); } });
    } catch (e) { abortErr = e.name; }
    abortMs = performance.now() - t1;
    // pre-aborted signal
    let pre = null;
    try { const a2 = new AbortController(); a2.abort(); await matchLook(blob, { signal: a2.signal }); } catch (e) { pre = e.name; }
    return { res, ms, prog, abortErr, abortMs, pre };
  });

  const { res } = r;
  check(res && res.film && res.effects && res.grainParams && res.stats, 'result has film / effects / grainParams / stats');
  check(res.film.lumaLock === true && res.film.type === 'color' && res.film.filmic === null && Object.keys(res.film.hsl).length === 8, 'film is a complete lumaLock colour param set');
  check(typeof res.effects.grain === 'number' && typeof res.effects.leak === 'number' && ['warm', 'prism'].includes(res.effects.leakStyle), `effects ${JSON.stringify(res.effects)}`);
  check(JSON.stringify(res.grainParams) === JSON.stringify(res.film.grain), `grainParams ${JSON.stringify(res.grainParams)} == film.grain`);
  check(res.grainParams.amount > 0.1, 'synthetic noise detected as grain');
  check(res.stats.distance.fitted < 0.3 * res.stats.distance.identity, `distance ${res.stats.distance.identity} → ${res.stats.distance.fitted}`);
  check(res.film.fade > 0 || res.film.curve[0][1] > 0.02 || res.film.lift.some((v) => v > 0.01), 'lifted blacks fitted (synthetic floor ≈ 0.3)');
  check(r.ms < 8000, `matchLook took ${Math.round(r.ms)} ms (< 8000; fit ${res.stats.fitMs} ms, ${res.stats.evals} evals)`);
  check(r.prog.length > 10 && r.prog.at(-1) === 1 && r.prog.every((p, i) => i === 0 || p >= r.prog[i - 1]), `progress monotonic 0..1 (${r.prog.length} updates)`);
  check(Array.isArray(res.stats.size) && res.stats.size[0] === 1600, 'decoded full size reported');
  check(r.abortErr === 'AbortError' && r.abortMs < r.ms, `abort → ${r.abortErr} after ${Math.round(r.abortMs)} ms`);
  check(r.pre === 'AbortError', 'pre-aborted signal rejects');
} catch (e) {
  console.log('FAIL', e);
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} failure(s)` : 'all browser match checks passed');
process.exit(failures ? 1 : 0);
