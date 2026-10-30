// outside-check.mjs — the hourly outside check, run by GitHub Actions in its own public repo (R-0b-72; design v4 §8
// E6; review-0b-7 M2, M9, M13, M14 and minors). It watches the Mini from outside: if the Mini dies or is turned against
// a product, this still runs.
//
//   node outside-check.mjs <check> <slot>
//
// The product list is the PRODUCTS secret, JSON: [{ repo, stage, post_merge_audit, audit_workflow, robot, tag }]. Slot N is
// the Nth entry and its only public name is "product N" (the pinned list is keyed by it too); an empty slot passes. CHECK_TOKEN is a read-only token for the product repos.
// The logs are PUBLIC: this prints only "<label> / <check>: ok|FAIL <reason code>", never a repo name, a commit, a path
// or an error message (an error prints its HTTP status only). It appends the same line to $RESULTS for collect.mjs.
//
// Checks (each one workflow step):
//   heartbeat    the robot's open issue labelled orchestrate-heartbeat says `mini_alive_at: <time>`; older than 70
//                minutes → FAIL. 70 minutes + this hourly schedule ≈ 2 h worst case to notice (R-0b-72 "~2 h").
//   audit-files  each pinned audit file (pinned-audit-files.json, by product label) still has its pinned SHA-256 on
//                main; changed or missing → FAIL.
//   audit-run    when the rules say the post-merge audit is on (stage second, a missing stage, or post_merge_audit):
//                every main first-parent commit 30 min to 48 h old has a finished, successful audit run → else FAIL.
//   deploys      the newest GitHub deployment whose environment starts with "Production" and whose latest status is
//                success must be a supported main commit; none found → FAIL unless the entry says `no_production: true` (supported.mjs, a byte-for-byte copy of Bob's M12 one).
//                GitHub deployments are created by the Git integration, so source is "git" here; a CLI deploy leaves
//                no GitHub deployment and is the Mini's watcher's to see.
//   permissions  the repo's Actions default token permission is "read".
//   robot-merges every main update the robot made in the last 7 days (GitHub's activity list, actor = the robot's
//                login) touches only the docs-lane paths pinned for that slot (pinned-docs-lane.json, a copy of the
//                product's first-cutover rules entry); anything else → FAIL until the owner lists that commit in
//                acknowledged-merges.json (as the SHA-256 of the commit id: this repo is public; only an ordinary
//                push or merge can be acknowledged). A robot force-push, an entry with no actor, a merge-queue merge
//                (its actor may not be the robot: unverified, so FAIL until a product's use of one is checked), a
//                default branch other than main, a list that can't be read or doesn't cover the window, or no pinned
//                docs lane → FAIL. Slot binding (0b-7 audit round 4 M-2): robot-merges-owner.json pins a short public
//                tag per slot; the PRODUCTS entry must carry the same tag, and a pinned slot left empty FAILs. The Mini
//                checks the same tag, records its last green time and latches a red until the owner clears it in
//                that file; the Merge Gate won't run unless green within 2 hours (lead calls L19, L20).
//   repo-guard   (one step, "product 1 / repo-guard"; lead call L24) this outside repo itself, so nobody but the owner
//                can change the check or acknowledge a merge: no collaborator other than the owner can push (the
//                robots and the Mini's accounts included), no deploy key can write, an active ruleset on the default
//                branch blocks updates, deletion and force-pushes with only the admin role able to bypass it, and the
//                check's own token can't write here. Anything that can't be read → FAIL. Commit author names are
//                never trusted. The Mini probes its own tokens the same way (outside-watch.mjs checkNoPush).
//                CHECK_TOKEN needs Administration: read on this repo to see deploy keys and ruleset bypass lists.
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9: void on an API change).

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStage, isSupported } from './supported.mjs';
import { SLOTS, GUARD } from './workflow.mjs';

