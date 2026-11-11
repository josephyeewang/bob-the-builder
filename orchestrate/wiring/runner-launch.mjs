// Part C, runner step 2 (L757, L759; #320 M1 and M3): the worker runner's launch wall. The workers run as the runner's own
// Mac user, so nothing but their settings keeps a worker from writing the runner's status or a request (L751). Before the
// runner starts any session it renders that session's settings with its own two paths and starts it only if #320's
// checkRunnerWall passes on them, with those paths as real paths. A launch that fails either is refused: "not walled".
//
// The role is the kind's (owner-status.mjs RUNNER_ROLE_OF), never one the request names. A role with no design profile
// can't be rendered, so it is refused here: no session runs unwalled. (Lane 2 has since added the script profile, L757,
// so a script launch now gets the script role's settings with the wall.)

import { checkRunnerWall, renderRoleSettings } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { checkProfile } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { RUNNER_ROLE_OF } from './owner-status.mjs';

const refuse = (reason) => ({ ok: false, reason: `not walled: ${reason}` });

/**
 * kind: the launch request's kind. workerRunner: the runner's own { requestsDir, statusFile }, which replace any in
 * `paths`. The rest goes to renderRoleSettings as is (profile, paths, product, rulesHosts, productionFiles, ...).
 * → { ok: true, role, settings } | { ok: false, reason }
 */
export function walledLaunchSettings({ kind, workerRunner, render = renderRoleSettings, check = checkRunnerWall, realpath, paths, ...rest }) {
  if (typeof kind !== 'string' || !Object.hasOwn(RUNNER_ROLE_OF, kind)) return refuse(`the worker runner does not start ${JSON.stringify(kind)} sessions`);
  const role = RUNNER_ROLE_OF[kind];
  if (!paths || typeof paths !== 'object') return refuse('the launch has no session paths');
  // The profile must be this role's, inside its design ceiling (review m4): never another role's tools or mode.
  const pc = checkProfile(role, rest.profile);
  if (!pc.ok) return refuse(pc.reason);
  const r = render({ ...rest, role, paths: { ...paths, workerRunner }, ...(realpath ? { realpath } : {}) });
  if (!r?.ok) return refuse(`the ${role} settings can't be made (${r?.reason ?? 'no answer'})`);
  const c = check({ settings: r.settings, workerRunner, paths, ...(realpath ? { realpath } : {}) });
  if (!c?.ok) return refuse(c?.reason ?? 'the wall check gave no answer');
  return { ok: true, role, settings: r.settings };
}
