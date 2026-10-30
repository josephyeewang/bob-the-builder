// The no-verify block (design v4 §14.1.5). A role never skips git's checks: no --no-verify, no
// `commit -n`, no switching the hooks folder off, no hook-skip variables.

import { pathToFileURL } from 'node:url';
import { runHook, block, pass, shellCommands, programOf } from './lib.mjs';

const SKIP_VARS = /(^|\s)(HUSKY|LEFTHOOK|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS)=/;

export function decide(input) {
  if (input.tool_name !== 'Bash') return pass();
  const cmd = String(input.tool_input?.command ?? '');
  if (/--no-verify\b/.test(cmd)) return block('--no-verify');
  if (/core\.hookspath/i.test(cmd)) return block('changing git\'s hooks folder');
  if (SKIP_VARS.test(cmd)) return block('a hook-skip variable');
  for (const c of shellCommands(cmd)) {
    if (programOf(c) !== 'git') continue;
    const sub = c.findIndex((w, k) => k > 0 && ['commit', 'merge', 'push', 'am', 'rebase'].includes(w));
    if (sub < 0) continue;
    // -n is --no-verify for commit, merge and push; it can sit in a bundle like -nm.
    if (c.slice(sub + 1).some((w) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) && !w.startsWith('--'))) return block('git -n (skips checks)');
  }
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
