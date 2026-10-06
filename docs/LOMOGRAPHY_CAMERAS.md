# Lomography cameras — research & emulation specs

Research for adding Lomography cameras to `js/cameras.js`. It covers 14 core cameras plus 2 variants
(Diana Mini, Colorsplash), which were measured mainly as reference data. The machine-readable
version, with every measured number, is `calibration/lomo-cameras.json`. The app doesn't read it at
runtime; the presets in `js/cameras.js` were derived from it (see *Implementation status*).

Camera list source: <https://www.lomography.com/cameras> (101 cameras are listed, 27 of them
Lomography/Lomo branded). Specs come from the camera's Lomography Shop page where it is still sold
(`https://shop.lomography.com/ca/<slug>`). For discontinued models (LC-Wide, LC-A 120, Sprocket
Rocket, Supersampler, Oktomat, Belair, Petzval 85) they come from Lomography's microsites, magazine
and manual pages, and are marked *unverified* where no primary source was found.

## Implementation status (2026-10)

Implemented in `js/cameras.js` / `renderer.js` / `overlays.js` / `exporter.js` (contracts in
`docs/ARCHITECTURE.md` §3, §5, §6, §9; checks in `tests/render.test.mjs` and
`tests/remap.browser.mjs`):

| capability | status | notes |
|---|---|---|
| 1 `gel-flash` | done | `RenderParams.gel`, `camera.flashGels`, 7 gels (`FLASH_GELS`); the flash share is scaled ×1.7 so subject casts read like the Colorsplash set |
| 2 `sprocket-exposure` + `format-pano` | done | frame `'sprocket'`, `FMT['35mm-pano']` (2.06), always drawn (on the negative); border adds a scanner margin |
| 3 `multi-lens-grid` | done | `camera.grid`, renderer remap mode 1; `fit:'split'` also gives the Diana Mini half-frame pair. **`shift` is per lens step** — the measured 5.5 / 14 / 12 % are against cell 0, so the presets use 3 / 7 / 3.5 % |
| 4 `fisheye-circle` | done | `camera.fisheye`, remap mode 2. Isotropic in the centre, easing to the inscribed ellipse of the source at the rim (the p-norm "contain" edge in §4 made straight lines wobble) |
| 5 `frame-rounded-mask` | done | `camera.mask = { type:'rounded', … }` instead of new frame names; drawn with or without a border |
| 6 formats + `format-masks` | done | `'6x12'`, `camera.masks` (LC-Wide full/half/square, Belair 6×12/6×9/6×6, Diana Mini pair/square) as format chips |
| 8 `swirl-arc-blur` | done (param `swirl`) | new param so `blurShape < 0` cameras (LC-A, mju-II) are unchanged; capped by the blur radius, no depth gate |
| 9 `axis-vignette` + `slit-banding` | done | params `vigAxis`, `banding` |
| `pano-input` (Spinner) | done | `minAspect: 4.3` — a phone pano keeps its aspect, other photos are cut to 4.3:1 |
| 7 `kaleidoscope`, 10 `multi-exposure`, 11 `frame-overlap`/`wide-stretch`/`depth-gate` | not done | LomoApparat and Colorsplash therefore not added |

Cameras added: Diana F+, Diana Mini, LC-A 120, LC-Wide, Fisheye No.2, Sprocket Rocket, Spinner 360°,
ActionSampler, Supersampler, Oktomat, La Sardina, Simple Use, Petzval 85, Belair X 6-12. Deviations
from the params below (tuned by eye): Diana F+ vignette 1.4, LC-A 120 1.35, Sprocket Rocket 1.4;
Spinner vignette 0.6 / hardness 2.4 with `vigAxis 1`; Supersampler `vigAxis 0.85`; Petzval
`swirl 1` instead of `blurShape −1`; Diana Mini as a 1.48:1 pair with a black 2.8 % divider.

## Method

- **Samples.** For each camera, 18 photos from the Lomography community gallery
  (`https://www.lomography.com/<cameras|lenses>/<id>/photos?order=selected`, topped up from
  `order=popular`). Images are the 600 px renditions linked from each photo page. They were fetched
  at ≥1.2 s per request with User-Agent `C41-calibration/0.1 (film-emulation research; derives
  colour statistics only)` and cached in `calibration/cache/lomo/<id>/` (gitignored; the
  per-image metadata is in `meta.json`). There are 288 images in total. Wikimedia Commons was
  checked too, but only *Taken with Lomography Sprocket Rocket* has a usable set (50+ files). That
  set is a possible supplement and was not used.
- **Contact sheets.** Every set was looked at on a 6×3 contact sheet. Accessory shots that are not
  the camera's own lens or format were excluded by hand: Diana F+ with its fisheye lens, 35 mm back
  or instant back (6 of 18 excluded); LomoApparat kaleidoscope shots (2); one Belair shot on a
  35 mm back.
- **Measurements.** These use the functions in `calibration/measure.py` (`trim_border`,
  `vignette_profile`) and new scratch scripts. Every number is compared with the iPhone baseline
  (`cache/baseline`, 144 images, measured with the same code at the same 600 px size):
  - *falloff*: median log2 ring luminance relative to the centre, over aspect-normalised radius
    d = 0 (centre) to 1 (corner), **minus the baseline profile**, exactly as `fit-cameras.mjs` does.
    It was then fitted to the renderer model `−1.6·vignette·d^hardness`. For sets with a mask
    (Diana, LC-A 120, fisheye, sprocket), only bins up to d ≤ 0.8 (fisheye: 0.6) were fitted.
  - *sharpness*: Laplacian energy ratio, log2, of the mid-field ring (d 0.55–0.75) and the corners
    (d > 0.8) against the centre (d < 0.25), relative to the baseline's own ratio. *Centre detail* is
    the centre Laplacian RMS divided by global luma σ, as log2 relative to the baseline.
  - *colour*: mean chroma (max−min), luma σ (contrast), 2nd-percentile luma (black lift), mean R−B
    (warmth) and G−(R+B)/2 (green). Each is a median over the colour images, compared with the
    baseline.
  - *grids* (ActionSampler, Supersampler, Oktomat): the frame is split into its known cells, and
    phase correlation of every cell against cell 0 gives the shift as a fraction of cell width (kept
    only when the correlation peak is > 0.05). Also measured: the exposure spread between the
    brightest and darkest cells, the median vignette within each cell, and separator luminance
    relative to the frame mean.
  - *fisheye*: the image-circle radius is found by ray-marching 32 rays out from the centre to the
    outermost pixel brighter than `max(0.06, 0.25·centre)`. Rays that run off the frame edge
    (circle clipped) are ignored.

