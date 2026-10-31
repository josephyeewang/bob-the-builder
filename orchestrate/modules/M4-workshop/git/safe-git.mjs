// The one way any plain script in M4 or M11 runs git (review 0b-4 M5).
//
// A worker controls everything in its copy, including .git/config, hooks, attributes and
// environment it can leave behind. So every call here:
//   - starts from an empty environment (fixed PATH, private HOME, no inherited GIT_* or pager);
//   - ignores the system and global git config;
//   - passes the safe settings through the environment (GIT_CONFIG_COUNT/KEY/VALUE), so a git
//     that another program starts (the secret scanner) gets them too;
//   - names the repository explicitly (GIT_DIR) and logs it, so a test can prove no call ran
//     inside a worker's copy except save-work;
//   - refuses a repository any of whose config files (its own, its worktrees', its submodules', found
//     through a pointer file or commondir) sets a key not on a short list known to start nothing
//     (LEAD-CALLS L49: deny by default), and turns off outside diff programs and text conversion on
//     every command that accepts the flags.
// Capability note: checked against Git 2.54.0 on 29 Oct 2026; requires git >= 2.42.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, lstatSync, statSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export const MIN_GIT = [2, 42];

// Settings that stop git from running any program a repository's own files could name, and from fetching
// submodules, bundle links or through a proxy (LEAD-CALLS L36). Since L49 they are the second layer: a repository
// whose config sets anything off the safe list is refused before git runs. They come last, so they win over the
// repository's own config. `core.hooksPath` names a file, so no hook can be found under it. They reach only the git
// this process starts: for a fetch from a local path, git clears GIT_CONFIG_COUNT before the source's upload side
// runs (checked on git 2.54.0, 30 Oct 2026), which holds because that side ignores a repository's program keys.
// Where git may go is decided by the call alone (L51): see `placeWhy`.
export const SAFE_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.editor', '/usr/bin/false'],
  ['sequence.editor', '/usr/bin/false'],
  ['core.sshCommand', '/usr/bin/false'],
  ['core.askPass', '/usr/bin/false'],
  ['core.attributesFile', '/dev/null'],
  ['interactive.diffFilter', 'cat'],
  ['credential.helper', ''],
  // Signatures: never checked or made, so no signing program runs (a commit with a signature header and
  // log.showSignature ran the repository's gpg.program on a plain `git log`).
  ['gpg.program', '/usr/bin/false'],
  ['gpg.openpgp.program', '/usr/bin/false'],
  ['gpg.x509.program', '/usr/bin/false'],
  ['gpg.ssh.program', '/usr/bin/false'],
  ['gpg.ssh.defaultKeyCommand', '/usr/bin/false'],
  ['log.showSignature', 'false'],
  ['merge.verifySignatures', 'false'],
  ['pull.verifySignatures', 'false'],
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
  ['tag.forceSignAnnotated', 'false'],
  ['push.gpgSign', 'false'],
  // Fetches go only where the call names: no submodules, bundle links or proxy.
  ['submodule.recurse', 'false'],
  ['fetch.recurseSubmodules', 'false'],
  ['push.recurseSubmodules', 'no'],
  ['transfer.bundleURI', 'false'],
  ['fetch.bundleURI', ''],
  ['http.proxy', ''],
  ['protocol.ext.allow', 'never'],
  // A repository nested in the work tree is never looked into, so its own config is never read (L49).
  ['diff.ignoreSubmodules', 'all'],
  ['status.submoduleSummary', 'false'],
  ['diff.submodule', 'short'],
  ['protocol.file.allow', 'always'], // local bundles and the mirror are files
  ['transfer.fsckObjects', 'true'],
  ['fetch.fsckObjects', 'true'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['advice.detachedHead', 'false'],
  ['init.defaultBranch', 'main'],
  ['user.name', 'orchestrate'],
  ['user.email', 'orchestrate@localhost'],
]);

const FIXED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
let privateHome = null;
const HOME_PREFIX = 'orch-git-home-';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove this script's own empty git homes older than a day. The exit handler below doesn't run when a process is
 * killed, so they pile up (lead, 29 Oct 2026). Only real folders (not links) with our prefix, owned by this user and
 * empty: rmdirSync refuses a folder with anything in it. Never throws. Returns the names removed.
 */
