// Camera / lens presets. Pure data — no DOM. See docs/ARCHITECTURE.md §3.
//
// Top-level fields (besides id/name/brand/year/lens/body/summary/traits):
//   brand        'Lomography' cameras are grouped separately in the UI (GROUPS below)
//   body         card icon: 'slr' | 'rangefinder' | 'compact' | 'medium' | 'toy' | 'fisheye' |
//                'multilens' | 'pano' | 'spinner' | 'none'
//   format       '35mm' | 'half-frame' | '6x6' | '6x7' | '6x12' | '35mm-pano'  (prose + format badge)
//   badge        optional card badge text overriding the format label (e.g. '2×2')
//   formatScale  grain size divides by this (bigger negative = finer apparent grain)
//   aspect       frame aspect, long/short (3:2 = 1.5, half-frame 4:3, 6x6 = 1, 6x7 = 1.25,
//                6x12 = 2, sprocket pano 2.06); null = keep the photo's own aspect.
//                Orientation always follows the photo.
//   minAspect    with aspect null: crop to at least this long/short (Spinner 360°: a phone
//                panorama keeps its own aspect, an ordinary photo is cut to a 4.3:1 strip)
//   frame        border style for "Film border": '135' (sprockets + edge print), 'half'
//                (135 run the other way), '120' (black rebate + edge print), 'holga' (rough mask),
//                'sprocket' (picture exposed across the full 35 mm width: the perforations and
//                edge print sit ON the picture, always — the border only adds the scanner margin)
//   notch        true → Hasselblad-style frame notches on the 120 border
//   mask         optional in-picture mask, always drawn (it is on the negative):
//                { type: 'rounded', inset, radius, feather, wobble } — fractions of the frame's
//                short edge (Diana F+ / LC-A 120 rounded black corners)
//   flashGels    true → the UI offers colour gels for the flash (RenderParams.gel)
//   masks        optional format masks the user can switch between:
//                [{ id, label, aspect, formatScale?, format?, frame?, grid? }] — first = default.
//                effectiveCamera(camera, maskId) applies one.
//   grid         multi-lens grid (renderer remap mode 1; every cell shows the whole photo):
//                { cols, rows (landscape orientation), fit: 'cover' | 'split', shift (fraction of
//                a cell between CONSECUTIVE lenses — the research's 5.5 / 14 / 12 % are measured
//                against cell 0, i.e. ≈ 2–3.5 steps), motion: 'long' | 'random', zoomJitter,
//                expoJitter (± stops), tintJitter, gap / gapCore (fractions of the short edge),
//                gapLuma }
//   fisheye      circular fisheye (remap mode 2): { radius (× half the short edge),
//                virtualHalfFov (deg, strength), rim (internal-reflection ring), fill: 'contain' }
//
// params (all read by renderer.js; every one is scaled by the "Lens character" amount 0..1.5
// except vignetteHardness, sweetSpot, blurShape, flash, leakBias, veilTint, flareTint, vigAxis, swirl):
//   vignette         0..~1.5    corner light falloff (stops = vignette × 1.6 at the corner)
//   vignetteHardness 1.4..5.0   exponent on the radial distance (lower = early spotlight, higher = corners only)
//   vignetteOffset   [x, y]     vignette centre offset (fraction of the half-diagonal) — uneven toy lenses
//   vignetteWobble   0..1       angular unevenness of the falloff (plastic lens / crude mask)
//   vigSat           -0.5..1    saturation shift following the vignette (+ LC-A saturation boost, − oblique drop)
//   sharpness        -1..1      <0 softens the whole frame, >0 unsharp-mask edge acuity
//   clarity          -0.6..0.6  local contrast at ~0.6 % of the short edge (+ "pop", − haze/glow)
//   microContrast    -0.5..1    optical MTF acutance ("3D pop") + multi-coated clean shadow depth (>0)
//   cornerSoft       0..1       blur toward the corners (field curvature); reads at phone scale
//   sweetSpot        0..0.9     radius (0 centre … 1 corner) that stays sharp before cornerSoft ramps in
//   blurShape        -1..1      shape of the corner blur: 0 round, +1 radial/zoom smear, −1 swirl
//   distortion       -0.15..0.15 2nd-order barrel (+) / pincushion (−); frame corners stay fixed
//   distK2           -0.12..0.12 4th-order radial distortion (opposite sign = wave/moustache; same = corner accel)
//   ca               0..1       lateral chromatic aberration
//   loca             0..1       longitudinal / axial CA (purple-magenta & green-cyan high-contrast fringing)
//   coma             0..1       outer-field highlight-only sagittal coma wings
//   spherical        0..1       wide-open spherical aberration tight highlight halo (distinct from wide bloom)
//   contrast         -0.3..0.3  lens contrast (post S-curve)
//   sat              -0.3..0.3  saturation shift (camera/lens colour signature)
//   veil             0..0.1     veiling glare — lifts / washes the blacks (uncoated / single-coated glass)
//   veilTint         -1..1      spectral tint of veil: −1 cool cyan-green, 0 neutral, +1 warm amber-gold
//   warmth           -0.15..0.15 coating colour cast (amber + / cool −)
//   tint             -0.15..0.15 green (−) / magenta (+) cast
//   bloom            0..1       wide highlight glow
//   flare            0..1       flare susceptibility
//   flareTint        -1..1      coating flare hue: −1 cool blue/violet, −0.5 emerald/T*, 0 warm-amber, +0.5 gold, +1 rose
//   flash            0..1       how hot / harsh the built-in flash looks when the Flash toggle is on (0 = flashless)
//   leak             0..1       built-in light-leak strength (always on for leaky bodies)
//   leakBias         'edge' | 'holga'  where built-in leaks come from (overlays.makeLeaks bias)
//   vigAxis          0..1       0 radial vignette … 1 falloff only across the film (not scaled)
//   banding          0..1       rotating-slit exposure banding along the long axis (Spinner)
//   swirl            0..1       corner blur along arcs round the centre (Petzval highlight-weighted swirl; not scaled)