**Caveats (read before trusting a number).**
- Community "selected" photos are curated toward the dramatic look: X-Pro, LomoChrome, flash,
  multiple exposures. **Colour and saturation differences come mostly from the film**, so the
  camera `sat`/`warmth` values below are deliberately much smaller than the measured ratios. Pair
  the cameras with films we already have (`cross-processed-e6`, `lomography-lomochrome-purple`,
  `lomography-cn-800`, `lomography-redscale-xr`).
- Content bias: the baseline's corners are about 0.14 stops *brighter* than its centre (sky,
  phones' lens correction). Subtracting the baseline profile removes the average scene, but flash
  shots exaggerate the falloff (Colorsplash, LomoApparat). For those cameras the `vignette` is set
  below the fit and the rest is left to `flash`.
- 600 px JPEGs can't show grain, and absolute sharpness is confounded by scan quality. Read the
  sharpness numbers **relative to each other**. All film sets come out −0.8 to −2.2 log2 below the
  phone in centre detail.
- 18 images per camera is a modest sample. Confidence is given per camera.

## Summary table

Abbreviations: Δ = difference from the iPhone baseline. `falloff` in stops at d = 0.7 / corner.
`mid` = log2 mid-field sharpness Δ (negative = edges softer than the phone's). `chroma×` is
measured saturation (film-dominated).

| Camera | n | aspect (median) | falloff 0.7 / corner | fit v / h | mid | centre detail | chroma× | black lift | stand-out |
|---|---|---|---|---|---|---|---|---|---|
| Diana F+ | 12 | 1.01 | −1.38 / −3.65 | 1.64 / 1.5 | −1.42 | −1.47 | 1.61 | −0.018 | round early vignette, rounded mask (54 % black corners) |
| LC-A 120 | 18 | 1.00 | −0.79 / −3.04 | 1.54 / 2.3 | −1.20 | **−0.92** | 1.26 | −0.016 | rounded black corners (46 %), sharpest centre |
| LC-Wide | 18 | 1.49 | **−0.17** / −1.44 | 1.16 / **3.8** | −0.82 | −1.36 | 1.32 | +0.018 | flat centre, corner-only falloff; yellow-green (+0.07 G) |
| Fisheye No.2 | 18 | 1.50 | −0.95 (in circle) | — | — | −1.67 | 1.55 | +0.008 | circle r = **1.08** × half short side (IQR 0.95–1.21, n=14) |
| Sprocket Rocket | 18 | **2.09** | −0.99 / −2.54 | 1.26 / 1.6 | +0.21 | −1.07 | 1.75 | −0.028 | sprockets exposed 16/18; frame ends dark |
| Spinner 360° | 18 | **5.4** (2.7–6.9) | none horizontally | — | +0.51 | −0.82 | 0.98 | −0.029 | full-width sprockets 18/18; slit-scan |
| ActionSampler | 18 | 1.49 | cell: −0.65 | 0.26 (whole) | +0.40 | −1.54 | 0.79 | +0.014 | 2×2; shift 5.5 % (max 6.8 %); expo spread 0.67 stops |
| Supersampler | 18 | 1.49 | strip ends ≥ −2 | 1.62 / 5.0 | −0.33 | −1.31 | 1.11 | +0.019 | 4 strips; shift 14 % (max 25 %) |
| Oktomat | 18 | 1.50 | cell: −0.46 | — | +0.31 | −1.08 | 1.80 | **+0.067** | 4×2; shift ≈12 % (n=2); expo spread 0.99 stops |
| La Sardina | 18 | 1.50 | −0.73 / −1.79 | 1.16 / 2.1 | +0.35 | −1.54 | 1.27 | +0.011 | highest contrast (σ ×1.21) |
| Simple Use | 18 | 1.51 | −0.56 / −1.16 | 0.78 / 1.9 | −1.03 | −1.05 | 0.88 | +0.035 | washed blacks, soft field |
| Belair X 6-12 | 17 | 1.67 (1/1.5/2/2.39) | −0.24 / −0.41 | 0.38 / 1.5 | **−1.49** | −0.96 | 1.06 | +0.021 | sharp centre, softest edges; leaks 3/17 |
| LomoApparat | 16 | 1.49 | −2.12 / −3.75 (flash) | 2.0 / 1.5 | −0.93 | −1.32 | 1.45 | +0.006 | flash-dominated falloff; gels; kaleidoscope |
| Petzval 85 | 18 | 1.50 | −0.52 / −0.93 | 0.64 / 1.5 | −0.55 | −2.19 | 1.56 | +0.012 | swirl visible 5/18 |
| *Diana Mini* | 18 | 1.46 (1.0 / 1.41 / 1.5) | −0.60 / −2.27 | 1.66 / 3.5 | +0.46 | −1.74 | 1.48 | +0.003 | half-frame pairs 10/18 |
| *Colorsplash* | 18 | 1.50 | −1.13 / −2.92 (flash) | — | −0.36 | −1.48 | **2.11** | +0.040 | subject-only colour casts ≈7/18 |

---

## Per-camera write-ups

The params listed below are the full non-zero set in the `cameras.js` schema; anything not listed
stays at its `ZERO` value. `needs` names a capability from the
[capabilities section](#new-renderer-capabilities-ranked).

### 1. Diana F+ (2007): `lomo-diana-f-plus`
- **Sources:** shop <https://shop.lomography.com/ca/diana-f-camera-flash>. Gallery
  <https://www.lomography.com/cameras/3314900-lomography-diana-f-camera-flash/photos>.
- **Specs:** 120 film; plastic 75 mm; f/11, f/16, f/22 and pinhole; 1/60 (N) and B; 12 shots at
  about 52×52 mm or 16 at 42×42 mm (plus an "endless panorama" setting with no mask); multiple
  exposures; Diana+ flash with colour gels. Lomography's own description: "soft-focus and
  beautiful vignetting", "brilliantly blurry edges", "light leaks".
- **Measured (n = 12 native 120 shots):** square (1.00–1.08). The falloff **starts early**: −0.6
  stops at d = 0.35, −1.4 at 0.7, −3.65 in the corners (the corner value includes mask blackness).
  Fit v 1.64 / h 1.5. Mid-field −1.42 and centre detail −1.47, so it is soft everywhere and softer
  out. Chroma 1.61×, blacks slightly crushed, warm (+0.05 R−B) and greenish (+0.03). 54 % of the
  frames have near-black corners from the rounded mask. 2 of 12 are multiple exposures, and 1 has
  a strong flare arc.
- **Look:** dreamy and glowing, a round "spotlight" vignette that is unlike the LC-A's tunnel,
  low resolution, and a rounded soft-edged mask.
- **Params:** vignette 1.45, hardness 2.0, offset [0.04, −0.03], wobble 0.25, vigSat 0.35,
  sharpness −0.45, clarity −0.25, cornerSoft 0.85, sweetSpot 0.18, blurShape 0.2, distortion 0.03,
  ca 0.5, contrast 0.08, sat 0.12, veil 0.01, warmth 0.04, tint −0.02, bloom 0.55, flare 0.7,
  flash 0.75, leak 0.3 (`holga` bias). Format 6x6, formatScale 1.8, frame `diana`.
  - How it differs from our Holga: less radial smear (blurShape 0.2 vs 0.6), more global softness
    and glow, a lower hardness so the vignette starts sooner, and a smooth rounded mask instead of
    a filed one.
- **Needs:** `frame-rounded-mask`, `gel-flash` (Diana+ flash gels), and `multi-exposure`
  (optional).
- **Confidence:** medium-high.

### 2. LC-A 120 (2014): `lomo-lc-a-120`
- **Sources:** gallery <https://www.lomography.com/cameras/3352400-lomo-lc-a-120/photos>. Specs
  from Lomography's LC-A 120 material: Minigon XL 38 mm f/4.5 glass, automatic exposure, 4-zone
  focus, 6×6 on 120, multiple exposures.
- **Measured (n = 18):** all square. Falloff −0.79 at d = 0.7, −1.34 at 0.75, −3.04 in the corners
  (rounded black corners in 46 % of frames). Fit v 1.54 / h 2.3. **Best centre detail in the set
  (−0.92)**, with the mid-field at −1.20. Chroma 1.26×, contrast 1.10×, deep blacks, neutral
  colour. One edge leak and 3 multiple exposures in 18.
- **Look:** the LC-A's saturated tunnel on a 21 mm-equivalent square. Crisp middle, soft swirly
  corners, rounded frame corners.
- **Params:** vignette 1.4, hardness 2.3, vigSat 0.6, sharpness 0.15, clarity 0.1,
  cornerSoft 0.6, sweetSpot 0.35, blurShape −0.3, distortion 0.04, ca 0.3, contrast 0.15,
  sat 0.12, tint −0.005, bloom 0.12, flare 0.45, flash 0.6, leak 0.05. 6x6, formatScale 1.8, frame
  `120-rounded`.
- **Needs:** `frame-rounded-mask` (the 120 border with radius ≈ 4 % of the short side) and
  `multi-exposure`.
- **Confidence:** high.

### 3. LC-Wide (2011): `lomo-lc-wide`
- **Sources:** gallery <https://www.lomography.com/cameras/3334141-lomo-lc-wide-35-mm/photos>.
  Lens page <https://www.lomography.com/lenses/818-lomo-lc-wide-minigon1-17mm-1-4-5> (Minigon 1
  17 mm f/4.5). Automatic exposure, full / half (17×24) / square (24×24) frame switch, multiple
  exposures.
- **Measured (n = 18):** 3:2 (four at 1.44, probably scanner crops). **The falloff is flat out to
  d = 0.6** (−0.17 at 0.7), then −1.19 at 0.85 and −1.44 in the corners, giving the highest fitted
  hardness in the set (3.8). Mid-field −0.82 and corners soft. Chroma 1.32×, contrast 1.19×,
  **yellow-green cast +0.07 R−B / +0.07 G** (X-Pro film, about 7 of 18).
- **Look:** an evenly lit ultra-wide with dark, smeared corners and stretched edges.
- **Params:** vignette 1.15, hardness 3.8, vigSat 0.5, sharpness 0.05, clarity 0.05,
  cornerSoft 0.7, sweetSpot 0.4, blurShape 0.4, distortion 0.02, ca 0.4, contrast 0.12, sat 0.15,
  warmth 0.04, tint −0.03, bloom 0.1, flare 0.5, flash 0.6.
- **Needs:** `format-masks` (half / square switch) and `wide-stretch` (optional; see below).
- **Confidence:** high.

### 4. Fisheye No.2 (c. 2007): `lomo-fisheye-no2`
- **Sources:** shop <https://shop.lomography.com/ca/fisheye-no-2-35-mm-camera> (10 mm fisheye,
  f/8, 1/100 and B, built-in flash plus hot shoe, multiple exposures, "170° field of view",
  "circular frames"). Gallery
  <https://www.lomography.com/cameras/3314877-lomography-fisheye-no-2-35-mm-camera/photos>.
