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
// except vignetteHardness, sweetSpot, blurShape, flash and leakBias):
//   vignette         0..~1.5  corner light falloff (stops = vignette × 1.6 at the corner)
//   vignetteHardness 2..4     exponent on the radial distance (higher = falloff concentrated in corners)
//   vignetteOffset   [x, y]   vignette centre offset (fraction of the half-diagonal) — uneven toy lenses
//   vignetteWobble   0..1     angular unevenness of the falloff (plastic lens / crude mask)
//   vigSat           0..1     saturation boost that follows the vignette (LC-A "glowing" colour)
//   sharpness        -1..1    <0 softens the whole frame, >0 unsharp-mask micro-contrast
//   clarity          -0.6..0.6 local contrast at ~0.6 % of the short edge (+ "pop", − haze/glow)
//   cornerSoft       0..1     blur toward the corners (field curvature); reads at phone scale
//   sweetSpot        0..0.9   radius (0 centre … 1 corner) that stays sharp before cornerSoft ramps in
//   blurShape        -1..1    shape of the corner blur: 0 round, +1 radial/zoom smear, −1 swirl
//   distortion       -0.1..0.1 barrel (+) / pincushion (−); frame corners stay fixed
//   ca               0..1     lateral chromatic aberration
//   contrast         -0.3..0.3 lens contrast (post S-curve)
//   sat              -0.3..0.3 saturation shift (camera/lens colour signature)
//   veil             0..0.1   veiling glare — lifts / washes the blacks (uncoated plastic)
//   warmth           -0.1..0.1 coating colour cast (amber +)
//   tint             -0.1..0.1 green (−) / magenta (+) cast
//   bloom            0..1     wide-open glow around highlights
//   flare            0..1     flare susceptibility
//   flash            0..1     how hot / harsh the built-in flash looks when the Flash toggle is on
//   leak             0..1     built-in light-leak strength (always on for leaky bodies)
//   leakBias         'edge' | 'holga'  where built-in leaks come from (overlays.makeLeaks bias)
//   vigAxis          0..1     0 radial vignette … 1 falloff only across the film (not scaled)
//   banding          0..1     rotating-slit exposure banding along the long axis (Spinner)
//   swirl            0..1     corner blur along arcs round the centre (Petzval swirl; not scaled)

