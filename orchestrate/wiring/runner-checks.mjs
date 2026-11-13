// Part C, runner step 6: the worker launch checks, the ports the start port (runner-ports.mjs startPort, its
// `checksFor`) hands to M4's launch() for an editing, undo or script session. As review-launch.mjs reviewChecks is for
// a review session, and built on it: a check that is the same for both roles is reviewChecks' own port, never a
// second copy. A check whose inputs the runner does not have gets no port, so launch() refuses there ("no check is
// wired") and nothing starts; no check is ever passed on a guess.
//
// The ports, by check (launch.mjs CHECKS):
//   1  fresh copy           reviewChecks' 1 on the card's copy: a plain folder of this user's alone (0700, which the
//                           job's Umask 077 gives), holding the head prepareWorkerCopy checked out
//   2  setup files put back setupFilesProblem below: every `.claude`, `.mcp.json` and `CLAUDE.local.md` in the copy (any
//                           depth outside a linked folder, which is not followed, as worker-copy.mjs removeProtected;
//                           any letter case, isProtectedName) is a plain file byte for byte main's in the mirror, no
//                           link, and each of main's is there (names compared after folding letter case, as the Mac's
//                           disk does), against the main commit the copy was restored from (`mainAt`, #369 r1 m3), so
//                           main moving during a launch is never read as the branch's tampering. The walk stops at
//                           WALK_LIMIT entries or WALK_DEPTH folders deep (#369 r1 c3). Names are compared after
//                           lower-casing, not after worker-copy.mjs `fold` (#369 r1 c2): fold also drops invisible
//                           characters, which the disk keeps, so a look-alike name would stand in for a missing file.
//                           Checks 1, 2, 3 and 8 run once more just before claude starts (#369 M1, r1 m1 and m2;
//                           runner-main.mjs startDeps `beforeStart`), since checks 4 and 11 run the branch's own code.
//   3  outbox emptied       reviewChecks' 3 (emptyOutbox, with `busy` the "what holds this folder" port)
//   4  dependencies         the install inside the lock-down (launch.mjs installStep), through the lock-down runner
//                           (runner-locked.mjs `runLocked`, L969), with the product's declared install command
//                           (render.product.commands.install) and its registry hosts (render.registryHosts). No runLocked
//                           or no install command, no port: launch() refuses a worker here, so a product with nothing
//                           to install launches no worker until it declares one (a cutover item; a no-op such as
//                           `true` passes). A script session skips check 4. A process an install script moves into its
//                           own session (setsid) outlives the group kill, in the copy (runner-locked.mjs; Mini proof 9.8).
//   5  role file            reviewChecks' 5: the settings file read back without following a link, byte for byte what
//                           the start port wrote (the same text form as review-settings.mjs templateText), and
//                           checkSettings passes it
//   6  read-back            reviewChecks' 6 (readBack)
//   7  hooks and version    reviewChecks' 7 (checkVersion, checkHooks with the product's rules)
//   8  rules snapshot       reviewChecks' 8: written afresh from the product's rules, then checkSnapshot
//   9  no stray keys        reviewChecks' 9 (checkRoleEnv on the environment claude gets)
//   10 machine-wide block   reviewChecks' 10 (checkMachineWide)
//   11 smoke and baseline   reviewChecks' smoke first, with the owner's home as the place outside the copy it must not
//                           write, so the lock-down is shown on before any of the branch's code runs (#369 M2); then a
//                           worker's baseline (the product's test command, run once through runner-locked.mjs guardedRun,
//                           must exit 0: its own process group recorded and killed with claude's, the Bash tool's wait its
//                           limit, BASELINE_MS 10 min, #463 r2 M3). The baseline never runs in the session's copy (#369 r1 M1): the start port makes a
//                           throwaway copy of the same commit (`x.throwaway()`), with its own settings that allow writes
//                           there only and deny the session's copy and outbox, and removes it after. So a process the
//                           tests leave running, one that started its own session (setsid) too, can't reach the copy
//                           claude starts in; the baseline's process group is killed after a normal end as well as on a
//                           time-out. A leftover may still write in the throwaway's place after it is removed (its
//                           settings allow it); nothing reads that place. Whether the smoke's and the baseline's claude,
//                           started in the copy, read the branch's CLAUDE.md (not a protected name) is not proven on the
//                           pin: if one does, the branch could steer the smoke to a false pass (#369 r1 m5), behind
//                           failIfUnavailable. A capability claim to prove on the Mini, void on a pin move. The baseline's exit code is written by
//                           the command into the copy, where the branch's code could forge it: it is a sanity check
//                           that the branch's tests pass, not a wall (#369 m1). Whether claude runs that one compound
//                           command under dontAsk (its exact allow rules reject `;` and `>`, so it rests on sandboxed
//                           shell commands being allowed) is not proven on the pinned version: a capability claim to
//                           prove in the live start on the Mini, void on a pin move; until then a refusal says "exit
//                           not written", which fails safe (#369 m5). A script session has no shell (role-profiles.mjs),
//                           so launch.mjs skips check 11 for it (#369 m6).
//   12 budget               M11's own check12 with this session's kind (gate.mjs counts editing, undo and script
//                           sessions themselves). The budget is check12's own inputs, and carries the pass's `filesOf`
//                           (#369 r2 m4): check12 works out an undo's exact reverse with it (lane 2's #393, gate.mjs;
//                           until it lands, check12 does not), so an undo is refused here, saying so, when the budget has
//                           none. The budget is the one main loaded from the config's `budget` (M11 budget.mjs); with
//                           none named, or one that could not be loaded, no port
//   13 Bob method folder    reviewChecks' 13 against the pinned file list; no list, no port
// The inputs come from the start port's `x` and the runner's config (runner-main.mjs workerCheckInputs).

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { reviewChecks } from '../modules/M4-workshop/launcher/review-launch.mjs';
import { baselineTest, installStep } from '../modules/M4-workshop/launcher/launch.mjs';
import { isProtectedName } from '../modules/M4-workshop/launcher/worker-copy.mjs';
import { git } from '../modules/M4-workshop/git/safe-git.mjs';
import { check12 } from '../modules/M11-dispatcher/gate.mjs';
import { randomBytes } from 'node:crypto';
import { LOCKED_MS, claudeEnd, exitCodeCommand, groupFile, guardedRun, jobGroupProblem, readNoLink } from './runner-locked.mjs';
import { foldKey } from '../shared/plan-fingerprint.mjs';

