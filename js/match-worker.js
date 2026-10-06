// C41 — "Match a photo" fitter. Module worker (spawned by js/look-match.js); the exported pure
// functions also run in Node for tests.
//
// Fits FIT_SPEC film params so that the iPhone baseline pool (assets/baseline-pool.bin: what a
// normal iPhone photo looks like) pushed through makeFilm() matches the colour statistics of ONE
// reference photo. Coordinate pattern search like calibration/fit.mjs, tuned for speed (few
// thousand pixels, three step levels, early stop, pattern extension) with a light prior toward a
// neutral film (makeFilm({ lumaLock: true }) ≈ identity), not toward any stock.
//
// Messages in:  { type: 'match', small: {w,h,data}, rect, grain: {w,h,data}|null, opts }
// Messages out: { type: 'progress', p } … { type: 'result', result } | { type: 'error', message }
// Abort: the main thread terminates the worker (the search loop is synchronous).
import { makeFilm, srgbToLinear, FIT_SPEC, FILM_DEFAULTS, paramVector, applyVector, specBounds } from './film-transform.js';
import {
  poolFromU8, poolStats, matchStats, matchDistance, statDistance, samplePixels,
  grainEstimate, grainToParams, edgeLeaks,
} from './match-stats.js';

export const NEUTRAL = Object.freeze({ lumaLock: true });
const HSL_ORDER = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']; // = HUE_BANDS order
const BAND_FRAC = 0.03;

export class AbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError'; }
}

/** Render a linear pool through `params` → sRGB 0..1 Float32Array. */
export function renderPool(lin, params, out = new Float32Array(lin.length)) {
  const fn = makeFilm(params), o = [0, 0, 0];
  for (let i = 0; i < lin.length; i += 3) {
    fn(lin[i], lin[i + 1], lin[i + 2], o);
    out[i] = o[0]; out[i + 1] = o[1]; out[i + 2] = o[2];
  }
  return out;
}

/**
 * Fit film params to target stats.
 * @param {Uint8Array} baseU8   baseline pool (uint8 RGB triplets)
 * @param {object} target       matchStats() of the reference
 * @param {object} [o]
 *   pixels (6000), coarsePixels (3000), steps ([0.25, 0.1, 0.04]), sweeps (2), prior (0.01),
 *   onProgress(p 0..1), shouldStop() → true aborts (throws AbortError),
 *   deadline (ms since start; stops refining and returns the best so far — keeps phones ≲ 15 s)
 * @returns {{ params, distance: { identity, fitted }, raw: { identity, fitted }, evals, ms, timedOut }}
 */
export function fitLook(baseU8, target, o = {}) {
  const {
    pixels = 6000, coarsePixels = 3000, steps = [0.25, 0.1, 0.04], sweeps = 2, prior = 0.01,
    onProgress = null, shouldStop = null, deadline = Infinity, now = () => Date.now(),
  } = o;
  const t0 = now();
  const spec = FIT_SPEC;
  const { lo, hi } = specBounds(spec);
  const x0 = paramVector(spec, NEUTRAL);
  const range = Array.from(lo, (m, i) => hi[i] - m || 1);

  const pools = {};
  const pool = (n) => {
    if (!pools[n]) { const s = poolFromU8(baseU8, n); pools[n] = { s, lin: s.map(srgbToLinear), out: new Float32Array(s.length) }; }
    return pools[n];
  };
  const fine = pool(pixels);
  const identityStats = matchStats(fine.s);

  // Only fit hue-band params where both the baseline and the reference have that hue.
  const baseBand = identityStats.band;
  const active = [];
  for (let i = 0; i < spec.length; i++) {
    const m = /^hsl\.(\w+)\./.exec(spec[i].path);
    if (m) {
      const b = HSL_ORDER.indexOf(m[1]);
      if (!target.band[b] || !baseBand[b] || target.band[b][2] < BAND_FRAC || baseBand[b][2] < BAND_FRAC) continue;
    }
    active.push(i);
  }

  let evals = 0, cur = pool(coarsePixels);
  const loss = (x) => {
    if (shouldStop && shouldStop()) throw new AbortError();
    evals++;
    let reg = 0;
    for (let i = 0; i < x.length; i++) reg += ((x[i] - x0[i]) / range[i]) ** 2;
    const st = matchStats(renderPool(cur.lin, applyVector(spec, x, NEUTRAL), cur.out));
    return matchDistance(st, target) + prior * reg;
  };

  const x = Float64Array.from(x0);
  let best = loss(x), timedOut = false;
  const total = steps.length * sweeps * active.length;
  let done = 0;
  const progress = () => { if (onProgress) onProgress(Math.min(1, done / total)); };

  outer:
  for (let li = 0; li < steps.length; li++) {
    const step = steps[li];
    if (li === 1 && cur !== fine) { cur = fine; best = loss(x); }
    for (let sweep = 0; sweep < sweeps; sweep++) {
      const startLoss = best;
      for (const i of active) {
        done++;
        if (now() - t0 > deadline) { timedOut = true; break outer; }
        for (const dir of [1, -1]) {
          const v = Math.min(hi[i], Math.max(lo[i], x[i] + dir * step * range[i]));
          if (v === x[i]) continue;
          const old = x[i]; x[i] = v;
          const l = loss(x);
          if (l < best) {
            best = l;
            // pattern extension: keep going while it helps (up to 3 more steps)
            for (let k = 0; k < 3; k++) {
              const v2 = Math.min(hi[i], Math.max(lo[i], x[i] + dir * step * range[i]));
              if (v2 === x[i]) break;
              const o2 = x[i]; x[i] = v2;
              const l2 = loss(x);
              if (l2 < best) best = l2; else { x[i] = o2; break; }
            }
            break;
          }
          x[i] = old;
        }
        if ((done & 7) === 0) progress();
      }
      // early stop: a sweep that gains < 1.5 % → next (finer) level
      if (startLoss - best < 0.015 * startLoss) { done += (sweeps - sweep - 1) * active.length; break; }
    }
    progress();
  }
  if (cur !== fine) { cur = fine; best = loss(x); }

  const params = applyVector(spec, x, NEUTRAL);
  const fitted = matchStats(renderPool(fine.lin, params, fine.out));
  return {
    params,
    distance: { identity: matchDistance(identityStats, target), fitted: matchDistance(fitted, target) },
    raw: { identity: statDistance(identityStats, target), fitted: statDistance(fitted, target) },
    fittedStats: fitted,
    identityStats,
    evals,
    ms: now() - t0,
    timedOut,
  };
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(round)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, w]) => [k, round(w)])) : v);

