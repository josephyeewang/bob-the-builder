// joe-waits.test.mjs — L130: a card put on Joe is told until a copy is delivered, and only a delivered copy marks it.
// Real Record (M9 setup, real permissions), the real outbox and sendAlerts (through withAlerts).
import { test } from 'node:test';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import assert from 'node:assert/strict';
import { waitOnJoe, retellWaits, WAIT_TELL_FACT, untoldWaitText } from './joe-waits.mjs';
import { withAlerts } from './fixtures.test-helper.mjs';
import { outbox, isQueued, ALERT_QUEUE_FACT } from './alerts.mjs';
import { waitOn } from './moves.mjs';
import { setup, product, readyCard, runCard, leadCard, seed, plan, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';

const MIN = 60_000;
const ask = { what: 'dead_session: probe', link: 'card C-1', kind: 'dead_ask' };

function world() {
  const E = setup({ prefix: 'm11-joewaits-', probe: { kill() {}, pidStart: () => 'start' }, host: 'mac-a' });
  product(E);
  readyCard(E, 'C-1');
  runCard(E, 'C-1');
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  const pass = () => withAlerts(E.record, E.clock.t, port, (alert) => retellWaits({ rec: E.record, alert, now: E.clock.t }));
  return { E, got, port, pass, card: () => E.record.read('card', 'C-1').doc, tell: () => E.record.read('fact', WAIT_TELL_FACT('C-1'))?.doc };
}

test('L130: an alert answering false leaves the card on Joe untold; the next pass tells it once and marks it', async () => {
  const w = world();
  const r = waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert: () => false, now: w.E.clock.t, ...ask });
  assert.equal(r.ok, true);
  assert.equal(w.card().wait.who, 'joe');
  assert.equal(w.tell().told_since, undefined, 'no told mark on a false answer');
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [['C-1', 'told again: waits on joe']]);
  assert.deepEqual(w.got, ['card C-1 needs you']);
  assert.equal(w.tell().told_since, w.card().wait.since, 'marked told for this wait once delivered');
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
  assert.equal(w.got.length, 1, 'told once');
});

test('L130: a queued tell is not queued twice, and a delivered one is not re-told', async () => {
  const w = world();
  const r = await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'told at once', alert, now: w.E.clock.t, ...ask }));
  assert.equal(r.ok, true);
  assert.deepEqual(w.got, ['told at once']);
  for (let i = 0; i < 3; i++) { w.E.clock.t += MIN; assert.deepEqual(await w.pass(), []); }
  assert.equal(w.got.length, 1);
});

test('L130: a tell that cannot be recorded moves nothing (the step sees the card again next pass)', () => {
  const w = world();
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') ? { ok: false, reason: 'busy' } : real.write(x)) } });
  let asked = 0;
  const r = waitOnJoe(rec, 'C-1', { text: 't', alert: () => { asked += 1; return true; }, now: w.E.clock.t, ...ask });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the tell could not be recorded: busy/);
  assert.equal(w.card().state, 'running', 'the card did not move');
  assert.equal(asked, 0, 'nothing was said about a wait that does not exist');
});

test('L130, L316: a tell recorded for an older wait is not re-told under a newer one; the newer one is told on its own words', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'first', alert: () => false, now: w.E.clock.t, ...ask }).ok, true);
  // A later re-wait written straight (not through waitOnJoe): its `since` is not the one the tell recorded.
  w.E.clock.t += MIN;
  const again = waitOn(w.E.record, 'C-1', { who: 'joe', what: 'dead_session: probe again', now: w.E.clock.t, link: 'card C-1' });
  assert.equal(again.ok, true, again.reason);
  assert.notEqual(w.card().wait.since, w.tell().since);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [['C-1', 'told again: waits on joe']]);
  assert.deepEqual(w.got, [untoldWaitText('C-1', w.card().wait)], 'not "first": the older wait\'s words');
  assert.match(w.got[0], /^card C-1 waits on you \(dead_session: probe again\)/);
});

