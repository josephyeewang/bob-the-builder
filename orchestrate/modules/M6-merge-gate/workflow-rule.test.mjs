// workflow-rule.test.mjs — every product workflow read-only but the audit; each rule a planted workflow (R-0b-92). Run:
// node --test orchestrate/modules/M6-merge-gate/workflow-rule.test.mjs

import { tempDir } from '../../shared/test-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';
import { checkWorkflow, checkWorkflows, checkWorkflowDir } from './workflow-rule.mjs';

const AUDIT = { path: '.github/workflows/audit.yml', permissions: { contents: 'read', statuses: 'write', 'pull-requests': 'write' } };
const TEST_PATH = '.github/workflows/test.yml';

// A read-only test workflow; each case swaps one piece.
function wf({ on = 'on:\n  pull_request:\n', perms = 'permissions:\n  contents: read\n', job = '', checkout = '        with:\n          persist-credentials: false\n', run = '      - run: npm test\n' } = {}) {
  return `name: test\n${on}${perms}jobs:\n  test:\n    runs-on: ubuntu-latest\n${job}    steps:\n      - uses: actions/checkout@v4\n${checkout}${run}`;
}
const check = (text, path = TEST_PATH, extra = {}) => checkWorkflow({ path, text, auditWorkflow: AUDIT, ...extra });
const fails = (r, re) => { assert.equal(r.ok, false); assert.ok(r.problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(r.problems)}`); };

test('the gap: yaml-lite alone refuses flow maps, so the rule expands one-line flow maps first', () => {
  assert.throws(() => parseYaml('permissions: {}\n'), /flow maps/);
  assert.throws(() => parseYaml('with: { persist-credentials: false }\n'), /flow maps/);
  // ...and the rule reads both forms.
  assert.deepEqual(check(wf({ perms: 'permissions: {}\n' })), { ok: true });
  assert.deepEqual(check(wf({ checkout: '        with: { fetch-depth: 0, persist-credentials: false }\n' })), { ok: true });
  // A flow map it can't split simply stays unreadable, which fails.
  fails(check(wf({ perms: 'permissions: { contents: { x: read } }\n' })), /unreadable workflow/);
  fails(check(wf({ perms: '"permissions": read-all\n' })), /unreadable workflow/);
});

test('read-only forms pass: read-all, {}, all read or none', () => {
  for (const perms of ['permissions: read-all\n', 'permissions: {}\n', 'permissions:\n  contents: read\n  issues: none\n', 'permissions: { contents: read, checks: none }\n']) {
    assert.deepEqual(check(wf({ perms })), { ok: true }, perms);
  }
});

test('no top-level permissions fails; any write, top level or a job, fails', () => {
  fails(check(wf({ perms: '' })), /no top-level permissions/);
  fails(check(wf({ perms: 'permissions:\n  contents: write\n' })), /top level asks for write \(contents\)/);
  fails(check(wf({ perms: 'permissions: write-all\n' })), /asks for write \(write-all\)/);
  fails(check(wf({ job: '    permissions:\n      pull-requests: write\n' })), /job test asks for write \(pull-requests\)/);
  fails(check(wf({ perms: 'permissions:\n  contents: admin\n' })), /odd level/);
  fails(check(wf({ perms: 'permissions: everything\n' })), /are not read-all/);
});

test('the audit workflow must have exactly the rules\' permissions, no more, no fewer', () => {
  const exact = 'permissions:\n  contents: read\n  pull-requests: write\n  statuses: write\n';
  const audit = (perms, rest = {}) => check(wf({ perms, checkout: '', ...rest }), AUDIT.path);
  assert.deepEqual(audit(exact), { ok: true });
  assert.deepEqual(audit('permissions: { statuses: write, pull-requests: write, contents: read }\n'), { ok: true });
  fails(audit(`${exact}  issues: write\n`), /must be exactly/);
  fails(audit('permissions:\n  contents: read\n  statuses: write\n'), /must be exactly/);
  fails(audit('permissions:\n  contents: write\n  pull-requests: write\n  statuses: write\n'), /must be exactly/);
  fails(audit('permissions: write-all\n'), /must be exactly/);
  fails(audit(exact, { job: '    permissions:\n      actions: write\n' }), /beyond the audit's own set/);
  assert.deepEqual(audit(exact, { job: '    permissions:\n      contents: read\n' }), { ok: true });
  // The same text under another name is an ordinary workflow, so its write fails.
  fails(check(wf({ perms: exact })), /asks for write/);
  // A bad audit rule fails every file.
  fails(checkWorkflow({ path: TEST_PATH, text: wf(), auditWorkflow: { path: 'audit.yml', permissions: {} } }), /names no workflow path/);
  fails(checkWorkflow({ path: TEST_PATH, text: wf() }), /no audit workflow rule/);
});

test('pull_request_target or workflow_run in any form fails, even in the audit workflow', () => {
  for (const t of ['pull_request_target', 'workflow_run']) {
    fails(check(wf({ on: `on: ${t}\n` })), new RegExp(t));
    fails(check(wf({ on: `on: [push, ${t}]\n` })), new RegExp(t));
    fails(check(wf({ on: `on:\n  ${t}:\n    types: [completed]\n` })), new RegExp(t));
    fails(check(wf({ on: `on:\n  - ${t}\n`, perms: 'permissions:\n  contents: read\n  pull-requests: write\n  statuses: write\n', checkout: '' }), AUDIT.path), new RegExp(t));
  }
});

test('issue_comment or issues with write fails; the audit file passes only with its exact set', () => {
  for (const t of ['issue_comment', 'issues']) {
    fails(check(wf({ on: `on:\n  ${t}:\n    types: [created]\n`, perms: 'permissions:\n  issues: write\n' })), new RegExp(`started by ${t} and asks for write`));
    assert.deepEqual(check(wf({ on: `on: ${t}\n`, perms: 'permissions: read-all\n' })), { ok: true });
    const exact = 'permissions:\n  contents: read\n  pull-requests: write\n  statuses: write\n';
    assert.deepEqual(check(wf({ on: `on: ${t}\n`, perms: exact, checkout: '' }), AUDIT.path), { ok: true });
    fails(check(wf({ on: `on: ${t}\n`, perms: `${exact}  issues: write\n`, checkout: '' }), AUDIT.path), new RegExp(`started by ${t}`));
  }
});

test('a checkout that keeps its key fails, except in the audit workflow', () => {
  fails(check(wf({ checkout: '' })), /keeps the checkout key/);
  fails(check(wf({ checkout: '        with:\n          persist-credentials: true\n' })), /keeps the checkout key/);
  fails(check(wf({ checkout: '        with:\n          persist-credentials: ${{ inputs.keep }}\n' })), /keeps the checkout key/);
  assert.deepEqual(check(wf({ checkout: '        with:\n          persist-credentials: "false"\n' })), { ok: true });
  const exact = 'permissions:\n  contents: read\n  pull-requests: write\n  statuses: write\n';
  assert.deepEqual(check(wf({ perms: exact, checkout: '' }), AUDIT.path), { ok: true });
});

test('outside text inside run: is script injection, in a plain or block script', () => {
  for (const ex of ['github.event.issue.body', 'github.event.issue.title', 'github.event.comment.body', 'github.event.pull_request.title',
    'github.event.pull_request.body', 'github.head_ref', 'github.event.pull_request.head.ref', "github.event['issue']['body']", 'GITHUB.EVENT.ISSUE.BODY']) {
    fails(check(wf({ run: `      - run: echo "\${{ ${ex} }}"\n` })), /script injection/);
    fails(check(wf({ run: `      - name: greet\n        run: |\n          echo start\n          # still the script\n          echo "\${{${ex}}}"\n` })), /script injection/);
  }
  fails(check(wf({ run: '      - uses: actions/github-script@v7\n        with:\n          script: console.log("${{ github.event.comment.body }}")\n' })), /script injection/);
  // Passing it through an environment variable is the safe form.
  assert.deepEqual(check(wf({ run: '      - env:\n          BODY: ${{ github.event.issue.body }}\n        run: echo "$BODY"\n' })), { ok: true });
});

