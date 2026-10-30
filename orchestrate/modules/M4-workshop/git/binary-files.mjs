// Which new files the push script lets through unread (LEAD-CALLS L28, audit R-0b-47 round 2 MAT-A).
//
// A scanner cannot see a secret inside a file it cannot read: a packed archive under any name, a
// locked file, an image's compressed data. So by default every new or changed file must be plain
// UTF-8 text with no zero byte, and anything else is refused. A product's rules entry may allow
// named PNG images under named paths (`product.allowed_binaries`, for example
// [{ path: 'docs/**/*.png', type: 'png' }]). Even then the file's real type is read from its
// bytes, never its name, so a zip renamed to .png is refused. Each allowed file is listed in the
// push's read-back. Anything in the entry this file does not understand allows nothing.

import { inflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// Only PNG is offered, and it is read in full (audit R-0b-47 round 3 MAT-1). The chunks must come
// in order from a fixed list of plain kinds: IHDR first, IDAT runs together, IEND last with nothing
// after it, every check sum right. Private chunks and every packed kind but the image data (zTXt,
// iTXt, iCCP, eXIf, animation frames) are refused. The image data must unpack, as one stream with
// nothing after it, to exactly the size the header states; the unpacked bytes go back for the scan.
// Interlaced images are refused rather than sized. JPEG, GIF, WebP and fonts are not offered until
// each is read as fully (an entry naming them allows nothing).
const PLAIN_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'pHYs', 'tIME', 'tEXt']);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
export const MAX_PIXEL_BYTES = 64 * 1024 * 1024;

/** The unpacked image data of a PNG that passes every check above, or null. */
export function pngPixels(b) {
  if (b.length < 20 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  let at = 8; let first = true; let size = -1; let row = 0; const idat = []; let idatDone = false;
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    if (at + 12 + len > b.length || !PLAIN_CHUNKS.has(type)) return null;
    if (crc32(b.subarray(at + 4, at + 8 + len)) !== b.readUInt32BE(at + 8 + len)) return null;
    const data = b.subarray(at + 8, at + 8 + len);
    if (first !== (type === 'IHDR')) return null;
    if (first) {
      if (len !== 13) return null;
      const [w, h, depth, color, comp, filter, lace] = [data.readUInt32BE(0), data.readUInt32BE(4), ...data.subarray(8, 13)];
      if (!w || !h || !DEPTHS[color]?.includes(depth) || comp || filter || lace) return null;
      row = 1 + Math.ceil((w * CHANNELS[color] * depth) / 8);
      size = h * row;
      if (size > MAX_PIXEL_BYTES) return null;
    }
    first = false;
    if (type === 'IDAT') { if (idatDone) return null; idat.push(data); } else if (idat.length) idatDone = true;
    at += 12 + len;
    if (type === 'IEND') {
      if (at !== b.length || !idat.length) return null;
      const packed = Buffer.concat(idat);
      try {
        const r = inflateSync(packed, { info: true, maxOutputLength: size + 1 });
        if (r.buffer.length !== size || r.engine.bytesWritten !== packed.length) return null;
        // Each row starts with one filter byte; it is dropped so a secret that runs from one row into
        // the next reads as one run (audit R-0b-47 round 4 MIN-1).
        const out = Buffer.alloc(size - size / row);
        for (let y = 0; y < size / row; y++) r.buffer.copy(out, y * (row - 1), y * row + 1, (y + 1) * row);
        return out;
      } catch { return null; }
    }
  }
  return null;
}

const MAGIC = { png: (b) => pngPixels(b) !== null };
export const BINARY_TYPES = Object.freeze(Object.keys(MAGIC));

