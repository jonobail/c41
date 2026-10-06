"""Explore Commons category trees: `probe.py parents <cat>` or `probe.py subcats <cat> [limit]`."""
import json, sys, time, urllib.parse, urllib.request

UA = {"User-Agent": "C41-calibration/0.1 (film-emulation research; derives colour statistics only)"}


def api(**p):
    p["format"] = "json"
    time.sleep(1)
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(p)
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30))


mode, title = sys.argv[1], sys.argv[2]
if mode == "parents":
    r = api(action="query", prop="categories", titles=title, cllimit=50)
    print([c["title"] for p in r["query"]["pages"].values() for c in p.get("categories", [])])
else:
    out, cont = [], {}
    while True:
        r = api(action="query", generator="categorymembers", gcmtitle=title, gcmtype="subcat",
                gcmlimit=500, prop="categoryinfo", **cont)
        for p in r.get("query", {}).get("pages", {}).values():
            ci = p.get("categoryinfo", {})
            out.append((ci.get("files", 0), ci.get("subcats", 0), p["title"]))
        if "continue" not in r: break
        cont = r["continue"]
    for o in sorted(out, reverse=True)[: int(sys.argv[3]) if len(sys.argv) > 3 else 80]:
        print(o)
