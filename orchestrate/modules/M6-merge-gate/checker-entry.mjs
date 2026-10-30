// checker-entry.mjs — the GitHub-side checker: did this main commit get every sign-off its files need? (R-0b-93;
// 0b-9 M2, M4, M5; R3-M1.) Bundled with everything it imports into github-checker.mjs (build-checker.mjs), which the
// outside-check repo keeps and the audit workflow and Vercel's build-skip command download by pinned commit + sha256.
//
// WHY. The Merge Gate on the Mini is the normal way onto main, but GitHub can't stop a hand push on the free plan, and
// the Mini could be wrong or turned. So after the merge this checker asks the same questions again from GitHub's own
// answers, using M10's one classifier (classify.mjs) so both sides agree:
//   - the commit carries the robot's mark (mark.mjs): no mark, or no pull request, is a flag;
//   - its files are classified by the rules AT THE PARENT commit, so a change that loosens policy.yaml is judged by the
//     rules it loosens; a parent with no readable policy.yaml makes every file need the owner;
//   - the robot's `orchestrate/needs-joe` status (NEEDS_JOE_CONTEXT) can only add: missing, unreadable or odd counts as
//     `needs-joe: true` (a needs-joe label) with declared tier 1; `false` never removes a computed class;
//   - Tier 1 or any risky class needs the owner's APPROVED review (numeric id, type User, not via an app) on the merged
//     pull request at the merged head, as the owner's last deciding review;
//   - an exact reverse (mark + a recomputed checkExactReverse of the commit named by a `reverses: <40-hex>` line in the
//     pull request's body) skips that review only when the reversed commit's audit run is `flagged` (audit-run.mjs);
//     a reverse touching policy.yaml or any protected file always needs it.
// A change's line text is not read here: at the first cutover every file outside the plain-docs paths is already
// unclassifiable by path, so a line scan could never turn a pass into a flag or back.
//
//   await runChecker({ gh, owner, repo, sha, robotBotId, ownerId, workflowPath, flagStep }) → { ok, flags: [why…], judged }
//     judged false = GitHub could not be read well enough to judge (never a verdict: the audit's read step fails).
//   await readNeedsJoe({ gh, owner, repo, sha, robotBotId }) → { needsJoe, tier, reason }
//   await main(argv, env, { gh, out }?) → exit code; never throws:
//     first | full                → build-skip.mjs main (0 skip / 1 build)
//     audit-read <file>           → judges GITHUB_SHA, writes { ok, flags } to <file>; 0, or 2 when it can't judge
//     verdict <file>              → the audit workflow's `verdict` step: 0 pass, 1 flagged, 2 unreadable file
//   Env for the audit: GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN, ORCHESTRATE_ROBOT_BOT_ID, ORCHESTRATE_OWNER_ID,
//   ORCHESTRATE_AUDIT_WORKFLOW, ORCHESTRATE_FLAG_STEP (optional). The token is never printed.

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyWithRulesText } from '../M10-rules/classify.mjs';
import { checkExactReverse } from '../M10-rules/exact-reverse.mjs';
import { makeGitView, touchedPaths } from '../M10-rules/git-view.mjs';
import { readMark, NEEDS_JOE_CONTEXT, NEEDS_JOE_DESC } from './mark.mjs';
import { readAuditRun, DEFAULT_FLAG_STEP } from './audit-run.mjs';
import { main as buildSkipMain, makeFetchGh } from './build-skip.mjs';

export { NEEDS_JOE_CONTEXT };
export const RULES_PATH = 'orchestrate/policy.yaml';
const REVERSES_LINE = /^reverses: ([0-9a-f]{40})$/;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const errText = (e) => String(e?.message ?? e).slice(0, 200);
class Unreadable extends Error {}

export async function readNeedsJoe({ gh, owner, repo, sha, robotBotId }) {
  const strict = (reason) => ({ needsJoe: true, tier: 1, reason });
  try {
    const st = await gh.get(`/repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100`);
    if (st?.status !== 200 || !Array.isArray(st.json)) return strict(`statuses unreadable (${st?.status})`);
    if (st.json.length >= 100) return strict('too many statuses to read them all');
    const mine = st.json.filter((s) => s?.context === NEEDS_JOE_CONTEXT && s?.creator?.id === robotBotId);
    if (!mine.length) return strict('no needs-joe status');
    const parsed = mine.map((s) => (s?.state === 'success' ? NEEDS_JOE_DESC.exec(s.description ?? '') : null));
    if (parsed.some((p) => !p) || new Set(parsed.map((p) => p[0])).size !== 1) return strict('needs-joe status odd or disagreeing');
    return { needsJoe: parsed[0][1] === 'true', tier: Number(parsed[0][2]), reason: 'robot status' };
  } catch (e) { return strict(`needs-joe check failed: ${errText(e)}`); }
}

