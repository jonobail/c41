import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS, DEFAULT_CAMERA_ID, getCamera, effectiveCamera, FLASH_GELS, getGel, GROUPS, cameraGroup } from '../js/cameras.js';
import { makeLeaks, mulberry32, frameLayout, instantType } from '../js/overlays.js';
import { planExport, PAD as EXPORT_PAD } from '../js/exporter.js';
import { lensReach, lensUniforms, CAM_AMT_MAX, remapGeometry, remapSourceRect, fishPoint, GRID_MAX } from '../js/renderer.js';
import { remapStripSource } from '../js/exporter.js';

const RANGES = {
  vignette: [0, 1.5], vignetteHardness: [2, 4], sharpness: [-1, 1], cornerSoft: [0, 1],
  ca: [0, 1], contrast: [-0.3, 0.3], warmth: [-0.1, 0.1], bloom: [0, 1], flare: [0, 1],
  vignetteWobble: [0, 1], vigSat: [0, 1], clarity: [-0.6, 0.6], sweetSpot: [0, 0.9],
  blurShape: [-1, 1], distortion: [-0.1, 0.1], sat: [-0.3, 0.3], veil: [0, 0.1],
  tint: [-0.1, 0.1], flash: [0, 1], leak: [0, 1], vigAxis: [0, 1], banding: [0, 1], swirl: [0, 1],
};
const ZERO_EXEMPT = ['vignetteHardness', 'sweetSpot', 'flash'];
const BODIES = ['slr', 'rangefinder', 'compact', 'medium', 'toy', 'fisheye', 'multilens', 'pano', 'spinner', 'none'];

test('cameras: none first, all zero', () => {
  assert.equal(CAMERAS[0].id, 'none');
  assert.equal(DEFAULT_CAMERA_ID, 'none');
  const p = CAMERAS[0].params;
  for (const k of Object.keys(RANGES)) {
    if (ZERO_EXEMPT.includes(k)) continue;
    assert.equal(p[k], 0, `none.${k}`);
  }
  assert.equal(CAMERAS[0].formatScale, 1);
});

test('cameras: schema, ranges, unique ids', () => {
  assert.ok(CAMERAS.length >= 15, 'about 18 presets');
  const ids = new Set();
  for (const c of CAMERAS) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    for (const k of ['id', 'name', 'brand', 'lens', 'format', 'summary', 'traits']) {
      assert.equal(typeof c[k], 'string', `${c.id}.${k}`);
    }
    assert.ok(BODIES.includes(c.body), `${c.id}.body`);
    assert.equal(typeof c.year, 'number');
    if (c.id !== 'none') {
      assert.ok(c.year >= 1900 && c.year <= 2030, `${c.id}.year`);
      assert.ok(c.summary.length > 10 && c.traits.length > 40, `${c.id} prose`);
    }
    assert.ok(c.formatScale >= 0.5 && c.formatScale <= 3, `${c.id}.formatScale`);
    for (const [k, [lo, hi]] of Object.entries(RANGES)) {
      const v = c.params[k];
      assert.equal(typeof v, 'number', `${c.id}.params.${k}`);
      assert.ok(v >= lo && v <= hi, `${c.id}.params.${k}=${v} outside [${lo},${hi}]`);
    }
  }
  assert.equal(getCamera('lomo-lca').id, 'lomo-lca');
  assert.equal(getCamera('nope').id, 'none');
  assert.equal(getCamera('holga-120n').formatScale, 1.8);
  assert.equal(getCamera('olympus-pen-f').formatScale, 0.7);
  for (const c of CAMERAS) {
    assert.ok(c.aspect === null || (c.aspect >= 1 && c.aspect <= 2.2), `${c.id}.aspect`);
    assert.ok(['135', 'half', '120', 'holga', 'sprocket'].includes(c.frame), `${c.id}.frame`);
    const o = c.params.vignetteOffset;
    assert.ok(Array.isArray(o) && o.length === 2 && o.every((v) => Math.abs(v) <= 0.3), `${c.id}.vignetteOffset`);
    assert.ok(['edge', 'holga'].includes(c.params.leakBias), `${c.id}.leakBias`);
  }
  assert.equal(getCamera('none').aspect, null);
  assert.equal(getCamera('hasselblad-500cm').aspect, 1);
  assert.equal(getCamera('mamiya-rz67').aspect, 1.25);
  assert.ok(Math.abs(getCamera('olympus-pen-f').aspect - 4 / 3) < 1e-9);
});