- **Measured (n = 18; circle n = 14):** a 3:2 black frame holding a centred image circle of
  **radius 1.08 × half the short side** (IQR 0.95–1.21), so the top and bottom of the circle are
  clipped. Inside the circle, light falls about 1 stop toward the rim (−0.48 at d = 0.45, −0.95 at
  0.65). About 8 of 18 show a **grey internal-reflection ring** just inside the rim, and about 8 of
  18 are lit by the flash. Chroma 1.55×.
- **Look:** a bulging world in a black circle, often flash-lit against black.
- **Params:** vignette 0.6, hardness 2.0, sharpness −0.1, cornerSoft 0.5, sweetSpot 0.3,
  blurShape 0.2, ca 0.5, contrast 0.1, sat 0.12, warmth 0.05, bloom 0.2, flare 0.6, flash 0.9.
  Also `fisheye: {radius: 1.08, fov: 170, virtualHalfFov: 70, rim: 0.35, fill: 'contain'}`.
- **Needs:** `fisheye-circle` and `gel-flash`.
- **Confidence:** high for geometry, medium for tone.

### 5. Sprocket Rocket (2010): `lomo-sprocket-rocket`
- **Sources:** gallery
  <https://www.lomography.com/cameras/3328515-lomography-sprocket-rocket-35-mm-panoramic-camera/photos>.
  Manual <https://downloads.lomography.com/downloads/sprocket-rocket-manual.pdf>. Plastic 30 mm,
  f/10.8 and f/16, 1/100 and B. Frame about 72×33 mm across the full film width, or 72×24 with the
  mask. Free rewind/advance, so frame ends overlap. Commons *Taken with Lomography Sprocket Rocket*
  (50+ files) is available as a supplement.
