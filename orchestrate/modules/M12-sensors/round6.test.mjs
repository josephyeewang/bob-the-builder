// round6.test.mjs — planted cases for the 0b-7 audit round 6 findings (MAT-A, MAT-B, MAT-C) and lead call L24 (the
// outside-check repo locked to its owner). Each test fails on the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { watchOutside, robotMergesGreen, checkNoPush, ROBOT_FACT, NO_PUSH_FACT } from './outside-watch.mjs';
import { repoGuard, writeProbe, runOne } from '../M13-ledger/outside-check/outside-check.mjs';
import { keepAlive } from '../M13-ledger/outside-check/keep-alive.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';
import { FAKE } from './fakes.mjs';

const TAG = 'slottag01';
// One outside-check run an hour (run()); the Mini's pass is pass(). guard sets the repo-guard step's conclusion.
function world(cleared) {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const rec = memoryRecord();
  const mk = () => makeAlerts({ rec, gh: fakeIssues(), owner: 'o', now: () => new Date(t) });
  const homeAlerts = mk(); const productAlerts = { 'product 1': mk() };
  const runs = []; let id = 0; let conc = 'success'; let guard = 'success';
  const owner = { tags: { 'product 1': TAG }, cleared };
  const fetchJson = async (path) => {
    if (path.endsWith('/contents/robot-merges-owner.json')) return { content: Buffer.from(JSON.stringify(owner)).toString('base64') };
    if (path.includes('/workflows/')) return { workflow_runs: runs.slice(0, 10).map(({ c: _c, g: _g, ...r }) => r) };
    const r = runs.find((x) => x.id === Number(/\/runs\/(\d+)\/jobs/.exec(path)[1]));
    const steps = [{ name: 'product 1 / robot-merges', conclusion: r.c }];
    if (r.g !== null) steps.push({ name: 'product 1 / repo-guard', conclusion: r.g });
    return { jobs: [{ name: 'check', steps }] };
  };
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  const productNames = { 'product 1': { product: 'real-product', tag: TAG } };
  let noPush = () => ({ green: true, at: new Date(t).toISOString() });
  return {
    run: () => { t += 60 * 60e3; const bad = conc !== 'success' || guard !== 'success'; runs.unshift({ id: ++id, created_at: new Date(t - 60e3).toISOString(), status: 'completed', conclusion: bad ? 'failure' : 'success', c: conc, g: guard }); },
    pass: () => watchOutside({ fetchJson, repo: 'o/c', homeAlerts, productAlerts, writer, productNames, now: () => t }),
    gate: () => robotMergesGreen({ read: (i) => (i === NO_PUSH_FACT ? noPush() : rec.read('fact', i)?.doc), product: 'real-product', now: () => t }),
    fact: () => rec.read('fact', ROBOT_FACT('real-product'))?.doc,
    clearNow: () => { owner.cleared = { 'product 1': new Date(t).toISOString() }; },
    set: (c) => { conc = c; }, setGuard: (g) => { guard = g; }, setNoPush: (f) => { noPush = f; }, tick: (m) => { t += m * 60e3; }, now: () => t,
  };
}

// ---- MAT-A: a clear written before a later failure never opens the gate ----

test('0b-7 audit round 6 MAT-A: the set-up clear does not excuse a robot change that fails after it, once it ages out', async () => {
  const w = world({});
  w.run(); await w.pass();
  w.tick(5); w.clearNow();
  w.set('failure');
  for (let h = 0; h < 7 * 24; h++) { w.run(); await w.pass(); }
  w.set('success'); w.run(); await w.pass();
  assert.equal(w.gate().open, false, 'the change after the clear was never looked at');
  w.clearNow(); w.run(); await w.pass();
  assert.equal(w.gate().open, true, 'a clear after the newest red run opens it');
});

test('0b-7 audit round 6 MAT-A: a clear for change A does not excuse change B that fails after it', async () => {
  const w = world({});
  w.run(); await w.pass(); w.clearNow(); w.run(); await w.pass();
  assert.equal(w.gate().open, true);
  w.set('failure'); w.run(); await w.pass(); w.run(); await w.pass();
  assert.ok(w.fact().red_since);
  w.tick(5); w.clearNow();
  for (let h = 0; h < 7 * 24; h++) { w.run(); await w.pass(); }
  w.set('success'); w.run(); await w.pass();
  assert.equal(w.gate().open, false);
  assert.ok(w.fact().last_red_at);
});