export function sweepStaleHomes({ dir = tmpdir(), now = Date.now(), maxAgeMs = DAY_MS } = {}) {
  const removed = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return removed; }
  for (const n of names) {
    if (!n.startsWith(HOME_PREFIX)) continue;
    try {
      const st = lstatSync(join(dir, n));
      if (!st.isDirectory() || st.uid !== process.getuid?.() || now - st.mtimeMs < maxAgeMs) continue;
      rmdirSync(join(dir, n));
      removed.push(n);
    } catch { /* not empty, or gone already: leave it */ }
  }
  return removed;
}

// The private git home is made once per process and removed when the process ends; stale ones are swept first.
const home = () => {
  if (!privateHome) {
    sweepStaleHomes();
    privateHome = mkdtempSync(join(tmpdir(), HOME_PREFIX));
    const made = privateHome;
    process.once('exit', () => rmSync(made, { recursive: true, force: true }));
  }
  return privateHome;
};

// Every call made, for the "no git inside a worker copy" test.
export const callLog = [];

/** The environment for one git call. `extraConfig` (pairs) is appended after SAFE_CONFIG. */
export function safeGitEnv({ gitDir, commonDir, workTree, extraConfig = [] } = {}) {
  const cfg = [...SAFE_CONFIG, ...extraConfig];
  const env = {
    PATH: FIXED_PATH,
    HOME: home(),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: '/usr/bin/false',
    GIT_SEQUENCE_EDITOR: '/usr/bin/false',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  if (gitDir) env.GIT_DIR = gitDir;
  if (commonDir) env.GIT_COMMON_DIR = commonDir;
  if (workTree) env.GIT_WORK_TREE = workTree;
  return env;
}

// Repository config keys known to start no program (LEAD-CALLS L49). A remote's address or a branch's remote may
// sit here, but no call follows one: every command that reaches another repository must name the place itself
// (L51, `placeWhy`). Any other key in any of the repository's config files is a refusal that names it: deny by
// default, since pinning one key at a time missed twice (L36; then hooks defined in config and bundle links). Keys as
// git lists them: section and key in lower case, the name between kept as written. Checked against git 2.54.0, 30 Oct 2026.
export const INERT_KEYS = Object.freeze(new Set([
  'core.repositoryformatversion', 'core.bare', 'core.filemode', 'core.logallrefupdates', 'core.ignorecase',
  'core.precomposeunicode', 'core.symlinks', 'extensions.objectformat', 'extensions.worktreeconfig',
  'extensions.refstorage', 'user.name', 'user.email',
  // Common in ordinary repositories (#32 round 2, Minor 6); the L49 sweep plants each with a program and an address.
  'core.autocrlf', 'core.untrackedcache', 'extensions.relativeworktrees',
]));
// A remote's name never holds `:` or `/`: a remote with no address of its own is fetched from its name, so a name
// like an address was a fetch from there (#32 round 2, Minors 1 and 2). `.`, `..` and a name starting with `~` are
// refused too: `branch.main.remote = ..` fetched the folder above (#32 round 3). `branch.<name>.remote` names one the
// same way.
const REMOTE_NAME = '(?![~])(?!\\.\\.?\\.[a-z-]+$)[^\\n:/]+';
export const PLAIN_REMOTE = /^(?![-~])(?!\.\.?$)[^\s:/]+$/;
const INERT_NAMED = new RegExp(`^(?:remote\\.${REMOTE_NAME}\\.(?:fetch|gh-resolved)|branch\\.[^\\n]+\\.(?:merge|rebase|vscode-merge-base))$`);
const REMOTE_KEY = /^branch\.[^\n]+\.remote$/;
const URL_KEY = new RegExp(`^remote\\.${REMOTE_NAME}\\.(?:url|pushurl)$`);
// A plain https, ssh or file address, an scp-style ssh address, or a local path: never `<helper>::`. A host that starts
// like an option is refused here too, though git already rejects one and core.sshCommand is pinned to a program
// that does nothing.
export const PLAIN_URL = /^(?:(?:https|ssh|file):\/\/(?!-)[^\s]*|\/[^\s]*|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!-)[^\s]+)$/;

