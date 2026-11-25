// C41 — app shell: state, wiring, digital image lab, live scopes, undo/redo, import/export.
import { Slider, Sheet, toast, ChipGroup, Toggle, icon, h, idleLoop, debounce } from './ui.js';
import {
  HSL_BANDS, ASPECT_PRESETS,
  defaultCurves, defaultHsl, defaultDevelop,
  buildCurveLut, isCurveIdentity, hasActiveHsl, hueToRgb,
  buildGeometry, computeAutoTone, HistoryStack,
} from './image-ops.js';
import { ScopeView, ToneCurveEditor } from './scopes.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const stage = $('stage');
const view = $('view');

const STORE_KEY = 'c41.state.v2';
const LEGACY_STORE_KEY = 'c41.state.v1';
const UI_KEY = 'c41.ui.v2';
const PROXY_MAX = 2048;
const PROXY_MIN = 1200;
const THUMB = 96;
const LUT_CACHE_MAX = 8;

/* ---------------------------------------------------------------- modules */

const M = {};
const missing = [];

async function loadModules() {
  const specs = {
    ft: './film-transform.js',
    films: './films.js',
    cameras: './cameras.js',
    renderer: './renderer.js',
    maps: './maps.js',
    overlays: './overlays.js',
    exif: './exif.js',
    exporter: './exporter.js',
    looks: './looks.js',
  };
  const keys = Object.keys(specs);
  const res = await Promise.allSettled(keys.map((k) => import(specs[k])));
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') M[keys[i]] = r.value;
    else {
      missing.push(specs[keys[i]].slice(2));
      console.warn(`[C41] module ${specs[keys[i]]} failed to load:`, r.reason);
    }
  });
}

/* ------------------------------------------------------------------ state */

const ADJUST_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'fade',
  'warmth', 'tint', 'vibrance', 'saturation',
  'clarity', 'sharpen', 'dehaze', 'denoise', 'vignette',
  'splitShadowHue', 'splitShadowAmt', 'splitHighlightHue', 'splitHighlightAmt', 'splitBalance',
];
const GEO_KEYS = ['rotate', 'flipH', 'flipV', 'straighten', 'aspect'];
const EFFECT_KEYS = ['grain', 'halation', 'flare', 'leak', 'dust'];

function defaults() {
  return {
    filmId: M.films?.DEFAULT_FILM_ID ?? 'kodak-portra-400',
    cameraId: M.cameras?.DEFAULT_CAMERA_ID ?? 'none',
    filmAmt: 1, camAmt: 1,
    grain: 1, halation: 1, flare: 1,
    leak: 0, leakSeed: 1, leakStyle: 'warm',
    dust: 0, dustSeed: 1,
    dateOn: false, dateFormat: 'classic', dateColor: 'orange', date: isoDate(new Date()),
    cropOn: true, borderOn: false, flashOn: false,
    gel: 'none',
    camMasks: {},
    ...defaultDevelop(),
    seed: (Math.random() * 1e9) | 0,
    lookId: null,
    lookFilm: null,
  };
}
const NULLABLE = { lookId: 'string', lookFilm: 'object' };

let state = null;
const history = new HistoryStack(50);

function loadState() {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      for (const k of Object.keys(d)) {
        if (s[k] === undefined) continue;
        if (k in NULLABLE) { if (s[k] === null || typeof s[k] === NULLABLE[k]) d[k] = s[k]; continue; }
        if (k === 'curves' && s.curves && typeof s.curves === 'object') {
          d.curves = { ...defaultCurves(), ...s.curves };
          continue;
        }
        if (k === 'hsl' && s.hsl && typeof s.hsl === 'object') {
          d.hsl = { ...defaultHsl(), ...s.hsl };
          continue;
        }
        if (typeof s[k] === typeof d[k]) d[k] = s[k];
      }
    }
  } catch { /* private mode / corrupt */ }
  return d;
}
const saveState = debounce(() => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota / private */ }
}, 300);

function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; }
}
function saveUi(patch) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUi(), ...patch })); } catch { /* ignore */ }
}

function recordHistory() {
  if (!state) return;
  history.push(state);
  syncHistoryButtons();
}

function syncHistoryButtons() {
  const u = $('btn-undo'), r = $('btn-redo');
  if (u) u.disabled = !S.proxy || !history.canUndo;
  if (r) r.disabled = !S.proxy || !history.canRedo;
}

function doUndo() {
  if (!S.proxy || !history.canUndo) return;
  const prev = history.undo();
  if (!prev) return;
  state = { ...defaults(), ...prev };
  syncControls();
  saveState();
  rebuildDust();
  rebuildDate();
  requestRender();
  syncHistoryButtons();
  toast('Undone', { duration: 1400 });
}

function doRedo() {
  if (!S.proxy || !history.canRedo) return;
  const next = history.redo();
  if (!next) return;
  state = { ...defaults(), ...next };
  syncControls();
  saveState();
  rebuildDust();
  rebuildDate();
  requestRender();
  syncHistoryButtons();
  toast('Redone', { duration: 1400 });
}

/* ------------------------------------------------------------ session data */

const S = {
  renderer: null,
  img: null, imgUrl: null, file: null,
  fullW: 0, fullH: 0,
  proxy: null,
  maps: null, flarePoint: { x: 0.5, y: 0.3, strength: 0 },
  exifDate: null,
  lutCache: new Map(), lutFilmId: null,
  curveKey: '',
  effFilm: null, effKey: '',
  dust: null, dustKey: '',
  date: null, dateKey: '',
  leaks: [], leaksSeed: null,
  camLeaks: [], camLeaksKey: '',
  layout: null, layoutKey: '', frame: null,
  split: -1, holding: false, clipWarn: false,
  scopeOn: true,
  zoom: 1, panX: 0, panY: 0,
  rafPending: false,
  exporting: false,
  thumbCancel: null,
  thumbLin: null,
  scope: null,
  viewRect: null,
};

/* -------------------------------------------------------------- utilities */

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return new Date();
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}
function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function releaseCanvas(c) {
  if (c && typeof c.width === 'number') { c.width = 0; c.height = 0; }
}
function mkCanvas(w, hh) {
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  return c;
}
const pct = (v) => `${Math.round(v * 100)}%`;
const signed = (v) => {
  const n = Math.round(v * 100);
  return n === 0 ? '0' : (n > 0 ? `+${n}` : `−${-n}`);
};
const degSigned = (v) => {
  const n = Math.round(v * 10) / 10;
  return Math.abs(n) < 0.05 ? '0°' : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}°`;
};
const degInt = (v) => `${Math.round(v)}°`;
const degDelta = (v) => {
  const n = Math.round(v);
  return n === 0 ? '0°' : (n > 0 ? `+${n}°` : `−${-n}°`);
};
const ev = (v) => (Math.abs(v) < 0.005 ? '0.0 EV' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`);
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function filmKey() {
  return state.lookFilm && M.looks ? `${state.filmId}#${M.looks.hashJson(state.lookFilm)}` : state.filmId;
}
function film() {
  const key = filmKey();
  if (S.effKey !== key || !S.effFilm) {
    const base = M.films.getFilm(state.filmId);
    S.effFilm = state.lookFilm && M.looks ? { ...base, params: M.looks.mergeFilmParams(base.params, state.lookFilm) } : base;
    S.effKey = key;
  }
  return S.effFilm;
}
const camera = () => {
  const c = M.cameras.getCamera(state.cameraId);
  return M.cameras.effectiveCamera ? M.cameras.effectiveCamera(c, state.camMasks?.[c.id]) : c;
};
const gelRgb = () => {
  const c = camera();
  if (!c?.flashGels || !state.flashOn || !M.cameras.getGel) return null;
  return M.cameras.getGel(state.gel).rgb;
};
function aspectOverrideValue() {
  const p = ASPECT_PRESETS.find((a) => a.id === state.aspect);
  return p ? p.ratio : null;
}

/* -------------------------------------------------------------- rendering */

function buildParams(overrides = {}) {
  const geo = buildGeometry(S.fullW || 1, S.fullH || 1, state);
  const [lw, lh] = geo.logImg;
  return {
    film: film(),
    camera: camera(),
    filmAmt: state.filmAmt,
    camAmt: state.camAmt,
    grain: state.grain,
    halation: state.halation,
    flare: state.flare,
    leak: state.leak,
    leaks: S.leaks,
    camLeaks: S.camLeaks,
    flash: state.flashOn ? 1 : 0,
    gel: gelRgb(),
    layout: S.layout,
    dust: S.dust ? state.dust : 0,
    dateOn: !!(state.dateOn && S.date),
    exposure: state.exposure,
    contrast: state.contrast,
    highlights: state.highlights,
    shadows: state.shadows,
    whites: state.whites,
    blacks: state.blacks,
    fade: state.fade,
    warmth: state.warmth,
    tint: state.tint,
    vibrance: state.vibrance,
    saturation: state.saturation,
    clarity: state.clarity,
    sharpen: state.sharpen,
    dehaze: state.dehaze,
    denoise: state.denoise,
    vignette: state.vignette,
    splitShadowHue: state.splitShadowHue,
    splitShadowAmt: state.splitShadowAmt,
    splitHighlightHue: state.splitHighlightHue,
    splitHighlightAmt: state.splitHighlightAmt,
    splitBalance: state.splitBalance,
    hsl: state.hsl,
    curveOn: !isCurveIdentity(state.curves),
    rotate: state.rotate,
    flipH: state.flipH,
    flipV: state.flipV,
    straighten: state.straighten,
    clipWarn: S.clipWarn,
    flarePoint: S.flarePoint,
    split: S.split,
    showOriginal: S.holding,
    seed: state.seed,
    fullShort: (S.layout ? Math.min(S.layout.crop[2], S.layout.crop[3]) : Math.min(lw, lh)) || 1,
    ...overrides,
  };
}

function ensureLut() {
  if (!S.renderer || !M.ft) return;
  const id = filmKey();
  if (S.lutFilmId === id) return;
  let lut = S.lutCache.get(id);
  if (lut) S.lutCache.delete(id);
  else lut = M.ft.buildLut(film().params);
  S.lutCache.set(id, lut);
  while (S.lutCache.size > LUT_CACHE_MAX) S.lutCache.delete(S.lutCache.keys().next().value);
  S.renderer.setLut(lut, M.ft.LUT_SIZE);
  S.lutFilmId = id;
}

function ensureCurveLut() {
  if (!S.renderer?.setCurveLut) return;
  const ident = isCurveIdentity(state.curves);
  const key = ident ? 'id' : JSON.stringify(state.curves);
  if (key === S.curveKey) return;
  S.curveKey = key;
  if (ident) S.renderer.setCurveLut(null);
  else S.renderer.setCurveLut(buildCurveLut(state.curves, 256), 256);
}

function ensureLeaks() {
  if (!M.overlays) return;
  const lk = `${state.leakSeed}|${state.leakStyle}`;
  if (S.leaksSeed !== lk) {
    S.leaks = M.overlays.makeLeaks(state.leakSeed, state.leakStyle === 'warm' ? null : { style: state.leakStyle });
    S.leaksSeed = lk;
  }
  const c = camera();
  const key = `${c.id}|${state.leakSeed}`;
  if (S.camLeaksKey !== key) {
    const cp = c.params || {};
    let hash = 0;
    for (const ch of c.id) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
    S.camLeaks = cp.leak > 0 ? M.overlays.makeLeaks((state.leakSeed ^ hash) >>> 0, { bias: cp.leakBias || 'edge' }) : [];
    S.camLeaksKey = key;
  }
}

function ensureLayout() {
  if (!S.proxy || !M.overlays?.frameLayout) { S.layout = null; return false; }
  const f = film(), c = camera();
  const geo = buildGeometry(S.fullW, S.fullH, state);
  const [lw, lh] = geo.logImg;
  const asp = aspectOverrideValue();
  const key = `${lw}x${lh}|${c.id}:${c.maskId || ''}|${f.id}|${state.cropOn}|${state.borderOn}|${asp}|${state.seed}|${S.proxy.width}`;
  if (key === S.layoutKey && S.layout) return false;
  const L = M.overlays.frameLayout(lw, lh, {
    camera: c, film: f, crop: state.cropOn, border: state.borderOn, seed: state.seed, aspectOverride: asp,
  });
  const prev = S.layout;
  S.layout = L;
  S.layoutKey = key;
  const sameFrame = prev && prev.crop.every((v, i) => Math.abs(v - L.crop[i]) < 0.5);
  if (S.frame) { releaseCanvas(S.frame.canvas); S.frame = null; }
  if (L.draw) {
    S.renderer.setParams(buildParams());
    const [w, hh] = S.renderer.previewSize();
    const proxyGeo = buildGeometry(S.proxy.width, S.proxy.height, state);
    const k = proxyGeo.logImg[0] / lw;
    const cv = mkCanvas(w, hh);
    try { L.draw(cv.getContext('2d'), 0, 0, k); } catch (e) { console.warn('[C41] frame draw failed', e); }
    S.frame = { canvas: cv, origin: [0, 0], size: [w, hh] };
  }
  S.renderer.setFrame(S.frame);
  if (!sameFrame) {
    S.dustKey = ''; S.dateKey = '';
    rebuildDust(); rebuildDate();
  }
  return true;
}

