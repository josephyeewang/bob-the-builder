// wait-since.test.mjs — a wait's since is when the waiting began (L285). The Store Writer stamps it on the move into
// waiting and keeps it on a re-check of the same wait (same who and what), whatever since the caller sends, so no
// re-check can quietly reset a cap measured from it (M11's limit cap, LIMIT_RESET_MAX_MS, and its no-hit cap). A wait on
// a new who or what is a new wait with a new since, so a Joe wait's tell (M11 joe-waits.mjs, matched within 60 s of
// its since) still finds it. The real Store Writer is tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iso, must, product, put, readyCard, runCard, setup } from './fixtures.test-helper.mjs';
import { keptSince, waitSince } from './guard.mjs';

const MIN = 60000;
const limitWait = (env, over = {}) => ({ who: 'usage', what: 'limit_hit', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN),
  resume: 'retry', return_to: 'ready', account: 'a', ...over });
const card = (env, id) => env.record.read('card', id).doc;

function parked() {
  const env = setup({ prefix: 'm9-since-' });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: limitWait(env) }), 'park');
  return { env, parkedAt: iso(env.clock.t) };
}

test('L285: a re-check of the same wait keeps its since, whether the caller sends now or the kept since', () => {
  const { env, parkedAt } = parked();
  env.clock.t += 2 * 24 * 60 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }), 're-check sending now');
  assert.equal(card(env, 'C-1').wait.since, parkedAt);
  env.clock.t += 60 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, next_check: iso(env.clock.t + 30 * MIN) } }), 're-check sending the kept since');
  assert.equal(card(env, 'C-1').wait.since, parkedAt);
});

test('L285: a re-check may not name any other past since', () => {
  const { env } = parked();
  env.clock.t += 60 * MIN;
  const r = put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, since: iso(env.clock.t - 30 * MIN), next_check: iso(env.clock.t + 30 * MIN) } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /wait\.since must be now/);
});

test('L285: a wait on a new what (a limit wait turned to Joe) is a new wait: its since is now, so its tell can find it', () => {
  const { env, parkedAt } = parked();
  env.clock.t += 3 * 24 * 60 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, who: 'joe', what: 'limit_hit: the hit has no readable reset time', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }), 'to Joe');
  const w = card(env, 'C-1').wait;
  assert.equal(w.since, iso(env.clock.t));
  assert.notEqual(w.since, parkedAt);
});

// Audit #153 m3: who and what each count alone, compared exactly (case and spaces count); an unreadable stored since is
// never kept.
test('audit #153 m3: a new who alone, or a new what alone, is a new wait with a new since', () => {
  for (const change of [{ who: 'joe' }, { what: 'limit_hit: another reading' }, { what: 'LIMIT_HIT' }, { what: 'limit_hit ' }, { what: ' limit_hit' }]) {
    const { env, parkedAt } = parked();
    env.clock.t += 60 * MIN;
    must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: { ...card(env, 'C-1').wait, ...change, since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }), JSON.stringify(change));
    assert.equal(card(env, 'C-1').wait.since, iso(env.clock.t), JSON.stringify(change));
    assert.notEqual(card(env, 'C-1').wait.since, parkedAt);
  }
});

test('audit #153 m3: keptSince keeps only a readable since of the same who and what; waitSince then wants now', () => {
  const NOW = Date.parse('2026-10-29T12:00:00Z');
  const wait = { who: 'usage', what: 'limit_hit', since: new Date(NOW).toISOString() };
  const kept = { who: 'usage', what: 'limit_hit', since: '2026-10-27T12:00:00.000Z' };
  assert.equal(keptSince({ wait, kept }), kept.since);
  for (const k of [{ ...kept, since: 'not a time' }, { ...kept, since: undefined }, { ...kept, who: 'joe' }, { ...kept, what: 'LIMIT_HIT' }, { ...kept, what: 'limit_hit ' }, null]) {
    assert.equal(keptSince({ wait, kept: k }), null, JSON.stringify(k));
    assert.deepEqual(waitSince({ wait, kept: k, nowMs: NOW }), { ok: true, since: wait.since }, JSON.stringify(k));
    assert.equal(waitSince({ wait: { ...wait, since: '2026-10-27T12:00:00.000Z' }, kept: k, nowMs: NOW }).ok, false, JSON.stringify(k));
  }
});
