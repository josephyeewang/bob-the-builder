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
//   packageFor (tests only)                             stands in for M5 reviewPackage; the runner never passes it
// The wiring writes no settings of its own: it launches claude with `--settings <the file settingsFor wrote>` and no
// other settings source, and returns claude's own process id (L66), since it spawns the pinned claude itself.
// `ok: false` means claude was never spawned (L71 point 2).
//
// The prompt and the review package are M5's (R-0b-144): the package is worked out in the review copy once it is made.

import { FLAGS as F } from './settings-names.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { reviewPackage } from '../../M5-review-audit/review-package.mjs';
import { reviewerPrompt } from '../../M5-review-audit/reviewer-prompt.mjs';

const refuse = (reason) => ({ ok: false, reason });

export async function start(x) {
  const profile = DESIGN_PROFILES[x?.role];
  if (!profile) return refuse(`${x?.role} has no role profile`);
  let made; try { made = await x.makeCopy(); } catch (e) { made = refuse(e?.message ?? String(e)); }
  if (!made?.ok) return refuse(`the review copy: ${made?.reason ?? 'not made'}`);
  const pkg = await (x.packageFor ?? reviewPackage)({ copy: x.copy, head: x.head });
  if (!pkg?.ok) return refuse(`the review package: ${pkg?.reason ?? 'not made'}`);
  let text;
  try { text = reviewerPrompt({ ...x, pkg }); } catch (e) { return refuse(`the prompt: ${e?.message ?? e}`); }
  const s = x.settingsFor(x.copy);
  if (!s?.ok) return refuse(`the settings: ${s?.reason ?? 'not made'}`);
  const args = [F.print, F.outputFormat, F.streamJson, F.verbose, F.settings, s.file, F.sessionId, x.sessionId,
    F.strictMcpConfig, F.mcpConfig, '{"mcpServers":{}}', F.tools, profile.tools.join(','), F.permissionMode, profile.mode];
  if (profile.restricted) args.push(F.restricted);
  args.push(text);
  let child;
  try {
    child = x.spawn(x.claudeBin, args, { cwd: x.copy, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, ...x.env }, detached: true, stdio: 'ignore' });
  } catch (e) { return refuse(`claude could not be spawned (${e?.code ?? e?.message})`); }
  const pid = await new Promise((res) => {
    if (Number.isInteger(child?.pid)) { res(child.pid); return; }
    child?.once?.('spawn', () => res(child.pid));
    child?.once?.('error', () => res(null));
    if (!child?.once) res(null);
  });
  if (!Number.isInteger(pid)) return refuse('claude could not be spawned');
  child.unref?.();
  return { ok: true, pid };
}