- **Measured (n = 18):** aspect **2.09** (16 of 18 between 2.0 and 2.22; masked or cropped ones at
  2.74–4.05). 72/35 = 2.06, which confirms the exposure covers the whole 35 mm width. Sprocket
  holes are **black** on almost every scan, and the edge print shows as **light yellow/orange**
  text. Falloff −0.99 at d = 0.7 and −2.54 in the corners (fit v 1.26 / h 1.6). It is darkest at
  the left and right ends of the frame. Chroma 1.75×, slightly cool and green. About 5 of 18 show
  frame ends overlapping the neighbouring frame.
- **Params:** vignette 1.25, hardness 2.0 (fit 1.6, clamped to the schema minimum), vigSat 0.3,
  sharpness −0.2, clarity −0.1, cornerSoft 0.7, sweetSpot 0.3, blurShape 0.3, distortion 0.02,
  ca 0.4, contrast 0.08, sat 0.15, veil 0.01, warmth −0.03, tint −0.03, bloom 0.25, flare 0.55,
  flash 0.6, leak 0.15. Aspect 2.09, frame `sprocket`.
- **Needs:** `sprocket-exposure`, `format-pano`, and `frame-overlap` (optional).
- **Confidence:** high.

### 6. Spinner 360° (2010): `lomo-spinner-360`
- **Sources:** shop <https://shop.lomography.com/ca/spinner-360> (f/8 and f/16, manual cord at
  1/125–1/250, no flash, multiple exposures; "every bit of your 35 mm film is fully exposed",
  "four times longer"). How-to <https://microsites.lomography.com/spinner-360/how-to/> (25 mm
  lens). Gallery
  <https://www.lomography.com/cameras/3325750-lomography-spinner-360/photos>.
- **Measured (n = 18):** aspect **median 5.4, range 2.7–6.9** (the frame length depends on the
  pull). Sprockets are exposed on both edges in 18 of 18. **There is no horizontal falloff**: the
  whole-frame profile even gets brighter outward, as expected from a rotating slit. The
  photographer appears in about 6 of 18. Neutral to cool colour, chroma 0.98×.
- **Params:** vignette 0.35 (vertical only), sharpness 0.05, ca 0.2, contrast 0.08, warmth −0.03,
  tint 0.01, flare 0.4. Aspect `null` (follows a panoramic source), frame `sprocket`.
- **Needs:** `sprocket-exposure`, `pano-input`, `slit-banding`, and `axis-vignette`. A single
  normal phone photo cannot provide 360° of content. The honest route is to enable this camera
  when the source photo's aspect is ≥ 2.5 (iPhone Pano), and otherwise crop to about 4.3:1.
- **Confidence:** medium.

### 7. ActionSampler (1998): `lomo-actionsampler`
- **Sources:** shop <https://shop.lomography.com/ca/actionsampler-clear> (4 × 26 mm, f/8, 1/100,
  "exposure intervals of 0.22 seconds per frame"). Gallery
  <https://www.lomography.com/cameras/3314879-lomography-actionsampler/photos>.
- **Measured (n = 18):** a 2×2 grid on 3:2. Cell-to-cell shift is **5.5 % of the cell width**
  (max 6.8 %, n = 10 confident correlations). Exposure varies by 0.67 stops between cells. The
  vignette within a cell is −0.65 stops at the cell corners. The separators are soft: their luma is
  0.80× the frame mean, so they are grey-dark gaps, not hard black lines. Chroma 0.79× (soft and
  muted), and 7 of 18 are B&W.
- **Params (applied per cell):** vignette 0.45, hardness 2.3, sharpness −0.25, clarity −0.1,
  cornerSoft 0.5, sweetSpot 0.3, ca 0.3, contrast 0.05, sat −0.05, veil 0.02, warmth 0.02,
  bloom 0.15, flare 0.5. formatScale 0.5 (each 12×18 picture is enlarged twice as much).
  - `grid: {cols 2, rows 2, order 'row', dt 0.22, shift 0.055, zoomJitter 0.01, expoJitter 0.3,
    gap 0.012, gapLuma 0.8}`.
- **Needs:** `multi-lens-grid`.
- **Confidence:** high for layout, medium for the shift magnitude.

