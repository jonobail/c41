// Overlay generators: dust/scratch texture, date-stamp texture, light-leak params.
// See docs/ARCHITECTURE.md §5. `mulberry32` and `makeLeaks` are pure (Node-safe);
// the canvas makers need a DOM (or OffscreenCanvas-like) `document`.

export function mulberry32(seed) {
  let a = (seed >>> 0) || 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------------------------------------------------------------------------
// Dust & scratches
// R = white specks / hairs, G = dark specks, B = scratches (white). Black bg.
// ---------------------------------------------------------------------------
export function makeDustCanvas(aspect, seed, amount) {
  const a = Math.max(0.05, Math.min(20, aspect || 1.5));
  const LONG = 2048;
  const w = a >= 1 ? LONG : Math.round(LONG * a);
  const h = a >= 1 ? Math.round(LONG / a) : LONG;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const amt = Math.max(0, Math.min(1, amount ?? 0.5));
  if (amt <= 0) return c;
  const rnd = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const S = Math.min(c.width, c.height);
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  const chan = (k, alpha) =>
    k === 0 ? `rgba(255,0,0,${alpha})` : k === 1 ? `rgba(0,255,0,${alpha})` : `rgba(0,0,255,${alpha})`;
  const opacity = 0.45 + 0.55 * amt;

  // Specks: mostly tiny, a few bigger clumps. White (R) more common than dark (G).
  const specks = Math.round(30 + 260 * amt);
  for (let i = 0; i < specks; i++) {
    const k = rnd() < 0.62 ? 0 : 1;
    const x = rnd() * c.width, y = rnd() * c.height;
    const big = rnd() < 0.06;
    const r = S * (big ? 0.0018 + rnd() * 0.0035 : 0.0004 + rnd() * rnd() * 0.0016);
    const alpha = opacity * (0.35 + 0.65 * rnd());
    g.fillStyle = chan(k, alpha);
    g.beginPath();
    if (big) {
      // irregular clump: a few overlapping blobs
      const n = 3 + Math.floor(rnd() * 4);
      for (let j = 0; j < n; j++) {
        const ox = (rnd() - 0.5) * r * 1.6, oy = (rnd() - 0.5) * r * 1.6;
        g.moveTo(x + ox + r * 0.6, y + oy);
        g.arc(x + ox, y + oy, r * (0.35 + rnd() * 0.5), 0, Math.PI * 2);
      }
    } else {
      g.ellipse(x, y, r, r * (0.6 + rnd() * 0.4), rnd() * Math.PI, 0, Math.PI * 2);
    }
    g.fill();
  }

  // Fibres / hairs: thin bezier curves.
  const hairs = Math.round(1 + 9 * amt);
  for (let i = 0; i < hairs; i++) {
    const k = rnd() < 0.55 ? 0 : 1;
    const x = rnd() * c.width, y = rnd() * c.height;
    const len = S * (0.02 + rnd() * 0.08);
    const ang = rnd() * Math.PI * 2;
    const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
    const bend = len * 0.6;
    g.strokeStyle = chan(k, opacity * (0.5 + 0.5 * rnd()));
    g.lineWidth = Math.max(1, S * (0.0006 + rnd() * 0.0009));
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(
      x + (rnd() - 0.5) * bend * 2, y + (rnd() - 0.5) * bend * 2,
      ex + (rnd() - 0.5) * bend * 2, ey + (rnd() - 0.5) * bend * 2,
      ex, ey);
    g.stroke();
  }

  // Scratches: a few long, faint, slightly wandering vertical lines (B).
  const scratches = Math.round(rnd() * 1.5 + 3 * amt);
  for (let i = 0; i < scratches; i++) {
    const x = rnd() * c.width;
    const y0 = rnd() < 0.5 ? 0 : rnd() * c.height * 0.5;
    const y1 = Math.min(c.height, y0 + c.height * (0.35 + rnd() * 0.65));
    const drift = (rnd() - 0.5) * S * 0.02;
    g.strokeStyle = chan(2, 0.18 + 0.3 * rnd() * opacity);
    g.lineWidth = Math.max(1, S * (0.0004 + rnd() * 0.0005));
    g.beginPath();
    g.moveTo(x, y0);
    g.bezierCurveTo(x + drift * 0.3, y0 + (y1 - y0) * 0.33, x + drift * 0.7, y0 + (y1 - y0) * 0.66, x + drift, y1);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

// ---------------------------------------------------------------------------
// Date stamp — seven-segment LED digits on black.
// ---------------------------------------------------------------------------
const SEGS = {
  // segments: a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left, g middle
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg',
  6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

const DATE_COLORS = {
  orange: { fill: '#ff8a1f', glow: 'rgba(255,110,20,0.9)' },
  red: { fill: '#ff3b1f', glow: 'rgba(255,40,10,0.9)' },
  yellow: { fill: '#ffd23a', glow: 'rgba(255,190,30,0.9)' },
};

function dateTokens(date, format) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const Y = d.getFullYear(), M = d.getMonth() + 1, D = d.getDate();
  const yy = String(Y % 100).padStart(2, '0');
  const p2 = (v) => String(v).padStart(2, '0');
  switch (format) {
    case 'us': return `${M} ${D} '${yy}`;
    case 'dots': return `${yy}.${p2(M)}.${p2(D)}`;
    case 'iso': return `${Y} ${p2(M)} ${p2(D)}`;
    case 'classic':
    default: return `'${yy} ${M} ${D}`;
  }
}

// Hexagonal horizontal segment centred at (cx,cy), length L, thickness t.
function hSeg(g, cx, cy, L, t) {
  const h = t / 2;
  g.moveTo(cx - L / 2, cy);
  g.lineTo(cx - L / 2 + h, cy - h);
  g.lineTo(cx + L / 2 - h, cy - h);
  g.lineTo(cx + L / 2, cy);
  g.lineTo(cx + L / 2 - h, cy + h);
  g.lineTo(cx - L / 2 + h, cy + h);
  g.closePath();
}
function vSeg(g, cx, cy, L, t) {
  const h = t / 2;
  g.moveTo(cx, cy - L / 2);
  g.lineTo(cx + h, cy - L / 2 + h);
  g.lineTo(cx + h, cy + L / 2 - h);
  g.lineTo(cx, cy + L / 2);
  g.lineTo(cx - h, cy + L / 2 - h);
  g.lineTo(cx - h, cy - L / 2 + h);
  g.closePath();
}

// Draw one digit with top-left (x,y), cell width W, height H.
function drawDigit(g, ch, x, y, W, H, t, rnd) {
  const segs = SEGS[ch] || '';
  const gap = t * 0.18;
  const hw = W - t, hh = (H - t) / 2;
  const L = hw - gap * 2, Lv = hh - gap * 2;
  const left = x + t / 2, right = x + W - t / 2;
  const top = y + t / 2, mid = y + H / 2, bot = y + H - t / 2;
  const cx = x + W / 2;
  for (const s of segs) {
    // hand-made wobble: each segment slightly different
    const j = () => (rnd() - 0.5) * t * 0.12;
    switch (s) {
      case 'a': hSeg(g, cx + j(), top + j(), L, t); break;
      case 'g': hSeg(g, cx + j(), mid + j(), L, t); break;
      case 'd': hSeg(g, cx + j(), bot + j(), L, t); break;
      case 'f': vSeg(g, left + j(), (top + mid) / 2 + j(), Lv, t); break;
      case 'b': vSeg(g, right + j(), (top + mid) / 2 + j(), Lv, t); break;
      case 'e': vSeg(g, left + j(), (mid + bot) / 2 + j(), Lv, t); break;
      case 'c': vSeg(g, right + j(), (mid + bot) / 2 + j(), Lv, t); break;
    }
  }
}

export function makeDateCanvas(date, opts = {}, fullW, fullH) {
  const format = opts.format || 'classic';
  const col = DATE_COLORS[opts.color] || DATE_COLORS.orange;
  const text = dateTokens(date, format);
  const short = Math.max(1, Math.min(fullW, fullH));
  const H = Math.max(8, short * 0.032);         // digit height (full px)
  const W = H * 0.56;                              // digit width
  const t = H * 0.13;                              // segment thickness
  const adv = W + H * 0.16;                        // digit advance
  const space = H * 0.38;
  const punct = H * 0.26;
  const skew = 0.12;                               // italic slant
  const pad = Math.ceil(H * 0.45);                 // room for glow

  let textW = 0;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') textW += adv;
    else if (ch === ' ') textW += space;
    else textW += punct;
  }
  const cw = Math.ceil(textW + H * skew + pad * 2);
  const chh = Math.ceil(H + pad * 2);
  const c = makeCanvas(cw, chh);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);

  const drawAll = (blur, alpha) => {
    const rnd = mulberry32(0x5eed + text.length); // same wobble for every pass
    g.save();
    g.globalAlpha = alpha;
    g.shadowColor = col.glow;
    g.shadowBlur = blur;
    g.fillStyle = col.fill;
    // italic skew around the baseline
    g.setTransform(1, 0, -skew, 1, pad + H * skew, pad);
    let x = 0;
    g.beginPath();
    for (const ch of text) {
      if (ch >= '0' && ch <= '9') {
        drawDigit(g, ch, x, 0, W, H, t, rnd);
        x += adv;
      } else if (ch === ' ') {
        x += space;
      } else if (ch === '.') {
        const r = t * 0.62;
        g.moveTo(x + punct * 0.45 + r, H - r);
        g.arc(x + punct * 0.45, H - r, r, 0, Math.PI * 2);
        x += punct;
      } else if (ch === "'") {
        // apostrophe: short slanted tick near the top
        const cx = x + punct * 0.5, w2 = t * 0.55;
        g.moveTo(cx - w2, 0);
        g.lineTo(cx + w2, 0);
        g.lineTo(cx + w2 * 0.2, H * 0.3);
        g.lineTo(cx - w2 * 1.2, H * 0.3);
        g.closePath();
        x += punct;
      } else {
        x += punct;
      }
    }
    g.fill();
    g.restore();
  };
  drawAll(H * 0.35, 0.8);   // wide glow
  drawAll(H * 0.08, 1.0);   // crisp core with a tight halo

  const margin = short * 0.05;
  const x = (fullW - margin - c.width + pad) / fullW;
  const y = (fullH - margin - c.height + pad) / fullH;
  return { canvas: c, rect: [x, y, c.width / fullW, c.height / fullH] };
}

// ---------------------------------------------------------------------------
// Light leaks — normalised params; renderer draws elliptical gaussian blobs.
// x, y: centre in 0..1 image coords (y down; x may lie off-frame);
// r: radius in short-edge units; stretch: vertical elongation; color: linear-ish rgb 0..1.
// ---------------------------------------------------------------------------
const LEAK_PALETTE = [
  [1.0, 0.45, 0.08],  // orange
  [1.0, 0.22, 0.06],  // red
  [1.0, 0.68, 0.18],  // amber
  [1.0, 0.55, 0.25],  // peach
  [0.95, 0.18, 0.45], // magenta (rare)
];

// Leak styles (opts.style, or the older opts.bias for camera built-in leaks):
//   'warm'  (default) — 1–3 warm orange/red leaks, mostly off the left/right edges;
//   'edge'  — one soft leak hugging the left/right edge;
//   'holga' — 1–2 strong red/orange streaks bleeding in from a side of the frame;
//   'prism' — a soft pink-orange glow from one side edge and a mint/teal glow from the
//             opposite edge (3–4 large, vertically stretched blobs).
export const LEAK_STYLES = ['warm', 'prism', 'edge', 'holga'];
export const PRISM_WARM = [1.0, 0.45, 0.35];
export const PRISM_COOL = [0.35, 0.95, 0.75];

export function makeLeaks(seed, opts = null) {
  const style = (opts && (opts.style || opts.bias)) || 'warm';
  if (style === 'edge' || style === 'holga') return biasedLeaks(seed, style);
  if (style === 'prism') return prismLeaks(seed);
  const rnd = mulberry32(((seed >>> 0) * 2654435761) ^ 0xa5a5a5a5);
  const n = 1 + Math.floor(rnd() * 3);
  const side0 = rnd() < 0.5 ? 0 : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const side = rnd() < 0.8 ? (i % 2 === 0 ? side0 : 1 - side0) : (rnd() < 0.5 ? 0 : 1);
    const edge = rnd() < 0.85;
    const x = edge
      ? (side === 0 ? -0.18 + rnd() * 0.22 : 0.96 + rnd() * 0.22)
      : 0.1 + rnd() * 0.8;
    const y = rnd();
    const r = 0.18 + rnd() * 0.32;
    const stretch = 1 + rnd() * 2.2;
    const pick = rnd();
    const ci = pick < 0.07 ? 4 : Math.floor(rnd() * 4);
    const base = LEAK_PALETTE[ci];
    const jitter = 0.9 + rnd() * 0.1;
    out.push({ x, y, r, stretch, color: [base[0], base[1] * jitter, base[2] * jitter] });
  }
  return out;
}

