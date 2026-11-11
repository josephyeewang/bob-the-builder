// Setup part 4: the watch-only week's two Mac-side pieces (R-0b-122, lane 4 round 2).
//
//   watch-rules --rules-source <full path>   root puts the rules draft in place: the file must hash to the config's `watch.rulesSha256`
//                                       (written by root in the config, so the owner's user cannot pick other rules); the copy
//                                       is root's 0644 in orchestrate's watch folder. The runner re-checks the hash every pass.
//   check-watch-rules                   the copy is there, root's 0644, no access list, and hashes to the config's value
//   the hourly job <label>.watch-only   runs as `orchestrate`, from the installed copy, `watch-run.mjs once --rules draft ...`;
//                                       built with the launcher's one plist builder (review-daemons.mjs); placed and loaded
//                                       with the other jobs by daemons.mjs
//
// Both are off when the config has no `watch` key. Nothing here names a product or a person: the repository comes from config.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ABS, LABEL, arr, plist, str } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { NODE, aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { ROOT_CONFIG_PATH, homeOf, isRepoName, parseConfig, watchRulesPath } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { tokenPath } from './extras.mjs';
import { READ_TROUBLE, faultWords } from '../modules/M6-merge-gate/watch-only.mjs';

export const WATCH_RUN = 'modules/M6-merge-gate/watch-run.mjs';
export const WATCH_EVERY_S = 3600;
const op = (text, run) => ({ text, run });
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const short = (h) => h.slice(0, 12);

/** Said wherever the config's watch entry has the repository but not yet the rules fingerprint (prove-token needs only the repository). */
export const WATCH_NO_HASH = "the config's watch entry has no rulesSha256 yet: run watch-rules --print-config-line --repo <owner/name> --rules-source <file>, and add the line it prints";

/** The watcher App's key (L627): orchestrate's 0600 file in the keys folder, named by the config. null when the config names no App. */
export const watchAppKeyPath = (cfg) => (cfg.watch?.app ? join(cfg.base, 'keys', cfg.watch.app.keyFile) : null);
/** The three App arguments watch-run takes, all or none (L624): without them the job can't read check runs. */
export const appArgs = (cfg) => (cfg.watch?.app ? ['--app-id', cfg.watch.app.id, '--app-installation', cfg.watch.app.installation, '--app-key-file', watchAppKeyPath(cfg)] : []);

