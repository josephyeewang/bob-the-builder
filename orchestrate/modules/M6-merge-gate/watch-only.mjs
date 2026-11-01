// watch-only.mjs — the Merge Gate's dry run on the product's real merges (R-0b-122, first-cutover version).
//
// WHAT. For a week before the first cutover, every commit that reaches the product's main is judged the way the gate would
// have judged it, and the answer is written to a log next to what MAIN actually did. Nothing is installed on the product,
// nothing is written to GitHub (the token is read only, and this file can only GET, plus the one read-only GraphQL query),
// and nothing here holds merge power: Joe's own login still merges until the cutover.
//
// WHAT IT JUDGES, AND WHAT IT CANNOT. Before the cutover the product has no cards, merge requests, reviewer verdicts or
// goes, so refusals 5 (reviewer verdict), 10 (go) and 11 (merge request) have nothing to read: they are listed on every
// line as `not_judged`, never as passed. Refusals 2 (main red then) and 12 (behind main) are about the moment of merging
// and can't be recomputed afterwards: also `not_judged`. Judged, from GitHub and the product's rules file alone:
//   1 required checks red on the pull request's head      6 a check result for another commit
//   4 stacked (the pull request's base is not main)        7 unresolved human review threads (as GitHub shows them now)
//   9 out of lane (M10's docs-lane rule, first cutover; a push to main with no pull request is also refused here)
//   8 needs the owner's Approve (M10's classification: a risky or Tier 1 change)
// Verdict: 'would merge' | 'would ask for the owner's Approve' | 'would refuse'. Every verdict but 'would merge' is a
// disagreement with MAIN (who merged it) and needs a written explanation in the explanations file; `summary` counts the
// unexplained ones. The week counts only if every day has a pass line (no silent hole) and there are zero unexplained.
//
// FILES (in `dir`, the runner's own folder): log.jsonl (one JSON line per commit or pass), explanations.json
// ({ "<commit sha>": "why this disagreement is fine" }). The token is read from a file the runner's own user owns, mode 0600,
// by a function the client calls per request; it is never put in a log line, an error or an argument.

import { closeSync, constants, fstatSync, openSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { classifyChange } from '../M10-rules/classify.mjs';
import { docsLaneProblem } from '../M10-rules/lane-check.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { MAX_BYTES, RULES_PATH, blobSha } from '../M10-rules/reader.mjs';
import { threadsQuery } from './gather.mjs';

export const NOT_JUDGED = Object.freeze([5, 10, 11, 2, 12]);
export const VERDICTS = Object.freeze(['would merge', 'would ask for the owner\'s Approve', 'would refuse']);
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const MAX_LIST = 100;
const GOOD = new Set(['success', 'neutral', 'skipped']);

/** The token, from the file the runner's own user owns (0600), as a function so it is never held in a variable others can print. */
export function tokenFile(path, { uid = process.getuid?.() } = {}) {
  return () => {
    let fd;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error('the watch-only token file could not be opened'); }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.size < 20 || st.size > 1024) throw new Error('the watch-only token file is not this user\'s own private file');
      return readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
  };
}

/** A GitHub client that can only read: GET on /repos, and the one read-only GraphQL query. Host fixed. */
export function readOnlyClient({ token, fetchFn = globalThis.fetch, timeoutMs = 15_000 }) {
  const call = async (method, path, body) => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token()}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  };
  return Object.freeze({
    get: async (path) => { if (!path.startsWith('/repos/')) throw new Error('only repository reads are allowed'); return call('GET', path); },
    post: async (path, body) => { if (path !== '/graphql' || body?.query !== threadsQuery) throw new Error('the only write-shaped call allowed is the read-only threads query'); return call('POST', path, body); },
  });
}

