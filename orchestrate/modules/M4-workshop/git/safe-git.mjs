// The one way any plain script in M4 or M11 runs git (review 0b-4 M5).
//
// A worker controls everything in its copy, including .git/config, hooks, attributes and
// environment it can leave behind. So every call here:
//   - starts from an empty environment (fixed PATH, private HOME, no inherited GIT_* or pager);
//   - ignores the system and global git config;
//   - passes the safe settings through the environment (GIT_CONFIG_COUNT/KEY/VALUE), so a git
//     that another program starts (the secret scanner) gets them too;
//   - names the repository explicitly (GIT_DIR) and logs it, so a test can prove no call ran
//     inside a worker's copy except save-work.
// Capability note: checked against Git 2.54.0 on 29 Oct 2026; requires git >= 2.42.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, lstatSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MIN_GIT = [2, 42];

// Settings that stop git from running any program a repository's own files could name.
export const SAFE_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.sshCommand', '/usr/bin/false'],
  ['core.askPass', '/usr/bin/false'],
  ['diff.external', ''],
  ['credential.helper', ''],
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
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  if (gitDir) env.GIT_DIR = gitDir;
  if (workTree) env.GIT_WORK_TREE = workTree;
  return env;
}

/**
 * Runs git. Never throws on a non-zero exit: returns { code, stdout: Buffer, stderr: string }.
 * `gitDir` is required; `cwd` defaults to a private empty folder so no repository is
 * discovered from the working folder. `purpose` names the step for the call log.
 */
export function git(args, { gitDir, workTree, cwd, input, extraConfig, purpose = 'unnamed', timeoutMs = 120000, gitBin = 'git' } = {}) {
  if (!gitDir) return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: 'safe-git: GIT_DIR is required' });
  const env = safeGitEnv({ gitDir, workTree, extraConfig });
  const where = cwd ?? home();
  callLog.push({ purpose, gitDir, cwd: where, workTree: workTree ?? null, args: args.filter((a) => !/^http\..*extraheader/i.test(a)) });
  return new Promise((resolve) => {
    const child = spawn(gitBin, ['--no-pager', ...args], { cwd: where, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
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
