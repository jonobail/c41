// C41 — app shell: state, wiring, panels, import/export flow.
// Modules owned by other agents are imported dynamically so a missing/broken one degrades
// gracefully instead of blanking the whole app.
import { Slider, Sheet, toast, ChipGroup, Toggle, icon, h, idleLoop, debounce } from './ui.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const stage = $('stage');
const view = $('view');

const STORE_KEY = 'c41.state.v1';
const UI_KEY = 'c41.ui.v1';
const PROXY_MAX = 2048;
const PROXY_MIN = 1200;
const THUMB = 96;          // thumbnail crop size (px)
const LUT_CACHE_MAX = 8;

/* ---------------------------------------------------------------- modules */

const M = {};              // loaded modules
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

const ADJUST_KEYS = ['exposure', 'contrast', 'warmth', 'tint'];
const EFFECT_KEYS = ['grain', 'halation', 'flare', 'leak', 'dust'];

function defaults() {
  return {
    filmId: M.films?.DEFAULT_FILM_ID ?? 'kodak-portra-400',
    cameraId: M.cameras?.DEFAULT_CAMERA_ID ?? 'none',
    filmAmt: 1, camAmt: 1,
    grain: 1, halation: 1, flare: 1,
    leak: 0, leakSeed: 1,
    dust: 0, dustSeed: 1,
    dateOn: false, dateFormat: 'classic', dateColor: 'orange', date: isoDate(new Date()),
    exposure: 0, contrast: 0, warmth: 0, tint: 0,
    seed: (Math.random() * 1e9) | 0,
  };
}

let state = null;

