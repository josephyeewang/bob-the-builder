// Setup part 2a (PR 2): the install. Makes the layout of install-check.mjs and runs the updater's first run as root.
//
//   <base>/install/                  root's folder; holds the copy's link, its versioned folders and the clone
//   <base>/install/orchestrate       the link (installRoot) → orchestrate.v-<commit>, made by the updater's --first
//   <base>/install/clone.git         the updater's own bare clone
//   <base>/install-work/             made and removed by the install: `bootstrap/` (the updater's three files) and `seed/`
//                                    (the copy's own items: bin/node, updater.json, review.json and the extras)
//
// Root never runs code from a folder anyone else writes. The updater is run from `bootstrap/`, a root-owned copy of its
// three files (review-updater.mjs, install-check.mjs, safe-git.mjs: the set the updater's test pins), with a node that
// is a root-owned copy of the one running this command. The updater then writes the real copy from `main` on GitHub.
// The files copied in come from this repository's checkout, which the person running the install has chosen to trust.
// All constants (names, layout, the script paths) are imported from the launcher's own modules; none is repeated here.

import { dirname, join, posix } from 'node:path';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCRIPTS } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { NODE, RUNNER_CONFIG, RUNNER_MODULES, STAMP, UPDATER_CONFIG, aclProblem, copyModuleProblem, currentCopy, installProblem, readInstallStamp } from '../modules/M4-workshop/launcher/install-check.mjs';
import { MUST_KEEP, RUNNER_NAMES } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { parseConfig } from './layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORCH_ROOT = join(HERE, '..');   // this repository's orchestrate/ folder
// The updater's module set, relative to orchestrate/ (review-updater.mjs imports the other two by these relative paths).
const UPDATER_DIR = posix.dirname(SCRIPTS.updater);
export const BOOTSTRAP_FILES = Object.freeze([SCRIPTS.updater, posix.join(UPDATER_DIR, 'install-check.mjs'), posix.join(UPDATER_DIR, '../git/safe-git.mjs')].map((p) => posix.normalize(p)));
// The jobs' label rule, as review-daemons.mjs has it (that file does not export it; a test pins the two together).
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/;
const PLAIN_ABS = (p) => typeof p === 'string' && p.startsWith('/') && posix.normalize(p) === p && !p.includes('\0') && !p.includes('\n') && p !== '/';
const KEEP_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;

/** Config for the install and the jobs: the setup config (layout.mjs) plus these keys. */
export function parseInstallConfig(raw) {
  const base = parseConfig(raw);
  const { address, gitBin = '/usr/bin/git', label, runnerConfig, extras = [], nodeBin = realpathSync(process.execPath) } = raw;
  if (typeof address !== 'string' || !HTTPS.test(address)) throw new Error('config: address must be the https address of the repository');
  if (!PLAIN_ABS(gitBin)) throw new Error('config: gitBin must be a full path');
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new Error('config: label must be letters, digits, . and - (it starts the jobs\' names)');
  if (!PLAIN_ABS(runnerConfig)) throw new Error('config: runnerConfig must be the full path of the review runner\'s prepared config file');
  if (!PLAIN_ABS(nodeBin)) throw new Error('config: nodeBin must be a full path');
  if (!Array.isArray(extras) || extras.length > 20 || extras.some((e) => !PLAIN_ABS(e) || !KEEP_NAME.test(posix.basename(e)) || [...Object.keys(MUST_KEEP), STAMP, UPDATER_CONFIG, RUNNER_CONFIG].includes(posix.basename(e)))) {
    throw new Error('config: extras must be full paths of files or folders to carry into the copy (the review runner\'s claude program and its hooks), each with a plain name of its own');
  }
  return { ...base, address, gitBin, label, runnerConfig, extras, nodeBin };
}

export function installPaths(cfg) {
  const install = join(cfg.base, 'install');
  return {
    install, installRoot: join(install, 'orchestrate'), clone: join(install, 'clone.git'), work: join(cfg.base, 'install-work'),
    bootstrap: join(cfg.base, 'install-work', 'bootstrap'), seed: join(cfg.base, 'install-work', 'seed'),
    logDir: join(cfg.base, 'logs'), accountCopy: join(cfg.base, 'account-copy.json'), reviewRoot: join(cfg.base, 'review'),
  };
}

/** The entries the install and the jobs put directly under the base, so `check` does not call them strangers (r3 n4). */
export const rootMadeEntries = (cfg) => { const P = installPaths(cfg); return [P.install, P.work, P.logDir, P.accountCopy]; };

