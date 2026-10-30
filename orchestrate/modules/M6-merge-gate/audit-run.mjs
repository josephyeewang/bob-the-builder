// audit-run.mjs — what a post-merge audit run said, and whether an issue may start an undo card (R3-M1, R2-M2).
//
// WHY. A red audit run is not the same as "the audit flagged this commit". A run can go red because a download
// failed, a runner died or someone cancelled it; treating that as a verdict would start undo cards for nothing (or let
// anyone who can open an issue start one). So the checker's verdict runs as ONE named step (the rules'
// product_profile.audit_workflow.flag_step, default `verdict`), and a run is FLAGGED only when the Actions API says that
// step concluded failure and every earlier step in its job concluded success. Any other red run is `could_not_run`:
// the owner gets a notice, no undo starts, and the commit stays undeployed until a rerun gives a verdict.
// An issue starts an undo card only when GitHub's Actions bot opened it, its body names the run and the commit, and
// that run is the declared audit workflow (product_profile.audit_workflow.path) on main for exactly that commit,
// flagged in the sense above. While the cutover stage is first (missing counts as first), no issue makes a card.
//
//   classifyRun(run, jobs, { flagStep = 'verdict', workflowPath, commit })
//     → 'passed' | 'flagged' | 'could_not_run' | 'not_this_audit'
//     run  = GitHub's workflow run JSON (path, head_sha, head_branch, status, conclusion)
//     jobs = the run's jobs list (each { steps: [{ name, number, conclusion }] })
//   await readAuditRun({ gh, owner, repo, runId, workflowPath, commit, flagStep }) → { ok: true, result } | { ok: false, reason }
//     An API error is { ok: false }; every caller treats that as could_not_run, never as a verdict.
//   await undoIssueCounts({ gh, owner, repo, issue, rules: { cutoverStage, workflowPath, flagStep } })
//     → { card: true, commit, runId } | { card: false, notice }
// `gh` is a GitHub client ({ get(path) } → { status, json }). Endpoint shapes from GitHub's REST docs (version
// 2022-11-28, read 30 Oct 2026; Principle 9: void on an API change): GET /actions/runs/{id} and /actions/runs/{id}/jobs.

export const DEFAULT_FLAG_STEP = 'verdict';
export const ACTIONS_BOT = 'github-actions[bot]';
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[1-9]\d{0,14}$/;   // 15 digits at most, so it stays an exact number
const RUN_LINE = /^run: ([1-9]\d{0,14})$/;
const COMMIT_LINE = /^commit: ([0-9a-f]{40})$/;
const str = (v) => typeof v === 'string' && v.length > 0;

export function classifyRun(run, jobs, { flagStep = DEFAULT_FLAG_STEP, workflowPath, commit } = {}) {
  try {
    if (!str(flagStep) || !str(workflowPath) || !SHA.test(commit ?? '')) return 'could_not_run';
    if (!run || typeof run !== 'object' || !str(run.path) || !str(run.head_sha) || !str(run.head_branch)) return 'could_not_run';
    if (run.path !== workflowPath || run.head_sha !== commit || run.head_branch !== 'main') return 'not_this_audit';
    if (run.status !== 'completed') return 'could_not_run';
    if (run.conclusion === 'success') return 'passed';
    if (run.conclusion !== 'failure') return 'could_not_run';      // cancelled, timed_out, skipped, neutral, …
    if (!Array.isArray(jobs)) return 'could_not_run';
    // Exactly one step in the whole run carries the verdict's name; two would let one stand in for the other.
    const hits = [];
    for (const job of jobs) {
      if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) return 'could_not_run';
      for (const s of job.steps) if (s?.name === flagStep) hits.push({ job, step: s });
    }
    if (hits.length !== 1) return 'could_not_run';
    const { job, step } = hits[0];
    if (!Number.isSafeInteger(step.number) || step.conclusion !== 'failure') return 'could_not_run';
    for (const s of job.steps) {
      if (s === step) continue;
      if (!s || !Number.isSafeInteger(s.number)) return 'could_not_run';
      if (s.number < step.number && s.conclusion !== 'success') return 'could_not_run';
    }
    return 'flagged';
  } catch { return 'could_not_run'; }
}

export async function readAuditRun({ gh, owner, repo, runId, workflowPath, commit, flagStep = DEFAULT_FLAG_STEP } = {}) {
  const no = (reason) => ({ ok: false, reason });
  try {
    if (!gh || typeof gh.get !== 'function') return no('no GitHub client');
    if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) return no('no owner and repo');
    const id = typeof runId === 'number' ? String(runId) : runId;
    if (typeof id !== 'string' || !RUN_ID.test(id)) return no('not a run id');
    const base = `/repos/${owner}/${repo}/actions/runs/${id}`;
    const r = await gh.get(base);
    if (r?.status !== 200 || !r.json || typeof r.json !== 'object') return no(`run unreadable (${r?.status})`);
    const j = await gh.get(`${base}/jobs?per_page=100`);
    if (j?.status !== 200 || !j.json || typeof j.json !== 'object') return no(`jobs unreadable (${j?.status})`);
    // A list that may be cut off is no list: classifyRun answers could_not_run for it.
    const jobs = Array.isArray(j.json.jobs) && j.json.total_count === j.json.jobs.length ? j.json.jobs : null;
    return { ok: true, result: classifyRun(r.json, jobs, { flagStep, workflowPath, commit }) };
  } catch (e) { return no(`audit run check failed: ${String(e?.message ?? e).slice(0, 200)}`); }
}

export async function undoIssueCounts({ gh, owner, repo, issue, rules = {} } = {}) {
  const notice = (why) => ({ card: false, notice: why });
  try {
    const { cutoverStage, workflowPath, flagStep = DEFAULT_FLAG_STEP } = rules ?? {};
    if (cutoverStage === undefined || cutoverStage === null || cutoverStage === 'first') return notice('first cutover: no issue starts an undo card');
    if (cutoverStage !== 'second') return notice(`unknown cutover stage ${JSON.stringify(cutoverStage)}`);
    if (!str(workflowPath)) return notice('the rules declare no audit workflow path');
    if (!issue || typeof issue !== 'object') return notice('no issue');
    if (issue.pull_request) return notice('a pull request, not an issue');
    if (issue.user?.login !== ACTIONS_BOT || issue.user?.type !== 'Bot') return notice('not opened by the Actions bot');
    const lines = typeof issue.body === 'string' ? issue.body.split(/\r?\n/) : [];
    const runs = lines.map((l) => RUN_LINE.exec(l)).filter(Boolean);
    const commits = lines.map((l) => COMMIT_LINE.exec(l)).filter(Boolean);
    if (runs.length !== 1) return notice('the issue does not name exactly one run');
    if (commits.length !== 1) return notice('the issue does not name exactly one commit');
    const runId = runs[0][1];
    const commit = commits[0][1];
    const a = await readAuditRun({ gh, owner, repo, runId, workflowPath, commit, flagStep });
    if (!a.ok) return notice(`audit run could not be read (counts as could_not_run): ${a.reason}`);
    if (a.result !== 'flagged') return notice(`audit run ${runId} is ${a.result}, not flagged`);
    return { card: true, commit, runId: Number(runId) };
  } catch (e) { return notice(`issue check failed: ${String(e?.message ?? e).slice(0, 200)}`); }
}
