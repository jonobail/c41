import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS, DEFAULT_CAMERA_ID, getCamera } from '../js/cameras.js';
import { makeLeaks, mulberry32 } from '../js/overlays.js';

const RANGES = {
  vignette: [0, 1.5], vignetteHardness: [2, 4], sharpness: [-1, 1], cornerSoft: [0, 1],
  ca: [0, 1], contrast: [-0.3, 0.3], warmth: [-0.1, 0.1], bloom: [0, 1], flare: [0, 1],
};
const BODIES = ['slr', 'rangefinder', 'compact', 'medium', 'toy', 'none'];

test('cameras: none first, all zero', () => {
  assert.equal(CAMERAS[0].id, 'none');
  assert.equal(DEFAULT_CAMERA_ID, 'none');
  const p = CAMERAS[0].params;
  for (const k of Object.keys(RANGES)) {
    if (k === 'vignetteHardness') continue;
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
  for (const m of ['setSource', 'setLut', 'setMaps', 'setDust', 'setDate', 'setParams',
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