function frameSize() {
  if (S.layout) return [S.layout.crop[2], S.layout.crop[3]];
  const geo = buildGeometry(S.fullW, S.fullH, state);
  return geo.logImg;
}

const rebuildDust = debounce(() => {
  if (!S.renderer || !M.overlays || !S.proxy) return;
  const amt = state.dust;
  if (amt <= 0) {
    if (S.dust) { S.renderer.setDust(null); releaseCanvas(S.dust); S.dust = null; S.dustKey = ''; }
    requestRender();
    return;
  }
  const [fw, fh] = frameSize();
  const aspect = fw / fh;
  const key = `${aspect.toFixed(4)}|${state.dustSeed}|${amt.toFixed(2)}`;
  if (key === S.dustKey) return;
  const c = M.overlays.makeDustCanvas(aspect, state.dustSeed, amt);
  S.renderer.setDust(c);
  releaseCanvas(S.dust);
  S.dust = c;
  S.dustKey = key;
  requestRender();
}, 120);

const rebuildDate = debounce(() => {
  if (!S.renderer || !M.overlays || !S.proxy) return;
  if (!state.dateOn) { requestRender(); return; }
  const [fw, fh] = frameSize();
  const key = `${state.date}|${state.dateFormat}|${state.dateColor}|${Math.round(fw)}x${Math.round(fh)}`;
  if (key === S.dateKey && S.date) { requestRender(); return; }
  const d = M.overlays.makeDateCanvas(parseIsoDate(state.date), { format: state.dateFormat, color: state.dateColor }, fw, fh);
  S.renderer.setDate(d);
  if (S.date && S.date.canvas !== d.canvas) releaseCanvas(S.date.canvas);
  S.date = d;
  S.dateKey = key;
  requestRender();
}, 80);

const refreshScopes = debounce(() => {
  if (!S.proxy || S.exporting || !S.scope) return;
  if (!S.scopeOn && !ctl.curveEditor) return;
  try {
    const hist = S.scope.updateFromCanvas(view);
    if (hist && ctl.curveEditor) ctl.curveEditor.setHistogram(hist);
  } catch { /* ignore */ }
}, 45);

function requestRender() {
  if (S.rafPending || !S.renderer || !S.proxy || S.exporting) return;
  S.rafPending = true;
  requestAnimationFrame(() => {
    S.rafPending = false;
    if (!S.proxy || S.exporting) return;
    try {
      ensureLut();
      ensureCurveLut();
      ensureLeaks();
      ensureLayout();
      S.renderer.setParams(buildParams());
      const w0 = view.width, h0 = view.height;
      S.renderer.renderPreview();
      if (view.width !== w0 || view.height !== h0) fitCanvas();
      refreshScopes();
    } catch (e) {
      console.error('[C41] render failed', e);
    }
  });
}

function resendAll() {
  const r = S.renderer;
  if (!r || !S.proxy) return;
  r.setSource(S.proxy);
  S.lutFilmId = null;
  S.curveKey = '';
  ensureLut();
  ensureCurveLut();
  if (S.maps) r.setMaps({ hmap: S.maps.hmap, bmap: S.maps.bmap });
  r.setDust(S.dust || null);
  r.setDate(S.date || null);
  r.setFrame?.(S.frame || null);
  requestRender();
}

/* --------------------------------------------------------------- stage fit & zoom */

function resetZoom() {
  S.zoom = 1;
  S.panX = 0;
  S.panY = 0;
  fitCanvas();
}

function setZoom(z) {
  S.zoom = Math.max(1, Math.min(4, z));
  if (S.zoom <= 1.01) { S.zoom = 1; S.panX = 0; S.panY = 0; }
  fitCanvas();
}

function fitCanvas() {
  const cw = view.width, ch = view.height;
  if (!cw || !ch || !S.proxy) return;
  const r = stage.getBoundingClientRect();
  const pad = r.width < 520 ? 12 : 24;
  const aw = Math.max(1, r.width - pad * 2), ah = Math.max(1, r.height - pad * 2);
  const k = Math.min(aw / cw, ah / ch);
  const bw = Math.round(cw * k), bh = Math.round(ch * k);
  const w = Math.round(bw * S.zoom), hh = Math.round(bh * S.zoom);
  const maxPanX = Math.max(0, (w - r.width + pad * 2) * 0.5);
  const maxPanY = Math.max(0, (hh - r.height + pad * 2) * 0.5);
  S.panX = Math.max(-maxPanX, Math.min(maxPanX, S.panX));
  S.panY = Math.max(-maxPanY, Math.min(maxPanY, S.panY));
  const x = Math.round((r.width - w) / 2 + S.panX);
  const y = Math.round((r.height - hh) / 2 + S.panY);
  Object.assign(view.style, { width: `${w}px`, height: `${hh}px`, left: `${x}px`, top: `${y}px` });
  S.viewRect = { x, y, w, h: hh };
  placeSplit();
  placeStraightenGrid();

  const zb = $('btn-zoom');
  if (zb) {
    zb.textContent = S.zoom <= 1.01 ? 'Fit' : `${Math.round(S.zoom * 100)}%`;
    zb.classList.toggle('is-zoomed', S.zoom > 1.01);
  }
}

function placeStraightenGrid() {
  const gr = $('straighten-grid');
  if (!gr || gr.hidden || !S.viewRect) return;
  const r = S.viewRect;
  Object.assign(gr.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

function showStraightenGrid(on) {
  const gr = $('straighten-grid');
  if (!gr) return;
  gr.hidden = !on;
  if (on) placeStraightenGrid();
}

/* ------------------------------------------------------------------ import */

function screenCap() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const long = Math.max(screen.width || 0, screen.height || 0, window.innerWidth, window.innerHeight) * dpr;
  let cap = Math.max(PROXY_MIN, Math.min(PROXY_MAX, Math.round(long)));
  const lim = S.renderer?.limits?.maxTexture;
  if (lim) cap = Math.min(cap, lim);
  return cap;
}

function makeProxy(img, W, H) {
  const k = Math.min(1, screenCap() / Math.max(W, H));
  const tw = Math.max(1, Math.round(W * k)), th = Math.max(1, Math.round(H * k));
  let src = img, sw = W, sh = H, tmp = null;
  while (sw / 2 >= tw * 1.5 && sh / 2 >= th) {
    const nw = Math.round(sw / 2), nh = Math.round(sh / 2);
    const c = mkCanvas(nw, nh);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, nw, nh);
    if (tmp) releaseCanvas(tmp);
    tmp = c; src = c; sw = nw; sh = nh;
  }
  const out = mkCanvas(tw, th);
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, tw, th);
  if (tmp) releaseCanvas(tmp);
  return out;
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = 'async';
    let settled = false;
    const ok = () => { if (!settled) { settled = true; resolve(im); } };
    const fail = () => { if (!settled) { settled = true; reject(new Error('decode-failed')); } };
    im.onload = () => (im.naturalWidth ? ok() : fail());
    im.onerror = fail;
    im.src = url;
    if (im.decode) im.decode().then(ok, () => { if (im.complete && im.naturalWidth) ok(); });
  });
}

async function decodeBitmap(file) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return bmp.width && bmp.height ? bmp : null;
  } catch { return null; }
}

function disposeSource(src) {
  if (!src) return;
  if (typeof src.close === 'function') src.close();
  else src.src = '';
}

function isBlank(c) {
  const t = mkCanvas(16, 16);
  const g = t.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  releaseCanvas(t);
  for (let i = 0; i < d.length; i += 4) if (d[i] > 2 || d[i + 1] > 2 || d[i + 2] > 2) return false;
  return true;
}

async function importFile(file) {
  if (!file) return;
  if (!S.renderer) { toast('The editor is not available on this device.', { tone: 'error' }); return; }
  if (file.type && !file.type.startsWith('image/')) {
    toast('That file isn’t an image.', { tone: 'error' });
    return;
  }
  setBusy(true);
  const url = URL.createObjectURL(file);
  let img = null, proxy = null;
  try {
    for (const dec of [() => decodeBitmap(file), () => decodeImage(url).catch(() => null)]) {
      const im = await dec();
      if (!im) continue;
      const p = makeProxy(im, im.naturalWidth || im.width, im.naturalHeight || im.height);
      disposeSource(img); releaseCanvas(proxy);
      img = im; proxy = p;
      if (!isBlank(p)) break;
    }
  } catch (e) {
    console.error('[C41] decode failed', e);
  }
  if (!img) {
    URL.revokeObjectURL(url);
    setBusy(false);
    toast('Couldn’t open that photo. Try a JPEG, PNG, WebP or HEIC.', { tone: 'error', duration: 5000 });
    return;
  }

  try {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const oldProxy = S.proxy, oldUrl = S.imgUrl, oldImg = S.img;
    S.img = img; S.imgUrl = url; S.file = file;
    S.fullW = W; S.fullH = H;
    S.proxy = proxy;
    S.zoom = 1; S.panX = 0; S.panY = 0;

    S.renderer.setSource(proxy);
    view.width = proxy.width; view.height = proxy.height;
    releaseCanvas(oldProxy);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    disposeSource(oldImg);

    if (M.maps) {
      try {
        if (S.maps) { releaseCanvas(S.maps.hmap); releaseCanvas(S.maps.bmap); }
        S.maps = M.maps.buildMaps(proxy);
        S.renderer.setMaps({ hmap: S.maps.hmap, bmap: S.maps.bmap });
        S.flarePoint = S.maps.flare || S.flarePoint;
      } catch (e) {
        console.warn('[C41] buildMaps failed', e);
      }
    }

    let d = null;
    if (M.exif) {
      try { d = await M.exif.readExifDate(file); } catch { d = null; }
    }
    if (!(d instanceof Date) || isNaN(d)) d = new Date(file.lastModified || Date.now());
    S.exifDate = d;
    state.date = isoDate(d);
    state.seed = (Math.random() * 1e9) | 0;
    // Reset per-photo orientation so a newly imported photo starts upright
    state.rotate = 0; state.flipH = false; state.flipV = false; state.straighten = 0;
    syncControls();
    saveState();
    ctl.dateInput && (ctl.dateInput.value = state.date);

    S.dustKey = ''; S.dateKey = ''; S.layoutKey = ''; S.curveKey = '';
    ensureLayout();
    rebuildDust.flush();
    rebuildDate.flush();

    app.classList.remove('is-empty');
    app.classList.add('has-image');
    $('btn-save').disabled = !M.exporter;
    $('btn-compare').disabled = false;
    $('btn-auto').disabled = false;
    $('btn-scope').disabled = false;
    $('btn-clip').disabled = false;
    $('stage-hud').hidden = false;
    $('title-pill').hidden = false;
    history.reset(state);
    syncHistoryButtons();
    updateTitle();
    fitCanvas();
    requestRender();
    buildThumbnails();
  } catch (e) {
    console.error('[C41] import failed', e);
    toast('Something went wrong loading that photo.', { tone: 'error' });
  } finally {
    setBusy(false);
  }
}

async function loadSamplePhoto() {
  setBusy(true);
  try {
    const { makeSamplePhotoFile } = await import('./sample-photo.js');
    const file = await makeSamplePhotoFile(1800, 1200);
    await importFile(file);
    toast('Loaded Golden Coast sample photo');
  } catch (e) {
    console.error('[C41] sample failed', e);
    toast('Couldn’t generate sample photo.', { tone: 'error' });
    setBusy(false);
  }
}

function setBusy(on) { $('stage-busy').hidden = !on; }

/* -------------------------------------------------------------- auto develop */

function runAutoDevelop() {
  if (!S.proxy) return;
  const sw = 240, sh = Math.max(80, Math.round(240 * S.proxy.height / S.proxy.width));
  const c = mkCanvas(sw, sh);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(S.proxy, 0, 0, sw, sh);
  const data = g.getImageData(0, 0, sw, sh).data;
  releaseCanvas(c);

  const auto = computeAutoTone(data, sw, sh);
  Object.assign(state, auto);
  syncControls();
  saveState();
  recordHistory();
  requestRender();
  toast('Auto-Developed tone & balance', {
    action: 'Undo',
    onAction: () => doUndo(),
  });
}

/* -------------------------------------------------------------- thumbnails */

const filmCards = new Map();