export const STALE_MIN = 70;
const AUDIT_MIN_AGE = 30 * 60e3;
const AUDIT_MAX_AGE = 48 * 3600e3;
const FIRST_PARENT_MAX = 200;
const FUTURE_SLACK = 10 * 60e3;
const MAIN_UPDATES = ['push', 'force_push', 'pr_merge', 'merge_queue_merge'];
const DEPLOY_PAGES = 10;
export const ROBOT_WINDOW = 7 * 24 * 3600e3;
const COMPARE_FILE_CAP = 300;
const ACKABLE = ['push', 'pr_merge'];
export const SLOT_TAG = /^[a-z0-9]{8,32}$/;

class HttpError extends Error { constructor(status) { super(`http ${status}`); this.status = status; } }

// A write that can't succeed, to learn whether a token may write to a repo without changing anything: creating a
// branch at the all-zero commit. 403 or 404 → the token can't write; 422 → it got past the permission check (it can
// write; the commit just doesn't exist); anything else → unknown. The REST docs (29 Oct 2026) don't say GitHub checks
// permission before the commit. Seen live on 30 Oct 2026: a login that can write got 422 ("can-write") and no branch
// was made. Not yet checked live: a read-only token getting 403 or 404 ("no-write"); the outside repo's first green
// repo-guard run with its read-only token shows it (README). Principle 9: both readings are void on an API change.
export async function writeProbe(post, repo) {
  let status;
  try { status = await post(`/repos/${repo}/git/refs`, { ref: 'refs/heads/orchestrate-write-probe', sha: '0'.repeat(40) }); } catch { status = undefined; }
  if (status === 403 || status === 404) return 'no-write';
  if (status === 422) return 'can-write';
  return 'unknown';
}

