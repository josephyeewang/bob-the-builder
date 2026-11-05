// proposal-route.test.mjs — R-0b-128 part 2 (L549): a proposal's way to review. The card is taken at the revision the
// intake checked, then pushed and handed in from wherever it is. Real M9 Record, real alerts outbox, a fake push door
// that writes the head as the real one does. Plants on the test repo stay with R-0b-162.
// Run: node --test orchestrate/modules/M11-dispatcher/proposal-route.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToReview, proposalRoutePass, routeRefused, ROUTE_FACT, ROUTE_RUN, ROUTE_TELL_MS } from './proposal-route.mjs';
import { outbox, sendAlerts, isQueued } from './alerts.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { setup, must, put, readyCard } from '../M9-record/fixtures.test-helper.mjs';
import { PRODUCT } from '../M9-record/fixtures.test-helper.mjs';
import { STILL_WAITING_MS } from '../../shared/still-waiting.mjs';

const CARD = 'C-1';
const SHA = 'a'.repeat(64);
const TIP = 'b'.repeat(40);
const RUN = ROUTE_RUN(CARD, SHA);
const HOST = 'mac-a';

function world({ values } = {}) {
  const t = setup({ prefix: 'm11-route-', values, host: HOST });
  must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'active' } }), 'product');
  readyCard(t, CARD);
  const port = fakeAlert();
  // The Record is frozen, so a plant sits in front of it: `v.plant(w)` answers for a write, or lets it through.
  const rec = { ...Object.fromEntries(['list', 'read', 'meta', 'diary', 'lapseClaims'].map((k) => [k, (...a) => t.record[k](...a)])),
    write: (w) => v.plant?.(w) ?? t.record.write(w),
    release: (x) => v.plant?.({ kind: 'release', ...x }) ?? t.record.release(x) };
  const v = {
    t, rec, port, pushes: 0, plant: null,
    now: () => t.clock.t,
    card: () => rec.read('card', CARD),
    state: () => rec.read('card', CARD).doc.state,
    route: () => rec.read('fact', ROUTE_FACT(CARD))?.doc,
    answer: { ok: true, tip: TIP },
    writeHead: true,
  };
  // As the real door: the head first, written by the Workshop.
  v.push = async ({ card }) => {
    v.pushes += 1;
    const a = typeof v.answer === 'function' ? v.answer() : v.answer;
    if (a.ok && v.writeHead) {
      const c = rec.read('card', card);
      if (c.doc.head !== a.tip) must(rec.write({ actor: 'workshop', entity: 'card', id: card, expectRev: c.rev, doc: { ...c.doc, head: a.tip }, kind: 'push_head' }), 'head');
    }
    return a;
  };
  v.take = (over = {}) => createToReview({ host: HOST, now: v.now })({ rec, product: PRODUCT, card: CARD, cardRev: v.card().rev, bundle: { sha256: SHA }, ...over });
  v.pass = async (over = {}) => {
    const alert = outbox(rec, v.now());
    const out = await proposalRoutePass({ rec, pushProposal: v.push, alert, now: v.now(), host: HOST, ...over });
    await sendAlerts(rec, port, v.now());
    return out;
  };
  v.clock = (ms) => { t.clock.t += ms; };
  return v;
}

test('toReview takes the card at the revision checked, with a claim of its own; nothing else moves', async () => {
  const v = world();
  assert.deepEqual(await v.take(), { ok: true });
  const c = v.card().doc;
  assert.equal(c.state, 'claimed');
  assert.deepEqual([c.claim.kind, c.claim.claim_id, c.claim.host], ['tab', RUN, HOST]);
  assert.equal(c.head, undefined, 'no push yet');
  assert.deepEqual([v.route().product, v.route().card, v.route().sha256, v.route().run], [PRODUCT, CARD, SHA, RUN]);
  assert.equal(v.pushes, 0);
});

test('L549: a card changed since the check is refused, and is not taken', async () => {
  const v = world();
  const old = v.card().rev;
  must(put(v.t.record, 'workshop', 'card', CARD, { head: TIP }), 'change');
  const r = await v.take({ cardRev: old });
  assert.equal(r.ok, false);
  assert.match(r.reason, /changed since it was checked/);
  assert.equal(v.state(), 'ready');
  assert.equal(v.route(), undefined, 'no route on a card this proposal never took');
});

test('no checked bundle, no card taken', async () => {
  const v = world();
  for (const bundle of [undefined, null, {}, { sha256: 'short' }, { sha256: SHA.toUpperCase() }]) {
    const r = await v.take({ bundle });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no checked bundle/);
  }
  assert.equal(v.state(), 'ready');
});

test('a claim the Record refuses (its ready check runs there) is the refusal, and leaves no route', async () => {
  const v = world();
  v.plant = (w) => (w.kind === 'claim' ? { ok: false, reason: 'no go for this plan' } : null);
  const r = await v.take();
  v.plant = null;
  assert.deepEqual(r, { ok: false, reason: 'no go for this plan' });
  assert.equal(v.state(), 'ready');
  assert.equal(v.route(), undefined);
});

