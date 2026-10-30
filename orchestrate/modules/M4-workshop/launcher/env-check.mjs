// Launch checks 9 and 10 (R-0b-36).
//
// Check 9, the run-key wrapper (review 0b-3 M8): a role's environment is built from a short list
// of plain names, every variable on the refused list is stripped, and the launch refuses if any
// is still there afterwards (or if a GitHub or other service key slipped in). A role never holds
// a key: AI roles use Joe's signed-in Claude account only.
//
// Check 10: the machine-wide settings file carries the production-write guard as a blocking hook
// and no escape (excludedCommands, unsandboxed commands, allow or ask rules, extra hosts).

import { REFUSED_ENV, SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { checkSettings } from './render-settings.mjs';

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

/** Check 10. `readFile(path)` returns the text of the machine-wide settings file. */
export function checkMachineWide({ readFile, path, guardScript = 'production-write-guard.mjs' }) {
  let obj;
  try { obj = JSON.parse(readFile(path)); } catch { return refuse('machine-wide settings are missing or not JSON'); }
  const c = checkSettings(obj, { machineWide: true });
  if (!c.ok) return c;
  const pre = obj?.[S.hooks]?.[E.preToolUse];
  const has = Array.isArray(pre) && pre.some((m) => m?.[H.matcher] === '*' && Array.isArray(m?.[H.hooks])
    && m[H.hooks].some((h) => h?.[H.type] === 'command' && typeof h?.[H.command] === 'string' && h[H.command].includes(guardScript) && h?.[H.onFailure] === 'block'));
  if (!has) return refuse('the machine-wide production block is not in force');
  return { ok: true };
}
