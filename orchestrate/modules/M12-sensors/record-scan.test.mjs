import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { ENTITIES } from '../../shared/record.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';
import { looseFind, scanRecordLoose, runGitleaks } from './record-scan.mjs';
import { FAKE, run } from './fakes.mjs';

const ALL = Object.values(FAKE);

// The Sensors run holding their own Vercel key, so its exact value is masked wherever it appears (layer 1).
const SENSORS_ENV = { VERCEL_TOKEN: FAKE.vercelClassic };

function weekOfRecord(writeRaw = null, env = SENSORS_ENV) {
  const rec = memoryRecord();
  const w = makeFactWriter(rec, { masker: makeMasker({ env }) });
  // A "week" of Sensors facts carrying every fake key in log lines, commit text and check output.
  for (let day = 0; day < 7; day++) {
    for (const [i, key] of ALL.entries()) {
      w.put(`log-${day}-${i}`, { kind: 'fact.log', head_sha: 'c'.repeat(40), line: `day ${day}: auth failed with ${key} at src/app-2026.mjs` });
    }
  }
  if (writeRaw) rec.write({ actor: 'sensors', entity: 'fact', id: 'raw', expectRev: 0, doc: { line: writeRaw } });
  // The planted control the scan must reach (written around the masker on purpose).
  rec.write({ actor: 'sensors', entity: 'fact', id: 'scan-control', expectRev: 0, doc: { kind: 'fact.scan-control', line: `control ${FAKE.generic}` } });
  return rec;
}

test('R-0b-125: a week of masked Sensors facts finds 0 with the independent scan, and the control was found', () => {
  const r = scanRecordLoose(weekOfRecord(), ['fact'], { control: FAKE.generic });
  assert.equal(r.control_found, true);
  assert.equal(r.valid, true);
  assert.deepEqual(r.hits, []);
});

test('planted failure: one unmasked key written around the masker is found by the independent scan', () => {
  const r = scanRecordLoose(weekOfRecord(`oops ${FAKE.supabaseSecret}`), ['fact'], { control: FAKE.generic });
  assert.equal(r.count >= 1, true);
  assert.ok(r.hits.some((h) => h.where.startsWith('fact/raw')));
  assert.ok(!JSON.stringify(r).includes(FAKE.supabaseSecret), 'the scan never repeats the secret');
});

test('the scan is independent of the masker: it finds every fake key on its own', () => {
  for (const k of ['github', 'githubPat', 'vercelClassic', 'supabasePat', 'anthropic', 'generic']) {
    assert.ok(looseFind(`x ${FAKE[k]} y`).length >= 1, k);
  }
});

test('a scan whose control is not found reports itself invalid', () => {
  const r = scanRecordLoose(weekOfRecord(), ['fact'], { control: 'short' });
  assert.equal(r.valid, false);
});

test('identifiers, paths and timestamps are not flagged', () => {
  assert.deepEqual(looseFind(`sha ${'d'.repeat(40)} uuid 3f2b8c1e-9a4d-4e6f-8b2a-1c7d5e9f0a3b at 2026-10-29T17:00:00.123Z file orchestrate/modules/M12-sensors/record-scan.test.mjs`), []);
});

test('gitleaks: absent says so; present counts leaks', () => {
  const absent = runGitleaks('/nowhere', () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; });
  assert.deepEqual(absent, { ran: false, why: 'gitleaks not installed' });
  const present = runGitleaks('/nowhere', () => 'INF scanning\n[{"RuleID":"x"},{"RuleID":"y"}]\n');
  assert.deepEqual(present, { ran: true, leaks: 2 });
});

test('residual, recorded honestly: a bare 24-character Vercel classic token the Sensors do not hold passes the masker, and the independent scan catches it', () => {
  const r = scanRecordLoose(weekOfRecord(null, {}), ['fact'], { control: FAKE.generic });
  assert.equal(r.count, 7, 'one per day, all the bare Vercel classic token');
  assert.ok(r.hits.every((h) => h.length === FAKE.vercelClassic.length));
});

test('round 2 M-4: an empty entity list, a missed entity, or a control never planted makes the scan invalid', () => {
  const rec = weekOfRecord();
  const empty = scanRecordLoose(rec, [], { control: FAKE.generic });
  assert.equal(empty.valid, false, 'old code: valid with count 0');
  assert.deepEqual(empty.unscanned, ['fact']);
  rec.write({ actor: 'sensors', entity: 'ask', id: 'a1', expectRev: 0, doc: { kind: 'ask', note: `leak ${FAKE.supabaseSecret}` } });
  const partial = scanRecordLoose(rec, ['fact'], { control: FAKE.generic });
  assert.equal(partial.valid, false);
  assert.deepEqual(partial.unscanned, ['ask']);
  const whole = scanRecordLoose(rec, undefined, { control: FAKE.generic });
  assert.equal(whole.valid, true);
  assert.ok(whole.hits.some((h) => h.where.startsWith('ask/a1')), 'the default scans every entity');
  const otherKey = scanRecordLoose(weekOfRecord(), ['fact'], { control: FAKE.anthropic });
  assert.equal(otherKey.valid, false, 'a control that is not in the record is not found');
});