const D = 24 * 60 * MIN;

test('L315: a card on Joe is told at once, quiet within the day, then again every day while it waits (was: once, ever)', async () => {
  const w = world();
  await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert, now: w.E.clock.t, ...ask }));
  assert.equal(w.got.length, 1);
  w.E.clock.t += 2 * 60 * MIN;
  await w.pass();
  assert.equal(w.got.length, 1, 'quiet at +2 h');
  for (let d = 1; d <= 30; d++) { w.E.clock.t += D; await w.pass(); }
  assert.equal(w.got.length, 31, 'once a day for thirty days');
  assert.ok(w.got.every((t) => t === 'card C-1 needs you'));
});

test('L315: when the wait ends the mark is cleared and a queued copy dropped; a new wait on Joe is told at once', async () => {
  const w = world();
  await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert, now: w.E.clock.t, ...ask }));
  // It ends: the card leaves Joe (back to its owner's queue is not this file's business; any other wait will do).
  w.E.clock.t += MIN;
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'dependency', what: 'card C-9', now: w.E.clock.t }).ok, true);
  await w.pass();
  assert.equal(w.tell().told_at, null, 'cleared');
  for (let i = 0; i < 3; i++) { w.E.clock.t += D; await w.pass(); }
  assert.equal(w.got.length, 1, 'nothing told while it waits on someone else');
  // Back on Joe within the day of the last tell: told at once, not held by the old mark.
  w.E.clock.t += MIN;
  await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you again', alert, now: w.E.clock.t, ...ask }));
  assert.deepEqual(w.got, ['card C-1 needs you', 'card C-1 needs you again']);
});

test('L316: the round cap, as M9 writer.mjs writes it (a joe wait with no tell), is told: the card, what, why and what Joe can do', async () => {
  // The real writer: caps.rounds 1, so the first fix card is round 2 and is created waiting on the owner.
  const E = setup({ prefix: 'm11-joewaits-cap-', values: { 'caps.rounds': 1 } });
  product(E);
  leadCard(E, 'C-1');
  seed(E, 'card', 'C-1', { ...E.record.read('card', 'C-1').doc, state: 'failed' });
  const fix = E.record.write({ actor: 'dispatcher', entity: 'card', id: 'F-1', expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'fix', fix_of: 'C-1', ...plan() } });
  assert.equal(fix.ok, true, fix.reason);
  const f = E.record.read('card', 'F-1').doc;
  assert.equal(f.state, 'waiting');
  assert.equal(f.wait.what, 'round cap');
  assert.equal(E.record.read('fact', WAIT_TELL_FACT('F-1')), null, 'the writer wrote no tell');
  const got = [];
  const pass = () => withAlerts(E.record, E.clock.t, (t) => { got.push(typeof t === 'string' ? t : t.text); return true; }, (alert) => retellWaits({ rec: E.record, alert, now: E.clock.t }));
  E.clock.t += MIN;
  await pass();
  assert.deepEqual(got, [`card F-1 waits on you (round cap): ${f.wait.reason}. Answer it through the Front Door`]);
  assert.match(got[0], /the owner cancels it, or the Lead makes a new card/, 'what Joe can do');
  E.clock.t += 60 * MIN;
  await pass();
  assert.equal(got.length, 1, 'quiet within the day');
  E.clock.t += D;
  await pass();
  assert.equal(got.length, 2, 'again a day later');
});

test('L316: a joe wait with no reason is told with the general answer', () => {
  assert.equal(untoldWaitText('C-7', { who: 'joe', what: 'dead_session: probe' }),
    'card C-7 waits on you (dead_session: probe); no reason was recorded. Answer it through the Front Door: say how it goes on, or cancel the card');
});

test('L316: a card parked because its product is paused is not told card by card (it resumes by itself)', async () => {
  const w = world();
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'joe', what: 'paused', now: w.E.clock.t }).ok, true);
  for (let i = 0; i < 3; i++) { w.E.clock.t += D; await w.pass(); }
  assert.deepEqual(w.got, []);
});