/** Whether `key` (as git lists it) with `value` is on the safe list. */
export function inertSetting(key, value) {
  if (INERT_KEYS.has(key) || INERT_NAMED.test(key)) return true;
  if (REMOTE_KEY.test(key)) return typeof value === 'string' && PLAIN_REMOTE.test(value);
  return URL_KEY.test(key) && typeof value === 'string' && PLAIN_URL.test(value);
}

const statOf = (p) => { try { return statSync(p); } catch { return null; } };
const lstatOf = (p) => { try { return lstatSync(p); } catch { return null; } };

/**
 * The one path in a pointer file (`.git` as `gitdir: <path>`) or `commondir`, or null when git could read it
 * differently from this. Git drops only line ends from the end and takes the rest as it is, so anything else around
 * the path is refused: a space, tab or other blank at either end, a byte-order mark, a NUL, a carriage return, a
 * second line, a path that is not plain UTF-8, an empty path (#32 round 2, M1).
 */
export function pointerPath(buf, prefix = '') {
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return null;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!body.startsWith(prefix)) return null;
  const p = body.slice(prefix.length);
  if (p === '' || /[\n\r\0\uFEFF]/.test(p) || /^\s|\s$/.test(p)) return null;
  return p;
}

// Where a path read from `file` leads, with `..` and links taken through the real folders as git does (Node's
// resolve would cancel `..` by its text). A relative path is joined to the text of the file's folder, as git joins it.
const leadsTo = (file, p) => realpathSync.native(isAbsolute(p) ? p : `${file.slice(0, file.lastIndexOf('/') + 1)}${p}`);

// Whether real path `p` is `folder` or inside it.
const within = (p, folder) => p === folder || p.startsWith(`${folder}/`);

/**
 * The real folders git will use for `gitDir` (`dir`, and `common` from its commondir) and every config file they,
 * their worktrees and their submodules have, or { why }. A `.git` pointer file and `commondir` are read here, once,
 * and git is handed both folders, so git never reads either itself (#32 round 2, M1). Every place they lead must be
 * inside the repository (#32 round 3, L51): `.git` is not a link; a pointer leads only to a linked worktree's own
 * folder (`<common>/worktrees/<name>`) whose `gitdir` file names this pointer back; a commondir only from such a
 * folder to the `<common>` two levels up; and every link inside `common` stays inside it (or inside the objects
 * folders the call allows). `{ missing: true }` comes with the refusal when nothing is at `gitDir` (only `git init`
 * may run there).
 */
export function repoConfigFiles(gitDir, { allowObjects = [] } = {}) {
  const l = lstatOf(gitDir);
  if (!l) return { why: 'its .git is missing', missing: true };
  const s = statOf(gitDir);
  if (!s) return { why: 'its .git is a link that leads nowhere' };
  if (l.isSymbolicLink()) return { why: `its .git is a link (to ${realpathSync.native(gitDir)}), not the repository's own folder` };
  let dir;
  let pointer = false;
  if (s.isFile()) {
    const p = pointerPath(readFileSync(gitDir), 'gitdir: ');
    if (p === null) return { why: 'its .git is a file but not a pointer git and this check read the same way' };
    try { dir = leadsTo(gitDir, p); } catch { return { why: 'its .git pointer does not lead to a folder' }; }
    if (!statOf(dir)?.isDirectory()) return { why: 'its .git pointer does not lead to a folder' };
    pointer = true;
  } else if (s.isDirectory()) dir = realpathSync.native(gitDir);
  else return { why: 'its .git is neither a folder nor a pointer file' };
  let common = dir;
  const cd = join(dir, 'commondir');
  const c = lstatOf(cd);
  if (c) {
    const p = c.isFile() ? pointerPath(readFileSync(cd)) : null;
    if (p === null) return { why: 'its commondir is not one path git and this check read the same way' };
    try { common = leadsTo(cd, p); } catch { return { why: 'its commondir does not lead to a folder' }; }
    if (!statOf(common)?.isDirectory()) return { why: 'its commondir does not lead to a folder' };
    if (dir !== join(common, 'worktrees', dir.slice(dir.lastIndexOf('/') + 1))) {
      return { why: `its commondir leads outside the repository, to ${common}` };
    }
  }
  if (pointer) {
    if (common === dir) return { why: `its .git pointer leads to ${dir}, which is not a linked worktree's own folder` };
    const back = join(dir, 'gitdir');
    let named = null;
    try { const p = lstatOf(back)?.isFile() ? pointerPath(readFileSync(back)) : null; named = p === null ? null : leadsTo(back, p); } catch { /* refused below */ }
    if (named !== realpathSync.native(gitDir)) return { why: `its .git pointer leads to ${dir}, a worktree folder that does not name this pointer back` };
  }
  const outside = linkOutside(common, allowObjects);
  if (outside) return { why: outside };
  const odd = oddFiles(dir, common, allowObjects);
  if (odd) return { why: odd };
  const found = new Map();
  const add = (f) => { const st = statOf(f); if (st) found.set(realpathSync(f), f); };
  for (const base of new Set([dir, common])) {
    add(join(base, 'config'));
    add(join(base, 'config.worktree'));
  }
  for (const w of statOf(join(common, 'worktrees'))?.isDirectory() ? readdirSync(join(common, 'worktrees')) : []) {
    add(join(common, 'worktrees', w, 'config'));
    add(join(common, 'worktrees', w, 'config.worktree'));
  }
  // Submodules' own folders, nested to any depth (a submodule's name may hold slashes).
  const seen = new Set();
  let budget = 20000;
  const walk = (d) => {
    const real = realpathSync(d);
    if (seen.has(real)) return;
    seen.add(real);
    for (const n of readdirSync(d)) {
      if ((budget -= 1) < 0) throw new Error('too many files under modules');
      const p = join(d, n);
      const st = statOf(p);
      if (st?.isDirectory()) walk(p);
      else if (n === 'config' || n === 'config.worktree') add(p);
    }
  };
  try {
    for (const base of new Set([dir, common])) if (statOf(join(base, 'modules'))?.isDirectory()) walk(join(base, 'modules'));
  } catch (e) { return { why: `its submodule folders could not be read: ${e.message}` }; }
  return { dir, common, files: [...found.values()] };
}

