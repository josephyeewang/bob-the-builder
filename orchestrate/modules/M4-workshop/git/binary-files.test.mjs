// The file-kind check behind the push script's secret scan (LEAD-CALLS L28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, gzipSync } from 'node:zlib';
import { isText, allowList, checkFile, realType, pngPixels, packedAsText, maskPath } from './binary-files.mjs';
import { chunk, makePng, ihdr, PNG_START } from './png-fixture.mjs';

test('L28: plain UTF-8 text passes; a zero byte or bytes that are not UTF-8 are not text', () => {
  assert.equal(isText(Buffer.from('héllo\n')), true);
  assert.equal(isText(Buffer.alloc(0)), true);
  assert.equal(isText(Buffer.from([0x68, 0x00, 0x69])), false);
  assert.equal(isText(Buffer.from([0x68, 0xff, 0xfe, 0x69])), false, 'Latin-1 or packed bytes with no zero byte');
  assert.equal(checkFile('a.txt', Buffer.from([0xc3, 0x28]), allowList([])).ok, false);
});

test('L28: an entry this check does not understand allows nothing', () => {
  for (const bad of [undefined, null, 'docs/*.png', {}, [null], [{ path: 'docs/*.png' }], [{ path: 'docs/*.png', type: 'zip' }], [{ path: '/docs/*.png', type: 'png' }], [{ path: 'docs/../*.png', type: 'png' }], [{ path: '', type: 'png' }], [{ path: 3, type: 'png' }]]) {
    assert.deepEqual(allowList(bad), [], JSON.stringify(bad));
  }
  assert.equal(allowList([{ path: 'docs/**/*.png', type: 'png' }]).length, 1);
});

test('L28: a pattern matches whole paths only: ** spans folders, * stays within one', () => {
  const [e] = allowList([{ path: 'docs/**/*.png', type: 'png' }]);
  for (const p of ['docs/a.png', 'docs/x/y/a.png']) assert.equal(e.re.test(p), true, p);
  for (const p of ['xdocs/a.png', 'docs/a.png.zip', 'other/docs/a.png', 'docs/a.pngx', 'docs/a_png']) assert.equal(e.re.test(p), false, p);
  const [f] = allowList([{ path: 'img/*.png', type: 'png' }]);
  assert.equal(f.re.test('img/a/b.png'), false);
});

test('L28: the real type is read from the bytes', () => {
  assert.equal(realType(Buffer.from('PK\x03\x04 not an image')), null);
  assert.equal(realType(makePng()), 'png');
  assert.deepEqual(pngPixels(makePng()), Buffer.from([128]), 'the row without its filter byte');
});

test('round 3 MAT-1: only PNG is offered; JPEG, GIF, WebP and font files are not images it allows, and an entry naming them allows nothing', () => {
  const others = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]),
    gif: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'),
    webp: (() => { const b = Buffer.alloc(16); b.write('RIFF'); b.writeUInt32LE(8, 4); b.write('WEBP', 8); return b; })(),
    woff: (() => { const b = Buffer.alloc(16); b.write('wOFF'); b.writeUInt32BE(16, 8); return b; })(),
    woff2: (() => { const b = Buffer.alloc(16); b.write('wOF2'); b.writeUInt32BE(16, 8); return b; })(),
  };
  for (const [type, b] of Object.entries(others)) {
    assert.equal(realType(b), null, type);
    assert.deepEqual(allowList([{ path: '**/*', type }]), [], type);
    assert.equal(checkFile('a.bin', b, allowList([{ path: '**/*', type: 'png' }])).ok, false, type);
  }
});