// L138 MAT-1: the Record stamps a wait with its own clock. The tick's `now` runs behind it here, so the wait's stored
// since is not the since the tick asked for; the tell is matched on the stored one.
for (const skew of [5, 1500]) {
  test(`L138 MAT-1: the Record's clock ${skew} ms ahead of the tick; a refused first tell is told on a later pass, exactly once`, async () => {
    const w = world();
    let answer = false;
    const port = (t) => { w.got.push(typeof t === 'string' ? t : t.text); return answer; };
    const tickNow = () => w.E.clock.t - skew;
    const r = await withAlerts(w.E.record, tickNow(), port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert, now: tickNow(), ...ask }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(w.card().wait.since, new Date(w.E.clock.t).toISOString(), 'the Record stamped its own time');
    assert.notEqual(w.card().wait.since, w.tell().since, 'not the time the tick asked at');
    assert.equal(w.tell().wait_since, w.card().wait.since, 'the stored since is copied onto the tell');
    assert.deepEqual(w.got, ['card C-1 needs you'], 'sent once and refused');
    assert.equal(w.tell().told_since, undefined, 'a refused send marks nothing');
    answer = true;
    const passAt = () => withAlerts(w.E.record, tickNow(), port, (alert) => retellWaits({ rec: w.E.record, alert, now: tickNow() }));
    w.E.clock.t += MIN;
    await passAt();
    assert.deepEqual(w.got, ['card C-1 needs you', 'card C-1 needs you'], 'told again on the next pass');
    assert.equal(w.tell().told_since, w.card().wait.since, 'marked told for the stored wait');
    for (let i = 0; i < 3; i++) { w.E.clock.t += MIN; assert.deepEqual(await passAt(), []); }
    assert.equal(w.got.length, 2, 'told exactly once once delivered (P20)');
  });
}

test('L138 MAT-1, L338: a refused copy of the since is still told at once, the refusal in the text and the answer', async () => {
  const w = world();
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  const r = await withAlerts(rec, w.E.clock.t - 1500, w.port, (alert) => waitOnJoe(rec, 'C-1', { text: 'needs you', alert, now: w.E.clock.t - 1500, ...ask }));
  assert.equal(r.ok, true, r.reason);
  assert.match(r.tell_refused ?? '', /could not be kept with its wait \(busy\)/);
  assert.equal(w.card().state, 'waiting');
  assert.equal(w.tell().wait_since, undefined, 'the copy was refused');
  assert.equal(w.got.length, 1);
  assert.match(w.got[0], /^needs you \(.*could not be kept with its wait \(busy\)/);
  assert.equal(w.tell().told_since, w.card().wait.since, 'marked told for the wait it was for');
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [], 'not told again');
  assert.equal(w.got.length, 1);
});

test('L138 MAT-1: a copy refused and an alert not delivered stays queued, is delivered on a later pass, and marked once', async () => {
  const w = world();
  const real = w.E.record;
  let refuse = true;
  const rec = Object.create(real, { write: { value: (x) => (refuse && x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  const down = fakeAlert({ answer: false });
  assert.equal((await withAlerts(rec, w.E.clock.t - 1500, down, (alert) => waitOnJoe(rec, 'C-1', { text: 'needs you', alert, now: w.E.clock.t - 1500, ...ask }))).ok, true);
  assert.equal(w.tell().told_since, undefined, 'not delivered, so not marked');
  refuse = false;
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [], 'the queued copy is sent, not a second one');
  assert.equal(w.tell().told_since, w.card().wait.since, 'marked once delivered');
  assert.equal(w.got.length, 1);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
  assert.equal(w.got.length, 1);
});

test('L315: a copy still queued is not queued again a day later, and is dropped when the wait ends', () => {
  const w = world();
  const fact = WAIT_TELL_FACT('C-1');
  const queued = () => (w.E.record.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => e.mark?.fact === fact).length;
  // Queued, never sent (no outbox sender runs here).
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t, ...ask }).ok, true);
  assert.equal(queued(), 1);
  for (let d = 1; d <= 2; d++) { w.E.clock.t += D; retellWaits({ rec: w.E.record, alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t }); }
  assert.equal(queued(), 1, 'one copy, not one per day');
  w.E.clock.t += MIN;
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'dependency', what: 'card C-9', now: w.E.clock.t }).ok, true);
  retellWaits({ rec: w.E.record, alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t });
  assert.equal(isQueued(w.E.record, fact), false, 'the wait ended: the unsent copy leaves the queue');
});