function buildThumbnails() {
  if (!M.ft || !S.proxy) return;
  S.thumbCancel?.();
  const p = S.proxy;
  const side = Math.min(p.width, p.height);
  const c = mkCanvas(THUMB, THUMB);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(p, (p.width - side) / 2, (p.height - side) / 2, side, side, 0, 0, THUMB, THUMB);
  const src = g.getImageData(0, 0, THUMB, THUMB).data;
  releaseCanvas(c);
  const lin = new Float32Array(THUMB * THUMB * 3);
  const tbl = new Float32Array(256);
  for (let i = 0; i < 256; i++) tbl[i] = M.ft.srgbToLinear(i / 255);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    lin[j] = tbl[src[i]]; lin[j + 1] = tbl[src[i + 1]]; lin[j + 2] = tbl[src[i + 2]];
  }
  S.thumbLin = lin;
  for (const { canvas } of filmCards.values()) canvas.classList.remove('is-ready');

  const ids = [state.filmId, ...M.films.FILMS.map((f) => f.id).filter((id) => id !== state.filmId)];
  let i = 0;
  const out = new Float32Array(3);
  S.thumbCancel = idleLoop(() => {
    if (i >= ids.length) return false;
    const f = M.films.getFilm(ids[i++]);
    const card = filmCards.get(f.id);
    if (!card) return i < ids.length;
    try {
      const fn = M.ft.makeFilm(f.params);
      const id = new ImageData(THUMB, THUMB);
      const d = id.data;
      for (let pp = 0, q = 0; pp < lin.length; pp += 3, q += 4) {
        fn(lin[pp], lin[pp + 1], lin[pp + 2], out);
        d[q] = out[0] * 255 + 0.5; d[q + 1] = out[1] * 255 + 0.5; d[q + 2] = out[2] * 255 + 0.5; d[q + 3] = 255;
      }
      card.canvas.getContext('2d').putImageData(id, 0, 0);
      card.canvas.classList.add('is-ready');
    } catch (e) {
      console.warn('[C41] thumbnail failed for', f.id, e);
    }
    return i < ids.length;
  });
  buildLookThumbs();
}

function buildLookThumbs() {
  S.lookThumbCancel?.();
  const lin = S.thumbLin;
  if (!lin || !M.looks || !M.ft) return;
  const queue = [...lookCards.keys()].filter((id) => id !== '__match' && id !== '__save');
  for (const { canvas } of lookCards.values()) canvas?.classList.remove('is-ready');
  let i = 0;
  S.lookThumbCancel = idleLoop(() => {
    if (i >= queue.length) return false;
    const id = queue[i++];
    const card = lookCards.get(id);
    const look = M.looks.getLook(id, customLooks);
    if (card && look) {
      try { renderLookThumb(lin, look, card.canvas); card.canvas.classList.add('is-ready'); } catch { /* ignore */ }
    }
    return i < queue.length;
  });
}

function renderLookThumb(lin, look, canvas) {
  const P = M.looks.lookPatch(look);
  const base = M.films.getFilm(P.filmId);
  const fn = M.ft.makeFilm(P.lookFilm ? M.looks.mergeFilmParams(base.params, P.lookFilm) : base.params);
  const cam = M.cameras.getCamera(P.cameraId);
  const Lu = M.renderer?.lensUniforms ? M.renderer.lensUniforms(cam, P.camAmt) : { vig: 0, vigHard: 2, warmth: 0, tint: 0 };
  const wt = 0.25 * P.warmth + (Lu.warmth || 0), tn = 0.2 * P.tint + (Lu.tint || 0);
  let wr = (1 + wt) * (1 + tn * 0.5), wg = 1 - tn, wb = (1 - wt) * (1 + tn * 0.5);
  const wl = 0.2126 * wr + 0.7152 * wg + 0.0722 * wb;
  const ex = Math.pow(2, P.exposure);
  wr = wr / wl * ex; wg = wg / wl * ex; wb = wb / wl * ex;
  const leaks = P.leak > 0 && M.overlays ? M.overlays.makeLeaks(P.leakSeed ?? state.leakSeed, P.leakStyle === 'warm' ? null : { style: P.leakStyle }).slice(0, 4) : [];
  const amt = P.filmAmt;
  const id = new ImageData(THUMB, THUMB);
  const d = id.data;
  const out = new Float32Array(3);
  const hd = Math.SQRT1_2;
  for (let y = 0, p = 0, q = 0; y < THUMB; y++) {
    for (let x = 0; x < THUMB; x++, p += 3, q += 4) {
      const nx = (x + 0.5) / THUMB, ny = (y + 0.5) / THUMB;
      let k = 1;
      if (Lu.vig > 0) k = Math.pow(2, -Math.min(9, Lu.vig * Math.pow(Math.hypot(nx - 0.5, ny - 0.5) / hd, Lu.vigHard)));
      const r = lin[p] * wr * k, g = lin[p + 1] * wg * k, b = lin[p + 2] * wb * k;
      fn(r, g, b, out);
      let R = out[0], G = out[1], B = out[2];
      if (amt < 1) {
        R = amt * R + (1 - amt) * M.ft.linearToSrgb(Math.min(1, r));
        G = amt * G + (1 - amt) * M.ft.linearToSrgb(Math.min(1, g));
        B = amt * B + (1 - amt) * M.ft.linearToSrgb(Math.min(1, b));
      }
      if (leaks.length) {
        let lr = 0, lg = 0, lb = 0;
        for (const l of leaks) {
          const qx = nx - l.x, qy = (ny - l.y) / Math.max(0.01, l.stretch);
          const v = Math.exp(-(qx * qx + qy * qy) / Math.max(1e-4, l.r * l.r));
          lr += l.color[0] * v * P.leak; lg += l.color[1] * v * P.leak; lb += l.color[2] * v * P.leak;
        }
        R = 1 - (1 - R) * (1 - Math.min(1, lr)); G = 1 - (1 - G) * (1 - Math.min(1, lg)); B = 1 - (1 - B) * (1 - Math.min(1, lb));
      }
      d[q] = R * 255 + 0.5; d[q + 1] = G * 255 + 0.5; d[q + 2] = B * 255 + 0.5; d[q + 3] = 255;
    }
  }
  canvas.getContext('2d').putImageData(id, 0, 0);
}

/* -------------------------------------------------------------- UI build */

const ctl = {};

/* ------------------------------------------------------------------- looks */

const lookCards = new Map();
let customLooks = [];

function activeLook() {
  return state.lookId && M.looks ? M.looks.getLook(state.lookId, customLooks) : null;
}

function buildLooksPane() {
  const pane = document.querySelector('[data-pane="looks"]');
  if (!pane || !M.looks) return;
  customLooks = M.looks.loadCustomLooks();
  const cards = h('div', { class: 'cards looks', role: 'radiogroup', 'aria-label': 'Looks' });
  ctl.lookCards = cards;
  ctl.lookInfo = h('div', { class: 'look-info', 'aria-live': 'polite' });
  pane.append(h('div', { class: 'pane-label', text: 'Looks & Recipes' }), cards, ctl.lookInfo);
  fillLookCards();
}

function openSaveRecipeSheet() {
  if (!M.looks) return;
  const defName = M.looks.nextLookName(customLooks);
  const name = h('input', { class: 'text-input', type: 'text', value: defName, maxlength: '40', 'aria-label': 'Recipe name', enterkeyhint: 'done', autocomplete: 'off' });
  const save = h('button', { class: 'btn btn-accent', type: 'button', html: `${icon('check')}<span>Save Recipe</span>` });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const f = film();
  const sheet = new Sheet({
    title: 'Save current recipe',
    content: h('div', { class: 'match' },
      h('p', { class: 'export-hint', style: { textAlign: 'left' }, text: `Saves ${f.name}, camera, effects, curves, HSL, and all Develop adjustments as a reusable one-tap Look.` }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Look Name' }), name),
      h('div', { class: 'export-actions' }, cancel, save)),
  });
  const doSave = () => {
    const adjust = {};
    for (const k of ADJUST_KEYS) adjust[k] = state[k];
    adjust.curves = JSON.parse(JSON.stringify(state.curves));
    adjust.hsl = JSON.parse(JSON.stringify(state.hsl));
    const look = {
      id: `custom-${Date.now()}`,
      name: (name.value || '').trim() || defName,
      description: `Custom recipe based on ${f.name}.`,
      custom: true,
      filmId: state.filmId,
      film: state.lookFilm ? JSON.parse(JSON.stringify(state.lookFilm)) : null,
      filmAmt: state.filmAmt,
      cameraId: state.cameraId,
      camAmt: state.camAmt,
      effects: {
        grain: state.grain, halation: state.halation, flare: state.flare,
        leak: state.leak, leakStyle: state.leakStyle, dust: state.dust, flash: state.flashOn,
      },
      adjust,
      swatch: f.swatch?.slice(0, 2) || ['#f5a623', '#24211d'],
      created: Date.now(),
    };
    const saved = M.looks.saveCustomLook(look);
    if (!saved) { toast('Couldn’t save look (storage full).', { tone: 'error' }); return; }
    customLooks = M.looks.loadCustomLooks();
    state.lookId = saved.id;
    fillLookCards();
    saveState();
    sheet.close();
    toast(`Saved “${saved.name}”`);
  };
  save.addEventListener('click', doSave);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  cancel.addEventListener('click', () => sheet.close());
  sheet.open();
}

function fillLookCards() {
  const cards = ctl.lookCards;
  if (!cards) return;
  S.lookThumbCancel?.();
  lookCards.clear();
  cards.replaceChildren();

  const match = h('button', { class: 'card look look-match', type: 'button', 'aria-label': 'Match a photo — create a look from a reference image' },
    h('span', { class: 'card-thumb', html: icon('wand') }),
    h('span', { class: 'card-name', text: 'Match photo' }),
    h('span', { class: 'card-sub', text: 'From reference' }));
  match.addEventListener('click', () => { const inp = $('file-ref'); inp.value = ''; inp.click(); });
  cards.append(match);

  const saveCard = h('button', { class: 'card look look-save', type: 'button', 'aria-label': 'Save current edit as a custom look' },
    h('span', { class: 'card-thumb', html: icon('bookmark') }),
    h('span', { class: 'card-name', text: 'Save recipe' }),
    h('span', { class: 'card-sub', text: 'Current edit' }));
  saveCard.addEventListener('click', openSaveRecipeSheet);
  cards.append(saveCard);

  const all = [...customLooks, ...M.looks.LOOKS];
  for (const look of all) {
    const sw = look.swatch && look.swatch.length ? look.swatch : ['#555', '#222'];
    const canvas = mkCanvas(THUMB, THUMB);
    const base = M.films.getFilm(look.filmId);
    const btn = h('button', { class: 'card look', type: 'button', role: 'radio', dataset: { id: look.id }, 'aria-label': `Look: ${look.name}` },
      h('span', { class: 'card-thumb' },
        h('span', { class: 'swatch-fill', style: { background: `linear-gradient(150deg, ${sw.join(', ')})` } }),
        look.thumb ? h('img', { class: 'look-ref', src: look.thumb, alt: '' }) : null,
        canvas,
        look.custom ? h('span', { class: 'card-iso', text: 'MINE' }) : null),
      h('span', { class: 'card-name', text: look.name }),
      h('span', { class: 'card-sub', text: look.custom ? 'Custom' : (base?.name || '') }));
    const wrap = h('div', { class: 'card-wrap' }, btn);
    let pressT = 0, longPressed = false;
    btn.addEventListener('click', (e) => {
      if (longPressed) { longPressed = false; e.preventDefault(); return; }
      tapLook(look.id);
    });
    if (look.custom) {
      const edit = h('button', { class: 'card-edit', type: 'button', 'aria-label': `Edit ${look.name}`, html: icon('more') });
      edit.addEventListener('click', () => openLookEditor(look.id));
      wrap.append(edit);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      btn.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        longPressed = false;
        const x0 = e.clientX, y0 = e.clientY;
        clearTimeout(pressT);
        pressT = setTimeout(() => { longPressed = true; navigator.vibrate?.(10); openLookEditor(look.id); }, 550);
        const cancel = (ev) => {
          if (ev.type === 'pointermove' && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) return;
          clearTimeout(pressT);
          btn.removeEventListener('pointermove', cancel);
        };
        btn.addEventListener('pointermove', cancel);
        btn.addEventListener('pointerup', cancel, { once: true });
        btn.addEventListener('pointercancel', cancel, { once: true });
      });
    }
    lookCards.set(look.id, { el: btn, canvas });
    cards.append(wrap);
  }
  markLook();
  if (S.thumbLin) buildLookThumbs();
}

function tapLook(id) {
  const look = M.looks.getLook(id, customLooks);
  if (!look) return;
  if (state.lookId === id) {
    if (M.looks.isLookModified(look, state)) { applyLook(look); toast(`${look.name} restored`); }
    return;
  }
  applyLook(look);
}

function applyLook(look) {
  const p = M.looks.lookPatch(look);
  if (M.films.getFilm(p.filmId)?.id !== p.filmId) p.filmId = M.films.DEFAULT_FILM_ID;
  if (M.cameras.getCamera(p.cameraId)?.id !== p.cameraId) p.cameraId = M.cameras.DEFAULT_CAMERA_ID;
  const dustChanged = p.dust !== state.dust || ('dustSeed' in p && p.dustSeed !== state.dustSeed);
  Object.assign(state, p);
  state.lookId = look.id;
  syncControls();
  saveState();
  recordHistory();
  if (dustChanged) rebuildDust();
  requestRender();
  scrollCardIntoView(ctl.lookCards, lookCards.get(look.id)?.el.parentElement);
}

function syncControls() {
  markFilm(); markCamera();
  for (const k of ['cropOn', 'borderOn', 'flashOn', 'filmAmt', 'camAmt', ...ADJUST_KEYS, ...EFFECT_KEYS, 'straighten']) {
    ctl[k]?.set?.(state[k]);
  }
  ctl.leakStyle?.set(state.leakStyle);
  ctl.aspectChips?.set(state.aspect);
  ctl.curveEditor?.set(state.curves);
  ctl.syncHslSliders?.();
  ctl.syncSplitSwatches?.();
  ctl.syncGeoButtons?.();
  ctl.syncDevBadges?.();
  markLook();
}

