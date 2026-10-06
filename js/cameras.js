// Camera / lens presets. Pure data — no DOM. See docs/ARCHITECTURE.md §3.
//
// Top-level fields (besides id/name/brand/year/lens/body/summary/traits):
//   format       '35mm' | 'half-frame' | '6x6' | '6x7'  (prose + format badge)
//   formatScale  grain size divides by this (bigger negative = finer apparent grain)
//   aspect       frame aspect, long/short (3:2 = 1.5, half-frame 4:3, 6x6 = 1, 6x7 = 1.25);
//                null = keep the photo's own aspect. Orientation always follows the photo.
//   frame        border style for "Film border": '135' (sprockets + edge print), 'half'
//                (135 run the other way), '120' (black rebate + edge print), 'holga' (rough mask)
//   notch        true → Hasselblad-style frame notches on the 120 border
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

const ZERO = Object.freeze({
  vignette: 0, vignetteHardness: 2, vignetteOffset: [0, 0], vignetteWobble: 0, vigSat: 0,
  sharpness: 0, clarity: 0, cornerSoft: 0, sweetSpot: 0.35, blurShape: 0, distortion: 0, ca: 0,
  contrast: 0, sat: 0, veil: 0, warmth: 0, tint: 0, bloom: 0, flare: 0,
  flash: 0.6, leak: 0, leakBias: 'edge',
});

