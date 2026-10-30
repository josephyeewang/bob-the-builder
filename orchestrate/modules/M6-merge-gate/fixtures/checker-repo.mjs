// checker-repo.mjs — a planted product repository for the GitHub-side checker's tests (checker-entry, the bundle).
// Built on M10's fake repo; the routes M10's fake doesn't answer (statuses, full pull requests, reviews, Actions runs)
// come from checker-fake.mjs. Tests only.
//
//   const p = plantedRepo({ withRules = true });
//   const { m, head } = p.merge({ 'docs/research/a.md': 'two' }, { marked, needsJoe, tier, reviews, body, parent, pr });
//   p.auditRun(commit, 'flagged' | 'passed');   p.args(m) → runChecker's arguments
//   p.approve(head) → a review list with the owner's approval of that head

import { readFileSync } from 'node:fs';
import { fakeRepo } from '../../M10-rules/fixtures/fake-repo.mjs';
import { withRoutes, markRoutes } from './checker-fake.mjs';

export const ROBOT = 4242;
export const OWNER = 1000001;
export const WF = '.github/workflows/audit.yml';
export const POLICY = readFileSync(new URL('../../M10-rules/fixtures/policy.yaml', import.meta.url), 'utf8');
const owner = 'sample-org';
const repo = 'sample-app';
const base = `/repos/${owner}/${repo}`;

export function plantedRepo({ withRules = true } = {}) {
  const r = fakeRepo({ owner, repo });
  const routes = withRoutes(r);
  const root = r.commit([], { ...(withRules ? { 'orchestrate/policy.yaml': POLICY } : {}), 'docs/research/a.md': 'one', 'lib/x.ts': 'x' });
  r.main = root;
  let runId = 50;

  const needsJoeStatus = (value, tier) => ({ context: 'orchestrate/needs-joe', state: 'success', creator: { id: ROBOT, type: 'Bot' },
    description: `needs-joe: ${value}; declared tier: ${tier}` });

  function merge(changes, { parent = r.main, pr = 7, marked = true, needsJoe = 'false', tier = 2, reviews = [], body = '', labels = [] } = {}) {
    const head = r.commit([parent], changes);
    const m = r.commit([parent, head], {}, { from: head });
    const statuses = needsJoe === null ? [] : [needsJoeStatus(needsJoe, tier)];
    if (marked) Object.assign(routes, markRoutes({ owner, repo, sha: m, head, pr, robotBotId: ROBOT, statuses, body, labels }));
    else {
      routes[`${base}/commits/${m}/statuses?per_page=100`] = statuses;
      routes[`${base}/commits/${m}/pulls?per_page=100`] = [];
    }
    routes[`${base}/pulls/${pr}/reviews?per_page=100`] = reviews;
    r.main = m;
    return { m, head };
  }

  function auditRun(commit, result) {
    const id = ++runId;
    const verdict = result === 'flagged' ? 'failure' : 'success';
    routes[`${base}/actions/runs?head_sha=${commit}&per_page=100`] = { total_count: 1, workflow_runs: [{ id, path: WF, head_branch: 'main', head_sha: commit }] };
    routes[`${base}/actions/runs/${id}`] = { id, path: WF, head_sha: commit, head_branch: 'main', status: 'completed', conclusion: verdict };
    routes[`${base}/actions/runs/${id}/jobs?per_page=100`] = { total_count: 1, jobs: [{ steps: [
      { name: 'fetch', number: 1, conclusion: 'success' }, { name: 'verdict', number: 2, conclusion: verdict }] }] };
  }

  const approve = (head) => [{ user: { id: OWNER, type: 'User' }, state: 'APPROVED', commit_id: head }];
  const args = (sha) => ({ gh: r.gh, owner, repo, sha, robotBotId: ROBOT, ownerId: OWNER, workflowPath: WF });
  return { r, routes, root, merge, auditRun, approve, args };
}