test('a route that cannot be recorded gives the card back', async () => {
  const v = world();
  v.plant = (w) => (w.entity === 'fact' ? { ok: false, reason: 'planted' } : null);
  const r = await v.take();
  v.plant = null;
  assert.equal(r.ok, false);
  assert.match(r.reason, /route could not be recorded \(planted\)/);
  assert.equal(v.state(), 'ready');
  assert.equal(v.card().doc.claim, undefined);
});

test('the pass pushes, then hands in: in_review at the pushed head, with one launch record for the merge request', async () => {
  const v = world();
  await v.take();
  assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
  const c = v.card().doc;
  assert.equal(c.state, 'in_review');
  assert.equal(c.head, TIP);
  assert.equal(c.claim, undefined);
  const l = v.rec.read('launch', RUN).doc;
  assert.deepEqual([l.session_id, l.role, l.card, l.head, l.product], [RUN, 'proposal_run', CARD, TIP, PRODUCT], 'never a worker: cleanup would look for a work folder');
  assert.equal(v.route().ended, 'sent');
  assert.deepEqual(v.port.texts, []);
  assert.deepEqual(await v.pass(), [], 'an ended route does nothing');
  assert.equal(v.pushes, 1);
});

test('a push that cannot finish is tried every pass; a blip is not told; past the limit it is told, then daily, then cleared', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, retry: true, reason: 'could not read GitHub' };
  assert.deepEqual(await v.pass(), [[CARD, 'not sent to review: could not read GitHub']]);
  assert.equal(v.state(), 'claimed');
  assert.deepEqual(v.port.texts, [], 'a blip is not told');
  v.clock(ROUTE_TELL_MS - 1000);
  // Its heartbeat would lapse the claim long before this: lapsing is its own test below.
  await v.pass();
  assert.deepEqual(v.port.texts, []);
  v.clock(2000);
  await v.pass();
  assert.equal(v.port.texts.length, 1);
  assert.match(v.port.texts[0], /proposal for card C-1 has not reached review: could not read GitHub/);
  await v.pass();
  assert.equal(v.port.texts.length, 1, 'told once');
  v.clock(STILL_WAITING_MS + 1000);
  await v.pass();
  assert.equal(v.port.texts.length, 2, 'then daily');
  v.answer = { ok: true, tip: TIP };
  assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
  assert.equal(v.state(), 'in_review');
  assert.equal(v.route().told_at, null);
  assert.ok(v.pushes >= 5);
});

test('a throwing push door is a retry, never a stop of the pass', async () => {
  const v = world();
  await v.take();
  v.answer = () => { throw new Error('boom'); };
  assert.deepEqual(await v.pass(), [[CARD, 'not sent to review: boom']]);
  assert.equal(v.state(), 'claimed');
});

test('a push refused for good gives the card back to ready, told once, and the names are open again', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, reason: 'touches a protected path' };
  assert.equal(routeRefused(v.rec, CARD), false);
  assert.deepEqual(await v.pass(), [[CARD, 'refused: touches a protected path']]);
  const c = v.card().doc;
  assert.equal(c.state, 'ready');
  assert.equal(c.claim, undefined);
  assert.equal(routeRefused(v.rec, CARD), true);
  assert.equal(v.port.texts.length, 1);
  assert.match(v.port.texts[0], /refused at the push, and the card is back to ready: touches a protected path\. Send a new proposal and bundle/);
  await v.pass();
  v.clock(2 * STILL_WAITING_MS);
  await v.pass();
  assert.equal(v.port.texts.length, 1, 'told once');
  assert.equal(v.pushes, 1);
});

test('a refusal whose card cannot be given back stays open and is tried again', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, reason: 'no' };
  v.plant = (w) => (w.kind === 'release' ? { ok: false, reason: 'planted' } : null);
  const out = await v.pass();
  v.plant = null;
  assert.match(out[0][1], /could not be given back \(planted\)/);
  assert.equal(v.state(), 'claimed');
  assert.equal(routeRefused(v.rec, CARD), false);
  assert.deepEqual(await v.pass(), [[CARD, 'refused: no']]);
});

test('a telling that was lost after the card was given back is told next pass: the end is recorded first', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, reason: 'no' };
  await proposalRoutePass({ rec: v.rec, pushProposal: v.push, alert: fakeAlert({ answer: false }), now: v.now(), host: HOST });
  assert.equal(v.route().ended, 'refused');
  assert.equal(v.route().told_end, null);
  await v.pass();
  assert.equal(v.port.texts.length, 1);
  await v.pass();
  assert.equal(v.port.texts.length, 1);
});