const FMT = {
  '35mm': { aspect: 1.5, frame: '135' },
  'half-frame': { aspect: 4 / 3, frame: 'half' },
  '6x6': { aspect: 1, frame: '120' },
  '6x7': { aspect: 1.25, frame: '120' },
};
const cam = (o) => ({ ...FMT[o.format], notch: false, ...o, params: { ...ZERO, ...o.params } });

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
    params: { vignette: 0.45, vignetteHardness: 2.4, sharpness: 0.1, clarity: 0.05, cornerSoft: 0.3, sweetSpot: 0.45, ca: 0.15, distortion: 0.01, contrast: 0.03, sat: 0.04, warmth: 0.045, tint: 0.005, bloom: 0.15, flare: 0.35, flash: 0.5 },
  }),
  cam({
    id: 'leica-m6', name: 'M6', brand: 'Leica', year: 1984, lens: 'Summicron 35mm f/2',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Crisp rangefinder rendering with high micro-contrast.',
    traits: 'The Summicron 35 is famous for its micro-contrast: fine textures snap while tonal transitions stay smooth. Vignetting is noticeable but even, light falls off gracefully rather than in a tunnel. Sharp to the corners, very low flare, a neutral to slightly cool cast.',
    params: { vignette: 0.4, vignetteHardness: 2.2, sharpness: 0.55, clarity: 0.35, cornerSoft: 0.05, sweetSpot: 0.6, ca: 0.04, distortion: 0.005, contrast: 0.09, sat: 0.04, warmth: -0.01, bloom: 0.03, flare: 0.15, flash: 0.5 },
  }),
  cam({
    id: 'contax-g2', name: 'G2', brand: 'Contax', year: 1996, lens: 'Carl Zeiss Biogon 45mm f/2',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Clinically sharp Zeiss glass with punchy contrast.',
    traits: 'The Biogon/Planar 45 is one of the sharpest 35 mm lenses ever made: very high resolution edge to edge, strong T* coated contrast and saturated, slightly cool colour. Light falloff is mild and flare is well suppressed.',
    params: { vignette: 0.3, vignetteHardness: 2.5, sharpness: 0.7, clarity: 0.4, cornerSoft: 0.0, ca: 0.03, contrast: 0.15, sat: 0.12, warmth: -0.025, tint: 0.01, bloom: 0.02, flare: 0.15, flash: 0.6 },
  }),
  cam({
    id: 'nikon-fm2', name: 'FM2', brand: 'Nikon', year: 1982, lens: 'Nikkor 50mm f/1.4 AI-S',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Fast Nikkor — dreamy wide-open glow around highlights.',
    traits: 'Shot wide open the 50/1.4 glows: spherical aberration paints a soft halo around bright areas and lowers local contrast while the centre stays reasonably sharp. Heavier vignetting at f/1.4, softer corners, slightly lower contrast and some flare with backlight.',
    params: { vignette: 0.6, vignetteHardness: 2.2, sharpness: -0.05, clarity: -0.15, cornerSoft: 0.4, sweetSpot: 0.4, ca: 0.18, distortion: 0.01, contrast: -0.06, sat: -0.03, veil: 0.015, warmth: 0.015, bloom: 0.45, flare: 0.4, flash: 0.5 },
  }),
  cam({
    id: 'pentax-k1000', name: 'K1000', brand: 'Pentax', year: 1976, lens: 'SMC Pentax-M 50mm f/2',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Student classic; SMC coating keeps flare low.',
    traits: 'Pentax\'s Super-Multi-Coating keeps flare and ghosting very low and contrast clean. The modest f/2 design is sharp in the centre, slightly soft at the edges, with mild, smooth vignetting and a neutral-warm cast.',
    params: { vignette: 0.35, vignetteHardness: 2.3, sharpness: 0.2, clarity: 0.12, cornerSoft: 0.2, sweetSpot: 0.5, ca: 0.08, contrast: 0.07, sat: 0.02, warmth: 0.01, bloom: 0.05, flare: 0.1, flash: 0.5 },
  }),
  cam({
    id: 'olympus-om1', name: 'OM-1', brand: 'Olympus', year: 1972, lens: 'Zuiko 50mm f/1.8',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Compact SLR with a gentle, slightly soft Zuiko.',
    traits: 'The Zuiko 50/1.8 renders gently: decent centre sharpness, soft-ish corners, medium-low contrast and moderate, round vignetting. A faintly cool "Zuiko" cast, slightly muted colour and some veiling flare against the light give it a soft vintage feel.',
    params: { vignette: 0.45, vignetteHardness: 2.2, sharpness: 0.0, clarity: -0.12, cornerSoft: 0.35, sweetSpot: 0.4, ca: 0.12, contrast: -0.05, sat: -0.05, veil: 0.015, warmth: -0.02, tint: -0.005, bloom: 0.2, flare: 0.35, flash: 0.5 },
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
    params: { vignette: 1.35, vignetteHardness: 2.8, vigSat: 0.7, sharpness: 0.1, clarity: 0.05, cornerSoft: 0.85, sweetSpot: 0.25, blurShape: -0.6, ca: 0.55, distortion: 0.045, contrast: 0.22, sat: 0.22, warmth: 0.03, tint: 0.01, bloom: 0.15, flare: 0.55, flash: 0.7, leak: 0.12, leakBias: 'edge' },
  }),
  cam({
    id: 'holga-120n', name: 'Holga 120N', brand: 'Holga', year: 2005, lens: 'Plastic 60mm f/8',
    body: 'toy', format: '6x6', formatScale: 1.8, frame: 'holga',
    summary: 'Plastic lens toy camera — extreme vignette, glow and blur.',
    traits: 'A single-element plastic meniscus lens behind a crude 6×6 mask: an uneven, off-centre vignette with near-black corners, a small sharp centre that dissolves into radial smear toward the edges, barrel distortion, strong chromatic fringing and a dreamy bloom. Light leaks bleed red-orange in from the side of the frame, and the filed-looking mask leaves rough black edges on the 6×6 negative.',
    params: { vignette: 1.5, vignetteHardness: 2.2, vignetteOffset: [0.09, -0.06], vignetteWobble: 0.45, vigSat: 0.3, sharpness: -0.15, clarity: -0.15, cornerSoft: 1.0, sweetSpot: 0.12, blurShape: 0.6, ca: 0.8, distortion: 0.06, contrast: 0.06, sat: 0.08, veil: 0.03, warmth: 0.05, tint: -0.01, bloom: 0.45, flare: 0.75, flash: 0.6, leak: 0.5, leakBias: 'holga' },
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
    params: { vignette: 0.4, vignetteHardness: 2.3, sharpness: 0.45, clarity: 0.28, cornerSoft: 0.1, sweetSpot: 0.55, ca: 0.05, contrast: 0.08, sat: 0.03, warmth: 0.0, tint: -0.005, bloom: 0.06, flare: 0.2, flash: 0.6 },
  }),
  cam({
    id: 'rollei-35', name: 'Rollei 35', brand: 'Rollei', year: 1966, lens: 'Tessar 40mm f/3.5',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Tiny 1960s classic — sharp Tessar, vintage warmth.',
    traits: 'The collapsible Tessar 40/3.5 is sharp in the centre with traditional Tessar snap, moderate vignetting and a touch of corner softness. Older coatings lend a warm, faintly yellow-green cast, a little veiling glare and some flare against the light.',
    params: { vignette: 0.55, vignetteHardness: 2.4, sharpness: 0.25, clarity: 0.08, cornerSoft: 0.3, sweetSpot: 0.4, ca: 0.1, contrast: 0.05, sat: -0.02, veil: 0.012, warmth: 0.055, tint: -0.015, bloom: 0.1, flare: 0.4, flash: 0.5 },
  }),
];

export const DEFAULT_CAMERA_ID = 'none';

const byId = new Map(CAMERAS.map((c) => [c.id, c]));
export function getCamera(id) {
  return byId.get(id) || CAMERAS[0];
}
