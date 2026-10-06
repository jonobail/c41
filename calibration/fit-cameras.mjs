// Fit each camera's vignette (renderer model: log2 falloff = -1.6 · vignette · d^hardness) to the median
// radial luminance profile of real photos taken with it, minus the iPhone baseline profile (which
// carries the "average scene" brightness distribution, phones being lens-corrected).
// Usage: node calibration/fit-cameras.mjs  → calibration/cameras-fitted.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const M = join(HERE, 'cache', 'measure');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const base = read(join(M, 'baseline', 'stats.json')).vignette;
const centres = base.map((_, i) => (i + 0.5) / base.length);

const out = {};
for (const id of existsSync(join(M, 'cameras')) ? readdirSync(join(M, 'cameras')) : []) {
  const s = read(join(M, 'cameras', id, 'stats.json'));
  if (!s.vignette || s.images < 8) { console.log(id.padEnd(18), 'skipped,', s.images, 'images'); continue; }
  const diff = s.vignette.map((v, i) => (v == null || base[i] == null ? null : v - base[i]));
  let best = { err: Infinity };
  for (let v = 0; v <= 2.0001; v += 0.02) {
    for (let h = 1.5; h <= 5.0001; h += 0.1) {
      let err = 0;
      diff.forEach((d, i) => { if (d != null) err += (centres[i] ** 2) * (d + 1.6 * v * centres[i] ** h) ** 2; });
      if (err < best.err) best = { err, vignette: +v.toFixed(2), vignetteHardness: +h.toFixed(1) };
    }
  }
  out[id] = { images: s.images, cornerStops: +diff.at(-1).toFixed(2), ...best };
  console.log(id.padEnd(18), `imgs ${String(s.images).padStart(3)}  corner ${diff.at(-1).toFixed(2)} stops  →  vignette ${best.vignette}  hardness ${best.vignetteHardness}`);
}
writeFileSync(join(HERE, 'cameras-fitted.json'), JSON.stringify(out, null, 1));
