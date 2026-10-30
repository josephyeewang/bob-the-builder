// The no-verify block (design v4 §14.1.5). A role never skips git's checks: no --no-verify, no
// `commit -n`, no switching the hooks folder off, no hook-skip variables.

import { pathToFileURL } from 'node:url';
import { runHook, block, pass, shellCommands, shellWords, programOf, wrapperOf, builtCommandName, hasExpansion } from './lib.mjs';

const SKIP_VARS = /(^|\s)(HUSKY|LEFTHOOK|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS)=/;

export function decide(input) {
  if (input.tool_name !== 'Bash') return pass();
  const cmd = String(input.tool_input?.command ?? '');
  if (/--no-verify\b/.test(cmd)) return block('--no-verify');
  if (/core\.hookspath/i.test(cmd)) return block('changing git\'s hooks folder');
  if (SKIP_VARS.test(cmd)) return block('a hook-skip variable');
  // The same checks on the words with quotes taken out (`--no-v""erify`), plus any shortened
  // form git would accept (`--no-veri`), and shapes no hook can read (audit R-0b-44 M-5).
  const words = shellWords(cmd);
  if (words.some((w) => w.length >= 5 && '--no-verify'.startsWith(w.split('=')[0]))) return block('--no-verify (or a shortened form)');
  if (words.some((w) => /core\.hookspath/i.test(w))) return block('changing git\'s hooks folder');
  if (words.some((w) => SKIP_VARS.test(` ${w}`))) return block('a hook-skip variable');
  const wrap = wrapperOf(cmd);
  if (wrap) return block(`"${wrap}" runs a string the guard can't check; run the command directly`);
  if (builtCommandName(cmd)) return block('a command name built from a variable or substitution can\'t be checked');
  if (hasExpansion(cmd) && shellCommands(cmd).some((c) => programOf(c) === 'git')) return block('a git command with a variable or substitution can\'t be checked; spell it out');
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