test('a head that was not written holds the card, and the next pass finishes it', async () => {
  const v = world();
  await v.take();
  v.writeHead = false;
  const out = await v.pass();
  assert.match(out[0][1], /head was not written/);
  assert.equal(v.state(), 'claimed');
  v.writeHead = true;
  assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
});

// A stop at each step: the next pass goes on from where the card is, with no second launch.
for (const kind of ['started', 'proposal_handed_in']) {
  test(`a stop at ${kind} is picked up next pass`, async () => {
    const v = world();
    await v.take();
    v.plant = (w) => (w.kind === kind ? { ok: false, reason: 'planted' } : null);
    const out = await v.pass();
    v.plant = null;
    assert.deepEqual(out, [[CARD, 'not sent to review: planted']]);
    assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
    assert.equal(v.state(), 'in_review');
    assert.equal(v.rec.list('launch').length, 1);
  });
}

test('a claim that lapsed to ready while the push could not finish is taken again', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, retry: true, reason: 'blip' };
  await v.pass();
  must(v.rec.lapseClaims(v.now() + 11 * 60_000));
  assert.equal(v.state(), 'ready');
  v.answer = { ok: true, tip: TIP };
  assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
  assert.equal(v.state(), 'in_review');
});

test('a run that lapsed in running is taken back and goes on', async () => {
  const v = world();
  await v.take();
  v.plant = (w) => (w.kind === 'proposal_handed_in' ? { ok: false, reason: 'planted' } : null);
  await v.pass();
  v.plant = null;
  assert.equal(v.state(), 'running');
  must(v.rec.lapseClaims(v.now() + 11 * 60_000));
  assert.equal(v.state(), 'waiting');
  assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
  assert.equal(v.state(), 'in_review');
});

test('a card taken again by no one and refused by the Record stays told, never lost', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, retry: true, reason: 'blip' };
  await v.pass();
  must(v.rec.lapseClaims(v.now() + 11 * 60_000));
  v.clock(ROUTE_TELL_MS + 1000);
  v.plant = (w) => (w.kind === 'claim' ? { ok: false, reason: 'planted' } : null);
  const out = await v.pass();
  v.plant = null;
  assert.match(out[0][1], /could not be taken again/);
  assert.equal(v.port.texts.length, 1);
  assert.match(v.port.texts[0], /has not reached review: the card could not be taken again/);
});

test('a card cancelled meanwhile ends the route quietly, and a queued telling goes with it', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, retry: true, reason: 'blip' };
  v.clock(ROUTE_TELL_MS + 1000);
  const alert = outbox(v.rec, v.now());
  await proposalRoutePass({ rec: v.rec, pushProposal: v.push, alert, now: v.now(), host: HOST });
  assert.equal(isQueued(v.rec, ROUTE_FACT(CARD)), true);
  must(v.rec.write({ actor: 'approvals', entity: 'card', id: CARD, expectRev: v.card().rev, doc: (({ claim: _c, ...rest }) => ({ ...rest, state: 'cancelled' }))(v.card().doc), kind: 'cancel' }), 'cancel');
  assert.deepEqual(await v.pass(), [[CARD, 'route over: card is cancelled']]);
  assert.equal(v.route().ended, 'over');
  assert.deepEqual(v.port.texts, []);
  assert.equal(routeRefused(v.rec, CARD), false, 'a cancel does not open the names');
});

test('someone else\'s claim on the card ends the route; the push never runs', async () => {
  const v = world();
  await v.take();
  must(v.rec.release({ card: CARD, session_id: RUN, reason: 'test' }), 'release');
  const again = v.card();
  must(v.rec.write({ actor: 'dispatcher', entity: 'card', id: CARD, expectRev: again.rev, doc: { ...again.doc, state: 'claimed', claim: { kind: 'tab', claim_id: 'other', host: HOST } }, kind: 'claim' }), 'other');
  assert.deepEqual(await v.pass(), [[CARD, 'route over: someone else holds the card']]);
  assert.equal(v.pushes, 0);
  assert.equal(v.state(), 'claimed');
});

test('a second proposal for the same card reopens a refused route with nothing left over', async () => {
  const v = world();
  await v.take();
  v.answer = { ok: false, reason: 'no' };
  await v.pass();
  v.answer = { ok: true, tip: TIP };
  const other = 'c'.repeat(64);
  assert.deepEqual(await v.take({ bundle: { sha256: other } }), { ok: true });
  assert.equal(v.route().ended, null);
  assert.equal(v.route().told_end, null);
  assert.equal(v.route().sha256, other);
  assert.equal(routeRefused(v.rec, CARD), false);
  assert.deepEqual(await v.pass(), [[CARD, 'sent to review']]);
});

test('the pass needs its clock', async () => {
  const v = world();
  await assert.rejects(() => proposalRoutePass({ rec: v.rec, pushProposal: v.push, alert: fakeAlert(), now: 'soon' }), /clock/);
});

