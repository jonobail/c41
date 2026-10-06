// Colour statistics shared by the fitter: computed identically on a reference film pool and on the
// iPhone baseline pool after it has been pushed through makeFilm, so the fitter can compare them.
// The statistics themselves live in js/match-stats.js (browser-safe; also used by the on-device
// "Match a photo" fitter) — this module re-exports them and adds the Node file loader.
import { readFileSync, existsSync } from 'node:fs';
import { poolFromU8 } from '../js/match-stats.js';

export { QUANTILES, LUMA_BINS, HUE_BANDS, poolStats, statDistance } from '../js/match-stats.js';

/** Load a measured pool as Float32Array of sRGB 0..1 triplets, optionally subsampled to `max` pixels. */
export function loadPool(path, max = Infinity, seed = 7) {
  if (!existsSync(path)) return null;
  return poolFromU8(readFileSync(path), max, seed);
}
