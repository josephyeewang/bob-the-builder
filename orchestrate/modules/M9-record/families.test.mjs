// families.test.mjs — L74: fact ids by family, change-own, and a card's attempts, on the real Record and the stand-in.
// A role creates a fact only under its own families and changes only a fact it created; no two roles' families
// overlap; a gating reader takes a fact as proof only by family AND writer (factFrom); each attempts key has one writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord, SCRIPT_ACTORS } from '../../shared/record.mjs';
import { ATTEMPTS, FACT_FAMILIES, WRITERS, factFamilyOf, factFrom, familyOverlaps } from './permissions.mjs';
import { guardWrite } from './guard.mjs';
import { PRODUCT, must, product, put, readyCard, setup } from './fixtures.test-helper.mjs';

const write = (rec, actor, id, doc, expectRev = rec.read('fact', id)?.rev ?? 0) => rec.write({ actor, entity: 'fact', id, expectRev, doc });
const both = () => [['real', setup({ prefix: 'm9-fam-' }).record], ['stand-in', memoryRecord()]];

test('the families do not overlap, and the table has the planted overlaps it must catch', () => {
  assert.deepEqual(familyOverlaps(), []);
  // Every family is a non-empty string, listed once.
  const all = Object.values(FACT_FAMILIES).flat();
  assert.ok(all.every((f) => typeof f === 'string' && f.length > 1), 'no empty family');
  assert.equal(new Set(all).size, all.length, 'no family listed twice');
  // The check finds each kind of overlap: the same entry, a prefix covering an exact id, a prefix covering a prefix.
  assert.equal(familyOverlaps({ a: ['x-'], b: ['x-'] }).length, 1);
  assert.equal(familyOverlaps({ a: ['usage-'], b: ['usage-band'] }).length, 1);
  assert.equal(familyOverlaps({ a: ['alert-'], b: ['alert-unsent-'] }).length, 1);
  assert.equal(familyOverlaps({ a: ['alert-'], b: ['review-alert-'] }).length, 0, 'a family inside another word is no overlap');
  assert.equal(familyOverlaps({ a: ['phone-link', 'phone-link-'] }).length, 0, 'one role may hold both');
  // Every role with families can write facts or is the store's own; every role in the fact row is a script actor.
  for (const role of Object.keys(FACT_FAMILIES)) assert.ok(role === 'store' || Object.hasOwn(WRITERS.fact, role), role);
  for (const role of Object.keys(WRITERS.fact)) assert.ok(SCRIPT_ACTORS.includes(role), role);
});

test('each family names its one owner; a prefix needs something after it', () => {
  assert.equal(factFamilyOf('pr-12'), 'sensors');
  assert.equal(factFamilyOf('pr-'), null, 'a bare prefix is no id');
  assert.equal(factFamilyOf('band-usage'), 'dispatcher');
  assert.equal(factFamilyOf('usage-acct-1'), 'sensors');
  assert.equal(factFamilyOf('unknown-usage-alert'), 'dispatcher');
  assert.equal(factFamilyOf('alert-x'), 'ledger');
  assert.equal(factFamilyOf('unsent-alerts'), 'dispatcher');
  assert.equal(factFamilyOf('intake-applied-S-1-a.md'), 'dispatcher');
  assert.equal(factFamilyOf('outbox-refused-S-1-abc'), 'store');
  assert.equal(factFamilyOf('outbox-S-1-a.md'), null, 'the old intake name has no owner now');
  assert.equal(factFamilyOf('reverse-U-1'), 'merge_gate');
  assert.equal(factFamilyOf('push.C-1.1'), 'workshop');
  assert.equal(factFamilyOf('blueprint_freshness_alarm'), 'sensors');
  assert.equal(factFamilyOf('blueprint_freshness_alarm-2'), null, 'an exact family is that one id');
  assert.equal(factFamilyOf('tab-heartbeat-T-1'), 'dispatcher', 'a tab heartbeat is the Dispatcher\'s (L77 (5))');
  assert.equal(factFamilyOf('heartbeat-T-1'), 'ledger', 'the Ledger\'s own heartbeat- is another family');
  assert.equal(factFamilyOf('hb-T-1'), null);
});

