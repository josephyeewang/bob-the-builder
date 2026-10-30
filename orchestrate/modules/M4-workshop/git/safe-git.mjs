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
import { join, dirname, resolve } from 'node:path';

export const MIN_GIT = [2, 42];

// Settings that stop git from running any program a repository's own files could name, or fetching from
// anywhere the call did not name (LEAD-CALLS L36). Since L49 they are the second layer: a repository whose config
// sets anything off the safe list is refused before git runs. They come last, so they win over the repository's
// own config. `core.hooksPath` names a file, so no hook can be found under it.
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
export function safeGitEnv({ gitDir, workTree, extraConfig = [] } = {}) {
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
  if (workTree) env.GIT_WORK_TREE = workTree;
  return env;
}

// Repository config keys known to start no program and fetch from nowhere the call did not name (LEAD-CALLS L49).
// Any other key in any of the repository's config files is a refusal that names it: deny by default, since pinning
// one key at a time missed twice (L36; then hooks defined in config and bundle links). Keys as git lists them:
// section and key in lower case, the name between kept as written. Checked against git 2.54.0, 30 Oct 2026.
export const INERT_KEYS = Object.freeze(new Set([
  'core.repositoryformatversion', 'core.bare', 'core.filemode', 'core.logallrefupdates', 'core.ignorecase',
  'core.precomposeunicode', 'core.symlinks', 'extensions.objectformat', 'extensions.worktreeconfig',
  'extensions.refstorage', 'user.name', 'user.email',
]));
const INERT_NAMED = /^(?:remote\.[^\n]+\.fetch|branch\.[^\n]+\.(?:remote|merge|rebase))$/;
const URL_KEY = /^remote\.[^\n]+\.(?:url|pushurl)$/;
// A plain https, ssh or file address, an scp-style ssh address, or a local path: never `<helper>::`, never a host
// that starts like an option.
export const PLAIN_URL = /^(?:(?:https|ssh|file):\/\/(?!-)[^\s]*|\/[^\s]*|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!-)[^\s]+)$/;

/** Whether `key` (as git lists it) with `value` is on the safe list. */
export function inertSetting(key, value) {
  if (INERT_KEYS.has(key) || INERT_NAMED.test(key)) return true;
  return URL_KEY.test(key) && typeof value === 'string' && PLAIN_URL.test(value);
}

const statOf = (p) => { try { return statSync(p); } catch { return null; } };

/**
 * The folder git will use for `gitDir` and every config file it or its worktrees and submodules have, or { why }.
 * A `.git` pointer file is followed (one step, as git does) and so is `commondir`.
 */
export function repoConfigFiles(gitDir) {
  let dir = gitDir;
  const s = statOf(dir);
  if (s?.isFile()) {
    const m = /^gitdir: (.+)$/m.exec(readFileSync(dir, 'utf8'));
    if (!m) return { why: 'its .git is a file but not a pointer' };
    dir = resolve(dirname(gitDir), m[1].trim());
    if (!statOf(dir)?.isDirectory()) return { why: 'its .git pointer does not lead to a folder' };
  } else if (!s?.isDirectory()) return { dir, files: [] };
  let common = dir;
  const cd = join(dir, 'commondir');
  if (statOf(cd)) {
    common = resolve(dir, readFileSync(cd, 'utf8').trim());
    if (!statOf(common)?.isDirectory()) return { why: 'its commondir does not lead to a folder' };
  }
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
  return { dir, files: [...found.values()] };
}

/** The keys and values in one config file, read by git without following its includes, or { why }. */
function readConfigFile(file, { gitBin, timeoutMs }) {
  return new Promise((done) => {
    const child = spawn(gitBin, ['config', '--file', file, '--no-includes', '--list', '-z'], { cwd: home(), env: safeGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ why: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return done({ why: err.trim().slice(0, 200) || `exit ${code}` });
      const entries = Buffer.concat(out).toString('utf8').split('\0').filter((x) => x !== '').map((x) => {
        const nl = x.indexOf('\n');
        return nl < 0 ? [x, undefined] : [x.slice(0, nl), x.slice(nl + 1)];
      });
      done({ entries });
    });
  });
}

