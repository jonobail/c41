# Looks & "Match a photo" — contract

A **Look** is a one-tap recipe: film (optionally with param overrides) + camera + effects + adjustments.
Built-in looks ship in `js/looks.js`; looks the user creates with *Match a photo* are stored on the device.

## Look object

```js
{
  id: 'warm-haze',                 // custom looks: 'custom-<timestamp>'
  name: 'Warm Haze',
  description: 'one line',
  custom: false,                   // true for user-made looks
  filmId: 'kodak-gold-200',        // base stock from films.js
  film: { ...partial film params } | null,  // merged over getFilm(filmId).params (deep for grain/halation)
  filmAmt: 1,
  cameraId: 'none', camAmt: 1,
  effects: { grain, halation, flare, leak, leakStyle, leakSeed, dust, dustSeed, flash }, // any subset; omitted keys → defaults
  adjust:  { exposure, contrast, warmth, tint },                                         // any subset
  swatch: ['#hex', '#hex'],        // card colours; custom looks may carry `thumb` (data URL, ≤ 8 KB)
}
```

Applying a look replaces film/camera/effects/adjust state with the look's values (unspecified keys
reset to defaults). After applying, the user may keep tweaking; the UI shows the look as "modified".

`leakStyle`: `'warm'` (current behaviour, default) | `'prism'` (warm pink-orange on one edge,
mint/teal on the opposite edge, like the reference in calibration/reference) | `'edge'` | `'holga'`.
`makeLeaks(seed, { style })` in js/overlays.js.

## Matcher API (`js/look-match.js`)

```js
export async function matchLook(file /* File|Blob */, { onProgress, signal } = {}) -> {
  film: { ...fitted film params },      // colour + tone (FIT_SPEC from film-transform.js), lumaLock: true
  effects: { grain, leak, leakStyle },  // estimated from the reference (grain level, mono/colour grain, edge leaks)
  grainParams: { amount, size, color }, // goes into film.grain
  stats: { ... },                       // for debugging / UI
}
```
- Runs the fit in a module worker (`js/match-worker.js`) against `assets/baseline-pool.bin`
  (9,000 sRGB uint8 RGB triplets sampled from 124 iPhone photos — "what a normal iPhone photo looks like").
- Target stats come from the reference photo (downscaled to ≤ 768 px, borders trimmed) using the same
  statistics as `calibration/stats.mjs` (luma quantiles, cast/chroma per tone band, hue-band chroma/luma).
- Must finish in ≲ 15 s on a recent iPhone; report progress 0..1; abortable.
- The resulting look: `{ custom: true, filmId: DEFAULT_FILM_ID, film: result.film, effects: result.effects, ... }`
  saved in localStorage key `c41.looks` (array, newest first, cap 24; thumbnails small).
