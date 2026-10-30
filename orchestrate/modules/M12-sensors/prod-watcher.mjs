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
const FINAL = ['READY', 'ERROR', 'CANCELED'];
// Vercel's deployment states as read on 29 Oct 2026 (Principle 9: re-check on a Vercel API change).
export const KNOWN_STATES = Object.freeze(['QUEUED', 'INITIALIZING', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'DELETED']);

// A missing field must never loosen the watch (0b-7 audit round 2, M-2): an answer in a shape the watcher doesn't know
// is "cannot read", never a quiet pass.
export function shapeProblems({ deps, live, settings }) {
  const p = [];
  if (!Array.isArray(deps)) return ['the deployment list is missing'];
  const badState = deps.filter((d) => !KNOWN_STATES.includes(d?.state)).length;
  if (badState) p.push(`${badState} deployment(s) with no known state`);
  if (deps.some((d) => !d?.uid)) p.push('a deployment with no id');
  if (deps.some((d) => d?.state === 'READY') && !live?.uid) p.push('ready deployments but no live production deployment id');
  if (!settings || typeof settings !== 'object') p.push('the project settings are missing');
  else for (const k of ['productionBranch', 'linkedRepo']) if (!settings[k]) p.push(`project setting ${k} is missing`);
  return p;
}

export async function watchOnce({ vercel, rulesEntry, mainFirstParent, evidence, writer, alerts, product }) {
  const id = stateFactId(product);
  const prev = writer.get(id);
  const out = [];
  const raise = async (kind, subject, title, body) => { out.push({ kind, subject, result: await alerts.raise({ key: `${product}|${kind}|${subject}`, title: `${product}: ${title}`, body }) }); };
  const readKey = `${product}|watcher-cannot-read|vercel`;
  let deps; let live; let env; let settings;
  try {
    [deps, live, env, settings] = await Promise.all([vercel.deployments(), vercel.live(), vercel.envMeta(), vercel.settings()]);
  } catch (e) {
    await raise('watcher-cannot-read', 'vercel', 'the production watcher cannot read Vercel', `The production watcher could not read Vercel${Number.isInteger(e?.status) ? ` (HTTP ${e.status})` : ''}. Production is not being watched until it can.`);
    return out;
  }
  const bad = shapeProblems({ deps, live, settings });
  if (bad.length) {
    await raise('watcher-cannot-read', 'vercel', 'the production watcher cannot read Vercel', `Vercel answered in a shape the production watcher does not know (${bad.join('; ')}). Production is not being watched until it can.`);
    return out;
  }
  await alerts.clear({ key: readKey, note: 'The production watcher can read Vercel again.' });
  const { stage, fallback } = resolveStage(rulesEntry);
  const judge = (d) => isSupported(d, { stage, mainFirstParent, evidence });

  if (fallback) await raise('no-stage', 'rules', 'rules entry has no stage', 'The product\'s rules entry has no stage (first/second), so the watcher uses the strict rule. Add the stage to the rules entry.');
  else await alerts.clear({ key: `${product}|no-stage|rules`, note: 'The rules entry has a stage again.' });

  const ready = deps.filter((d) => d.state === 'READY' && d.target === 'production');
  const seen = new Set(prev?.seen ?? []);
  if (prev) {
    for (const d of ready) {
      if (seen.has(d.uid)) continue;
      const v = judge(d);
      if (!v.ok) await raise('unsupported-deploy', d.uid, 'production deploy that is not a supported main commit', `Deployment ${d.uid} went live in production: ${v.why}.${d.sha ? ` Commit ${d.sha}.` : ''}`);
    }
  }
  // Only a deploy in a final state is remembered: one first seen while still building is judged when it turns READY
  // (0b-7 audit M-1).
  for (const d of deps) if (FINAL.includes(d.state)) seen.add(d.uid);

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