/** Pure: the verdict from the facts below. facts = { direct, prBase, checks, statuses, requiredChecks, ignored, threads, lane, classification, headSha }. */
export function judgeMerged(f) {
  const refusals = []; const no = (n, reason) => refusals.push({ n, reason });
  if (f.direct) {
    no(9, 'a push to main with no pull request: the gate only merges pull requests');
    return finish(refusals, false);
  }
  if (f.prBase !== 'main') no(4, `stacked on ${f.prBase ?? 'an unknown branch'}, not main`);
  const ign = (c) => (f.ignored ?? []).some((x) => x?.app_id === c.app_id && x?.name === c.name);
  if (!Array.isArray(f.checks) || !Array.isArray(f.statuses) || !Array.isArray(f.requiredChecks)) no(1, 'the checks could not be read');
  else {
    const runs = f.checks.filter((c) => !ign(c));
    const good = (c) => c.status === 'completed' && GOOD.has(c.conclusion);
    for (const name of f.requiredChecks) if (!runs.some((c) => c.name === name && good(c)) && !f.statuses.some((s) => s.context === name && s.state === 'success')) no(1, `required check "${name}" did not pass`);
    if (!runs.every(good) || !f.statuses.every((s) => s.state === 'success')) no(1, 'a check or status is not green');
    if (f.checks.some((c) => c?.head_sha !== f.headSha)) no(6, 'a check result is for another commit');
  }
  if (f.threads?.ok !== true) no(7, 'the review threads could not be read');
  else if (f.threads.unresolved !== 0) no(7, `${f.threads.unresolved} review thread(s) unresolved`);
  if (typeof f.lane === 'string') no(9, `first cutover: docs lane only (${f.lane})`);
  else if (f.lane !== null) no(9, 'the lane could not be judged');
  const asks = f.classification && (f.classification.tier !== 2 || (f.classification.risky ?? []).length > 0);
  return finish(refusals, Boolean(asks), f.classification);
}

function finish(refusals, asks, classification) {
  const verdict = refusals.length ? VERDICTS[2] : asks ? VERDICTS[1] : VERDICTS[0];
  return { verdict, refusals, tier: classification?.tier ?? null, risky: classification?.risky ?? [], not_judged: [...NOT_JUDGED] };
}

const get = async (gh, path) => { const r = await gh.get(path); if (r?.status !== 200 || r.json == null) throw new Error(`${path.split('?')[0]} answered ${r?.status}`); return r.json; };
const linesOf = (patch) => {
  if (typeof patch !== 'string') return {};
  const added = []; const removed = [];
  for (const l of patch.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added.push(l.slice(1)); else if (l.startsWith('-') && !l.startsWith('---')) removed.push(l.slice(1)); }
  return { added_lines: added, removed_lines: removed };
};

