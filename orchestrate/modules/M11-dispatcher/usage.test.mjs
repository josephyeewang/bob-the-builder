import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFact, bands, currentBands, mayStart, recordBands, USAGE_FACT, BAND_FACT } from './usage.mjs';
import { KEYS as K, MissingKey } from './keys.mjs';
import { rulesWith, usageFact, recWith, T0, MIN } from './fixtures.test-helper.mjs';

const R = rulesWith();
const at = (f, rules = R, account = 'acct-a') => currentBands({ rec: recWith([['fact', USAGE_FACT('acct-a'), f]]), rules, account, now: T0 });
// pace = (week / 100) / gone; at gone = 0.3 a pace p needs week = 30 × p (own building stays open below 31.5)
const pace = (p, h5 = 10) => at(usageFact({ week: 30 * p, h5, gone: 0.3 }));

test('M2 plants: the band edges', () => {
  const plant = at(usageFact({ week: 50, h5: 60, gone: 0.625 })); // pace 0.80, week 50, 5-hour 60
  assert.equal(plant.band, 'green');
  assert.equal(plant.own_building, 'full'); // past 45: the Dispatcher's own building stops, Joe's tabs don't
  assert.equal(pace(0.85).band, 'green');
  assert.equal(pace(0.86).band, 'amber');
  assert.equal(pace(1.0).band, 'amber');
  assert.equal(pace(1.01).band, 'red');
  assert.equal(at(usageFact({ week: 86, h5: 10, gone: 0.95 })).band, 'red');
  assert.equal(at(usageFact({ week: 10, h5: 80 })).band, 'red');
  assert.equal(at(usageFact({ week: 10, h5: 79 })).band, 'amber');
  assert.equal(at(usageFact({ week: 10, h5: 69 })).band, 'green');
  assert.equal(at(usageFact({ week: 10, h5: 70 })).band, 'amber');
});

test('row 67: pace 0.9 is amber; week 86 is red', () => {
  assert.equal(at(usageFact({ week: 27, h5: 10, gone: 0.3 })).band, 'amber'); // 0.27 / 0.3 = 0.9
  const r = at(usageFact({ week: 86, h5: 10, gone: 0.99 }));
  assert.equal(r.band, 'red');
  assert.match(r.reason, /week 86%/);
});

test('M1 / L13: pace counts only once a seventh of the week has gone', () => {
  // one hour in, 2% used: pace would be ~3.4
  const early = at(usageFact({ week: 2, h5: 10, gone: 1 / 168 }));
  assert.equal(early.band, 'green');
  assert.equal(early.pace, null);
  // just past the floor, the same pace counts
  const after = at(usageFact({ week: 30, h5: 10, gone: 0.15 }));
  assert.ok(after.pace > 1);
  assert.equal(after.band, 'red');
  // just before it, the same reading does not
  assert.equal(at(usageFact({ week: 14, h5: 10, gone: 0.14 })).pace, null);
  // a missing floor key falls back to 0.143
  assert.equal(at(usageFact({ week: 14, h5: 10, gone: 0.14 }), rulesWith({ [K.paceMinShare]: undefined })).pace, null);
  assert.ok(at(usageFact({ week: 14.4, h5: 10, gone: 0.144 }), rulesWith({ [K.paceMinShare]: undefined })).pace > 0.99);
  // a different floor in the rules is used
  assert.notEqual(at(usageFact({ week: 14, h5: 10, gone: 0.14 }), rulesWith({ [K.paceMinShare]: 0.1 })).pace, null);
});

test('M3: own building is amber at 31.5 and full at 45, and the band is not red', () => {
  const below = at(usageFact({ week: 31.4, h5: 10, gone: 0.6 }));
  assert.equal(below.own_building, 'open');
  assert.equal(below.band, 'green');
  const amber = at(usageFact({ week: 31.5, h5: 10, gone: 0.6 }));
  assert.equal(amber.own_building, 'amber');
  assert.equal(amber.band, 'green');
  // own-building amber gives the amber rules to the Dispatcher's own starts
  assert.equal(mayStart({ b: amber, kind: 'editing', tier: 2, redRuns: [] }).amberCaps, true);
  assert.equal(mayStart({ b: amber, kind: 'script', tier: 2, redRuns: [] }).ok, false);
  const full = at(usageFact({ week: 45, h5: 10, gone: 0.6 }));
  assert.equal(full.own_building, 'full');
  assert.equal(full.band, 'green');
  assert.equal(at(usageFact({ week: 44.9, h5: 10, gone: 0.6 })).own_building, 'amber');
  // full stops new editing, not reviews or the Lead
  assert.equal(mayStart({ b: full, kind: 'editing', tier: 2, redRuns: [] }).ok, false);
  assert.equal(mayStart({ b: full, kind: 'review', tier: 2, redRuns: [] }).ok, true);
  assert.equal(mayStart({ b: full, kind: 'lead', redRuns: [] }).ok, true);
  assert.equal(mayStart({ b: full, kind: 'readonly', tier: 2, redRuns: [] }).ok, true);
});