const ZERO = Object.freeze({
  vignette: 0, vignetteHardness: 2, vignetteOffset: [0, 0], vignetteWobble: 0, vigSat: 0,
  sharpness: 0, clarity: 0, microContrast: 0, cornerSoft: 0, sweetSpot: 0.35, blurShape: 0,
  distortion: 0, distK2: 0, ca: 0, loca: 0, coma: 0, spherical: 0,
  contrast: 0, sat: 0, veil: 0, veilTint: 0, warmth: 0, tint: 0, bloom: 0, flare: 0, flareTint: 0,
  flash: 0.6, leak: 0, leakBias: 'edge', vigAxis: 0, banding: 0, swirl: 0,
});

const FMT = {
  '35mm': { aspect: 1.5, frame: '135' },
  'half-frame': { aspect: 4 / 3, frame: 'half' },
  '6x6': { aspect: 1, frame: '120' },
  '6x7': { aspect: 1.25, frame: '120' },
  '6x12': { aspect: 2, frame: '120' },
  '35mm-pano': { aspect: 2.06, frame: 'sprocket' },   // 72 mm × the full 35 mm film width
};
const cam = (o) => ({ ...FMT[o.format], notch: false, mask: null, flashGels: false, masks: null, grid: null, fisheye: null, minAspect: null, badge: null, ...o, params: { ...ZERO, ...o.params } });

/** UI groups for the camera list. */
export const GROUPS = [
  { id: 'classic', label: 'Classic' },
  { id: 'lomo', label: 'Lomography' },
];
export const cameraGroup = (c) => (c && c.brand === 'Lomography' ? 'lomo' : 'classic');

/**
 * Flash gels (sRGB-linear transmission). The renderer luminance-normalises them and tints only
 * the light the flash adds (Colorsplash / Simple Use / Diana+ flash casts).
 */
export const FLASH_GELS = [
  { id: 'none', label: 'Clear', rgb: null, swatch: '#f4f1ea' },
  { id: 'red', label: 'Red', rgb: [1, 0.25, 0.2], swatch: '#ff4a3a' },
  { id: 'orange', label: 'Orange', rgb: [1, 0.55, 0.2], swatch: '#ff9a3a' },
  { id: 'yellow', label: 'Yellow', rgb: [1, 0.85, 0.2], swatch: '#ffd84a' },
  { id: 'green', label: 'Green', rgb: [0.35, 1, 0.35], swatch: '#5fe36a' },
  { id: 'blue', label: 'Blue', rgb: [0.3, 0.5, 1], swatch: '#5b8cff' },
  { id: 'magenta', label: 'Magenta', rgb: [1, 0.35, 0.9], swatch: '#ff5fe0' },
];
export function getGel(id) {
  return FLASH_GELS.find((g) => g.id === id) || FLASH_GELS[0];
}

/**
 * The camera with one of its format masks applied (camera.masks; unknown id → the first mask).
 * Cameras without masks are returned unchanged.
 */
export function effectiveCamera(camera, maskId) {
  if (!camera || !Array.isArray(camera.masks) || !camera.masks.length) return camera;
  const m = camera.masks.find((x) => x.id === maskId) || camera.masks[0];
  const out = { ...camera, maskId: m.id };
  for (const k of ['aspect', 'formatScale', 'format', 'frame', 'grid', 'mask', 'minAspect', 'badge']) if (k in m) out[k] = m[k];
  return out;
}