function loadState() {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      for (const k of Object.keys(d)) if (s[k] !== undefined && typeof s[k] === typeof d[k]) d[k] = s[k];
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

/* ------------------------------------------------------------ session data */

const S = {
  renderer: null,
  img: null, imgUrl: null, file: null,
  fullW: 0, fullH: 0,
  proxy: null,
  maps: null, flarePoint: { x: 0.5, y: 0.3, strength: 0 },
  exifDate: null,
  lutCache: new Map(), lutFilmId: null,
  dust: null, dustKey: '',
  date: null, dateKey: '',
  leaks: [], leaksSeed: null,
  split: -1, holding: false,
  rafPending: false,
  exporting: false,
  thumbCancel: null,
  thumbBase: null,
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
const ev = (v) => (Math.abs(v) < 0.005 ? '0.0 EV' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} EV`);
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const film = () => M.films.getFilm(state.filmId);
const camera = () => M.cameras.getCamera(state.cameraId);

/* -------------------------------------------------------------- rendering */

function buildParams(overrides = {}) {
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
    dust: S.dust ? state.dust : 0,
    dateOn: !!(state.dateOn && S.date),
    exposure: state.exposure,
    contrast: state.contrast,
    warmth: state.warmth,
    tint: state.tint,
    flarePoint: S.flarePoint,
    split: S.split,
    showOriginal: S.holding,
    seed: state.seed,
    fullShort: Math.min(S.fullW, S.fullH) || 1,
    ...overrides,
  };
}

function ensureLut() {
  if (!S.renderer || !M.ft) return;
  const id = state.filmId;
  if (S.lutFilmId === id) return;
  let lut = S.lutCache.get(id);
  if (lut) {
    S.lutCache.delete(id); // LRU bump
  } else {
    lut = M.ft.buildLut(film().params);
  }
  S.lutCache.set(id, lut);
  while (S.lutCache.size > LUT_CACHE_MAX) S.lutCache.delete(S.lutCache.keys().next().value);
  S.renderer.setLut(lut, M.ft.LUT_SIZE);
  S.lutFilmId = id;
}

function ensureLeaks() {
  if (!M.overlays) return;
  if (S.leaksSeed !== state.leakSeed) {
    S.leaks = M.overlays.makeLeaks(state.leakSeed);
    S.leaksSeed = state.leakSeed;
  }
}

const rebuildDust = debounce(() => {
  if (!S.renderer || !M.overlays || !S.proxy) return;
  const amt = state.dust;
  if (amt <= 0) {
    if (S.dust) { S.renderer.setDust(null); releaseCanvas(S.dust); S.dust = null; S.dustKey = ''; }
    requestRender();
    return;
  }
  const aspect = S.fullW / S.fullH;
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
  const key = `${state.date}|${state.dateFormat}|${state.dateColor}|${S.fullW}x${S.fullH}`;
  if (key === S.dateKey && S.date) { requestRender(); return; }
  const d = M.overlays.makeDateCanvas(parseIsoDate(state.date), { format: state.dateFormat, color: state.dateColor }, S.fullW, S.fullH);
  S.renderer.setDate(d);
  if (S.date && S.date.canvas !== d.canvas) releaseCanvas(S.date.canvas);
  S.date = d;
  S.dateKey = key;
  requestRender();
}, 80);

function requestRender() {
  if (S.rafPending || !S.renderer || !S.proxy || S.exporting) return;
  S.rafPending = true;
  requestAnimationFrame(() => {
    S.rafPending = false;
    if (!S.proxy || S.exporting) return;
    try {
      ensureLut();
      ensureLeaks();
      S.renderer.setParams(buildParams());
      S.renderer.renderPreview();
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
  ensureLut();
  if (S.maps) r.setMaps({ hmap: S.maps.hmap, bmap: S.maps.bmap });
  r.setDust(S.dust || null);
  r.setDate(S.date || null);
  requestRender();
}

/* --------------------------------------------------------------- stage fit */

function fitCanvas() {
  const cw = view.width, ch = view.height;
  if (!cw || !ch || !S.proxy) return;
  const r = stage.getBoundingClientRect();
  const pad = r.width < 500 ? 10 : 20;
  const aw = Math.max(1, r.width - pad * 2), ah = Math.max(1, r.height - pad * 2);
  const k = Math.min(aw / cw, ah / ch);
  const w = Math.round(cw * k), hh = Math.round(ch * k);
  const x = Math.round((r.width - w) / 2), y = Math.round((r.height - hh) / 2);
  Object.assign(view.style, { width: `${w}px`, height: `${hh}px`, left: `${x}px`, top: `${y}px` });
  S.viewRect = { x, y, w, h: hh };
  placeSplit();
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

/** Downscale with successive halving for quality, then a final high-quality draw. */
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
    if (im.decode) im.decode().then(ok, () => { if (im.complete && im.naturalWidth) ok(); /* else wait for onload/onerror */ });
  });
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
  let img;
  try {
    img = await decodeImage(url);
  } catch {
    URL.revokeObjectURL(url);
    setBusy(false);
    toast('Couldn’t open that photo. Try a JPEG or HEIC from Photos.', { tone: 'error', duration: 5000 });
    return;
  }

  try {
    const W = img.naturalWidth, H = img.naturalHeight;
    const proxy = makeProxy(img, W, H);

    // release the previous image
    const oldProxy = S.proxy, oldUrl = S.imgUrl, oldImg = S.img;
    S.img = img; S.imgUrl = url; S.file = file;
    S.fullW = W; S.fullH = H;
    S.proxy = proxy;

    S.renderer.setSource(proxy);
    view.width = proxy.width; view.height = proxy.height;
    releaseCanvas(oldProxy);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    if (oldImg) oldImg.src = '';

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

    // Capture date for the stamp + EXIF
    let d = null;
    if (M.exif) {
      try { d = await M.exif.readExifDate(file); } catch { d = null; }
    }
    if (!(d instanceof Date) || isNaN(d)) d = new Date(file.lastModified || Date.now());
    S.exifDate = d;
    state.date = isoDate(d);
    state.seed = (Math.random() * 1e9) | 0;
    saveState();
    ctl.dateInput && (ctl.dateInput.value = state.date);

    S.dustKey = ''; S.dateKey = '';
    rebuildDust.flush();
    rebuildDate.flush();

    app.classList.remove('is-empty');
    app.classList.add('has-image');
    $('btn-save').disabled = !M.exporter;
    $('btn-compare').disabled = false;
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

function setBusy(on) { $('stage-busy').hidden = !on; }

/* -------------------------------------------------------------- thumbnails */

const filmCards = new Map();   // id -> { el, canvas }

function buildThumbnails() {
  if (!M.ft || !S.proxy) return;
  S.thumbCancel?.();
  // centre crop of the proxy
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
  for (const { canvas } of filmCards.values()) canvas.classList.remove('is-ready');

  // selected first, then visible order
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
      for (let p = 0, q = 0; p < lin.length; p += 3, q += 4) {
        fn(lin[p], lin[p + 1], lin[p + 2], out);
        d[q] = out[0] * 255 + 0.5; d[q + 1] = out[1] * 255 + 0.5; d[q + 2] = out[2] * 255 + 0.5; d[q + 3] = 255;
      }
      card.canvas.getContext('2d').putImageData(id, 0, 0);
      card.canvas.classList.add('is-ready');
    } catch (e) {
      console.warn('[C41] thumbnail failed for', f.id, e);
    }
    return i < ids.length;
  });
}

/* -------------------------------------------------------------- UI build */

const ctl = {};            // control refs for syncing after reset

function buildFilmPane() {
  const pane = document.querySelector('[data-pane="film"]');
  const { FILMS, FILM_CATEGORIES } = M.films;
  let cat = loadUi().filmCat || 'all';

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
    filmCards.set(f.id, { el, canvas });
    cards.append(el);
  }

  function applyFilter() {
    for (const f of FILMS) filmCards.get(f.id).el.hidden = !(cat === 'all' || f.category === cat);
  }
  applyFilter();

  ctl.filmAmt = new Slider({
    label: 'Strength', min: 0, max: 1, step: 0.01, value: state.filmAmt, defaultValue: 1, format: pct,
    onInput: (v) => set('filmAmt', v),
  });
  const info = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'About this film', html: icon('info') });
  info.addEventListener('click', openFilmInfo);

  pane.append(
    h('div', { style: { paddingTop: '2px' } }, chips.el),
    cards,
    h('div', { class: 'row' }, ctl.filmAmt.el, info));
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
  const f = film();
  $('title-film').textContent = `${f.brand ? f.brand + ' ' : ''}${f.name}`;
}

function selectFilm(id) {
  if (state.filmId === id) return;
  state.filmId = id;
  markFilm();
  saveState();
  requestRender();
  scrollCardIntoView(ctl.filmCards, filmCards.get(id)?.el);
}

const camCards = new Map();

function buildCameraPane() {
  const pane = document.querySelector('[data-pane="camera"]');
  const cards = h('div', { class: 'cards', role: 'radiogroup', 'aria-label': 'Camera' });
  for (const c of M.cameras.CAMERAS) {
    const el = h('button', { class: 'card cam', type: 'button', role: 'radio', dataset: { id: c.id }, 'aria-label': `${c.brand} ${c.name}`.trim() },
      h('span', { class: 'card-thumb', html: icon(`body-${c.body || 'none'}`) },
        c.year ? h('span', { class: 'card-year', text: `’${String(c.year).slice(2)}` }) : null),
      h('span', { class: 'card-brand', text: c.brand || '—' }),
      h('span', { class: 'card-name', text: c.name }),
      h('span', { class: 'card-sub', text: c.lens || 'Neutral' }));
    el.addEventListener('click', () => selectCamera(c.id));
    camCards.set(c.id, el);
    cards.append(el);
  }
  ctl.camAmt = new Slider({
    label: 'Lens character', min: 0, max: 1, step: 0.01, value: state.camAmt, defaultValue: 1, format: pct,
    onInput: (v) => set('camAmt', v),
  });
  const info = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'About this camera', html: icon('info') });
  info.addEventListener('click', openCameraInfo);
  pane.append(h('div', { class: 'pane-label', text: 'Camera & lens' }), cards, h('div', { class: 'row' }, ctl.camAmt.el, info));
  ctl.camCards = cards;
  markCamera();
}

function markCamera() {
  for (const [id, el] of camCards) el.setAttribute('aria-checked', String(id === state.cameraId));
}

function selectCamera(id) {
  if (state.cameraId === id) return;
  state.cameraId = id;
  markCamera();
  saveState();
  requestRender();
  scrollCardIntoView(ctl.camCards, camCards.get(id));
}

function buildEffectsPane() {
  const pane = document.querySelector('[data-pane="effects"]');
  const mk = (key, label, max, extra) => {
    const s = new Slider({
      label, min: 0, max, step: 0.01, value: state[key], defaultValue: defaults()[key], format: pct,
      onInput: (v) => set(key, v),
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
      if (seedKey === 'dustSeed') rebuildDust();
      requestRender();
    });
    return b;
  };

  // Date stamp
  ctl.dateToggle = new Toggle({ label: 'Date stamp', value: state.dateOn, onChange: (v) => { state.dateOn = v; saveState(); syncDateOpts(); rebuildDate(); } });
  ctl.dateFormat = new ChipGroup({
    label: 'Date format', className: 'wrap',
    items: [
      { id: 'classic', label: "’98 10 5" }, { id: 'us', label: "10 5 ’98" },
      { id: 'dots', label: '98.10.05' }, { id: 'iso', label: '2026 10 05' },
    ],
    value: state.dateFormat,
    onChange: (v) => { state.dateFormat = v; saveState(); rebuildDate(); },
  });
  ctl.dateColor = new ChipGroup({
    label: 'Date colour', className: 'wrap',
    items: [
      { id: 'orange', label: 'Orange', swatch: '#ff8a1e' },
      { id: 'red', label: 'Red', swatch: '#ff3b2a' },
      { id: 'yellow', label: 'Yellow', swatch: '#ffd23a' },
    ],
    value: state.dateColor,
    onChange: (v) => { state.dateColor = v; saveState(); rebuildDate(); },
  });
  ctl.dateInput = h('input', { class: 'date-input', type: 'date', value: state.date, 'aria-label': 'Stamp date' });
  ctl.dateInput.addEventListener('change', () => {
    if (!ctl.dateInput.value) { ctl.dateInput.value = state.date; return; }
    state.date = ctl.dateInput.value; saveState(); rebuildDate();
  });
  ctl.dateOpts = h('div', { class: 'date-opts' }, ctl.dateFormat.el, ctl.dateColor.el, ctl.dateInput);

  pane.append(
    mk('grain', 'Grain', 2),
    mk('halation', 'Halation', 2),
    mk('flare', 'Lens flare', 2),
    h('div', { class: 'divider' }),
    mk('leak', 'Light leak', 1, shuffle('leakSeed', 'Shuffle light leak')),
    mk('dust', 'Dust & scratches', 1, shuffle('dustSeed', 'Shuffle dust')),
    h('div', { class: 'divider' }),
    h('div', { class: 'ctl' }, ctl.dateToggle.el, ctl.dateOpts));
  syncDateOpts();
}

function syncDateOpts() {
  ctl.dateOpts.setAttribute('aria-disabled', String(!state.dateOn));
  ctl.dateOpts.inert = !state.dateOn;
}

function buildAdjustPane() {
  const pane = document.querySelector('[data-pane="adjust"]');
  const mk = (key, label, min, max, format) => {
    const s = new Slider({ label, min, max, step: 0.01, value: state[key], defaultValue: 0, bipolar: true, format, onInput: (v) => set(key, v) });
    ctl[key] = s;
    return h('div', { class: 'ctl' }, s.el);
  };
  const reset = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', html: `${icon('reset')}<span>Reset all</span>` });
  reset.addEventListener('click', resetAll);
  pane.append(
    mk('exposure', 'Exposure', -2, 2, ev),
    mk('contrast', 'Contrast', -1, 1, signed),
    mk('warmth', 'Warmth', -1, 1, signed),
    mk('tint', 'Tint', -1, 1, signed),
    h('div', { class: 'pane-foot' }, reset));
}

function set(key, v) {
  state[key] = v;
  saveState();
  if (key === 'dust') rebuildDust();
  requestRender();
}

function resetAll() {
  const d = defaults();
  for (const k of [...ADJUST_KEYS, ...EFFECT_KEYS, 'filmAmt', 'camAmt']) {
    state[k] = d[k];
    ctl[k]?.set(d[k]);
  }
  state.dateOn = false;
  ctl.dateToggle.set(false);
  syncDateOpts();
  saveState();
  rebuildDust();
  requestRender();
  toast('Edits reset — film & camera kept');
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
      f.status ? h('span', { class: `info-tag ${f.status === 'discontinued' ? 'is-warn' : 'is-ok'}`, text: f.status === 'discontinued' ? 'Discontinued' : 'In production' }) : null),
    dl([['Colour', t.color], ['Contrast', t.contrast], ['Grain', t.grain], ['Highlights', t.highlights], ['Shadows', t.shadows]]));
  new Sheet({ title: f.name, content: body }).open();
}

function openCameraInfo() {
  const c = camera();
  const bodyName = { slr: 'SLR', rangefinder: 'Rangefinder', compact: 'Compact', medium: 'Medium format', toy: 'Toy camera', none: 'None' }[c.body] || c.body;
  const body = h('div', {},
    h('div', { class: 'info-kicker' }, c.brand ? h('span', { text: c.brand }) : null, c.year ? h('span', { text: String(c.year) }) : null, c.format ? h('span', { text: c.format }) : null),
    h('p', { class: 'info-summary', text: c.summary || '' }),
    h('div', { class: 'info-tags' },
      h('span', { class: 'info-tag', text: bodyName }),
      c.lens ? h('span', { class: 'info-tag', text: c.lens }) : null),
    dl([['Lens character', c.traits]]));
  new Sheet({ title: `${c.brand ? c.brand + ' ' : ''}${c.name}`, content: body }).open();
}

/* -------------------------------------------------------------------- tabs */

function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const show = (name) => {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
    saveUi({ tab: name });
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));
  show(loadUi().tab || 'film');
}

/* ------------------------------------------------------- compare / original */

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
  let dragging = null;

  const setSplitFromX = (clientX) => {
    const sr = stage.getBoundingClientRect();
    const r = S.viewRect;
    S.split = Math.min(1, Math.max(0, (clientX - sr.left - r.x) / r.w));
    placeSplit();
    requestRender();
  };

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    if (!S.proxy || e.button > 0 || e.target.closest('.empty, .fatal')) return;
    if (S.split >= 0) {
      dragging = e.pointerId;
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      setSplitFromX(e.clientX);
      return;
    }
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, t: setTimeout(() => {
      S.holding = true; badge.hidden = false; requestRender();
    }, 140) };
  });
  stage.addEventListener('pointermove', (e) => {
    if (dragging === e.pointerId) { setSplitFromX(e.clientX); return; }
    if (hold && hold.id === e.pointerId && !S.holding && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 12) {
      clearTimeout(hold.t); hold = null;
    }
  });
  const end = (e) => {
    if (dragging === e.pointerId) { dragging = null; return; }
    if (hold && hold.id === e.pointerId) {
      clearTimeout(hold.t); hold = null;
      if (S.holding) { S.holding = false; badge.hidden = true; requestRender(); }
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', end);

  // tag labels on the handle
  $('split-handle').append(h('span', { class: 'split-tag l', text: 'BEFORE' }), h('span', { class: 'split-tag r', text: 'AFTER' }));

  cmp.innerHTML = icon('compare');
  cmp.disabled = true;
  cmp.addEventListener('click', () => {
    S.split = S.split >= 0 ? -1 : 0.5;
    cmp.setAttribute('aria-pressed', String(S.split >= 0));
    placeSplit();
    requestRender();
  });
}

/* ------------------------------------------------------------------ export */

async function startExport() {
  if (!S.proxy || S.exporting) return;
  if (!M.exporter) { toast('Export isn’t available yet (exporter module missing).', { tone: 'error' }); return; }

  const ctrl = new AbortController();
  const bar = h('div', { class: 'progress-bar' });
  const pctEl = h('span', { text: '0%' });
  const cancel = h('button', { class: 'btn btn-block', type: 'button', text: 'Cancel' });
  const progress = h('div', { class: 'export-progress' },
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Export progress' }, bar),
    h('div', { class: 'progress-meta' }, h('span', { text: `${S.fullW} × ${S.fullH}` }), pctEl),
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
  try {
    blob = await M.exporter.exportJpeg({
      renderer: S.renderer,
      image: S.img,
      params: buildParams({ split: -1, showOriginal: false }),
      proxy: S.proxy,
      // worker contract wants 'YYYY:MM:DD HH:MM:SS'
      exifDate: (S.exifDate && M.exif?.formatExifDate?.(S.exifDate)) || null,
      quality: 92,
      signal: ctrl.signal,
      onProgress: (p) => {
        const v = Math.max(0, Math.min(1, p || 0));
        bar.style.width = `${(v * 100).toFixed(1)}%`;
        pctEl.textContent = `${Math.round(v * 100)}%`;
      },
    });
  } catch (e) {
    S.exporting = false;
    try { S.renderer.setSource(S.proxy); } catch { /* ignore */ }
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

  const name = `C41_${f.id}_${stampName()}.jpg`;
  const file = new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  const url = URL.createObjectURL(blob);
  urls.push(url);

  const preview = h('img', { class: 'export-preview', src: url, alt: `Developed photo, ${f.name}` });
  const meta = h('div', { class: 'export-meta' }, h('span', { text: '…' }), h('span', { text: fmtBytes(blob.size) }), h('span', { text: 'JPEG Q92' }));
  preview.addEventListener('load', () => { meta.firstChild.textContent = `${preview.naturalWidth} × ${preview.naturalHeight}`; }, { once: true });

  const actions = h('div', { class: 'export-actions' });
  let canShareFiles = false;
  try { canShareFiles = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch { canShareFiles = false; }
  if (canShareFiles) {
    const share = h('button', { class: 'btn btn-accent', type: 'button', html: `${icon('share')}<span>Save to Photos</span>` });
    // navigator.share must be called synchronously in the tap handler (fresh user activation).
    share.addEventListener('click', () => {
      navigator.share({ files: [file] }).then(
        () => toast('Saved ✓'),
        (err) => {
          if (err && err.name === 'AbortError') return;
          console.warn('[C41] share failed', err);
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
  // Static chrome first so something sensible shows even if modules fail.
  $('btn-import').innerHTML = icon('image');
  const lib = $('file-library'), cam = $('file-camera');
  const pick = (input) => { input.value = ''; input.click(); };
  $('btn-import').addEventListener('click', () => pick(lib));
  $('btn-choose').addEventListener('click', () => pick(lib));
  $('btn-take').addEventListener('click', () => pick(cam));
  for (const input of [lib, cam]) input.addEventListener('change', () => importFile(input.files && input.files[0]));
  $('btn-save').addEventListener('click', startExport);

  registerSW();
  await loadModules();

  const critical = ['film-transform.js', 'films.js', 'cameras.js', 'renderer.js'].filter((m) => missing.includes(m));
  if (critical.length) {
    fatal('C41 is still being developed', `Missing module${critical.length > 1 ? 's' : ''}: ${critical.join(', ')}. Reload in a moment.`);
    for (const b of ['btn-import', 'btn-save', 'btn-compare']) $(b).disabled = true;
    return;
  }
  if (missing.length) console.warn('[C41] optional modules missing:', missing.join(', '));

  state = loadState();
  // validate persisted ids
  if (M.films.getFilm(state.filmId)?.id !== state.filmId) state.filmId = M.films.DEFAULT_FILM_ID;
  if (M.cameras.getCamera(state.cameraId)?.id !== state.cameraId) state.cameraId = M.cameras.DEFAULT_CAMERA_ID;

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

  buildFilmPane();
  buildCameraPane();
  buildEffectsPane();
  buildAdjustPane();
  initTabs();
  initStageGestures();

  const onResize = debounce(() => fitCanvas(), 60);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 250));
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(stage);

  window.addEventListener('pagehide', () => saveState.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveState.flush(); });

  // Drag & drop for desktop
  stage.addEventListener('dragover', (e) => { e.preventDefault(); });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) importFile(f);
  });

  if (missing.includes('exporter.js')) toast('Export module missing — saving disabled.', { tone: 'error' });

  // test hook (non-enumerable, harmless in production)
  Object.defineProperty(window, '__c41', { value: { state: () => state, S, M, missing, importFile } });
}

boot().catch((e) => {
  console.error('[C41] boot failed', e);
  fatal('Can’t start C41', String(e?.message || e));
});
