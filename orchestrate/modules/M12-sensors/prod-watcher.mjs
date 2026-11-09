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
//                          auto-assign, system-variable access, production domains). The alert names the setting,
//                          never its value;
//   4. no-stage            the product's rules entry has no stage, so the strict rule is in use (supported.mjs);
//   5. system-vars-off     Vercel's "Enable access to System Environment Variables" box (autoExposeSystemEnvs) is not
//                          on, or Vercel did not report it. Checked on every pass, the first included, and cleared once
//                          it is on (L716, #277 r1 Minor 1, 2): with it off the build-skip line sees no branch and skips
//                          every production build, and a skipped build raises nothing here.
// A cancelled build (the build-skip refused it) or a failed one is never READY and raises nothing.
//
// The FIRST pass only records a baseline (every deployment already there counts as seen; settings fingerprinted), so
// turning the watcher on never floods the owner with history. Each alert goes through M13's alerts (one updated issue per
// condition). The state of the last pass is one fact, `prod-watch-<product>`.
// Deliberately absent: the N14 ref watch (D15's approved-jobs ref) is second cutover (0b-11); don't add it here.

import { createHash } from 'node:crypto';
import { TROUBLE_SOURCES, wasSaved } from './facts.mjs';
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

export async function watchOnce(pass) {
  const out = await watch(pass);
  // The Record refusing alert writes gets its own alert (L402), and either answer shows like any other.
  const result = await pass.alerts.reportTrouble(pass.product, TROUBLE_SOURCES.WATCHER);
  if (result !== 'none') out.push({ kind: 'alerts', subject: 'record-refusing', result });
  const login = await pass.alerts.loginTrouble?.();
  if (login) out.push({ kind: 'alerts', subject: 'robot-login', result: login });
  return out;
}