function prismLeaks(seed) {
  const rnd = mulberry32(((seed >>> 0) * 3266489917) ^ 0x9715e);
  const warmSide = rnd() < 0.5 ? 0 : 1;       // which edge gets the pink-orange glow
  const edgeX = (side, inset) => (side === 0 ? -0.1 + inset : 1.1 - inset);
  const tint = (base, j) => [
    Math.min(1, base[0] * (1 - j * 0.04)), Math.min(1, base[1] * (1 - j * 0.06)), Math.min(1, base[2] * (1 + j * 0.08)),
  ];
  const out = [];
  // main warm glow: large, low-ish on its edge
  const wy = 0.45 + rnd() * 0.4;
  out.push({ x: edgeX(warmSide, rnd() * 0.06), y: wy, r: 0.36 + rnd() * 0.16, stretch: 1.3 + rnd() * 0.6, color: tint(PRISM_WARM, rnd() - 0.5) });
  // main teal glow: opposite edge, a little higher, slightly smaller
  const cy = 0.3 + rnd() * 0.4;
  out.push({ x: edgeX(1 - warmSide, rnd() * 0.06), y: cy, r: 0.3 + rnd() * 0.14, stretch: 1.4 + rnd() * 0.7, color: tint(PRISM_COOL, rnd() - 0.5) });
  // softer secondary blooms keep each edge from looking like a single spot
  if (rnd() < 0.8) {
    const y = Math.min(1, Math.max(0, wy + (rnd() < 0.5 ? -1 : 1) * (0.25 + rnd() * 0.15)));
    out.push({ x: edgeX(warmSide, -0.04), y, r: 0.24 + rnd() * 0.1, stretch: 1.6 + rnd() * 0.8, color: tint([1.0, 0.55, 0.4], rnd() - 0.5) });
  }
  if (rnd() < 0.6) {
    const y = Math.min(1, Math.max(0, cy + (rnd() < 0.5 ? -1 : 1) * (0.22 + rnd() * 0.15)));
    out.push({ x: edgeX(1 - warmSide, -0.04), y, r: 0.2 + rnd() * 0.1, stretch: 1.5 + rnd() * 0.8, color: tint([0.45, 0.9, 0.85], rnd() - 0.5) });
  }
  return out;
}

