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
import { homeOf, watchRulesPath } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { tokenPath } from './extras.mjs';

export const WATCH_RUN = 'modules/M6-merge-gate/watch-run.mjs';
export const WATCH_EVERY_S = 3600;
export const REPO_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const op = (text, run) => ({ text, run });
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const short = (h) => h.slice(0, 12);

/** The hourly job's plist text. `cfg` must carry `watch` and the install keys (label). */
export function watchPlist(io, cfg) {
  const P = installPaths(cfg);
  if (!LABEL.test(String(cfg.label))) throw new Error('bad job label');
  for (const [k, v] of Object.entries({ installRoot: P.installRoot, logDir: P.logDir })) if (!ABS.test(String(v))) throw new Error(`${k} must be an absolute path`);
  const home = homeOf(cfg, 'orchestrate');
  return plist([
    `<key>Label</key>${str(`${cfg.label}.watch-only`)}`,
    `<key>UserName</key>${str('orchestrate')}`,
    `<key>ProgramArguments</key>${arr([join(P.installRoot, NODE), join(P.installRoot, WATCH_RUN), 'once', '--repo', cfg.watch.repo, '--dir', join(cfg.base, 'watch'), '--token-file', tokenPath(cfg), '--rules', 'draft', '--rules-sha256', cfg.watch.rulesSha256])}`,
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
  let text; try { text = readSource(source); } catch (e) { return { problem: `the rules file could not be read (${e?.code ?? 'error'})` }; }
  if (typeof text !== 'string' || text.length === 0 || text.length > 200_000) return { problem: 'the rules file is empty or too large' };
  return { text };
}

/** The one line to add to the root config: the repository and the fingerprint of the rules file named. Reads only. */
export function watchConfigLine(cfg, { repo, source, readSource }) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return { problem: '--repo must be owner/name' };
  const r = readRules(source, readSource); if (r.problem) return r;
  return { line: `  "watch": { "repo": ${JSON.stringify(repo)}, "rulesSha256": "${sha(r.text)}" },` };
}

/** Root puts the rules draft in place. → { ops, problems }. `readSource(path)` reads a file outside the prefix (a port for tests). */
export function planWatchRules(io, cfg, { source, readSource }) {
  if (!cfg.watch) return { ops: [], problems: ['the config has no "watch" entry (repo and rulesSha256); add it first'] };
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
  try { const s = io.lstat(dest); same = s.isFile() && !s.isSymbolicLink() && s.uid === io.rootUid && (s.mode & 0o7777) === 0o644 && sha(io.readText(dest)) === got && aclProblem([io.at(dest)]) === null; } catch { /* not there */ }
  if (same) return { ops: [], problems: [] };
  return { ops: [op(`write ${dest}   (root:wheel 0644, hash ${short(got)}…)`, () => { io.rm(dest); io.write(dest, text, 0o600); io.secureFile(dest, { uid: io.rootUid, gid: 0, mode: 0o644 }); })], problems: [] };
}

/** Read only → [{ ok, what, why? }]; needs root to look (the folder is orchestrate's 0700). */
export function checkWatchRules(io, cfg) {
  const f = watchRulesPath(cfg); const what = `${f} is root's 0644 copy of the rules, and hashes to the config's value`;
  if (!cfg.watch) return [{ ok: true, what: 'the watch-only week is not set up (no "watch" entry in the config)' }];
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: 'the folder is orchestrate-only; needs root to look; run with sudo' }];
  let st; try { st = io.lstat(f); } catch { return [{ ok: false, what, why: 'missing (run watch-rules --rules-source <file>)' }]; }
  const why = [];
  if (st.isSymbolicLink() || !st.isFile()) why.push('is not a plain file');
  else {
    if (st.uid !== io.rootUid) why.push(`owner is uid ${st.uid}, not root`);
    if ((st.mode & 0o7777) !== 0o644) why.push(`mode is ${(st.mode & 0o7777).toString(8)}, want 644`);
    const acl = aclProblem([io.at(f)]); if (acl) why.push(acl);
    let h = null; try { h = sha(io.readText(f)); } catch { why.push('could not be read'); }
    if (h !== null && h !== cfg.watch.rulesSha256) why.push(`hashes to ${short(h)}…, the config says ${short(cfg.watch.rulesSha256)}…`);
  }
  return [{ ok: why.length === 0, what, ...(why.length ? { why: why.join('; ') } : {}) }];
}
