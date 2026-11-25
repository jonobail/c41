// C41 modern optical logo mark — precision camera aperture "C" & coated lens element.
// Pure SVG builders (no DOM), shared by scripts/make-icons.mjs.

const CX = 256, CY = 256;
const rad = (d) => (d * Math.PI) / 180;
const pt = (r, a, cx = CX, cy = CY) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))].map((v) => +v.toFixed(2));

/** Swept open circular arc from angle a0 to a1 (clockwise, SVG y-down). */
function arc(r, a0, a1, cx = CX, cy = CY) {
  const [x0, y0] = pt(r, a0, cx, cy), [x1, y1] = pt(r, a1, cx, cy);
  const large = (a1 - a0) > 180 ? 1 : 0;
  return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/**
 * Modern C41 optical emblem in a 512×512 viewBox.
 * - Bold swept molten-amber C-aperture ring (284° sweep) with rounded optical terminals
 * - Inner precision titanium/silver glass element ring + cyan-teal anti-reflective lens glint
 * - Central luminous optical core & crisp geometric "41" aperture detail on full size
 *
 * @param {object} o
 *   bg:      background fill or null (transparent)
 *   rounded: rounded-square squircle background (favicon / badge)
 *   scale:   artwork scale about the centre (maskable safe zone)
 *   compact: simplified high-legibility version for small sizes (≤ 32 px topbar)
 */
export function logoArt({ bg = '#09090b', rounded = false, scale = 0.88, compact = false } = {}) {
  const uid = compact ? 's' : 'f';
  return `
  <defs>
    <linearGradient id="c41-bg-${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#19191d"/>
      <stop offset="55%" stop-color="#0d0d10"/>
      <stop offset="100%" stop-color="#060608"/>
    </linearGradient>
    <linearGradient id="c41-gold-${uid}" x1="0.1" y1="0.05" x2="0.9" y2="0.95">
      <stop offset="0%" stop-color="#ffd97d"/>
      <stop offset="48%" stop-color="#f5a524"/>
      <stop offset="100%" stop-color="#d95b16"/>
    </linearGradient>
    <linearGradient id="c41-glass-${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.92"/>
      <stop offset="55%" stop-color="#d8d4ce" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#9e9890" stop-opacity="0.45"/>
    </linearGradient>
    <linearGradient id="c41-coat-${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5eead4" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.15"/>
    </linearGradient>
    <radialGradient id="c41-glow-${uid}" cx="0.48" cy="0.46" r="0.52">
      <stop offset="0%" stop-color="#f5a524" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#f5a524" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#f5a524" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${bg ? `<rect width="512" height="512" ${rounded ? 'rx="116"' : ''} fill="url(#c41-bg-${uid})"/>
  <rect x="8" y="8" width="496" height="496" ${rounded ? 'rx="108"' : ''} fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="6"/>` : ''}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    ${!compact ? `<circle cx="256" cy="256" r="224" fill="url(#c41-glow-${uid})"/>` : ''}
    <!-- Precision subtle outer optical barrel track -->
    <circle cx="256" cy="256" r="192" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="${compact ? 14 : 10}"/>
    <!-- Primary luminous C-aperture arc -->
    <path d="${arc(192, 40, 320)}" fill="none" stroke="url(#c41-gold-${uid})" stroke-width="${compact ? 48 : 42}" stroke-linecap="round"/>
    <!-- Inner coated optical lens ring -->
    <path d="${arc(124, 54, 306)}" fill="none" stroke="url(#c41-glass-${uid})" stroke-width="${compact ? 22 : 16}" stroke-linecap="round"/>
    <!-- Anti-reflective cyan lens coating highlight -->
    <path d="${arc(124, 206, 254)}" fill="none" stroke="url(#c41-coat-${uid})" stroke-width="${compact ? 16 : 12}" stroke-linecap="round"/>
    <!-- Precision optical center aperture & right-side shutter alignment dot -->
    <circle cx="256" cy="256" r="${compact ? 40 : 34}" fill="url(#c41-gold-${uid})"/>
    <circle cx="256" cy="256" r="${compact ? 16 : 14}" fill="#09090b"/>
    <circle cx="388" cy="256" r="${compact ? 22 : 18}" fill="#f8f8fa"/>
    ${!compact ? `
    <!-- Fine Leica-style lens calibration ticks -->
    <g stroke="rgba(255,255,255,0.22)" stroke-width="5" stroke-linecap="round">
      <line x1="256" y1="16" x2="256" y2="34"/>
      <line x1="256" y1="478" x2="256" y2="496"/>
      <line x1="16" y1="256" x2="34" y2="256"/>
    </g>` : ''}
  </g>`;
}

export const svgDoc = (inner, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${inner}</svg>`;

/**
 * README banner (560×160): the optical emblem beside a clean geometric "C41" wordmark.
 */
export function bannerSvg() {
  const mark = logoArt({ bg: null, scale: 1 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 160" width="560" height="160" role="img" aria-label="C41">
<defs>
  <linearGradient id="c41-banner-bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#141418"/>
    <stop offset="100%" stop-color="#08080a"/>
  </linearGradient>
</defs>
<rect width="560" height="160" rx="20" fill="url(#c41-banner-bg)"/>
<rect x="1.5" y="1.5" width="557" height="157" rx="18.5" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="1.5"/>
<g transform="translate(84 18) scale(${124 / 512})">${mark}</g>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M318 50 A38 38 0 1 0 318 110" stroke="url(#c41-gold-f)" stroke-width="14"/>
  <path d="M396 116 V44 L350 96 H414" stroke="#f5f5f7" stroke-width="14"/>
  <path d="M438 56 L458 44 V116" stroke="#f5f5f7" stroke-width="14"/>
</g>
</svg>`;
}
