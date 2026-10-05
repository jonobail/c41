// Camera / lens presets. Pure data — no DOM. See docs/ARCHITECTURE.md §3.
//
// params (all read by renderer.js):
//   vignette         0..~1.5  corner light falloff (stops = vignette × 1.6 at the corner)
//   vignetteHardness 2..4     exponent on the radial distance (higher = falloff concentrated in corners)
//   sharpness        -1..1    <0 softens, >0 unsharp-mask micro-contrast
//   cornerSoft       0..1     extra softness toward the corners (field curvature)
//   ca               0..1     lateral chromatic aberration
//   contrast         -0.3..0.3 lens contrast / veiling glare (post S-curve)
//   warmth           -0.1..0.1 coating colour cast
//   bloom            0..1     wide-open glow around highlights
//   flare            0..1     flare susceptibility

const ZERO = Object.freeze({
  vignette: 0, vignetteHardness: 2, sharpness: 0, cornerSoft: 0, ca: 0,
  contrast: 0, warmth: 0, bloom: 0, flare: 0,
});

const cam = (o) => ({ ...o, params: { ...ZERO, ...o.params } });

export const CAMERAS = [
  cam({
    id: 'none', name: 'No camera', brand: '', year: 0, lens: '',
    body: 'none', format: '35mm', formatScale: 1,
    summary: 'Film only — no lens character applied.',
    traits: 'A perfectly neutral, optically ideal lens: no vignetting, no softness, no flare and no colour cast. Use this to judge a film stock on its own.',
    params: {},
  }),
  cam({
    id: 'canon-ae1', name: 'AE-1', brand: 'Canon', year: 1976, lens: 'FD 50mm f/1.8',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'The everyman SLR — honest, slightly warm, gentle falloff.',
    traits: 'The FD 50/1.8 is a modest double-Gauss: moderate vignetting wide open that eases into the corners, good centre sharpness with a touch of softness at the edges, medium contrast and a faintly warm single-coated rendering. Flare is controlled but veils a little with the sun in frame.',
    params: { vignette: 0.45, vignetteHardness: 2.4, sharpness: 0.1, cornerSoft: 0.2, ca: 0.15, contrast: 0.03, warmth: 0.03, bloom: 0.1, flare: 0.35 },
  }),
  cam({
    id: 'leica-m6', name: 'M6', brand: 'Leica', year: 1984, lens: 'Summicron 35mm f/2',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Crisp rangefinder rendering with high micro-contrast.',
    traits: 'The Summicron 35 is famous for its micro-contrast: fine textures snap while tonal transitions stay smooth. Vignetting is noticeable but even, light falls off gracefully rather than in a tunnel. Sharp to the corners, very low flare, a neutral to slightly cool cast.',
    params: { vignette: 0.4, vignetteHardness: 2.2, sharpness: 0.55, cornerSoft: 0.05, ca: 0.05, contrast: 0.08, warmth: -0.01, bloom: 0.03, flare: 0.15 },
  }),
  cam({
    id: 'contax-g2', name: 'G2', brand: 'Contax', year: 1996, lens: 'Carl Zeiss Biogon 45mm f/2',
    body: 'rangefinder', format: '35mm', formatScale: 1,
    summary: 'Clinically sharp Zeiss glass with punchy contrast.',
    traits: 'The Biogon/Planar 45 is one of the sharpest 35 mm lenses ever made: very high resolution edge to edge, strong T* coated contrast and saturated, slightly cool colour. Light falloff is mild and flare is well suppressed.',
    params: { vignette: 0.3, vignetteHardness: 2.5, sharpness: 0.7, cornerSoft: 0.0, ca: 0.03, contrast: 0.14, warmth: -0.02, bloom: 0.02, flare: 0.15 },
  }),
  cam({
    id: 'nikon-fm2', name: 'FM2', brand: 'Nikon', year: 1982, lens: 'Nikkor 50mm f/1.4 AI-S',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Fast Nikkor — dreamy wide-open glow around highlights.',
    traits: 'Shot wide open the 50/1.4 glows: spherical aberration paints a soft halo around bright areas while the centre stays reasonably sharp. Heavier vignetting at f/1.4, softer corners, slightly lower contrast and some flare with backlight.',
    params: { vignette: 0.6, vignetteHardness: 2.2, sharpness: -0.1, cornerSoft: 0.3, ca: 0.15, contrast: -0.04, warmth: 0.01, bloom: 0.45, flare: 0.4 },
  }),
  cam({
    id: 'pentax-k1000', name: 'K1000', brand: 'Pentax', year: 1976, lens: 'SMC Pentax-M 50mm f/2',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Student classic; SMC coating keeps flare low.',
    traits: 'Pentax\'s Super-Multi-Coating keeps flare and ghosting very low and contrast clean. The modest f/2 design is sharp in the centre, slightly soft at the edges, with mild, smooth vignetting and a neutral-warm cast.',
    params: { vignette: 0.35, vignetteHardness: 2.3, sharpness: 0.15, cornerSoft: 0.15, ca: 0.08, contrast: 0.05, warmth: 0.02, bloom: 0.05, flare: 0.12 },
  }),
  cam({
    id: 'olympus-om1', name: 'OM-1', brand: 'Olympus', year: 1972, lens: 'Zuiko 50mm f/1.8',
    body: 'slr', format: '35mm', formatScale: 1,
    summary: 'Compact SLR with a gentle, slightly soft Zuiko.',
    traits: 'The Zuiko 50/1.8 renders gently: decent centre sharpness, soft-ish corners, medium-low contrast and moderate, round vignetting. A light warm cast and some veiling flare against the light give it a vintage feel.',
    params: { vignette: 0.45, vignetteHardness: 2.2, sharpness: 0.0, cornerSoft: 0.25, ca: 0.12, contrast: -0.02, warmth: 0.03, bloom: 0.15, flare: 0.35 },
  }),
  cam({
    id: 'olympus-mju2', name: 'mju-II', brand: 'Olympus', year: 1997, lens: '35mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Cult point-and-shoot: punchy centre, soft corners.',
    traits: 'The 4-element 35/2.8 is surprisingly sharp in the middle with punchy contrast and saturated colour, but corners go soft and dark: strong vignetting with a fairly hard edge, noticeable field curvature, a bit of lateral CA and flare when shooting into the sun.',
    params: { vignette: 0.7, vignetteHardness: 2.8, sharpness: 0.3, cornerSoft: 0.5, ca: 0.25, contrast: 0.12, warmth: 0.02, bloom: 0.08, flare: 0.45 },
  }),
  cam({
    id: 'contax-t2', name: 'T2', brand: 'Contax', year: 1990, lens: 'Carl Zeiss Sonnar 38mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Luxury compact — Zeiss Sonnar bite and rich contrast.',
    traits: 'The T* coated Sonnar 38 is crisp with rich, contrasty colour and deep blacks. Vignetting is moderate and smooth, corners hold up well, and flare is low for a compact. A faintly cool, clean rendering.',
    params: { vignette: 0.45, vignetteHardness: 2.5, sharpness: 0.45, cornerSoft: 0.15, ca: 0.08, contrast: 0.12, warmth: -0.01, bloom: 0.05, flare: 0.2 },
  }),
  cam({
    id: 'yashica-t4', name: 'T4', brand: 'Yashica', year: 1990, lens: 'Carl Zeiss Tessar 35mm f/3.5',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Fashion-snapshot favourite with a sharp Tessar.',
    traits: 'The Tessar 35/3.5 is sharp with snappy contrast; at its fixed small aperture vignetting is moderate but visible, corners are a little soft. Colours lean slightly warm and flash-lit snapshots pop. Some flare with strong backlight.',
    params: { vignette: 0.5, vignetteHardness: 2.6, sharpness: 0.35, cornerSoft: 0.25, ca: 0.12, contrast: 0.1, warmth: 0.02, bloom: 0.05, flare: 0.3 },
  }),
  cam({
    id: 'lomo-lca', name: 'LC-A', brand: 'Lomo', year: 1984, lens: 'Minitar 1 32mm f/2.8',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'The lomography icon — tunnel vignette, saturated, soft edges.',
    traits: 'The Minitar 32 throws a heavy "tunnel" vignette with a dark, hard-edged ring, while the centre stays reasonably sharp and the corners smear softly. Strong lateral chromatic aberration, boosted contrast and saturation, and flare that blooms freely into the frame.',
    params: { vignette: 1.2, vignetteHardness: 3.2, sharpness: 0.1, cornerSoft: 0.7, ca: 0.55, contrast: 0.2, warmth: 0.03, bloom: 0.15, flare: 0.55 },
  }),
  cam({
    id: 'holga-120n', name: 'Holga 120N', brand: 'Holga', year: 2005, lens: 'Plastic 60mm f/8',
    body: 'toy', format: '6x6', formatScale: 1.8,
    summary: 'Plastic lens toy camera — extreme vignette, glow and blur.',
    traits: 'A single-element plastic meniscus lens: extreme vignetting with near-black corners, soft overall and very soft at the edges, strong chromatic fringing and a dreamy bloom around highlights. Low lens contrast and frequent flare and veiling glare, all on a 6×6 negative with finer apparent grain.',
    params: { vignette: 1.5, vignetteHardness: 2.6, sharpness: -0.2, cornerSoft: 1.0, ca: 0.8, contrast: -0.05, warmth: 0.05, bloom: 0.6, flare: 0.75 },
  }),
  cam({
    id: 'hasselblad-500cm', name: '500C/M', brand: 'Hasselblad', year: 1970, lens: 'Carl Zeiss Planar 80mm f/2.8',
    body: 'medium', format: '6x6', formatScale: 2.2,
    summary: 'Square medium format — smooth, detailed, almost grainless.',
    traits: 'The Planar 80 on 6×6 delivers enormous detail with smooth, three-dimensional tonality. Light falloff is gentle, sharpness is high without harshness, contrast is moderate and flare well controlled by the T* coating. The big negative makes grain nearly invisible.',
    params: { vignette: 0.3, vignetteHardness: 2.2, sharpness: 0.35, cornerSoft: 0.08, ca: 0.03, contrast: 0.04, warmth: 0.0, bloom: 0.05, flare: 0.18 },
  }),
  cam({
    id: 'mamiya-rz67', name: 'RZ67 Pro II', brand: 'Mamiya', year: 1995, lens: 'Sekor Z 110mm f/2.8',
    body: 'medium', format: '6x7', formatScale: 2.6,
    summary: 'Studio 6×7 — huge negative, creamy and clean.',
    traits: 'The Sekor Z 110/2.8 is a portrait classic: sharp where focused, creamy elsewhere, with very mild vignetting and low CA. Contrast is moderate and colour neutral. The 6×7 negative renders grain extremely fine and tonality smooth.',
    params: { vignette: 0.25, vignetteHardness: 2.2, sharpness: 0.3, cornerSoft: 0.05, ca: 0.02, contrast: 0.03, warmth: 0.01, bloom: 0.08, flare: 0.15 },
  }),
  cam({
    id: 'kodak-funsaver', name: 'FunSaver', brand: 'Kodak', year: 1988, lens: 'Plastic 30mm f/10',
    body: 'toy', format: '35mm', formatScale: 1,
    summary: 'Disposable camera — soft, dark corners, flares easily.',
    traits: 'A single-element plastic lens behind a fixed f/10 aperture: soft overall with mushy corners, obvious vignetting, chromatic fringing and an uncoated lens that flares and veils readily. Slightly warm and low in micro-contrast, the definitive party-snapshot look.',
    params: { vignette: 0.85, vignetteHardness: 2.4, sharpness: -0.35, cornerSoft: 0.6, ca: 0.45, contrast: 0.06, warmth: 0.04, bloom: 0.2, flare: 0.65 },
  }),
  cam({
    id: 'olympus-pen-f', name: 'Pen F', brand: 'Olympus', year: 1963, lens: 'F.Zuiko 38mm f/1.8',
    body: 'slr', format: 'half-frame', formatScale: 0.7,
    summary: 'Half-frame SLR — twice the shots, coarser grain.',
    traits: 'The half-frame 18×24 mm negative enlarges grain noticeably. The F.Zuiko 38/1.8 is pleasantly sharp in the centre, softer at the edges, with moderate vignetting, gentle glow wide open and a warm vintage single-coated cast prone to veiling flare.',
    params: { vignette: 0.5, vignetteHardness: 2.3, sharpness: 0.0, cornerSoft: 0.3, ca: 0.15, contrast: -0.02, warmth: 0.04, bloom: 0.2, flare: 0.4 },
  }),
  cam({
    id: 'konica-hexar-af', name: 'Hexar AF', brand: 'Konica', year: 1993, lens: 'Hexanon 35mm f/2',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Silent rangefinder-style compact with a superb Hexanon.',
    traits: 'The Hexanon 35/2 rivals Leica glass: high sharpness and micro-contrast, a smooth moderate vignette wide open, low distortion and CA. Colour is neutral and contrast crisp but not harsh; flare is low.',
    params: { vignette: 0.4, vignetteHardness: 2.3, sharpness: 0.45, cornerSoft: 0.1, ca: 0.05, contrast: 0.07, warmth: 0.0, bloom: 0.06, flare: 0.2 },
  }),
  cam({
    id: 'rollei-35', name: 'Rollei 35', brand: 'Rollei', year: 1966, lens: 'Tessar 40mm f/3.5',
    body: 'compact', format: '35mm', formatScale: 1,
    summary: 'Tiny 1960s classic — sharp Tessar, vintage warmth.',
    traits: 'The collapsible Tessar 40/3.5 is sharp in the centre with traditional Tessar snap, moderate vignetting and a touch of corner softness. Older coatings lend a warm cast and some veiling flare against the light.',
    params: { vignette: 0.5, vignetteHardness: 2.4, sharpness: 0.25, cornerSoft: 0.25, ca: 0.1, contrast: 0.05, warmth: 0.04, bloom: 0.08, flare: 0.4 },
  }),
];

export const DEFAULT_CAMERA_ID = 'none';

const byId = new Map(CAMERAS.map((c) => [c.id, c]));
export function getCamera(id) {
  return byId.get(id) || CAMERAS[0];
}
