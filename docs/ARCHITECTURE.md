# C41 — architecture & module contracts

C41 is a **static, no-build PWA** (plain ES modules, no bundler, no runtime deps) so it can be
hosted on GitHub Pages or any static server. All paths are **relative** (works under a sub-path).
Target: iOS Safari 16+ (WebGL2, module scripts, Web Share with files), installed to the home screen.

## Directory layout & file ownership

| Path | Owner (phase 1) | Purpose |
|---|---|---|
| `js/film-transform.js` | Film agent | Pure colour math: `makeFilm`, `buildLut`, sRGB helpers |
| `js/films.js` | Film agent | Film-stock inventory (data + descriptions) |
| `scripts/gen-film-doc.mjs`, `docs/FILM_STOCKS.md` | Film agent | Inventory doc generated from `films.js` |
| `tests/film.test.mjs` | Film agent | `node --test` unit tests |
| `js/cameras.js` | Render agent | Camera/lens presets (data + descriptions) |
| `js/renderer.js` | Render agent | WebGL2 pipeline (single shader pass) |
| `js/maps.js` | Render agent | CPU-side low-res maps: halation/bloom maps, flare point |
| `js/overlays.js` | Render agent | Dust/scratch texture, date-stamp texture, light-leak params |
| `tests/render.test.mjs` | Render agent | unit tests for pure parts (overlays params, cameras schema) |
| `js/jpeg-worker.js` | Export agent | Classic Web Worker: streaming baseline JPEG encoder (4:2:0) + EXIF APP1 |
| `js/exif.js` | Export agent | Read EXIF DateTimeOriginal from a JPEG `File` |
| `js/exporter.js` | Export agent | Full-res strip export orchestration |
| `tests/jpeg.test.mjs`, `tests/exif.test.mjs` | Export agent | unit tests |
| `index.html`, `css/app.css`, `js/app.js`, `js/ui.js` | Shell agent | UI, state, wiring |
| `manifest.webmanifest`, `sw.js`, `icons/*`, `scripts/make-icons.mjs`, `scripts/serve.mjs` | Shell agent | PWA plumbing |

Agents must not edit files they don't own. If a contract below seems wrong, implement to the
contract and note the issue in your final report.

## Data flow

```
File ─► <img> (full res, EXIF-oriented by the browser) ──────────────┐
          │                                                          │ export (strips)
          ▼ drawImage                                                ▼
     proxy canvas (≤2048 long edge) ─► Renderer.setSource      exporter.exportJpeg
          │                                                          │
          ├─► maps.buildMaps(proxy) ─► Renderer.setMaps              │
          └─► thumbnails (CPU, makeFilm per stock)                   │
state ─► buildLut(film) ─► Renderer.setLut                           │
state ─► overlays (dust canvas, date canvas, leaks) ─► Renderer      │
state ─► Renderer.render(params, target) ─► preview canvas / FBO ◄───┘
```

**Resolution independence is the core rule.** Every spatial effect is defined relative to the
*full image* (normalised 0..1 coords, or px × `scale`), so the ≤2048 px preview and the full-res
strip export look the same. Grain, sharpening radii, CA etc. are computed in "full-image px"
and the renderer is told the current `scale` (target short edge / original short edge).

## 1. `js/film-transform.js` (pure, no DOM — must run in Node for tests)

```js
export const LUT_SIZE = 33;
export const LUT_HEADROOM = 2.0;     // LUT input u∈[0,1] encodes linear = srgbToLinear(u) * 2.0
export function srgbToLinear(v) {}   // scalar
export function linearToSrgb(v) {}   // scalar, clamps negative to 0
export function makeFilm(params)     // -> fn(rLin, gLin, bLin, out: Float32Array|number[3]) writes sRGB-encoded 0..1
export function buildLut(params, N = LUT_SIZE) // -> Uint16Array (N*N*N*4, half-float RGBA, A=1.0)
                                                //    index = ((b*N + g)*N + r)*4 ; input via LUT_HEADROOM shaper
export function floatToHalf(f)       // helper used by buildLut
export const FILM_DEFAULTS = {...}   // see schema below
```

