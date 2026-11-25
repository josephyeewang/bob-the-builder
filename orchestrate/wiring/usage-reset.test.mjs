// L1358: the account owner reset the weekly usage. The owner's answer then said week 0% (no 5-hour row, h5_none) while the
// stored usage fact said 100% in the same window; the drop was refused, the stale 100% was handed on, and the band stayed
// unknown ("the 5-hour figure is not a percent"), so nothing was claimed. A drop on the same row is now taken as a reset
// and written down (and, on the same row, a weekly reset time moved later with a lower percent: a restarted window); a
// drop on a row the report no longer lists (or, from an answer without week_rows, any change of row), any other moved
// reset time, a stale file and a file not the owner's are still refused, and the pass logs why. With week_rows (L1358 r2)
// a drop is judged on the row seen last, whichever row is top now. End to end through the real sensorsPorts, sensorsPass, Record, and M11's currentBands
// and mayStart.
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
  // The ports as sensors-wiring.mjs gives them, usageReason included (L1358 m1).
  const pass = (n, o) => { const q = ports(n, o); return sensorsPass({ rec, ports: { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, usageReason: q.lastReason, probes: {} }, now: () => new Date(T0 + n) }); };
  const seed = (doc = LIVE_STORED) => assert.equal(makeFactWriter(rec, { actor: 'sensors', now: () => new Date(T0) }).put(USAGE_FACT('a'), doc).ok, true);
  const fact = () => rec.read('fact', USAGE_FACT('a'))?.doc;
  const band = (n) => currentBands({ rec, rules: rulesWith(), account: 'a', now: T0 + n });
  return { rec, put, ports, pass, fact, band, seed, done: () => rmSync(dir, { recursive: true, force: true }) };
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
    assert.equal(u.reset_note, 'usage for weekly_all went from 100% to 0% this week; taken as a reset');
    assert.equal(q.lastReason(), null, 'a reset is no reason: nothing was wrong');
    const out = await w.pass(300_000);
    assert.deepEqual(out.problems.filter((p) => /usage|signed-in/.test(p)), [], 'nothing went wrong with the account or usage');
    assert.deepEqual(out.notes, ['usage-a: usage for weekly_all went from 100% to 0% this week; taken as a reset']);
    const d = w.fact();
    assert.deepEqual([d.week.used_pct, d.h5_none, d.h5.used_pct, d.reset_note],
      [0, true, null, 'usage for weekly_all went from 100% to 0% this week; taken as a reset'], 'the stored fact keeps h5_none and the note');
    assert.deepEqual(d.last_reset, { note: 'usage for weekly_all went from 100% to 0% this week; taken as a reset', at: at(300_000), windows: ['week'] }, 'and the last reset, for M11 to tell Joe once');
    const b = w.band(300_000);
    assert.deepEqual([b.band, b.own_building, b.prodBlocked], ['green', 'open', false], JSON.stringify(b));
    assert.doesNotMatch(b.reason, /5-hour figure is not a percent/);
    assert.deepEqual(mayStart({ b, kind: 'editing', tier: 1, redRuns: [] }), { ok: true, amberCaps: false }, 'a Tier-1 editing claim may start');
    // The next pass: the same reading is no drop, and the note is not carried on.
    w.put(RESET, 360_000); const next = await w.pass(360_000);
    assert.deepEqual([next.notes, w.fact().reset_note, w.fact().h5_none], [[], undefined, true]);
    assert.deepEqual(w.fact().last_reset, d.last_reset, 'the last reset is carried on, so it is told once whichever pass reads it');
    assert.equal(w.band(360_000).band, 'green');
  } finally { w.done(); }
});

