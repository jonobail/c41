// C41 — Looks: one-tap recipes (film + overrides, camera, effects, adjustments).
// Contract: docs/LOOKS.md. Pure data + helpers; storage helpers touch localStorage only when
// called (Node-safe to import).

export const LOOKS_KEY = 'c41.looks';
export const CUSTOM_MAX = 24;
export const THUMB_MAX_BYTES = 8192;

/** Effect / adjust values a look falls back to for keys it doesn't specify. */
export const LOOK_EFFECT_DEFAULTS = {
  grain: 1, halation: 1, flare: 1, leak: 0, leakStyle: 'warm', dust: 0, flash: false,
};
export const LOOK_ADJUST_DEFAULTS = { exposure: 0, contrast: 0, warmth: 0, tint: 0 };

export const LOOKS = [
  {
    id: 'warm-haze', name: 'Warm Haze',
    description: 'Rosy warmth, milky lifted blacks, creamy capped highlights, fine mono grain and a prism leak.',
    custom: false,
    filmId: 'kodak-gold-200', filmAmt: 1, cameraId: 'none', camAmt: 1,
    film: {
      lumaLock: true, temp: 0.2, tint: 0.2, contrast: -0.28, rolloff: 0.5, fade: 0.19, whitePoint: 0.975,
      lift: [0.035, 0.012, 0.018], gain: [1.0, 0.99, 0.9], gamma: [1.16, 1, 0.99], sat: 0.88, satHighlights: 0.75,
      shadows: 0.12, highlights: -0.06, splitHighlight: { hue: 55, amt: 0.07 },
      hsl: {
        orange: [-3, 1.0, 0.03], red: [-6, 1.0, 0.02], yellow: [0, 0.8, 0], green: [-8, 0.65, 0],
        blue: [8, 0.55, 0.05], aqua: [0, 0.65, 0.03], purple: [0, 0.8, 0.03],
      },
      grain: { amount: 0.45, size: 1.1, color: 0.05 }, halation: { amount: 0.06, color: [1, 0.45, 0.3] }, bloom: 0.18,
    },
    effects: { grain: 1.2, leak: 0.55, leakStyle: 'prism', halation: 1, flare: 0.6, dust: 0 },
    adjust: {},
    swatch: ['#f3c9b0', '#9fe0c8'],
  },
  {
    id: 'summer-compact', name: 'Summer Compact',
    description: 'Portra through a Contax T2: soft skin, crisp centre, gentle vignette. Flash off.',
    custom: false,
    filmId: 'kodak-portra-400', film: null, filmAmt: 1, cameraId: 'contax-t2', camAmt: 1,
    effects: { grain: 1, halation: 0.8, flare: 1, leak: 0, flash: false },
    adjust: { warmth: 0.12, exposure: 0.15 },
    swatch: ['#f2c14e', '#f28c6b'],
  },
  {
    id: 'cine-night', name: 'Cine Night',
    description: 'CineStill 800T with glowing red halos around every light.',
    custom: false,
    filmId: 'cinestill-800t', film: { grain: { amount: 0.55 } }, filmAmt: 1, cameraId: 'none', camAmt: 1,
    effects: { grain: 1.1, halation: 1.6, flare: 1.2, leak: 0 },
    adjust: { contrast: 0.08 },
    swatch: ['#1d3557', '#e63946'],
  },
  {
    id: 'toy-camera', name: 'Toy Camera',
    description: 'Holga plastic lens on Lomo 800: heavy vignette, soft corners, warm leaks.',
    custom: false,
    filmId: 'lomography-cn-800', film: null, filmAmt: 1, cameraId: 'holga-120n', camAmt: 1.1,
    effects: { grain: 1.3, halation: 1, flare: 1, leak: 0.6, leakStyle: 'warm', leakSeed: 7, dust: 0.25 },
    adjust: { contrast: 0.1 },
    swatch: ['#ef233c', '#ffb703'],
  },
  {
    id: 'silver', name: 'Silver',
    description: 'Tri-X on a Leica M6: punchy blacks, gritty grain, crisp rendering.',
    custom: false,
    filmId: 'kodak-tri-x-400', film: null, filmAmt: 1, cameraId: 'leica-m6', camAmt: 1,
    effects: { grain: 1.2, halation: 0.5, flare: 0.8, leak: 0, dust: 0.15 },
    adjust: { contrast: 0.1 },
    swatch: ['#d9d9d9', '#2b2b2b'],
  },
];

const BY_ID = new Map(LOOKS.map((l) => [l.id, l]));

/** Built-in or custom look by id (custom looks read from storage), or null. */
export function getLook(id, customs = null) {
  if (!id) return null;
  if (BY_ID.has(id)) return BY_ID.get(id);
  return (customs || loadCustomLooks()).find((l) => l.id === id) || null;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/**
 * Film params with look overrides: shallow replace, except `grain` and `halation` which merge
 * field by field. Never mutates the inputs.
 */
export function mergeFilmParams(base, over) {
  const out = { ...(base || {}) };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if ((k === 'grain' || k === 'halation') && isObj(v)) out[k] = { ...(isObj(out[k]) ? out[k] : {}), ...clone(v) };
    else out[k] = clone(v);
  }
  return out;
}

