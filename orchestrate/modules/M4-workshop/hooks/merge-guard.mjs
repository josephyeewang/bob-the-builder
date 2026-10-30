// The merge guard (design v4 §14.1.5). No role merges or pushes to main: only the Merge Gate does,
// as the robot. Blocks `gh pr merge`, `gh api …/merge(s)`, a push whose refspec lands on main (or
// master, or a mirror/all push), and any web call to GitHub's merge address.

import { pathToFileURL } from 'node:url';
import { runHook, block, pass, shellCommands, shellWords, programOf } from './lib.mjs';

const MAIN = /^(?:\+)?(?:[^:]*:)?(?:refs\/heads\/)?(main|master)$/;
const MERGE_URL = /(api\.)?github\.com\/.*\/(merges?|pulls\/\d+\/merge)(\b|$)|\/repos\/[^\s]+\/(merges?|pulls\/\d+\/merge)\b/i;

export function decide(input) {
  if (input.tool_name !== 'Bash') return pass();
  const cmd = String(input.tool_input?.command ?? '');
  if (MERGE_URL.test(cmd)) return block('the command reaches GitHub\'s merge address');
  for (const c of shellCommands(cmd)) {
    const prog = programOf(c);
    if (prog === 'gh') {
      const rest = c.slice(1);
      if (rest[0] === 'pr' && rest[1] === 'merge') return block('gh pr merge');
      if (rest[0] === 'api' && rest.some((w) => /\/merges?\b|\/merge$/.test(w))) return block('gh api …/merge');
    }
    if (prog === 'git') {
      const i = c.findIndex((w, k) => k > 0 && w === 'push');
      if (i > 0) {
        const pushArgs = c.slice(i + 1);
        if (pushArgs.some((w) => ['--mirror', '--all', '--delete', '-d'].includes(w))) return block('a mirror, all-branches or delete push');
        if (pushArgs.filter((w) => !w.startsWith('-')).some((w) => MAIN.test(w))) return block('a push to main');
      }
    }
  }
  // A merge address spelled across quoting or variables is still a GitHub merge call.
  if (shellWords(cmd).some((w) => MERGE_URL.test(w))) return block('the command reaches GitHub\'s merge address');
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
