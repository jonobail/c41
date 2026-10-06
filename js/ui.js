// C41 — reusable UI pieces: Slider, Sheet, toast, ChipGroup, Toggle, icons.
// No dependencies. All components return/own a root element (`.el`).

/* ------------------------------------------------------------------ icons */

const S = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  image: S('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5.2-5.2L6 19.5"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  camera: S('<path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/>'),
  compare: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 2.5v19"/><path d="M12 4.5h6.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H12z" fill="currentColor" stroke="none" opacity=".35"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>'),
  shuffle: S('<path d="M3 7h3.5c4.5 0 6.5 10 11 10H21"/><path d="M3 17h3.5c1.8 0 3.1-1.6 4.2-3.6M13.3 9.6C14.4 8.1 15.7 7 17.5 7H21"/><path d="M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  share: S('<path d="M12 3.5v12M7.5 8L12 3.5 16.5 8"/><path d="M6 11.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7.5a1 1 0 0 0-1-1h-1"/>'),
  download: S('<path d="M12 3.5v12M7.5 11L12 15.5 16.5 11"/><path d="M4.5 19.5h15"/>'),
  reset: S('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4h4"/>'),
  film: S('<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 3v18M16 3v18M4 7.5h4M4 12h4M4 16.5h4M16 7.5h4M16 12h4M16 16.5h4"/>'),
  sliders: S('<path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11M20 18h-1"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  wand: S('<path d="M4 20L15 9"/><path d="M13.5 7.5l3 3"/><path d="M17.5 2.8l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/><path d="M8 3.5l.5 1.3 1.3.5-1.3.5L8 7.1l-.5-1.3-1.3-.5 1.3-.5z"/><path d="M19.5 13l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>'),
  more: S('<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>'),
  trash: S('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>'),
  sparkle: S('<path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6-5.6-1.9 5.6-1.9z"/>'),
  // Camera bodies — used on camera cards (wider viewBox for nicer proportions)
  'body-slr': S('<path d="M6 13h36a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3z"/><path d="M16 13l3.5-6h9L32 13"/><circle cx="24" cy="23.5" r="7"/><circle cx="24" cy="23.5" r="3.6"/><path d="M7 10h5"/><rect x="36" y="16" width="5" height="3" rx="1"/>', '0 0 48 40'),
  'body-rangefinder': S('<rect x="3" y="11" width="42" height="22" rx="3"/><circle cx="20" cy="22" r="7.5"/><circle cx="20" cy="22" r="4"/><rect x="34" y="14.5" width="7" height="4.5" rx="1"/><rect x="5.5" y="14.5" width="5" height="3.5" rx="1"/><path d="M33 8h7"/>', '0 0 48 40'),
  'body-compact': S('<rect x="4" y="10" width="40" height="22" rx="7"/><circle cx="28" cy="21" r="6"/><circle cx="28" cy="21" r="2.6"/><rect x="9" y="14" width="7" height="4" rx="1"/><path d="M36 7h5"/><circle cx="12" cy="25" r="1.2"/>', '0 0 48 40'),
  'body-medium': S('<rect x="9" y="12" width="30" height="24" rx="2"/><path d="M13 12V5h22v7"/><circle cx="24" cy="25" r="7"/><circle cx="24" cy="25" r="3.5"/><path d="M39 18h4M5 18h4"/>', '0 0 48 40'),
  'body-toy': S('<rect x="6" y="12" width="36" height="21" rx="4"/><circle cx="24" cy="22.5" r="8"/><circle cx="24" cy="22.5" r="4.5"/><path d="M14 12l3-5h14l3 5"/><circle cx="36" cy="16" r="1.4"/>', '0 0 48 40'),
  'body-none': S('<rect x="6" y="9" width="36" height="24" rx="2.5" stroke-dasharray="3 3"/><path d="M17 21h14"/>', '0 0 48 40'),
};

export function icon(name, cls = '') {
  const svg = ICONS[name] || ICONS.image;
  return cls ? svg.replace('<svg ', `<svg class="${cls}" `) : svg;
}

/* --------------------------------------------------------------- helpers */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- Slider */

/**
 * Touch slider with RELATIVE drag (grab anywhere on the track, the value moves by
 * the finger's delta — never jumps), bipolar fill for ±ranges, double-tap reset.
 *
 * new Slider({ label, min, max, step, value, defaultValue, bipolar, format, onInput, onChange })
 */
export class Slider {
  constructor(opts) {
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 1;
    this.step = opts.step ?? 0.01;
    this.defaultValue = opts.defaultValue ?? (opts.bipolar ? 0 : this.min);
    this.bipolar = !!opts.bipolar;
    this.format = opts.format || ((v) => v.toFixed(2));
    this.onInput = opts.onInput || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.sensitivity = opts.sensitivity ?? 1; // 1 = full track width spans full range
    this.value = this._quant(opts.value ?? this.defaultValue);

    this.readout = h('output', { class: 'slider-value' });
    this.head = h('div', { class: 'slider-head' },
      h('span', { class: 'slider-label', text: opts.label || '' }),
      h('span', { class: 'slider-spacer' }),
      this.readout);
    this.fill = h('div', { class: 'slider-fill' });
    this.thumb = h('div', { class: 'slider-thumb' });
    const ticks = h('div', { class: 'slider-ticks', 'aria-hidden': 'true' });
    this.track = h('div', {
      class: 'slider-track' + (this.bipolar ? ' is-bipolar' : ''),
      role: 'slider',
      tabindex: '0',
      'aria-label': opts.label || '',
      'aria-valuemin': String(this.min),
      'aria-valuemax': String(this.max),
    }, h('div', { class: 'slider-rail' }, this.fill), ticks, this.thumb);
    if (this.bipolar) ticks.append(h('i', { class: 'tick-centre' }));
    this.el = h('div', { class: 'slider' }, this.head, this.track);

    this._bind();
    this._paint();
  }

  _quant(v) {
    const s = this.step;
    v = clamp(v, this.min, this.max);
    return s ? Math.round(v / s) * s : v;
  }

  set(v, { emit = false, commit = false } = {}) {
    const q = this._quant(v);
    const changed = Math.abs(q - this.value) > 1e-9;
    this.value = q;
    this._paint();
    if (emit && changed) this.onInput(this.value);
    if (commit) this.onChange(this.value);
  }

  reset() {
    this.set(this.defaultValue, { emit: true, commit: true });
    this.el.classList.add('did-reset');
    setTimeout(() => this.el.classList.remove('did-reset'), 350);
  }

  _frac(v) { return (v - this.min) / (this.max - this.min || 1); }

  _paint() {
    const f = this._frac(this.value);
    if (this.bipolar) {
      const c = this._frac(clamp(0, this.min, this.max));
      const a = Math.min(c, f), b = Math.max(c, f);
      this.fill.style.left = `${a * 100}%`;
      this.fill.style.width = `${(b - a) * 100}%`;
    } else {
      this.fill.style.left = '0%';
      this.fill.style.width = `${f * 100}%`;
    }
    this.thumb.style.left = `${f * 100}%`;
    const txt = this.format(this.value);
    this.readout.textContent = txt;
    this.track.setAttribute('aria-valuenow', String(+this.value.toFixed(4)));
    this.track.setAttribute('aria-valuetext', txt);
    this.el.classList.toggle('is-default', Math.abs(this.value - this.defaultValue) < 1e-9);
  }

  _bind() {
    const t = this.track;
    let drag = null;
    let lastTap = 0;

    t.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: this.value, w: t.getBoundingClientRect().width || 1, engaged: false, moved: 0 };
      try { t.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.el.classList.add('is-active');
    });
    t.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      drag.moved = Math.max(drag.moved, Math.abs(dx), Math.abs(e.clientY - drag.y0));
      if (!drag.engaged) {
        if (Math.abs(dx) < 4) return;
        drag.engaged = true;
        drag.x0 = e.clientX; // start from here so the slop doesn't jump the value
        return;
      }
      // Fine control: dragging vertically away from the track slows the slider down
      // (like iOS scrubbing) — up to 8x finer.
      const off = Math.abs(e.clientY - drag.y0);
      const fine = off > 60 ? clamp(1 - (off - 60) / 200, 0.125, 1) : 1;
      if (fine !== drag.fine) {
        // rebase so changing speed doesn't jump
        if (drag.fine != null) { drag.v0 = this.value; drag.x0 = e.clientX; }
        drag.fine = fine;
      }
      const range = this.max - this.min;
      const v = drag.v0 + ((e.clientX - drag.x0) / drag.w) * range * this.sensitivity * fine;
      this.set(v, { emit: true });
    });
    const end = (e, cancelled) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      this.el.classList.remove('is-active');
      if (cancelled) {
        // Browser took the gesture (vertical scroll): undo any tiny accidental move.
        if (!d.engaged) return;
        this.onChange(this.value);
        return;
      }
      if (d.engaged) { this.onChange(this.value); return; }
      if (d.moved < 10) {
        const now = performance.now();
        if (now - lastTap < 320) { lastTap = 0; this.reset(); }
        else lastTap = now;
      }
    };
    t.addEventListener('pointerup', (e) => end(e, false));
    t.addEventListener('pointercancel', (e) => end(e, true));
    t.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.id) end(e, false); });

    t.addEventListener('keydown', (e) => {
      const big = (this.max - this.min) / 10;
      const st = this.step || (this.max - this.min) / 100;
      let v = null;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowUp': v = this.value + (e.shiftKey ? big : st); break;
        case 'ArrowLeft': case 'ArrowDown': v = this.value - (e.shiftKey ? big : st); break;
        case 'PageUp': v = this.value + big; break;
        case 'PageDown': v = this.value - big; break;
        case 'Home': v = this.min; break;
        case 'End': v = this.max; break;
        case 'Delete': case 'Backspace': case '0': this.reset(); e.preventDefault(); return;
        default: return;
      }
      e.preventDefault();
      this.set(v, { emit: true, commit: true });
    });
  }
}