test('cameras are distinguishable: no two presets share the same look parameters', () => {
  const keys = Object.keys(RANGES).filter((k) => k !== 'flash');
  const sig = (c) => JSON.stringify([c.aspect, c.frame, c.grid, c.fisheye, ...keys.map((k) => c.params[k])]);
  const seen = new Map();
  for (const c of CAMERAS) {
    assert.ok(!seen.has(sig(c)), `${c.id} duplicates ${seen.get(sig(c))}`);
    seen.set(sig(c), c.id);
  }
});

test('lensUniforms / lensReach: scale with lens amount, clamp at 150 %', () => {
  const holga = getCamera('holga-120n');
  const a1 = lensUniforms(holga, 1), a15 = lensUniforms(holga, 1.5), a3 = lensUniforms(holga, 3);
  assert.equal(CAM_AMT_MAX, 1.5);
  assert.ok(a15.vig > a1.vig && a15.cornerSoft > a1.cornerSoft);
  assert.deepEqual(a3, a15, 'amount clamps at CAM_AMT_MAX');
  for (const v of Object.values(a3)) for (const x of [v].flat()) assert.ok(Number.isFinite(x));
  assert.equal(lensReach(getCamera('none'), 1, 3000, 2000), 0);
  assert.equal(lensReach(null, 1, 3000, 2000), 0);
  const r = lensReach(holga, 1.5, 4000, 4000);
  assert.ok(r > 64 && r < 0.08 * 4000, `holga reach ${r}`);
  assert.ok(lensReach(getCamera('leica-m6'), 1, 4000, 6000) < lensReach(holga, 1, 4000, 6000));
});

test('frameLayout: format crops follow the photo orientation', () => {
  const L = (W, H, camId, o = {}) => frameLayout(W, H, { camera: getCamera(camId), crop: true, ...o });
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  let f = L(3000, 2000, 'hasselblad-500cm');
  assert.deepEqual(f.crop, [500, 0, 2000, 2000]);
  assert.deepEqual(f.out, [2000, 2000]);
  assert.equal(f.draw, null);
  f = L(4000, 3000, 'leica-m6');                        // 4:3 → 3:2 landscape
  assert.ok(near(f.crop[2] / f.crop[3], 1.5) && near(f.crop[2], 4000));
  f = L(3000, 4000, 'leica-m6');                        // portrait → 2:3
  assert.ok(near(f.crop[3] / f.crop[2], 1.5) && near(f.crop[3], 4000));
  f = L(3000, 2000, 'mamiya-rz67');
  assert.ok(near(f.crop[2] / f.crop[3], 1.25));
  f = L(3000, 2000, 'olympus-pen-f');
  assert.ok(near(f.crop[2] / f.crop[3], 4 / 3));
  f = L(3000, 2000, 'none');
  assert.deepEqual(f.crop, [0, 0, 3000, 2000]);
  f = frameLayout(3000, 2000, { camera: getCamera('holga-120n'), crop: false });
  assert.deepEqual(f.crop, [0, 0, 3000, 2000]);
  // crop rect always inside the image, centred
  for (const c of CAMERAS) for (const [W, H] of [[4032, 3024], [3024, 4032], [1000, 1000], [6000, 2000]]) {
    const g = L(W, H, c.id);
    const [x, y, w, h] = g.crop;
    assert.ok(x >= -1e-9 && y >= -1e-9 && x + w <= W + 1e-6 && y + h <= H + 1e-6, `${c.id} ${W}x${H}`);
    assert.ok(near(x * 2 + w, W) && near(y * 2 + h, H));
  }
});

