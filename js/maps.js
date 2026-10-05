// CPU-side low-resolution maps for halation, bloom and flare. See docs/ARCHITECTURE.md §4.
// Everything here is resolution independent: blur radii are fractions of the short edge.

const MAX_EDGE = 512;

const s2l = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// One horizontal + vertical box pass (radius r) using running sums, edge-clamped.
function boxPass(src, dst, w, h, r) {
  if (r < 1) { dst.set(src); return; }
  const tmp = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

// Approximate gaussian of the given sigma (px) with 3 box passes.
export function gaussBlur(data, w, h, sigma) {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  const r = Math.max(0, Math.round((wIdeal - 1) / 2));
  const a = new Float32Array(data);
  const b = new Float32Array(w * h);
  boxPass(a, b, w, h, r);
  boxPass(b, a, w, h, r);
  boxPass(a, b, w, h, r);
  return b;
}

export function buildMaps(proxyCanvas) {
  const sw = proxyCanvas.width, sh = proxyCanvas.height;
  const k = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const small = canvas(w, h);
  const g = small.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(proxyCanvas, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  const N = w * h;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  const mask = new Float32Array(N), soft = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = s2l[px[i * 4]], gg = s2l[px[i * 4 + 1]], b = s2l[px[i * 4 + 2]];
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    mask[i] = smooth(0.6, 1.0, l);
    const sm = smooth(0.45, 1.0, l);
    soft[i] = sm;
    R[i] = r * sm; G[i] = gg * sm; B[i] = b * sm;
  }
  const short = Math.min(w, h);
  const hR = gaussBlur(mask, w, h, short * 0.008);
  const hG = gaussBlur(mask, w, h, short * 0.02);
  const bs = short * 0.025;
  const bR = gaussBlur(R, w, h, bs), bG = gaussBlur(G, w, h, bs), bB = gaussBlur(B, w, h, bs);

  const hmap = canvas(w, h), bmap = canvas(w, h);
  const hImg = new ImageData(w, h), bImg = new ImageData(w, h);
  const hd = hImg.data, bd = bImg.data;
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    hd[o] = q(hR[i]); hd[o + 1] = q(hG[i]); hd[o + 2] = 0; hd[o + 3] = 255;
    bd[o] = q(bR[i]); bd[o + 1] = q(bG[i]); bd[o + 2] = q(bB[i]); bd[o + 3] = 255;
  }
  hmap.getContext('2d').putImageData(hImg, 0, 0);
  bmap.getContext('2d').putImageData(bImg, 0, 0);

  const flare = findFlare(proxyCanvas);

  small.width = small.height = 0;
  return { hmap, bmap, flare };
}

// Brightest region on a ≤64px version, weighted slightly toward the top of the frame.
function findFlare(src) {
  const sw = src.width, sh = src.height;
  const k = Math.min(1, 64 / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = canvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    L[i] = 0.2126 * s2l[px[i * 4]] + 0.7152 * s2l[px[i * 4 + 1]] + 0.0722 * s2l[px[i * 4 + 2]];
  }
  // small region average (radius 1) so isolated specular pixels don't win
  const A = new Float32Array(w * h);
  boxPass(L, A, w, h, 1);
  let best = -1, bx = 0.5, by = 0.3, peak = 0;
  for (let y = 0; y < h; y++) {
    const wy = 1 - 0.12 * (y / Math.max(1, h - 1));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = Math.max(A[i], L[i] * 0.85);
      const s = v * wy;
      if (s > best) { best = s; bx = (x + 0.5) / w; by = (y + 0.5) / h; peak = v; }
    }
  }
  const strength = peak < 0.8 ? 0 : smooth(0.8, 0.97, peak);
  return { x: bx, y: by, strength };
}
