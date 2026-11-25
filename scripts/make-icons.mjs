#!/usr/bin/env node
// Renders the C41 icon design (SVG) to PNGs with Playwright/Chromium.
//   node scripts/make-icons.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logoArt, bannerSvg, svgDoc as svg } from './logo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

const art = () => logoArt({ rounded: false, scale: 0.84 });
const maskable = () => logoArt({ rounded: false, scale: 0.68 });

fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg(logoArt({ rounded: true, scale: 0.84 })) + '\n');
fs.writeFileSync(path.join(OUT, 'logo.svg'), svg(logoArt({ bg: null, scale: 0.96 })) + '\n');
fs.writeFileSync(path.join(OUT, 'logo-small.svg'), svg(logoArt({ bg: null, scale: 0.96, compact: true })) + '\n');
fs.writeFileSync(path.join(ROOT, 'docs', 'c41-logo.svg'), bannerSvg() + '\n');

const jobs = [
  { file: 'icon-180.png', size: 180, inner: art() },
  { file: 'icon-192.png', size: 192, inner: art() },
  { file: 'icon-512.png', size: 512, inner: art() },
  { file: 'icon-maskable-512.png', size: 512, inner: maskable() },
];

// Find locally cached Chromium if default Playwright binary differs
let executablePath;
const cacheRoot = path.join(process.env.HOME || '', '.cache/ms-playwright');
for (const rel of ['chromium-1254/chrome-linux64/chrome', 'chromium-1248/chrome-linux64/chrome']) {
  const p = path.join(cacheRoot, rel);
  if (fs.existsSync(p)) { executablePath = p; break; }
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const j of jobs) {
    await page.setViewportSize({ width: j.size, height: j.size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:#09090b}svg{display:block}</style>${svg(j.inner, j.size)}`);
    await page.screenshot({ path: path.join(OUT, j.file), omitBackground: false, clip: { x: 0, y: 0, width: j.size, height: j.size } });
    console.log('wrote icons/' + j.file);
  }
} finally {
  await browser.close();
}
console.log('wrote icons/favicon.svg, logo.svg, logo-small.svg, docs/c41-logo.svg');
