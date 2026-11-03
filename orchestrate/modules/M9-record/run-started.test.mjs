// run-started.test.mjs — a card wait's run_started (MAT-1, audit #78 r2): when the run a card waits from began.
//
// M11 resumes a card parked on a usage limit only on a limit hit observed after its run began. The Record sets that time
// from the claim, in the same write that ends the claim (guard.mjs guardWrite, which the Store Writer and the stand-in
// both call): claimed/running → waiting copies claim.claimed_at (claimed → waiting is not a legal move today); a re-check while waiting keeps it; any other move into
// waiting has none; a missing or unreadable claimed_at gives none. A caller's run_started is dropped on every path.
// The real Store Writer is tested here; guardWrite directly for what no legal write can reach (a claim with no time);
// the stand-in through M11's parkOnLimit (M11 limit-wait.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iso, must, product, put, readyCard, runCard, setup } from './fixtures.test-helper.mjs';
import { guardWrite } from './guard.mjs';

const MIN = 60000;
const FORGED = '2020-01-01T00:00:00.000Z';
const limitWait = (env, over = {}) => ({ who: 'usage', what: 'limit_hit', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN),
  resume: 'retry', return_to: 'ready', account: 'a', ...over });
const card = (env, id) => env.record.read('card', id).doc;

function running(id = 'C-1') {
  const env = setup({ prefix: 'm9-rs-' });
  product(env);
  readyCard(env, id);
  runCard(env, id);
  return env;
}

test('running → waiting: run_started is the claim\'s claimed_at, not the park time', () => {
  const env = running();
  const claimedAt = card(env, 'C-1').claim.claimed_at;
  env.clock.t += 7 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env) }), 'park');
  const c = card(env, 'C-1');
  assert.equal(c.wait.run_started, claimedAt);
  assert.equal(c.wait.since, iso(env.clock.t));
  assert.equal(c.claim, undefined, 'the claim ends in the same write');
});

test('a caller\'s run_started is dropped on the park: the claim\'s time is stored', () => {
  const env = running();
  const claimedAt = card(env, 'C-1').claim.claimed_at;
  env.clock.t += MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env, { run_started: FORGED }) }), 'park');
  assert.equal(card(env, 'C-1').wait.run_started, claimedAt);
});

test('a re-check while waiting keeps run_started, and a caller\'s run_started on the re-check is dropped', () => {
  const env = running();
  const claimedAt = card(env, 'C-1').claim.claimed_at;
  env.clock.t += MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env) }), 'park');
  env.clock.t += 10 * MIN;
  // A re-check that leaves run_started out keeps it.
  const { run_started: _r, ...rest } = card(env, 'C-1').wait;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...rest, since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }), 're-check');
  assert.equal(card(env, 'C-1').wait.run_started, claimedAt);
  // One that names another time keeps the stored one.
  env.clock.t += 10 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, run_started: FORGED, since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }), 're-check');
  assert.equal(card(env, 'C-1').wait.run_started, claimedAt);
  // One that changes only run_started changes nothing.
  const r = put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, run_started: FORGED } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nothing changed/);
});

test('ready → waiting has no run_started, a caller\'s included, and a re-check of it gets none', () => {
  const env = setup({ prefix: 'm9-rs-' });
  product(env);
  readyCard(env, 'C-1');
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env, { run_started: FORGED }) }), 'park from ready');
  assert.equal(card(env, 'C-1').wait.run_started, undefined);
  env.clock.t += MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, run_started: FORGED, since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }), 're-check');
  assert.equal(card(env, 'C-1').wait.run_started, undefined);
});

test('a second run parks with its own claim\'s time, never the first run\'s', () => {
  const env = running();
  const first = card(env, 'C-1').claim.claimed_at;
  env.clock.t += MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env) }), 'park 1');
  env.clock.t += 60 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'ready' }), 'resume');
  assert.equal(card(env, 'C-1').wait, undefined, 'leaving waiting ends the wait');
  env.clock.t += MIN;
  runCard(env, 'C-1');
  const second = card(env, 'C-1').claim.claimed_at;
  assert.notEqual(second, first);
  env.clock.t += MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env) }), 'park 2');
  assert.equal(card(env, 'C-1').wait.run_started, second);
});

// What no legal write reaches: the claim itself is the Record's (claimCheck stamps claimed_at), so a claim with a
// missing or unreadable time is checked on guardWrite, the one function both records call.
test('guardWrite: a claim with no claimed_at, or one that is not a time, gives no run_started; the caller\'s is still dropped', () => {
  const now = '2026-10-01T12:00:00.000Z';
  const w = { who: 'usage', what: 'limit_hit', since: now, next_check: now, resume: 'retry', return_to: 'ready', account: 'a', run_started: FORGED };
  const old = (claim) => ({ state: 'running', product: 'p', module: 'M-test', claim });
  for (const claim of [{ kind: 'session', session_id: 'S-1', host: 'h' }, { kind: 'session', session_id: 'S-1', host: 'h', claimed_at: 'not a time' },
    { kind: 'session', session_id: 'S-1', host: 'h', claimed_at: 12345 }, undefined]) {
    const g = guardWrite({ entity: 'card', id: 'C-1', actor: 'dispatcher', old: old(claim), doc: { ...old(claim), state: 'waiting', wait: w } });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.doc.wait.run_started, undefined, JSON.stringify(claim));
  }
  // A good one is copied; the caller's doc is never changed.
  const good = old({ kind: 'session', session_id: 'S-1', host: 'h', claimed_at: now });
  const doc = { ...good, state: 'waiting', wait: w };
  const g = guardWrite({ entity: 'card', id: 'C-1', actor: 'dispatcher', old: good, doc });
  assert.equal(g.doc.wait.run_started, now);
  assert.equal(doc.wait.run_started, FORGED, 'guardWrite does not change its input');
});

test('guardWrite: a create drops a caller\'s run_started too', () => {
  const g = guardWrite({ entity: 'card', id: 'C-9', actor: 'dispatcher', old: null,
    doc: { state: 'draft', product: 'p', wait: { who: 'usage', what: 'x', run_started: FORGED } } });
  if (g.ok) assert.equal(g.doc.wait.run_started, undefined);
});
