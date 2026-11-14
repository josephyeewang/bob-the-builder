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
 * Every finding the scan makes in the tree, looked at by hand, keyed by site (#556 r4 M-C): the file, the kind, what the
 * scan says, and @ a hash of the call's normalised text (with #2, #3 for the same text met again in one file). Since r3
 * the scan fails closed: a word it can not follow to literals, names that say what they are, or a value this module gives
 * is listed (kind unread), never passed. A new site fails the test below until it is looked at and added with the true
 * reason it is safe; one no longer met fails it too. A site inside a function that reads a credential (readSecret, a cat
 * or read of a token or key path) is kind reader, not unread, and is held to the same table.
 *
 * Reasons that cover many sites are named, each checked once, and each one's count is pinned in SHARED below, so a new
 * site under a shared reason changes the test.
 */
// setup/layout.mjs parseConfig and setup/install.mjs parseInstallConfig rebuild the setup config field by field.
const SETUP_CFG = "the setup config as parseConfig and parseInstallConfig rebuild it: paths, user and product names, labels, an https address; neither keeps a field that could hold a credential";
// The io port setup steps pass on to reach io.at(path), io.run and io.lstat. Setup does read one credential: the watch
// token (setup/extras.mjs, io.readSecret when it is pasted, and a cat as orchestrate when it is checked). Neither function
// has a site here; one that did would be kind reader.
const SETUP_IO = "setup's io port, passed on: here it answers with paths (io.at), uids, lstat results and commands' own answers; the one credential setup reads, the watch token, is read in extras.mjs functions that have no site here";
// A parameter written as { a, b }: the scan does not follow a property of a caller's object (a known limit).
const DESTRUCTURED = "a destructured parameter: a path, a 40-hex commit id or a ref name its callers pass, checked where it is used";
// push.mjs's run wraps git; gitDo and gitText hand back git's own output.
const GIT_ANSWER = "git's own answer in the product mirror (push.mjs's run, gitDo and gitText): commit, tree and ref ids and lists of them; the push token goes by GIT_CONFIG_* environment through extraConfig, never a word";
const RECORD_DOC = "the Record's session and card documents (record.read) and the intake's and push's facts (intakeFactId and the push facts it names): product name, card id, branch, outbox path, attempt and the report's sha256, each checked against its pattern before git sees it; no document or fact has a credential field";
// push.mjs's push and intake facts are read the same way since #536 (holds, heldSha, a push already made): their
// result, branch, tip, sha256 and a refusal's reason are compared, never made into a word, so they share RECORD_DOC.
const CLAUDE_START = "Claude Code's path, its fixed flags, a settings file's path and the session prompt last (a card's brief for a worker or review start; a proof's own fixed text for a live proof's start); the account and any key go by environment";
const INSTALL_PATHS = "installRoot, p and rel are install paths (the copy's link, the folders under it, a file inside it); ls -led reads only their access lists";
const PROOF_ROWS = "proofList builds each proof's args from fixed words (ls, test -w/-x, head -c 1, true) and paths: the setup config's folders, homes, proposal rows and the installed rules' env_files and secrets.paths (paths whose reading is proven refused; their contents are never read), and since #528 r4-r7 the links root found inside a folder and the folders above each place (paths too, so the names of links inside the key folders appear in ps-visible arguments, names only, never contents; an owner look has no args)";
const CAPTURE_TOOL = "the screen-capture test tool: tmux words, the test server's name, and the keys and text a fixture scenario types into a test session; no credential exists in it";
const REVIEW_CONFIG = "the review runner's config (readConfig, through openJobJson): paths, uids, names and the rules' file paths, with no credential field; argv[0] is that config's path and ownerTaps a folder path";
const GITLEAKS_SETUP = "the push script's scanner setup { bin, version, config, ignoreFile }: the pinned gitleaks path (checkScanner checks it is absolute) and file paths";
// gitleaks.mjs runScanner (#536): every caller is scanSecrets or checkScanner, in the same file.
const GITLEAKS_ARGS = "runScanner's words: a gitleaks subcommand (version, git, dir, stdin), the mirror's path, --log-opts with the new commit ids (the ids rev-list gives for the mirror's own commits; not pattern-checked), the scan folder's paths and the Do-plane config and ignore file paths; a commit's own text goes on stdin";
// The live proofs (setup/live-proofs, lane 4) ask claude its version before a run.
const CLAUDE_VERSION = "claude's path (the worker runner config's claudeBin, or the one the proof is handed), asked only --version";
const LIVE_TESTS = "settings-names' TESTS: each run(side, dir) gives claude fixed flags (with, per test, an --effort level, the --mcp-config JSON of an empty or test tool-server list, or a random --session-id), the path of a settings file written in the proof's own temp folder (the settings object goes in the file, not on the command line) and a prompt made of fixed text and paths in that folder (dir)";
const SHARED = { SETUP_CFG, SETUP_IO, DESTRUCTURED, GIT_ANSWER, RECORD_DOC, CLAUDE_START, INSTALL_PATHS, PROOF_ROWS, CAPTURE_TOOL, REVIEW_CONFIG, GITLEAKS_SETUP, GITLEAKS_ARGS, CLAUDE_VERSION, LIVE_TESTS };
const SHARED_COUNT = { SETUP_CFG: 4, SETUP_IO: 13, DESTRUCTURED: 9, GIT_ANSWER: 13, RECORD_DOC: 17, CLAUDE_START: 14, INSTALL_PATHS: 13, PROOF_ROWS: 31, CAPTURE_TOOL: 6, REVIEW_CONFIG: 4, GITLEAKS_SETUP: 2, GITLEAKS_ARGS: 1, CLAUDE_VERSION: 3, LIVE_TESTS: 3 };
const REVIEWED = {
  "modules/M11-dispatcher/cleanup.mjs unread git(…, ['merge-base', '--is-ancestor', a.merge_commit, 'refs/heads/): rec.list('merge') is a call whose answer is not read @d02e91a1": "rec is the Record store: rec.list('merge') gives merge records, whose merge_commit is a 40-hex commit id (checked before git sees it), and rec.list('product') gives product ids",
  "modules/M11-dispatcher/cleanup.mjs unread mirrorTree's sha reaches git(…, ['ls-tree', '-r', '-z', '--full-tree', sha]), and mirrorTree is called from other modules @879170a7": "mirrorTree(git, mirror, sha): git ls-tree on a commit id; its callers pass a card's recorded commit",
  "modules/M11-dispatcher/cleanup.mjs unread git(…, ['merge-base', '--is-ancestor', a.merge_commit, 'refs/heads/): rec.list('product') is a call whose answer is not read @616aedfb": "rec is the Record store: rec.list('merge') gives merge records, whose merge_commit is a 40-hex commit id (checked before git sees it), and rec.list('product') gives product ids",
  "modules/M11-dispatcher/sync-limit.mjs unread run passes its words on, and is not called here (it may be handed on as a value) @9f2d946c": "limitedSync returns run as a port: the wiring that holds it passes fixed git, launchctl and gh words (the gh token goes by environment, never a word)",
  "modules/M11-dispatcher/sync-limit.mjs unread run passes its list on, and is not called here (it may be handed on as a value) @eb3a0a5d": "limitedSync returns run as a port: the wiring that holds it passes fixed git, launchctl and gh words (the gh token goes by environment, never a word)",
  "modules/M12-sensors/history.mjs unread runner(…, ['--literal-pathspecs', ...args]): a parameter of an unnamed function @916a74f4": "makeGit's git takes an argument list from the history reader: git log words, commit ids and paths",
  "modules/M12-sensors/probes/launchd.mjs unread runLaunchctl's args reaches spawn(…, args), and runLaunchctl is called from other modules @3380bcc1": "exported, but its only use is launchdProbe's default runner, which passes ['print', <domain>/<label>], both checked against fixed patterns",
  "modules/M12-sensors/probes/launchd.mjs unread run(…, ['print', `${domain}/${label}`]): domain is given no value here that is read @f136c3b6": "domain is checked against DOMAIN (system, gui/<uid> or user/<uid>) and label against LABEL just above",
  "modules/M12-sensors/screen/tools/capture.mjs unread makeTmux's server reaches execFileSync(…, ['-L', server, '-f', '/dev/null', ...args]), and makeTmux is called from other modules @4c816efc": CAPTURE_TOOL,
  "modules/M12-sensors/screen/tools/capture.mjs unread keys's k reaches run(…, ...k), and keys is called from other modules @5b981112": CAPTURE_TOOL,
  "modules/M12-sensors/screen/tools/capture.mjs unread text's t reaches run(…, t), and text is called from other modules @db71962f": CAPTURE_TOOL,
  "modules/M12-sensors/screen/tools/capture.mjs unread runScenario's s reaches run(…, ...args), and runScenario is called from other modules @08f33e9d": CAPTURE_TOOL,
  "modules/M12-sensors/screen/tools/capture.mjs unread main's argv reaches run(…, claude), and main is called from other modules @22d1286f": CAPTURE_TOOL,
  "modules/M12-sensors/screen/tools/capture.mjs unread main's argv reaches version(…, bin), and main is called from other modules @4cf5f9a5": CAPTURE_TOOL,
  "modules/M12-sensors/shell-guard/runner.mjs unread askHook's hookCommand reaches spawnSync(…, ['-c', hookCommand]), and askHook is called from other modules @354f4d32": "the hook command from the role's settings file (a path and its fixed words); the command under test goes on stdin",
  "modules/M12-sensors/shell-guard/selfcheck.mjs unread runShell(…, [...(sh.endsWith('zsh') ? ['-f'] : []), '-c', cmd]): cases(mode === 'relative' ? name : `${root}/proj/${name}`, m is a call whose answer is not read @56bd2879": "cmd is a case from cases(), the guard's own case table, built on a new temp folder's real path (newFolder)",
  "modules/M12-sensors/shell-guard/selfcheck.mjs unread runShell's sh reaches spawnSync(…, argv[0]), and runShell is called from other modules @4653bd61": "runShell's one caller passes a shell from the fixed list and -c with a case's command from the guard's own case table",
  "modules/M12-sensors/shell-guard/selfcheck.mjs unread runShell's args reaches spawnSync(…, argv[0]), and runShell is called from other modules @0689a76d": "runShell's one caller passes a shell from the fixed list and -c with a case's command from the guard's own case table",
  "modules/M12-sensors/shell-guard/selfcheck.mjs unread runShell(…, [...(sh.endsWith('zsh') ? ['-f'] : []), '-c', cmd]): newFolder() is a call whose answer is not read @1a1a9702": "cmd is a case from cases(), the guard's own case table, built on a new temp folder's real path (newFolder)",
  "modules/M12-sensors/shell-guard/selfcheck.mjs unread runOne(…, sh): a parameter of an unnamed function @8a1e903d": "sh is each of touchCheck's shells: /bin/bash unless its caller names others (shell paths)",
  "modules/M4-workshop/git/gitleaks.mjs unread run(…, ['git', mirror, '--log-opts', logOpts, ...common(setup, repo): shas is given no value here that is read @a29af271": "shas are 40-hex commit ids and mirror the product mirror's path, from the push script; messages' texts go on stdin (input), and only each sha reaches a word, in the report's file name",
  "modules/M4-workshop/git/gitleaks.mjs unread run(…, ['git', mirror, '--log-opts', logOpts, ...common(setup, repo): mirror is given no value here that is read @a5f71025": "shas are 40-hex commit ids and mirror the product mirror's path, from the push script; messages' texts go on stdin (input), and only each sha reaches a word, in the report's file name",
  "modules/M4-workshop/git/gitleaks.mjs unread run(…, ['stdin', ...common(setup, rep)]): messages is given no value here that is read @b635587e": "shas are 40-hex commit ids and mirror the product mirror's path, from the push script; messages' texts go on stdin (input), and only each sha reaches a word, in the report's file name",
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): git(args, opts) is a call whose answer is not read @1f203dec": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): git(args, opts) is a call whose answer is not read @3a07f800": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread gitDo(…, ['cat-file', 'commit', sha]): git(args, opts) is a call whose answer is not read @b11bc3f2": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread changes(…, [mb, tip]): git(args, opts) is a call whose answer is not read @eaf76ea4": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): git(args, { ...opts, ...(t.bin ? { gitBin: t.bin } : {}), .. is a call whose answer is not read @78f54efd": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): git(args, { ...opts, ...(t.bin ? { gitBin: t.bin } : {}), .. is a call whose answer is not read @98be60a9": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread gitDo(…, ['cat-file', 'commit', sha]): git(args, { ...opts, ...(t.bin ? { gitBin: t.bin } : {}), .. is a call whose answer is not read @536d23c7": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread changes(…, [mb, tip]): git(args, { ...opts, ...(t.bin ? { gitBin: t.bin } : {}), .. is a call whose answer is not read @317af315": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): passed on through more than 6 helpers @4913271b": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['check-ref-format', '--branch', branch]): a parameter of an unnamed function @e31eb719": "a branch name, checked by git check-ref-format itself",
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): out.trim().split('\\n').filter(Boolean).map((l) => { const [s is given a function whose answer is not read @e8d3423b": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread gitDo(…, ['cat-file', 'commit', sha]): out.trim().split('\\n').filter(Boolean).map((l) => { const [s is given a function whose answer is not read @f77c5611": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): passed on through more than 6 helpers @f4dec46d": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): passed on through more than 6 helpers @c5e8a196": GIT_ANSWER,
  "modules/M4-workshop/git/push.mjs unread run(…, ['check-ref-format', '--branch', branch]): record.read('session', sessionId) is a call whose answer is not read @df8a7b00": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): proposalFolder(rules, product) is a call whose answer is not read @ce668588": "proposalFolder(rules, product) is the product's proposals folder path from the rules",
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): cardBranch(card) is a call whose answer is not read @2cb445b8": "cardBranch(card) is card/<card id>, the id checked against CARD",
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('card', card) is a call whose answer is not read @5b8b42d8": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread gitDo(…, ['cat-file', 'commit', sha]): record.read('card', card) is a call whose answer is not read @3c962526": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): proposalFolder(rules, product) is a call whose answer is not read @ce668588 #2": "proposalFolder(rules, product) is the product's proposals folder path from the rules",
  "modules/M4-workshop/git/push.mjs unread run(…, ['push', '--porcelain', '--atomic', '--no-verify', url, `${t): testRemote(repo) is a call whose answer is not read @5415f594": "url is githubUrl(repo), checked to start https://github.com/ with no user part, or in tests testRemote's local folder, checked to be a full path",
  "modules/M4-workshop/git/push.mjs unread gitText(…, ['commit-tree', tree, '-p', main, '-m', `Copy research ask $): checkMirror(mirror) is a call whose answer is not read @c3fd0570": "checkMirror answers { ok, reason } about the mirror folder; only the mirror's path reaches a word",
  "modules/M4-workshop/git/push.mjs value auth @68a4b3f4": "remoteTip is a commit id parsed from git ls-remote's answer; auth is that call's options (the token goes by GIT_CONFIG_* environment through extraConfig), not a word",
  "modules/M4-workshop/git/push.mjs value auth @d775228e": "remoteTip is a commit id parsed from git ls-remote's answer; auth is that call's options (the token goes by GIT_CONFIG_* environment through extraConfig), not a word",
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): factParts() is a call whose answer is not read @4c46e0c2": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['check-ref-format', '--branch', branch]): record.read('session', sessionId) is a call whose answer is not read @df8a7b00 #2": RECORD_DOC,
  "modules/M4-workshop/git/save-work.mjs unread gitOk(…, ['bundle', 'create', '-q', tmp, `refs/heads/${branch}`]): branch is given no value here that is read @91790e7f": "branch is checked just above to be cardBranch(card) and to match BRANCH",
  "modules/M4-workshop/launcher/accounts.mjs unread claudeAuthStatus's claudeBin reaches spawnSync(…, claudeBin), and claudeAuthStatus is called from other modules @9c6a0212": "claudeBin is Claude Code's program path ('claude', or --claude <path> for a test's fake); the account goes by environment (CLAUDE_CONFIG_DIR), not a word",
  "modules/M4-workshop/launcher/accounts.mjs unread claudeAuthStatus(…, claudeBin): args.splice(k, 2) is a call whose answer is not read @aec334e2": "claudeBin is Claude Code's program path ('claude', or --claude <path> for a test's fake); the account goes by environment (CLAUDE_CONFIG_DIR), not a word",
  "modules/M4-workshop/launcher/env-check.mjs unread readPlist's p reaches execFileSync(…, ['-convert', 'json', '-o', '-', '--', p]), and readPlist is called from other modules @77e9e38c": "p is a job file's path (plutil -convert json -- <path>)",
  "modules/M4-workshop/launcher/hooks-check.mjs unread run(…, node): execFileSync(bin, a, { encoding: 'utf8', timeout: 10000, env is a call whose answer is not read @1d0055da": "the hook command's own words from the role settings file, node's and Claude Code's pinned paths (claudeBin is checked to be pinnedBinary(root, pin)) and --version",
  "modules/M4-workshop/launcher/hooks-check.mjs unread run(…, claudeBin): claudeBin is given no value here that is read @c3a59cdd": "the hook command's own words from the role settings file, node's and Claude Code's pinned paths (claudeBin is checked to be pinnedBinary(root, pin)) and --version",
  "modules/M4-workshop/launcher/hooks-check.mjs unread run(…, node): settings is given no value here that is read @3942f546": "the hook command's own words from the role settings file, node's and Claude Code's pinned paths (claudeBin is checked to be pinnedBinary(root, pin)) and --version",
  "modules/M4-workshop/launcher/install-check.mjs unread copyModuleProblem's rel reaches lsShowsAcl(…, [p]), and copyModuleProblem is called from other modules @dd78c160": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread lsShowsAcl(…, [p]): readlink(installRoot) is a call whose answer is not read @f7b5749a": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread lsShowsAcl(…, [p]): e is given no value here that is read @aacd693e": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread currentCopy's installRoot reaches lsShowsAcl(…, [p]), and currentCopy is called from other modules @cae28d14": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread copyReady's installRoot reaches currentCopy(…, installRoot), and copyReady is called from other modules @309b9574": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread copyReady's installRoot reaches readInstallStamp(…, installRoot), and copyReady is called from other modules @db382688": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread copyPath's installRoot reaches lsShowsAcl(…, [p]), and copyPath is called from other modules @99795a92": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread copyPath's p reaches lsShowsAcl(…, [p]), and copyPath is called from other modules @5d588a78": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread aclProblem's paths reaches lsShowsAcl(…, batch), and aclProblem is called from other modules @53943225": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread installProblem's installRoot reaches currentCopy(…, installRoot), and installProblem is called from other modules @f9e5b0ae": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread installProblem's installRoot reaches inside(…, installRoot), and installProblem is called from other modules @27a3db36": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread installProblem's installRoot reaches lsShowsAcl(…, [p]), and installProblem is called from other modules @a07535ae": INSTALL_PATHS,
  "modules/M4-workshop/launcher/install-check.mjs unread readInstallStamp's installRoot reaches currentCopy(…, installRoot), and readInstallStamp is called from other modules @1682e7f2": INSTALL_PATHS,
  "modules/M4-workshop/launcher/review-launch.mjs unread spawnClaude's bin reaches spawn(…, bin), and spawnClaude is called from other modules @1ecafca3": CLAUDE_START,
  "modules/M4-workshop/launcher/review-launch.mjs unread spawnClaude's args reaches spawn(…, args), and spawnClaude is called from other modules @5b418b89": CLAUDE_START,
  "modules/M4-workshop/launcher/review-launch.mjs unread runProbe(…, lr.bin): lockedRunCommand({ claudeBin: x.claudeBin, settingsFile: x.s is a call whose answer is not read @2510d8ef": CLAUDE_START,
  "modules/M4-workshop/launcher/review-runner-main.mjs unread realPath(…, c.root): openJobJson(file, (why) => { throw new Error(`config: ${file is a call whose answer is not read @5cf2e1ea": REVIEW_CONFIG,
  "modules/M4-workshop/launcher/review-runner-main.mjs unread realPath(…, c.root): read(runnerConfig) is a call whose answer is not read @d0846155": REVIEW_CONFIG,
  "modules/M4-workshop/launcher/review-runner-main.mjs unread realPath(…, given): ownerTaps is given no value here that is read @832a7751": REVIEW_CONFIG,
  "modules/M4-workshop/launcher/review-runner-main.mjs unread gitOk(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): cardBranch(card) is a call whose answer is not read @f2fdf991": "prepareReviewCopy({ mirror, card, head, dest }): card is checked against CARD_ID and head to be 40 hex just above; mirror and dest are the runner's folder paths",
  "modules/M4-workshop/launcher/review-runner-main.mjs unread gitOk(…, ['init', '-q', '--initial-branch=review-copy-unborn', dest]): dest is given no value here that is read @87cc44c4": "prepareReviewCopy({ mirror, card, head, dest }): card is checked against CARD_ID and head to be 40 hex just above; mirror and dest are the runner's folder paths",
  "modules/M4-workshop/launcher/review-runner-main.mjs unread gitOk(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): mirror is given no value here that is read @ef1fe249": "prepareReviewCopy({ mirror, card, head, dest }): card is checked against CARD_ID and head to be 40 hex just above; mirror and dest are the runner's folder paths",
  "modules/M4-workshop/launcher/review-runner-main.mjs unread currentHead's card reaches git(…, ['rev-parse', '--verify', '-q', `refs/heads/card/${card.toLo), and currentHead is called from other modules @7dd0f63b": "a card id (checked against its pattern) and a 40-hex commit id, in git rev-parse words",
  "modules/M4-workshop/launcher/review-runner-main.mjs unread treeOf's head reaches git(…, ['rev-parse', '--verify', '-q', `${head}^{tree}`]), and treeOf is called from other modules @66f09cf3": "a card id (checked against its pattern) and a 40-hex commit id, in git rev-parse words",
  "modules/M4-workshop/launcher/review-runner-main.mjs unread realPath(…, c.root): readConfigFn(argv[0]) is a call whose answer is not read @3af1e357": REVIEW_CONFIG,
  "modules/M4-workshop/launcher/review-updater.mjs unread updateOnce(…, c): readFileSync(file, 'utf8') is a call whose answer is not read @ad246420": "the updater's config (readUpdaterConfig): paths and an https address whose host part holds no user or password (HTTPS pattern)",
  "modules/M4-workshop/launcher/review-updater.mjs unread updateOnce's c reaches makeClone(…, c.clone), and updateOnce is called from other modules @2a783828": "the updater's config (readUpdaterConfig): paths and an https address whose host part holds no user or password (HTTPS pattern)",
  "modules/M4-workshop/launcher/review-updater.mjs unread updateOnce's c reaches git(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-), and updateOnce is called from other modules @09b7ab5a": "the updater's config (readUpdaterConfig): paths and an https address whose host part holds no user or password (HTTPS pattern)",
  "modules/M4-workshop/launcher/review-updater.mjs unread git(…, ['ls-tree', '-r', '-z', '--full-tree', `${commit}:${SOURCE}`): git(['rev-parse', '--verify', '-q', `${MAIN}^{commit}`], { . is a call whose answer is not read @831ad7ee": "commit is git's own answer to rev-parse main^{commit}, a commit id; OUTSIDE_FILES is an imported constant of file paths",
  "modules/M4-workshop/launcher/review-updater.mjs unread git(…, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...OUTS) @1c07e12f": "commit is git's own answer to rev-parse main^{commit}, a commit id; OUTSIDE_FILES is an imported constant of file paths",
  "modules/M4-workshop/launcher/worker-copy.mjs unread gitOk(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', lastBu): cardBranch(card.id) is a call whose answer is not read @9823116b": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread gitOk(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): product is given no value here that is read @40a6835b": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread git(…, ['cat-file', '-t', card.commit]): card is given no value here that is read @8558f5d8": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread git(…, ['merge-base', '--is-ancestor', card.commit, 'refs/heads/mai): card is given no value here that is read @1e3b5f00": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread gitOk(…, ['init', '-q', dest]): dest is given no value here that is read @efc23733": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread gitOk(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): card is given no value here that is read @53fd9dbf": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread git(…, ['merge-base', '--is-ancestor', card.commit, head]): card is given no value here that is read @16c9a11c": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread git(…, ['merge-base', '--is-ancestor', card.commit, head]): card is given no value here that is read @16c9a11c #2": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread gitOk(…, ['branch', branch, card.commit]): card is given no value here that is read @0c9b3814": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/launcher/worker-copy.mjs unread git(…, ['merge-base', '--is-ancestor', card.commit, head]): git(['rev-parse', '--verify', '-q', `${remoteRef}^{commit}`] is a call whose answer is not read @8eda35c2": "prepareWorkerCopy({ product, card, dest }): card.id is checked against CARD and card.commit to be a full commit id, product.mirror is the rules' mirror path, dest the copy's folder; remoteRef's commit is git's own answer",
  "modules/M4-workshop/send-safe/guard.mjs unread run(…, ['send-keys', '-t', target, '-l', '--', text, ';', 'send-key): targetFor(id) is a call whose answer is not read @cae7e18e": "a message typed into a session (tmux send-keys -l) and targetFor(id)'s tmux target: the Dispatcher's own words to a session, which reads them anyway; never a credential",
  "modules/M4-workshop/send-safe/guard.mjs unread send's text reaches run(…, ['send-keys', '-t', target, '-l', '--', text, ';', 'send-key), and send is called from other modules @03a34ff8": "a message typed into a session (tmux send-keys -l) and targetFor(id)'s tmux target: the Dispatcher's own words to a session, which reads them anyway; never a credential",
  "modules/M5-review-audit/findings.mjs unread gitOk(…, ['merge-base', 'refs/heads/main', head]): head is given no value here that is read @95ce5375": DESTRUCTURED,
  "modules/M5-review-audit/findings.mjs unread at(…, head): head is given no value here that is read @6f62011a": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs unread gitOk(…, ['merge-base', 'refs/heads/main', head]): head is given no value here that is read @95ce5375": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs unread gitOk(…, ['diff', '--name-status', '-z', '--no-renames', '--ignore-su): head is given no value here that is read @9eb865eb": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs unread gitOk(…, ['diff', ...DIFF_FLAGS, base, head]): head is given no value here that is read @64ff2e2c": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs unread git(…, ['merge-base', '--is-ancestor', since, head]): since is given no value here that is read @7ce55da9": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs unread git(…, ['merge-base', '--is-ancestor', since, head]): head is given no value here that is read @d6d37aa1": DESTRUCTURED,
  "modules/M5-review-audit/review-package.mjs unread gitOk(…, ['merge-base', 'refs/heads/main', since]): since is given no value here that is read @3a710277": DESTRUCTURED,
  "setup/bob-manifest.mjs unread bobGit's cfg reaches run(…, argv), and bobGit is called from other modules @90a87067": SETUP_CFG,
  "setup/bob-manifest.mjs unread bobGit's from reaches run(…, argv), and bobGit is called from other modules @34d91233": "argv is sudo's flags, ENV, GIT_ENV (PATH, LC_ALL, GIT_TERMINAL_PROMPT, GIT_CONFIG_NOSYSTEM; no token), git -C <Bob's folder> and the command; input is object ids on stdin",
  "setup/bob-manifest.mjs unread run(…, argv): a parameter of an unnamed function @1a7d192b": "argv is sudo's flags, ENV, GIT_ENV (PATH, LC_ALL, GIT_TERMINAL_PROMPT, GIT_CONFIG_NOSYSTEM; no token), git -C <Bob's folder> and the command; input is object ids on stdin",
  "setup/builder-wall.mjs unread planWall's io reaches run(…, ['bootstrap', 'system', io.at(wallPlistPath(cfg))]), and planWall is called from other modules @e64a91b9": SETUP_IO,
  "setup/builder-wall.mjs reader step(…, ['-X', ref]): io.readText(tokenPath(cfg)) is a call whose answer is not read (in wayOut, which reads a credential) @e28f722b": "ref is pf's enable reference, the number pfctl -E printed and wallDir's pf-token file keeps (root's 0700 folder); it is checked to be digits before pfctl -X takes it. pf calls it a token; it is a count, not a credential",
  "setup/builder-wall.mjs unread spawn(…, [...as(user), '-e', LISTENER, proto, host]): net.addresses() is a call whose answer is not read @b0bde14e": "net.addresses() is this Mac's own non-loopback IP address, for the listener and client probes",
  "setup/builder-wall.mjs unread spawn(…, [...as(user), '-e', CLIENT, proto, host, String(port)]): port is given no value here that is read @c2fb59ea": "port is the number the probe's own listener printed (PORT n, read as Number), handed to the client probe; it is a port number. Until r7 the scan passed it by reading the CLIENT script's text as code",
  "setup/builder-wall.mjs unread planWall(…, io): realIo() is a call whose answer is not read @58a4416a": SETUP_IO,
  "setup/daemons.mjs unread planLoad's io reaches launchctl(…, ['bootstrap', 'system', io.at(plistPath(cfg, job))]), and planLoad is called from other modules @e2d8b091": SETUP_IO,
  "setup/daemons.mjs unread planReloadAccount's io reaches launchctl(…, ['bootstrap', 'system', io.at(plistPath(cfg, job))]), and planReloadAccount is called from other modules @cc90dfc9": SETUP_IO,
  "setup/dispatcher-check.mjs unread unreadableWhy's real reaches asDispatcher(…, ['/bin/test', '-r', real]), and unreadableWhy is called from other modules @ebde55eb": "real is a guarded file's real path (realpathSync.native of a config path, with the disk's own case); test -r reads nothing",
  "setup/dispatcher-check.mjs unread checkDispatcherKeys's io reaches unreadableWhy(…, real), and checkDispatcherKeys is called from other modules @df930cf9": SETUP_IO,
  "setup/extras.mjs unread asUser(…, [TEST, '-w', f]): planFolders(io, cfg, { owner: { uid: owner.uid, gid: owner.g is a call whose answer is not read @d344687c": "proposalsParentOf(cfg) and planFolders' rows are paths built from the setup config's base and product names",
  "setup/extras.mjs unread checkProposals's cfg reaches asUser(…, [TEST, '-w', f]), and checkProposals is called from other modules @a320d649": SETUP_CFG,
  "setup/extras.mjs unread asUser(…, [TEST, '-w', f]): proposalsParentOf(cfg) is a call whose answer is not read @f94d0a66": "proposalsParentOf(cfg) and planFolders' rows are paths built from the setup config's base and product names",
  "setup/install.mjs unread spawnSync(…, c.args): node is given no value here that is read @bf16ec3d": "updaterCommand writes the list out: the script, the config, --first and the seed, all install paths (io.at)",
  "setup/install.mjs unread spawnSync(…, c.args): script is given no value here that is read @fcda2aff": "updaterCommand writes the list out: the script, the config, --first and the seed, all install paths (io.at)",
  "setup/install.mjs unread spawnSync(…, c.args): config is given no value here that is read @0b0113c1": "updaterCommand writes the list out: the script, the config, --first and the seed, all install paths (io.at)",
  "setup/install.mjs unread spawnSync(…, c.args): seed is given no value here that is read @0e9aebb3": "updaterCommand writes the list out: the script, the config, --first and the seed, all install paths (io.at)",
  "setup/managed-settings.mjs unread spawnSync(…, node): node is given no value here that is read @10d09a6d": "runGuard({ node, hook, copy }): node's path, the hook's path and the snapshot copy's path; the command under test goes on stdin",
  "setup/owner-answer-setup.mjs unread planOwnerLoad's io reaches bootstrap(…, io), and planOwnerLoad is called from other modules @7248fb30": SETUP_IO,
  "setup/proofs.mjs unread proveList's list reaches run(…, ['-n', '-H', '-u', BUILDER, ...pr.args]), and proveList is called from other modules @680eaaba": PROOF_ROWS,
  "setup/users-folders.mjs value key @f14f1e8a": "census's read(path, key): key is a dscl attribute name, 'UniqueID' or 'PrimaryGroupID' at its one caller",
  "setup/users-folders.mjs unread want(…, [['UserShell', shellOf(name)], ['IsHidden', '1'], ['Password): homeOf(cfg, name) is a call whose answer is not read @2df588fe": "homeOf(cfg, name) is a home folder's path under the setup base and shellOf(name) a shell's path (/usr/bin/false or /bin/zsh); dscl attribute values",
  "setup/users-folders.mjs unread want(…, [['UserShell', shellOf(name)], ['IsHidden', '1'], ['Password): shellOf(name) is a call whose answer is not read @8f7af688": "homeOf(cfg, name) is a home folder's path under the setup base and shellOf(name) a shell's path (/usr/bin/false or /bin/zsh); dscl attribute values",
  "setup/users-folders.mjs unread aclEntries's io reaches run(…, ['-led', io.at(path)]), and aclEntries is called from other modules @f142b286": SETUP_IO,
  "setup/users-folders.mjs unread planFolders's rows reaches aclOp(…, row), and planFolders is called from other modules @b54f037a": "rows are folderTable(cfg): paths, owners and modes",
  "setup/users-folders.mjs unread planFolders's io reaches aclOp(…, io), and planFolders is called from other modules @1120115e": SETUP_IO,
  "setup/users-folders.mjs unread planFolders's io reaches aclEntries(…, io), and planFolders is called from other modules @8fe81b16": SETUP_IO,
  "setup/users-folders.mjs unread planFolders's io reaches aclOp(…, io), and planFolders is called from other modules @1120115e #2": SETUP_IO,
  "setup/users-folders.mjs unread plan's io reaches planFolders(…, io), and plan is called from other modules @9377316d": SETUP_IO,
  "setup/users-folders.mjs unread planFolders(…, folderTable(cfg)): folderTable(cfg) is a call whose answer is not read @b608e97c": "rows are folderTable(cfg): paths, owners and modes",
  // r8: planFolders' rows default is read as one more value rows may take.
  "setup/users-folders.mjs unread aclOp(…, row): folderTable(cfg) is a call whose answer is not read @e8c01960": "rows are folderTable(cfg): paths, owners and modes, and access lists of Mac user names and permission words (chmod +a)",
  "setup/users-folders.mjs unread check's io reaches folderChecks(…, io), and check is called from other modules @9b76c848": SETUP_IO,
  "setup/users-folders.mjs unread folderChecks's io reaches aclEntries(…, io), and folderChecks is called from other modules @1e11095f": SETUP_IO,
  "setup/watch-setup.mjs unread watchPlist's cfg reaches arr(…, [join(P.installRoot, NODE), join(P.installRoot, WATCH_RUN), ), and watchPlist is called from other modules @57f96ecb": SETUP_CFG,
  "setup/watch-setup.mjs unread proveWatchAppChecks's cfg reaches run(…, ['-n', '-H', '-u', 'orchestrate', join(P.installRoot, NODE),), and proveWatchAppChecks is called from other modules @2f4d98ef": SETUP_CFG,
  "setup/watch-setup.mjs unread proveWatchAppChecks's on reaches run(…, ['-n', '-H', '-u', 'orchestrate', join(P.installRoot, NODE),), and proveWatchAppChecks is called from other modules @47feee6d": "on is a pull request's number and 40-hex head; the job mints the App's token itself from the key file, whose path is the only key word passed",
  "wiring/owner-answer.mjs unread claudeUsage's claudeBin reaches spawnSync(…, claudeBin), and claudeUsage is called from other modules @4b221127": "claudeBin is the Claude Code program's path; the account goes by environment, not a word",
  "wiring/review-ports.mjs unread git(…, withNoPrograms(['diff-tree', '-r', '-z', '--name-only', '--n): withNoPrograms(['diff-tree', '-r', '-z', '--name-only', '--n is a call whose answer is not read @a288668a": "the list is written out inside withNoPrograms, which only adds the fixed NO_PROGRAMS flags; sha is checked to be a commit id",
  // The runtime guard (R-0b-179, L1176): envGit is exported only so secret-guard.test can drive a token through it.
  "wiring/review-ports.mjs unread envGit's env reaches run(…, ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ), and envGit is called from other modules @829ebb5d": "envGit's one caller in the tree is mirrorFilesOf's git, whose calls pass safeGitEnv() with no extraConfig (fixed PATH, HOME, LANG, GIT_DIR paths and safe settings; a token could come only through extraConfig, none is passed, #556 r2 m6) and lists written out; exported only for secret-guard.test, which shows a token in it is refused",
  "wiring/review-ports.mjs unread envGit's args reaches run(…, ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ), and envGit is called from other modules @479786ef": "envGit's one caller in the tree is mirrorFilesOf's git, whose calls pass safeGitEnv() with no extraConfig (fixed PATH, HOME, LANG, GIT_DIR paths and safe settings; a token could come only through extraConfig, none is passed, #556 r2 m6) and lists written out; exported only for secret-guard.test, which shows a token in it is refused",
  "wiring/runner-checks.mjs unread run(…, ['ls-tree', '-r', '-z', '--full-tree', main]): mainAt is given no value here that is read @0056e2c5": "mainAt is used only when SHA says it is a 40-hex commit id, else 'refs/heads/main'",
  "wiring/runner-locked.mjs unread runToEnd's bin reaches spawn(…, bin), and runToEnd is called from other modules @5330f049": CLAUDE_START,
  "wiring/runner-locked.mjs unread runToEnd's args reaches spawn(…, args), and runToEnd is called from other modules @d1bbaf97": CLAUDE_START,
  "wiring/runner-locked.mjs unread runToEnd(…, lr.bin): lockedRunCommand({ claudeBin, settingsFile, command, roleArg is a call whose answer is not read @da073895": CLAUDE_START,
  "wiring/runner-ports.mjs unread run(…, ['merge-base', '--is-ancestor', commit, head]): head is given no value here that is read @9fc2f629": DESTRUCTURED,
  "wiring/runner-ports.mjs unread chmodTree's d reaches execFileSync(…, ['-R', '-P', 'u+rwx', d]), and chmodTree is called from other modules @1f95cc77": "d is a folder being removed (chmod -R -P u+rwx <folder>)",
  "wiring/runner-ports.mjs unread run(…, ['cat-file', '-t', commit]): startCommit({ mirror: p.mirror, card, cardDoc: cd.doc }) is a call whose answer is not read @81fc7491": "startCommit answers with the card's start commit id, from the card record or git; git cat-file -t only names its type",
  // From main after #536, #537 and #577 (merged into #556): the scan reads the new and rewritten sites, each looked at.
  "modules/M4-workshop/git/gitleaks.mjs unread runScanner's bin reaches spawn(…, bin), and runScanner is called from other modules @70983b59": GITLEAKS_SETUP,
  "modules/M4-workshop/git/gitleaks.mjs unread runScanner's args reaches spawn(…, args), and runScanner is called from other modules @261eb37f": GITLEAKS_ARGS,
  "modules/M4-workshop/git/gitleaks.mjs unread runScanner(…, bin): bin is given no value here that is read @a344e5a3": GITLEAKS_SETUP,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('fact', intakeFactId(product, bundleName(card))) is a call whose answer is not read @4ac16284": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): record.read('fact', intakeFactId(product, bundleName(card))) is a call whose answer is not read @7ca6c538": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('card', card) is a call whose answer is not read @5b8b42d8 #2": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): record.read('card', card) is a call whose answer is not read @ba1ff5ac": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): rules.may('push_branch', subject) is a call whose answer is not read @464d44dc": "rules.may answers { decision, reason }; only the decision is read, and no part of it reaches a word",
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): rules.may('push_branch', subject) is a call whose answer is not read @5cdfff00": "rules.may answers { decision, reason }; only the decision is read, and no part of it reaches a word",
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('card', card) is a call whose answer is not read @5b8b42d8 #3": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): record.read('card', card) is a call whose answer is not read @ba1ff5ac #2": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('fact', id) is a call whose answer is not read @73ed70b6": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): record.read('fact', id) is a call whose answer is not read @76a464da": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('fact', PUSH_FACT(got.card, got.att)) is a call whose answer is not read @aa8e573e": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): record.read('fact', PUSH_FACT(got.card, got.att)) is a call whose answer is not read @9bd8c5e2": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-): record.read('fact', PUSH_FACT(inputs.card, inputs.att)) is a call whose answer is not read @51c67952": RECORD_DOC,
  "modules/M4-workshop/git/push.mjs unread run(…, ['merge-base', '--is-ancestor', remoteTip, tip]): record.read('fact', PUSH_FACT(inputs.card, inputs.att)) is a call whose answer is not read @32bd96a6": RECORD_DOC,
  "setup/live-proofs/runlocked.mjs unread childSpawn(…, bin): a parameter of an unnamed function @12b29354": CLAUDE_START,
  "setup/live-proofs/runlocked.mjs unread childSpawn(…, args): a parameter of an unnamed function @878dbc18": CLAUDE_START,
  "setup/live-proofs/runlocked.mjs unread run(…, log) @5ed0d222": "underLock hands run the proof's own temp folder and a function that writes the proof's log lines",
  "setup/live-proofs/runlocked.mjs unread execFileSync(…, c.claudeBin): checkRunnerConfig(readRunnerConfig(arg(argv, '--config'), se is a call whose answer is not read @a958a5f7": CLAUDE_VERSION,
  "setup/live-proofs/runlocked.mjs unread verifyBundle's mirror reaches spawnSync(…, ['--git-dir', mirror, 'bundle', 'verify', file]), and verifyBundle is called from other modules @5d821cdd": "git bundle verify on two paths: the runner config's mirror and the bundle the proof's own run left in its outbox",
  "setup/live-proofs/settings-names.mjs unread run(…, d): findInit(out) is a call whose answer is not read @3aebf2ba": LIVE_TESTS,
  "setup/live-proofs/settings-names.mjs value secret @4519cb0e": "a fixture file the live proof makes in its own temp folder, named `secret` (its text is the marker seen-<side>-7c1f): the word is a file name in a test prompt, not a credential",
  "setup/live-proofs/settings-names.mjs unread run(…, d): Object.freeze([ { id: 'allow', title: 'an allow rule lets a  is not read to its end @fe71caeb": LIVE_TESTS,
  "setup/live-proofs/settings-names.mjs unread runToEnd(…, c.claudeBin): checkInit(findInit(out), { role, profile, pin, args }) is a call whose answer is not read @0ce73cfe": CLAUDE_START,
  "setup/live-proofs/settings-names.mjs unread runToEnd's bin reaches childSpawn(…, bin), and runToEnd is called from other modules @1377338b": CLAUDE_START,
  "setup/live-proofs/settings-names.mjs unread runToEnd's args reaches childSpawn(…, args), and runToEnd is called from other modules @6ab99d41": CLAUDE_START,
  "setup/live-proofs/settings-names.mjs unread claudeVersion's bin reaches execFileSync(…, bin), and claudeVersion is called from other modules @97a91a5e": CLAUDE_VERSION,
  "setup/live-proofs/settings-names.mjs unread main's argv reaches arg(…, argv), and main is called from other modules @415dae43": "the proof's own command line, read for --config (a path), --product (a name) and --restore",
  "setup/live-proofs/settings-names.mjs unread runToEnd(…, c.claudeBin): d.readConfig(arg(argv, '--config')) is a call whose answer is not read @09442aee": CLAUDE_START,
  "setup/live-proofs/settings-names.mjs unread run(…, d): d.makeBase() is a call whose answer is not read @33ab196e": LIVE_TESTS,
  "setup/live-proofs/settings-names.mjs unread claude's args reaches runToEnd(…, args), and claude is called from other modules @e43b0132": CLAUDE_START,
  "setup/live-proofs/settings-names.mjs unread start's args reaches runToInit(…, args), and start is called from other modules @ae8656fa": CLAUDE_START,
  "setup/live-proofs/transcript-place.mjs unread version's bin reaches execFileSync(…, bin), and version is called from other modules @37189a6c": CLAUDE_VERSION,
  "setup/proofs.mjs unread noList(…, ownerHome): readUser(io, cfg.owner) is a call whose answer is not read @6556a4e2": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): io.readText(file) is a call whose answer is not read @2d0c1107": PROOF_ROWS,
  "setup/proofs.mjs unread proofList's cfg reaches noWrite(…, p('products', prod, 'store')), and proofList is called from other modules @8d3e8664": PROOF_ROWS,
  "setup/proofs.mjs unread proofList's cfg reaches noWrite(…, p(d)), and proofList is called from other modules @46598acc": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): cfg.products.map((prod) => [prod, runnerPlaces({ copiesRoot: is given a function whose answer is not read @1b180d51": PROOF_ROWS,
  "setup/proofs.mjs unread above passes its words on, and is not called here (it may be handed on as a value) @6e6dc9f8": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): walks.get(l.real) is a call whose answer is not read @6f9e859d": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): w.links.flatMap((x) => reach(`${B} cannot read ${x.at} (a li is given a function whose answer is not read @45575eac": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): w.named.map((x) => notTried(`${B} cannot read ${x} (inside $ is given a function whose answer is not read @768b9f46": PROOF_ROWS,
  "setup/proofs.mjs unread reach(…, x.at): a parameter of an unnamed function @a7ea4f22": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): make(q, l.kind) is a call whose answer is not read @cfc54bb7": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): make(q, l.kind).map((pr) => ({ ...pr, what: via ? `${pr.what is given a function whose answer is not read @96e5e18e": PROOF_ROWS,
  "setup/proofs.mjs unread readProof passes its words on, and is not called here (it may be handed on as a value) @ab6ebb34": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): homeOf(cfg, B) is a call whose answer is not read @93fdee0f": PROOF_ROWS,
  "setup/proofs.mjs unread proofList's cfg reaches proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky), and proofList is called from other modules @e9414952": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): places.flatMap(([prod, at]) => [at.copies, ...PRODUCT_OUTBOX is given a function whose answer is not read @da0b1b48": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): cfg.products.flatMap((prod) => noWrite((d) => `${B} cannot w is given a function whose answer is not read @6d6950c3": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): NO_WRITE.flatMap((d) => noWrite((q) => `${B} cannot write ${ is given a function whose answer is not read @7864abb3": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): places.flatMap(([prod, at]) => noWrite((d) => `${B} cannot w is given a function whose answer is not read @c2a82600": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): USERS.filter((u) => u !== B).flatMap((u) => noList((d) => `$ is given a function whose answer is not read @a9d0951f": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): FLAT_OUTBOX_ROLES.map((r) => join(outboxRootPath(cfg), r)) is given a function whose answer is not read @5a2bc9f8": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): FLAT_OUTBOX_ROLES.map((r) => join(outboxRootPath(cfg), r)).f is given a function whose answer is not read @7d74408a": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): proposalRows(cfg) is a call whose answer is not read @20b250b7": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): proposalRows(cfg).flatMap((row) => reach(`${B} cannot write  is given a function whose answer is not read @fab3ee5a": PROOF_ROWS,
  "setup/proofs.mjs unread proveList(…, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: sticky): (rules.odd ?? []).map((x) => notTried(`${B} cannot read the  is given a function whose answer is not read @bc84f16e": PROOF_ROWS,
  "setup/proofs.mjs unread noWrite(…, p('products', prod, 'store')): a parameter of an unnamed function @2cc004fb": PROOF_ROWS,
  "setup/proofs.mjs unread noWrite(…, p(d)): a parameter of an unnamed function @e3a3185d": PROOF_ROWS,
  "setup/proofs.mjs unread noList(…, homeOf(cfg, u)): homeOf(cfg, u) is a call whose answer is not read @af83e728": PROOF_ROWS,
  "setup/proofs.mjs unread noWrite(…, d): a parameter of an unnamed function @8767b4f0": PROOF_ROWS,
  "setup/proofs.mjs unread runProofs's cfg reaches proofList(…, cfg), and runProofs is called from other modules @3746eaba": PROOF_ROWS,
};
/** A finding's key in REVIEWED: file, kind, what, @site, and #n for the nth time that text is met in the file. */
function keysOf(rel, src) {
  const seen = new Map();
  return credentialArgFindings(src).map((x) => {
    const k = `${rel} ${x.kind} ${x.what} @${x.site}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    return { x, key: seen.get(k) > 1 ? `${k} #${seen.get(k)}` : k };
  });
}

test('R-0b-179 (b): no module outside the tests puts a credential on a command line, and every site the scan can not read has been looked at', () => {
  const files = sources(ROOT);
  assert.ok(files.length > 100, `only ${files.length} modules were found to read`);
  const fresh = []; const met = new Set();
  for (const f of files) {
    for (const { x, key } of keysOf(relative(ROOT, f), readFileSync(f, 'utf8'))) {
      if (REVIEWED[key]) met.add(key);
      else fresh.push(`${relative(ROOT, f)}:${x.line} ${key}\n    ${x.list}`);
    }
  }
  assert.deepEqual(fresh, [], 'pass a credential in the child\'s environment, a file it reads, or its stdin, never its arguments. A site the scan can not read: look at what reaches it, then add it to REVIEWED with why it is safe');
  assert.deepEqual(Object.keys(REVIEWED).filter((k) => !met.has(k)), [], 'a reviewed site no longer met: take it out');
  const counts = Object.fromEntries(Object.entries(SHARED).map(([n, why]) => [n, Object.values(REVIEWED).filter((r) => r === why).length]));
  assert.deepEqual(counts, SHARED_COUNT, 'a shared reason now covers more or fewer sites: check the new ones against it, then move the count');
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
  assert.deepEqual(said('export function f(io, list) { return io.run(BIN, list); }'), ["unread:f's list reaches run(…, list), and f is called from other modules"]);
  assert.ok(said("function wrap(a) { return a.map(String); }\nspawn(b, wrap(x));").some((x) => x.startsWith('unread:')));
  // Safe shapes stay quiet: a token in the child's environment, literal lists through a helper. (A Bearer string in env
  // was quiet here until r3 m2 made `Bearer ${` a finding in any string but an HTTP header's whole value.)
  for (const src of ["spawn('/usr/bin/gh', ['push'], { env: { GH_TOKEN: token } });", "function asUser(io, user, args) { return io.run('/usr/bin/sudo', ['-n', '-u', user, ...args]); }\nasUser(io, 'o', ['/bin/ls', dir]);"]) assert.deepEqual(said(src), [], src);
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
  assert.deepEqual(said('spawn(bin, makeList(cfg));'), ['unread:spawn(…, bin): bin is given no value here that is read', 'unread:spawn(…, makeList(cfg)): makeList(cfg) is a call whose answer is not read']);
  assert.deepEqual(said("const args = ['a'];\nspawn('/bin/x', args);"), []);
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
    'a command string from a call': ['execSync(makeCommand(cfg));', 'unread:execSync(…, makeCommand(cfg)): makeCommand(cfg) is a call whose answer is not read'],
    'a parameter whose caller gives a name with no value here': ["function push(io, v) { return io.run('/usr/bin/gh', ['--body', v]); }\npush(io, given);", 'unread:push(…, given): given is given no value here that is read'],
    'a helper that is not called here (c1)': ["function f(o) { return spawn('/x', ['a', o.v]); }", 'unread:f passes its words on, and is not called here (it may be handed on as a value)'],
    'a helper that returns nothing read': ["function mk() { build(); }\nspawn('/x', mk());", 'unread:spawn(…, mk()): mk returns nothing that is read'],
    'a destructured parameter': ["function go({ a }) { return spawn('/x', ['x', a]); }\ngo({ a: 'y' });", "unread:spawn(…, ['x', a]): a is given no value here that is read"],
    'more than six helpers': ["function h1(a){ return spawn('/x', a); }\nfunction h2(a){ return h1(a); }\nfunction h3(a){ return h2(a); }\nfunction h4(a){ return h3(a); }\nfunction h5(a){ return h4(a); }\nfunction h6(a){ return h5(a); }\nfunction h7(a){ return h6(a); }\nh7(['--x', token]);", 'unread:h6(…, a): passed on through more than 6 helpers'],
    'apply': ["spawn.apply(null, ['/x', ['a']]);", 'unread:spawn.apply(…)'],
    'an exported helper': ['export function f(io, list) { return io.run(BIN, list); }', "unread:f's list reaches run(…, list), and f is called from other modules"],
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

test('R-0b-179 (b, #556 r5): the environment, read-named calls and env.X are read, not passed', () => {
  const H = "import { spawnSync } from 'node:child_process';\nimport { readFile } from 'node:fs/promises';\nimport fsp from 'node:fs/promises';\n";
  const E = 'process.' + 'env';
  const plants = {
    'M1 an environment variable as a word': `spawnSync('gh', ['x', ${E}.GH_PAT]);`,
    'M1 an environment variable through a name': `const k2 = ${E}.ANTHROPIC_KEY;\nspawnSync('x', ['--', k2]);`,
    'M1 env -i K=V from the whole environment': `const git = (args) => spawnSync('/usr/bin/env', ['-i', ...Object.entries(${E}).map(([k, v]) => \`\${k}=\${v}\`), 'git', ...args]);\ngit(['x']);`,
    'M1 the environment spread into an object': `spawnSync('x', ['--', JSON.stringify({ ...${E} })]);`,
    'M1 the environment stringified': `spawnSync('x', ['--', JSON.stringify(${E})]);`,
    'M1 globalThis is not quiet': "spawnSync('x', ['--', globalThis.vault]);",
    'M1 a chain ending env': "export function f(o) { spawnSync('/usr/bin/env', ['-i', ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`)]); }",
    'M2 readFile(tokenFile)': "async function f(tokenFile) { spawnSync('x', ['--', await readFile(tokenFile, 'utf8')]); }\nf('/t');",
    'M2 fsp.readFile(p)': "async function f(p) { spawnSync('x', ['--', await fsp.readFile(p, 'utf8')]); }\nf('/t');",
    'M2 readKeyFile(p)': "import { readKeyFile } from './k.mjs';\nspawnSync('x', ['--', readKeyFile('/t')]);",
    // Each half of M2 pinned alone: a read-named call whose name ends like a path; a call ending source.
    'M2 readTokenPath(p)': "import { readTokenPath } from './k.mjs';\nspawnSync('x', ['--', readTokenPath('/t')]);",
    'M2 secretSource(p)': "import { secretSource } from './k.mjs';\nspawnSync('x', ['--', secretSource('/t')]);",
    // Exported with no caller here, so each is caught only by its own rule (not by globalThis at a caller).
    'M3 env.GITHUB_PAT': "export function f(env) { spawnSync('x', ['--', env.GITHUB_PAT]); }",
    'M3 ghEnv.value': "export function f(ghEnv) { spawnSync('x', ['--', ghEnv.value]); }",
    'M3 gitEnv.GIT_CONFIG_VALUE_0': "export function f(gitEnv) { spawnSync('x', ['--', gitEnv.GIT_CONFIG_VALUE_0]); }",
  };
  for (const [what, src] of Object.entries(plants)) assert.ok(said(H + src).length > 0, `${what} passed in silence`);
  // A variable not on the plain list is a finding (value), not only a listing.
  assert.ok(said(H + plants['M1 an environment variable as a word']).includes(`value:${E}.GH_PAT`));
  assert.ok(said(H + plants['M1 an environment variable through a name']).includes(`value:${E}.ANTHROPIC_KEY`));
  // M2: a read of a token file inside the function makes its site a reader site.
  assert.equal(said(H + plants['M2 readFile(tokenFile)']).filter((x) => x.startsWith('reader:')).length, 1);
  // The plain variables still pass.
  assert.deepEqual(said(H + `spawnSync('/bin/x', [${E}.HOME, \`\${${E}.TMPDIR}/a\`, ${E}.USER]);`), []);
  // m-a: a credential read at the module's top makes the sites that use it reader sites, in a function or not.
  const R = "import { readFileSync } from 'node:fs';\nconst tokenPath = '/k/t';\nconst t = readFileSync(tokenPath, 'utf8').trim();\n";
  const readerOf = (src) => said(H + R + src).filter((x) => x.startsWith('reader:'));
  assert.equal(readerOf("export function f(io) { const h = t.slice(0); return io.run('x', ['--', h]); }").length, 1);
  assert.equal(readerOf("export function f(io, w) { return io.run('x', ['--', w, t.length > 1 ? 'a' : 'b']); }").length, 1);
  // m-b: one element of a list named tokens is listed.
  assert.ok(said(H + "export function f(tokens) { spawnSync('x', ['--', tokens[0]]); }").some((x) => x.includes('one of a list of tokens')));
});

test('R-0b-179 (b, #556 r6): other names for process, an index into an environment, read verbs in any case, one of a list of tokens', () => {
  const H = "import { spawnSync } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\n";
  const P = 'pro' + 'cess';
  const plants = {
    '1 const p = process': `const p = ${P};\nspawnSync('x', ['--', p.env.GH_PAT]);`,
    '1 const { env } = process': `const { env } = ${P};\nspawnSync('x', ['--', env.GH_PAT]);`,
    '1 let { env: e } = process': `let { env: e } = ${P};\nspawnSync('x', ['--', e.GH_PAT]);`,
    "2 import { env } from 'node:process'": `import { env } from 'node:${P}';\nspawnSync('x', ['--', env.GH_PAT]);`,
    "2 import proc from 'node:process'": `import proc from 'node:${P}';\nspawnSync('x', ['--', proc.env.GH_PAT]);`,
    "2 require('node:process')": `const proc = require('node:${P}');\nspawnSync('x', ['--', proc.env.GH_PAT]);`,
    '3 env[k]': "export function f(env, k) { spawnSync('x', ['--', env[k]]); }",
    '3 gitEnv[0]': "export function f(gitEnv) { spawnSync('x', ['--', gitEnv[0]]); }",
    '3 childEnv[k] after Object.assign': `const childEnv = {};\nObject.assign(childEnv, ${P}.env);\nexport function f(k) { spawnSync('x', ['--', childEnv[k]]); }`,
    '3 childEnv[k] after a spread': `const childEnv = { ...${P}.env };\nexport function f(k) { spawnSync('x', ['--', childEnv[k]]); }`,
    '3 childEnv[k] filled in a for-of': `const childEnv = {};\nfor (const k of Object.keys(${P}.env)) childEnv[k] = ${P}.env[k];\nexport function f(k) { spawnSync('x', ['--', childEnv[k]]); }`,
    '4 ReadTokenPath': "import { ReadTokenPath } from './k.mjs';\nspawnSync('x', ['--', ReadTokenPath('/t')]);",
    '4 vault.ReadTokenPath()': "export function f(vault) { spawnSync('x', ['--', vault.ReadTokenPath()]); }",
    '4 decryptKeyPath': "import { decryptKeyPath } from './k.mjs';\nspawnSync('x', ['--', decryptKeyPath('/t')]);",
    '4 retrieveSecretPath': "import { retrieveSecretPath } from './k.mjs';\nspawnSync('x', ['--', retrieveSecretPath('/t')]);",
    '4 unsealPath': "import { unsealPath } from './k.mjs';\nspawnSync('x', ['--', unsealPath('/t')]);",
    '4 openTokenPath': "import { openTokenPath } from './k.mjs';\nspawnSync('x', ['--', openTokenPath('/t')]);",
    '5 tokens[0].value': "export function f(tokens) { spawnSync('x', ['--', tokens[0].value]); }",
    '5 tokens[0].text': "export function f(tokens) { spawnSync('x', ['--', tokens[0].text]); }",
    '5 const [first] = tokens': "export function f(tokens) { const [first] = tokens; spawnSync('x', ['--', first]); }",
    '5 for (const first of tokens)': "export function f(tokens) { for (const first of tokens) spawnSync('x', ['--', first]); }",
  };
  for (const [what, src] of Object.entries(plants)) assert.ok(said(H + src).length > 0, `${what} passed in silence`);
  // Each other name for process.env reads its variable as process.env's: a finding, not only a listing.
  for (const k of Object.keys(plants).filter((x) => /^[12] /.test(x))) assert.ok(said(H + plants[k]).includes(`value:${P}.env.GH_PAT`), k);
  // m-a: `let t; t = read…` and a destructured read at the top make the sites that use them reader sites.
  const readerOf = (src) => said(H + src).filter((x) => x.startsWith('reader:'));
  assert.equal(readerOf("const tokenPath = '/k/t';\nlet t;\nt = readFileSync(tokenPath, 'utf8');\nexport function f(io) { const h = t.slice(0); return io.run('x', ['--', h]); }").length, 1);
  assert.equal(readerOf("const tokenPath = '/k/t';\nconst { v } = JSON.parse(readFileSync(tokenPath, 'utf8'));\nexport function f(io, w) { return io.run('x', ['--', w, v ? 'a' : 'b']); }").length, 1);
  // Still quiet: an element of a list of files, a plain variable through another name for process.
  assert.deepEqual(said(H + "const files = ['/a', '/b'];\nfor (const f of files) spawnSync('/bin/cat', [f]);"), []);
  assert.deepEqual(said(H + `const { env } = ${P};\nspawnSync('/bin/x', [env.HOME]);`), []);
});

test('R-0b-179 (b, #556 r7): destructuring with defaults, process from require and import, the read verb in any case, a bracketed copy', () => {
  const H = "import { spawnSync } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\n";
  const P = 'pro' + 'cess';
  const plants = {
    'M1 const { env = {} } = process': `const { env = {} } = ${P};\nspawnSync('x', ['--', env.GH_PAT]);`,
    'M1 const { env: e = {} } = process': `const { env: e = {} } = ${P};\nspawnSync('x', ['--', e.GH_PAT]);`,
    "M2 const { env } = require('node:process')": `const { env } = require('node:${P}');\nspawnSync('x', ['--', env.GH_PAT]);`,
    "M2 const { env: E } = require('process')": `const { env: E } = require('${P}');\nspawnSync('x', ['--', E.GH_PAT]);`,
    "M2 require('node:process').env.X in place": `spawnSync('x', ['--', require('node:${P}').env.GH_PAT]);`,
    "M2 const e = require('node:process').env": `const e = require('node:${P}').env;\nspawnSync('x', ['--', e.GH_PAT]);`,
    "M2 require('./cfg.json').value": "spawnSync('x', ['--', require('./cfg.json').value]);",
    "M3 import { default as proc } from 'node:process'": `import { default as proc } from 'node:${P}';\nspawnSync('x', ['--', proc.env.GH_PAT]);`,
    'M4 READ_TOKEN_PATH()': "import { READ_TOKEN_PATH } from './k.mjs';\nspawnSync('x', ['--', READ_TOKEN_PATH()]);",
    'M4 READTokenPath()': "import { READTokenPath } from './k.mjs';\nspawnSync('x', ['--', READTokenPath()]);",
    'M4 DECRYPT_PATH()': "import { DECRYPT_PATH } from './k.mjs';\nspawnSync('x', ['--', DECRYPT_PATH()]);",
    'M4 GET_NAME()': "import { GET_NAME } from './k.mjs';\nspawnSync('x', ['--', GET_NAME()]);",
    'M4 vault.READ_TOKEN_PATH()': "export function f(vault) { spawnSync('x', ['--', vault.READ_TOKEN_PATH()]); }",
    'M4 vault.UNSEAL_PATH()': "export function f(vault) { spawnSync('x', ['--', vault.UNSEAL_PATH()]); }",
    'm1 _readTokenPath()': "import { _readTokenPath } from './k.mjs';\nspawnSync('x', ['--', _readTokenPath()]);",
    'M5 const p = (process)': `const p = (${P});\nspawnSync('x', ['--', p.env.GH_PAT]);`,
    "c3 import proc, { env } from 'node:process' (default)": `import proc, { env } from 'node:${P}';\nspawnSync('x', ['--', proc.env.GH_PAT]);`,
    "c3 import proc, { env } from 'node:process' (named)": `import proc, { env } from 'node:${P}';\nspawnSync('x', ['--', env.GH_PAT]);`,
    "c3 const p = await import('node:process')": `const p = await import('node:${P}');\nspawnSync('x', ['--', p.env.GH_PAT]);`,
    'c3 globalThis.process': `spawnSync('x', ['--', globalThis.${P}.env.GH_PAT]);`,
    'c1 tokens.at(0)': "export function f(tokens) { spawnSync('x', ['--', tokens.at(0)]); }",
    'c1 tokens.find(…)': "export function f(tokens) { spawnSync('x', ['--', tokens.find((t) => t.ok)]); }",
  };
  for (const [what, src] of Object.entries(plants)) assert.ok(said(H + src).length > 0, `${what} passed in silence`);
  // Each name for process.env reads its variable as process.env's: a finding, not only a listing.
  for (const k of Object.keys(plants).filter((x) => /^(?:M[1235]|c3) /.test(x) && !/cfg\.json/.test(x))) assert.ok(said(H + plants[k]).includes(`value:${P}.env.GH_PAT`), k);
  for (const k of ['c1 tokens.at(0)', 'c1 tokens.find(…)']) assert.ok(said(H + plants[k]).some((x) => x.includes('one of a list of tokens')), k);
  // m-a: a top-level destructured read with a default object is a reader site.
  const readerOf = (src) => said(H + src).filter((x) => x.startsWith('reader:'));
  assert.equal(readerOf("const tokenPath = '/k/t';\nconst { v = {} } = JSON.parse(readFileSync(tokenPath, 'utf8'));\nexport function f(io, w) { return io.run('x', ['--', w, v ? 'a' : 'b']); }").length, 1);
  // Still quiet: a plain variable through these names, verbs that are not verbs, a path from a helper named for one.
  for (const quiet of [
    `const { env = {} } = ${P};\nspawnSync('/bin/x', [env.HOME]);`,
    `const { env } = require('node:${P}');\nspawnSync('/bin/x', [env.HOME]);`,
    "import { readerPath, categoryPath, openingPath } from './k.mjs';\nspawnSync('/bin/x', [readerPath(), categoryPath(), openingPath()]);",
    "const { a = {}, b: { c } = {} } = JSON.parse('{}');\nspawnSync('/bin/x', ['--', 'y']);",
  ]) assert.deepEqual(said(H + quiet), [], quiet);
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
    // Before the plant: only the findings already looked at (REVIEWED); after it, what the plant added.
    assert.deepEqual(keysOf(rel, src).map((k) => k.key).filter((k) => !REVIEWED[k]), [], rel);
    const before = said(src).filter((x) => !x.startsWith('unread:'));
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

test('R-0b-179 (b, #556 r4): a word passes only when each part of it is read: calls, awaits, ${…} and + parts, argv0, a reader\'s sites', () => {
  const H = "import { spawnSync, execSync, spawn } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\n";
  const E = 'process.' + 'env.';
  // Each must give a finding of some kind (flag, value, text, unread or reader): none may pass in silence.
  const plants = {
    'M-A a program\'s answer as a word': "const r = spawnSync('git', ['config', 'x']);\nspawnSync('git', ['push', r.stdout.trim()]);",
    'M-A readFileSync as a word': "const p = '/k';\nspawnSync('git', ['x', readFileSync(p, 'utf8')]);",
    'M-A await vault.get()': "async function f(vault) { const v = await vault.get(); spawnSync('x', ['--', v]); }\nf(globalThis.vault);",
    'M-A await vault.get() inline': "async function f(vault) { spawnSync('x', ['--', await vault.get()]); }\nf(globalThis.vault);",
    'M-A JSON.parse(…).value': "const pemPath = '/k';\nspawnSync('x', ['--', JSON.parse(readFileSync(pemPath, 'utf8')).value]);",
    'M-A a helper fed readFileSync': "function h(w) { spawnSync('x', ['--', w]); }\nconst pemPath = '/k';\nh(readFileSync(pemPath));",
    'M-B ${v} in execSync': "function f({ v }) { execSync(`gh api ${v}`); }\nf({ v: 1 });",
    'M-B --body=${v}': "function f({ v }) { spawnSync('gh', [`--body=${v}`]); }\nf({ v: 1 });",
    "M-B 'Bearer ' + v": "function f({ v }) { spawnSync('curl', ['-H', 'Authorization: Bearer ' + v]); }\nf({ v: 1 });",
    'M-B a + operand': "function f({ v }) { spawnSync('curl', ['-H', 'X: ' + v]); }\nf({ v: 1 });",
    'M-B io.run one word at a time': "function f({ v }, io) { io.run('gh', 'api', v); }\nf({ v: 1 }, globalThis.io);",
    'M-C an exported function reading a key path': "export function planWall(io, cfg) { const keyPath = cfg.keyFile; const k = io.readText(keyPath); return io.run('/sbin/pfctl', ['-a', k]); }",
    'M-C cfg.watch.value': "export function planWall(io, cfg) { return io.run('/sbin/pfctl', ['-a', cfg.watch.value]); }",
    'M-C a header from a cat of tokenPath': "const tokenPath = (c) => c.dir + '/t';\nexport function planWall(io, cfg) { const f = tokenPath(cfg); const r = io.run('/usr/bin/sudo', ['-u', 'o', '/bin/cat', f]); const h = String(r.stdout).trim(); return io.run('curl', ['-H', h]); }",
    'M-C readSecret in a function': "export function setupX(io) { const t = io.readSecret('Paste'); const z = t.trim(); return io.run('x', ['--', z]); }",
    'm1 argv0': `const t = ${E}GH_TOKEN;\nspawn('/bin/x', ['a'], { argv0: t });`,
    'm1 argv0 in a named options object': "function f({ v }) { const o = { argv0: v }; spawn('/bin/x', ['a'], o); }\nf({ v: 1 });",
    "m2 'Bearer ' + t outside a header": `const t = ${E}X;\nconst h = 'Bearer ' + t;`,
    'm6 Reflect.apply(spawn, …)': "function f(args) { Reflect.apply(spawn, null, ['x', args]); }",
    'm6 shell: true in a named options object': "function f({ v }) { const o = { shell: true }; spawn(`ls ${v}`, [], o); }\nf({ v: 1 });",
    'env -i K=V from an imported env maker': "import { mkEnv } from './e.mjs';\nconst git = (env, args) => spawnSync('/usr/bin/env', ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'git', ...args]);\ngit(mkEnv({ extra: 1 }), ['x']);",
  };
  for (const [what, src] of Object.entries(plants)) assert.ok(said(H + src).length > 0, `${what} passed in silence`);
  // M-C: a site inside a function that reads a credential is kind reader, so a reason written for an unread site can't cover it.
  const reader = (src) => said(H + src).filter((x) => x.startsWith('reader:'));
  assert.equal(reader(plants['M-C a header from a cat of tokenPath']).length, 1);
  assert.equal(reader(plants['M-C readSecret in a function']).length, 1);
  assert.equal(reader(plants['M-C an exported function reading a key path']).length, 1);
  // Reading a file whose last name part is not a credential's (host.lock's path, held in a config's key names) is not.
  assert.deepEqual(reader("export function chk(io, cfg) { const k = keysOf(cfg); const r = io.run('/bin/cat', [k.hostLockPath]); return io.run('x', ['--', r.stdout]); }"), []);
  // Sites are told apart by their call text, not only the function or message.
  const two = credentialArgFindings(H + "export function f(io, a, b) { io.run('/x', [a]); io.run('/y', [b]); }").filter((x) => x.kind === 'unread');
  assert.equal(new Set(two.map((x) => x.site)).size, two.length);
  // m1: argv0 is read like any word; c1: the header names it.
  assert.ok(said(`const t = ${E}GH_TOKEN;\nspawn('/bin/x', ['a'], { argv0: t });`).includes('value:process.env.GH_TOKEN'));
  // The safe shapes the leaf rule reads through stay quiet, unread included.
  const I = "import { join } from 'node:path';\nimport { randomUUID } from 'node:crypto';\n";
  for (const src of [
    "spawnSync('/bin/x', [join('/a', 'b'), String(3), `--n=${Math.max(1, 2)}`]);",
    "const dirs = ['/a', '/b'];\nspawnSync('/bin/ls', dirs.map((d) => `${d}/x`));",
    "spawnSync('/bin/x', [randomUUID(), new Date().toISOString(), process.pid > 1 ? 'a' : 'b']);",
  ]) assert.deepEqual(said(H + I + src), [], src);
});

/**
 * #556 r8 (L1186) done rule: every plant any audit round has made, in one corpus (credential-args.plants.json, keyed
 * "r<round> <name>"; r0 is the first planted-credential test, r8 the r8 auditor's 136, r8L the lane's own r8 plants,
 * copied from the test below). Each entry is [strength, source]: what the plant is said as at its strongest, a finding
 * (flag, value or text), a reader site, or a listing (unread). No plant may be said more weakly than its entry: a
 * finding that becomes a listing is a regression, even though the listing still fails closed. One said more strongly
 * fails too, so the entry is moved up when a fix lands. A plant left silent is a stated limit, named in LIMITS with its
 * ruling. When made (#556 r8) no plant was weaker than on the r7 scan, and 60 were stronger. r9 added twelve plants, r10 fourteen more.
 */
const LIMITS = {
  // L1186 m4: a read verb is told from the rest of a name by case or _ (readTokenPath, READ_TOKEN_PATH, read_token).
  // All lowercase has no edge to find; reading every name holding "read" would list ordinary names (thread, already).
  // The runtime guard refuses a registered token on any command line whatever the name of what read it.
  'r8 lower readtokenpath': 'a read verb in an all-lowercase name',
};
test('R-0b-179 (b, #556 r8): every plant from every audit round is a finding, listed, or a reader site, as strongly as recorded, but the stated limits', () => {
  const corpus = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'credential-args.plants.json'), 'utf8'));
  assert.ok(Object.keys(corpus).length >= 341, 'the corpus lost plants');
  // Each entry is exactly [strength, source] (#556 r9 cosmetic): a third element would be quietly dropped.
  const bad = Object.entries(corpus).filter(([, e]) => !Array.isArray(e) || e.length !== 2 || !['finding', 'reader', 'listed', 'silent'].includes(e[0]) || typeof e[1] !== 'string').map(([k]) => k);
  assert.deepEqual(bad, [], 'a corpus entry is not [strength, source]');
  const strength = (src) => {
    const kinds = credentialArgFindings(src).map((x) => x.kind);
    return kinds.some((x) => /^(?:flag|value|text)$/.test(x)) ? 'finding' : kinds.includes('reader') ? 'reader' : kinds.length ? 'listed' : 'silent';
  };
  const silent = Object.entries(corpus).filter(([, [, src]]) => strength(src) === 'silent').map(([k]) => k);
  assert.deepEqual(silent, Object.keys(LIMITS), 'a plant passed in silence (fix the cause, or name it a stated limit with its ruling)');
  const moved = Object.entries(corpus).map(([k, [want, src]]) => [k, want, strength(src)]).filter(([, want, now]) => want !== now);
  assert.deepEqual(moved, [], 'a plant is said more weakly than recorded (a regression), or more strongly (move its entry up)');
});

test('R-0b-179 (b, #556 r8): a tail is carried across a helper and into a default; process itself as a value is listed', () => {
  const H = "import { spawnSync } from 'node:child_process';\n";
  const P = 'pro' + 'cess';
  const V = `value:${P}.env.GH_PAT`;
  // Each is read to the credential: a finding, not only a listing.
  const found = {
    'a helper given process': `function f(p) { spawnSync('x', ['--', p.env.GH_PAT]); }\nf(${P});`,
    'two helpers deep': `function f(p) { spawnSync('x', ['--', p.env.GH_PAT]); }\nfunction g(q) { f(q); }\ng(${P});`,
    'a helper that copies its parameter': `function f(p) { const q = p; spawnSync('x', ['--', q.env.GH_PAT]); }\nf(${P});`,
    'a helper returning a list with p.env.X': `function mk(p) { return ['--', p.env.GH_PAT]; }\nspawnSync('x', mk(${P}));`,
    'a default that is a credential': `function f(t = ${P}.env.GH_PAT) { spawnSync('x', ['--', t]); }\nf();`,
    'an arrow default': `const f = (t = ${P}.env.GH_PAT) => spawnSync('x', ['--', t]);\nf();`,
    'a default of process': `function f(p = ${P}) { spawnSync('x', ['--', p.env.GH_PAT]); }\nf();`,
    'require(`process`) in place': `spawnSync('x', ['--', require(\`${P}\`).env.GH_PAT]);`,
    'import(`process`) awaited in place': `spawnSync('x', ['--', (await import(\`${P}\`)).env.GH_PAT]);`,
  };
  for (const [what, src] of Object.entries(found)) assert.ok(said(H + src).includes(V), `${what}: ${JSON.stringify(said(H + src))}`);
  // Where the tail is not carried, process as a value is listed, never passed (failing closed).
  const listed = {
    'a helper returning process': `function g() { return ${P}; }\nspawnSync('x', ['--', g().env.GH_PAT]);`,
    'process in an object': `const o = { p: ${P} };\nspawnSync('x', ['--', o.p.env.GH_PAT]);`,
    'a loop over [process]': `for (const p of [${P}]) spawnSync('x', ['--', p.env.GH_PAT]);`,
  };
  for (const [what, src] of Object.entries(listed)) assert.ok(said(H + src).some((x) => x.includes('process as a value')), `${what}: ${JSON.stringify(said(H + src))}`);
  // Still quiet: process's plain parts, a default that is a plain value.
  for (const quiet of [
    `spawnSync('/bin/x', [String(${P}.pid), ${P}.platform, ${P}.cwd()]);`,
    "function f(dir = '/tmp') { spawnSync('/bin/ls', [dir]); }\nf();",
  ]) assert.deepEqual(said(H + quiet), [], quiet);
});
