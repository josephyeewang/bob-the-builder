// R-0b-179 (b), L1148 F6: no module puts a credential on a command line (credential-args.mjs says why and what it reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialArgFindings } from './credential-args.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (statSync(f).isDirectory()) sources(f, out);
    else if (n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !n.endsWith('.test-helper.mjs')) out.push(f);
  }
  return out;
}
const said = (src) => credentialArgFindings(src).map((x) => `${x.kind}:${x.what}`);

/**
 * What the scan lists rather than reads to its end (#556 r1-r3), each looked at by hand. Since r3 the scan fails closed:
 * a list, a word or a command string it can not follow to literals, names that say what they are, or a value this
 * module gives is listed here, never passed. A new one fails the test below until it is looked at and added with the true
 * reason it is safe; one no longer met fails it too. Three reasons cover many entries, each checked once:
 */
// setup/layout.mjs parseConfig rebuilds the setup config from base, owner, products, proposalsParent, the host.lock paths
// and watch (repo, rulesSha256, app: id, installation and keyFile, a bare file name): no field can hold a credential.
const SETUP_CFG = 'the setup config: paths, user and product names, labels; parseConfig keeps no field that could hold a credential';
// setup's io: run, lstat, uid, readConfig, readSource. No setup step reads a key: the keys folder is only made and
// checked (lstat), and the watcher App's token is minted by its own job from the key file, whose path is all setup passes.
const SETUP_IO = "setup's ports: what they return is a uid, a path, a job file's text or a command's answer; setup reads no key";
// A parameter written as { a, b }: the scan does not follow a property of a caller's object (a known limit).
const DESTRUCTURED = "a destructured parameter: a path, a 40-hex commit id or a ref name its callers pass, checked where it is used";
const REVIEWED_UNREAD = {
  "modules/M11-dispatcher/cleanup.mjs mirrorTree's sha reaches a program's words, and mirrorTree is called from other modules": "mirrorTree(git, mirror, sha): git ls-tree on a commit id; its callers pass a card's recorded commit",
  "modules/M11-dispatcher/cleanup.mjs stage's card reaches a program's words, and stage is called from other modules": "stage(rec, card) reads the record to name a stage ('keep', 'check', …); its words are a card id and the record's own commit ids",
  "modules/M11-dispatcher/cleanup.mjs stage's rec reaches a program's words, and stage is called from other modules": "stage(rec, card) reads the record to name a stage ('keep', 'check', …); its words are a card id and the record's own commit ids",
  "modules/M11-dispatcher/cleanup.mjs stage(…, rec): rec is given no value here that is read": DESTRUCTURED,
  "modules/M11-dispatcher/sync-limit.mjs run passes its list on, and is not called here (it may be handed on as a value)": "limitedSync returns run as a port: the wiring that holds it passes fixed git, launchctl and gh words (the gh token goes by environment, never a word)",
  "modules/M11-dispatcher/sync-limit.mjs run passes its words on, and is not called here (it may be handed on as a value)": "limitedSync returns run as a port: the wiring that holds it passes fixed git, launchctl and gh words (the gh token goes by environment, never a word)",
  "modules/M12-sensors/history.mjs runner(…, ['--literal-pathspecs', ...args]): a parameter of an unnamed function": "makeGit's git takes an argument list from the history reader: git log words, commit ids and paths",
  "modules/M12-sensors/probes/launchd.mjs runLaunchctl's args reaches a program's words, and runLaunchctl is called from other modules": "exported, but its only use is launchdProbe's default runner, which passes ['print', <domain>/<label>], both checked against fixed patterns",
  "modules/M12-sensors/screen/tools/capture.mjs keys's k reaches a program's words, and keys is called from other modules": "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it",
  "modules/M12-sensors/screen/tools/capture.mjs makeTmux's server reaches a program's words, and makeTmux is called from other modules": "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it",
  "modules/M12-sensors/screen/tools/capture.mjs run(…, ...args)": "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it",
  "modules/M12-sensors/screen/tools/capture.mjs runScenario's s reaches a program's words, and runScenario is called from other modules": "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it",
  "modules/M12-sensors/screen/tools/capture.mjs screen's colour reaches a program's words, and screen is called from other modules": "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it",
  "modules/M12-sensors/screen/tools/capture.mjs text's t reaches a program's words, and text is called from other modules": "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it",
  "modules/M12-sensors/shell-guard/runner.mjs askHook's hookCommand reaches a program's words, and askHook is called from other modules": "the hook command from the role's settings file (a path and its fixed words); the command under test goes on stdin",
  "modules/M12-sensors/shell-guard/selfcheck.mjs runShell's args reaches a program's words, and runShell is called from other modules": "runShell's one caller passes a shell from the fixed list and -c with a case's command from the guard's own case table",
  "modules/M12-sensors/shell-guard/selfcheck.mjs runShell's sh reaches a program's words, and runShell is called from other modules": "runShell's one caller passes a shell from the fixed list and -c with a case's command from the guard's own case table",
  "modules/M12-sensors/shell-guard/selfcheck.mjs runShell(…, sh): sh is given no value here that is read": "sh is each of touchCheck's shells: /bin/bash unless its caller names others (shell paths)",
  "modules/M12-sensors/shell-guard/selfcheck.mjs spawnSync(…, argv[1])": "runShell builds argv as [perl, ['-e', GROUP, sh, ...args]] or [sh, args]; its one caller passes -c and a case's command from the guard's own case table",
  "modules/M4-workshop/git/gitleaks.mjs run(…, ['git', mirror, '--log-opts', logOpts, ...common(setup, repo): mirror is given no value here that is read": DESTRUCTURED,
  "modules/M4-workshop/git/gitleaks.mjs run(…, bin): bin is given no value here that is read": DESTRUCTURED,
  "modules/M4-workshop/git/push.mjs newCommits(…, ['refs/heads/main', ...(remoteTip && remoteTip !== tip && !r): passed on through more than 4 helpers": "commit ids and ref names (refs/heads/main, the card branch), read from git itself, through more helpers than the scan follows",
  "modules/M4-workshop/git/push.mjs newCommits(…, tip): passed on through more than 4 helpers": "commit ids and ref names (refs/heads/main, the card branch), read from git itself, through more helpers than the scan follows",
  "modules/M4-workshop/git/push.mjs pushResearch passes its words on, and is not called here (it may be handed on as a value)": "pushResearch's words are the research ask's card, attempt and report path, checked against the id patterns; it is handed to the script as a value",
  "modules/M4-workshop/git/push.mjs run(…, ['check-ref-format', '--branch', branch]): a parameter of an unnamed function": "a branch name, checked by git check-ref-format itself",
  "modules/M4-workshop/git/safe-git.mjs withNoPrograms's args reaches a program's words, and withNoPrograms is called from other modules": "withNoPrograms adds only the fixed NO_PROGRAMS flags to the list it is given; its callers' lists are read where they call it",
  "modules/M4-workshop/launcher/accounts.mjs claudeAuthStatus's claudeBin reaches a program's words, and claudeAuthStatus is called from other modules": "claudeBin is the pinned Claude Code program's path; the account goes by environment (CLAUDE_CONFIG_DIR), not a word",
  "modules/M4-workshop/launcher/env-check.mjs readPlist's p reaches a program's words, and readPlist is called from other modules": "p is a job file's path (plutil -convert json -- <path>)",
  "modules/M4-workshop/launcher/hooks-check.mjs run(…, [script, ...argv])": "argv is the hook command's own words from the role settings file, and the script is checked to be the hooks folder's",
  "modules/M4-workshop/launcher/hooks-check.mjs run(…, claudeBin): claudeBin is given no value here that is read": "claudeBin is the pinned Claude Code program's path; the account goes by environment (CLAUDE_CONFIG_DIR), not a word",
  "modules/M4-workshop/launcher/install-check.mjs aclProblem's paths reaches a program's words, and aclProblem is called from other modules": "paths are install paths whose access lists are read (ls -led -- <paths>)",
  "modules/M4-workshop/launcher/install-check.mjs currentCopy's installRoot reaches a program's words, and currentCopy is called from other modules": "installRoot and p are install paths (the copy's link and the folders under it)",
  "modules/M4-workshop/launcher/install-check.mjs currentCopy(…, installRoot): passed on through more than 4 helpers": "installRoot and p are install paths (the copy's link and the folders under it)",
  "modules/M4-workshop/launcher/install-check.mjs oldInstall's installRoot reaches a program's words, and oldInstall is called from other modules": "installRoot and p are install paths (the copy's link and the folders under it)",
  "modules/M4-workshop/launcher/install-check.mjs shellQuote's p reaches a program's words, and shellQuote is called from other modules": "installRoot and p are install paths (the copy's link and the folders under it)",
  "modules/M4-workshop/launcher/review-launch.mjs launchReview's x reaches a program's words, and launchReview is called from other modules": "Claude Code's path, its fixed flags, a settings file's path and the session prompt (the card's brief); the account and any key go by environment",
  "modules/M4-workshop/launcher/review-launch.mjs reviewChecks's x reaches a program's words, and reviewChecks is called from other modules": "Claude Code's path, its fixed flags, a settings file's path and the session prompt (the card's brief); the account and any key go by environment",
  "modules/M4-workshop/launcher/review-launch.mjs runProbe(…, lr.args)": "Claude Code's path, its fixed flags, a settings file's path and the session prompt (the card's brief); the account and any key go by environment",
  "modules/M4-workshop/launcher/review-launch.mjs spawnClaude's args reaches a program's words, and spawnClaude is called from other modules": "Claude Code's path, its fixed flags, a settings file's path and the session prompt (the card's brief); the account and any key go by environment",
  "modules/M4-workshop/launcher/review-launch.mjs spawnClaude's bin reaches a program's words, and spawnClaude is called from other modules": "Claude Code's path, its fixed flags, a settings file's path and the session prompt (the card's brief); the account and any key go by environment",
  "modules/M4-workshop/launcher/review-runner-main.mjs currentHead's card reaches a program's words, and currentHead is called from other modules": "a card id (checked against its pattern) and a 40-hex commit id, in git rev-parse words",
  "modules/M4-workshop/launcher/review-runner-main.mjs gitOk(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): mirror is given no value here that is read": DESTRUCTURED,
  "modules/M4-workshop/launcher/review-runner-main.mjs gitOk(…, ['init', '-q', '--initial-branch=review-copy-unborn', dest]): dest is given no value here that is read": DESTRUCTURED,
  "modules/M4-workshop/launcher/review-runner-main.mjs main's argv reaches a program's words, and main is called from other modules": "the review runner's config: paths, uids, names and the rules' file paths (it has no credential field); argv[0] is that config's path",
  "modules/M4-workshop/launcher/review-runner-main.mjs realPorts's c reaches a program's words, and realPorts is called from other modules": "the review runner's config: paths, uids, names and the rules' file paths (it has no credential field); argv[0] is that config's path",
  "modules/M4-workshop/launcher/review-runner-main.mjs start's x reaches a program's words, and start is called from other modules": "the review runner's config: paths, uids, names and the rules' file paths (it has no credential field); argv[0] is that config's path",
  "modules/M4-workshop/launcher/review-runner-main.mjs treeOf's head reaches a program's words, and treeOf is called from other modules": "a card id (checked against its pattern) and a 40-hex commit id, in git rev-parse words",
  "modules/M4-workshop/launcher/review-updater.mjs git(…, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...OUTS)": "OUTSIDE_FILES is an imported constant of file paths",
  "modules/M4-workshop/launcher/review-updater.mjs updateOnce's c reaches a program's words, and updateOnce is called from other modules": "the updater's config: paths and an https address whose host part holds no user or password (HTTPS pattern)",
  "modules/M4-workshop/launcher/worker-copy.mjs gitOk(…, ['init', '-q', dest]): dest is given no value here that is read": DESTRUCTURED,
  "modules/M4-workshop/send-safe/guard.mjs send's text reaches a program's words, and send is called from other modules": "text is a message typed into a session (tmux send-keys -l): the Dispatcher's own words to a session, which reads them anyway; never a credential",
  "modules/M5-review-audit/findings.mjs at(…, head): head is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/findings.mjs gitOk(…, ['merge-base', 'refs/heads/main', head]): head is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs git(…, ['merge-base', '--is-ancestor', since, head]): head is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs git(…, ['merge-base', '--is-ancestor', since, head]): since is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs gitOk(…, ['diff', ...DIFF_FLAGS, base, head]): head is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs gitOk(…, ['diff', '--name-status', '-z', '--no-renames', '--ignore-su): head is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs gitOk(…, ['merge-base', 'refs/heads/main', head]): head is given no value here that is read": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs gitOk(…, ['merge-base', 'refs/heads/main', since]): since is given no value here that is read": DESTRUCTURED,
  "setup/bob-manifest.mjs bobGit's cfg reaches a program's words, and bobGit is called from other modules": SETUP_CFG,
  "setup/bob-manifest.mjs bobGit's from reaches a program's words, and bobGit is called from other modules": "argv is sudo's flags, ENV, GIT_ENV (PATH, LC_ALL, GIT_TERMINAL_PROMPT, GIT_CONFIG_NOSYSTEM; no token), git -C <Bob's folder> and the command; input is object ids on stdin",
  "setup/bob-manifest.mjs run(…, argv): a parameter of an unnamed function": "argv is sudo's flags, ENV, GIT_ENV (PATH, LC_ALL, GIT_TERMINAL_PROMPT, GIT_CONFIG_NOSYSTEM; no token), git -C <Bob's folder> and the command; input is object ids on stdin",
  "setup/builder-wall.mjs otherAddresses's ifaces reaches a program's words, and otherAddresses is called from other modules": "this Mac's own non-loopback address, an IP address, for the listener and client probes",
  "setup/builder-wall.mjs planWall's cfg reaches a program's words, and planWall is called from other modules": SETUP_CFG,
  "setup/builder-wall.mjs planWall's io reaches a program's words, and planWall is called from other modules": SETUP_IO,
  "setup/builder-wall.mjs trafficChecks's net reaches a program's words, and trafficChecks is called from other modules": "this Mac's own non-loopback address, an IP address, for the listener and client probes",
  "setup/builder-wall.mjs wayOut's cfg reaches a program's words, and wayOut is called from other modules": SETUP_CFG,
  "setup/builder-wall.mjs wayOut's io reaches a program's words, and wayOut is called from other modules": SETUP_IO,
  "setup/builder-wall.mjs words's p reaches a program's words, and words is called from other modules": "a pf rule's words: the builder user's name or uid and a protocol (tcp, udp)",
  "setup/builder-wall.mjs words's u reaches a program's words, and words is called from other modules": "a pf rule's words: the builder user's name or uid and a protocol (tcp, udp)",
  "setup/daemons.mjs placeSteps's jobs reaches a program's words, and placeSteps is called from other modules": "jobs are job names from jobsFor (fixed labels)",
  "setup/daemons.mjs planLoad's cfg reaches a program's words, and planLoad is called from other modules": SETUP_CFG,
  "setup/daemons.mjs planLoad's io reaches a program's words, and planLoad is called from other modules": SETUP_IO,
  "setup/daemons.mjs planReloadAccount's cfg reaches a program's words, and planReloadAccount is called from other modules": SETUP_CFG,
  "setup/daemons.mjs planReloadAccount's io reaches a program's words, and planReloadAccount is called from other modules": SETUP_IO,
  "setup/daemons.mjs planUnload's cfg reaches a program's words, and planUnload is called from other modules": SETUP_CFG,
  "setup/extras.mjs planProposals's cfg reaches a program's words, and planProposals is called from other modules": SETUP_CFG,
  "setup/extras.mjs planProposals's io reaches a program's words, and planProposals is called from other modules": SETUP_IO,
  "setup/extras.mjs planSafeDirectory's cfg reaches a program's words, and planSafeDirectory is called from other modules": SETUP_CFG,
  "setup/install.mjs spawnSync(…, c.args)": "updaterCommand writes the list out: the script, the config, --first and the seed, all paths",
  "setup/install.mjs spawnUpdater's io reaches a program's words, and spawnUpdater is called from other modules": SETUP_IO,
  "setup/install.mjs spawnUpdater's spec reaches a program's words, and spawnUpdater is called from other modules": "updaterCommand writes the list out: the script, the config, --first and the seed, all paths",
  "setup/managed-settings.mjs planManagedSettings's cfg reaches a program's words, and planManagedSettings is called from other modules": SETUP_CFG,
  "setup/owner-answer-setup.mjs checkOwnerJob's cfg reaches a program's words, and checkOwnerJob is called from other modules": SETUP_CFG,
  "setup/owner-answer-setup.mjs ownerJobState's cfg reaches a program's words, and ownerJobState is called from other modules": SETUP_CFG,
  "setup/owner-answer-setup.mjs planOwnerLoad's cfg reaches a program's words, and planOwnerLoad is called from other modules": SETUP_CFG,
  "setup/owner-answer-setup.mjs planOwnerLoad's io reaches a program's words, and planOwnerLoad is called from other modules": SETUP_IO,
  "setup/owner-answer-setup.mjs planOwnerPlace's cfg reaches a program's words, and planOwnerPlace is called from other modules": SETUP_CFG,
  "setup/owner-answer-setup.mjs planOwnerUnload's cfg reaches a program's words, and planOwnerUnload is called from other modules": SETUP_CFG,
  "setup/proofs.mjs proveList's list reaches a program's words, and proveList is called from other modules": "pr comes from proofList, whose args: [...] lists (ls, test -w/-x, head -c 1, true, on paths) the scan reads as lists",
  "setup/proofs.mjs run(…, ['-n', '-H', '-u', BUILDER, ...pr.args])": "pr comes from proofList, whose args: [...] lists (ls, test -w/-x, head -c 1, true, on paths) the scan reads as lists",
  "setup/proofs.mjs runProofs's cfg reaches a program's words, and runProofs is called from other modules": SETUP_CFG,
  "setup/proofs.mjs runProofs's io reaches a program's words, and runProofs is called from other modules": SETUP_IO,
  "setup/users-folders.mjs aclEntries's io reaches a program's words, and aclEntries is called from other modules": SETUP_IO,
  "setup/users-folders.mjs check's io reaches a program's words, and check is called from other modules": SETUP_IO,
  "setup/users-folders.mjs folderChecks's io reaches a program's words, and folderChecks is called from other modules": SETUP_IO,
  "setup/users-folders.mjs plan's cfg reaches a program's words, and plan is called from other modules": SETUP_CFG,
  "setup/users-folders.mjs plan's io reaches a program's words, and plan is called from other modules": SETUP_IO,
  "setup/users-folders.mjs planFolders's io reaches a program's words, and planFolders is called from other modules": SETUP_IO,
  "setup/users-folders.mjs planFolders's rows reaches a program's words, and planFolders is called from other modules": "rows are folderTable(cfg): paths, owners and modes",
  "setup/users-folders.mjs planUsers's cfg reaches a program's words, and planUsers is called from other modules": SETUP_CFG,
  "setup/users-folders.mjs planUsers's io reaches a program's words, and planUsers is called from other modules": SETUP_IO,
  "setup/users-folders.mjs planUsers(…, cfg): passed on through more than 4 helpers": SETUP_CFG,
  "setup/users-folders.mjs planUsers(…, io): passed on through more than 4 helpers": SETUP_IO,
  "setup/users-folders.mjs readUser's io reaches a program's words, and readUser is called from other modules": SETUP_IO,
  "setup/watch-setup.mjs proveWatchAppChecks's cfg reaches a program's words, and proveWatchAppChecks is called from other modules": SETUP_CFG,
  "setup/watch-setup.mjs proveWatchAppChecks's on reaches a program's words, and proveWatchAppChecks is called from other modules": "on is a pull request's number and 40-hex head; the job mints the App's token itself from the key file, whose path is the only key word passed",
  "setup/watch-setup.mjs watchPlist's cfg reaches a program's words, and watchPlist is called from other modules": SETUP_CFG,
  "wiring/owner-answer.mjs claudeUsage's claudeBin reaches a program's words, and claudeUsage is called from other modules": "claudeBin is the Claude Code program's path; the account goes by environment, not a word",
  "wiring/review-ports.mjs git(…, withNoPrograms(['diff-tree', '-r', '-z', '--name-only', '--n)": "the list is written out inside withNoPrograms, which only adds the fixed NO_PROGRAMS flags; sha is checked to be a commit id",
  "wiring/review-ports.mjs git(…, withNoPrograms(['diff-tree', '-r', '-z', '--name-only', '--n): a parameter of an unnamed function": "the list is written out inside withNoPrograms, which only adds the fixed NO_PROGRAMS flags; sha is checked to be a commit id",
  "wiring/review-ports.mjs run(…, ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), )": "env -i K=V: both callers pass safeGitEnv() with no extraConfig, so only fixed PATH, HOME, LANG and the fixed safe settings; a token could come only through extraConfig, and none is passed (#556 r2 m6)",
  "wiring/runner-locked.mjs runToEnd's args reaches a program's words, and runToEnd is called from other modules": "Claude Code's path and its fixed flags, a settings file's path and the session prompt (the card's brief, last); the account and any key go by environment",
  "wiring/runner-locked.mjs runToEnd's bin reaches a program's words, and runToEnd is called from other modules": "Claude Code's path and its fixed flags, a settings file's path and the session prompt (the card's brief, last); the account and any key go by environment",
  "wiring/runner-locked.mjs runToEnd(…, args)": "Claude Code's path and its fixed flags, a settings file's path and the session prompt (the card's brief, last); the account and any key go by environment",
  "wiring/runner-ports.mjs chmodTree's d reaches a program's words, and chmodTree is called from other modules": "d is a folder being removed (chmod -R -P u+rwx <folder>)",
  "wiring/runner-ports.mjs run(…, ['cat-file', '-t', commit]): a parameter of an unnamed function": "a commit id from the session record, checked against its pattern",
  "wiring/runner-ports.mjs run(…, ['merge-base', '--is-ancestor', commit, head]): head is given no value here that is read": DESTRUCTURED,
  "wiring/runner-ports.mjs startPort's c reaches a program's words, and startPort is called from other modules": "the worker's start: the runner's config (paths, uids, names) and the session prompt, the card's brief; the account goes by environment",
  "wiring/runner-ports.mjs workerPromptText's x reaches a program's words, and workerPromptText is called from other modules": "the worker's start: the runner's config (paths, uids, names) and the session prompt, the card's brief; the account goes by environment",
};
/** Findings looked at and not a credential: what the scan took for one, and why it is not. */
const REVIEWED_FOUND = {
  'setup/users-folders.mjs value key': "census's read(path, key): key is a dscl attribute name, 'UniqueID' or 'PrimaryGroupID' at its one caller",
  'modules/M4-workshop/git/push.mjs value auth': "remoteTip is a commit id parsed from git ls-remote's answer; auth is that call's options (the token goes by GIT_CONFIG_* environment through extraConfig), not a word",
};

