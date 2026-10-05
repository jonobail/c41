# Running C41 on an iPhone

C41 is a static site with no build step. Service workers (offline / installable) and
`navigator.share` ("Save to Photos") only work in a **secure context**: HTTPS, or `localhost`.
Plain `http://<tailnet-ip>:port` from the phone loads the app, but no offline support and no share sheet.

## 1. Start the dev server

```sh
npm run serve                  # = node scripts/serve.mjs, PORT=8080, binds 0.0.0.0
PORT=5173 npm run serve        # any port
```

`scripts/serve.mjs` is dependency-free. It sends correct MIME types (`.webmanifest`, `.mjs`/`.js`, …),
`no-cache` for everything and `no-store` for `sw.js`, and prints the local and network URLs.

## 2. Get HTTPS on the tailnet

```sh
tailscale serve --bg 8080      # proxies https://m715q.tailefb4a9.ts.net/ → localhost:8080
tailscale serve status         # check it
tailscale serve --https=443 off   # stop it later
```

Open **https://m715q.tailefb4a9.ts.net/** in Safari on the iPhone. The certificate is a real
Let's Encrypt cert, so there are no warnings. (MagicDNS and HTTPS certificates must be enabled in the tailnet admin console.)

## 3. Install to the home screen

Safari → Share → **Add to Home Screen**. It launches standalone (no browser chrome) with the
C41 icon, works offline once the service worker has cached the shell, and respects the notch and
home-indicator safe areas in both orientations.

## 4. Saving photos

After export, the sheet offers:

- **Save to Photos**: opens the iOS share sheet with the JPEG; choose *Save Image*.
- **Download**: saves to Files.
- **Press and hold the preview**: *Save to Photos* from the context menu (fallback if sharing is unavailable).

## Updating / caching gotchas

- The service worker is **cache-first**. After changing any shell file, bump `CACHE_VERSION` in
  `sw.js` (e.g. `c41-v2`). Open clients get an "Update ready → Reload" toast.
- While iterating, a hard way to reset on iPhone is Settings → Safari → Advanced → Website Data →
  remove the tailnet host. On desktop Chrome: DevTools → Application → *Update on reload*.
- GitHub Pages: all paths are relative (`start_url`/`scope` are `./`), so it works under a
  `/<repo>/` sub-path unchanged.