// How many entries the walk for links reads before it gives up and refuses.
const LINK_WALK_MAX = 1_000_000;

/**
 * The first link anywhere in `common` that leads outside it (and outside every folder in `allowObjects`), as a
 * refusal that names it, or null (#32 round 3, L51). A link that leads nowhere is refused too. Links are not
 * followed, so each folder is read once. An `objects` folder or a ref linked to another repository let git read or
 * write there.
 */
function linkOutside(common, allowObjects) {
  const allowed = allowObjects.map((p) => { try { return realpathSync.native(p); } catch { return null; } }).filter(Boolean);
  let budget = LINK_WALK_MAX;
  const stack = [common];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (e) { return `its folder ${d} could not be read: ${e.code ?? e.message}`; }
    if ((budget -= entries.length) < 0) return 'it has too many files to check for links';
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isSymbolicLink()) {
        let real = null;
        try { real = realpathSync.native(p); } catch { /* leads nowhere */ }
        const name = p.slice(common.length + 1);
        if (real === null) return `its ${name} is a link that leads nowhere`;
        if (!within(real, common) && !allowed.some((a) => within(real, a))) return `its ${name} is a link to ${real}, outside the repository`;
      }
    }
  }
  return null;
}

/**
 * Why files outside the config that can still send git elsewhere must stop the run, or null (#32 round 2, Minors 3
 * and 4): the old-style remote files (`remotes/<name>`, `branches/<name>`), which can name an address, and a
 * borrowed-objects list (`objects/info/alternates`), which lets git read another repository's objects. Deny by
 * default: either folder holding anything, or an alternates file naming any folder but those in `allowObjects`.
 */
function oddFiles(dir, common, allowObjects) {
  const allowed = new Set(allowObjects.map((p) => { try { return realpathSync.native(p); } catch { return null; } }).filter(Boolean));
  for (const base of new Set([dir, common])) {
    for (const legacy of ['remotes', 'branches']) {
      const p = join(base, legacy);
      const st = lstatOf(p);
      if (st && (!st.isDirectory() || readdirSync(p).length)) return `it has old-style remote files in ${legacy}`;
    }
    if (lstatOf(join(base, 'objects', 'info', 'http-alternates'))) return 'it has objects/info/http-alternates';
    const alt = join(base, 'objects', 'info', 'alternates');
    const a = lstatOf(alt);
    if (!a) continue;
    if (!a.isFile()) return 'its objects/info/alternates is not a plain file';
    const objects = join(base, 'objects');
    for (const line of readFileSync(alt, 'utf8').split('\n').filter((x) => x !== '')) {
      let real = null;
      try { real = leadsTo(`${objects}/`, line); } catch { /* leads nowhere: refused below */ }
      if (!allowed.has(real)) return 'it borrows objects from another repository (objects/info/alternates)';
    }
  }
  return null;
}

