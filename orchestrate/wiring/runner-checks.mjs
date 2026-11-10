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
//                           depth, any letter case; worker-copy.mjs isProtectedName) is a plain file byte for byte
//                           main's in the mirror, no link, and each of main's is there
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
//   11 baseline and smoke   a worker's baseline first (the product's test command, run once by the role's own start
//                           with its own settings through lockedRunCommand, must exit 0), then reviewChecks' smoke, with
//                           the owner's home as the place outside the copy it must not write. A script session runs the
//                           smoke only (launch.mjs: the baseline is the worker's).
//   12 budget               M11's own check12 with this session's kind (gate.mjs counts editing, undo and script
//                           sessions themselves); no budget source, no port
//   13 Bob method folder    reviewChecks' 13 against the pinned file list; no list, no port
// The inputs come from the start port's `x` and the runner's config (runner-main.mjs workerCheckInputs).

import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, constants } from 'node:fs';
import { join } from 'node:path';
import { reviewChecks } from '../modules/M4-workshop/launcher/review-launch.mjs';
import { lockedRunCommand, baselineTest } from '../modules/M4-workshop/launcher/launch.mjs';
import { roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { isProtectedName } from '../modules/M4-workshop/launcher/worker-copy.mjs';
import { git, gitOk } from '../modules/M4-workshop/git/safe-git.mjs';
import { check12 } from '../modules/M11-dispatcher/gate.mjs';

const refuse = (reason) => ({ ok: false, reason });
export const BASELINE_MS = 15 * 60_000;
const has = (v) => v !== undefined && v !== null && v !== '';

/**
 * Check 2: the copy's settings-bearing files are exactly main's. → null, or the reason. `run` is safe-git's git (a port).
 */
export async function setupFilesProblem({ copy, mirror }, { run = git } = {}) {
  let raw;
  try {
    const r = await run(['ls-tree', '-r', '-z', '--full-tree', 'refs/heads/main'], { gitDir: mirror, purpose: 'runner-check-2-list', timeoutMs: 60_000 });
    if (r?.code !== 0) throw new Error(String(r?.stderr ?? '').trim().slice(0, 200) || `exit ${r?.code}`);
    raw = r.stdout.toString();
  } catch (e) { return `main's file list can't be read from the mirror (${e?.message ?? e})`; }
  const want = new Map();
  for (const rec of raw.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [, type, oid] = rec.slice(0, tab).split(' '); const path = rec.slice(tab + 1);
    if (path.split('/').some(isProtectedName)) want.set(path, { type, oid });
  }
  const found = [];
  const under = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name; const p = join(dir, ent.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${r} is a link`);
      if (st.isDirectory()) under(p, r); else if (st.isFile()) found.push(r); else throw new Error(`${r} is not a plain file`);
    }
  };
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
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
    const w = want.get(r);
    if (!w || w.type !== 'blob') return `the copy holds ${r}, which main does not`;
    const b = await run(['cat-file', 'blob', w.oid], { gitDir: mirror, purpose: 'runner-check-2-blob', timeoutMs: 60_000 });
    if (b?.code !== 0) return `main's ${r} can't be read from the mirror`;
    let mine; try { mine = readNoLink(join(copy, r)); } catch (e) { return `the copy's ${r} can't be read (${e?.code ?? e?.message})`; }
    if (!Buffer.from(b.stdout).equals(mine)) return `the copy's ${r} is not main's`;
  }
  const have = new Set(found);
  const missing = [...want.keys()].filter((k) => !have.has(k));
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

// Runs one claude to its end (or the time limit). → { exitCode }, or a throw.
function runToEnd(spawn, bin, args, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { ...opts, stdio: ['ignore', 'ignore', 'ignore'] }); } catch (e) { reject(e); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('it did not finish in time')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); resolve({ exitCode: code }); });
  });
}

/**
 * The ports for one worker-runner session. x: the start port's { role, profile, kind, sessionId, card, cardDoc, product,
 * copy, outbox, env, head, claudeBin, settings: { file, settings }, ownUid } plus the config's { mirror, pin, hooksDir,
 * rules, snapshot, writeSnapshot, machineWide, busy, alert, spawn, home, testCommand, budget, bobFolder, bobManifest,
 * probeMs?, baselineMs? }. gateOf is M11's check12 (a port for tests). → { [n]: async () => { ok, reason } }, with no entry for a check whose inputs are not there.
 */
export function workerChecks(x, { gateOf = check12 } = {}) {
  const r = reviewChecks({ ...x, reviewHome: x.home });
  const ports = { 1: r[1], 5: r[5], 9: r[9] };
  if (has(x.mirror)) ports[2] = async () => { const p = await setupFilesProblem(x); return p ? refuse(p) : { ok: true }; };
  if (typeof x.busy === 'function') ports[3] = r[3];
  if (has(x.pin) && typeof x.spawn === 'function') ports[6] = r[6];
  if (has(x.pin) && has(x.hooksDir) && x.rules) ports[7] = r[7];
  if (has(x.snapshot) && x.rules && typeof x.writeSnapshot === 'function') ports[8] = r[8];
  if (has(x.machineWide)) ports[10] = r[10];
  if (typeof x.spawn === 'function' && has(x.home) && (x.role !== 'worker' || has(x.testCommand))) {
    ports[11] = async () => {
      if (x.role === 'worker') {
        const f = baselineFile(x);
        let cmd; try { cmd = baselineCommand(x.testCommand, f); } catch (e) { return refuse(e.message); }
        const lr = lockedRunCommand({ claudeBin: x.claudeBin, settingsFile: x.settings.file, command: cmd, roleArgs, profile: x.profile });
        if (!lr.ok) return lr;
        rmSync(f, { force: true });
        let b;
        try {
          b = await baselineTest({ run: async () => {
            await runToEnd(x.spawn, lr.bin, lr.args, { cwd: x.copy, env: x.env }, x.baselineMs ?? BASELINE_MS);
            // The command's own exit code, as it wrote it; none written, and the baseline can't say (not 0).
            let text; try { text = readNoLink(f).toString('utf8').trim(); } catch { return { exitCode: 'not written' }; }
            return { exitCode: /^\d{1,3}$/.test(text) ? Number(text) : text.slice(0, 20) };
          } });
        } finally { rmSync(f, { force: true }); }
        if (!b.ok) return b;
      }
      return r[11]();
    };
  }
  if (x.budget) {
    const gate = gateOf(x.budget);
    ports[12] = async () => (x.cardDoc ? gate({ card: x.cardDoc, kind: x.kind, product: x.product }) : refuse('the card is not in the Record'));
  }
  if (x.bobManifest && has(x.bobFolder)) ports[13] = r[13];
  return ports;
}
