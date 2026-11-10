// The review runner's wiring (R-0b-163, LEAD-CALLS L77 (2)): the one file the runner's config names as `wiring`, and
// the only place a review session's claude is spawned. It exports `start` and nothing else; the runner refuses a
// wiring with any other export at daemon start (review-runner-main.mjs `main`).
//
// start(x) gets from the runner (review-runner.mjs `runnerPass`, filled in by review-runner-main.mjs `realPorts`):
//   role, card, head, sessionId, outbox, env, earlier   the session, as the runner made it
//   packageDir                                          <root>/packages/<session>: the runner's folder the package goes in
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
//   packageFor (tests only)                             stands in for M5 reviewPackage; the runner never passes it
//
// The prompt and the review package are M5's (R-0b-144): the package is worked out in the review copy once it is made,
// and written into packageDir, never into the copy (M-1 (c), L83). Every answer once it is written carries its
// package_sha256, so the runner pins it whether or not claude starts.
// Once the copy, the package and the settings are made, every review session goes through the launcher (L83 M-3):
// launch.mjs's own launch(), checks 1 to 13, with the ports in review-launch.mjs. claude is spawned only after every
// check passed. The wiring writes no settings of its own: it launches claude with `--settings <the file settingsFor
// wrote>` and no other settings source, and returns claude's own process id (L66), since it spawns the pinned claude
// itself. `ok: false` means claude was never spawned (L71 point 2); a launch refusal carries the checks' log
// (`launch_log`).

import { DESIGN_PROFILES } from './role-profiles.mjs';
import { reviewPackage } from '../../M5-review-audit/review-package.mjs';
import { reviewerPrompt } from '../../M5-review-audit/reviewer-prompt.mjs';
import { launchReview, sessionArgs, spawnClaude } from './review-launch.mjs';

const refuse = (reason) => ({ ok: false, reason });

// The session's whole environment: the same object the launch checks read (check 9) and claude gets.
const sessionEnv = (x) => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, ...x.env });

export async function start(x) {
  const profile = DESIGN_PROFILES[x?.role];
  if (!profile) return refuse(`${x?.role} has no role profile`);
  let made; try { made = await x.makeCopy(); } catch (e) { made = refuse(e?.message ?? String(e)); }
  if (!made?.ok) return refuse(`the review copy: ${made?.reason ?? 'not made'}`);
  const pkg = await (x.packageFor ?? reviewPackage)({ copy: x.copy, head: x.head, dir: x.packageDir, since: x.audited });
  if (!pkg?.ok) return refuse(`the review package: ${pkg?.reason ?? 'not made'}`);
  const sha = { package_sha256: pkg.diffSha256 };
  const no = (reason, more = {}) => ({ ...refuse(reason), ...more, ...sha });
  let text;
  try { text = reviewerPrompt({ ...x, pkg }); } catch (e) { return no(`the prompt: ${e?.message ?? e}`); }
  const s = x.settingsFor(x.copy);
  if (!s?.ok) return no(`the settings: ${s?.reason ?? 'not made'}`);
  const args = sessionArgs({ profile, settingsFile: s.file, sessionId: x.sessionId, prompt: text, earlier: x.earlier });
  const env = sessionEnv(x);
  const li = x.launchInputs ?? {};
  let r;
  try {
    r = await launchReview({ ...li, role: x.role, profile, sessionId: x.sessionId, card: x.card, head: x.head, copy: x.copy, outbox: x.outbox,
      env, claudeBin: x.claudeBin, spawn: x.spawn, settings: s },
    { spawnSession: () => spawnClaude(x.spawn, x.claudeBin, args, { cwd: x.copy, env }), names: { ...(li.names ?? {}), flags: args.filter((a) => a.startsWith('--')), version: li.pin } });
  } catch (e) { return no(`the launch checks failed: ${e?.message ?? e}`); }
  if (!r?.ok) return no(r?.reason ?? 'the launch checks refused', { launch_log: r?.log ?? [] });
  return r.started?.ok ? { ...r.started, launch_log: r.log, ...sha } : no(r.started?.reason ?? 'claude could not be spawned', { launch_log: r.log });
}
