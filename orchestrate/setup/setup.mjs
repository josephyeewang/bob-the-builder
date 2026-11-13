#!/usr/bin/env node
// The always-on Mac's one-time setup commands (R-0b-05 and the install). Every command has a --dry-run (changing commands)
// or is read only; every changing command is safe to run twice and refuses clearly when it needs root and does not have it.
//
//   users-folders        [--dry-run]    the three Mac users and their folders                                  (root)
//   check                               PASS, FAIL or NEEDS ROOT per item for the above; exit 3 if some need root (read only)
//   proofs               [--dry-run]    the owner's own Mac user cannot write the record, hooks,
//                                       settings, launcher... or read the keys                                 (root, read only)
//   install              [--dry-run]    the link layout, then the updater's first run                          (root)
//   check-install        [--main <sha>] the copy, its link, every install folder, access lists                 (read only)
//   review-config --pin <x.y.z> --input <file> --out <file> [--for-install] [--dry-run]   the review runner's review.json,
//                                       built: setup's values, the pin, and the owner's few from --input; read back with
//                                       the runner's own check; --for-install for a first install (review-config.mjs) (NOT root)
//   add-to-install --pin <x.y.z> --sha256 <hex> [--dry-run]   the pinned Claude Code and the hooks into the installed copy, in
//                                       place: no update, no job touched; safe to run again                    (root)
//   bob --from <a Bob checkout> --commit <40-hex sha> [--dry-run]   the Bob method folder the sessions read and its
//                                       pinned file list, from that commit, together (launch check 13; bob-manifest.mjs)  (root)
//   check-dispatcher     the review runner's launches folder, the job's dispatcher.json's outboxRoot and copiesRoot, and whether orchestrate can read the owner's host.lock, and if not why  (read only; sudo to read as orchestrate)
//   dispatcher-config    [--dry-run]    write the Dispatcher's config, <base>/dispatcher.json (and the copy's, when the copy keeps it)  (root)
//                                       an existing dispatcher.json without outboxRoot and copiesRoot won't start the Dispatcher until this is run again
//   host-lock-copier     prints the owner's host.lock copier job file (a LaunchAgent of the owner's, L1029 E) on stdout and how to load it on
//                        stderr; needs hostLockSource (read only; refused under sudo)
//   dispatcher-keys      prints the Dispatcher config's reviewRoot, mirror, sealRoot, outboxRoot, copiesRoot, hostLockPath and hostLockUid as JSON (read only)
//   daemons place|load|unload  [--dry-run]   the three background jobs' files; load; unload                    (root)
//                                       (place and load refuse on the same checks: a placed job starts at boot without load)
//   daemons list                        loaded or not, per job                                                 (read only)
//   daemons place|load|unload|list|check --only <job>   that one job only (e.g. watch-only); an unknown name is refused
//                                       (the robot job, `robot`, is one of them only when the config says "robot": true; robot-setup.mjs;
//                                       the Dispatcher job, `dispatcher`, only when the config has a "dispatcher" entry; dispatcher-setup.mjs)
//   daemons check                       the job files are exact, no leftover jobs, each job loaded from the file as it is now, last exit 0, no run going over 30 minutes (the Dispatcher: its deadline plus the watchdog's margin, about 35)  (read only)
//   daemons reload-account [--dry-run]  reload the account job; exits 1 ("Run: daemons load") when it is not loaded  (root)
//   proposals  [--dry-run]  the proposals folders: parent root's, one per product  (root)
//   check-proposals  owner, mode, access list; with sudo, who can read or write (read only)
//   safe-directory  [--dry-run]  the owner's git trusts exactly the mirror folder  (root, runs git as the owner)
//   check-safe-directory (read only; sudo to look)
//   token  [--dry-run]  save the watch-only token (typed hidden, never shown)  (root)
//   prove-token  the repository is the config's watch.repo (private, not archived); read works, a no-op pull-request write is refused as "this token may not"; each kind of read the watch job makes works (the check runs with the watcher App's token, minted as orchestrate); then a note to check the token page by eye  (sudo: the token is read as orchestrate)
//   watch-rules --rules-source <full path> [--dry-run]  put the watch-only week's rules in place (the file's hash must match the config)  (root)
//   watch-rules --print-config-line --repo <owner/name> --rules-source <full path>  prints the config line (repo + fingerprint of that file)  (read only)
//   check-watch-rules  the rules copy is root's, 0644, and hashes to the config's value; the watcher App's key FILE is orchestrate's 0600 (the file only: it asks GitHub nothing; prove-token proves the App's read)  (read only; sudo to look)
//   check-token  the token file's owner, mode and size (never its text)  (read only; sudo to look)
//   watch-app --app-id <id> --app-installation <id> --app-key-name <name> [--rules-sha256 <hex>] [--dry-run]  name the watcher App in root's config (the key must already be in the keys folder); every other entry is kept  (root)
//
// The config: as root, ONLY the root-owned file at ROOT_CONFIG_PATH (layout.mjs), opened without following links, owned
// by root, written by no one else, in folders only root writes (NEW-1). Without sudo, `--config <file>` may name another
// file (for a --dry-run before the real one is put in place).
//
// `--root-prefix <dir>` is for tests only (every folder path is put under it; the Mac's user records are not) and is
// refused when running as root: under sudo it would move where root writes while every printed path still read
// /Library/... (L90 minor b). Exit: 0 fine, 1 a check failed or a problem was found, 2 usage or not root.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_CONFIG_PATH, parseConfig } from './layout.mjs';
import { checkDispatcherKeys, dispatcherKeysOn } from './dispatcher-check.mjs';
import { DISPATCHER_JOB, checkDispatcherConfig, parseDispatcher, planDispatcherConfig } from './dispatcher-setup.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { guarded } from './guard.mjs';
import { apply, check, plan } from './users-folders.mjs';
import { proofCommands, runProofs } from './proofs.mjs';
import { checkInstall, installPaths, parseInstallConfig, planAddToInstall, planInstall, rootMadeEntries, spawnUpdater } from './install.mjs';
import { COPIER_JOB, copierPlist } from './host-lock-copy.mjs';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';
import { checkDaemons, jobLive, list, onlyJobs, planLoad, planPlace, planReloadAccount, planUnload } from './daemons.mjs';
import { checkRulesCopy, checkWatchAppConfig, checkWatchRules, planWatchApp, planWatchRules, proveWatchAppChecks, watchConfigLine } from './watch-setup.mjs';
import { reviewConfigCommand } from './review-config.mjs';
import { bobGit, checkBob, planBob } from './bob-manifest.mjs';
import { readUser } from './users-folders.mjs';
import { proveToken, checkProposals, checkSafeDirectory, checkToken, planProposals, planSafeDirectory, planToken } from './extras.mjs';

