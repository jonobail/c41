"""Contact sheet of a cached reference set: `montage.py films/kodak-portra-400 [out.jpg]`."""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent / "cache"
key = sys.argv[1]
out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "montage" / (key.replace("/", "__") + ".jpg")
files = sorted((ROOT / key).glob("*.jpg"))[:36]
cell, cols = 200, 6
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cell, max(1, rows) * cell), (20, 20, 20))
for i, f in enumerate(files):
    try:
        im = Image.open(f).convert("RGB")
    except Exception:
        continue
    im.thumbnail((cell - 6, cell - 6))
    sheet.paste(im, ((i % cols) * cell + (cell - im.width) // 2, (i // cols) * cell + (cell - im.height) // 2))
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out, quality=85)
print(out)