// ---- MAT-B, MAT-C: masking ----

test('0b-7 audit round 6 MAT-B: values in a list or object under a secret name are masked at any depth', () => {
  const rec = memoryRecord();
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  const plain = 'hunter2'.repeat(2);
  writer.put('mb', { kind: 'fact.x', password: [plain], db_password: { value: FAKE.dbPassword, deeper: [{ x: plain }] }, client_secret: [FAKE.vercelClassic], tokens: { input: 12, note: plain } });
  const d = rec.read('fact', 'mb').doc;
  const all = JSON.stringify(d);
  for (const bad of [plain, FAKE.dbPassword, FAKE.vercelClassic]) assert.equal(all.includes(bad), false, 'masked');
  // fact.x has no shape, so under L25 the allow-list masks every value; the second layer alone does the same job.
  const two = makeMasker({ env: {} }).maskDeep({ password: [plain], db_password: { value: FAKE.dbPassword, deeper: [{ x: plain }] }, tokens: { input: 12, note: plain } });
  assert.equal(JSON.stringify(two).includes(plain), false);
  assert.equal(two.tokens.input, 12, 'a count under a count-like name is kept');
  assert.equal(two.tokens.note, '[REDACTED:named-key]');
});

test('0b-7 audit round 6 MAT-C: lower-case "<what>_key", passphrase and credentials are masked; our own ids are not', () => {
  const { maskDeep, maskSecrets } = makeMasker({ env: {} });
  const plain = 'hunter2'.repeat(2);
  for (const k of ['deploy_key', 'DEPLOY_KEY', 'encryption_key', 'signing_key', 'ssh-key', 'passphrase', 'credentials', 'credential']) {
    assert.equal(maskDeep({ [k]: plain })[k], '[REDACTED:named-key]', k);
  }
  for (const s of [`passphrase: ${plain}`, `signing_key=${plain}`, `credentials: ${plain}`]) assert.equal(maskSecrets(s).text.includes(plain), false, s);
  assert.deepEqual(maskDeep({ idempotency_key: 'push-1', key: 'product 1|alert|x', monkey: 'banana' }), { idempotency_key: 'push-1', key: 'product 1|alert|x', monkey: 'banana' });
});

// ---- L24: the outside repo's lock ----

const SELF = 'joe-example/outside-check';
function guardGh(o = {}) {
  const s = {
    collaborators: [{ login: 'Joe-Example', permissions: { admin: true, maintain: true, push: true, pull: true } }, { login: 'robot', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } }],
    keys: [{ id: 1, read_only: true }],
    rulesets: [{ id: 7 }],
    ruleset: { id: 7, target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }, { type: 'deletion' }, { type: 'non_fast_forward' }],
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] },
    probeStatus: 403,
    ...o,
  };
  const api = async (path) => {
    if (path === `/repos/${SELF}`) return { default_branch: 'main' };
    if (path.startsWith(`/repos/${SELF}/collaborators`)) { if (s.collaborators instanceof Error) throw s.collaborators; return s.collaborators; }
    if (path.startsWith(`/repos/${SELF}/keys`)) return s.keys;
    if (path.startsWith(`/repos/${SELF}/rulesets?`)) return s.rulesets;
    if (path === `/repos/${SELF}/rulesets/7`) return s.ruleset;
    throw Object.assign(new Error('x'), { status: 404 });
  };
  const probe = async () => s.probeStatus;
  return { api, probe, self: SELF, selfOwner: 'joe-example' };
}
const rs = (o) => ({ ruleset: { id: 7, target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }], bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], ...o } });

test('L24: a repo only its owner can push, with the default branch locked, passes', async () => {
  assert.deepEqual(await repoGuard(guardGh()), { ok: true, code: 'locked' });
  const line = (await runOne('repo-guard', 1, { products: null, ...guardGh() })).line;
  assert.equal(line, 'product 1 / repo-guard: ok locked', 'runs even when the product list is missing');
});

