// C41 — Live image scopes (RGB Histogram, Luminance, RGB Parade) and interactive
// 4-channel Fritsch-Carlson Tone Curve editor.

import { monotoneCurve } from './film-transform.js';
import { computeHistogram, computeWaveform, CURVE_PRESETS } from './image-ops.js';
import { h } from './ui.js';

const SCOPE_MODES = [
  { id: 'rgb', label: 'RGB' },
  { id: 'luma', label: 'LUMA' },
  { id: 'parade', label: 'PARADE' },
];

/**
 * Live floating scope widget (RGB Histogram / Luminance / RGB Parade Waveform).
 * Call `updateFromCanvas(srcCanvas)` after renders (throttled internally).
 */
export class ScopeView {
  constructor({ mode = 'rgb', onModeChange = null } = {}) {
    this.mode = SCOPE_MODES.some((m) => m.id === mode) ? mode : 'rgb';
    this.onModeChange = onModeChange;
    this.lastHist = null;
    this.lastWave = null;
    this._sampleCanvas = document.createElement('canvas');
    this._sampleCanvas.width = 160;
    this._sampleCanvas.height = 100;
    this._sampleCtx = this._sampleCanvas.getContext('2d', { willReadFrequently: true });

    this.canvas = h('canvas', { class: 'scope-canvas', width: '320', height: '140' });
    this.modeLabel = h('span', { class: 'scope-mode', text: this._modeObj().label });
    this.clipSh = h('span', { class: 'scope-clip scope-clip-sh', title: 'Shadow clipping' });
    this.clipHi = h('span', { class: 'scope-clip scope-clip-hi', title: 'Highlight clipping' });
    this.el = h('button', {
      class: 'scope-card',
      type: 'button',
      'aria-label': 'Live image scope — tap to switch mode',
    },
      h('div', { class: 'scope-head' },
        this.clipSh,
        this.modeLabel,
        this.clipHi),
      this.canvas);

    this.el.addEventListener('click', () => this.cycleMode());
  }

  _modeObj() {
    return SCOPE_MODES.find((m) => m.id === this.mode) || SCOPE_MODES[0];
  }

  cycleMode() {
    const idx = SCOPE_MODES.findIndex((m) => m.id === this.mode);
    this.mode = SCOPE_MODES[(idx + 1) % SCOPE_MODES.length].id;
    this.modeLabel.textContent = this._modeObj().label;
    this.onModeChange?.(this.mode);
    this.paint();
  }

  updateFromCanvas(src) {
    if (!src || !src.width || !src.height) return null;
    const sw = 160, sh = Math.max(40, Math.min(120, Math.round(160 * src.height / src.width)));
    if (this._sampleCanvas.width !== sw || this._sampleCanvas.height !== sh) {
      this._sampleCanvas.width = sw;
      this._sampleCanvas.height = sh;
    }
    this._sampleCtx.drawImage(src, 0, 0, sw, sh);
    const data = this._sampleCtx.getImageData(0, 0, sw, sh).data;
    this.lastHist = computeHistogram(data, sw, sh);
    if (this.mode === 'parade') {
      this.lastWave = computeWaveform(data, sw, sh, 72, 48);
    } else {
      this._lastRgba = data;
      this._lastW = sw;
      this._lastH = sh;
      this.lastWave = null;
    }
    this.paint();
    return this.lastHist;
  }

  paint() {
    const cv = this.canvas;
    const w = cv.width, hh = cv.height;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, hh);