test('a secret outside a schedule, dispatch or push-to-main workflow fails', () => {
  const run = '      - run: deploy\n        env:\n          KEY: ${{ secrets.PROD_KEY }}\n';
  fails(check(wf({ run })), /a secret outside/);
  fails(check(wf({ run, on: 'on: push\n' })), /a secret outside/);
  fails(check(wf({ run, on: 'on:\n  push:\n    branches: [main, dev]\n' })), /a secret outside/);
  fails(check(wf({ run, on: 'on:\n  push:\n    branches: [main]\n    tags: [v1]\n' })), /a secret outside/);
  fails(check(wf({ run, on: 'on:\n  push:\n    branches: [main]\n  pull_request:\n' })), /a secret outside/);
  fails(check(wf({ run: "      - run: x\n        env:\n          ALL: ${{ toJSON(secrets) }}\n", on: 'on: pull_request\n' })), /a secret outside/);
  for (const on of ['on:\n  push:\n    branches: [main]\n', 'on:\n  push:\n    branches: main\n', 'on:\n  schedule:\n    - cron: "0 6 * * *"\n  workflow_dispatch:\n', 'on: [schedule, workflow_dispatch]\n']) {
    assert.deepEqual(check(wf({ run, on })), { ok: true }, on);
  }
  // GITHUB_TOKEN is not a production secret; a narrower allowed list is honoured.
  assert.deepEqual(check(wf({ run: '      - run: x\n        env:\n          T: ${{ secrets.GITHUB_TOKEN }}\n' })), { ok: true });
  fails(check(wf({ run, on: 'on: schedule\n' }), TEST_PATH, { secretsAllowedTriggers: ['workflow_dispatch'] }), /a secret outside/);
});