const op = (text, run) => ({ text, run });
// Owner and mode are set through an open handle (never by path, which would follow a link): a folder or a file, root:wheel.
const rootOwned = (io, p, mode, kind = 'file') => [op(`set owner and mode of ${p}: chown 0:0, chmod ${mode.toString(8)}`, () => { const want = { uid: io.rootUid, gid: 0, mode }; if (kind === 'dir') io.secure(p, want); else io.secureFile(p, want); })];

/** Every file and folder under `p` made root's, with no write for group or other (the copy is root's alone). A folder is locked
 *  before anything inside it is touched; a link anywhere in it is refused. */
function ownTree(io, p) {
  const st = io.lstat(p);
  if (st.isSymbolicLink()) throw new Error(`${p} is a link, which the install does not carry in`);
  if (st.isDirectory()) {
    io.secure(p, { uid: io.rootUid, gid: 0, mode: 0o755 });
    for (const n of io.list(p)) ownTree(io, join(p, n));
  } else io.secureFile(p, { uid: io.rootUid, gid: 0, mode: (st.mode & 0o111) ? 0o755 : 0o644 });
}

/** The updater's own config, as the copy keeps it. Paths are the ones the updater will see (io.at). */
export function updaterConfigFor(io, cfg) {
  const P = installPaths(cfg);
  return { installRoot: io.at(P.installRoot), clone: io.at(P.clone), address: cfg.address, keep: ['bin', UPDATER_CONFIG, RUNNER_CONFIG, ...cfg.extras.map((e) => posix.basename(e))], gitBin: cfg.gitBin };
}

/**
 * What the install does: { ops, problems, installed }. Reads only. `readSource(path)` reads a file of this machine outside
 * the prefix (the runner config) and `runUpdater(io, {node, script, config, seed})` is the updater's first run (ports for a test).
 */
