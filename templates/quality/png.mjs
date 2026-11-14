// png.mjs — read a PNG into RGBA pixels and compare two images, with Node's own zlib (no image library to install).
// Reads what a browser screenshot writes: 8 bits per channel, RGB or RGBA, not interlaced. Any other PNG is refused
// with the reason (fail closed), never compared as if it matched.

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let pos = 8, width, height, colorType, idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (data.length !== len) throw new Error('PNG is cut short');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8]; colorType = data[9];
      if (depth !== 8 || ![2, 6].includes(colorType) || data[12] !== 0) {
        throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${colorType}, interlace ${data[12]}); save it as 8-bit RGB or RGBA`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || idat.length === 0) throw new Error('PNG has no image data');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is cut short');
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let add;
      if (filter === 0) add = 0;
      else if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else throw new Error(`PNG row ${y} has an unknown filter ${filter}`);
      line[x] = (line[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels]; out[o + 1] = line[x * channels + 1]; out[o + 2] = line[x * channels + 2];
      out[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

// A pixel differs when any channel moves by more than pixelThreshold (0–1) of its range. Different sizes never match.
export function compareImages(a, b, { pixelThreshold = 0.1 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return { sameSize: false, diffPixels: null, diffRatio: 1, detail: `size ${a.width}×${a.height} vs reference ${b.width}×${b.height}` };
  }
  const limit = pixelThreshold * 255;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > limit || Math.abs(a.data[i + 1] - b.data[i + 1]) > limit ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > limit || Math.abs(a.data[i + 3] - b.data[i + 3]) > limit) diff++;
  }
  const total = a.width * a.height;
  return { sameSize: true, diffPixels: diff, diffRatio: diff / total, detail: `${diff} of ${total} pixels differ` };
}