// What prove-token did NOT prove, said after a PASS (L173 n1): only that the token cannot write pull requests.
const TOKEN_PAGE_NOTE = [
  'What this proved: the token cannot write pull requests. It did not prove the token cannot change code, or that it reaches only one repository.',
  "Now check that by eye, on GitHub's token page (github.com → your picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → this token):",
  '  - Repository access: only the one repository named in the config;',
  '  - Permissions: Metadata = Read-only (GitHub adds it by itself; fine if absent), Contents = Read-only (GitHub may call it "code"), Pull requests = Read-only, Commit statuses = Read-only (the watch job reads it to judge a merge), and nothing else. (Not Checks: the job reads check runs with the watcher App, which holds Checks: read.)',
];
const USAGE = 'usage: node setup.mjs <users-folders|check|proofs|install|check-install|check-dispatcher|dispatcher-config|dispatcher-keys|host-lock-copier|review-config --pin <x.y.z> --input <file> --out <file> [--for-install]|add-to-install --pin <x.y.z> --sha256 <hex>|bob --from <Bob checkout> --commit <sha>|daemons place|load|unload|list|check [--only <job>]|daemons reload-account|prove-token|proposals|check-proposals|safe-directory|check-safe-directory|token|check-token|watch-rules|check-watch-rules|watch-app> [--config <file>, without sudo only] [--dry-run] [--main <commit>]';
const DAEMON_SUBS = ['place', 'load', 'unload', 'list', 'check', 'reload-account'];
const COMMANDS = ['users-folders', 'check', 'proofs', 'install', 'check-install', 'check-dispatcher', 'dispatcher-config', 'dispatcher-keys', 'host-lock-copier', 'review-config', 'add-to-install', 'bob', 'daemons', 'proposals', 'check-proposals', 'safe-directory', 'check-safe-directory', 'token', 'check-token', 'prove-token', 'watch-rules', 'check-watch-rules', 'watch-app'];
const READ_ONLY = ['check', 'check-install', 'check-dispatcher', 'dispatcher-keys', 'check-proposals', 'check-safe-directory', 'check-token', 'prove-token', 'check-watch-rules'];
const PLAIN_CONFIG = ['users-folders', 'check', 'check-dispatcher', 'dispatcher-keys', 'proofs', 'proposals', 'check-proposals', 'safe-directory', 'check-safe-directory', 'token', 'check-token', 'prove-token', 'watch-rules', 'check-watch-rules', 'watch-app', 'review-config'];