/** The hourly job's plist text. `cfg` must carry `watch` (repo AND rulesSha256) and the install keys (label). */
export function watchPlist(io, cfg) {
  if (!/^[0-9a-f]{64}$/.test(String(cfg.watch?.rulesSha256))) throw new Error(WATCH_NO_HASH);
  const P = installPaths(cfg);
  if (!LABEL.test(String(cfg.label))) throw new Error('bad job label');
  for (const [k, v] of Object.entries({ installRoot: P.installRoot, logDir: P.logDir })) if (!ABS.test(String(v))) throw new Error(`${k} must be an absolute path`);
  const home = homeOf(cfg, 'orchestrate');
  return plist([
    `<key>Label</key>${str(`${cfg.label}.watch-only`)}`,
    `<key>UserName</key>${str('orchestrate')}`,
    `<key>ProgramArguments</key>${arr([join(P.installRoot, NODE), join(P.installRoot, WATCH_RUN), 'once', '--repo', cfg.watch.repo, '--dir', join(cfg.base, 'watch'), '--token-file', tokenPath(cfg), '--rules', 'draft', '--rules-sha256', cfg.watch.rulesSha256, ...appArgs(cfg)])}`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key>${str('/usr/bin:/bin:/usr/sbin:/sbin')}<key>HOME</key>${str(home)}</dict>`,
    `<key>WorkingDirectory</key>${str(home)}`,
    '<key>Umask</key><integer>63</integer>',
    `<key>StartInterval</key><integer>${WATCH_EVERY_S}</integer>`,
    '<key>RunAtLoad</key><true/>',
    `<key>StandardOutPath</key>${str(join(P.logDir, 'watch-only.out.log'))}`,
    `<key>StandardErrorPath</key>${str(join(P.logDir, 'watch-only.err.log'))}`,
  ]);
}

/** A rules file named on the command line: a full path, a plain non-empty file that can be read. → { text } or { problem }. Fails closed. */
function readRules(source, readSource) {
  if (typeof source !== 'string' || !source.startsWith('/')) return { problem: '--rules-source must be the full path of the rules file' };
  let text; try { text = readSource(source); } catch (e) { return { problem: `the rules file could not be read: ${e?.message ?? 'error'}` }; }
  if (typeof text !== 'string' || text.length === 0) return { problem: 'the rules file is empty' };   // the size limit is the reader's (readConfigFile: 64 KB), stated once there
  return { text };
}

/** The one line to add to the root config: the repository and the fingerprint of the rules file named. Reads only. It ends in a
 *  comma, ready to go above another key; as the LAST key, drop that comma (the runbook's step strips it with sed). */
export function watchConfigLine(cfg, { repo, source, readSource }) {
  if (!isRepoName(repo)) return { problem: '--repo must be owner/name' };
  const r = readRules(source, readSource); if (r.problem) return r;
  return { line: `  "watch": { "repo": ${JSON.stringify(repo)}, "rulesSha256": "${sha(r.text)}" },` };
}

/** Root puts the rules draft in place. → { ops, problems }. `readSource(path)` reads a file outside the prefix (a port for tests). */
export function planWatchRules(io, cfg, { source, readSource }) {
  if (!cfg.watch) return { ops: [], problems: ['the config has no "watch" entry (repo and rulesSha256); add it first'] };
  if (!cfg.watch.rulesSha256) return { ops: [], problems: [WATCH_NO_HASH] };
  const r = readRules(source, readSource); if (r.problem) return { ops: [], problems: [r.problem] };
  const text = r.text;
  const got = sha(text);
  if (got !== cfg.watch.rulesSha256) return { ops: [], problems: [`the rules file hashes to ${short(got)}…, but the config (which only root can change) says ${short(cfg.watch.rulesSha256)}…; nothing was changed`] };
  const dir = join(cfg.base, 'watch'); const dest = watchRulesPath(cfg);
  const orch = readUser(io, 'orchestrate');
  if (!orch.exists) return { ops: [], problems: ['the orchestrate user does not exist yet (run users-folders first)'] };
  let d; try { d = io.lstat(dir); } catch { return { ops: [], problems: [`${dir} is not there (run users-folders first)`] }; }
  if (d.isSymbolicLink() || !d.isDirectory() || d.uid !== orch.uid || (d.mode & 0o7777) !== 0o700) return { ops: [], problems: [`${dir} is not orchestrate's own 0700 folder (run users-folders first)`] };
  let same = false;
  try { const s = io.lstat(dest); same = s.isFile() && !s.isSymbolicLink() && s.uid === io.rootUid && s.gid === 0 && (s.mode & 0o7777) === 0o644 && sha(io.readRules(io.at(dest))) === got && aclProblem([io.at(dest)]) === null; } catch { /* not there */ }
  if (same) return { ops: [], problems: [] };
  return { ops: [op(`write ${dest}   (root:wheel 0644, hash ${short(got)}…)`, () => { io.unlink(dest); io.writeOwned(dest, text, { uid: io.rootUid, gid: 0, mode: 0o644 }); })], problems: [] };
}

/**
 * `watch-app` (L630): name the watcher App in root's config, so no one edits that file by hand. The plan is made from the
 * config text as it was read (`text`, `raw`); the run checks the file still holds that same text before it writes, then
 * writes the new text beside it (root:wheel 0644) and renames it over the config in one step. Every other entry is kept as
 * it was. Refused when the result would not load, when there is no watch entry, or when the key is not in place yet (the
 * job must never be pointed at a key that is not there). The same App already named → nothing to do.
 * `rulesSha256` (L633), optional: also pins the rules through the config, so a job placed from it judges by the rules
 * copy in place; refused unless that copy hashes to it (so a re-pin that changed only the job file is brought back here).
 */
export function planWatchApp(io, cfg, { raw, text, app, rulesSha256 = null, dry = false }) {
  if (!raw?.watch) return { ops: [], problems: ['the config has no "watch" entry (repo and rulesSha256); add it first'] };
  const next = { ...raw, watch: { ...raw.watch, ...(rulesSha256 !== null ? { rulesSha256 } : {}), app: { id: app.id, installation: app.installation, keyFile: app.keyFile } } };
  let cfg2; try { cfg2 = { ...cfg, watch: parseConfig(next).watch }; } catch (e) { return { ops: [], problems: [`${e.message}; nothing was changed`] }; }
  const old = raw.watch.app; const oldPin = raw.watch.rulesSha256;
  const pinSame = rulesSha256 === null || rulesSha256 === oldPin;
  if (pinSame && old && old.id === app.id && old.installation === app.installation && old.keyFile === app.keyFile && Object.keys(old).length === 3) return { ops: [], problems: [] };
  const key = checkWatchAppKey(io, cfg2)[0];
  if (!key.ok) return { ops: [], problems: [`the key is not in place as it must be (${key.why}): put it there first, then run this again; nothing was changed`] };
  const copy = checkRulesHash(io, cfg2)[0];
  if (!copy.ok) return { ops: [], problems: [`the rules copy in place does not match the config's pin (${copy.why}); nothing was changed`] };
  const notes = [...(key.skip && dry ? ['   (the key could not be looked at without root; the real run checks it)'] : []), ...(copy.skip && dry ? ['   (the rules copy could not be looked at without root; the real run checks it)'] : [])];
  const pinNote = pinSame ? '' : `, rules pin ${short(rulesSha256)}… (it was ${oldPin ? `${short(oldPin)}…` : 'none'})`;
  const body = `${JSON.stringify(next, null, 2)}\n`; const tmp = `${ROOT_CONFIG_PATH}.new`; const was = sha(text);
  return { ops: [
    op(`check ${ROOT_CONFIG_PATH} still holds the text this plan was made from`, () => {
      const now = io.readConfig(ROOT_CONFIG_PATH, { strict: true });
      if (sha(now) !== was) throw new Error(`${ROOT_CONFIG_PATH} changed after this plan was made; nothing was changed`);
    }),
    op(`write ${tmp} (root:wheel 0644): the config with watch.app = App ${app.id}, installation ${app.installation}, key ${watchAppKeyPath(cfg2)}${old ? ` (it named App ${old.id})` : ''}${pinNote}${notes.join('')}`, () => {
      io.unlink(tmp); io.writeOwned(tmp, body, { uid: io.rootUid, gid: 0, mode: 0o644 });
    }),
    op(`rename ${tmp} over ${ROOT_CONFIG_PATH}`, () => io.rename(tmp, ROOT_CONFIG_PATH)),
  ], problems: [], cfgAfter: cfg2 };
}

/** watch-app's read-back: root's config, read again as root reads it, names exactly this App, and its key passes. */
export function checkWatchAppConfig(io, cfg, app, rulesSha256 = null) {
  const what = `${ROOT_CONFIG_PATH} names the watcher App ${app.id}, installation ${app.installation}, key ${app.keyFile}${rulesSha256 ? `, rules pin ${short(rulesSha256)}…` : ''}`;
  let w; try { w = parseConfig(JSON.parse(io.readConfig(ROOT_CONFIG_PATH, { strict: true }))).watch; } catch (e) { return [{ ok: false, what, why: `could not be read back (${e.message})` }]; }
  const a = w?.app; const ok = !!a && a.id === app.id && a.installation === app.installation && a.keyFile === app.keyFile && (rulesSha256 === null || w.rulesSha256 === rulesSha256);
  return [{ ok, what, ...(ok ? {} : { why: 'the file read back does not name it' }) }, ...checkRulesHash(io, { ...cfg, watch: w }), ...checkWatchAppKey(io, { ...cfg, watch: w })];
}

/** check-watch-rules, read only: the rules copy, then the watcher App's key (L627). */
export const checkWatchRules = (io, cfg) => { const r = checkRulesCopy(io, cfg); return cfg.watch?.rulesSha256 ? [...r, ...checkWatchAppKey(io, cfg)] : r; };

/** The rules copy alone (watch-rules' read-back): read only → [{ ok, what, why? }]; needs root to look (the folder is orchestrate's 0700). */
/**
 * The rules copy in place hashes to the config's pin (L633): a plain file, read as root, its owner and mode not judged. So
 * watch-app can bring a pin set by hand in the job file back into the config even while the copy is not yet root's 0644
 * (a hand re-pin installs it as orchestrate's 600); `watch-rules` then rewrites it as root's, and check-watch-rules
 * judges all of it.
 */
export function checkRulesHash(io, cfg) {
  const f = watchRulesPath(cfg); const what = `${f} hashes to the config's pin`;
  if (!cfg.watch?.rulesSha256) return [{ ok: false, what, why: WATCH_NO_HASH }];
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: 'the folder is orchestrate-only; needs root to look; run with sudo' }];
  let st; try { st = io.lstat(f); } catch { return [{ ok: false, what, why: 'missing (run watch-rules --rules-source <file>)' }]; }
  if (st.isSymbolicLink() || !st.isFile()) return [{ ok: false, what, why: 'is not a plain file' }];
  let h; try { h = sha(io.readRules(io.at(f))); } catch (e) { return [{ ok: false, what, why: `could not be read (${e.message})` }]; }
  return h === cfg.watch.rulesSha256 ? [{ ok: true, what }] : [{ ok: false, what, why: `hashes to ${short(h)}…, the pin is ${short(cfg.watch.rulesSha256)}…` }];
}