test('R-0b-179 (b): no module outside the tests puts a credential on a command line, and every list the scan can not read has been looked at', () => {
  const files = sources(ROOT);
  assert.ok(files.length > 100, `only ${files.length} modules were found to read`);
  const found = []; const unread = []; const seenFound = [];
  for (const f of files) {
    for (const x of credentialArgFindings(readFileSync(f, 'utf8'))) {
      if (x.kind === 'unread') unread.push(`${relative(ROOT, f)} ${x.what}`);
      else if (!REVIEWED_FOUND[`${relative(ROOT, f)} ${x.kind} ${x.what}`]) found.push(`${relative(ROOT, f)}:${x.line} ${x.kind} ${x.what}: ${x.list}`);
      else seenFound.push(`${relative(ROOT, f)} ${x.kind} ${x.what}`);
    }
  }
  assert.deepEqual(found, [], `pass a credential in the child's environment, a file it reads, or its stdin, never its arguments:\n${found.join('\n')}`);
  assert.deepEqual(unread.filter((u) => !REVIEWED_UNREAD[u]), [], 'a spawn call whose list the scan can not read: look at what reaches it, then add it to REVIEWED_UNREAD with why it is safe');
  assert.deepEqual(Object.keys(REVIEWED_UNREAD).filter((u) => !unread.includes(u)), [], 'a reviewed entry no longer met: take it out');
  assert.deepEqual(Object.keys(REVIEWED_FOUND).filter((u) => !seenFound.includes(u)), [], 'a reviewed finding no longer met: take it out');
});

