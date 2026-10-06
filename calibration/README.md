# Film & camera calibration

The film presets aren't only hand-tuned. Wherever enough real photos shot on a stock exist, C41 fits
the film's colour parameters so that **ordinary iPhone photos, pushed through the film model, end up
with the same colour statistics as real photos shot on that stock**. Cameras get their vignette
profile measured the same way.

Source photos come from Wikimedia Commons categories ("Photographs taken on Kodak Ektar 100 film",
"Taken with Canon AE-1", …). They are cached locally to compute statistics and are **never shipped**
with the app (`calibration/cache/` is gitignored).

## Pipeline

```sh
cd calibration
python3 -m venv .venv && .venv/bin/pip install numpy pillow     # once
.venv/bin/python fetch.py 36            # ≤36 images per film/camera + 144 iPhone baseline images (slow: Commons rate limits)
node -e "import('../js/films.js').then(m=>console.log(JSON.stringify(Object.fromEntries(m.FILMS.map(f=>[f.id,f.params.type==='bw'?'bw':'color'])))))" > kinds.json
.venv/bin/python measure.py < kinds.json   # pixel pools, vignette profiles, grain estimate → cache/measure/
node fit.mjs [filmId ...]               # → fitted.json + ../js/films-calibrated.js
node fit-cameras.mjs                    # → vignette fit for js/cameras.js
.venv/bin/python montage.py films/<id>  # contact sheet, to eyeball a reference set
```

- `categories.json`: which Commons categories feed which film / camera (hand-mapped; only
  direct files, because some subcategories are mis-filed).
- `fetch.py`: downloads 960 px thumbnails, seeded shuffle per set.
- `measure.py`: trims scan borders and rebates, drops monochrome shots from colour sets (and vice
  versa), samples 4,000 px per image, measures radial falloff and a grain proxy.
- `stats.mjs`: luma quantiles, colour cast and chroma per tone band, chroma and luma per hue band.
- `fit.mjs`: coordinate pattern search over `FIT_SPEC` (`FIT_SPEC_BW` for B&W) from
  `js/film-transform.js`, regularised toward the hand-authored params so the stock's character
  survives where the data is thin. Colour films are fitted with `lumaLock: true`.

## Caveats

- Commons samples mix scanners, labs and eras. Old slides can be faded, and scene content differs
  from the baseline. Thirty-odd images per stock average much of this out, but not all of it, which
  is why the fit is regularised and each set gets checked on a contact sheet.
- Grain and sharpness can't be measured reliably from 960 px thumbnails, so those stay hand-authored.
- Stocks without a usable reference set keep their hand-authored params.
