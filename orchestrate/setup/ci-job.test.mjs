// ci-job.test.mjs — the setup commands need a Mac's own tools, so the Linux check skips those tests ("needs macOS tools;
// run by the macOS job"). That is only safe while the macOS job exists and runs them: this test fails if it goes missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '../../.github/workflows/scripts-ci.yml');

/** The text of each job in the workflow (a job starts at two spaces and a name, under `jobs:`). */
export function jobsOf(text) {
  const rest = text.split(/^jobs:\s*$/m)[1] ?? '';
  const out = {};
  let name = null;
  for (const line of rest.split('\n')) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; } else if (name) out[name] += `${line}\n`;
  }
  return out;
}

test('a macOS job runs every setup test; the Linux check cannot be the only place they run', () => {
  const jobs = jobsOf(readFileSync(WORKFLOW, 'utf8'));
  const macJobs = Object.entries(jobs).filter(([, body]) => /^\s+runs-on:\s*macos-/m.test(body));
  assert.ok(macJobs.length > 0, 'scripts-ci.yml has no macOS job: the tests that need the Mac\'s tools would be skipped everywhere');
  assert.ok(macJobs.some(([, body]) => /node --test[^\n]*orchestrate\/setup\//.test(body)), 'no macOS job runs `node --test` over orchestrate/setup/');
});

test('PLANT the macOS job removed or pointed at another folder → the check above fails', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const noMac = text.replace(/macos-latest/g, 'ubuntu-latest');
  const macJobs = (t) => Object.values(jobsOf(t)).filter((b) => /^\s+runs-on:\s*macos-/m.test(b) && /node --test[^\n]*orchestrate\/setup\//.test(b));
  assert.equal(macJobs(text).length > 0, true);
  assert.equal(macJobs(noMac).length, 0, 'a workflow with no Mac runner passes the guard');
  assert.equal(macJobs(text.replace('orchestrate/setup/*.test.mjs', 'orchestrate/shared/')).length, 0, 'a Mac job over another folder passes the guard');
});

// The temp folder the ORCHESTRATE tests run with (L257 (A), audit #144 M1 and r2 n2). The job-config reader refuses a
// world-writable folder or one under an access list, so CI makes /orch-tmp (its user's own, 0755), refuses to go on if
// / or /orch-tmp carries an access list, and runs the tests with TMPDIR=/orch-tmp. Deleting the access-list check, or
// the TMPDIR, passed every test before this one.
const ORCH_TESTS = /^\s+run: (.*)node --test \$\(find orchestrate -name '\*\.test\.mjs'\)\s*$/m;
const MAKE_TMP = /sudo install -d -o "\$\(id -u\)" -g "\$\(id -g\)" -m 0755 \/orch-tmp/;
const ACL_CHECK = /if ls -ld \/ \/orch-tmp \| awk '\{print \$1\}' \| grep -q '\+'; then [^\n]*exit 1; fi/;
/** What is wrong with the temp folder the ORCHESTRATE tests run with, in the workflow `text` ([] when it is right). */
export function orchTmpProblems(text) {
  const job = Object.entries(jobsOf(text)).find(([, body]) => ORCH_TESTS.test(body));
  if (!job) return ['no job runs ORCHESTRATE\'s tests'];
  const [name, body] = job;
  const out = [];
  const run = ORCH_TESTS.exec(body);
  if (run[1] !== 'TMPDIR=/orch-tmp ') out.push(`${name}: the ORCHESTRATE tests do not run with TMPDIR=/orch-tmp`);
  const at = run.index;
  const make = body.search(MAKE_TMP);
  if (make < 0 || make > at) out.push(`${name}: no step makes /orch-tmp (its user's own, 0755) before the tests`);
  const acl = body.search(ACL_CHECK);
  if (acl < 0 || acl > at) out.push(`${name}: no step refuses an access list on / or /orch-tmp before the tests`);
  return out;
}

test('audit #144 r2 n2: the ORCHESTRATE tests run with TMPDIR=/orch-tmp, made and checked for an access list first', () => {
  assert.deepEqual(orchTmpProblems(readFileSync(WORKFLOW, 'utf8')), []);
});

test('PLANT audit #144 r2 n2: the access-list check deleted, the TMPDIR dropped or changed, the folder not made, or made after → fails', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const lines = text.split('\n');
  const without = (re) => lines.filter((l) => !re.test(l)).join('\n');
  const [job] = Object.keys(jobsOf(text)).filter((n) => ORCH_TESTS.test(jobsOf(text)[n]));
  assert.deepEqual(orchTmpProblems(without(/grep -q '\+'/)), [`${job}: no step refuses an access list on / or /orch-tmp before the tests`]);
  assert.deepEqual(orchTmpProblems(text.replace('TMPDIR=/orch-tmp node --test', 'node --test')), [`${job}: the ORCHESTRATE tests do not run with TMPDIR=/orch-tmp`]);
  assert.deepEqual(orchTmpProblems(text.replace('TMPDIR=/orch-tmp node --test', 'TMPDIR=/tmp node --test')), [`${job}: the ORCHESTRATE tests do not run with TMPDIR=/orch-tmp`]);
  assert.deepEqual(orchTmpProblems(without(/sudo install -d .*\/orch-tmp/)), [`${job}: no step makes /orch-tmp (its user's own, 0755) before the tests`]);
  assert.deepEqual(orchTmpProblems(text.replace('-m 0755 /orch-tmp', '-m 1777 /orch-tmp')), [`${job}: no step makes /orch-tmp (its user's own, 0755) before the tests`]);
  // The tests step moved ahead of the folder's step.
  const i = lines.findIndex((l) => /- name: A temp folder only this job's user can write/.test(l));
  const j = lines.findIndex((l) => /- name: ORCHESTRATE's tests/.test(l));
  assert.ok(i >= 0 && j === i + 8, 'the two steps as the workflow has them (the folder step is 8 lines, then the tests)');
  const swapped = [...lines.slice(0, i), ...lines.slice(j, j + 2), ...lines.slice(i, j), ...lines.slice(j + 2)].join('\n');
  assert.deepEqual(orchTmpProblems(swapped), [`${job}: no step makes /orch-tmp (its user's own, 0755) before the tests`, `${job}: no step refuses an access list on / or /orch-tmp before the tests`]);
});
