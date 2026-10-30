import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { POWER_FACT } from '../M12-sensors/power-source.mjs';
import { STATUS_FACT } from '../M13-ledger/heartbeat.mjs';
import { buildTripBrief, miniCheck, airCheck, AIR_FACT } from './trip.mjs';
import { FAKE } from '../M12-sensors/fakes.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const now = () => new Date(NOW);
const ago = (min) => new Date(NOW - min * 60e3).toISOString();
const HB = 'mini';

function world() {
  const rec = memoryRecord();
  const facts = makeFactWriter(rec, { actor: 'ledger', now });
  const w = (entity, id, doc) => assert.equal(rec.write({ actor: 'dispatcher', entity, id, expectRev: rec.read(entity, id)?.rev ?? 0, doc }).ok, true);
  return { rec, facts, w };
}
const green = (facts) => {
  facts.put(STATUS_FACT(HB), { kind: 'fact.heartbeat-status', at: ago(5), front_door_reachable: true, signed_in: true, login: 'account A', red: [] });
  facts.put(POWER_FACT, { kind: 'fact.power-source', at: ago(5), source: 'AC Power', ups_present: true, on_ups_power: false });
};

test('MAT-9: no facts at all → every Mini item and the Air read "unknown", never green', () => {
  const { facts } = world();
  const m = miniCheck({ facts, heartbeatProduct: HB, now });
  assert.equal(m.green, false);
  assert.deepEqual(m.items.map((i) => i.state), ['unknown', 'unknown', 'unknown']);
  const a = airCheck({ facts, now });
  assert.equal(a.passed, false);
  assert.match(a.text, /last result you told me: never/);
  assert.match(a.text, /type \/configaudit/);
});

test('MAT-9: facts older than an hour are unknown; fresh ones are green; a fresh "no" is red', () => {
  const { facts } = world();
  green(facts);
  assert.equal(miniCheck({ facts, heartbeatProduct: HB, now }).green, true);
  facts.put(STATUS_FACT(HB), { kind: 'fact.heartbeat-status', at: ago(61), front_door_reachable: true, signed_in: true, login: 'account A' });
  const stale = miniCheck({ facts, heartbeatProduct: HB, now });
  assert.equal(stale.green, false);
  assert.deepEqual(stale.items.map((i) => i.state), ['unknown', 'unknown', 'green']);
  facts.put(STATUS_FACT(HB), { kind: 'fact.heartbeat-status', at: ago(2), front_door_reachable: false, signed_in: false, login: null });
  facts.put(POWER_FACT, { kind: 'fact.power-source', at: ago(2), ups_present: false });
  assert.deepEqual(miniCheck({ facts, heartbeatProduct: HB, now }).items.map((i) => i.state), ['red', 'red', 'red']);
  facts.put(POWER_FACT, { kind: 'fact.power-source', at: ago(2), ups_present: null });
  assert.equal(miniCheck({ facts, heartbeatProduct: HB, now }).items[2].state, 'unknown', 'a failed power read stays unknown');
});

test('Air: passed only with 0 red told within 24 h', () => {
  const { facts } = world();
  facts.put(AIR_FACT, { kind: 'fact.air-health', red_count: 0, told_at: ago(60) });
  assert.equal(airCheck({ facts, now }).passed, true);
  facts.put(AIR_FACT, { kind: 'fact.air-health', red_count: 2, told_at: ago(60) });
  assert.match(airCheck({ facts, now }).text, /2 red/);
  facts.put(AIR_FACT, { kind: 'fact.air-health', red_count: 0, told_at: ago(60 * 30) });
  assert.equal(airCheck({ facts, now }).passed, false);
});

test('R-0b-83 brief: away line, time zone question, go items and risky asks with links, green Mini, Air', () => {
  const { rec, facts, w } = world();
  green(facts);
  facts.put(AIR_FACT, { kind: 'fact.air-health', red_count: 0, told_at: ago(30) });
  w('go', 'go-1', { state: 'waiting', wait: { who: 'joe', what: 'go on roadmap row 7', since: ago(100) }, link: 'https://example.invalid/roadmap#row-7' });
  w('go', 'go-2', { state: 'done' });
  w('ask', 'ask-1', { state: 'pushed', what: `delete the old table (pasted ${FAKE.github})`, link: 'https://example.invalid/pr/9' });
  w('ask', 'ask-2', { state: 'expired', what: 'old' });
  w('ask', 'ask-3', { state: 'open', what: 'no link here' });
  const text = buildTripBrief({ products: [{ name: 'test-product', on_merge_gate: true }, { name: 'second', on_merge_gate: false }], until: '2026-11-07', tz: null, rec, facts, heartbeatProduct: HB, now });
  assert.match(text, /test-product, second set to away until 2026-11-07/);
  assert.match(text, /Which time zone will you be in\?.*number work holds; \[Undo\] still runs/);
  assert.match(text, /second still merges the way you run it today; the hours rule starts at the second cutover/);
  assert.match(text, /Waiting on your go \(1\):\n- go-1: .*go on roadmap row 7.*\(https:\/\/example.invalid\/roadmap#row-7\)/);
  assert.match(text, /Open risky-act asks \(2\); they still expire after 12 h/);
  assert.match(text, /ask-1: .*\(https:\/\/example.invalid\/pr\/9\)/);
  assert.match(text, /ask-3: .*RECORD ERROR: no pull request link/);
  assert.equal(text.includes('ask-2'), false);
  assert.equal(text.includes(FAKE.github), false, 'ask text is masked');
  assert.match(text, /Mini check: green/);
  assert.match(text, /Air health check: passed/);
});

test('with a time zone, Merge Gate products get the hours line; Mini going off → freeze wording, no Mini check', () => {
  const { rec, facts } = world();
  const text = buildTripBrief({ products: [{ name: 'test-product', on_merge_gate: true }], tz: 'Europe/Prague', rec, facts, heartbeatProduct: HB, miniGoingOff: true, now });
  assert.match(text, /test-product: number work merges only 07:00–22:00 Europe\/Prague/);
  assert.equal(text.includes('Which time zone'), false);
  assert.match(text, /products freeze.*digest issue and the GitHub view.*one "heartbeat stale" issue\. MAIN is not affected\./);
  assert.equal(text.includes('Mini check'), false);
  const noFacts = buildTripBrief({ products: [{ name: 'test-product', on_merge_gate: true }], tz: 'UTC', rec, facts, heartbeatProduct: HB, now });
  assert.match(noFacts, /Mini check: NOT green/);
  assert.equal((noFacts.match(/unknown \(no fact from the last hour\)/g) ?? []).length, 3);
});
