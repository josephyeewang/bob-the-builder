// l118.test.mjs — L118 M1: only the writer that created a fact or handoff may update it. Each fact writer may update
// (L112), so without this a second writer could rewrite a Sensors fact while the Record still names Sensors as its
// writer, and the readers that trust that (an exact_reverse card's undo_issue, an audit result's audit_run, the start
// gate's vercel fact) would take a forgery. The #91 r1 auditor's ten forgeries are here, each refused on the real Record,
// and the real fact-writing modules run on one real Record with no fact id written by two actors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT, must, outboxFile, plan, product, setup } from './fixtures.test-helper.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { readPowerSource } from '../M12-sensors/power-source.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { heartbeatOnce } from '../M13-ledger/heartbeat.mjs';
import { caughtUpOnce } from '../M13-ledger/caught-up.mjs';

const FORGERS = ['dispatcher', 'workshop', 'ledger'];
const rewrite = (env, actor, entity, id, fields) => {
  const cur = env.record.read(entity, id);
  return env.record.write({ actor, entity, id, expectRev: cur.rev, doc: { ...cur.doc, ...fields } });
};
const refusedAsNotCreator = (r, where) => { assert.equal(r.ok, false, where); assert.match(r.reason, /only sensors may change fact|only lead:L-1 may change handoff/, where); };

for (const forger of FORGERS) {
  test(`forgery: ${forger} turns a Sensors undo_issue authenticated, and no exact_reverse card follows`, () => {
    const env = setup({ prefix: 'm9-l118-' }); product(env);
    must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'F-u', expectRev: 0, doc: { type: 'undo_issue', authenticated: false } }));
    refusedAsNotCreator(rewrite(env, forger, 'fact', 'F-u', { authenticated: true }), forger);
    assert.equal(env.record.read('fact', 'F-u').doc.authenticated, false);
    const c = env.record.write({ actor: 'dispatcher', entity: 'card', id: 'U-1', expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'exact_reverse', source: { fact: 'F-u' }, ...plan() } });
    assert.equal(c.ok, false, 'an unauthenticated undo_issue makes no exact_reverse card');
  });
  test(`forgery: ${forger} turns a Sensors audit_run failure into success`, () => {
    const env = setup({ prefix: 'm9-l118-' });
    must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-1', expectRev: 0, doc: { type: 'audit_run', commit: 'a'.repeat(40), conclusion: 'failure' } }));
    refusedAsNotCreator(rewrite(env, forger, 'fact', 'audit-1', { conclusion: 'success' }), forger);
    assert.equal(env.record.read('fact', 'audit-1').doc.conclusion, 'failure');
  });
  test(`forgery: ${forger} turns a Sensors start-gate vercel fact true`, () => {
    const env = setup({ prefix: 'm9-l118-' });
    const id = `start_gate.vercel_env.${PRODUCT}`;
    must(env.record.write({ actor: 'sensors', entity: 'fact', id, expectRev: 0, doc: { kind: 'fact.start-gate', result: false } }));
    refusedAsNotCreator(rewrite(env, forger, 'fact', id, { result: true }), forger);
    assert.equal(env.record.read('fact', id).doc.result, false);
  });
}

test('forgery: the dispatcher rewrites a handoff the Lead wrote', () => {
  const env = setup({ prefix: 'm9-l118-' });
  // The Lead's handoff comes in through its outbox; set-up puts it in as the Lead wrote it.
  env.store.transaction((tx) => tx.commit([{ entity: 'handoff', id: 'handoff-L-1-1', doc: { session: 'L-1', text: 'where I got to' } }], { actor: 'lead:L-1', kind: 'handoff' }));
  refusedAsNotCreator(rewrite(env, 'dispatcher', 'handoff', 'handoff-L-1-1', { text: 'something else' }), 'dispatcher');
});

test('the creator still updates its own fact and handoff', () => {
  const env = setup({ prefix: 'm9-l118-' });
  for (const actor of ['sensors', ...FORGERS]) {
    must(env.record.write({ actor, entity: 'fact', id: `own-${actor}`, expectRev: 0, doc: { n: 1 } }), `${actor} create`);
    must(rewrite(env, actor, 'fact', `own-${actor}`, { n: 2 }), `${actor} update`);
  }
  must(env.record.write({ actor: 'dispatcher', entity: 'handoff', id: 'handoff-L-9', expectRev: 0, doc: { session: 'L-9', text: 'a' } }));
  must(rewrite(env, 'dispatcher', 'handoff', 'handoff-L-9', { text: 'b' }), 'the dispatcher rewrites its own restart handoff');
});

