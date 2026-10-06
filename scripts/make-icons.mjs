#!/usr/bin/env node
// Renders the C41 icon design (SVG) to PNGs with Playwright/Chromium.
//   node scripts/make-icons.mjs
// Outputs: icons/favicon.svg, logo.svg, logo-small.svg, icon-180.png (apple-touch, opaque), icon-192.png, icon-512.png,
//          icon-maskable-512.png (content inside the 80% safe zone).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

import { logoArt, svgDoc as svg } from './logo.mjs';

// The mark itself lives in scripts/logo.mjs (rings forming a "C" around "41").
const art = () => logoArt();
// maskable: full-bleed background, artwork inside the central 80% safe zone
const maskable = () => logoArt({ scale: 0.7 });

fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg(logoArt({ rounded: true })) + '\n');
// transparent marks for the UI: full (empty state) and simplified (top bar, ~28 px)
fs.writeFileSync(path.join(OUT, 'logo.svg'), svg(logoArt({ bg: null, scale: 1 })) + '\n');
fs.writeFileSync(path.join(OUT, 'logo-small.svg'), svg(logoArt({ bg: null, scale: 1, rings: 2 })) + '\n');

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
console.log('wrote icons/favicon.svg, logo.svg, logo-small.svg');
