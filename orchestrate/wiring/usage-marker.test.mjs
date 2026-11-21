// L1331 r3 M1: the no-5-hour marker is never handed on. A refused report, or a fresh report refused for a lower or moved
// week, may have shown a 5-hour row; the stored week-only reading handed on in its place must read as unknown, not green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { writeAnswer, ANSWER_FILE } from './owner-answer.mjs';
import { sensorsPorts, storedUsage } from './sensors-ports.mjs';
import { sensorsPass } from '../modules/M12-sensors/loop.mjs';
import { memoryRecord } from '../shared/record.mjs';
import { readFact, bands, USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { rulesWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';

const T0 = Date.parse('2026-11-05T12:00:00Z');
const UID = process.getuid();
const noAcl = () => null;
const WEEK = { used_pct: 30, resets_at: '2026-11-07T22:59:59.000Z' };
const ans = (t, usage, extra = {}) => ({ v: 1, account: 'a', signed_in: true, observed_at: new Date(t).toISOString(), usage, ...extra });
async function scenario(second, first = ans(T0, { h5: null, week: WEEK, week_from: 'weekly_all', h5_none: true })) {
  const dir = tempDir('orch-repro-'); chmodSync(dir, 0o755); const file = join(dir, ANSWER_FILE);
  const rec = memoryRecord();
  const run = async (n) => { const q = sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) });
    q.pass = await sensorsPass({ rec, ports: { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {} }, now: () => new Date(T0 + n) }); return q; };
  try {
    assert.equal(writeAnswer({ to: file, answer: first }).ok, true);
    await run(0);
    assert.equal(writeAnswer({ to: file, answer: second }).ok, true);
    const q = await run(60_000);
    const doc = rec.read('fact', USAGE_FACT('a'))?.doc;
    const r = readFact({ doc }, { account: 'a', now: T0 + 120_000, staleMs: 15 * 60_000 });
    const b = bands({ rules: rulesWith(), reading: r, now: T0 + 120_000 });
    return { doc, why: q.lastReason(), band: b.band, noted: q.pass?.wrote?.[USAGE_FACT('a')]?.unknown };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('L1331 r3: after a week-only reading, a refused or dropped report never bands green from the handed-on week', async () => {
  const cases = {
    'refused report (a renamed 5-hour row)': ans(T0 + 60_000, null, { usage_reason: 'the /usage report has a row of a kind this does not know (five_hour)' }),
    'session 99% with a lower week': ans(T0 + 60_000, { h5: { used_pct: 99, resets_at: '2026-11-05T14:00:00.000Z' }, week: { used_pct: 29, resets_at: WEEK.resets_at }, week_from: 'weekly_all' }),
    'session 99% with the week moved to a scoped row': ans(T0 + 60_000, { h5: { used_pct: 99, resets_at: '2026-11-05T14:00:00.000Z' }, week: { used_pct: 50, resets_at: '2026-11-08T10:00:00.000Z' }, week_from: 'weekly_scoped:M' }),
  };
  for (const [name, second] of Object.entries(cases)) {
    const out = await scenario(second);
    assert.notEqual(out.doc.h5_none, true, name);
    assert.notEqual(out.band, 'green', `${name}: ${JSON.stringify(out)}`);
  }
});

test('L1331 r4: the marker needs a complete week of its own, and no 5-hour percent seen in the last 5 hours', async () => {
  // M1: a clean report with a 96% week but no reset time hands the stored 30% week on; never green from it.
  const noReset = await scenario(ans(T0 + 60_000, { h5: null, week: { used_pct: 96, resets_at: null }, week_from: 'weekly_all', h5_none: true }));
  assert.equal(noReset.doc.h5_none, false); assert.notEqual(noReset.band, 'green', JSON.stringify(noReset));
  assert.equal(noReset.noted, true, 'the pass summary says unknown too (r4 m2)');
  // M2: a 97% 5-hour figure without a reset time, then a clean week-only report a minute later.
  const h5NoReset = await scenario(ans(T0 + 60_000, { h5: null, week: WEEK, week_from: 'weekly_all', h5_none: true }),
    ans(T0, { h5: { used_pct: 97, resets_at: null }, week: WEEK, week_from: 'weekly_all' }));
  assert.equal(h5NoReset.doc.h5_none, false); assert.notEqual(h5NoReset.band, 'green', JSON.stringify(h5NoReset));
  // A forged marker after a high 5-hour reading in its window: the stored figure is handed on and checked (red).
  const forged = await scenario(ans(T0 + 60_000, { h5: null, week: WEEK, week_from: 'weekly_all', h5_none: true }),
    ans(T0, { h5: { used_pct: 97, resets_at: '2026-11-05T14:00:00.000Z' }, week: WEEK, week_from: 'weekly_all' }));
  assert.equal(forged.doc.h5_none, false); assert.equal(forged.band, 'red');
  // And the live case still bands from the week: two clean week-only reports.
  const live = await scenario(ans(T0 + 60_000, { h5: null, week: WEEK, week_from: 'weekly_all', h5_none: true }));
  assert.equal(live.doc.h5_none, true); assert.equal(live.band, 'green'); assert.equal(live.noted, false);
});

// r5: answers one minute apart (an answer of null: the read fails, the loop writes its blank reading); the band and fact
// after each pass.
async function steps(answers) {
  const dir = tempDir('orch-steps-'); chmodSync(dir, 0o755); const file = join(dir, ANSWER_FILE);
  const rec = memoryRecord(); const out = [];
  try {
    for (const [i, a] of answers.entries()) {
      const n = i * 60_000;
      if (a) assert.equal(writeAnswer({ to: file, answer: a }).ok, true); else rmSync(file, { force: true });
      const q = sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) });
      await sensorsPass({ rec, ports: { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {} }, now: () => new Date(T0 + n) });
      const doc = rec.read('fact', USAGE_FACT('a'))?.doc;
      const r = readFact({ doc }, { account: 'a', now: T0 + n + 1000, staleMs: 15 * 60_000 });
      out.push({ doc, band: bands({ rules: rulesWith(), reading: r, now: T0 + n + 1000 }).band });
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('L1331 r5: what a reading showed holds the marker off for 5 hours, through every later write', async () => {
  const none = (i, week = WEEK) => ans(T0 + i * 60_000, { h5: null, week, week_from: 'weekly_all', h5_none: true });
  const h5NoReset = ans(T0, { h5: { used_pct: 97, resets_at: null }, week: WEEK, week_from: 'weekly_all' });
  const refused = ans(T0 + 60_000, null, { usage_reason: 'the /usage report has a row of a kind this does not know (five_hour)' });
  const cases = {
    'A: a 5-hour figure without a reset time, then two week-only reports': [h5NoReset, none(1), none(2)],
    'B: the same, with a refused report between': [h5NoReset, refused, none(2)],
    'B2: the same, with a failed read between': [h5NoReset, null, none(2)],
    'F: a 96% week without a reset time, then week-only 30%': [none(0), none(1, { used_pct: 96, resets_at: null }), none(2), none(3)],
  };
  for (const [name, answers] of Object.entries(cases)) {
    const out = await steps(answers);
    for (const [i, s] of out.entries()) if (i > 0) assert.notEqual(s.band, 'green', `${name}, pass ${i}: ${JSON.stringify(s)}`);
    assert.equal(typeof out.at(-1).doc.h5_hold_until, 'string', name);
  }
  // The hold ends after 5 hours: the live plan reads green again then, and the hold field is cleared.
  const out = await steps([none(0)]);
  assert.deepEqual([out[0].band, out[0].doc.h5_hold_until], ['green', null]);
});