// L1358 m3 (#671 audit): on the same row, a weekly reset time moved later with a lower percent is a restarted window
// (a reset that also started the week again), taken with the same note, within one window of the reading. Moved back,
// moved later with the percent the same or up, moved later from another row, and past one window are still refused.
test('L1358 m3: a weekly reset time moved later with a lower percent, same row, is a restarted window; other moves are refused and logged', async () => {
  const LATER = '2026-12-01T21:00:00.000Z';   // inside one week of the reading (T0 + 5 min)
  const cases = [
    ['moved later, lower, same row', LIVE_STORED, { used_pct: 0, resets_at: LATER }, 'weekly_all', null],
    ['moved back', LIVE_STORED, { used_pct: 0, resets_at: '2026-11-26T23:00:00.000Z' }, 'weekly_all', /weekly_all row's reset time moved back while the window seen \(to 2026-11-27T00:00:01\.198Z\) is still open, so it is refused/],
    ['moved later, the percent the same', LIVE_STORED, { used_pct: 100, resets_at: LATER }, 'weekly_all', /weekly_all row's reset time moved later while the window seen/],
    ['moved later, the percent up', { ...LIVE_STORED, week: { ...LIVE_STORED.week, used_pct: 60 } }, { used_pct: 70, resets_at: LATER }, 'weekly_all', /weekly_all row's reset time moved later/],
    ['moved later, lower, another row', LIVE_STORED, { used_pct: 0, resets_at: LATER }, 'weekly_scoped:Y', /weekly_scoped:Y row's reset time moved later/],
    ['moved later, lower, past one window', LIVE_STORED, { used_pct: 0, resets_at: '2026-12-02T00:00:00.000Z' }, 'weekly_all', /week reset time is further out than one weekly window/],
  ];
  for (const [name, stored, week, from, refused] of cases) {
    const w = world();
    try {
      w.seed(stored);
      w.put({ ...RESET, week, week_from: from }, 300_000);
      const out = await w.pass(300_000);
      // A reset time past one window makes the whole answer refused, so no account is read either; the line says why.
      const usageProblems = out.problems.filter((p) => /^usage(-a)?:/.test(p));
      if (!refused) {
        assert.deepEqual([w.fact().week.used_pct, w.fact().week.resets_at, w.fact().reset_note], [0, LATER, 'usage for weekly_all went from 100% to 0% this week; taken as a reset'], name);
        assert.deepEqual(usageProblems, [], name);
        assert.equal(w.band(300_000).band, 'green', name);
        continue;
      }
      assert.deepEqual([w.fact().week.used_pct, w.fact().week.resets_at, w.fact().reset_note], [stored.week.used_pct, stored.week.resets_at, undefined], `${name}: the stored reading is handed on`);
      assert.notEqual(w.fact().h5_none, true, `${name}: never with the no-5-hour marker (L1331 r3)`);
      // L1358 m1: the pass's log says why, so a refusal is never only "band unknown".
      assert.equal(usageProblems.length, 1, `${name}: ${JSON.stringify(out.problems)}`);
      assert.match(usageProblems[0], refused, name);
    } finally { w.done(); }
  }
});

// L1358 M1 (#671 audit): the owner's answer takes the highest weekly row. A scoped row at 80% that drops out of the
// report leaves weekly_all at 20% with the same reset time; taken as a reset, the band would flip to green, then back
// when the scoped row came back. A drop that comes with a change of row is refused, so the band holds.
test('L1358 M1: a scoped row dropping out (80% → weekly_all 20%, same reset time) is no reset: the band does not flip', async () => {
  const w = world();
  try {
    const WEEK = LIVE_STORED.week.resets_at;
    w.seed({ ...LIVE_STORED, source: 'claude /usage | week from weekly_scoped:Y', week: { used_pct: 80, resets_at: WEEK } });
    w.put({ ...RESET, week: { used_pct: 80, resets_at: WEEK }, week_from: 'weekly_scoped:Y' }, 0); await w.pass(0);   // the scoped row as stored, so the account is signed in
    const before = w.band(0).band;
    assert.notEqual(before, 'green', 'a week at 80% is not green');
    const bands = [];
    for (const [n, pct, from] of [[60_000, 20, 'weekly_all'], [120_000, 80, 'weekly_scoped:Y'], [180_000, 20, 'weekly_all']]) {
      w.put({ ...RESET, week: { used_pct: pct, resets_at: WEEK }, week_from: from }, n);
      const out = await w.pass(n);
      if (from === 'weekly_all') assert.ok(out.problems.some((p) => /^usage-a: usage: the weekly_all row went down within one window \(20% after 80%\), so it is refused/.test(p)), JSON.stringify(out.problems));
      assert.deepEqual([w.fact().week.used_pct, w.fact().reset_note, w.fact().last_reset], [80, undefined, { note: null, at: null, windows: [] }], `at ${n}`);
      bands.push(w.band(n).band);
    }
    // Never green. A refused run hands the stored week on without the no-5-hour marker (L1331 r3), so it reads unknown,
    // which holds claims as red does; only a reading that passed may say there is no 5-hour row.
    assert.deepEqual(bands.map((b) => b === 'green'), [false, false, false], `no flip to green: ${bands.join(', ')}`);
  } finally { w.done(); }
});

// L1358 r2 (#671 audit r2 MAT-1): the live account's rows tie and swap (weekly_scoped:Fable and weekly_all, same reset
// time; a tie goes to weekly_all). The stored week came from the scoped row at 100%; after the reset the answer's top row
// is weekly_all at 0%. With `week_rows` the drop is judged on the scoped row itself (100% → 0%): a reset, and the band
// is green. Before, it was a drop with a change of row, refused, and the band stayed unknown all week.
const WEEK = LIVE_STORED.week.resets_at;
const rowsW = (o) => Object.fromEntries(Object.entries(o).map(([n, p]) => [n, { used_pct: p, resets_at: WEEK }]));
const withRows = (o) => { const top = Object.entries(o).reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] === 'weekly_all') ? b : a));
  return { h5: null, week: { used_pct: top[1], resets_at: WEEK }, week_from: top[0], week_rows: rowsW(o), h5_none: true }; };