export function checkRulesCopy(io, cfg) {
  const f = watchRulesPath(cfg); const what = `${f} is root:wheel's 0644 copy of the rules, and hashes to the config's value`;
  if (!cfg.watch) return [{ ok: true, what: 'the watch-only week is not set up (no "watch" entry in the config)' }];
  if (!cfg.watch.rulesSha256) return [{ ok: false, what, why: WATCH_NO_HASH }];
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: 'the folder is orchestrate-only; needs root to look; run with sudo' }];
  let st; try { st = io.lstat(f); } catch { return [{ ok: false, what, why: 'missing (run watch-rules --rules-source <file>)' }]; }
  const why = [];
  if (st.isSymbolicLink() || !st.isFile()) why.push('is not a plain file');
  else {
    if (st.uid !== io.rootUid) why.push(`owner is uid ${st.uid}, not root`);
    if (st.gid !== 0) why.push(`group is gid ${st.gid}, not wheel (0)`);
    if ((st.mode & 0o7777) !== 0o644) why.push(`mode is ${(st.mode & 0o7777).toString(8)}, want 644`);
    const acl = aclProblem([io.at(f)]); if (acl) why.push(acl);
    let h = null; try { h = sha(io.readRules(io.at(f))); } catch (e) { why.push(`could not be read (${e.message})`); }
    if (h !== null && h !== cfg.watch.rulesSha256) why.push(`hashes to ${short(h)}…, the config says ${short(cfg.watch.rulesSha256)}…`);
  }
  return [{ ok: why.length === 0, what, ...(why.length ? { why: why.join('; ') } : {}) }];
}

