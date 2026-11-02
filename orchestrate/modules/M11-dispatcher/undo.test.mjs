import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoStep as undoStep0, exactReverse, UNDO_CARD, FIX_CARD, REVERSE_FACT, UNDO_NOTE_FACT } from './undo.mjs';
import { rulesWith, recWith, T0, iso, withAlerts } from './fixtures.test-helper.mjs';
import { outbox, ALERT_QUEUE_FACT } from './alerts.mjs';

// Each step runs as the tick runs it: its alerts are queued, then sent once it is done (alerts.mjs, L47).
const undoStep = (a) => withAlerts(a.rec, a.now, a.alert ?? (() => {}), (alert) => undoStep0({ ...a, alert }));

// The Record's own shapes (L72, L74): the ask names the merged card (approvals' ask, answered by a tap), the card holds
// the merge commit the gate recorded, and the gate's merge names the card, its PR and the same commit.
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
// count_approval is M10's real engine (fixtures.test-helper.mjs, L81): the ask is the one M2 writes, with its product,
// tier and risky classes, and the tap counts only where M10 says a tap is enough.
const R = rulesWith();
const tapped = (over = {}) => ({ channel: 'tap', choice: 'Undo', approves: true, at: iso(T0), ...over });
const ask = (over = {}) => ({ state: 'answered', kind: 'undo', product: 'p', card: 'T-1', tier: 2, risky: [], choices: ['Undo', 'Keep'], answer: tapped(), ...over });
const target = (over = {}) => ['card', 'T-1', { state: 'merged', module: 'M-u', product: 'p', tier: 2, files: ['src/a.js', 'src/b.js'], merge_commit: SHA, ...over }];
const merge = (over = {}, id = 'MG-1') => ['merge', id, { state: 'audited_ok', card: 'T-1', pr: 7, merge_commit: SHA, product: 'p', ...over }];
const undoCard = (over = {}) => ({ state: 'ready', kind: 'exact_reverse', source: { ask: 'A-1' }, module: 'M-u', product: 'p', tier: 2, files: ['src/a.js', 'src/b.js'], what: 'undo PR 7', ...over });

function world(entries, { files = ['src/a.js', 'src/b.js'], rec: wrap } = {}) {
  const base = recWith(entries);
  const rec = wrap ? wrap(base) : base;
  const calls = { alerts: [], filesOf: [] };
  const step = (rules = R) => undoStep({ rec, rules, now: T0, filesOf: (s) => { calls.filesOf.push(s); return files; }, alert: (t) => calls.alerts.push(t) });
  return { rec, base, calls, step };
}
const tapWorld = (askOver, opts) => world([target(), merge(), ['ask', 'A-1', ask(askOver)]], opts);
// A record that refuses the undo card's create, as the real one may (the ask's evidence already used, a store error).
const refusesCard = (reason) => (rec) => ({ ...proxy(rec), write: (w) => (w.entity === 'card' && w.expectRev === 0 ? { ok: false, reason } : rec.write(w)) });
const proxy = (rec) => ({ read: (...a) => rec.read(...a), list: (...a) => rec.list(...a), meta: (...a) => rec.meta(...a), write: (w) => rec.write(w), diary: (...a) => rec.diary(...a) });

// L47: a crash between queueing and sending. The pass that queued the alert ends before its send; the next
// pass (the same record, a working port) delivers it once, and only then is the cause marked told.
test('L47: an alert queued by a pass that crashed before sending is delivered once by the next pass', async () => {
  const w = tapWorld({}, { rec: refusesCard('store busy') });
  await undoStep0({ rec: w.rec, rules: R, now: T0, filesOf: () => ['src/a.js'], alert: outbox(w.rec, T0) });
  const q = w.rec.read('fact', ALERT_QUEUE_FACT).doc.entries;
  assert.equal(q.length, 1);
  assert.match(q[0].text, /PR 7 could not be queued/);
  assert.ok(!w.rec.list('fact').some((f) => f.id !== ALERT_QUEUE_FACT && f.doc?.told_at), 'marked told before any send');
  await w.step();
  await w.step();
  assert.equal(w.calls.alerts.length, 1, w.calls.alerts.join(' | '));
  assert.match(w.calls.alerts[0], /PR 7 could not be queued/);
  assert.deepEqual(w.rec.read('fact', ALERT_QUEUE_FACT).doc.entries, []);
  assert.ok(w.rec.list('fact').some((f) => f.id !== ALERT_QUEUE_FACT && f.doc?.told_at), 'told once delivered');
});

