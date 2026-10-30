// outside-check.mjs — the hourly outside check, run by GitHub Actions in its own public repo (R-0b-72; design v4 §8
// E6; review-0b-7 M2, M9, M13, M14 and minors). It watches the Mini from outside: if the Mini dies or is turned against
// a product, this still runs.
//
//   node outside-check.mjs <check> <slot>
//
// The product list is the PRODUCTS secret, JSON: [{ repo, stage, post_merge_audit, audit_workflow, robot }]. Slot N is
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
//                acknowledged-merges.json (as the SHA-256 of the commit id: this repo is public). A robot force-push, a list that can't be read or doesn't cover the window,
//                or no pinned docs lane → FAIL. The Mini records its last green time; the Merge Gate won't run unless
//                it was green within 2 hours (lead calls L19, L20; R-0b-72 lead_note).
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9: void on an API change).

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStage, isSupported } from './supported.mjs';
import { SLOTS } from './workflow.mjs';

export const STALE_MIN = 70;
const AUDIT_MIN_AGE = 30 * 60e3;
const AUDIT_MAX_AGE = 48 * 3600e3;
const FIRST_PARENT_MAX = 200;
const FUTURE_SLACK = 10 * 60e3;
const MAIN_UPDATES = ['push', 'force_push', 'pr_merge', 'merge_queue_merge'];
const DEPLOY_PAGES = 10;
export const ROBOT_WINDOW = 7 * 24 * 3600e3;
const COMPARE_FILE_CAP = 300;

class HttpError extends Error { constructor(status) { super(`http ${status}`); this.status = status; } }

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
  // a FAIL on its own. Activity list fields as GitHub documents them, 29 Oct 2026; not yet checked live (Principle 9).
  async 'audit-run'(p, { api, now }) {
    const { auditCheck } = resolveStage(p);
    if (!auditCheck) return { ok: true, code: 'not-applicable stage first' };
    if (!p.audit_workflow) return { ok: false, code: 'no-audit-workflow-named' };
    const t = now();
    const future = (await firstParent(api, p.repo, 100)).filter((c) => Date.parse(c.commit?.committer?.date) > t + FUTURE_SLACK);
    if (future.length) return { ok: false, code: `commit-dated-in-future ${future.length}` };
    const acts = await api(`/repos/${p.repo}/activity?ref=refs/heads/main&per_page=100`);
    if (!Array.isArray(acts)) return { ok: false, code: 'activity-unreadable' };
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
  // 29 Oct 2026; not yet checked live (Principle 9). The list is read unpaged (it pages by cursor in a header this
  // reader doesn't see): a full page that still reaches into the window means the window isn't covered → FAIL.
  async 'robot-merges'(p, { api, docsLane = {}, acked = {}, now }) {
    const lane = docsLane[p.label];
    if (!Array.isArray(lane) || !lane.length || lane.some((e) => typeof e !== 'string' || !e)) return { ok: false, code: 'no-pinned-docs-lane' };
    if (!p.robot) return { ok: false, code: 'no-robot-named' };
    const t = now();
    const robot = String(p.robot).toLowerCase();
    const acts = await api(`/repos/${p.repo}/activity?ref=refs/heads/main&time_period=week&per_page=100`);
    if (!Array.isArray(acts)) return { ok: false, code: 'activity-unreadable' };
    const times = acts.map((a) => Date.parse(a?.timestamp));
    if (times.some((x) => !Number.isFinite(x))) return { ok: false, code: 'activity-entry-malformed' };
    if (acts.length >= 100 && Math.min(...times) > t - ROBOT_WINDOW) return { ok: false, code: 'activity-window-not-covered' };
    const mine = acts.filter((a, i) => times[i] >= t - ROBOT_WINDOW && String(a.actor?.login ?? '').toLowerCase() === robot);
    const ok = new Set(Array.isArray(acked[p.label]) ? acked[p.label] : []);
    let outside = 0;
    for (const a of mine) {
      if (typeof a.after === 'string' && ok.has(createHash('sha256').update(a.after).digest('hex'))) continue;
      if (!MAIN_UPDATES.includes(a.activity_type) || a.activity_type === 'force_push') { outside += 1; continue; }
      if (!/^[0-9a-f]{40}$/.test(a.before ?? '') || !/^[0-9a-f]{40}$/.test(a.after ?? '') || /^0+$/.test(a.before)) return { ok: false, code: 'activity-entry-malformed' };
      const files = [];
      for (let page = 1; page <= COMPARE_FILE_CAP / 100; page++) {
        const c = await api(`/repos/${p.repo}/compare/${a.before}...${a.after}?per_page=100&page=${page}`);
        if (!Array.isArray(c?.files)) return { ok: false, code: 'compare-unreadable' };
        files.push(...c.files);
        if (c.files.length < 100) break;
      }
      if (files.length >= COMPARE_FILE_CAP) { outside += 1; continue; }
      const paths = files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
      if (!paths.length || paths.some((x) => !inDocsLane(x, lane))) outside += 1;
    }
    return outside ? { ok: false, code: `robot-change-outside-docs-lane ${outside}` } : { ok: true, code: `${mine.length} robot updates` };
  },
  async permissions(p, { api }) {
    const r = await api(`/repos/${p.repo}/actions/permissions/workflow`);
    return r.default_workflow_permissions === 'read' ? { ok: true, code: 'read' } : { ok: false, code: 'default-permissions-not-read' };
  },
};

// Runs one (check, slot); returns the public line. Never throws, never prints product data.
export async function runOne(check, slot, { products, api, pinned, docsLane, acked, now = () => Date.now() }) {
  const label = `product ${slot}`;
  if (!CHECKS[check]) return { line: `${label} / ${check}: FAIL unknown-check`, ok: false, label };
  // A missing, empty or malformed product list fails every slot: a silent green would switch the net off (0b-7 audit M-5).
  if (!Array.isArray(products) || !products.length) return { line: `${label} / ${check}: FAIL products-missing`, ok: false, label };
  // A product past the last slot would never be checked; fail every slot rather than leave it unwatched (round 2 minor).
  if (products.length > SLOTS) return { line: `${label} / ${check}: FAIL products-over-slots`, ok: false, label };
  const p = products[slot - 1];
  if (p !== undefined && (!p || typeof p !== 'object' || !p.repo)) return { line: `${label} / ${check}: FAIL product-entry-malformed`, ok: false, label };
  if (!p) return { line: `${label} / ${check}: ok slot-empty`, ok: true, label, empty: true };
  let r;
  try { r = await CHECKS[check]({ ...p, label }, { api, pinned, docsLane, acked, now }); }
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
  const res = products === null
    ? { line: `product ${slotArg} / ${check}: FAIL products-secret-unreadable`, ok: false }
    : await runOne(check, Number(slotArg), { products, api: makeApi(process.env.CHECK_TOKEN), pinned, docsLane, acked });
  console.log(res.line);
  if (process.env.RESULTS && !res.empty) appendFileSync(process.env.RESULTS, `${res.line}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