/**
 * Runs one git and resolves { code, stdout, stderr }; never throws. Git starts in a process group of its own with
 * no terminal, so nothing it starts (ssh, a credential helper) can wait on a password typed there. At `timeoutMs`
 * the whole group is killed and the call ends at once, even if a program that left the group keeps the output open
 * (lead's standing rule, 30 Oct 2026: no call may wait forever).
 */
function runChild(bin, argv, { cwd, env, input = null, timeoutMs }) {
  return new Promise((resolve) => {
    const out = []; let err = ''; let ended = false; let timer = null;
    const end = (r) => { if (ended) return; ended = true; clearTimeout(timer); resolve(r); };
    let child;
    try { child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); } catch (e) { end({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message) }); return; }
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group has already ended */ }
      for (const s of [child.stdin, child.stdout, child.stderr]) s.destroy();
      end({ code: -1, stdout: Buffer.concat(out), stderr: `${err}safe-git: git did not end within ${timeoutMs} ms and was stopped` });
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => end({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message) }));
    child.on('close', (code, signal) => end({ code: code ?? (signal ? -1 : 0), stdout: Buffer.concat(out), stderr: err }));
    child.stdin.on('error', () => { /* git closed its input early; its exit code decides */ });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/** The keys and values in one config file, read by git without following its includes, or { why }. */
async function readConfigFile(file, { gitBin, timeoutMs }) {
  const r = await runChild(gitBin, ['config', '--file', file, '--no-includes', '--list', '-z'], { cwd: home(), env: safeGitEnv(), timeoutMs });
  if (r.code !== 0) return { why: r.stderr.trim().slice(0, 200) || `exit ${r.code}` };
  const entries = r.stdout.toString('utf8').split('\0').filter((x) => x !== '').map((x) => {
    const nl = x.indexOf('\n');
    return nl < 0 ? [x, undefined] : [x.slice(0, nl), x.slice(nl + 1)];
  });
  return { entries };
}

// A config file's name for a refusal: from the repository's own folder, or from the common folder it shares.
const labelOf = (f, { dir, common }) => {
  if (f.startsWith(`${dir}/`)) return f.slice(dir.length + 1);
  if (f.startsWith(`${common}/`)) return `${f.slice(common.length + 1)} in the common folder`;
  return f;
};

async function checkRepo(gitDir, { gitBin = 'git', timeoutMs = 30000, allowObjects } = {}) {
  let found;
  try { found = repoConfigFiles(gitDir, { allowObjects }); } catch (e) { return { why: `its folders could not be read: ${e.message}` }; }
  if (found.why) return { why: found.why, missing: found.missing };
  const bad = [];
  for (const f of found.files) {
    const r = await readConfigFile(f, { gitBin, timeoutMs });
    const where = labelOf(f, found);
    if (r.why) return { why: `its config ${where} could not be read: ${r.why}` };
    for (const [k, v] of r.entries) if (!inertSetting(k, v)) bad.push(`${k} (${where})`);
  }
  if (bad.length) return { why: `its config sets what is not on the safe list: ${bad.join(', ')}` };
  return { dir: found.dir, common: found.common };
}

/**
 * Why the repository at `gitDir` must not be run, or null. Every config file it has is read, including what
 * worktrees and submodules have and what a pointer file or commondir leads to; any key off the safe list is a
 * refusal that names it, and so is an include. Old-style remote files and a borrowed-objects list are refused,
 * and so is a missing or dangling `.git`. A config that can't be read is a refusal: fail closed.
 */
export async function repoConfigWhy(gitDir, opts) {
  return (await checkRepo(gitDir, opts)).why ?? null;
}

// Diff-family commands, which accept the two flags that turn off outside diff programs and text conversion.
const DIFF_COMMANDS = new Set(['log', 'show', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'whatchanged', 'format-patch', 'range-diff']);
const NO_PROGRAMS = ['--no-ext-diff', '--no-textconv'];
// Options before the command that take the next word as their value.
const GLOBAL_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

