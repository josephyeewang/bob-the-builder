// The start gate per repo (design v4 §8.3 D4; review 0b-4 M7, m8; lead call L3).
//
// No card branch is pushed to a repo unless four facts hold, each fresh and for that repo:
//   1. GitHub Actions' default for the repo is read-only: the outside check's run record says so
//      (its per-product step passed). Read at most once an hour; older than 2 hours = not read-only.
//   2. Every workflow on the repo's main passes the workflow audit rule (M6, R-0b-92), worked out
//      here on the mirror's fresh main. Until that rule exists, this fact fails.
//   3. The Vercel project's skip command is the pinned one, and
//   4. no Vercel variable is set in both Preview and Production. M12 Sensors read Vercel and write
//      facts 3 and 4 into the record (L3); this file only reads them. Older than 10 minutes = shut.
// Anything missing, malformed, for the wrong repo or project, or stale shuts the gate. A shut
// gate raises one GitHub issue to the owner, updated rather than opened again while it stays shut.
//
// The fact shapes M12 must write (record entity 'fact'):
//   id `start_gate.vercel_skip.<product>`, `start_gate.vercel_env.<product>`
//   doc { product, vercel_project, read_at (ISO time), result: true | false }

import { gitOk } from './safe-git.mjs';

export const FACT1_MAX_AGE_MS = 2 * 3600 * 1000;
export const FACT1_READ_EVERY_MS = 3600 * 1000;
export const VERCEL_FACT_MAX_AGE_MS = 10 * 60 * 1000;
export const OUTSIDE_EVENTS = Object.freeze(['schedule', 'workflow_dispatch']);
export const factId = (kind, product) => `start_gate.${kind}.${product}`;

const shut = (reason) => ({ ok: false, reason });
export const FUTURE_ALLOWANCE_MS = 60 * 1000;
// A date more than a minute ahead is not believed: it counts as stale (R-0b-47 MIN-2).
const age = (now, at) => { const t = Date.parse(at); return Number.isFinite(t) && now - t >= -FUTURE_ALLOWANCE_MS ? now - t : Infinity; };

/**
 * Fact 1. `readRun()` returns the outside check's newest run record, read keyless from its
 * public repo: { workflow_path, event, head_branch, run_at, steps: [{ product, conclusion }] }.
 * `cache` is an object kept between pushes, so the run is read at most once an hour.
 */
export async function actionsReadOnly({ product, readRun, workflowPath, cache, now }) {
  if (!cache.run || now - cache.readAt >= FACT1_READ_EVERY_MS) {
    try { cache.run = await readRun(); } catch { cache.run = null; }
    cache.readAt = now;
  }
  const run = cache.run;
  if (!run || typeof run !== 'object') return shut('the outside check\'s run record could not be read');
  if (run.workflow_path !== workflowPath) return shut('the outside check\'s run is not from the pinned workflow');
  if (!OUTSIDE_EVENTS.includes(run.event)) return shut('the outside check\'s run was not a scheduled or manual run');
  if (run.head_branch !== 'main') return shut('the outside check\'s run was not on main');
  if (!(age(now, run.run_at) <= FACT1_MAX_AGE_MS)) return shut('the outside check has not run in the last 2 hours');
  const step = Array.isArray(run.steps) ? run.steps.find((s) => s?.product === product) : null;
  if (step?.conclusion !== 'success') return shut('the outside check does not show this repo\'s Actions default as read-only');
  return { ok: true };
}

/**
 * Fact 2. Lists the workflow files on the mirror's main (no checkout) and runs `workflowRule`
 * ({ path, text }) -> { ok, reason } on each. No rule wired = the fact fails.
 */
export async function workflowsPass({ mirror, workflowRule }) {
  if (typeof workflowRule !== 'function') return shut('the workflow audit rule (R-0b-92) is not built yet');
  let raw;
  try { raw = await gitOk(['ls-tree', '-r', '-z', '--full-tree', 'refs/heads/main', '--', '.github/workflows'], { gitDir: mirror, purpose: 'start-gate-workflows' }); } catch { return shut('could not list main\'s workflows'); }
  for (const ent of raw.split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(ent);
    if (!m) return shut('could not read main\'s workflow list');
    if (m[2] !== 'blob' || m[1] === '120000') return shut(`${m[4]} on main is not a plain file`);
    let text;
    try { text = await gitOk(['cat-file', 'blob', m[3]], { gitDir: mirror, purpose: 'start-gate-workflows' }); } catch { return shut(`could not read ${m[4]} on main`); }
    let r;
    try { r = await workflowRule({ path: m[4], text }); } catch (e) { r = shut(e.message); }
    if (r?.ok !== true) return shut(`${m[4]} on main fails the workflow audit rule: ${r?.reason ?? 'no answer'}`);
  }
  return { ok: true };
}

/** Facts 3 and 4, read from the record. */
export function vercelFact({ record, kind, product, vercelProject, now }) {
  const label = kind === 'vercel_skip' ? 'the pinned Vercel skip command' : 'no Vercel value in both Preview and Production';
  const f = record.read('fact', factId(kind, product));
  const d = f?.doc;
  if (!d || typeof d !== 'object') return shut(`no fact yet for ${label}`);
  if (d.product !== product || d.vercel_project !== vercelProject) return shut(`the fact for ${label} is for another project`);
  if (!(age(now, d.read_at) <= VERCEL_FACT_MAX_AGE_MS)) return shut(`the fact for ${label} is older than 10 minutes`);
  if (d.result !== true) return shut(`the start gate fails: not ${label}`);
  return { ok: true };
}

/**
 * The whole gate. On a shut gate, `issues.upsert({ key, title, body })` is called once (the
 * writer updates an open issue with the same key instead of opening another).
 */
export async function startGate({ product, mirror, record, readRun, workflowPath, workflowRule, vercelProject, cache, issues, now = Date.now() }) {
  const checks = [
    () => actionsReadOnly({ product, readRun, workflowPath, cache, now }),
    () => workflowsPass({ mirror, workflowRule }),
    () => vercelFact({ record, kind: 'vercel_skip', product, vercelProject, now }),
    () => vercelFact({ record, kind: 'vercel_env', product, vercelProject, now }),
  ];
  for (const c of checks) {
    let r;
    try { r = await c(); } catch (e) { r = shut(`the start gate failed: ${e.message}`); }
    if (r?.ok !== true) {
      const reason = r?.reason ?? 'no answer';
      try {
        await issues.upsert({ key: `start-gate-${product}`, title: `Pushes to ${product} are stopped`, body: `No card branch will be pushed to ${product} until this is fixed: ${reason}.` });
      } catch { /* the push is refused either way */ }
      return shut(reason);
    }
  }
  return { ok: true };
}