test('R-0b-179 (b): a planted credential flag, value, header or URL is caught, however the argument list is written', () => {
  const caught = {
    "spawnSync('/usr/bin/gh', ['api', '--token', t]);": 'flag:--token',
    'spawn(bin, [`--password=${pw}`]);': 'flag:--password',
    "const args = ['--api-key', key];\nspawn(bin, args);": 'flag:--api-key',
    "execFileSync(node, ['run.mjs', token]);": 'value:token',
    "io.run('/bin/x', ['--repo', cfg.watch.repo, cfg.watch.token]);": 'value:cfg.watch.token',
    "spawnSync(bin, [\n  'a',\n  appKey,\n], { env });": 'value:appKey',
    "const p = await run(['push', secret, url], { gitDir });": 'value:secret',
    "await git(['-c', `http.extraHeader=Authorization: Basic ${b}`, 'push'], { gitDir });": 'text:an Authorization header',
    "await gitOk(['push', `https://u:${pw}@example.com/o/r.git`]);": 'text:a URL with a password in it',
    "await gitOk(['push', `https://x-access-token:${tok}@github.com/o/r.git`]);": 'text:x-access-token: (a token in a URL or header)',
    "`<key>ProgramArguments</key>${arr([node, run, '--secret', s])}`": 'flag:--secret',
    '<key>ProgramArguments</key>\n<array>\n<string>/x</string>\n<string>--token</string>\n<string>abc</string>\n</array>': 'flag:--token',
  };
  for (const [src, want] of Object.entries(caught)) assert.ok(said(src).includes(want), `${JSON.stringify(src)} → ${JSON.stringify(said(src))}`);
  // One finding per line and kind, though a job file's arr([...]) is met twice (as a call and after ProgramArguments).
  assert.deepEqual(said("`<key>ProgramArguments</key>${arr([node, run, '--secret', s])}`").filter((x) => !x.startsWith('unread:')), ['flag:--secret']);
});

