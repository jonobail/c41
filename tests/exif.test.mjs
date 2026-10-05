import test from 'node:test';
import assert from 'node:assert/strict';
import { readExifDate, formatExifDate } from '../js/exif.js';

/** Hand-built JPEG: SOI, APP0 JFIF, APP1 Exif (given endianness), SOS stub, EOI. */
function buildJpeg({ le, dto = null, dt = null, extraApp = false }) {
  const tiff = [];
  const u16 = (v) => (le ? [v & 255, v >> 8 & 255] : [v >> 8 & 255, v & 255]);
  const u32 = (v) => (le ? [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24] : [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255]);
  const str = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  // layout: header(8) | IFD0 @8 | data | ExifIFD | data
  const ifd0Entries = [];
  ifd0Entries.push([0x010F, 2, 6, str('Apple').slice(0, 6)]);      // Make (out-of-line, 6 bytes)
  if (dt) ifd0Entries.push([0x0132, 2, 20, str(dt)]);
  ifd0Entries.push([0x8769, 4, 1, null]);
  const ifd0Off = 8;
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  let dataOff = ifd0Off + ifd0Size;
  const ifd0Data = [];
  const exifEntries = dto ? [[0x9003, 2, 20, str(dto)]] : [[0x9000, 7, 4, [48, 50, 51, 49]]];
  // compute ifd0 data
  const ifd0Bytes = [];
  const pending = [];
  for (const [tag, type, count, val] of ifd0Entries) {
    ifd0Bytes.push(...u16(tag), ...u16(type), ...u32(count));
    if (val === null) { pending.push(ifd0Bytes.length); ifd0Bytes.push(0, 0, 0, 0); } else if (val.length <= 4) ifd0Bytes.push(...val, ...Array(4 - val.length).fill(0));
    else { ifd0Bytes.push(...u32(dataOff)); ifd0Data.push(...val); dataOff += val.length; }
  }
  const exifOff = dataOff;
  const patch = u32(exifOff);
  for (const p of pending) ifd0Bytes.splice(p, 4, ...patch);
  const exifSize = 2 + exifEntries.length * 12 + 4;
  let eData = exifOff + exifSize;
  const exifBytes = [], exifData = [];
  for (const [tag, type, count, val] of exifEntries) {
    exifBytes.push(...u16(tag), ...u16(type), ...u32(count));
    if (val.length <= 4) exifBytes.push(...val);
    else { exifBytes.push(...u32(eData)); exifData.push(...val); eData += val.length; }
  }
  tiff.push(...(le ? [0x49, 0x49] : [0x4D, 0x4D]), ...u16(42), ...u32(ifd0Off));
  tiff.push(...u16(ifd0Entries.length), ...ifd0Bytes, ...u32(0), ...ifd0Data);
  tiff.push(...u16(exifEntries.length), ...exifBytes, ...u32(0), ...exifData);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const jfif = [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const bytes = [0xFF, 0xD8,
    0xFF, 0xE0, ...[(jfif.length + 2) >> 8, (jfif.length + 2) & 255], ...jfif];
  if (extraApp) bytes.push(0xFF, 0xE1, 0, 8, 0x68, 0x74, 0x74, 0x70, 0, 0); // non-Exif APP1 (XMP-ish)
  bytes.push(0xFF, 0xE1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1,
    0xFF, 0xDA, 0, 2, 1, 2, 3, 0xFF, 0xD9);
  return new Uint8Array(bytes);
}

const parts = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];

for (const le of [false, true]) {
  const tag = le ? 'II' : 'MM';
  test(`${tag}: DateTimeOriginal`, async () => {
    const d = await readExifDate(new Blob([buildJpeg({ le, dto: '2001:02:03 04:05:06', dt: '2010:10:10 10:10:10' })]));
    assert.deepEqual(parts(d), [2001, 2, 3, 4, 5, 6]);
  });
  test(`${tag}: fallback to IFD0 DateTime`, async () => {
    const d = await readExifDate(new Blob([buildJpeg({ le, dt: '1998:10:05 12:34:56' })]));
    assert.deepEqual(parts(d), [1998, 10, 5, 12, 34, 56]);
  });
  test(`${tag}: skips non-Exif APP1, no dates → null`, async () => {
    const d = await readExifDate(new Blob([buildJpeg({ le, dto: '2022:12:31 23:59:59', extraApp: true })]));
    assert.deepEqual(parts(d), [2022, 12, 31, 23, 59, 59]);
    assert.equal(await readExifDate(new Blob([buildJpeg({ le, extraApp: true })])), null);
  });
}

test('zeroed date → falls back / null', async () => {
  assert.equal(await readExifDate(new Blob([buildJpeg({ le: false, dto: '0000:00:00 00:00:00' })])), null);
  const d = await readExifDate(new Blob([buildJpeg({ le: true, dto: '0000:00:00 00:00:00', dt: '2005:05:05 05:05:05' })]));
  assert.deepEqual(parts(d), [2005, 5, 5, 5, 5, 5]);
});

test('garbage / truncated / non-JPEG → null, never throws', async () => {
  const rnd = new Uint8Array(5000).map((_, i) => (i * 7919) & 255);
  assert.equal(await readExifDate(new Blob([rnd])), null);
  assert.equal(await readExifDate(new Blob([])), null);
  assert.equal(await readExifDate(new Blob([new Uint8Array([0xFF, 0xD8, 0xFF])])), null);
  const good = buildJpeg({ le: false, dto: '2001:02:03 04:05:06' });
  for (let n = 0; n < good.length; n += 3) {
    const r = await readExifDate(new Blob([good.subarray(0, n)]));
    assert.ok(r === null || r instanceof Date);
  }
  // corrupted offsets
  const bad = good.slice(); bad[30] = 0xFF; bad[31] = 0xFF;
  const r = await readExifDate(new Blob([bad]));
  assert.ok(r === null || r instanceof Date);
  assert.equal(await readExifDate(null), null);
  assert.equal(await readExifDate({}), null);
  // PNG signature
  assert.equal(await readExifDate(new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10])])), null);
});

test('formatExifDate', () => {
  assert.equal(formatExifDate(new Date(2024, 0, 2, 3, 4, 5)), '2024:01:02 03:04:05');
  assert.equal(formatExifDate(new Date(1999, 11, 31, 23, 59, 59)), '1999:12:31 23:59:59');
  assert.equal(formatExifDate(new Date(NaN)), null);
  assert.equal(formatExifDate('2024'), null);
});