/** Gathers the facts for one commit on main. Anything unreadable becomes null and the verdict refuses for it. */
export async function gatherMerged({ gh, owner, repo, policy, sha }) {
  const base = `/repos/${owner}/${repo}`;
  const view = makeGitView({ gh, owner, repo });
  const attempt = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };
  const pulls = await attempt(() => get(gh, `${base}/commits/${sha}/pulls?per_page=${MAX_LIST}`), null);
  // The pull request GitHub ties to this commit: the one whose merge commit it is, else the first listed. It counts only if
  // GitHub itself says it was merged; a commit that is merely some open pull request's head is a push with no merge.
  const listed = Array.isArray(pulls) ? pulls.filter((p) => Number.isInteger(p?.number)) : [];
  const num = (listed.find((p) => p.merge_commit_sha === sha) ?? listed[0])?.number;
  const pr = Number.isInteger(num) ? await attempt(() => get(gh, `${base}/pulls/${num}`)) : null;
  if (Array.isArray(pulls) && (listed.length === 0 || (pr && pr.merged !== true))) return { direct: true, mergedBy: null, pr: null };
  const headSha = SHA.test(pr?.head?.sha ?? '') ? pr.head.sha : null;
  const c = await attempt(() => view.commit(sha));
  const parent = c?.parents?.[0] ?? null;
  const cmp = parent ? await attempt(() => get(gh, `${base}/compare/${parent}...${sha}`)) : null;
  const raw = Array.isArray(cmp?.files) && cmp.files.length < 300 ? cmp.files : null;
  const files = raw ? await attempt(() => Promise.all(raw.map(async (x) => {
    const e = await view.entry(x.status === 'removed' ? parent : sha, x.filename);
    if (!e) throw new Error('no tree entry');
    return { path: x.filename, ...(x.previous_filename ? { previous_path: x.previous_filename } : {}), status: x.status === 'changed' ? 'modified' : x.status, mode: e.mode, ...linesOf(x.patch) };
  }))) : null;
  const labels = (pr?.labels ?? []).map((l) => l?.name).filter((n) => typeof n === 'string');
  const classification = files ? classifyChange(policy, { product: 'watch', files, truncated: false, labels, declared_tier: 2 }) : null;
  const lane = files ? docsLaneProblem(policy, { files, truncated: false, labels, declared_tier: 2 }) : 'the change\'s files could not be read';
  const checks = headSha ? await attempt(async () => {
    const j = await get(gh, `${base}/commits/${headSha}/check-runs?per_page=${MAX_LIST}`);
    if (!Array.isArray(j.check_runs) || !Number.isInteger(j.total_count) || j.total_count >= MAX_LIST || j.total_count !== j.check_runs.length) throw new Error('cut off');
    return j.check_runs.map((x) => ({ name: x?.name, app_id: x?.app?.id, head_sha: x?.head_sha, status: x?.status, conclusion: x?.conclusion }));
  }) : null;
  const statuses = headSha ? await attempt(async () => {
    const j = await get(gh, `${base}/commits/${headSha}/status?per_page=${MAX_LIST}`);
    if (!Array.isArray(j.statuses) || (Number.isInteger(j.total_count) && j.total_count >= MAX_LIST)) throw new Error('cut off');
    return j.statuses.map((s) => ({ context: s?.context, state: s?.state }));
  }) : null;
  const threads = Number.isInteger(num) ? await attempt(async () => {
    const r = await gh.post('/graphql', { query: threadsQuery, variables: { owner, repo, pr: num } });
    const t = r?.json?.data?.repository?.pullRequest?.reviewThreads;
    if (r?.status !== 200 || r.json?.errors || !t || !Array.isArray(t.nodes) || t.totalCount !== t.nodes.length || t.totalCount >= MAX_LIST) return { ok: false };
    return { ok: true, unresolved: t.nodes.filter((n) => n?.isResolved !== true && n?.comments?.nodes?.[0]?.author?.__typename !== 'Bot').length };
  }, { ok: false }) : { ok: false };
  const requiredChecks = policy?.product_profile?.required_checks;
  return {
    direct: false, pr: num ?? null, mergedBy: pr?.merged_by?.login ?? null, prBase: pr?.base?.ref ?? null, headSha, checks, statuses,
    requiredChecks: Array.isArray(requiredChecks) ? requiredChecks : null, ignored: Array.isArray(policy?.product_profile?.checks_ignored) ? policy.product_profile.checks_ignored.map((x) => ({ app_id: Number(x?.app_id), name: x?.name })) : [],
    threads, lane, classification,
  };
}

