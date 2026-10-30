// The merge guard (design v4 §14.1.5). No role merges or pushes to main: only the Merge Gate does,
// as the robot. Blocks `gh pr merge`, `gh api …/merge(s)`, every `git push` (the push script is the only
// route to GitHub), and any web call to GitHub's merge address.

import { isMain, runHook, block, pass, shellCommands, shellWords, programOf, joinLines, unreadable, namesGitInternals } from './lib.mjs';

// Git settings that turn a plain push into a push to main, or rename a command.
const PUSH_SETTINGS = /^(remote\..+\.(push|pushurl|url|mirror)|remote\.pushdefault|push\.default|alias\..+|core\.hookspath|url\..+\.(push)?insteadof|include\.path|includeif\..+)(=|$)/i;
const MERGE_URL = /(api\.)?github\.com\/.*\/(merges?|pulls\/\d+\/merge)(\b|$)|\/repos\/[^\s]+\/(merges?|pulls\/\d+\/merge)\b/i;

export function decide(input) {
  if (input.tool_name !== 'Bash') return pass();
  const cmd = joinLines(input.tool_input?.command);
  if (MERGE_URL.test(cmd)) return block('the command reaches GitHub\'s merge address');
  // Shapes no hook can read are refused as a class (lib.mjs `unreadable`; audit R-0b-44 round 2 MAT-1).
  const why = unreadable(cmd);
  if (why) return block(`${why}; write the command out plainly`);
  // git's settings by environment, or its own files, can turn a plain push into a push to main.
  if (shellWords(cmd).some((w) => /^GIT_CONFIG/i.test(w))) return block('git settings passed by environment');
  if (namesGitInternals(cmd)) return block('the command touches git\'s own settings or hooks files');
  const cmds = shellCommands(cmd);
  if (/graphql/i.test(cmd) && /merge/i.test(cmd)) return block('a GitHub query that merges');
  for (const c of cmds) {
    const prog = programOf(c);
    if (prog === 'gh') {
      const rest = c.slice(1);
      if (rest[0] === 'pr' && rest[1] === 'merge') return block('gh pr merge');
      if (rest[0] === 'alias') return block('gh alias (a renamed command can\'t be checked)');
      if (rest[0] === 'api' && rest.some((w) => /\/merges?\b|\/merge$/.test(w))) return block('gh api …/merge');
    }
    if (prog === 'git') {
      // `git -c key=value` and `git config key value` of a push, alias or hooks setting.
      if (c.some((w) => PUSH_SETTINGS.test(w))) return block('changing git\'s push, alias or hooks settings');
      // No role pushes: the push script is the only route to GitHub, so every push is refused, whatever
      // its refspec (`git switch -c main && git push origin HEAD` lands on main with none; audit R-0b-44 round 3 MIN-1).
      if (c.some((w, k) => k > 0 && (w === 'push' || w === 'send-pack'))) return block('a push (only the push script pushes)');
    }
  }
  // A merge address spelled across quoting or variables is still a GitHub merge call.
  if (shellWords(cmd).some((w) => MERGE_URL.test(w))) return block('the command reaches GitHub\'s merge address');
  return pass();
}

if (isMain(import.meta.url)) runHook(decide);