test('frameLayout: borders pad the output; instant films get a paper frame', () => {
  const film = { id: 'kodak-portra-400', brand: 'Kodak', name: 'Portra 400', process: 'C-41', params: {} };
  let f = frameLayout(3000, 2000, { camera: getCamera('canon-ae1'), film, crop: true, border: true });
  assert.equal(f.style, '135');
  assert.equal(f.filmBorder, true);
  assert.equal(typeof f.draw, 'function');
  assert.ok(f.out[0] > 3000 && f.out[1] > 2000);
  assert.ok(Math.abs(f.out[0] - 2 * f.inner[0] - 3000) < 1e-6 && Math.abs(f.out[1] - 2 * f.inner[1] - 2000) < 1e-6);
  // 35 mm: 24 mm picture height, ~35 mm film → rebate top/bottom much bigger than the ends
  assert.ok(f.inner[1] > f.inner[0] * 2);
  // half-frame landscape: the film runs vertically → rebate on the left/right
  f = frameLayout(3000, 2000, { camera: getCamera('olympus-pen-f'), film, crop: true, border: true });
  assert.equal(f.style, 'half');
  assert.ok(f.inner[0] > f.inner[1] * 2);
  f = frameLayout(3000, 2000, { camera: getCamera('holga-120n'), film, crop: true, border: true });
  assert.equal(f.style, 'holga');
  assert.equal(instantType({ id: 'polaroid-600' }), 'polaroid');
  assert.equal(instantType({ id: 'fuji-instax-mini' }), 'instax');
  assert.equal(instantType(film), null);
  f = frameLayout(3000, 2000, { camera: getCamera('leica-m6'), film: { id: 'polaroid-600' }, crop: true, border: true });
  assert.equal(f.style, 'polaroid');
  assert.equal(f.filmBorder, false);
  assert.deepEqual(f.crop, [500, 0, 2000, 2000], 'Polaroid is square regardless of camera');
  const bottom = f.out[1] - f.inner[1] - f.crop[3];
  assert.ok(bottom > 3 * f.inner[1], 'thick bottom strip');
  f = frameLayout(2000, 3000, { film: { id: 'fuji-instax-mini' }, crop: true, border: true });
  assert.ok(Math.abs(f.crop[3] / f.crop[2] - 62 / 46) < 1e-6);
});

test('planExport: crop + border geometry, lens-aware pad, strips', () => {
  const lim = { maxTexture: 16384, maxRenderbuffer: 16384, maxViewport: [16384, 16384] };
  const plain = planExport(3000, 2000, lim);
  assert.equal(plain.outW, 3000); assert.equal(plain.outH, 2000); assert.equal(plain.pad, EXPORT_PAD);
  const film = { id: 'kodak-portra-400', brand: 'Kodak', name: 'Portra 400' };
  const L = frameLayout(3000, 2000, { camera: getCamera('holga-120n'), film, crop: true, border: true });
  const reach = lensReach(getCamera('holga-120n'), 1.5, L.crop[2], L.crop[3]);
  const g = planExport(3000, 2000, lim, L, reach);
  assert.equal(g.outW, Math.round(L.out[0])); assert.equal(g.outH, Math.round(L.out[1]));
  assert.equal(g.pad, EXPORT_PAD + reach);
  assert.equal(g.stripH % 16, 0);
  assert.ok(g.sx0 >= 0 && g.sx0 + g.srcW <= 3000 + 1, 'source columns in bounds');
  assert.ok(g.srcW >= g.crop[2], 'source columns cover the frame');
  assert.equal(g.fullShort, 2000);
  // GPU limit: output (incl. border) must fit
  const small = planExport(3000, 2000, { maxTexture: 2048, maxRenderbuffer: 2048, maxViewport: [2048, 2048] }, L, reach);
  assert.ok(small.outW <= 2048 && small.outH <= 2048 && small.srcW <= 2048);
  assert.ok(Math.abs(small.outW / small.outH - L.out[0] / L.out[1]) < 0.01);
});