    // Subtle darkroom reference grid
    g.strokeStyle = 'rgba(255, 240, 220, 0.08)';
    g.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const x = Math.round((w * i) / 4) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hh); g.stroke();
    }
    for (let i = 1; i <= 2; i++) {
      const y = Math.round((hh * i) / 3) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }

    if (!this.lastHist) return;

    this.clipSh.classList.toggle('is-lit', this.lastHist.clippedShadows > 0.005);
    this.clipHi.classList.toggle('is-lit', this.lastHist.clippedHighlights > 0.005);

    if (this.mode === 'parade') {
      if (!this.lastWave && this._lastRgba) {
        this.lastWave = computeWaveform(this._lastRgba, this._lastW, this._lastH, 72, 48);
      }
      if (this.lastWave) this._paintParade(g, w, hh, this.lastWave);
      return;
    }

    const hist = this.lastHist;
    const maxV = Math.max(1, hist.maxVal);
    const drawCurve = (bins, fill, stroke, lineW = 1.5) => {
      g.beginPath();
      g.moveTo(0, hh);
      for (let i = 0; i < 256; i++) {
        // 3-bin box smoothing for crisp vector feel
        const v = (bins[Math.max(0, i - 1)] + bins[i] * 2 + bins[Math.min(255, i + 1)]) * 0.25;
        const norm = Math.min(1, Math.pow(v / maxV, 0.85));
        const x = (i / 255) * w;
        const y = hh - norm * (hh - 6) - 1;
        g.lineTo(x, y);
      }
      g.lineTo(w, hh);
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = lineW; g.stroke(); }
    };

    if (this.mode === 'rgb') {
      g.save();
      g.globalCompositeOperation = 'screen';
      drawCurve(hist.r, 'rgba(255, 76, 76, 0.34)', 'rgba(255, 98, 92, 0.85)', 1.2);
      drawCurve(hist.g, 'rgba(68, 218, 120, 0.32)', 'rgba(84, 232, 136, 0.85)', 1.2);
      drawCurve(hist.b, 'rgba(72, 148, 255, 0.36)', 'rgba(92, 168, 255, 0.90)', 1.2);
      g.restore();
      drawCurve(hist.luma, null, 'rgba(245, 238, 228, 0.42)', 1);
    } else {
      const grad = g.createLinearGradient(0, 0, 0, hh);
      grad.addColorStop(0, 'rgba(244, 168, 58, 0.55)');
      grad.addColorStop(1, 'rgba(244, 168, 58, 0.06)');
      drawCurve(hist.luma, grad, 'rgba(245, 238, 228, 0.9)', 1.5);
    }
  }

  _paintParade(g, w, hh, wave) {
    const { r, g: gg, b, cols, rows, maxVal } = wave;
    const pad = 4;
    const colW = (w - pad * 2) / 3;
    const panels = [
      { data: r, color: [255, 92, 84], x0: 0 },
      { data: gg, color: [76, 224, 128], x0: colW + pad },
      { data: b, color: [86, 162, 255], x0: (colW + pad) * 2 },
    ];
    const cellW = colW / cols;
    const cellH = hh / rows;
    const normDiv = Math.max(1, Math.sqrt(maxVal * 0.65));

    for (const p of panels) {
      const [cr, cg, cb] = p.color;
      for (let ry = 0; ry < rows; ry++) {
        const y = hh - (ry + 1) * cellH;
        const rowOff = ry * cols;
        for (let cx = 0; cx < cols; cx++) {
          const val = p.data[rowOff + cx];
          if (!val) continue;
          const a = Math.min(0.95, Math.sqrt(val) / normDiv);
          g.fillStyle = `rgba(${cr},${cg},${cb},${a.toFixed(2)})`;
          g.fillRect(p.x0 + cx * cellW, y, Math.ceil(cellW), Math.ceil(cellH));
        }
      }
    }
  }
}

/* ----------------------------------------------------------- ToneCurveEditor */