test('R-0b-179 (b, #556 r2 A, B): the auditor\'s plants: lists passed through helpers, lists helpers return, and a URL built in a variable', () => {
  const caught = {
    'E1: a helper that spreads its list parameter': "function asUser(io, user, args) { return io.run('/usr/bin/sudo', ['-n', '-u', user, ...args]); }\nasUser(io, 'orchestrate', ['/bin/cat', f, cfg.watch.token]);",
    'E1: rest parameters': "const asUser = (io, user, ...args) => io.run('/usr/bin/sudo', ['-n', '-u', user, ...args]);\nasUser(io, 'orchestrate', '/bin/cat', f, cfg.watch.token);",
    'E2: two helpers deep': "function inner(io, args) { return spawnSync('/usr/bin/sudo', ['-n', ...args]); }\nfunction asDispatcher(io, args) { return inner(io, ['-u', 'd', ...args]); }\nasDispatcher(io, ['x', apiKey]);",
    'E3: a list a helper returns': "function appArgs(cfg) { return ['--app', cfg.id, secret]; }\nspawn(bin, appArgs(cfg));",
    "E4: wayOut's step": "export function wayOut(io, cfg) {\n  const step = (what, cmd, args) => { const r = io.run(cmd, args); };\n  step('x', PFCTL, ['-a', A, cfg.secret]);\n}",
    'a helper that hands its parameter back': "function wrap(a) { return a; }\nconst xs = ['--x', token];\nspawn(b, wrap(xs));",
    'an arrow that hands its parameter back': "const wrap = (a) => a;\nconst xs = [token];\nspawn(b, wrap(xs));",
    'a helper that spreads a slice of its parameter': "function w(args) { return ['-n', ...args.slice(1)]; }\nspawn(b, w(['x', token]));",
    'B: an x-access-token URL in a variable': "const url = `https://x-access-token:${tok}@example.com/o/r.git`;\nrun(['push', url]);",
    'B: a URL with a password in a variable': "const u = `https://me:${pw}@example.com/r.git`;\nspawn(bin, ['push', u]);",
    'shape: [...base]': "const base = ['--x', token];\nspawn(bin, [...base]);",
    "shape: ['x'].concat(token)": "spawn(bin, ['x'].concat(token));",
    'shape: args[0] = token': "const args = ['x'];\nargs[0] = token;\nspawn(bin, args);",
    'shape: a require alias': "const { spawn: sp } = require('node:child_process');\nsp(bin, ['--token', t]);",
  };
  for (const [what, src] of Object.entries(caught)) assert.ok(said(src).some((x) => /^(flag|value|text):/.test(x)), `${what}: ${JSON.stringify(said(src))}`);
  // A list passed in that the scan can not follow is listed, never passed: a helper called only from other modules.
  assert.deepEqual(said('export function f(io, list) { return io.run(BIN, list); }'), ["unread:f's list reaches a program's words, and f is called from other modules"]);
  assert.ok(said("function wrap(a) { return a.map(String); }\nspawn(b, wrap(x));").some((x) => x.startsWith('unread:')));
  // Safe shapes stay quiet: a token in the child's environment, literal lists through a helper. (A Bearer string in env
  // was quiet here until r3 m2 made `Bearer ${` a finding in any string but an HTTP header's whole value.)
  for (const src of ["spawn(bin, ['push'], { env: { GH_TOKEN: token } });", "function asUser(io, user, args) { return io.run('/usr/bin/sudo', ['-n', '-u', user, ...args]); }\nasUser(io, 'o', ['/bin/ls', dir]);"]) assert.deepEqual(said(src), [], src);
});