const ZERO = Object.freeze({
  vignette: 0, vignetteHardness: 2, vignetteOffset: [0, 0], vignetteWobble: 0, vigSat: 0,
  sharpness: 0, clarity: 0, cornerSoft: 0, sweetSpot: 0.35, blurShape: 0, distortion: 0, ca: 0,
  contrast: 0, sat: 0, veil: 0, warmth: 0, tint: 0, bloom: 0, flare: 0,
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
    id: 'canon-ae1', name: 'AE-1', brand: 'Canon', year: 1976, lens: 'FD 50mm f/1.8',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'The everyman SLR — honest, slightly warm, gentle falloff.',
    traits: 'The FD 50/1.8 is a modest double-Gauss: moderate vignetting wide open that eases into the corners, good centre sharpness with a touch of softness at the edges, medium contrast and the warm, slightly glowing single-coated rendering Canon FD glass is known for. Flare is controlled but veils a little with the sun in frame.',
    params: { vignette: 0.35, vignetteHardness: 3.65, sharpness: 0.1, clarity: 0.05, cornerSoft: 0.3, sweetSpot: 0.45, ca: 0.15, distortion: 0.01, contrast: 0.03, sat: 0.04, warmth: 0.045, tint: 0.005, bloom: 0.15, flare: 0.35, flash: 0.5 },
  }),
  cam({
    id: 'leica-m6', name: 'M6', brand: 'Leica', year: 1984, lens: 'Summicron 35mm f/2',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Crisp rangefinder rendering with high micro-contrast.',
    traits: 'The Summicron 35 is famous for its micro-contrast: fine textures snap while tonal transitions stay smooth. Vignetting is noticeable but even, light falls off gracefully rather than in a tunnel. Sharp to the corners, very low flare, a neutral to slightly cool cast.',
    params: { vignette: 0.45, vignetteHardness: 2, sharpness: 0.55, clarity: 0.35, cornerSoft: 0.05, sweetSpot: 0.6, ca: 0.04, distortion: 0.005, contrast: 0.09, sat: 0.04, warmth: -0.01, bloom: 0.03, flare: 0.15, flash: 0.5 },
  }),
  cam({
    id: 'contax-g2', name: 'G2', brand: 'Contax', year: 1996, lens: 'Carl Zeiss Biogon 45mm f/2',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Clinically sharp Zeiss glass with punchy contrast.',
    traits: 'The Biogon/Planar 45 is one of the sharpest 35 mm lenses ever made: very high resolution edge to edge, strong T* coated contrast and saturated, slightly cool colour. Light falloff is mild and flare is well suppressed.',
    params: { vignette: 0.15, vignetteHardness: 2, sharpness: 0.7, clarity: 0.4, cornerSoft: 0.0, ca: 0.03, contrast: 0.15, sat: 0.12, warmth: -0.025, tint: 0.01, bloom: 0.02, flare: 0.15, flash: 0.6 },
  }),
  cam({
    id: 'nikon-fm2', name: 'FM2', brand: 'Nikon', year: 1982, lens: 'Nikkor 50mm f/1.4 AI-S',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Fast Nikkor — dreamy wide-open glow around highlights.',
    traits: 'Shot wide open the 50/1.4 glows: spherical aberration paints a soft halo around bright areas and lowers local contrast while the centre stays reasonably sharp. Heavier vignetting at f/1.4, softer corners, slightly lower contrast and some flare with backlight.',
    params: { vignette: 0.32, vignetteHardness: 2.2, sharpness: -0.05, clarity: -0.15, cornerSoft: 0.4, sweetSpot: 0.4, ca: 0.18, distortion: 0.01, contrast: -0.06, sat: -0.03, veil: 0.015, warmth: 0.015, bloom: 0.45, flare: 0.4, flash: 0.5 },
  }),
  cam({
    id: 'pentax-k1000', name: 'K1000', brand: 'Pentax', year: 1976, lens: 'SMC Pentax-M 50mm f/2',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Student classic; SMC coating keeps flare low.',
    traits: 'Pentax\'s Super-Multi-Coating keeps flare and ghosting very low and contrast clean. The modest f/2 design is sharp in the centre, slightly soft at the edges, with mild, smooth vignetting and a neutral-warm cast.',
    params: { vignette: 0.23, vignetteHardness: 2.2, sharpness: 0.2, clarity: 0.12, cornerSoft: 0.2, sweetSpot: 0.5, ca: 0.08, contrast: 0.07, sat: 0.02, warmth: 0.01, bloom: 0.05, flare: 0.1, flash: 0.5 },
  }),
  cam({
    id: 'olympus-om1', name: 'OM-1', brand: 'Olympus', year: 1972, lens: 'Zuiko 50mm f/1.8',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Compact SLR with a gentle, slightly soft Zuiko.',
    traits: 'The Zuiko 50/1.8 renders gently: decent centre sharpness, soft-ish corners, medium-low contrast and moderate, round vignetting. A faintly cool "Zuiko" cast, slightly muted colour and some veiling flare against the light give it a soft vintage feel.',
    params: { vignette: 0.23, vignetteHardness: 2, sharpness: 0.0, clarity: -0.12, cornerSoft: 0.35, sweetSpot: 0.4, ca: 0.12, contrast: -0.05, sat: -0.05, veil: 0.015, warmth: -0.02, tint: -0.005, bloom: 0.2, flare: 0.35, flash: 0.5 },
  }),
  cam({
    id: 'olympus-mju2', name: 'mju-II', brand: 'Olympus', year: 1997, lens: '35mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Cult point-and-shoot: punchy centre, soft corners.',
    traits: 'The 4-element 35/2.8 is surprisingly sharp in the middle with punchy contrast and saturated colour, but corners go soft and dark: strong vignetting with a fairly hard edge, noticeable field curvature, a bit of lateral CA and flare when shooting into the sun. Its built-in flash gives the hot-centre snapshot look.',
    params: { vignette: 0.75, vignetteHardness: 2.8, sharpness: 0.3, clarity: 0.15, cornerSoft: 0.65, sweetSpot: 0.3, blurShape: -0.3, ca: 0.3, distortion: 0.02, contrast: 0.14, sat: 0.1, warmth: 0.02, bloom: 0.08, flare: 0.45, flash: 0.85 },
  }),
  cam({
    id: 'contax-t2', name: 'T2', brand: 'Contax', year: 1990, lens: 'Carl Zeiss Sonnar 38mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Luxury compact — Zeiss Sonnar bite and rich contrast.',
    traits: 'The T* coated Sonnar 38 is crisp with rich, contrasty colour and deep blacks. Vignetting is moderate and smooth, corners hold up well, and flare is low for a compact. A faintly cool, clean rendering.',
    params: { vignette: 0.45, vignetteHardness: 2.5, sharpness: 0.45, clarity: 0.3, cornerSoft: 0.15, sweetSpot: 0.5, ca: 0.08, distortion: 0.01, contrast: 0.16, sat: 0.09, warmth: -0.01, bloom: 0.05, flare: 0.2, flash: 0.75 },
  }),
  cam({
    id: 'yashica-t4', name: 'T4', brand: 'Yashica', year: 1990, lens: 'Carl Zeiss Tessar 35mm f/3.5',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Fashion-snapshot favourite with a sharp Tessar.',
    traits: 'The Tessar 35/3.5 is sharp with snappy contrast; at its fixed small aperture vignetting is moderate but visible, corners are a little soft. Colours lean slightly warm, and its punchy built-in flash is the fashion-snapshot look the camera is famous for. Some flare with strong backlight.',
    params: { vignette: 0.55, vignetteHardness: 2.6, sharpness: 0.35, clarity: 0.15, cornerSoft: 0.35, sweetSpot: 0.35, ca: 0.12, distortion: 0.015, contrast: 0.12, sat: 0.07, warmth: 0.03, bloom: 0.05, flare: 0.3, flash: 0.9 },
  }),
  cam({
    id: 'lomo-lca', name: 'LC-A', brand: 'Lomo', year: 1984, lens: 'Minitar 1 32mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'The lomography icon — tunnel vignette, saturated, soft edges.',
    traits: 'The Minitar 32 throws a heavy "tunnel" vignette that also pushes colour saturation toward the edges, while the centre stays reasonably sharp and the corners smear in a slight swirl. Noticeable barrel distortion from the wide 32 mm, strong lateral chromatic aberration, boosted contrast and saturation, flare that blooms freely, and the occasional soft leak from a tired body.',
    params: { vignette: 1.31, vignetteHardness: 2.55, vigSat: 0.7, sharpness: 0.1, clarity: 0.05, cornerSoft: 0.85, sweetSpot: 0.25, blurShape: -0.6, ca: 0.55, distortion: 0.045, contrast: 0.22, sat: 0.22, warmth: 0.03, tint: 0.01, bloom: 0.15, flare: 0.55, flash: 0.7, leak: 0.12, leakBias: 'edge' },
  }),
  cam({
    id: 'holga-120n', name: 'Holga 120N', brand: 'Holga', year: 2005, lens: 'Plastic 60mm f/8',
    body: 'toy', format: '6x6', formatScale: 1.8, frame: 'holga',
    summary: 'Plastic lens toy camera — extreme vignette, glow and blur.',
    traits: 'A single-element plastic meniscus lens behind a crude 6×6 mask: an uneven, off-centre vignette with near-black corners, a small sharp centre that dissolves into radial smear toward the edges, barrel distortion, strong chromatic fringing and a dreamy bloom. Light leaks bleed red-orange in from the side of the frame, and the filed-looking mask leaves rough black edges on the 6×6 negative.',
    params: { vignette: 1.14, vignetteHardness: 2.75, vignetteOffset: [0.09, -0.06], vignetteWobble: 0.45, vigSat: 0.3, sharpness: -0.15, clarity: -0.15, cornerSoft: 1.0, sweetSpot: 0.12, blurShape: 0.6, ca: 0.8, distortion: 0.06, contrast: 0.06, sat: 0.08, veil: 0.03, warmth: 0.05, tint: -0.01, bloom: 0.45, flare: 0.75, flash: 0.6, leak: 0.5, leakBias: 'holga' },
  }),
  cam({
    id: 'hasselblad-500cm', name: '500C/M', brand: 'Hasselblad', year: 1970, lens: 'Carl Zeiss Planar 80mm f/2.8',
    body: 'medium', format: '6x6', formatScale: 2.2, notch: true,
    summary: 'Square medium format — smooth, detailed, almost grainless.',
    traits: 'The Planar 80 on a square 6×6 negative delivers enormous detail with smooth, three-dimensional tonality. Light falloff is gentle, sharpness is high without harshness, contrast is moderate and flare well controlled by the T* coating. The big negative makes grain nearly invisible; full scans show the film-back notches on the frame edge.',
    params: { vignette: 0.3, vignetteHardness: 2.2, sharpness: 0.35, clarity: 0.22, cornerSoft: 0.08, sweetSpot: 0.6, ca: 0.03, contrast: 0.05, sat: 0.03, warmth: 0.0, bloom: 0.05, flare: 0.18, flash: 0.45 },
  }),
  cam({
    id: 'mamiya-rz67', name: 'RZ67 Pro II', brand: 'Mamiya', year: 1995, lens: 'Sekor Z 110mm f/2.8',
    body: 'medium', format: '6x7', formatScale: 2.6,
    summary: 'Studio 6×7 — huge negative, creamy and clean.',
    traits: 'The Sekor Z 110/2.8 is a portrait classic: sharp where focused, creamy elsewhere, with very mild vignetting and low CA. Contrast is moderate and colour neutral. The 6×7 "ideal format" frame (≈5:4) renders grain extremely fine and tonality smooth.',
    params: { vignette: 0.25, vignetteHardness: 2.2, sharpness: 0.25, clarity: 0.12, cornerSoft: 0.05, sweetSpot: 0.6, ca: 0.02, contrast: 0.03, sat: 0.02, warmth: 0.01, bloom: 0.1, flare: 0.15, flash: 0.45 },
  }),
  cam({
    id: 'kodak-funsaver', name: 'FunSaver', brand: 'Kodak', year: 1988, lens: 'Plastic 30mm f/10',
    body: 'toy', format: '35mm', formatScale: 1,
    summary: 'Disposable camera — soft, dark corners, flares easily.',
    traits: 'A single-element plastic lens behind a fixed f/10 aperture: soft overall with mushy corners, obvious vignetting, chromatic fringing and an uncoated lens whose veiling glare washes out the blacks. Warm, slightly green and low in saturation — and with the Flash toggle on, the harsh on-camera flash that blasts the subject and drops the background into darkness: the definitive party-snapshot look.',
    params: { vignette: 0.85, vignetteHardness: 2.4, vignetteWobble: 0.15, sharpness: -0.4, clarity: -0.15, cornerSoft: 0.7, sweetSpot: 0.25, blurShape: 0.3, ca: 0.45, distortion: 0.035, contrast: 0.04, sat: -0.06, veil: 0.045, warmth: 0.06, tint: -0.02, bloom: 0.2, flare: 0.65, flash: 1.0, leak: 0.08, leakBias: 'edge' },
  }),
  cam({
    id: 'olympus-pen-f', name: 'Pen F', brand: 'Olympus', year: 1963, lens: 'F.Zuiko 38mm f/1.8',
    body: 'slr', format: 'half-frame', formatScale: 0.7,
    summary: 'Half-frame SLR — twice the shots, coarser grain.',
    traits: 'The half-frame 18×24 mm negative is a 3:4 frame (two per 35 mm frame) that enlarges grain noticeably. The F.Zuiko 38/1.8 is pleasantly sharp in the centre, softer at the edges, with moderate vignetting, gentle glow wide open and a warm, slightly hazy single-coated cast prone to veiling flare.',
    params: { vignette: 0.5, vignetteHardness: 2.3, sharpness: 0.0, clarity: -0.08, cornerSoft: 0.35, sweetSpot: 0.4, ca: 0.15, contrast: -0.03, sat: -0.03, veil: 0.015, warmth: 0.05, bloom: 0.25, flare: 0.4, flash: 0.5 },
  }),
  cam({
    id: 'konica-hexar-af', name: 'Hexar AF', brand: 'Konica', year: 1993, lens: 'Hexanon 35mm f/2',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Silent rangefinder-style compact with a superb Hexanon.',
    traits: 'The Hexanon 35/2 rivals Leica glass: high sharpness and micro-contrast, a smooth moderate vignette wide open, low distortion and CA. Colour is neutral and contrast crisp but not harsh; flare is low.',
    params: { vignette: 0.52, vignetteHardness: 2, sharpness: 0.45, clarity: 0.28, cornerSoft: 0.1, sweetSpot: 0.55, ca: 0.05, contrast: 0.08, sat: 0.03, warmth: 0.0, tint: -0.005, bloom: 0.06, flare: 0.2, flash: 0.6 },
  }),
  cam({
    id: 'rollei-35', name: 'Rollei 35', brand: 'Rollei', year: 1966, lens: 'Tessar 40mm f/3.5',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Tiny 1960s classic — sharp Tessar, vintage warmth.',
    traits: 'The collapsible Tessar 40/3.5 is sharp in the centre with traditional Tessar snap, moderate vignetting and a touch of corner softness. Older coatings lend a warm, faintly yellow-green cast, a little veiling glare and some flare against the light.',
    params: { vignette: 0.55, vignetteHardness: 2.4, sharpness: 0.25, clarity: 0.08, cornerSoft: 0.3, sweetSpot: 0.4, ca: 0.1, contrast: 0.05, sat: -0.02, veil: 0.012, warmth: 0.055, tint: -0.015, bloom: 0.1, flare: 0.4, flash: 0.5 },
  }),

  // ------------------------------------------------------------------ Lomography
  // Params from calibration/lomo-cameras.json (docs/LOMOGRAPHY_CAMERAS.md), tuned by eye.
  cam({
    id: 'lomo-diana-f-plus', name: 'Diana F+', brand: 'Lomography', year: 2007, lens: 'Plastic 75mm f/11',
    body: 'toy', format: '6x6', formatScale: 1.8, flashGels: true,
    mask: { type: 'rounded', inset: 0.018, radius: 0.085, feather: 0.006, wobble: 0.004 },
    summary: 'The 1960s dream machine — soft, glowing, round spotlight vignette.',
    traits: 'A single plastic meniscus behind a square mask: low overall sharpness that melts further toward the edges, a round vignette that starts early and reaches near-black in the mask\'s soft rounded corners, generous glow and veiling flare, and saturated colour. The moulded mask leaves soft, slightly uneven rounded corners on every frame. The Diana+ flash takes colour gels, and red leaks are part of the deal.',
    params: { vignette: 1.4, vignetteHardness: 2.0, vignetteOffset: [0.04, -0.03], vignetteWobble: 0.25, vigSat: 0.35, sharpness: -0.45, clarity: -0.25, cornerSoft: 0.85, sweetSpot: 0.18, blurShape: 0.2, distortion: 0.03, ca: 0.5, contrast: 0.08, sat: 0.12, veil: 0.01, warmth: 0.04, tint: -0.02, bloom: 0.55, flare: 0.7, flash: 0.75, leak: 0.3, leakBias: 'holga' },
  }),
  cam({
    id: 'lomo-diana-mini', name: 'Diana Mini', brand: 'Lomography', year: 2009, lens: 'Plastic 24mm f/8',
    body: 'toy', format: '35mm', formatScale: 0.7, aspect: 1.48, badge: 'Pair', flashGels: true,
    grid: { cols: 2, rows: 1, fit: 'split', shift: 0.03, motion: 'random', zoomJitter: 0.01, expoJitter: 0.15, gap: 0.006, gapCore: 0.028, gapLuma: 0 },
    masks: [
      { id: 'pair', label: 'Half-frame pair', aspect: 1.48, formatScale: 0.7, format: '35mm', badge: 'Pair' },
      { id: 'square', label: 'Square', aspect: 1, formatScale: 1, format: '35mm', grid: null, badge: '1:1' },
    ],
    summary: 'Diana in 35 mm — half-frame pairs with a black divider, or square.',
    traits: 'The Diana look shrunk onto 35 mm: a soft plastic 24 mm lens with a hard, deep vignette in every frame. In half-frame mode two portrait frames share one 35 mm frame, scanned side by side with a black divider — each with its own vignette and a slightly different exposure. Square mode gives a single 24×24 frame. Warm, glowing and soft in the centre.',
    params: { vignette: 1.2, vignetteHardness: 3.0, vignetteWobble: 0.15, vigSat: 0.3, sharpness: -0.35, clarity: -0.15, cornerSoft: 0.6, sweetSpot: 0.3, blurShape: 0.2, ca: 0.4, distortion: 0.03, contrast: 0.08, sat: 0.12, veil: 0.01, warmth: 0.05, tint: 0.01, bloom: 0.35, flare: 0.6, flash: 0.7, leak: 0.2, leakBias: 'holga' },
  }),
  cam({
    id: 'lomo-lc-a-120', name: 'LC-A 120', brand: 'Lomography', year: 2014, lens: 'Minigon XL 38mm f/4.5',
    body: 'compact', format: '6x6', formatScale: 1.8,
    mask: { type: 'rounded', inset: 0.008, radius: 0.045, feather: 0.004, wobble: 0.0015 },
    summary: 'The LC-A tunnel on a wide square negative with rounded corners.',
    traits: 'The Minigon XL 38 mm is a 21 mm-equivalent wide angle on 6×6: the sharpest centre of the Lomography range, then a saturated LC-A-style tunnel vignette, soft swirly corners and noticeable barrel distortion. Deep blacks, punchy contrast and neutral colour. The 120 frame has small rounded black corners.',
    params: { vignette: 1.35, vignetteHardness: 2.3, vigSat: 0.6, sharpness: 0.15, clarity: 0.1, cornerSoft: 0.6, sweetSpot: 0.35, blurShape: -0.3, distortion: 0.04, ca: 0.3, contrast: 0.15, sat: 0.12, tint: -0.005, bloom: 0.12, flare: 0.45, flash: 0.6, leak: 0.05, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-lc-wide', name: 'LC-Wide', brand: 'Lomography', year: 2011, lens: 'Minigon 1 17mm f/4.5',
    body: 'compact', format: '35mm', formatScale: 1,
    masks: [
      { id: 'full', label: 'Full 24×36', aspect: 1.5, formatScale: 1, frame: '135' },
      { id: 'half', label: 'Half 17×24', aspect: 24 / 17, formatScale: 0.7, frame: 'half', format: 'half-frame' },
      { id: 'square', label: 'Square 24×24', aspect: 1, formatScale: 1, frame: '135', badge: '1:1' },
    ],
    summary: 'Ultra-wide 17 mm — evenly lit, then dark, smeared corners.',
    traits: 'The 17 mm Minigon is evenly lit across most of the frame, then the light drops off hard right in the corners, which also smear and stretch. Saturated, contrasty colour with a faint yellow-green lean. A switch picks full frame, half frame (17×24) or square (24×24).',
    params: { vignette: 1.15, vignetteHardness: 3.8, vigSat: 0.5, sharpness: 0.05, clarity: 0.05, cornerSoft: 0.7, sweetSpot: 0.4, blurShape: 0.4, distortion: 0.02, ca: 0.4, contrast: 0.12, sat: 0.15, warmth: 0.04, tint: -0.03, bloom: 0.1, flare: 0.5, flash: 0.6 },
  }),
  cam({
    id: 'lomo-fisheye-no2', name: 'Fisheye No.2', brand: 'Lomography', year: 2007, lens: '10mm f/8 fisheye, 170°',
    body: 'fisheye', format: '35mm', formatScale: 1, badge: 'Circle', flashGels: true,
    fisheye: { radius: 1.08, virtualHalfFov: 70, rim: 0.35, fill: 'contain' },
    summary: 'A bulging world inside a black circle.',
    traits: 'The 10 mm fisheye throws a circular image onto the 35 mm frame: the circle is slightly larger than the frame height, so its top and bottom are clipped, and everything outside it is black. The centre bulges toward you, straight lines bow, light falls off about a stop toward the rim, and a faint grey ring from internal reflections sits just inside the edge. Often shot with the built-in flash against a dark background.',
    params: { vignette: 0.6, vignetteHardness: 2.0, sharpness: -0.1, cornerSoft: 0.5, sweetSpot: 0.3, blurShape: 0.2, ca: 0.5, contrast: 0.1, sat: 0.12, warmth: 0.05, bloom: 0.2, flare: 0.6, flash: 0.9 },
  }),
  cam({
    id: 'lomo-sprocket-rocket', name: 'Sprocket Rocket', brand: 'Lomography', year: 2010, lens: 'Plastic 30mm f/10.8',
    body: 'pano', format: '35mm-pano', formatScale: 1,
    summary: 'Wide panoramas exposed right across the sprocket holes.',
    traits: 'The Sprocket Rocket exposes a 72 mm-long panorama across the full width of the 35 mm film, so the picture runs over the perforations: black sprocket holes and the film\'s orange edge print sit inside the image. The plastic 30 mm lens vignettes strongly toward the ends of the frame, softens the corners and fringes colour; the frame is slightly cool and green.',
    params: { vignette: 1.4, vignetteHardness: 2.0, vigSat: 0.3, sharpness: -0.2, clarity: -0.1, cornerSoft: 0.7, sweetSpot: 0.3, blurShape: 0.3, distortion: 0.02, ca: 0.4, contrast: 0.08, sat: 0.15, veil: 0.01, warmth: -0.03, tint: -0.03, bloom: 0.25, flare: 0.55, flash: 0.6, leak: 0.15, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-spinner-360', name: 'Spinner 360°', brand: 'Lomography', year: 2010, lens: '25mm f/8 rotating slit',
    body: 'spinner', format: '35mm-pano', formatScale: 1, aspect: null, minAspect: 4.3, badge: '360°',
    summary: 'Pull the cord, spin a full circle — a very long strip across the sprockets.',
    traits: 'A rotating camera that scans the scene through a slit as it spins, exposing the whole width of the 35 mm film — sprocket holes and edge print included — over a frame four times longer than normal. Light falls off only toward the film edges, never toward the ends, and an uneven spin leaves faint vertical bands. Opens a phone panorama at its own length; an ordinary photo is cut into a long 4.3:1 strip.',
    params: { vignette: 0.6, vignetteHardness: 2.4, vigAxis: 1, banding: 0.6, sharpness: 0.05, ca: 0.2, contrast: 0.08, warmth: -0.03, tint: 0.01, flare: 0.4, flash: 0.6 },
  }),
  cam({
    id: 'lomo-actionsampler', name: 'ActionSampler', brand: 'Lomography', year: 1998, lens: '4 × 26mm f/8 plastic',
    body: 'multilens', format: '35mm', formatScale: 0.5, badge: '2×2',
    grid: { cols: 2, rows: 2, fit: 'cover', shift: 0.03, motion: 'random', zoomJitter: 0.01, expoJitter: 0.3, gap: 0.012, gapLuma: 0.8 },
    summary: 'Four lenses, four frames in under a second — a 2×2 sequence.',
    traits: 'Four little plastic lenses fire one after another, 0.22 s apart, onto one 35 mm frame: a 2×2 grid of the same scene, each picture shifted a little, exposed a little differently and vignetted by its own lens, separated by soft dark seams. Each quarter-frame is enlarged a lot, so grain is coarse and the colour soft and muted.',
    params: { vignette: 0.45, vignetteHardness: 2.3, sharpness: -0.25, clarity: -0.1, cornerSoft: 0.5, sweetSpot: 0.3, ca: 0.3, contrast: 0.05, sat: -0.05, veil: 0.02, warmth: 0.02, bloom: 0.15, flare: 0.5, flash: 0.6 },
  }),
  cam({
    id: 'lomo-supersampler', name: 'Supersampler', brand: 'Lomography', year: 1998, lens: '4 plastic lenses in a row',
    body: 'multilens', format: '35mm', formatScale: 0.5, badge: '1×4',
    grid: { cols: 4, rows: 1, fit: 'cover', shift: 0.07, motion: 'long', zoomJitter: 0.01, expoJitter: 0.25, gap: 0.008, gapLuma: 0.8 },
    summary: 'Pull the cord: four tall slices of a moment, swept across the frame.',
    traits: 'Four lenses in a row expose four tall, narrow strips one after another as the pull-cord shutter sweeps across them, so the scene repeats four times with a small pan between strips. Each strip darkens hard toward its two ends, and the exposure wanders a little from strip to strip. Mild, slightly cool colour.',
    params: { vignette: 1.0, vignetteHardness: 4.0, vigAxis: 0.85, sharpness: -0.2, clarity: -0.05, cornerSoft: 0.4, sweetSpot: 0.35, ca: 0.3, contrast: 0.1, sat: 0.05, veil: 0.02, warmth: -0.03, tint: -0.02, bloom: 0.15, flare: 0.45, flash: 0.6 },
  }),
  cam({
    id: 'lomo-oktomat', name: 'Oktomat', brand: 'Lomography', year: 1998, lens: '8 plastic lenses',
    body: 'multilens', format: '35mm', formatScale: 0.5, badge: '4×2',
    grid: { cols: 4, rows: 2, fit: 'cover', shift: 0.035, motion: 'random', zoomJitter: 0.015, expoJitter: 0.4, tintJitter: 0.02, gap: 0.01, gapLuma: 0.8 },
    summary: 'Eight lenses over 2.5 seconds — a 4×2 grid of tiny frames.',
    traits: 'Eight lenses fire in sequence over about 2.5 seconds, filling one 35 mm frame with a 4×2 grid of small portrait pictures. Things move between frames, each lens vignettes on its own, the exposure and colour wander from cell to cell, and the washed-out blacks and warm cast give it a faded, home-made feel.',
    params: { vignette: 0.4, vignetteHardness: 2.2, sharpness: -0.2, clarity: -0.05, cornerSoft: 0.4, sweetSpot: 0.3, ca: 0.25, contrast: 0.05, sat: 0.1, veil: 0.04, warmth: 0.06, bloom: 0.15, flare: 0.5, flash: 0.6 },
  }),
  cam({
    id: 'lomo-la-sardina', name: 'La Sardina', brand: 'Lomography', year: 2011, lens: 'Plastic 22mm f/8',
    body: 'compact', format: '35mm', formatScale: 1, flashGels: true,
    summary: 'Wide-angle plastic tin can — the most contrasty Lomo.',
    traits: 'A 22 mm plastic wide angle in a sardine-tin body: strong falloff toward the corners, soft edges with a little radial smear and fringing, and the highest contrast of the Lomography cameras. The optional Fritz the Blitz flash takes colour gels, and the multiple-exposure switch invites night-time flash experiments.',
    params: { vignette: 1.1, vignetteHardness: 2.2, vigSat: 0.3, sharpness: -0.15, clarity: -0.05, cornerSoft: 0.55, sweetSpot: 0.35, blurShape: 0.2, distortion: 0.03, ca: 0.35, contrast: 0.18, sat: 0.1, warmth: 0.04, bloom: 0.15, flare: 0.5, flash: 0.85, leak: 0.05, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-simple-use', name: 'Simple Use', brand: 'Lomography', year: 2018, lens: 'Plastic 31mm f/9',
    body: 'toy', format: '35mm', formatScale: 1, flashGels: true,
    summary: 'Reloadable disposable with slip-in flash gels.',
    traits: 'A reloadable single-use camera: a soft plastic 31 mm lens with mushy corners, a moderate vignette and washed, lifted blacks from veiling glare. The built-in flash comes with colour gels that tint whatever the flash lights — the subject goes red, yellow or blue while the background keeps its own colour or drops into darkness.',
    params: { vignette: 0.75, vignetteHardness: 2.0, vignetteWobble: 0.1, sharpness: -0.3, clarity: -0.1, cornerSoft: 0.75, sweetSpot: 0.3, blurShape: 0.3, distortion: 0.03, ca: 0.4, contrast: 0.08, veil: 0.035, warmth: 0.01, tint: 0.01, bloom: 0.2, flare: 0.6, flash: 1.0, leak: 0.05, leakBias: 'edge' },
  }),
  cam({
    id: 'lomo-petzval-85', name: 'Petzval 85', brand: 'Lomography', year: 2014, lens: 'New Petzval 85mm f/2.2 Art Lens',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Brass portrait lens — sharp centre, swirling bokeh.',
    traits: 'A remake of Joseph Petzval\'s 1840 portrait design in brass: sharp and glowing in the centre, with strong field curvature that turns the out-of-focus surroundings into a circular swirl around the subject. Gentle vignetting, warm veiling glare and soft flares, mild colour.',
    params: { vignette: 0.6, vignetteHardness: 2.0, sharpness: 0.15, clarity: 0.05, cornerSoft: 1.0, sweetSpot: 0.3, swirl: 1, ca: 0.15, contrast: 0.03, sat: 0.05, veil: 0.01, warmth: 0.03, bloom: 0.35, flare: 0.3, flash: 0.5 },
  }),
  cam({
    id: 'lomo-belair-6-12', name: 'Belair X 6-12', brand: 'Lomography', year: 2012, lens: 'Belairgon 58mm f/8',
    body: 'medium', format: '6x12', formatScale: 2.4,
    masks: [
      { id: '6x12', label: '6×12', aspect: 2, formatScale: 2.4, format: '6x12' },
      { id: '6x9', label: '6×9', aspect: 1.5, formatScale: 2.1, format: '6x9', badge: '6×9' },
      { id: '6x6', label: '6×6', aspect: 1, formatScale: 1.8, format: '6x6' },
    ],
    summary: 'Folding 120 panoramic — crisp centre, very soft edges.',
    traits: 'An auto-exposure bellows camera on 120 film with 6×12, 6×9 and 6×6 masks. The 58 mm lens is comparatively crisp in the middle but has the softest edges in the Lomography range, with only a gentle light falloff and mild, neutral colour. The bellows let in the odd red-orange edge leak.',
    params: { vignette: 0.4, vignetteHardness: 2.0, sharpness: 0.05, clarity: 0.05, cornerSoft: 0.75, sweetSpot: 0.35, ca: 0.1, distortion: 0.01, contrast: 0.03, sat: 0.03, warmth: 0.02, bloom: 0.1, flare: 0.3, flash: 0.5, leak: 0.2, leakBias: 'edge' },
  }),
];

export const DEFAULT_CAMERA_ID = 'none';

const byId = new Map(CAMERAS.map((c) => [c.id, c]));
export function getCamera(id) {
  return byId.get(id) || CAMERAS[0];
}