/** The watcher App's key file: orchestrate's own plain 0600 file, of a key's size, with no access list (L627). Never reads it. */
export function checkWatchAppKey(io, cfg) {
  const f = watchAppKeyPath(cfg);
  if (!f) return [{ ok: false, what: 'the watch job names a watcher App', why: 'the config\'s watch entry has no "app" (id, installation, keyFile): without it the job cannot read check runs' }];
  return keyFileItems(io, f);
}

/**
 * An App key file in the robot key folder (the watcher App's, L627; the robot App's, L727): orchestrate's own plain 0600
 * file, of a key's size, one name, with no access list. Never reads it. Without root it is skipped, never a pass.
 */
export function keyFileItems(io, f) {
  const what = `${f} is orchestrate's own 0600 file of a key's size, with no access list`;
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: 'the folder is orchestrate-only; needs root to look; run with sudo' }];
  const orch = readUser(io, 'orchestrate');
  if (!orch.exists) return [{ ok: false, what, why: 'the orchestrate user does not exist' }];
  let st; try { st = io.lstat(f); } catch (e) { return [{ ok: false, what, why: e?.code === 'ENOENT' ? 'missing' : `could not be looked at (${e?.code ?? e})` }]; }
  const why = [];
  if (st.isSymbolicLink() || !st.isFile()) why.push('is not a plain file');
  else {
    if (st.uid !== orch.uid) why.push(`owner is uid ${st.uid}, not orchestrate`);
    // Exactly 0600 on purpose: token.mjs (mintInstallationToken), the reader, refuses only group or other bits, so it takes
    // 0400 too. Setup is stricter because the mode is one it sets and fixes; a key copied in read-only needs chmod 600.
    if ((st.mode & 0o7777) !== 0o600) why.push(`mode is ${(st.mode & 0o7777).toString(8)}, want 600`);
    if (st.nlink !== undefined && st.nlink !== 1) why.push('has a second name');
    if (!(st.size >= 200 && st.size <= 10_000)) why.push('its size is not a key\'s');
    const acl = aclProblem([io.at(f)]); if (acl) why.push(acl);
  }
  return [{ ok: why.length === 0, what, ...(why.length ? { why: why.join('; ') } : {}) }];
}