// Where the command is in `args`: the first word after the options that come before it (args.length if none).
const commandAt = (args) => {
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    if (GLOBAL_WITH_VALUE.has(a)) i += 2;
    else if (a.startsWith('-')) i += 1;
    else break;
  }
  return i;
};

// Commands that reach another repository (LEAD-CALLS L51). Each runs only when the call itself names the place, as
// its first word that is not an option: an absolute local path (the mirror, a bundle, a copy), or the one https
// address the call passes as `address` (the push script's GitHub). Never a remote's name, and never the form with no
// place, where git would take one from the repository's own config, which a worker can write.
const NAMED_PLACE = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone']);
// Commands that take the place from the repository's own files, or reach the network some other way: never run.
const NEVER_RUN = new Set(['remote', 'submodule', 'maintenance', 'request-pull', 'send-pack', 'fetch-pack', 'backfill', 'http-fetch',
  'http-push', 'upload-pack', 'receive-pack', 'upload-archive', 'daemon', 'instaweb', 'send-email', 'imap-send', 'svn', 'p4',
  'cvsimport', 'cvsexportcommit', 'cvsserver', 'archimport', 'quiltimport', 'lfs', 'annex']);
// The options a named-place command may carry. None takes a value, so none can hide the place or name another.
const PLACE_FLAGS = new Set(['-q', '--quiet', '-v', '--verbose', '-n', '--no-tags', '--tags', '--no-write-fetch-head', '--no-auto-gc',
  '--no-auto-maintenance', '--no-recurse-submodules', '--update-head-ok', '--porcelain', '--atomic', '--no-verify', '--heads', '--refs',
  '-f', '--force', '--dry-run', '--progress', '--no-progress', '--exit-code', '--ff-only', '--no-rebase', '--no-edit']);

/**
 * Why a call must not run for where it could send git, or null (#32 round 3, L51). `at` is where the command is in
 * `args`.
 */
export function placeWhy(args, at, address) {
  const cmd = String(args[at]);
  const rest = args.slice(at + 1).map(String);
  if (NEVER_RUN.has(cmd) || (cmd === 'archive' && rest.some((a) => a.startsWith('--remote') || a.startsWith('--exec')))) {
    return `git ${cmd} can reach another repository the call does not name, so safe-git never runs it`;
  }
  if (!NAMED_PLACE.has(cmd)) return null;
  let place = null;
  let options = true;
  for (const a of rest) {
    if (options && (a === '--' || a === '--end-of-options')) options = false;
    else if (options && a.startsWith('-')) {
      if (!PLACE_FLAGS.has(a)) return `git ${cmd} with ${a}: only plain switches may come with a command that reaches another repository`;
    } else if (place === null) place = a;
  }
  if (place === null) return `git ${cmd} names no place, so git would take one from the repository's own config`;
  if (place.startsWith('/') || (typeof address === 'string' && address.startsWith('https://') && place === address)) return null;
  return `git ${cmd} names ${JSON.stringify(place)}: only an absolute local path, or the address the call allows, may be named`;
}

/** `args` with the no-program flags right after a diff-family command (once each); other commands unchanged. */
export function withNoPrograms(args) {
  const i = commandAt(args);
  if (i >= args.length || !DIFF_COMMANDS.has(args[i])) return args;
  const add = NO_PROGRAMS.filter((f) => !args.includes(f));
  return [...args.slice(0, i + 1), ...add, ...args.slice(i + 1)];
}

/**
 * Runs git. Never throws on a non-zero exit: returns { code, stdout: Buffer, stderr: string }.
 * `gitDir` is required; `cwd` defaults to a private empty folder so no repository is
 * discovered from the working folder. `purpose` names the step for the call log. A repository whose own
 * config sets anything off the safe list is refused (code -1) before git runs in it. Git is handed the real folders
 * the check read (GIT_DIR and GIT_COMMON_DIR), so it reads no pointer file or commondir itself. `allowObjects` names
 * the objects folders an alternates file may borrow from. A command that reaches another repository must name the
 * place: an absolute path, or `address` (one https address) (L51). Only `git init` runs where nothing is yet, and a
 * call with no command (`--version`) opens no repository, so it is not checked.
 */
