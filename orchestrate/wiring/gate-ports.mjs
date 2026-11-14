// gate-ports.mjs — the start gate's two live ports for the robot's push (lane N, N1; LEAD-CALLS L1079 Q2): fact 1's
// `readRun` and fact 2's `workflowRule` (M4 start-gate.mjs). Until these, both were missing outside tests, so the gate
// stayed shut for every product.
//
//   publicJson({ fetchFn?, timeoutMs? }) → (path) → JSON         keyless GET on api.github.com; a non-200 throws
//   outsideRun({ getJson, repo, workflowPath, slot, tag, product }) → async () → run | null
//   productWorkflowRule({ rules, product }) → ({ path, text }) → { ok: true } | { ok: false, reason }
//
// FACT 1 (readRun). The outside check (M13 outside-check/) runs hourly on GitHub in its own public repo, one step per
// product slot and check: "product N / permissions" is the step that checks the repo's Actions default is read-only.
// This reads, with no key:
//   1. the pinned workflow's newest finished runs on main; the newest whose event is scheduled or manual is the run
//      (none such: the newest finished run, so the gate says why it doesn't count; none at all: null, the gate shuts);
//   2. that run's steps;
//   3. the outside repo's robot-merges-owner.json `tags`, so the slot counts only when its public tag equals the one this
//      Mac's config gives for the product: a swapped or stale slot name can't open one product's gate on another's
//      green. The same binding M12 outside-watch.mjs uses for robot merges.
// The run's step for this product is a success only when "product N / permissions" succeeded AND, in the same run,
// "product 1 / repo-guard" did (lead call L24: a check whose own repo isn't locked proves nothing). Anything else is
// passed on as the step's own conclusion, or `missing`, `unbound` or `guard-<conclusion>`, so the gate shuts naming it.
// The gate itself (M4 actionsReadOnly) checks the run's path, event, branch and age, and reads at most once an hour.
// Endpoint shapes checked live on a public repo, 13 Nov 2026: a run's `path` is the bare workflow path, no `@ref`
// (Principle 9; revisit if GitHub's runs API changes).
//
// FACT 2 (workflowRule). M6 workflow-rule.mjs checkWorkflow, the one audit rule, with the product's own
// product_profile.audit_workflow from the rules, read fresh on every call. Its problems become the gate's reason.
// A rules value that can't be read is a problem, never "no audit workflow, so pass".

import { posix } from 'node:path';
import { checkWorkflow } from '../modules/M6-merge-gate/workflow-rule.mjs';
import { GUARD_STEP, OWNER_FILE } from '../modules/M12-sensors/outside-watch.mjs';
import { OUTSIDE_EVENTS } from '../modules/M4-workshop/git/start-gate.mjs';
import { pastTime } from '../shared/still-waiting.mjs';

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SLOT = /^product [1-9]$/;
export { GUARD_STEP };
export const PERMISSIONS_STEP = (slot) => `${slot} / permissions`;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

export function publicJson({ fetchFn = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  return async (path) => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) throw Object.assign(new Error(`GitHub answered ${res.status} to GET ${path.split('?')[0]}`), { status: res.status });
    return res.json();
  };
}

/** The setup problem with an outside-check slot, or null. Asked once at wiring, so a bad config refuses the pass. */
export function outsideProblem({ repo, workflowPath, slot, tag }) {
  if (typeof repo !== 'string' || !REPO.test(repo)) return 'outsideRepo must be owner/name';
  if (typeof workflowPath !== 'string' || !WORKFLOW_PATH.test(workflowPath)) return 'outsideWorkflow must be .github/workflows/<name>.yml';
  if (typeof slot !== 'string' || !SLOT.test(slot)) return 'outsideSlot must be "product N" (1-9)';
  if (typeof tag !== 'string' || !/^[a-z0-9]{8,32}$/.test(tag)) return 'outsideTag must be the slot\'s 8–32 letter or digit tag';
  return null;
}

export function outsideRun({ getJson, repo, workflowPath, slot, tag, product }) {
  const bad = outsideProblem({ repo, workflowPath, slot, tag });
  if (bad) throw new Error(`the outside check's run reader: ${bad}`);
  if (typeof product !== 'string' || !product) throw new Error('the outside check\'s run reader: no product');
  const file = encodeURIComponent(posix.basename(workflowPath));
  return async () => {
    const list = await getJson(`/repos/${repo}/actions/workflows/${file}/runs?branch=main&status=completed&per_page=20`);
    const runs = Array.isArray(list?.workflow_runs) ? list.workflow_runs.filter((r) => r && typeof r === 'object') : null;
    if (!runs || runs.length === 0) return null;
    const at = (r) => pastTime(r.created_at, Infinity) || 0; // I4: any readable time (a sort, not a wait); unreadable sorts last
    const byNew = [...runs].sort((a, b) => at(b) - at(a));
    const run = byNew.find((r) => OUTSIDE_EVENTS.includes(r.event)) ?? byNew[0];
    if (!Number.isSafeInteger(run.id)) return null;
    const jobs = await getJson(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=10`);
    if (!Array.isArray(jobs?.jobs)) return null;
    const steps = jobs.jobs.flatMap((j) => (Array.isArray(j?.steps) ? j.steps : []));
    const step = (name) => steps.find((s) => s?.name === name);
    let tags = null;
    try {
      const c = await getJson(`/repos/${repo}/contents/${OWNER_FILE}`);
      tags = JSON.parse(Buffer.from(String(c?.content ?? ''), 'base64').toString('utf8'))?.tags ?? null;
    } catch { tags = null; }
    const perm = step(PERMISSIONS_STEP(slot));
    const guard = step(GUARD_STEP);
    const conclusion = tags?.[slot] !== tag ? 'unbound'
      : !perm ? 'missing'
        : perm.conclusion !== 'success' ? String(perm.conclusion ?? 'unknown')
          : guard?.conclusion !== 'success' ? `guard-${guard ? String(guard.conclusion ?? 'unknown') : 'missing'}`
            : 'success';
    return { workflow_path: run.path, event: run.event, head_branch: run.head_branch, run_at: run.created_at, steps: [{ product, conclusion }] };
  };
}

export function productWorkflowRule({ rules, product }) {
  if (typeof rules?.get !== 'function') throw new Error('the workflow rule port has no rules');
  return ({ path, text }) => {
    let auditWorkflow;
    try { auditWorkflow = rules.get('product_profile.audit_workflow', { product }); } catch (e) {
      return { ok: false, reason: `the rules' audit workflow could not be read: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    const r = checkWorkflow({ path, text, auditWorkflow });
    return r.ok === true ? { ok: true } : { ok: false, reason: (Array.isArray(r.problems) ? r.problems : ['no answer']).join('; ').slice(0, 400) };
  };
}
