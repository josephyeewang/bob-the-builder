// round7.test.mjs — 0b-8 audit round 7 M-1: before the second cutover nothing holds number work, so neither the away
// push nor the trip brief may say it holds for a product not on the Merge Gate. Fails on 4303997.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutboxFile, intakePush } from './outbox.mjs';
import { buildTripBrief, nextTripPush, briefAnswers } from './trip.mjs';
import { readFileSync } from 'node:fs';
import { memoryRecord } from '../../shared/record.mjs';

test('0b-8 audit round 7 M-1: no time zone and not on the Merge Gate → nothing says number work holds', () => {
  const name = 'state-20261103-0915-kq.json';
  const r = checkOutboxFile(name, '{"product":"testprod","state":"away","until":"2026-11-06","tz":null}', { products: ['testprod'], seenIds: [] });
  const push = intakePush(name, r);
  assert.match(push, /^Confirmed: away testprod until 2026-11-06, no time zone yet/);
  assert.doesNotMatch(push, /hold/);
  const rec = memoryRecord();
  const brief = buildTripBrief({ products: [{ name: 'testprod', on_merge_gate: false }], tz: null, rec, facts: { get: () => null }, heartbeatProduct: 'testprod' });
  assert.doesNotMatch(brief, /number work holds/);
  assert.match(brief, /testprod still merges the way you run it today/);
});

test('0b-8 audit round 7 minor 1: a brief that throws is pushed as a failure once, never silently dropped', () => {
  const states = [{ id: '20261103-0915-kq', state: 'away' }];
  const p = nextTripPush({ states, build: () => { throw new Error('record down'); } });
  assert.equal(p.failed, true); assert.match(p.text, /^Trip brief failed/); assert.deepEqual(p.ids, ['20261103-0915-kq']);
  assert.equal(nextTripPush({ states, lastFailedIds: p.ids, build: () => { throw new Error('x'); } }), null, 'once per id set');
});

test('0b-8 audit round 8 M-1: after a failed brief the next healthy pass pushes the real brief; the failure push promises no retry Joe must do', () => {
  const states = [{ id: '20261103-0915-kq', state: 'away' }];
  const f = nextTripPush({ states, build: () => { throw new Error('record down'); } });
  assert.equal(f.failed, true); assert.doesNotMatch(f.text, /Say "brief"/);
  const ok = nextTripPush({ states, lastFailedIds: f.ids, build: (ids) => `Brief made x; answers state files: ${ids.join(', ')}.` });
  assert.equal(ok.failed, undefined); assert.match(ok.text, /20261103-0915-kq/);
});

test('0b-8 audit round 8 minor 2: a product with no Merge Gate value is "unknown", never "still merges the way you run it today"', () => {
  const rec = memoryRecord();
  const brief = buildTripBrief({ products: [{ name: 'testprod' }], tz: null, rec, facts: { get: () => null }, heartbeatProduct: 'testprod' });
  assert.match(brief, /testprod: Merge Gate status unknown/);
  assert.doesNotMatch(brief, /testprod still merges/);
});

test('0b-8 audit round 9 M-1 and minor 2: a failure names its ids so the skill can quote it; a bad id is a failure, not silence', () => {
  const states = [{ id: '20261103-0915-kq', state: 'away' }];
  const f = nextTripPush({ states, build: () => { throw new Error('x'); } });
  assert.equal(briefAnswers(f.text, ['20261103-0915-kq']), true, 'the skill quotes the failure from the brief file');
  const skill = readFileSync(new URL('./skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(skill, /it will come to your phone/);
  const bad = nextTripPush({ states: [{ id: 'state-20261103-0915-kq.json', state: 'away' }], build: () => 'x' });
  assert.equal(bad.failed, true);
  assert.equal(nextTripPush({ states: [{ id: 'state-20261103-0915-kq.json', state: 'away' }], lastFailedIds: bad.ids, build: () => 'x' }), null, 'once');
});
