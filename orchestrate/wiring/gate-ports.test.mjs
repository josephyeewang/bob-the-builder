// gate-ports.test.mjs — the start gate's live ports (lane N; L1079 Q2): the outside check's run reader and the
// workflow rule, each driven through M4's own gate checks so the shapes are proved to meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsideRun, outsideProblem, productWorkflowRule, publicJson, GUARD_STEP } from './gate-ports.mjs';
import { actionsReadOnly } from '../modules/M4-workshop/git/start-gate.mjs';
import { OWNER_FILE } from '../modules/M12-sensors/outside-watch.mjs';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const WF = '.github/workflows/outside-check.yml';
const SLOT = { repo: 'owner-x/outside', workflowPath: WF, slot: 'product 2', tag: 'abcd1234', product: 'app' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

function api({ runs, steps, tags = { 'product 2': 'abcd1234' }, fail = {} }) {
  const asked = [];
  const getJson = async (path) => {
    asked.push(path);
    for (const [k, v] of Object.entries(fail)) if (path.includes(k)) throw Object.assign(new Error(`GitHub answered ${v}`), { status: v });
    if (path.includes('/runs?')) return { workflow_runs: runs };
    if (path.includes('/jobs')) return { jobs: [{ steps }] };
    if (path.includes(`/contents/${OWNER_FILE}`)) return { content: b64({ tags }) };
    throw new Error(`unexpected ${path}`);
  };
  return { getJson, asked };
}
const run = (o = {}) => ({ id: 11, path: WF, event: 'schedule', head_branch: 'main', created_at: '2026-11-13T11:30:00Z', status: 'completed', ...o });
const green = [{ name: 'product 2 / permissions', conclusion: 'success' }, { name: GUARD_STEP, conclusion: 'success' }];
const gate = (readRun) => actionsReadOnly({ product: 'app', readRun, workflowPath: WF, cache: {}, now: NOW });

test('fact 1 opens on the newest scheduled run with this slot\'s permissions step and the repo guard green, tag bound', async () => {
  const a = api({ runs: [run({ id: 9, created_at: '2026-11-13T10:30:00Z' }), run()], steps: green });
  const r = await outsideRun({ getJson: a.getJson, ...SLOT })();
  assert.deepEqual(r, { workflow_path: WF, event: 'schedule', head_branch: 'main', run_at: '2026-11-13T11:30:00Z', steps: [{ product: 'app', conclusion: 'success' }] });
  assert.match(a.asked[0], /^\/repos\/owner-x\/outside\/actions\/workflows\/outside-check\.yml\/runs\?branch=main&status=completed/);
  assert.match(a.asked[1], /\/runs\/11\/jobs/);
  assert.deepEqual(await gate(outsideRun({ getJson: a.getJson, ...SLOT })), { ok: true });
});

test('a push-event run newer than the scheduled one is not the run', async () => {
  const a = api({ runs: [run({ id: 12, event: 'push', created_at: '2026-11-13T11:50:00Z' }), run()], steps: green });
  const r = await outsideRun({ getJson: a.getJson, ...SLOT })();
  assert.equal(r.event, 'schedule');
  assert.match(a.asked[1], /\/runs\/11\//);
});

test('with only runs of other events, the newest is given so the gate says why it doesn\'t count', async () => {
  const a = api({ runs: [run({ event: 'push' })], steps: green });
  assert.match((await gate(outsideRun({ getJson: a.getJson, ...SLOT }))).reason, /scheduled or manual/);
});

test('the gate shuts, naming why, when the slot is unbound, the step failed or is missing, or the guard is not green', async () => {
  const cases = [
    [{ tags: { 'product 2': 'other999' } }, 'unbound'],
    [{ tags: null }, 'unbound'],
    [{ steps: [green[1]] }, 'missing'],
    [{ steps: [{ ...green[0], conclusion: 'failure' }, green[1]] }, 'failure'],
    [{ steps: [green[0]] }, 'guard-missing'],
    [{ steps: [green[0], { ...green[1], conclusion: 'failure' }] }, 'guard-failure'],
    [{ steps: [{ name: 'product 1 / permissions', conclusion: 'success' }, green[1]] }, 'missing'],
  ];
  for (const [o, want] of cases) {
    const a = api({ runs: [run()], steps: green, ...o });
    const r = await outsideRun({ getJson: a.getJson, ...SLOT })();
    assert.equal(r.steps[0].conclusion, want, JSON.stringify(o));
    assert.equal((await gate(outsideRun({ getJson: a.getJson, ...SLOT }))).ok, false);
  }
});

test('an owner file that can\'t be read leaves the slot unbound (the gate shuts)', async () => {
  const a = api({ runs: [run()], steps: green, fail: { contents: 404 } });
  assert.equal((await outsideRun({ getJson: a.getJson, ...SLOT })()).steps[0].conclusion, 'unbound');
});

test('runs or steps that can\'t be read: null or a throw, and the gate shuts (I1)', async () => {
  assert.equal(await outsideRun({ getJson: api({ runs: [], steps: green }).getJson, ...SLOT })(), null);
  assert.equal(await outsideRun({ getJson: async (p) => (p.includes('/runs?') ? { workflow_runs: [run()] } : { nope: 1 }), ...SLOT })(), null);
  assert.equal(await outsideRun({ getJson: async () => ({}), ...SLOT })(), null);
  const a = api({ runs: [run()], steps: green, fail: { '/runs?': 403 } });
  await assert.rejects(outsideRun({ getJson: a.getJson, ...SLOT })(), /403/);
  assert.match((await gate(outsideRun({ getJson: a.getJson, ...SLOT }))).reason, /could not be read/);
});

test('a bad slot setup is refused when the reader is made', () => {
  assert.equal(outsideProblem(SLOT), null);
  for (const [k, v] of [['repo', 'nope'], ['workflowPath', 'outside-check.yml'], ['slot', 'product 0'], ['slot', 'slot 1'], ['tag', 'short'], ['tag', 'UPPERCASE1']]) {
    assert.throws(() => outsideRun({ getJson: async () => ({}), ...SLOT, [k]: v }), /outside check/, `${k}=${v}`);
  }
  assert.throws(() => outsideRun({ getJson: async () => ({}), ...SLOT, product: '' }), /no product/);
});

test('publicJson sends no key and throws on anything but 200', async () => {
  const seen = [];
  const ok = publicJson({ fetchFn: async (url, init) => { seen.push([url, init.headers]); return { status: 200, json: async () => ({ a: 1 }) }; } });
  assert.deepEqual(await ok('/repos/a/b'), { a: 1 });
  assert.equal(seen[0][0], 'https://api.github.com/repos/a/b');
  assert.ok(!Object.keys(seen[0][1]).some((h) => /authorization/i.test(h)));
  const no = publicJson({ fetchFn: async () => ({ status: 404, json: async () => ({}) }) });
  await assert.rejects(no('/repos/a/b?x=1'), /404 to GET \/repos\/a\/b$/);
});

const AUDIT = { path: '.github/workflows/audit.yml', permissions: { contents: 'read' } };
const rulesWith = (v) => ({ get: (k, o) => { assert.equal(k, 'product_profile.audit_workflow'); assert.equal(o.product, 'app'); if (v instanceof Error) throw v; return v; } });

test('fact 2: the M6 rule with the product\'s audit workflow, its problems the reason', () => {
  const rule = productWorkflowRule({ rules: rulesWith(AUDIT), product: 'app' });
  assert.deepEqual(rule({ path: '.github/workflows/ci.yml', text: 'on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' }), { ok: true });
  const bad = rule({ path: '.github/workflows/ci.yml', text: 'on: pull_request_target\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.length > 0);
});

test('fact 2: no audit workflow in the rules, or rules that can\'t be read, fail every workflow (I1)', () => {
  const text = 'on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
  assert.match(productWorkflowRule({ rules: rulesWith(undefined), product: 'app' })({ path: '.github/workflows/ci.yml', text }).reason, /audit workflow/);
  assert.match(productWorkflowRule({ rules: rulesWith(new Error('rules gone')), product: 'app' })({ path: '.github/workflows/ci.yml', text }).reason, /rules gone/);
  assert.throws(() => productWorkflowRule({ rules: null, product: 'app' }), /no rules/);
});
