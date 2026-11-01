// A review session's way through the launcher (L83 M-3, audit R-0b-147). The wiring's start (review-wiring.mjs) makes
// the review copy and the session's settings, then calls `launchReview`, which runs the same `launch()` every role runs
// (launch.mjs, checks 1 to 13), with a real port for each check that applies to a review role and nothing for the rest.
// There is no second copy of the launcher's order or stop: a check that applies and has no port here is refused by
// launch() itself ('no check is wired'), never passed. The session's claude is spawned only by the `spawnSession` the
// wiring hands in, and only once every check passed.
//
// The ports, by check (each calls the real check function next to launch.mjs):
//   1  fresh copy           the copy the runner just made: a plain folder of this user's alone, holding the head
//   2  setup files put back no port: the runner makes the review copy fresh for each session (prepareReviewCopy), so
//                           this check is to be declared not applicable for the review roles in their role profile
//                           (lane 2's role-profiles.mjs; the request is in the L83 report). Until then launch()
//                           refuses here, and no review starts.
//   3  outbox emptied       emptyOutbox (outbox.mjs), with `busy` the real "what holds this folder" port
//   4  dependencies         not a review role's check (launch.mjs: the worker's only)
//   5  role file            the settings file the runner wrote, read again without following a link: byte for byte what
//                           sessionSettings wrote (templateText of its settings), and checkSettings passes it
//   6  read-back            readBack (readback.mjs): the role headless, its start message compared with the role
//   7  hooks and version    checkVersion and checkHooks (hooks-check.mjs)
//   8  rules snapshot       written afresh from the runner's config just before (L83 minor), then checkSnapshot: fresh,
//                           its hash right, and its rules the config's
//   9  no stray keys        checkRoleEnv (env-check.mjs) on the environment the session gets
//   10 machine-wide block   checkMachineWide (env-check.mjs) on the machine-wide settings file the config names
//   11 smoke                smokeTest through lockedRunCommand (launch.mjs): one shell command, run by the role's own
//                           start with its own settings, tries to write outside the copy and reach github.com; it
//                           must first mark that it ran, or the smoke can't say and refuses
//   12 budget               M11's own check12 (gate.mjs, the function the Dispatcher's pass runs), given the budget
//                           source the config's `budget` module hands back; no module, no port
//   13 Bob method folder    checkBobFolder (launch.mjs) against the pinned file list the config's `bobManifest` names;
//                           no list, no port
// `launchReview` returns launch()'s answer: { ok, failedAt, reason, log } or { ok: true, log, started }.

import { lstatSync, openSync, fstatSync, readFileSync, closeSync, rmSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { launch, smokeTest, lockedRunCommand, checkBobFolder } from './launch.mjs';
import { roleArgs, readBack } from './readback.mjs';
import { checkVersion, checkHooks, checkSnapshot, productionProbe } from './hooks-check.mjs';
import { checkRoleEnv, checkMachineWide } from './env-check.mjs';
import { emptyOutbox } from './outbox.mjs';
import { checkSettings } from './render-settings.mjs';
import { templateText } from './review-settings.mjs';
import { check12 } from '../../M11-dispatcher/gate.mjs';
import { gitOk } from '../git/safe-git.mjs';
import { FLAGS as F } from './settings-names.mjs';

const refuse = (reason) => ({ ok: false, reason });
export const PROBE_MS = 120_000;
// The kind M11's start gate counts each review role as (gate.mjs CAP_FREE).
export const GATE_KIND = Object.freeze({ reviewer: 'review', auditor: 'audit' });
// The effort a send-back round runs at (R-0b-145).
export const SEND_BACK_EFFORT = 'xhigh';
// The smoke command's three files: one it writes first, inside the copy, to show it ran; one outside the copy; one it
// writes only if github.com answered.
export const smokeFiles = ({ copy, reviewHome, sessionId }) => ({
  ran: join(copy, `.orch-smoke-ran-${sessionId}`),
  outside: join(reviewHome, `.orch-smoke-outside-${sessionId}`),
  net: join(copy, `.orch-smoke-net-${sessionId}`),
});
const q = (p) => { if (/['\0\n]/.test(p)) throw new Error('a smoke path holds a quote or a line break'); return `'${p}'`; };
export function smokeCommand(f) {
  return `/usr/bin/touch ${q(f.ran)}; /usr/bin/touch ${q(f.outside)}; /usr/bin/curl -sS -m 5 -o /dev/null https://github.com && /usr/bin/touch ${q(f.net)}`;
}
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

// A file read whole without following a link. → its text, or throws.
function readNoLink(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error(`${p} is not a plain file`); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

// Runs a probe claude to its end (or the time limit) and hands back what it printed.
function runProbe(spawn, bin, args, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child; let out = '';
    try { child = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('the probe did not finish in time')); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); resolve({ exitCode: code, out }); });
  });
}

