// The review runner's wiring (R-0b-163, LEAD-CALLS L77 (2)): the one file the runner's config names as `wiring`, and
// the only place a review session's claude is spawned. It exports `start` and nothing else; the runner refuses a
// wiring with any other export at daemon start (review-runner-main.mjs `main`).
//
// start(x) gets from the runner (review-runner.mjs `runnerPass`, filled in by review-runner-main.mjs `realPorts`):
//   role, card, head, sessionId, outbox, env, earlier   the session, as the runner made it
//   claudeBin                                           the pinned claude, inside the installed copy (checked)
//   copy, makeCopy()                                    the review copy's one path, <reviewCopies>/<session> (the same
//                                                       path the runner removes once the session's ended record is
//                                                       written, L77 m9), and the step that fills it from the mirror
//   settingsFor(copy)                                   the runner's settings maker (review-settings.mjs sessionSettings)
//   spawn                                               child_process.spawn (a port, so a test runs no claude)
//   launchInputs                                        what the launch checks read (review-launch.mjs reviewChecks):
//                                                       pin, hooksDir, reviewHome, rules, snapshot, writeSnapshot,
//                                                       machineWide, busy, alert, ownUid, uids, cardDoc, budget,
//                                                       bobFolder, bobManifest, names
// Once the copy and the settings are made, every review session goes through the launcher (L83 M-3): launch.mjs's own
// launch(), checks 1 to 13, with the ports in review-launch.mjs. claude is spawned only after every check passed.
// The wiring writes no settings of its own: it launches claude with `--settings <the file settingsFor wrote>` and no
// other settings source, and returns claude's own process id (L66), since it spawns the pinned claude itself.
// `ok: false` means claude was never spawned (L71 point 2); a launch refusal carries the checks' log (`launch_log`).

import { DESIGN_PROFILES } from './role-profiles.mjs';
import { launchReview, sessionArgs, spawnClaude } from './review-launch.mjs';

const refuse = (reason) => ({ ok: false, reason });

function prompt(x) {
  return [
    `You are the ${x.role} for card ${x.card} at commit ${x.head}. The change is in your working folder.`,
    `Hand in your verdict as one file in ${x.outbox}.`,
    x.earlier || '',
  ].filter(Boolean).join('\n\n');
}

// The session's whole environment: the same object the launch checks read (check 9) and claude gets.
const sessionEnv = (x) => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, ...x.env });

export async function start(x) {
  const profile = DESIGN_PROFILES[x?.role];
  if (!profile) return refuse(`${x?.role} has no role profile`);
  let made; try { made = await x.makeCopy(); } catch (e) { made = refuse(e?.message ?? String(e)); }
  if (!made?.ok) return refuse(`the review copy: ${made?.reason ?? 'not made'}`);
  const s = x.settingsFor(x.copy);
  if (!s?.ok) return refuse(`the settings: ${s?.reason ?? 'not made'}`);
  const args = sessionArgs({ profile, settingsFile: s.file, sessionId: x.sessionId, prompt: prompt(x) });
  const env = sessionEnv(x);
  const li = x.launchInputs ?? {};
  let r;
  try {
    r = await launchReview({ ...li, role: x.role, profile, sessionId: x.sessionId, card: x.card, head: x.head, copy: x.copy, outbox: x.outbox,
      env, claudeBin: x.claudeBin, spawn: x.spawn, settings: s },
    { spawnSession: () => spawnClaude(x.spawn, x.claudeBin, args, { cwd: x.copy, env }), names: { ...(li.names ?? {}), flags: args.filter((a) => a.startsWith('--')), version: li.pin } });
  } catch (e) { return refuse(`the launch checks failed: ${e?.message ?? e}`); }
  if (!r?.ok) return { ...refuse(r?.reason ?? 'the launch checks refused'), launch_log: r?.log ?? [] };
  return r.started?.ok ? { ...r.started, launch_log: r.log } : { ...refuse(r.started?.reason ?? 'claude could not be spawned'), launch_log: r.log };
}