`makeFilm(params)` merges `params` over `FILM_DEFAULTS`. Pipeline (in this order):
linear WB (`temp`,`tint`) → `matrix` (3×3 row-major channel mixer, linear) → `exposure` (stops)
→ B&W mix (`type:'bw'`, `bwMix`) → linear highlight shoulder (`rolloff`) → encode sRGB →
`contrast` S-curve → `shadows`/`highlights` → per-channel `lift`/`gamma`/`gain`
→ (colour only) `sat`, `vibrance`, `satShadows`/`satHighlights`, 8-band `hsl`
→ split toning (`splitShadow`, `splitHighlight`; also used for B&W toning)
→ `fade` / `whitePoint` → clamp 0..1.

### Film params schema (`FILM_DEFAULTS`)

```js
{
  type: 'color',            // 'color' | 'bw'
  exposure: 0,              // stops
  temp: 0, tint: 0,         // -1..1 (blue↔amber, green↔magenta)
  matrix: null,             // [9] linear channel mixer rows (false-colour stocks)
  bwMix: [0.30, 0.59, 0.11],// B&W spectral sensitivity (normalised internally)
  contrast: 0,              // -1..1
  shadows: 0, highlights: 0,// -1..1
  rolloff: 0,               // 0..1 highlight shoulder softness
  fade: 0,                  // 0..0.25 black lift
  whitePoint: 1,            // 0.8..1
  lift: [0,0,0], gamma: [1,1,1], gain: [1,1,1],  // per-channel (crossovers / casts)
  sat: 1, vibrance: 0, satShadows: 1, satHighlights: 1,
  hsl: {},                  // { red|orange|yellow|green|aqua|blue|purple|magenta: [hueShiftDeg, satMul, lumAdd] }
  splitShadow: null,        // { hue: deg, amt: 0..1 }
  splitHighlight: null,     // { hue: deg, amt: 0..1 }
  // spatial (NOT in the LUT; read by the renderer)
  grain: { amount: 0.3, size: 1, color: 0.3 },   // amount 0..1; size 1 = ISO-400-ish 35mm; color 0 mono..1
  halation: { amount: 0.05, color: [1, 0.35, 0.15] },
  bloom: 0,                 // 0..1 (instant films, diffusion)
}
```

## 2. `js/films.js`

```js
export const FILM_CATEGORIES = [
  { id: 'color', label: 'Colour' }, { id: 'bw', label: 'B&W' }, { id: 'slide', label: 'Slide' },
  { id: 'cine', label: 'Cinema' }, { id: 'special', label: 'Specialty' } ];
export const FILMS = [ {
  id: 'kodak-portra-400', name: 'Portra 400', brand: 'Kodak', iso: 400,
  category: 'color',                  // one of FILM_CATEGORIES ids
  process: 'C-41',                    // C-41 | B&W | E-6 | ECN-2 | K-14 | Instant
  status: 'current',                  // 'current' | 'discontinued'
  swatch: ['#f2c14e', '#d9480f'],     // canister/label colours for UI cards
  summary: 'one line',                // card subtitle / list
  traits: { color: '', contrast: '', grain: '', highlights: '', shadows: '' }, // prose
  params: { ...film params... },
}, ... ];
export function getFilm(id) {}        // falls back to FILMS[0]
export const DEFAULT_FILM_ID = 'kodak-portra-400';
```
~45 stocks across all categories. Required to include at least: Portra 160/400/800, Ektar 100,
Gold 200, Ultramax 400, ColorPlus 200, Superia X-TRA 400, Fujicolor C200, Pro 400H, CineStill 800T &
50D, Vision3 250D/500T, Tri-X 400, T-Max 100/P3200, HP5 Plus, FP4 Plus, Delta 3200, Pan F Plus,
XP2 Super, SFX 200, Acros II, Double-X 5222, Ektachrome E100, Kodachrome 64, Velvia 50/100,
Provia 100F, Aerochrome, LomoChrome Purple/Metropolis, Redscale, cross-processed E-6, Polaroid 600,
Instax Mini.