// ───────────────────────────────────────────── prove the App's read of the check runs (L707 M1)

const SUDO = '/usr/bin/sudo';
const SAID = /^[A-Za-z0-9 ().,']{1,80}$/;

/**
 * The one read the watch job makes with the watcher App's token (L624), proven for real: as `orchestrate` (only it may mint),
 * the installed copy's watch-run.mjs `checks` mints the App's token through token.mjs with the job's own function and the
 * job's own arguments (appArgs, read from this config, as the job's plist has them), then reads the check runs at the pull
 * request's head that prove-token found (`on.head`). The token never leaves that process: it is in no argument and no line;
 * only its fixed-word JSON line comes back. A missing App, key, copy or a failed mint or read is a FAIL that says which.
 * → one row { ok, what, why? }.
 */
export function proveWatchAppChecks(io, cfg, on) {
  const what = `the watcher App's token, minted as orchestrate, reads the check runs (at pull request #${on.pr}'s head ${on.head.slice(0, 7)})`;
  const no = (why) => ({ ok: false, what, why });
  const key = watchAppKeyPath(cfg);
  if (!key) return no('the config\'s watch entry names no watcher App (id, installation, keyFile), so the job cannot read check runs; run watch-app first');
  try { io.lstat(key); } catch { return no(`the watcher App's key file ${key} is missing; put it there (see watch-app), then run this again`); }
  const P = installPaths(cfg);
  const run = join(P.installRoot, WATCH_RUN);
  try { io.lstat(run); } catch { return no(`the installed copy has no ${WATCH_RUN}; run install first`); }
  const r = io.run(SUDO, ['-n', '-H', '-u', 'orchestrate', join(P.installRoot, NODE), run, 'checks', '--repo', cfg.watch.repo, '--sha', on.head, ...appArgs(cfg)]);
  let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { /* below */ }
  if (!j || typeof j !== 'object') {
    if (r.status === 2 && /first word must be once, summary or explain/.test(String(r.stderr))) return no('the installed copy is older than this check (its watch-run.mjs has no "checks"); update the install, then run this again');
    return no(`the check could not run as orchestrate (exit ${Number.isInteger(r.status) ? r.status : 'unknown'}), so the App's read is not proven`);
  }
  if (j.ok === true && r.status === 0) return { ok: true, what };
  if (j.stage === 'mint') return no(`the App's token could not be minted as orchestrate (${String(j.reason ?? 'no reason given').replace(/[^\x20-\x7e]/g, '').slice(0, 200)}); check the App's id, installation and key at GitHub`);
  if (j.stage === 'read' && ['permission', 'trouble', 'other'].includes(j.kind)) {
    // `said` is readFault's fixed words; anything else in its place is not shown.
    const said = typeof j.said === 'string' && SAID.test(j.said) ? j.said : Number.isInteger(j.status) ? `GitHub answered ${j.status}` : 'GitHub did not answer as asked';
    return no(faultWords({ kind: j.kind, said }, `give the watcher App "Checks: Read" and install it on ${cfg.watch.repo} at GitHub`));
  }
  return no(`the check gave no answer it could use (exit ${r.status}); ${READ_TROUBLE}`);
}