test('round 3 MAT-1 and MIN-2: every planted bad PNG is refused, each by the one check it breaks', () => {
  const good = makePng();
  const sum = (b) => { const c = Buffer.from(b); c[c.length - 13] ^= 1; return c; }; // IDAT's last check-sum byte sits before IEND (12 bytes)
  const bad = {
    'a bad check sum': sum(good),
    'IHDR not first': Buffer.concat([PNG_START, chunk('tEXt', Buffer.from('a\0b')), good.subarray(8)]),
    'a header-sized chunk before IHDR': Buffer.concat([PNG_START, chunk('tEXt', ihdr()), good.subarray(8)]),
    'a second IHDR': Buffer.concat([PNG_START, chunk('IHDR', ihdr()), good.subarray(8)]),
    'a private chunk': makePng({ extra: [chunk('prVt', deflateSync(Buffer.from('hidden')))] }),
    'a packed colour profile (iCCP)': makePng({ extra: [chunk('iCCP', Buffer.concat([Buffer.from('p\0\0'), deflateSync(Buffer.from('hidden'))]))] }),
    'packed text (zTXt)': makePng({ extra: [chunk('zTXt', Buffer.concat([Buffer.from('c\0\0'), deflateSync(Buffer.from('hidden'))]))] }),
    'international text (iTXt)': makePng({ extra: [chunk('iTXt', Buffer.from('c\0\0\0\0\0hidden'))] }),
    'camera data (eXIf)': makePng({ extra: [chunk('eXIf', Buffer.from('MM\0*hidden'))] }),
    'an animation frame (fdAT)': makePng({ extra: [chunk('acTL', Buffer.alloc(8))] }),
    'data after the end': makePng({ after: Buffer.from('more') }),
    'image data larger than the header says': makePng({ pixels: Buffer.from([0, 128, 1, 2, 3]) }),
    'image data smaller than the header says': makePng({ head: ihdr({ w: 4 }) }),
    'a second packed stream after the image data': makePng({ idat: Buffer.concat([deflateSync(Buffer.from([0, 128])), deflateSync(Buffer.from('hidden'))]) }),
    'image data split around another chunk': Buffer.concat([PNG_START, chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(Buffer.from([0, 128])).subarray(0, 4)), chunk('tEXt', Buffer.from('a\0b')), chunk('IDAT', deflateSync(Buffer.from([0, 128])).subarray(4)), chunk('IEND', Buffer.alloc(0))]),
    'an interlaced image': makePng({ head: ihdr({ lace: 1 }) }),
    'a depth the colour type does not have': makePng({ head: ihdr({ color: 2, depth: 4 }), pixels: Buffer.from([0, 1, 2]) }), // the right size for that depth, so only the depth check refuses it
    'a header claiming a huge image': makePng({ head: ihdr({ w: 100000, h: 100000 }) }),
    'a real image just over the size cap': makePng({ head: ihdr({ w: 8192, h: 8192 }), pixels: Buffer.alloc(8192 * 8193) }),
    'a short header': Buffer.concat([PNG_START, chunk('IHDR', ihdr().subarray(0, 12)), good.subarray(8 + 25)]),
    'no image data': Buffer.concat([PNG_START, chunk('IHDR', ihdr()), chunk('IEND', Buffer.alloc(0))]),
    'image data that does not unpack': makePng({ idat: Buffer.from('not packed at all') }),
  };
  const list = allowList([{ path: '**/*.png', type: 'png' }]);
  assert.equal(checkFile('a.png', good, list).ok, true, 'control: the good image passes');
  for (const [why, b] of Object.entries(bad)) {
    assert.equal(pngPixels(b), null, why);
    assert.equal(checkFile('a.png', b, list).ok, false, why);
  }
});

test('round 3 MAT-1: an allowed PNG comes back with its unpacked image data, for the scan', () => {
  const pixels = Buffer.concat([Buffer.from([0]), Buffer.from('key = "x"')]);
  const b = makePng({ head: ihdr({ w: pixels.length - 1 }), pixels });
  const r = checkFile('docs/a.png', b, allowList([{ path: 'docs/*.png', type: 'png' }]));
  assert.deepEqual(r.binary, { path: 'docs/a.png', type: 'png' });
  assert.deepEqual(r.unpacked, pixels.subarray(1));
  assert.equal(checkFile('a.txt', Buffer.from('text'), []).unpacked, undefined);
});

test('round 3 MIN-1: packed data written out as base64 in a text file is refused; ordinary base64 is not', () => {
  const secret = Buffer.from('key = "not-a-real-one"\n');
  const zipStart = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)]);
  for (const packed of [gzipSync(secret), zipStart]) {
    for (const t of [packed.toString('base64'), `data = "${packed.toString('base64url')}"`, `x\n${packed.toString('base64')}\n`]) {
      assert.equal(packedAsText(t), true, t);
      assert.match(checkFile('a.txt', Buffer.from(t), []).reason ?? '', /packed data written out as text/);
    }
  }
  for (const ok of [secret.toString('base64').repeat(3), `"integrity": "sha512-${Buffer.alloc(64, 7).toString('base64')}"`, 'H4sI short']) assert.equal(packedAsText(ok), false, ok);
});

