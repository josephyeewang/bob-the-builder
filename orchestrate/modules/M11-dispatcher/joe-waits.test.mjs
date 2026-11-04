// joe-waits.test.mjs — L130: a card put on Joe is told until a copy is delivered, and only a delivered copy marks it.
// Real Record (M9 setup, real permissions), the real outbox and sendAlerts (through withAlerts).
import { test } from 'node:test';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import assert from 'node:assert/strict';
import { waitOnJoe, retellWaits, WAIT_TELL_FACT } from './joe-waits.mjs';
import { withAlerts } from './fixtures.test-helper.mjs';
import { waitOn } from './moves.mjs';
import { setup, product, readyCard, runCard } from '../M9-record/fixtures.test-helper.mjs';

const MIN = 60_000;
const ask = { what: 'dead_session: probe', link: 'card C-1', kind: 'dead_ask' };

function world() {
  const E = setup({ prefix: 'm11-joewaits-', probe: { kill() {}, pidStart: () => 'start' }, host: 'mac-a' });
  product(E);
  readyCard(E, 'C-1');
  runCard(E, 'C-1');
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  const pass = () => withAlerts(E.record, E.clock.t, port, (alert) => retellWaits({ rec: E.record, alert }));
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

test('L130: a tell recorded for an older wait is not re-told under a newer one', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'first', alert: () => false, now: w.E.clock.t, ...ask }).ok, true);
  // A later re-wait written straight (not through waitOnJoe): its `since` is not the one the tell recorded.
  w.E.clock.t += MIN;
  const again = waitOn(w.E.record, 'C-1', { who: 'joe', what: 'dead_session: probe again', now: w.E.clock.t, link: 'card C-1' });
  assert.equal(again.ok, true, again.reason);
  assert.notEqual(w.card().wait.since, w.tell().since);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
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
    const passAt = () => withAlerts(w.E.record, tickNow(), port, (alert) => retellWaits({ rec: w.E.record, alert }));
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

test('L405 m1: a card on the owner, never told, whose copy is refused on every pass is told once, with the refusal in the text', async () => {
  const w = world();
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  // The first alert never queued (a crash between the wait and its tell).
  assert.equal(waitOnJoe(rec, 'C-1', { text: 'needs you', alert: fakeAlert({ answer: false }), now: w.E.clock.t, ...ask }).ok, true);
  assert.deepEqual(w.got, []);
  let did = [];
  for (let i = 0; i < 300; i++) {
    w.E.clock.t += 10 * MIN;
    did = did.concat(await withAlerts(rec, w.E.clock.t, w.port, (alert) => retellWaits({ rec, alert })));
  }
  assert.equal(w.got.length, 1, JSON.stringify(w.got));
  assert.match(w.got[0], /^needs you \(this card's tell could not be kept with its wait \(busy\)/);
  assert.match(did[0][1], /^told again: waits on joe; this card's tell could not be kept/);
  assert.equal(w.tell().told_since, w.card().wait.since, 'marked by the since it matched');
  assert.equal(w.tell().wait_since, undefined);
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
    assert.deepEqual(await withAlerts(s.rec, t, port, (alert) => retellWaits({ rec: s.rec, alert })), [], `${s.name}: and not again`);
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