const SCOPED_STORED = { ...LIVE_STORED, source: 'claude /usage | week from weekly_scoped:Fable' };

test('L1358 r2 MAT-1: a reset seen on the scoped row the week came from counts though weekly_all is top now; the band is green and stays so', async () => {
  const w = world();
  try {
    w.seed(SCOPED_STORED);   // a fact from before week_rows: the scoped row's 100%, named by the source
    const bands = []; const notes = [];
    for (const [n, rows] of [[300_000, { 'weekly_scoped:Fable': 0, weekly_all: 0 }], [360_000, { 'weekly_scoped:Fable': 0, weekly_all: 1 }],
      [420_000, { 'weekly_scoped:Fable': 1, weekly_all: 3 }], [480_000, { 'weekly_scoped:Fable': 5, weekly_all: 3 }]]) {
      w.put(withRows(rows), n);
      const out = await w.pass(n);
      assert.deepEqual(out.problems.filter((p) => /usage/.test(p)), [], `at ${n}: ${JSON.stringify(out.problems)}`);
      notes.push(...out.notes);
      bands.push(w.band(n).band);
    }
    assert.deepEqual(notes, ['usage-a: usage for weekly_scoped:Fable went from 100% to 0% this week; taken as a reset'], 'the reset is said once, on its own row');
    assert.deepEqual(bands, ['green', 'green', 'green', 'green'], 'green after the scoped→all reset, and when the scoped row is top again');
    const d = w.fact();
    assert.deepEqual([d.week.used_pct, d.source, d.week_rows], [5, 'claude /usage | week from weekly_scoped:Fable', { 'weekly_scoped:Fable': { used_pct: 5, resets_at: WEEK }, weekly_all: { used_pct: 3, resets_at: WEEK } }], 'the fact keeps every row for the next read');
    assert.deepEqual([d.last_reset.note, d.last_reset.windows], ['usage for weekly_scoped:Fable went from 100% to 0% this week; taken as a reset', ['week']]);
  } finally { w.done(); }
});