async function checkRepo(gitDir, { gitBin = 'git', timeoutMs = 30000 } = {}) {
  let found;
  try { found = repoConfigFiles(gitDir); } catch (e) { return { why: `its folders could not be read: ${e.message}` }; }
  if (found.why) return { why: found.why };
  const bad = [];
  for (const f of found.files) {
    const r = await readConfigFile(f, { gitBin, timeoutMs });
    const where = f.startsWith(found.dir) ? f.slice(found.dir.length + 1) : f;
    if (r.why) return { why: `its config ${where} could not be read: ${r.why}` };
    for (const [k, v] of r.entries) if (!inertSetting(k, v)) bad.push(`${k} (${where})`);
  }
  if (bad.length) return { why: `its config sets what is not on the safe list: ${bad.join(', ')}` };
  return { dir: found.dir };
}

/**
 * Why the repository at `gitDir` must not be run, or null. Every config file it has is read, including what
 * worktrees and submodules have and what a pointer file or commondir leads to; any key off the safe list is a
 * refusal that names it, and so is an include. A folder with no config yet (git init, version) has nothing to
 * read. A config that can't be read is a refusal: fail closed.
 */
export async function repoConfigWhy(gitDir, opts) {
  return (await checkRepo(gitDir, opts)).why ?? null;
}

// Diff-family commands, which accept the two flags that turn off outside diff programs and text conversion.
const DIFF_COMMANDS = new Set(['log', 'show', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'whatchanged', 'format-patch', 'range-diff']);
const NO_PROGRAMS = ['--no-ext-diff', '--no-textconv'];
// Options before the command that take the next word as their value.
const GLOBAL_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** `args` with the no-program flags right after a diff-family command (once each); other commands unchanged. */
export function withNoPrograms(args) {
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    if (GLOBAL_WITH_VALUE.has(a)) i += 2;
    else if (a.startsWith('-')) i += 1;
    else break;
  }
  if (i >= args.length || !DIFF_COMMANDS.has(args[i])) return args;
  const add = NO_PROGRAMS.filter((f) => !args.includes(f));
  return [...args.slice(0, i + 1), ...add, ...args.slice(i + 1)];
}

/**
 * Runs git. Never throws on a non-zero exit: returns { code, stdout: Buffer, stderr: string }.
 * `gitDir` is required; `cwd` defaults to a private empty folder so no repository is
 * discovered from the working folder. `purpose` names the step for the call log. A repository whose own
 * config sets anything off the safe list is refused (code -1) before git runs in it. Git is handed the folder the
 * check read, so a pointer file can't be swapped between the check and the run.
 */
export async function git(args, { gitDir, workTree, cwd, input, extraConfig, purpose = 'unnamed', timeoutMs = 120000, gitBin = 'git' } = {}) {
  if (!gitDir) return { code: -1, stdout: Buffer.alloc(0), stderr: 'safe-git: GIT_DIR is required' };
  const checked = await checkRepo(gitDir, { gitBin });
  if (checked.why) return { code: -1, stdout: Buffer.alloc(0), stderr: `safe-git: refused: ${checked.why}` };
  const env = safeGitEnv({ gitDir: checked.dir, workTree, extraConfig });
  const where = cwd ?? home();
  callLog.push({ purpose, gitDir, cwd: where, workTree: workTree ?? null, args: args.filter((a) => !/^http\..*extraheader/i.test(a)) });
  return new Promise((resolve) => {
    const child = spawn(gitBin, ['--no-pager', ...withNoPrograms(args)], { cwd: where, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message) }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? -1 : 0), stdout: Buffer.concat(out), stderr: err }));
    child.stdin.on('error', () => { /* git closed its input early; its exit code decides */ });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
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
