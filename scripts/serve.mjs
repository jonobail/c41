#!/usr/bin/env node
// C41 — dependency-free static dev server.
//   node scripts/serve.mjs            (PORT=8080 by default, binds 0.0.0.0)
//   PORT=5173 node scripts/serve.mjs
// For HTTPS on the tailnet (needed for service workers + Web Share on iPhone):
//   tailscale serve --bg <port>       → https://<host>.<tailnet>.ts.net/
// See docs/IOS.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  let file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT) || /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path.relative(ROOT, file))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.existsSync(file) ? fs.statSync(file) : null;
      err = st ? null : new Error('nf');
    }
    if (err || !st) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      log(req, 404);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // Dev server: always revalidate. The service worker must never be HTTP-cached.
      'Cache-Control': path.basename(file) === 'sw.js' ? 'no-cache, no-store, must-revalidate' : 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    };
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = './';
    const ims = req.headers['if-modified-since'];
    if (ims && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
      res.writeHead(304, headers).end();
      log(req, 304);
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
    log(req, 200);
  });
});

function log(req, code) {
  if (process.env.QUIET) return;
  console.log(`${code} ${req.method} ${req.url}`);
}

server.listen(PORT, HOST, () => {
  console.log(`C41 serving ${ROOT}`);
  console.log(`  local:   http://localhost:${PORT}/`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  network: http://${a.address}:${PORT}/`);
    }
  }
  console.log(`  HTTPS on your tailnet (for iPhone install/testing):  tailscale serve --bg ${PORT}`);
});