async function watch({ vercel, rulesEntry, mainFirstParent, evidence, writer, alerts, product }) {
  const id = stateFactId(product);
  const prev = writer.get(id);
  const out = [];
  // Answers whether the alert went out: not when M13 lost it (L143). What the pass saves after a raise (a deploy seen, a
  // setting's baseline) is saved only when it went out, so a lost alert is raised again next pass.
  // With no status the body is the cause, which suits a body that's fixed for its key. One that isn't passes a status
  // (L376), or a figure in it would read as a new cause and open a new issue after each close.
  const raise = async (kind, subject, title, body, status) => {
    const result = await alerts.raise({ key: `${product}|${kind}|${subject}`, title: `${product}: ${title}`, body, ...(status ? { status } : {}) });
    out.push({ kind, subject, result });
    return result !== false;
  };
  // A clear GitHub lost shows in the pass's answer, as a raise's does. One with nothing to clear does not show.
  // Answers whether the clear went through (or had nothing to clear): not when GitHub lost it (L143).
  const clear = async (kind, subject, note) => {
    const result = await alerts.clear({ key: `${product}|${kind}|${subject}`, note });
    if (result !== 'none') out.push({ kind, subject, result });
    return result !== false;
  };
  let deps; let live; let env; let settings;
  try {
    [deps, live, env, settings] = await Promise.all([vercel.deployments(), vercel.live(), vercel.envMeta(), vercel.settings()]);
  } catch (e) {
    await raise('watcher-cannot-read', 'vercel', 'the production watcher cannot read Vercel', `The production watcher could not read Vercel${Number.isInteger(e?.status) ? ` (HTTP ${e.status})` : ''}. Production is not being watched until it can.`, 'cannot-read');
    return out;
  }
  const bad = shapeProblems({ deps, live, settings });
  if (bad.length) {
    await raise('watcher-cannot-read', 'vercel', 'the production watcher cannot read Vercel', `Vercel answered in a shape the production watcher does not know (${bad.join('; ')}). Production is not being watched until it can.`, 'cannot-read');
    return out;
  }
  await clear('watcher-cannot-read', 'vercel', 'The production watcher can read Vercel again.');
  // Vercel's API reference types the field boolean, but its own example shows the text "false" (#277 r1): accept both.
  const sv = settings.autoExposeSystemEnvs;
  if (sv === true || sv === 'true') await clear('system-vars-off', 'vercel', 'Vercel\'s system environment variables are on again.');
  else {
    const off = sv === false || sv === 'false';
    await raise('system-vars-off', 'vercel', off ? 'Vercel system variables are off: every production build is skipped' : 'Vercel did not report its system-variables setting: production builds may all be skipped',
      `${off ? 'The Vercel setting "Enable access to System Environment Variables" (Settings, Environment Variables) is off.' : 'Vercel\'s answer did not say whether "Enable access to System Environment Variables" (Settings, Environment Variables) is on, so it is not known to be on.'} With it off, the build-skip line sees no branch and skips every production build, and nothing else says so. Tick the box on the dashboard.`,
      off ? 'off' : 'not-reported');
  }
  const { stage, fallback } = resolveStage(rulesEntry);
  const judge = (d) => isSupported(d, { stage, mainFirstParent, evidence });

  if (fallback) await raise('no-stage', 'rules', 'rules entry has no stage', 'The product\'s rules entry has no stage (first/second), so the watcher uses the strict rule. Add the stage to the rules entry.');
  else await clear('no-stage', 'rules', 'The rules entry has a stage again.');

  const ready = deps.filter((d) => d.state === 'READY' && d.target === 'production');
  const seen = new Set(prev?.seen ?? []);
  const lostDeploys = new Set();
  if (prev) {
    for (const d of ready) {
      if (seen.has(d.uid)) continue;
      const v = judge(d);
      if (!v.ok && !(await raise('unsupported-deploy', d.uid, 'production deploy that is not a supported main commit', `Deployment ${d.uid} went live in production: ${v.why}.${d.sha ? ` Commit ${d.sha}.` : ''}`))) lostDeploys.add(d.uid);
    }
  }
  // Only a deploy in a final state is remembered: one first seen while still building is judged when it turns READY
  // (0b-7 audit M-1).
  for (const d of deps) if (FINAL.includes(d.state) && !lostDeploys.has(d.uid)) seen.add(d.uid);

  const newest = ready.filter((d) => judge(d).ok).sort((a, b) => b.created - a.created)[0] ?? null;
  if (prev && live?.uid && newest && live.uid !== newest.uid) {
    await raise('old-version-live', 'production', 'production is not serving the newest supported deploy', `Production serves ${live.uid}; the newest supported main deploy is ${newest.uid}. An older deployment was promoted or rolled back.`);
  } else if (prev && live?.uid && newest && live.uid === newest.uid) {
    await clear('old-version-live', 'production', `Production serves the newest supported deploy ${newest.uid} again.`);
  }

  const ep = envPrint(env);
  const sp = settingsPrint(settings);
  // The baseline saved: the new prints, except a change whose alert was lost keeps its old print (or stays absent).
  const keepEnv = { ...ep }; const keepSp = { ...sp };
  const keepOld = (to, k, old) => { if (old === undefined) delete to[k]; else to[k] = old; };
  // Old-value alerts whose clear GitHub lost: tried again each pass (L143), never holding the baseline (L152 m1).
  const unclear = new Set();
  const clearOld = async (subject, note) => { if (!(await clear('setting-changed', subject, note))) unclear.add(subject); };
  for (const subject of prev?.unclear ?? []) await clearOld(subject, 'The project setting changed again.');
  if (prev) {
    for (const eid of new Set([...Object.keys(prev.env ?? {}), ...Object.keys(ep)])) {
      const a = prev.env?.[eid]; const b = ep[eid];
      if (a?.print === b?.print) continue;
      const what = !a ? 'added' : !b ? 'removed' : 'updated';
      if (!(await raise('setting-changed', `env:${eid}:${b?.print ?? 'gone'}`, `production setting ${(b ?? a).key} ${what}`, `Production environment variable ${(b ?? a).key} was ${what}. (Its value is never read.)`))) keepOld(keepEnv, eid, a);
    }
    for (const k of new Set([...Object.keys(prev.settings ?? {}), ...Object.keys(sp)])) {
      const was = prev.settings?.[k];
      if (was === sp[k]) continue;
      // The alert's key holds the new value's print, so the old value's alert is cleared first: a later return to that
      // value is then told again, even if Joe closed its issue (L716, #277 r1 M1; M13 reopens a cleared condition, L371).
      // A lost raise keeps the old print, so the next pass raises again (L143); a lost clear is kept in `unclear`.
      if (was !== undefined) await clearOld(`project:${k}:${was}`, `The project setting ${k} changed again.`);
      // A return to a value whose own clear GitHub has still lost (#277 r2 m1): its old issue is open, so a raise now would
      // land on it and tell nothing, and the retry would later close it while the value stands. Keep the old print: the
      // pass whose retry clears it then sees the change again and raises it as new.
      if (unclear.has(`project:${k}:${sp[k] ?? 'gone'}`)) { keepOld(keepSp, k, was); continue; }
      if (!(await raise('setting-changed', `project:${k}:${sp[k] ?? 'gone'}`, `project setting ${k} changed`, `The project setting ${k} changed in Vercel. If nobody meant to, check it on the dashboard.`))) keepOld(keepSp, k, was);
    }
  }

  // A baseline that isn't saved is a silent watcher: with none, every pass is a first pass and alerts on nothing (L393).
  const put = writer.put(id, { kind: 'fact.prod-watch', product, stage, live: live?.uid ?? null, newest_supported: newest?.uid ?? null,
    env: keepEnv, settings: keepSp, unclear: [...unclear].slice(-SEEN_KEEP), seen: [...seen].slice(-SEEN_KEEP), baseline: !prev });
  if (wasSaved(put)) await clear('watcher-cannot-save', 'baseline', 'The production watcher can save what it saw again.');
  else await raise('watcher-cannot-save', 'baseline', 'the production watcher cannot save what it saw', `The Record refused what the production watcher saw (${String(put?.reason ?? 'no reason given').slice(0, 200)}). Production is not being watched properly until it can save it.`, 'cannot-save');
  return out;
}