test('L1358 r2: with week_rows, the stored row missing from the report is refused as before; another row dropping is said, not refused', async () => {
  const w = world();
  try {
    // The M1 case with rows: the stored scoped row (80%) is not in the report; weekly_all at 20% is no reset.
    w.seed({ ...SCOPED_STORED, week: { used_pct: 80, resets_at: WEEK } });
    w.put(withRows({ weekly_all: 20 }), 60_000);
    let out = await w.pass(60_000);
    assert.ok(out.problems.some((p) => /^usage-a: usage: the weekly_all row went down within one window \(20% after 80%\), so it is refused/.test(p)), JSON.stringify(out.problems));
    assert.deepEqual([w.fact().week.used_pct, w.fact().reset_note], [80, undefined]);
    assert.notEqual(w.band(60_000).band, 'green');
    // The row listed again, still 80%: taken; the stored rows now hold both.
    w.put(withRows({ 'weekly_scoped:Fable': 80, weekly_all: 20 }), 120_000); out = await w.pass(120_000);
    assert.deepEqual([out.problems.filter((p) => /usage/.test(p)), w.fact().week.used_pct, Object.keys(w.fact().week_rows).sort()], [[], 80, ['weekly_all', 'weekly_scoped:Fable']]);
    // weekly_all (not the top) reset on its own: the week stays 80%, and the drop is said on its row (compared row by row).
    w.put(withRows({ 'weekly_scoped:Fable': 80, weekly_all: 0 }), 180_000); out = await w.pass(180_000);
    assert.deepEqual([out.problems.filter((p) => /usage/.test(p)), out.notes, w.fact().week.used_pct],
      [[], ['usage-a: usage for weekly_all went from 20% to 0% this week; taken as a reset'], 80]);
    // The top row dropping by a reset's size is a reset whatever else the report says.
    w.put(withRows({ 'weekly_scoped:Fable': 30, weekly_all: 0 }), 240_000); out = await w.pass(240_000);
    assert.deepEqual([out.notes, w.fact().week.used_pct], [['usage-a: usage for weekly_scoped:Fable went from 80% to 30% this week; taken as a reset'], 30]);
  } finally { w.done(); }
});

// #671 audit r2 m1: a stored week whose source names no row (a fact from before the source said so). With week_rows it is
// compared with the new top row, and a drop is taken only when every row is at or below it; without week_rows it is
// still refused (the row can't be told).
test('L1358 r2 m1: a stored week with no row is judged against the new top row when the answer lists every row', async () => {
  for (const [name, usage, ok] of [
    ['with rows, every row lower', withRows({ 'weekly_scoped:Fable': 0, weekly_all: 0 }), true],
    ['without rows', { h5: null, week: { used_pct: 0, resets_at: WEEK }, week_from: 'weekly_all', h5_none: true }, false],
  ]) {
    const w = world();
    try {
      w.seed({ ...LIVE_STORED, source: 'claude /usage' });
      w.put(usage, 300_000);
      const out = await w.pass(300_000);
      if (ok) {
        assert.deepEqual([w.fact().week.used_pct, out.notes, w.band(300_000).band], [0, ['usage-a: usage for weekly_all went from 100% to 0% this week; taken as a reset'], 'green'], name);
      } else {
        assert.equal(w.fact().week.used_pct, 100, name);
        assert.ok(out.problems.some((p) => /weekly_all row went down within one window \(0% after 100%\)/.test(p)), `${name}: ${JSON.stringify(out.problems)}`);
      }
    } finally { w.done(); }
  }
});

test('L1358: a stale answer and one not the owner\'s are still refused, drop or not', async () => {
  const w = world();
  try {
    w.seed();
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
