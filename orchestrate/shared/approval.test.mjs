// The one approval check (LEAD-CALLS L81), against M10's real engine on its sample policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerCounts, countSubject, CHANNEL_TIER } from './approval.mjs';
import { fakeRules, makeRules } from './rules.mjs';
import { makeEngine } from '../modules/M10-rules/engine.mjs';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const M10 = join(here, '../modules/M10-rules');
const policy = parsePolicy(readFileSync(join(M10, 'fixtures/policy.yaml'), 'utf8'));
assert.ok(policy.ok, policy.reason);
const real = makeRules(makeEngine({ products: ['p'], rulesState: () => ({ status: 'ok', policy: policy.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
  productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(M10, 'roles'), clock: () => Date.parse('2026-10-29T12:00:00Z') }));

// An ask as M2's createAsk writes it, with the answer M2 records.
const ask = (over = {}, answer = {}) => ({ kind: 'undo', product: 'p', card: 'C-1', tier: 2, risky: [], state: 'answered', answer: { channel: 'tap', choice: 'Undo', approves: true, ...answer }, ...over });

test('L81: a tap on an Undo ask counts at Tier 2; a GitHub Approve on a decision counts at Tier 1', () => {
  assert.deepEqual({ ...answerCounts(real, ask()), verdict: undefined }, { ok: true, tier: 2, verdict: undefined });
  const d = answerCounts(real, ask({ kind: 'decision', tier: 1 }, { channel: 'github_review', choice: 'approve' }));
  assert.equal(d.ok, true, d.reason);
  assert.equal(d.tier, 1);
});

test('L81: the subject is exactly what count_approval reads, with the channel from answer.channel', () => {
  assert.deepEqual(countSubject(ask()), { product: 'p', card: 'C-1', ask_kind: 'undo', channel: 'tap', tier: 2, risky: [] });
  assert.equal(countSubject(ask(), 'q').product, 'q');
  let seen;
  answerCounts(fakeRules({ answers: { count_approval: (s) => { seen = s; return { decision: 'ask', tier: 2, reason: 'tap' }; } } }), ask(), { product: 'p' });
  assert.deepEqual(seen, countSubject(ask()));
});

test('L81: no top-level `via`: only answer.channel names the channel', () => {
  // A `via` beside the answer is ignored both ways.
  assert.equal(answerCounts(real, ask({ via: 'github_review' })).ok, true);
  const r = answerCounts(real, ask({ via: 'tap' }, { channel: 'github_review' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /tap in a question box/);
  // No answer.channel is never counted, whatever else names one.
  assert.match(answerCounts(real, ask({ via: 'tap' }, { channel: undefined })).reason, /no channel the rules know/);
});

test('L81: only "ask" at the channel\'s own tier counts', () => {
  const said = (verdict) => answerCounts(fakeRules({ answers: { count_approval: verdict } }), ask());
  assert.equal(said({ decision: 'allow', reason: 'allowed' }).ok, false);
  assert.equal(said({ decision: 'ask', tier: 1, reason: 'github' }).ok, false);
  assert.equal(said({ decision: 'deny', reason: 'no' }).ok, false);
  assert.equal(said({ decision: 'ask', tier: 2, reason: 'tap' }).ok, true);
  // A risky class needs the GitHub Approve: the real engine does not count a tap for it.
  assert.match(answerCounts(real, ask({ risky: ['schema'] })).reason, /Approve on GitHub/);
  assert.deepEqual(CHANNEL_TIER, { github_review: 1, tap: 2 });
});

test('L81: approves: the answer must approve (an Undo or a delete), else it is not counted', () => {
  assert.equal(answerCounts(real, ask({}, { approves: false })).ok, true, 'a recorded "Keep" is still a counted answer');
  assert.match(answerCounts(real, ask({}, { approves: false }), { approves: true }).reason, /does not approve/);
  assert.match(answerCounts(real, ask({}, { approves: 'yes' }), { approves: true }).reason, /does not approve/);
  assert.equal(answerCounts(real, ask(), { approves: true }).ok, true);
});

test('L81: no answer, an unknown channel, the old { ask } shape and rules that throw are never counted', () => {
  assert.match(answerCounts(real, ask({ answer: undefined })).reason, /no recorded answer/);
  assert.match(answerCounts(real, ask({}, { channel: 'typed' })).reason, /no channel/);
  assert.match(answerCounts(real, ask({}, { channel: 'constructor' })).reason, /no channel/);
  assert.equal(real.may('count_approval', { ask: ask() }).decision, 'deny', 'the old shape');
  const throws = { may: () => { throw new Error('boom'); } };
  assert.match(answerCounts(throws, ask()).reason, /could not be asked \(boom\)/);
  assert.equal(answerCounts(real, ask({ product: 'unknown' })).ok, false);
});