const day = (iso) => String(iso).slice(0, 10);
const readLog = (dir) => {
  const f = join(dir, 'log.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { corrupt: true }; } });
};

/**
 * The product's rules file AS IT STANDS AT `sha` (read from GitHub through the same read-only client; never a local copy,
 * never an older version). → { policy } or { reason }. The text must be the blob GitHub names, and must parse.
 */
export async function rulesAt({ gh, owner, repo, sha }) {
  try {
    const j = await get(gh, `/repos/${owner}/${repo}/contents/${RULES_PATH}?ref=${sha}`);
    if (!SHA.test(j?.sha ?? '') || j.encoding !== 'base64' || typeof j.content !== 'string') return { reason: 'the rules file answer was odd' };
    const buf = Buffer.from(j.content, 'base64');
    if (buf.length > MAX_BYTES || buf.length !== j.size || blobSha(buf) !== j.sha) return { reason: 'the rules file does not match the version GitHub named' };
    const parsed = parsePolicy(buf.toString('utf8'));
    return parsed.ok ? { policy: parsed.policy } : { reason: `the rules file is not usable (${parsed.reason})` };
  } catch (e) { return { reason: `the rules file could not be read (${String(e?.message ?? e).slice(0, 60)})` }; }
}

/**
 * One pass: lists the commits on main since `since` (an ISO time), judges each one not already in the log against the rules
 * AS THEY STOOD AT THAT COMMIT, appends a line per commit and one pass line. A commit whose rules could not be read is
 * logged `not_judged` with the reason (and tried again next pass); it is never judged against other rules, and the pass
 * has a problem, so its day does not count. → { judged, skipped, problems }. Never writes to GitHub.
 */
export async function watchPass({ gh, owner, repo, dir, since, now = () => new Date().toISOString() }) {
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) throw new Error('watch needs an owner and repo');
  const at = now();
  const problems = [];
  const log = (o) => appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(o)}\n`, { mode: 0o600 });
  const seen = new Set(readLog(dir).filter((l) => l.sha && !l.not_judged_reason).map((l) => l.sha));
  let commits;
  try {
    commits = [];
    for (let page = 1; page <= 10; page++) {
      const j = await get(gh, `/repos/${owner}/${repo}/commits?sha=main&since=${encodeURIComponent(since)}&per_page=${MAX_LIST}&page=${page}`);
      if (!Array.isArray(j)) throw new Error('odd answer');
      commits.push(...j.filter((x) => SHA.test(x?.sha ?? '')));
      if (j.length < MAX_LIST) break;
    }
  } catch (e) { problems.push(`main's commits could not be listed (${String(e.message).slice(0, 80)})`); log({ pass: true, at, judged: 0, problems }); return { judged: 0, skipped: 0, problems }; }
  let judged = 0; let skipped = 0;
  for (const c of commits.reverse()) {
    if (seen.has(c.sha)) { skipped++; continue; }
    const rules = await rulesAt({ gh, owner, repo, sha: c.sha });
    if (!rules.policy) {
      problems.push(`${c.sha.slice(0, 8)}: not judged, ${rules.reason}`);
      log({ sha: c.sha, at, merged_at: c.commit?.committer?.date ?? null, not_judged_reason: rules.reason });
      continue;
    }
    const facts = await gatherMerged({ gh, owner, repo, policy: rules.policy, sha: c.sha });
    const v = judgeMerged(facts);
    log({ sha: c.sha, at, merged_at: c.commit?.committer?.date ?? null, pr: facts.pr, merged_by: facts.mergedBy ?? c.author?.login ?? null, direct: facts.direct, ...v });
    judged++;
  }
  log({ pass: true, at, judged, skipped, problems });
  return { judged, skipped, problems };
}

/**
 * The week's result. `days` consecutive days ending `endDay` (inclusive). Counts commits judged, disagreements, the
 * unexplained ones, and the days with no pass line. `ok` only when 7 days are covered and nothing is unexplained.
 */
export function summary({ dir, endDay, days = 7 }) {
  const lines = readLog(dir);
  const explanations = existsSync(join(dir, 'explanations.json')) ? JSON.parse(readFileSync(join(dir, 'explanations.json'), 'utf8')) : {};
  const wanted = []; const end = new Date(`${endDay}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) wanted.push(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  // A pass that could not list main or read the rules covers nothing: that day still has a hole.
  const passDays = new Set(lines.filter((l) => l.pass && !(l.problems?.length)).map((l) => day(l.at)));
  const missingDays = wanted.filter((d) => !passDays.has(d));
  const commits = lines.filter((l) => l.sha && !l.not_judged_reason && wanted.includes(day(l.at)));
  const disagreements = commits.filter((l) => l.verdict !== VERDICTS[0]);
  const unexplained = disagreements.filter((l) => typeof explanations[l.sha] !== 'string' || !explanations[l.sha].trim());
  const failedPasses = lines.filter((l) => l.pass && wanted.includes(day(l.at)) && l.problems?.length).length;
  return { days: wanted, missingDays, judged: commits.length, wouldMerge: commits.length - disagreements.length, disagreements: disagreements.length, unexplained: unexplained.map((l) => ({ sha: l.sha, pr: l.pr, verdict: l.verdict, refusals: l.refusals })), failedPasses, corrupt: lines.filter((l) => l.corrupt).length,
    ok: missingDays.length === 0 && unexplained.length === 0 && lines.every((l) => !l.corrupt) };
}
