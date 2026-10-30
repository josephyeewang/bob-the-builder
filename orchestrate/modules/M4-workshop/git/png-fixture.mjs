// PNG files built for the tests (binary-files.test.mjs, push.test.mjs): one builder, so a planted
// bad image differs from a good one by exactly the part under test.
import { deflateSync } from 'node:zlib';
import { crc32 } from './binary-files.mjs';

export const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const chunk = (type, data, { badSum = false } = {}) => {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE((crc32(Buffer.concat([t, data])) ^ (badSum ? 1 : 0)) >>> 0);
  return Buffer.concat([len, t, data, c]);
};

// IHDR for a grey 8-bit image, `w` by `h`, not interlaced unless `lace`.
export const ihdr = ({ w = 1, h = 1, depth = 8, color = 0, lace = 0 } = {}) => {
  const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = color; b[12] = lace; return b;
};

/**
 * A valid PNG (1x1 grey by default). `text` adds a plain tEXt chunk; `extra` chunks go after it;
 * `pixels` is the unpacked image data (filter byte plus row); `head` replaces IHDR's data;
 * `idat` replaces the packed data; `after` is appended past IEND.
 */
export function makePng({ text, extra = [], pixels = Buffer.from([0, 128]), head = ihdr(), idat, after } = {}) {
  return Buffer.concat([PNG_START, chunk('IHDR', head), ...(text ? [chunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1')]))] : []),
    ...extra, chunk('IDAT', idat ?? deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)), ...(after ? [after] : [])]);
}