export function planInstall(io, cfg, { readSource, runUpdater }) {
  const P = installPaths(cfg); const ops = []; const problems = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (!cur.missing) {
    const why = cur.problem ?? (cur.link ? null : 'is a plain folder, not the link the updater flips');
    if (why) problems.push(`${P.installRoot}: ${why}. Nothing was changed`);
    return { ops, problems, installed: !why };
  }
  let rc;
  try { rc = JSON.parse(readSource(cfg.runnerConfig)); } catch (e) { problems.push(`the runner config ${cfg.runnerConfig} can't be read as JSON (${e.code ?? e.message})`); }
  if (rc && (typeof rc !== 'object' || rc.installRoot !== io.at(P.installRoot))) problems.push(`the runner config's installRoot must be ${io.at(P.installRoot)}`);
  const names = rc ? RUNNER_NAMES.filter((n) => typeof rc[n] === 'string') : [];
  const inCopy = io.at(P.installRoot);
  for (const n of names) {
    if (RUNNER_MODULES.includes(n)) {   // the wiring and the budget module are the copy's own code files from main, never extras (#82)
      const rel = rc[n].startsWith(`${inCopy}/`) ? rc[n].slice(inCopy.length + 1) : null;
      const why = rel === null ? `is not inside ${inCopy}` : copyModuleProblem(rel);
      if (why) problems.push(`the runner config's ${n} (${rc[n]}) ${why}; name it ${inCopy}/modules/... (the first update would refuse it)`);
    } else if (!cfg.extras.some((e) => rc[n] === `${inCopy}/${posix.basename(e)}` || rc[n].startsWith(`${inCopy}/${posix.basename(e)}/`))) problems.push(`the runner config's ${n} (${rc[n]}) is not inside any of the extras the copy carries, so the first update would refuse it`);
  }
  if (problems.length) return { ops, problems, installed: false };

  const dir = (p, mode, text) => [op(text ?? `mkdir ${p}`, () => { try { io.mkdir(p, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; } }), ...rootOwned(io, p, mode, 'dir')];
  ops.push(...dir(P.install, 0o755), op(`rm -rf ${P.work}   (leftovers of a cut-off install)`, () => io.rm(P.work)), ...dir(P.work, 0o755), ...dir(P.bootstrap, 0o755), ...dir(P.seed, 0o755));
  const made = new Set();
  const dirs = (root, rel) => { const parts = posix.dirname(rel).split('/').filter((x) => x !== '.'); let at = root; return parts.flatMap((x) => { at = join(at, x); if (made.has(at)) return []; made.add(at); return dir(at, 0o755); }); };
  for (const f of BOOTSTRAP_FILES) ops.push(...dirs(P.bootstrap, f), op(`copy ${f} → ${join(P.bootstrap, f)}`, () => io.copyFile(join(ORCH_ROOT, f), join(P.bootstrap, f), 0o644)), ...rootOwned(io, join(P.bootstrap, f), 0o644));
  ops.push(...dir(join(P.seed, 'bin'), 0o755), op(`copy node ${cfg.nodeBin} → ${join(P.seed, NODE)}`, () => io.copyFile(cfg.nodeBin, join(P.seed, NODE), 0o755)), ...rootOwned(io, join(P.seed, NODE), 0o755));
  const uc = updaterConfigFor(io, cfg);
  ops.push(op(`write ${join(P.seed, UPDATER_CONFIG)}`, () => io.write(join(P.seed, UPDATER_CONFIG), `${JSON.stringify(uc, null, 1)}\n`, 0o644)), ...rootOwned(io, join(P.seed, UPDATER_CONFIG), 0o644));
  ops.push(op(`copy ${cfg.runnerConfig} → ${join(P.seed, RUNNER_CONFIG)}`, () => io.write(join(P.seed, RUNNER_CONFIG), readSource(cfg.runnerConfig), 0o644)), ...rootOwned(io, join(P.seed, RUNNER_CONFIG), 0o644));
  for (const e of cfg.extras) { const to = join(P.seed, posix.basename(e)); ops.push(op(`copy ${e} → ${to}`, () => { io.copyTree(e, to); ownTree(io, to); })); }
  ops.push(op(`run the updater's first run as root: ${join(P.seed, NODE)} ${join(P.bootstrap, SCRIPTS.updater)} ${join(P.seed, UPDATER_CONFIG)} --first ${P.seed}`, () => {
    const r = runUpdater(io, { node: join(P.seed, NODE), script: join(P.bootstrap, SCRIPTS.updater), config: join(P.seed, UPDATER_CONFIG), seed: P.seed });
    if (r.status !== 0) throw new Error(`the updater's first run failed (exit ${r.status}): ${String(r.stderr).trim().slice(-300)}`);
  }), op(`rm -rf ${P.work}`, () => io.rm(P.work)));
  return { ops, problems, installed: false };
}

/** The real first run: a child process, no shell, the paths as arguments. */
export function spawnUpdater(io, { node, script, config, seed }) {
  const r = spawnSync(io.at(node), [io.at(script), io.at(config), '--first', io.at(seed)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 600_000 });
  return { status: r.status ?? 1, stderr: String(r.stderr ?? r.error?.message ?? '') };
}

/** Every folder in the copy and above it, to the top: all that must be root's alone (and without an access list). */
function folderList(io, cfg) {
  const P = installPaths(cfg); const out = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  const top = io.prefix || '/';
  for (let p = io.at(dirname(P.installRoot)); ; p = dirname(p)) { out.push(p); if (p === top || p === dirname(p)) break; }
  if (cur.real) {
    out.push(io.at(P.installRoot));
    const walk = (d) => { out.push(d); for (const n of io.listReal(d)) { const q = join(d, n); if (io.lstatReal(q).isDirectory()) walk(q); } };
    walk(cur.real);
  }
  return out;
}

/** Read only → [{ ok, what, why? }]. `main` is a commit the stamp must equal, when the caller knows it. */
export function checkInstall(io, cfg, { main = null } = {}) {
  const P = installPaths(cfg); const out = [];
  const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const top = io.prefix || '/';
  const root = io.at(P.installRoot);
  const cur = currentCopy(root, { owner: io.rootUid });
  item(!cur.missing && !cur.problem && cur.link, `${P.installRoot} is root's link to a ${posix.basename(P.installRoot)}.v-<commit> folder beside it`, cur.problem ?? 'is not a link');
  if (!cur.link) return out;
  const files = [NODE, UPDATER_CONFIG, RUNNER_CONFIG].map((n) => join(root, n));
  const bad = installProblem(root, files, { owner: io.rootUid, top });
  item(bad === null, 'the copy and every folder above it are root\'s, written by no one else, no links', bad);
  const stamp = readInstallStamp(root, { owner: io.rootUid });
  item(stamp !== null, `the commit stamp (${STAMP}) is there and root's`, 'missing or not root\'s alone');
  if (main) item(stamp === main, 'the stamp is main\'s commit', `stamp ${stamp ?? 'none'}, main ${main}`);
  const dirs = folderList(io, cfg);
  const acl = aclProblem(dirs);
  item(acl === null, `none of the ${dirs.length} install folders has an access list`, acl);
  let rc = null; try { rc = JSON.parse(io.readText(join(P.installRoot, RUNNER_CONFIG))); } catch { /* reported below */ }
  item(rc !== null && rc.installRoot === root, 'the copy\'s review.json is JSON and names this copy', 'unreadable or names another installRoot');
  for (const n of RUNNER_NAMES) if (rc && typeof rc[n] === 'string') { let here = true; try { io.lstatReal(rc[n]); } catch { here = false; } item(here, `review.json's ${n} exists in the copy`, `${rc[n]} is missing`); }
  return out;
}