## 3. `js/cameras.js`

```js
export const CAMERAS = [ {
  id: 'canon-ae1', name: 'AE-1', brand: 'Canon', year: 1976, lens: 'FD 50mm f/1.8',
  body: 'slr',          // 'slr' | 'rangefinder' | 'compact' | 'medium' | 'toy' | 'none' (UI icon)
  format: '35mm', formatScale: 1,   // grain size divides by this (6x7 ≈ 2.6, half-frame 0.7)
  summary: '', traits: '',          // prose
  params: {
    vignette: 0..~1.5,     // corner light falloff in stops ×1.6
    vignetteHardness: 2..4,// exponent on radial distance
    sharpness: -1..1,      // <0 softens, >0 unsharp-mask micro-contrast
    cornerSoft: 0..1,      // extra softness toward corners (field curvature)
    ca: 0..1,              // lateral chromatic aberration
    contrast: -0.3..0.3,   // lens contrast / veiling glare
    warmth: -0.1..0.1,     // coating colour cast
    bloom: 0..1,           // wide-open glow
    flare: 0..1,           // flare susceptibility
  } }, ... ];
export const DEFAULT_CAMERA_ID = 'none';   // CAMERAS[0] = { id:'none', name:'No camera', ... all zero }
export function getCamera(id) {}
```

## 4. `js/maps.js`

```js
export function buildMaps(proxyCanvas) -> {
  hmap: HTMLCanvasElement,  // ≤512 long edge; R = blurred highlight mask (small radius), G = wider radius
  bmap: HTMLCanvasElement,  // ≤512 long edge; rgb = blurred highlight-weighted colour, LINEAR light
  flare: { x, y, strength } // normalised (y down) brightest-source position, strength 0..1
}
```

## 5. `js/overlays.js`

```js
export function makeDustCanvas(aspect /* w/h */, seed, amount /*0..1*/) -> HTMLCanvasElement
  // ≤2048 long edge, opaque black bg. R = white specks/hairs, G = dark specks, B = scratches.
export function makeDateCanvas(date: Date, opts: { format: 'classic'|'us'|'dots'|'iso', color: 'orange'|'red'|'yellow' },
                               fullW, fullH) -> { canvas, rect: [x, y, w, h] /* normalised, y down */ }
  // Seven-segment LED digits drawn on BLACK (renderer screen-blends rgb). Canvas px == full-image px.
  // classic: '98 10 5   us: 10 5 '98   dots: 98.10.05   iso: 2026 10 05
export function makeLeaks(seed) -> Array<{ x, y, r, stretch, color: [r,g,b] }>   // 1–3 leaks, normalised
export function mulberry32(seed) -> () => float   // seeded PRNG (shared)
```

## 6. `js/renderer.js`

```js
export class Renderer {
  constructor(canvas)              // throws Error('webgl2-unavailable') if no WebGL2
  get limits()                     // { maxTexture, maxRenderbuffer, maxViewport: [w,h] }
  setSource(canvasOrImageSource)   // uploads uSrc; for preview: the proxy canvas
  setLut(halfData: Uint16Array, N) // 3D RGBA16F (falls back to RGBA8 if unsupported)
  setMaps({ hmap, bmap })
  setDust(canvas | null)
  setDate({ canvas, rect } | null)
  setParams(p)                     // RenderParams below; cheap, call often
  renderPreview()                  // draws source-sized proxy to the canvas (canvas.width/height = source size)
  renderRegion({ srcOrigin:[x,y], srcSize:[w,h], full:[W,H], outOrigin:[x,y], outSize:[w,h], scale })
                                   // renders into an internal FBO of outSize, returns Uint8Array RGBA,
                                   // row 0 = TOP row of the region (no flip needed by the encoder)
  onContextRestored(cb)            // app re-sends everything after a context loss
  dispose()
}
```

