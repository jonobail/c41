# C41

A film-emulation photo editor that runs entirely in the browser, made to be installed to the iPhone
home screen as a PWA. Pick a photo, then layer a **film stock** (colour, tone, grain, halation) and a
**camera** (lens character, vignette, format, borders), plus effects like light leaks, dust and an LED
date stamp. Save the result at full resolution. Nothing leaves the device.

- **51 film stocks**: colour negative, B&W, slide, cinema and specialty. 27 of them are calibrated
  against statistics of real photos shot on that stock ([calibration/](calibration/README.md)).
- **31 cameras**: classic SLRs, rangefinders and compacts, plus Lomography cameras with fisheye,
  multi-lens sequence grids, panoramas over the sprocket holes and colour-gel flash.
- **Looks**: one-tap recipes, and **Match a photo**, which fits a film to any reference photo on the
  device.
- **Full-resolution export**: renders in strips and streams into a JPEG encoder running in a worker,
  so 24–48 MP iPhone photos save without hitting iOS canvas limits. The original capture date is kept
  in EXIF.

## Run

No build step, no runtime dependencies: it's static files and ES modules.

```sh
npm install        # dev only: Playwright for tests / icon rendering
npm run serve      # http://localhost:8080  (PORT=… to change)
npm test           # unit tests;  node tests/*.browser.mjs for browser checks
```

Service workers (offline use) and Save to Photos need HTTPS. See [docs/IOS.md](docs/IOS.md) for
testing on an iPhone over Tailscale and installing to the home screen.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): module contracts and the render/export pipeline
- [docs/FILM_STOCKS.md](docs/FILM_STOCKS.md): the film inventory, with traits and parameters
- [docs/LOMOGRAPHY_CAMERAS.md](docs/LOMOGRAPHY_CAMERAS.md): Lomography camera research and emulation specs
- [docs/LOOKS.md](docs/LOOKS.md): Looks and Match a photo
- [calibration/README.md](calibration/README.md): how films and cameras are fitted to real photos

Film and camera names are used only to describe the looks being emulated. C41 isn't affiliated with
any film or camera maker. The calibration reference photos are downloaded locally to compute
statistics and aren't included in this repository.