test('M5 / m14: unknown readings', () => {
  const unknown = (f, account = 'acct-a') => at(f, R, account);
  assert.equal(currentBands({ rec: recWith(), rules: R, account: 'acct-a', now: T0 }).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 10, h5: 10, observedAgoMin: 16 })).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 10, h5: 10, observedAgoMin: 14 })).band, 'green');
  assert.equal(unknown(usageFact({ week: 10, h5: 10, account: 'acct-b' })).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 10, h5: 10 }), null).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 10, h5: 10, h5ResetsInMin: -1 })).band, 'unknown');
  assert.equal(unknown({ ...usageFact({ week: 10, h5: 10 }), week: { used_pct: '10', resets_at: '2026-11-01T00:00:00Z' } }).band, 'unknown');
  assert.equal(unknown({ ...usageFact({ week: 10, h5: 10 }), observed_at: 'yesterday' }).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 10, h5: 10, observedAgoMin: -5 })).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 10, h5: 10, gone: -0.1 })).band, 'unknown');
  assert.equal(unknown(usageFact({ week: 101, h5: 10 })).band, 'unknown');
  const r = readFact({ doc: usageFact({ week: 10, h5: 10, observedAgoMin: 20 }) }, { account: 'acct-a', now: T0, staleMs: 15 * MIN });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale/);
});

test('M4 / L14: unknown counts as amber for ORCHESTRATE and blocks Tier-1 starts', () => {
  const b = at(usageFact({ week: 10, h5: 10, observedAgoMin: 30 }));
  assert.equal(b.band, 'unknown');
  assert.equal(mayStart({ b, kind: 'editing', tier: 1, redRuns: [] }).ok, false);
  const t2 = mayStart({ b, kind: 'editing', tier: 2, redRuns: [] });
  assert.equal(t2.ok, true);
  assert.equal(t2.amberCaps, true);
  assert.equal(mayStart({ b, kind: 'script', tier: 2, redRuns: [] }).ok, false);
  assert.equal(mayStart({ b, kind: 'overnight', tier: 2, redRuns: [] }).ok, false);
});

test('G3: what each band starts', () => {
  const RR = ['reviews', 'audits', 'merges'];
  const green = pace(0.5); const amber = pace(0.9); const red = pace(1.2);
  assert.deepEqual(mayStart({ b: green, kind: 'editing', tier: 2, redRuns: RR }), { ok: true, amberCaps: false });
  assert.equal(mayStart({ b: green, kind: 'script', tier: 2, redRuns: RR }).ok, true);
  assert.equal(mayStart({ b: amber, kind: 'script', tier: 2, redRuns: RR }).ok, false);
  assert.equal(mayStart({ b: amber, kind: 'overnight', tier: 2, redRuns: RR }).ok, false);
  assert.equal(mayStart({ b: amber, kind: 'editing', tier: 2, redRuns: RR }).amberCaps, true);
  assert.equal(mayStart({ b: amber, kind: 'readonly', tier: 2, redRuns: RR }).ok, true);
  for (const kind of ['editing', 'script', 'overnight', 'readonly']) assert.equal(mayStart({ b: red, kind, tier: 2, redRuns: RR }).ok, false, kind);
  for (const kind of ['review', 'audit', 'merge']) assert.equal(mayStart({ b: red, kind, tier: 2, redRuns: RR }).ok, true, kind);
  // red_runs comes from the rules: without audits, red holds them
  assert.equal(mayStart({ b: red, kind: 'audit', tier: 2, redRuns: ['reviews', 'merges'] }).ok, false);
  assert.equal(mayStart({ b: red, kind: 'undo', redRuns: [] }).ok, true);
  assert.equal(mayStart({ b: green, kind: 'mystery', tier: 2, redRuns: RR }).ok, false);
});

test('M23: no Tier-1 production work above 90%, in any band; undo exempt', () => {
  const b = at(usageFact({ week: 20, h5: 91, gone: 0.9 }));
  assert.equal(b.band, 'red');
  assert.equal(b.prodBlocked, true);
  assert.equal(mayStart({ b, kind: 'merge', tier: 1, risky: ['production_data'], redRuns: ['merges'] }).ok, false);
  assert.equal(mayStart({ b, kind: 'merge', tier: 1, risky: ['schema'], redRuns: ['merges'] }).ok, false);
  assert.equal(mayStart({ b, kind: 'merge', tier: 1, repair: true, redRuns: ['merges'] }).ok, false);
  assert.equal(mayStart({ b, kind: 'merge', tier: 1, risky: ['protected'], redRuns: ['merges'] }).ok, true);
  assert.equal(mayStart({ b, kind: 'undo', tier: 1, risky: ['production_data'], redRuns: [] }).ok, true);
  const week91 = at(usageFact({ week: 91, h5: 10, gone: 0.99 }));
  assert.equal(week91.prodBlocked, true);
  assert.equal(at(usageFact({ week: 50, h5: 90, gone: 0.9 })).prodBlocked, false);
  // amber with 5-hour 91 is impossible (red at 80), so lower the red line to show it holds in amber too
  const amber = at(usageFact({ week: 20, h5: 91, gone: 0.9 }), rulesWith({ [K.redH5]: 95 }));
  assert.equal(amber.band, 'amber');
  assert.equal(mayStart({ b: amber, kind: 'editing', tier: 1, risky: ['production_data'], redRuns: [] }).ok, false);
  assert.equal(mayStart({ b: amber, kind: 'editing', tier: 1, risky: ['protected'], redRuns: [] }).ok, true);
  // unknown also blocks the production merge request
  const unk = at(usageFact({ week: 10, h5: 10, observedAgoMin: 30 }));
  assert.equal(mayStart({ b: unk, kind: 'merge', tier: 1, risky: ['production_data'], redRuns: ['merges'] }).ok, false);
  assert.equal(mayStart({ b: unk, kind: 'merge', tier: 1, risky: [], redRuns: ['merges'] }).ok, true);
});