export async function git(args, { gitDir, workTree, cwd, input, extraConfig, allowObjects, address, purpose = 'unnamed', timeoutMs = 120000, gitBin = 'git' } = {}) {
  if (!gitDir) return { code: -1, stdout: Buffer.alloc(0), stderr: 'safe-git: GIT_DIR is required' };
  const at = commandAt(args);
  let dirs = { gitDir };
  if (at < args.length) {
    const checked = await checkRepo(gitDir, { gitBin, allowObjects, timeoutMs });
    const why = checked.missing && args[at] === 'init' ? null : checked.why ?? placeWhy(args, at, address);
    if (why) return { code: -1, stdout: Buffer.alloc(0), stderr: `safe-git: refused: ${why}` };
    if (!checked.why) dirs = { gitDir: checked.dir, commonDir: checked.common };
  }
  const env = safeGitEnv({ ...dirs, workTree, extraConfig });
  const where = cwd ?? home();
  callLog.push({ purpose, gitDir, cwd: where, workTree: workTree ?? null, args: args.filter((a) => !/^http\..*extraheader/i.test(a)) });
  return runChild(gitBin, ['--no-pager', ...withNoPrograms(args)], { cwd: where, env, input, timeoutMs });
}

/** Like git() but resolves stdout as text and refuses (throws) on a non-zero exit. */
export async function gitOk(args, opts) {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout.toString('utf8');
}

export async function checkGitVersion(opts = {}) {
  const r = await git(['--version'], { gitDir: '/dev/null', purpose: 'version', ...opts });
  const m = /git version (\d+)\.(\d+)/.exec(r.stdout.toString());
  if (!m) return { ok: false, reason: 'git version unreadable' };
  const [maj, min] = [Number(m[1]), Number(m[2])];
  const ok = maj > MIN_GIT[0] || (maj === MIN_GIT[0] && min >= MIN_GIT[1]);
  return ok ? { ok: true, version: `${maj}.${min}` } : { ok: false, reason: `git ${maj}.${min} is older than ${MIN_GIT.join('.')}` };
}

// The mirror's config must be exactly this. It holds nothing that names a program or a
// remote: pushes name GitHub explicitly, and main is fetched by URL.
export const MIRROR_CONFIG_TEMPLATE = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';

/**
 * Checks the scripts' own mirror before each run. Refuses a config that differs from the
 * template, an alternates file (it could let a worker plant objects that satisfy a bundle),
 * any hook, or an attributes file.
 */
export function checkMirror(gitDir, { template = MIRROR_CONFIG_TEMPLATE } = {}) {
  const st = (p) => { try { return lstatSync(p); } catch { return null; } };
  const root = st(gitDir);
  if (!root || !root.isDirectory()) return { ok: false, reason: 'mirror is missing or not a folder' };
  const cfg = join(gitDir, 'config');
  if (!st(cfg)?.isFile()) return { ok: false, reason: 'mirror config is missing or not a plain file' };
  if (readFileSync(cfg, 'utf8') !== template) return { ok: false, reason: 'mirror config differs from the template' };
  // info/grafts, shallow and the commit-graph files can change a commit's parents (R-0b-47 MIN-11).
  for (const f of ['config.worktree', 'objects/info/alternates', 'objects/info/http-alternates', 'info/attributes', 'commondir', 'info/grafts', 'shallow', 'objects/info/commit-graph', 'objects/info/commit-graphs']) {
    if (st(join(gitDir, f))) return { ok: false, reason: `mirror has ${f}` };
  }
  const hooks = join(gitDir, 'hooks');
  if (st(hooks)) {
    if (!st(hooks).isDirectory()) return { ok: false, reason: 'mirror hooks is not a folder' };
    const live = readdirSync(hooks).filter((n) => !n.endsWith('.sample'));
    if (live.length) return { ok: false, reason: `mirror has hooks: ${live.join(', ')}` };
  }
  return { ok: true };
}

/** Creates a mirror in the expected shape (for setup and tests). */
export async function initMirror(gitDir) {
  await gitOk(['init', '--bare', '-q', gitDir], { gitDir, purpose: 'init-mirror' });
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(join(gitDir, 'config'), MIRROR_CONFIG_TEMPLATE);
  rmSync(join(gitDir, 'hooks'), { recursive: true, force: true });
  if (existsSync(join(gitDir, 'description'))) rmSync(join(gitDir, 'description'));
}