function markLook() {
  if (!M.looks) return;
  const look = activeLook();
  const modified = !!look && M.looks.isLookModified(look, state);
  for (const [id, { el }] of lookCards) {
    const on = id === state.lookId;
    el.setAttribute('aria-checked', String(on));
    el.classList.toggle('is-modified', on && modified);
    const sub = el.querySelector('.card-sub');
    if (sub) {
      const lk = M.looks.getLook(id, customLooks);
      sub.textContent = on && modified ? 'Edited' : (lk?.custom ? 'Custom' : (M.films.getFilm(lk?.filmId)?.name || ''));
    }
  }
  if (ctl.lookInfo) {
    if (look) {
      ctl.lookInfo.replaceChildren(
        h('strong', { text: look.name }),
        h('span', { text: modified ? ' — edited. Tap the look again to restore it.' : ` — ${look.description || (look.custom ? 'Your custom recipe.' : '')}` }));
    } else {
      ctl.lookInfo.replaceChildren(h('span', { text: 'One tap sets film, camera, colour grade & effects — or match any reference photo.' }));
    }
  }
  updateTitle(look, modified);
}

function updateTitle(look = activeLook(), modified = look ? M.looks.isLookModified(look, state) : false) {
  const f = M.films.getFilm(state.filmId);
  const filmName = `${f.brand ? f.brand + ' ' : ''}${f.name}`;
  const el = $('title-film');
  if (el) el.textContent = look ? `${look.name}${modified ? ' · edited' : ''}` : filmName;
  const dot = $('title-dot');
  if (dot && f.swatch?.[0]) dot.style.background = f.swatch[0];
}

/* ------------------------------------------------------- match a photo */

function refThumb(img, side = 72) {
  const c = mkCanvas(side, side);
  const g = c.getContext('2d', { willReadFrequently: true });
  const W = img.naturalWidth, H = img.naturalHeight, s = Math.min(W, H);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(img, (W - s) / 2, (H - s) / 2, s, s, 0, 0, side, side);
  let url = '';
  for (const q of [0.72, 0.6, 0.45]) {
    url = c.toDataURL('image/jpeg', q);
    if (url.length <= 8000) break;
  }
  const d = g.getImageData(0, 0, side, side).data;
  const acc = [[0, 0, 0, 0], [0, 0, 0, 0]];
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = (y * side + x) * 4, a = acc[x < side / 2 ? 0 : 1];
    a[0] += d[i]; a[1] += d[i + 1]; a[2] += d[i + 2]; a[3]++;
  }
  const hex = (a) => '#' + [0, 1, 2].map((k) => Math.round(a[k] / a[3]).toString(16).padStart(2, '0')).join('');
  releaseCanvas(c);
  return { thumb: url.length <= 11000 ? url : undefined, swatch: [hex(acc[0]), hex(acc[1])] };
}

function snapshotWith(patch, maxSide = 640) {
  if (!S.renderer || !S.proxy || S.exporting) return null;
  const saved = state;
  let out = null;
  try {
    state = { ...state, ...patch };
    ensureLut(); ensureCurveLut(); ensureLeaks();
    S.renderer.setParams(buildParams({ split: -1, showOriginal: false, clipWarn: false }));
    S.renderer.renderPreview();
    const k = Math.min(1, maxSide / Math.max(view.width, view.height));
    out = mkCanvas(Math.max(1, Math.round(view.width * k)), Math.max(1, Math.round(view.height * k)));
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(view, 0, 0, out.width, out.height);
  } catch (e) {
    console.warn('[C41] snapshot failed', e);
    out = null;
  } finally {
    state = saved;
    try {
      ensureLut(); ensureCurveLut(); ensureLeaks();
      S.renderer.setParams(buildParams());
      S.renderer.renderPreview();
    } catch { /* next requestRender recovers */ }
  }
  return out;
}

async function startMatch(file) {
  if (!file) return;
  if (!M.looks) { toast('Looks aren’t available.', { tone: 'error' }); return; }
  if (file.type && !file.type.startsWith('image/')) { toast('That file isn’t an image.', { tone: 'error' }); return; }
  const ctrl = new AbortController();
  const refUrl = URL.createObjectURL(file);
  const refImg = h('img', { class: 'match-ref', src: refUrl, alt: 'Reference photo' });
  const bar = h('div', { class: 'progress-bar' });
  const pctEl = h('span', { text: '0%' });
  const status = h('span', { text: 'Reading colour & tone…' });
  const cancel = h('button', { class: 'btn btn-block', type: 'button', text: 'Cancel' });
  const body = h('div', { class: 'match' },
    h('div', { class: 'match-hero' }, refImg),
    h('div', { class: 'export-progress' },
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Matching progress' }, bar),
      h('div', { class: 'progress-meta' }, status, pctEl),
      cancel));
  let done = false;
  const sheet = new Sheet({
    title: 'Matching…', content: body, className: 'sheet-match',
    onClose: () => { if (!done) ctrl.abort(); setTimeout(() => URL.revokeObjectURL(refUrl), 600); },
  });
  cancel.addEventListener('click', () => { ctrl.abort(); sheet.close(); });
  sheet.open();

  const fail = (msg) => { done = true; if (sheet.isOpen) sheet.close(); toast(msg, { tone: 'error', duration: 5000 }); };

  let mod;
  try {
    mod = await import('./look-match.js');
    if (typeof mod.matchLook !== 'function') throw new Error('matchLook missing');
  } catch (e) {
    console.warn('[C41] look-match.js unavailable', e);
    fail('Photo matching isn’t available yet.');
    return;
  }
  if (ctrl.signal.aborted) return;

  let res, img;
  try {
    const stages = [[0.25, 'Reading colour & tone…'], [0.6, 'Fitting the film curve…'], [0.95, 'Fine-tuning…'], [2, 'Almost there…']];
    res = await mod.matchLook(file, {
      signal: ctrl.signal,
      onProgress: (p) => {
        const v = Math.max(0, Math.min(1, +p || 0));
        bar.style.width = `${(v * 100).toFixed(1)}%`;
        pctEl.textContent = `${Math.round(v * 100)}%`;
        status.textContent = stages.find(([t]) => v < t)[1];
      },
    });
    img = await decodeImage(refUrl).catch(() => null);
  } catch (e) {
    if (ctrl.signal.aborted || e?.name === 'AbortError') {
      done = true;
      if (sheet.isOpen) sheet.close();
      toast('Match cancelled');
      return;
    }
    console.error('[C41] match failed', e);
    fail(`Couldn’t match that photo${e?.message ? ` (${e.message})` : ''}.`);
    return;
  }
  if (ctrl.signal.aborted || !sheet.isOpen) return;
  if (!res || typeof res !== 'object' || !res.film) { fail('Couldn’t match that photo.'); return; }

  const fp = { ...res.film };
  if (res.grainParams && typeof res.grainParams === 'object') fp.grain = { ...(fp.grain || {}), ...res.grainParams };
  const ref = img ? refThumb(img) : { thumb: undefined, swatch: ['#c9b8a8', '#6d625a'] };
  const look = {
    id: `custom-${Date.now()}`, name: M.looks.nextLookName(customLooks), description: 'Matched from a photo.', custom: true,
    filmId: M.films.DEFAULT_FILM_ID, film: fp, filmAmt: 1, cameraId: 'none', camAmt: 1,
    effects: { ...(res.effects || {}) }, adjust: {}, swatch: ref.swatch, thumb: ref.thumb, created: Date.now(),
  };

  const patch = { ...M.looks.lookPatch(look) };
  const snap = snapshotWith(patch);
  const after = snap
    ? h('figure', { class: 'match-fig' }, snap, h('figcaption', { text: 'Your photo' }))
    : h('figure', { class: 'match-fig is-empty' }, h('div', { class: 'match-placeholder', text: 'Open a photo to see the look on it — it’ll apply automatically.' }), h('figcaption', { text: 'Your photo' }));
  const name = h('input', { class: 'text-input', type: 'text', value: look.name, maxlength: '40', 'aria-label': 'Look name', enterkeyhint: 'done', autocomplete: 'off' });
  const save = h('button', { class: 'btn btn-accent', type: 'button', html: `${icon('check')}<span>Save look</span>` });
  const discard = h('button', { class: 'btn', type: 'button', text: 'Discard' });
  const result = h('div', { class: 'match' },
    h('div', { class: 'match-compare' },
      h('figure', { class: 'match-fig' }, h('img', { src: refUrl, alt: 'Reference photo' }), h('figcaption', { text: 'Reference' })),
      after),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), name),
    h('div', { class: 'export-actions' }, discard, save));
  done = true;
  sheet.setTitle('Matched look');
  sheet.body.replaceChildren(result);

  const doSave = () => {
    look.name = (name.value || '').trim() || look.name;
    const saved = M.looks.saveCustomLook(look);
    if (!saved) { toast('Couldn’t save the look (storage full or unavailable).', { tone: 'error' }); return; }
    customLooks = M.looks.loadCustomLooks();
    fillLookCards();
    applyLook(saved);
    sheet.close();
    toast(S.proxy ? `Saved “${saved.name}”` : `Saved “${saved.name}” — it’ll apply to the next photo you open`);
  };
  save.addEventListener('click', doSave);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); doSave(); } });
  discard.addEventListener('click', () => sheet.close());
}

function openLookEditor(id) {
  const look = M.looks.getLook(id, customLooks);
  if (!look || !look.custom) return;
  const name = h('input', { class: 'text-input', type: 'text', value: look.name, maxlength: '40', 'aria-label': 'Look name', enterkeyhint: 'done', autocomplete: 'off' });
  const save = h('button', { class: 'btn btn-accent', type: 'button', text: 'Rename' });
  const del = h('button', { class: 'btn btn-danger', type: 'button', html: `${icon('trash')}<span>Delete</span>` });
  const sheet = new Sheet({
    title: look.name,
    content: h('div', { class: 'match' },
      look.thumb ? h('div', { class: 'edit-head' }, h('img', { class: 'edit-thumb', src: look.thumb, alt: '' }), h('p', { class: 'export-hint', text: 'Matched from this photo.' })) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), name),
      h('div', { class: 'export-actions' }, del, save)),
  });
  const doRename = () => {
    const n = (name.value || '').trim();
    if (!n) { name.focus(); return; }
    if (n !== look.name) {
      if (!M.looks.saveCustomLook({ ...look, name: n })) { toast('Couldn’t save.', { tone: 'error' }); return; }
      customLooks = M.looks.loadCustomLooks();
      fillLookCards();
      toast('Look renamed');
    }
    sheet.close();
  };
  save.addEventListener('click', doRename);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRename(); } });
  let armed = 0;
  del.addEventListener('click', () => {
    if (!armed) {
      del.classList.add('is-armed');
      del.lastChild.textContent = 'Tap to confirm';
      armed = setTimeout(() => { armed = 0; del.classList.remove('is-armed'); del.lastChild.textContent = 'Delete'; }, 3000);
      return;
    }
    clearTimeout(armed);
    M.looks.deleteCustomLook(id);
    customLooks = M.looks.loadCustomLooks();
    if (state.lookId === id) { state.lookId = null; saveState(); }
    fillLookCards();
    sheet.close();
    toast(`Deleted “${look.name}”`);
  });
  sheet.open();
}

/* -------------------------------------------------------------------- film */

function buildFilmPane() {
  const pane = document.querySelector('[data-pane="film"]');
  const { FILMS, FILM_CATEGORIES } = M.films;
  let cat = loadUi().filmCat || 'all';
  let query = '';

  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: `Search ${FILMS.length} stocks (Portra, Tri-X, 800T…)`,
    'aria-label': 'Search film stocks',
    autocomplete: 'off',
  });
  const searchClear = h('button', { class: 'search-clear', type: 'button', hidden: true, 'aria-label': 'Clear search', html: icon('close') });
  const searchWrap = h('div', { class: 'search-wrap' },
    h('span', { class: 'search-ico', html: icon('search') }),
    searchInput,
    searchClear);

  const chips = new ChipGroup({
    label: 'Film category',
    items: [{ id: 'all', label: 'All' }, ...FILM_CATEGORIES],
    value: cat,
    onChange: (id) => { cat = id; applyFilter(); saveUi({ filmCat: id }); cards.scrollLeft = 0; },
  });

  const cards = h('div', { class: 'cards', role: 'radiogroup', 'aria-label': 'Film stock' });
  for (const f of FILMS) {
    const sw = f.swatch && f.swatch.length ? f.swatch : ['#555', '#222'];
    const canvas = mkCanvas(THUMB, THUMB);
    const el = h('button', { class: 'card', type: 'button', role: 'radio', dataset: { id: f.id, cat: f.category }, 'aria-label': `${f.brand} ${f.name}` },
      h('span', { class: 'card-thumb' },
        h('span', { class: 'swatch-fill', style: { background: `linear-gradient(150deg, ${sw.join(', ')})` } }),
        canvas,
        f.iso ? h('span', { class: 'card-iso', text: String(f.iso) }) : null,
        h('span', { class: 'card-stripe' }, sw.map((c) => h('i', { style: { background: c } })))),
      h('span', { class: 'card-brand', text: f.brand || '' }),
      h('span', { class: 'card-name', text: f.name }));
    el.addEventListener('click', () => selectFilm(f.id));
    filmCards.set(f.id, { el, canvas, searchHay: `${f.brand} ${f.name} ${f.iso || ''} ${f.process || ''} ${f.category}`.toLowerCase() });
    cards.append(el);
  }

  function applyFilter() {
    const q = query.trim().toLowerCase();
    for (const f of FILMS) {
      const entry = filmCards.get(f.id);
      const catOk = cat === 'all' || f.category === cat;
      const qOk = !q || entry.searchHay.includes(q);
      entry.el.hidden = !(catOk && qOk);
    }
  }
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    searchClear.hidden = !query;
    applyFilter();
  });
  searchClear.addEventListener('click', () => {
    query = ''; searchInput.value = ''; searchClear.hidden = true;
    applyFilter(); searchInput.focus();
  });
  applyFilter();

  ctl.filmAmt = new Slider({
    label: 'Film Strength', min: 0, max: 1.5, step: 0.01, value: state.filmAmt, defaultValue: 1, format: pct,
    onInput: (v) => set('filmAmt', v),
    onChange: () => recordHistory(),
  });
  const info = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'About this film', html: icon('info') });
  info.addEventListener('click', openFilmInfo);

  pane.append(
    searchWrap,
    chips.el,
    h('div', { class: 'row' }, ctl.filmAmt.el, info),
    cards);
  ctl.filmCards = cards;
  ctl.filmChips = chips;
  markFilm();
}

