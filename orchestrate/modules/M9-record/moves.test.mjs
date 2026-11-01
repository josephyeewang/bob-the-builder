// moves.test.mjs — R-0b-21: every state pair of every entity, as every script actor (0b-2 M-2, R2-M2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINAL_STATES, SCRIPT_ACTORS, STATES, timeoutFor } from '../../shared/record.mjs';
import { readFileSync } from 'node:fs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { INTERNAL_MOVES, MOVES, moveActors } from './moves.mjs';
import { HEAD, PRODUCT, fullTimeouts, iso, passingVerdict, seed, setup } from './fixtures.test-helper.mjs';

const ACTORS = SCRIPT_ACTORS.filter((a) => a !== 'joe');
const GATE = /illegal move|may not move|made only by a claim break/;

function baseDoc(entity, state, env) {
  const t = env.clock.t;
  const wait = { who: 'dependency', what: 'x', since: iso(t), next_check: iso(t + 60000), resume: 'retry', return_to: 'ready' };
  switch (entity) {
    case 'card': return { state, product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, files: ['a.mjs'], done_when: 'x', tier: 2, head: HEAD,
      ...(state === 'claimed' || state === 'running' ? { claim: { kind: 'session', host: 'mac-a', pid: 1, pid_start: 'x', session_id: 'S-1', at: iso(t) } } : {}),
      ...(state === 'waiting' ? { wait } : {}) };
    case 'ask': return { state, kind: 'question', reask_count: 0 };
    case 'session': return { state, role: 'worker', ...(state.startsWith('waiting_') ? { wait: { who: 'usage', what: 'x', since: iso(t), next_check: iso(t + 60000) } } : {}) };
    case 'merge': return { state, card: 'C-x' };
    case 'product': return { state, ...(state === 'paused' ? { return_to: 'active' } : {}) };
    default: throw new Error(entity);
  }
}

test('every state pair: illegal refused with no diary line, wrong actor refused, listed actor passes the move gate', () => {
  const env = setup({ prefix: 'm9-moves-' });
  let n = 0; let legal = 0; let illegal = 0;
  for (const entity of Object.keys(STATES)) {
    for (const from of STATES[entity]) {
      // A refused write leaves the document as it was, so one seed serves until a write succeeds.
      const id = entity === 'product' ? PRODUCT : `${entity}-${n++}`;
      seed(env, entity, id, baseDoc(entity, from, env));
      for (const to of STATES[entity]) {
        if (from === to) continue;
        const actors = moveActors(entity, from, to);
        const internal = INTERNAL_MOVES[entity]?.[from]?.includes(to);
        for (const actor of ACTORS) {
          const before = env.record.diary().length;
          const cur = env.record.read(entity, id);
          const r = env.record.write({ actor, entity, id, expectRev: cur.rev, doc: { ...cur.doc, state: to } });
          const where = `${entity} ${from} → ${to} as ${actor}: ${r.reason}`;
          if (internal) assert.match(r.reason ?? '', /made only by a claim break/, where);
          else if (!actors) { assert.equal(r.ok, false, where); assert.match(r.reason, /illegal move/, where); illegal++; }
          else if (!actors.includes(actor)) { assert.equal(r.ok, false, where); assert.match(r.reason, /may not move/, where); }
          else { legal++; if (!r.ok) assert.doesNotMatch(r.reason, GATE, where); }
          if (!r.ok) assert.equal(env.record.diary().length, before, `refused write left a diary line: ${where}`);
          else { assert.equal(env.record.diary().length, before + 1, where); seed(env, entity, id, baseDoc(entity, from, env)); }
        }
      }
    }
  }
  assert.ok(legal > 50 && illegal > 200, `${legal} legal, ${illegal} illegal`);
});

test('the move table names only real states and script or AI actors', () => {
  for (const [entity, rows] of Object.entries(MOVES)) {
    for (const [from, tos] of Object.entries(rows)) {
      assert.ok(STATES[entity].includes(from), `${entity} ${from}`);
      for (const to of Object.keys(tos)) assert.ok(STATES[entity].includes(to), `${entity} ${to}`);
    }
  }
});