/* ---------------------------------------------------------------- Toggle */

export class Toggle {
  constructor({ label, value = false, onChange }) {
    this.value = !!value;
    this.onChange = onChange || (() => {});
    this.btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label },
      h('span', { class: 'switch-knob' }));
    this.el = h('div', { class: 'toggle-row' }, h('span', { class: 'slider-label', text: label }), h('span', { class: 'slider-spacer' }), this.btn);
    this.btn.addEventListener('click', () => { this.set(!this.value); this.onChange(this.value); });
    this.set(this.value);
  }
  set(v) {
    this.value = !!v;
    this.btn.setAttribute('aria-checked', String(this.value));
  }
}

/* ------------------------------------------------------------- ChipGroup */

export class ChipGroup {
  /** items: [{ id, label, swatch? }] */
  constructor({ items, value, onChange, label = '', className = '' }) {
    this.onChange = onChange || (() => {});
    this.el = h('div', { class: `chips ${className}`, role: 'radiogroup', 'aria-label': label });
    this.buttons = new Map();
    for (const it of items) {
      const b = h('button', { class: 'chip', type: 'button', role: 'radio', dataset: { id: it.id } },
        it.swatch ? h('i', { class: 'chip-swatch', style: { background: it.swatch } }) : null,
        it.label);
      b.addEventListener('click', () => {
        if (this.value === it.id) return;
        this.set(it.id);
        this.onChange(it.id);
      });
      this.buttons.set(it.id, b);
      this.el.append(b);
    }
    this.set(value);
  }
  set(id) {
    this.value = id;
    for (const [k, b] of this.buttons) b.setAttribute('aria-checked', String(k === id));
  }
}