function scrollCardIntoView(container, el) {
  if (!el || el.hidden) return;
  const cr = container.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (er.left < cr.left + 16 || er.right > cr.right - 16) {
    container.scrollTo({ left: container.scrollLeft + (er.left - cr.left) - (cr.width - er.width) / 2, behavior: 'smooth' });
  }
}

function markFilm() {
  for (const [id, { el }] of filmCards) el.setAttribute('aria-checked', String(id === state.filmId));
  updateTitle();
}

function selectFilm(id) {
  if (state.filmId === id && !state.lookFilm) return;
  state.filmId = id;
  state.lookFilm = null;
  markFilm();
  markLook();
  saveState();
  recordHistory();
  requestRender();
  scrollCardIntoView(ctl.filmCards, filmCards.get(id)?.el);
}

/* ------------------------------------------------------------------ camera */

const camCards = new Map();
const FORMAT_LABEL = { '35mm': '35mm', 'half-frame': 'Half', '6x6': '6×6', '6x7': '6×7', '6x12': '6×12', '35mm-pano': 'Pano' };
const camGroupOf = (c) => (M.cameras.cameraGroup ? M.cameras.cameraGroup(c) : 'classic');

function buildCameraPane() {
  const pane = document.querySelector('[data-pane="camera"]');
  const groups = M.cameras.GROUPS || [];
  let grp = loadUi().camGroup || 'all';
  if (grp !== 'all' && !groups.some((g) => g.id === grp)) grp = 'all';
  if (grp !== 'all' && state.cameraId !== 'none' && camGroupOf(M.cameras.getCamera(state.cameraId)) !== grp) grp = 'all';
  const chips = groups.length > 1 ? new ChipGroup({
    label: 'Camera group',
    items: [{ id: 'all', label: 'All' }, ...groups],
    value: grp,
    onChange: (id) => { grp = id; applyFilter(); saveUi({ camGroup: id }); cards.scrollLeft = 0; },
  }) : null;
  const cards = h('div', { class: 'cards', role: 'radiogroup', 'aria-label': 'Camera' });
  for (const c of M.cameras.CAMERAS) {
    const el = h('button', { class: 'card cam', type: 'button', role: 'radio', dataset: { id: c.id }, 'aria-label': `${c.brand} ${c.name}`.trim() },
      h('span', { class: 'card-thumb', html: icon(`body-${c.body || 'none'}`) },
        c.year ? h('span', { class: 'card-year', text: `’${String(c.year).slice(2)}` }) : null,
        c.id !== 'none' ? h('span', { class: 'card-fmt', text: c.badge || FORMAT_LABEL[c.format] || c.format }) : null),
      h('span', { class: 'card-brand', text: c.brand || '—' }),
      h('span', { class: 'card-name', text: c.name }),
      h('span', { class: 'card-sub', text: c.lens || 'Neutral' }));
    el.addEventListener('click', () => selectCamera(c.id));
    camCards.set(c.id, el);
    cards.append(el);
  }
  function applyFilter() {
    for (const c of M.cameras.CAMERAS) camCards.get(c.id).hidden = !(grp === 'all' || c.id === 'none' || camGroupOf(c) === grp);
  }
  applyFilter();
  ctl.camAmt = new Slider({
    label: 'Lens character', min: 0, max: M.renderer?.CAM_AMT_MAX ?? 1.5, step: 0.01, value: state.camAmt, defaultValue: 1, format: pct,
    onInput: (v) => set('camAmt', v),
    onChange: () => recordHistory(),
  });
  const info = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'About this camera', html: icon('info') });
  info.addEventListener('click', openCameraInfo);
  const tog = (key, label) => {
    ctl[key] = new Toggle({
      label, value: state[key],
      onChange: (v) => { state[key] = v; saveState(); recordHistory(); markLook(); requestRender(); },
    });
    return ctl[key].el;
  };
  ctl.camMaskRow = h('div', { class: 'cam-opts', hidden: true });
  const gels = M.cameras.FLASH_GELS || [];
  ctl.gel = gels.length ? new ChipGroup({
    label: 'Flash gel', className: 'wrap',
    items: gels.map((g) => ({ id: g.id, label: g.label, swatch: g.swatch })),
    value: state.gel,
    onChange: (v) => {
      state.gel = v;
      if (v !== 'none' && !state.flashOn) { state.flashOn = true; ctl.flashOn?.set(true); }
      saveState(); recordHistory(); markLook(); requestRender();
    },
  }) : null;
  ctl.gelRow = h('div', { class: 'cam-opts', hidden: true }, h('div', { class: 'opts-label', text: 'Flash gel' }), ctl.gel?.el);
  pane.append(
    chips ? h('div', { style: { paddingTop: '2px' } }, chips.el) : h('div', { class: 'pane-label', text: 'Camera & lens' }),
    cards,
    h('div', { class: 'row' }, ctl.camAmt.el, info),
    ctl.camMaskRow,
    h('div', { class: 'ctl cam-toggles' },
      tog('cropOn', 'Crop to format'),
      tog('borderOn', 'Film border'),
      tog('flashOn', 'Flash')),
    ctl.gelRow);
  ctl.camCards = cards;
  ctl.camChips = chips;
  markCamera();
}

function syncCameraOpts() {
  const c = M.cameras.getCamera(state.cameraId);
  if (ctl.gelRow) {
    ctl.gelRow.hidden = !c.flashGels;
    ctl.gel?.set(state.gel);
  }
  if (!ctl.camMaskRow) return;
  const masks = Array.isArray(c.masks) ? c.masks : null;
  ctl.camMaskRow.hidden = !masks;
  if (!masks) { ctl.camMaskRow.replaceChildren(); ctl.camMaskKey = ''; return; }
  const cur = camera().maskId;
  if (ctl.camMaskKey !== c.id) {
    ctl.camMask = new ChipGroup({
      label: 'Format', className: 'wrap',
      items: masks.map((m) => ({ id: m.id, label: m.label })),
      value: cur,
      onChange: (v) => {
        state.camMasks = { ...(state.camMasks || {}), [c.id]: v };
        saveState(); recordHistory(); markLook(); requestRender();
      },
    });
    ctl.camMaskRow.replaceChildren(h('div', { class: 'opts-label', text: 'Format' }), ctl.camMask.el);
    ctl.camMaskKey = c.id;
  } else {
    ctl.camMask?.set(cur);
  }
}

function markCamera() {
  for (const [id, el] of camCards) el.setAttribute('aria-checked', String(id === state.cameraId));
  syncCameraOpts();
}

function selectCamera(id) {
  if (state.cameraId === id) return;
  state.cameraId = id;
  const want = id === 'none' ? null : camGroupOf(M.cameras.getCamera(id));
  if (ctl.camChips && want && ctl.camChips.value !== 'all' && ctl.camChips.value !== want) ctl.camChips.buttons.get('all')?.click();
  markCamera();
  markLook();
  saveState();
  recordHistory();
  requestRender();
  scrollCardIntoView(ctl.camCards, camCards.get(id));
}

/* ----------------------------------------------------- Develop (Digital Lab) */

