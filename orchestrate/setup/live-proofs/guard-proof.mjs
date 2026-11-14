#!/usr/bin/env node
// guard-proof.mjs — live proof (L1211): the installed copy's jobs start with the secret guard on (R-0b-179, L1191).
//
// Read-only. Joe runs it on the Mini with sudo after the reinstall (the run sheet's G7). For each job below whose job file
// is placed under the config's label, it reads the job file (its node, its script and its user) and checks, without
// starting the job:
//   - the job starts the copy's node and the job's own script from the copy, and the user it runs as is not root and not
//     the owner (the updater is the one job that runs as root by design, and must);
//   - the node, the script and the copy's shared/secret-guard.mjs are root's all the way up, with no link (a real path that
//     is not the copy's own guard is a FAIL);
//   - then, as the job's own user (uid and gid), in /var/empty with a bare environment and a 30 s limit, a fresh node from
//     the copy loads the job's script exactly as the job does, but with no arguments, so the script's own "am I the
//     program that was started" test is false and its main never runs. In that child: the guard that installed itself must
//     be the copy's (its install mark names the file, and the copy's guard read back is that same instance), the start
//     functions must be the wrapped ones, a start whose argument holds a value the child registers must be refused with
//     the guard's own code, and a plain start must still run.
// While the script loads, the child refuses and records every file write, network connection and program start (none of
// the scripts below does one at load: the scan in the PR that added this file). A script that tries one is a FAIL, and
// nothing is written or sent.
//
// One line per job: PASS, FAIL, NOT TRIED (with why) or NOT PLACED (its job file is not there; listed, never a PASS).
// The exit is 0 only when at least one job is placed and every placed job PASSes.
//
// sudo node setup/live-proofs/guard-proof.mjs [--config /Library/orchestrate-setup.json]
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DAEMON_DIR, plistTexts } from '../daemons.mjs';
import { realIo } from '../mac.mjs';
import { installPaths, parseInstallConfig } from '../install.mjs';
import { ROOT_CONFIG_PATH } from '../layout.mjs';
import { WATCH_RUN } from '../watch-setup.mjs';
import { ROBOT_JOB, ROBOT_MAIN } from '../robot-setup.mjs';
import { DISPATCHER_JOB, DISPATCHER_MAIN } from '../dispatcher-setup.mjs';
import { SENSORS_JOB, SENSORS_MAIN } from '../sensors-setup.mjs';
import { WORKER_RUNNER_JOB, WORKER_RUNNER_MAIN } from '../worker-runner-setup.mjs';
import { SCRIPTS } from '../../modules/M4-workshop/launcher/review-daemons.mjs';
import { NODE, chainProblem, currentCopy } from '../../modules/M4-workshop/launcher/install-check.mjs';
import { INSTALL_MARK, REFUSED_CODE } from '../../shared/secret-guard.mjs';

export const GUARD = 'shared/secret-guard.mjs';
export const CHILD_LIMIT_MS = 30_000;
const IN = 'ORCH_GUARD_PROOF';

/**
 * The jobs whose processes load the guard, each with the script its job file must start; `root`: runs as root by design.
 * The root exemption is this table's one exact key: the job file must be <label>.review-updater.plist and its Label exactly
 * <label>.review-updater (judgeJob). Any other name is not a job this proof knows, and a FAIL, even one merely containing
 * "review-updater"; any other job here that runs as root is a FAIL.
 */
export const PROVED_JOBS = Object.freeze({
  'review-updater': Object.freeze({ script: SCRIPTS.updater, root: true }),
  'review-runner': Object.freeze({ script: SCRIPTS.runner }),
  'watch-only': Object.freeze({ script: WATCH_RUN }),
  [DISPATCHER_JOB]: Object.freeze({ script: DISPATCHER_MAIN }),
  [SENSORS_JOB]: Object.freeze({ script: SENSORS_MAIN }),
  [ROBOT_JOB]: Object.freeze({ script: ROBOT_MAIN }),
  [WORKER_RUNNER_JOB]: Object.freeze({ script: WORKER_RUNNER_MAIN }),
});
/**
 * Jobs left out, and why: listed in the output so a reader sees them. Each exemption covers that one label only: it never
 * counts toward "every placed job PASSes" and stands in for no other job.
 */