test('final states have no way out except closed → reverted (D8)', () => {
  for (const [entity, finals] of Object.entries(FINAL_STATES)) {
    for (const f of finals) {
      const outs = Object.keys(MOVES[entity]?.[f] ?? {});
      if (entity === 'card' && f === 'closed') assert.deepEqual(outs, ['reverted']);
      else assert.deepEqual(outs, [], `${entity} ${f}`);
    }
  }
});

test('every non-final state has a time limit or a reason in the rules (A4), read through timeoutFor', () => {
  const t = { timeouts: fullTimeouts() };
  for (const [entity, states] of Object.entries(STATES)) {
    for (const s of states) {
      const lim = timeoutFor(t, entity, s);
      if (FINAL_STATES[entity].includes(s)) assert.equal(lim, null);
      else assert.ok(lim && (lim.minutes >= 1 || lim.no_limit_reason), `${entity} ${s}`);
    }
  }
  // A state the rules forget is corrupt, never "no limit".
  const missing = fullTimeouts(); delete missing.card.running;
  assert.equal(timeoutFor({ timeouts: missing }, 'card', 'running'), undefined);
});

// The check above reads a test fixture; the real guard is M10 refusing a rules file that leaves a state out
// (0b-2 audit MIN-9). Its own fixture passes, and taking one state's row out makes the whole file corrupt.
test('A4 on the real rules: M10 refuses a rules file with a non-final state missing from timeouts', () => {
  const text = readFileSync(new URL('../M10-rules/fixtures/policy.yaml', import.meta.url), 'utf8');
  const good = parsePolicy(text);
  assert.ok(good.ok, good.reason);
  for (const [entity, states] of Object.entries(STATES)) for (const s of states) if (!FINAL_STATES[entity].includes(s)) assert.ok(good.policy.timeouts[entity][s], `${entity} ${s}`);
  const row = /\n    draft:\n      no_limit_reason: [^\n]*\n/;
  assert.match(text, row);
  const bad = parsePolicy(text.replace(row, '\n'));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /timeouts\.card\.draft missing/);
});

