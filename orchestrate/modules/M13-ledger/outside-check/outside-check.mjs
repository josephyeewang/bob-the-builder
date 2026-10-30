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
//                success must be a supported main commit (supported.mjs, a byte-for-byte copy of Bob's M12 one).
//                GitHub deployments are created by the Git integration, so source is "git" here; a CLI deploy leaves
//                no GitHub deployment and is the Mini's watcher's to see.
//   permissions  the repo's Actions default token permission is "read".
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9: void on an API change).

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStage, isSupported } from './supported.mjs';

export const STALE_MIN = 70;
const AUDIT_MIN_AGE = 30 * 60e3;
const AUDIT_MAX_AGE = 48 * 3600e3;
const FIRST_PARENT_MAX = 200;

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

export const CHECKS = {
  async heartbeat(p, { api, now }) {
    const issues = await api(`/repos/${p.repo}/issues?labels=orchestrate-heartbeat&state=open&per_page=10`);
    const times = issues.filter((i) => i.user?.login === p.robot)
      .map((i) => /^mini_alive_at: (\S+)$/m.exec(i.body ?? '')?.[1]).map((t) => Date.parse(t)).filter(Number.isFinite);
    if (!times.length) return { ok: false, code: 'heartbeat-missing' };
    const age = Math.round((now() - Math.max(...times)) / 60e3);
    return age > STALE_MIN ? { ok: false, code: `heartbeat-stale ${age}min` } : { ok: true, code: `${age}min` };
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
  async 'audit-run'(p, { api, now }) {
    const { auditCheck } = resolveStage(p);
    if (!auditCheck) return { ok: true, code: 'not-applicable stage first' };
    if (!p.audit_workflow) return { ok: false, code: 'no-audit-workflow-named' };
    const t = now();
    const due = (await firstParent(api, p.repo)).filter((c) => {
      const age = t - Date.parse(c.commit?.committer?.date);
      return age >= AUDIT_MIN_AGE && age <= AUDIT_MAX_AGE;
    });
    let missing = 0;
    for (const c of due) if (!(await auditOk(api, p.repo, p.audit_workflow, c.sha))) missing += 1;
    return missing ? { ok: false, code: `main-commit-without-audit ${missing}` } : { ok: true, code: `${due.length} commits` };
  },
  async deploys(p, { api }) {
    const deps = (await api(`/repos/${p.repo}/deployments?per_page=50`)).filter((d) => String(d.environment ?? '').startsWith('Production'));
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
    return { ok: true, code: 'no-live-production-deployment' };
  },
  async permissions(p, { api }) {
    const r = await api(`/repos/${p.repo}/actions/permissions/workflow`);
    return r.default_workflow_permissions === 'read' ? { ok: true, code: 'read' } : { ok: false, code: 'default-permissions-not-read' };
  },
};

// Runs one (check, slot); returns the public line. Never throws, never prints product data.
export async function runOne(check, slot, { products, api, pinned, now = () => Date.now() }) {
  const label = `product ${slot}`;
  if (!CHECKS[check]) return { line: `${label} / ${check}: FAIL unknown-check`, ok: false, label };
  const p = products[slot - 1];
  if (!p) return { line: `${label} / ${check}: ok slot-empty`, ok: true, label, empty: true };
  let r;
  try { r = await CHECKS[check]({ ...p, label }, { api, pinned, now }); }
  catch (e) { r = { ok: false, code: `check-error ${Number.isInteger(e?.status) ? e.status : 'exception'}` }; }
  return { line: `${label} / ${check}: ${r.ok ? 'ok' : 'FAIL'} ${r.code}`, ok: r.ok, label };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [check, slotArg] = process.argv.slice(2);
  let products = [];
  try { products = JSON.parse(process.env.PRODUCTS || '[]'); } catch { products = null; }
  const pinned = JSON.parse(readFileSync(new URL('./pinned-audit-files.json', import.meta.url), 'utf8'));
  const res = products === null
    ? { line: `product ${slotArg} / ${check}: FAIL products-secret-unreadable`, ok: false }
    : await runOne(check, Number(slotArg), { products, api: makeApi(process.env.CHECK_TOKEN), pinned });
  console.log(res.line);
  if (process.env.RESULTS && !res.empty) appendFileSync(process.env.RESULTS, `${res.line}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