export function parseArgs(argv) {
  const cmd = argv[0];
  if (!COMMANDS.includes(cmd)) throw new Error(`first word must be ${COMMANDS.join(', ')}`);
  let rest = argv.slice(1); let sub = null;
  if (cmd === 'daemons') { sub = rest[0]; rest = rest.slice(1); if (!DAEMON_SUBS.includes(sub)) throw new Error(`daemons needs one of ${DAEMON_SUBS.join(', ')}`); }
  const o = { cmd, sub, config: null, dry: false, prefix: '', main: null, repo: null, rulesSource: null, printLine: false, only: null, app: {}, pin: null, claudePin: null, sha256: null, input: null, out: null, forInstall: false, from: null, commit: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--print-config-line') o.printLine = true;
    else if (a === '--for-install') o.forInstall = true;
    else if (a === '--rules-sha256') {
      const v = rest[++i];
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new Error('--rules-sha256 needs the rules file\'s 64-hex fingerprint');
      o.pin = v;
    } else if (a === '--app-id' || a === '--app-installation' || a === '--app-key-name') {
      const v = rest[++i];
      if (typeof v !== 'string' || v.startsWith('--')) throw new Error(`${a} needs a value`);
      o.app[{ '--app-id': 'id', '--app-installation': 'installation', '--app-key-name': 'keyFile' }[a]] = v;
    }
    else if (a === '--config' || a === '--root-prefix' || a === '--main' || a === '--repo' || a === '--rules-source' || a === '--only' || a === '--pin' || a === '--sha256' || a === '--input' || a === '--out' || a === '--from' || a === '--commit') {
      const v = rest[++i];
      if (typeof v !== 'string' || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--pin') { if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('--pin must be a version, x.y.z'); o.claudePin = v; continue; }
      if (a === '--sha256') { if (!/^[0-9a-f]{64}$/.test(v)) throw new Error('--sha256 must be 64 lower-case hex characters'); o.sha256 = v; continue; }
      if (a === '--from') { o.from = v; continue; }
      if (a === '--commit') { if (!/^[0-9a-f]{40}$/.test(v)) throw new Error('--commit must be the full commit: 40 lower-case hex characters'); o.commit = v; continue; }
      if (a === '--input') { o.input = v; continue; }
      if (a === '--out') { o.out = v; continue; }
      if (a === '--config') o.config = v; else if (a === '--main') { if (!/^[0-9a-f]{40}$/.test(v)) throw new Error('--main must be a 40-hex commit'); o.main = v; } else if (a === '--repo') o.repo = v; else if (a === '--rules-source') o.rulesSource = v; else if (a === '--only') o.only = v; else o.prefix = v;
    } else throw new Error(`argument ${i + 1} is not one this command takes (it is not shown, in case it is a secret)`);
  }
  const readOnly = READ_ONLY.includes(cmd) || (cmd === 'daemons' && (sub === 'list' || sub === 'check'));
  if (readOnly && o.dry) throw new Error('this command never changes anything, so --dry-run does not apply');
  if (o.repo !== null && !(cmd === 'watch-rules' && o.printLine)) throw new Error('--repo is only for watch-rules --print-config-line (prove-token takes the repository from the config)');
  if (o.printLine && cmd !== 'watch-rules') throw new Error('--print-config-line is only for watch-rules');
  if (o.printLine && (o.dry || !o.repo)) throw new Error('--print-config-line reads only and needs --repo owner/name and --rules-source <full path> (no --dry-run)');
  if (o.rulesSource !== null && cmd !== 'watch-rules') throw new Error('--rules-source is only for watch-rules');
  if (cmd === 'watch-rules' && !o.rulesSource) throw new Error('watch-rules needs --rules-source <the full path of the rules file>');
  if (o.only !== null && !(cmd === 'daemons' && ['place', 'load', 'unload', 'list', 'check'].includes(sub))) throw new Error('--only is only for daemons place, load, unload, list and check');
  if (Object.keys(o.app).length && cmd !== 'watch-app') throw new Error('--app-id, --app-installation and --app-key-name are only for watch-app');
  if (o.pin !== null && cmd !== 'watch-app') throw new Error('--rules-sha256 is only for watch-app');
  if (cmd === 'watch-app' && Object.keys(o.app).length !== 3) throw new Error('watch-app needs all three: --app-id <id> --app-installation <id> --app-key-name <the key file\'s name in the keys folder>');
  if (o.main && cmd !== 'check-install') throw new Error('--main is only for check-install');
  if ((o.input !== null || o.out !== null) && cmd !== 'review-config') throw new Error('--input and --out are only for review-config');
  if (o.claudePin !== null && cmd !== 'review-config' && cmd !== 'add-to-install') throw new Error('--pin is only for review-config and add-to-install');
  if (o.sha256 !== null && cmd !== 'add-to-install') throw new Error('--sha256 is only for add-to-install');
  if (o.forInstall && cmd !== 'review-config') throw new Error('--for-install is only for review-config');
  if (cmd === 'review-config' && (o.claudePin === null || o.input === null || o.out === null)) throw new Error('review-config needs --pin <x.y.z>, --input <your file of the owner\'s fields> and --out <the file to write>');
  if ((o.from !== null || o.commit !== null) && cmd !== 'bob') throw new Error('--from and --commit are only for bob');
  if (cmd === 'bob' && (o.from === null || o.commit === null)) throw new Error('bob needs --from <the full path of a Bob checkout> and --commit <its 40-hex commit>');
  if (cmd === 'add-to-install' && (o.claudePin === null || o.sha256 === null)) throw new Error('add-to-install needs --pin <x.y.z> and --sha256 <hex>');
  return o;
}

function report(res, out) {
  // NOT TRIED is not a pass: it counts as a FAIL (L707 c1).
  for (const r of res) out(r.skip ? `NEEDS ROOT  ${r.what} — ${r.why}` : r.notTried ? `NOT TRIED  ${r.what} — ${r.why}` : r.warn ? `WARNING  ${r.what} — ${r.why}` : r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`);
  const bad = res.filter((r) => !r.ok).length; const skipped = res.filter((r) => r.skip).length; const warned = res.filter((r) => r.warn).length;
  // A check that could not look is not a pass: with any NEEDS ROOT line the summary says so and the exit code is not 0.
  out(`${bad ? `${bad} of ${res.length} FAILED` : skipped ? `${res.length - skipped} PASS, but ${skipped} could not be checked without root (run it again with sudo)` : warned ? `${res.length - warned} PASS and ${warned} WARNING (not a failure, but something does not work until it is put right)` : `all ${res.length} PASS`}`);
  return bad ? 1 : skipped ? 3 : 0;
}

/**
 * The plan for a changing command: { ops, problems, installed? }. Every command that changes the Mac goes through here, and
 * every one of them starts with the same wall (L90 M3): the folders above the base must be root's alone, checked now (a
 * problem gives no steps at all) and again as the FIRST step of the run.
 */
export function planCommand(io, cfg, o, { readSource = (p) => io.readSource(p), runUpdater = spawnUpdater, bobGitOf = (from) => bobGit(io, cfg, from) } = {}) {
  if (o.cmd === 'users-folders') return plan(io, cfg);   // carries the wall itself
  if (o.cmd === 'proposals') return guarded(io, cfg, planProposals(io, cfg));   // the base wall first (L150 m3), then its own wall for the parent (extras.mjs)
  if (o.cmd === 'watch-app') return guarded(io, cfg, planWatchApp(io, cfg, { raw: o.raw, text: o.text, app: o.app, rulesSha256: o.pin, dry: o.dry }));
  if (o.cmd === 'watch-rules') return guarded(io, cfg, planWatchRules(io, cfg, { source: o.rulesSource, readSource: (p) => io.readRules(p) }));
  if (o.cmd === 'safe-directory') return planSafeDirectory(io, cfg);   // root writes nothing: git runs as the owner
  const res = o.cmd === 'install' ? planInstall(io, cfg, { readSource, runUpdater })
    : o.cmd === 'add-to-install' ? planAddToInstall(io, cfg, { pin: o.claudePin, sha256: o.sha256, readSource })
    : o.cmd === 'bob' ? planBob(io, cfg, { from: o.from, commit: o.commit, git: bobGitOf(o.from) })
    : o.cmd === 'token' ? planToken(io, cfg)
    : o.cmd === 'dispatcher-config' ? planDispatcherConfig(io, cfg, { jobLive: () => jobLive(io, cfg, DISPATCHER_JOB) })
    : o.sub === 'place' ? planPlace(io, cfg, o.jobs) : o.sub === 'load' ? planLoad(io, cfg, o.jobs) : o.sub === 'reload-account' ? planReloadAccount(io, cfg) : planUnload(io, cfg, o.jobs);
  return guarded(io, cfg, res);
}

/** Runs one command. `io` and `runUpdater` are ports for tests. → exit code. */
export function main(argv, { io: given, runUpdater = spawnUpdater, bobGitOf, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  let o; let cfg;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const io = given ?? realIo({ prefix: o.prefix });
  const asRoot = io.euid() === 0;
  if (o.prefix && asRoot) { err('refused: --root-prefix is for tests and may not be used as root'); return 2; }
  // Root takes orders only from the root-owned config at the fixed place (NEW-1): never from a file named on the command
  // line, and never from a home folder. And root must not be running a node program others can change, whatever the command
  // (a `sudo check` runs code as root as well; L100 m3).
  if (asRoot) {
    if (o.config) { err(`refused: as root this reads only ${ROOT_CONFIG_PATH}, which must be root's own file; --config is for a run without sudo (see the README)`); return 2; }
    const p = io.nodeProblem?.();
    if (p) { err(`refused: root must not run a node program others can change: ${p}. Use the node from nodejs.org in /usr/local/bin/node by its full path.`); return 2; }
  }
  try {
    const text = io.readConfig(o.config ?? ROOT_CONFIG_PATH, { strict: asRoot || !o.config });
    let raw; try { raw = JSON.parse(text); } catch { throw new Error('the config is not valid JSON'); }   // never the parser's own message: it quotes the file
    cfg = PLAIN_CONFIG.includes(o.cmd) ? parseConfig(raw) : parseInstallConfig(raw);
    if (o.cmd === 'watch-app') { o.raw = raw; o.text = text; }
    // check reads the plain config, which drops the entry: on only when the entry's own parser takes it (L807 c2, r1 c1).
    // An entry there that its parser refuses: check-dispatcher says so rather than leave its root rows out (L905 m1).
    o.dispatcherOn = (() => { try { return parseDispatcher(raw?.dispatcher, cfg) !== undefined; } catch (e) { if (raw?.dispatcher !== undefined) o.dispatcherWhy = e?.message ?? 'it can\'t be read'; return false; } })();
    if (o.only !== null) o.jobs = onlyJobs(cfg, o.only, { anyKnown: o.cmd === 'daemons' && (o.sub === 'unload' || o.sub === 'list') });   // a name that is no job of this config is refused before anything runs (unload and list take any job setup makes)
  } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }

  if (o.cmd === 'review-config') return reviewConfigCommand(cfg, { pin: o.claudePin, input: o.input, out: o.out, dry: o.dry, forInstall: o.forInstall }, { euid: io.euid(), userOf: (n) => readUser(io, n), out, err });
  if (o.cmd === 'check') return report(check(io, cfg, { alsoKnown: rootMadeEntries(cfg, { dispatcher: o.dispatcherOn }) }), out);
  if (o.cmd === 'check-install') {
    const code = report(checkInstall(io, cfg, { main: o.main }), out);
    // The Dispatcher's lines are their own command (L748 r1 M1): `daemons load` and the watch cutover wait on check-install,
    // and a host.lock the Dispatcher can't read must not stop the review or watch jobs. Once the config names it, say where to look.
    if (cfg.hostLockPath !== undefined) out('the Dispatcher\'s folders and host.lock: run check-dispatcher (sudo to read host.lock as orchestrate)');
    return code;
  }
  if (o.cmd === 'check-dispatcher') return report(checkDispatcherKeys(io, cfg, { dispatcher: o.dispatcherOn, refused: o.dispatcherWhy }), out);
  if (o.cmd === 'host-lock-copier') {
    // The owner's own job: never root's to place or load (it runs as the owner, from the installed copy).
    if (asRoot) { err('refused: the host.lock copier is the owner\'s own job; run this without sudo'); return 2; }
    if (cfg.hostLockSource === undefined) { err('PROBLEM  the setup config names no hostLockSource (the synced host.lock the copier copies to hostLockPath)'); return 1; }
    const home = `/Users/${cfg.owner}`;
    if (cfg.hostLockCopierNode !== undefined) {
      // L1041: the node macOS lets read the synced folder must be the owner's alone, so nothing else can run through it.
      const n = cfg.hostLockCopierNode; let st, uid;
      try { st = io.lstat(n); uid = io.euid(); } catch (e) { err(`PROBLEM  hostLockCopierNode ${n} can't be looked at (${e?.code ?? e.message}): copy node there first (README, Part 6 step 5)`); return 1; }
      if (!st.isFile()) { err(`PROBLEM  hostLockCopierNode ${n} is not a plain file (a link is not taken: name the node itself)`); return 1; }
      if (st.uid !== uid || (st.mode & 0o7077) !== 0 || (st.mode & 0o100) === 0) {
        err(`PROBLEM  hostLockCopierNode ${n} must be this user's (the owner's), mode 0700 (it is uid ${st.uid}, mode ${(st.mode & 0o7777).toString(8)}): README, Part 6 step 5`); return 1;
      }
    }
    let text; try { text = copierPlist({ label: cfg.label, installRoot: installPaths(cfg).installRoot, node: NODE, configPath: o.config ?? ROOT_CONFIG_PATH, copy: cfg.hostLockPath, home, copierNode: cfg.hostLockCopierNode }); } catch (e) { err(`PROBLEM  ${e.message}`); return 1; }
    const file = `${home}/Library/LaunchAgents/${cfg.label}.${COPIER_JOB}.plist`;
    out(text);
    err(`Save the text above as ${file} (owner's own, 0644), make the copy's folder ${dirname(cfg.hostLockPath)} (the owner's, 0755), then: launchctl bootstrap gui/$(id -u) ${file}. Run dispatcher-config again so the Dispatcher's dispatcher.json names the copy too (with the Dispatcher's job in place, unload it first: README, Part 6 step 6). A minute later, sudo node setup.mjs check-dispatcher (README, Part 6 step 5).`);
    return 0;
  }
  if (o.cmd === 'dispatcher-keys') { let k; try { k = dispatcherKeysOn(io, cfg); } catch (e) { err(`PROBLEM  ${e.message}`); return 1; } out(JSON.stringify(k, null, 2)); return 0; }
  if (o.cmd === 'check-proposals') return report(checkProposals(io, cfg), out);
  if (o.cmd === 'check-safe-directory') return report(checkSafeDirectory(io, cfg), out);
  if (o.cmd === 'check-token') return report(checkToken(io, cfg), out);
  if (o.cmd === 'check-watch-rules') return report(checkWatchRules(io, cfg), out);
  if (o.cmd === 'watch-rules' && o.printLine) { const r = watchConfigLine(cfg, { repo: o.repo, source: o.rulesSource, readSource: (p) => io.readRules(p) }); if (r.problem) { err(`PROBLEM  ${r.problem}`); return 1; } out(r.line); return 0; }
  if (o.cmd === 'prove-token') return proveToken(io, cfg, { proveApp: (on) => proveWatchAppChecks(io, cfg, on) }).then((res) => { const code = report(res, out); if (code === 0) for (const l of TOKEN_PAGE_NOTE) out(l); return code; });
  if (o.cmd === 'daemons' && o.sub === 'check') return report(checkDaemons(io, cfg, o.jobs), out);
  if (o.cmd === 'daemons' && o.sub === 'list') {
    for (const j of list(io, cfg, o.jobs)) out(j.loaded ? `${j.label}: loaded, ${j.state}, last exit ${j.lastExit}` : `${j.label}: not loaded${j.error ? ` (${j.error})` : ''}`);
    return 0;
  }

  if (o.cmd === 'proofs') {
    if (o.dry) { for (const c of proofCommands(cfg)) out(`would run: ${c}`); out('dry run: nothing was run.'); return 0; }
    const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; }
    const res = runProofs(io, cfg);
    for (const r of res) out(r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`);
    const bad = res.filter((r) => !r.ok).length;
    out(bad ? `${bad} of ${res.length} proofs FAILED` : `all ${res.length} proofs PASS`);
    return bad ? 1 : 0;
  }

  if (!o.dry) { const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; } }
  const planned = planCommand(io, cfg, o, { runUpdater, ...(bobGitOf ? { bobGitOf } : {}) });
  for (const n of planned.notes ?? []) out(`uses ${n}`);
  for (const p of planned.problems) err(`PROBLEM  ${p}`);
  if (planned.problems.length) { err('nothing was changed.'); return 1; }
  if (!planned.ops.length) out(planned.installed ? 'nothing to do: already installed.' : 'nothing to do: already as needed.');
  if (o.dry) {
    for (const x of planned.ops) out(`would run: ${x.text}`);
    // What the plan could not look at without root (#305 r1 m4): never read as checked.
    for (const u of planned.unchecked ?? []) out(`NOT CHECKED  ${u}`);
    // A dry run is not root, but it can read the runner config with root's rules: warn only when root would refuse it, and say why (L169 m4).
    if ((o.cmd === 'install' || o.cmd === 'add-to-install') && cfg.runnerConfig && planned.ops.length) {
      try { io.readSourceStrict(cfg.runnerConfig); } catch (e) { out(`WARNING  root will refuse ${cfg.runnerConfig}: ${e.message}. To put it right: keep your copy of review.json in a folder only you can open, then sudo install -o root -g wheel -m 0644 /dev/stdin <a path in a folder only root can write, e.g. under /Library> < <that copy>, and set runnerConfig in your settings to that path`); }
    }
    out(`dry run: ${planned.ops.length} step(s), nothing changed.`); return 0; }
  // A message that already says what to run next ("run: daemons load") is the one instruction; the generic "run it again" is only for the rest.
  try { apply(planned.ops, { log: (t) => out(`run: ${t}`) }); } catch (e) { const why = String(e.message).replace(/\.+$/, '');   // a message that ends in its own period gets one, not two
    err(/run: daemons load/i.test(e.message) ? `stopped: ${why}.` : `stopped: ${why}. Run it again after fixing that; it picks up where it stopped.`); return 1; }
  const after = o.cmd === 'users-folders' ? check(io, cfg, { alsoKnown: rootMadeEntries(cfg, { dispatcher: o.dispatcherOn }) }) : o.cmd === 'install' || o.cmd === 'add-to-install' ? checkInstall(io, cfg)
    : o.cmd === 'dispatcher-config' ? checkDispatcherConfig(io, cfg) : o.cmd === 'bob' ? checkBob(io, cfg, { commit: o.commit })
    : o.cmd === 'proposals' ? checkProposals(io, cfg) : o.cmd === 'safe-directory' ? checkSafeDirectory(io, cfg) : o.cmd === 'token' ? checkToken(io, cfg) : o.cmd === 'watch-rules' ? checkRulesCopy(io, cfg) : o.cmd === 'watch-app' ? checkWatchAppConfig(io, cfg, o.app, o.pin)
    : o.sub === 'place' ? checkDaemons(io, cfg, o.jobs).filter((r) => /exactly the built job file$|under another label/.test(r.what)) : o.sub === 'load' ? checkDaemons(io, cfg, o.jobs).filter((r) => /is loaded$|loaded from the job file as it is now$/.test(r.what))
    : o.sub === 'reload-account' ? checkDaemons(io, cfg).filter((r) => /review-account (is loaded|was loaded from the job file as it is now)$/.test(r.what)) : null;
  if (!after) { out('done.'); return 0; }
  const bad = after.filter((r) => !r.ok);
  for (const r of bad) err(`FAIL  ${r.what} — ${r.why}`);
  for (const r of after.filter((x) => x.warn)) out(`WARNING  ${r.what} — ${r.why}`);   // a WARNING is never summed up as a plain pass (L737 M1)
  out(bad.length ? `${bad.length} item(s) still FAIL after the run.` : `done: all ${after.length} items PASS${after.some((x) => x.warn) ? ', with the WARNING above' : ''}.`);
  return bad.length ? 1 : 0;
}

// Run as a script, also through a link such as the installed copy's (#261 r2 Minor 1): node gives import.meta.url as the
// real file but keeps argv[1] as typed, so the two are compared with argv[1] resolved, as the checker files do.
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) Promise.resolve(main(process.argv.slice(2))).then((c) => { process.exitCode = c; });
