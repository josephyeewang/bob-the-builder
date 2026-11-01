import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, memoryRecord, isActor, missingFields, STATES, FINAL_STATES, WAIT_FIELDS, REQUIRED_FIELDS, ENTITIES } from './record.mjs';

test('create, read, update only if unchanged, one diary line per accepted write', () => {
  const rec = memoryRecord();
  const w1 = rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'draft', module: 'm' } });
  assert.deepEqual([w1.ok, w1.rev], [true, 1]);
  assert.deepEqual(rec.read('card', 'C-1').doc, { state: 'draft', module: 'm' });
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'ready', module: 'm' } }).rev, 2);
  const stale = rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'claimed', module: 'm' } });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /changed since read/);
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 2, doc: { state: 'claimed', module: 'm' } }).rev, 3);
  const d = rec.diary();
  assert.equal(d.length, 3);
  assert.deepEqual([d[2].from_state, d[2].to_state, d[2].actor], ['ready', 'claimed', 'dispatcher']);
});

// L72: the stand-in refuses what M9 refuses on who may write what, with M9's own check (guard.mjs), and keeps no line.
test('the stand-in refuses a field or a move M9 does not allow that actor, as the real Record does', () => {
  const rec = memoryRecord();
  const make = (actor, entity, id, doc) => rec.write({ actor, entity, id, expectRev: 0, doc });
  assert.equal(make('dispatcher', 'card', 'C-1', { state: 'draft', module: 'm' }).ok, true);
  const at = (doc, actor = 'dispatcher') => { const c = rec.read('card', 'C-1'); return rec.write({ actor, entity: 'card', id: 'C-1', expectRev: c.rev, doc: { ...c.doc, ...doc } }); };
  // A field outside the dispatcher's list.
  assert.match(at({ changed_at: '2026-10-01T00:00:00Z' }).reason, /dispatcher may not change changed_at on card C-1/);
  // A field set at create that the maker may not set.
  assert.match(make('dispatcher', 'card', 'C-2', { state: 'draft', module: 'm', go_free: true }).reason, /may not set go_free on a new card/);
  // A state the maker may not create in, a move not in the table, a move by the wrong actor.
  assert.match(make('dispatcher', 'card', 'C-3', { state: 'running', module: 'm' }).reason, /may not create a card in running/);
  assert.match(at({ state: 'merged' }).reason, /illegal move: card draft → merged/);
  assert.match(at({ state: 'cancelled' }).reason, /dispatcher may not move card draft → cancelled/);
  // claimed → ready only by release, break or lapse.
  assert.equal(at({ state: 'ready' }).ok, true);
  assert.equal(at({ state: 'claimed', claim: { kind: 'session', session_id: 'S-1', host: 'h' } }).ok, true);
  assert.match(at({ state: 'ready' }).reason, /made only by a claim break or lapse/);
  // Who may create an entity at all: the dispatcher writes no facts.
  assert.match(make('dispatcher', 'fact', 'F-1', { text: 'x' }).reason, /dispatcher may not create fact/);
  // The claim a move ends goes with it: leaving claimed by release clears it.
  assert.equal(rec.release({ card: 'C-1', session_id: 'S-1' }).ok, true);
  assert.equal(rec.read('card', 'C-1').doc.claim, undefined);
  assert.equal(rec.diary().length, 4);
});

test('AI roles cannot call write; bad arguments are refused, not thrown', () => {
  const rec = memoryRecord();
  for (const w of [null, { actor: 'worker:S-1', entity: 'card', id: 'C', expectRev: 0 }, { actor: 'root', entity: 'card', id: 'C', expectRev: 0 },
    { actor: 'joe', entity: 'secrets', id: 'C', expectRev: 0 }, { actor: 'joe', entity: 'card', id: '../x', expectRev: 0 },
    { actor: 'joe', entity: 'card', id: 'C' }]) {
    assert.equal(rec.write(w).ok, false, JSON.stringify(w));
  }
  assert.equal(rec.diary().length, 0);
});