/** The session's own start: `--settings` the runner's file and no other source, the runner's session id, the role. */
export function sessionArgs({ profile, settingsFile, sessionId, prompt, earlier }) {
  const args = [F.print, F.outputFormat, F.streamJson, F.verbose, F.settings, settingsFile, F.sessionId, sessionId,
    F.strictMcpConfig, F.mcpConfig, '{"mcpServers":{}}', F.tools, profile.tools.join(','), F.permissionMode, profile.mode];
  if (profile.restricted) args.push(F.restricted);
  // A send-back (R-0b-145): a round after an earlier failing verdict on this card runs at the highest effort.
  if (typeof earlier === 'string' && earlier.trim()) args.push(F.effort, SEND_BACK_EFFORT);
  args.push(prompt);
  return args;
}

/** Spawns the session's claude, detached -> { ok, pid } (claude's own, L66) or { ok: false, reason }. */
export async function spawnClaude(spawn, bin, args, { cwd, env }) {
  let child;
  try {
    child = spawn(bin, args, { cwd, env, detached: true, stdio: 'ignore' });
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

/**
 * The ports for one review session. `x` is the wiring's start input plus what the wiring made:
 *   role, profile, sessionId, card, head, copy, outbox, env (the session's whole environment), claudeBin, pin,
 *   hooksDir, reviewHome, settings ({ file, settings } from settingsFor), rules (the config's), snapshot,
 *   writeSnapshot(path, rules), machineWide (path), busy(dir) → [holders], alert(text), spawn, ownUid(),
 *   cardDoc (the card from the Record), budget ({ rules, rec, bandsNow, runningNow } or null),
 *   bobFolder, bobManifest ({ path: sha256 } or null), probeMs.
 * → { [n]: async () => { ok, reason } }, with no entry for a check this role has no port for.
 */
export function reviewChecks(x) {
  const probeMs = x.probeMs ?? PROBE_MS;
  const ports = {
    1: async () => {
      let st; try { st = lstatSync(x.copy); } catch { return refuse('the review copy is missing'); }
      if (st.isSymbolicLink() || !st.isDirectory()) return refuse('the review copy is not a plain folder');
      if (st.uid !== x.ownUid() || st.mode & 0o077) return refuse('the review copy is not this user\'s alone (0700)');
      let h; try { h = (await gitOk(['rev-parse', 'HEAD'], { gitDir: join(x.copy, '.git'), workTree: x.copy, cwd: x.copy, purpose: 'review-launch-head', timeoutMs: 30_000 })).trim(); } catch (e) { return refuse(`the review copy's commit can't be read (${e?.message ?? e})`); }
      return h === x.head ? { ok: true } : refuse(`the review copy holds ${h.slice(0, 7)}, not the head ${x.head.slice(0, 7)}`);
    },
    3: async () => emptyOutbox(x.outbox, { busy: x.busy, alert: x.alert }),
    5: async () => {
      let back; try { back = readNoLink(x.settings.file); } catch (e) { return refuse(`the settings file can't be read back (${e?.code ?? e?.message})`); }
      let obj; try { obj = JSON.parse(back); } catch { return refuse('the settings file read back is not JSON'); }
      // The very bytes sessionSettings wrote (L83 minor 2), not only the same settings once parsed.
      if (back !== templateText(x.settings.settings) || !isDeepStrictEqual(obj, x.settings.settings)) return refuse('the settings file read back differs from what was written');
      return checkSettings(obj, { profile: x.profile });
    },
    6: async () => readBack({ claudeBin: x.claudeBin, args: roleArgs({ profile: x.profile, settingsFile: x.settings.file }), env: x.env, cwd: x.copy,
      role: x.role, profile: x.profile, pin: x.pin, spawnFn: x.spawn, timeoutMs: probeMs }),
    7: async () => {
      const v = checkVersion({ claudeBin: x.claudeBin, root: dirname(dirname(dirname(x.claudeBin))), pin: x.pin, ...(x.versionRun ? { run: x.versionRun } : {}) });
      if (!v.ok) return v;
      return checkHooks({ settings: x.settings.settings, hooksDir: x.hooksDir, ...(x.hooksSource ? { source: x.hooksSource } : {}), kinds: x.profile.outbox,
        copy: x.copy, outbox: x.outbox, harmfulProduction: productionProbe(x.rules) });
    },
    8: async () => {
      try { x.writeSnapshot(x.snapshot, x.rules); } catch (e) { return refuse(`the rules snapshot could not be written (${e?.code ?? e?.message})`); }
      const s = checkSnapshot(x.snapshot);
      if (!s.ok) return s;
      return isDeepStrictEqual(s.rules, x.rules) ? { ok: true } : refuse('the rules snapshot holds other rules than the runner\'s config');
    },
    9: async () => checkRoleEnv(x.env),
    10: async () => checkMachineWide({ readFile: readNoLink, path: x.machineWide }),
    11: async () => {
      const f = smokeFiles(x);
      for (const p of Object.values(f)) rmSync(p, { force: true });
      let cmd; try { cmd = smokeCommand(f); } catch (e) { return refuse(e.message); }
      const lr = lockedRunCommand({ claudeBin: x.claudeBin, settingsFile: x.settings.file, command: cmd, roleArgs, profile: x.profile });
      if (!lr.ok) return lr;
      try {
        return await smokeTest({
          run: async () => {
            await runProbe(x.spawn, lr.bin, lr.args, { cwd: x.copy, env: x.env }, probeMs);
            // Ran, and either reached the network or not. Not ran: it can't say, and the smoke refuses.
            return { networkReached: exists(f.net) ? true : exists(f.ran) ? false : undefined };
          },
          markerExists: () => exists(f.outside),
        });
      } finally { for (const p of Object.values(f)) rmSync(p, { force: true }); }
    },
  };
  if (x.budget) {
    const gate = check12(x.budget);
    ports[12] = async () => {
      if (!x.cardDoc) return refuse('the card is not in the Record');
      return gate({ card: x.cardDoc, kind: GATE_KIND[x.role], product: x.cardDoc.product });
    };
  }
  if (x.bobManifest) ports[13] = async () => checkBobFolder({ folder: x.bobFolder, manifest: x.bobManifest, settings: x.settings.settings });
  return ports;
}

/**
 * Runs launch() for one review session. `names` is { flags, version, confirmed? } (launch.mjs check 0; the settings
 * object is the session's own). `spawnSession()` spawns the session's claude → { ok, pid } | { ok: false, reason }.
 */
export function launchReview(x, { spawnSession, names = {}, ownUid = x.ownUid }) {
  return launch({ role: x.role, profile: x.profile, checks: reviewChecks(x), start: spawnSession,
    names: { ...names, settings: x.settings.settings }, ctx: { uids: x.uids }, ownUid });
}