test('round 3 MIN-3: a secret-shaped run in a path is cut to its first four characters', () => {
  assert.equal(maskPath(`docs/ghp_${'A1'.repeat(18)}.zip`), 'docs/ghp_….zip');
  assert.equal(maskPath('.github/workflows/evil.yml'), '.github/workflows/evil.yml');
  const r = checkFile(`ghp_${'A1'.repeat(18)}.zip`, Buffer.from([0, 1]), []);
  assert.doesNotMatch(r.reason, /A1A1A1/);
});

test('round 4 MIN-1: each row loses its filter byte, so a line laid across two rows reads as one', () => {
  const line = Buffer.from('key = "abcdefgh"\n ');
  const rows = [line.subarray(0, 9), line.subarray(9)];
  const b = makePng({ head: ihdr({ w: 9, h: 2 }), pixels: Buffer.concat([Buffer.from([0]), rows[0], Buffer.from([0]), rows[1]]) });
  assert.deepEqual(pngPixels(b), line);
  assert.deepEqual(checkFile('docs/a.png', b, allowList([{ path: 'docs/*.png', type: 'png' }])).unpacked, line);
});

test('round 4 MIN-1: an allowed image whose pixels start like packed data is refused', () => {
  const list = allowList([{ path: 'docs/*.png', type: 'png' }]);
  for (const packed of [gzipSync(Buffer.from('key = "x"')), Buffer.from([0x78, 0x9c, 1, 2, 3]), makePng()]) {
    const b = makePng({ head: ihdr({ w: packed.length }), pixels: Buffer.concat([Buffer.from([0]), packed]) });
    assert.match(checkFile('docs/a.png', b, list).reason ?? '', /pixels start like packed data/);
  }
  assert.equal(checkFile('docs/a.png', makePng(), list).ok, true, 'control: plain pixels pass');
});

test('round 4 MIN-2 and MIN-3: every packed start, as base64 and as base64url with - or _ in its first characters, is refused', () => {
  const starts = { gzip: [0x1f, 0x8b, 0x08], zip: [0x50, 0x4b, 0x03, 0x04], '7z': [0x37, 0x7a, 0xbc, 0xaf], bzip2: [0x42, 0x5a, 0x68], xz: [0xfd, 0x37, 0x7a, 0x58], zstd: [0x28, 0xb5, 0x2f, 0xfd],
    zlib1: [0x78, 0x01], zlib5e: [0x78, 0x5e], zlib9c: [0x78, 0x9c], zlibda: [0x78, 0xda], png: [0x89, 0x50, 0x4e, 0x47] };
  let early = 0;
  for (const [name, s] of Object.entries(starts)) {
    const b = Buffer.concat([Buffer.from(s), Buffer.alloc(40, 0xfb)]);
    const url = b.toString('base64url');
    if (/[-_]/.test(url.slice(0, 8))) early += 1;
    for (const t of [b.toString('base64'), url]) assert.equal(packedAsText(t), true, `${name}: ${t}`);
  }
  assert.ok(early >= 5, `control: the url forms put - or _ in the first characters (${early})`);
});

test('round 4 MIN-3: an image bomb over 64 MB is refused without unpacking it in full', () => {
  const list = allowList([{ path: 'docs/*.png', type: 'png' }]);
  const big = makePng({ head: ihdr({ w: 8192, h: 8192 }), idat: deflateSync(Buffer.alloc(8192 * 8193)) });
  const small = makePng({ idat: deflateSync(Buffer.alloc(70 * 1024 * 1024)) }); // says 1 by 1, unpacks to 70 MB
  for (const b of [big, small]) {
    assert.equal(pngPixels(b), null);
    assert.equal(checkFile('docs/a.png', b, list).ok, false);
  }
});

test('round 4 MIN-4: a UUID, or a long run split by - _ + = that holds a digit, is cut to its first four characters', () => {
  assert.equal(maskPath('a/123e4567-e89b-12d3-a456-426614174000.txt'), 'a/123e….txt');
  assert.equal(maskPath('k/abcd-1234-efgh-5678-ijkl.txt'), 'k/abcd….txt');
  assert.equal(maskPath('a/abcdefab-cdef-abcd-efab-cdefabcdefab.txt'), 'a/abcd….txt', 'a UUID with no digit: only the UUID rule catches it');
  assert.equal(maskPath('k/ab_cd+12=ef_gh34ij.txt'), 'k/ab_c….txt');
  assert.equal(maskPath('docs/release-notes-for-everyone.md'), 'docs/release-notes-for-everyone.md', 'no digit: left as it is');
});
