// C41 — Built-in high-resolution procedural sample photo generator.
// Creates a rich golden-hour coastal canyon scene with sky gradients, sun disc (for halation/flare),
// atmospheric mountain layers (for dehaze), sunlit cliffs, ocean reflections, foliage & foreground depth.

import { mulberry32 } from './overlays.js';

export async function makeSamplePhotoFile(width = 1800, height = 1200) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  const rnd = mulberry32(414141);

  // 1. Atmospheric sunset sky
  const sky = g.createLinearGradient(0, 0, 0, height * 0.62);
  sky.addColorStop(0.00, '#1e3c6b');
  sky.addColorStop(0.28, '#3f6a9e');
  sky.addColorStop(0.56, '#9eb6cb');
  sky.addColorStop(0.78, '#e8b684');
  sky.addColorStop(0.92, '#f59c63');
  sky.addColorStop(1.00, '#fad79a');
  g.fillStyle = sky;
  g.fillRect(0, 0, width, height * 0.65);

  // 2. Luminous low sun + atmospheric bloom (triggers halation & lens flare!)
  const sunX = width * 0.68, sunY = height * 0.42;
  const halo = g.createRadialGradient(sunX, sunY, height * 0.01, sunX, sunY, height * 0.48);
  halo.addColorStop(0.00, 'rgba(255, 252, 238, 1.0)');
  halo.addColorStop(0.08, 'rgba(255, 240, 195, 0.92)');
  halo.addColorStop(0.22, 'rgba(255, 194, 128, 0.48)');
  halo.addColorStop(0.55, 'rgba(242, 134, 92, 0.16)');
  halo.addColorStop(1.00, 'rgba(242, 134, 92, 0.0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, width, height * 0.85);

  // Crisp bright sun disc
  g.fillStyle = '#fffef5';
  g.beginPath();
  g.arc(sunX, sunY, height * 0.036, 0, Math.PI * 2);
  g.fill();

  // 3. Soft layered golden clouds
  for (let i = 0; i < 18; i++) {
    const cx = rnd() * width;
    const cy = height * (0.10 + rnd() * 0.34);
    const rw = width * (0.09 + rnd() * 0.16);
    const rh = height * (0.014 + rnd() * 0.028);
    const dist = Math.hypot((cx - sunX) / width, (cy - sunY) / height);
    const warm = Math.max(0, 1 - dist * 1.7);
    const cg = g.createRadialGradient(cx, cy, rh * 0.2, cx, cy, rw);
    cg.addColorStop(0, `rgba(${Math.round(235 + 20 * warm)}, ${Math.round(178 + 45 * warm)}, ${Math.round(152 + 30 * warm)}, ${0.22 + 0.18 * warm})`);
    cg.addColorStop(1, 'rgba(245, 180, 140, 0)');
    g.save();
    g.translate(cx, cy);
    g.scale(1, rh / rw);
    g.fillStyle = cg;
    g.beginPath();
    g.arc(0, 0, rw, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // Helper to paint layered natural ridges
  function ridge(baseY, amp, freq, phase, fillStyle, highlightStyle = null) {
    g.beginPath();
    g.moveTo(0, height);
    const pts = [];
    const steps = 160;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = u * width;
      const y = baseY
        - Math.sin(u * freq + phase) * amp
        - Math.sin(u * freq * 2.3 + phase * 1.7) * amp * 0.42
        - Math.cos(u * freq * 5.1 + phase * 0.6) * amp * 0.16
        - Math.sin(u * freq * 11.7 + phase * 2.1) * amp * 0.05;
      pts.push([x, y]);
      g.lineTo(x, y);
    }
    g.lineTo(width, height);
    g.closePath();
    g.fillStyle = fillStyle;
    g.fill();

    if (highlightStyle) {
      g.save();
      g.clip();
      g.strokeStyle = highlightStyle;
      g.lineWidth = height * 0.012;
      g.beginPath();
      pts.forEach(([x, y], idx) => (idx === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
      g.stroke();
      g.restore();
    }
  }

  // 4. Distant hazy coastal mountain ranges (great for testing Dehaze & Clarity)
  const m1 = g.createLinearGradient(0, height * 0.36, 0, height * 0.65);
  m1.addColorStop(0, '#787e99');
  m1.addColorStop(1, '#c89b87');
  ridge(height * 0.56, height * 0.075, 4.2, 0.8, m1);

  const m2 = g.createLinearGradient(0, height * 0.44, 0, height * 0.72);
  m2.addColorStop(0, '#5a5c78');
  m2.addColorStop(1, '#a97969');
  ridge(height * 0.61, height * 0.068, 5.5, 2.5, m2, 'rgba(255, 210, 155, 0.28)');

  // 5. Shimmering coastal bay water
  const waterY = height * 0.60;
  const water = g.createLinearGradient(0, waterY, 0, height);
  water.addColorStop(0.0, '#c78c6a');
  water.addColorStop(0.18, '#5f6f8a');
  water.addColorStop(0.55, '#2b4761');
  water.addColorStop(1.0, '#16283a');
  g.fillStyle = water;
  g.fillRect(0, waterY, width, height - waterY);

  // Sun reflection path across the water
  for (let i = 0; i < 190; i++) {
    const t = rnd();
    const y = waterY + t * t * (height - waterY) * 0.92;
    const spread = width * (0.025 + t * 0.16);
    const x = sunX + (rnd() - 0.5) * spread * 2;
    const w = width * (0.01 + t * 0.06) * (0.5 + rnd());
    const h = Math.max(1.2, (1.5 + t * 4.5));
    const alpha = (1 - t * 0.6) * (0.25 + 0.55 * rnd());
    g.fillStyle = `rgba(255, ${Math.round(215 + 35 * (1 - t))}, ${Math.round(145 + 75 * (1 - t))}, ${alpha})`;
    g.fillRect(x - w / 2, y, w, h);
  }

  // 6. Midground sunlit red-ochre sandstone promontory (left)
  const cliff = g.createLinearGradient(0, height * 0.52, width * 0.52, height * 0.88);
  cliff.addColorStop(0.0, '#c46b42');
  cliff.addColorStop(0.45, '#8c442d');
  cliff.addColorStop(1.0, '#36211c');
  g.beginPath();
  g.moveTo(0, height * 0.56);
  g.bezierCurveTo(width * 0.16, height * 0.52, width * 0.28, height * 0.60, width * 0.44, height * 0.72);
  g.bezierCurveTo(width * 0.38, height * 0.78, width * 0.20, height * 0.84, 0, height * 0.88);
  g.closePath();
  g.fillStyle = cliff;
  g.fill();

  // Warm rim light on cliff facets
  g.strokeStyle = 'rgba(255, 198, 128, 0.55)';
  g.lineWidth = height * 0.006;
  g.beginPath();
  g.moveTo(0, height * 0.56);
  g.bezierCurveTo(width * 0.16, height * 0.52, width * 0.28, height * 0.60, width * 0.44, height * 0.72);
  g.stroke();

  // 7. Rich green coastal pines & foreground hillside (tests Green/Yellow/Orange HSL + Shadows!)
  const hill = g.createLinearGradient(0, height * 0.72, 0, height);
  hill.addColorStop(0, '#3f5432');
  hill.addColorStop(0.45, '#253620');
  hill.addColorStop(1, '#101712');
  ridge(height * 0.89, height * 0.085, 3.1, 4.4, hill);

  // Foreground pine silhouettes with sunlit warm needles
  const drawPine = (px, py, ph, shade) => {
    const pw = ph * 0.34;
    g.fillStyle = shade;
    g.beginPath();
    g.moveTo(px, py - ph);
    const tiers = 7;
    for (let t = 1; t <= tiers; t++) {
      const f = t / tiers;
      const y1 = py - ph * (1 - f * 0.92);
      const y2 = py - ph * (1 - f * 0.76);
      g.lineTo(px + pw * f * (0.85 + 0.3 * rnd()), y1);
      g.lineTo(px + pw * f * 0.42, y2);
    }
    g.lineTo(px + pw * 0.12, py);
    g.lineTo(px - pw * 0.12, py);
    for (let t = tiers; t >= 1; t--) {
      const f = t / tiers;
      const y1 = py - ph * (1 - f * 0.92);
      const y2 = py - ph * (1 - f * 0.76);
      g.lineTo(px - pw * f * 0.42, y2);
      g.lineTo(px - pw * f * (0.85 + 0.3 * rnd()), y1);
    }
    g.closePath();
    g.fill();
  };

  for (let i = 0; i < 22; i++) {
    const px = width * (0.02 + rnd() * 0.36);
    const ph = height * (0.11 + rnd() * 0.22);
    const py = height * (0.88 + rnd() * 0.15);
    const gTone = Math.round(34 + rnd() * 28);
    drawPine(px, py, ph, `rgb(${Math.round(gTone * 0.55)}, ${gTone}, ${Math.round(gTone * 0.45)})`);
  }
  for (let i = 0; i < 12; i++) {
    const px = width * (0.76 + rnd() * 0.24);
    const ph = height * (0.09 + rnd() * 0.19);
    const py = height * (0.90 + rnd() * 0.12);
    const gTone = Math.round(28 + rnd() * 22);
    drawPine(px, py, ph, `rgb(${Math.round(gTone * 0.65)}, ${gTone}, ${Math.round(gTone * 0.42)})`);
  }

  // 8. Foreground warm boulders & vibrant wildflowers (red/magenta/yellow accents for HSL testing)
  const wildColors = ['#e64b4b', '#f2a93b', '#f5dd58', '#d9579a', '#5da6eb'];
  for (let i = 0; i < 95; i++) {
    const fx = rnd() * width;
    const fy = height * (0.86 + rnd() * 0.13);
    const r = height * (0.002 + rnd() * 0.0045);
    g.fillStyle = wildColors[Math.floor(rnd() * wildColors.length)];
    g.globalAlpha = 0.55 + rnd() * 0.4;
    g.beginPath();
    g.arc(fx, fy, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // 9. Subtle natural micro-texture so sharpening / denoise / grain have real detail
  const id = g.getImageData(0, 0, width, height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 6;
    d[i] = Math.min(255, Math.max(0, d[i] + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
  }
  g.putImageData(id, 0, 0);

  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.94));
  c.width = c.height = 0;
  return new File([blob], 'golden-coast-sample.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}
