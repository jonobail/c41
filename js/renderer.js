// C41 WebGL2 renderer — one full-screen-triangle fragment pass. See docs/ARCHITECTURE.md §6.
// No DOM access at import time (safe to import in Node).

import { LUT_HEADROOM, FILM_DEFAULTS, srgbToLinear, linearToSrgb, floatToHalf } from './film-transform.js';

export const PAD = 64; // full-image px of neighbourhood sampling the shader may need

const VERT = `#version 300 es
void main() {
  // full-screen triangle
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

uniform sampler2D uSrc, uHmap, uBmap, uDustTex, uDateTex, uFrameTex;
uniform sampler3D uLut;

// Geometry (all in render px). "frame" = the camera's picture area (crop of the image);
// "output" = frame + optional border. p = frame coords, o = output coords.
uniform vec2 uImg;         // whole source image size
uniform vec2 uCropOff;     // frame origin inside the image
uniform vec2 uFull;        // frame size
uniform vec2 uInner;       // frame origin inside the output
uniform vec2 uOutFull;     // whole output size
uniform vec2 uSrcOrigin, uSrcSize, uOutOrigin, uOutSize;
uniform float uFlip;
uniform float uScale;      // render px per full-res px
uniform float uRefShort;   // frame short edge in render px
uniform float uLutN, uHeadroom;

uniform float uSharp, uSoft, uClarity, uCornerSoft, uSweet, uBlurShape, uMaxR, uDist, uCA, uMaxCA;
uniform float uVig, uVigHard, uVigWob, uVigSat;
uniform vec2 uVigOff;
uniform vec3 uWB;
uniform float uExpo, uVeil, uSat, uFlash;
uniform vec3 uHalCol;
uniform float uHal, uBloom;
uniform vec3 uFlare;       // x, y (frame-normalised), strength (final)
uniform float uFilmAmt, uContrast;
uniform vec3 uGrain;       // amplitude, cell size (target px), colour mix
uniform uint uSeed;
uniform int uLeakN;
uniform vec4 uLeakGeo[6];  // x, y, r, stretch (≤4 user + ≤2 camera)
uniform vec4 uLeakCol[6];  // rgb, weight
uniform float uDust, uDateOn;
uniform vec4 uDateRect;
uniform float uFrameOn, uFrameFilm;
uniform vec2 uFrameOrigin, uFrameSize;
uniform float uSplit, uShowOrig;
// Remapped lenses (docs/ARCHITECTURE.md §6 "remap"): 0 plain, 1 multi-lens grid, 2 circular fisheye
uniform int uMode;
uniform vec2 uGridN;       // cols, rows (in the frame's orientation)
uniform vec4 uCellA[8];    // per cell: image-px origin b.xy, magnification m (image px per cell px), exposure (stops)
uniform vec3 uCellB[8];    // per cell: white-balance multiplier
uniform vec3 uGap;         // separator core half-width (frame px), feather (frame px), luma
uniform vec4 uFish;        // circle radius R (frame px), half-FOV phi (rad), tan(phi), rim strength
uniform vec4 uFishS;       // scene centre (image px), scene half extents (image px)
uniform float uTexK;       // source texels per image px (LOD for minified remaps)
uniform float uVigAxis;    // 0 radial vignette .. 1 falloff only across the film (short frame axis)
uniform float uBand;       // rotating-slit exposure banding along the long axis
uniform float uSwirl;      // Petzval: corner blur along arcs round the lens centre
uniform vec4 uGel;         // flash gel transmission (luma-normalised rgb), amount

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// ---- lens space ----
// develop() works in "lens px": frame px for a plain lens or the fisheye, cell-local px for a grid.
// lensToImg() maps lens px to image px; every tap (blur, CA, clarity) goes through it, so local
// lens effects stay local while the picture is remapped. Set per pixel in main().
vec2 gFull;      // lens frame size (frame, or one grid cell)
vec2 gCtr;       // lens centre (lens px)
float gHd;       // vignette / falloff normaliser (half-diagonal; fisheye: circle radius)
float gK;        // lens frame short edge / frame short edge
float gLod;      // source mip level (minified remaps)
vec2 gMapB;      // grid: image px = gMapB + q * gMapM
float gMapM;
float gCellExpo; // grid: per-cell exposure (stops)
vec3 gCellWb;    // grid: per-cell colour
float gGap;      // grid: separator mask 0..1
float gOut;      // fisheye: 0 inside the image circle .. 1 outside
float gRho;      // fisheye: radius / circle radius

// Source scale along dir at circle radius rho: isotropic (short half-extent) in the middle, so
// the centre bulges without wobble, easing toward the source's inscribed ellipse at the rim so the
// long side of the photo is used too ('contain').
float fishE(vec2 dir, float rho) {
  vec2 hs = uFishS.zw;
  float hmin = min(hs.x, hs.y);
  float ell = inversesqrt(dot(dir * dir, 1.0 / (hs * hs)));
  return mix(hmin, ell, rho * rho * rho);
}
vec2 fishMap(vec2 q) {
  vec2 v = q - uFull * 0.5;
  float r = length(v);
  if (r < 1e-4) return uFishS.xy;
  vec2 dir = v / r;
  float rho = min(r / uFish.x, 0.999);
  return uFishS.xy + dir * (fishE(dir, rho) * tan(rho * uFish.y) / uFish.z);
}
vec2 lensToImg(vec2 q) {
  if (uMode == 1) return gMapB + q * gMapM;
  if (uMode == 2) return fishMap(q);
  return q + uCropOff;
}
vec3 srcImg(vec2 qi) {
  qi = clamp(qi, vec2(0.5), uImg - 0.5);
  return textureLod(uSrc, (qi - uSrcOrigin) / uSrcSize, gLod).rgb;
}
vec3 srcAt(vec2 p) { return srcImg(lensToImg(p)); }
// lens tap with lateral CA (red magnified, blue shrunk)
vec3 tapCA(vec2 q, vec2 off) {
  return vec3(srcAt(q + off).r, srcAt(q).g, srcAt(q - off).b);
}

vec3 toLin(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 l) {
  l = max(l, 0.0);
  return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), l));
}

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float hashf(ivec2 c, uint ch) {
  uint h = pcg(uint(c.x) ^ pcg(uint(c.y) ^ pcg(uSeed * 3u + ch)));
  return float(h) * (2.0 / 4294967295.0) - 1.0;
}
float vnoise(vec2 x, uint ch) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i) + ivec2(65536);
  float a = hashf(c, ch);
  float b = hashf(c + ivec2(1, 0), ch);
  float d = hashf(c + ivec2(0, 1), ch);
  float e = hashf(c + ivec2(1, 1), ch);
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
float grainAt(vec2 gp, uint ch) {
  // fine octave at the cell size + a coarser clumping octave
  float o1 = vnoise(gp / uGrain.y, ch);
  float o2 = vnoise(gp / (uGrain.y * 2.3) + 31.7, ch + 7u);
  return (o1 + 0.5 * o2) * 1.25;
}

vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0)); }

// Full camera + film development of the picture at frame coords p.
vec3 develop(vec2 p) {
  vec2 ctr = gCtr;
  float hd = gHd;
  float refShort = uRefShort * gK;
  vec2 rp = (p - ctr) / hd;                 // centre 0 .. corner length 1
  float d = length(rp);
  float edge = smoothstep(uSweet, 1.0, d);  // 0 in the sweet spot .. 1 in the corners

  // ---- lens geometry: barrel / pincushion, corners fixed ----
  vec2 q = p;
  if (uDist != 0.0) q = ctr + (p - ctr) * (1.0 + uDist * d * d) / (1.0 + uDist);

  // ---- lateral CA ----
  vec2 off = vec2(0.0);
  if (uCA > 0.0) {
    off = (q - ctr) * uCA * 0.0025;
    float lo = length(off);
    if (lo > uMaxCA * gK) off *= uMaxCA * gK / lo;
  }
  vec3 col = uCA > 0.0 ? tapCA(q, off) : srcAt(q);

  // ---- softness: overall + field curvature toward the corners (elliptical kernel) ----
  float soft = uSoft + uCornerSoft * edge;
  float rad = min(soft * refShort * 0.005, uMaxR * gK);
  if (rad > 0.4) {
    vec2 rd = d > 1e-4 ? rp / d : vec2(1.0, 0.0);
    vec2 td = vec2(-rd.y, rd.x);
    float an = uBlurShape * edge;           // + radial (zoom) smear, − tangential (swirl)
    float ra = rad * (1.0 + max(an, 0.0) * 1.5) * (1.0 - max(-an, 0.0) * 0.6);
    float rt = rad * (1.0 + max(-an, 0.0) * 1.5) * (1.0 - max(an, 0.0) * 0.6);
    vec3 acc = col;
    for (int i = 0; i < 16; i++) {
      float fi = float(i) + 0.5;
      float rr = sqrt(fi / 16.0);
      float a = fi * 2.3999632;
      vec2 kk = vec2(cos(a), sin(a)) * rr;
      vec2 o2 = rd * (kk.x * ra) + td * (kk.y * rt);
      if (uSwirl > 0.0) {
        // Petzval swirl: taps on an ARC round the lens centre (curved, not straight, smear)
        vec2 v = q - ctr;
        float vr = max(length(v), 1.0);
        float ph = kk.x * uSwirl * 2.4 * rad * edge / vr;
        float sc = 1.0 + kk.y * rad * 0.35 / vr;
        vec2 cs = vec2(cos(ph), sin(ph));
        o2 = mix(o2, (vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x) * sc) - v, min(1.0, uSwirl));
      }
      acc += uCA > 0.0 ? tapCA(q + o2, off) : srcAt(q + o2);
    }
    col = mix(col, acc / 17.0, smoothstep(0.4, 1.5, rad));
  }

  // ---- micro-contrast (unsharp mask) — fades where the corners go soft ----
  float sh = uSharp * (1.0 - edge * min(1.0, uCornerSoft * 2.0));
  if (sh > 0.0 || uClarity != 0.0) {
    float r1 = max(0.75, refShort * 0.0008);
    float r2 = refShort * 0.006;
    vec3 m1 = vec3(0.0), m2 = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 dir2 = vec2(cos(a + 0.3926991), sin(a + 0.3926991));
      if (sh > 0.0) m1 += srcAt(q + dir * r1);
      if (uClarity != 0.0) m2 += srcAt(q + dir2 * r2) + srcAt(q + dir * r2 * 0.5);
    }
    if (sh > 0.0) col += (col - m1 / 8.0) * sh * 1.6;
    if (uClarity != 0.0) {
      m2 /= 16.0;
      // local contrast mostly in the midtones; negative = haze / glow toward the local mean
      float L = dot(col, LUMA);
      float w = uClarity > 0.0 ? 0.35 + 0.65 * clamp(4.0 * L * (1.0 - L), 0.0, 1.0) : 1.0;
      col += (col - m2) * uClarity * w;
    }
    col = max(col, 0.0);
  }

  // ---- linear light ----
  vec3 lin = toLin(col) * uWB * uExpo;
  if (uMode == 1) lin *= exp2(gCellExpo) * gCellWb;

  // vignette (stops), optionally off-centre and uneven
  vec2 vq = rp - uVigOff;
  float vd = length(vq);
  if (uVigAxis > 0.0) {
    // falloff across the film only (rotating slit, Supersampler strips): 1 at the lens frame's
    // edges along the frame's short axis
    float ax = uFull.x >= uFull.y ? abs(p.y - ctr.y) / (gFull.y * 0.5) : abs(p.x - ctr.x) / (gFull.x * 0.5);
    vd = mix(vd, ax, uVigAxis);
  }
  if (uVigWob > 0.0) {
    float ang = atan(vq.y, vq.x);
    vd *= 1.0 + uVigWob * 0.16 * (sin(ang * 2.0 + 1.3) + 0.6 * sin(ang * 3.0 + 4.1) + 0.4 * sin(ang * 5.0 + 0.7));
  }
  float vst = min(uVig * pow(max(vd, 0.0), uVigHard), 9.0);
  lin *= exp2(-vst);

  // point-and-shoot flash: hot centre, fast fall-off, unlit background drops away
  if (uFlash > 0.0) {
    float L = dot(lin, LUMA) / max(uExpo, 1e-3);
    float r2 = d * d;
    float sAmb = -0.3 - 1.7 * (1.0 - smoothstep(0.006, 0.16, L));   // what the ambient light keeps
    float stops = 0.95 * exp(-r2 / 0.22) - 1.1 * r2 + sAmb;
    lin *= exp2(uFlash * stops);
    lin *= mix(vec3(1.0), vec3(0.95, 1.0, 1.07), uFlash);
    if (uGel.w > 0.0) {
      // colour gel: tint only the share of the light the flash added, not the ambient
      // (×1.7: the subject the flash reaches is lit mostly by it — the Colorsplash reference set
      // shows near-saturated casts on the subject)
      float share = clamp(1.7 * (1.0 - exp2(uFlash * (sAmb - stops))), 0.0, 1.0);
      lin *= mix(vec3(1.0), uGel.rgb, share * uGel.w);
    }
  }

  // rotating-slit banding (Spinner): faint bands along the long axis from an uneven spin
  if (uBand > 0.0) {
    float lx = uFull.x >= uFull.y ? p.x : p.y;
    lin *= exp2(uBand * 0.24 * vnoise(vec2(lx / (0.08 * min(uFull.x, uFull.y)), 0.5), 11u));
  }

  // multi-lens grid: soft dark separators between the cells
  if (gGap > 0.0) lin = mix(lin, lin * uGap.z * 0.25, gGap);

  // veiling glare (washed blacks)
  lin += uVeil * 0.25 * uExpo;

  // halation + bloom (maps cover the whole image)
  vec2 nImg = clamp(lensToImg(q), vec2(0.0), uImg) / uImg;
  vec4 h = texture(uHmap, nImg);
  // halation is light scattered back from the film base: it shows as a glow AROUND highlights,
  // so suppress it inside the (already saturated) highlight itself
  float hiSelf = smoothstep(0.5, 1.0, dot(lin, LUMA));
  lin += uHalCol * (0.6 * h.r + 0.4 * h.g) * uHal * 2.0 * uExpo * (1.0 - 0.85 * hiSelf);
  lin += texture(uBmap, nImg).rgb * uBloom * 1.5 * uExpo;

  // fisheye: grey internal-reflection ring just inside the rim; outside the image circle only a
  // faint reflection of the rim on the lens barrel, then black film base
  if (uMode == 2) {
    lin += uFish.w * 0.05 * uExpo * smoothstep(0.92, 0.985, gRho) * (1.0 - smoothstep(0.985, 1.0, gRho));
    if (gOut > 0.0) {
      float rimL = dot(lin, LUMA);
      vec3 refl = vec3(rimL) * uFish.w * 0.25 * exp(-(gRho - 1.0) / 0.025);
      lin = mix(lin, refl + 0.0012 * uExpo, gOut);
    }
  }

  // flare
  if (uFlare.z > 0.0) {
    vec2 fq0 = (p - ctr) / refShort;
    vec2 fq = (uFlare.xy * gFull - ctr) / refShort;
    float fd = length(fq0 - fq);
    vec3 fl = vec3(1.0, 0.78, 0.55) * (exp(-fd * fd / (0.08 * 0.08)) * 1.4 + exp(-fd * fd / (0.35 * 0.35)) * 0.12);
    // ghosts along the line through the centre
    vec3 ghosts = vec3(0.0);
    float ks[4] = float[4](-0.35, -0.75, -1.25, 0.45);
    float rs[4] = float[4](0.05, 0.085, 0.035, 0.06);
    vec3 ts[4] = vec3[4](vec3(0.35, 0.9, 0.45), vec3(0.85, 0.4, 0.9), vec3(1.0, 0.7, 0.3), vec3(0.4, 0.6, 1.0));
    for (int i = 0; i < 4; i++) {
      float gd = length(fq0 - fq * ks[i]);
      float disc = 1.0 - smoothstep(rs[i] * 0.6, rs[i], gd);
      float rim = smoothstep(rs[i] * 0.55, rs[i] * 0.9, gd) * disc;
      ghosts += ts[i] * (disc * 0.10 + rim * 0.08);
    }
    fl += ghosts + vec3(1.0, 0.9, 0.8) * 0.03;
    lin += fl * uFlare.z * uExpo;
  }

  // ---- encode + film LUT ----
  vec3 base = clamp(toSrgb(lin), 0.0, 1.0);
  vec3 u = clamp(toSrgb(lin / uHeadroom), 0.0, 1.0);
  vec3 lut = texture(uLut, u * ((uLutN - 1.0) / uLutN) + 0.5 / uLutN).rgb;
  vec3 c = clamp(mix(base, lut, uFilmAmt), 0.0, 1.0); // uFilmAmt > 1 exaggerates the stock

  // camera colour signature: saturation (+ boost that follows the vignette)
  float sat = uSat + uVigSat * (1.0 - exp2(-vst));
  if (sat != 0.0) {
    float Y = dot(c, LUMA);
    c = clamp(mix(vec3(Y), c, 1.0 + sat), 0.0, 1.0);
  }

  // post contrast (user + lens + flash)
  if (uContrast != 0.0) {
    vec3 cc = clamp(c, 0.0, 1.0);
    c = cc + uContrast * (cc * cc * (3.0 - 2.0 * cc) - cc);
  }
  return c;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 o = uOutOrigin + vec2(fc.x, uFlip > 0.5 ? uOutSize.y - fc.y : fc.y);
  vec2 p = o - uInner;
  vec2 n = p / uFull;

  vec4 fr = vec4(0.0);
  if (uFrameOn > 0.5) fr = texture(uFrameTex, (o - uFrameOrigin) / uFrameSize);

  // per-pixel lens space (defaults: the whole frame, plain lens)
  gFull = uFull; gCtr = uFull * 0.5; gHd = length(gCtr); gK = 1.0; gLod = 0.0;
  gMapB = vec2(0.0); gMapM = 1.0; gCellExpo = 0.0; gCellWb = vec3(1.0); gGap = 0.0; gOut = 0.0; gRho = 0.0;

  if (uShowOrig > 0.5 || o.x / uOutFull.x < uSplit) {
    vec3 c0 = fr.a > 0.998 ? vec3(0.0) : srcImg(p + uCropOff);
    outColor = vec4(mix(c0, fr.rgb, fr.a), 1.0);
    return;
  }

  vec2 lp = p;
  if (uMode == 1) {
    vec2 S = uFull / uGridN;
    vec2 ij = clamp(floor(p / S), vec2(0.0), uGridN - 1.0);
    int k = int(ij.y * uGridN.x + ij.x);
    lp = p - ij * S;
    gFull = S; gCtr = S * 0.5; gHd = length(gCtr);
    gK = min(S.x, S.y) / min(uFull.x, uFull.y);
    vec4 A = uCellA[k];
    gMapB = A.xy; gMapM = A.z; gCellExpo = A.w; gCellWb = uCellB[k];
    gLod = max(0.0, log2(A.z * uTexK));
    // distance to the nearest INTERNAL cell edge (frame px)
    float de = 1e9;
    if (ij.x > 0.0) de = min(de, lp.x);
    if (ij.x < uGridN.x - 1.0) de = min(de, S.x - lp.x);
    if (ij.y > 0.0) de = min(de, lp.y);
    if (ij.y < uGridN.y - 1.0) de = min(de, S.y - lp.y);
    gGap = 1.0 - smoothstep(uGap.x, uGap.x + uGap.y, de);
  } else if (uMode == 2) {
    vec2 v = p - gCtr;
    float r = length(v);
    gRho = r / uFish.x;
    gHd = uFish.x;
    gOut = smoothstep(1.0, 1.0 + 1.5 / uFish.x, gRho);
    if (gRho > 0.995) lp = gCtr + v * (0.995 / gRho);
    // local magnification of the fisheye map → mip level (rim is strongly minified)
    float rho = min(gRho, 0.995);
    vec2 dir = r > 1e-4 ? v / r : vec2(1.0, 0.0);
    float e = fishE(dir, rho);
    float cs = cos(rho * uFish.y);
    float jr = e * uFish.y / (uFish.x * uFish.z * cs * cs);
    gLod = max(0.0, log2(jr * uTexK));
  }

  vec3 c = fr.a > 0.998 ? fr.rgb : mix(develop(lp), fr.rgb, fr.a);
  float onPic = 1.0 - fr.a;
  float filmW = mix(1.0, uFrameFilm, fr.a);   // grain / leaks continue onto a film rebate

  // ---- grain ----
  if (uGrain.x > 0.0 && filmW > 0.0) {
    float L = clamp(dot(c, LUMA), 0.0, 1.0);
    float w = 0.15 + 0.85 * clamp(4.0 * L * (1.0 - L), 0.0, 1.0);
    float m = grainAt(p, 0u);
    vec3 g = mix(vec3(m), vec3(m, grainAt(p, 1u), grainAt(p, 2u)), uGrain.z);
    c += g * uGrain.x * w * filmW;
  }
  c = clamp(c, 0.0, 1.0);

  // ---- light leaks (screen) ----
  if (uLeakN > 0 && filmW > 0.0) {
    vec3 lk = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      if (i >= uLeakN) break;
      vec4 g = uLeakGeo[i];
      vec2 q = (p - g.xy * uFull) / uRefShort;
      q.y /= max(g.w, 0.01);
      float v = exp(-dot(q, q) / max(g.z * g.z, 1e-4));
      vec3 lc = uLeakCol[i].rgb;
      // hot core: warm white for warm leaks; follows the leak colour for cool (teal/mint) ones
      vec3 core = mix(vec3(1.0, 0.85, 0.6), lc, clamp(lc.g + lc.b - lc.r, 0.0, 1.0));
      lk += (lc * v + core * pow(v, 4.0) * 0.35) * uLeakCol[i].a;
    }
    c = screen(c, lk * filmW);
  }

  bool inPic = all(greaterThanEqual(n, vec2(0.0))) && all(lessThanEqual(n, vec2(1.0)));
  // ---- dust (on the picture) ----
  if (uDust > 0.0 && inPic) {
    vec3 dt = texture(uDustTex, n).rgb * onPic;
    c = mix(c, vec3(1.0), clamp(dt.r * uDust, 0.0, 1.0));
    c = mix(c, vec3(0.03), clamp(dt.g * 0.8 * uDust, 0.0, 1.0));
    c = mix(c, vec3(1.0), clamp(dt.b * uDust, 0.0, 1.0));
  }

  // ---- date stamp (screen) ----
  if (uDateOn > 0.5) {
    vec2 du = (n - uDateRect.xy) / uDateRect.zw;
    if (all(greaterThanEqual(du, vec2(0.0))) && all(lessThanEqual(du, vec2(1.0)))) {
      c = screen(c, texture(uDateTex, du).rgb * onPic);
    }
  }

  // ---- dither ----
  float dz = float(pcg(uint(o.x) * 7919u ^ pcg(uint(o.y) + 0x9e3779b9u))) / 4294967295.0 - 0.5;
  outColor = vec4(c + dz / 255.0, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader compile failed: ' + log);
  }
  return s;
}

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

function identityLut(N) {
  const data = new Uint16Array(N * N * N * 4);
  const v = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    v[i] = floatToHalf(Math.min(1, linearToSrgb(srgbToLinear(i / (N - 1)) * LUT_HEADROOM)));
  }
  let o = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    data[o++] = v[r]; data[o++] = v[g]; data[o++] = v[b]; data[o++] = 0x3c00;
  }
  return data;
}

const UNIFORMS = [
  'uSrc', 'uHmap', 'uBmap', 'uDustTex', 'uDateTex', 'uFrameTex', 'uLut',
  'uImg', 'uCropOff', 'uFull', 'uInner', 'uOutFull',
  'uSrcOrigin', 'uSrcSize', 'uOutOrigin', 'uOutSize', 'uFlip', 'uScale', 'uRefShort',
  'uLutN', 'uHeadroom', 'uSharp', 'uSoft', 'uClarity', 'uCornerSoft', 'uSweet', 'uBlurShape', 'uMaxR',
  'uDist', 'uCA', 'uMaxCA', 'uVig', 'uVigHard', 'uVigWob', 'uVigSat', 'uVigOff',
  'uWB', 'uExpo', 'uVeil', 'uSat', 'uFlash',
  'uHalCol', 'uHal', 'uBloom', 'uFlare', 'uFilmAmt', 'uContrast', 'uGrain', 'uSeed',
  'uLeakN', 'uLeakGeo', 'uLeakCol', 'uDust', 'uDateOn', 'uDateRect',
  'uFrameOn', 'uFrameFilm', 'uFrameOrigin', 'uFrameSize', 'uSplit', 'uShowOrig',
  'uMode', 'uGridN', 'uCellA', 'uCellB', 'uGap', 'uFish', 'uFishS', 'uTexK', 'uVigAxis', 'uBand', 'uGel', 'uSwirl',
];
// texture units
const U_SRC = 0, U_LUT = 1, U_HMAP = 2, U_BMAP = 3, U_DUST = 4, U_DATE = 5, U_FRAME = 6;

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const CAM_AMT_MAX = 1.5;   // "Lens character" may exaggerate up to 150 %
const BLUR_K = 0.005;             // blur radius per unit softness (× frame short edge)
const MAX_R_K = 0.012;            // blur radius cap (× frame short edge); kernel reaches 2.5×
const MAX_CA_K = 0.012;           // CA offset cap (× frame short edge)
const CLARITY_K = 0.006;          // clarity radius (× frame short edge)

/** Derived lens uniforms from a camera object and the "Lens character" amount. */
export function lensUniforms(camera, camAmt = 1) {
  const c = (camera && camera.params) || {};
  const a = clampN(num(camAmt, 1), 0, CAM_AMT_MAX);
  const sharp = num(c.sharpness, 0) * a;
  const off = Array.isArray(c.vignetteOffset) ? c.vignetteOffset : [0, 0];
  return {
    sharp: clampN(Math.max(0, sharp), 0, 1.2),
    soft: clampN(Math.max(0, -sharp), 0, 1.2),
    clarity: clampN(num(c.clarity, 0) * a, -0.6, 0.8),
    cornerSoft: clampN(num(c.cornerSoft, 0) * a, 0, 1.8),
    sweet: clampN(num(c.sweetSpot, 0.35), 0, 0.95),
    blurShape: clampN(num(c.blurShape, 0), -1, 1),
    dist: clampN(num(c.distortion, 0) * a, -0.15, 0.15),
    ca: clampN(num(c.ca, 0) * a, 0, 1.5),
    vig: Math.max(0, num(c.vignette, 0) * a * 1.6),
    vigHard: clampN(num(c.vignetteHardness, 2), 1, 6),
    vigOff: [num(off[0], 0) * a, num(off[1], 0) * a],
    vigWob: clampN(num(c.vignetteWobble, 0) * a, 0, 1.5),
    vigSat: clampN(num(c.vigSat, 0) * a, 0, 1.5),
    sat: clampN(num(c.sat, 0) * a, -0.6, 0.6),
    veil: clampN(num(c.veil, 0) * a, 0, 0.2),
    contrast: num(c.contrast, 0) * a,
    warmth: num(c.warmth, 0) * a,
    tint: num(c.tint, 0) * a,
    bloom: clampN(num(c.bloom, 0) * a, 0, 1.5),
    flare: num(c.flare, 0) * a,
    flash: clampN(num(c.flash, 0.6), 0, 1),
    vigAxis: clampN(num(c.vigAxis, 0), 0, 1),
    band: clampN(num(c.banding, 0) * a, 0, 1.5),
    swirl: clampN(num(c.swirl, 0), 0, 1),
  };
}

/* ------------------------------------------------------------------ remapped lenses */
// Multi-lens grids (ActionSampler, Supersampler, Oktomat, half-frame pairs) and circular
// fisheyes sample the source far from the output pixel. The geometry below is the JS twin of the
// shader's lensToImg(): the renderer turns it into uniforms, and the exporter uses
// remapSourceRect() to upload exactly the source region each strip needs.

export const GRID_MAX = 8;

function strHash(s) {
  let h = 2166136261;
  for (const ch of String(s || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;   // −1..1
  };
}

/**
 * Remap geometry for `camera.grid` / `camera.fisheye`, or null for an ordinary lens.
 * img = [W, H] whole source image, crop = [x, y, w, h] frame inside it — any consistent px units
 * (preview proxy px or export render px); everything scales with them. seed = photo seed.
 *   grid:    { mode: 1, cols, rows, S: [w, h] cell size, cells: [{ b: [x, y], m, expo, wb: [r,g,b] }],
 *              gapCore, gapFeather, gapLuma }   image px = b + cellLocal × m
 *   fisheye: { mode: 2, R, phi, tanPhi, rim, sc: [x, y], sh: [hx, hy], frame: [w, h] }
 */
export function remapGeometry(camera, img, crop, seed = 1) {
  const g = camera && camera.grid, f = camera && camera.fisheye;
  if (!g && !f) return null;
  const [cx, cy, Fw, Fh] = crop;
  const short = Math.min(Fw, Fh);
  if (g) {
    const land = Fw >= Fh;
    const cols = Math.max(1, Math.round(land ? g.cols : g.rows));
    const rows = Math.max(1, Math.round(land ? g.rows : g.cols));
    const n = Math.min(GRID_MAX, cols * rows);
    const S = [Fw / cols, Fh / rows];
    const r = rng(((seed >>> 0) * 2654435761) ^ strHash(camera.id));
    const shift = num(g.shift, 0);
    let dir;
    if (g.motion === 'long') dir = land ? [1, 0] : [0, 1];
    else { const a = (r() + 1) * Math.PI; dir = [Math.cos(a), Math.sin(a)]; }
    const raw = [];
    for (let k = 0; k < n; k++) {
      const t = k - (n - 1) / 2;
      raw.push({
        o: [shift * t * dir[0] + 0.35 * shift * r(), shift * t * dir[1] + 0.35 * shift * r()],
        z: 1 + num(g.zoomJitter, 0) * Math.abs(r()),
        expo: num(g.expoJitter, 0) * r(),
        tint: num(g.tintJitter, 0) * r(),
      });
    }
    const split = g.fit === 'split';
    const maxO = [0, 1].map((a) => Math.max(...raw.map((c) => Math.abs(c.o[a]))));
    // cover-fit the whole image into a cell, zoomed in just enough that the shifts stay inside it
    const m0 = Math.min(img[0] / (S[0] * (1 + 2 * maxO[0])), img[1] / (S[1] * (1 + 2 * maxO[1])));
    const cells = raw.map((c, k) => {
      const m = split ? 1 / c.z : m0 / c.z;
      let centre;
      if (split) {
        const i = k % cols, j = Math.floor(k / cols);
        centre = [cx + (i + 0.5) * S[0] + c.o[0] * S[0], cy + (j + 0.5) * S[1] + c.o[1] * S[1]];
      } else {
        centre = [img[0] / 2 + c.o[0] * S[0] * m, img[1] / 2 + c.o[1] * S[1] * m];
      }
      return {
        b: [centre[0] - S[0] * 0.5 * m, centre[1] - S[1] * 0.5 * m], m, expo: c.expo,
        wb: [1 + c.tint, 1, 1 - c.tint],
      };
    });
    return {
      mode: 1, cols, rows, S, cells,
      gapCore: num(g.gapCore, 0) * short, gapFeather: Math.max(1e-3, num(g.gap, 0.01) * short),
      gapLuma: num(g.gapLuma, 0.8),
    };
  }
  const R = num(f.radius, 1.08) * short / 2;
  const phi = clampN(num(f.virtualHalfFov, 70), 20, 85) * Math.PI / 180;
  const sh = f.fill === 'cover' ? [Math.min(img[0], img[1]) / 2, Math.min(img[0], img[1]) / 2] : [img[0] / 2, img[1] / 2];
  return { mode: 2, R, phi, tanPhi: Math.tan(phi), rim: num(f.rim, 0.35), sc: [img[0] / 2, img[1] / 2], sh, frame: [Fw, Fh] };
}

/** JS twin of the shader's fishMap(): frame px → [image x, image y, local magnification]. */
export function fishPoint(G, x, y) {
  const vx = x - G.frame[0] / 2, vy = y - G.frame[1] / 2;
  const r = Math.hypot(vx, vy);
  const dx = r > 1e-4 ? vx / r : 1, dy = r > 1e-4 ? vy / r : 0;
  const rho = Math.min(r / G.R, 0.995);
  const hmin = Math.min(G.sh[0], G.sh[1]);
  const ell = 1 / Math.sqrt((dx * dx) / (G.sh[0] * G.sh[0]) + (dy * dy) / (G.sh[1] * G.sh[1]));
  const e = hmin + (ell - hmin) * rho * rho * rho;
  const s = e * Math.tan(rho * G.phi) / G.tanPhi;
  const cs = Math.cos(rho * G.phi);
  return [G.sc[0] + dx * s, G.sc[1] + dy * s, e * G.phi / (G.R * G.tanPhi * cs * cs)];
}

/**
 * Source region (image px, [x0, y0, x1, y1], unclamped) that frame rect [x0, y0, x1, y1] samples
 * under remap geometry G, including `reach` lens px of neighbourhood (blur / CA / clarity).
 * Also returns jMin = the smallest image-px-per-lens-px over the region (how far the source can
 * be downsampled before it limits detail).
 */
export function remapSourceRect(G, rect, reach = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, jMin = Infinity;
  const add = (x, y, pad) => {
    x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
  };
  if (G.mode === 1) {
    const [Sw, Sh] = G.S;
    for (let j = 0; j < G.rows; j++) for (let i = 0; i < G.cols; i++) {
      const ax = Math.max(rect[0], i * Sw), bx = Math.min(rect[2], (i + 1) * Sw);
      const ay = Math.max(rect[1], j * Sh), by = Math.min(rect[3], (j + 1) * Sh);
      if (bx <= ax || by <= ay) continue;
      const c = G.cells[j * G.cols + i];
      if (!c) continue;
      const pad = (reach + 2) * c.m;
      add(c.b[0] + (ax - i * Sw) * c.m, c.b[1] + (ay - j * Sh) * c.m, pad);
      add(c.b[0] + (bx - i * Sw) * c.m, c.b[1] + (by - j * Sh) * c.m, pad);
      jMin = Math.min(jMin, c.m);
    }
  } else if (G.mode === 2) {
    const fx0 = Math.max(rect[0], 0), fy0 = Math.max(rect[1], 0);
    const fx1 = Math.min(rect[2], G.frame[0]), fy1 = Math.min(rect[3], G.frame[1]);
    if (fx1 > fx0 && fy1 > fy0) {
      const N = 96;
      const pt = (x, y) => {
        const [ix, iy, J] = fishPoint(G, x, y);
        add(ix, iy, (reach + 2) * J);
        jMin = Math.min(jMin, J);
      };
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        pt(fx0 + (fx1 - fx0) * u, fy0); pt(fx0 + (fx1 - fx0) * u, fy1);
        pt(fx0, fy0 + (fy1 - fy0) * u); pt(fx1, fy0 + (fy1 - fy0) * u);
      }
      const cxF = G.frame[0] / 2, cyF = G.frame[1] / 2;
      if (cxF >= fx0 && cxF <= fx1 && cyF >= fy0 && cyF <= fy1) pt(cxF, cyF);
      // the rim column/row through the centre bounds the bulge when the rect straddles an axis
      if (cxF >= fx0 && cxF <= fx1) { pt(cxF, Math.min(Math.max(cyF, fy0), fy1)); }
      if (cyF >= fy0 && cyF <= fy1) { pt(Math.min(Math.max(cxF, fx0), fx1), cyF); }
    }
  }
  if (!(x1 > x0)) return null;
  return { rect: [x0, y0, x1, y1], jMin };
}

/**
 * How far (in the same units as frameW/frameH) the lens stage may sample away from a pixel:
 * distortion + CA + blur kernel / clarity ring. The exporter adds this to PAD for strips.
 */
export function lensReach(camera, camAmt, frameW, frameH) {
  // multi-lens grid: the lens works per cell (the exporter scales this by the cell magnification)
  const gr = camera && camera.grid;
  if (gr) {
    const land = frameW >= frameH;
    frameW /= Math.max(1, land ? gr.cols : gr.rows);
    frameH /= Math.max(1, land ? gr.rows : gr.cols);
  }
  const L = lensUniforms(camera, camAmt);
  const short = Math.min(frameW, frameH), hd = 0.5 * Math.hypot(frameW, frameH);
  const dist = Math.abs(L.dist) * 0.4 * hd;
  const ca = Math.min(L.ca * 0.0025 * hd, MAX_CA_K * short);
  const blur = Math.min((L.soft + L.cornerSoft) * BLUR_K, MAX_R_K) * short * 2.5;
  const clar = L.clarity !== 0 ? CLARITY_K * short : 0;
  return Math.ceil(dist + ca + Math.max(blur, clar));
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('webgl2-unavailable');
    this.gl = gl;
    this.params = {};
    this.lost = false;
    this._restoreCb = null;
    this._onLost = (e) => { e.preventDefault(); this.lost = true; };
    this._onRestored = () => {
      this.lost = false;
      this._init();
      if (this._restoreCb) this._restoreCb();
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    this._init();
  }

  _init() {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    this.u = {};
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);
    this.vao = gl.createVertexArray();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    const black = () => {
      const t = this._tex2d();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    };
    this.tex = { src: black(), hmap: black(), bmap: black(), dust: black(), date: black(), frame: black(), lut: null };
    this.frameGeo = null;
    this.srcSize = [1, 1];
    this.dateRect = [0, 0, 0, 0];
    this.hasDate = false;
    this.lutN = 2;
    this.setLut(identityLut(17), 17);
    this.fbo = null; this.fboTex = null; this.fboSize = [0, 0];
  }

  _tex2d() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _upload(key, source, mip = false) {
    const gl = this.gl;
    if (this.lost) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[key]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip && source ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (source) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      // overlays drawn at full-image resolution get minified in the preview
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    }
  }

  get limits() {
    const gl = this.gl;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    return {
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewport: [vp[0], vp[1]],
    };
  }

  /** Source texture (mipmapped: remapped lenses minify it — see uTexK / gLod). */
  setSource(src) {
    this._upload('src', src, true);
    const w = src.naturalWidth || src.videoWidth || src.width;
    const h = src.naturalHeight || src.videoHeight || src.height;
    this.srcSize = [w, h];
  }

  setLut(halfData, N) {
    const gl = this.gl;
    if (this.lost) return;
    if (this.tex.lut) gl.deleteTexture(this.tex.lut);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    if (!this._lut8) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, N, N, N, 0, gl.RGBA, gl.HALF_FLOAT, halfData);
      if (gl.getError() !== gl.NO_ERROR) this._lut8 = true;
    }
    if (this._lut8) {
      const b = new Uint8Array(halfData.length);
      for (let i = 0; i < b.length; i++) {
        b[i] = Math.max(0, Math.min(255, Math.round(halfToFloat(halfData[i]) * 255)));
      }
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, b);
    }
    this.tex.lut = t;
    this.lutN = N;
  }

  setMaps(maps) {
    this._upload('hmap', maps && maps.hmap);
    this._upload('bmap', maps && maps.bmap);
  }

  setDust(canvas) {
    this._upload('dust', canvas || null, true);
  }

  setDate(d) {
    if (d && d.canvas) {
      this._upload('date', d.canvas, true);
      this.dateRect = d.rect.slice(0, 4);
      this.hasDate = true;
    } else {
      this._upload('date', null);
      this.hasDate = false;
    }
  }

  /**
   * Border texture (see overlays.frameLayout): { canvas, origin: [x, y], size: [w, h] } in output
   * px of the NEXT render (preview: whole output; export: the current strip), or null.
   */
  setFrame(f) {
    if (f && f.canvas) {
      this._upload('frame', f.canvas);
      this.frameGeo = { origin: f.origin.slice(0, 2), size: f.size.slice(0, 2) };
    } else {
      this._upload('frame', null);
      this.frameGeo = null;
    }
  }

  setParams(p) {
    this.params = p || {};
  }

  /** Output (canvas) size renderPreview() will use for the current source + params.layout. */
  previewSize() {
    return this._previewGeo().outFull;
  }

  _previewGeo() {
    const [w, h] = this.srcSize;
    const L = this.params.layout;
    if (!L || !L.full) {
      return { img: [w, h], crop: [0, 0, w, h], inner: [0, 0], outFull: [w, h], k: 1 };
    }
    const kx = w / L.full[0], ky = h / L.full[1];
    const k = kx;
    return {
      img: [w, h],
      crop: [L.crop[0] * kx, L.crop[1] * ky, L.crop[2] * kx, L.crop[3] * ky],
      inner: [L.inner[0] * k, L.inner[1] * k],
      outFull: [Math.max(1, Math.round(L.out[0] * k)), Math.max(1, Math.round(L.out[1] * k))],
      k,
    };
  }

  renderPreview() {
    if (this.lost) return;
    const gl = this.gl;
    const [w, h] = this.srcSize;
    const G = this._previewGeo();
    const [ow, oh] = G.outFull;
    if (this.canvas.width !== ow) this.canvas.width = ow;
    if (this.canvas.height !== oh) this.canvas.height = oh;
    const fullShort = num(this.params.fullShort, Math.min(G.crop[2], G.crop[3]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._draw({
      img: G.img, crop: G.crop, inner: G.inner, outFull: G.outFull,
      srcOrigin: [0, 0], srcSize: [w, h], outOrigin: [0, 0], outSize: [ow, oh],
      scale: Math.min(G.crop[2], G.crop[3]) / fullShort, flip: true, texK: 1,
    });
  }

  // full = whole source image size (render px). Optional: crop [x,y,w,h] (frame inside the
  // image, default whole image), inner [x,y] (frame origin in output), outFull [w,h] (output size).
  // texK = source texels per image render px (the exporter may upload a remapped strip's source
  // region downsampled; default 1).
  renderRegion({ srcOrigin, srcSize, full, outOrigin, outSize, scale, crop, inner, outFull, texK }) {
    if (this.lost) throw new Error('webgl-context-lost');
    const gl = this.gl;
    const [w, h] = outSize;
    if (!this.fbo || this.fboSize[0] !== w || this.fboSize[1] !== h) {
      if (!this.fbo) this.fbo = gl.createFramebuffer();
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      this.fboTex = this._tex2d();
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      this.fboSize = [w, h];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const cr = crop || [0, 0, full[0], full[1]];
    this._draw({
      img: full, crop: cr, inner: inner || [0, 0], outFull: outFull || [cr[2], cr[3]],
      srcOrigin, srcSize, outOrigin, outSize, scale: num(scale, 1), flip: false, texK: num(texK, 1),
    });
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  _draw(g) {
    const gl = this.gl, u = this.u, P = this.params;
    const film = P.film || {}, fp = film.params || film;
    const formatScale = num(P.camera && P.camera.formatScale, 1);
    const filmAmt = num(P.filmAmt, 1);
    const Lu = lensUniforms(P.camera, P.camAmt);
    const scale = g.scale;
    const frameShort = Math.min(g.crop[2], g.crop[3]);
    const fullShort = num(P.fullShort, frameShort / scale);
    const refShort = fullShort * scale;

    gl.viewport(0, 0, g.outSize[0], g.outSize[1]);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);

    const bind = (unit, target, tex, loc) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
      gl.uniform1i(loc, unit);
    };
    bind(U_SRC, gl.TEXTURE_2D, this.tex.src, u.uSrc);
    bind(U_LUT, gl.TEXTURE_3D, this.tex.lut, u.uLut);
    bind(U_HMAP, gl.TEXTURE_2D, this.tex.hmap, u.uHmap);
    bind(U_BMAP, gl.TEXTURE_2D, this.tex.bmap, u.uBmap);
    bind(U_DUST, gl.TEXTURE_2D, this.tex.dust, u.uDustTex);
    bind(U_DATE, gl.TEXTURE_2D, this.tex.date, u.uDateTex);
    bind(U_FRAME, gl.TEXTURE_2D, this.tex.frame, u.uFrameTex);

    gl.uniform2f(u.uImg, g.img[0], g.img[1]);
    gl.uniform2f(u.uCropOff, g.crop[0], g.crop[1]);
    gl.uniform2f(u.uFull, g.crop[2], g.crop[3]);
    gl.uniform2f(u.uInner, g.inner[0], g.inner[1]);
    gl.uniform2f(u.uOutFull, g.outFull[0], g.outFull[1]);
    gl.uniform2f(u.uSrcOrigin, g.srcOrigin[0], g.srcOrigin[1]);
    gl.uniform2f(u.uSrcSize, g.srcSize[0], g.srcSize[1]);
    gl.uniform2f(u.uOutOrigin, g.outOrigin[0], g.outOrigin[1]);
    gl.uniform2f(u.uOutSize, g.outSize[0], g.outSize[1]);
    gl.uniform1f(u.uFlip, g.flip ? 1 : 0);
    gl.uniform1f(u.uScale, scale);
    gl.uniform1f(u.uRefShort, refShort);
    gl.uniform1f(u.uLutN, this.lutN);
    gl.uniform1f(u.uHeadroom, LUT_HEADROOM);

    // lens
    gl.uniform1f(u.uSharp, Lu.sharp);
    gl.uniform1f(u.uSoft, Lu.soft);
    gl.uniform1f(u.uClarity, Lu.clarity);
    gl.uniform1f(u.uCornerSoft, Lu.cornerSoft);
    gl.uniform1f(u.uSweet, Lu.sweet);
    gl.uniform1f(u.uBlurShape, Lu.blurShape);
    gl.uniform1f(u.uMaxR, MAX_R_K * refShort);
    gl.uniform1f(u.uDist, Lu.dist);
    gl.uniform1f(u.uCA, Lu.ca);
    gl.uniform1f(u.uMaxCA, MAX_CA_K * refShort);
    gl.uniform1f(u.uVig, Lu.vig);
    gl.uniform1f(u.uVigHard, Lu.vigHard);
    gl.uniform2f(u.uVigOff, Lu.vigOff[0], Lu.vigOff[1]);
    gl.uniform1f(u.uVigWob, Lu.vigWob);
    gl.uniform1f(u.uVigSat, Lu.vigSat);
    gl.uniform1f(u.uSat, Lu.sat);
    gl.uniform1f(u.uVeil, Lu.veil);
    const flash = num(P.flash, 0) > 0 ? Lu.flash * Math.min(1, num(P.flash, 0)) : 0;
    gl.uniform1f(u.uFlash, flash);

    // white balance: user warmth/tint + lens coating cast, luminance-normalised gains
    const wt = 0.25 * num(P.warmth, 0) + Lu.warmth;
    const tn = 0.2 * num(P.tint, 0) + Lu.tint;
    let wr = (1 + wt) * (1 + tn * 0.5), wg = 1 - tn, wb = (1 - wt) * (1 + tn * 0.5);
    const wl = 0.2126 * wr + 0.7152 * wg + 0.0722 * wb;
    gl.uniform3f(u.uWB, wr / wl, wg / wl, wb / wl);
    const expo = Math.pow(2, num(P.exposure, 0));
    gl.uniform1f(u.uExpo, expo);

    // halation + bloom
    const hal = { ...FILM_DEFAULTS.halation, ...(fp.halation || {}) };
    const hc = hal.color || [1, 0.35, 0.15];
    gl.uniform3f(u.uHalCol, hc[0], hc[1], hc[2]);
    gl.uniform1f(u.uHal, num(hal.amount, 0) * num(P.halation, 1) * filmAmt);
    gl.uniform1f(u.uBloom, Lu.bloom + num(fp.bloom, FILM_DEFAULTS.bloom) * filmAmt);

    // flare (flarePoint is normalised to the whole image → convert to the frame)
    const fpnt = P.flarePoint || { x: 0.5, y: 0.3, strength: 0 };
    const fstr = Lu.flare * num(P.flare, 1) * (0.3 + 0.7 * num(fpnt.strength, 0));
    const fx = (num(fpnt.x, 0.5) * g.img[0] - g.crop[0]) / g.crop[2];
    const fy = (num(fpnt.y, 0.3) * g.img[1] - g.crop[1]) / g.crop[3];
    gl.uniform3f(u.uFlare, fx, fy, fstr);

    gl.uniform1f(u.uFilmAmt, filmAmt);
    gl.uniform1f(u.uContrast, num(P.contrast, 0) + Lu.contrast + 0.14 * flash);

    // grain
    const gr = { ...FILM_DEFAULTS.grain, ...(fp.grain || {}) };
    const rawCell = fullShort * 0.00045 * num(gr.size, 1) / formatScale * scale;
    const cell = Math.max(1, rawCell);
    // When the true grain cell is sub-pixel (downscaled preview / export), several grains average
    // into one pixel: attenuate (sqrt — between "honest" averaging and keeping grain visible).
    const atten = rawCell < 1 ? Math.max(0.5, Math.sqrt(rawCell)) : 1;
    gl.uniform3f(u.uGrain, num(gr.amount, 0) * num(P.grain, 1) * 0.12 * atten, cell, num(gr.color, 0));
    gl.uniform1ui(u.uSeed, (num(P.seed, 1) >>> 0));

    // leaks: user leaks (weight = leak slider) + camera built-in leaks (weight = camera leak)
    const all = [];
    if (num(P.leak, 0) > 0 && Array.isArray(P.leaks)) for (const l of P.leaks.slice(0, 4)) all.push([l, num(P.leak, 0)]);
    const camLeak = num(P.camera && P.camera.params && P.camera.params.leak, 0) * clampN(num(P.camAmt, 1), 0, CAM_AMT_MAX);
    if (camLeak > 0 && Array.isArray(P.camLeaks)) for (const l of P.camLeaks.slice(0, 2)) all.push([l, camLeak]);
    const geo = new Float32Array(24), lc = new Float32Array(24);
    all.forEach(([l, w], i) => {
      geo.set([num(l.x, 0), num(l.y, 0), num(l.r, 0.3), num(l.stretch, 1)], i * 4);
      const c = l.color || [1, 0.5, 0.1];
      lc.set([c[0], c[1], c[2], w], i * 4);
    });
    gl.uniform1i(u.uLeakN, all.length);
    gl.uniform4fv(u.uLeakGeo, geo);
    gl.uniform4fv(u.uLeakCol, lc);

    gl.uniform1f(u.uDust, num(P.dust, 0));
    gl.uniform1f(u.uDateOn, P.dateOn && this.hasDate ? 1 : 0);
    const r = this.dateRect;
    gl.uniform4f(u.uDateRect, r[0], r[1], Math.max(1e-6, r[2]), Math.max(1e-6, r[3]));

    const fg = this.frameGeo;
    const layout = P.layout;
    gl.uniform1f(u.uFrameOn, fg && layout && layout.draw ? 1 : 0);
    gl.uniform1f(u.uFrameFilm, layout && layout.filmBorder ? 1 : 0);
    gl.uniform2f(u.uFrameOrigin, fg ? fg.origin[0] : 0, fg ? fg.origin[1] : 0);
    gl.uniform2f(u.uFrameSize, fg ? Math.max(1, fg.size[0]) : 1, fg ? Math.max(1, fg.size[1]) : 1);

    // remapped lenses (grid / fisheye), axis vignette, slit banding, flash gel
    const RG = remapGeometry(P.camera, g.img, g.crop, num(P.seed, 1));
    gl.uniform1i(u.uMode, RG ? RG.mode : 0);
    gl.uniform1f(u.uTexK, num(g.texK, 1));
    if (RG && RG.mode === 1) {
      const A = new Float32Array(4 * GRID_MAX), B = new Float32Array(3 * GRID_MAX).fill(1);
      RG.cells.forEach((c, i) => { A.set([c.b[0], c.b[1], c.m, c.expo], i * 4); B.set(c.wb, i * 3); });
      gl.uniform2f(u.uGridN, RG.cols, RG.rows);
      gl.uniform4fv(u.uCellA, A);
      gl.uniform3fv(u.uCellB, B);
      gl.uniform3f(u.uGap, RG.gapCore, RG.gapFeather, RG.gapLuma);
    } else {
      gl.uniform2f(u.uGridN, 1, 1);
    }
    if (RG && RG.mode === 2) {
      gl.uniform4f(u.uFish, RG.R, RG.phi, RG.tanPhi, RG.rim);
      gl.uniform4f(u.uFishS, RG.sc[0], RG.sc[1], RG.sh[0], RG.sh[1]);
    } else {
      gl.uniform4f(u.uFish, 1, 1, 1, 0);
      gl.uniform4f(u.uFishS, 0, 0, 1, 1);
    }
    gl.uniform1f(u.uVigAxis, Lu.vigAxis);
    gl.uniform1f(u.uBand, Lu.band);
    gl.uniform1f(u.uSwirl, Lu.swirl);
    const gel = Array.isArray(P.gel) && P.gel.length >= 3 ? P.gel : null;
    if (gel && flash > 0) {
      const gl0 = 0.2126 * gel[0] + 0.7152 * gel[1] + 0.0722 * gel[2] || 1;
      gl.uniform4f(u.uGel, gel[0] / gl0, gel[1] / gl0, gel[2] / gl0, 1);
    } else {
      gl.uniform4f(u.uGel, 1, 1, 1, 0);
    }

    gl.uniform1f(u.uSplit, num(P.split, -1));
    gl.uniform1f(u.uShowOrig, P.showOriginal ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  onContextRestored(cb) {
    this._restoreCb = cb;
  }

  dispose() {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (!this.lost) {
      for (const k of Object.keys(this.tex)) if (this.tex[k]) gl.deleteTexture(this.tex[k]);
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.prog) gl.deleteProgram(this.prog);
    }
    this.tex = {};
    this.fbo = this.fboTex = null;
  }
}
