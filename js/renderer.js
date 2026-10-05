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

uniform sampler2D uSrc, uHmap, uBmap, uDustTex, uDateTex;
uniform sampler3D uLut;

uniform vec2 uFull, uSrcOrigin, uSrcSize, uOutOrigin, uOutSize;
uniform float uFlip;
uniform float uScale;      // target px per full-res px
uniform float uRefShort;   // short edge of the image in target px (fullShort * scale)
uniform float uLutN, uHeadroom;

uniform float uSharp, uCornerSoft, uCA, uVig, uVigHard;
uniform vec3 uWB;
uniform float uExpo;
uniform vec3 uHalCol;
uniform float uHal, uBloom;
uniform vec3 uFlare;       // x, y (normalised), strength (final)
uniform float uFilmAmt, uContrast;
uniform vec3 uGrain;       // amplitude, cell size (target px), colour mix
uniform uint uSeed;
uniform int uLeakN;
uniform vec4 uLeakGeo[3];  // x, y, r, stretch
uniform vec3 uLeakCol[3];
uniform float uLeak, uDust, uDateOn;
uniform vec4 uDateRect;
uniform float uSplit, uShowOrig;

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 srcAt(vec2 p) {
  p = clamp(p, vec2(0.5), uFull - 0.5);
  return texture(uSrc, (p - uSrcOrigin) / uSrcSize).rgb;
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
  ivec2 c = ivec2(i) + ivec2(4096);
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

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = uOutOrigin + vec2(fc.x, uFlip > 0.5 ? uOutSize.y - fc.y : fc.y);
  vec2 n = p / uFull;
  vec2 ctr = uFull * 0.5;
  float d = length(p - ctr) / length(ctr);   // 0 centre .. 1 corner

  vec3 c0 = srcAt(p);
  if (uShowOrig > 0.5 || n.x < uSplit) {
    outColor = vec4(c0, 1.0);
    return;
  }

  // ---- lens: sharpen / soften with corner falloff ----
  vec3 col = c0;
  if (uSharp != 0.0 || uCornerSoft > 0.0) {
    float d2 = d * d;
    float r = uRefShort * 0.0007 * (1.0 + 2.0 * max(0.0, -uSharp) + 3.0 * uCornerSoft * d2);
    r = min(r, float(${PAD}) * uScale / 1.5);
    vec3 s1 = vec3(0.0), s2 = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 dir2 = vec2(cos(a + 0.3926991), sin(a + 0.3926991));
      s1 += srcAt(p + dir * r * 0.75);
      s2 += srcAt(p + dir2 * r * 1.5);
    }
    vec3 blur = c0 * 0.2 + s1 * (0.5 / 8.0) + s2 * (0.3 / 8.0);
    float eff = uSharp - uCornerSoft * d2 * 1.2;
    col = eff > 0.0 ? c0 + (c0 - blur) * eff * 1.5 : mix(c0, blur, min(1.0, -eff));
    col = max(col, 0.0);
  }
  // ---- lateral chromatic aberration ----
  if (uCA > 0.0) {
    vec2 off = (p - ctr) * uCA * 0.0025;
    float lo = length(off), mx = 40.0 * uScale;
    if (lo > mx) off *= mx / lo;
    col.r += srcAt(p + off).r - c0.r;
    col.b += srcAt(p - off).b - c0.b;
  }

  // ---- linear light ----
  vec3 lin = toLin(col) * uWB * uExpo;
  lin *= exp2(-uVig * pow(d, uVigHard));

  // halation + bloom
  vec4 h = texture(uHmap, n);
  // halation is light scattered back from the film base: it shows as a glow AROUND highlights,
  // so suppress it inside the (already saturated) highlight itself
  float hiSelf = smoothstep(0.5, 1.0, dot(lin, LUMA));
  lin += uHalCol * (0.6 * h.r + 0.4 * h.g) * uHal * 2.0 * uExpo * (1.0 - 0.85 * hiSelf);
  lin += texture(uBmap, n).rgb * uBloom * 1.5 * uExpo;

  // flare
  if (uFlare.z > 0.0) {
    vec2 q = (p - ctr) / uRefShort;
    vec2 fq = (uFlare.xy * uFull - ctr) / uRefShort;
    float fd = length(q - fq);
    vec3 fl = vec3(1.0, 0.78, 0.55) * (exp(-fd * fd / (0.08 * 0.08)) * 1.4 + exp(-fd * fd / (0.35 * 0.35)) * 0.12);
    // ghosts along the line through the centre
    vec3 ghosts = vec3(0.0);
    float ks[4] = float[4](-0.35, -0.75, -1.25, 0.45);
    float rs[4] = float[4](0.05, 0.085, 0.035, 0.06);
    vec3 ts[4] = vec3[4](vec3(0.35, 0.9, 0.45), vec3(0.85, 0.4, 0.9), vec3(1.0, 0.7, 0.3), vec3(0.4, 0.6, 1.0));
    for (int i = 0; i < 4; i++) {
      float gd = length(q - fq * ks[i]);
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
  vec3 c = mix(base, lut, uFilmAmt);

  // post contrast (user + lens)
  if (uContrast != 0.0) {
    vec3 cc = clamp(c, 0.0, 1.0);
    c = cc + uContrast * (cc * cc * (3.0 - 2.0 * cc) - cc);
  }

  // ---- grain ----
  if (uGrain.x > 0.0) {
    float L = clamp(dot(c, LUMA), 0.0, 1.0);
    float w = 0.15 + 0.85 * clamp(4.0 * L * (1.0 - L), 0.0, 1.0);
    float m = grainAt(p, 0u);
    vec3 g = mix(vec3(m), vec3(m, grainAt(p, 1u), grainAt(p, 2u)), uGrain.z);
    c += g * uGrain.x * w;
  }
  c = clamp(c, 0.0, 1.0);

  // ---- light leaks (screen) ----
  if (uLeak > 0.0) {
    vec3 lk = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      if (i >= uLeakN) break;
      vec4 g = uLeakGeo[i];
      vec2 q = (p - g.xy * uFull) / uRefShort;
      q.y /= max(g.w, 0.01);
      float v = exp(-dot(q, q) / max(g.z * g.z, 1e-4));
      lk += uLeakCol[i] * v + vec3(1.0, 0.85, 0.6) * pow(v, 4.0) * 0.35;
    }
    c = screen(c, lk * uLeak);
  }

  // ---- dust ----
  if (uDust > 0.0) {
    vec3 dt = texture(uDustTex, n).rgb;
    c = mix(c, vec3(1.0), clamp(dt.r * uDust, 0.0, 1.0));
    c = mix(c, vec3(0.03), clamp(dt.g * 0.8 * uDust, 0.0, 1.0));
    c = mix(c, vec3(1.0), clamp(dt.b * uDust, 0.0, 1.0));
  }

  // ---- date stamp (screen) ----
  if (uDateOn > 0.5) {
    vec2 du = (n - uDateRect.xy) / uDateRect.zw;
    if (all(greaterThanEqual(du, vec2(0.0))) && all(lessThanEqual(du, vec2(1.0)))) {
      c = screen(c, texture(uDateTex, du).rgb);
    }
  }

  // ---- dither ----
  float dz = float(pcg(uint(p.x) * 7919u ^ pcg(uint(p.y) + 0x9e3779b9u))) / 4294967295.0 - 0.5;
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
  'uSrc', 'uHmap', 'uBmap', 'uDustTex', 'uDateTex', 'uLut',
  'uFull', 'uSrcOrigin', 'uSrcSize', 'uOutOrigin', 'uOutSize', 'uFlip', 'uScale', 'uRefShort',
  'uLutN', 'uHeadroom', 'uSharp', 'uCornerSoft', 'uCA', 'uVig', 'uVigHard', 'uWB', 'uExpo',
  'uHalCol', 'uHal', 'uBloom', 'uFlare', 'uFilmAmt', 'uContrast', 'uGrain', 'uSeed',
  'uLeakN', 'uLeakGeo', 'uLeakCol', 'uLeak', 'uDust', 'uDateOn', 'uDateRect', 'uSplit', 'uShowOrig',
];
// texture units
const U_SRC = 0, U_LUT = 1, U_HMAP = 2, U_BMAP = 3, U_DUST = 4, U_DATE = 5;

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

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
    this.tex = { src: black(), hmap: black(), bmap: black(), dust: black(), date: black(), lut: null };
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

  setSource(src) {
    this._upload('src', src);
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

  setParams(p) {
    this.params = p || {};
  }

  renderPreview() {
    if (this.lost) return;
    const gl = this.gl;
    const [w, h] = this.srcSize;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    const fullShort = num(this.params.fullShort, Math.min(w, h));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._draw({
      srcOrigin: [0, 0], srcSize: [w, h], full: [w, h], outOrigin: [0, 0], outSize: [w, h],
      scale: Math.min(w, h) / fullShort, flip: true,
    });
  }

  renderRegion({ srcOrigin, srcSize, full, outOrigin, outSize, scale }) {
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
    this._draw({ srcOrigin, srcSize, full, outOrigin, outSize, scale: num(scale, 1), flip: false });
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  _draw(g) {
    const gl = this.gl, u = this.u, P = this.params;
    const film = P.film || {}, fp = film.params || film;
    const cam = (P.camera && P.camera.params) || {};
    const formatScale = num(P.camera && P.camera.formatScale, 1);
    const filmAmt = num(P.filmAmt, 1), camAmt = num(P.camAmt, 1);
    const scale = g.scale;
    const fullShort = num(P.fullShort, Math.min(g.full[0], g.full[1]) / scale);
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

    gl.uniform2f(u.uFull, g.full[0], g.full[1]);
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
    gl.uniform1f(u.uSharp, num(cam.sharpness, 0) * camAmt);
    gl.uniform1f(u.uCornerSoft, num(cam.cornerSoft, 0) * camAmt);
    gl.uniform1f(u.uCA, num(cam.ca, 0) * camAmt);
    gl.uniform1f(u.uVig, num(cam.vignette, 0) * camAmt * 1.6);
    gl.uniform1f(u.uVigHard, num(cam.vignetteHardness, 2));

    // white balance: user warmth/tint + lens coating warmth, luminance-normalised gains
    const wt = 0.25 * num(P.warmth, 0) + num(cam.warmth, 0) * camAmt;
    const tn = 0.2 * num(P.tint, 0);
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
    gl.uniform1f(u.uBloom, num(cam.bloom, 0) * camAmt + num(fp.bloom, FILM_DEFAULTS.bloom) * filmAmt);

    // flare
    const fpnt = P.flarePoint || { x: 0.5, y: 0.3, strength: 0 };
    const fstr = num(cam.flare, 0) * camAmt * num(P.flare, 1) * (0.3 + 0.7 * num(fpnt.strength, 0));
    gl.uniform3f(u.uFlare, num(fpnt.x, 0.5), num(fpnt.y, 0.3), fstr);

    gl.uniform1f(u.uFilmAmt, filmAmt);
    gl.uniform1f(u.uContrast, num(P.contrast, 0) + num(cam.contrast, 0) * camAmt);

    // grain
    const gr = { ...FILM_DEFAULTS.grain, ...(fp.grain || {}) };
    const rawCell = fullShort * 0.00045 * num(gr.size, 1) / formatScale * scale;
    const cell = Math.max(1, rawCell);
    // When the true grain cell is sub-pixel (downscaled preview / export), several grains average
    // into one pixel: attenuate (sqrt — between "honest" averaging and keeping grain visible).
    const atten = rawCell < 1 ? Math.max(0.5, Math.sqrt(rawCell)) : 1;
    gl.uniform3f(u.uGrain, num(gr.amount, 0) * num(P.grain, 1) * 0.12 * atten, cell, num(gr.color, 0));
    gl.uniform1ui(u.uSeed, (num(P.seed, 1) >>> 0));

    // leaks
    const leaks = Array.isArray(P.leaks) ? P.leaks.slice(0, 3) : [];
    const geo = new Float32Array(12), lc = new Float32Array(9);
    leaks.forEach((l, i) => {
      geo.set([num(l.x, 0), num(l.y, 0), num(l.r, 0.3), num(l.stretch, 1)], i * 4);
      const c = l.color || [1, 0.5, 0.1];
      lc.set([c[0], c[1], c[2]], i * 3);
    });
    gl.uniform1i(u.uLeakN, leaks.length);
    gl.uniform4fv(u.uLeakGeo, geo);
    gl.uniform3fv(u.uLeakCol, lc);
    gl.uniform1f(u.uLeak, leaks.length ? num(P.leak, 0) : 0);

    gl.uniform1f(u.uDust, num(P.dust, 0));
    gl.uniform1f(u.uDateOn, P.dateOn && this.hasDate ? 1 : 0);
    const r = this.dateRect;
    gl.uniform4f(u.uDateRect, r[0], r[1], Math.max(1e-6, r[2]), Math.max(1e-6, r[3]));
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