test('R-0b-179 (b, #556 r1 M3, M4, m10/11): the auditor\'s plants: lists built by push or under any name, scripts in strings, more names and flags', () => {
  const caught = {
    'via a variable named cmd': "const cmd = ['gh', '--token', t];\nspawn(cmd[0], cmd.slice(1));",
    'a spread with a token': 'spawn(bin, [...base, token]);',
    'a spread of a token-named list': 'spawn(bin, [...tokenArgs]);',
    'XML ProgramArguments': '<key>ProgramArguments</key><array><string>/x</string><string>--password</string><string>p</string></array>',
    'args.push(token) after a literal (M3)': "const args = ['x'];\nargs.push(token);\nspawn(bin, args);",
    "args.push('--token', t) (M3)": "const args = ['x'];\nargs.push('--token', t);\nspawn(bin, args);",
    'args.unshift / concat / splice (M3)': "const args = ['x'];\nargs.unshift(apiKey);\nspawn(bin, args.concat([secret]));\nargs.splice(1, 0, password);",
    'an index bracket before the list': "io.run(cmds[0], ['--token', t]);",
    'a flag inside an sh -c script (M4)': "spawn('/bin/sh', ['-c', `gh api --token ${t} /user`]);",
    'env NAME=${…} (M4)': "spawn('/usr/bin/env', [`GH_TOKEN=${t}`, 'gh', 'api']);",
    'the name tok': "spawn(bin, ['--repo', r, tok]);",
    'the name pw': "spawn(bin, ['-u', user, pw]);",
    'the name key': "spawn(bin, ['--key', key]);",
    'the flag --auth': "spawn(bin, ['--auth', a]);",
    'the flag --pass': "spawn(bin, ['--pass', p]);",
    '-p${pw}': 'spawn(bin, [`-p${pw}`]);',
    'curl -u user:${pw}': "spawn('/usr/bin/curl', ['-u', `${u}:${pw}`, url]);",
    'Bearer ${t}': "spawn('/usr/bin/curl', ['-H', `Bearer ${t}`, url]);",
    'a credential helper that echoes a password': "git(['-c', `credential.helper=!f() { echo password=${p}; }; f`, 'push']);",
    'execSync with a shell string': 'execSync(`gh api --token ${token}`);',
    'a promisify alias': "const pexec = promisify(execFile);\nawait pexec(bin, ['--token', t]);",
    'cp.spawn': "cp.spawn(bin, ['--token', t]);",
    'args reassigned (no const)': "let a; args = ['--token', t];\nspawn(bin, args);",
    'a sessionArgs-style push (M3)': "export function sessionArgs({ prompt, apiKey }) {\n  const args = ['-p'];\n  args.push(apiKey);\n  return args;\n}",
    'an object property': "spawn(bin, ['--x', secrets.github]);",
    'an optional chain': "spawn(bin, ['--x', cfg?.watch?.token]);",
    "cfg['token']": "spawn(bin, ['--x', cfg['token']]);",
    "'--token=' + t": "spawn(bin, ['--token=' + t]);",
    'a launchd job script in a string (M4)': "const script = ['set -u', `/usr/bin/curl --token ${cfg.secret} https://x`].join('\\n');",
  };
  for (const [name, src] of Object.entries(caught)) assert.ok(said(src).length > 0, `${name}: missed: ${JSON.stringify(src)}`);
  // Each way of reading, pinned by a plant only it catches.
  const only = {
    'an index is not the list': ["io.run(cmds[0], ['x', token]);", 'value:token'],
    'a promisify alias is a call': ["const pexec = promisify(execFile);\nawait pexec(bin, ['x', token]);", 'value:token'],
    'a name handed to spawn is a list': ["const opts = ['x'];\nopts.push(token);\nspawn(bin, opts);", 'value:token'],
    '-u then user:${…}': ["spawn('/usr/bin/curl', ['-u', `${user}:${p}`, url]);", 'text:a user:password pair after -u'],
    'a regex with a quote does not put the rest out of step': ["const q = s.replace(/'/g, 'x');\nconst r = io.run(bin, ['x', token]);", 'value:token'],
    'a regex holding /* is not a comment that hides the rest': ["const star = /a\\/*/;\nconst r = io.run(bin, ['x', token]);", 'value:token'],
    'a regex ending in // is not a line comment': ["const u = s.replace(/^https:\\/\\//, ''); io.run(bin, ['x', token]);", 'value:token'],
  };
  for (const [name, [src, want]] of Object.entries(only)) assert.ok(said(src).includes(want), `${name}: ${JSON.stringify(said(src))}`);
  // A list the scan can not read is listed, never passed in silence.
  assert.deepEqual(said('spawn(bin, makeList(cfg));'), ['unread:spawn(…, makeList(cfg))']);
  assert.deepEqual(said("const args = ['a'];\nspawn(bin, args);"), []);
});

