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

test('M21: an answered, counted tap naming a merged PR -> one go-free undo card first in the queue; the ask consumed', async () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]]);
  assert.deepEqual((await w.step()), [['A-1', 'undo card written']]);
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
  assert.deepEqual((await w.step()), []);
  assert.equal(w.rec.list('card').length, 1);
});

test('an undo card the record refuses (no module known) alerts Joe once and leaves the ask answered', async () => {
  const w = world([['merge', 'M-1', merged({ module: undefined, card: null })], ['ask', 'A-1', ask()]]);
  assert.match((await w.step())[0][1], /undo card not recorded: card is missing module/);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /PR 7 could not be queued/);
  await w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
});

test('M21: every merged state counts; a merge that did not land does not', async () => {
  for (const state of ['merged', 'audited_ok', 'audit_flagged']) {
    const w = world([['merge', 'M-1', merged({ state })], ['ask', 'A-1', ask()]]);
    assert.equal((await w.step())[0][1], 'undo card written', state);
  }
  for (const state of ['requested', 'checking', 'merging', 'refused']) {
    const w = world([['merge', 'M-1', merged({ state })], ['ask', 'A-1', ask()]]);
    assert.equal((await w.step())[0][1], 'no merged attempt matches', state);
    assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  }
});

test('M21: not a tap, not counted, or naming no matching merge -> nothing written', async () => {
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
    const out = (await w.step(rules));
    assert.match(out[0][1], why);
    assert.equal(w.rec.list('card').length, 0);
    assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  }
});

test('M21: only answered undo asks are read', async () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask({ state: 'open' })], ['ask', 'A-2', ask({ kind: 'delete_copy' })]]);
  assert.deepEqual((await w.step()), []);
});

test('M21: count_approval sees the ask', async () => {
  let seen;
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]]);
  await w.step(rulesWith({}, { count_approval: (s) => { seen = s; return { decision: 'allow', reason: 'ok' }; } }));
  assert.equal(seen.ask.id, 'A-1');
  assert.equal(seen.ask.via, 'tap');
});

test('M21: the reversed commit\'s files cannot be read -> no card, the ask stays answered for the next pass', async () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]], { files: null });
  assert.match((await w.step())[0][1], /could not be read/);
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  assert.equal(w.rec.list('card').length, 0);
});

test('M21: a pass stopped after the card and before the ask move finishes without a second card', async () => {
  const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()], ['card', UNDO_CARD('A-1'), { state: 'ready', kind: 'undo', pr: 7 }]]);
  assert.deepEqual((await w.step()), [['A-1', 'undo card written']]);
  assert.equal(w.calls.filesOf.length, 0);
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'consumed');
});

test('D8: M6 says not clean -> a fix card first in the Lead\'s queue and one alert', async () => {
  const U = UNDO_CARD('A-1');
  const w = world([['card', U, { state: 'running', kind: 'undo', pr: 7, product: 'p' }], ['fact', REVERSE_FACT(U), { state: 'not_clean', reason: 'a later change touched src/a.js' }]]);
  assert.deepEqual((await w.step()), [[U, 'fix card written']]);
  const fix = w.rec.read('card', FIX_CARD(U)).doc;
  // audit MAT-4: the fix card waits on the Lead to plan it; it is never `ready` for a worker
  assert.deepEqual([fix.kind, fix.for, fix.queue, fix.state, fix.about, fix.module], ['fix', 'lead', 'front', 'waiting', U, 'M-test']);
  assert.equal(fix.waiting.who, 'lead');
  for (const f of ['who', 'what', 'since', 'next_check']) assert.ok(fix.waiting[f], f);
  assert.match(fix.what, /a later change touched src\/a\.js/);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /PR 7/);
  await w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
});

test('D8: a clean reverse, or no word from M6 yet, writes nothing', async () => {
  const U = UNDO_CARD('A-1');
  const w = world([['card', U, { state: 'running', kind: 'undo', pr: 7 }], ['card', 'C-2', { state: 'running' }], ['fact', REVERSE_FACT('C-2'), { state: 'not_clean' }]]);
  assert.deepEqual((await w.step()), []);
  const w2 = world([['card', U, { state: 'running', kind: 'undo', pr: 7 }], ['fact', REVERSE_FACT(U), { state: 'clean' }]]);
  assert.deepEqual((await w2.step()), []);
  assert.equal(w2.calls.alerts.length, 0);
});

