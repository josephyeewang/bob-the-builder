// L1358: the account owner reset the weekly usage. The owner's answer then said week 0% (no 5-hour row, h5_none) while the
// stored usage fact said 100% in the same window; the drop was refused, the stale 100% was handed on, and the band stayed
// unknown ("the 5-hour figure is not a percent"), so nothing was claimed. A drop within one window is now taken as a reset
// and written down; a moved reset time, a stale file and a file not the owner's are still refused. End to end through the
// real sensorsPorts, sensorsPass, Record, and M11's currentBands and mayStart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { writeAnswer, ANSWER_FILE } from './owner-answer.mjs';
import { sensorsPorts, storedUsage, ANSWER_STALE_MS } from './sensors-ports.mjs';
import { sensorsPass } from '../modules/M12-sensors/loop.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { memoryRecord } from '../shared/record.mjs';
import { currentBands, mayStart, USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { rulesWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';

const T0 = Date.parse('2026-11-24T21:43:20.703Z');
const UID = process.getuid();
const noAcl = () => null;
const at = (n) => new Date(T0 + n).toISOString();
// The live stored fact (diary usage-a rev 7501): week 100%, no 5-hour figure, no marker (a handed-on reading never keeps it).
const LIVE_STORED = { kind: 'fact.usage', account: 'a', observed_at: at(0), source: 'claude /usage | week from weekly_all',
  h5: { used_pct: null, resets_at: null }, week: { used_pct: 100, resets_at: '2026-11-27T00:00:01.198Z' }, h5_hold_until: null, h5_none: false };
// The live owner's answer after the reset.
const RESET = { h5: null, week: { used_pct: 0, resets_at: '2026-11-27T00:00:00.243Z' }, week_from: 'weekly_all', h5_none: true };

function world() {
  const dir = tempDir('orch-l1358-'); chmodSync(dir, 0o755);
  const file = join(dir, ANSWER_FILE); const rec = memoryRecord();
  const put = (usage, n) => assert.equal(writeAnswer({ to: file, answer: { v: 1, account: 'a', signed_in: true, observed_at: at(n), usage } }).ok, true);
  const ports = (n, o = {}) => sensorsPorts({ file, ownerUid: o.ownerUid ?? UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) });
  const pass = (n, o) => { const q = ports(n, o); return sensorsPass({ rec, ports: { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {} }, now: () => new Date(T0 + n) }); };
  const fact = () => rec.read('fact', USAGE_FACT('a'))?.doc;
  const band = (n) => currentBands({ rec, rules: rulesWith(), account: 'a', now: T0 + n });
  return { rec, put, ports, pass, fact, band, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('L1358: the live reset (week 100% → 0%, no 5-hour row) is taken, written down, and gives a band that lets claims run', async () => {
  const w = world();
  try {
    // The stored fact as it was on the Mini, and the band it gave.
    assert.equal(makeFactWriter(w.rec, { actor: 'sensors', now: () => new Date(T0) }).put(USAGE_FACT('a'), LIVE_STORED).ok, true);
    w.put(RESET, 300_000);
    const q = w.ports(300_000);
    const u = await q.readUsage('a');
    assert.deepEqual([u?.h5, u?.week?.used_pct, u?.h5_none], [null, 0, true], `the fresh reading is handed on: ${q.lastReason()}`);
    assert.equal(u.week.resets_at, LIVE_STORED.week.resets_at, 'the same window (reset times under a minute apart) keeps its first reset time');
    assert.equal(q.lastReason(), 'usage for weekly_all went down from 100% to 0% within one window; taken as a reset');
    const out = await w.pass(300_000);
    assert.deepEqual(out.problems.filter((p) => /usage|signed-in/.test(p)), [], 'nothing went wrong with the account or usage');
    assert.deepEqual(out.notes, ['usage-a: usage for weekly_all went down from 100% to 0% within one window; taken as a reset']);
    const d = w.fact();
    assert.deepEqual([d.week.used_pct, d.h5_none, d.h5.used_pct, d.reset_note],
      [0, true, null, 'usage for weekly_all went down from 100% to 0% within one window; taken as a reset'], 'the stored fact keeps h5_none and the note');
    const b = w.band(300_000);
    assert.deepEqual([b.band, b.own_building, b.prodBlocked], ['green', 'open', false], JSON.stringify(b));
    assert.doesNotMatch(b.reason, /5-hour figure is not a percent/);
    assert.deepEqual(mayStart({ b, kind: 'editing', tier: 1, redRuns: [] }), { ok: true, amberCaps: false }, 'a Tier-1 editing claim may start');
    // The next pass: the same reading is no drop, and the note is not carried on.
    w.put(RESET, 360_000); const next = await w.pass(360_000);
    assert.deepEqual([next.notes, w.fact().reset_note, w.fact().h5_none], [[], undefined, true]);
    assert.equal(w.band(360_000).band, 'green');
  } finally { w.done(); }
});

test('L1358: a reset time moved within the open window is still refused, and the stale 100% is handed on', async () => {
  const w = world();
  try {
    assert.equal(makeFactWriter(w.rec, { actor: 'sensors', now: () => new Date(T0) }).put(USAGE_FACT('a'), LIVE_STORED).ok, true);
    w.put({ ...RESET, week: { used_pct: 0, resets_at: '2026-11-27T00:05:00.000Z' } }, 300_000);
    const q = w.ports(300_000);
    const u = await q.readUsage('a');
    assert.equal(u?.week?.used_pct, 100, 'the stored reading is handed on');
    assert.equal(u.h5_none, undefined, 'never with the no-5-hour marker (L1331 r3)');
    assert.match(q.lastReason(), /weekly_all row's reset time moved later while the window seen \(to 2026-11-27T00:00:01\.198Z\) is still open, so it is refused/);
    await w.pass(300_000);
    assert.equal(w.fact().week.used_pct, 100);
    assert.equal(w.fact().reset_note, undefined, 'a refused reading is no reset');
    assert.notEqual(w.band(300_000).band, 'green');
  } finally { w.done(); }
});

test('L1358: a stale answer and one not the owner\'s are still refused, drop or not', async () => {
  const w = world();
  try {
    assert.equal(makeFactWriter(w.rec, { actor: 'sensors', now: () => new Date(T0) }).put(USAGE_FACT('a'), LIVE_STORED).ok, true);
    w.put(RESET, 0);
    const stale = w.ports(ANSWER_STALE_MS + 60_000);
    assert.equal(await stale.readUsage('a'), null);
    assert.match(stale.lastReason(), /the owner's answer is \d+ min old/);
    const foreign = w.ports(60_000, { ownerUid: UID + 1 });
    assert.equal(await foreign.readUsage('a'), null);
    assert.match(foreign.lastReason(), /is not the owner's/);
    for (const [n, o] of [[ANSWER_STALE_MS + 60_000, {}], [60_000, { ownerUid: UID + 1 }]]) await w.pass(n, o);
    assert.deepEqual([w.fact().week.used_pct, w.fact().reset_note], [100, undefined], 'neither wrote the 0% over the stored 100%');
  } finally { w.done(); }
});
