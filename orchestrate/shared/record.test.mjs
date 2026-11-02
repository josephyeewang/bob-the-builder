import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRecord, memoryRecord, outboxKind, isActor, missingFields, STATES, FINAL_STATES, WAIT_FIELDS, REQUIRED_FIELDS, ENTITIES } from './record.mjs';
import { tempDir } from './test-tmp.mjs';

test('create, read, update only if unchanged, one diary line per accepted write', () => {
  const rec = memoryRecord();
  const w1 = rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'draft', module: 'm' } });
  assert.deepEqual([w1.ok, w1.rev], [true, 1]);
  assert.deepEqual(rec.read('card', 'C-1').doc, { state: 'draft', module: 'm' });
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'ready', module: 'm' } }).rev, 2);
  const stale = rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'claimed', module: 'm' } });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /changed since read/);
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 2, doc: { state: 'claimed', module: 'm', claim: { kind: 'session', session_id: 'S-1', host: 'h' } } }).rev, 3);
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
  // Facts by family (L74): the dispatcher makes facts only in its own families, so it can't take Sensors' pr- first.
  assert.match(make('dispatcher', 'fact', 'F-1', { text: 'x' }).reason, /fact F-1 is in no family; dispatcher may not create it/);
  assert.match(make('dispatcher', 'fact', 'pr-7', { text: 'x' }).reason, /fact pr-7 is in sensors's family, not dispatcher's/);
  assert.match(make('approvals', 'fact', 'outage', { text: 'x' }).reason, /approvals may not create fact/);
  // The claim's two steps, by M9's own check (guard.mjs claimCheck, L72): ready → claimed names a session and no
  // process, and is stamped; claimed → running adds pid and pid_start and nothing else; no other write changes it.
  {
    const r2 = memoryRecord({ now: () => Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r2.write({ actor: 'dispatcher', entity: 'card', id: 'K', expectRev: 0, doc: { state: 'draft', module: 'm' } }).ok, true);
    const k = (doc, actor = 'dispatcher') => { const c = r2.read('card', 'K'); return r2.write({ actor, entity: 'card', id: 'K', expectRev: c.rev, doc: { ...c.doc, ...doc } }); };
    assert.equal(k({ state: 'ready' }).ok, true);
    assert.match(k({ state: 'claimed' }).reason, /a claim needs its owner/);
    assert.match(k({ state: 'claimed', claim: { kind: 'session', session_id: 'S-9', host: 'h', pid: 7 } }).reason, /gets its pid at claimed → running/);
    assert.match(k({ state: 'claimed', claim: { kind: 'session', session_id: 'bad id', host: 'h' } }).reason, /session_id/);
    assert.equal(k({ state: 'claimed', claim: { kind: 'session', session_id: 'S-9', host: 'h' } }).ok, true);
    assert.equal(r2.read('card', 'K').doc.claim.claimed_at, '2026-10-01T00:00:00.000Z');
    const claim = r2.read('card', 'K').doc.claim;
    assert.match(k({ state: 'running' }).reason, /needs the session's pid/);
    assert.match(k({ state: 'running', claim: { ...claim, pid: undefined, pid_start: undefined } }).reason, /needs the session's pid/);
    assert.match(k({ state: 'running', claim: { ...claim, pid: 7 } }).reason, /needs pid_start/);
    assert.match(k({ state: 'running', claim: { ...claim, session_id: 'S-8', pid: 7, pid_start: 'x' } }).reason, /only adds pid and pid_start/);
    assert.equal(k({ state: 'running', claim: { ...claim, pid: 7, pid_start: 'x' } }).ok, true);
    assert.match(k({ claim: { ...r2.read('card', 'K').doc.claim, pid: 8 } }).reason, /a claim is set only by ready → claimed/);
  }
  // The claim a move ends goes with it: leaving claimed by release clears it.
  assert.equal(rec.release({ card: 'C-1', session_id: 'S-1' }).ok, true);
  assert.equal(rec.read('card', 'C-1').doc.claim, undefined);
  assert.equal(rec.diary().length, 4);
  // Change-own (L74): a fact is changed only by the role that created it.
  assert.equal(make('dispatcher', 'fact', 'outage', { text: 'x' }).ok, true);
  const f = rec.read('fact', 'outage');
  assert.match(rec.write({ actor: 'sensors', entity: 'fact', id: 'outage', expectRev: f.rev, doc: { text: 'y' } }).reason, /sensors may change only a fact it created; outage was created by dispatcher/);
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'fact', id: 'outage', expectRev: f.rev, doc: { text: 'y' } }).ok, true);
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
  const dir = tempDir('m9-outbox-');
  writeFileSync(join(dir, 'report-C-1.md'), 'done');
  assert.equal(rec.applyOutbox({ role: 'worker', sessionId: 'S-4', card: 'C-1' }, join(dir, 'report-C-1.md')).ok, true);
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

test('L121: the stand-in refuses a file name with no outbox kind, as the real M9 does', () => {
  const rec = memoryRecord();
  for (const name of ['/o/notakind-C-1.md', '/o/verdict-compact\u2011S1.md', '/o/report-.md']) {
    const r = rec.applyOutbox({ role: 'worker', sessionId: 'S-4' }, name);
    assert.equal(r.ok, false, name);
    assert.match(r.reason, /no outbox kind/, name);
  }
  assert.equal(rec.diary().length, 0);
  assert.equal(outboxKind('report-C-1.md'), 'report-');
  assert.equal(outboxKind('ask-request-1.md'), 'ask-request-', 'the longest kind wins');
});

test('L129: the stand-in names a document\'s first writer as its creator (meta), and only it may change a fact', () => {
  const rec = memoryRecord();
  assert.equal(rec.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'x' } }).ok, true);
  // L118 M1: another writer may not rewrite it, so createdBy stays the writer of the contents too.
  assert.match(rec.write({ actor: 'ledger', entity: 'fact', id: 'audit-run-1', expectRev: 1, doc: { type: 'y' } }).reason, /may change/);
  assert.equal(rec.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 1, doc: { type: 'y' } }).ok, true);
  assert.equal(rec.meta('fact', 'audit-run-1').createdBy, 'sensors');
  assert.equal(rec.meta('fact', 'audit-run-2'), null);
});

test('L129: a name with a dot in its id has no outbox kind', () => {
  assert.equal(outboxKind('report-X.1.md'), null);
  assert.equal(outboxKind('report-X1.md'), 'report-');
});