// post(path, body) → the HTTP status only; never throws, never returns a body.
export function makeProbe(token, fetchImpl = fetch) {
  return async (path, body) => {
    try {
      const r = await fetchImpl(`https://api.github.com${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, body: JSON.stringify(body) });
      return r.status;
    } catch { return undefined; }
  };
}

const LOCK_RULES = ['update', 'deletion', 'non_fast_forward'];
const ADMIN_ROLE = 5;
function coversDefault(conditions, def) {
  const inc = conditions?.ref_name?.include; const exc = conditions?.ref_name?.exclude ?? [];
  if (!Array.isArray(inc) || !Array.isArray(exc)) return false;
  const names = ['~DEFAULT_BRANCH', '~ALL', `refs/heads/${def}`];
  if (!inc.some((x) => names.includes(x))) return false;
  // Any exclude that could match the default branch (it, a pattern, or the special names) doesn't count (strict).
  return !exc.some((x) => typeof x !== 'string' || names.includes(x) || /[*?[\]]/.test(x));
}

// The outside repo's own lock (lead call L24). self = GITHUB_REPOSITORY, selfOwner = GITHUB_REPOSITORY_OWNER.
// The rulesets read needs a public repo or GitHub Pro: on a private repo without Pro, GitHub answers 403 "Upgrade to
// GitHub Pro or make this repository public" (checked live, 30 Oct 2026), and the check fails safe (FAIL check-error
// 403). The outside repo is public by design.
export async function repoGuard({ api, probe, self, selfOwner }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(self ?? '')) || !selfOwner) return { ok: false, code: 'self-unknown' };
  const repo = await api(`/repos/${self}`);
  const def = repo?.default_branch;
  if (typeof def !== 'string' || !def) return { ok: false, code: 'repo-unreadable' };
  const people = await api(`/repos/${self}/collaborators?affiliation=all&per_page=100`);
  if (!Array.isArray(people)) return { ok: false, code: 'collaborators-unreadable' };
  if (people.length >= 100) return { ok: false, code: 'collaborators-not-covered' };
  if (people.some((c) => typeof c?.login !== 'string' || !c.permissions || typeof c.permissions !== 'object')) return { ok: false, code: 'collaborators-unreadable' };
  const writers = people.filter((c) => c.login.toLowerCase() !== String(selfOwner).toLowerCase()
    && (c.permissions.push !== false || c.permissions.maintain === true || c.permissions.admin !== false));
  if (writers.length) return { ok: false, code: `others-can-write ${writers.length}` };
  const keys = await api(`/repos/${self}/keys?per_page=100`);
  if (!Array.isArray(keys) || keys.length >= 100) return { ok: false, code: 'deploy-keys-unreadable' };
  if (keys.some((k) => k?.read_only !== true)) return { ok: false, code: 'deploy-key-can-write' };
  const list = await api(`/repos/${self}/rulesets?per_page=100`);
  if (!Array.isArray(list) || list.length >= 100) return { ok: false, code: 'rulesets-unreadable' };
  let locked = false;
  for (const s of list) {
    if (!Number.isInteger(s?.id)) return { ok: false, code: 'rulesets-unreadable' };
    const r = await api(`/repos/${self}/rulesets/${s.id}`);
    if (r?.target !== 'branch' || r.enforcement !== 'active' || !coversDefault(r.conditions, def)) continue;
    // Without the bypass list (a token lacking Administration: read) the lock can't be judged.
    if (!Array.isArray(r.bypass_actors) || !Array.isArray(r.rules)) return { ok: false, code: 'ruleset-unreadable' };
    const types = r.rules.map((x) => x?.type);
    const update = r.rules.find((x) => x?.type === 'update');
    const onlyAdmin = r.bypass_actors.every((b) => b?.actor_type === 'RepositoryRole' && b.actor_id === ADMIN_ROLE);
    if (LOCK_RULES.every((t) => types.includes(t)) && update?.parameters?.update_allows_fetch_and_merge !== true && onlyAdmin) locked = true;
  }
  if (!locked) return { ok: false, code: 'default-branch-not-locked' };
  const w = await writeProbe(probe, self);
  if (w !== 'no-write') return { ok: false, code: w === 'can-write' ? 'check-token-can-write' : 'write-probe-unclear' };
  return { ok: true, code: 'locked' };
}

export function makeApi(token, fetchImpl = fetch) {
  return async (path) => {
    const r = await fetchImpl(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    if (!r.ok) throw new HttpError(r.status);
    return r.json();
  };
}

async function firstParent(api, repo, limit = FIRST_PARENT_MAX) {
  const byPage = [];
  for (let page = 1; page <= Math.ceil(limit / 100) + 1; page++) {
    const batch = await api(`/repos/${repo}/commits?sha=main&per_page=100&page=${page}`);
    byPage.push(...batch);
    if (batch.length < 100) break;
  }
  const bySha = new Map(byPage.map((c) => [c.sha, c]));
  const chain = [];
  let c = byPage[0];
  while (c && chain.length < limit) { chain.push(c); c = bySha.get(c.parents?.[0]?.sha); }
  return chain;
}

async function auditOk(api, repo, workflow, sha) {
  const r = await api(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=20`);
  return (r.workflow_runs ?? []).some((w) => w.status === 'completed' && w.conclusion === 'success');
}

// A path is in the docs lane when it equals an entry, or starts with an entry ending in "/".
export function inDocsLane(path, lane) {
  return typeof path === 'string' && path !== '' && lane.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e));
}