function buildAdjustPane() {
  const pane = document.querySelector('[data-pane="adjust"]');
  const subDefs = [
    { id: 'light',  label: 'Light' },
    { id: 'curves', label: 'Curves' },
    { id: 'color',  label: 'Color' },
    { id: 'detail', label: 'Detail' },
    { id: 'crop',   label: 'Crop' },
  ];

  const subBar = h('div', { class: 'dev-subtabs', role: 'tablist', 'aria-label': 'Develop categories' });
  const subBtns = new Map();
  const subPanes = new Map();

  for (const s of subDefs) {
    const b = h('button', { class: 'dev-subtab', type: 'button', role: 'tab', 'aria-selected': 'false', dataset: { sub: s.id }, text: s.label });
    const p = h('div', { class: 'dev-subpane', role: 'tabpanel', hidden: true });
    b.addEventListener('click', () => showSub(s.id));
    subBtns.set(s.id, b);
    subPanes.set(s.id, p);
    subBar.append(b);
  }

  const showSub = (id) => {
    for (const [k, b] of subBtns) b.setAttribute('aria-selected', String(k === id));
    for (const [k, p] of subPanes) p.hidden = k !== id;
    saveUi({ devSub: id });
    if (id === 'curves' && ctl.curveEditor) ctl.curveEditor.paint();
  };

  const mkSlider = (key, label, min, max, format, extra = {}) => {
    const def = defaults()[key];
    const s = new Slider({
      label, min, max, step: extra.step ?? 0.01, value: state[key], defaultValue: def,
      bipolar: extra.bipolar ?? (min < 0 && max > 0), format,
      gradient: extra.gradient || null,
      onInput: (v) => {
        set(key, v);
        extra.onInputExtra?.(v);
      },
      onChange: () => {
        recordHistory();
        extra.onChangeExtra?.();
      },
    });
    ctl[key] = s;
    return h('div', { class: 'ctl' }, s.el);
  };

  // ---- 1. LIGHT ----
  const autoBtn = h('button', { class: 'btn btn-auto-hero', type: 'button', html: `${icon('wand')}<span>Auto Develop</span>` });
  autoBtn.addEventListener('click', runAutoDevelop);
  const resetBtn = h('button', { class: 'btn btn-ghost', type: 'button', html: `${icon('reset')}<span>Reset</span>` });
  resetBtn.addEventListener('click', resetAll);

  subPanes.get('light').append(
    h('div', { class: 'auto-bar' }, autoBtn, resetBtn),
    mkSlider('exposure', 'Exposure', -2, 2, ev),
    mkSlider('contrast', 'Contrast', -1, 1, signed),
    mkSlider('highlights', 'Highlights', -1, 1, signed),
    mkSlider('shadows', 'Shadows', -1, 1, signed),
    mkSlider('whites', 'Whites', -1, 1, signed),
    mkSlider('blacks', 'Blacks', -1, 1, signed),
    mkSlider('fade', 'Matte Fade', 0, 1, pct, { bipolar: false }));

  // ---- 2. CURVES ----
  ctl.curveEditor = new ToneCurveEditor({
    curves: state.curves,
    onInput: (c) => {
      state.curves = c;
      saveState();
      markLook();
      ctl.syncDevBadges?.();
      requestRender();
    },
    onChange: () => recordHistory(),
  });
  subPanes.get('curves').append(ctl.curveEditor.el);

  // ---- 3. COLOR (WB + Vibrance/Sat + 8-Band HSL + Split Toning) ----
  const wbGrad = 'linear-gradient(90deg, #4b83e6 0%, #302c28 50%, #f5a623 100%)';
  const tintGrad = 'linear-gradient(90deg, #45c774 0%, #302c28 50%, #e056b7 100%)';
  const rainbowGrad = 'linear-gradient(90deg, #ff4545, #ffa534, #ffe838, #46d96b, #36d9d9, #4686ff, #9b5cff, #f24db8, #ff4545)';

  // 8-Band HSL Color Mixer
  let activeBand = 'orange';
  const hslDotBtns = new Map();
  const hslBandName = h('span', { class: 'hsl-band-name', text: 'Orange' });
  const hslResetBtn = h('button', { class: 'curve-reset-btn', type: 'button', text: 'Reset HSL' });
  const hslDots = h('div', { class: 'hsl-dots', role: 'tablist', 'aria-label': 'HSL Colour Band' });

  const setHslVal = (idx, v) => {
    if (!state.hsl[activeBand]) state.hsl[activeBand] = [0, 0, 0];
    state.hsl[activeBand][idx] = v;
    saveState();
    markLook();
    syncHslDots();
    ctl.syncDevBadges?.();
    requestRender();
  };

  const hslHue = new Slider({ label: 'Hue', min: -30, max: 30, step: 1, value: 0, defaultValue: 0, bipolar: true, format: degDelta, onInput: (v) => setHslVal(0, v), onChange: () => recordHistory() });
  const hslSat = new Slider({ label: 'Saturation', min: -1, max: 1, step: 0.01, value: 0, defaultValue: 0, bipolar: true, format: signed, onInput: (v) => setHslVal(1, v), onChange: () => recordHistory() });
  const hslLum = new Slider({ label: 'Luminance', min: -0.5, max: 0.5, step: 0.01, value: 0, defaultValue: 0, bipolar: true, format: signed, onInput: (v) => setHslVal(2, v), onChange: () => recordHistory() });

  const syncHslDots = () => {
    for (const b of HSL_BANDS) {
      const btn = hslDotBtns.get(b.id);
      const v = state.hsl?.[b.id] || [0, 0, 0];
      const mod = Math.abs(v[0]) > 0.1 || Math.abs(v[1]) > 0.005 || Math.abs(v[2]) > 0.005;
      btn?.setAttribute('aria-selected', String(b.id === activeBand));
      btn?.classList.toggle('is-mod', mod);
    }
  };

  ctl.syncHslSliders = () => {
    const b = HSL_BANDS.find((x) => x.id === activeBand) || HSL_BANDS[0];
    hslBandName.textContent = b.label;
    const v = state.hsl?.[activeBand] || [0, 0, 0];
    hslHue.set(v[0] || 0);
    hslSat.set(v[1] || 0);
    hslLum.set(v[2] || 0);
    syncHslDots();
  };

  for (const b of HSL_BANDS) {
    const btn = h('button', { class: 'hsl-dot-btn', type: 'button', role: 'tab', 'aria-label': `${b.label} band`, 'aria-selected': String(b.id === activeBand) },
      h('span', { class: 'hsl-dot', style: { background: b.color } }));
    btn.addEventListener('click', () => { activeBand = b.id; ctl.syncHslSliders(); });
    hslDotBtns.set(b.id, btn);
    hslDots.append(btn);
  }
  hslResetBtn.addEventListener('click', () => {
    state.hsl = defaultHsl();
    ctl.syncHslSliders();
    saveState();
    recordHistory();
    markLook();
    ctl.syncDevBadges?.();
    requestRender();
  });

  const hslBox = h('div', { class: 'hsl-box' },
    h('div', { class: 'hsl-head' }, h('span', { class: 'hsl-title', text: 'HSL Mixer' }), hslBandName, hslResetBtn),
    hslDots,
    h('div', { class: 'ctl' }, hslHue.el),
    h('div', { class: 'ctl' }, hslSat.el),
    h('div', { class: 'ctl' }, hslLum.el));

  // Split Toning Card
  const shDot = h('i', { class: 'split-chip-dot' });
  const hiDot = h('i', { class: 'split-chip-dot' });
  ctl.syncSplitSwatches = () => {
    const s = hueToRgb(state.splitShadowHue);
    const hi = hueToRgb(state.splitHighlightHue);
    shDot.style.background = `rgb(${Math.round(s[0] * 255)},${Math.round(s[1] * 255)},${Math.round(s[2] * 255)})`;
    hiDot.style.background = `rgb(${Math.round(hi[0] * 255)},${Math.round(hi[1] * 255)},${Math.round(hi[2] * 255)})`;
  };
  const splitBox = h('div', { class: 'split-box' },
    h('div', { class: 'split-swatch-row' },
      h('span', { class: 'split-badge' }, shDot, 'Shadows'),
      h('span', { class: 'split-badge' }, hiDot, 'Highlights')),
    mkSlider('splitShadowHue', 'Shadow Hue', 0, 360, degInt, { step: 1, bipolar: false, gradient: rainbowGrad, onInputExtra: () => ctl.syncSplitSwatches() }),
    mkSlider('splitShadowAmt', 'Shadow Tint', 0, 1, pct, { bipolar: false }),
    mkSlider('splitHighlightHue', 'Highlight Hue', 0, 360, degInt, { step: 1, bipolar: false, gradient: rainbowGrad, onInputExtra: () => ctl.syncSplitSwatches() }),
    mkSlider('splitHighlightAmt', 'Highlight Tint', 0, 1, pct, { bipolar: false }),
    mkSlider('splitBalance', 'Balance', -1, 1, signed));

  subPanes.get('color').append(
    mkSlider('warmth', 'Temperature', -1, 1, signed, { gradient: wbGrad }),
    mkSlider('tint', 'Tint', -1, 1, signed, { gradient: tintGrad }),
    mkSlider('vibrance', 'Vibrance', -1, 1, signed),
    mkSlider('saturation', 'Saturation', -1, 1, signed),
    hslBox,
    splitBox);

  // ---- 4. DETAIL (Optical DSP) ----
  subPanes.get('detail').append(
    mkSlider('clarity', 'Clarity', -0.8, 0.8, signed),
    mkSlider('sharpen', 'Sharpen', 0, 1, pct, { bipolar: false }),
    mkSlider('dehaze', 'Dehaze', -1, 1, signed),
    mkSlider('denoise', 'Denoise (Bilateral)', 0, 1, pct, { bipolar: false }),
    mkSlider('vignette', 'Vignette', -1, 1, signed));

  // ---- 5. CROP & GEOMETRY ----
  const mkGeoBtn = (ico, lbl, onClick) => {
    const b = h('button', { class: 'geo-btn', type: 'button', html: `${icon(ico)}<span>${lbl}</span>` });
    b.addEventListener('click', onClick);
    return b;
  };
  const btnRotL = mkGeoBtn('rotateL', 'Rotate L', () => {
    state.rotate = (state.rotate + 270) % 360;
    S.layoutKey = '';
    saveState(); recordHistory(); ctl.syncGeoButtons(); ctl.syncDevBadges(); requestRender();
  });
  const btnRotR = mkGeoBtn('rotateR', 'Rotate R', () => {
    state.rotate = (state.rotate + 90) % 360;
    S.layoutKey = '';
    saveState(); recordHistory(); ctl.syncGeoButtons(); ctl.syncDevBadges(); requestRender();
  });
  const btnFlipH = mkGeoBtn('flipH', 'Flip H', () => {
    state.flipH = !state.flipH;
    saveState(); recordHistory(); ctl.syncGeoButtons(); ctl.syncDevBadges(); requestRender();
  });
  const btnFlipV = mkGeoBtn('flipV', 'Flip V', () => {
    state.flipV = !state.flipV;
    saveState(); recordHistory(); ctl.syncGeoButtons(); ctl.syncDevBadges(); requestRender();
  });

  ctl.syncGeoButtons = () => {
    btnFlipH.setAttribute('aria-pressed', String(!!state.flipH));
    btnFlipV.setAttribute('aria-pressed', String(!!state.flipV));
  };

  const straightenCtl = mkSlider('straighten', 'Straighten', -45, 45, degSigned, {
    step: 0.1,
    onInputExtra: () => showStraightenGrid(true),
    onChangeExtra: () => showStraightenGrid(false),
  });
  ctl.straighten.track.addEventListener('pointerdown', () => { if (S.proxy) showStraightenGrid(true); });
  ctl.straighten.track.addEventListener('pointerup', () => showStraightenGrid(false));
  ctl.straighten.track.addEventListener('pointercancel', () => showStraightenGrid(false));

  ctl.aspectChips = new ChipGroup({
    label: 'Aspect ratio',
    className: 'wrap',
    items: ASPECT_PRESETS.map((a) => ({ id: a.id, label: a.label })),
    value: state.aspect,
    onChange: (v) => {
      state.aspect = v;
      S.layoutKey = '';
      saveState(); recordHistory(); ctl.syncDevBadges(); requestRender();
    },
  });

  const resetGeoBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', html: `${icon('reset')}<span>Reset Geometry</span>` });
  resetGeoBtn.addEventListener('click', () => {
    state.rotate = 0; state.flipH = false; state.flipV = false; state.straighten = 0; state.aspect = 'auto';
    S.layoutKey = '';
    syncControls(); saveState(); recordHistory(); requestRender();
  });

  subPanes.get('crop').append(
    h('div', { class: 'geo-bar' }, btnRotL, btnRotR, btnFlipH, btnFlipV),
    straightenCtl,
    h('div', { class: 'cam-opts' }, h('div', { class: 'opts-label', text: 'Aspect Ratio' }), ctl.aspectChips.el),
    h('div', { class: 'pane-foot' }, resetGeoBtn));

  // Sub-tab edit indicator pips
  ctl.syncDevBadges = () => {
    const nz = (keys) => keys.some((k) => Math.abs((state[k] || 0) - (defaults()[k] || 0)) > 0.004);
    subBtns.get('light')?.classList.toggle('has-edits', nz(['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'fade']));
    subBtns.get('curves')?.classList.toggle('has-edits', !isCurveIdentity(state.curves));
    subBtns.get('color')?.classList.toggle('has-edits', nz(['warmth', 'tint', 'vibrance', 'saturation', 'splitShadowAmt', 'splitHighlightAmt']) || hasActiveHsl(state.hsl));
    subBtns.get('detail')?.classList.toggle('has-edits', nz(['clarity', 'sharpen', 'dehaze', 'denoise', 'vignette']));
    subBtns.get('crop')?.classList.toggle('has-edits', state.rotate !== 0 || state.flipH || state.flipV || Math.abs(state.straighten) > 0.05 || state.aspect !== 'auto');
  };

  pane.append(subBar, ...subPanes.values());
  ctl.syncHslSliders();
  ctl.syncSplitSwatches();
  ctl.syncGeoButtons();
  ctl.syncDevBadges();
  const savedSub = loadUi().devSub;
  showSub(subBtns.has(savedSub) ? savedSub : 'light');
}

/* ----------------------------------------------------------------- effects */

function buildEffectsPane() {
  const pane = document.querySelector('[data-pane="effects"]');
  const mk = (key, label, max, extra) => {
    const s = new Slider({
      label, min: 0, max, step: 0.01, value: state[key], defaultValue: defaults()[key], format: pct,
      onInput: (v) => set(key, v),
      onChange: () => recordHistory(),
    });
    ctl[key] = s;
    if (extra) s.head.append(extra);
    return h('div', { class: 'ctl' }, s.el);
  };
  const shuffle = (seedKey, label) => {
    const b = h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, html: icon('shuffle') });
    b.addEventListener('click', () => {
      state[seedKey] = ((Math.random() * 1e9) | 0) + 1;
      if (seedKey === 'leakSeed' && state.leak === 0) { set('leak', 0.6); ctl.leak.set(0.6); }
      if (seedKey === 'dustSeed' && state.dust === 0) { set('dust', 0.5); ctl.dust.set(0.5); }
      saveState();
      recordHistory();
      markLook();
      if (seedKey === 'dustSeed') rebuildDust();
      requestRender();
    });
    return b;
  };

  ctl.dateToggle = new Toggle({
    label: 'Date stamp', value: state.dateOn,
    onChange: (v) => { state.dateOn = v; saveState(); recordHistory(); syncDateOpts(); rebuildDate(); },
  });
  ctl.dateFormat = new ChipGroup({
    label: 'Date format', className: 'wrap',
    items: [
      { id: 'classic', label: "’98 10 5" }, { id: 'us', label: "10 5 ’98" },
      { id: 'dots', label: '98.10.05' }, { id: 'iso', label: '2026 10 05' },
    ],
    value: state.dateFormat,
    onChange: (v) => { state.dateFormat = v; saveState(); recordHistory(); rebuildDate(); },
  });
  ctl.dateColor = new ChipGroup({
    label: 'Date colour', className: 'wrap',
    items: [
      { id: 'orange', label: 'Orange', swatch: '#ff8a1e' },
      { id: 'red', label: 'Red', swatch: '#ff3b2a' },
      { id: 'yellow', label: 'Yellow', swatch: '#ffd23a' },
    ],
    value: state.dateColor,
    onChange: (v) => { state.dateColor = v; saveState(); recordHistory(); rebuildDate(); },
  });
  ctl.dateInput = h('input', { class: 'date-input', type: 'date', value: state.date, 'aria-label': 'Stamp date' });
  ctl.dateInput.addEventListener('change', () => {
    if (!ctl.dateInput.value) { ctl.dateInput.value = state.date; return; }
    state.date = ctl.dateInput.value; saveState(); recordHistory(); rebuildDate();
  });
  ctl.dateOpts = h('div', { class: 'date-opts' }, ctl.dateFormat.el, ctl.dateColor.el, ctl.dateInput);

  ctl.leakStyle = new ChipGroup({
    label: 'Light leak style', className: 'wrap',
    items: [
      { id: 'warm', label: 'Warm', swatch: 'linear-gradient(135deg, #ffb347, #ff5a1f)' },
      { id: 'prism', label: 'Prism', swatch: 'linear-gradient(135deg, #ff8f7a, #7ff0c8)' },
    ],
    value: state.leakStyle === 'prism' ? 'prism' : 'warm',
    onChange: (v) => {
      state.leakStyle = v;
      if (state.leak === 0) { state.leak = 0.6; ctl.leak.set(0.6); }
      saveState(); recordHistory(); markLook(); requestRender();
    },
  });

  pane.append(
    mk('grain', 'Film Grain', 2),
    mk('halation', 'Halation', 2),
    mk('flare', 'Lens Flare', 2),
    h('div', { class: 'divider' }),
    mk('leak', 'Light Leak', 1, shuffle('leakSeed', 'Shuffle light leak')),
    h('div', { class: 'ctl leak-style' }, ctl.leakStyle.el),
    mk('dust', 'Dust & Scratches', 1, shuffle('dustSeed', 'Shuffle dust')),
    h('div', { class: 'divider' }),
    h('div', { class: 'ctl' }, ctl.dateToggle.el, ctl.dateOpts));
  syncDateOpts();
}

function syncDateOpts() {
  ctl.dateOpts.setAttribute('aria-disabled', String(!state.dateOn));
  ctl.dateOpts.inert = !state.dateOn;
}

function set(key, v) {
  state[key] = v;
  saveState();
  if (key === 'dust') rebuildDust();
  ctl.syncDevBadges?.();
  markLook();
  requestRender();
}

function resetAll() {
  const d = defaults();
  for (const k of [...ADJUST_KEYS, ...EFFECT_KEYS, ...GEO_KEYS, 'filmAmt', 'camAmt']) {
    state[k] = d[k];
  }
  state.curves = defaultCurves();
  state.hsl = defaultHsl();
  state.dateOn = false;
  ctl.dateToggle?.set(false);
  syncDateOpts();
  state.leakStyle = 'warm';
  S.layoutKey = '';
  syncControls();
  saveState();
  recordHistory();
  rebuildDust();
  requestRender();
  toast('Develop & effects reset — film & camera kept');
}

/* ------------------------------------------------------------- info sheets */

function dl(pairs) {
  return h('dl', { class: 'info-traits' }, pairs.filter(([, v]) => v).map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }))));
}