test('M21 (L74): an answered, counted Undo tap on a merged card -> one exact_reverse card, ready (go-free); the ask is approvals\' to close', async () => {
  const w = tapWorld();
  assert.deepEqual((await w.step()), [['A-1', 'undo card written']]);
  const card = w.rec.read('card', UNDO_CARD('A-1')).doc;
  assert.deepEqual([card.kind, card.state, card.source, card.product, card.module], ['exact_reverse', 'ready', { ask: 'A-1' }, 'p', 'M-u']);
  assert.deepEqual(card.files, ['src/a.js', 'src/b.js']);
  assert.match(card.what, /undo PR 7 \(merge aaaaaaa of card T-1\)/);
  // The reversed commit comes from the source (M6 undoneBy), never from a field on the card.
  for (const f of ['pr', 'merge_commit_sha', 'reverses', 'queue', 'go_free']) assert.equal(card[f], undefined, f);
  assert.deepEqual(w.calls.filesOf, [SHA]);
  // M11 does not move the ask (answered → consumed is approvals'; M2 has no consume call yet, a (b) for the lead).
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  // asking again is harmless: the card is past draft
  assert.deepEqual((await w.step()), []);
  assert.equal(w.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 1);
});

test('an undo card the record refuses alerts Joe once and leaves the ask answered', async () => {
  const w = tapWorld({}, { rec: refusesCard('ask A-1 already has its exact_reverse card') });
  assert.match((await w.step())[0][1], /undo card not recorded: ask A-1 already has its exact_reverse card/);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /PR 7 could not be queued/);
  await w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
});

test('M21: every merged state counts; a merge that did not land does not', async () => {
  for (const state of ['merged', 'audited_ok', 'audit_flagged']) {
    const w = world([target(), merge({ state }), ['ask', 'A-1', ask()]]);
    assert.equal((await w.step())[0][1], 'undo card written', state);
  }
  for (const state of ['requested', 'checking', 'merging', 'refused']) {
    const w = world([target(), merge({ state }), ['ask', 'A-1', ask()]]);
    assert.equal((await w.step())[0][1], 'no merged attempt matches', state);
    assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  }
});