test('L24 planted: anyone else who can write, a writable deploy key, or a missing or weak lock → FAIL', async () => {
  const cases = [
    [{ collaborators: [{ login: 'joe-example', permissions: { admin: true, push: true } }, { login: 'robot', permissions: { admin: false, maintain: false, push: true } }] }, /others-can-write 1/],
    [{ collaborators: [{ login: 'joe-example', permissions: { admin: true, push: true } }, { login: 'mini-account', permissions: { admin: false, maintain: true, push: false } }] }, /others-can-write 1/],
    [{ collaborators: [{ login: 'joe-example', permissions: { admin: true, push: true } }, { login: 'x' }] }, /collaborators-unreadable/],
    [{ collaborators: Array.from({ length: 100 }, (_, i) => ({ login: `u${i}`, permissions: { push: false, admin: false } })) }, /collaborators-not-covered/],
    [{ keys: [{ id: 1, read_only: false }] }, /deploy-key-can-write/],
    [{ rulesets: [] }, /default-branch-not-locked/],
    [rs({ enforcement: 'evaluate' }), /default-branch-not-locked/],
    [rs({ rules: [{ type: 'update' }, { type: 'non_fast_forward' }] }), /default-branch-not-locked/],
    [rs({ rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: true } }, { type: 'deletion' }, { type: 'non_fast_forward' }] }), /default-branch-not-locked/],
    [rs({ bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }, { actor_id: 15368, actor_type: 'Integration' }] }), /default-branch-not-locked/],
    [rs({ bypass_actors: undefined }), /ruleset-unreadable/],
    [rs({ conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/ma*'] } } }), /default-branch-not-locked/],
    [rs({ conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } } }), /default-branch-not-locked/],
    [{ probeStatus: 422 }, /check-token-can-write/],
    [{ probeStatus: 500 }, /write-probe-unclear/],
  ];
  for (const [o, re] of cases) {
    const r = await runOne('repo-guard', 1, { products: [], ...guardGh(o) });
    assert.equal(r.ok, false, String(re)); assert.match(r.line, re);
    assert.match(r.line, /^product 1 \/ [a-z-]+: (ok|FAIL)( [a-z0-9 -]+)?$/, 'public line shape');
  }
  const unread = await runOne('repo-guard', 1, { products: [], ...guardGh({ collaborators: Object.assign(new Error('x'), { status: 403 }) }) });
  assert.equal(unread.line, 'product 1 / repo-guard: FAIL check-error 403');
  assert.equal((await runOne('repo-guard', 2, { products: [], ...guardGh() })).ok, false, 'only slot 1');
  assert.equal((await runOne('repo-guard', 1, { products: [], ...guardGh(), self: undefined })).ok, false, 'unknown self');
});

test('L24: the write probe reads 403/404 as no-write, 422 as can-write, anything else as unknown', async () => {
  for (const [st, want] of [[403, 'no-write'], [404, 'no-write'], [422, 'can-write'], [201, 'unknown'], [500, 'unknown'], [undefined, 'unknown']]) {
    assert.equal(await writeProbe(async () => st, 'o/r'), want, String(st));
  }
  assert.equal(await writeProbe(async () => { throw new Error('net'); }, 'o/r'), 'unknown');
  let sent;
  await writeProbe(async (p, b) => { sent = [p, b]; return 403; }, 'o/r');
  assert.equal(sent[0], '/repos/o/r/git/refs'); assert.match(sent[1].sha, /^0{40}$/);
});

test('L24 planted: a failed or missing repo guard keeps the robot-merges result red; failures count toward the latch', async () => {
  const w = world({}); w.run(); await w.pass(); w.clearNow(); w.run(); await w.pass();
  assert.equal(w.gate().open, true);
  w.setGuard('failure'); w.run(); await w.pass();
  assert.equal(w.gate().open, false); assert.match(w.fact().reason, /repo guard failed/);
  w.run(); await w.pass();
  assert.ok(w.fact().red_since, 'two failed guard runs latch');
  w.setGuard('success'); w.run(); await w.pass();
  assert.equal(w.gate().open, false, 'stays shut until a clear');
  const m = world({}); m.run(); await m.pass(); m.clearNow(); m.run(); await m.pass();
  m.setGuard(null); m.run(); await m.pass();
  assert.equal(m.gate().open, false); assert.match(m.fact().reason, /no repo-guard step/);
});