// L329 (joe-waits:41): the window match reads both times; a tell whose since can't be read, or lies an hour ahead,
// matches no wait. The fallback (adoptUntold) writes it afresh for the card's own wait, so the card is told at the next
// pass and daily after, never silent.
test('L329: a tell whose since is unreadable or an hour ahead is told at the next pass, then daily', async () => {
  for (const [label, bad] of [['unreadable', () => 'garbage'], ['an hour ahead', (t) => new Date(t + 60 * MIN).toISOString()]]) {
    const w = world();
    const r = await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'told at once', alert, now: w.E.clock.t, ...ask }));
    assert.equal(r.ok, true);
    assert.equal(w.got.length, 1);
    const f = w.E.record.read('fact', WAIT_TELL_FACT('C-1'));
    const put = w.E.record.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT('C-1'), expectRev: f.rev, doc: { since: bad(w.E.clock.t), text: f.doc.text }, kind: 'wait_tell' });
    assert.equal(put.ok, true, put.reason);
    w.E.clock.t += MIN;
    await w.pass();
    assert.equal(w.got.length, 2, `${label}: told at the next pass`);
    assert.equal(w.tell().told_since, w.card().wait.since, `${label}: marked for the card's own wait`);
    w.E.clock.t += MIN;
    await w.pass();
    assert.equal(w.got.length, 2, `${label}: then quiet`);
    w.E.clock.t += 24 * 60 * MIN;
    await w.pass();
    assert.equal(w.got.length, 3, `${label}: told again a day on`);
  }
});

// L355 m1 (L323): a joe wait written with no tell gets one from adoptUntold; when the Record refuses that write, the card
// would never be told. The step throws after telling the rest, so the tick's step error tells the owner, daily.
test('L355 m1: a reminder the Record refuses to record for a card on the owner is thrown, after the other cards are told', async () => {
  const w = world();
  readyCard(w.E, 'C-2');
  runCard(w.E, 'C-2');
  assert.equal((await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-2', { text: 'card C-2 needs you', alert, now: w.E.clock.t, ...ask }))).ok, true);
  w.E.clock.t += MIN;
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'joe', what: 'round cap', now: w.E.clock.t }).ok, true);
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') ? { ok: false, reason: 'busy' } : real.write(x)) } });
  w.E.clock.t += 24 * 60 * MIN;
  await assert.rejects(
    withAlerts(real, w.E.clock.t, w.port, (alert) => retellWaits({ rec, alert, now: w.E.clock.t })),
    /cards wait on you whose reminder could not be kept right: card C-1 waits on you \(round cap\).*\(its reminder could not be recorded: busy\)$/,
  );
  // The tick sends the queue in its own step; here the throw stops withAlerts before sending, so the copy is still queued.
  assert.equal(isQueued(real, WAIT_TELL_FACT('C-2')), true, 'the other card was still told again, a day on');
});

