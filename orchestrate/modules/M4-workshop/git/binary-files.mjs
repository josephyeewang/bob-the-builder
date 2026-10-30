// Which new files the push script lets through unread (LEAD-CALLS L28, audit R-0b-47 round 2 MAT-A).
//
// A scanner cannot see a secret inside a file it cannot read: a packed archive under any name, a
// locked file, an image's compressed data. So by default every new or changed file must be plain
// UTF-8 text with no zero byte, and anything else is refused. A product's rules entry may allow
// named image and font types under named paths (`product.allowed_binaries`, for example
// [{ path: 'docs/**/*.png', type: 'png' }]). Even then the file's real type is read from its
// bytes, never its name, so a zip renamed to .png is refused. Each allowed file is listed in the
// push's read-back. Anything in the entry this file does not understand allows nothing.

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// A PNG is walked chunk by chunk: IHDR first, IEND last with nothing after it, every check sum
// right, and no compressed text chunk (zTXt, iTXt), whose contents no scan could read.
function png(b) {
  if (b.length < 20 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let at = 8; let first = true;
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    if (at + 12 + len > b.length || !/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(b.subarray(at + 4, at + 8 + len)) !== b.readUInt32BE(at + 8 + len)) return false;
    if ((first && type !== 'IHDR') || type === 'zTXt' || type === 'iTXt') return false;
    first = false;
    at += 12 + len;
    if (type === 'IEND') return at === b.length;
  }
  return false;
}

// Only a PNG is walked in full. The others are checked by their start and their end or stated
// length, which stops a renamed file but not a file built to pass, so a product should name them
// only under paths it trusts. Types with nothing to check but a start marker (ico, ttf, otf) are
// not offered.
const MAGIC = {
  png,
  jpeg: (b) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9,
  gif: (b) => b.length >= 7 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) && b[b.length - 1] === 0x3b,
  webp: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' && b.readUInt32LE(4) + 8 === b.length,
  woff: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'wOFF' && b.readUInt32BE(8) === b.length,
  woff2: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'wOF2' && b.readUInt32BE(8) === b.length,
};
export const BINARY_TYPES = Object.freeze(Object.keys(MAGIC));

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

/** { ok: true, binary: null } for text, { ok: true, binary: { path, type } } for an allowed one, else a refusal. */
export function checkFile(path, buf, list) {
  if (isText(buf)) return { ok: true, binary: null };
  const type = realType(buf);
  if (type && list.some((e) => e.type === type && e.re.test(path))) return { ok: true, binary: { path, type } };
  const why = type ? `a ${type} file where the product's rules allow none` : 'not plain UTF-8 text, and not an allowed image or font';
  return { ok: false, reason: `the new file ${String(path).slice(0, 120)} cannot be scanned for secrets: ${why}` };
}