test('L24 planted: the gate needs the Mini\'s no-write fact green and under 2 hours old', async () => {
  const w = world({}); w.run(); await w.pass(); w.clearNow(); w.run(); await w.pass();
  assert.equal(w.gate().open, true);
  w.setNoPush(() => null); assert.equal(w.gate().open, false);
  w.setNoPush(() => ({ green: false, reason: 'mini: can-write', at: new Date(w.now()).toISOString() })); assert.match(w.gate().problems.join(), /can-write/);
  w.setNoPush(() => ({ green: true, at: new Date(w.now() - 3 * 3600e3).toISOString() })); assert.equal(w.gate().open, false);
  w.setNoPush(() => ({ green: true, at: new Date(w.now() + 3600e3).toISOString() })); assert.equal(w.gate().open, false);
  w.setNoPush(() => { throw new Error('x'); }); assert.equal(w.gate().open, false);
});

test('L24: checkNoPush is red with no tokens or any token that can write or can\'t be told; green only when all read no-write', async () => {
  const rec = memoryRecord(); const gh = fakeIssues();
  const homeAlerts = makeAlerts({ rec, gh, owner: 'o', now: () => new Date(1e12) });
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  const run = (tokens) => checkNoPush({ tokens, repo: 'o/c', writer, homeAlerts, writeProbe, now: () => 1e12 });
  const fact = () => rec.read('fact', NO_PUSH_FACT).doc;
  await run([]); assert.equal(fact().green, false);
  await run([{ name: 'mini main', probe: async () => 403 }, { name: 'robot', probe: async () => 422 }]);
  assert.equal(fact().green, false); assert.match(fact().reason, /robot answered can-write/);
  assert.equal([...gh.issues.values()].filter((i) => !i.closed).length, 1);
  await run([{ name: 'mini main', probe: async () => 500 }]); assert.match(fact().reason, /unknown/);
  await run([{ name: 'mini main', probe: async () => 403 }, { name: 'robot', probe: async () => 404 }]);
  assert.equal(fact().green, true);
  assert.equal([...gh.issues.values()].filter((i) => !i.closed).length, 0, 'alert closed');
});

test('L24: keep-alive commits to the keep-alive branch, never the default branch, creating it when missing', async () => {
  const NOW = Date.parse('2026-11-03T12:00:00Z');
  const mk = (days, sideExists) => {
    const calls = [];
    const api = async (m, p, b) => {
      calls.push([m, p, b]);
      if (m !== 'GET') return {};
      if (p === '') return { default_branch: 'main' };
      if (p.startsWith('/commits?sha=main')) return [{ sha: 'a'.repeat(40), commit: { committer: { date: new Date(NOW - days * 86400e3).toISOString() } } }];
      if (p.startsWith('/commits?sha=keep-alive')) { if (!sideExists) throw new Error('404'); return [{ sha: 'b'.repeat(40), commit: { committer: { date: new Date(NOW - days * 86400e3).toISOString() } } }]; }
      throw new Error('404');
    };
    return { api, calls };
  };
  const fresh = mk(51, false);
  assert.equal((await keepAlive({ api: fresh.api, now: () => NOW })).committed, true);
  const writes = fresh.calls.filter(([m]) => m !== 'GET');
  assert.deepEqual(writes.map(([m, p]) => [m, p]), [['POST', '/git/refs'], ['PUT', '/contents/keepalive.txt']]);
  assert.equal(writes[0][2].ref, 'refs/heads/keep-alive');
  assert.equal(writes[1][2].branch, 'keep-alive');
  const existing = mk(51, true);
  await keepAlive({ api: existing.api, now: () => NOW });
  assert.deepEqual(existing.calls.filter(([m]) => m !== 'GET').map(([m]) => m), ['PUT']);
  assert.equal(existing.calls.find(([m]) => m === 'PUT')[2].branch, 'keep-alive');
});