export const CHECKS = {
  async heartbeat(p, { api, now }) {
    const issues = await api(`/repos/${p.repo}/issues?labels=orchestrate-heartbeat&state=open&per_page=10`);
    const times = issues.filter((i) => i.user?.login === p.robot)
      .map((i) => /^mini_alive_at: (\S+)$/m.exec(i.body ?? '')?.[1]).map((t) => Date.parse(t)).filter(Number.isFinite);
    if (!times.length) return { ok: false, code: 'heartbeat-missing' };
    const age = Math.round((now() - Math.max(...times)) / 60e3);
    // A time more than 10 minutes ahead is a wrong clock, not a fresh heartbeat (round 3 minor 2).
    if (age < -10) return { ok: false, code: 'heartbeat-in-future' };
    return age > STALE_MIN ? { ok: false, code: `heartbeat-stale ${age}min` } : { ok: true, code: `${Math.max(age, 0)}min` };
  },
  async 'audit-files'(p, { api, pinned }) {
    const files = pinned[p.label];
    if (!files || !Object.keys(files).length) return { ok: false, code: 'no-pinned-audit-files' };
    let changed = 0;
    for (const [path, sha256] of Object.entries(files)) {
      try {
        const f = await api(`/repos/${p.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=main`);
        const got = createHash('sha256').update(Buffer.from(f.content ?? '', 'base64')).digest('hex');
        if (got !== sha256) changed += 1;
      } catch (e) { if (e.status === 404) changed += 1; else throw e; }
    }
    return changed ? { ok: false, code: `audit-files-changed ${changed}` } : { ok: true, code: `${Object.keys(files).length} files` };
  },
  // Which main updates are due an audit run is judged by GitHub's own push times (the repository activity list), never
  // by a commit's date, which the pusher sets (0b-7 audit M-6). Each push, PR merge or queue merge to main that is
  // 30 min to 48 h old needs a successful audit run on the head it left. A first-parent commit dated in the future is
  // a FAIL on its own. Activity list fields as GitHub documents them, 29 Oct 2026. Seen live on 30 Oct 2026:
  // activity_type, actor.login, timestamp, before and after, on push and branch_creation entries. Not yet checked
  // live: pr_merge, merge_queue_merge and force_push entries (Principle 9).
  async 'audit-run'(p, { api, now }) {
    const { auditCheck } = resolveStage(p);
    if (!auditCheck) return { ok: true, code: 'not-applicable stage first' };
    if (!p.audit_workflow) return { ok: false, code: 'no-audit-workflow-named' };
    const t = now();
    const future = (await firstParent(api, p.repo, 100)).filter((c) => Date.parse(c.commit?.committer?.date) > t + FUTURE_SLACK);
    if (future.length) return { ok: false, code: `commit-dated-in-future ${future.length}` };
    const acts = await api(`/repos/${p.repo}/activity?ref=refs/heads/main&direction=desc&per_page=100`);
    if (!Array.isArray(acts)) return { ok: false, code: 'activity-unreadable' };
    // A full page that doesn't reach back 48 h may hide an unaudited update (0b-7 audit round 5 minor 1).
    const seen = acts.map((a) => Date.parse(a?.timestamp)).filter(Number.isFinite);
    if (acts.length >= 100 && !(Math.min(...seen) <= t - AUDIT_MAX_AGE)) return { ok: false, code: 'activity-window-not-covered' };
    // An update entry without the fields this reads is a FAIL, never "nothing due" (0b-7 audit round 2, M-3b).
    const updates = acts.filter((a) => MAIN_UPDATES.includes(a?.activity_type));
    const malformed = updates.filter((a) => !/^[0-9a-f]{40}$/.test(a.after ?? '') || !Number.isFinite(Date.parse(a.timestamp))).length;
    if (malformed) return { ok: false, code: `activity-entry-malformed ${malformed}` };
    const due = updates.filter((a) => {
      const age = t - Date.parse(a.timestamp);
      return age >= AUDIT_MIN_AGE && age <= AUDIT_MAX_AGE;
    });
    let missing = 0;
    for (const a of due) if (!(await auditOk(api, p.repo, p.audit_workflow, a.after))) missing += 1;
    return missing ? { ok: false, code: `main-update-without-audit ${missing}` } : { ok: true, code: `${due.length} main updates` };
  },
  // Every page is read (up to DEPLOY_PAGES), so previews newer than the live production deploy can't hide it; and a
  // product with no live production deploy found is a FAIL unless its entry says it has none (0b-7 audit round 2, M-3a).
  async deploys(p, { api }) {
    const all = [];
    for (let page = 1; page <= DEPLOY_PAGES; page++) {
      const batch = await api(`/repos/${p.repo}/deployments?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) return { ok: false, code: 'deployments-unreadable' };
      all.push(...batch);
      if (batch.length < 100) break;
    }
    const deps = all.filter((d) => String(d.environment ?? '').startsWith('Production'));
    for (const d of deps.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
      const [latest] = await api(`/repos/${p.repo}/deployments/${d.id}/statuses?per_page=1`);
      if (latest?.state !== 'success') continue;
      const { stage } = resolveStage(p);
      const main = new Set((await firstParent(api, p.repo)).map((c) => c.sha));
      const evidence = new Set();
      if (stage !== 'first' && p.audit_workflow && await auditOk(api, p.repo, p.audit_workflow, d.sha)) evidence.add(d.sha);
      const v = isSupported({ source: 'git', sha: d.sha }, { stage, mainFirstParent: main, evidence });
      return v.ok ? { ok: true, code: 'supported' } : { ok: false, code: 'unsupported-production-deploy' };
    }
    return p.no_production === true ? { ok: true, code: 'no-production-by-entry' } : { ok: false, code: 'no-live-production-deployment' };
  },
  // The robot's main updates, judged by GitHub's own record of who moved main and when (the activity list), not by
  // commit authors, which the pusher sets. Activity fields and the compare file cap as GitHub documents them,
  // 29 Oct 2026. Seen live on 30 Oct 2026: the activity fields on push and branch_creation entries, and a push's
  // compare files. Not yet checked live: pr_merge, merge_queue_merge and force_push entries, and the compare file cap
  // (Principle 9). The list is read unpaged (it pages by cursor in a header this
  // reader doesn't see): a full page that still reaches into the window means the window isn't covered → FAIL.
  async 'robot-merges'(p, { api, docsLane = {}, acked = {}, owner = {}, now }) {
    const lane = docsLane[p.label];
    if (!Array.isArray(lane) || !lane.length || lane.some((e) => typeof e !== 'string' || !e)) return { ok: false, code: 'no-pinned-docs-lane' };
    if (!p.robot) return { ok: false, code: 'no-robot-named' };
    const tag = owner?.tags?.[p.label];
    if (typeof tag !== 'string' || !SLOT_TAG.test(tag)) return { ok: false, code: 'no-pinned-slot-tag' };
    if (p.tag !== tag) return { ok: false, code: 'slot-tag-mismatch' };
    const t = now();
    const robot = String(p.robot).toLowerCase();
    const info = await api(`/repos/${p.repo}`);
    if (info?.default_branch !== 'main') return { ok: false, code: 'default-branch-not-main' };
    const acts = await api(`/repos/${p.repo}/activity?ref=refs/heads/main&time_period=week&direction=desc&per_page=100`);
    if (!Array.isArray(acts)) return { ok: false, code: 'activity-unreadable' };
    const times = acts.map((a) => Date.parse(a?.timestamp));
    if (times.some((x) => !Number.isFinite(x))) return { ok: false, code: 'activity-entry-malformed' };
    if (acts.length >= 100 && Math.min(...times) > t - ROBOT_WINDOW) return { ok: false, code: 'activity-window-not-covered' };
    const inWindow = acts.filter((a, i) => times[i] >= t - ROBOT_WINDOW);
    if (inWindow.some((a) => typeof a.actor?.login !== 'string' || !a.actor.login)) return { ok: false, code: 'activity-actor-missing' };
    const mine = inWindow.filter((a) => a.actor.login.toLowerCase() === robot);
    const queued = inWindow.filter((a) => a.activity_type === 'merge_queue_merge' && a.actor.login.toLowerCase() !== robot).length;
    const ok = new Set(Array.isArray(acked[p.label]) ? acked[p.label] : []);
    let outside = queued;
    for (const a of mine) {
      // The kind of update first: a force-push or an unknown kind is never excused by an acknowledgement (round 4 M-1).
      if (!MAIN_UPDATES.includes(a.activity_type) || a.activity_type === 'force_push') { outside += 1; continue; }
      if (ACKABLE.includes(a.activity_type) && typeof a.after === 'string' && ok.has(createHash('sha256').update(a.after).digest('hex'))) continue;
      if (!/^[0-9a-f]{40}$/.test(a.before ?? '') || !/^[0-9a-f]{40}$/.test(a.after ?? '') || /^0+$/.test(a.before)) return { ok: false, code: 'activity-entry-malformed' };
      // The compare's file list (up to 300) comes whole on its first page; paging only pages commits (round 4 minor).
      const c = await api(`/repos/${p.repo}/compare/${a.before}...${a.after}`);
      if (!Array.isArray(c?.files)) return { ok: false, code: 'compare-unreadable' };
      const files = c.files;
      if (files.length >= COMPARE_FILE_CAP) { outside += 1; continue; }
      const paths = files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
      if (!paths.length || paths.some((x) => !inDocsLane(x, lane))) outside += 1;
    }
    if (queued) return { ok: false, code: `merge-queue-merge-unverified ${queued}` };
    return outside ? { ok: false, code: `robot-change-outside-docs-lane ${outside}` } : { ok: true, code: `${mine.length} robot updates` };
  },
  async permissions(p, { api }) {
    const r = await api(`/repos/${p.repo}/actions/permissions/workflow`);
    return r.default_workflow_permissions === 'read' ? { ok: true, code: 'read' } : { ok: false, code: 'default-permissions-not-read' };
  },
};

// Runs one (check, slot); returns the public line. Never throws, never prints product data.
export async function runOne(check, slot, { products, api, pinned, docsLane, acked, owner, probe, self, selfOwner, now = () => Date.now() }) {
  const label = `product ${slot}`;
  // The outside repo's own lock runs once, under slot 1, whatever the product list holds (lead call L24).
  if (check === GUARD) {
    if (slot !== 1) return { line: `${label} / ${check}: FAIL guard-runs-in-slot-1`, ok: false, label };
    let r;
    try { r = await repoGuard({ api, probe, self, selfOwner }); }
    catch (e) { r = { ok: false, code: `check-error ${Number.isInteger(e?.status) ? e.status : 'exception'}` }; }
    return { line: `${label} / ${check}: ${r.ok ? 'ok' : 'FAIL'} ${r.code}`, ok: r.ok, label };
  }
  if (!CHECKS[check]) return { line: `${label} / ${check}: FAIL unknown-check`, ok: false, label };
  // A missing, empty or malformed product list fails every slot: a silent green would switch the net off (0b-7 audit M-5).
  if (!Array.isArray(products) || !products.length) return { line: `${label} / ${check}: FAIL products-missing`, ok: false, label };
  // A product past the last slot would never be checked; fail every slot rather than leave it unwatched (round 2 minor).
  if (products.length > SLOTS) return { line: `${label} / ${check}: FAIL products-over-slots`, ok: false, label };
  const p = products[slot - 1];
  if (p !== undefined && (!p || typeof p !== 'object' || !p.repo)) return { line: `${label} / ${check}: FAIL product-entry-malformed`, ok: false, label };
  // A slot the owner pinned for robot-merges must hold a product: an empty one would read green (round 4 M-2).
  if (!p && check === 'robot-merges' && (docsLane?.[label] !== undefined || owner?.tags?.[label] !== undefined)) return { line: `${label} / ${check}: FAIL pinned-slot-empty`, ok: false, label };
  if (!p) return { line: `${label} / ${check}: ok slot-empty`, ok: true, label, empty: true };
  let r;
  try { r = await CHECKS[check]({ ...p, label }, { api, pinned, docsLane, acked, owner, now }); }
  catch (e) { r = { ok: false, code: `check-error ${Number.isInteger(e?.status) ? e.status : 'exception'}` }; }
  return { line: `${label} / ${check}: ${r.ok ? 'ok' : 'FAIL'} ${r.code}`, ok: r.ok, label };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [check, slotArg] = process.argv.slice(2);
  let products = [];
  try { products = JSON.parse(process.env.PRODUCTS || '[]'); } catch { products = null; }
  const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
  const pinned = read('./pinned-audit-files.json');
  const docsLane = read('./pinned-docs-lane.json');
  const acked = read('./acknowledged-merges.json');
  const owner = read('./robot-merges-owner.json');
  const res = products === null
    ? { line: `product ${slotArg} / ${check}: FAIL products-secret-unreadable`, ok: false }
    : await runOne(check, Number(slotArg), { products, api: makeApi(process.env.CHECK_TOKEN), probe: makeProbe(process.env.CHECK_TOKEN),
      self: process.env.GITHUB_REPOSITORY, selfOwner: process.env.GITHUB_REPOSITORY_OWNER, pinned, docsLane, acked, owner });
  console.log(res.line);
  if (process.env.RESULTS && !res.empty) appendFileSync(process.env.RESULTS, `${res.line}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
