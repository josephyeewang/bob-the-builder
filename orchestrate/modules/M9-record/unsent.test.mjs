// unsent.test.mjs — the store's unsent-alerts.jsonl reader (L240, L288): a file that can't be read as one plain file is
// an error, never read as "no alerts waiting", so an alert is never lost to a corrupt or replaced file.
// Run: node --test orchestrate/modules/M9-record/unsent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { UNSENT, appendPlain, markSent, readUnsent } from './unsent.mjs';

const line = (x) => `${JSON.stringify(x)}\n`;

test('readUnsent: waiting entries oldest first; a sent mark and a torn line take nothing away from the rest', () => {
  const root = tempDir('m9-unsent-');
  writeFileSync(join(root, UNSENT), line({ id: 'a', outcome: 'unsent', event: { type: 't' } }) + '{"id":"b","outc\n' + line({ id: 'c', outcome: 'unsent', event: { type: 'u' } }));
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['a', 'c']);
  markSent(root, 'a', '2026-11-03T00:00:00Z');
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['c']);
});

test('L288: a folder, a link, a second name or a pipe in its place is refused, never read as empty', () => {
  const cases = {
    folder: (f) => mkdirSync(f),
    link: (f) => { writeFileSync(`${f}.real`, line({ id: 'z', outcome: 'unsent', event: { type: 't' } })); symlinkSync(`${f}.real`, f); },
    'second name': (f) => { writeFileSync(`${f}.real`, line({ id: 'z', outcome: 'unsent', event: { type: 't' } })); linkSync(`${f}.real`, f); },
    pipe: (f) => execFileSync('mkfifo', [f]),
  };
  for (const [name, make] of Object.entries(cases)) {
    const root = tempDir('m9-unsent-');
    make(join(root, UNSENT));
    assert.throws(() => readUnsent(root), undefined, name);
    assert.throws(() => markSent(root, 'z', 'x'), undefined, `${name}: no mark lands through it`);
  }
});

// ---- #260 r1 M1: on a full disk write() can land part of a line with no error ----
const half = (fd, bytes) => writeSync(fd, bytes.subarray(0, Math.floor(bytes.length / 2)));
const started = () => {
  const root = tempDir('m9-unsent-');
  const f = join(root, UNSENT);
  const before = line({ id: 'a', outcome: 'unsent', event: { type: 't' } }) + line({ id: 'a', outcome: 'sent', at: 'x' });
  writeFileSync(f, before);
  return { root, f, before };
};

test('#260 r1 M1: a short write on a file with lines in it is cut back and thrown, so the caller holds the line', () => {
  const { root, f, before } = started();
  const text = line({ id: 'b', outcome: 'unsent', event: { type: 'diary_damaged', reason: 'y'.repeat(400) } });
  assert.throws(() => appendPlain(f, text, { write: half }), (e) => e.code === 'ENOSPC' && /only \d+ of \d+ bytes/.test(e.message));
  assert.equal(readFileSync(f, 'utf8'), before, 'the half line is cut back off');
  appendPlain(f, text);
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['b'], 'the next write is whole and parses');
});

test('#260 r1 M1: a file whose last line has no newline gets one first, so the new line parses on its own', () => {
  const { root, f, before } = started();
  writeFileSync(f, `${before}{"id":"torn","outc`);
  appendPlain(f, line({ id: 'c', outcome: 'unsent', event: { type: 'u' } }));
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['c']);
  markSent(root, 'c', 'x');
  assert.deepEqual(readUnsent(root), []);
});

test('#260 r1 M1: the cut-back never takes another process\'s line appended after the short one', () => {
  const { f, before } = started();
  const other = line({ id: 'o', outcome: 'sent', at: 'x' });
  const thenOther = (fd, bytes) => { const n = half(fd, bytes); appendFileSync(f, other); return n; };
  assert.throws(() => appendPlain(f, line({ id: 'b', outcome: 'unsent', event: { type: 't' } }), { write: thenOther }));
  assert.ok(readFileSync(f, 'utf8').startsWith(before) && readFileSync(f, 'utf8').endsWith(other), 'the other line is kept');
});

test('#260 r1 M1: a write that lands nothing is thrown too', () => {
  const { f, before } = started();
  assert.throws(() => appendPlain(f, line({ id: 'b', outcome: 'unsent', event: { type: 't' } }), { write: () => 0 }), (e) => e.code === 'ENOSPC');
  assert.equal(readFileSync(f, 'utf8'), before);
});
