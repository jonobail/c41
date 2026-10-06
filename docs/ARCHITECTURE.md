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
export const FILMIC_DEFAULTS = { slope: 1, toe: 0.3, shoulder: 0.25, blackDensity: 2.5 }
export function monotoneCurve(points)   // -> x=>y, Fritsch–Carlson monotone cubic (sanitising rules below)
export function makeFilmicCurve(filmic) // -> linear x≥0 => linear display 0..1 (the filmic stage alone)
// fitting helpers (see "Fitting" below)
export function getPath(obj, 'a.b.0'), setPath(obj, path, value)
export function paramVector(spec, params) -> Float64Array
export function applyVector(spec, vec, base) -> new params object
export function specBounds(spec) -> { lo: Float64Array, hi: Float64Array }
export const FIT_SPEC, FIT_SPEC_FILMIC, FIT_SPEC_BW, CURVE_X, CHANNEL_CURVE_X
```

`makeFilm(params)` merges `params` over `FILM_DEFAULTS`. Pipeline (in this order):
linear WB (`temp`,`tint`) → `matrix` (3×3 row-major channel mixer, linear) → `exposure` (stops)
→ B&W mix (`type:'bw'`, `bwMix`) → **tone stage** (per channel, tabulated):
[`filmic` characteristic curve **or** (`rolloff` shoulder → encode sRGB → `contrast` S-curve)]
→ `shadows`/`highlights` → master `curve` → (colour only) `curveR`/`curveG`/`curveB`
→ per-channel `lift`/`gamma`/`gain`
→ (colour only) `sat`, `vibrance`, `satShadows`/`satHighlights`, `chromaCurve` → 8-band `hsl`
→ `density` (subtractive dye darkening) → split toning (`splitShadow`, `splitHighlight`; also
used for B&W toning) → (`lumaLock`) gamut compress → `fade` / `whitePoint` → clamp 0..1 (NaN → 0).

All new keys default to no-op; `makeFilm({})` ≈ identity, and films that don't use the new keys
render exactly as before (≤ 3e-6). Cost: ~200 ns/px for a typical stock, ~420 ns/px with
every feature on (Node, x86); compile 1–8 ms.

### Film params schema (`FILM_DEFAULTS`)

```js
{
  type: 'color',            // 'color' | 'bw'
  exposure: 0,              // stops
  temp: 0, tint: 0,         // -1..1 (blue↔amber, green↔magenta)
  matrix: null,             // [9] linear channel mixer rows (false-colour stocks)
  bwMix: [0.30, 0.59, 0.11],// B&W spectral sensitivity (normalised internally)
  contrast: 0,              // -1..1   (ignored when `filmic` is set)
  shadows: 0, highlights: 0,// -1..1
  rolloff: 0,               // 0..1 highlight shoulder softness (ignored when `filmic` is set)
  fade: 0,                  // 0..0.25 black lift
  whitePoint: 1,            // 0.8..1
  lift: [0,0,0], gamma: [1,1,1], gain: [1,1,1],  // per-channel (crossovers / casts)
  sat: 1, vibrance: 0, satShadows: 1, satHighlights: 1,
  hsl: {},                  // { red|orange|yellow|green|aqua|blue|purple|magenta: [hueShiftDeg, satMul, lumAdd] }
                            //   table values clamped to hue ±60°, sat× 0..4, lum ±0.5
  splitShadow: null,        // { hue: deg, amt: 0..1 }
  splitHighlight: null,     // { hue: deg, amt: 0..1 }
  // --- extended tone / colour model (all optional) ---
  filmic: null,             // { slope, toe, shoulder, blackDensity } — see "Filmic" below
  curve: null,              // [[x,y],...] master tone curve, encoded 0..1 (applies to B&W too)
  curveR: null, curveG: null, curveB: null, // per-channel curves, same format (colour only)
  density: 0,               // 0..1 subtractive dye density (darkens saturated colours)
  densityHue: null,         // { band: multiplier 0..3 } hue weighting of density (HSL band names, default 1)
  chromaCurve: null,        // [5] sat multipliers at luma 0, .25, .5, .75, 1 (piecewise linear, × sat)
  lumaLock: false,          // true: luma-preserving colour stages (recommended for fitted films)
  hueKeep: null,            // { band: [hueShiftDeg, chromaMul] } keyed by SCENE (input) hue — see below
  // spatial (NOT in the LUT; read by the renderer)
  grain: { amount: 0.3, size: 1, color: 0.3 },   // amount 0..1; size 1 = ISO-400-ish 35mm; color 0 mono..1
  halation: { amount: 0.05, color: [1, 0.35, 0.15] },
  bloom: 0,                 // 0..1 (instant films, diffusion)
}
```

**Curves** (`curve`, `curveR/G/B`): control points `[[x,y],...]`, encoded sRGB in/out, evaluated
with a monotone cubic (Fritsch–Carlson; C1, no overshoot). Sanitising, so any input is safe:
non-finite / malformed points dropped; x,y clamped to 0..1; duplicate x averaged; implicit
`(0,0)` / `(1,1)` added if the points don't reach x=0 / x=1; y made non-decreasing by isotonic
regression (violating neighbours are averaged — keeps gradients alive for optimisers). An
identity or empty curve is a no-op. The master curve runs after contrast/shadows/highlights;
channel curves run after the master curve and are ignored for `type:'bw'` (so B&W stays r=g=b).

**Filmic** (`filmic: {...}`, missing fields from `FILMIC_DEFAULTS`; replaces `rolloff` + `contrast`).
A print-through characteristic curve on log exposure, per channel (one channel for B&W):

```
E    = log10(x / 0.18)                         x = linear scene value after matrix/exposure
Dlin = log10(1/0.18) + off − slope·E           straight-line portion (density units)
D1   = softplus(Dlin; shoulder)                shoulder: density can't fall below paper white
D    = Db − softplus(Db − D1; toe)             toe: density saturates at Db = blackDensity
y    = 10^−(D − Dw),  Dw = D(x→∞)              linear display value, white → 1 asymptotically
softplus(v; w) = w·ln(1 + e^(v/w))
```

`off` is solved at build time so 0.18 → 0.18 (mid grey pinned; use `exposure` to move it).
`slope` = midtone gamma in log-log (1 ≈ digital, 1.3–1.6 punchy print, <1 flat/log-ish; clamped
0.2..4). `shoulder` (density width, 0.005..3) = highlight compression/latitude: larger rolls off
earlier and keeps separation far above 1.0 (at defaults: x=1 → 0.84, x=2 → 0.94 encoded).
`toe` (0.005..3) = how gradually shadows fall into Dmax. `blackDensity` (0.5..5) = print Dmax;
black outputs 10^−(Db−Dw) linear (encoded: 2.5 → ≈0.04 matte black; 3.5 → ≈0.004; 1.5 → ≈0.19 faded).
`y` is then sRGB-encoded and continues into shadows/highlights → curve.

**Density**: after `hsl`, RGB is multiplied by `1 − k`, `k = 0.45·density·C·(0.4 + 0.6·C)·hueW`,
where `C` = chroma (max−min, encoded) **relative to the film's own neutral at the same luma**
(see below) and `hueW` interpolates `densityHue` over the 8 HSL band hues. Hue and HSV saturation
are kept, luma drops: pure red at density 1 → ×0.55; a skin tone → ≈×0.93; neutrals ×1.

**Neutral axis**: when `density > 0` or (`lumaLock` and `hsl`), `makeFilm` traces a grey ramp
(linear 0..2.5) through the front half of the pipeline (to the end of the saturation stage) and
tabulates its colour by luma (1024 nodes, with a per-node tolerance for interpolation error).
"Relative chroma" = chroma of (pixel − neutral(pixel luma)), minus that tolerance. Casts and
crossovers that the film applies to greys are therefore never treated as "colour".

**`lumaLock: true`** (colour only) makes the colour stages luma-safe: the saturation stage
shrinks its factor so no channel leaves 0..1 (hue + luma kept, instead of clipping); `hsl` hue
and sat edits preserve Rec.709 luma (the lum column becomes an explicit luma scale
`1 + lum·s`), out-of-gamut results are compressed toward luma rather than clipped, and band
effects fade in over relative chroma 0..0.06 (so the neutral axis is untouched); a final
luma-preserving gamut compress runs before `fade`. Without it, `hsl` keeps the legacy HSV
behaviour (e.g. desaturating at fixed V brightens). With `lumaLock`, grey-ramp luma is
monotonic for **any** params within the FIT_SPEC bounds (fuzz-tested); without it that holds only
for the tone/cast stages. Fitted films should set `lumaLock: true`.

**`hueKeep`** (colour only) is the one colour control keyed by the **scene's** hue (the linear
input, weighted in by input HSV saturation 0.1→0.35) rather than the post-cast hue. Right after the
tone/cast stages it rotates (`hueShiftDeg`) and scales (`chromaMul`) the pixel's chroma *relative to
the film's neutral at that luma*, at constant luma, then pulls any out-of-gamut result toward luma.
A strong cast can collapse e.g. a blue sky into the neutral, where `hsl` (classified post-cast and
faded near the neutral) can no longer reach it; `hueKeep` can. "Match a photo" uses it to keep hues
the reference doesn't show (skies, foliage) from being dragged into the reference's cast.

### Fitting helpers

A *spec* is an array of `{ path, min, max, def, fixed? }`. `path` is a dotted path into params
(`'contrast'`, `'lift.0'`, `'hsl.green.1'`, `'curve.3.1'`, `'filmic.slope'`); numeric segments
index arrays. `paramVector(spec, params)` reads each path (missing → `def`) and clamps to
`[min,max]`. `applyVector(spec, vec, base)` deep-copies `base` (never mutated), clamps each value,
writes each entry's `fixed` paths (e.g. a curve point's fixed x), then the value. Missing
containers are created sensibly: `hsl.<band>` → `[0,1,0]`; `lift/gamma/gain/bwMix` → copy of the
default; `filmic` → `FILMIC_DEFAULTS`; `chromaCurve` → `[1,1,1,1,1]`; curve point → `[x, y]`.
Results only use schema keys. `paramVector(spec, applyVector(spec, v, base))` ≡ `v` for v in bounds.

* `FIT_SPEC` (68 params, colour; base should have `lumaLock: true`):
  `exposure` −1..1, `contrast` −0.6..0.8, `shadows`/`highlights` −0.6..0.6, `rolloff` 0..1,
  `fade` 0..0.15, `whitePoint` 0.8..1, `temp`/`tint` −0.4..0.4, `lift.0-2` −0.05..0.12,
  `gamma.0-2` 0.75..1.33, `gain.0-2` 0.85..1.15, `sat` 0.3..1.8, `vibrance` −0.5..0.5,
  `satShadows`/`satHighlights` 0.4..1.6, `chromaCurve.0-4` 0.4..1.8, `density` 0..1,
  per band `hsl.<band>.0` (hue) −25..25, `.1` (sat×) 0.4..1.8, `.2` (lum) −0.1..0.1,
  `curve.i.1` at fixed x `CURVE_X = [0, .1, .25, .5, .75, .9, 1]`, y ∈ x ± 0.3 (clamped 0..1),
  `curveR/G/B.i.1` at fixed x `CHANNEL_CURVE_X = [.25, .5, .75]`, y ∈ x ± 0.12.
* `FIT_SPEC_FILMIC` (4): `filmic.slope` 0.5..2, `filmic.toe` 0.02..1.5, `filmic.shoulder`
  0.02..1.5, `filmic.blackDensity` 1..3.5. Concatenate with FIT_SPEC / FIT_SPEC_BW to fit a
  characteristic curve (then `contrast`/`rolloff` are inert — drop them from the spec).
* `FIT_SPEC_BW` (16): the tone entries of FIT_SPEC + `bwMix.0` 0.05..0.8, `bwMix.2` 0..0.6
  (green fixed at 0.59 as reference; the mix is normalised) + master `curve` points.

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
  body: 'slr',          // UI icon: 'slr' | 'rangefinder' | 'compact' | 'medium' | 'toy' | 'fisheye' |
                        //          'multilens' | 'pano' | 'spinner' | 'none'
  format: '35mm', formatScale: 1,   // '35mm'|'half-frame'|'6x6'|'6x7'|'6x12'|'35mm-pano'; grain size ÷ formatScale
  badge: null,          // optional card badge text instead of the format label ('2×2', 'Circle', '360°')
  aspect: 1.5,          // frame long/short (half-frame 4/3, 6x6 1, 6x7 1.25, 6x12 2, 35mm-pano 2.06);
                        // null = photo's own aspect. "Crop to format" crops to it in the PHOTO's orientation.
  minAspect: null,      // with aspect null: crop to at least this (Spinner 4.3; a phone pano keeps its own)
  frame: '135',         // "Film border" style: '135' | 'half' | '120' | 'holga' | 'sprocket'
                        // ('sprocket' = picture across the full 35 mm width, perforations ON the picture)
  notch: false,         // Hasselblad film-back notches on the 120 border
  mask: null,           // in-picture mask, always drawn: { type:'rounded', inset, radius, feather, wobble }
                        // (fractions of the frame short edge; Diana F+, LC-A 120)
  flashGels: false,     // UI offers flash gels (RenderParams.gel)
  masks: null,          // switchable formats [{ id, label, aspect, formatScale?, format?, frame?, grid?, badge? }]
                        // (first = default); effectiveCamera(camera, maskId) applies one
  grid: null,           // multi-lens grid → renderer remap mode 1 (see §6):
                        // { cols, rows (landscape; swapped for portrait), fit:'cover'|'split', shift (per
                        //   lens step, fraction of a cell), motion:'long'|'random', zoomJitter, expoJitter
                        //   (± stops), tintJitter, gap, gapCore (fractions of the short edge), gapLuma }
  fisheye: null,        // circular fisheye → remap mode 2: { radius (× half short edge), virtualHalfFov
                        //   (deg), rim (reflection ring), fill:'contain'|'cover' }
  summary: '', traits: '',          // prose
  params: {             // all × "Lens character" amount (0..1.5) unless noted
    vignette: 0..~1.5,     // corner light falloff in stops ×1.6 (d = 0 centre .. 1 frame corner)
    vignetteHardness: 2..4,// exponent on radial distance (not scaled)
    vignetteOffset: [x,y], // vignette centre offset, fraction of the half-diagonal (uneven toy lenses)
    vignetteWobble: 0..1,  // angular unevenness of the falloff
    vigSat: 0..1,          // saturation boost that follows the vignette (LC-A)
    sharpness: -1..1,      // <0 softens the whole frame, >0 unsharp-mask micro-contrast
    clarity: -0.6..0.6,    // local contrast at ~0.6 % of the short edge (+ pop, − haze/glow)
    cornerSoft: 0..1,      // blur toward the corners (field curvature)
    sweetSpot: 0..0.9,     // sharp radius before cornerSoft ramps in (not scaled)
    blurShape: -1..1,      // corner blur shape: 0 round, +1 radial/zoom, −1 swirl (not scaled)
    distortion: -0.1..0.1, // barrel (+) / pincushion (−), frame corners fixed
    ca: 0..1,              // lateral chromatic aberration
    contrast: -0.3..0.3,   // lens contrast (post S-curve)
    sat: -0.3..0.3,        // saturation shift (camera colour signature)
    veil: 0..0.1,          // veiling glare: lifts/washes blacks (linear, pre-film)
    warmth: -0.1..0.1,     // coating cast (amber +)
    tint: -0.1..0.1,       // green (−) / magenta (+) cast
    bloom: 0..1,           // wide-open glow
    flare: 0..1,           // flare susceptibility
    flash: 0..1,           // built-in flash harshness when the Flash toggle is on (not scaled; default 0.6)
    leak: 0..1,            // built-in light-leak strength (camera leaks always on when > 0)
    leakBias: 'edge'|'holga', // passed to overlays.makeLeaks(seed, { bias })
    vigAxis: 0..1,         // 0 radial … 1 falloff only across the film / short frame axis (not scaled)
    banding: 0..1,         // rotating-slit exposure bands along the long axis (Spinner)
    swirl: 0..1,           // corner blur along arcs round the centre (Petzval; not scaled)
  } }, ... ];
export const DEFAULT_CAMERA_ID = 'none';   // CAMERAS[0] = { id:'none', aspect:null, all look params zero }
export function getCamera(id) {}
export function effectiveCamera(camera, maskId)   // camera with a `masks` entry applied (or unchanged)
export const GROUPS = [{ id:'classic' }, { id:'lomo' }]; export function cameraGroup(camera)  // UI grouping
export const FLASH_GELS = [{ id, label, rgb: [r,g,b] | null, swatch }]; export function getGel(id)
```
Lomography cameras (`brand: 'Lomography'`, ids `lomo-*` from `calibration/lomo-cameras.json`):
Diana F+, Diana Mini, LC-A 120, LC-Wide, Fisheye No.2, Sprocket Rocket, Spinner 360°, ActionSampler,
Supersampler, Oktomat, La Sardina, Simple Use, Petzval 85, Belair X 6-12. The original `lomo-lca`
(brand 'Lomo') keeps its id.
`vignette`/`vignetteHardness` keep their original meaning (fitted from reference photos in
`calibration/`); every other key is an additive modifier that defaults to a no-op.

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
export function makeDustCanvas(aspect /* w/h of the FRAME */, seed, amount /*0..1*/) -> HTMLCanvasElement
  // ≤2048 long edge, opaque black bg. R = white specks/hairs, G = dark specks, B = scratches.