export async function runChecker({ gh, owner, repo, sha, robotBotId, ownerId, workflowPath, flagStep = DEFAULT_FLAG_STEP } = {}) {
  const flags = [];
  try {
    if (!gh || typeof gh.get !== 'function') throw new Unreadable('no GitHub client');
    if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) throw new Unreadable('no owner and repo');
    if (!SHA.test(sha ?? '')) throw new Unreadable('not a full commit id');
    if (!posInt(robotBotId) || !posInt(ownerId)) throw new Unreadable('robot or owner id not configured');
    const base = `/repos/${owner}/${repo}`;
    const read = async (path) => {
      const r = await gh.get(`${base}${path}`);
      if (r?.status !== 200 || !r.json || typeof r.json !== 'object') throw new Unreadable(`GitHub answered ${r?.status} for ${path.split('?')[0]}`);
      return r.json;
    };
    // GitHub must answer these before "no mark" can be a verdict rather than a read failure.
    await read(`/commits/${sha}/statuses?per_page=100`);
    const prs = await read(`/commits/${sha}/pulls?per_page=100`);

    const view = makeGitView({ gh, owner, repo });
    const commit = await view.commit(sha);
    if (!commit.parents.length) { flags.push('the commit has no parent'); return { ok: false, flags, judged: true }; }
    const parent = commit.parents[0];
    const files = await view.files(parent, sha);

    const mark = await readMark({ gh, owner, repo, sha, robotBotId });
    if (!mark.ok) flags.push(`no robot mark: ${mark.reason}`);
    if (!Array.isArray(prs) || !prs.length) flags.push('no pull request for this commit');
    const pr = mark.ok ? await read(`/pulls/${mark.pr}`) : null;

    const rules = await rulesAt(gh, base, parent);
    if (rules === null) flags.push(`no readable ${RULES_PATH} at the parent: every file needs the owner`);
    const nj = await readNeedsJoe({ gh, owner, repo, sha, robotBotId });
    const labels = [...(Array.isArray(pr?.labels) ? pr.labels.map((l) => l?.name).filter((n) => typeof n === 'string') : []),
      ...(nj.needsJoe ? ['needs-joe'] : [])];
    const cls = classifyWithRulesText(rules, { files, declared_tier: nj.tier, labels });
    const needsOwner = cls.tier === 1 || cls.risky.length > 0;
    if (!needsOwner) return { ok: flags.length === 0, flags, judged: true };
    const why = `Tier ${cls.tier}${cls.risky.length ? `, ${cls.risky.join(', ')}` : ''}`;

    // An exact reverse of a flagged merge may skip the owner's review, unless it touches the rules or a protected file.
    const reverses = mark.ok && typeof pr?.body === 'string' ? pr.body.split(/\r?\n/).map((l) => REVERSES_LINE.exec(l)).filter(Boolean) : [];
    if (reverses.length === 1) {
      const target = reverses[0][1];
      const er = await checkExactReverse({ view, reverses: target, merged: sha });
      const touchesRules = [...touchedPaths(files)].some((p) => p.toLowerCase() === RULES_PATH) || cls.protected.length > 0 || cls.risky.includes('protected');
      if (er.ok && !touchesRules) {
        const audit = await auditOf(gh, owner, repo, target, workflowPath, flagStep);
        if (audit === 'flagged') return { ok: flags.length === 0, flags, judged: true };
        flags.push(`exact reverse of ${target.slice(0, 7)}, but its audit run is ${audit}, not flagged`);
      } else if (er.ok) flags.push('an exact reverse that touches policy.yaml or a protected file still needs the owner');
      else flags.push(`not an exact reverse: ${er.reasons.join('; ').slice(0, 300)}`);
    }

    const review = mark.ok ? await ownerApproved(read, mark.pr, mark.head, ownerId) : { ok: false, reason: 'no marked pull request' };
    if (!review.ok) flags.push(`needs the owner's Approve (${why}): ${review.reason}`);
    return { ok: flags.length === 0, flags, judged: true };
  } catch (e) {
    flags.push(`could not judge: ${errText(e)}`);
    return { ok: false, flags, judged: false };
  }
}

