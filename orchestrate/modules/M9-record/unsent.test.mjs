// unsent.test.mjs — the store's unsent-alerts.jsonl reader (L240, L288): a file that can't be read as one plain file is
// an error, never read as "no alerts waiting", so an alert is never lost to a corrupt or replaced file.
// Run: node --test orchestrate/modules/M9-record/unsent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { HELD_FLAG, HELD_FLAG_BYTES, UNSENT, appendPlain, clearHeldFlag, makeHeldFlag, markSent, readHeldFlag, readUnsent, setHeldFlag } from './unsent.mjs';

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

// ---- #260 r2 m1 / c1: a newline always goes first, and a 1-byte short write is never cut back ----

test('#260 r2 m1: a line appended right after another writer\'s cut-short line still parses (Q7)', () => {
  const { root, f } = started();
  const race = (fd, bytes) => { appendFileSync(f, '{"id":"other","outcome":"unsent","ev'); return writeSync(fd, bytes); };
  appendPlain(f, line({ id: 'ours', outcome: 'unsent', event: { type: 'diary_damaged' } }), { write: race });
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['ours'], 'ours parses on its own line');
});

test('#260 r2 c1: a short write that lands only the leading newline is never cut back, so another writer\'s line is kept (Q8)', () => {
  const { root, f, before } = started();
  writeFileSync(f, `${before}{"torn`);
  const other = line({ id: 'o', outcome: 'unsent', event: { type: 'x' } });
  const one = (fd, bytes) => { const n = writeSync(fd, bytes.subarray(0, 1)); appendFileSync(f, other); return n; };
  assert.throws(() => appendPlain(f, line({ id: 'ours', outcome: 'unsent', event: { type: 't' } }), { write: one }), (e) => e.code === 'ENOSPC');
  assert.ok(readFileSync(f, 'utf8').endsWith(other), 'their line is byte-for-byte intact');
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['o']);
});

// ---- #260 r2 M1 a: the held flag ----

const flagged = () => { const root = tempDir('m9-flag-'); makeHeldFlag(root); return root; };
const sizeOf = (root) => readFileSync(join(root, HELD_FLAG)).length;

test('#260 r2 M1: the held flag is made clear at a fixed size, set and read back, and never changes size', () => {
  const root = flagged();
  assert.equal(sizeOf(root), HELD_FLAG_BYTES);
  assert.equal(readHeldFlag(root), null, 'clear reads as nothing held');
  makeHeldFlag(root);
  setHeldFlag(root, { pid: 41, at: 'T', held: 2, dropped: 0, id: 'w1', event: { type: 'diary_damaged', reason: 'r' } });
  assert.equal(sizeOf(root), HELD_FLAG_BYTES);
  makeHeldFlag(root);
  const r = readHeldFlag(root);
  assert.deepEqual(r.flag, { pid: 41, at: 'T', held: 2, dropped: 0, id: 'w1', event: { type: 'diary_damaged', reason: 'r' } }, 'a second make never clears a set flag');
  assert.equal(clearHeldFlag(root, r.raw), true);
  assert.equal(readHeldFlag(root), null);
  assert.equal(sizeOf(root), HELD_FLAG_BYTES);
});

test('#260 r2 M1: clearing compares first, so a flag set again since it was read is kept', () => {
  const root = flagged();
  setHeldFlag(root, { pid: 41, at: 'T1', held: 1, dropped: 0, id: 'w1', event: { type: 't' } });
  const told = readHeldFlag(root);
  setHeldFlag(root, { pid: 42, at: 'T2', held: 1, dropped: 0, id: 'w2', event: { type: 't' } });
  assert.equal(clearHeldFlag(root, told.raw), false);
  assert.equal(readHeldFlag(root).flag.id, 'w2');
});

test('#260 r2 M1: an oversized warning is shrunk to fit, and the flag still reads', () => {
  const root = flagged();
  setHeldFlag(root, { pid: 41, at: 'T', held: 1, dropped: 0, id: 'w1', event: { type: 'diary_damaged', reason: 'é'.repeat(5000), extra: 'z'.repeat(9000) } });
  const r = readHeldFlag(root);
  assert.equal(sizeOf(root), HELD_FLAG_BYTES);
  assert.equal(r.flag.event.type, 'diary_damaged');
  assert.equal(r.flag.event.reason.length, 600);
  assert.equal(r.flag.event.extra, undefined);
});

test('#260 r2 M1: a torn flag reads as set but unreadable; a link or a wrong size is refused, never read as clear', () => {
  const root = flagged();
  writeFileSync(join(root, HELD_FLAG), '{"pid":4'.padEnd(HELD_FLAG_BYTES, ' '));
  const r = readHeldFlag(root);
  assert.ok(r && r.flag === null, 'torn is set, not clear');
  const linked = tempDir('m9-flag-');
  writeFileSync(join(linked, 'real'), ' '.repeat(HELD_FLAG_BYTES));
  symlinkSync(join(linked, 'real'), join(linked, HELD_FLAG));
  assert.throws(() => readHeldFlag(linked));
  assert.throws(() => setHeldFlag(linked, { pid: 1, at: 'T', held: 1, dropped: 0 }));
  const short = tempDir('m9-flag-');
  writeFileSync(join(short, HELD_FLAG), ' ');
  assert.throws(() => setHeldFlag(short, { pid: 1, at: 'T', held: 1, dropped: 0 }), /is not 4096 bytes/);
  assert.equal(readHeldFlag(tempDir('m9-flag-')), null, 'a store with no flag (older) holds nothing');
});