const CHANNELS = [
  { id: 'rgb', label: 'RGB', color: '#f4efe8', glow: 'rgba(244, 168, 58, 0.35)' },
  { id: 'r',   label: 'R',   color: '#ff645c', glow: 'rgba(255, 100, 92, 0.35)' },
  { id: 'g',   label: 'G',   color: '#52d97c', glow: 'rgba(82, 217, 124, 0.35)' },
  { id: 'b',   label: 'B',   color: '#56a3ff', glow: 'rgba(86, 163, 255, 0.35)' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cloneCurves = (c) => JSON.parse(JSON.stringify(c));

/**
 * Interactive 4-channel (RGB / R / G / B) Fritsch-Carlson Monotone Cubic Tone Curve editor.
 */
export class ToneCurveEditor {
  constructor({ curves, onInput, onChange }) {
    this.curves = cloneCurves(curves);
    this.channel = 'rgb';
    this.onInput = onInput || (() => {});
    this.onChange = onChange || (() => {});
    this.hist = null;
    this._dragIdx = -1;
    this._activeIdx = -1;
    this._lastTap = { t: 0, idx: -1 };

    // Channel selector buttons
    this.chanBtns = new Map();
    const chanBar = h('div', { class: 'curve-chans', role: 'tablist', 'aria-label': 'Curve channel' });
    for (const ch of CHANNELS) {
      const b = h('button', {
        class: `curve-chan curve-chan-${ch.id}`,
        type: 'button',
        role: 'tab',
        'aria-selected': String(ch.id === this.channel),
      }, h('i', { class: 'curve-dot', style: { background: ch.color } }), ch.label);
      b.addEventListener('click', () => this.setChannel(ch.id));
      this.chanBtns.set(ch.id, b);
      chanBar.append(b);
    }

    this.resetChBtn = h('button', { class: 'curve-reset-btn', type: 'button', text: 'Reset' });
    this.resetChBtn.addEventListener('click', () => {
      this.curves[this.channel] = [[0, 0], [1, 1]];
      this._activeIdx = -1;
      this._syncChannelBadges();
      this.paint();
      this.onInput(cloneCurves(this.curves));
      this.onChange(cloneCurves(this.curves));
    });

    this.canvas = h('canvas', { class: 'curve-canvas', width: '560', height: '320' });

    // Curve quick presets
    const presetBar = h('div', { class: 'curve-presets' });
    for (const pr of CURVE_PRESETS) {
      const b = h('button', { class: 'curve-preset', type: 'button', text: pr.label });
      b.addEventListener('click', () => {
        this.curves[this.channel] = pr.pts.map((p) => p.slice());
        this._activeIdx = -1;
        this._syncChannelBadges();
        this.paint();
        this.onInput(cloneCurves(this.curves));
        this.onChange(cloneCurves(this.curves));
      });
      presetBar.append(b);
    }

    this.el = h('div', { class: 'curve-editor' },
      h('div', { class: 'curve-top' }, chanBar, this.resetChBtn),
      h('div', { class: 'curve-stage' }, this.canvas),
      presetBar,
      h('p', { class: 'curve-hint', text: 'Tap to add point · Drag to shape · Double-tap point to remove' }));

    this._bind();
    this._syncChannelBadges();
    this.paint();
  }

  setChannel(ch) {
    if (!this.chanBtns.has(ch)) return;
    this.channel = ch;
    this._activeIdx = -1;
    for (const [k, b] of this.chanBtns) b.setAttribute('aria-selected', String(k === ch));
    this.paint();
  }

  set(curves) {
    this.curves = cloneCurves(curves);
    this._activeIdx = -1;
    this._syncChannelBadges();
    this.paint();
  }

  setHistogram(hist) {
    this.hist = hist;
    this.paint();
  }

  _isChanModified(ch) {
    const pts = this.curves[ch] || [];
    return pts.some(([x, y]) => Math.abs(x - y) > 0.004);
  }

  _syncChannelBadges() {
    for (const ch of CHANNELS) {
      this.chanBtns.get(ch.id)?.classList.toggle('is-mod', this._isChanModified(ch.id));
    }
  }

  _pts() {
    let pts = this.curves[this.channel];
    if (!Array.isArray(pts) || pts.length < 2) {
      pts = [[0, 0], [1, 1]];
      this.curves[this.channel] = pts;
    }
    return pts;
  }

  _pad() { return 18; }

  _toNorm(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const pad = (this._pad() / this.canvas.width) * r.width;
    const x = clamp((clientX - r.left - pad) / Math.max(1, r.width - pad * 2), 0, 1);
    const y = clamp(1 - (clientY - r.top - pad) / Math.max(1, r.height - pad * 2), 0, 1);
    return [x, y];
  }

  _toCanvas(nx, ny) {
    const pad = this._pad();
    const w = this.canvas.width - pad * 2;
    const hh = this.canvas.height - pad * 2;
    return [pad + nx * w, pad + (1 - ny) * hh];
  }

  _bind() {
    const cv = this.canvas;
    let moved = false;

    cv.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const [nx, ny] = this._toNorm(e.clientX, e.clientY);
      const pts = this._pts();

      // Hit-test existing control points (generous touch radius)
      let hit = -1, bestD = 0.095;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - nx, pts[i][1] - ny);
        if (d < bestD) { bestD = d; hit = i; }
      }

      const now = performance.now();
      if (hit >= 0) {
        // Double-tap interior point to remove it
        if (hit > 0 && hit < pts.length - 1 && this._lastTap.idx === hit && now - this._lastTap.t < 340) {
          pts.splice(hit, 1);
          this._dragIdx = -1;
          this._activeIdx = -1;
          this._lastTap = { t: 0, idx: -1 };
          this._syncChannelBadges();
          this.paint();
          this.onInput(cloneCurves(this.curves));
          this.onChange(cloneCurves(this.curves));
          return;
        }
        this._lastTap = { t: now, idx: hit };
        this._dragIdx = hit;
        this._activeIdx = hit;
      } else if (pts.length < 9) {
        // Insert new control point sorted by x
        const pt = [clamp(nx, 0.02, 0.98), ny];
        pts.push(pt);
        pts.sort((a, b) => a[0] - b[0]);
        const idx = pts.indexOf(pt);
        this._dragIdx = idx;
        this._activeIdx = idx;
        this._lastTap = { t: now, idx };
        this._syncChannelBadges();
        this.paint();
        this.onInput(cloneCurves(this.curves));
      }
      moved = false;
      this.paint();
    });

    cv.addEventListener('pointermove', (e) => {
      if (this._dragIdx < 0) return;
      const pts = this._pts();
      const idx = this._dragIdx;
      const [nx, ny] = this._toNorm(e.clientX, e.clientY);
      if (idx === 0) {
        pts[0][0] = 0;
        pts[0][1] = clamp(ny, 0, 1);
      } else if (idx === pts.length - 1) {
        pts[idx][0] = 1;
        pts[idx][1] = clamp(ny, 0, 1);
      } else {
        const lo = pts[idx - 1][0] + 0.025;
        const hi = pts[idx + 1][0] - 0.025;
        pts[idx][0] = clamp(nx, lo, hi);
        pts[idx][1] = clamp(ny, 0, 1);
      }
      moved = true;
      this._syncChannelBadges();
      this.paint();
      this.onInput(cloneCurves(this.curves));
    });

    const end = () => {
      if (this._dragIdx < 0) return;
      this._dragIdx = -1;
      if (moved) this.onChange(cloneCurves(this.curves));
      this.paint();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  paint() {
    const cv = this.canvas;
    const W = cv.width, H = cv.height;
    const pad = this._pad();
    const w = W - pad * 2, hh = H - pad * 2;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);

    // Inner chart area background
    g.fillStyle = 'rgba(8, 7, 6, 0.72)';
    g.fillRect(pad, pad, w, hh);

    // Live histogram backdrop inside the curve box
    if (this.hist) {
      const bins = this.channel === 'rgb' ? this.hist.luma : this.hist[this.channel];
      const maxV = Math.max(1, this.hist.maxVal);
      if (bins) {
        g.beginPath();
        g.moveTo(pad, pad + hh);
        for (let i = 0; i < 256; i++) {
          const norm = Math.min(1, Math.pow(bins[i] / maxV, 0.85));
          g.lineTo(pad + (i / 255) * w, pad + hh - norm * hh * 0.86);
        }
        g.lineTo(pad + w, pad + hh);
        g.closePath();
        g.fillStyle = this.channel === 'rgb' ? 'rgba(244, 232, 214, 0.10)'
          : this.channel === 'r' ? 'rgba(255, 92, 84, 0.14)'
            : this.channel === 'g' ? 'rgba(82, 217, 124, 0.14)'
              : 'rgba(86, 163, 255, 0.16)';
        g.fill();
      }
    }

    // 4×4 optical grid
    g.strokeStyle = 'rgba(255, 236, 210, 0.09)';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = Math.round(pad + (w * i) / 4) + 0.5;
      const y = Math.round(pad + (hh * i) / 4) + 0.5;
      g.beginPath(); g.moveTo(x, pad); g.lineTo(x, pad + hh); g.stroke();
      g.beginPath(); g.moveTo(pad, y); g.lineTo(pad + w, y); g.stroke();
    }

    // Identity diagonal reference line
    g.save();
    g.setLineDash([5, 5]);
    g.strokeStyle = 'rgba(255, 236, 210, 0.18)';
    g.beginPath(); g.moveTo(pad, pad + hh); g.lineTo(pad + w, pad); g.stroke();
    g.restore();

    // Draw inactive modified channels dimly for context
    for (const ch of CHANNELS) {
      if (ch.id === this.channel || !this._isChanModified(ch.id)) continue;
      const fn = monotoneCurve(this.curves[ch.id]);
      if (!fn) continue;
      g.beginPath();
      for (let i = 0; i <= 128; i++) {
        const u = i / 128;
        const [px, py] = this._toCanvas(u, clamp(fn(u), 0, 1));
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokeStyle = ch.color;
      g.globalAlpha = 0.28;
      g.lineWidth = 1.6;
      g.stroke();
      g.globalAlpha = 1;
    }

    // Active channel curve
    const chObj = CHANNELS.find((c) => c.id === this.channel) || CHANNELS[0];
    const pts = this._pts();
    const fn = monotoneCurve(pts);
    g.save();
    g.shadowColor = chObj.glow;
    g.shadowBlur = 10;
    g.beginPath();
    for (let i = 0; i <= 160; i++) {
      const u = i / 160;
      const y = fn ? clamp(fn(u), 0, 1) : u;
      const [px, py] = this._toCanvas(u, y);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokeStyle = chObj.color;
    g.lineWidth = 3;
    g.stroke();
    g.restore();

    // Control points
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = this._toCanvas(pts[i][0], pts[i][1]);
      const active = i === this._activeIdx || i === this._dragIdx;
      g.beginPath();
      g.arc(px, py, active ? 9.5 : 7, 0, Math.PI * 2);
      g.fillStyle = active ? chObj.color : '#161310';
      g.fill();
      g.lineWidth = 2.6;
      g.strokeStyle = chObj.color;
      g.stroke();
    }
  }
}