test('applyOutbox needs a known role and its session id', () => {
  const rec = memoryRecord();
  assert.equal(rec.applyOutbox({ role: 'merge_gate', sessionId: 'S' }, 'f').ok, false);
  assert.equal(rec.applyOutbox({ role: 'worker' }, 'f').ok, false);
  assert.equal(rec.applyOutbox({ role: 'worker', sessionId: 'S-4', card: 'C-1' }, '/o/report-C-1.md').ok, true);
  assert.equal(rec.diary()[0].actor, 'worker:S-4');
});

test('a throwing store comes back as a refusal', () => {
  const rec = makeRecord({ write() { throw new Error('disk full'); }, applyOutbox() { return 'yes'; } });
  assert.match(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C', expectRev: 0, doc: { state: 'draft', module: 'm' } }).reason, /disk full/);
  assert.equal(rec.applyOutbox({ role: 'lead', sessionId: 'S' }, 'f').ok, false);
});

test('names are fixed', () => {
  assert.ok(isActor('reviewer:S-9') && !isActor('reviewer') && !isActor('boss:S-1'));
  // The session part is SESSION_ID: at most 128, letters, digits and dashes (0b-2 audit round 7 m-3).
  assert.ok(isActor(`reviewer:${'S'.repeat(128)}`) && !isActor(`reviewer:${'S'.repeat(129)}`) && !isActor('reviewer:S_1') && !isActor('reviewer:S-1\n'));
  assert.ok(STATES.card.includes('reverted') && WAIT_FIELDS.length === 4);
});

test('required fields are refused when missing, on the fake as on the real record', () => {
  const rec = memoryRecord();
  assert.match(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C', expectRev: 0, doc: { state: 'draft' } }).reason, /missing module/);
  assert.match(rec.write({ actor: 'dispatcher', entity: 'launch', id: 'L', expectRev: 0, doc: { session_id: 'S' } }).reason, /missing role, card, head, rev, launched_at/);
  const launch = { session_id: 'S-1', role: 'reviewer', card: 'C', head: 'a'.repeat(40), rev: 2, launched_at: '2026-10-29T00:00:00Z' };
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'launch', id: 'L-1', expectRev: 0, doc: launch }).ok, true);
  for (const bad of ['S'.repeat(129), 123, ['S-1'], true]) assert.match(rec.write({ actor: 'dispatcher', entity: 'launch', id: 'L-2', expectRev: 0, doc: { ...launch, session_id: bad } }).reason, /launch needs a session_id/);
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'verdict', id: 'V', expectRev: 0, doc: { session_id: 'S-1' } }).ok, false);
  assert.ok(Object.keys(REQUIRED_FIELDS).every((e) => ENTITIES.includes(e)));
});

test('final states are real states, and every entity with states has a final list', () => {
  for (const [entity, finals] of Object.entries(FINAL_STATES)) {
    assert.ok(finals.every((s) => STATES[entity].includes(s)), entity);
  }
  assert.deepEqual(Object.keys(FINAL_STATES).sort(), Object.keys(STATES).sort());
  assert.ok(STATES.merge.includes('queued') && FINAL_STATES.card.includes('failed'));
});

test('a launch names a card and head only for a worker, reviewer or auditor', () => {
  const base = { session_id: 's-1', rev: 1, launched_at: '2026-10-30T00:00:00Z' };
  assert.deepEqual(missingFields('launch', { ...base, role: 'front_door' }), []);
  assert.deepEqual(missingFields('launch', { ...base, role: 'worker' }), ['card', 'head']);
  assert.deepEqual(missingFields('launch', { ...base }), ['role', 'card', 'head'], 'no role: fail closed');
  assert.deepEqual(missingFields('merge_request', {}), REQUIRED_FIELDS.merge_request);
});
