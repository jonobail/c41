import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HSL_BANDS, ASPECT_PRESETS, CURVE_PRESETS,
  defaultCurves, defaultHsl, defaultDevelop,
  isCurveIdentity, buildCurveLut, hasActiveHsl, packHslUniforms, hueToRgb,
  inscribedZoom, buildGeometry, geoPoint, geoSourceRect,
  computeHistogram, computeWaveform, computeAutoTone, HistoryStack,
} from '../js/image-ops.js';
import { lensReach } from '../js/renderer.js';
import { getCamera } from '../js/cameras.js';

test('image-ops: curve LUT identity and S-curve monotonicity', () => {
  const def = defaultCurves();
  assert.equal(isCurveIdentity(def), true);
  const lutId = buildCurveLut(def, 256);
  assert.equal(lutId.length, 256 * 4);
  for (let i = 0; i < 256; i++) {
    assert.equal(lutId[i * 4], i);
    assert.equal(lutId[i * 4 + 3], i);
  }

  const sCurve = { ...def, rgb: CURVE_PRESETS.find((p) => p.id === 's-curve').pts };
  assert.equal(isCurveIdentity(sCurve), false);
  const lutS = buildCurveLut(sCurve, 256);
  // Master channel (alpha) must be monotonically non-decreasing and darken shadows / brighten highlights
  for (let i = 1; i < 256; i++) {
    assert.ok(lutS[i * 4 + 3] >= lutS[(i - 1) * 4 + 3], `monotonic at ${i}`);
  }
  assert.ok(lutS[64 * 4 + 3] < 64, 'S-curve deepens shadows');
  assert.ok(lutS[192 * 4 + 3] > 192, 'S-curve lifts highlights');
});

test('image-ops: 8-band HSL packing and detection', () => {
  assert.equal(HSL_BANDS.length, 8);
  const def = defaultHsl();
  assert.equal(hasActiveHsl(def), false);
  const packed0 = packHslUniforms(def);
  assert.equal(packed0.length, 24);
  assert.ok(packed0.every((v) => v === 0));

  def.blue = [18, 0.45, -0.2];
  assert.equal(hasActiveHsl(def), true);
  const packed = packHslUniforms(def);
  // blue is index 5
  assert.equal(packed[5 * 3], 18);
  assert.ok(Math.abs(packed[5 * 3 + 1] - 0.45) < 1e-6);
  assert.ok(Math.abs(packed[5 * 3 + 2] + 0.2) < 1e-6);
});

test('image-ops: hueToRgb primary hues', () => {
  assert.deepEqual(hueToRgb(0), [1, 0, 0]);
  assert.deepEqual(hueToRgb(120), [0, 1, 0]);
  assert.deepEqual(hueToRgb(240), [0, 0, 1]);
  assert.deepEqual(hueToRgb(360), [1, 0, 0]);
});

test('image-ops: geometry rotate, flip, straighten inscribed zoom stays in bounds', () => {
  const id = buildGeometry(4000, 3000, {});
  assert.equal(id.active, false);
  assert.deepEqual(id.logImg, [4000, 3000]);

  // 90° CW swaps dimensions and maps all 4 corners inside raw bounds
  const r90 = buildGeometry(4000, 3000, { rotate: 90 });
  assert.equal(r90.active, true);
  assert.deepEqual(r90.logImg, [3000, 4000]);
  for (const [lx, ly] of [[0, 0], [3000, 0], [0, 4000], [3000, 4000]]) {
    const [sx, sy] = geoPoint(r90, lx, ly);
    assert.ok(sx >= -1e-6 && sx <= 4000 + 1e-6 && sy >= -1e-6 && sy <= 3000 + 1e-6, `90° (${lx},${ly}) -> (${sx},${sy})`);
  }

  // Straighten + flip + rotate keeps every logical corner strictly inside raw image (zero black borders!)
  for (const rot of [0, 90, 180, 270]) {
    for (const ang of [-35, -12, 7.5, 42]) {
      const G = buildGeometry(4000, 3000, { rotate: rot, flipH: true, flipV: false, straighten: ang });
      const [lw, lh] = G.logImg;
      assert.ok(G.zoom >= 1);
      const box = geoSourceRect(G, [0, 0, lw, lh], 0);
      assert.ok(box[0] >= -1e-4 && box[1] >= -1e-4 && box[2] <= 4000 + 1e-4 && box[3] <= 3000 + 1e-4,
        `rot=${rot} ang=${ang} box=${box.map((n) => n.toFixed(1))}`);
    }
  }
  assert.equal(inscribedZoom(1000, 1000, 0), 1);
  assert.ok(Math.abs(inscribedZoom(1000, 1000, 45) - Math.SQRT2) < 1e-6);
});