/**
 * Full analysis of a decoded reference.
 * @param {Uint8Array} baseU8
 * @param {{ small: {w,h,data}, rect, grain: {w,h,data}|null }} img
 *   small: ≤ 768 px RGBA of the whole picture, rect = trimmed picture area inside it;
 *   grain: RGBA of the trimmed picture at GRAIN_SHORT_EDGE (or native) for the grain estimate.
 */
export function analyse(baseU8, img, o = {}) {
  const { small, rect, grain } = img;
  const onProgress = o.onProgress || (() => {});
  const px = samplePixels(small.data, small.w, small.h, rect, o.samples || 12000);
  const target = matchStats(px);
  onProgress(0.03);
  const g = grain ? grainEstimate(grain.data, grain.w, grain.h) : null;
  const gp = grainToParams(g);
  const leaks = edgeLeaks(small.data, small.w, small.h, rect);
  onProgress(0.08);
  const fit = fitLook(baseU8, target, { ...o, onProgress: (p) => onProgress(0.08 + 0.9 * p) });

  // Complete film: every colour param set explicitly (a Look merges `film` shallowly over the
  // base stock's params, so non-fitted stages of the stock must be neutralised here).
  const film = round({
    ...FILM_DEFAULTS,
    ...fit.params,
    type: 'color',
    matrix: null, filmic: null, splitShadow: null, splitHighlight: null, densityHue: null,
    lumaLock: true,
    grain: { amount: gp.amount, size: 1, color: gp.color },
  });
  delete film.halation; delete film.bloom; // spatial: left to the base stock
  onProgress(1);
  return {
    film,
    effects: { grain: gp.slider, leak: leaks.leak, leakStyle: leaks.leakStyle },
    grainParams: { amount: gp.amount, size: 1, color: gp.color },
    stats: round({
      target: { q: target.q, cast: target.cast, ncast: target.ncast, chroma: target.chroma, mono: target.mono },
      fitted: { q: fit.fittedStats.q, cast: fit.fittedStats.cast, ncast: fit.fittedStats.ncast, chroma: fit.fittedStats.chroma },
      distance: fit.distance,
      rawDistance: fit.raw,
      grain: { ...(g || {}), level: gp.level },
      leak: { warmSide: leaks.warmSide, sides: leaks.sides },
      evals: fit.evals, fitMs: fit.ms, timedOut: fit.timedOut,
    }),
  };
}

// ---- worker glue ------------------------------------------------------------------------------
const inWorker = typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (inWorker) {
  let poolP = null;
  const loadPool = () => (poolP ||= fetch(new URL('../assets/baseline-pool.bin', import.meta.url))
    .then((r) => { if (!r.ok) throw new Error(`baseline pool: HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((b) => new Uint8Array(b)));
  self.onmessage = async (e) => {
    const m = e.data;
    if (!m || m.type !== 'match') return;
    try {
      const base = await loadPool();
      let last = -1;
      const result = analyse(base, m, {
        ...(m.opts || {}),
        onProgress: (p) => { if (p - last >= 0.01 || p === 1) { last = p; self.postMessage({ type: 'progress', p }); } },
      });
      self.postMessage({ type: 'result', result });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err), name: err && err.name });
    }
  };
}
