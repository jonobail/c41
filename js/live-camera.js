// C41 — Real-time device camera manager (getUserMedia, physical lens/device enumeration,
// switching, torch/flash, front-camera mirroring, and full-sensor capture).

const labelForDevice = (dev, idx) => {
  const raw = (dev.label || '').trim();
  if (!raw) return `Camera ${idx + 1}`;
  const low = raw.toLowerCase();
  if (low.includes('ultra wide') || low.includes('ultrawide') || low.includes('0.5')) return '0.5× Ultra Wide';
  if (low.includes('telephoto') || low.includes('tele')) return 'Telephoto';
  if (low.includes('dual wide') || low.includes('triple') || low.includes('back dual')) return 'Multi-Lens';
  if (low.includes('front') || low.includes('facetime') || low.includes('selfie') || low.includes('user')) return 'Front';
  if (low.includes('back') || low.includes('rear') || low.includes('environment')) return '1× Wide';
  // Clean up desktop USB/webcam labels like "HD Pro Webcam C920 (046d:082d)"
  return raw.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').slice(0, 26);
};

export function inferFacing(device) {
  const s = (device?.label || '').toLowerCase();
  if (s.includes('front') || s.includes('user') || s.includes('facetime') || s.includes('selfie')) return 'user';
  if (s.includes('back') || s.includes('rear') || s.includes('environment') || s.includes('wide') || s.includes('tele')) return 'environment';
  return 'unknown';
}

export class LiveCamera {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');

