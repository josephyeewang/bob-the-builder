// prod-watcher.mjs — the production watcher on the Mini (R-0b-71; design v4 §8 E5, v3 Module 7 and the watcher
// paragraph of Module 10; review-0b-7 M2–M4, M10). Detect-only: it never blocks, never deploys, never changes a setting.
//
// Every minute (the Dispatcher's schedule) it reads the product's production deployments, which deployment production
// serves, the production env list (names and update times only) and the project settings, through vercel-reader.mjs.
// It alerts on:
//   1. unsupported-deploy  a production deployment that became READY and isn't a supported main commit (supported.mjs:
//                          a CLI / redeploy / API deploy is never supported, whatever commit it carries);
//   2. old-version-live    production serves a deployment that isn't the newest supported one (a promotion of an older
//                          deployment, or a rollback). Cleared once production serves the newest supported one again;
//   3. setting-changed     a production env variable added, removed or updated (id, key, target, type, update time;
//                          never a value), or a project setting changed (build-skip command, build/install/output
//                          commands, root directory, framework, Node version, production branch, linked repo, domain
//                          auto-assign, production domains). The alert names the setting, never its value;
//   4. no-stage            the product's rules entry has no stage, so the strict rule is in use (supported.mjs).
// A cancelled build (the build-skip refused it) or a failed one is never READY and raises nothing.
//
// The FIRST pass only records a baseline (every deployment already there counts as seen; settings fingerprinted), so
// turning the watcher on never floods Joe with history. Each alert goes through M13's alerts (one updated issue per
// condition). The state of the last pass is one fact, `prod-watch-<product>`.
// Deliberately absent: the N14 ref watch (D15's approved-jobs ref) is second cutover (0b-11); don't add it here.

import { createHash } from 'node:crypto';
import { resolveStage, isSupported } from './supported.mjs';

export const stateFactId = (product) => `prod-watch-${String(product).replace(/[^A-Za-z0-9_-]/g, '-')}`;
const h = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
const SEEN_KEEP = 1000;

function envPrint(list) {
  const fp = {};
  for (const e of list) {
    if (!e.target.includes('production')) continue;
    fp[e.id] = { key: e.key, print: h([e.key, [...e.target].sort(), e.type, e.updatedAt]) };
  }
  return fp;
}
const settingsPrint = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, h(v)]));

// evidence: Set of SHAs with stage-second evidence (the robot's merge-gate status). mainFirstParent: Set of main SHAs.
export async function watchOnce({ vercel, rulesEntry, mainFirstParent, evidence, writer, alerts, product }) {
  const id = stateFactId(product);
  const prev = writer.get(id);
  const [deps, live, env, settings] = await Promise.all([vercel.deployments(), vercel.live(), vercel.envMeta(), vercel.settings()]);
  const { stage, fallback } = resolveStage(rulesEntry);
  const judge = (d) => isSupported(d, { stage, mainFirstParent, evidence });
  const out = [];
  const raise = async (kind, subject, title, body) => { out.push({ kind, subject, result: await alerts.raise({ key: `${product}|${kind}|${subject}`, title: `${product}: ${title}`, body }) }); };

  if (fallback) await raise('no-stage', 'rules', 'rules entry has no stage', 'The product\'s rules entry has no stage (first/second), so the watcher uses the strict rule. Add the stage to the rules entry.');

  const ready = deps.filter((d) => d.state === 'READY' && d.target === 'production');
  const seen = new Set(prev?.seen ?? []);
  if (prev) {
    for (const d of ready) {
      if (seen.has(d.uid)) continue;
      const v = judge(d);
      if (!v.ok) await raise('unsupported-deploy', d.uid, 'production deploy that is not a supported main commit', `Deployment ${d.uid} went live in production: ${v.why}.${d.sha ? ` Commit ${d.sha}.` : ''}`);
    }
  }
  for (const d of deps) seen.add(d.uid);

  const newest = ready.filter((d) => judge(d).ok).sort((a, b) => b.created - a.created)[0] ?? null;
  const oldKey = `${product}|old-version-live|production`;
  if (prev && live?.uid && newest && live.uid !== newest.uid) {
    await raise('old-version-live', 'production', 'production is not serving the newest supported deploy', `Production serves ${live.uid}; the newest supported main deploy is ${newest.uid}. An older deployment was promoted or rolled back.`);
  } else if (prev && live?.uid && newest && live.uid === newest.uid) {
    await alerts.clear({ key: oldKey, note: `Production serves the newest supported deploy ${newest.uid} again.` });
  }

  const ep = envPrint(env);
  const sp = settingsPrint(settings);
  if (prev) {
    for (const eid of new Set([...Object.keys(prev.env ?? {}), ...Object.keys(ep)])) {
      const a = prev.env?.[eid]; const b = ep[eid];
      if (a?.print === b?.print) continue;
      const what = !a ? 'added' : !b ? 'removed' : 'updated';
      await raise('setting-changed', `env:${eid}:${b?.print ?? 'gone'}`, `production setting ${(b ?? a).key} ${what}`, `Production environment variable ${(b ?? a).key} was ${what}. (Its value is never read.)`);
    }
    for (const k of new Set([...Object.keys(prev.settings ?? {}), ...Object.keys(sp)])) {
      if (prev.settings?.[k] === sp[k]) continue;
      await raise('setting-changed', `project:${k}:${sp[k] ?? 'gone'}`, `project setting ${k} changed`, `The project setting ${k} changed in Vercel. If nobody meant to, check it on the dashboard.`);
    }
  }

  writer.put(id, { kind: 'fact.prod-watch', product, stage, live: live?.uid ?? null, newest_supported: newest?.uid ?? null,
    env: ep, settings: sp, seen: [...seen].slice(-SEEN_KEEP), baseline: !prev });
  return out;
}