test('a path outside .github/workflows, or not .yml/.yaml, is not a workflow; odd input fails, never throws', () => {
  for (const path of ['workflows/test.yml', '.github/workflows/test.json', '.github/workflows/sub/test.yml', '.github/workflows/../x.yml', null]) {
    fails(check(wf(), path), /not a workflow file/);
  }
  assert.deepEqual(check(wf(), '.github/workflows/test.yaml'), { ok: true });
  fails(check(null), /no workflow text/);
  fails(check('jobs: {}\n'), /no trigger/);
  fails(check('on: push\npermissions: read-all\n'), /no jobs map/);
  fails(check(`${wf()}\tbad: tab\n`), /unreadable/);
  fails(check(wf({ job: '    __proto__:\n      x: y\n' })), /__proto__/);
  fails(check(''), /reserved/);
  assert.equal(checkWorkflow().ok, false);
});

test('checkWorkflows lists each file\'s problems, and a missing audit workflow; checkWorkflowDir reads a folder', () => {
  const exact = 'permissions:\n  contents: read\n  pull-requests: write\n  statuses: write\n';
  const good = [{ path: AUDIT.path, text: wf({ perms: exact, checkout: '' }) }, { path: TEST_PATH, text: wf() }];
  assert.deepEqual(checkWorkflows(good, AUDIT), { ok: true, problems: [] });
  const r = checkWorkflows([good[1], { path: '.github/workflows/bad.yml', text: wf({ perms: '' }) }], AUDIT);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.path === '.github/workflows/bad.yml' && /no top-level permissions/.test(p.problem)));
  assert.ok(r.problems.some((p) => p.path === AUDIT.path && /missing/.test(p.problem)));
  assert.equal(checkWorkflows('nope', AUDIT).ok, false);

  const dir = join(tempDir('m6-wfdir-'), 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'audit.yml'), good[0].text);
  writeFileSync(join(dir, 'test.yml'), good[1].text);
  writeFileSync(join(dir, 'notes.md'), 'not a workflow');
  assert.deepEqual(checkWorkflowDir(dir, AUDIT), { ok: true, problems: [] });
  symlinkSync(join(dir, 'test.yml'), join(dir, 'linked.yml'));
  const linked = checkWorkflowDir(dir, AUDIT);
  assert.equal(linked.ok, false);
  assert.ok(linked.problems.some((p) => /a link/.test(p.problem)));
  assert.equal(checkWorkflowDir(join(dir, 'nope'), AUDIT).ok, false);
});
