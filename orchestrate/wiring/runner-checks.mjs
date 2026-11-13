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
//   4  dependencies         NO PORT: the install runs inside the lock-down (launch.mjs installStep), through the
//                           lock-down runner (`runLocked`), which is not built (save-work waits on it too). Until it is,
//                           launch() refuses a worker here and no worker starts. A script session skips check 4.
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
//                           worker's baseline (the product's test command, run once through lockedRunCommand, must exit
//                           0). The baseline never runs in the session's copy (#369 r1 M1): the start port makes a
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
//                           none. No budget source yet (runner-main.mjs budget: null), so no port
//   13 Bob method folder    reviewChecks' 13 against the pinned file list; no list, no port
// The inputs come from the start port's `x` and the runner's config (runner-main.mjs workerCheckInputs).

import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, constants } from 'node:fs';
import { join } from 'node:path';
import { reviewChecks } from '../modules/M4-workshop/launcher/review-launch.mjs';
import { lockedRunCommand, baselineTest } from '../modules/M4-workshop/launcher/launch.mjs';
import { roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { isProtectedName } from '../modules/M4-workshop/launcher/worker-copy.mjs';
import { git } from '../modules/M4-workshop/git/safe-git.mjs';
import { check12 } from '../modules/M11-dispatcher/gate.mjs';
import { groupThere } from './runner-ports.mjs';
import { foldKey } from '../shared/plan-fingerprint.mjs';

const refuse = (reason) => ({ ok: false, reason });
export const BASELINE_MS = 15 * 60_000;
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

function readNoLink(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); return readFileSync(fd); } finally { closeSync(fd); }
}

const q = (p) => { if (/['\0\n]/.test(p)) throw new Error('a baseline path holds a quote or a line break'); return `'${p}'`; };
/** The baseline's file (in the copy) its exit code is written to, and the one shell command. */
export const baselineFile = ({ copy, sessionId }) => join(copy, `.orch-baseline-${sessionId}`);
export function baselineCommand(test, file) {
  if (typeof test !== 'string' || !test.trim() || /[\0\n]/.test(test)) throw new Error('the product declares no one-line test command');
  return `( ${test} ); /bin/echo $? > ${q(file)}`;
}

// Runs one claude to its end (or the time limit). → { exitCode }, or a throw. It leads its own process group, so a
// time-out kills the tests it started too, not claude alone (#369 m2), and so does a normal end (#369 r1 M1): what the
// tests left running in the group goes with it. After the end, the group is killed only if signal 0 still finds it
// (#369 r2 c3; runner-ports.mjs groupThere, the one test of a group): an empty group's number is not signalled.
function runToEnd(spawn, bin, args, opts, timeoutMs, kill = (g) => process.kill(-g, 'SIGKILL'), there = groupThere) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { ...opts, detached: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch (e) { reject(e); return; }
    const group = () => Number.isInteger(child.pid) && child.pid > 1;
    const t = setTimeout(() => {
      try { if (group()) kill(child.pid); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      reject(new Error('it did not finish in time'));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); try { if (group() && there(child.pid)) kill(child.pid); } catch { /* none of the group is left */ } resolve({ exitCode: code }); });
  });
}

/**
 * The ports for one worker-runner session. x: the start port's { role, profile, kind, sessionId, card, cardDoc, product,
 * copy, outbox, env, head, mainAt, claudeBin, settings: { file, settings }, ownUid, throwaway() → { ok, copy, settingsFile,
 * done() } (the baseline's own copy, #369 r1 M1) } plus the config's { mirror, pin, hooksDir,
 * rules, snapshot, writeSnapshot, machineWide, busy, alert, spawn, home, testCommand, budget, bobFolder, bobManifest,
 * probeMs?, baselineMs? }. gateOf is M11's check12 (a port for tests). → { [n]: async () => { ok, reason } }, with no entry for a check whose inputs are not there.
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
        const lr = lockedRunCommand({ claudeBin: x.claudeBin, settingsFile: t.settingsFile, command: cmd, roleArgs, profile: x.profile });
        if (!lr.ok) return lr;
        rmSync(f, { force: true });
        b = await baselineTest({ run: async () => {
          await runToEnd(x.spawn, lr.bin, lr.args, { cwd: t.copy, env: x.env }, x.baselineMs ?? BASELINE_MS, x.killGroup, x.groupThere);
          // The command's own exit code, as it wrote it; none written, and the baseline can't say (not 0).
          let text; try { text = readNoLink(f).toString('utf8').trim(); } catch { return { exitCode: 'not written' }; }
          return { exitCode: /^\d{1,3}$/.test(text) ? Number(text) : text.slice(0, 20) };
        } });
      } finally { try { await t.done(); } catch { /* left for cleanup */ } }
      if (!b.ok) return b;
      return smoke;
    };
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