test('the real Sensors and Ledger fact writers run on one real Record: every write lands, and no fact id has two writers', async () => {
  const env = setup({ prefix: 'm9-l118-' }); product(env);
  let t = Date.parse('2026-11-03T08:00:00Z');
  const now = () => new Date(t);
  // A view of the real Record that notes who wrote each fact.
  const writes = [];
  const rec = { ...env.record, write(w) { const r = env.record.write(w); if (w.entity === 'fact') writes.push({ actor: w.actor, id: w.id, ok: r.ok, reason: r.reason }); return r; } };
  const sensors = makeFactWriter(rec, { actor: 'sensors', now });
  const ledger = makeFactWriter(rec, { actor: 'ledger', now });
  const gh = fakeIssues();
  const alerts = makeAlerts({ rec, gh, owner: 'owner', now });
  const world = { dispatcherRunning: true, signedIn: true };
  const probes = {
    dispatcherLastGood: async () => (world.dispatcherRunning ? new Date(t - 60e3).toISOString() : new Date(t - 3 * 3600e3).toISOString()),
    rulesReadable: async () => true,
    frontDoorReachable: async () => true,
    account: async () => (world.signedIn ? { signedIn: true, login: 'account A' } : { signedIn: false }),
    usage: async () => null,
  };
  const heartbeat = () => heartbeatOnce({ product: 'product 1', writer: ledger, gh, alerts, owner: 'owner', probes, now });
  const issues = [];
  let lastGood = now().toISOString();
  const caughtUp = async () => { await caughtUpOnce({ rec, gh: { listIdeaIssues: async () => issues }, writer: ledger, ownerId: 1001, product: 'product 1', lastGoodPass: lastGood, now }); lastGood = now().toISOString(); };
  const power = (out) => readPowerSource({ run: async () => out, writer: sensors, now });
  // Twice over: green, then red (an alert raised, the account signed out), then green again (cleared), so each fact
  // is created and then rewritten by its writer.
  for (let round = 0; round < 2; round++) {
    await heartbeat(); await caughtUp(); await power("Now drawing from 'AC Power'\n");
    world.dispatcherRunning = false; world.signedIn = false; t += 10 * 60e3;
    await heartbeat(); await power("Now drawing from 'UPS Power'\n -Back-UPS 900 (id=1)\t84%; discharging; 0:31 remaining present: true\n");
    world.dispatcherRunning = true; world.signedIn = true; t += 2 * 3600e3;
    issues.push({ number: 7 + round, title: 'Idea', body: 'x', user: { id: 1001, login: 'owner' } });
    await caughtUp(); await heartbeat();
    t += 10 * 60e3;
  }
  const refused = writes.filter((w) => !w.ok);
  assert.deepEqual(refused, [], 'every fact write lands');
  const byId = new Map();
  for (const w of writes) byId.set(w.id, new Set([...(byId.get(w.id) ?? []), w.actor]));
  const shared = [...byId].filter(([, actors]) => actors.size > 1).map(([id, a]) => `${id}: ${[...a].join(', ')}`);
  assert.deepEqual(shared, [], 'no fact id is written by two actors');
  assert.ok(writes.filter((w) => w.actor === 'ledger').length > 5 && writes.some((w) => w.actor === 'sensors'), `${writes.length} fact writes`);
  assert.ok([...byId.keys()].some((id) => (byId.get(id).has('ledger')) && writes.filter((w) => w.id === id).length > 1), 'some Ledger fact is rewritten');
});

// #91 r2 audit (L129), probe m68fam carried as a test: a Lead's handoff, handed in through its outbox, is the Lead's
// own; the Dispatcher, another Lead session, the same session's writer name and Learning may not rewrite it.
test('L129: a Lead handoff from the outbox is rewritten by no one, the Dispatcher included', () => {
  const env = setup({ prefix: 'm9-l129-' });
  const f = outboxFile(env, 'lead', 'X', 'handoff-X.md', 'where I got to');
  const a = env.record.applyOutbox({ role: 'lead', sessionId: 'X' }, f);
  assert.equal(a.ok, true, a.reason);
  const h = env.record.list('handoff')[0];
  for (const actor of ['dispatcher', 'lead:X', 'lead:Y', 'learning:Z']) {
    const r = env.record.write({ actor, entity: 'handoff', id: h.id, expectRev: h.rev, doc: { ...h.doc, text: 'forged' } });
    assert.equal(r.ok, false, actor);
  }
  assert.equal(env.record.read('handoff', h.id).doc.text, h.doc.text);
});
