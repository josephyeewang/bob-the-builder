// unsent.test.mjs — the store's unsent-alerts.jsonl reader (L240, L288): a file that can't be read as one plain file is
// an error, never read as "no alerts waiting", so an alert is never lost to a corrupt or replaced file.
// Run: node --test orchestrate/modules/M9-record/unsent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { HELD_FLAG, HELD_FLAG_BYTES, UNSENT, appendPlain, clearHeldFlag, dropHeldHolder, heldCut, heldHolders, isOwnHolder, makeHeldFlag, markSent, newHeldToken, readHeldFlag, readUnsent, setHeldFlag } from './unsent.mjs';

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
  const { gen, total, ...rest } = r.flag;
  assert.deepEqual(rest, { pid: 41, token: null, at: 'T', held: 2, dropped: 0, id: 'w1', event: { type: 'diary_damaged', reason: 'r' }, also: [] }, 'a second make never clears a set flag');
  assert.deepEqual([gen, total], [1, { holders: 1, held: 2, dropped: 0 }]);
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
  assert.equal(readHeldFlag(root).flag.id, 'w1', 'the earliest warning stays the one to tell (#260 r3 M1)');
  assert.deepEqual(readHeldFlag(root).flag.also.map((h) => h.pid), [42]);
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

// ---- #260 r3 M1, m1, m2: several holders merge into the one flag ----

const holder = (pid, token, held, extra = {}) => ({ pid, token, at: `T${pid}`, held, dropped: 0, id: `w${pid}`, event: { type: 'alert_not_queued', text: `from ${pid}` }, ...extra });

test('#260 r3 M1: a second holder merges in: the earliest warning stays the one to tell, later holders are named in also, counts sum', () => {
  const root = flagged();
  setHeldFlag(root, holder(41, 'a', 1));
  setHeldFlag(root, holder(42, 'b', 2, { dropped: 3 }));
  setHeldFlag(root, holder(43, 'c', 1));
  const f = readHeldFlag(root).flag;
  assert.deepEqual([f.pid, f.token, f.id, f.event.text], [41, 'a', 'w41', 'from 41'], 'the first holder and its warning stay at the top');
  assert.deepEqual(f.also.map((h) => [h.pid, h.token, h.held, h.dropped]), [[42, 'b', 2, 3], [43, 'c', 1, 0]]);
  assert.deepEqual(f.total, { holders: 3, held: 4, dropped: 3 });
  assert.equal(f.gen, 3);
  setHeldFlag(root, holder(42, 'b', 5));
  const g = readHeldFlag(root).flag;
  assert.deepEqual(g.also.map((h) => [h.pid, h.held, h.at]), [[42, 5, 'T42'], [43, 1, 'T43']], 'a holder that sets again is updated in place, not added twice');
  assert.deepEqual(g.total, { holders: 3, held: 7, dropped: 0 });
  setHeldFlag(root, holder(41, 'a', 2, { id: 'w41b', at: 'later' }));
  const h = readHeldFlag(root).flag;
  assert.deepEqual([h.held, h.id, h.at], [2, 'w41b', 'T41'], 'the first holder updating itself keeps its place and first time');
});

test('#260 r3 m1: the same pid with another token is another holder (a reused pid), and only a token made here is this process\'s own', () => {
  const root = flagged();
  const mine = newHeldToken();
  setHeldFlag(root, holder(process.pid, undefined, 1));
  setHeldFlag(root, holder(process.pid, mine, 1));
  const f = readHeldFlag(root).flag;
  assert.deepEqual(heldHolders(f).map((x) => [x.pid, x.token ?? null]), [[process.pid, null], [process.pid, mine]]);
  assert.deepEqual(heldHolders(f).map(isOwnHolder), [false, true]);
  assert.equal(isOwnHolder({ pid: process.pid + 1, token: mine }), false, 'the token alone is not enough');
  assert.equal(dropHeldHolder(root, { pid: process.pid, token: 'never-made' }), false, 'the same pid with a token not in the flag drops nothing');
  assert.equal(dropHeldHolder(root, { pid: process.pid, token: mine }), true);
  assert.deepEqual(heldHolders(readHeldFlag(root).flag).map((x) => x.token ?? null), [null], 'the dead process\'s entry stays');
});

test('#260 r3 M1: a holder drops only its own entry; the flag clears only when nothing else is left', () => {
  const root = flagged();
  for (const [pid, t] of [[41, 'a'], [42, 'b'], [43, 'c']]) setHeldFlag(root, holder(pid, t, 1));
  assert.equal(dropHeldHolder(root, { pid: 42, token: 'b' }), true);
  assert.deepEqual(heldHolders(readHeldFlag(root).flag).map((x) => x.pid), [41, 43]);
  assert.equal(dropHeldHolder(root, { pid: 99, token: 'z' }), false, 'a holder not in it changes nothing');
  assert.equal(dropHeldHolder(root, { pid: 41, token: 'a' }), true);
  const f = readHeldFlag(root).flag;
  assert.deepEqual([f.pid, f.id, f.event, f.also.length, f.total.holders], [43, null, null, 0, 1], 'the next holder moves up, with no warning of its own to tell');
  assert.equal(dropHeldHolder(root, { pid: 43, token: 'c' }), true);
  assert.equal(readHeldFlag(root), null, 'the last one out clears it');
});