### 8. Supersampler (1998): `lomo-supersampler`
- **Sources:** gallery <https://www.lomography.com/cameras/3314903-lomography-supersampler/photos>.
  "4 photos in 2 seconds or 4 photos in 0.2 seconds" (B&H / Lomography magazine
  <https://www.lomography.com/magazine/86200-supersampler-review>). Focal length unverified.
- **Measured (n = 18):** four vertical 9×24 strips. The shift between strips is **14 % of a strip
  width** (max 25 %, n = 6). Each strip goes dark hard at **its two ends** (whole-frame corner
  −2.16, fit hardness 5.0). Exposure spread 0.70 stops. Mild colour (1.11×), slightly cool.
- **Params (per strip):** vignette 1.0, hardness 4.0, sharpness −0.2, clarity −0.05,
  cornerSoft 0.4, sweetSpot 0.35, ca 0.3, contrast 0.1, sat 0.05, veil 0.02, warmth −0.03,
  tint −0.02, bloom 0.15, flare 0.45.
  - `grid: {cols 4, rows 1, dt 0.067, shift 0.14, expoJitter 0.25, gap 0.008, gapLuma 0.8,
    cellVignette 'axis-long'}`.
- **Needs:** `multi-lens-grid` and `axis-vignette` (the falloff runs along the strip's long axis).
- **Confidence:** medium.

### 9. Oktomat (1998): `lomo-oktomat`
- **Sources:** gallery <https://www.lomography.com/cameras/3314886-lomography-oktomat/photos>.
  Lomopedia <https://www.lomography.com/magazine/237100-lomopedia-oktomat> ("8 lenses … over
  2.5 seconds").
- **Measured (n = 18):** a 4×2 grid of portrait 9×12 cells. Shift about 12 % of a cell width
  (only 2 confident correlations, because content changes too much between cells). **Exposure
  spread 0.99 stops**, the largest of the grid cameras, and per-cell colour shifts are visible in
  about 10 of 18. Cell vignette −0.46. **Blacks lifted by +0.067** (washed), warm (+0.09 R−B).
- **Params (per cell):** vignette 0.4, hardness 2.2, sharpness −0.2, clarity −0.05,
  cornerSoft 0.4, sweetSpot 0.3, ca 0.25, contrast 0.05, sat 0.1, veil 0.04, warmth 0.06,
  bloom 0.15, flare 0.5.
  - `grid: {cols 4, rows 2, dt 0.33, shift 0.12, zoomJitter 0.015, expoJitter 0.4,
    tintJitter 0.02, gap 0.01, gapLuma 0.8}`.
- **Needs:** `multi-lens-grid`. The same capability with `dt 0`, a 3×3 grid and no shift covers
  the Pop 9.
- **Confidence:** medium.

### 10. La Sardina (2011): `lomo-la-sardina`
- **Sources:** shop <https://shop.lomography.com/ca/la-sardina-camera-flash-diy> (22 mm, f/8,
  1/100 and B, multiple-exposure switch). Gallery
  <https://www.lomography.com/cameras/3334778-lomography-la-sardina/photos>.
- **Measured (n = 18):** 3:2, 7 of 18 in B&W. Falloff −0.73 at d = 0.7 and −1.79 in the corners
  (fit v 1.16 / h 2.1). **Contrast 1.21×, the highest in the set.** Centre detail −1.54. Two
  multiple exposures and about 5 flash night shots.
- **Params:** vignette 1.1, hardness 2.2, vigSat 0.3, sharpness −0.15, clarity −0.05,
  cornerSoft 0.55, sweetSpot 0.35, blurShape 0.2, distortion 0.03, ca 0.35, contrast 0.18,
  sat 0.1, warmth 0.04, bloom 0.15, flare 0.5, flash 0.85, leak 0.05.
- **Needs:** nothing new (optional: `multi-exposure`, plus `gel-flash` for the Fritz flash).
  **This one can ship today.**
- **Confidence:** high.

### 11. Simple Use (2018): `lomo-simple-use`
- **Sources:** shop
  <https://shop.lomography.com/ca/simple-use-reloadable-film-camera-color-negative> (31 mm, f/9,
  1/120, built-in flash; "Colored gel filters … slip a gel (or two!) in front of the flash").
  Gallery
  <https://www.lomography.com/cameras/3356912-lomography-simple-use-reloadable-film-camera/photos>.
- **Measured (n = 18):** falloff −0.56 at d = 0.7 and −1.16 in the corners (fit v 0.78 / h 1.9).
  Mid-field −1.03 (soft field). **Black lift +0.035.** Chroma 0.88×. A magenta lean from
  LomoChrome reloads.
- **Params:** vignette 0.75, hardness 2.0, wobble 0.1, sharpness −0.3, clarity −0.1,
  cornerSoft 0.75, sweetSpot 0.3, blurShape 0.3, distortion 0.03, ca 0.4, contrast 0.08,
  veil 0.035, warmth 0.01, tint 0.01, bloom 0.2, flare 0.6, flash 1.0, leak 0.05. Close to our
  FunSaver but less warm and less green.
- **Needs:** `gel-flash`.
- **Confidence:** medium-high.

### 12. Belair X 6-12 (2012): `lomo-belair-6-12`
- **Sources:** gallery
  <https://www.lomography.com/cameras/3348698-lomography-belair-x-6-12/photos>. Interchangeable
  58 mm and 90 mm f/8 lenses; automatic exposure; 6×12, 6×9 and 6×6 masks; bellows.
- **Measured (n = 17):** a mix of formats: 5 at 2:1, 3 at 2.39 (35 mm back), 2 at 1.5 and 5
  square. The falloff is gentle (−0.24 at d = 0.7, −0.41 in the corners). **Mid-field −1.49, the
  softest edges in the set, while the centre is comparatively crisp (−0.96).** Red/orange edge
  leaks in 3 of 17.
- **Params:** vignette 0.4, hardness 2.0, sharpness 0.05, clarity 0.05, cornerSoft 0.75,
  sweetSpot 0.35, ca 0.1, distortion 0.01, contrast 0.03, sat 0.03, warmth 0.02, bloom 0.1,
  flare 0.3, flash 0.5, leak 0.2 (edge). Format `6x12`, aspect 2.0, formatScale 2.4, frame `120`.
- **Needs:** `format-6x12` (one `FMT` entry) and `format-masks`.
- **Confidence:** medium.

### 13. LomoApparat (2021): `lomo-lomoapparat`
- **Sources:** shop <https://shop.lomography.com/ca/lomoapparat-black-wide-angle-camera> (21 mm,
  f/10, 1/100 and B, built-in flash with a "colored gel filter slider", 0.2 m close-up,
  "Kaleidoscope and Splitzer lens attachments"). Gallery
  <https://www.lomography.com/cameras/3365658-lomoapparat/photos>.
