// C41 — minimal EXIF date reader (JPEG only). Never throws.
//
// readExifDate(file)   File/Blob (or ArrayBuffer / typed array) -> Promise<Date|null>
//   DateTimeOriginal (Exif IFD 0x9003), falling back to IFD0 DateTime (0x0132).
//   The EXIF string has no zone, so it is interpreted as local time.
// formatExifDate(date) Date -> 'YYYY:MM:DD HH:MM:SS' (local time), or null if invalid.

const HEAD_BYTES = 256 * 1024;

export async function readExifDate(file) {
  try {
    let buf;
    if (file instanceof ArrayBuffer) buf = file.slice(0, HEAD_BYTES);
    else if (ArrayBuffer.isView(file)) buf = file.buffer.slice(file.byteOffset, file.byteOffset + Math.min(file.byteLength, HEAD_BYTES));
    else buf = await file.slice(0, HEAD_BYTES).arrayBuffer();
    return parseJpegDate(new DataView(buf));
  } catch {
    return null;
  }
}

function parseJpegDate(dv) {
  const n = dv.byteLength;
  if (n < 4 || dv.getUint16(0) !== 0xFFD8) return null;
  let p = 2;
  while (p + 4 <= n) {
    if (dv.getUint8(p) !== 0xFF) return null;
    let marker = dv.getUint8(p + 1);
    if (marker === 0xFF) { p++; continue; }               // fill byte
    p += 2;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue; // no length
    if (marker === 0xD9 || marker === 0xDA) return null;   // EOI / SOS: no more metadata
    if (p + 2 > n) return null;
    const len = dv.getUint16(p);
    if (len < 2) return null;
    if (marker === 0xE1 && len >= 8 && p + 8 <= n &&
        dv.getUint32(p + 2) === 0x45786966 && dv.getUint16(p + 6) === 0) {  // 'Exif\0\0'
      const end = Math.min(n, p + len);
      const d = parseTiff(dv, p + 8, end);
      if (d) return d;
    }
    p += len;
  }
  return null;
}

function parseTiff(dv, T, end) {
  if (T + 8 > end) return null;
  const bo = dv.getUint16(T);
  let le;
  if (bo === 0x4949) le = true; else if (bo === 0x4D4D) le = false; else return null;
  const u16 = (o) => dv.getUint16(T + o, le);
  const u32 = (o) => dv.getUint32(T + o, le);
  const lim = end - T;
  if (u16(2) !== 42) return null;

  const readIfd = (off) => {
    const tags = new Map();
    if (!(off >= 8 && off + 2 <= lim)) return tags;
    const count = u16(off);
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > lim) break;
      tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return tags;
  };
  const ascii = (ent) => {
    if (!ent || ent.type !== 2 || ent.count < 19) return null;
    const off = ent.count <= 4 ? ent.at : u32(ent.at);
    if (off + 19 > lim) return null;
    let s = '';
    for (let i = 0; i < 19; i++) s += String.fromCharCode(dv.getUint8(T + off + i));
    return s;
  };

  const ifd0 = readIfd(u32(4));
  let date = null;
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr && (exifPtr.type === 4 || exifPtr.type === 13)) {
    const exif = readIfd(u32(exifPtr.at));
    date = parseExifDateString(ascii(exif.get(0x9003)));
  }
  return date || parseExifDateString(ascii(ifd0.get(0x0132)));
}

function parseExifDateString(s) {
  if (!s) return null;
  const m = /^(\d{4})[:\-](\d\d)[:\-](\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1800 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
  const date = new Date(y, mo - 1, d, h, mi, se);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatExifDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${p(date.getFullYear(), 4)}:${p(date.getMonth() + 1)}:${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
