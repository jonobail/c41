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

export function makeLeaks(seed) {
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