- **Measured (n = 16 after excluding 2 kaleidoscope shots):** falloff −2.12 at d = 0.7 and −3.75
  in the corners. This is **flash-dominated** (about 9 of 18 are flash-lit against black). About
  3 of 18 are gel-tinted and 3 are multiple exposures. Chroma 1.45×. In the kaleidoscope shots
  the central subject is ringed by 3–6 overlapping, displaced copies.
- **Params:** vignette 1.1 (lens only; the fit of 2.0 includes the flash), hardness 2.0,
  vigSat 0.2, sharpness −0.1, cornerSoft 0.6, sweetSpot 0.35, blurShape 0.2, distortion 0.04,
  ca 0.35, contrast 0.1, sat 0.12, warmth 0.03, tint −0.01, bloom 0.15, flare 0.5, flash 1.0,
  leak 0.05.
  - `kaleidoscope: {facets 6, offset 0.28, r0 0.22, feather 0.06, mix 0.55}`.
- **Needs:** `gel-flash`, `kaleidoscope`, and `multi-exposure` (the splitzer).
- **Confidence:** medium.

### 14. New Petzval 85 Art Lens (2014): `lomo-petzval-85`
- **Sources:** gallery
  <https://www.lomography.com/lenses/1-new-petzval-85-art-lens/photos>. Shop family page (Joseph
  Petzval 55):
  <https://shop.lomography.com/ca/joseph-petzval-55-f-1-7-bokeh-control-art-lens> ("swirly
  bokeh", "warm veiling glare and gentle lens flares").
- **Measured (n = 18):** falloff −0.52 at d = 0.7 and −0.93 in the corners (fit v 0.64). Lowest
  centre detail (−2.19), because the frames are dominated by shallow depth of field. The swirl is
  clearly visible in 5 of 18, and several shots are heavily edited.
- **Params:** vignette 0.6, hardness 2.0, sharpness 0.15, clarity 0.05, **cornerSoft 1.0,
  sweetSpot 0.3, blurShape −1.0**, ca 0.15, contrast 0.03, sat 0.05, veil 0.01, warmth 0.03,
  bloom 0.35, flare 0.3. Body `slr`, 35mm.
  - The existing swirl (blurShape −1) is a straight tangential smear. It reads as swirl, but
    without curvature.
- **Needs:** `swirl-arc-blur`, and `depth-gate` (future work: only blur where the background is
  out of focus, for example from an iPhone Portrait depth map).
- **Confidence:** medium.

### Variants (measured, lower priority)
- **Diana Mini (c. 2009): `lomo-diana-mini`.** 24 mm f/8 and f/11, 24×24 square or 17×24
  half-frame. Gallery
  <https://www.lomography.com/cameras/3319493-lomography-diana-mini-flash-half-frame-square-camera/photos>.
  In 10 of 18, two portrait half-frames are scanned side by side with a black divider. Corner
  falloff −2.27 (h 3.5), softest centre after the Petzval (−1.74). **Needs:** `half-frame-pair`
  (two frames from one photo, or a mirrored/offset second crop) and `multi-exposure`.
- **Colorsplash (c. 2007): `lomo-colorsplash`.** Gallery
  <https://www.lomography.com/cameras/3314921-lomography-colorsplash/photos>. This is the
  reference set for `gel-flash`. The subject carries a single strong cast (yellow, green, magenta
  or blue) while the background keeps its ambient colour or goes black, in about 7 of 18. Chroma
  2.11×, flash falloff −2.9 stops in the corners, black lift +0.04.

---

## New renderer capabilities (ranked)

Ranked by impact (how many cameras it unlocks × how recognisable the result is) against effort.
All math is written for `develop(p)` in `renderer.js`, where `p` is the frame pixel, `ctr = uFull/2`,
`hd = |ctr|` and `short = min(uFull)`.

**Strip-export constraint.** Today each output pixel samples the source within
`PAD + lensReach` of its own position. Capabilities 3, 4 and 7 break that, because they remap
far-away source content. They need one shared mechanism, **`remap` strips**: a JS twin of the
GLSL mapping gives `srcBoundsFor(outRect)`. It samples the strip's border (64 points, plus the
centre if inside) through the inverse map, takes the bounding box, and adds the lens reach. The
exporter uploads that source rect for each strip instead of strip ± reach. The grid case is
special: it needs the whole source, but only at cell resolution (below).

| # | capability | cameras | impact | effort | reach |
|---|---|---|---|---|---|
| 1 | `gel-flash` | Simple Use, Colorsplash, LomoApparat, Diana F+, Fisheye, La Sardina | high | **low** | 0 |
| 2 | `sprocket-exposure` (+ `format-pano`) | Sprocket Rocket, Spinner, Diana 35 mm back | high | **low** | 0 |
| 3 | `multi-lens-grid` | ActionSampler, Supersampler, Oktomat, Pop 9 | very high | medium | whole source at cell resolution |
| 4 | `fisheye-circle` | Fisheye No.2 / One, Diana fisheye | high | medium | inverse-map bbox |
| 5 | `frame-rounded-mask` | Diana F+, LC-A 120 | medium | **low** | 0 |
| 6 | `format-6x12`, `format-masks`, `format-pano` | Belair, LC-Wide, Sprocket | medium | trivial | 0 |
| 7 | `kaleidoscope` | LomoApparat | medium (niche) | medium | `offset·short` |
| 8 | `swirl-arc-blur` | Petzval (improves LC-A, mju-II) | medium | low | same as today |
| 9 | `axis-vignette` + `slit-banding` | Spinner, Supersampler strips | low-medium | low | 0 |
| 10 | `multi-exposure` / `half-frame-pair` | nearly all Lomo, Diana Mini, splitzer | high | **high** (second image + UI) | second source |
| 11 | `frame-overlap`, `wide-stretch`, `depth-gate` | Sprocket, LC-Wide, Petzval | low | low–high | — |