// L355 m3 (plant P4): a mark counts only for the wait it names. A mark left by an older wait, told just now, does not
// hold a new wait's tell for a day.
test('L355 m3: a told mark naming an older wait does not count for the new one: the new wait is told at the next pass', async () => {
  const w = world();
  assert.equal((await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'wait one', alert, now: w.E.clock.t, ...ask }))).ok, true);
  const old = w.tell().told_since;
  w.E.clock.t += MIN;
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'wait two', alert: () => false, now: w.E.clock.t, ...ask, what: 'another question' }).ok, true);
  const f = w.E.record.read('fact', WAIT_TELL_FACT('C-1'));
  const at = new Date(w.E.clock.t).toISOString();
  assert.equal(w.E.record.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT('C-1'), expectRev: f.rev, doc: { ...f.doc, told_since: old, told_at: at }, kind: 'wait_told' }).ok, true);
  assert.notEqual(w.card().wait.since, old, 'a second wait on the owner');
  w.E.clock.t += MIN;
  await w.pass();
  assert.deepEqual(w.got, ['wait one', 'wait two'], 'the new wait is told at once, not held by the old mark');
  assert.equal(w.tell().told_since, w.card().wait.since);
});

// L355 m4: owner -> owner between ticks. The first wait's copy, still queued, is about a wait that has ended: it is
// dropped, never delivered, and the second wait is told.
test('L355 m4: a copy still queued for a wait on the owner that ended in a second one is dropped; the second is told', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'W1 text', alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t, ...ask }).ok, true);
  assert.equal(isQueued(w.E.record, WAIT_TELL_FACT('C-1')), true, 'the first copy waits in the queue');
  w.E.clock.t += MIN;
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'W2 text', alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t, ...ask }).ok, true);
  w.E.clock.t += MIN;
  await w.pass();
  assert.deepEqual(w.got, ['W2 text'], 'only the live wait is told');
  assert.equal(w.tell().told_since, w.card().wait.since);
});

test('L355 m4: owner -> owner by a writer that tells nothing: the old copy is dropped, and the new wait is told by its own text', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'W1 text', alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t, ...ask }).ok, true);
  w.E.clock.t += 5 * MIN;
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'joe', what: 'round cap', now: w.E.clock.t }).ok, true);
  w.E.clock.t += MIN;
  await w.pass();
  assert.deepEqual(w.got, [untoldWaitText('C-1', w.card().wait)], 'only the live wait is told');
});

test('L359: a drop of the old wait\'s queued copy that the Record refuses is told (adoptUntold) or in the answer (waitOnJoe)', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'W1 text', alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t, ...ask }).ok, true);
  const real = w.E.record;
  const noDrop = Object.create(real, { write: { value: (x) => (x.kind === 'alert_cause_cleared' ? { ok: false, reason: 'busy' } : real.write(x)) } });
  w.E.clock.t += 5 * MIN;
  // waitOnJoe: the wait moves, and the refused drop is in its answer.
  const r = waitOnJoe(noDrop, 'C-1', { text: 'W2 text', alert: () => false, now: w.E.clock.t, ...ask });
  assert.equal(r.ok, true);
  assert.match(r.old_copy_kept, /could not be dropped/);
  // adoptUntold: owner -> owner by a writer that tells nothing; the refused drop is thrown, so the tick tells it.
  w.E.clock.t += 5 * MIN;
  assert.equal(waitOn(real, 'C-1', { who: 'joe', what: 'round cap', now: w.E.clock.t }).ok, true);
  w.E.clock.t += MIN;
  await assert.rejects(
    withAlerts(real, w.E.clock.t, w.port, (alert) => retellWaits({ rec: noDrop, alert, now: w.E.clock.t })),
    /card C-1 waits on you \(round cap\).*\(a reminder still queued for its last wait could not be dropped\)/,
  );
});