test('R-0b-179 (b, #556 r3): the scan fails closed: command strings, parameters, returned lists, URLs and aliases are read to their end, or listed', () => {
  const E = 'process.' + 'env.GH_' + 'TOKEN';
  const caught = {
    // M1: a command string, given to exec/execSync or to spawn with a shell, is read for the names in its ${…}.
    'M1 execSync(`…${token}`)': ['execSync(`gh api --x ${token}`);', 'value:token'],
    'M1 exec(`…${token}`)': ['exec(`git push https://github.com/o/r ${token}`);', 'value:token'],
    'M1 spawn with shell: true': ['spawn(`gh api ${token}`, { shell: true });', 'value:token'],
    'M1 a command string in a name': ['const cmd = `gh api ${token}`;\nexecSync(cmd);', 'value:token'],
    'M1 a command string a helper is given': ['function go(cmd) { return execSync(cmd); }\ngo(`gh ${token}`);', 'value:token'],
    // M2: an element that is a parameter is read at each caller.
    'M2 a parameter as an element': ["function push(io, v) { return io.run('/usr/bin/gh', ['secret', 'set', 'X', '--body', v]); }\npush(io, cfg.token);", 'value:cfg.token'],
    "M2 a parameter's property (o.v)": ["function f(o) { return spawn('/x', ['a', o.v]); }\nf({ v: token });", 'value:token'],
    // M3: a list a helper builds under any name and returns; the whole right-hand side of an assignment.
    'M3 a returned list built under out': ["function mk() { const out = []; out.push(apiKey); return out; }\nspawn('/x', mk());", 'value:apiKey'],
    'M3 a returned args.push': ["function mk() { const args = ['x']; args.push(token); return args; }\nspawn('/x', mk());", 'value:token'],
    "M3 ['push'].concat(token) assigned": ["const args = ['push'].concat(token);\nspawn('/x', args);", 'value:token'],
    // m1-m4.
    'm1 https://${token}@host': ["const remote = `https://${token}@github.com/o/r.git`;\nspawn('git', ['push', remote]);", 'text:a URL with a token as its user'],
    "m2 a +-built URL ending x-access-token:": ["const remote = 'https://x-access-token:' + t + '@github.com/o/r';\nrunGit(['push', remote]);", 'text:x-access-token: (a URL built with +)'],
    'm2 Bearer ${…} in any string': ["const h = `Bearer ${t}`;\nspawn('/usr/bin/curl', ['-H', h, '-s']);", 'text:a Bearer token'],
    'm3 a name given an environment credential': [`const t = ${E};\nspawn('/x', ['push', t]);`, 'value:process.env.GH_TOKEN'],
    'm4 const sp = spawn': ["const sp = spawn;\nsp('/x', ['push', token]);", 'value:token'],
    // Followed, not only named: a credential set on a URL object, a loop name, a destructured name.
    'u.password = t': ["const u = new URL('https://github.com/o/r'); u.password = t;\nrunGit(['push', u.href]);", 'value:u.password'],
    'for (const [k, v] of pairs)': ["const pairs = [['a', token]];\nfor (const [k, v] of pairs) spawn('/x', [k, v]);", 'value:token'],
    'const { t } = cfg': ["const { t } = { t: token };\nspawn('/x', ['a', t]);", 'value:token'],
  };
  for (const [what, [src, want]] of Object.entries(caught)) assert.ok(said(src).includes(want), `${what}: ${JSON.stringify(said(src))}`);
  // Each way of reading, pinned: with it taken out the plant above it would pass (checked by mutation, #556 r3).
  // What can not be read to its end is listed, never passed.
  const listed = {
    'a command string from a call': ['execSync(makeCommand(cfg));', 'unread:execSync(…, makeCommand(cfg))'],
    'a parameter whose caller gives a name with no value here': ["function push(io, v) { return io.run('/usr/bin/gh', ['--body', v]); }\npush(io, given);", 'unread:push(…, given): given is given no value here that is read'],
    'a helper that is not called here (c1)': ["function f(o) { return spawn('/x', ['a', o.v]); }", 'unread:f passes its words on, and is not called here (it may be handed on as a value)'],
    'a helper that returns nothing read': ["function mk() { build(); }\nspawn('/x', mk());", 'unread:spawn(…, mk()): mk returns nothing that is read'],
    'a destructured parameter': ["function go({ a }) { return spawn('/x', ['x', a]); }\ngo({ a: 'y' });", "unread:spawn(…, ['x', a]): a is given no value here that is read"],
    'more than four helpers': ["function h1(a){ return spawn('/x', a); }\nfunction h2(a){ return h1(a); }\nfunction h3(a){ return h2(a); }\nfunction h4(a){ return h3(a); }\nfunction h5(a){ return h4(a); }\nh5(['--x', token]);", 'unread:h4(…, a): passed on through more than 4 helpers'],
    'apply': ["spawn.apply(null, ['/x', ['a']]);", 'unread:spawn.apply(…)'],
    'an exported helper': ['export function f(io, list) { return io.run(BIN, list); }', "unread:f's list reaches a program's words, and f is called from other modules"],
  };
  for (const [what, [src, want]] of Object.entries(listed)) assert.deepEqual(said(src), [want], what);
  // Safe shapes stay quiet: an HTTP header's whole value (fetch sends it, no command line holds it), the environment,
  // spawn without a shell, options after a list, loop names over literal paths, a parameter given a literal path.
  for (const src of [
    'await fetch(u, { headers: { authorization: `Bearer ${t}` } });',
    'headers.authorization = `Bearer ${t}`;',
    "spawn('/x', ['push'], { env: { GH_TOKEN: token } });",
    "spawn('/x', ['a'], { shell: false });",
    "function run2(cmd, opts) { return spawn(cmd, ['a'], opts); }\nrun2('/x', { env: { GH_TOKEN: token } });",
    "const files = ['/a'];\nfor (const f of files) spawn('/bin/ls', ['-l', f]);",
    "function go(dir) { return spawn('/bin/ls', [dir]); }\ngo('/tmp');",
  ]) assert.deepEqual(said(src), [], src);
});