test('M21: not a tap, not counted, or naming no matching merge -> nothing written', async () => {
  const cases = [
    [[target(), merge(), ['ask', 'A-1', ask({ answer: tapped({ channel: 'typed' }) })]], R, /not a tap/],
    // A risky class needs Joe's GitHub Approve: the real engine does not count a tap for it.
    [[target(), merge(), ['ask', 'A-1', ask({ risky: ['schema'] })]], R, /not counted: this answer needs the owner's own Approve on GitHub/],
    [[target(), merge(), ['ask', 'A-1', ask()]], rulesWith({}, { count_approval: { decision: 'deny', reason: 'no' } }), /not counted/],
    [[target(), merge(), ['ask', 'A-1', ask()]], rulesWith({}, { count_approval: { decision: 'ask', tier: 1, reason: 'needs a second look' } }), /not counted/],
    [[target({ merge_commit: OTHER }), merge(), ['ask', 'A-1', ask()]], R, /no merged attempt matches/],
    [[target(), merge({ card: 'T-2' }), ['ask', 'A-1', ask()]], R, /no merged attempt matches/],
    [[target(), merge(), ['ask', 'A-1', ask({ card: 'T-9' })]], R, /no merge commit in the record/],
    [[target({ merge_commit: undefined }), merge(), ['ask', 'A-1', ask()]], R, /no merge commit in the record/],
  ];
  for (const [entries, rules, why] of cases) {
    const w = world(entries);
    const out = (await w.step(rules));
    assert.match(out[0][1], why);
    assert.equal(w.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 0);
    assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  }
});

test('M21: a tap that chose Keep, or did not approve, undoes nothing and is not held', async () => {
  for (const answer of [tapped({ choice: 'Keep' }), tapped({ approves: false })]) {
    const w = tapWorld({ answer });
    assert.deepEqual((await w.step()), []);
    assert.equal(w.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 0);
    assert.equal(w.calls.alerts.length, 0);
  }
});

test('M21: only answered undo asks are read', async () => {
  const w = world([target(), merge(), ['ask', 'A-1', ask({ state: 'open', answer: undefined })], ['ask', 'A-2', ask({ kind: 'delete_copy' })]]);
  assert.deepEqual((await w.step()), []);
});

test('M21 (L81): count_approval is asked what M10 reads, and only "ask" at the tap\'s tier counts', async () => {
  let seen;
  const w = tapWorld();
  await w.step(rulesWith({}, { count_approval: (s) => { seen = s; return { decision: 'ask', tier: 2, reason: 'a tap' }; } }));
  assert.deepEqual(seen, { product: 'p', card: 'T-1', ask_kind: 'undo', channel: 'tap', tier: 2, risky: [] });
  assert.equal(w.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 1);
  // An "allow" is not M10's answer for an approval, and a GitHub-tier answer does not count a tap.
  for (const verdict of [{ decision: 'allow', reason: 'ok' }, { decision: 'ask', tier: 1, reason: 'github' }]) {
    const w2 = tapWorld();
    assert.match((await w2.step(rulesWith({}, { count_approval: verdict })))[0][1], /not counted/);
    assert.equal(w2.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 0);
  }
  // The old shape, { ask: {...} }, is refused by the real engine (L81 plant).
  assert.equal(R.may('count_approval', { ask: { id: 'A-1', ...ask() } }).decision, 'deny');
});

test('M21: the reversed commit\'s files cannot be read -> no card, the ask stays answered for the next pass', async () => {
  const w = tapWorld({}, { files: null });
  assert.match((await w.step())[0][1], /could not be read/);
  assert.equal(w.rec.read('ask', 'A-1').doc.state, 'answered');
  assert.equal(w.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 0);
});

test('M21: a pass stopped after the card and before its move to ready finishes without a second card', async () => {
  const w = world([target(), merge(), ['ask', 'A-1', ask()], ['card', UNDO_CARD('A-1'), undoCard({ state: 'draft' })]]);
  assert.deepEqual((await w.step()), [['A-1', 'undo card written']]);
  assert.equal(w.calls.filesOf.length, 0);
  assert.equal(w.rec.read('card', UNDO_CARD('A-1')).doc.state, 'ready');
  assert.equal(w.rec.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 1);
});

const failedUndo = (over = {}) => ['card', UNDO_CARD('A-1'), undoCard({ state: 'failed', failure: { reason: 'the reverse is not clean', at: iso(T0) }, ...over })];
const reverseFact = (doc, id = REVERSE_FACT(UNDO_CARD('A-1'))) => ['fact', id, doc];

test('D8: M6 says not clean on a failed undo card -> a fix card as a draft for the Lead, and one alert', async () => {
  const U = UNDO_CARD('A-1');
  const w = world([target(), merge(), ['ask', 'A-1', ask()], failedUndo(), reverseFact({ state: 'not_clean', reason: 'a later change touched src/a.js' })]);
  assert.deepEqual((await w.step()), [[U, 'fix card written']]);
  const fix = w.rec.read('card', FIX_CARD(U)).doc;
  // audit MAT-4: the fix card waits on the Lead to plan it (a draft); it is never `ready` for a worker
  assert.deepEqual([fix.kind, fix.fix_of, fix.state, fix.module, fix.product], ['fix', U, 'draft', 'M-u', 'p']);
  assert.deepEqual(fix.files, ['src/a.js', 'src/b.js'], 'the plan is the root\'s');
  assert.match(fix.what, /a later change touched src\/a\.js/);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /could not be an exact reverse/);
  await w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
});