export function makeDateCanvas(date: Date, opts: { format: 'classic'|'us'|'dots'|'iso', color: 'orange'|'red'|'yellow' },
                               frameW, frameH) -> { canvas, rect: [x, y, w, h] /* normalised to the frame, y down */ }
  // Seven-segment LED digits drawn on BLACK (renderer screen-blends rgb). Canvas px == full-image px.
  // classic: '98 10 5   us: 10 5 '98   dots: 98.10.05   iso: 2026 10 05
export function makeLeaks(seed, opts?: { bias: 'edge'|'holga' }) -> Array<{ x, y, r, stretch, color: [r,g,b] }>
  // no bias: 1–3 leaks (user "Light leak"); bias: 1–2 camera leaks hugging the left/right frame edge
export function mulberry32(seed) -> () => float   // seeded PRNG (shared)
export function instantType(film) -> 'polaroid' | 'instax' | null   // from the film id
export function frameLayout(W, H, { camera, film, crop: bool, border: bool, seed }) -> {
  full: [W, H],            // original image px
  crop: [x, y, w, h],      // camera FRAME inside the image (px) — centred, camera.aspect in the photo's
                           // orientation (instant films force their own aspect); whole image if crop off
  inner: [l, t],           // frame origin inside the output (px, full-res units)
  out: [w, h],             // output size incl. border (px, full-res units)
  style: null|'135'|'half'|'120'|'holga'|'sprocket'|'polaroid'|'instax',
  filmBorder: bool,        // rebate is film (grain + leaks continue onto it) vs instant paper
  mask: null|'sprocket'|'rounded',   // in-picture mask (drawn even when border is off)
  draw: null | (ctx2d, ox, oy, k) => void,   // paints the border: canvas px (0,0) = output px (ox,oy)
}                                            // at k output px per full-res px; opaque border, transparent picture
```
In-picture masks are on the negative, so `draw` exists (with `inner = [0,0]`, `out = crop size`,
`filmBorder: true`) even without a border: `sprocket` paints black KS perforations 2 mm in from each
film edge plus edge print (alpha ≈ 0.85, process ink colour) OVER the picture, the frame's short
side being the full 35 mm film width; with a border it only adds a thin scanner margin. `rounded`
paints soft black corners outside a wobbly rounded rectangle; the feather is N nested layers added
with `'lighter'` (no canvas blur), so preview and every strip match exactly.
Borders are sized in film millimetres from the frame's across-film side (135: 24 mm picture on 35 mm
film with KS perforations, edge print `FILM NAME`, frame numbers, DX-style bars, ink colour by
process; 120: black rebate, edge print, frame number; holga: rough rounded mask; instant: paper
with a thick bottom strip). Deterministic (seeded) and resolution independent.

## 6. `js/renderer.js`

```js
export const PAD = 64;             // base neighbourhood (export px); the lens adds lensReach()
export const CAM_AMT_MAX = 1.5;    // "Lens character" may exaggerate to 150 %
export function lensUniforms(camera, camAmt) -> {...}   // derived, clamped lens/colour uniforms
export function lensReach(camera, camAmt, frameW, frameH) -> px   // max lens sampling distance (same units)
export class Renderer {
  constructor(canvas)              // throws Error('webgl2-unavailable') if no WebGL2
  get limits()                     // { maxTexture, maxRenderbuffer, maxViewport: [w,h] }
  setSource(canvasOrImageSource)   // uploads uSrc (mipmapped); for preview: the proxy canvas (whole image)
  setLut(halfData: Uint16Array, N) // 3D RGBA16F (falls back to RGBA8 if unsupported)
  setMaps({ hmap, bmap })          // built from the whole image; sampled through the crop
  setDust(canvas | null)
  setDate({ canvas, rect } | null)
  setFrame({ canvas, origin:[x,y], size:[w,h] } | null)  // border texture, placed in OUTPUT px of the
                                   // next render (preview: whole output; export: the current strip)
  setParams(p)                     // RenderParams below; cheap, call often
  previewSize() -> [w, h]          // canvas size renderPreview() will use (output incl. border)
  renderPreview()                  // canvas.width/height = params.layout.out × (proxy / full); whole image if no layout
  renderRegion({ srcOrigin:[x,y], srcSize:[w,h], full:[W,H], outOrigin:[x,y], outSize:[w,h], scale,
                 crop?:[x,y,w,h], inner?:[x,y], outFull?:[w,h], texK? })
                                   // texK = source texels per image render px (default 1; the exporter
                                   // uploads minified remap sources downsampled)
                                   // all render px: full = whole image, crop = frame inside it (default whole),
                                   // inner = frame origin in the output, outFull = output size (default crop size).
                                   // Renders into an internal FBO of outSize, returns a fresh Uint8Array RGBA,
                                   // row 0 = TOP row of the region (no flip needed by the encoder)
  onContextRestored(cb)            // app re-sends everything after a context loss
  dispose()
}
```

`RenderParams` (all plain numbers/arrays; renderer derives uniforms):
```js
{
  film: <film object from films.js>, camera: <camera object>,
  filmAmt: 0..1, camAmt: 0..1.5,
  grain: 0..2, halation: 0..2, flare: 0..2,     // multipliers on film/camera values
  leak: 0..1, leaks: [...makeLeaks()],          // user leaks
  camLeaks: [...makeLeaks(seed, { bias })],     // camera built-in leaks, weight = camera.params.leak × camAmt
  flash: 0 | 1,                                  // Flash toggle (strength = camera.params.flash)
  gel: [r,g,b] | null,                           // flash gel transmission (cameras.FLASH_GELS rgb); tints only
                                                 // the share of the light the flash added
  layout: <frameLayout() result> | null,         // format crop + border
  dust: 0..1,
  dateOn: bool,
  exposure: -2..2, contrast: -1..1, warmth: -1..1, tint: -1..1,   // user adjustments
  flarePoint: { x, y, strength },               // normalised to the WHOLE image (maps.buildMaps)
  split: -1 | 0..1,          // compare: output x < split shows original; -1 off
  showOriginal: bool,
  seed: int,                 // grain seed
  fullShort: number,         // short edge of the FRAME (crop) at full resolution (px) — sizes grain, lens radii
}
```
Coordinates: output px `o` → frame px `p = o − inner` → image px `p + crop.xy` (clamped to the whole
image). Everything lens/film (vignette, distortion, blur, flash, leaks, dust, date) is relative to the
frame. Shader order: border texture (opaque → skip) → lens: distortion (corners fixed) → lateral CA →
elliptical blur (overall softness + cornerSoft beyond sweetSpot, radial/swirl by blurShape) →
unsharp + clarity → linear → user/lens WB + exposure → vignette (stops, offset/wobble) → flash →
veil → halation + bloom (maps) → flare → encode with LUT_HEADROOM shaper → film LUT mixed by
`filmAmt` → camera saturation (+ vignette-following) → post contrast (user + lens + flash) →
composite border → grain (also on a film rebate; value noise in full-image px,
size = fullShort·0.00045·film.grain.size / camera.formatScale, ≥1 target px; luminance-weighted)
→ light leaks, user + camera (screen; also on a film rebate) → dust (picture only) → date stamp
(screen, picture only) → dither. Strip export needs neighbourhood sampling ≤ `PAD + lensReach`
(ordinary lenses) or the remap source rect (below).

**Lens space / remapped lenses.** `develop()` runs in *lens px*; `lensToImg(q)` maps them to image
px and every lens tap (blur, CA, clarity, maps) goes through it. `uMode` 0 = plain (`q + crop.xy`,
unchanged behaviour). 1 = **multi-lens grid**: the frame is split into cols×rows cells; each cell is a
complete little frame (vignette, softness, CA, flash, flare per lens: `ctr`/`hd`/`refShort` are
the cell's) whose lens px map affinely `img = b + q·m` (`fit:'cover'`: the whole photo cover-fitted,
zoomed in just enough that the per-lens shifts stay inside; `fit:'split'`: each cell shows its own part
of the frame — half-frame pairs), plus per-cell exposure / colour jitter and soft dark separators
(`gapCore` black core + `gap` feather) at internal cell edges. 2 = **circular fisheye**: frame px
inside the circle R = radius·short/2 map equidistant-ish to the source along each ray,
`s = e·tan(ρΦ)/tanΦ` (e = short half-extent in the middle easing to the source's inscribed
ellipse at the rim, so the centre bulges without wobble); outside the circle: a faint reflection
of the rim, then black film base; a grey ring just inside the rim. Remaps minify the source, so
the source texture is mipmapped and sampled with `textureLod`, lod = log2(local magnification ×
texK) (grid: m; fisheye: analytic radial derivative) — identical in preview (proxy, texK 1) and
export. `remapGeometry(camera, img, crop, seed)` is the pure JS twin that builds the uniforms
(resolution independent, seeded per photo); `remapSourceRect(G, frameRect, reach)` returns the
image rect a frame rect samples (grid: affine corners per intersecting cell; fisheye: 4×97 border
samples + centre/axes through `fishPoint`) and the minimum magnification `jMin`.
Also: `vigAxis` swaps the radial vignette distance for the across-film one (lens-frame relative,
so Supersampler strips darken at their ends), `banding` multiplies seeded 1-D value noise along the
long axis, `swirl` replaces the corner-blur taps with arcs round the lens centre, and the flash gel
tints `share = clamp(1.7·(1 − 2^(flash·(sAmb − stops))))` of the light.

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
  quality = 92, exifDate = null, onProgress = (0..1) => {}, signal /*AbortSignal*/,
  proxy /*restored after*/, previewFrame /*{canvas,origin,size} restored after*/,
  stripPixels /*test hook: strip size*/ }) -> Blob
export function planExport(W, H, limits, layout?, reach?, stripPixels?) -> { s, outW, outH, stripH, pad, img,
  crop, inner, sx0, srcW, scale, fullShort }
export function remapStripSource(G, RG, y0, rows, reach, maxDim?, budget?) -> { x, y, w, h, texK }
```
Output = `params.layout.out × s` (crop + border; whole image when there is no layout), `s ≤ 1` so the
output and the per-strip source canvas fit the renderer limits. Strips: width = output width, height a
multiple of 16 sized to ~4 MP incl. `pad = PAD + lensReach(camera, camAmt, crop)` rows above/below.
Per strip: the matching image rows (frame columns ± pad, clamped in-bounds) are drawn from `image` into a
reusable 2D canvas → `setSource`; if the layout has a border, its rows are drawn with `layout.draw` into a
second canvas → `setFrame`; then `renderRegion` → worker (≤2 strips in flight). Without a layout the
geometry is identical to the original whole-image contract. **Remapped lenses** (`camera.grid` /
`camera.fisheye`) don't use the column band: per strip, `remapSourceRect` (strip rows ± PAD, lens
reach × magnification) gives the image rect it samples; it is aligned to 32 render px (so mip blocks
of neighbouring strips line up), clamped, drawn at `texK` = a power of two ≤ 1/jMin (grid cells are
minified → smaller upload; fisheye 1), capped at 16 MP / the GPU limit, and passed as
`srcOrigin/srcSize/texK`. Restores `proxy` / `previewFrame` /
params afterwards and releases canvases (width=height=0) for iOS memory.

## 10. Shell (`index.html`, `js/app.js`, `js/ui.js`, `css/app.css`, PWA files)

Mobile-first dark UI: top bar (import / compare / save), stage with the preview canvas
(press-and-hold = original, split-compare handle), bottom panel tabs Film · Camera · Effects · Adjust,
custom touch sliders (relative drag, double-tap resets), film cards with CPU thumbnails rendered
via `makeFilm`, info sheet with traits, export sheet (progress → "Save to Photos" via
`navigator.share({files})` on a fresh tap, download fallback, long-press preview). Safe-area insets,
`100dvh`, no page scroll, `touch-action: manipulation`. Settings persisted in localStorage (try/catch).
Service worker: versioned precache of the app shell, cache-first, offline navigation fallback.