test('R-0b-179 (b): the safe ways pass: the environment, a file, a kind or a name, a count, a switch, and an options object after the list', () => {
  for (const src of [
    "spawnSync(bin, ['push'], { env: { GH_TOKEN: token } });",
    "const url = 'https://github.com/o/r.git';\nconst r = await git(['push', url], { gitDir, extraConfig: tokenConfig(token) });",
    "const node = '/usr/local/bin/node'; const run = '/x/watch-run.mjs';\narr([node, run, '--token-file', tokenPath(cfg), '--app-key-file', keyFile])",
    "spawn(bin, ['--kind', secretKind, tokenFile]);",
    "spawnSync('/bin/ls', ['-la', dir]);",
    "spawnSync(bin, ['--note', 'the token is in the environment']);",
    '// spawn(bin, [token]) in a comment',
    // #556 r1 m10: what the r1 scan refused wrongly.
    "spawn(claude, ['--max-tokens', '1000']);",
    "spawn(claude, ['--limit', String(maxTokens)]);",
    "spawn(bin, ['--n', tokens]);",
    "spawn(bin, ['--deny', secretsDir]);",
    "spawn(bin, ['--no-token']);",
    "spawn('/usr/bin/curl', ['-c', cookieJar, url]);",
    'git([\'-c\', `credential.helper=${credentialHelper}`]);',
    "spawn(gitleaks, ['--redact', '--secret-scan']);",
    "spawn('/bin/cat', ['/etc/passwd']);",
    "spawn(bin, ['--tokenizer', 'cl100k']);",
    "spawn('/usr/bin/security', ['find-generic-password', '-s', service, '-w']);",
    "git(['push', 'https://github.com:443/o/r.git']);",
    "git(['push', 'ssh://git@github.com/o/r.git']);",
    "spawn(bin, ['http://localhost:8080@x']);",
    'const marker = `<!-- orch:alert v1 key=${key} status=${s} -->`;',
    "spawn(bin, ['--deny', cfg?.secrets?.dir, cfg['secrets'].dir]);",
    "spawn(bin, ['--dry', String(hasSecret), String(noToken)]);",
  ]) assert.deepEqual(said(src).filter((x) => !x.startsWith('unread:')), [], src);   // no finding; a name given no value here is listed (r3)
});

