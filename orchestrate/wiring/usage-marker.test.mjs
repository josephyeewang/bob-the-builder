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