### 1. `gel-flash`: colour gel on the built-in flash
Tint only the light the flash adds, not the ambient light. Add a uniform `uGel` (rgb transmission,
or `vec3(1)` for no gel) and split the existing flash block in two:
```glsl
float r2 = d*d;
float sAmb   = -0.3 - 1.7*(1.0 - smoothstep(0.006, 0.16, L));  // background drop (already present)
float sTotal = 0.95*exp(-r2/0.22) - 1.1*r2 + sAmb;              // existing total
float share  = clamp(1.0 - exp2(uFlash*(sAmb - sTotal)), 0.0, 1.0);  // fraction of light from the flash
vec3 gelN = uGel / dot(uGel, LUMA);                              // keep luminance
lin *= exp2(uFlash*sTotal) * mix(vec3(1.0), gelN, share * uGelAmt);
```
- Suggested gel palette (sRGB-linear transmission): red (1, .25, .2), orange (1, .55, .2),
  yellow (1, .85, .2), green (.35, 1, .35), blue (.3, .5, 1), magenta (1, .35, .9). These match
  the casts seen on the Colorsplash sheet.
- UI: a gel picker next to the Flash toggle, shown when `camera.flashGels` is true.
- No reach, and it costs one uniform.

### 2. `sprocket-exposure`: picture across the full film width
The new frame style `sprocket` in `overlays.frameLayout`:
- The frame's short side represents **35 mm of film width** (not 24 mm). The picture fills the
  whole frame: aspect = frame length / 35, which is 2.06 for 72 mm (measured 2.09).
- `draw()` paints only **inside** the picture area:
  - KS perforations (reuse the `135` geometry: 1.98 × 2.79 mm, 4.75 mm pitch, ≈2 mm from each
    edge) as opaque near-black rounded rectangles (measured: black on almost every scan).
  - The edge print (`FILM NAME`, frame numbers, `16A`-style arrows) in the strip between the holes
    and the film edge, with alpha ≈ 0.7 in pale yellow-orange. Edge print is pre-exposed latent
    image, so it should sit *over* the picture.
- Shader: nothing new. The border texture already composites over the picture where it isn't
  opaque, and `filmBorder = true` keeps grain and leaks on it.
- `vignetteHardness` around 2 plus the lens vignette darkens the sprocket rows, as observed.
- **`format-pano`:** add `FMT['35mm-pano'] = { aspect: 2.06, frame: 'sprocket' }`, and have the
  Spinner use `aspect: null` with the same frame. Effort: an overlays change only.

### 3. `multi-lens-grid`: ActionSampler, Supersampler, Oktomat, Pop 9
`camera.grid = {cols, rows, order, dt, shift, zoomJitter, expoJitter, tintJitter, gap, gapLuma}`.
For each output pixel:
```
cell = (W/cols, H/rows);  ij = floor(p / cell);  u = (p - ij*cell) / cell      // u in [0,1]^2
k = (order == 'row') ? ij.y*cols + ij.x : ...                                  // firing order
// every cell is a complete little frame; cover-fit the whole source into the cell aspect:
ca = cell.x/cell.y;  sa = srcW/srcH;
fit = (ca > sa) ? vec2(1, sa/ca) : vec2(ca/sa, 1)        // fraction of the source used, in UV
zeta = 1 + zoomJitter*h(k)                               // h(k) is a seeded hash in [-1, 1]
delta = shift*k*dirMotion + 0.35*shift*vec2(h(k,1), h(k,2))   // motion over dt*k + hand shake/parallax
srcUV = 0.5 + (u - 0.5)*fit/zeta + delta*fit.x
```
- Evaluate the lens section of `develop()` with **cell-local** geometry: `ctr = cell/2` and
  `hd = |cell|/2`. Vignette, cornerSoft and CA are then per lens, which is what the measurements
  show (cell corners −0.46 to −0.65 stops).
  - `cellVignette: 'axis-long'` (Supersampler) uses `vd = |rp.long|` instead of the radius.
- Per-cell exposure: `lin *= exp2(expoJitter * h(k,3))`. Optionally
  `wb *= 1 + tintJitter*(h(k,4), 0, -h(k,4))`.
- Gaps: `e = min(u, 1-u)` in cell px, and `gapMask = 1 - smoothstep(0, gap*short, min(e.x, e.y))`.
  Then `lin = mix(lin, lin*gapLuma*0.25 + 0.02, gapMask)`. This gives soft, dark-grey separators,
  not black (measured separator luma 0.8× the mean, including a feather).
- `dirMotion`: a seeded unit vector per photo. For the Supersampler use the strip axis, so the
  sweep reads as a pan.
- **Reach / strips.** Every cell needs the whole source, but at only `1/max(cols, rows)` of the
  frame's resolution. Upload a **cell-resolution copy of the whole crop** as `uSrcGrid` (≤
  `cell × 1.25` px: for example 2048 px for an 8192 px export with 4 columns). It fits easily
  within `maxTexture`, so strips need no source band at all. Blur and unsharp radii stay in frame
  px, divided by the cell scale.
- Grain should use `formatScale` around 0.45–0.5, because each picture is 1/4–1/8 of a 35 mm
  frame.

### 4. `fisheye-circle`: Fisheye No.2
`camera.fisheye = {radius κ = 1.08, virtualHalfFov Φ = 70°, rim, fill: 'contain'|'cover'}`.
```
R = κ * short/2;  v = p - ctr;  ρ = |v| / R;  α = atan(v.y, v.x)
if (ρ > 1)  ->  picture = film-base black (lin = 0.004, plus a little flare/veil);
               skip the lens stage
// equidistant fisheye -> rectilinear source.
// e(α) = distance from source centre to its edge in direction α (smooth p-norm so diagonals don't kink):
e = ( |cos α / Hx|^8 + |sin α / Hy|^8 )^(-1/8)     // Hx, Hy: source half-extents in px
//   'contain': rim maps onto the source edge
//   'cover':   e = min(Hx, Hy), the source corners are cropped
s = e * tan(ρ*Φ) / tan(Φ)                          // source radius (px)
q = srcCtr + s * (cos α, sin α)                    // feeds the existing CA / blur / vignette path
```
- With Φ = 70° the centre is magnified 1/(Φ/tanΦ) ≈ 2.3× and the rim is compressed. That is the
  bulge the samples show, using only the content the phone captured. Φ is the "fisheye strength"
  knob (50–80°).
