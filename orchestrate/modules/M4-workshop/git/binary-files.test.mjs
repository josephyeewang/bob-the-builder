// The file-kind check behind the push script's secret scan (LEAD-CALLS L28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isText, allowList, checkFile, realType } from './binary-files.mjs';

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
  assert.equal(realType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9])), 'jpeg');
  assert.equal(realType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0x50, 0x4b])), null, 'a JPEG start with something else after its end');
});