test('#260 r3 M1: the flag stays within its 4 KiB when full: the oldest later holders fold into cut, the first holder, its warning id and the total never go', () => {
  const root = flagged();
  setHeldFlag(root, holder(1, 't1', 1, { event: { type: 'diary_damaged', reason: 'r'.repeat(3000) } }), { settleMs: 0 });
  for (let i = 2; i <= 200; i += 1) setHeldFlag(root, holder(i, `t${i}`, i, { dropped: 1 }), { settleMs: 0 });
  const r = readHeldFlag(root);
  assert.equal(readFileSync(join(root, HELD_FLAG)).length, HELD_FLAG_BYTES);
  const f = r.flag;
  assert.deepEqual([f.pid, f.id], [1, 'w1']);
  assert.deepEqual(f.total, { holders: 200, held: 200 * 201 / 2, dropped: 199 });
  const c = heldCut(f);
  assert.ok(c.holders > 0, 'some were folded');
  assert.equal(c.holders + f.also.length + 1, 200, 'every holder is named or counted');
  assert.equal(f.also.at(-1).pid, 200, 'the newest is named');
  assert.equal(c.held + f.also.reduce((a, h) => a + h.held, 0) + f.held, f.total.held);
  setHeldFlag(root, holder(1, 't1', 1, { event: { type: 'x', text: 'é'.repeat(4000) } }), { settleMs: 0 });
  assert.equal(readHeldFlag(root).flag.total.holders, 200, 'still whole after the first holder grows');
});

test('#260 r3 M1: a flag that can\'t be read is replaced by the merge, and says an earlier one was lost', () => {
  const root = flagged();
  writeFileSync(join(root, HELD_FLAG), '{"pid":4'.padEnd(HELD_FLAG_BYTES, ' '));
  setHeldFlag(root, holder(41, 'a', 1));
  const f = readHeldFlag(root).flag;
  assert.deepEqual([f.pid, f.torn_before], [41, true]);
});

test('#260 r3 m2: a set whose entry another rewrite took in the moment after it wrote merges itself back in', () => {
  const root = flagged();
  setHeldFlag(root, holder(41, 'a', 1));
  const before = readHeldFlag(root).raw;
  let raced = 0;
  // The robot's clear lands right after this set wrote (it compared against the flag it told, which this set changed
  // only an instant before): the setter's own entry is gone, and it must put it back.
  setHeldFlag(root, holder(42, 'b', 1), { afterWrite: (i) => { if (i === 0) { raced += 1; writeFileSync(join(root, HELD_FLAG), ' '.repeat(HELD_FLAG_BYTES)); } } });
  assert.equal(raced, 1);
  const f = readHeldFlag(root).flag;
  assert.ok(f && heldHolders(f).some((x) => x.pid === 42), 'the setter is back in the flag');
  assert.notEqual(readHeldFlag(root).raw, before);
});

test('#260 r3 m2: a clear re-reads just before it writes, so a set that lands after its compare is kept', () => {
  const root = flagged();
  setHeldFlag(root, holder(41, 'a', 1));
  const told = readHeldFlag(root);
  const ok = clearHeldFlag(root, told.raw, { between: () => setHeldFlag(root, holder(42, 'b', 1), { settleMs: 0 }) });
  assert.equal(ok, false);
  assert.deepEqual(heldHolders(readHeldFlag(root).flag).map((x) => x.pid), [41, 42]);
  assert.equal(readHeldFlag(root).flag.gen, 2, 'each write moves the generation on');
});

test('#260 r3 M1: a clear with keep leaves only the holders it accepts (the robot\'s own), with the first one\'s warning if it is kept', () => {
  const root = flagged();
  setHeldFlag(root, holder(41, 'a', 1));
  setHeldFlag(root, holder(42, 'b', 2));
  const r = readHeldFlag(root);
  assert.equal(clearHeldFlag(root, r.raw, { keep: (h) => h.pid === 42 }), true);
  const f = readHeldFlag(root).flag;
  assert.deepEqual([f.pid, f.held, f.id, f.total.holders], [42, 2, null, 1]);
  const r2 = readHeldFlag(root);
  assert.equal(clearHeldFlag(root, r2.raw, { keep: (h) => h.pid === 42 }), true);
  assert.equal(readHeldFlag(root).flag.pid, 42, 'kept again');
});

test('#260 r4 m2 (P2): folded counts survive the last named holder leaving', () => {
  const root = flagged();
  const f = { gen: 5, pid: 41, token: 'a', at: 'T41', held: 1, dropped: 0, id: 'w41', event: { type: 't' }, also: [{ pid: 42, token: 'b', at: 'T42', held: 1, dropped: 0 }], cut: { holders: 2, held: 3, dropped: 1 }, total: { holders: 4, held: 5, dropped: 1 } };
  writeFileSync(join(root, HELD_FLAG), JSON.stringify(f).padEnd(HELD_FLAG_BYTES, ' '));
  assert.equal(dropHeldHolder(root, { pid: 41, token: 'a' }), true);
  assert.equal(dropHeldHolder(root, { pid: 42, token: 'b' }), true);
  const r = readHeldFlag(root);
  assert.ok(r?.flag, 'not cleared: the folded holders are still counted');
  assert.deepEqual(heldHolders(r.flag), [], 'no named holder left');
  assert.deepEqual(heldCut(r.flag), { holders: 2, held: 3, dropped: 1 });
  assert.deepEqual(r.flag.total, { holders: 2, held: 3, dropped: 1 });
});