// policy.yaml's text at a commit; null when it is missing. Any other answer is a read failure (throws).
async function rulesAt(gh, base, ref) {
  const r = await gh.get(`${base}/contents/${RULES_PATH}?ref=${ref}`);
  if (r?.status === 404) return null;
  if (r?.status !== 200 || r.json?.type !== 'file') throw new Unreadable(`${RULES_PATH} unreadable (${r?.status})`);
  if (r.json.encoding !== 'base64' || typeof r.json.content !== 'string') return null;   // too big to inline: no readable rules
  return Buffer.from(r.json.content, 'base64').toString('utf8');
}

// The owner's last deciding review (approve, request changes or dismissed) must be an approval of exactly `head`.
async function ownerApproved(read, pr, head, ownerId) {
  const list = await read(`/pulls/${pr}/reviews?per_page=100`);
  if (!Array.isArray(list)) return { ok: false, reason: 'reviews unreadable' };
  if (list.length >= 100) return { ok: false, reason: 'too many reviews to read them all' };
  const last = list.filter((r) => r?.user?.id === ownerId && r?.user?.type === 'User' && !r?.performed_via_github_app
    && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r?.state)).at(-1);
  if (!last) return { ok: false, reason: 'no review by the owner' };
  if (last.state !== 'APPROVED') return { ok: false, reason: `the owner's last review is ${last.state}` };
  if (last.commit_id !== head) return { ok: false, reason: 'the owner approved another head' };
  return { ok: true };
}

// The newest run of the audit workflow on main for `commit`, as audit-run.mjs reads it. Anything unreadable → could_not_run.
async function auditOf(gh, owner, repo, commit, workflowPath, flagStep) {
  try {
    if (typeof workflowPath !== 'string' || !workflowPath) return 'could_not_run (no audit workflow configured)';
    const r = await gh.get(`/repos/${owner}/${repo}/actions/runs?head_sha=${commit}&per_page=100`);
    const runs = r?.status === 200 && Array.isArray(r.json?.workflow_runs) ? r.json.workflow_runs : null;
    if (!runs || r.json.total_count !== runs.length) return 'could_not_run';
    const mine = runs.filter((x) => x?.path === workflowPath && x?.head_branch === 'main' && posInt(x?.id)).sort((a, b) => b.id - a.id);
    if (!mine.length) return 'could_not_run (no audit run)';
    const a = await readAuditRun({ gh, owner, repo, runId: mine[0].id, workflowPath, commit, flagStep });
    return a.ok ? a.result : 'could_not_run';
  } catch { return 'could_not_run'; }
}

const intEnv = (v) => (typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : null);

export async function main(argv, env, deps = {}) {
  const mode = Array.isArray(argv) ? argv[0] : undefined;
  if (mode === 'first' || mode === 'full') return buildSkipMain(argv, env, deps);
  const out = deps.out ?? ((s) => console.log(s));
  try {
    const e = env && typeof env === 'object' ? env : {};
    const file = argv?.[1];
    if (typeof file !== 'string' || !file) { out('checker: no result file named'); return 2; }
    if (mode === 'audit-read') {
      const [owner, repo, extra] = String(e.GITHUB_REPOSITORY ?? '').split('/');
      if (extra !== undefined) { out('checker: odd GITHUB_REPOSITORY'); return 2; }
      const r = await runChecker({ gh: deps.gh ?? makeFetchGh({ token: e.GITHUB_TOKEN }), owner, repo, sha: e.GITHUB_SHA,
        robotBotId: intEnv(e.ORCHESTRATE_ROBOT_BOT_ID), ownerId: intEnv(e.ORCHESTRATE_OWNER_ID),
        workflowPath: e.ORCHESTRATE_AUDIT_WORKFLOW, flagStep: e.ORCHESTRATE_FLAG_STEP || DEFAULT_FLAG_STEP });
      for (const f of r.flags) out(`checker: ${f}`);
      if (!r.judged) return 2;
      writeFileSync(file, JSON.stringify({ ok: r.ok, flags: r.flags }));
      return 0;
    }
    if (mode === 'verdict') {
      const r = JSON.parse(readFileSync(file, 'utf8'));
      if (r?.ok === true && Array.isArray(r.flags) && r.flags.length === 0) { out('checker: passed'); return 0; }
      if (r?.ok === false && Array.isArray(r.flags) && r.flags.length) { out(`checker: FLAGGED (${r.flags.length})`); return 1; }
      out('checker: result file odd'); return 2;
    }
    out('checker: unknown mode');
    return 2;
  } catch (err) { try { out(`checker: failed: ${errText(err)}`); } catch { /* nothing to add */ } return 2; }
}

// Run as a script (the bundle, by the audit workflow or Vercel): exit with main's code. A rejection can't print the
// build token, so in a build mode it still skips.
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, () => { process.exitCode = 2; });