/* ----------------------------------------------------------------- Sheet */

let sheetStack = 0;

/**
 * Bottom sheet with backdrop. Swipe the grabber/header (or the body when scrolled to top)
 * down to dismiss; tap the backdrop to dismiss. new Sheet({ title, content, onClose, dismissible })
 */
export class Sheet {
  constructor({ title = '', content = null, onClose = null, dismissible = true, className = '' } = {}) {
    this.onClose = onClose;
    this.dismissible = dismissible;
    this.titleEl = h('h2', { class: 'sheet-title', text: title });
    this.closeBtn = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close', html: icon('close') });
    this.body = h('div', { class: 'sheet-body' });
    if (content) this.body.append(content);
    this.panel = h('div', { class: `sheet ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
      h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }, h('span')),
      h('header', { class: 'sheet-head' }, this.titleEl, this.closeBtn),
      this.body);
    this.backdrop = h('div', { class: 'sheet-backdrop' });
    this.root = h('div', { class: 'sheet-layer' }, this.backdrop, this.panel);
    this.isOpen = false;

    this.closeBtn.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => { if (this.dismissible) this.close(); });
    this._onKey = (e) => { if (e.key === 'Escape' && this.dismissible) this.close(); };
    this._bindSwipe();
  }

  setTitle(t) { this.titleEl.textContent = t; this.panel.setAttribute('aria-label', t); }
  setDismissible(d) { this.dismissible = d; this.closeBtn.hidden = !d; }

  open() {
    if (this.isOpen) return this;
    this.isOpen = true;
    this._prevFocus = document.activeElement;
    document.body.append(this.root);
    this.root.style.zIndex = String(100 + (sheetStack++));
    // next frame → transition in
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.add('is-open')));
    document.addEventListener('keydown', this._onKey);
    // iOS: keep the sheet above the on-screen keyboard (fixed layers don't move with it)
    const vv = window.visualViewport;
    if (vv) {
      this._onVV = () => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        this.panel.style.bottom = kb > 40 ? `${kb}px` : '';
      };
      vv.addEventListener('resize', this._onVV);
      vv.addEventListener('scroll', this._onVV);
    }
    setTimeout(() => { try { this.panel.focus({ preventScroll: true }); } catch { /* ignore */ } }, 50);
    return this;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    sheetStack = Math.max(0, sheetStack - 1);
    document.removeEventListener('keydown', this._onKey);
    if (this._onVV && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onVV);
      window.visualViewport.removeEventListener('scroll', this._onVV);
    }
    this.root.classList.remove('is-open');
    this.panel.style.transform = '';
    const done = () => { this.root.remove(); };
    if (prefersReducedMotion()) done(); else setTimeout(done, 280);
    try { this._prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    this.onClose?.();
  }

  _bindSwipe() {
    let d = null;
    const p = this.panel;
    p.addEventListener('pointerdown', (e) => {
      if (!this.dismissible || e.button > 0) return;
      const onHandle = e.target.closest('.sheet-grab, .sheet-head');
      const atTop = this.body.scrollTop <= 0;
      if (!onHandle && !(atTop && e.pointerType === 'touch')) return;
      if (e.target.closest('button, input, select, a, .slider-track, .chips')) return;
      d = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0, onHandle, engaged: false };
    });
    p.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      d.dy = e.clientY - d.y0;
      if (!d.engaged) {
        if (d.dy > 8) {
          d.engaged = true;
          try { p.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          p.classList.add('is-dragging');
        } else return;
      }
      p.style.transform = `translateY(${Math.max(0, d.dy)}px)`;
    });
    const end = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const { dy, t0, engaged } = d;
      d = null;
      p.classList.remove('is-dragging');
      if (!engaged) return;
      const v = dy / Math.max(1, performance.now() - t0);
      if (dy > p.offsetHeight * 0.3 || (dy > 40 && v > 0.5)) this.close();
      else p.style.transform = '';
    };
    p.addEventListener('pointerup', end);
    p.addEventListener('pointercancel', end);
  }
}

/* ----------------------------------------------------------------- toast */

let toastHost = null;

/** toast(message, { action, onAction, duration }) → { dismiss } */
export function toast(message, { action = null, onAction = null, duration = 3200, tone = '' } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast ${tone ? 'toast-' + tone : ''}` }, h('span', { class: 'toast-msg', text: message }));
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.remove('is-in');
    setTimeout(() => t.remove(), prefersReducedMotion() ? 0 : 250);
  };
  if (action) {
    const b = h('button', { class: 'toast-action', type: 'button', text: action });
    b.addEventListener('click', () => { dismiss(); onAction?.(); });
    t.append(b);
  }
  toastHost.append(t);
  // keep at most 3
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('is-in'));
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { dismiss };
}

/* ------------------------------------------------------------ misc utils */

/** Run `work(deadline)` chunks in idle time (falls back to setTimeout). Returns cancel fn. */
export function idleLoop(step) {
  let cancelled = false;
  const ric = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 120 })
    : (cb) => setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: false }), 16);
  const run = (dl) => {
    if (cancelled) return;
    let more = true;
    const t0 = performance.now();
    do { more = step(); } while (more && !cancelled && (dl.timeRemaining() > 2 || performance.now() - t0 < 6));
    if (more && !cancelled) ric(run);
  };
  ric(run);
  return () => { cancelled = true; };
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}