test('makeLeaks bias: camera leaks hug the frame edge', () => {
  assert.deepEqual(makeLeaks(5, { bias: 'holga' }), makeLeaks(5, { bias: 'holga' }));
  assert.deepEqual(makeLeaks(5, null), makeLeaks(5));
  for (let s = 0; s < 100; s++) {
    for (const bias of ['holga', 'edge']) {
      const l = makeLeaks(s, { bias });
      assert.ok(l.length >= 1 && l.length <= 2);
      for (const k of l) {
        assert.ok(k.x < 0.1 || k.x > 0.9, `${bias} x=${k.x}`);
        assert.ok(k.stretch >= 1 && k.stretch <= 4 && k.r > 0.05 && k.r < 0.5);
        assert.ok(k.color[0] >= k.color[2]);
      }
    }
  }
});

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const sa = Array.from({ length: 100 }, a), sb = Array.from({ length: 100 }, b);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, Array.from({ length: 100 }, c));
  for (const v of sa) assert.ok(v >= 0 && v < 1);
  const mean = sa.reduce((s, v) => s + v, 0) / sa.length;
  assert.ok(mean > 0.35 && mean < 0.65);
});

test('makeLeaks: deterministic, 1–3 leaks, sane ranges', () => {
  assert.deepEqual(makeLeaks(7), makeLeaks(7));
  let edge = 0, total = 0;
  const counts = new Set();
  for (let s = 0; s < 300; s++) {
    const leaks = makeLeaks(s);
    counts.add(leaks.length);
    assert.ok(leaks.length >= 1 && leaks.length <= 3);
    for (const l of leaks) {
      total++;
      if (l.x < 0.1 || l.x > 0.9) edge++;
      assert.ok(l.x >= -0.3 && l.x <= 1.3);
      assert.ok(l.y >= 0 && l.y <= 1);
      assert.ok(l.r > 0.05 && l.r < 1);
      assert.ok(l.stretch >= 1 && l.stretch <= 4);
      assert.equal(l.color.length, 3);
      for (const c of l.color) assert.ok(c >= 0 && c <= 1);
      assert.ok(l.color[0] >= l.color[2], 'warm palette');
    }
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3]);
  assert.ok(edge / total > 0.7, 'mostly off the left/right edges');
});

test('renderer.js imports without touching the DOM', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const mod = await import('../js/renderer.js');
  assert.equal(typeof mod.Renderer, 'function');
  assert.equal(mod.PAD, 64);
  for (const m of ['setSource', 'setLut', 'setMaps', 'setDust', 'setDate', 'setFrame', 'setParams', 'previewSize',
    'renderPreview', 'renderRegion', 'onContextRestored', 'dispose']) {
    assert.equal(typeof mod.Renderer.prototype[m], 'function', m);
  }
  assert.throws(() => new mod.Renderer({ getContext: () => null, addEventListener() {} }), /webgl2-unavailable/);
});

test('maps.js and overlays.js import without a DOM', async () => {
  const maps = await import('../js/maps.js');
  assert.equal(typeof maps.buildMaps, 'function');
  const o = await import('../js/overlays.js');
  assert.equal(typeof o.makeDustCanvas, 'function');
  assert.equal(typeof o.makeDateCanvas, 'function');
});