// R-0b-21 "allowed ones pass": every legal move, by every listed script actor, succeeds once its condition holds.
test('every legal move succeeds for each listed actor when its condition holds', () => {
  const env = setup({ prefix: 'm9-legal-' });
  const t = env.clock.t;
  const ok = (r, where) => assert.ok(r.ok, `${where}: ${r.reason}`);
  seed(env, 'product', PRODUCT, { state: 'active' });
  ok(env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-ok', expectRev: 0, doc: { type: 'audit_run', commit: HEAD, run_id: 1, conclusion: 'success' } }), 'fact');
  ok(env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-bad', expectRev: 0, doc: { type: 'audit_run', commit: HEAD, run_id: 2, conclusion: 'failure' } }), 'fact');
  // A go-free kind made by its allowed creator, so moves into ready and claimed pass without a go.
  const goFreeCard = (id, doc) => env.store.transaction((tx) => tx.commit([{ entity: 'card', id, doc }], { actor: 'lead:L-1', kind: 'seed' }));
  const waitTo = (back) => ({ who: 'dependency', what: 'x', since: iso(t), next_check: iso(t + 60000), resume: back === 'ready' ? 'retry' : 'continue', return_to: back });
  let n = 0; let passed = 0;
  for (const entity of Object.keys(STATES)) {
    for (const from of STATES[entity]) {
      for (const to of STATES[entity]) {
        const actors = from === to ? null : moveActors(entity, from, to);
        if (!actors || INTERNAL_MOVES[entity]?.[from]?.includes(to)) continue;   // made only by release, break or lapse (claims tests)
        for (const actor of actors.filter((a) => ACTORS.includes(a))) {   // AI roles move only through their outbox (outbox tests)
          const id = entity === 'product' ? PRODUCT : `${entity}-L${n++}`;
          const where = `${entity} ${from} → ${to} as ${actor}`;
          let write; let also;
          if (entity === 'card') {
            const doc = { ...baseDoc('card', from, env), kind: 'lead_daily_card' };
            if (from === 'waiting') doc.wait = waitTo(to === 'closed_no_answer' || to === 'cancelled' ? 'ready' : to);
            // A seeded wait carries the head it began on, as the writer stamps it (L123 m-4).
            if (from === 'waiting' && doc.head !== undefined) doc.wait.head = doc.head;
            if (from === 'running' && to === 'in_review') doc.claim = { kind: 'tab', host: 'mac-a', claim_id: 'T-1', at: iso(t) };
            goFreeCard(id, doc);
            const next = { ...doc, state: to };
            if (to === 'waiting') next.wait = waitTo(from === 'running' ? 'ready' : from);
            if (from === 'ready' && to === 'claimed') next.claim = { kind: 'session', host: 'mac-a', pid: 7, pid_start: 'x', session_id: 'S-9' };
            if (actor === 'workshop') next.head = 'c'.repeat(40);
            if (to === 'verified' || to === 'approved') {   // every way in needs a pass for the head (round 3 MAT-A)
              passingVerdict(env, id, `R-${id}`);
            }
            if (to === 'merged') { next.merge_commit = HEAD; seed(env, 'merge', `merged-${id}`, { state: 'merged', card: id, merge_commit: HEAD }); }
            const cardWrite = { entity: 'card', id, expectRev: env.record.read('card', id).rev, doc: next };
            if (to === 'merging') {
              const mid = `merge-for-${id}`;
              seed(env, 'merge', mid, { state: 'queued', card: id });
              write = { entity: 'merge', id: mid, expectRev: env.record.read('merge', mid).rev, doc: { state: 'checking', card: id } };
              also = [cardWrite];
            } else write = cardWrite;
          } else {
            const doc = baseDoc(entity, from, env);
            if (entity === 'ask' && to === 'expired') doc.reask_count = 1;
            if (entity === 'session' && to === 'recycling') doc.role = 'lead';
            if (entity === 'session' && from === 'quarantined') { doc.card = `card-of-${id}`; seed(env, 'card', doc.card, baseDoc('card', 'closed', env)); }
            if (entity === 'product' && from === 'paused') doc.return_to = to;
            if (entity === 'merge') doc.merge_commit = HEAD;
            if (entity === 'merge' && to === 'checking') { doc.card = `card-of-${id}`; seed(env, 'card', doc.card, baseDoc('card', 'approved', env)); }
            seed(env, entity, id, doc);
            const next = { ...doc, state: to };
            if (entity === 'ask' && from !== 'open' && to === 'open') next.reask_count = 1;
            if (entity === 'session' && to.startsWith('waiting_')) next.wait = { who: 'usage', what: 'x', since: iso(t), next_check: iso(t + 60000) };
            if (entity === 'session' && from.startsWith('waiting_')) delete next.wait;
            if (entity === 'product' && to === 'paused') next.return_to = from;
            if (entity === 'product' && from === 'paused') delete next.return_to;
            write = { entity, id, expectRev: env.record.read(entity, id).rev, doc: next };
            if (entity === 'merge' && from === 'merged') write.data = { fact: to === 'audited_ok' ? 'audit-ok' : 'audit-bad' };
            if (entity === 'merge' && to === 'checking') {
              const c = env.record.read('card', doc.card);
              also = [{ entity: 'card', id: doc.card, expectRev: c.rev, doc: { ...c.doc, state: 'merging' } }];
            }
          }
          // A move needing a verdict goes through the view that knows the review user (L66 M1: the file is read again).
          const via = entity === 'card' && (to === 'verified' || to === 'approved') ? env.review : env.record;
          ok(via.write({ actor, ...write, ...(also ? { also } : {}) }), where);
          passed++;
          // One merge at a time: finish this one so the next case can enter checking.
          if (also) seed(env, 'merge', write.id, { ...env.record.read('merge', write.id).doc, state: 'merged' });
          if (entity === 'product') seed(env, 'product', PRODUCT, { state: 'active' });
        }
      }
    }
  }
  assert.ok(passed > 80, `${passed} legal moves`);
});