function openFilmInfo() {
  const f = film();
  const catLabel = M.films.FILM_CATEGORIES.find((c) => c.id === f.category)?.label || f.category;
  const t = f.traits || {};
  const body = h('div', {},
    h('div', { class: 'info-kicker' }, h('span', { text: f.brand || '' }), f.iso ? h('span', { text: `ISO ${f.iso}` }) : null, h('span', { text: f.process || '' })),
    h('div', { class: 'info-swatch' }, (f.swatch || []).map((c) => h('i', { style: { background: c } }))),
    h('p', { class: 'info-summary', text: f.summary || '' }),
    h('div', { class: 'info-tags' },
      h('span', { class: 'info-tag', text: catLabel }),
      f.process ? h('span', { class: 'info-tag', text: `Process ${f.process}` }) : null,
      f.status ? h('span', { class: `info-tag ${f.status === 'discontinued' ? 'is-warn' : 'is-ok'}`, text: f.status === 'discontinued' ? 'Discontinued' : 'In production' }) : null,
      f.calibrated ? h('span', { class: 'info-tag is-ok', text: `Calibrated · ${f.calibrated.images} real photos` }) : null),
    dl([['Colour', t.color], ['Contrast', t.contrast], ['Grain', t.grain], ['Highlights', t.highlights], ['Shadows', t.shadows]]));
  new Sheet({ title: f.name, content: body }).open();
}

function openCameraInfo() {
  const c = camera();
  const bodyName = { slr: 'SLR', rangefinder: 'Rangefinder', compact: 'Compact', medium: 'Medium format', toy: 'Toy camera', fisheye: 'Fisheye', multilens: 'Multi-lens', pano: 'Panoramic', spinner: 'Rotating panoramic', none: 'None' }[c.body] || c.body;
  const body = h('div', {},
    h('div', { class: 'info-kicker' }, c.brand ? h('span', { text: c.brand }) : null, c.year ? h('span', { text: String(c.year) }) : null, c.format ? h('span', { text: c.format }) : null),
    h('p', { class: 'info-summary', text: c.summary || '' }),
    h('div', { class: 'info-tags' },
      h('span', { class: 'info-tag', text: bodyName }),
      c.lens ? h('span', { class: 'info-tag', text: c.lens }) : null),
    dl([['Lens character', c.traits]]));
  new Sheet({ title: `${c.brand ? c.brand + ' ' : ''}${c.name}`, content: body }).open();
}

function openShortcutsSheet() {
  const rows = [
    ['Undo / Redo', '⌘/Ctrl + Z · ⇧Z'],
    ['Auto Develop', 'A'],
    ['Hold for Original', '\\'],
    ['Split Compare', 'C'],
    ['Toggle Live Scopes', 'H'],
    ['Clipping Warnings', 'J'],
    ['Fit / 200% Zoom', '0 · 1'],
    ['Export Photo', '⌘/Ctrl + E'],
  ];
  const body = h('div', { class: 'keys-list' },
    rows.map(([lbl, key]) => h('div', { class: 'keys-row' }, h('span', { text: lbl }), h('kbd', { class: 'kbd', text: key }))));
  new Sheet({ title: 'Keyboard Shortcuts', content: body }).open();
}

/* -------------------------------------------------------------------- tabs */

function initTabs() {
  if (!M.looks) {
    document.querySelector('[data-tab="looks"]')?.remove();
    document.querySelector('[data-pane="looks"]')?.remove();
    document.querySelector('.tabs')?.classList.add('tabs-4');
  }
  for (const el of document.querySelectorAll('.tab-ico[data-ico]')) {
    el.innerHTML = icon(el.dataset.ico);
  }
  const tabs = [...document.querySelectorAll('.tab')];
  const show = (name) => {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
    saveUi({ tab: name });
    if (name === 'adjust' && ctl.curveEditor) ctl.curveEditor.paint();
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));
  const saved = loadUi().tab;
  show(tabs.some((t) => t.dataset.tab === saved) ? saved : (M.looks ? 'looks' : 'film'));

  // Mobile expandable inspector drawer toggle
  const panel = $('panel');
  const expBtn = $('btn-panel-expand');
  expBtn?.addEventListener('click', () => {
    const on = !panel.classList.contains('is-expanded');
    panel.classList.toggle('is-expanded', on);
    expBtn.setAttribute('aria-expanded', String(on));
    setTimeout(fitCanvas, 280);
  });
}

/* ------------------------------------------------------- stage gestures & zoom */

function placeSplit() {
  const hnd = $('split-handle');
  if (S.split < 0 || !S.viewRect) { hnd.hidden = true; return; }
  const r = S.viewRect;
  hnd.hidden = false;
  Object.assign(hnd.style, { left: `${r.x + r.w * S.split}px`, top: `${r.y}px`, height: `${r.h}px` });
}

function initStageGestures() {
  const badge = $('badge-original');
  const cmp = $('btn-compare');
  let hold = null;
  let draggingSplit = null;
  let panning = null;
  let lastTapT = 0;

  const setSplitFromX = (clientX) => {
    const sr = stage.getBoundingClientRect();
    const r = S.viewRect;
    S.split = Math.min(1, Math.max(0, (clientX - sr.left - r.x) / r.w));
    placeSplit();
    requestRender();
  };

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    if (!S.proxy || e.button > 0 || e.target.closest('.empty, .fatal, .stage-hud')) return;
    if (S.split >= 0) {
      draggingSplit = e.pointerId;
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      setSplitFromX(e.clientX);
      return;
    }
    if (S.zoom > 1.01) {
      panning = { id: e.pointerId, x0: e.clientX, y0: e.clientY, px0: S.panX, py0: S.panY, moved: 0 };
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    hold = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      t: setTimeout(() => { S.holding = true; badge.hidden = false; requestRender(); }, 180),
    };
  });
  stage.addEventListener('pointermove', (e) => {
    if (draggingSplit === e.pointerId) { setSplitFromX(e.clientX); return; }
    if (panning && panning.id === e.pointerId) {
      const dx = e.clientX - panning.x0, dy = e.clientY - panning.y0;
      panning.moved = Math.max(panning.moved, Math.hypot(dx, dy));
      S.panX = panning.px0 + dx;
      S.panY = panning.py0 + dy;
      fitCanvas();
      return;
    }
    if (hold && hold.id === e.pointerId && !S.holding && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 12) {
      clearTimeout(hold.t); hold = null;
    }
  });
  const end = (e) => {
    if (draggingSplit === e.pointerId) { draggingSplit = null; return; }
    if (panning && panning.id === e.pointerId) {
      const wasTap = panning.moved < 8;
      panning = null;
      if (wasTap) {
        const now = performance.now();
        if (now - lastTapT < 300) { lastTapT = 0; resetZoom(); }
        else lastTapT = now;
      }
      return;
    }
    if (hold && hold.id === e.pointerId) {
      clearTimeout(hold.t);
      const wasHolding = S.holding;
      hold = null;
      if (wasHolding) { S.holding = false; badge.hidden = true; requestRender(); }
      else {
        const now = performance.now();
        if (now - lastTapT < 300) { lastTapT = 0; setZoom(S.zoom > 1.01 ? 1 : 2); }
        else lastTapT = now;
      }
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', end);

  // Wheel zoom on desktop
  stage.addEventListener('wheel', (e) => {
    if (!S.proxy || e.target.closest('.stage-hud')) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom(S.zoom * factor);
  }, { passive: false });

  $('split-handle').append(h('span', { class: 'split-tag l', text: 'BEFORE' }), h('span', { class: 'split-tag r', text: 'AFTER' }));

  cmp.innerHTML = icon('compare');
  cmp.disabled = true;
  cmp.addEventListener('click', toggleCompare);

  $('btn-zoom')?.addEventListener('click', () => {
    if (S.zoom <= 1.01) setZoom(2);
    else if (S.zoom < 2.9) setZoom(3);
    else resetZoom();
  });
  $('btn-keys')?.addEventListener('click', openShortcutsSheet);
}

function toggleCompare() {
  if (!S.proxy) return;
  S.split = S.split >= 0 ? -1 : 0.5;
  $('btn-compare').setAttribute('aria-pressed', String(S.split >= 0));
  placeSplit();
  requestRender();
}

function toggleScopes() {
  S.scopeOn = !S.scopeOn;
  $('btn-scope')?.setAttribute('aria-pressed', String(S.scopeOn));
  if (S.scope) S.scope.el.hidden = !S.scopeOn;
  saveUi({ scopeOn: S.scopeOn });
  if (S.scopeOn) refreshScopes.flush();
}

function toggleClipping() {
  if (!S.proxy) return;
  S.clipWarn = !S.clipWarn;
  $('btn-clip')?.setAttribute('aria-pressed', String(S.clipWarn));
  requestRender();
  toast(S.clipWarn ? 'Clipping warnings ON (Red = blown, Blue = crushed)' : 'Clipping warnings OFF', { duration: 2000 });
}

/* ------------------------------------------------------------------ export */

function openExportSheet() {
  if (!S.proxy || S.exporting) return;
  if (!M.exporter) { toast('Export isn’t available yet.', { tone: 'error' }); return; }

  const ui = loadUi();
  let fmt = ui.expFmt || 'jpeg';
  let quality = ui.expQ ?? 92;
  let maxEdge = ui.expEdge ?? 0;
  let keepExif = ui.expExif ?? true;

  const outW = S.layout ? Math.round(S.layout.out[0]) : buildGeometry(S.fullW, S.fullH, state).logImg[0];
  const outH = S.layout ? Math.round(S.layout.out[1]) : buildGeometry(S.fullW, S.fullH, state).logImg[1];

  const dimLabel = h('strong');
  const updateDim = () => {
    const k = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(outW, outH)) : 1;
    dimLabel.textContent = `${Math.round(outW * k)} × ${Math.round(outH * k)} px`;
  };
  updateDim();

  const fmtChips = new ChipGroup({
    label: 'Format', className: 'wrap',
    items: [
      { id: 'jpeg', label: 'JPEG (EXIF)' },
      { id: 'png',  label: 'PNG (Lossless)' },
      { id: 'webp', label: 'WebP' },
    ],
    value: fmt,
    onChange: (v) => {
      fmt = v; saveUi({ expFmt: v });
      qSlider.el.hidden = v === 'png';
      exifTog.el.hidden = v !== 'jpeg';
    },
  });

  const resChips = new ChipGroup({
    label: 'Resolution', className: 'wrap',
    items: [
      { id: '0', label: 'Full Res' },
      { id: '2048', label: '2048 px' },
      { id: '1200', label: '1200 px' },
    ],
    value: String(maxEdge),
    onChange: (v) => { maxEdge = Number(v); saveUi({ expEdge: maxEdge }); updateDim(); },
  });

  const qSlider = new Slider({
    label: 'Quality', min: 70, max: 100, step: 1, value: quality, defaultValue: 92,
    format: (v) => `${Math.round(v)}%`,
    onInput: (v) => { quality = Math.round(v); saveUi({ expQ: quality }); },
  });
  qSlider.el.hidden = fmt === 'png';

  const exifTog = new Toggle({
    label: 'Keep capture date in EXIF', value: keepExif,
    onChange: (v) => { keepExif = v; saveUi({ expExif: v }); },
  });
  exifTog.el.hidden = fmt !== 'jpeg';

  const goBtn = h('button', { class: 'btn btn-accent btn-lg btn-block', type: 'button', html: `${icon('download')}<span>Develop &amp; Export</span>` });
  const body = h('div', { class: 'export-config' },
    h('div', { class: 'export-summary-bar' }, h('span', { text: `${film().name}` }), dimLabel),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Format' }), fmtChips.el),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Resolution' }), resChips.el),
    qSlider.el,
    exifTog.el,
    goBtn);

  const sheet = new Sheet({ title: 'Export Photo', content: body });
  goBtn.addEventListener('click', () => {
    sheet.close();
    startExport({ fmt, quality, maxEdge, keepExif });
  });
  sheet.open();
}

