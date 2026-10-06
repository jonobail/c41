"""Measure the downloaded reference photos.

For every set in cache/ (baseline, films/*, cameras/*) writes into cache/measure/<key>:
  pool.bin      N×3 uint8 sRGB pixels, an equal random sample from each usable image
                (frame borders trimmed, 6 % margin cropped) — the colour fitter works on these.
  stats.json    { images, kind, vignette: [log2 ratio per radius bin], grain: float }

Vignette: luma ring means over aspect-normalised radius (0 centre → 1 corner) relative to the
centre, as log2; median over images. Grain: median std of a fine high-pass in flat regions.
"""
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).parent / "cache"
OUT = ROOT / "measure"
PER_IMAGE = 4000
RBINS = np.linspace(0, 1, 11)


def trim_border(a):
    """Remove scan borders / film rebates: trim edge rows/cols that are near-black or near-white."""
    y = a.mean(axis=2)
    h, w = y.shape
    def edge(lines, limit):
        n = 0
        for v in lines[:limit]:
            if v < 0.07 or v > 0.95: n += 1
            else: break
        return n
    rows, cols = y.mean(axis=1), y.mean(axis=0)
    t, b = edge(rows, h // 6), edge(rows[::-1], h // 6)
    l, r = edge(cols, w // 6), edge(cols[::-1], w // 6)
    trimmed = t + b + l + r > 0
    pad_h, pad_w = (int(h * 0.01) if trimmed else 0), (int(w * 0.01) if trimmed else 0)
    return a[t + pad_h: h - b - pad_h, l + pad_w: w - r - pad_w], trimmed


def blur(x, s):
    k = np.exp(-0.5 * (np.arange(-3 * s, 3 * s + 1) / s) ** 2); k /= k.sum()
    x = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, x)
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, x)


def vignette_profile(a):
    y = (a ** 2.2) @ np.array([0.2126, 0.7152, 0.0722])          # approx linear luma
    h, w = y.shape
    yy, xx = np.mgrid[0:h, 0:w]
    asp = w / h
    d = np.hypot((xx / w - 0.5) * asp, yy / h - 0.5) / np.hypot(0.5 * asp, 0.5)
    centre = y[d < 0.3].mean()
    if centre < 0.02: return None
    prof = []
    for lo, hi in zip(RBINS[:-1], RBINS[1:]):
        m = (d >= lo) & (d < hi)
        prof.append(np.log2(max(y[m].mean(), 1e-4) / centre) if m.any() else np.nan)
    return prof


def grain_level(a):
    y = a @ np.array([0.2126, 0.7152, 0.0722])
    y = y[: (y.shape[0] // 4) * 4, : (y.shape[1] // 4) * 4]
    hp = y - blur(y, 1.5)
    smooth = blur(y, 3)
    gy, gx = np.gradient(smooth)
    flat = np.hypot(gx, gy) < 0.004
    mid = (smooth > 0.2) & (smooth < 0.8)
    m = flat & mid
    return float(hp[m].std()) if m.sum() > 2000 else None


def measure(key, kind):
    files = sorted((ROOT / key).glob("*.jpg"))
    rng = np.random.default_rng(1234)
    pools, profiles, grains, used = [], [], [], 0
    for f in files:
        try:
            im = Image.open(f).convert("RGB")
        except Exception:
            continue
        im.thumbnail((1024, 1024))
        a = np.asarray(im, dtype=np.float32) / 255.0
        a, _ = trim_border(a)
        if min(a.shape[:2]) < 200: continue
        chroma = (a.max(axis=2) - a.min(axis=2)).mean()
        mono = chroma < 0.03
        if kind == "bw" and chroma > 0.12: continue          # mis-filed colour shot
        if kind == "color" and mono: continue                 # B&W shot in a colour set
        h, w = a.shape[:2]
        mh, mw = int(h * 0.06), int(w * 0.06)
        core = a[mh: h - mh, mw: w - mw].reshape(-1, 3)
        pools.append((core[rng.choice(len(core), PER_IMAGE, replace=len(core) < PER_IMAGE)] * 255).astype(np.uint8))
        small = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((256, max(32, int(256 * h / w)))), np.float32) / 255
        p = vignette_profile(small)
        if p is not None: profiles.append(p)
        g = grain_level(a)
        if g is not None: grains.append(g)
        used += 1
    if not used: return None
    d = OUT / key
    d.mkdir(parents=True, exist_ok=True)
    np.concatenate(pools).tofile(d / "pool.bin")
    stats = {
        "images": used, "kind": kind,
        "vignette": [None if np.isnan(v) else round(float(v), 4) for v in np.nanmedian(np.array(profiles), axis=0)] if profiles else None,
        "grain": round(float(np.median(grains)), 5) if grains else None,
    }
    (d / "stats.json").write_text(json.dumps(stats))
    return stats


if __name__ == "__main__":
    kinds = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    keys = ["baseline"] + [f"{g}/{p.name}" for g in ("films", "cameras") for p in sorted((ROOT / g).glob("*")) if p.is_dir()]
    for key in keys:
        kind = kinds.get(key.split("/")[-1], "color") if key.startswith("films/") else "any"
        s = measure(key, kind)
        print(key, None if s is None else {k: s[k] for k in ("images", "grain")}, flush=True)
