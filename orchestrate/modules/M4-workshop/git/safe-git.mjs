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
//   - refuses a repository whose own config names a program under a name SAFE_CONFIG cannot pin
//     ahead of time (a filter, diff or merge driver, a remote's upload program, a URL rewrite), and
//     turns off outside diff programs and text conversion on every command that accepts the flags.
// Capability note: checked against Git 2.54.0 on 29 Oct 2026; requires git >= 2.42.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, lstatSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MIN_GIT = [2, 42];

// Settings that stop git from running any program a repository's own files could name, or fetching from
// anywhere the call did not name (LEAD-CALLS L36: every key that can, not one at a time). They come last, so
// they win over the repository's own config. `core.hooksPath` names a file, so no hook can be found under it.
export const SAFE_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.editor', '/usr/bin/false'],
  ['sequence.editor', '/usr/bin/false'],
  ['core.sshCommand', '/usr/bin/false'],
  ['core.askPass', '/usr/bin/false'],
  ['core.attributesFile', '/dev/null'],
  ['diff.external', ''],
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
  ['http.proxy', ''],
  ['protocol.ext.allow', 'never'],
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

// Repository config keys that name a program, or a place to fetch from, under a name each repository picks, so
// SAFE_CONFIG cannot pin them ahead of time (L36). A repository whose own config (or a file it includes) sets one
// is refused. Keys as git lists them: section and key in lower case, the name between kept as written.
export const NAMED_PROGRAM_KEY = /^(?:(?:filter|diff|merge|mergetool|difftool|trailer)\..+\.(?:clean|smudge|process|command|textconv|driver|cmd)|remote\..+\.(?:uploadpack|receivepack|vcs|promisor|proxy|partialclonefilter)|url\..+\.(?:insteadof|pushinsteadof)|credential\..+\.helper|submodule\..+\.update|http\..+\.proxy|extensions\.partialclone|core\.alternaterefscommand|core\.gitproxy)$/;

// Diff-family commands, which accept the two flags that turn off outside diff programs and text conversion.
const DIFF_COMMANDS = new Set(['log', 'show', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'whatchanged', 'format-patch', 'range-diff']);
const NO_PROGRAMS = ['--no-ext-diff', '--no-textconv'];

/** `args` with the no-program flags right after a diff-family command (once each); other commands unchanged. */
export function withNoPrograms(args) {
  const i = args.findIndex((a) => !String(a).startsWith('-'));
  if (i < 0 || !DIFF_COMMANDS.has(args[i])) return args;
  const add = NO_PROGRAMS.filter((f) => !args.includes(f));
  return [...args.slice(0, i + 1), ...add, ...args.slice(i + 1)];
}

/**
 * Why the repository at `gitDir` must not be run, or null. Reads its own config (and what it includes) with the
 * safe settings; a key that names a program under a per-repository name is a refusal. A folder with no config
 * yet (git init, version) has nothing to read. A config that can't be read is a refusal: fail closed.
 */
export function repoConfigWhy(gitDir, { gitBin = 'git', timeoutMs = 30000 } = {}) {
  if (!existsSync(join(gitDir, 'config')) && !existsSync(join(gitDir, 'commondir'))) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(gitBin, ['config', '--list', '-z', '--show-scope', '--includes'], { cwd: home(), env: safeGitEnv({ gitDir }), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve(`its config could not be read: ${e.message}`));
    child.on('close', (code) => {
      if (code !== 0) return resolve(`its config could not be read: ${err.trim().slice(0, 200)}`);
      const f = Buffer.concat(out).toString('utf8').split('\0');
      const bad = [];
      for (let i = 0; i + 1 < f.length; i += 2) {
        if (f[i] === 'command') continue;
        const key = f[i + 1].split('\n')[0];
        if (NAMED_PROGRAM_KEY.test(key)) bad.push(key);
      }
      resolve(bad.length ? `its config names a program or a place to fetch from: ${bad.join(', ')}` : null);
    });
  });
}

/**
 * Runs git. Never throws on a non-zero exit: returns { code, stdout: Buffer, stderr: string }.
 * `gitDir` is required; `cwd` defaults to a private empty folder so no repository is
 * discovered from the working folder. `purpose` names the step for the call log. A repository whose own
 * config names a program SAFE_CONFIG cannot pin is refused (code -1) before git runs in it.
 */
export async function git(args, { gitDir, workTree, cwd, input, extraConfig, purpose = 'unnamed', timeoutMs = 120000, gitBin = 'git' } = {}) {
  if (!gitDir) return { code: -1, stdout: Buffer.alloc(0), stderr: 'safe-git: GIT_DIR is required' };
  const why = await repoConfigWhy(gitDir, { gitBin });
  if (why) return { code: -1, stdout: Buffer.alloc(0), stderr: `safe-git: refused: ${why}` };
  const env = safeGitEnv({ gitDir, workTree, extraConfig });
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
