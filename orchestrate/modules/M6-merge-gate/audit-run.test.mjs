// audit-run.test.mjs — only a failed `verdict` step after clean earlier steps is a flag; only a genuine flag makes a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, readAuditRun, undoIssueCounts } from './audit-run.mjs';
import { routeGh } from './fixtures/checker-fake.mjs';

const owner = 'sample-org';
const repo = 'sample-app';
const WF = '.github/workflows/audit.yml';
const C = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const RUN = 12345;
const opts = { workflowPath: WF, commit: C };

const run = (extra = {}) => ({ id: RUN, path: WF, head_sha: C, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', ...extra });
const steps = (...pairs) => pairs.map(([name, conclusion], i) => ({ name, conclusion, number: i + 1 }));
const flaggedJobs = () => [{ steps: steps(['Set up job', 'success'], ['fetch', 'success'], ['verdict', 'failure'], ['Post', 'success']) }];
const ghFor = (r, jobs) => routeGh({
  [`/repos/${owner}/${repo}/actions/runs/${RUN}`]: r,
  [`/repos/${owner}/${repo}/actions/runs/${RUN}/jobs?per_page=100`]: { total_count: jobs.length, jobs },
});
const issue = (extra = {}) => ({ number: 3, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `Audit flagged a merge.\nrun: ${RUN}\ncommit: ${C}\n`, ...extra });
const second = { cutoverStage: 'second', workflowPath: WF };

test('the verdict step failed after every earlier step succeeded: flagged', () => {
  assert.equal(classifyRun(run(), flaggedJobs(), opts), 'flagged');
});

test('a failed fetch step with the verdict skipped is could_not_run', () => {
  const jobs = [{ steps: steps(['Set up job', 'success'], ['fetch', 'failure'], ['verdict', 'skipped']) }];
  assert.equal(classifyRun(run(), jobs, opts), 'could_not_run');
  // An earlier step that failed while the verdict still "failed" is not a verdict either.
  const both = [{ steps: steps(['fetch', 'failure'], ['verdict', 'failure']) }];
  assert.equal(classifyRun(run(), both, opts), 'could_not_run');
});

test('cancelled, timed out, still running, or shapes missing: could_not_run', () => {
  for (const extra of [{ conclusion: 'cancelled' }, { conclusion: 'timed_out' }, { conclusion: 'skipped' }, { status: 'in_progress', conclusion: null }]) {
    assert.equal(classifyRun(run(extra), flaggedJobs(), opts), 'could_not_run', JSON.stringify(extra));
  }
  assert.equal(classifyRun(null, flaggedJobs(), opts), 'could_not_run');
  assert.equal(classifyRun(run(), null, opts), 'could_not_run');
  assert.equal(classifyRun(run(), [{}], opts), 'could_not_run');
  assert.equal(classifyRun(run({ path: undefined }), flaggedJobs(), opts), 'could_not_run');
  // Two steps named verdict: neither counts.
  assert.equal(classifyRun(run(), [...flaggedJobs(), { steps: steps(['verdict', 'failure']) }], opts), 'could_not_run');
  // The step name comes from the rules.
  assert.equal(classifyRun(run(), flaggedJobs(), { ...opts, flagStep: 'judge' }), 'could_not_run');
});

test('a successful run passes; another workflow, commit or branch is not this audit', () => {
  assert.equal(classifyRun(run({ conclusion: 'success' }), [], opts), 'passed');
  assert.equal(classifyRun(run({ path: '.github/workflows/other.yml' }), flaggedJobs(), opts), 'not_this_audit');
  assert.equal(classifyRun(run({ head_sha: OTHER }), flaggedJobs(), opts), 'not_this_audit');
  assert.equal(classifyRun(run({ head_branch: 'feature' }), flaggedJobs(), opts), 'not_this_audit');
});

test('readAuditRun reads the run and its jobs; an API error is not ok, and a cut-off job list is could_not_run', async () => {
  assert.deepEqual(await readAuditRun({ gh: ghFor(run(), flaggedJobs()), owner, repo, runId: RUN, ...opts }), { ok: true, result: 'flagged' });
  const down = ghFor(run(), flaggedJobs()); down.down = true;
  assert.equal((await readAuditRun({ gh: down, owner, repo, runId: RUN, ...opts })).ok, false);
  assert.equal((await readAuditRun({ gh: routeGh({}), owner, repo, runId: RUN, ...opts })).ok, false);
  const cut = ghFor(run(), flaggedJobs());
  cut.routes[`/repos/${owner}/${repo}/actions/runs/${RUN}/jobs?per_page=100`] = { total_count: 120, jobs: flaggedJobs() };
  assert.deepEqual(await readAuditRun({ gh: cut, owner, repo, runId: RUN, ...opts }), { ok: true, result: 'could_not_run' });
  assert.equal((await readAuditRun({ gh: cut, owner, repo, runId: '12a', ...opts })).ok, false);
});

test('a genuine flagged issue at the second cutover makes a card', async () => {
  const r = await undoIssueCounts({ gh: ghFor(run(), flaggedJobs()), owner, repo, issue: issue(), rules: second });
  assert.deepEqual(r, { card: true, commit: C, runId: RUN });
});

test('at the first cutover (or with no stage) even a genuine issue makes no card', async () => {
  for (const cutoverStage of ['first', undefined]) {
    const r = await undoIssueCounts({ gh: ghFor(run(), flaggedJobs()), owner, repo, issue: issue(), rules: { ...second, cutoverStage } });
    assert.equal(r.card, false);
    assert.match(r.notice, /first cutover/);
  }
});

test('an API error, another workflow, another commit or a passed run: a notice, not a card', async () => {
  const down = ghFor(run(), flaggedJobs()); down.down = true;
  const cases = [
    [down, issue()],
    [ghFor(run({ path: '.github/workflows/other.yml' }), flaggedJobs()), issue()],
    [ghFor(run({ head_sha: OTHER }), flaggedJobs()), issue()],
    [ghFor(run(), flaggedJobs()), issue({ body: `run: ${RUN}\ncommit: ${OTHER}` })],
    [ghFor(run({ conclusion: 'success' }), []), issue()],
    [ghFor(run({ conclusion: 'cancelled' }), flaggedJobs()), issue()],
  ];
  for (const [gh, iss] of cases) {
    const r = await undoIssueCounts({ gh, owner, repo, issue: iss, rules: second });
    assert.equal(r.card, false);
    assert.equal(typeof r.notice, 'string');
  }
});

test('an issue not opened by the Actions bot is a notice: a look-alike user, another bot, a collaborator', async () => {
  for (const user of [{ login: 'github-actions[bot]', type: 'User' }, { login: 'sample-robot[bot]', type: 'Bot' }, { login: 'a-collaborator', type: 'User' }]) {
    const r = await undoIssueCounts({ gh: ghFor(run(), flaggedJobs()), owner, repo, issue: issue({ user }), rules: second });
    assert.deepEqual([r.card, /Actions bot/.test(r.notice)], [false, true], JSON.stringify(user));
  }
});

test('the run and commit lines must each appear exactly once, exactly as written', async () => {
  for (const body of [`commit: ${C}`, `run: ${RUN}`, `run: ${RUN}\nrun: 999\ncommit: ${C}`, ` run: ${RUN}\ncommit: ${C}`, `run: ${RUN}\ncommit: ${C.slice(0, 7)}`]) {
    const r = await undoIssueCounts({ gh: ghFor(run(), flaggedJobs()), owner, repo, issue: issue({ body }), rules: second });
    assert.equal(r.card, false, body);
  }
});