test('R-0b-179 (b): the real job builders are read: a token planted in the watch job, the push, a claude call, its session argv, or the wall\'s job script is caught', () => {
  const plant = (rel, from, to) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(src.includes(from), `${rel} no longer holds ${from}; move this plant to where its arguments are built now`);
    // Before the plant: only the findings already looked at (REVIEWED_FOUND); after it, what the plant added.
    const before = said(src).filter((x) => !x.startsWith('unread:'));
    assert.deepEqual(before.filter((x) => !REVIEWED_FOUND[`${rel} ${x.replace(':', ' ')}`]), [], rel);
    return said(src.replace(from, to)).filter((x) => !x.startsWith('unread:') && !before.includes(x));
  };
  assert.deepEqual(plant('setup/watch-setup.mjs', "'--token-file'", "'--token'"), ['flag:--token']);
  assert.deepEqual(plant('modules/M4-workshop/git/push.mjs', "run(['push', '--porcelain'", "run(['push', token, '--porcelain'"), ['value:token']);
  assert.deepEqual(plant('modules/M4-workshop/launcher/accounts.mjs', "['auth', 'status', '--json']", "['auth', 'status', '--json', apiKey]"), ['value:apiKey']);
  // #556 r1 M3: every claude launch's argv is built by push in sessionArgs.
  const session = 'modules/M4-workshop/launcher/review-launch.mjs';
  assert.deepEqual(plant(session, '  args.push(prompt);\n  return args;', '  args.push(prompt);\n  args.push(apiKey);\n  return args;'), ['value:apiKey']);
  assert.deepEqual(plant(session, '  args.push(prompt);\n  return args;', "  args.push('--api-key', key);\n  args.push(prompt);\n  return args;"), ['flag:--api-key', 'value:key']);
  // #556 r1 M4: the wall's own job script is a string.
  assert.deepEqual(plant('setup/builder-wall.mjs', "    'set -u',", "    'set -u',\n    `/usr/bin/curl --token ${cfg.secret} https://x`,"), ['flag:--token']);
  assert.deepEqual(plant('setup/builder-wall.mjs', "    'set -u',", "    'set -u',\n    `GH_TOKEN=${cfg.watchToken} /usr/bin/true`,"), ['text:GH_TOKEN=${…} (a credential set in a command)']);
});
