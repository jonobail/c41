/*
 * C41 — streaming baseline JPEG encoder (classic Web Worker, no imports).
 *
 * Format: baseline sequential DCT (SOF0), 8-bit, 3 components YCbCr 4:2:0
 * (Y 0x22, Cb/Cr 0x11), Annex K quantisation tables scaled with the IJG quality
 * formula, Annex K Huffman tables, AAN float FDCT. An Exif APP1 segment (big-endian
 * TIFF) is written straight after SOI — no JFIF APP0, like camera JPEGs — carrying
 * Orientation=1, Software="C41" and, when given, DateTime / DateTimeOriginal /
 * DateTimeDigitized.
 *
 * Worker protocol (docs/ARCHITECTURE.md §8):
 *   in : { type:'start', width, height, quality, exifDate? }   exifDate 'YYYY:MM:DD HH:MM:SS'
 *        { type:'rows', data: Uint8Array RGBA, rows }          any row count; 16-multiples are zero-copy
 *        { type:'finish' }
 *   out: { type:'consumed', rows } | { type:'done', blob } | { type:'error', message }
 *
 * Node / test loading: the whole file is one IIFE. If a CommonJS-style `module` object is
 * in scope, the API is assigned to `module.exports` and no worker wiring happens:
 *
 *   const src = fs.readFileSync('js/jpeg-worker.js', 'utf8');
 *   const m = { exports: {} };
 *   new Function('module', src)(m);
 *   const { createJpegEncoder } = m.exports;
 *
 * API: createJpegEncoder({ width, height, quality = 92, exifDate = null })
 *        -> { addRows(rgba, rows), finish() -> Uint8Array[] (chunks, concat = JPEG file) }
 *      buildExifApp1(exifDate|null) -> Uint8Array (complete FFE1 segment)
 *      scaleQuantTable(base, quality) -> Uint8Array (natural order), TABLES, ZIGZAG
 */