- **Rim ring** (seen in about half the frames):
  `lin += rim * 0.06 * smoothstep(0.93, 0.985, ρ) * (1 - smoothstep(0.985, 1.0, ρ))`, a grey
  annulus. Add a slight radial CA boost there (`ca` × (1 + 2·ρ⁴)).
- Run the vignette, flash and other effects on `ρ` instead of the frame `d` (`vd = ρ`), so the
  circle darkens toward its own rim.
- **Reach:** the map is monotone along each ray, so `srcBoundsFor(strip)` = bbox of the mapped
  strip border (+ `srcCtr` if the strip contains `ctr`) + `lensReach`. A strip near the top only
  needs a compressed band near the source's top edge.

### 5. `frame-rounded-mask`: Diana F+ and LC-A 120
New frame styles: `diana` (and `120-rounded`, the same with the 120 rebate and edge print).
- An opaque black mask outside a rounded rectangle inset by `m = 0.02·short`, corner radius
  `rc = 0.07·short` (Diana) or `0.04·short` (LC-A 120).
- The mask edge is feathered by 0.4 % of short, with ±0.3 % low-frequency wobble along the
  perimeter (seeded), as the Diana mask's moulded plastic shows. The measured 46–54 % black-corner
  rate comes from this.
- Paint it in `overlays.frameLayout().draw` like `holga`. No shader change, no reach.

### 6. Formats
- `FMT['6x12'] = { aspect: 2.0, frame: '120' }`, with `formatScale` around 2.4.
- `format-masks`: an optional `camera.masks: [{label, aspect, formatScale}]` shown as a format
  chip. Examples: LC-Wide full/half/square, and Belair 6×12/6×9/6×6.

### 7. `kaleidoscope`: LomoApparat attachment
`k = {facets N = 6, offset ρk = 0.28, r0 = 0.22, feather f = 0.06, mix m = 0.55}`, with radii in
units of `short`.
```
v = p - ctr;  r = |v|/short;  a = atan(v.y, v.x)
w = smoothstep(r0, r0 + f, r)                       // centre stays direct
sector = floor(a / (2π/N) + 0.5);  θk = sector * 2π/N
qk = p - ρk*short * (cos θk, sin θk)                // pull the central subject out into this facet
// blend the two nearest facets across the sector edge to hide the seam:
t = fract(a/(2π/N) + 0.5);  e = smoothstep(0.42, 0.58, t)
facet = mix(src(qk), src(q_{k+1}), e)
col = mix(src(p), mix(src(p), facet, m), w)          // ghosted, overlapping copies as in the samples
```
- Run the lens stage on each of the three taps, or on the blended result to keep it cheap.
- **Reach** = `ρk·short` (≈0.28 short), handled by `lensReach` plus the normal strip padding.

### 8. `swirl-arc-blur`: Petzval
When `blurShape < 0`, replace the straight tangential axis with taps along an **arc centred on
the frame centre**:
```
φmax = (-blurShape) * rad*1.5 / max(|q-ctr|, 1)          // arc half-angle; arc length ≈ 1.5·rad
for i in taps: φ = (t_i - 0.5) * 2φmax;  r_i = 1 + (s_i - 0.5) * rad*0.6/|q-ctr|
               tap = ctr + rot(φ) * (q - ctr) * r_i
weight w_i = 1 + 3 * hmap.r(tap)                         // highlights dominate -> cat's-eye / ring bokeh
```
- Reach is unchanged (arc length ≤ the current `uMaxR`).
- `depth-gate` (future work): multiply `soft` by `1 − depthNear(p)` when the source has a Portrait
  depth map, so only the background swirls.

### 9. `axis-vignette` and `slit-banding`
- Axis vignette: `vd = |rp.y|·k` (Spinner, Supersampler strips) instead of `length(rp)`.
- Slit banding (Spinner): `lin *= exp2(0.12 * (vnoise1(p.x / (0.08*H)) - 0.5) * 2)`, a seeded 1-D
  noise across x: faint vertical bands from the uneven spin.
- No reach for either.

### 10. `multi-exposure` / `half-frame-pair` / splitzer
- Add a second source `uSrc2` (proxy and strips) and combine in **linear** light before the film
  LUT: `lin = w1·lin1 + w2·lin2`, with `w ≈ 0.6` each, as on negative film. The splitzer is the
  same with a half-plane mask `step(dot(p − ctr, n), 0)` feathered by 1 %.
- `half-frame-pair` is the 1-source shortcut: two crops of the same photo side by side, with a
  slight shift between them and a black 1.5 mm divider.
- This is the most "Lomo" capability, but it needs a second photo picker, two strip uploads and
  its own UX. Schedule it separately.

### 11. Small or optional items
- `frame-overlap` (Sprocket Rocket): feather the left and right 6 % of the frame to a darker,
  lower-contrast rebate, to suggest the neighbouring exposure.
- `wide-stretch` (LC-Wide): an edge-only horizontal stretch,
  `q.x = ctr.x + v.x·(1 + 0.08·(|rp.x|⁴))`, which fakes rectilinear 17 mm stretching. Its value is
  low; recommend the iPhone ultra-wide source instead.

## Suggested order of work
1. **Ship with no renderer work:** La Sardina, LC-A 120 (frame `120` until rounded masks exist),
   LC-Wide, Simple Use (without gels), Belair (after the one-line `6x12` format), Petzval
   (existing swirl), and Diana F+ (frame `holga` until `diana` exists).
2. Low-effort, high-impact: `gel-flash`, `sprocket-exposure` + `format-pano` (Sprocket Rocket),
   and `frame-rounded-mask`.
3. Medium effort: `multi-lens-grid` (three cameras plus the Pop 9), then `fisheye-circle`, both on
   top of the shared `remap`-strip mechanism.
4. Later: `kaleidoscope`, `swirl-arc-blur`, Spinner (`pano-input`), and `multi-exposure`.