function biasedLeaks(seed, bias) {
  const rnd = mulberry32(((seed >>> 0) * 2246822519) ^ (bias === 'holga' ? 0x401ea : 0xed9e));
  const holga = bias === 'holga';
  const n = holga ? 1 + (rnd() < 0.55 ? 1 : 0) : 1;
  const side = rnd() < 0.5 ? 0 : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = i === 0 ? side : (rnd() < 0.7 ? side : 1 - side);
    const inset = holga ? rnd() * 0.08 : -0.04 + rnd() * 0.06;
    const x = s === 0 ? -0.04 + inset : 1.04 - inset;
    const y = holga ? 0.2 + rnd() * 0.6 : 0.15 + rnd() * 0.7;
    const r = holga ? 0.1 + rnd() * 0.1 : 0.14 + rnd() * 0.1;
    const stretch = holga ? 2.4 + rnd() * 1.4 : 1.6 + rnd() * 1.2;
    const base = holga ? LEAK_PALETTE[rnd() < 0.6 ? 1 : 0] : LEAK_PALETTE[rnd() < 0.5 ? 0 : 2];
    out.push({ x, y, r, stretch, color: base.slice() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format crop + film border ("frame")
// ---------------------------------------------------------------------------
// frameLayout(W, H, { camera, film, crop, border, seed }) →
//   { full: [W, H],                 original image size (px)
//     crop: [x, y, w, h],           frame rect inside the original (px) — everything lens/film
//                                   related is defined relative to this rect
//     inner: [l, t],                where the frame sits inside the output (px, full-res units)
//     out: [w, h],                  output size incl. border (px, full-res units; round × scale)
//     style: null | '135' | 'half' | '120' | 'holga' | 'polaroid' | 'instax',
//     filmBorder: bool,             border is film (grain/leaks continue onto it) vs paper
//     draw: null | (ctx, ox, oy, k) => void }
// draw() paints the border into a 2D context whose pixel (0,0) is output pixel (ox, oy) at
// k output px per full-res px. Opaque where the border is, transparent over the picture.
// Resolution independent and deterministic: preview and every export strip draw the same thing.

export function instantType(film) {
  const id = (film && film.id) || '';
  if (id.includes('polaroid')) return 'polaroid';
  if (id.includes('instax')) return 'instax';
  return null;
}

const INSTANT = {
  // image aspect (long/short), border as fractions of the image short edge
  polaroid: { aspect: 1, side: 0.057, top: 0.076, bottom: 0.278, paper: ['#f4f2ec', '#e9e6dd'] },
  instax: { aspect: 62 / 46, side: 0.087, top: 0.14, bottom: 0.38, paper: ['#f6f5f1', '#eceae4'] },
  // a landscape Instax reads like Instax Wide: slimmer margins, the thick strip still at the bottom
  instaxLand: { aspect: 62 / 46, side: 0.075, top: 0.12, bottom: 0.27, paper: ['#f6f5f1', '#eceae4'] },
};
// film geometry in mm: across = picture dimension across the film, side = border on the
// across axis (rebate + a sliver of scanner holder), end = border on the along-film axis
const ROLL = {
  135: { across: 24, side: 6.2, end: 2.4, filmEdge: 5.5 },
  half: { across: 24, side: 6.2, end: 2.0, filmEdge: 5.5 },
  120: { across: 56, side: 3.8, end: 3.4, filmEdge: 2.6 },
  holga: { across: 56, side: 5.4, end: 5.0, filmEdge: 2.6 },
};

export function frameLayout(W, H, { camera = null, film = null, crop = false, border = false, seed = 1 } = {}) {
  W = Math.max(1, W); H = Math.max(1, H);
  const inst = instantType(film);
  const land = W >= H;
  let aspect = inst ? INSTANT[inst].aspect : (camera && camera.aspect) || null;
  let cr = [0, 0, W, H];
  if (crop && aspect) {
    const a = land ? aspect : 1 / aspect;
    let cw = W, ch = W / a;
    if (ch > H) { ch = H; cw = H * a; }
    cr = [(W - cw) / 2, (H - ch) / 2, cw, ch];
  }
  const [, , cw, ch] = cr;
  const L = { full: [W, H], crop: cr, inner: [0, 0], out: [cw, ch], style: null, filmBorder: false, draw: null };
  if (!border) return L;

  const short = Math.min(cw, ch);
  if (inst) {
    const g = INSTANT[inst === 'instax' && cw > ch ? 'instaxLand' : inst];
    const l = g.side * short, t = g.top * short, b = g.bottom * short;
    Object.assign(L, { inner: [l, t], out: [cw + 2 * l, ch + t + b], style: inst, filmBorder: false });
    L.draw = (ctx, ox, oy, k) => drawInstant(ctx, ox, oy, k, L, g);
    return L;
  }
  const style = (camera && camera.frame) || '135';
  const geo = ROLL[style] || ROLL[135];
  // half-frame: the 24 mm across-film side is the LONG side; otherwise the short side
  const acrossIsLong = style === 'half';
  const acrossVertical = acrossIsLong ? !(cw >= ch) : cw >= ch;
  const acrossPx = acrossVertical ? ch : cw;
  const mm = acrossPx / geo.across;
  const side = geo.side * mm, end = geo.end * mm;
  const l = acrossVertical ? end : side, t = acrossVertical ? side : end;
  Object.assign(L, { inner: [l, t], out: [cw + 2 * l, ch + 2 * t], style, filmBorder: true });
  const info = {
    geo, mm, acrossVertical, notch: !!(camera && camera.notch),
    label: filmLabel(film), ink: edgeInk(film), frameNo: 1 + Math.floor(mulberry32((seed >>> 0) ^ 0x51f7)() * 35),
    seed: seed >>> 0,
  };
  L.draw = (ctx, ox, oy, k) => drawRoll(ctx, ox, oy, k, L, info);
  return L;
}

function filmLabel(film) {
  if (!film) return 'SAFETY FILM';
  const brand = film.brand && film.brand !== 'Generic' ? film.brand + ' ' : '';
  return (brand + (film.name || '')).toUpperCase().replace(/\s+/g, ' ').trim();
}
function edgeInk(film) {
  const p = film && film.params;
  if ((p && p.type === 'bw') || (film && film.category === 'bw')) return { ink: '#d8d6d0', glow: 'rgba(230,230,230,0.5)', base: '#0b0b0b' };
  if (film && film.process === 'E-6') return { ink: '#f3e9cf', glow: 'rgba(255,240,200,0.45)', base: '#070605' };
  return { ink: '#f7a63c', glow: 'rgba(255,140,40,0.55)', base: '#120d0a' };
}

function rrect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawInstant(ctx, ox, oy, k, L, g) {
  const [ow, oh] = L.out, [l, t] = L.inner, cw = L.crop[2], ch = L.crop[3];
  ctx.save();
  ctx.setTransform(k, 0, 0, k, -ox, -oy);
  const gr = ctx.createLinearGradient(0, 0, ow * 0.3, oh);
  gr.addColorStop(0, g.paper[0]); gr.addColorStop(1, g.paper[1]);
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, ow, oh);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.rect(l, t, cw, ch);
  ctx.fill();
  // the developer spread leaves a faint darker rim on the picture edge
  ctx.globalCompositeOperation = 'source-over';
  const s = Math.min(cw, ch);
  ctx.strokeStyle = 'rgba(28,22,18,0.35)';
  ctx.lineWidth = s * 0.006;
  ctx.strokeRect(l + s * 0.003, t + s * 0.003, cw - s * 0.006, ch - s * 0.006);
  ctx.restore();
}

// Smooth seeded 1-D noise in −1..1 (sum of a few sines) for rough mask edges.
function edgeNoise(seed) {
  const r = mulberry32(seed);
  const terms = Array.from({ length: 5 }, (_, i) => ({ f: (i + 1) * (2 + r() * 3), p: r() * 6.283, a: 1 / (i + 1.3) }));
  const norm = terms.reduce((s, x) => s + x.a, 0);
  return (u) => terms.reduce((s, x) => s + x.a * Math.sin(u * x.f + x.p), 0) / norm;
}

function drawRoll(ctx, ox, oy, k, L, I) {
  const { geo, mm } = I;
  const [l, t] = L.inner, cw = L.crop[2], ch = L.crop[3];
  // local film coords: u along the film (0..A = picture), v across (0..C = picture)
  const A = I.acrossVertical ? cw : ch, C = I.acrossVertical ? ch : cw;
  const side = geo.side * mm, end = geo.end * mm;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, -ox, -oy);
  if (I.acrossVertical) ctx.transform(1, 0, 0, 1, l, t);
  else ctx.transform(0, -1, 1, 0, l, t + ch);   // (u, v) → (x = l + v, y = t + A − u)
  const rnd = mulberry32(I.seed ^ 0x2f00d);

  // scanner holder (outside the film) + film base
  ctx.fillStyle = '#030303';
  ctx.fillRect(-end, -side, A + 2 * end, C + 2 * side);
  ctx.fillStyle = I.ink.base;
  ctx.fillRect(-end, -geo.filmEdge * mm, A + 2 * end, C + 2 * geo.filmEdge * mm);

  // picture window
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  if (L.style === 'holga') {
    // filed / rough plastic mask: wobbly edges, rounded corners, soft fall-off
    const N = 90, amp = 0.55 * mm;
    const nz = [0, 1, 2, 3].map((i) => edgeNoise(I.seed * 7 + i * 101 + 3));
    const rc = 3.2 * mm;
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 0.9 * mm * k;
    ctx.beginPath();
    const pts = [];
    const push = (u, v) => pts.push([u, v]);
    // four wobbly edges joined by rounded corners
    const e = (i, f) => amp * nz[i](f * 6.283) + amp * 0.4;
    const corner = (cu, cv, a0, inU, inV) => {
      for (let j = 1; j < 8; j++) {
        const a = a0 + (j / 8) * Math.PI / 2;
        push(cu + Math.cos(a) * (rc - inU), cv + Math.sin(a) * (rc - inV));
      }
    };
    for (let i = 0; i <= N; i++) { const f = i / N; push(rc + f * (A - 2 * rc), e(0, f)); }
    corner(A - rc, rc, -Math.PI / 2, e(1, 0), e(0, 1));
    for (let i = 0; i <= N; i++) { const f = i / N; push(A - e(1, f), rc + f * (C - 2 * rc)); }
    corner(A - rc, C - rc, 0, e(1, 1), e(2, 0));
    for (let i = 0; i <= N; i++) { const f = i / N; push(A - rc - f * (A - 2 * rc), C - e(2, f)); }
    corner(rc, C - rc, Math.PI / 2, e(3, 0), e(2, 1));
    for (let i = 0; i <= N; i++) { const f = i / N; push(e(3, f), C - rc - f * (C - 2 * rc)); }
    corner(rc, rc, Math.PI, e(3, 1), e(0, 0));
    pts.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.beginPath();
    rrect(ctx, 0, 0, A, C, (L.style === '120' ? 0.5 : 0.3) * mm);
    ctx.fill();
    if (I.notch) {
      // Hasselblad film-back notches: small V cut-outs on one frame edge
      ctx.beginPath();
      for (const f of [0.3, 0.38]) {
        ctx.moveTo(A - 0.1 * mm, C * f - 0.6 * mm);
        ctx.lineTo(A + 0.9 * mm, C * f);
        ctx.lineTo(A - 0.1 * mm, C * f + 0.6 * mm);
        ctx.closePath();
      }
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  const font = (h) => `600 ${h}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const text = (str, u, v, h, alpha = 1) => {
    ctx.font = font(h);
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.shadowColor = I.ink.glow;
    ctx.shadowBlur = 0.35 * mm * k;
    ctx.fillStyle = I.ink.ink;
    ctx.fillText(str, u, v);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };
  const n = I.frameNo;
  if (L.style === '135' || L.style === 'half') {
    // KS perforations: 1.98 mm along × 2.79 mm across, pitch 4.75 mm, 0.71 mm from the picture
    const pitch = 4.75 * mm, pw = 1.98 * mm, ph = 2.79 * mm, gap = 0.71 * mm;
    const phase = rnd() * pitch;
    ctx.fillStyle = '#ece8df';
    ctx.beginPath();
    for (let u = -end - pitch + phase; u < A + end; u += pitch) {
      rrect(ctx, u, -gap - ph, pw, ph, 0.45 * mm);
      rrect(ctx, u, C + gap, pw, ph, 0.45 * mm);
    }
    ctx.fill();
    // edge print in the outer margin (perforation → film edge)
    const vTop = -(gap + ph + (geo.filmEdge * mm - gap - ph) / 2);
    const vBot = C + (gap + ph + (geo.filmEdge * mm - gap - ph) / 2);
    const th = 1.15 * mm;
    if (L.style === 'half') {
      text(`${n}`, A * 0.1, vTop, th);
      text(I.label, A * 0.35, vTop, th * 0.9);
      text(`\u25B6${n}A`, A * 0.1, vBot, th);
    } else {
      text(I.label, A * 0.1, vTop, th);
      text(`${n}`, A * 0.78, vTop, th);
      text(`\u25B6${n}A`, A * 0.06, vBot, th);
      text(`${n + 1}`, A * 0.86, vBot, th);
      // DX-style barcode
      ctx.fillStyle = I.ink.ink;
      ctx.globalAlpha = 0.9;
      let u = A * 0.34;
      const bh = 1.0 * mm;
      for (let i = 0; i < 22; i++) {
        const w = (rnd() < 0.5 ? 0.32 : 0.62) * mm;
        if (i % 2 === 0) ctx.fillRect(u, vBot - bh / 2, w, bh);
        u += w + 0.28 * mm;
      }
      ctx.globalAlpha = 1;
    }
  } else {
    // 120: edge print near the film edge, frame numbers on the other edge
    const vTop = -geo.filmEdge * mm * 0.5, vBot = C + geo.filmEdge * mm * 0.5;
    const th = 1.25 * mm;
    const a = L.style === 'holga' ? 0.75 : 1;
    text(I.label, A * 0.08, vTop, th, a);
    text(`${n % 16 || 16}`, A * 0.62, vBot, th * 1.2, a);
    text('\u25B6', A * 0.7, vBot, th, a);
    if (L.style !== 'holga') text(`${(n % 16 || 16) + 1}`, A * 0.94, vTop, th, 0.5);
  }
  ctx.restore();
}
