"""Download sample photos (1024 px thumbnails) for each film/camera category plus an iPhone baseline.

Images are cached under calibration/cache/<key>/ (gitignored) and only used to derive statistics;
they are never shipped with the app.
"""
import json, random, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

UA = {"User-Agent": "C41-calibration/0.1 (film-emulation research; derives colour statistics only)"}
API = "https://commons.wikimedia.org/w/api.php"
CACHE = Path(__file__).parent / "cache"
PER_SET = int(sys.argv[1]) if len(sys.argv) > 1 else 30

BASELINE = [
    "Category:Taken with iPhone 13", "Category:Taken with iPhone 13 Pro",
    "Category:Taken with iPhone 14 Pro", "Category:Taken with iPhone 15 Pro",
]


def get(url, binary=False):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(6):
        try:
            data = urllib.request.urlopen(req, timeout=60).read()
            return data if binary else json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503): raise
            time.sleep(int(e.headers.get("Retry-After", 0) or 0) or 10 * (attempt + 1))
    raise RuntimeError("rate limited: " + url)


def thumb_url(url, width=960):
    """Commons standard thumb path: .../commons/a/ab/N.jpg -> .../commons/thumb/a/ab/N.jpg/960px-N.jpg"""
    head, tail = url.split("?", 1)[0].split("/wikipedia/commons/", 1)  # API appends ?utm_… tracking params
    return f"{head}/wikipedia/commons/thumb/{tail}/{width}px-{tail.rsplit('/', 1)[-1]}"


def list_files(cat, cap=500):
    # No iiurlwidth: asking the API to build thumbnail URLs is what triggers its rate limiting.
    out, cont = [], {}
    while len(out) < cap:
        p = dict(action="query", format="json", generator="categorymembers", gcmtitle=cat, gcmtype="file",
                 gcmlimit=500, prop="imageinfo", iiprop="url|mime|size", **cont)
        time.sleep(3.0)
        try:
            r = get(API + "?" + urllib.parse.urlencode(p))
        except (urllib.error.HTTPError, RuntimeError):
            return out
        for page in r.get("query", {}).get("pages", {}).values():
            ii = (page.get("imageinfo") or [{}])[0]
            if ii.get("mime") == "image/jpeg" and ii.get("width", 0) >= 1000 and ii.get("url"):
                out.append((page["title"], thumb_url(ii["url"])))
        if "continue" not in r: break
        cont = {k: v for k, v in r["continue"].items()}
    return out


def fetch_set(key, cats, n):
    d = CACHE / key
    d.mkdir(parents=True, exist_ok=True)
    have = len(list(d.glob("*.jpg")))
    if have >= n: return have
    files = []
    for c in cats: files += list_files(c)
    random.Random(key).shuffle(files)
    for i, (title, url) in enumerate(files[:n]):
        dest = d / f"{i:03d}.jpg"
        if dest.exists(): continue
        try:
            dest.write_bytes(get(url, binary=True))
        except Exception as e:  # skip broken files, keep going
            print("  skip", title, e, flush=True)
        time.sleep(0.6)
    return len(list(d.glob("*.jpg")))


if __name__ == "__main__":
    cats = json.load(open(Path(__file__).parent / "categories.json"))
    jobs = [("baseline", BASELINE, PER_SET * 4)]
    for group in ("films", "cameras"):
        for key, cs in cats[group].items():
            jobs.append((f"{group}/{key}", cs, PER_SET))
    for key, cs, n in jobs:
        print(key, fetch_set(key, cs, n), flush=True)