test('a missing threshold key refuses rather than guesses', () => {
  for (const key of [K.redWeek, K.amberPace, K.reservePct, K.noTier1ProdAbove, K.ownBuildingShare]) {
    assert.throws(() => at(usageFact({ week: 10, h5: 10 }), rulesWith({ [key]: undefined })), MissingKey, key);
  }
  assert.throws(() => at(usageFact({ week: 10, h5: 10 }), rulesWith({ [K.staleAfterMin]: undefined })), MissingKey);
  assert.throws(() => bands({ rules: rulesWith({ [K.redH5]: 'eighty' }), reading: { ok: false }, now: T0 }), MissingKey);
});

test('the usage-band fact keeps both values and the unknown start time', () => {
  const rec = recWith();
  const g = pace(0.5);
  assert.equal(recordBands({ rec, b: g, now: T0, account: 'acct-a' }).ok, true);
  assert.equal(rec.read('fact', BAND_FACT).doc.band, 'green');
  assert.equal(recordBands({ rec, b: g, now: T0 + MIN }).unchanged, true);
  const u = { band: 'unknown', own_building: 'unknown', reason: 'stale' };
  const first = recordBands({ rec, b: u, now: T0 + 2 * MIN });
  assert.equal(first.unknownSince, new Date(T0 + 2 * MIN).toISOString());
  const again = recordBands({ rec, b: { ...u, own_building: 'unknown' }, now: T0 + 60 * MIN });
  assert.equal(again.unknownSince, first.unknownSince);
  const doc = rec.read('fact', BAND_FACT).doc;
  assert.equal(doc.band, 'unknown');
  assert.equal(doc.own_building, 'unknown');
  const full = { band: 'amber', own_building: 'full', reason: 'own building full' };
  recordBands({ rec, b: full, now: T0 + 61 * MIN });
  assert.equal(rec.read('fact', BAND_FACT).doc.own_building, 'full');
  assert.equal(rec.read('fact', BAND_FACT).doc.unknown_since, null);
});

test('audit MIN-20 (U6, U7): the pace edges are exact: pace 1.0 is amber, 0.85 is green, and the floor share itself counts', () => {
  assert.equal(at(usageFact({ week: 50, h5: 10, gone: 0.5 })).pace, 1);
  assert.equal(at(usageFact({ week: 50, h5: 10, gone: 0.5 })).band, 'amber');
  assert.equal(at(usageFact({ week: 42.5, h5: 10, gone: 0.5 })).pace, 0.85);
  assert.equal(at(usageFact({ week: 42.5, h5: 10, gone: 0.5 })).band, 'green');
  const floor = at(usageFact({ week: 30, h5: 10, gone: 0.25 }), rulesWith({ [K.paceMinShare]: 0.25 }));
  assert.equal(floor.pace, 1.2);
  assert.equal(floor.band, 'red');
});

test('audit MIN-20 (U22): under unknown usage a Tier-1 review or audit is held; a merge request and Tier 2 are not', () => {
  const unk = at(usageFact({ week: 10, h5: 10, observedAgoMin: 30 }));
  const RR = ['reviews', 'audits', 'merges'];
  assert.match(mayStart({ b: unk, kind: 'review', tier: 1, redRuns: RR }).reason, /no Tier-1 start/);
  assert.equal(mayStart({ b: unk, kind: 'audit', tier: undefined, redRuns: RR }).ok, false);
  assert.equal(mayStart({ b: unk, kind: 'review', tier: 2, redRuns: RR }).ok, true);
  assert.equal(mayStart({ b: unk, kind: 'merge', tier: 1, redRuns: RR }).ok, true);
});

test('audit MIN-20 (K3): a negative, infinite or non-number rules value is missing, never used', async () => {
  const { need } = await import('./keys.mjs');
  for (const v of [-1, Infinity, NaN, '5', null]) assert.throws(() => need(rulesWith({ [K.redWeek]: v }), K.redWeek), MissingKey, String(v));
  assert.equal(need(rulesWith({ [K.redWeek]: 0 }), K.redWeek), 0);
});
