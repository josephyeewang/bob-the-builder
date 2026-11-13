// Launch checks 9 and 10 (R-0b-36).
//
// Check 9, the run-key wrapper (review 0b-3 M8): a role's environment is built from a short list
// of plain names, every variable on the refused list is stripped, and the launch refuses if any
// is still there afterwards (or if a GitHub or other service key slipped in). A role never holds
// a key: AI roles use the owner's signed-in Claude account only.
//
// Check 10: the machine-wide settings file carries the production-write guard as a blocking hook
// and no escape (excludedCommands, unsandboxed commands, allow or ask rules, extra hosts), and so
// does every other managed settings source claude reads (MANAGED SOURCES below).

import { readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { REFUSED_ENV, SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { checkSettings } from './render-settings.mjs';
import { ACCOUNT_NAMES, accountDir } from './accounts.mjs';

const refuse = (reason) => ({ ok: false, reason });

// Plain variables a role may inherit. Everything else is dropped.
export const PASS_ENV = Object.freeze(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'TZ']);
// Names that look like a key for some service, on top of the refused list.
const KEYISH = /(^|_)(TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY)(_|$)|^(GH|GITHUB)_|^GIT_ASKPASS$|^SSH_AUTH_SOCK$/;

export function roleEnv(base, { path, extra = {} } = {}) {
  const env = {};
  for (const k of PASS_ENV) if (typeof base[k] === 'string') env[k] = base[k];
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  if (path) env.PATH = path;
  for (const k of REFUSED_ENV) delete env[k];
  return env;
}

export function checkRoleEnv(env) {
  const left = REFUSED_ENV.filter((k) => Object.hasOwn(env, k));
  if (left.length) return refuse(`refused variables in the role's environment: ${left.join(', ')}`);
  const keyish = Object.keys(env).filter((k) => KEYISH.test(k));
  if (keyish.length) return refuse(`key-like variables in the role's environment: ${keyish.join(', ')}`);
  return { ok: true };
}

// MANAGED SOURCES: the managed (policy) settings sources check 10 reads, as claude reads them.
//
// CAPABILITY NOTE, checked on claude 2.1.322 (its bundled code) and again in 2.1.316's, the pin, 13 Nov 2026: the same
// sources, the two plist paths in the same order, both overrides built out (checked: claude-code 2.1.316; MANAGED_SOURCES_CHECKED_ON below
// is code, its owner's to move). RECHECK ON EVERY UPGRADE of the pin.
// A source a newer claude adds, moves or reorders gets past check 10 until this list follows it.
// This build has two overrides built out, which a newer one may build in: CLAUDE_CODE_MANAGED_SETTINGS_PATH
// (another managed file) and CLAUDE_CODE_REMOTE_SETTINGS_PATH (another remote cache). Its storage backend
// for the remote cache is stubbed out (uCo() returns undefined; CLAUDE_CODE_HOVER_REST pins it), so the
// cache is the file below only; on an upgrade, look for the cache moving into that storage.
// Sources, highest precedence first. By default ONLY the highest tier with content applies, and the
// ones beneath it are not read for policy at all (unless a source sets managedSourcesBehavior "merge").
// So a remote cache or managed preferences with content displaces managed-settings.json and its guard
// hook, which is why each must carry the guard itself, not only hold no escape. A source that is a
// plain object with no keys ({}) is none, for claude and here alike (claude writes {} as its remote
// cache when the server has no settings for the account); the fixed main file is not a source
// that may be empty: it is the one that must carry the guard.
//   helper  a policyHelper or policyHelpers key in a managed source runs a program whose output is policy.
//           Check 10 can't judge that output ahead of time: any source holding either key refuses.
//   remote  server-managed settings, fetched at start for a signed-in organization that has some, and
//           cached at <config home>/remote-settings.json. The config home is CLAUDE_CONFIG_DIR, else
//           $HOME/.claude; a review session sets CLAUDE_CONFIG_DIR only for the second account
//           (accounts.mjs accountEnv). So reviewChecks has check 10 read the cache in the session's own
//           config home, from the session's own environment (configDirs: its CLAUDE_CONFIG_DIR, else its
//           HOME's .claude); called without configDirs, check 10 reads every account folder (ACCOUNTS:
//           .claude, .claude-b) under home(), $HOME by default. The CLAUDE_CODE_REMOTE_SETTINGS_PATH override is not in this
//           build. A readable cache must pass; an unreadable or non-JSON one refuses.
//           KNOWN GAP: a missing cache passes. Settings the server sends at start are never seen by
//           check 10, and since only the highest source applies, they would also displace the guard
//           hook. Only an organization admin on the service's side can set them (no worker can); the
//           owner confirms the account has none (a check on the machine, not here).
//   plist   MDM: /Library/Managed Preferences/<user>/com.anthropic.claudecode.plist, then
//           /Library/Managed Preferences/com.anthropic.claudecode.plist, converted with
//           /usr/bin/plutil -convert json -o - --. Each one present must pass; one that can't be read refuses.
//   file    /Library/Application Support/ClaudeCode/managed-settings.json (CLAUDE_FILE), the only main
//           managed-settings file this build reads (its override is built out, above). The config's machineWide must name it:
//           any other path refuses, since its guard would never apply (L909). It must be there and carry the
//           guard; missing or {} refuses. Then
//           every managed-settings.d/ entry beside it that is a file or a link named *.json, not starting
//           with a dot, read in name order. The drop-ins merge into this same tier, so they can't displace
//           the guard, only add an escape; requiring the guard in each as well is stricter than needed, and
//           kept on purpose. A linked drop-in refuses: the launcher reads every source without following a link.
//   parent  --managed-settings <json>, or CLAUDE_CODE_MANAGED_SETTINGS_PATH: the launcher passes neither
//           (pinned by review-launch.test.mjs).
export const MANAGED_SOURCES_CHECKED_ON = '2.1.322';
export const MANAGED_PREFS = Object.freeze({ dir: '/Library/Managed Preferences', name: 'com.anthropic.claudecode.plist' });
export const DROP_INS = 'managed-settings.d';
export const REMOTE_CACHE = 'remote-settings.json';
export const CLAUDE_FILE = '/Library/Application Support/ClaudeCode/managed-settings.json';
const HELPER_KEYS = Object.freeze(['policyHelper', 'policyHelpers']);
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

// The names in a drop-in folder that claude reads, in its order. Throws when the folder can't be listed.
export function listDropIns(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.json') && !e.name.startsWith('.'))
    .map((e) => e.name).sort();
}

// A managed preferences file as JSON text, or null when there is none. Throws when one is there and can't be read.
export function readPlist(p) {
  try { lstatSync(p); } catch (e) { if (ABSENT.has(e?.code)) return null; throw e; }
  return execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', p],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The readers check 10 uses for the sources beyond the main file, and claudeFile, the one path machineWide must
// name, as live code runs it. A test passes fakes
// (review-launch's reviewChecks takes them as x.managedReaders); nothing else does.
export const MANAGED_READERS = Object.freeze({ listDir: listDropIns, plist: readPlist, user: () => userInfo().username,
  home: () => process.env.HOME, claudeFile: CLAUDE_FILE });

const guardIn = (obj, guardScript) => {
  const pre = obj?.[S.hooks]?.[E.preToolUse];
  return Array.isArray(pre) && pre.some((m) => m?.[H.matcher] === '*' && Array.isArray(m?.[H.hooks])
    && m[H.hooks].some((h) => h?.[H.type] === 'command' && typeof h?.[H.command] === 'string' && h[H.command].includes(guardScript) && h?.[H.onFailure] === 'block'));
};

// One source's settings → null when it passes, else a refusal. `label` names the source in every reason but the main file's.
function sourceProblem(obj, label, guardScript) {
  const tail = label ? ` (in ${label})` : '';
  // {} is no source at all, as claude reads it (L906 M1); never the fixed main file (label '').
  if (label && obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0) return null;
  if (obj && typeof obj === 'object' && HELPER_KEYS.some((k) => Object.hasOwn(obj, k))) return refuse(`machine-wide settings name a policy helper, whose output check 10 can't judge${tail}`);
  const c = checkSettings(obj, { machineWide: true });
  if (!c.ok) return refuse(`${c.reason}${tail}`);
  if (!guardIn(obj, guardScript)) return refuse(`the machine-wide production block is not in force${tail}`);
  return null;
}

/**
 * Check 10. `readFile(path)` returns the text of the machine-wide settings file, and of its drop-ins and the remote
 * cache (it throws with code ENOENT or ENOTDIR for one that isn't there). The other readers default to the real ones.
 * `path` must equal `claudeFile` (CLAUDE_FILE live); any other refuses before anything is read (L909).
 */
export function checkMachineWide({ readFile, path, guardScript = 'production-write-guard.mjs',
  listDir = MANAGED_READERS.listDir, plist = MANAGED_READERS.plist, user = MANAGED_READERS.user, home = MANAGED_READERS.home,
  claudeFile = MANAGED_READERS.claudeFile, configDirs }) {
  // Claude reads only its fixed file (L909): a guard in any other file would never apply. Nothing is read first.
  if (path !== claudeFile) return refuse(`machine-wide settings must be ${claudeFile}, not ${path}: claude ${MANAGED_SOURCES_CHECKED_ON} reads only that file`);
  let obj;
  try { obj = JSON.parse(readFile(path)); } catch { return refuse('machine-wide settings are missing or not JSON'); }
  const main = sourceProblem(obj, '', guardScript);
  if (main) return main;
  const dropIns = dropInsProblem(path, { readFile, listDir, guardScript });
  if (dropIns) return dropIns;

  let who; try { who = user(); } catch {}
  if (typeof who !== 'string' || !who || who.includes('/')) return refuse('the user\'s managed preferences can\'t be named (no user name)');
  for (const p of [join(MANAGED_PREFS.dir, who, MANAGED_PREFS.name), join(MANAGED_PREFS.dir, MANAGED_PREFS.name)]) {
    let text; try { text = plist(p); } catch (e) { return refuse(`the managed preferences ${p} can't be read (${e?.code ?? e?.message})`); }
    if (text === null) continue;
    let d; try { d = JSON.parse(text); } catch { return refuse(`the managed preferences ${p} are not JSON once converted`); }
    const bad = sourceProblem(d, p, guardScript);
    if (bad) return bad;
  }

  // The config homes whose remote cache claude reads: the session's own when the caller names it (L913 m1),
  // else every account folder under home.
  let dirs;
  if (configDirs) { try { dirs = configDirs(); } catch {} }
  else { const h = home(); if (typeof h === 'string' && h.startsWith('/')) dirs = ACCOUNT_NAMES.map((n) => accountDir(h, n)); }
  if (!Array.isArray(dirs) || !dirs.length || !dirs.every((d) => typeof d === 'string' && d.startsWith('/'))) return refuse('the remote settings cache can\'t be found (no home folder)');
  for (const cache of dirs.map((d) => join(d, REMOTE_CACHE))) {
    let text = null;
    try { text = readFile(cache); } catch (e) { if (!ABSENT.has(e?.code)) return refuse(`the remote settings cache ${cache} can't be read (${e?.code ?? e?.message})`); }
    if (text === null) continue;
    let d; try { d = JSON.parse(text); } catch { return refuse(`the remote settings cache ${cache} is not JSON`); }
    const bad = sourceProblem(d, cache, guardScript);
    if (bad) return bad;
  }
  return { ok: true };
}

// The drop-ins beside one managed settings file → null when each passes (or there are none), else a refusal.
function dropInsProblem(file, { readFile, listDir, guardScript }) {
  const dir = join(dirname(file), DROP_INS);
  let names = [];
  try { names = listDir(dir); } catch (e) { if (!ABSENT.has(e?.code)) return refuse(`the machine-wide drop-in folder ${dir} can't be listed (${e?.code ?? e?.message})`); }
  for (const n of names) {
    const p = join(dir, n);
    let d; try { d = JSON.parse(readFile(p)); } catch (e) { return refuse(`the machine-wide drop-in ${p} is unreadable or not JSON (${e?.code ?? e?.message})`); }
    const bad = sourceProblem(d, p, guardScript);
    if (bad) return bad;
  }
  return null;
}