test('L130: a fix card whose alert was not queued is told on the next pass, once, and only then noted', async () => {
  const U = UNDO_CARD('A-1');
  const w = world([target(), merge(), ['ask', 'A-1', ask()], failedUndo(), reverseFact({ state: 'not_clean', reason: 'a later change touched src/a.js' })]);
  assert.deepEqual(await undoStep0({ rec: w.rec, rules: R, now: T0, filesOf: () => ['src/a.js', 'src/b.js'], alert: () => false }), [[U, 'fix card written']]);
  assert.ok(w.rec.read('card', FIX_CARD(U)));
  assert.equal(w.rec.read('fact', UNDO_NOTE_FACT(U)), null, 'no note while untold');
  await w.step();
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /could not be an exact reverse/);
  assert.ok(w.rec.read('fact', UNDO_NOTE_FACT(U)), 'noted once delivered');
  await w.step();
  assert.equal(w.calls.alerts.length, 1, 'once');
  assert.equal(w.rec.list('card').filter((c) => c.id === FIX_CARD(U)).length, 1, 'one fix card');
});

test('D8: not clean while the undo card has not failed -> no fix card yet; the Lead is told once a day', async () => {
  const U = UNDO_CARD('A-1');
  const rec = recWith([target(), merge(), ['ask', 'A-1', ask()], ['card', U, undoCard()], reverseFact({ state: 'not_clean', reason: 'x' })]);
  const alerts = [];
  const step = (at) => undoStep({ rec, rules: R, now: at, filesOf: () => [], alert: (t) => alerts.push(t) });
  await step(T0);
  await step(T0 + 60_000);
  assert.equal(rec.read('card', FIX_CARD(U)), null);
  assert.equal(alerts.length, 1, alerts.join(' | '));
  assert.match(alerts[0], /the Lead plans the fix once the undo card has failed/);
  await step(T0 + 25 * 3_600_000);
  assert.equal(alerts.length, 2, 'again a day later');
});

test('D8 / L74 addendum: a clean reverse, no word from M6, or a look-alike not_clean fact not written by the gate writes nothing', async () => {
  const U = UNDO_CARD('A-1');
  const base = [target(), merge(), ['ask', 'A-1', ask()], failedUndo()];
  for (const [label, extra] of [
    ['no word', []],
    ['clean', [reverseFact({ state: 'clean' })]],
    ['another card\'s', [reverseFact({ state: 'not_clean' }, REVERSE_FACT('C-2'))]],
  ]) {
    const w = world([...base, ...extra]);
    assert.deepEqual((await w.step()), [], label);
    assert.equal(w.calls.alerts.length, 0, label);
  }
  // The look-alike: a not_clean fact under the gate's id that another role wrote (a record that says so) is ignored.
  const w = world([...base, reverseFact({ state: 'not_clean', reason: 'x' })], { rec: (r) => ({ ...proxy(r), meta: (e, id) => (e === 'fact' && id === REVERSE_FACT(U) ? { ...r.meta(e, id), createdBy: 'sensors' } : r.meta(e, id)) }) });
  assert.deepEqual((await w.step()), [], 'a look-alike is not proof');
  assert.equal(w.rec.read('card', FIX_CARD(U)), null);
  // Control: the gate's own fact on the same record does write the fix card.
  const w2 = world([...base, reverseFact({ state: 'not_clean', reason: 'x' })]);
  assert.deepEqual((await w2.step()), [[U, 'fix card written']]);
});

// Audit 0b-6 r4 MAT-4: each tap on its own, and no tap left untold (L38).
test('r4 MAT-4: a tap whose files read throws holds no other tap, and is told once a day', async () => {
  const rec = recWith([target(), merge(), target({ merge_commit: OTHER }).map((x, i) => (i === 1 ? 'T-2' : x)), merge({ card: 'T-2', pr: 8, merge_commit: OTHER }, 'MG-2'),
    ['ask', 'A-1', ask()], ['ask', 'A-2', ask({ card: 'T-2' })]]);
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
  assert.match(alerts[0], /your Undo tap \(ask A-1, card T-1\) is not acted on: it could not be read/);
  await step(T0 + 25 * 3_600_000);
  assert.equal(alerts.length, 2, 'again a day later');
});