    this.stream = null;
    this.track = null;
    this.devices = [];
    this.activeDeviceId = null;
    this.facingMode = 'environment';
    this.mirrored = false;
    this.torchOn = false;
    this.torchSupported = false;
    this.isDemo = false;
    this._demoRaf = 0;
    this._demoCanvas = null;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  }

  get width() { return this.video.videoWidth || (this._demoCanvas ? this._demoCanvas.width : 0); }
  get height() { return this.video.videoHeight || (this._demoCanvas ? this._demoCanvas.height : 0); }
  get source() { return this.isDemo ? this._demoCanvas : this.video; }
  get ready() { return this.isDemo ? !!this._demoCanvas : (this.video.readyState >= 2 && this.video.videoWidth > 0); }

  async start({ deviceId = null, facingMode = 'environment' } = {}) {
    this.stop();
    if (!LiveCamera.isSupported()) {
      throw new Error('camera-unavailable');
    }

    const attempts = [];
    if (deviceId) {
      attempts.push({ video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      attempts.push({ video: { deviceId: { exact: deviceId } }, audio: false });
    } else {
      attempts.push({ video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      attempts.push({ video: { facingMode }, audio: false });
      attempts.push({ video: true, audio: false });
    }

    let stream = null;
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream) break;
      } catch (e) {
        lastErr = e;
        if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) throw e;
      }
    }
    if (!stream) throw lastErr || new Error('camera-start-failed');

    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.isDemo = false;

    const settings = this.track?.getSettings?.() || {};
    this.activeDeviceId = settings.deviceId || deviceId || null;
    this.facingMode = settings.facingMode || facingMode || 'environment';
    this.mirrored = this.facingMode === 'user';

    const caps = this.track?.getCapabilities?.() || {};
    this.torchSupported = !!caps.torch;
    this.torchOn = false;

    this.video.srcObject = stream;
    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('error', onErr);
      };
      if (this.video.readyState >= 1 && this.video.videoWidth > 0) { resolve(); return; }
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('error', onErr);
    });
    try { await this.video.play(); } catch { /* autoplay already active */ }

    await this.refreshDevices();
    // If activeDeviceId matches a front camera by label, mirror automatically
    const activeDev = this.devices.find((d) => d.deviceId === this.activeDeviceId);
    if (activeDev && inferFacing(activeDev) === 'user') {
      this.facingMode = 'user';
      this.mirrored = true;
    }
    return this.info();
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === 'videoinput');
      this.devices = cams.map((d, i) => ({
        deviceId: d.deviceId,
        rawLabel: d.label || '',
        label: labelForDevice(d, i),
        facing: inferFacing(d),
      }));
    } catch {
      this.devices = [];
    }
    return this.devices;
  }

  async switchDevice(deviceId) {
    if (!deviceId || deviceId === this.activeDeviceId) return this.info();
    const target = this.devices.find((d) => d.deviceId === deviceId);
    return this.start({ deviceId, facingMode: target?.facing === 'user' ? 'user' : 'environment' });
  }

  async flipFacing() {
    if (this.isDemo) {
      this.mirrored = !this.mirrored;
      return this.info();
    }
    const nextFacing = this.facingMode === 'user' ? 'environment' : 'user';
    // Try finding an enumerated device with the opposite facing first
    const match = this.devices.find((d) => d.deviceId !== this.activeDeviceId && d.facing === nextFacing)
      || this.devices.find((d) => d.deviceId !== this.activeDeviceId);
    if (match && match.facing === nextFacing) {
      return this.start({ deviceId: match.deviceId, facingMode: nextFacing });
    }
    return this.start({ facingMode: nextFacing });
  }

  async setTorch(on) {
    if (!this.track || !this.torchSupported) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      return this.torchOn;
    } catch {
      this.torchSupported = false;
      this.torchOn = false;
      return false;
    }
  }

  /**
   * Capture a full-resolution photo File from the live stream.
   * Uses ImageCapture.takePhoto() for full sensor resolution when available,
   * falling back cleanly to the live video frame (respecting front-camera mirror).
   */
  async captureFile() {
    if (this.isDemo && this._demoCanvas) {
      const blob = await new Promise((res) => this._demoCanvas.toBlob(res, 'image/jpeg', 0.95));
      return new File([blob], `C41_live_${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    }

    // Try full-sensor ImageCapture when not mirrored (most rear cameras)
    if (this.track && !this.mirrored && typeof window.ImageCapture === 'function') {
      try {
        const cap = new window.ImageCapture(this.track);
        if (typeof cap.takePhoto === 'function') {
          const blob = await cap.takePhoto();
          if (blob && blob.size > 4096) {
            return new File([blob], `C41_cam_${Date.now()}.jpg`, { type: blob.type || 'image/jpeg', lastModified: Date.now() });
          }
        }
      } catch { /* fallback to video frame */ }
    }

    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!(w > 0 && h > 0)) throw new Error('no-video-frame');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (this.mirrored) {
      g.translate(w, 0);
      g.scale(-1, 1);
    }
    g.drawImage(this.video, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.96));
    c.width = c.height = 0;
    return new File([blob], `C41_cam_${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  }

  /** Animated procedural live feed fallback (for desktops/environments with no webcam). */
  startDemoFeed(width = 1280, height = 960) {
    this.stop();
    this.isDemo = true;
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    this._demoCanvas = c;
    const g = c.getContext('2d');
    this.devices = [
      { deviceId: 'demo-wide', label: '1× Wide (Demo)', facing: 'environment' },
      { deviceId: 'demo-tele', label: '2× Tele (Demo)', facing: 'environment' },
    ];
    this.activeDeviceId = 'demo-wide';
    this.facingMode = 'environment';
    this.mirrored = false;
    this.torchSupported = false;

    const t0 = performance.now();
    const tick = (now) => {
      if (!this.isDemo) return;
      const t = (now - t0) * 0.001;
      const tele = this.activeDeviceId === 'demo-tele' ? 1.45 : 1;
      g.save();
      g.translate(width / 2, height / 2);
      g.scale(tele, tele);
      g.translate(-width / 2, -height / 2);

      // Animated golden hour sky & drifting sun glow
      const sky = g.createLinearGradient(0, 0, 0, height * 0.65);
      sky.addColorStop(0, '#1d3966');
      sky.addColorStop(0.45, '#6a89ab');
      sky.addColorStop(0.82, '#ebaa76');
      sky.addColorStop(1, '#fae0a2');
      g.fillStyle = sky;
      g.fillRect(0, 0, width, height);

      const sx = width * (0.64 + Math.sin(t * 0.35) * 0.04);
      const sy = height * (0.40 + Math.cos(t * 0.25) * 0.02);
      const halo = g.createRadialGradient(sx, sy, 10, sx, sy, height * 0.42);
      halo.addColorStop(0, 'rgba(255,254,242,1)');
      halo.addColorStop(0.12, 'rgba(255,232,175,0.88)');
      halo.addColorStop(0.45, 'rgba(244,145,95,0.28)');
      halo.addColorStop(1, 'rgba(244,145,95,0)');
      g.fillStyle = halo;
      g.fillRect(0, 0, width, height);

      // Gentle drifting mountain & ocean horizon
      const pan = Math.sin(t * 0.45) * 28;
      g.fillStyle = '#5c607b';
      g.beginPath();
      g.moveTo(-60, height);
      for (let i = 0; i <= 40; i++) {
        const u = i / 40;
        g.lineTo(u * (width + 120) - 60 + pan * 0.5, height * 0.56 - Math.sin(u * 5.2 + 0.9) * 52 - Math.cos(u * 11) * 14);
      }
      g.lineTo(width + 60, height);
      g.closePath();
      g.fill();

      const sea = g.createLinearGradient(0, height * 0.58, 0, height);
      sea.addColorStop(0, '#ba8164');
      sea.addColorStop(0.3, '#445d78');
      sea.addColorStop(1, '#122233');
      g.fillStyle = sea;
      g.fillRect(0, height * 0.58, width, height * 0.42);

      // Shimmering animated water highlights
      g.fillStyle = 'rgba(255, 224, 165, 0.55)';
      for (let i = 0; i < 36; i++) {
        const frac = i / 36;
        const y = height * 0.60 + frac * frac * height * 0.36;
        const w = (18 + frac * 78) * (0.7 + 0.3 * Math.sin(t * 2.2 + i * 1.7));
        const x = sx + Math.sin(t * 1.4 + i * 2.1) * (16 + frac * 90);
        g.fillRect(x - w / 2, y, w, 2 + frac * 3);
      }

      // Foreground silhouette
      g.fillStyle = '#19261b';
      g.beginPath();
      g.moveTo(0, height);
      g.lineTo(0, height * 0.72);
      g.quadraticCurveTo(width * 0.28 + pan, height * 0.66, width * 0.48 + pan, height * 0.86);
      g.quadraticCurveTo(width * 0.78 + pan, height * 0.92, width, height * 0.80);
      g.lineTo(width, height);
      g.closePath();
      g.fill();
      g.restore();

      this._demoRaf = requestAnimationFrame(tick);
    };
    this._demoRaf = requestAnimationFrame(tick);
    return this.info();
  }

  info() {
    const cur = this.devices.find((d) => d.deviceId === this.activeDeviceId);
    return {
      activeDeviceId: this.activeDeviceId,
      activeLabel: cur ? cur.label : (this.facingMode === 'user' ? 'Front' : 'Camera'),
      devices: this.devices,
      facingMode: this.facingMode,
      mirrored: this.mirrored,
      torchSupported: this.torchSupported,
      torchOn: this.torchOn,
      isDemo: this.isDemo,
    };
  }

  stop() {
    this.isDemo = false;
    if (this._demoRaf) { cancelAnimationFrame(this._demoRaf); this._demoRaf = 0; }
    if (this._demoCanvas) { this._demoCanvas.width = 0; this._demoCanvas.height = 0; this._demoCanvas = null; }
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this.stream = null;
    }
    this.track = null;
    this.torchOn = false;
    this.torchSupported = false;
    try { this.video.pause(); this.video.srcObject = null; } catch { /* ignore */ }
  }
}