// A secret can be a file's name. Any run of 20 or more letters and digits in a path
// is cut to its first four before the path goes into a refusal or the record (round 3 MIN-3).
// Also any UUID-shaped run, and any run of 16 or more of letters, digits and - _ + = that holds a digit
// (round 4 MIN-4): keys split into short parts.
export const maskPath = (p) => String(p)
  .replace(/[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}/g, (m) => `${m.slice(0, 4)}…`)
  .replace(/[A-Za-z0-9_+=-]{16,}/g, (m) => (/[0-9]/.test(m) ? `${m.slice(0, 4)}…` : m))
  .replace(/[A-Za-z0-9]{20,}/g, (m) => `${m.slice(0, 4)}…`);

// Packed data written out as base64 (round 3 MIN-1): a long base64 run whose first bytes mark
// gzip, zip, 7z, bzip2, xz, zstd, raw zlib or a PNG (round 4 MIN-2: an embedded `data:` image). Deliberate encoding of other kinds still gets through; the
// scan stops accidents and the named tricks.
const PACKED_STARTS = [[0x1f, 0x8b, 0x08], [0x50, 0x4b, 0x03, 0x04], [0x37, 0x7a, 0xbc, 0xaf], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58], [0x28, 0xb5, 0x2f, 0xfd],
  [0x78, 0x01], [0x78, 0x5e], [0x78, 0x9c], [0x78, 0xda], [0x89, 0x50, 0x4e, 0x47]];
export const packedStart = (bytes) => PACKED_STARTS.some((s) => s.every((x, i) => bytes[i] === x));
export function packedAsText(text) {
  for (const m of String(text).matchAll(/[A-Za-z0-9+/_-]{40,}/g)) {
    // Node's base64 reader takes the url letters - and _ as well, so both forms decode here.
    const head = Buffer.from(m[0].slice(0, 8), 'base64');
    if (packedStart(head)) return true;
  }
  return false;
}

/** True when the bytes are plain UTF-8 text with no zero byte. */
export function isText(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** The type the bytes really are, of the allowed kinds, or null. */
export function realType(buf) {
  for (const [t, ok] of Object.entries(MAGIC)) if (ok(buf)) return t;
  return null;
}

// A path pattern: `**` any folders, `*` any characters but `/`. Nothing else is special.
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The rules entry as a clean list; anything malformed is dropped (it allows nothing). */
export function allowList(entry) {
  if (!Array.isArray(entry)) return [];
  return entry.filter((e) => e && typeof e === 'object' && typeof e.path === 'string' && e.path && !e.path.startsWith('/')
    && !e.path.split('/').includes('..') && BINARY_TYPES.includes(e.type)).map((e) => ({ re: globRe(e.path), type: e.type }));
}

/**
 * { ok: true, binary: null } for text, { ok: true, binary: { path, type }, unpacked } for an allowed
 * one (`unpacked`: its image data, for the scan), else a refusal.
 */
export function checkFile(path, buf, list) {
  const shown = maskPath(String(path).slice(0, 120));
  if (isText(buf)) {
    if (packedAsText(buf.toString('utf8'))) return { ok: false, reason: `the new file ${shown} holds packed data written out as text, which cannot be scanned for secrets` };
    return { ok: true, binary: null };
  }
  const type = realType(buf);
  if (type && list.some((e) => e.type === type && e.re.test(path))) {
    const unpacked = pngPixels(buf);
    // Packed data written out as text in a text note or in the pixels (confirm audit of round 4, Minor 1).
    if (packedAsText(buf.toString('latin1')) || (unpacked && packedAsText(unpacked.toString('latin1')))) return { ok: false, reason: `the new file ${shown} is an image holding packed data written out as text, which cannot be scanned for secrets` };
    if (packedStart(unpacked)) return { ok: false, reason: `the new file ${shown} is an image whose pixels start like packed data, which cannot be scanned for secrets` };
    return { ok: true, binary: { path, type }, unpacked };
  }
  const why = type ? `a ${type} file where the product's rules allow none` : 'not plain UTF-8 text, and not an allowed image';
  return { ok: false, reason: `the new file ${shown} cannot be scanned for secrets: ${why}` };
}