test('makeLeaks prism: warm on one edge, mint/teal on the opposite, deterministic', () => {
  assert.deepEqual(makeLeaks(9, { style: 'prism' }), makeLeaks(9, { style: 'prism' }));
  assert.deepEqual(makeLeaks(9, { style: 'warm' }), makeLeaks(9), 'warm = legacy default');
  assert.deepEqual(makeLeaks(9, { style: 'holga' }), makeLeaks(9, { bias: 'holga' }));
  const sides = new Set();
  for (let s = 0; s < 200; s++) {
    const l = makeLeaks(s, { style: 'prism' });
    assert.ok(l.length >= 2 && l.length <= 4, 'renderer takes up to 4 user leaks');
    const warm = l.filter((k) => k.color[0] > k.color[1]);
    const cool = l.filter((k) => k.color[1] > k.color[0]);
    assert.ok(warm.length >= 1 && cool.length >= 1);
    const wSide = warm[0].x < 0.5 ? 0 : 1;
    sides.add(wSide);
    for (const k of warm) assert.equal(k.x < 0.5 ? 0 : 1, wSide, 'warm glows share an edge');
    for (const k of cool) assert.equal(k.x < 0.5 ? 0 : 1, 1 - wSide, 'teal on the opposite edge');
    for (const k of l) {
      assert.ok(k.x < 0.1 || k.x > 0.9);
      assert.ok(k.y >= 0 && k.y <= 1);
      assert.ok(k.r >= 0.2 && k.r < 0.6, 'large soft radii');
      assert.ok(k.stretch >= 1.2 && k.stretch <= 4);
      for (const c of k.color) assert.ok(c >= 0 && c <= 1);
    }
    assert.ok(cool[0].color[1] > 0.8 && cool[0].color[2] > 0.6 && cool[0].color[0] < 0.5, 'mint/teal');
    assert.ok(warm[0].color[0] > 0.9 && warm[0].color[2] > 0.25, 'pink-orange');
  }
  assert.deepEqual([...sides].sort(), [0, 1], 'seed varies which edge is warm');
});

test('Lomography cameras: ids, group, capabilities', () => {
  const lomo = CAMERAS.filter((c) => c.brand === 'Lomography');
  assert.ok(lomo.length >= 12);
  for (const c of lomo) {
    assert.ok(c.id.startsWith('lomo-'), c.id);
    assert.equal(cameraGroup(c), 'lomo');
  }
  assert.equal(cameraGroup(getCamera('canon-ae1')), 'classic');
  assert.deepEqual(GROUPS.map((g) => g.id), ['classic', 'lomo']);
  // the original LC-A keeps its id (looks / saved state refer to it)
  assert.equal(getCamera('lomo-lca').brand, 'Lomo');
  for (const c of CAMERAS) {
    if (c.grid) {
      const n = c.grid.cols * c.grid.rows;
      assert.ok(n >= 2 && n <= GRID_MAX, `${c.id} grid size`);
      assert.ok(c.grid.shift >= 0 && c.grid.shift <= 0.25 && (c.grid.expoJitter ?? 0) <= 0.5, `${c.id} grid jitter`);
    }
    if (c.fisheye) assert.ok(c.fisheye.radius > 0.8 && c.fisheye.radius < 1.4);
    if (c.mask) assert.equal(c.mask.type, 'rounded');
    if (c.masks) {
      for (const m of c.masks) assert.ok(m.id && m.label && m.aspect >= 1 && m.aspect <= 2.2, `${c.id} mask ${m.id}`);
      assert.equal(effectiveCamera(c, 'nope').maskId, c.masks[0].id, 'unknown mask → first');
    }
  }
  assert.equal(getCamera('lomo-sprocket-rocket').frame, 'sprocket');
  assert.equal(getCamera('lomo-belair-6-12').aspect, 2);
  const lcw = getCamera('lomo-lc-wide');
  assert.equal(effectiveCamera(lcw, 'square').aspect, 1);
  assert.equal(effectiveCamera(lcw, 'half').frame, 'half');
  assert.equal(effectiveCamera(getCamera('lomo-diana-mini'), 'square').grid, null);
  assert.equal(effectiveCamera(getCamera('leica-m6'), 'x'), getCamera('leica-m6'), 'no masks → same object');
  assert.equal(getGel('none').rgb, null);
  assert.equal(getGel('bogus').id, 'none');
  for (const g of FLASH_GELS.slice(1)) assert.ok(g.rgb.length === 3 && Math.max(...g.rgb) === 1);
});

