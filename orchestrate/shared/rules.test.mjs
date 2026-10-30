import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRules, fakeRules, allow, ask, deny, isDecision, ACTIONS, RISKY_CLASSES } from './rules.mjs';

test('a listed answer comes back with the rules version', () => {
  const r = fakeRules({ answers: { merge: allow('clean') }, rev: 'r7' });
  assert.deepEqual(r.may('merge', {}), { decision: 'allow', reason: 'clean', rev: 'r7' });
});

test('an action nobody listed is denied', () => {
  const r = fakeRules({ answers: { merge: allow('clean') } });
  assert.equal(r.may('rm_rf', {}).decision, 'deny');
  assert.equal(r.may('push_branch', {}).decision, 'deny');      // known action, but no answer from the rules
});

test('a throwing or junk implementation is a deny, never an exception', () => {
  const boom = makeRules({ may() { throw new Error('file unreadable'); }, get() { throw new Error('x'); }, classify() { throw new Error('x'); } });
  assert.match(boom.may('merge', {}).reason, /file unreadable/);
  assert.equal(boom.may('merge', {}).decision, 'deny');
  assert.equal(boom.get('caps.rounds'), undefined);
  for (const junk of [undefined, null, 'allow', { decision: 'allow' }, { decision: 'ask', tier: 3, reason: 'x' }, { decision: 'yes', reason: 'x' }]) {
    assert.equal(makeRules({ may: () => junk }).may('merge').decision, 'deny', JSON.stringify(junk));
  }
});

test('ask carries its tier; a function answer sees the subject', () => {
  const r = fakeRules({ answers: { count_approval: (s) => (s.via === 'github_review' ? allow('review') : ask(1, 'needs review')) } });
  assert.equal(r.may('count_approval', { via: 'github_review' }).decision, 'allow');
  assert.deepEqual(r.may('count_approval', { via: 'tap' }), { decision: 'ask', tier: 1, reason: 'needs review', rev: 'fake-1' });
});

test('classify fails closed to unclassifiable Tier 1', () => {
  const bad = [() => { throw new Error('no scan'); }, () => null, () => ({ tier: 2, risky: ['made_up'] }), () => ({ tier: 3, risky: [] })];
  for (const classify of bad) {
    const c = fakeRules({ classify }).classify({ files: [] });
    assert.equal(c.tier, 1);
    assert.deepEqual(c.risky, ['unclassifiable']);
  }
  assert.deepEqual(fakeRules().classify({ files: [] }).risky, []);
  for (const classify of [() => ({ tier: 2, risky: [] }), () => ({ tier: 2, risky: [], reasons: [] }), () => ({ tier: 2, risky: [], reasons: {}, protected: 'x' })]) {
    assert.deepEqual(fakeRules({ classify }).classify({ files: [] }).risky, ['unclassifiable']);
  }
});

test('any risky class or protected path forces Tier 1 (R2-m2)', () => {
  const risky = fakeRules({ classify: () => ({ tier: 2, risky: ['schema'], reasons: { schema: ['x'] } }) });
  assert.equal(risky.classify({ files: [] }).tier, 1);
  const prot = fakeRules({ classify: () => ({ tier: 2, risky: [], reasons: {}, protected: ['.husky/pre-commit'] }) });
  assert.equal(prot.classify({ files: [] }).tier, 1);
});

test('a caller cannot hand classify looser rules (R2-M10)', () => {
  let seen;
  const r = fakeRules({ classify: (c) => { seen = c; return { tier: c.policy || c.atCommit ? 2 : 1, risky: [], reasons: {} }; } });
  const change = { product: 'sample-app', files: [{ path: 'src/a.js', status: 'modified' }] };
  const plain = r.classify(change);
  const looser = r.classify({ ...change, policy: { tiers: { paths: [] } }, atCommit: 'abc' });
  assert.deepEqual(looser, plain);
  assert.ok(!('policy' in seen) && !('atCommit' in seen));
});

test('the shapes are fixed', () => {
  assert.ok(isDecision(deny('x')) && isDecision(ask(2, 'x')) && !isDecision(deny('')));
  assert.ok(Object.isFrozen(ACTIONS) && RISKY_CLASSES.includes('unclassifiable'));
});
