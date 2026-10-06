// Browser checks for camera frames / remapped lenses through the REAL renderer + exporter.
//   node tests/remap.browser.mjs
// For a set of cameras (plain, rounded mask, sprocket exposure, pano, multi-lens grids, fisheye,
// flash gel) on a synthetic photo-like image it checks:
//  - export dimensions = layout.out (× GPU scale),
//  - preview == export: the export, downscaled to the preview size, matches renderPreview()
//    within a small mean error (grain off — it is resolution dependent by design),
//  - invisible strip seams: an export with tiny strips equals one with the default strips,
//  - no console / WebGL errors.
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

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const CASES = [
  { id: 'leica-m6' },
  { id: 'holga-120n', border: true },
  { id: 'lomo-diana-f-plus', flash: true, gel: 'magenta' },
  { id: 'lomo-lc-a-120', border: true },
  { id: 'lomo-sprocket-rocket' },
  { id: 'lomo-sprocket-rocket', border: true, portrait: true },
  { id: 'lomo-spinner-360' },
  { id: 'lomo-belair-6-12', mask: '6x9', border: true },
  { id: 'lomo-actionsampler' },
  { id: 'lomo-supersampler', portrait: true },
  { id: 'lomo-oktomat', border: true },
  { id: 'lomo-diana-mini' },
  { id: 'lomo-fisheye-no2' },
  { id: 'lomo-fisheye-no2', portrait: true, flash: true },
];

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/__test.html`);
  const results = await page.evaluate(async (CASES) => {
    const R = await import('/js/renderer.js');
    const ft = await import('/js/film-transform.js');
    const cams = await import('/js/cameras.js');
    const ov = await import('/js/overlays.js');
    const maps = await import('/js/maps.js');
    const ex = await import('/js/exporter.js');
    const films = await import('/js/films.js');
    const film = films.getFilm('kodak-portra-400');

    // photo-like synthetic image: sky gradient, ground, soft shapes, edges and mild texture
    function synth(W, H) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const sky = g.createLinearGradient(0, 0, 0, H * 0.55);
      sky.addColorStop(0, '#5d8fd6'); sky.addColorStop(1, '#cfe0f0');
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      const gr = g.createLinearGradient(0, H * 0.55, 0, H);
      gr.addColorStop(0, '#6b7d3a'); gr.addColorStop(1, '#3b2a1c');
      g.fillStyle = gr; g.fillRect(0, H * 0.55, W, H * 0.45);
      let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 60; i++) {
        g.fillStyle = `hsl(${Math.floor(rnd() * 360)},${30 + rnd() * 50}%,${25 + rnd() * 50}%)`;
        const x = rnd() * W, y = H * (0.3 + rnd() * 0.7), w = W * (0.02 + rnd() * 0.12), h = H * (0.05 + rnd() * 0.3);
        if (rnd() < 0.5) g.fillRect(x, y - h, w, h); else { g.beginPath(); g.ellipse(x, y, w / 2, h / 3, 0, 0, 6.283); g.fill(); }
      }
      g.fillStyle = '#fff8e0'; g.beginPath(); g.arc(W * 0.78, H * 0.18, H * 0.05, 0, 6.283); g.fill();
      g.strokeStyle = 'rgba(20,20,20,.8)'; g.lineWidth = Math.max(2, W / 600);
      for (let i = 0; i < 14; i++) { g.beginPath(); g.moveTo(rnd() * W, rnd() * H); g.lineTo(rnd() * W, rnd() * H); g.stroke(); }
      const id = g.getImageData(0, 0, W, H);
      for (let i = 0; i < id.data.length; i += 4) { const n = (rnd() - 0.5) * 10; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
      g.putImageData(id, 0, 0);
      return c;
    }
    const pixels = (src, w, h) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, w, h); return g.getImageData(0, 0, w, h).data;
    };
    const out = [];
    const cv = document.createElement('canvas');
    const r = new R.Renderer(cv);
    r.setLut(ft.buildLut(film.params), ft.LUT_SIZE);
    for (const cs of CASES) {
      const W = cs.portrait ? 1800 : 2700, H = cs.portrait ? 2700 : 1800;
      const big = synth(W, H);
      const k = 1200 / Math.max(W, H);
      const proxy = document.createElement('canvas'); proxy.width = Math.round(W * k); proxy.height = Math.round(H * k);
      const pg = proxy.getContext('2d'); pg.imageSmoothingQuality = 'high'; pg.drawImage(big, 0, 0, proxy.width, proxy.height);
      const camera = cams.effectiveCamera(cams.getCamera(cs.id), cs.mask);
      const layout = ov.frameLayout(W, H, { camera, film, crop: true, border: !!cs.border, seed: 9 });
      const mp = maps.buildMaps(proxy);
      r.setSource(proxy); r.setMaps(mp);
      const params = {
        film, camera, filmAmt: 1, camAmt: 1, grain: 0, halation: 1, flare: 1, leak: 0, leaks: [], camLeaks: [],
        flash: cs.flash ? 1 : 0, gel: cs.gel ? cams.getGel(cs.gel).rgb : null, layout, dust: 0, dateOn: false,
        exposure: 0, contrast: 0, warmth: 0, tint: 0, flarePoint: mp.flare, split: -1, showOriginal: false, seed: 4242,
        fullShort: Math.min(layout.crop[2], layout.crop[3]),
      };
      r.setParams(params);
      let frame = null;
      if (layout.draw) {
        const [fw, fh] = r.previewSize();
        const fc = document.createElement('canvas'); fc.width = fw; fc.height = fh;
        layout.draw(fc.getContext('2d'), 0, 0, proxy.width / W);
        frame = { canvas: fc, origin: [0, 0], size: [fw, fh] };
      }
      r.setFrame(frame);
      r.renderPreview();
      const pw = cv.width, ph = cv.height;
      const prev = pixels(cv, pw, ph);
      const run = async (stripPixels) => {
        const blob = await ex.exportJpeg({ renderer: r, image: big, params, quality: 98, proxy, previewFrame: frame, stripPixels });
        return createImageBitmap(blob);
      };
      const A = await run(4_000_000);
      const B = await run(260_000);
      const res = { name: `${cs.id}${cs.mask ? ':' + cs.mask : ''}${cs.border ? ' +border' : ''}${cs.portrait ? ' portrait' : ''}${cs.gel ? ' gel' : ''}`,
        dims: [A.width, A.height], want: [Math.round(layout.out[0]), Math.round(layout.out[1])] };
      // preview == export
      const ea = pixels(A, pw, ph);
      let d = 0;
      for (let i = 0; i < ea.length; i += 4) d += Math.abs(ea[i] - prev[i]) + Math.abs(ea[i + 1] - prev[i + 1]) + Math.abs(ea[i + 2] - prev[i + 2]);
      res.previewDiff = d / (pw * ph * 3);
      // seams: tiny strips vs default strips, full res; worst row
      const fa = pixels(A, A.width, A.height), fb = pixels(B, B.width, B.height);
      let tot = 0, worstRow = 0;
      for (let y = 0; y < A.height; y++) {
        let rs = 0;
        for (let x = 0, i = y * A.width * 4; x < A.width; x++, i += 4) rs += Math.abs(fa[i] - fb[i]) + Math.abs(fa[i + 1] - fb[i + 1]) + Math.abs(fa[i + 2] - fb[i + 2]);
        tot += rs; worstRow = Math.max(worstRow, rs / (A.width * 3));
      }
      res.stripDiff = tot / (A.width * A.height * 3);
      res.worstRow = worstRow;
      out.push(res);
      // restore preview state like the app does
      r.setSource(proxy);
    }
    return out;
  }, CASES);
  for (const r of results) {
    check(r.dims[0] === r.want[0] && r.dims[1] === r.want[1], `${r.name}: export ${r.dims.join('×')} (layout ${r.want.join('×')})`);
    check(r.previewDiff < 2.5, `${r.name}: preview vs export mean |Δ| ${r.previewDiff.toFixed(2)}/255`);
    check(r.stripDiff < 0.25 && r.worstRow < 1.5, `${r.name}: tiny strips vs default mean |Δ| ${r.stripDiff.toFixed(3)}, worst row ${r.worstRow.toFixed(2)}/255`);
  }
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all remap browser checks passed');
