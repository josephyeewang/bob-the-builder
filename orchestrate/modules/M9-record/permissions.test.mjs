// permissions.test.mjs — R-0b-22: who may change which fields (0b-2 M-1, R2-M12, R3-M2, R3-M3, R3-m5).
// Every listed write passes the field check for the listed actor and is refused for every other script actor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, REQUIRED_FIELDS, SCRIPT_ACTORS } from '../../shared/record.mjs';
import { CARD_CREATORS, WRITERS, fieldsAllowed, mayCreateKind } from './permissions.mjs';
import { HEAD, PRODUCT, iso, seed, setup } from './fixtures.test-helper.mjs';

const ACTORS = SCRIPT_ACTORS.filter((a) => a !== 'joe');
const FIELD_GATE = /may not change|may not set|may not create|may not change [a-z_]+$/;

function minimal(entity, env) {
  const t = iso(env.clock.t);
  const req = Object.fromEntries((REQUIRED_FIELDS[entity] ?? []).map((f) => [f, f === 'head' ? HEAD : f === 'rev' ? 1 : f.endsWith('_at') ? t : 'x']));
  const states = { card: 'draft', ask: 'open', session: 'preparing', merge: 'requested' };
  return { ...req, ...(states[entity] ? { state: states[entity] } : {}), ...(entity === 'product' ? { state: 'active' } : {}) };
}

test('every entity has a writer row, and every row names a real entity', () => {
  for (const e of ENTITIES) assert.ok(WRITERS[e], `no writer row for ${e}`);
  for (const e of Object.keys(WRITERS)) assert.ok(ENTITIES.includes(e), e);
});

test('create: only the listed script actors may create each entity', () => {
  const env = setup({ prefix: 'm9-perm-' });
  let n = 0;
  for (const entity of ENTITIES) {
    if (entity === 'card' || entity === 'merge_request') continue;   // card kinds and merge requests: their own tests
    for (const actor of ACTORS) {
      const id = entity === 'product' ? PRODUCT : `${entity}-${n++}`;
      const r = env.record.write({ actor, entity, id, expectRev: 0, doc: minimal(entity, env) });
      const listed = fieldsAllowed(entity, actor, { create: true }) !== null;
      if (listed) {
        if (!r.ok) assert.doesNotMatch(r.reason, /may not create/, `${entity} as ${actor}: ${r.reason}`);
        if (r.ok && entity === 'product') seed(env, 'product', PRODUCT, { state: 'active' });
      } else {
        assert.equal(r.ok, false, `${entity} created by ${actor}`);
        assert.match(r.reason, /may not create/, `${entity} as ${actor}`);
      }
      // A product can exist once; clear the way for the next actor by using a fresh store per product case.
      if (entity === 'product' && r.ok) break;
    }
  }
});

test('card kinds: each creator makes only its own kinds (R3-M3)', () => {
  for (const kind of ['ordinary', 'fix', 'exact_reverse', 'lead_daily_card', 'research_copy']) {
    const makers = Object.entries(CARD_CREATORS).filter(([, ks]) => ks.includes(kind)).map(([a]) => a);
    assert.equal(makers.length, 1, `${kind} has one creator`);
    for (const a of [...ACTORS, 'lead', 'worker', 'reviewer']) assert.equal(mayCreateKind(`${a}:S-1`, kind), a === makers[0], `${a} ${kind}`);
  }
});

test('update: every listed field passes the field check for its actor and is refused for every other actor', () => {
  const env = setup({ prefix: 'm9-perm-' });
  let n = 0; let checked = 0;
  const value = (f) => (f === 'head' ? 'c'.repeat(40) : f === 'needs_joe' ? true : f === 'merge_commit' ? HEAD : `v-${f}`);
  for (const entity of ENTITIES) {
    const fields = new Set();
    for (const row of Object.values(WRITERS[entity])) if (Array.isArray(row.update) || row.update instanceof Set) for (const f of row.update) fields.add(f);
    if (entity === 'card') for (const f of ['brief', 'desired', 'merge_requested']) fields.add(f);
    fields.add('note');   // a field nobody lists
    for (const field of fields) {
      for (const actor of ACTORS) {
        const id = entity === 'product' ? PRODUCT : `${entity}-${n++}`;
        const doc = entity === 'card' ? { ...minimal('card', env), product: PRODUCT, kind: 'ordinary', round: 1 } : minimal(entity, env);
        // approvals only clears needs_joe (the setters are tested on the other side of the same field).
        const clearing = entity === 'card' && field === 'needs_joe' && actor === 'approvals';
        if (clearing) doc.needs_joe = true;
        seed(env, entity, id, doc);
        const cur = env.record.read(entity, id);
        const r = env.record.write({ actor, entity, id, expectRev: cur.rev, doc: { ...cur.doc, [field]: clearing ? false : value(field) } });
        const allowed = fieldsAllowed(entity, actor, { state: cur.doc.state });
        const listed = allowed === '*' || (allowed instanceof Set && allowed.has(field));
        const where = `${entity}.${field} as ${actor}: ${r.reason}`;
        if (listed) { if (!r.ok) assert.doesNotMatch(r.reason, FIELD_GATE, where); }
        else { assert.equal(r.ok, false, where); assert.match(r.reason, FIELD_GATE, where); }
        checked++;
      }
    }
  }
  assert.ok(checked > 150, `${checked} checks`);
});

test('the Lead changes plan inputs only on a draft; never on a fix card (R2-M12, R3-m2)', () => {
  assert.ok(fieldsAllowed('card', 'lead:L-1', { state: 'draft' }).has('files'));
  assert.ok(!fieldsAllowed('card', 'lead:L-1', { state: 'ready' }).has('files'));
  assert.ok(!fieldsAllowed('card', 'worker:S-1', { state: 'running' }).has('needs_joe'));
});
