// round5.test.mjs — planted cases for the 0b-8 audit round 5 findings. Each fails on the old code (8a2cfc5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { airHealthFile, checkAirHealthFile, airFactFromFile } from '../M12-sensors/air-health.mjs';
import { airCheck, AIR_FACT, nextTripPush, FREEZE_TEXT } from './trip.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const at = (h) => new Date(T0 + h * 3600e3);
const brief = (ids) => `Brief made ${at(0).toISOString()}; answers state files: ${ids.join(', ')}.\nTrip mode: A, B set to away.\n`;

test('0b-8 audit round 5 M-1: a plain pause after a trip pushes no trip brief', () => {
  const trip = [{ id: '20261103-0915-kq', state: 'away' }, { id: '20261103-0915-kr', state: 'away' }];
  const p = nextTripPush({ states: trip, build: brief });
  assert.deepEqual(p.ids, ['20261103-0915-kq', '20261103-0915-kr']);
  const later = [{ id: '20261110-0915-kz', state: 'paused' }, trip[1]];
  assert.equal(nextTripPush({ states: later, lastPushedIds: p.ids, build: brief }), null, 'old code pushed "set to away" after a pause');
});

test('0b-8 audit round 5 M-2: the skill says the freeze wording itself when the Mini is turning off', () => {
  const skill = readFileSync(new URL('./skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
  assert.ok(skill.includes(FREEZE_TEXT), 'the skill carries the exact freeze text');
});

test('0b-8 audit round 5 M-3: an older Air result synced late never replaces a newer one', () => {
  const rec = memoryRecord();
  const facts = makeFactWriter(rec, { actor: 'ledger', now: () => at(0) });
  const takeIn = (f) => {
    const c = checkAirHealthFile(f.name, f.text, () => at(0));
    const fact = airFactFromFile(c.doc, () => at(0), facts.get(AIR_FACT));
    if (fact) facts.put(AIR_FACT, fact);
  };
  takeIn(airHealthFile({ red_count: 3, at: at(-0.5) }));
  takeIn(airHealthFile({ red_count: 0, at: at(-2) }));
  const a = airCheck({ facts, now: () => at(0) });
  assert.equal(a.passed, false); assert.match(a.text, /3 red/);
  takeIn(airHealthFile({ red_count: 0, at: at(-0.1) }));
  assert.equal(airCheck({ facts, now: () => at(0) }).passed, true, 'a newer check does replace it');
});