test('r4 MAT-4: every tap that is not acted on is told, once per tap and reason, and again a day later', async () => {
  const cases = [
    [[target(), merge(), ['ask', 'A-1', ask({ answer: tapped({ channel: 'typed' }) })]], R, /not a tap/],
    [[target(), merge(), ['ask', 'A-1', ask({ risky: ['schema'] })]], R, /not counted/],
    [[target(), merge(), ['ask', 'A-1', ask({ card: 'T-9' })]], R, /no merge commit in the record/],
    [[target(), merge({ card: 'T-2' }), ['ask', 'A-1', ask()]], R, /no merged attempt matches/],
  ];
  for (const [entries, rules, why] of cases) {
    const rec = recWith(entries);
    const alerts = [];
    const step = (at) => undoStep({ rec, rules, now: at, filesOf: () => ['src/a.js'], alert: (t) => alerts.push(t) });
    await step(T0);
    await step(T0 + 60_000);
    assert.equal(alerts.length, 1, `${why}: ${alerts.join(' | ')}`);
    assert.match(alerts[0], why);
    await step(T0 + 25 * 3_600_000);
    assert.equal(alerts.length, 2, `${why}: again a day later`);
  }
  // The files read answering nothing is told too.
  {
    const w = tapWorld({}, { files: null });
    await w.step();
    assert.equal(w.calls.alerts.length, 1);
    assert.match(w.calls.alerts[0], /files could not be read/);
  }
  // Two taps held for the same reason are each told: the alert is per tap, not per reason.
  {
    const typed = { answer: tapped({ channel: 'typed' }) };
    const rec = recWith([target(), merge(), ['ask', 'A-1', ask(typed)], ['ask', 'A-2', ask(typed)]]);
    const alerts = [];
    await undoStep({ rec, rules: R, now: T0, filesOf: () => ['src/a.js'], alert: (t) => alerts.push(t) });
    assert.equal(alerts.length, 2, alerts.join(' | '));
    assert.match(alerts.join('\n'), /ask A-1/);
    assert.match(alerts.join('\n'), /ask A-2/);
  }
});

// Audit 0b-6 r4 MAT-5: each part of the exact-reverse check (L40), planted alone.
test('r4 MAT-5: exactReverse refuses a card that differs from the merge in any one way', () => {
  const recOf = (entries = []) => recWith([target(), merge({ state: 'merged' }), ['ask', 'A-1', ask()], ...entries]);
  const rec = recOf();
  const card = (over = {}) => ({ id: 'U-1', ...undoCard(over) });
  const files = () => ['src/b.js', 'src/a.js'];
  assert.deepEqual(exactReverse({ rec, card: card(), filesOf: files }), { ok: true }, 'control');
  const notMerge = /not the reverse of a merge in the record/;
  const refusedMerge = recWith([target(), merge({ state: 'refused' }), ['ask', 'A-1', ask()]]);
  const otherCommit = recWith([target({ merge_commit: OTHER }), merge({ state: 'merged' }), ['ask', 'A-1', ask()]]);
  const otherAsk = recOf([['ask', 'A-2', ask({ kind: 'delete_copy' })]]);
  for (const [label, r, c, f, why] of [
    ['a merge that did not land', refusedMerge, card(), files, notMerge],
    ['the card\'s commit is not the merge\'s', otherCommit, card(), files, notMerge],
    ['no such ask', rec, card({ source: { ask: 'A-9' } }), files, notMerge],
    ['an ask that is not an undo', otherAsk, card({ source: { ask: 'A-2' } }), files, notMerge],
    ['no source', rec, card({ source: undefined }), files, notMerge],
    ['not an exact_reverse card', rec, card({ kind: 'ordinary' }), files, notMerge],
    ['files unreadable', rec, card(), () => null, /files could not be read/],
    ['files throw', rec, card(), () => { throw new Error('x'); }, /files could not be read/],
    ['no files port', rec, card(), undefined, /files could not be read/],
    ['card has no list', rec, card({ files: undefined }), files, /files could not be read/],
    ['one file more', rec, card({ files: ['src/a.js', 'src/b.js', 'src/c.js'] }), files, /does not match/],
    ['one file less', rec, card({ files: ['src/a.js'] }), files, /does not match/],
    ['as many files, one other', rec, card({ files: ['src/a.js', 'src/c.js'] }), files, /does not match/],
  ]) {
    const out = exactReverse({ rec: r, card: c, filesOf: f });
    assert.equal(out.ok, false, label);
    assert.match(out.reason, why, label);
  }
});