const refuse = (reason) => ({ ok: false, reason });
// The ports of guardedRun a test may swap in (#463 r2 self-review c1): its reads and waits, never what it runs.
const JOB_PORTS = Object.freeze(['read', 'info', 'pidStartOf', 'jobGone', 'pollMs', 'answer', 'rm']);
const jobPortsOf = (p) => (p && typeof p === 'object' ? Object.fromEntries(JOB_PORTS.filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]])) : {});
// #463 r2 M3 (L1010): the baseline runs as one Bash-tool command, so its limit is that tool's longest wait (LOCKED_MS,
// 10 min, a claim on claude 2.1.322: RECHECK ON EVERY UPGRADE of the pin), not the 15 min it had. A branch whose tests
// need longer is refused at the start ("did not finish in time"); its test command must be split by its product.
export const BASELINE_MS = LOCKED_MS;
const has = (v) => v !== undefined && v !== null && v !== '';
export const WALK_LIMIT = 200_000;
export const WALK_DEPTH = 64;
const SHA = /^[0-9a-f]{40}$/;

/**
 * Check 2: the copy's settings-bearing files are exactly main's. → null, or the reason. `run` is safe-git's git (a port).
 */
export async function setupFilesProblem({ copy, mirror, mainAt }, { run = git } = {}) {
  // The main commit the copy was restored from, when the start port read it; refs/heads/main for a bare call.
  const main = SHA.test(String(mainAt ?? '')) ? mainAt : 'refs/heads/main';
  let raw;
  try {
    const r = await run(['ls-tree', '-r', '-z', '--full-tree', main], { gitDir: mirror, purpose: 'runner-check-2-list', timeoutMs: 60_000 });
    if (r?.code !== 0) throw new Error(String(r?.stderr ?? '').trim().slice(0, 200) || `exit ${r?.code}`);
    raw = r.stdout.toString();
  } catch (e) { return `main's file list can't be read from the mirror (${e?.message ?? e})`; }
  // Keyed by the path with its letter case folded, as the Mac's disk stores it (#369 m7): main's `.claude/a` and
  // `.CLAUDE/b` land in one folder of the copy.
  const want = new Map();
  for (const rec of raw.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [mode, type, oid] = rec.slice(0, tab).split(' '); const path = rec.slice(tab + 1);
    if (!path.split('/').some(isProtectedName)) continue;
    // Only a plain file of main's is put back (worker-copy.mjs restoreMainCopies refuses a link, 120000).
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return `main's ${path} is not a plain file (mode ${mode})`;
    const k = foldKey(path);
    // A name that can't be folded can't be compared, so it never shares a key (#369 merge review minor 1).
    if (k === null) return `main's ${path} has a name that can't be compared`;
    want.set(k, { path, oid });
  }
  const found = [];
  let seen = 0;
  const entries = (dir, rel) => {
    if (rel.split('/').length > WALK_DEPTH) throw new Error(`more than ${WALK_DEPTH} folders deep at ${rel}`);
    const all = readdirSync(dir, { withFileTypes: true });
    if ((seen += all.length) > WALK_LIMIT) throw new Error(`more than ${WALK_LIMIT} files to look through`);
    return all;
  };
  const under = (dir, rel) => {
    for (const ent of entries(dir, rel)) {
      const r = rel ? `${rel}/${ent.name}` : ent.name; const p = join(dir, ent.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${r} is a link`);
      if (st.isDirectory()) under(p, r); else if (st.isFile()) found.push(r); else throw new Error(`${r} is not a plain file`);
    }
  };
  const walk = (dir, rel) => {
    for (const ent of entries(dir, rel)) {
      if (!rel && ent.name === '.git') continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name; const p = join(dir, ent.name);
      if (isProtectedName(ent.name)) {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) throw new Error(`${r} is a link`);
        if (st.isDirectory()) under(p, r); else if (st.isFile()) found.push(r); else throw new Error(`${r} is not a plain file`);
      } else if (ent.isDirectory() && !ent.isSymbolicLink()) walk(p, r);
    }
  };
  try { walk(copy, ''); } catch (e) { return `the copy's setup files: ${e?.message ?? e}`; }
  for (const r of found) {
    const k = foldKey(r);
    if (k === null) return `the copy's ${r} has a name that can't be compared`;
    const w = want.get(k);
    if (!w) return `the copy holds ${r}, which main does not`;
    const b = await run(['cat-file', 'blob', w.oid], { gitDir: mirror, purpose: 'runner-check-2-blob', timeoutMs: 60_000 });
    if (b?.code !== 0) return `main's ${r} can't be read from the mirror`;
    let mine; try { mine = readNoLink(join(copy, r)); } catch (e) { return `the copy's ${r} can't be read (${e?.code ?? e?.message})`; }
    if (!Buffer.from(b.stdout).equals(mine)) return `the copy's ${r} is not main's`;
  }
  const have = new Set(found.map((r) => foldKey(r)));
  const missing = [...want].filter(([k]) => !have.has(k)).map(([, w]) => w.path);
  return missing.length ? `main's ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not put back in the copy` : null;
}

/** The baseline's file (in the copy) its exit code is written to, and the one shell command (runner-locked.mjs's form). */
export const baselineFile = ({ copy, sessionId }) => join(copy, `.orch-baseline-${sessionId}`);
export const baselineCommand = (test, file) => exitCodeCommand(test, file, 'test command');

/**
 * The ports for one worker-runner session. x: the start port's { role, profile, kind, sessionId, card, cardDoc, product,
 * copy, outbox, env, head, mainAt, claudeBin, settings: { file, settings }, ownUid, throwaway() → { ok, copy, settingsFile,
 * done() } (the baseline's own copy, #369 r1 M1) } plus the config's { mirror, pin, hooksDir,
 * rules, snapshot, writeSnapshot, machineWide, busy, alert, spawn, home, testCommand, budget, bobFolder, bobManifest,
 * probeMs?, baselineMs?, nonce?, jobPorts? (guardedRun's read, info, pidStartOf, jobGone, pollMs, answer, rm: for tests) }. gateOf is M11's check12 (a port for tests). → { [n]: async () => { ok, reason } }, with no entry for a check whose inputs are not there.
 */
export function workerChecks(x, { gateOf = check12 } = {}) {
  const r = reviewChecks({ ...x, reviewHome: x.home });
  // reviewChecks' check 1 says "the review copy"; a worker's is the card's copy (#369 r1 c1).
  const ports = { 1: async () => { const a = await r[1](); return a?.ok ? a : { ...a, reason: String(a?.reason).replaceAll('the review copy', 'the copy') }; }, 5: r[5], 9: r[9] };
  if (has(x.mirror)) ports[2] = async () => { const p = await setupFilesProblem(x); return p ? refuse(p) : { ok: true }; };
  if (typeof x.busy === 'function') ports[3] = r[3];
  if (has(x.pin) && typeof x.spawn === 'function') ports[6] = r[6];
  if (has(x.pin) && has(x.hooksDir) && x.rules) ports[7] = r[7];
  if (has(x.snapshot) && x.rules && typeof x.writeSnapshot === 'function') ports[8] = r[8];
  if (has(x.machineWide)) ports[10] = r[10];
  if (typeof x.spawn === 'function' && has(x.home) && (x.role !== 'worker' || (has(x.testCommand) && typeof x.throwaway === 'function'))) {
    ports[11] = async () => {
      // The smoke first (#369 M2): the branch's tests run only once the lock-down is shown on.
      const smoke = await r[11]();
      if (!smoke?.ok || x.role !== 'worker') return smoke;
      // In a throwaway copy of the same commit, never the session's (#369 r1 M1).
      let t; try { t = await x.throwaway(); } catch (e) { t = refuse(`the baseline's throwaway copy can't be made (${e?.message ?? e})`); }
      if (!t?.ok) return t?.reason ? t : refuse('the baseline\'s throwaway copy can\'t be made (no answer)');
      let b;
      try {
        const f = baselineFile({ copy: t.copy, sessionId: x.sessionId });
        let cmd; try { cmd = baselineCommand(x.testCommand, f); } catch (e) { return refuse(e.message); }
        rmSync(f, { force: true });
        b = await baselineTest({ run: async () => {
          // #463 r2 M3 (L1010): as runLocked's jobs (guardedRun), the tests run in a process group of their own that is
          // recorded and kept before they start, killed with claude's at the limit and at claude's end, and the Bash
          // tool waits the whole limit. The baseline is a start check, so no group is kept in the runner's memory.
          const ran = await guardedRun({ spawn: x.spawn, claudeBin: x.claudeBin, settingsFile: t.settingsFile, inner: cmd, profile: x.profile, cwd: t.copy,
            env: x.env, ms: x.baselineMs ?? BASELINE_MS, killGroup: x.killGroup, groupThere: x.groupThere, label: 'the baseline',
            gfile: groupFile({ cwd: t.copy, job: 'baseline', sessionId: x.sessionId, run: (x.nonce ?? (() => randomBytes(8).toString('hex')))() }),
            ...jobPortsOf(x.jobPorts) });
          // Claude's own end (#463 r1 c3, as runLocked): one ended by a signal is no baseline, whatever it wrote.
          if (ran?.exitCode === null) return { exitCode: claudeEnd(ran) };
          // Its own group still there at claude's end, or never recorded (so the tests never ran as kept): no baseline.
          // One killed at claude's normal end is not (#369 r1 M1): the tests ran to their end, and their copy is thrown away.
          const left = jobGroupProblem(ran, 'the baseline', { killedOk: true });
          if (left) throw new Error(left);
          // The command's own exit code, as it wrote it; none written, and the baseline can't say (not 0).
          let text; try { text = readNoLink(f).toString('utf8').trim(); } catch { return { exitCode: `not written; ${claudeEnd(ran)}` }; }
          return { exitCode: /^\d{1,3}$/.test(text) ? Number(text) : text.slice(0, 20) };
        } });
      } finally { try { await t.done(); } catch { /* left for cleanup */ } }
      if (!b.ok) return b;
      return smoke;
    };
  }
  // Check 4 (L969): the product's install inside the lock-down, through installStep (the install-phase settings with the
  // registry's hosts, then the session's again, the registry shown gone). Only with the runner's runLocked, which
  // save-work has too (runner-main.mjs lockedWiring: one value, so a launch is never possible while a save is not, #456 r1 m3).
  if (typeof x.runLocked === 'function' && has(x.installCommand) && typeof x.renderPhase === 'function' && typeof x.writeSettings === 'function') {
    ports[4] = () => installStep({ render: x.renderPhase, write: x.writeSettings, registryHosts: Array.isArray(x.registryHosts) ? x.registryHosts : [],
      install: () => x.runLocked({ job: 'install', command: x.installCommand, sessionId: x.sessionId, role: x.role, settingsFile: x.settings?.file, cwd: x.copy,
        // The start's own environment (#463 r1 m6), which launch check 9 holds: the sign-in is not read a second time.
        ...(x.env && typeof x.env === 'object' ? { env: x.env } : {}) }) });
  }
  if (x.budget) {
    const gate = gateOf(x.budget);
    ports[12] = async () => {
      if (!x.cardDoc) return refuse('the card is not in the Record');
      if (x.kind === 'undo' && typeof x.budget.filesOf !== 'function') return refuse('the budget carries no filesOf (the pass\'s own), so the undo can\'t be shown an exact reverse');
      // The card with its id (L863): without one, check12 reads the card's own claim as an undo already running.
      // An undo's reversed commit too (L976): check12 holds it to the commit the card's source names.
      return gate({ card: { id: x.card, ...x.cardDoc }, kind: x.kind, product: x.product, ...(x.kind === 'undo' ? { undoCommit: x.undoCommit } : {}) });
    };
  }
  if (x.bobManifest && has(x.bobFolder)) ports[13] = r[13];
  return ports;
}