export const CAMERAS = [
  cam({
    id: 'none', name: 'No camera', brand: '', year: 0, lens: '',
    body: 'none', format: '35mm', formatScale: 1, aspect: null,
    summary: 'Film only — no lens character applied.',
    traits: 'A perfectly neutral, optically ideal lens: no vignetting, no softness, no flare and no colour cast. Use this to judge a film stock on its own.',
    params: {},
  }),
  cam({
    id: 'canon-ae1', name: 'AE-1', brand: 'Canon', year: 1976, lens: 'FD 50mm f/1.8 S.C.',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: '1970s everyman SLR — golden S.C. warmth, gentle glow, smooth falloff.',
    traits: 'The 6-element FD 50/1.8 kept Canon\'s single-layer Spectra Coating (S.C.): flattering golden-warm skin tones, honest medium contrast, smooth gradual vignetting (~1.2 EV wide open) and softly receding corners with mild coma. Backlight brings a nostalgic warm amber veiling glow and magenta-blue ghosts.',
    params: { vignette: 0.36, vignetteHardness: 2.2, sharpness: 0.12, clarity: 0.04, microContrast: 0.08, cornerSoft: 0.28, sweetSpot: 0.45, ca: 0.14, loca: 0.15, coma: 0.22, spherical: 0.26, distortion: 0.005, contrast: 0.03, sat: 0.05, veil: 0.012, veilTint: 0.65, warmth: 0.055, tint: 0.005, bloom: 0.16, flare: 0.42, flareTint: 0.55, flash: 0.5 },
  }),
  cam({
    id: 'leica-m6', name: 'M6', brand: 'Leica', year: 1984, lens: 'Summicron-M 35mm f/2 (V4)',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Mandler "King of Bokeh" — organic tonal depth, subtle Leica glow, graceful vignette.',
    traits: 'The pre-ASPH 7-element Version IV Summicron-M 35/2 balances crisp micro-contrast with smooth, organic tonal transitions and a delicate wide-open spherical "Leica glow". Natural cinematic radial vignetting (~1.3 EV at f/2), neutral-warm colour, slight field curvature at the edges, trace pincushion and virtually zero CA.',
    params: { vignette: 0.52, vignetteHardness: 2.0, vigSat: -0.06, sharpness: 0.24, clarity: 0.20, microContrast: 0.50, cornerSoft: 0.15, sweetSpot: 0.52, ca: 0.03, loca: 0.10, coma: 0.12, spherical: 0.22, distortion: -0.008, contrast: 0.08, sat: 0.05, veil: 0.005, veilTint: 0.25, warmth: 0.018, tint: 0.003, bloom: 0.08, flare: 0.26, flareTint: -0.25, flash: 0.5 },
  }),
  cam({
    id: 'contax-g2', name: 'G2', brand: 'Contax', year: 1996, lens: 'Carl Zeiss Planar 45mm f/2 T*',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Clinical Zeiss 3D pop — razor edge-to-edge acuity, inky blacks, cool T* richness.',
    traits: 'The 6-element Carl Zeiss Planar 45/2 T* is one of the highest-resolving 35 mm lenses ever tested (Photodo 4.7/5): blistering edge-to-edge sharpness, benchmark micro-contrast ("Zeiss 3D pop"), deep ink-like blacks and punchy, slightly cool saturated colour. Virtually zero distortion, CA or glow, with T* coating suppressing flare into faint violet-emerald ghosts.',
    params: { vignette: 0.24, vignetteHardness: 2.1, sharpness: 0.36, clarity: 0.28, microContrast: 0.85, cornerSoft: 0.0, sweetSpot: 0.75, ca: 0.02, distortion: 0.001, contrast: 0.16, sat: 0.14, warmth: -0.028, tint: 0.012, flare: 0.12, flareTint: -0.55, flash: 0.6 },
  }),
  cam({
    id: 'nikon-fm2', name: 'FM2', brand: 'Nikon', year: 1982, lens: 'Nikkor 50mm f/1.4 AI-S',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Fast f/1.4 Nikkor — luminous wide-open spherical bloom, heavy vignette, purple-green LoCA.',
    traits: 'Shot wide open at f/1.4, the 7-element Nikkor 50/1.4 AI-S shows its famous dreamy side: pronounced spherical aberration paints a luminous halo around highlights while lowering local clarity, paired with heavy fast-prime vignetting (~2 EV), soft coma-tipped corners and visible purple/green longitudinal CA. Neutral-cool Nikon colour and NIC rainbow-blue backlit flare.',
    params: { vignette: 0.62, vignetteHardness: 2.15, vigSat: -0.12, sharpness: -0.04, clarity: -0.14, microContrast: -0.08, cornerSoft: 0.42, sweetSpot: 0.38, ca: 0.16, loca: 0.55, coma: 0.45, spherical: 0.68, distortion: 0.01, contrast: -0.05, sat: -0.04, veil: 0.016, veilTint: -0.25, warmth: -0.008, tint: -0.01, bloom: 0.42, flare: 0.42, flareTint: -0.75, flash: 0.5 },
  }),
  cam({
    id: 'pentax-k1000', name: 'K1000', brand: 'Pentax', year: 1976, lens: 'SMC Pentax-M 50mm f/2',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Cleanest 1970s SLR — warm SMC colour, crisp blacks, class-leading flare control.',
    traits: 'Pentax\'s 7-layer Super-Multi-Coating (SMC) keeps veiling glare near zero and blacks transparent even into strong light, leaving only tight emerald-green ghosts when pushed. The compact 5-element f/2 prime renders rich, warm reds and skin tones with honest centre crispness, mildly soft edges and smooth light falloff.',
    params: { vignette: 0.30, vignetteHardness: 2.1, sharpness: 0.24, clarity: 0.14, microContrast: 0.28, cornerSoft: 0.22, sweetSpot: 0.52, ca: 0.09, loca: 0.12, coma: 0.10, spherical: 0.08, distortion: 0.004, contrast: 0.07, sat: 0.06, warmth: 0.032, tint: -0.006, bloom: 0.04, flare: 0.08, flareTint: -0.45, flash: 0.5 },
  }),
  cam({
    id: 'olympus-om1', name: 'OM-1', brand: 'Olympus', year: 1972, lens: 'F.Zuiko Auto-S 50mm f/1.8',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: '1972 Silver Nose Zuiko — airy cool-neutral tones, gentle single-coated glow.',
    traits: 'The original 1972 6-element single-coated "Silver Nose" F.Zuiko 50/1.8 delivers Olympus\'s transparent, cool-neutral palette with clean blues and restrained saturation. Wide open it adds a gentle spherical glow, soft corners, moderate round vignetting, visible purple-green CA and cool single-coated veiling flare in backlight.',
    params: { vignette: 0.34, vignetteHardness: 2.0, sharpness: 0.04, clarity: -0.12, microContrast: -0.06, cornerSoft: 0.36, sweetSpot: 0.40, ca: 0.22, loca: 0.34, coma: 0.25, spherical: 0.34, distortion: 0.003, contrast: -0.05, sat: -0.05, veil: 0.02, veilTint: -0.55, warmth: -0.032, tint: -0.012, bloom: 0.20, flare: 0.48, flareTint: -0.85, flash: 0.5 },
  }),
  cam({
    id: 'olympus-mju2', name: 'mju-II', brand: 'Olympus', year: 1997, lens: '35mm f/2.8 Aspherical',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Aspheric pocket powerhouse — razor-sharp punch, moody f/2.8 vignette, nightlife flash.',
    traits: 'Its multi-coated 4-element aspherical 35/2.8 is far cleaner edge-to-edge than typical compacts: biting centre acuity, well-controlled geometry and CA, and vivid commercial contrast. Because auto-exposure favours f/2.8, corners darken moodily (~1.2 EV), and its close-axis auto-flash delivers the iconic hot-foreground nightlife snapshot look.',
    params: { vignette: 0.62, vignetteHardness: 2.35, vigSat: 0.08, sharpness: 0.30, clarity: 0.16, microContrast: 0.36, cornerSoft: 0.20, sweetSpot: 0.55, ca: 0.12, loca: 0.08, coma: 0.08, spherical: 0.02, distortion: 0.012, contrast: 0.15, sat: 0.12, warmth: 0.015, tint: 0.004, bloom: 0.04, flare: 0.24, flareTint: -0.30, flash: 0.90 },
  }),
  cam({
    id: 'contax-t2', name: 'T2', brand: 'Contax', year: 1990, lens: 'Carl Zeiss Sonnar 38mm f/2.8 T*',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Luxury Zeiss compact — deep 3D Sonnar pop, lush blacks, organic corner falloff.',
    traits: 'The 5-element Carl Zeiss Sonnar 38/2.8 T* delivers signature Zeiss micro-contrast, deep blacks and rich, flattering colour with clean whites. Smooth organic Sonnar vignetting (~1.2 EV wide open) and gentle wide-open corner field curvature frame a tack-sharp centre, while T* coating holds contrast into backlight with subtle violet-magenta ghosts.',
    params: { vignette: 0.54, vignetteHardness: 2.15, sharpness: 0.28, clarity: 0.24, microContrast: 0.70, cornerSoft: 0.18, sweetSpot: 0.52, blurShape: -0.15, ca: 0.06, loca: 0.04, spherical: 0.06, distortion: 0.01, contrast: 0.17, sat: 0.13, warmth: 0.012, tint: 0.004, bloom: 0.04, flare: 0.16, flareTint: -0.50, flash: 0.72 },
  }),
  cam({
    id: 'yashica-t4', name: 'T4', brand: 'Yashica', year: 1990, lens: 'Carl Zeiss Tessar 35mm f/3.5 T*',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Raw fashion-snapshot Tessar — biting acuity, warm snap, harsh close-axis flash.',
    traits: 'The 4-element Carl Zeiss Tessar 35/3.5 T* pairs a programmed leaf shutter (f/3.5–f/15.5) with classic "Eagle Eye" centre snap, punchy high contrast, faintly warm colour and mildly softer extreme corners. T* coating controls flare cleanly, while its brutal close-axis flash defines the stark 1990s fashion-snapshot aesthetic.',
    params: { vignette: 0.48, vignetteHardness: 2.4, sharpness: 0.30, clarity: 0.18, microContrast: 0.46, cornerSoft: 0.26, sweetSpot: 0.44, ca: 0.11, loca: 0.06, spherical: 0.02, distortion: 0.008, contrast: 0.14, sat: 0.08, warmth: 0.032, bloom: 0.03, flare: 0.22, flareTint: -0.40, flash: 0.95 },
  }),
  cam({
    id: 'lomo-lca', name: 'LC-A', brand: 'Lomo', year: 1984, lens: 'Minitar-1 32mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'The lomography icon — deep saturated tunnel, ~4.5% pincushion warp, swirly edges.',
    traits: 'The Soviet 5-element Minitar-1 32/2.8 throws a persistent ~2+ EV "tunnel" vignette that intensifies colour saturation toward the dark edges. A punchy, contrasty central sweet spot melts into swirly, coma-softened corners with heavy lateral CA, surprising ~4.5% pincushion distortion, warm vivid colour, free-blooming flare and occasional body leaks.',
    params: { vignette: 1.32, vignetteHardness: 2.5, vigSat: 0.72, sharpness: 0.16, clarity: 0.08, cornerSoft: 0.85, sweetSpot: 0.24, blurShape: -0.6, ca: 0.62, loca: 0.25, coma: 0.45, spherical: 0.18, distortion: -0.045, distK2: -0.015, contrast: 0.22, sat: 0.22, veil: 0.008, veilTint: 0.40, warmth: 0.035, tint: 0.008, bloom: 0.16, flare: 0.58, flareTint: 0.30, flash: 0.7, leak: 0.12, leakBias: 'edge' },
  }),
  cam({
    id: 'holga-120n', name: 'Holga 120N', brand: 'Holga', year: 2005, lens: 'Plastic 60mm f/8 (~f/13)',
    body: 'toy', format: '6x6', formatScale: 1.8, frame: 'holga',
    summary: 'Uncoated plastic 6×6 toy — extreme off-centre tunnel, Petzval melt, red leaks.',
    traits: 'A single uncoated injection-molded plastic meniscus (~f/13 effective) behind a rough 6×6 baffle mask: extreme off-centre vignetting plunging corners near black, a small glowing centre dissolving into heavy radial field curvature, coma wings and broad purple/green CA, strong barrel distortion, warm milky veiling glare and red-orange edge leaks.',
    params: { vignette: 1.25, vignetteHardness: 2.75, vignetteOffset: [0.09, -0.06], vignetteWobble: 0.48, vigSat: 0.32, sharpness: -0.18, clarity: -0.18, microContrast: -0.25, cornerSoft: 1.0, sweetSpot: 0.12, blurShape: 0.65, ca: 0.85, loca: 0.55, coma: 0.75, spherical: 0.65, distortion: 0.055, distK2: 0.015, contrast: 0.04, sat: 0.08, veil: 0.036, veilTint: 0.65, warmth: 0.05, tint: -0.012, bloom: 0.45, flare: 0.80, flareTint: 0.40, flash: 0.6, leak: 0.5, leakBias: 'holga' },
  }),
  cam({
    id: 'hasselblad-500cm', name: '500C/M', brand: 'Hasselblad', year: 1970, lens: 'Carl Zeiss Planar 80mm f/2.8 T*',
    body: 'medium', format: '6x6', formatScale: 2.2, notch: true,
    summary: 'Square 6×6 Zeiss icon — rich 3D micro-contrast, fine grain, deep graceful falloff.',
    traits: 'The 7-element Carl Zeiss Planar 80/2.8 T* on a huge 56×56 mm negative delivers unmistakable medium-format 3D micro-contrast, deep blacks and subtly warm, rich Zeiss colour with negligible CA or distortion. Gentle f/2.8 corner falloff and a whisper of wide-open creaminess pair with iconic film-gate V-notches.',
    params: { vignette: 0.40, vignetteHardness: 2.15, sharpness: 0.26, clarity: 0.20, microContrast: 0.64, cornerSoft: 0.10, sweetSpot: 0.58, ca: 0.03, loca: 0.04, spherical: 0.10, distortion: 0.003, contrast: 0.08, sat: 0.06, warmth: 0.015, bloom: 0.04, flare: 0.15, flareTint: -0.50, flash: 0.45 },
  }),
  cam({
    id: 'mamiya-rz67', name: 'RZ67 Pro II', brand: 'Mamiya', year: 1995, lens: 'Sekor Z 110mm f/2.8 W',
    body: 'medium', format: '6x7', formatScale: 2.6,
    summary: 'Studio 6×7 titan — ultra-fine grain, neutral skin tones, flat-field smoothness.',
    traits: 'The 6-element Mamiya-Sekor Z 110/2.8 W covers the massive 6×7 "ideal format" negative with flat-field edge-to-edge sharpness, minimal vignetting and virtually zero CA or distortion. Strictly neutral, linear studio colour and creamy tonal roll-off separate it cleanly from Hasselblad\'s punchier Zeiss contrast.',
    params: { vignette: 0.20, vignetteHardness: 2.1, sharpness: 0.24, clarity: 0.10, microContrast: 0.34, cornerSoft: 0.04, sweetSpot: 0.72, ca: 0.02, loca: 0.02, spherical: 0.06, distortion: 0.002, contrast: 0.02, sat: 0.01, veil: 0.004, veilTint: 0.15, warmth: -0.005, bloom: 0.06, flare: 0.20, flareTint: 0.15, flash: 0.45 },
  }),
  cam({
    id: 'kodak-funsaver', name: 'FunSaver', brand: 'Kodak', year: 1988, lens: 'Plastic 30mm f/10',
    body: 'toy', format: '35mm', formatScale: 1,
    summary: 'Disposable party icon — green-veiled blacks, 30 mm barrel warp, harsh 3 m flash.',
    traits: 'An uncoated single-element 30 mm f/10 plastic meniscus paired with a curved 35 mm film gate that keeps mid-frame focus steadier than flat-gate toy cameras, yet still yields soft edges, strong ~4.5% barrel distortion, heavy vignetting, purple/green CA and cool-greenish milky shadow veil. Its harsh coaxial xenon flash blasts foregrounds flat against dark backgrounds.',
    params: { vignette: 0.90, vignetteHardness: 2.35, vignetteWobble: 0.15, sharpness: -0.38, clarity: -0.16, microContrast: -0.22, cornerSoft: 0.65, sweetSpot: 0.28, blurShape: 0.3, ca: 0.50, loca: 0.35, coma: 0.40, spherical: 0.28, distortion: 0.045, distK2: 0.012, contrast: 0.02, sat: -0.08, veil: 0.048, veilTint: -0.75, warmth: 0.055, tint: -0.025, bloom: 0.20, flare: 0.68, flareTint: -0.15, flash: 1.0, leak: 0.08, leakBias: 'edge' },
  }),
  cam({
    id: 'olympus-pen-f', name: 'Pen F', brand: 'Olympus', year: 1963, lens: 'F.Zuiko Auto-S 38mm f/1.8',
    body: 'slr', format: 'half-frame', formatScale: 0.7,
    summary: '1960s half-frame SLR — coarse 3:4 grain, dreamy single-coated warm haze.',
    traits: 'Exposing 18×24 mm half-frames (two per 35 mm frame) noticeably enlarges film grain while keeping native vignetting surprisingly mild. The 1963 single-coated 6-element F.Zuiko 38/1.8 paints a painterly wide-open spherical glow, warm lifted veiling glare in backlight, noticeable LoCA and gentle vintage contrast.',
    params: { vignette: 0.26, vignetteHardness: 2.1, sharpness: 0.08, clarity: -0.10, microContrast: -0.08, cornerSoft: 0.24, sweetSpot: 0.46, ca: 0.14, loca: 0.32, coma: 0.20, spherical: 0.45, distortion: 0.004, contrast: -0.04, sat: -0.03, veil: 0.026, veilTint: 0.55, warmth: 0.055, tint: 0.004, bloom: 0.28, flare: 0.52, flareTint: 0.35, flash: 0.5 },
  }),
  cam({
    id: 'konica-hexar-af', name: 'Hexar AF', brand: 'Konica', year: 1993, lens: 'Hexanon 35mm f/2',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Rangefinder-grade "Summicron killer" — surgical sharpness, neutral faithful colour.',
    traits: 'The 7-element multi-coated Konica Hexanon 35/2 rivals rangefinder glass: surgical edge-to-edge acuity, refined micro-contrast, near-zero ~0.5% distortion and remarkably clean illumination once stopped down. Strictly neutral colour, subtle wide-open axial CA, and an integrated metal hood that keeps flare very low.',
    params: { vignette: 0.38, vignetteHardness: 2.0, sharpness: 0.32, clarity: 0.20, microContrast: 0.58, cornerSoft: 0.08, sweetSpot: 0.62, ca: 0.04, loca: 0.16, spherical: 0.08, distortion: 0.005, contrast: 0.09, sat: 0.05, warmth: 0.0, tint: -0.004, bloom: 0.05, flare: 0.14, flareTint: 0.25, flash: 0.55 },
  }),
  cam({
    id: 'rollei-35', name: 'Rollei 35', brand: 'Rollei', year: 1966, lens: 'Carl Zeiss Tessar 40mm f/3.5',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: '1966 collapsible German Tessar — Eagle-Eye centre snap, vibrant warmth, backlit veil.',
    traits: 'The original 1966 single-coated 4-element German Carl Zeiss Tessar 40/3.5 delivers crisp "Eagle Eye" centre acuity and punchy, vibrant Zeiss colour with almost no distortion or spherical glow at f/3.5. Its tiny collapsible barrel adds noticeable vignetting (~1.2 EV wide open) and single-coated luminous veiling glare when backlit.',
    params: { vignette: 0.52, vignetteHardness: 2.3, sharpness: 0.26, clarity: 0.14, microContrast: 0.40, cornerSoft: 0.24, sweetSpot: 0.46, ca: 0.08, loca: 0.05, spherical: 0.04, distortion: 0.002, contrast: 0.10, sat: 0.07, veil: 0.016, veilTint: 0.70, warmth: 0.05, tint: -0.005, bloom: 0.06, flare: 0.48, flareTint: 0.45, flash: 0.5 },
  }),

  // ------------------------------------------------------------------ Lomography
  // Calibrated from calibration/lomo-cameras.json + real optical specs (docs/LOMOGRAPHY_CAMERAS.md).
  cam({
    id: 'lomo-diana-f-plus', name: 'Diana F+', brand: 'Lomography', year: 2007, lens: 'Plastic 75mm f/11',
    body: 'toy', format: '6x6', formatScale: 1.8, flashGels: true,
    mask: { type: 'rounded', inset: 0.018, radius: 0.085, feather: 0.006, wobble: 0.004 },
    summary: '1960s dream machine — ethereal spherical glow, early spotlight vignette, rounded mask.',
    traits: 'An uncoated single-element 75 mm plastic meniscus behind a moulded 52×52 mm mask: heavy spherical aberration paints a dreamy ethereal glow across the frame, an early-onset spotlight vignette darkens into the soft rounded corners, and milky warm veiling glare, coma, barrel distortion and red leaks complete the lo-fi spell. Diana+ flash takes colour gels.',
    params: { vignette: 1.35, vignetteHardness: 1.6, vignetteOffset: [0.04, -0.03], vignetteWobble: 0.25, vigSat: 0.25, sharpness: -0.45, clarity: -0.32, microContrast: -0.30, cornerSoft: 0.88, sweetSpot: 0.16, blurShape: 0.2, distortion: 0.045, distK2: 0.01, ca: 0.60, loca: 0.42, coma: 0.60, spherical: 0.72, contrast: 0.02, sat: 0.06, veil: 0.030, veilTint: 0.50, warmth: 0.04, tint: -0.01, bloom: 0.62, flare: 0.80, flareTint: 0.35, flash: 0.75, leak: 0.3, leakBias: 'holga' },
  }),
  cam({
    id: 'lomo-diana-mini', name: 'Diana Mini', brand: 'Lomography', year: 2009, lens: 'Plastic 24mm f/8',
    body: 'toy', format: '35mm', formatScale: 0.7, aspect: 1.48, badge: 'Pair', flashGels: true,
    grid: { cols: 2, rows: 1, fit: 'split', shift: 0.03, motion: 'random', zoomJitter: 0.01, expoJitter: 0.15, gap: 0.006, gapCore: 0.028, gapLuma: 0 },
    masks: [
      { id: 'pair', label: 'Half-frame pair', aspect: 1.48, formatScale: 0.7, format: '35mm', badge: 'Pair' },
      { id: 'square', label: 'Square', aspect: 1, formatScale: 1, format: '35mm', grid: null, badge: '1:1' },
    ],
    summary: 'Wide 24 mm plastic Diana on 35 mm — half-frame pairs or square, hard corner falloff.',
    traits: 'A tiny uncoated 24 mm plastic meniscus shrunk onto 35 mm: the softest centre in the Diana line, pronounced wide-angle barrel warp, warm milky spherical glow and a steep hard-edged vignette where the tiny image circle barely covers the frame. Half-frame mode pairs two portrait shots beside a black divider; square mode shoots 24×24.',
    params: { vignette: 1.25, vignetteHardness: 3.4, vignetteOffset: [-0.03, 0.02], vignetteWobble: 0.22, vigSat: 0.25, sharpness: -0.50, clarity: -0.22, microContrast: -0.25, cornerSoft: 0.75, sweetSpot: 0.22, blurShape: 0.2, ca: 0.55, loca: 0.35, coma: 0.48, spherical: 0.45, distortion: 0.06, distK2: 0.015, contrast: 0.02, sat: 0.06, veil: 0.026, veilTint: 0.45, warmth: 0.045, tint: 0.005, bloom: 0.40, flare: 0.68, flareTint: 0.25, flash: 0.7, leak: 0.28, leakBias: 'holga' },
  }),
  cam({
    id: 'lomo-lc-a-120', name: 'LC-A 120', brand: 'Lomography', year: 2014, lens: 'Minigon XL 38mm f/4.5',
    body: 'compact', format: '6x6', formatScale: 1.8,
    mask: { type: 'rounded', inset: 0.008, radius: 0.045, feather: 0.004, wobble: 0.0015 },
    summary: 'Multi-coated 21 mm-equiv 6×6 glass — crisp centre, deep saturated tunnel, rounded corners.',
    traits: 'The 5-element multi-coated glass Minigon XL 38/4.5 (21 mm equivalent on 6×6) delivers the sharpest, cleanest centre in the Lomography range with deep blacks and well-controlled distortion, before dropping steeply into soft, gently swirling corners and a saturated LC-A tunnel vignette inside small rounded 120 corners.',
    params: { vignette: 1.35, vignetteHardness: 2.3, vigSat: 0.62, sharpness: 0.28, clarity: 0.18, microContrast: 0.34, cornerSoft: 0.72, sweetSpot: 0.34, blurShape: -0.38, distortion: 0.025, distK2: -0.01, ca: 0.28, loca: 0.10, coma: 0.25, spherical: 0.06, contrast: 0.16, sat: 0.14, warmth: 0.005, tint: -0.005, bloom: 0.08, flare: 0.35, flareTint: -0.35, flash: 0.6, leak: 0.05, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-lc-wide', name: 'LC-Wide', brand: 'Lomography', year: 2011, lens: 'Minigon 1 17mm f/4.5',
    body: 'compact', format: '35mm', formatScale: 1,
    masks: [
      { id: 'full', label: 'Full 24×36', aspect: 1.5, formatScale: 1, frame: '135' },
      { id: 'half', label: 'Half 17×24', aspect: 24 / 17, formatScale: 0.7, frame: 'half', format: 'half-frame' },
      { id: 'square', label: 'Square 24×24', aspect: 1, formatScale: 1, frame: '135', badge: '1:1' },
    ],
    summary: 'Ultra-wide 17 mm multi-coated glass — punchy flat field, steep dark stretched corners.',
    traits: 'The 5-element multi-coated glass Minigon 1 17/4.5 (103° FoV) stays crisp, punchy and evenly illuminated across most of the frame, then plunges steeply into dark, radially stretched corners with mild wave distortion and rich colour saturation. Switches between full frame, half frame (17×24) and square (24×24).',
    params: { vignette: 1.15, vignetteHardness: 3.8, vigSat: 0.52, sharpness: 0.22, clarity: 0.15, microContrast: 0.30, cornerSoft: 0.55, sweetSpot: 0.45, blurShape: 0.55, distortion: 0.035, distK2: -0.015, ca: 0.35, loca: 0.10, coma: 0.22, spherical: 0.05, contrast: 0.18, sat: 0.16, warmth: 0.01, tint: -0.008, bloom: 0.07, flare: 0.40, flareTint: -0.30, flash: 0.6 },
  }),
  cam({
    id: 'lomo-fisheye-no2', name: 'Fisheye No.2', brand: 'Lomography', year: 2007, lens: '10mm f/8 fisheye, 170°',
    body: 'fisheye', format: '35mm', formatScale: 1, badge: 'Circle', flashGels: true,
    fisheye: { radius: 1.08, virtualHalfFov: 70, rim: 0.35, fill: 'contain' },
    summary: '170° circular plastic dome — bulging centre, heavy rim fringing, barrel-reflection ring.',
    traits: 'The uncoated 10 mm plastic fisheye throws a 170° circular image clipped top and bottom on 35 mm film. Its exposed dome gathers stray-light haze and flare from all angles, softens even the bulging centre, ramps colour fringing sharply toward the rim and leaves a faint grey barrel-reflection ring just inside the edge. Pairs with a punchy built-in flash.',
    params: { vignette: 0.62, vignetteHardness: 2.0, sharpness: -0.30, clarity: -0.12, microContrast: -0.18, cornerSoft: 0.70, sweetSpot: 0.25, blurShape: 0.2, ca: 0.78, loca: 0.35, coma: 0.35, spherical: 0.28, contrast: 0.08, sat: 0.08, veil: 0.026, veilTint: -0.20, warmth: 0.03, bloom: 0.30, flare: 0.75, flareTint: 0.20, flash: 0.9 },
  }),
  cam({
    id: 'lomo-sprocket-rocket', name: 'Sprocket Rocket', brand: 'Lomography', year: 2010, lens: 'Plastic 30mm f/10.8',
    body: 'pano', format: '35mm-pano', formatScale: 1,
    summary: '72 mm panoramic sprocket exposure — dramatic barrel warp and dark wide ends.',
    traits: 'Exposing a massive 72×35 mm panorama straight across the sprocket holes pushes the uncoated 30 mm f/10.8 plastic lens far past its comfort zone: a fair central zone gives way to heavy panoramic barrel distortion, early-onset falloff toward both ends, radial edge smear, fringing and uncoated veiling glare.',
    params: { vignette: 1.35, vignetteHardness: 1.7, vigSat: 0.28, sharpness: -0.10, clarity: -0.08, microContrast: -0.12, cornerSoft: 0.80, sweetSpot: 0.30, blurShape: 0.45, distortion: 0.065, distK2: 0.018, ca: 0.55, loca: 0.25, coma: 0.42, spherical: 0.20, contrast: 0.04, sat: 0.08, veil: 0.022, veilTint: -0.30, warmth: -0.01, tint: -0.01, bloom: 0.24, flare: 0.65, flareTint: -0.10, flash: 0.6, leak: 0.15, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-spinner-360', name: 'Spinner 360°', brand: 'Lomography', year: 2010, lens: '25mm f/8 rotating slit',
    body: 'spinner', format: '35mm-pano', formatScale: 1, aspect: null, minAspect: 4.3, badge: '360°',
    summary: 'Pull-cord 360° slit scan — sprocket strip with vertical falloff and spin banding.',
    traits: 'A rotating 25 mm f/8 plastic lens scans through a vertical slit as the body spins, exposing across the sprockets over a 4.3:1+ strip. Because every column passes on-axis through the slit, horizontal distortion and lateral CA vanish — leaving only soft plastic micro-contrast, mild haze, top-and-bottom edge falloff and subtle vertical spin-speed banding.',
    params: { vignette: 0.65, vignetteHardness: 2.3, vigAxis: 1, banding: 0.65, sharpness: -0.15, clarity: -0.08, microContrast: -0.10, spherical: 0.14, contrast: 0.04, sat: 0.02, veil: 0.018, veilTint: -0.15, warmth: -0.01, bloom: 0.15, flare: 0.50, flareTint: 0.15, flash: 0, leak: 0.06, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-actionsampler', name: 'ActionSampler', brand: 'Lomography', year: 1998, lens: '4 × 26mm f/8 plastic',
    body: 'multilens', format: '35mm', formatScale: 0.5, badge: '2×2',
    grid: { cols: 2, rows: 2, fit: 'cover', shift: 0.03, motion: 'random', zoomJitter: 0.01, expoJitter: 0.3, gap: 0.012, gapLuma: 0.8 },
    summary: 'Four 26 mm plastic lenses in 2×2 — soft, low-contrast, coarse quarter-frame grain.',
    traits: 'Four uncoated 26 mm f/8 plastic lenses fire 0.22 s apart onto one 35 mm frame: a 2×2 sequence separated by soft dark baffle seams, each cell shifted slightly with its own exposure, mild barrel warp and vignette. Heavy quarter-frame enlargement magnifies grain, while uncoated plastic keeps contrast low, blacks veiled and colour muted.',
    params: { vignette: 0.42, vignetteHardness: 2.3, sharpness: -0.35, clarity: -0.14, microContrast: -0.18, cornerSoft: 0.55, sweetSpot: 0.28, distortion: 0.025, ca: 0.38, loca: 0.22, coma: 0.25, spherical: 0.20, contrast: -0.05, sat: -0.08, veil: 0.028, veilTint: 0.15, warmth: 0.02, bloom: 0.20, flare: 0.55, flareTint: 0.20, flash: 0 },
  }),
  cam({
    id: 'lomo-supersampler', name: 'Supersampler', brand: 'Lomography', year: 1998, lens: '4 × 20mm f/8 plastic',
    body: 'multilens', format: '35mm', formatScale: 0.5, badge: '1×4',
    grid: { cols: 4, rows: 1, fit: 'cover', shift: 0.07, motion: 'long', zoomJitter: 0.01, expoJitter: 0.32, gap: 0.008, gapLuma: 0.8 },
    summary: 'Four wide 20 mm lenses in a 1×4 sweep — steep dark strip ends and panoramic pan.',
    traits: 'Four wide-angle 20 mm f/8 plastic lenses in a row fire sequentially off a pull-cord sweep, slicing one 35 mm frame into four tall panoramic strips. Wide 20 mm coverage produces steep dark caps at the top and bottom of every strip, noticeable barrel distortion, soft strip ends, cool plastic veil and wandering strip-to-strip exposure.',
    params: { vignette: 1.25, vignetteHardness: 4.6, vigAxis: 0.90, sharpness: -0.25, clarity: -0.08, microContrast: -0.12, cornerSoft: 0.55, sweetSpot: 0.32, distortion: 0.04, ca: 0.42, loca: 0.20, coma: 0.30, spherical: 0.16, contrast: 0.08, sat: 0.04, veil: 0.024, veilTint: -0.35, warmth: -0.02, tint: -0.01, bloom: 0.16, flare: 0.50, flareTint: -0.20, flash: 0 },
  }),
  cam({
    id: 'lomo-oktomat', name: 'Oktomat', brand: 'Lomography', year: 1998, lens: '8 × plastic f/8',
    body: 'multilens', format: '35mm', formatScale: 0.38, badge: '4×2',
    grid: { cols: 4, rows: 2, fit: 'cover', shift: 0.035, motion: 'random', zoomJitter: 0.015, expoJitter: 0.48, tintJitter: 0.05, gap: 0.01, gapLuma: 0.8 },
    summary: 'Eight micro-frames in 4×2 — ultra-coarse 1/8-frame grain, washed blacks, wild exposure drift.',
    traits: 'Eight miniature f/8 plastic lenses fire over 2.5 seconds into tiny 9×12 mm cells (1/8 the area of 35 mm), making grain unmistakably coarse. Eight tiny mechanical shutters and chambers produce wild cell-to-cell exposure and colour wander, the lowest contrast and heaviest warm-milky shadow veil in the lineup, plus occasional leaks.',
    params: { vignette: 0.32, vignetteHardness: 2.2, sharpness: -0.30, clarity: -0.12, microContrast: -0.20, cornerSoft: 0.45, sweetSpot: 0.28, distortion: 0.02, ca: 0.30, loca: 0.20, spherical: 0.22, contrast: -0.08, sat: 0.04, veil: 0.058, veilTint: 0.35, warmth: 0.045, bloom: 0.18, flare: 0.55, flareTint: 0.30, flash: 0, leak: 0.12, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-la-sardina', name: 'La Sardina', brand: 'Lomography', year: 2011, lens: 'Plastic 22mm f/8',
    body: 'compact', format: '35mm', formatScale: 1, flashGels: true,
    summary: '89° wide-angle plastic tin can — strong 22 mm barrel warp, deep corners, gel flash.',
    traits: 'An 89° 22 mm plastic wide-angle in a sardine-tin body: strong barrel distortion, deep corner falloff (~1.8 EV), radially smeared and colour-fringed edges, and soft uncoated plastic micro-contrast with mild haze. Pairs with the side-mounted Fritz the Blitz gel flash for punchy wide-angle night shots.',
    params: { vignette: 1.12, vignetteHardness: 2.15, vigSat: 0.25, sharpness: -0.28, clarity: -0.10, microContrast: -0.14, cornerSoft: 0.68, sweetSpot: 0.28, blurShape: 0.35, distortion: 0.06, distK2: 0.015, ca: 0.50, loca: 0.25, coma: 0.45, spherical: 0.22, contrast: 0.10, sat: 0.08, veil: 0.018, veilTint: 0.25, warmth: 0.035, bloom: 0.22, flare: 0.62, flareTint: 0.25, flash: 0.85, leak: 0.05, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-simple-use', name: 'Simple Use', brand: 'Lomography', year: 2018, lens: 'Plastic 31mm f/9',
    body: 'toy', format: '35mm', formatScale: 1, flashGels: true,
    summary: 'Reloadable disposable — washed cool-neutral blacks, mushy corners, slip-in flash gels.',
    traits: 'A reloadable single-use camera with an uncoated 31 mm f/9 plastic meniscus on a flat film gate: a fair central sweet spot collapses rapidly into mushy corners, while uncoated veiling glare lifts shadows into cool-neutral haze with subdued saturation. Slip-in flash gels tint whatever the harsh built-in flash reaches.',
    params: { vignette: 0.75, vignetteHardness: 1.9, vignetteWobble: 0.1, sharpness: -0.22, clarity: -0.12, microContrast: -0.18, cornerSoft: 0.82, sweetSpot: 0.25, blurShape: 0.3, distortion: 0.035, ca: 0.45, loca: 0.30, coma: 0.42, spherical: 0.22, contrast: 0.03, sat: -0.04, veil: 0.038, veilTint: -0.45, warmth: 0.005, bloom: 0.22, flare: 0.68, flareTint: -0.10, flash: 1.0, leak: 0.05, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-petzval-85', name: 'Petzval 85', brand: 'Lomography', year: 2014, lens: 'New Petzval 85mm f/2.2 Art Lens',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Russian brass 1840 portrait optics — popping centre, luminous swirling bokeh, golden flare.',
    traits: 'A Zenit-made 4-element Russian glass remake of Joseph Petzval\'s 1840 brass portrait formula: wide open at f/2.2, a distinctly crisp central sweet spot pops against severe field curvature that twists out-of-focus highlights into glowing curved cat\'s-eye swirl. Strong optical vignetting, painterly spherical bloom and lush golden brass-barrel veiling flare.',
    params: { vignette: 0.90, vignetteHardness: 1.65, sharpness: 0.28, clarity: 0.12, microContrast: 0.36, cornerSoft: 1.0, sweetSpot: 0.24, swirl: 1, ca: 0.18, loca: 0.25, coma: 0.45, spherical: 0.48, distortion: -0.008, contrast: -0.02, sat: 0.08, veil: 0.022, veilTint: 0.85, warmth: 0.045, bloom: 0.45, flare: 0.68, flareTint: 0.65, flash: 0.45 },
  }),
  cam({
    id: 'lomo-belair-6-12', name: 'Belair X 6-12', brand: 'Lomography', year: 2012, lens: 'Plastic 58mm f/8',
    body: 'medium', format: '6x12', formatScale: 2.4,
    masks: [
      { id: '6x12', label: '6×12', aspect: 2, formatScale: 2.4, format: '6x12' },
      { id: '6x9', label: '6×9', aspect: 1.5, formatScale: 2.1, format: '6x9', badge: '6×9' },
      { id: '6x6', label: '6×6', aspect: 1, formatScale: 1.8, format: '6x6' },
    ],
    summary: 'Folding 120 panoramic bellows — decent centre, extreme 6×12 edge collapse, bellows leaks.',
    traits: 'An auto-exposure folding bellows camera on 120 film with 6×12, 6×9 and 6×6 masks. Its stock 2-element 58 mm f/8 plastic wide-angle (21 mm equivalent on 6×12) keeps a decent centre before collapsing dramatically across the massive 104×52 mm panoramic ends with barrel distortion, CA, plastic haze, wide falloff and red-orange bellows leaks.',
    params: { vignette: 0.72, vignetteHardness: 1.7, sharpness: 0.05, clarity: -0.02, microContrast: -0.08, cornerSoft: 0.88, sweetSpot: 0.30, blurShape: 0.25, ca: 0.42, loca: 0.25, coma: 0.50, spherical: 0.22, distortion: 0.045, distK2: 0.01, contrast: 0.03, sat: 0.04, veil: 0.022, veilTint: 0.20, warmth: 0.02, bloom: 0.22, flare: 0.55, flareTint: 0.20, flash: 0.5, leak: 0.25, leakBias: 'edge' },
  }),
];

export const DEFAULT_CAMERA_ID = 'none';

const byId = new Map(CAMERAS.map((c) => [c.id, c]));
export function getCamera(id) {
  return byId.get(id) || CAMERAS[0];
}