`RenderParams` (all plain numbers/arrays; renderer derives uniforms):
```js
{
  film: <film object from films.js>, camera: <camera object>,
  filmAmt: 0..1, camAmt: 0..1,
  grain: 0..2, halation: 0..2, flare: 0..2,     // multipliers on film/camera values
  leak: 0..1, leaks: [...makeLeaks()],
  dust: 0..1,
  dateOn: bool,
  exposure: -2..2, contrast: -1..1, warmth: -1..1, tint: -1..1,   // user adjustments
  flarePoint: { x, y, strength },
  split: -1 | 0..1,          // compare: x < split shows original; -1 off
  showOriginal: bool,
  seed: int,                 // grain seed
  fullShort: number,         // short edge of the ORIGINAL full-res image (px) — sizes grain etc.
}
```
Shader order: lens (sharpen/soften with corner falloff, CA) → linear → user/lens WB + exposure →
vignette (stops) → halation + bloom (from maps) → flare → encode with LUT_HEADROOM shaper →
film LUT mixed by `filmAmt` → post contrast (user + lens) → grain (value noise in full-image px,
size = fullShort·0.00045·film.grain.size / camera.formatScale, ≥1 target px; luminance-weighted)
→ light leaks (screen) → dust → date stamp (screen) → dither. Strip export needs neighbourhood
sampling ≤ `PAD = 64` px; clamp sample coords to the full image.

## 7. `js/exif.js`

```js
export async function readExifDate(file) -> Date | null   // DateTimeOriginal, fallback DateTime; JPEG only
```

## 8. `js/jpeg-worker.js` (classic worker, no imports)

Messages in:  `{ type:'start', width, height, quality /*1..100*/, exifDate?: 'YYYY:MM:DD HH:MM:SS' }`
             `{ type:'rows', data: Uint8Array /*RGBA*/, rows }`  (rows multiple of 16 except the last strip)
             `{ type:'finish' }`
Messages out: `{ type:'consumed', rows }` after each strip (backpressure), `{ type:'done', blob }`,
             `{ type:'error', message }`.
Baseline JPEG, YCbCr 4:2:0, standard Annex K tables, optional EXIF APP1 (DateTimeOriginal + Software "C41").

## 9. `js/exporter.js`

```js
export async function exportJpeg({ renderer, image /*HTMLImageElement full res*/, params /*RenderParams*/,
  quality = 92, exifDate = null, onProgress = (0..1) => {}, signal /*AbortSignal*/ }) -> Blob
```
Strips: width = full width (downscaled only if > renderer limits), height multiple of 16 sized to
~4 MP incl. `PAD` rows above/below; each strip drawn from `image` into a reusable 2D canvas, uploaded
via `setSource`, `renderRegion`, posted to the worker (≤2 strips in flight). Restores the preview
source afterwards (caller passes `restorePreview` cb or exporter re-calls `renderer.setSource(proxy)` —
exporter accepts `proxy` option and restores it). Releases canvases (width=height=0) for iOS memory.

## 10. Shell (`index.html`, `js/app.js`, `js/ui.js`, `css/app.css`, PWA files)

Mobile-first dark UI: top bar (import / compare / save), stage with the preview canvas
(press-and-hold = original, split-compare handle), bottom panel tabs Film · Camera · Effects · Adjust,
custom touch sliders (relative drag, double-tap resets), film cards with CPU thumbnails rendered
via `makeFilm`, info sheet with traits, export sheet (progress → "Save to Photos" via
`navigator.share({files})` on a fresh tap, download fallback, long-press preview). Safe-area insets,
`100dvh`, no page scroll, `touch-action: manipulation`. Settings persisted in localStorage (try/catch).
Service worker: versioned precache of the app shell, cache-first, offline navigation fallback.
