import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoStep, UNDO_CARD, FIX_CARD, REVERSE_FACT } from './undo.mjs';
import { rulesWith, recWith, T0, iso } from './fixtures.test-helper.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const COUNT = { count_approval: { decision: 'allow', reason: 'a counted tap' } };
const R = rulesWith({}, COUNT);
const ask = (over = {}) => ({ state: 'answered', kind: 'undo', via: 'tap', pr: 7, merge_commit_sha: SHA, answered_at: iso(T0), ...over });
const merged = (over = {}) => ({ state: 'audited_ok', pr: 7, merge_commit_sha: SHA, product: 'p', card: 'C-1', module: 'M-u', ...over });

function world(entries, { files = ['src/a.js', 'src/b.js'] } = {}) {
  const rec = recWith(entries);
  const calls = { alerts: [], filesOf: [] };
  const step = (rules = R) => undoStep({ rec, rules, now: T0, filesOf: (s) => { calls.filesOf.push(s); return files; }, alert: (t) => calls.alerts.push(t) });
  return { rec, calls, step };
}

test('M21: an answered, counted tap naming a merged PR -> one go-free undo card first in the queue; the ask consumed', () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]]);
  assert.deepEqual(w.step(), [['A-1', 'undo card written']]);
  const card = w.rec.read('card', UNDO_CARD('A-1')).doc;
  assert.equal(card.kind, 'undo');
  assert.equal(card.go_free, true);
  assert.equal(card.queue, 'front');
  assert.equal(card.state, 'ready');
  assert.deepEqual(card.files, ['src/a.js', 'src/b.js']);
  assert.deepEqual([card.pr, card.merge_commit_sha, card.reverses, card.product], [7, SHA, 'M-1', 'p']);
  assert.deepEqual(w.calls.filesOf, [SHA]);
  const a = w.rec.read('ask', 'A-1').doc;
  assert.equal(a.state, 'consumed');
  assert.equal(a.card, UNDO_CARD('A-1'));
  // asking again is harmless
  assert.deepEqual(w.step(), []);
  assert.equal(w.rec.list('card').length, 1);
});

test('an undo card the record refuses (no module known) alerts Joe once and leaves the ask answered', () => {
  const w = world([['merge', 'M-1', merged({ module: undefined, card: null })], ['ask', 'A-1', ask()]]);
  assert.match(w.step()[0][1], /undo card not recorded: card is missing module/);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /PR 7 could not be queued/);
  w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
});

test('M21: every merged state counts; a merge that did not land does not', () => {
  for (const state of ['merged', 'audited_ok', 'audit_flagged']) {
    const w = world([['merge', 'M-1', merged({ state })], ['ask', 'A-1', ask()]]);
    assert.equal(w.step()[0][1], 'undo card written', state);
  }
  for (const state of ['requested', 'checking', 'merging', 'refused']) {
    const w = world([['merge', 'M-1', merged({ state })], ['ask', 'A-1', ask()]]);
    assert.equal(w.step()[0][1], 'no merged attempt matches', state);
    assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  }
});

test('M21: not a tap, not counted, or naming no matching merge -> nothing written', () => {
  const cases = [
    [ask({ via: 'typed' }), R, /not a tap/],
    [ask(), rulesWith(), /not counted/], // no count_approval answer -> denied
    [ask(), rulesWith({}, { count_approval: { decision: 'ask', tier: 1, reason: 'needs a second look' } }), /not counted/],
    [ask({ merge_commit_sha: OTHER }), R, /no merged attempt matches/],
    [ask({ pr: 8 }), R, /no merged attempt matches/],
    [ask({ pr: undefined }), R, /names no merged PR/],
    [ask({ merge_commit_sha: 'abc' }), R, /names no merged PR/],
  ];
  for (const [a, rules, why] of cases) {
    const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', a]]);
    const out = w.step(rules);
    assert.match(out[0][1], why);
    assert.equal(w.rec.list('card').length, 0);
    assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  }
});

test('M21: only answered undo asks are read', () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask({ state: 'open' })], ['ask', 'A-2', ask({ kind: 'delete_copy' })]]);
  assert.deepEqual(w.step(), []);
});

test('M21: count_approval sees the ask', () => {
  let seen;
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]]);
  w.step(rulesWith({}, { count_approval: (s) => { seen = s; return { decision: 'allow', reason: 'ok' }; } }));
  assert.equal(seen.ask.id, 'A-1');
  assert.equal(seen.ask.via, 'tap');
});

test('M21: the reversed commit\'s files cannot be read -> no card, the ask stays answered for the next pass', () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]], { files: null });
  assert.match(w.step()[0][1], /could not be read/);
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  assert.equal(w.rec.list('card').length, 0);
});

test('M21: a pass stopped after the card and before the ask move finishes without a second card', () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()], ['card', UNDO_CARD('A-1'), { state: 'ready', kind: 'undo', pr: 7 }]]);
  assert.deepEqual(w.step(), [['A-1', 'undo card written']]);
  assert.equal(w.calls.filesOf.length, 0);
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'consumed');
});

test('D8: M6 says not clean -> a fix card first in the Lead\'s queue and one alert', () => {
  const U = UNDO_CARD('A-1');
  const w = world([['card', U, { state: 'running', kind: 'undo', pr: 7, product: 'p' }], ['fact', REVERSE_FACT(U), { state: 'not_clean', reason: 'a later change touched src/a.js' }]]);
  assert.deepEqual(w.step(), [[U, 'fix card written']]);
  const fix = w.rec.read('card', FIX_CARD(U)).doc;
  // audit MAT-4: the fix card waits on the Lead to plan it; it is never `ready` for a worker
  assert.deepEqual([fix.kind, fix.for, fix.queue, fix.state, fix.about, fix.module], ['fix', 'lead', 'front', 'waiting', U, 'M-test']);
  assert.equal(fix.waiting.who, 'lead');
  for (const f of ['who', 'what', 'since', 'next_check']) assert.ok(fix.waiting[f], f);
  assert.match(fix.what, /a later change touched src\/a\.js/);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /PR 7/);
  w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
});

test('D8: a clean reverse, or no word from M6 yet, writes nothing', () => {
  const U = UNDO_CARD('A-1');
  const w = world([['card', U, { state: 'running', kind: 'undo', pr: 7 }], ['card', 'C-2', { state: 'running' }], ['fact', REVERSE_FACT('C-2'), { state: 'not_clean' }]]);
  assert.deepEqual(w.step(), []);
  const w2 = world([['card', U, { state: 'running', kind: 'undo', pr: 7 }], ['fact', REVERSE_FACT(U), { state: 'clean' }]]);
  assert.deepEqual(w2.step(), []);
  assert.equal(w2.calls.alerts.length, 0);
});