export const NOT_CHECKED = Object.freeze({
  // review-account (L1211 ruling): it starts nothing that carries a secret today. If it ever gains a start whose command
  // line could carry a secret, it must load the guard, move to PROVED_JOBS and be checked like the rest.
  'review-account': 'it loads no guard: it copies the owner\'s account file and starts only claude\'s status check, with no secret on the line',
  // builder-wall-check (L1223 ruling), this exact label only: root's by design. builder-wall.mjs reads no secret and starts
  // only fixed programs (pfctl, launchctl). If it ever reads a secret or starts a program with one, it must load the guard
  // and be proved here under a root exemption by its exact label, like review-updater.
  'builder-wall-check': 'it loads no guard: root\'s by design, it reads no secret and starts only pfctl and launchctl, with no secret on the line',
});
/** A job whose script writes or connects when it is only loaded is never loaded here: NOT TRIED, with the reason. None today. */
export const LOAD_WRITES = Object.freeze({});

// The child's code: node's own modules only, run with --input-type=module -e, so the child has no script argument and no
// script takes itself for the started program.
export const PROBE = String.raw`
import cp from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import wt from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const input = JSON.parse(process.env.${IN}); delete process.env.${IN};
const { entry, guard, nonce, mark, code } = input;
// Every answer says who the child ran as and with how many arguments (r1 m2): the proof wants the job's uid and gid, and
// argv[1] unset, so no script's main ran.
const who = { uid: process.getuid(), gid: process.getgid(), argc: process.argv.length };
const say = (o) => { fs.writeSync(1, '\n' + nonce + ' ' + JSON.stringify({ ...o, ...who }) + '\n'); process.exit(0); };
const tried = [];
let loading = true;
const stop = (obj, name, what, when = () => true) => {
  const real = obj?.[name];
  if (typeof real !== 'function') return;
  obj[name] = function (...a) {
    if (loading && when(a)) { tried.push(what + ' (' + name + ')'); throw new Error('guard-proof: no ' + what + ' while the script loads'); }
    return Reflect.apply(real, this, a);
  };
};
const stopNew = (obj, name, what) => {
  const Real = obj?.[name];
  if (typeof Real !== 'function') return;
  obj[name] = new Proxy(Real, { construct(target, a, nt) {
    if (loading) { tried.push(what + ' (' + name + ')'); throw new Error('guard-proof: no ' + what + ' while the script loads'); }
    return Reflect.construct(target, a, nt);
  } });
};
const READ = new Set([undefined, null, 'r', 'rs', 'sr', fs.constants.O_RDONLY]);
const WRITES = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'symlink', 'link',
  'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'truncate', 'mkdtempDisposable'];
for (const n of WRITES) { stop(fs, n, 'file write'); stop(fs, n + 'Sync', 'file write'); stop(fs.promises, n, 'file write'); }
for (const n of ['createWriteStream']) stop(fs, n, 'file write');
for (const [o, n] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) stop(o, n, 'file write', (a) => !READ.has(a[1]));
stop(net.Socket.prototype, 'connect', 'network connection');
stop(net.Server.prototype, 'listen', 'listening');
stop(globalThis, 'fetch', 'network connection');
stop(dgram, 'createSocket', 'network connection');
for (const n of ['bind', 'send', 'connect']) stop(dgram.Socket.prototype, n, 'network connection');
const LOOKUP = /^(lookup|resolve|reverse)/;
for (const o of [dns, dns.promises, dns.Resolver?.prototype, dns.promises?.Resolver?.prototype]) {
  for (const n of Object.getOwnPropertyNames(o ?? {})) if (LOOKUP.test(n)) stop(o, n, 'name lookup');
}
stopNew(wt, 'Worker', 'thread start');
for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) stop(cp, n, 'program start');
stop(cp.ChildProcess.prototype, 'spawn', 'program start');
syncBuiltinESMExports();
let at = 'loading the script';
try {
  await import(pathToFileURL(entry).href);
  loading = false;
  if (tried.length) say({ ok: false, why: 'while it loaded, the script tried: ' + [...new Set(tried)].join(', ') + '; nothing was done' });
  at = 'reading the install mark';
  const m = globalThis[Symbol.for(mark)];
  if (!m || typeof m.registerSecret !== 'function' || typeof m.url !== 'string') say({ ok: false, why: 'the script loaded no guard that marked its install' });
  const want = pathToFileURL(guard).href;
  if (m.url !== want) say({ ok: false, why: 'the guard that installed itself is ' + (m.url.startsWith('file:') ? fileURLToPath(m.url) : m.url) + ', not the copy\'s ' + guard });
  at = 'loading the copy\'s guard';
  const g = await import(want);
  if (g.registerSecret !== m.registerSecret) say({ ok: false, why: 'the copy\'s guard read back is another instance than the one that installed itself' });
  if (typeof g.guardInstalled !== 'function' || g.guardInstalled() !== true) say({ ok: false, why: 'the start functions are not the guard\'s wrapped ones' });
  at = 'the refusal check';
  const v = randomBytes(24).toString('hex');
  g.registerSecret(v);
  let e = null;
  try { cp.spawnSync('/usr/bin/true', [v], { stdio: 'ignore' }); } catch (x) { e = x; }
  if (!e) say({ ok: false, why: 'a start whose argument holds a registered value was not refused' });
  if (e.code !== code) say({ ok: false, why: 'a start was refused, but not by the guard (' + (e.code ?? 'no code') + ': ' + String(e.message).slice(0, 120) + ')' });
  at = 'a plain start';
  const r = cp.spawnSync('/usr/bin/true', [], { stdio: 'ignore' });
  if (r.error || r.status !== 0) say({ ok: false, why: 'a plain start did not run (' + (r.error?.code ?? 'exit ' + r.status) + ')' });
  say({ ok: true, guard });
} catch (x) {
  loading = false;
  const why = at + ': ' + String(x?.message ?? x).slice(0, 200);
  say({ ok: false, why: tried.length ? 'while it loaded, the script tried: ' + [...new Set(tried)].join(', ') + '; nothing was done (then ' + why + ')' : why });
}
`;

