#!/usr/bin/env node
// Renders the C41 icon design (SVG) to PNGs with Playwright/Chromium.
//   node scripts/make-icons.mjs
// Outputs: icons/favicon.svg, icon-180.png (apple-touch, opaque), icon-192.png, icon-512.png,
//          icon-maskable-512.png (content inside the 80% safe zone).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Glyphs are drawn as strokes (no font dependency) so every renderer agrees.
// Concept: a strip of C-41 negative — orange-masked base with sprocket holes — framing "C41".
function art({ rounded = false, bg = true } = {}) {
  const holes = (y) => Array.from({ length: 11 }, (_, i) =>
    `<rect x="${22 + i * 44}" y="${y}" width="24" height="30" rx="6" fill="#0d0b09"/>`).join('');
  return `
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4a83a"/>
      <stop offset="0.5" stop-color="#e2852a"/>
      <stop offset="1" stop-color="#c9661f"/>
    </linearGradient>
    <radialGradient id="frame" cx="0.62" cy="0.3" r="0.9">
      <stop offset="0" stop-color="#2a221b"/>
      <stop offset="1" stop-color="#110e0b"/>
    </radialGradient>
    <radialGradient id="bg" cx="0.5" cy="0.35" r="0.8">
      <stop offset="0" stop-color="#1a1613"/>
      <stop offset="1" stop-color="#0b0a09"/>
    </radialGradient>
  </defs>
  ${bg ? `<rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="url(#bg)"/>` : ''}
  <rect x="0" y="100" width="512" height="312" fill="url(#base)"/>
  ${holes(112)}
  ${holes(370)}
  <rect x="72" y="156" width="368" height="200" rx="16" fill="url(#frame)"/>
  <g transform="translate(256 256) scale(0.88) translate(-256 -256)" fill="none" stroke="#f7ead6" stroke-linecap="round" stroke-linejoin="round" stroke-width="30">
    <path d="M214 214 A60 60 0 1 0 214 298"/>
    <path d="M318 316 V196 L254 282 H344"/>
    <path d="M374 216 L400 196 V316"/>
  </g>
  <rect x="92" y="334" width="40" height="6" rx="3" fill="#f4a83a" opacity=".9"/>
  `;
}

const svg = (inner, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${inner}</svg>`;

// maskable: full-bleed background, artwork scaled into the central safe zone
const maskable = () => `
  <rect width="512" height="512" fill="#0b0a09"/>
  <g transform="translate(256 256) scale(0.8) translate(-256 -256)">${art({ bg: false })}</g>`;

const favicon = svg(art({ rounded: true }));
fs.writeFileSync(path.join(OUT, 'favicon.svg'), favicon + '\n');

const jobs = [
  { file: 'icon-180.png', size: 180, inner: art() },
  { file: 'icon-192.png', size: 192, inner: art() },
  { file: 'icon-512.png', size: 512, inner: art() },
  { file: 'icon-maskable-512.png', size: 512, inner: maskable() },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const j of jobs) {
    await page.setViewportSize({ width: j.size, height: j.size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:#0b0a09}svg{display:block}</style>${svg(j.inner, j.size)}`);
    // opaque PNG (iOS apple-touch-icon must not have transparency)
    await page.screenshot({ path: path.join(OUT, j.file), omitBackground: false, clip: { x: 0, y: 0, width: j.size, height: j.size } });
    console.log('wrote icons/' + j.file);
  }
} finally {
  await browser.close();
}
console.log('wrote icons/favicon.svg');