/** Stable short hash (FNV-1a, base36) of any JSON-able value — LUT cache keys. */
export function hashJson(v) {
  const s = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * The app-state patch a look applies (unspecified effect/adjust keys → defaults; seeds are only
 * set when the look specifies them). Keys match the app state.
 */
export function lookPatch(look) {
  const e = { ...LOOK_EFFECT_DEFAULTS, ...(look.effects || {}) };
  const a = { ...LOOK_ADJUST_DEFAULTS, ...(look.adjust || {}) };
  const p = {
    filmId: look.filmId,
    lookFilm: isObj(look.film) ? clone(look.film) : null,
    filmAmt: num(look.filmAmt, 1),
    cameraId: look.cameraId || 'none',
    camAmt: num(look.camAmt, 1),
    grain: num(e.grain, 1), halation: num(e.halation, 1), flare: num(e.flare, 1),
    leak: num(e.leak, 0), leakStyle: typeof e.leakStyle === 'string' ? e.leakStyle : 'warm',
    dust: num(e.dust, 0), flashOn: !!e.flash,
    exposure: num(a.exposure, 0), contrast: num(a.contrast, 0), warmth: num(a.warmth, 0), tint: num(a.tint, 0),
  };
  if (look.effects && Number.isFinite(look.effects.leakSeed)) p.leakSeed = look.effects.leakSeed;
  if (look.effects && Number.isFinite(look.effects.dustSeed)) p.dustSeed = look.effects.dustSeed;
  return p;
}
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

/** True when `state` no longer matches what `look` applied. */
export function isLookModified(look, state) {
  if (!look || !state) return false;
  const p = lookPatch(look);
  for (const [k, v] of Object.entries(p)) {
    const s = state[k];
    if (k === 'lookFilm') { if (hashJson(s || null) !== hashJson(v || null)) return true; continue; }
    if (typeof v === 'number') { if (typeof s !== 'number' || Math.abs(s - v) > 0.004) return true; continue; }
    if (s !== v) return true;
  }
  return false;
}

/* ------------------------------------------------------------ custom looks */

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** Validates / normalises a stored look; returns null if unusable. */
export function sanitizeLook(l) {
  if (!isObj(l) || typeof l.id !== 'string' || !l.id) return null;
  return {
    id: l.id,
    name: (typeof l.name === 'string' && l.name.trim() ? l.name.trim() : 'My look').slice(0, 40),
    description: typeof l.description === 'string' ? l.description : '',
    custom: true,
    filmId: typeof l.filmId === 'string' ? l.filmId : 'kodak-portra-400',
    film: isObj(l.film) ? l.film : null,
    filmAmt: num(l.filmAmt, 1),
    cameraId: typeof l.cameraId === 'string' ? l.cameraId : 'none',
    camAmt: num(l.camAmt, 1),
    effects: isObj(l.effects) ? l.effects : {},
    adjust: isObj(l.adjust) ? l.adjust : {},
    swatch: Array.isArray(l.swatch) ? l.swatch.filter((c) => typeof c === 'string').slice(0, 3) : ['#8d847a', '#27231f'],
    thumb: typeof l.thumb === 'string' && l.thumb.startsWith('data:image/') && l.thumb.length <= THUMB_MAX_BYTES * 1.4 ? l.thumb : undefined,
    created: num(l.created, 0),
  };
}

/** Custom looks, newest first. Never throws. */
export function loadCustomLooks() {
  const st = storage();
  if (!st) return [];
  try {
    const arr = JSON.parse(st.getItem(LOOKS_KEY) || '[]');
    return Array.isArray(arr) ? arr.map(sanitizeLook).filter(Boolean).slice(0, CUSTOM_MAX) : [];
  } catch { return []; }
}

function writeCustomLooks(list) {
  const st = storage();
  if (!st) return false;
  let arr = list.slice(0, CUSTOM_MAX);
  // on quota errors drop thumbnails, then the oldest looks
  for (let attempt = 0; attempt < 4; attempt++) {
    try { st.setItem(LOOKS_KEY, JSON.stringify(arr)); return true; } catch {
      if (attempt === 0) arr = arr.map((l) => ({ ...l, thumb: undefined }));
      else arr = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)));
    }
  }
  return false;
}

/** Insert or replace (by id); new looks go first. Returns the saved (sanitised) look or null. */
export function saveCustomLook(look) {
  const l = sanitizeLook({ ...look, custom: true, id: look.id || `custom-${Date.now()}`, created: look.created || Date.now() });
  if (!l) return null;
  const list = loadCustomLooks();
  const i = list.findIndex((x) => x.id === l.id);
  if (i >= 0) list[i] = l; else list.unshift(l);
  return writeCustomLooks(list) ? l : null;
}

export function deleteCustomLook(id) {
  const list = loadCustomLooks();
  const next = list.filter((l) => l.id !== id);
  if (next.length === list.length) return false;
  return writeCustomLooks(next);
}

/** Next default name: "My look N". */
export function nextLookName(customs = loadCustomLooks()) {
  let n = customs.length + 1;
  const names = new Set(customs.map((l) => l.name));
  while (names.has(`My look ${n}`)) n++;
  return `My look ${n}`;
}