// Audit 0b-6 r4 MAT-4: each tap on its own, and no tap left untold (L38).
test('r4 MAT-4: a tap whose files read throws holds no other tap, and is told once a day', async () => {
  const rec = recWith([['merge', 'M-1', merged()], ['merge', 'M-2', merged({ pr: 8, merge_commit_sha: OTHER })],
    ['ask', 'A-1', ask()], ['ask', 'A-2', ask({ pr: 8, merge_commit_sha: OTHER })]]);
  const alerts = [];
  const step = (at) => undoStep({ rec, rules: R, now: at, alert: (t) => alerts.push(t),
    filesOf: (s) => { if (s === SHA) throw new Error('mirror unreadable'); return ['src/b.js']; } });
  const out = (await step(T0));
  assert.deepEqual(out.find(([id]) => id === 'A-2'), ['A-2', 'undo card written']);
  assert.ok(rec.read('card', UNDO_CARD('A-2')));
  assert.match(out.find(([id]) => id === 'A-1')[1], /could not be read \(mirror unreadable\)/);
  assert.equal(rec.read('ask', 'A-1').doc.state, 'answered');
  await step(T0 + 60_000);
  assert.equal(alerts.length, 1, alerts.join(' | '));
  assert.match(alerts[0], /your Undo tap \(ask A-1, PR 7\) is not acted on: it could not be read/);
  await step(T0 + 25 * 3_600_000);
  assert.equal(alerts.length, 2, 'again a day later');
});

test('r4 MAT-4: every tap that is not acted on is told, once per tap and reason, and again a day later', async () => {
  const cases = [
    [ask({ via: 'typed' }), R, /not a tap/],
    [ask(), rulesWith(), /not counted/],
    [ask({ pr: undefined }), R, /names no merged PR/],
    [ask({ pr: 8 }), R, /no merged attempt matches/],
  ];
  for (const [a, rules, why] of cases) {
    const rec = recWith([['merge', 'M-1', merged()], ['ask', 'A-1', a]]);
    const alerts = [];
    const step = (at) => undoStep({ rec, rules, now: at, filesOf: () => ['src/a.js'], alert: (t) => alerts.push(t) });
    await step(T0);
    await step(T0 + 60_000);
    assert.equal(alerts.length, 1, `${why}: ${alerts.join(' | ')}`);
    assert.match(alerts[0], why);
    await step(T0 + 25 * 3_600_000);
    assert.equal(alerts.length, 2, `${why}: again a day later`);
  }
  // The files read answering nothing is told too; the record refusing the card, once a day.
  {
    const w = world([['merge', 'M-1', merged()], ['ask', 'A-1', ask()]], { files: null });
    await w.step();
    assert.equal(w.calls.alerts.length, 1);
    assert.match(w.calls.alerts[0], /files could not be read/);
  }
  // Two taps held for the same reason are each told: the alert is per tap, not per reason.
  {
    const rec = recWith([['merge', 'M-1', merged()], ['ask', 'A-1', ask({ via: 'typed' })], ['ask', 'A-2', ask({ via: 'typed' })]]);
    const alerts = [];
    await undoStep({ rec, rules: R, now: T0, filesOf: () => ['src/a.js'], alert: (t) => alerts.push(t) });
    assert.equal(alerts.length, 2, alerts.join(' | '));
    assert.match(alerts.join('\n'), /ask A-1/);
    assert.match(alerts.join('\n'), /ask A-2/);
  }
});

// Audit 0b-6 r4 MAT-5: each part of the exact-reverse check (L40), planted alone.
test('r4 MAT-5: exactReverse refuses a card that differs from the merge in any one way', async () => {
  const { exactReverse } = await import('./undo.mjs');
  const rec = recWith([['merge', 'M-1', merged({ state: 'merged' })], ['merge', 'M-2', merged({ state: 'refused' })]]);
  const card = (over = {}) => ({ id: 'U-1', kind: 'undo', reverses: 'M-1', pr: 7, merge_commit_sha: SHA, files: ['src/a.js', 'src/b.js'], ...over });
  const files = () => ['src/b.js', 'src/a.js'];
  assert.deepEqual(exactReverse({ rec, card: card(), filesOf: files }), { ok: true }, 'control');
  const notMerge = /not the reverse of a merge in the record/;
  for (const [label, c, f, why] of [
    ['a merge that did not land', card({ reverses: 'M-2' }), files, notMerge],
    ['no merge of that id', card({ reverses: 'M-9' }), files, notMerge],
    ['no merge named', card({ reverses: undefined }), files, notMerge],
    ['another PR', card({ pr: 8 }), files, notMerge],
    ['another commit', card({ merge_commit_sha: OTHER }), files, notMerge],
    ['files unreadable', card(), () => null, /files could not be read/],
    ['files throw', card(), () => { throw new Error('x'); }, /files could not be read/],
    ['no files port', card(), undefined, /files could not be read/],
    ['card has no list', card({ files: undefined }), files, /files could not be read/],
    ['one file more', card({ files: ['src/a.js', 'src/b.js', 'src/c.js'] }), files, /does not match/],
    ['one file less', card({ files: ['src/a.js'] }), files, /does not match/],
    ['as many files, one other', card({ files: ['src/a.js', 'src/c.js'] }), files, /does not match/],
  ]) {
    const r = exactReverse({ rec, card: c, filesOf: f });
    assert.equal(r.ok, false, label);
    assert.match(r.reason, why, label);
  }
});