test('frameLayout: sprocket exposure, pano minimum, rounded mask (with and without border)', () => {
  const film = { id: 'kodak-portra-800', brand: 'Kodak', name: 'Portra 800', process: 'C-41', params: {} };
  let f = frameLayout(4032, 3024, { camera: getCamera('lomo-sprocket-rocket'), film, crop: true });
  assert.ok(Math.abs(f.crop[2] / f.crop[3] - 2.06) < 1e-6);
  assert.equal(f.mask, 'sprocket');
  assert.equal(typeof f.draw, 'function', 'sprockets are on the picture: drawn without a border');
  assert.deepEqual(f.inner, [0, 0]);
  assert.deepEqual(f.out, [f.crop[2], f.crop[3]]);
  f = frameLayout(4032, 3024, { camera: getCamera('lomo-sprocket-rocket'), film, crop: true, border: true });
  assert.equal(f.style, 'sprocket');
  assert.ok(f.inner[1] > 0 && f.inner[1] < 0.05 * f.crop[3], 'thin scanner margin only');
  // Spinner: an ordinary photo is cut to 4.3:1, a phone panorama keeps its aspect
  f = frameLayout(4032, 3024, { camera: getCamera('lomo-spinner-360'), film, crop: true });
  assert.ok(Math.abs(f.crop[2] / f.crop[3] - 4.3) < 1e-6);
  f = frameLayout(12000, 2000, { camera: getCamera('lomo-spinner-360'), film, crop: true });
  assert.deepEqual(f.crop, [0, 0, 12000, 2000]);
  f = frameLayout(3024, 4032, { camera: getCamera('lomo-spinner-360'), film, crop: true });
  assert.ok(Math.abs(f.crop[3] / f.crop[2] - 4.3) < 1e-6, 'portrait follows the photo');
  // rounded mask
  f = frameLayout(3000, 3000, { camera: getCamera('lomo-diana-f-plus'), film, crop: true });
  assert.equal(f.mask, 'rounded');
  assert.equal(typeof f.draw, 'function');
  f = frameLayout(3000, 3000, { camera: getCamera('lomo-lc-a-120'), film, crop: true, border: true });
  assert.equal(f.style, '120');
  assert.equal(f.mask, 'rounded');
  // ordinary cameras: unchanged
  f = frameLayout(3000, 2000, { camera: getCamera('leica-m6'), film, crop: true });
  assert.equal(f.draw, null);
  assert.equal(f.mask, null);
});

test('remapGeometry: grids cover-fit the whole photo, shifts stay inside, deterministic', () => {
  const img = [4032, 3024];
  for (const id of ['lomo-actionsampler', 'lomo-supersampler', 'lomo-oktomat', 'lomo-diana-mini']) {
    const cam = getCamera(id);
    for (const [W, H] of [[4032, 3024], [3024, 4032]]) {
      const L = frameLayout(W, H, { camera: cam, crop: true });
      const G = remapGeometry(cam, [W, H], L.crop, 77);
      assert.equal(G.mode, 1);
      assert.deepEqual(G, remapGeometry(cam, [W, H], L.crop, 77));
      assert.notDeepEqual(G.cells, remapGeometry(cam, [W, H], L.crop, 78).cells, 'seeded');
      assert.equal(G.cells.length, G.cols * G.rows);
      if (W < H) assert.ok(G.rows >= G.cols || G.cols === G.rows, `${id} portrait swaps the grid`);
      for (const c of G.cells) {
        // the cell's view must lie inside the image (no smeared edge pixels)
        const x0 = c.b[0], y0 = c.b[1], x1 = c.b[0] + G.S[0] * c.m, y1 = c.b[1] + G.S[1] * c.m;
        assert.ok(x0 >= -1e-6 && y0 >= -1e-6 && x1 <= W + 1e-6 && y1 <= H + 1e-6 || cam.grid.fit === 'split', `${id} cell in image`);
        assert.ok(Math.abs(c.expo) <= cam.grid.expoJitter + 1e-9);
      }
      // resolution independence: half-size geometry is the same picture
      const G2 = remapGeometry(cam, [W / 2, H / 2], L.crop.map((v) => v / 2), 77);
      G2.cells.forEach((c, i) => {
        assert.ok(Math.abs(c.m - G.cells[i].m) < 1e-9);
        assert.ok(Math.abs(c.b[0] * 2 - G.cells[i].b[0]) < 1e-6);
      });
    }
  }
  assert.equal(remapGeometry(getCamera('leica-m6'), img, [0, 0, 4032, 3024]), null);
});

