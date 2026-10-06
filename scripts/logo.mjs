// C41 logo mark — concentric rings forming a "C" around "41".
// Pure string builders (no DOM), shared by scripts/make-icons.mjs.
//
// Three rings open on the right step down in weight from the outside in, and each ring's opening is a
// little wider than the one outside it, so the gap fans out like an aperture. Only the outer ring is
// amber (the orange mask of C-41 negative); the rest and the "41" are cream. Everything is drawn
// with strokes, so no font is needed and every renderer agrees.

const CX = 250, CY = 256;
const rad = (d) => (d * Math.PI) / 180;
const pt = (r, a) => [CX + r * Math.cos(rad(a)), CY + r * Math.sin(rad(a))].map((v) => +v.toFixed(2));

/** Open arc from angle a0 to a1 (clockwise, SVG y-down). */
function arc(r, a0, a1) {
  const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${(a1 - a0) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

// [radius, stroke width, half-opening in degrees, amber?]
const RINGS = [
  [206, 30, 36, true],
  [164, 18, 43, false],
  [132, 8, 52, false],
];

/**
 * Logo artwork in a 512×512 box.
 * @param {object} o
 *   bg:      background fill or null (transparent)
 *   rounded: rounded-square background (favicon)
 *   scale:   artwork scale about the centre (maskable safe zone)
 *   ink:     colour of the cream rings and "41"
 *   rings:   how many rings to draw (fewer reads better at tiny sizes)
 */
export function logoArt({ bg = '#0d0b09', rounded = false, scale = 0.88, ink = '#f3e7d3', rings = 3 } = {}) {
  return `
  <defs>
    <linearGradient id="c41-amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f5b04a"/>
      <stop offset="1" stop-color="#dc7424"/>
    </linearGradient>
  </defs>
  ${bg ? `<rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="${bg}"/>` : ''}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)" fill="none" stroke-linecap="butt">
    ${RINGS.slice(0, rings).map(([r, w, half, amber]) =>
      `<path d="${arc(r, half, 360 - half)}" stroke="${amber ? 'url(#c41-amber)' : ink}" stroke-width="${w}"/>`).join('\n    ')}
    <g stroke="${ink}" stroke-width="18" stroke-linejoin="miter" stroke-miterlimit="10">
      <path d="M260 304 V206 L206 270 H284" stroke-linecap="butt"/>
      <path d="M302 222 L326 206 V304" stroke-linecap="butt"/>
    </g>
  </g>`;
}

export const svgDoc = (inner, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${inner}</svg>`;