const row = (job, result, why) => ({ job, result, why });

/**
 * One job's verdict. io: { exists, isLink(file), readPlist(file) → object, built(job) → the job file the installer writes
 * for it, as an object, currentCopy(installRoot) → install-check's answer, realpath, idOf(name) → { uid, gid } | null,
 * chain(path) → problem | null, runChild({ node, uid, gid, env, cwd }) → spawnSync's answer, myUid }.
 */
export function judgeJob(job, { cfg, io, ownerUid, loadWrites = LOAD_WRITES }) {
  const spec = PROVED_JOBS[job];
  if (!spec) return row(job, 'FAIL', 'not a job this proof knows');
  const file = join(DAEMON_DIR, `${cfg.label}.${job}.plist`);
  if (!io.exists(file)) return row(job, 'NOT PLACED', `no job file at ${file}`);
  if (io.isLink(file)) return row(job, 'FAIL', `its job file ${file} is a link; not loaded`);
  let p; try { p = io.readPlist(file); } catch (e) { return row(job, 'FAIL', `its job file can't be read (${e?.message ?? e})`); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return row(job, 'FAIL', 'its job file is not a dictionary; not loaded');
  // r1 M2: launchd obeys every key, not only the ones read below (Program, GroupName, InitGroups, a NODE_OPTIONS preload in
  // EnvironmentVariables…). So the job file may hold only the keys the installer's own builder writes for this job, and
  // only its environment names; anything more is a FAIL before anything is loaded.
  let want; try { want = io.built(job); } catch (e) { return row(job, 'FAIL', `the installer's job file for it can't be built here (${e?.message ?? e}); not loaded`); }
  if (!want || typeof want !== 'object') return row(job, 'FAIL', 'the installer writes no job file for it with this config; not loaded');
  for (const k of ['Program', 'GroupName']) if (Object.hasOwn(p, k)) return row(job, 'FAIL', `its job file sets ${k}, which the installer never writes; not loaded`);
  const extra = Object.keys(p).filter((k) => !Object.hasOwn(want, k));
  if (extra.length) return row(job, 'FAIL', `its job file has keys the installer doesn't write for it: ${extra.join(', ')}; not loaded`);
  const env = p.EnvironmentVariables;
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return row(job, 'FAIL', 'its job file\'s EnvironmentVariables is not a dictionary; not loaded');
    const allowed = want.EnvironmentVariables && typeof want.EnvironmentVariables === 'object' ? want.EnvironmentVariables : {};
    const more = Object.keys(env).filter((k) => !Object.hasOwn(allowed, k));
    if (more.length) return row(job, 'FAIL', `its job file sets environment names the installer doesn't write for it: ${more.join(', ')}; not loaded`);
  }
  const { installRoot } = installPaths(cfg);
  const node = join(installRoot, NODE); const script = join(installRoot, spec.script);
  const args = p.ProgramArguments;
  if (!Array.isArray(args) || args.length < 2) return row(job, 'FAIL', 'its job file has no program and script');
  if (args[0] !== node) return row(job, 'FAIL', `it starts ${args[0]}, not the copy's node ${node}`);
  if (args[1] !== script) return row(job, 'FAIL', `it runs ${args[1]}, not its script ${script}; not loaded`);
  if (p.Label !== `${cfg.label}.${job}`) return row(job, 'FAIL', `its job file's Label is ${JSON.stringify(p.Label)}, not ${cfg.label}.${job}; not loaded`);
  if (Object.hasOwn(loadWrites, job)) return row(job, 'NOT TRIED', `its script is not loaded here: ${loadWrites[job]}`);
  // The user: a job file with no UserName runs as root.
  const user = p.UserName === undefined ? 'root' : p.UserName;
  const ids = user === 'root' ? { uid: 0, gid: 0 } : io.idOf(user);
  if (!ids || !Number.isInteger(ids.uid) || !Number.isInteger(ids.gid)) return row(job, 'FAIL', `its user ${user} is not a user on this Mac`);
  if (spec.root) { if (ids.uid !== 0) return row(job, 'FAIL', `it runs as ${user}; it is root's job by design`); }
  else if (ids.uid === 0) return row(job, 'FAIL', 'it runs as root');
  else if (ids.uid === ownerUid) return row(job, 'FAIL', `it runs as the owner's uid ${ownerUid}`);
  // r1 M1: the copy's name is root's link into its versioned folder (install.mjs), as the jobs name it. The link is
  // checked as the install check does (currentCopy: root's, into <name>.v-<commit>/orchestrate, folders root's); then the
  // node, the script and the guard by their real paths, root's all the way up with no link anywhere.
  let cur; try { cur = io.currentCopy(installRoot); } catch (e) { cur = { problem: `it can't be read (${e?.message ?? e})` }; }
  if (cur?.problem) return row(job, 'FAIL', `the copy: ${cur.problem}`);
  if (cur?.link !== true || typeof cur.real !== 'string') return row(job, 'FAIL', `the copy ${installRoot} is not the installer's link to a versioned copy`);
  const rnode = join(cur.real, NODE); const rscript = join(cur.real, spec.script); const rguard = join(cur.real, GUARD);
  for (const x of [rnode, rscript, rguard]) { const why = io.chain(x); if (why) return row(job, 'FAIL', why); }
  // Kept on purpose (r1 c1): with the chain check above these can't differ on a real Mac; they stand if that check is ever
  // narrowed, and the tests reach them with it switched off.
  let real;
  try { real = { script: io.realpath(rscript), guard: io.realpath(rguard) }; } catch (e) { return row(job, 'FAIL', `a real path can't be read (${e?.message ?? e})`); }
  if (real.guard !== rguard) return row(job, 'FAIL', `the copy's guard is really ${real.guard}, not the copy's own ${rguard}`);
  if (real.script !== rscript) return row(job, 'FAIL', `its script is really ${real.script}, not the copy's own ${rscript}`);
  if (io.myUid !== 0 && io.myUid !== ids.uid) return row(job, 'NOT TRIED', `it runs as ${user}: run this with sudo, which starts each check as the job's own user`);
  const nonce = randomBytes(16).toString('hex');
  const input = { entry: rscript, guard: rguard, nonce, mark: INSTALL_MARK.description, code: REFUSED_CODE };
  const r = io.runChild({ node: rnode, uid: ids.uid, gid: ids.gid, cwd: '/var/empty', env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', [IN]: JSON.stringify(input) } });
  return row(job, ...readAnswer(r, nonce, user, ids));
}

/**
 * The child's answer → [result, why]. Only the line carrying this run's nonce counts (the script never sees it). `ids`:
 * { uid, gid } the job runs as; the answer must say the child ran as exactly those, with no script argument (r1 m2).
 */
export function readAnswer(r, nonce, user, ids) {
  if (r?.error) return ['FAIL', `the check could not run as ${user} (${r.error.code ?? r.error.message})`];
  const line = String(r?.stdout ?? '').split('\n').reverse().find((l) => l.startsWith(`${nonce} `));
  if (!line) {
    const err = String(r?.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
    return ['FAIL', `the check gave no answer (${r?.signal ? `stopped by ${r.signal}` : `exit ${r?.status}`}${err ? `: ${err}` : ''})`];
  }
  let a; try { a = JSON.parse(line.slice(nonce.length + 1)); } catch { return ['FAIL', 'the check\'s answer is not readable']; }
  if (!Number.isInteger(ids?.uid) || !Number.isInteger(ids?.gid)) return ['FAIL', 'the job\'s uid and gid are not known'];
  if (a?.uid !== ids.uid || a?.gid !== ids.gid) return ['FAIL', `the check ran as uid ${JSON.stringify(a?.uid)} gid ${JSON.stringify(a?.gid)}, not the job's uid ${ids.uid} gid ${ids.gid}`];
  if (a?.argc !== 1) return ['FAIL', `the check ran with ${JSON.stringify(a?.argc)} arguments, not none, so a script's main may have run`];
  if (a?.ok === true) return ['PASS', `as ${user}: the copy's guard (${a.guard}) is on, refused a registered value with its own code, and let a plain start run`];
  return ['FAIL', typeof a?.why === 'string' ? a.why : 'the check said no, with no reason'];
}

/** Exit 0 only when at least one job is placed and every placed job PASSes. */
export const proofPassed = (rows) => rows.some((x) => x.result !== 'NOT PLACED') && rows.every((x) => x.result === 'PASS' || x.result === 'NOT PLACED');

/** A job file's text → its object, as launchd reads it (plutil, from stdin). */
export function plistObject(text) {
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: text, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `plutil exit ${r.status}`).trim().slice(0, 200));
  return JSON.parse(r.stdout);
}

export const liveIo = (cfg) => ({
  exists: (f) => { try { lstatSync(f); return true; } catch { return false; } },   // a dangling link is placed too
  isLink: (f) => lstatSync(f).isSymbolicLink(),
  // The installer's own builder (daemons.mjs plistTexts), built in memory from this config and the Mac's users: nothing is written.
  built: (job) => { const b = plistTexts(realIo(), cfg); if (!Object.hasOwn(b.plists, job)) throw new Error(b.problems.join('; ') || 'not a job of this config'); return plistObject(b.plists[job]); },
  currentCopy: (root) => currentCopy(root),
  readPlist: (f) => {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', f], { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `plutil exit ${r.status}`).trim().slice(0, 200));
    return JSON.parse(r.stdout);
  },
  realpath: (p) => realpathSync.native(p),
  idOf: (name) => {
    const id = (flag) => { const r = spawnSync('/usr/bin/id', [flag, '--', name], { encoding: 'utf8', timeout: 10_000 }); return r.status === 0 && /^\d+\n?$/.test(r.stdout) ? Number(r.stdout) : null; };
    const uid = id('-u'); const gid = id('-g');
    return uid === null || gid === null ? null : { uid, gid };
  },
  chain: (p) => chainProblem(p),
  runChild: ({ node, uid, gid, env, cwd }) => spawnSync(node, ['--input-type=module', '-e', PROBE], {
    uid, gid, env, cwd, encoding: 'utf8', timeout: CHILD_LIMIT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  myUid: process.getuid(),
});

export function main(argv, { io, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const at = argv.indexOf('--config');
  const configPath = at >= 0 ? argv[at + 1] : ROOT_CONFIG_PATH;
  if (at >= 0 && !configPath) { out('usage: sudo node setup/live-proofs/guard-proof.mjs [--config <setup config>]'); return 2; }
  let cfg; try { cfg = parseInstallConfig(JSON.parse(readFileSync(configPath, 'utf8'))); } catch (e) { out(`FAIL        the setup config ${configPath} can't be read (${e?.message ?? e})`); return 1; }
  io ??= liveIo(cfg);
  const owner = io.idOf(cfg.owner);
  if (!owner) { out(`FAIL        the owner ${cfg.owner} is not a user on this Mac`); return 1; }
  const rows = Object.keys(PROVED_JOBS).map((job) => judgeJob(job, { cfg, io, ownerUid: owner.uid }));
  for (const x of rows) out(`${x.result.padEnd(11)} ${x.job}: ${x.why}`);
  for (const [job, why] of Object.entries(NOT_CHECKED)) out(`${'NOT CHECKED'.padEnd(11)} ${job}: ${why}`);
  const ok = proofPassed(rows);
  out(ok ? 'PASS: every placed job starts with the copy\'s guard on' : 'FAIL: not every placed job was shown to start with the copy\'s guard on');
  return ok ? 0 : 1;
}

const self = (() => { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (self && self === invoked) process.exitCode = main(process.argv.slice(2));