test('remapSourceRect: covers every sampled source point of a strip (grid + fisheye)', () => {
  const W = 4032, H = 3024;
  for (const id of ['lomo-actionsampler', 'lomo-oktomat', 'lomo-supersampler', 'lomo-fisheye-no2', 'lomo-diana-mini']) {
    const cam = getCamera(id);
    const L = frameLayout(W, H, { camera: cam, crop: true });
    const G = remapGeometry(cam, [W, H], L.crop, 5);
    const [Fw, Fh] = [L.crop[2], L.crop[3]];
    const map = (x, y) => {
      if (G.mode === 2) return fishPoint(G, x, y).slice(0, 2);
      const i = Math.min(G.cols - 1, Math.floor(x / G.S[0])), j = Math.min(G.rows - 1, Math.floor(y / G.S[1]));
      const c = G.cells[j * G.cols + i];
      return [c.b[0] + (x - i * G.S[0]) * c.m, c.b[1] + (y - j * G.S[1]) * c.m];
    };
    for (const [y0, y1] of [[0, 300], [700, 1100], [Fh / 2 - 100, Fh / 2 + 150], [Fh - 250, Fh]]) {
      const r = remapSourceRect(G, [0, y0, Fw, y1], 0);
      assert.ok(r && r.jMin > 0, `${id} rect`);
      for (let k = 0; k < 400; k++) {
        const x = (k * 0.618034 % 1) * Fw, y = y0 + ((k * 0.414214) % 1) * (y1 - y0);
        const [ix, iy] = map(x, y);
        assert.ok(ix >= r.rect[0] - 1 && ix <= r.rect[2] + 1 && iy >= r.rect[1] - 1 && iy <= r.rect[3] + 1,
          `${id} strip ${y0}-${y1}: (${x.toFixed(0)},${y.toFixed(0)}) → (${ix.toFixed(0)},${iy.toFixed(0)}) outside ${r.rect.map(Math.round)}`);
      }
    }
  }
});

test('remapStripSource: aligned, in bounds, downsampled only where the remap minifies', () => {
  const W = 4032, H = 3024;
  const lim = { maxTexture: 16384, maxRenderbuffer: 16384, maxViewport: [16384, 16384] };
  for (const id of ['lomo-actionsampler', 'lomo-fisheye-no2', 'lomo-supersampler']) {
    const cam = getCamera(id);
    const L = frameLayout(W, H, { camera: cam, crop: true, border: true, film: { id: 'x', name: 'X' } });
    const G = planExport(W, H, lim, L, 0);
    const RG = remapGeometry(cam, G.img, G.crop, 3);
    for (let y0 = 0; y0 < G.outH; y0 += 512) {
      const R = remapStripSource(G, RG, y0, Math.min(512, G.outH - y0), 20);
      assert.ok(R.x >= 0 && R.y >= 0 && R.x + R.w <= Math.round(G.img[0]) && R.y + R.h <= Math.round(G.img[1]), `${id} in bounds`);
      assert.equal(R.x % 32, 0); assert.equal(R.y % 32, 0);
      assert.ok(R.texK > 0 && R.texK <= 1 && Math.log2(R.texK) % 1 === 0, 'power-of-two texK');
      assert.ok(R.w * R.h * R.texK * R.texK <= 16e6 + 1);
      if (RG.mode === 1) {
        const mMin = Math.min(...RG.cells.map((c) => c.m));
        assert.ok(R.texK * mMin >= 1 - 1e-9 && R.texK * mMin < 2, 'downsampled only as far as the cells minify');
      }
      if (id === 'lomo-fisheye-no2') assert.equal(R.texK, 1);
    }
  }
});

test('lensReach: grids measure the lens per cell', () => {
  const as = getCamera('lomo-actionsampler');
  const flat = { ...as, grid: null };
  assert.ok(lensReach(as, 1, 4000, 3000) < lensReach(flat, 1, 4000, 3000));
  const u = lensUniforms(getCamera('lomo-spinner-360'), 1);
  assert.equal(u.vigAxis, 1);
  assert.ok(u.band > 0);
});