(function () {
  'use strict';

  var CHUNK = 1 << 20; // 1 MB output chunks

  // zig-zag index -> natural (row-major) index
  var ZIGZAG = new Int32Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);

  // Annex K.1 tables, natural order
  var LUMA_Q = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99];
  var CHROMA_Q = [
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99];

  // Annex K.3 Huffman tables: BITS[i] = number of codes of length i+1
  var DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  var DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  var DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
  var DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  var AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  var AC_LUMA_VALS = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa];
  var AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
  var AC_CHROMA_VALS = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa];

  // AAN scale factors: aasf[0] = 1, aasf[k] = cos(k*pi/16) * sqrt(2)
  var AASF = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];

  var EXIF_DATE_RE = /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/;

  function scaleQuantTable(base, quality) {
    var q = Math.round(Number(quality));
    if (!(q >= 1)) q = 1; if (q > 100) q = 100;
    var sf = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
    var out = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var t = Math.floor((base[i] * sf + 50) / 100);
      out[i] = t < 1 ? 1 : t > 255 ? 255 : t;
    }
    return out;
  }

  function buildHuffman(bits, vals) {
    var code = new Int32Array(256), size = new Int32Array(256);
    var c = 0, k = 0;
    for (var len = 1; len <= 16; len++) {
      for (var n = 0; n < bits[len - 1]; n++) {
        var v = vals[k++];
        code[v] = c++;
        size[v] = len;
      }
      c <<= 1;
    }
    return { code: code, size: size };
  }

  function fdtblFor(qt) {
    var t = new Float32Array(64);
    for (var n = 0; n < 64; n++) t[n] = 1 / (qt[n] * AASF[n >> 3] * AASF[n & 7] * 8);
    return t;
  }

  // ---- Exif APP1 (big-endian TIFF) ----
  function buildExifApp1(exifDate) {
    var date = typeof exifDate === 'string' && EXIF_DATE_RE.test(exifDate) ? exifDate : null;
    // entry: [tag, type, count, value(number) | bytes(array)]
    var ascii = function (s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0x7f); a.push(0); return a; };
    var ifd0 = [[0x0112, 3, 1, 1], [0x0131, 2, 4, ascii('C41')]];
    if (date) ifd0.push([0x0132, 2, 20, ascii(date)]);
    ifd0.push([0x8769, 4, 1, 0]); // patched below
    var exif = [[0x9000, 7, 4, [0x30, 0x32, 0x33, 0x31]]];
    if (date) { exif.push([0x9003, 2, 20, ascii(date)]); exif.push([0x9004, 2, 20, ascii(date)]); }

    var ifdSize = function (e) { return 2 + e.length * 12 + 4; };
    var dataSize = function (e) { var s = 0; e.forEach(function (x) { if (Array.isArray(x[3]) && x[3].length > 4) s += x[3].length + (x[3].length & 1); }); return s; };
    var ifd0Off = 8;
    var exifOff = ifd0Off + ifdSize(ifd0) + dataSize(ifd0);
    var tiffLen = exifOff + ifdSize(exif) + dataSize(exif);
    ifd0[ifd0.length - 1][3] = exifOff;

    var seg = new Uint8Array(4 + 6 + tiffLen);
    var dv = new DataView(seg.buffer);
    dv.setUint16(0, 0xFFE1); dv.setUint16(2, seg.length - 2);
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // 'Exif\0\0'
    var T = 10; // TIFF base
    seg.set([0x4D, 0x4D, 0x00, 0x2A], T); dv.setUint32(T + 4, ifd0Off);

    var writeIfd = function (entries, off) {
      var p = T + off, dataP = off + ifdSize(entries);
      dv.setUint16(p, entries.length); p += 2;
      entries.forEach(function (e) {
        dv.setUint16(p, e[0]); dv.setUint16(p + 2, e[1]); dv.setUint32(p + 4, e[2]);
        var v = e[3];
        if (Array.isArray(v)) {
          if (v.length <= 4) seg.set(v, p + 8);
          else { dv.setUint32(p + 8, dataP); seg.set(v, T + dataP); dataP += v.length + (v.length & 1); }
        } else if (e[1] === 3) dv.setUint16(p + 8, v);
        else dv.setUint32(p + 8, v);
        p += 12;
      });
      dv.setUint32(p, 0); // next IFD
    };
    writeIfd(ifd0, ifd0Off);
    writeIfd(exif, exifOff);
    return seg;
  }

  // ---- encoder ----
  function createJpegEncoder(opts) {
    opts = opts || {};
    var W = opts.width | 0, H = opts.height | 0;
    if (!(W > 0 && H > 0 && W <= 65535 && H <= 65535)) throw new Error('jpeg: invalid dimensions ' + opts.width + 'x' + opts.height);
    var quality = opts.quality == null ? 92 : opts.quality;
    var yQT = scaleQuantTable(LUMA_Q, quality), cQT = scaleQuantTable(CHROMA_Q, quality);
    var fdY = fdtblFor(yQT), fdC = fdtblFor(cQT);
    var hDCY = buildHuffman(DC_LUMA_BITS, DC_LUMA_VALS), hACY = buildHuffman(AC_LUMA_BITS, AC_LUMA_VALS);
    var hDCC = buildHuffman(DC_CHROMA_BITS, DC_CHROMA_VALS), hACC = buildHuffman(AC_CHROMA_BITS, AC_CHROMA_VALS);
    var dcYc = hDCY.code, dcYs = hDCY.size, acYc = hACY.code, acYs = hACY.size;
    var dcCc = hDCC.code, dcCs = hDCC.size, acCc = hACC.code, acCs = hACC.size;

    // output
    var chunks = [];
    var buf = new Uint8Array(CHUNK), pos = 0;
    function newChunk() { chunks.push(buf.subarray(0, pos)); buf = new Uint8Array(CHUNK); pos = 0; }
    function putByte(b) { if (pos >= CHUNK) newChunk(); buf[pos++] = b; }
    function putWord(w) { putByte(w >> 8 & 0xFF); putByte(w & 0xFF); }
    function putBytes(a) { for (var i = 0; i < a.length; i++) putByte(a[i]); }

    // 32-bit bit accumulator (holds < 8 pending bits between calls)
    var bitBuf = 0, bitCnt = 0;
    function writeBits(code, len) {
      bitBuf = (bitBuf << len) | code;
      bitCnt += len;
      while (bitCnt >= 8) {
        bitCnt -= 8;
        var b = (bitBuf >>> bitCnt) & 0xFF;
        if (pos >= CHUNK - 1) newChunk();
        buf[pos++] = b;
        if (b === 0xFF) buf[pos++] = 0; // byte stuffing
      }
      bitBuf &= (1 << bitCnt) - 1;
    }

    // ---- headers ----
    putWord(0xFFD8);
    if (opts.exif !== false) putBytes(buildExifApp1(opts.exifDate));
    putWord(0xFFDB); putWord(2 + 65 * 2);
    putByte(0); for (var i = 0; i < 64; i++) putByte(yQT[ZIGZAG[i]]);
    putByte(1); for (i = 0; i < 64; i++) putByte(cQT[ZIGZAG[i]]);
    putWord(0xFFC0); putWord(17); putByte(8); putWord(H); putWord(W); putByte(3);
    putByte(1); putByte(0x22); putByte(0);
    putByte(2); putByte(0x11); putByte(1);
    putByte(3); putByte(0x11); putByte(1);
    var dht = [[0x00, DC_LUMA_BITS, DC_LUMA_VALS], [0x10, AC_LUMA_BITS, AC_LUMA_VALS],
      [0x01, DC_CHROMA_BITS, DC_CHROMA_VALS], [0x11, AC_CHROMA_BITS, AC_CHROMA_VALS]];
    var dhtLen = 2; dht.forEach(function (t) { dhtLen += 17 + t[2].length; });
    putWord(0xFFC4); putWord(dhtLen);
    dht.forEach(function (t) { putByte(t[0]); putBytes(t[1]); putBytes(t[2]); });
    putWord(0xFFDA); putWord(12); putByte(3);
    putByte(1); putByte(0x00); putByte(2); putByte(0x11); putByte(3); putByte(0x11);
    putByte(0); putByte(63); putByte(0);

    // ---- planes for one MCU row (16 luma lines, 8 chroma lines) ----
    var mcuCols = Math.ceil(W / 16), pw = mcuCols * 16, cw = mcuCols * 8;
    var Yp = new Float32Array(pw * 16), Cbp = new Float32Array(cw * 8), Crp = new Float32Array(cw * 8);
    var blk = new Float32Array(64), zz = new Int32Array(64);
    var predY = 0, predCb = 0, predCr = 0;
    var stride = W * 4;
    var lineBuf = new Uint8Array(stride * 16), carry = 0;
    var rowsIn = 0, finished = false;

    // RGBA rows [row0, row0+nRows) of src -> planes; replicate last column / last row.
    function fill(src, row0, nRows) {
      var wLast = W - 1;
      for (var cy = 0; cy < 8; cy++) {
        var ra = 2 * cy, rb = ra + 1;
        if (ra >= nRows) ra = nRows - 1;
        if (rb >= nRows) rb = nRows - 1;
        var oa = (row0 + ra) * stride, ob = (row0 + rb) * stride;
        var ya = 2 * cy * pw, yb = ya + pw, co = cy * cw;
        for (var cx = 0; cx < cw; cx++) {
          var x0 = 2 * cx, x1 = x0 + 1;
          if (x1 > wLast) { x1 = wLast; if (x0 > wLast) x0 = wLast; }
          var p0 = oa + x0 * 4, p1 = oa + x1 * 4, p2 = ob + x0 * 4, p3 = ob + x1 * 4;
          var r0 = src[p0], g0 = src[p0 + 1], b0 = src[p0 + 2];
          var r1 = src[p1], g1 = src[p1 + 1], b1 = src[p1 + 2];
          var r2 = src[p2], g2 = src[p2 + 1], b2 = src[p2 + 2];
          var r3 = src[p3], g3 = src[p3 + 1], b3 = src[p3 + 2];
          var xi = 2 * cx;
          Yp[ya + xi] = 0.299 * r0 + 0.587 * g0 + 0.114 * b0 - 128;
          Yp[ya + xi + 1] = 0.299 * r1 + 0.587 * g1 + 0.114 * b1 - 128;
          Yp[yb + xi] = 0.299 * r2 + 0.587 * g2 + 0.114 * b2 - 128;
          Yp[yb + xi + 1] = 0.299 * r3 + 0.587 * g3 + 0.114 * b3 - 128;
          var rs = r0 + r1 + r2 + r3, gs = g0 + g1 + g2 + g3, bs = b0 + b1 + b2 + b3;
          Cbp[co + cx] = (-0.168736 * rs - 0.331264 * gs + 0.5 * bs) * 0.25;
          Crp[co + cx] = (0.5 * rs - 0.418688 * gs - 0.081312 * bs) * 0.25;
        }
      }
    }

    // AAN float FDCT of the 8x8 block at plane[off] (row stride `st`), quantise, zig-zag into zz.
    function fdctQuant(plane, off, st, fdtbl) {
      var d0, d1, d2, d3, d4, d5, d6, d7, t0, t1, t2, t3, t4, t5, t6, t7, t10, t11, t12, t13, z1, z2, z3, z4, z5, z11, z13;
      var i, p, o;
      for (i = 0; i < 8; i++) {
        p = off + i * st; o = i * 8;
        d0 = plane[p]; d1 = plane[p + 1]; d2 = plane[p + 2]; d3 = plane[p + 3];
        d4 = plane[p + 4]; d5 = plane[p + 5]; d6 = plane[p + 6]; d7 = plane[p + 7];
        t0 = d0 + d7; t7 = d0 - d7; t1 = d1 + d6; t6 = d1 - d6;
        t2 = d2 + d5; t5 = d2 - d5; t3 = d3 + d4; t4 = d3 - d4;
        t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
        blk[o] = t10 + t11; blk[o + 4] = t10 - t11;
        z1 = (t12 + t13) * 0.707106781;
        blk[o + 2] = t13 + z1; blk[o + 6] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        z5 = (t10 - t12) * 0.382683433;
        z2 = 0.541196100 * t10 + z5; z4 = 1.306562965 * t12 + z5; z3 = t11 * 0.707106781;
        z11 = t7 + z3; z13 = t7 - z3;
        blk[o + 5] = z13 + z2; blk[o + 3] = z13 - z2; blk[o + 1] = z11 + z4; blk[o + 7] = z11 - z4;
      }
      for (i = 0; i < 8; i++) {
        d0 = blk[i]; d1 = blk[i + 8]; d2 = blk[i + 16]; d3 = blk[i + 24];
        d4 = blk[i + 32]; d5 = blk[i + 40]; d6 = blk[i + 48]; d7 = blk[i + 56];
        t0 = d0 + d7; t7 = d0 - d7; t1 = d1 + d6; t6 = d1 - d6;
        t2 = d2 + d5; t5 = d2 - d5; t3 = d3 + d4; t4 = d3 - d4;
        t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
        blk[i] = t10 + t11; blk[i + 32] = t10 - t11;
        z1 = (t12 + t13) * 0.707106781;
        blk[i + 16] = t13 + z1; blk[i + 48] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        z5 = (t10 - t12) * 0.382683433;
        z2 = 0.541196100 * t10 + z5; z4 = 1.306562965 * t12 + z5; z3 = t11 * 0.707106781;
        z11 = t7 + z3; z13 = t7 - z3;
        blk[i + 40] = z13 + z2; blk[i + 24] = z13 - z2; blk[i + 8] = z11 + z4; blk[i + 56] = z11 - z4;
      }
      for (i = 0; i < 64; i++) {
        var n = ZIGZAG[i];
        var v = blk[n] * fdtbl[n];
        var q = v < 0 ? (v - 0.5) | 0 : (v + 0.5) | 0;
        if (q > 1023) q = 1023; else if (q < -1023) q = -1023; // AC range; DC never reaches this
        zz[i] = q;
      }
    }

    // Huffman-code zz (after fdctQuant); returns the new DC predictor.
    function codeBlock(pred, dcc, dcs, acc, acs) {
      var dc = zz[0], diff = dc - pred, a, cat;
      if (diff === 0) writeBits(dcc[0], dcs[0]);
      else {
        a = diff < 0 ? -diff : diff;
        cat = 32 - Math.clz32(a);
        writeBits(dcc[cat], dcs[cat]);
        writeBits(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
      }
      var end = 63;
      while (end > 0 && zz[end] === 0) end--;
      if (end === 0) { writeBits(acc[0], acs[0]); return dc; }
      var run = 0;
      for (var k = 1; k <= end; k++) {
        var v = zz[k];
        if (v === 0) { run++; continue; }
        while (run >= 16) { writeBits(acc[0xF0], acs[0xF0]); run -= 16; }
        a = v < 0 ? -v : v;
        cat = 32 - Math.clz32(a);
        var sym = (run << 4) | cat;
        writeBits(acc[sym], acs[sym]);
        writeBits(v < 0 ? v + (1 << cat) - 1 : v, cat);
        run = 0;
      }
      if (end < 63) writeBits(acc[0], acs[0]);
      return dc;
    }

    function encodeMcuRow() {
      for (var mx = 0; mx < mcuCols; mx++) {
        var yo = mx * 16;
        fdctQuant(Yp, yo, pw, fdY); predY = codeBlock(predY, dcYc, dcYs, acYc, acYs);
        fdctQuant(Yp, yo + 8, pw, fdY); predY = codeBlock(predY, dcYc, dcYs, acYc, acYs);
        fdctQuant(Yp, yo + 8 * pw, pw, fdY); predY = codeBlock(predY, dcYc, dcYs, acYc, acYs);
        fdctQuant(Yp, yo + 8 * pw + 8, pw, fdY); predY = codeBlock(predY, dcYc, dcYs, acYc, acYs);
        fdctQuant(Cbp, mx * 8, cw, fdC); predCb = codeBlock(predCb, dcCc, dcCs, acCc, acCs);
        fdctQuant(Crp, mx * 8, cw, fdC); predCr = codeBlock(predCr, dcCc, dcCs, acCc, acCs);
      }
    }

    function addRows(data, rows) {
      if (finished) throw new Error('jpeg: addRows after finish');
      rows = rows | 0;
      if (rows <= 0) return;
      if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      if (!data || data.length < rows * stride) throw new Error('jpeg: strip data too short (' + (data && data.length) + ' < ' + rows * stride + ')');
      if (rowsIn + rows > H) throw new Error('jpeg: too many rows (' + (rowsIn + rows) + ' > ' + H + ')');
      var r = 0;
      if (carry > 0) {
        var take = Math.min(16 - carry, rows);
        lineBuf.set(data.subarray(0, take * stride), carry * stride);
        carry += take; r = take;
        if (carry === 16) { fill(lineBuf, 0, 16); encodeMcuRow(); carry = 0; }
      }
      while (rows - r >= 16) { fill(data, r, 16); encodeMcuRow(); r += 16; }
      if (r < rows) {
        lineBuf.set(data.subarray(r * stride, rows * stride), 0);
        carry = rows - r;
      }
      rowsIn += rows;
    }

    function finish() {
      if (finished) throw new Error('jpeg: finish called twice');
      if (rowsIn !== H) throw new Error('jpeg: got ' + rowsIn + ' rows, expected ' + H);
      if (carry > 0) { fill(lineBuf, 0, carry); encodeMcuRow(); carry = 0; }
      if (bitCnt > 0) writeBits((1 << (8 - bitCnt)) - 1, 8 - bitCnt); // pad with 1-bits
      putWord(0xFFD9);
      chunks.push(buf.subarray(0, pos));
      finished = true;
      Yp = Cbp = Crp = lineBuf = null;
      var out = chunks; chunks = []; buf = null;
      return out;
    }

    return { width: W, height: H, addRows: addRows, finish: finish, get rowsReceived() { return rowsIn; } };
  }

  var api = {
    createJpegEncoder: createJpegEncoder,
    buildExifApp1: buildExifApp1,
    scaleQuantTable: scaleQuantTable,
    ZIGZAG: ZIGZAG,
    TABLES: {
      LUMA_Q: LUMA_Q, CHROMA_Q: CHROMA_Q,
      DC_LUMA_BITS: DC_LUMA_BITS, DC_LUMA_VALS: DC_LUMA_VALS,
      DC_CHROMA_BITS: DC_CHROMA_BITS, DC_CHROMA_VALS: DC_CHROMA_VALS,
      AC_LUMA_BITS: AC_LUMA_BITS, AC_LUMA_VALS: AC_LUMA_VALS,
      AC_CHROMA_BITS: AC_CHROMA_BITS, AC_CHROMA_VALS: AC_CHROMA_VALS,
    },
  };

  // Node / tests: `module` injected by the loader (see header).
  if (typeof module === 'object' && module !== null) { module.exports = api; return; }

  // Worker wiring.
  if (typeof self === 'undefined' || typeof importScripts !== 'function') return;
  var enc = null, failed = false;
  function fail(err) {
    failed = true; enc = null;
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
  self.onmessage = function (e) {
    var m = e.data || {};
    if (failed) return;
    try {
      if (m.type === 'start') {
        enc = createJpegEncoder({ width: m.width, height: m.height, quality: m.quality, exifDate: m.exifDate });
      } else if (m.type === 'rows') {
        if (!enc) throw new Error('jpeg: rows before start');
        enc.addRows(m.data, m.rows);
        self.postMessage({ type: 'consumed', rows: m.rows });
      } else if (m.type === 'finish') {
        if (!enc) throw new Error('jpeg: finish before start');
        var chunks = enc.finish();
        enc = null;
        self.postMessage({ type: 'done', blob: new Blob(chunks, { type: 'image/jpeg' }) });
      }
    } catch (err) { fail(err); }
  };
})();
