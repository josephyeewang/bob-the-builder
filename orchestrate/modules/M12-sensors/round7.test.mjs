// round7.test.mjs — planted cases for the 0b-7 audit round 7 findings (M-1, M-2) and one of its minors. Each fails on
// the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { watchOutside, checkNoPush, ROBOT_FACT, NO_PUSH_FACT } from './outside-watch.mjs';
import { watchOnce, stateFactId } from './prod-watcher.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';
import { FAKE } from './fakes.mjs';

const TAG = 'slottag01';
function world() {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const rec = memoryRecord();
  const mk = () => makeAlerts({ rec, gh: fakeIssues(), owner: 'o', now: () => new Date(t) });
  const homeAlerts = mk(); const productAlerts = { 'product 1': mk() };
  const runs = []; let id = 0; let failJobs = false;
  const owner = { tags: { 'product 1': TAG } };
  const fetchJson = async (path) => {
    if (path.endsWith('/contents/robot-merges-owner.json')) return { content: Buffer.from(JSON.stringify(owner)).toString('base64') };
    if (path.includes('/workflows/')) return { workflow_runs: runs.slice(0, 10).map(({ c: _c, ...r }) => r) };
    if (failJobs) throw new Error('502');
    const r = runs.find((x) => x.id === Number(/\/runs\/(\d+)\/jobs/.exec(path)[1]));
    return { jobs: [{ name: 'check', steps: [{ name: 'product 1 / robot-merges', conclusion: r.c }, { name: 'product 1 / repo-guard', conclusion: 'success' }] }] };
  };
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  return {
    run: (c) => { t += 60 * 60e3; runs.unshift({ id: ++id, created_at: new Date(t - 60e3).toISOString(), status: 'completed', conclusion: c === 'success' ? 'success' : 'failure', c }); },
    pass: () => watchOutside({ fetchJson, repo: 'o/c', homeAlerts, productAlerts, writer, productNames: { 'product 1': { product: 'real-product', tag: TAG } }, now: () => t }),
    fact: () => rec.read('fact', ROBOT_FACT('real-product'))?.doc,
    failJobs: (v) => { failJobs = v; }, tick: (m) => { t += m * 60e3; },
  };
}

test('0b-7 audit round 7 M-1: a failed run whose steps could not be read still counts toward the latch once they can', async () => {
  const w = world();
  w.run('success'); await w.pass();
  w.run('failure'); w.failJobs(true); await w.pass();
  assert.equal(w.fact().red_runs, 0, 'unknown steps are not a red run yet');
  w.failJobs(false); w.tick(5); await w.pass();
  assert.equal(w.fact().red_runs, 1, 'the same run, now readable, counts');
  assert.ok(w.fact().last_red_at, 'and a clear must come after it');
  w.run('failure'); await w.pass();
  assert.equal(w.fact().red_runs, 2);
  assert.ok(w.fact().red_since, 'two red runs in a row latch the gate');
});

test('0b-7 audit round 7 M-1: a pass that cannot read the steps keeps the last run it did read', async () => {
  const w = world();
  w.run('success'); await w.pass();
  const before = w.fact();
  w.run('success'); w.failJobs(true); await w.pass();
  assert.equal(w.fact().run_id, before.run_id);
  assert.equal(w.fact().run_at, before.run_at);
});

test('0b-7 audit round 7 M-2: an outside-chosen env id that looks secret-named neither masks the stored fact nor repeats an alert', async () => {
  for (const envId of ['aPwDx1234567890Q', 'tokenAbc123', 'secret-env-01']) {
    const rec = memoryRecord(); const masker = makeMasker({ env: {} });
    const writer = makeFactWriter(rec, { masker }); const gh = fakeIssues();
    const alerts = makeAlerts({ rec, gh, owner: 'o', masker });
    const vercel = { deployments: async () => [], live: async () => ({ uid: null }), envMeta: async () => [{ id: envId, key: 'API_URL', target: ['production'], type: 'plain', updatedAt: 1 }],
      settings: async () => ({ productionBranch: 'main', linkedRepo: 'github:a/b' }) };
    const events = [];
    for (let i = 0; i < 3; i++) events.push(...await watchOnce({ vercel, rulesEntry: { stage: 'first' }, mainFirstParent: new Set(), evidence: new Set(), writer, alerts, product: 'p' }));
    assert.deepEqual(events.filter((e) => e.kind === 'setting-changed'), [], envId);
    assert.equal(writer.get(stateFactId('p')).env[envId].key, 'API_URL', envId);
  }
});

test('0b-7 audit round 7: a planted key in a map key or in declared text is still masked by its shape', () => {
  const rec = memoryRecord(); const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  writer.put('f', { kind: 'fact.prod-watch', product: 'p', env: { [FAKE.github]: { key: `x ${FAKE.github}`, print: 'ab12' } }, settings: { a: 'b' } });
  assert.equal(JSON.stringify(rec.read('fact', 'f').doc).includes(FAKE.github), false);
});

test('0b-7 audit round 7 minor: the no-push reason says which token can write, unmasked', async () => {
  const rec = memoryRecord(); const masker = makeMasker({ env: {} });
  const writer = makeFactWriter(rec, { masker });
  await checkNoPush({ tokens: [{ name: 'robot token', probe: async () => 422 }], repo: 'a/b', writer, homeAlerts: makeAlerts({ rec, gh: fakeIssues(), owner: 'o', masker }), writeProbe: async () => 'can-write' });
  assert.equal(writer.get(NO_PUSH_FACT).reason, 'robot token answered can-write');
});