test('image-ops: histogram, waveform & auto-tone analysis', () => {
  // Synthetic dark, cool-tinted flat image
  const w = 64, h = 48;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = x / (w - 1);
      rgba[i] = Math.round(35 + t * 40);
      rgba[i + 1] = Math.round(45 + t * 45);
      rgba[i + 2] = Math.round(70 + t * 55);
      rgba[i + 3] = 255;
    }
  }
  const hist = computeHistogram(rgba, w, h);
  assert.equal(hist.total, w * h);
  assert.equal(hist.clippedHighlights, 0);
  const sum = hist.luma.reduce((a, b) => a + b, 0);
  assert.equal(sum, w * h);

  const wave = computeWaveform(rgba, w, h, 32, 24);
  assert.equal(wave.r.length, 32 * 24);
  assert.ok(wave.maxVal > 0);

  const auto = computeAutoTone(rgba, w, h);
  assert.ok(auto.exposure > 0.2, `dark photo boosted: ${auto.exposure}`);
  assert.ok(auto.warmth > 0.05, `cool cast warmed: ${auto.warmth}`);
  assert.ok(auto.contrast > 0, `flat photo contrast increased: ${auto.contrast}`);
  for (const v of Object.values(auto)) assert.ok(Number.isFinite(v));
});

test('image-ops: HistoryStack undo / redo / branch truncation', () => {
  const hs = new HistoryStack(4);
  hs.reset({ a: 0 });
  assert.equal(hs.canUndo, false);
  assert.equal(hs.canRedo, false);
  assert.equal(hs.push({ a: 0 }), false, 'duplicate ignored');
  assert.equal(hs.push({ a: 1 }), true);
  assert.equal(hs.push({ a: 2 }), true);
  assert.equal(hs.canUndo, true);
  assert.deepEqual(hs.undo(), { a: 1 });
  assert.equal(hs.canRedo, true);
  assert.deepEqual(hs.redo(), { a: 2 });
  assert.deepEqual(hs.undo(), { a: 1 });
  hs.push({ a: 99 });
  assert.equal(hs.canRedo, false, 'redo branch cleared on new edit');
  assert.deepEqual(hs.undo(), { a: 1 });
  // respects max capacity
  hs.push({ a: 10 }); hs.push({ a: 11 }); hs.push({ a: 12 }); hs.push({ a: 13 });
  assert.ok(hs.stack.length <= 4);
});

test('image-ops: defaults & lensReach spatial DSP reach', () => {
  const dev = defaultDevelop();
  assert.equal(dev.exposure, 0);
  assert.equal(dev.rotate, 0);
  assert.ok(ASPECT_PRESETS.some((a) => a.id === '16:9'));
  const none = getCamera('none');
  assert.equal(lensReach(none, 1, 3000, 2000), 0);
  assert.ok(lensReach(none, 1, 3000, 2000, { dehaze: 0.5 }) > 20);
  assert.ok(lensReach(none, 1, 3000, 2000, { denoise: 0.7 }) > 0);
});