async function renderCanvasExport({ fmt, quality, maxEdge, onProgress }) {
  // For PNG / WebP, render strips into a single output canvas (capped safely to GPU/4096 limit)
  const cap = maxEdge > 0 ? maxEdge : Math.min(4096, S.renderer.limits?.maxTexture || 4096);
  const blobJpg = await M.exporter.exportJpeg({
    renderer: S.renderer,
    image: S.img,
    params: buildParams({ split: -1, showOriginal: false, clipWarn: false }),
    proxy: S.proxy,
    previewFrame: S.frame,
    quality: 100,
    maxEdge: cap,
    onProgress: (p) => onProgress(p * 0.85),
  });
  const bmp = await createImageBitmap(blobJpg);
  const cv = mkCanvas(bmp.width, bmp.height);
  cv.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const mime = fmt === 'png' ? 'image/png' : 'image/webp';
  const outBlob = await new Promise((res) => cv.toBlob(res, mime, quality / 100));
  releaseCanvas(cv);
  onProgress(1);
  return outBlob;
}

async function startExport(opts = {}) {
  if (!S.proxy || S.exporting) return;
  if (!M.exporter) { toast('Export isn’t available yet (exporter module missing).', { tone: 'error' }); return; }

  const fmt = opts.fmt || 'jpeg';
  const quality = opts.quality ?? 92;
  const maxEdge = opts.maxEdge ?? 0;
  const keepExif = opts.keepExif ?? true;

  const ctrl = new AbortController();
  const bar = h('div', { class: 'progress-bar' });
  const pctEl = h('span', { text: '0%' });
  const cancel = h('button', { class: 'btn btn-block', type: 'button', text: 'Cancel' });
  const [lw, lh] = buildGeometry(S.fullW, S.fullH, state).logImg;
  const progress = h('div', { class: 'export-progress' },
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Export progress' }, bar),
    h('div', { class: 'progress-meta' }, h('span', { text: S.layout ? `${Math.round(S.layout.out[0])} × ${Math.round(S.layout.out[1])}` : `${lw} × ${lh}` }), pctEl),
    cancel);
  const urls = [];
  const sheet = new Sheet({
    title: 'Developing…', content: progress, dismissible: false,
    onClose: () => {
      ctrl.abort();
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 400);
    },
  });
  sheet.setDismissible(false);
  cancel.addEventListener('click', () => ctrl.abort());
  sheet.open();

  S.exporting = true;
  const f = film();
  let blob;
  const onProgress = (p) => {
    const v = Math.max(0, Math.min(1, p || 0));
    bar.style.width = `${(v * 100).toFixed(1)}%`;
    pctEl.textContent = `${Math.round(v * 100)}%`;
  };
  try {
    if (fmt === 'jpeg') {
      blob = await M.exporter.exportJpeg({
        renderer: S.renderer,
        image: S.img,
        params: buildParams({ split: -1, showOriginal: false, clipWarn: false }),
        proxy: S.proxy,
        previewFrame: S.frame,
        exifDate: (keepExif && S.exifDate && M.exif?.formatExifDate?.(S.exifDate)) || null,
        quality,
        maxEdge,
        signal: ctrl.signal,
        onProgress,
      });
    } else {
      blob = await renderCanvasExport({ fmt, quality, maxEdge, onProgress });
    }
  } catch (e) {
    S.exporting = false;
    try { S.renderer.setSource(S.proxy); S.renderer.setFrame?.(S.frame || null); } catch { /* ignore */ }
    requestRender();
    if (ctrl.signal.aborted || e?.name === 'AbortError') {
      if (sheet.isOpen) sheet.close();
      toast('Export cancelled');
    } else {
      console.error('[C41] export failed', e);
      if (sheet.isOpen) sheet.close();
      toast(`Export failed${e?.message ? ': ' + e.message : ''}`, { tone: 'error', duration: 6000 });
    }
    return;
  }
  S.exporting = false;
  requestRender();
  if (!sheet.isOpen) return;

  const ext = fmt === 'png' ? 'png' : fmt === 'webp' ? 'webp' : 'jpg';
  const mime = fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : 'image/jpeg';
  const name = `C41_${f.id}_${stampName()}.${ext}`;
  const file = new File([blob], name, { type: mime, lastModified: Date.now() });
  const url = URL.createObjectURL(blob);
  urls.push(url);

  const preview = h('img', { class: 'export-preview', src: url, alt: `Developed photo, ${f.name}` });
  const fmtBadge = fmt === 'png' ? 'PNG Lossless' : `${fmt.toUpperCase()} Q${quality}`;
  const meta = h('div', { class: 'export-meta' }, h('span', { text: '…' }), h('span', { text: fmtBytes(blob.size) }), h('span', { text: fmtBadge }));
  preview.addEventListener('load', () => { meta.firstChild.textContent = `${preview.naturalWidth} × ${preview.naturalHeight}`; }, { once: true });

  const actions = h('div', { class: 'export-actions' });
  let canShareFiles = false;
  try { canShareFiles = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch { canShareFiles = false; }
  if (canShareFiles) {
    const share = h('button', { class: 'btn btn-accent', type: 'button', html: `${icon('share')}<span>Save to Photos</span>` });
    share.addEventListener('click', () => {
      navigator.share({ files: [file] }).then(
        () => toast('Saved ✓'),
        (err) => {
          if (err && err.name === 'AbortError') return;
          toast('Sharing failed — press and hold the image to save instead.', { duration: 5000 });
        });
    });
    actions.append(share);
  }
  const dlBtn = h('a', { class: `btn ${canShareFiles ? '' : 'btn-accent'}`, href: url, download: name, html: `${icon('download')}<span>Download</span>` });
  actions.append(dlBtn);

  const done = h('div', { class: 'export-done' },
    preview,
    meta,
    actions,
    h('p', { class: 'export-hint', text: 'Or press and hold the image to save it.' }));
  sheet.setTitle(f.name);
  sheet.body.replaceChildren(done);
  sheet.setDismissible(true);
}

/* ------------------------------------------------------- keyboard shortcuts */

function initKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (document.querySelector('.sheet-layer.is-open')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && (e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 's')) {
      if (S.proxy) { e.preventDefault(); openExportSheet(); }
      return;
    }
    if (mod || e.altKey) return;
    switch (e.key) {
      case '\\':
        if (S.proxy && !S.holding) { S.holding = true; $('badge-original').hidden = false; requestRender(); }
        break;
      case 'c': case 'C': toggleCompare(); break;
      case 'h': case 'H': toggleScopes(); break;
      case 'j': case 'J': toggleClipping(); break;
      case 'a': case 'A': if (S.proxy) runAutoDevelop(); break;
      case '0': if (S.proxy) resetZoom(); break;
      case '1': if (S.proxy) setZoom(S.zoom > 1.01 ? 1 : 2); break;
      case '?': openShortcutsSheet(); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === '\\' && S.holding) {
      S.holding = false;
      $('badge-original').hidden = true;
      requestRender();
    }
  });
}

/* ------------------------------------------------------- service worker */

function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let userReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userReload) location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const prompt = (w) => {
      toast('Update ready', {
        action: 'Reload', duration: 0,
        onAction: () => { userReload = true; w.postMessage({ type: 'SKIP_WAITING' }); },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) prompt(nw);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('[C41] SW registration failed', e));
}

/* --------------------------------------------------------------- fatal */

function fatal(title, msg) {
  $('fatal-title').textContent = title;
  $('fatal-msg').textContent = msg;
  $('fatal').hidden = false;
  $('empty').hidden = true;
  app.classList.add('is-empty');
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  $('btn-import').innerHTML = icon('image');
  $('btn-undo').innerHTML = icon('undo');
  $('btn-redo').innerHTML = icon('redo');
  $('btn-auto').innerHTML = icon('wand');
  $('btn-scope').innerHTML = icon('histogram');
  $('btn-clip').innerHTML = icon('clipping');

  const lib = $('file-library'), cam = $('file-camera');
  const pick = (input) => { input.value = ''; input.click(); };
  $('btn-import').addEventListener('click', () => pick(lib));
  $('btn-choose').addEventListener('click', () => pick(lib));
  $('btn-take').addEventListener('click', () => pick(cam));
  $('btn-sample')?.addEventListener('click', loadSamplePhoto);
  for (const input of [lib, cam]) input.addEventListener('change', () => importFile(input.files && input.files[0]));
  const ref = $('file-ref');
  ref.addEventListener('change', () => { const f = ref.files && ref.files[0]; ref.value = ''; startMatch(f); });

  $('btn-undo').addEventListener('click', doUndo);
  $('btn-redo').addEventListener('click', doRedo);
  $('btn-auto').addEventListener('click', runAutoDevelop);
  $('btn-scope').addEventListener('click', toggleScopes);
  $('btn-clip').addEventListener('click', toggleClipping);
  $('btn-save').addEventListener('click', openExportSheet);
  $('title-pill')?.addEventListener('click', openFilmInfo);

  registerSW();
  await loadModules();

  const critical = ['film-transform.js', 'films.js', 'cameras.js', 'renderer.js'].filter((m) => missing.includes(m));
  if (critical.length) {
    fatal('C41 is still being developed', `Missing module${critical.length > 1 ? 's' : ''}: ${critical.join(', ')}. Reload in a moment.`);
    for (const b of ['btn-import', 'btn-save', 'btn-compare']) $(b).disabled = true;
    return;
  }

  state = loadState();
  if (M.films.getFilm(state.filmId)?.id !== state.filmId) state.filmId = M.films.DEFAULT_FILM_ID;
  if (M.cameras.getCamera(state.cameraId)?.id !== state.cameraId) state.cameraId = M.cameras.DEFAULT_CAMERA_ID;
  if (!['warm', 'prism'].includes(state.leakStyle)) state.leakStyle = 'warm';
  if (!M.looks) { state.lookId = null; state.lookFilm = null; }
  if (state.lookFilm && typeof state.lookFilm !== 'object') state.lookFilm = null;

  try {
    S.renderer = new M.renderer.Renderer(view);
  } catch (e) {
    console.error('[C41] renderer init failed', e);
    const noGl = String(e?.message || e).includes('webgl2');
    fatal(noGl ? 'WebGL 2 not available' : 'Can’t start the editor',
      noGl
        ? 'C41 develops photos on your GPU using WebGL 2. Please update to iOS 15 or later (or a current browser) and try again.'
        : `The image engine failed to start (${e?.message || e}).`);
    for (const b of ['btn-import', 'btn-save', 'btn-compare']) $(b).disabled = true;
    return;
  }
  S.renderer.onContextRestored?.(() => { resendAll(); });
  view.addEventListener('webglcontextlost', () => toast('Graphics reset — restoring…'));

  // Live Scope HUD
  const ui = loadUi();
  S.scopeOn = ui.scopeOn !== false;
  $('btn-scope').setAttribute('aria-pressed', String(S.scopeOn));
  S.scope = new ScopeView({
    mode: ui.scopeMode || 'rgb',
    onModeChange: (m) => saveUi({ scopeMode: m }),
  });
  S.scope.el.hidden = !S.scopeOn;
  $('scope-slot')?.append(S.scope.el);

  buildLooksPane();
  buildFilmPane();
  buildCameraPane();
  buildEffectsPane();
  buildAdjustPane();
  initTabs();
  initStageGestures();
  initKeyboard();

  const onResize = debounce(() => fitCanvas(), 60);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 250));
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(stage);

  window.addEventListener('pagehide', () => saveState.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveState.flush(); });

  // Drag & drop with active visual dropzone state
  let dragDepth = 0;
  stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; stage.classList.add('is-dragover'); });
  stage.addEventListener('dragover', (e) => { e.preventDefault(); });
  stage.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) stage.classList.remove('is-dragover'); });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    stage.classList.remove('is-dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) importFile(f);
  });

  if (missing.includes('exporter.js')) toast('Export module missing — saving disabled.', { tone: 'error' });

  const setState = (patch) => {
    Object.assign(state, patch);
    syncControls();
    saveState();
    if ('dust' in patch || 'dustSeed' in patch) rebuildDust();
    requestRender();
  };
  Object.defineProperty(window, '__c41', { value: {
    state: () => state, S, M, missing, importFile, setState, startExport, startMatch,
    loadSamplePhoto, runAutoDevelop, doUndo, doRedo,
    applyLook: (id) => { const l = M.looks?.getLook(id, customLooks); if (l) applyLook(l); return !!l; },
    customLooks: () => customLooks,
  } });
}

boot().catch((e) => {
  console.error('[C41] boot failed', e);
  fatal('Can’t start C41', String(e?.message || e));
});