test('L405 m1, L315: a card on the owner, never told, whose copy is refused on every pass is told once a day, with the refusal in the text', async () => {
  const w = world();
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  // The first alert never queued (a crash between the wait and its tell).
  assert.equal(waitOnJoe(rec, 'C-1', { text: 'needs you', alert: fakeAlert({ answer: false }), now: w.E.clock.t, ...ask }).ok, true);
  assert.deepEqual(w.got, []);
  let did = [];
  for (let i = 0; i < 300; i++) {
    w.E.clock.t += 10 * MIN;
    did = did.concat(await withAlerts(rec, w.E.clock.t, w.port, (alert) => retellWaits({ rec, alert, now: w.E.clock.t })));
  }
  assert.equal(w.got.length, 3, `a tell on the first pass, then one a day over 50 hours: ${JSON.stringify(w.got)}`);
  assert.match(w.got[0], /^needs you \(this card's tell could not be kept with its wait \(busy\)/);
  assert.match(did[0][1], /^told again: waits on joe; this card's tell could not be kept/);
  assert.equal(w.tell().told_since, w.card().wait.since, 'marked by the since it matched');
  assert.equal(w.tell().wait_since, undefined);
});

// Joe-waits audit m4: the daily repeat of a refused copy ends with its wait, the mark goes, and nothing more is sent.
test('L405 m1, L315: a refused-copy card stops being told once its wait ends: nothing over the next 3 days, its mark cleared', async () => {
  const w = world();
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  assert.equal(waitOnJoe(rec, 'C-1', { text: 'needs you', alert: fakeAlert({ answer: false }), now: w.E.clock.t, ...ask }).ok, true);
  w.E.clock.t += 10 * MIN;
  await withAlerts(rec, w.E.clock.t, w.port, (alert) => retellWaits({ rec, alert, now: w.E.clock.t }));
  assert.equal(w.got.length, 1, 'told while it waits');
  assert.ok(w.tell().told_at, 'marked');
  w.E.clock.t += MIN;
  assert.equal(waitOn(real, 'C-1', { who: 'dependency', what: 'card C-9', now: w.E.clock.t }).ok, true);
  for (let i = 0; i < 3 * 24; i++) {
    w.E.clock.t += 60 * MIN;
    await withAlerts(rec, w.E.clock.t, w.port, (alert) => retellWaits({ rec, alert, now: w.E.clock.t }));
  }
  assert.equal(w.got.length, 1, JSON.stringify(w.got));
  assert.equal(w.tell().told_at, null, 'the mark is cleared');
});

// Audit #153 m1: the Record keeps a re-checked wait's since (L296), so a tell asked at now would match no wait.
test('audit #153 m1: a card put on Joe again for the same what is told the new text, on the real writer and the stand-in', async () => {
  const { recWith, seed, setClock, T0 } = await import('./fixtures.test-helper.mjs');
  const real = world();
  const stand = recWith();
  seed(stand, 'card', 'C-1', { state: 'running', product: 'p1', tier: 2, files: ['src/C-1.js'] });
  // Each side: its Record, and a way to set its clock (the stand-in's is setClock; the real one's is E.clock).
  const sides = [
    { name: 'real', rec: real.E.record, start: real.E.clock.t, set: (ms) => { real.E.clock.t = ms; } },
    { name: 'stand-in', rec: stand, start: T0, set: (ms) => setClock(stand, ms) },
  ];
  for (const s of sides) {
    let t = s.start;
    const at = (ms) => { t = ms; s.set(ms); };
    const port = fakeAlert();
    const got = port.texts;
    const putOnJoe = (text) => withAlerts(s.rec, t, port, (alert) => waitOnJoe(s.rec, 'C-1', { text, alert, now: t, ...ask }));
    assert.equal((await putOnJoe('first tell')).ok, true, s.name);
    const first = s.rec.read('card', 'C-1').doc.wait.since;
    at(t + 2 * 60 * MIN);
    const r = await putOnJoe('second tell');
    assert.equal(r.ok, true, `${s.name}: ${r.reason}`);
    assert.equal(s.rec.read('card', 'C-1').doc.wait.since, first, `${s.name}: the wait keeps its since`);
    assert.deepEqual(got, ['first tell', 'second tell'], `${s.name}: the second tell is sent`);
    assert.equal(s.rec.read('fact', WAIT_TELL_FACT('C-1')).doc.told_since, first, `${s.name}: marked told for the kept since`);
    at(t + MIN);
    assert.deepEqual(await withAlerts(s.rec, t, port, (alert) => retellWaits({ rec: s.rec, alert, now: t })), [], `${s.name}: and not again`);
    assert.equal(got.length, 2, s.name);
  }
});

test('audit #153 m1, L338: a re-wait whose since could not be copied onto the tell is still told, with the refusal', async () => {
  const w = world();
  const real = w.E.record;
  assert.equal((await withAlerts(real, w.E.clock.t, w.port, (alert) => waitOnJoe(real, 'C-1', { text: 'first tell', alert, now: w.E.clock.t, ...ask }))).ok, true);
  w.E.clock.t += 2 * 60 * MIN;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  const r = await withAlerts(rec, w.E.clock.t, w.port, (alert) => waitOnJoe(rec, 'C-1', { text: 'second tell', alert, now: w.E.clock.t, ...ask }));
  assert.equal(r.ok, true);
  assert.ok(r.tell_refused);
  assert.equal(w.got.length, 2);
  assert.match(w.got[1], /^second tell \(/);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
  assert.equal(w.got.length, 2);
});

test('L338: across the 60 s edge, a refused copy of the since is still told, and the refusal is in the answer', async () => {
  const { seed } = await import('../M9-record/fixtures.test-helper.mjs');
  const w = world();
  const real = w.E.record;
  assert.equal((await withAlerts(real, w.E.clock.t, w.port, (alert) => waitOnJoe(real, 'C-1', { text: 'first tell', alert, now: w.E.clock.t, ...ask }))).ok, true);
  w.E.clock.t += 2 * 60 * MIN;
  const c = w.card();
  seed(w.E, 'card', 'C-1', { ...c, wait: { ...c.wait, since: new Date(w.E.clock.t + 59e3).toISOString() } });
  // The copy is refused by a stale expectRev: the tell moved between the read and the write.
  const rec = Object.create(real, { write: { value: (x) => real.write(x.doc?.wait_since ? { ...x, expectRev: x.expectRev - 1 } : x) } });
  const now = w.E.clock.t - 50e3;
  const r = await withAlerts(rec, now, w.port, (alert) => waitOnJoe(rec, 'C-1', { text: 'second tell', alert, now, ...ask }));
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.tell_refused, 'the refusal is in the answer');
  assert.equal(w.got.length, 2, 'the second tell is sent');
  assert.equal(w.tell().told_since, w.card().wait.since);
});

test('audit #153 r2 m1-r: a re-wait across the 60 s edge (stored since 59 s ahead, the tick 50 s behind) is still told', async () => {
  const { seed } = await import('../M9-record/fixtures.test-helper.mjs');
  for (const [ahead, behind] of [[59e3, 50e3], [59e3, 0], [-60 * MIN, 50e3]]) {
    const w = world();
    const rec = w.E.record;
    assert.equal((await withAlerts(rec, w.E.clock.t, w.port, (alert) => waitOnJoe(rec, 'C-1', { text: 'first tell', alert, now: w.E.clock.t, ...ask }))).ok, true);
    w.E.clock.t += 2 * 60 * MIN;
    const c = w.card();
    seed(w.E, 'card', 'C-1', { ...c, wait: { ...c.wait, since: new Date(w.E.clock.t + ahead).toISOString() } });
    const now = w.E.clock.t - behind;
    const r = await withAlerts(rec, now, w.port, (alert) => waitOnJoe(rec, 'C-1', { text: 'second tell', alert, now, ...ask }));
    assert.equal(r.ok, true, r.reason);
    w.E.clock.t += MIN;
    await w.pass();
    assert.deepEqual(w.got, ['first tell', 'second tell'], `ahead ${ahead / 1000} s, behind ${behind / 1000} s`);
    assert.equal(w.tell().wait_since, w.card().wait.since, 'the stored since is on the tell');
  }
});