test('PLANT squatting: no role creates a fact in another role\'s family, on the real Record and the stand-in', () => {
  for (const [what, rec] of both()) {
    assert.match(write(rec, 'dispatcher', 'pr-7', { n: 1 }).reason, /fact pr-7 is in sensors's family, not dispatcher's/, what);
    assert.match(write(rec, 'sensors', 'outage', { n: 1 }).reason, /in dispatcher's family/, what);
    assert.match(write(rec, 'workshop', 'audit-run-1', { n: 1 }).reason, /in sensors's family/, what);
    assert.match(write(rec, 'dispatcher', 'reverse-U-1', { n: 1 }).reason, /in merge_gate's family/, what);
    assert.match(write(rec, 'ledger', 'outbox-refused-S-1-x', { n: 1 }).reason, /in store's family/, what);
    assert.match(write(rec, 'live_check', 'anything', { n: 1 }).reason, /in no family/, what);
    assert.match(write(rec, 'dispatcher', 'outbox-S-1-a.md', { n: 1 }).reason, /in no family/, what);
    // Each in its own family is fine.
    for (const [role, id] of [['sensors', 'pr-7'], ['dispatcher', 'outage'], ['ledger', 'alert-1'], ['workshop', 'push.C-1.1'], ['merge_gate', 'reverse-U-1']]) {
      must(write(rec, role, id, { n: 1 }), `${what}: ${role} ${id}`);
    }
  }
});

test('PLANT change-own: a fact is changed only by the role that created it', () => {
  for (const [what, rec] of both()) {
    must(write(rec, 'sensors', 'pr-7', { n: 1 }), what);
    must(write(rec, 'dispatcher', 'outage', { n: 1 }), what);
    assert.match(write(rec, 'dispatcher', 'pr-7', { n: 2 }).reason, /dispatcher may change only a fact it created; pr-7 was created by sensors/, what);
    assert.match(write(rec, 'sensors', 'outage', { n: 2 }).reason, /sensors may change only a fact it created/, what);
    assert.match(write(rec, 'ledger', 'pr-7', { n: 2 }).reason, /ledger may change only a fact it created/, what);
    must(write(rec, 'sensors', 'pr-7', { n: 2 }), `${what}: its own`);
    must(write(rec, 'dispatcher', 'outage', { n: 2 }), `${what}: its own`);
    assert.equal(rec.read('fact', 'pr-7').doc.n, 2);
  }
  // The guard refuses an own-row update when the caller can't say who created the document.
  assert.match(guardWrite({ entity: 'fact', id: 'outage', actor: 'dispatcher', old: { n: 1 }, doc: { n: 2 } }).reason, /created by an unknown writer/);
});

test('PLANT look-alike: a gating reader takes a fact as proof only by its family AND its writer', () => {
  const rec = (id, createdBy) => ({ id, createdBy, doc: { type: 'audit_run' } });
  assert.equal(factFrom('sensors', rec('audit-run-1', 'sensors'), 'audit-run-'), true);
  assert.equal(factFrom('sensors', rec('audit-run-1', 'merge_gate'), 'audit-run-'), false, 'right family, wrong writer');
  assert.equal(factFrom('sensors', rec('push.1', 'workshop'), 'audit-run-'), false, 'the workshop is never proof');
  assert.equal(factFrom('sensors', rec('pr-1', 'sensors'), 'audit-run-'), false, 'right writer, wrong family');
  assert.equal(factFrom('sensors', rec('pr-1', 'sensors')), true, 'any of the role\'s families when none is named');
  assert.equal(factFrom('sensors', rec('reverse-1', 'sensors')), false, 'a family not the role\'s');
  assert.equal(factFrom('sensors', rec('audit-run-1', 'sensors'), 'reverse-'), false, 'a named family not the role\'s');
  assert.equal(factFrom(null, rec('hb-1', 'sensors')), false, 'no writer named: nothing counts');
  assert.equal(factFrom('sensors', null), false);
});

test('attempts: each key only by its own writer, in its shape; no other key (L74)', () => {
  const env = setup({ prefix: 'm9-fam-' });
  product(env);
  readyCard(env, 'C-1');
  const at = (actor, attempts) => put(env.record, actor, 'card', 'C-1', { attempts });
  assert.deepEqual(Object.keys(ATTEMPTS).sort(), ['merge_refusals', 'reviewer_starts']);
  must(at('dispatcher', { reviewer_starts: 1 }), 'the dispatcher adds its own count');
  assert.match(at('dispatcher', { reviewer_starts: 1, merge_refusals: ['checks failed'] }).reason, /dispatcher may not change attempts.merge_refusals \(it is merge_gate's\)/);
  assert.match(at('merge_gate', { reviewer_starts: 2 }).reason, /merge_gate may not change attempts.reviewer_starts/);
  assert.match(at('dispatcher', { reviewer_starts: 1, stop_count: 1 }).reason, /attempts.stop_count is not a listed count/);
  assert.match(at('dispatcher', { reviewer_starts: -1 }).reason, /must be a whole number/);
  assert.match(at('dispatcher', { reviewer_starts: 1.5 }).reason, /must be a whole number/);
  assert.match(at('dispatcher', [1]).reason, /attempts must be an object/);
  must(at('merge_gate', { reviewer_starts: 1, merge_refusals: ['checks failed'] }), 'the gate adds its own reasons');
  assert.match(at('merge_gate', { reviewer_starts: 1, merge_refusals: [''] }).reason, /must be a list of reasons/);
  assert.match(at('workshop', { reviewer_starts: 1, merge_refusals: ['checks failed', 'x'] }).reason, /workshop may not change attempts/);
  assert.match(at('approvals', { reviewer_starts: 0, merge_refusals: ['checks failed'] }).reason, /approvals may not change attempts/);
  const doc = env.record.read('card', 'C-1').doc;
  assert.deepEqual(doc.attempts, { reviewer_starts: 1, merge_refusals: ['checks failed'] });
  assert.equal(doc.product, PRODUCT);
  // The stand-in refuses the same.
  const m = memoryRecord();
  must(m.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'draft', module: 'm' } }), 'card');
  assert.match(m.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'draft', module: 'm', attempts: { merge_refusals: ['x'] } } }).reason, /it is merge_gate's/);
});

test('PLANT fact-state: on a fact, `state` is a plain field, so a change to it alone is written (real and stand-in)', () => {
  for (const [what, rec] of both()) {
    must(write(rec, 'dispatcher', 'intake-applied-S-1-a.md', { session: 'S-1', state: 'starting' }), what);
    must(write(rec, 'dispatcher', 'intake-applied-S-1-a.md', { session: 'S-1', state: 'waiting' }), `${what}: the state alone changed`);
    assert.equal(rec.read('fact', 'intake-applied-S-1-a.md').doc.state, 'waiting', what);
    assert.match(write(rec, 'dispatcher', 'intake-applied-S-1-a.md', { session: 'S-1', state: 'waiting' }).reason, /nothing changed/, what);
  }
});
