import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, existsSync, chmodSync, cpSync, rmSync, realpathSync, appendFileSync, linkSync } from 'node:fs';
import { cp, writeFile, chmod } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { safeGitEnv, sweepStaleHomes, git, gitOk, checkGitVersion, checkMirror, initMirror, MIRROR_CONFIG_TEMPLATE, SAFE_CONFIG, withNoPrograms, repoConfigWhy, repoConfigFiles, inertSetting, INERT_KEYS, pointerPath, placeWhy } from './safe-git.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const tmp = () => tempDir('orch-sg-');
// Plain git in the controls asks for nothing either (the lead's standing rule, 30 Oct 2026: no test may hang).
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GCM_INTERACTIVE: 'never' };

test('environment starts empty: no inherited GIT_* or other variables survive', () => {
  process.env.GIT_SSH_COMMAND = 'planted';
  process.env.ORCH_PLANTED_VAR = 'x';
  const env = safeGitEnv({ gitDir: '/x' });
  delete process.env.GIT_SSH_COMMAND; delete process.env.ORCH_PLANTED_VAR;
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.ORCH_PLANTED_VAR, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_DIR, '/x');
  assert.equal(Number(env.GIT_CONFIG_COUNT), SAFE_CONFIG.length);
});

test('git version is at least the floor', async () => {
  const v = await checkGitVersion();
  assert.equal(v.ok, true, v.reason);
});

test('missing GIT_DIR is refused, never discovered from the folder', async () => {
  const r = await git(['status']);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /GIT_DIR is required/);
});

test('a repository hook and fsmonitor planted by a worker never run', async () => {
  const d = tmp();
  const gd = join(d, '.git');
  await gitOk(['init', '-q', d], { gitDir: gd });
  const marker = join(d, 'RAN');
  mkdirSync(join(gd, 'hooks'), { recursive: true });
  writeFileSync(join(gd, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(join(d, 'a.txt'), 'a');
  await gitOk(['add', 'a.txt'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['commit', '-q', '-m', 'x'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['status', '--porcelain'], { gitDir: gd, workTree: d, cwd: d });
  assert.throws(() => statSync(marker), 'a planted hook ran');
  // The same programs named in the repository's config: refused before git runs, naming both keys (L49).
  const clean = readFileSync(join(gd, 'config'), 'utf8');
  writeFileSync(join(gd, 'config'), clean + `[core]\n\tfsmonitor = /bin/sh -c 'touch ${marker}'\n\thooksPath = ${join(gd, 'hooks')}\n`);
  const r = await git(['status', '--porcelain'], { gitDir: gd, workTree: d, cwd: d });
  assert.equal(r.code, -1);
  assert.match(r.stderr, /core\.fsmonitor .*core\.hookspath /);
  assert.throws(() => statSync(marker), 'a planted fsmonitor ran');
  // Planted fault: drop the safe fsmonitor setting and the same planted program does run,
  // so the check above can fail.
  writeFileSync(join(gd, 'config'), clean);
  await gitOk(['status', '--porcelain'], { gitDir: gd, workTree: d, cwd: d, extraConfig: [['core.fsmonitor', `/bin/sh -c 'touch ${marker}'`]] });
  assert.ok(statSync(marker), 'the planted-fault half should have run the program');
});

test('mirror check: the template passes, every planted extra is refused', async () => {
  const d = join(tmp(), 'm.git');
  await initMirror(d);
  assert.deepEqual(checkMirror(d), { ok: true });
  const plant = async (fn, re) => {
    const m = join(tmp(), 'm.git'); await initMirror(m); fn(m);
    const r = checkMirror(m); assert.equal(r.ok, false); assert.match(r.reason, re);
  };
  await plant((m) => writeFileSync(join(m, 'config'), MIRROR_CONFIG_TEMPLATE + '[include]\n\tpath = x\n'), /differs/);
  await plant((m) => writeFileSync(join(m, 'config'), MIRROR_CONFIG_TEMPLATE + '[remote "origin"]\n\turl = x\n'), /differs/);
  await plant((m) => { mkdirSync(join(m, 'objects/info'), { recursive: true }); writeFileSync(join(m, 'objects/info/alternates'), '/x\n'); }, /alternates/);
  await plant((m) => { mkdirSync(join(m, 'info'), { recursive: true }); writeFileSync(join(m, 'info/attributes'), '* filter=x\n'); }, /attributes/);
  await plant((m) => { mkdirSync(join(m, 'hooks')); writeFileSync(join(m, 'hooks/post-update'), '#!/bin/sh\n'); }, /hooks/);
  assert.equal(checkMirror(join(tmp(), 'nope')).ok, false);
});

// Static check (review 0b-4 M5): no other file under orchestrate/ starts git itself.
// Known exceptions, each with the lead's call and date. The test fails if a listed file stops starting git, so the
// line is deleted in the change that routes it through safe-git.mjs.
const KNOWN_EXCEPTIONS = {};
test('no other orchestrate file spawns git directly', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..', '..');
  const offenders = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, n.name);
      if (n.isDirectory()) { if (n.name !== 'node_modules' && n.name !== 'third_party') walk(p); continue; }
      if (!/\.(mjs|js|cjs|sh)$/.test(n.name) || n.name.endsWith('.test.mjs')) continue;
      if (p === join(here, 'safe-git.mjs')) continue;
      const src = readFileSync(p, 'utf8');
      const spawnsGit = /(spawn|exec|execFile|spawnSync|execSync|execFileSync)\s*\(\s*['"`]git\b/.test(src);
      const shellGit = n.name.endsWith('.sh') && /^\s*git\s+\w/m.test(src);
      if (spawnsGit || shellGit) offenders.push(relative(root, p));
    }
  };
  walk(root);
  for (const f of Object.keys(KNOWN_EXCEPTIONS)) assert.ok(offenders.includes(f), `${f} no longer starts git: delete its line in KNOWN_EXCEPTIONS`);
  assert.deepEqual(offenders.filter((f) => !(f in KNOWN_EXCEPTIONS)), []);
});

test('start-up sweep removes only stale, empty git homes of ours (lead, 29 Oct 2026)', () => {
  const d = tempDir('m4-homes-');
  const now = Date.now();
  const old = (now - 25 * 3600 * 1000) / 1000;
  const mk = (n, { age = old, file = false } = {}) => { mkdirSync(join(d, n)); if (file) writeFileSync(join(d, n, 'x'), 'x'); utimesSync(join(d, n), age, age); };
  mk('orch-git-home-stale');
  mk('orch-git-home-fresh', { age: now / 1000 });
  mk('orch-git-home-full', { file: true });
  mk('other-stale');
  mkdirSync(join(d, 'target'));
  symlinkSync(join(d, 'target'), join(d, 'orch-git-home-link'));
  assert.deepEqual(sweepStaleHomes({ dir: d, now }), ['orch-git-home-stale']);
  assert.equal(existsSync(join(d, 'orch-git-home-stale')), false);
  for (const n of ['orch-git-home-fresh', 'orch-git-home-full', 'other-stale', 'orch-git-home-link', 'target']) assert.ok(existsSync(join(d, n)), n);
  assert.deepEqual(sweepStaleHomes({ dir: join(d, 'missing'), now }), []);
});

test('the sweep runs when safe-git first makes its git home', () => {
  const d = tempDir('m4-homes-');
  const old = (Date.now() - 25 * 3600 * 1000) / 1000;
  mkdirSync(join(d, 'orch-git-home-stale')); utimesSync(join(d, 'orch-git-home-stale'), old, old);
  const url = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'safe-git.mjs')).href;
  const env = { ...process.env, TMPDIR: d }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { checkGitVersion } from ${JSON.stringify(url)}; await checkGitVersion();`], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(d, 'orch-git-home-stale')), false);
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('orch-git-home-')), [], 'its own home is removed on exit');
});

// LEAD-CALLS L36: a repository's own config ran a program on a plain `git log` (log.showSignature plus gpg.program,
// and one commit with a signature header). The sweep plants every key that can run a program or fetch from
// elsewhere, one key per copy of a repository, runs every kind of git command the scripts run through safe-git,
// and checks no planted program ran. Keys SAFE_CONFIG pins must be overridden; per-name keys must be refused.
const SIGS = [
  ['PGP', '-----BEGIN PGP SIGNATURE-----', '-----END PGP SIGNATURE-----'],
  ['SSH', '-----BEGIN SSH SIGNATURE-----', '-----END SSH SIGNATURE-----'],
  ['X509', '-----BEGIN SIGNED MESSAGE-----', '-----END SIGNED MESSAGE-----'],
];

/** A local listener that counts every connection made to it: a planted address that git reaches shows up here. */
async function listener() {
  let hits = 0;
  const server = createServer((c) => { hits += 1; c.destroy(); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  server.unref(); // a test that fails before close() still lets the run end
  return { url: `http://127.0.0.1:${server.address().port}`, hits: () => hits, reset: () => { hits = 0; }, close: () => new Promise((ok) => server.close(ok)) };
}

// The two sweeps run their cases side by side, at most this many at a time (#35): one after another they took 50 to
// 100 s each on a loaded machine, close to their 120 s limit, and a cancelled sweep's git kept making folders after
// its cleanup ran (L161). Each case has its own folder, so nothing one case does is seen by another. A case copies
// and writes its files without blocking (fs/promises): on a loaded machine the copies alone took 40 s of the L49
// sweep's main thread, one after another.
const POOL = Math.min(8, availableParallelism());

/** Runs `fn` on every item, at most `n` at once; `fn` also gets the number of the slot it runs in (0 to n-1). */
async function inPool(items, n, fn) {
  let next = 0;
  const slot = async (k) => { while (next < items.length) { const i = next++; await fn(items[i], k, i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, (_, k) => slot(k)));
}

/**
 * One sweep case's own world: a copy of the trapped repository, its own markers folder, a listener and a bare peer
 * to push to (pushes from cases side by side into one peer would race for its refs). `cw` stands in for the world
 * in everyCommand: the bundles and clean repositories it makes go in the case's folder.
 */
async function sweepCase(w, name) {
  const dir = join(w.root, 'cases', name.replace(/[^a-z0-9]+/gi, '-'));
  const markers = join(dir, 'markers');
  mkdirSync(markers, { recursive: true });
  const d = join(dir, 'repo');
  await cp(w.d, d, { recursive: true });
  const peer = join(dir, 'peer.git');
  await gitOk(['init', '--bare', '-q', peer], { gitDir: peer });
  return { dir, markers, d, peer, net: await listener(), cw: { ...w, root: dir, peer } };
}

/**
 * git run with safe-git's environment and flags but without its config check: the second layer alone. A git still
 * running after 30 s is stopped with everything it started (its own process group) and comes back `hung`: a program
 * git started that keeps git's output open (a planted `cat`) would otherwise keep the case waiting until the sweep's
 * limit cancels it (#35).
 */
function rawGit(args, { gitDir, workTree, input } = {}) {
  return new Promise((done) => {
    const child = spawn('git', ['--no-pager', ...withNoPrograms(args)], { cwd: tmp(), env: safeGitEnv({ gitDir, workTree }), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let err = '';
    let out = '';
    let hung = false;
    const timer = setTimeout(() => { hung = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 30_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout: out, stderr: err, hung }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** A repository with history (a side branch, one commit per signature kind), a clean bare peer, and a clean source. */
async function trapWorld() {
  const root = tmp();
  const d = join(root, 'repo');
  const gd = join(d, '.git');
  const o = { gitDir: gd, workTree: d };
  await gitOk(['init', '-q', d], { gitDir: gd });
  writeFileSync(join(d, 'a.txt'), 'one\n');
  await gitOk(['add', '-A'], o);
  await gitOk(['commit', '-q', '-m', 'first'], o);
  await gitOk(['checkout', '-q', '-b', 'side'], o);
  writeFileSync(join(d, 'b.txt'), 'side\n');
  await gitOk(['add', '-A'], o);
  await gitOk(['commit', '-q', '-m', 'side'], o);
  await gitOk(['checkout', '-q', 'main'], o);
  let parent = (await gitOk(['rev-parse', 'HEAD'], o)).trim();
  const tree = (await gitOk(['rev-parse', 'HEAD^{tree}'], o)).trim();
  for (const [name, begin, end] of SIGS) {
    const body = `tree ${tree}\nparent ${parent}\nauthor a <a@localhost> 1700000000 +0000\ncommitter a <a@localhost> 1700000000 +0000\ngpgsig ${begin}\n \n AAAA\n ${end}\n\nsigned ${name}\n`;
    parent = (await gitOk(['hash-object', '-t', 'commit', '-w', '--stdin'], { ...o, input: body })).trim();
  }
  await gitOk(['update-ref', 'refs/heads/main', parent], o);
  await gitOk(['reset', '-q', '--hard', 'main'], o);
  const peer = join(root, 'peer.git');
  await gitOk(['init', '--bare', '-q', peer], { gitDir: peer });
  const src = join(root, 'src');
  await gitOk(['init', '-q', src], { gitDir: join(src, '.git') });
  await gitOk(['fetch', '-q', gd, 'refs/heads/main:refs/heads/src-main'], { gitDir: join(src, '.git') });
  return { root, d, gd, peer, src };
}

/** Every kind of git command the scripts run through safe-git, against the trapped repository `d`. */
async function everyCommand(w, d, run) {
  const gd = join(d, '.git');
  const o = { gitDir: gd, workTree: d };
  const bundle = join(w.root, `b-${Math.random().toString(36).slice(2)}.bundle`);
  const into = join(w.root, `into-${Math.random().toString(36).slice(2)}`);
  writeFileSync(join(d, 'a.txt'), 'changed\n');
  const cmds = [
    [['status', '--porcelain'], o], [['status'], o], [['add', '-A'], o], [['add', 'a.txt'], o],
    [['--literal-pathspecs', 'log', '-n4', '--name-only', '--format=%H %s', 'main'], o], [['log', '-n4', '-p', 'main'], o],
    [['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B', 'main'], o], [['show', 'main'], o], [['diff', 'HEAD~1'], o], [['diff', '--cached'], o],
    [['diff-tree', '-p', '-r', '--text', '--no-commit-id', 'main'], o], [['diff-tree', '-r', '-z', '--raw', 'main'], o],
    [['cat-file', 'commit', 'main'], o], [['cat-file', 'blob', 'main:a.txt'], o], [['ls-tree', '-r', '-z', '--full-tree', 'main'], o],
    [['ls-files', '-s'], o], [['rev-parse', '--verify', 'main^{commit}'], o], [['rev-list', '--parents', 'main'], o],
    [['merge-base', '--is-ancestor', 'side', 'main'], o], [['for-each-ref', '--format=%(refname) %(objectname)'], o],
    [['commit', '-q', '-m', 'work'], o], [['commit', '-q', '--allow-empty', '-m', 'empty'], o], [['tag', '-a', '-m', 't', 't1'], o],
    [['commit', '-q', '--amend'], o], [['tag', '-a', 't2'], o],
    [['merge', '-q', '--no-ff', '-m', 'merge', 'side'], o], [['checkout', '-q', '-f', 'side'], o], [['checkout', '-q', '-b', 'c2', 'main'], o],
    [['reset', '-q', '--hard', 'main'], o], [['branch', '-f', 'b2', 'main'], o], [['commit-tree', '-p', 'main', '-m', 'x', 'main^{tree}'], o],
    [['update-ref', 'refs/heads/b3', 'main'], o], [['bundle', 'create', '-q', bundle, 'refs/heads/main'], o],
    [['bundle', 'verify', '-q', bundle], o], [['bundle', 'list-heads', bundle], o],
    [['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', w.src, 'refs/heads/src-main:refs/heads/from-src'], o],
    [['fetch', '-q', 'origin'], o], [['push', '-q', w.peer, 'main:refs/heads/main'], o],
    [['push', '--porcelain', '--atomic', '--no-verify', w.peer, 'main:refs/heads/p2'], o], [['ls-remote', '--heads', w.peer], o],
    [['merge-base', 'main', 'side'], o], [['check-ref-format', '--branch', 'main'], o],
    // The forms with no place, where git would take one from the repository's config: refused since L51.
    [['fetch', '-q'], o], [['ls-remote'], o], [['ls-remote', '--heads'], o], [['push', '-q'], o], [['pull', '-q'], o],
  ];
  const out = [];
  for (const [args, opts] of cmds) out.push([args.join(' '), await run(args, opts)]);
  // The trapped repository as a source: fetched from, into a clean one.
  await gitOk(['init', '-q', into], { gitDir: join(into, '.git') });
  out.push(['fetch from it', await run(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', gd, 'refs/heads/main:refs/heads/x'], { gitDir: join(into, '.git') })]);
  return out;
}

test('L36/L49 sweep: every planted key is refused before git runs; the pins alone still start no program and reach no network', { timeout: 120_000 }, async () => {
  const w = await trapWorld();
  // A case's traps: programs and hooks that leave a marker in the case's own folder when they run.
  const trapsFor = async (t) => {
    const traps = join(t.dir, 'traps');
    const prog = (name) => {
      const p = join(traps, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(t.markers, name))}\ncat\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const hooks = join(traps, 'hooks');
    mkdirSync(hooks, { recursive: true });
    await Promise.all(['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'post-index-change', 'pre-auto-gc'].map(async (h) => {
      await writeFile(join(hooks, h), `#!/bin/sh\ntouch ${JSON.stringify(join(t.markers, `hook-${h}`))}\n`);
      await chmod(join(hooks, h), 0o755);
    }));
    const attrs = join(traps, 'attributes');
    await writeFile(attrs, '* filter=y diff=y merge=y\n');
    return { traps, prog, hooks, attrs };
  };
  const sign = (k) => ['[log]', '\tshowSignature = true', '[merge]', '\tverifySignatures = true', '[pull]', '\tverifySignatures = true',
    '[commit]', '\tgpgSign = true', '[tag]', '\tgpgSign = true', '\tforceSignAnnotated = true', '[push]', '\tgpgSign = if-asked', k];
  // Pinned: the repository sets them, SAFE_CONFIG wins.
  const pinned = {
    'core.fsmonitor': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\tfsmonitor = ${prog('core.fsmonitor')}`],
    'core.hooksPath': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\thooksPath = ${hooks}`],
    'core.pager': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\tpager = ${prog('core.pager')}`, '[pager]', `\tlog = ${prog('pager.log')}`],
    'core.editor': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\teditor = ${prog('core.editor')}`, '[sequence]', `\teditor = ${prog('sequence.editor')}`],
    'core.sshCommand': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\tsshCommand = ${prog('core.sshCommand')}`],
    'core.askPass': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\taskPass = ${prog('core.askPass')}`],
    'core.attributesFile': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\tattributesFile = ${attrs}`, '[filter "y"]', `\tclean = ${prog('attributes.clean')}`,
      `\tsmudge = ${prog('attributes.smudge')}`, '\trequired = true', '[diff "y"]', `\ttextconv = ${prog('attributes.textconv')}`, '[merge "y"]', `\tdriver = ${prog('attributes.merge')}`],
    'diff.external': ({ prog, hooks, attrs, traps }, t) => ['[diff]', `\texternal = ${prog('diff.external')}`],
    'interactive.diffFilter': ({ prog, hooks, attrs, traps }, t) => ['[interactive]', `\tdiffFilter = ${prog('interactive.diffFilter')}`],
    'credential.helper': ({ prog, hooks, attrs, traps }, t) => ['[credential]', `\thelper = !${prog('credential.helper')}`],
    'gpg.program': ({ prog, hooks, attrs, traps }, t) => sign(`[gpg]\n\tprogram = ${prog('gpg.program')}`),
    'gpg.openpgp.program': ({ prog, hooks, attrs, traps }, t) => sign(`[gpg "openpgp"]\n\tprogram = ${prog('gpg.openpgp.program')}`),
    'gpg.x509.program': ({ prog, hooks, attrs, traps }, t) => sign(`[gpg]\n\tformat = x509\n[gpg "x509"]\n\tprogram = ${prog('gpg.x509.program')}`),
    'gpg.ssh.program': ({ prog, hooks, attrs, traps }, t) => sign(`[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = ${prog('gpg.ssh.program')}\n\tdefaultKeyCommand = ${prog('gpg.ssh.defaultKeyCommand')}\n\tallowedSignersFile = ${attrs}`),
    'submodule.recurse': ({ prog, hooks, attrs, traps }, t) => ['[submodule]', '\trecurse = true', '[fetch]', '\trecurseSubmodules = true', '[push]', '\trecurseSubmodules = on-demand'],
    'transfer.bundleURI': ({ prog, hooks, attrs, traps }, t) => ['[transfer]', '\tbundleURI = true', '[fetch]', `\tbundleURI = file://${prog('bundle-uri')}`],
    'http.proxy': ({ prog, hooks, attrs, traps }, t) => ['[http]', `\tproxy = ${t.net.url}`, '[remote "origin"]', '\turl = https://example.invalid/r.git'],
    'fetch.bundleURI': ({ prog, hooks, attrs, traps }, t) => ['[fetch]', `\tbundleURI = ${t.net.url}/b.bundle`],
    'protocol.ext.allow': ({ prog, hooks, attrs, traps }, t) => ['[protocol "ext"]', '\tallow = always', '[remote "origin"]', `\turl = ext::${prog('ext-protocol')}`],
  };
  // Per-name: refused before git runs in the repository.
  const named = {
    'filter.x': ({ prog, hooks, attrs, traps }, t) => ['[filter "x"]', `\tclean = ${prog('filter.clean')}`, `\tsmudge = ${prog('filter.smudge')}`, `\tprocess = ${prog('filter.process')}`, '\trequired = true'],
    'diff.x': ({ prog, hooks, attrs, traps }, t) => ['[diff "x"]', `\ttextconv = ${prog('diff.textconv')}`, `\tcommand = ${prog('diff.command')}`],
    'merge.x.driver': ({ prog, hooks, attrs, traps }, t) => ['[merge "x"]', `\tdriver = ${prog('merge.driver')}`],
    'trailer.x': ({ prog, hooks, attrs, traps }, t) => ['[trailer "x"]', `\tcommand = ${prog('trailer.command')}`, `\tcmd = ${prog('trailer.cmd')}`],
    'remote.uploadpack': ({ prog, hooks, attrs, traps }, t) => ['[remote "origin"]', `\turl = ${'$'}{SRC}`, `\tuploadpack = ${prog('remote.uploadpack')}`, `\treceivepack = ${prog('remote.receivepack')}`],
    'remote.vcs': ({ prog, hooks, attrs, traps }, t) => ['[remote "origin"]', '\tvcs = trap', `\turl = ${'$'}{SRC}`],
    'url.insteadOf': ({ prog, hooks, attrs, traps }, t) => [`[url "ext::${prog('url.insteadof')}"]`, `\tinsteadOf = ${'$'}{SRC}`, `\tpushInsteadOf = ${'$'}{PEER}`],
    'credential.url.helper': ({ prog, hooks, attrs, traps }, t) => ['[credential "https://example.invalid"]', `\thelper = !${prog('credential.url.helper')}`],
    'submodule.update': ({ prog, hooks, attrs, traps }, t) => ['[submodule "s"]', `\tupdate = !${prog('submodule.update')}`],
    'http.url.proxy': ({ prog, hooks, attrs, traps }, t) => ['[http "https://example.invalid"]', `\tproxy = ${t.net.url}`],
    'hook.x': ({ prog, hooks, attrs, traps }, t) => ['[hook "x"]', `\tcommand = ${prog('hook.x')}`, '\tevent = reference-transaction', '\tevent = pre-commit', '\tevent = post-checkout'],
    'HOOK.y (upper case)': ({ prog, hooks, attrs, traps }, t) => ['[HOOK "y"]', `\tCOMMAND = ${prog('hook.y')}`, '\tEVENT = reference-transaction'],
    'bundle list': ({ prog, hooks, attrs, traps }, t) => ['[bundle]', '\tversion = 1', '\tmode = all', '[bundle "b"]', `\turi = ${t.net.url}/c.bundle`],
    'promisor': ({ prog, hooks, attrs, traps }, t) => ['[extensions]', '\tpartialClone = origin', '[remote "origin"]', `\turl = ${'$'}{SRC}`, '\tpromisor = true'],
    'core.alternateRefsCommand': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\talternateRefsCommand = ${prog('core.alternateRefsCommand')}`],
    'core.gitProxy': ({ prog, hooks, attrs, traps }, t) => ['[core]', `\tgitProxy = ${prog('core.gitProxy')}`],
    'include of a named key': ({ prog, hooks, attrs, traps }, t) => { const inc = join(traps, 'inc.cfg'); writeFileSync(inc, `[filter "x"]\n\tclean = ${prog('include.clean')}\n`); return ['[include]', `\tpath = ${inc}`]; },
  };
  const fill = (lines, t) => lines.join('\n').replaceAll('${SRC}', w.src).replaceAll('${PEER}', t.peer);
  const failures = [];
  const fired = (t, name) => {
    const f = readdirSync(t.markers);
    if (f.length) failures.push(`${name}: ${f.join(', ')}`);
    for (const x of f) rmSync(join(t.markers, x));
    if (t.net.hits()) failures.push(`${name}: reached the network ${t.net.hits()} times`);
    t.net.reset();
  };
  const refusedAll = (name, res) => {
    // Every command in the trapped repository is refused; the fetch from it into a clean one does not read its config.
    const ran = res.filter(([c, r]) => c !== 'fetch from it' && !(r.code === -1 && /safe-git: refused: .*not on the safe list/.test(r.stderr)));
    if (ran.length) failures.push(`${name}: not refused: ${ran.map(([c]) => c).join('; ')}`);
  };
  // Every key a pinned case is named for, and every signature key it plants, is one SAFE_CONFIG pins. Checked by
  // name because some pins back each other up (gpg.program and gpg.openpgp.program are one setting in git, and
  // log.showSignature only matters while a signing program can run): one of them dropped changes nothing git does,
  // so no run of git would show it.
  const pinnedKeys = new Set(SAFE_CONFIG.map(([k]) => k.toLowerCase()));
  const keysIn = (lines) => {
    let head = '';
    return lines.join('\n').split('\n').flatMap((l) => {
      const sec = /^\[([^\s\]"]+)(?: "([^"]*)")?\]$/.exec(l);
      if (sec) { head = sec[2] === undefined ? sec[1] : `${sec[1]}.${sec[2]}`; return []; }
      const kv = /^\t([A-Za-z0-9-]+) = /.exec(l);
      return kv ? [`${head}.${kv[1]}`] : [];
    });
  };
  const sigKeys = keysIn(sign('[gpg]\n\tprogram = x'));
  assert.ok(sigKeys.length >= 8, `read only ${sigKeys.length} signature keys`);
  // diff.external is the one stopped by a flag (--no-ext-diff on every diff command, withNoPrograms), not a pin.
  const unpinned = [...Object.keys(pinned), ...sigKeys].filter((k) => k !== 'diff.external' && !pinnedKeys.has(k.toLowerCase()));
  assert.deepEqual(unpinned, [], 'planted as pinned, but SAFE_CONFIG does not pin it');
  const cases = [...Object.entries(pinned).map(([name, lines]) => [name, lines, true]), ...Object.entries(named).map(([name, lines]) => [name, lines, false])];
  const done = [];
  await inPool(cases, POOL, async ([name, lines, pin]) => {
    const t = await sweepCase(w, name);
    done.push([name, t]);
    // The global attributes file only counts where the tree's own .gitattributes says nothing.
    if (name !== 'core.attributesFile') await writeFile(join(t.d, '.gitattributes'), '* filter=x diff=x merge=x\n');
    const clean = readFileSync(join(t.d, '.git', 'config'), 'utf8');
    await writeFile(join(t.d, '.git', 'config'), `${clean}${fill(lines(await trapsFor(t), t), t)}\n`);
    refusedAll(name, await everyCommand(t.cw, t.d, (args, opts) => git(args, opts)));
    fired(t, name);
    if (!pin) return;
    // The second layer alone: the same commands with the config check skipped.
    // After a git that hung, the case has failed: its later commands are skipped, since several of them hanging 30 s
    // each would hold the sweep past its limit.
    let hung = '';
    await everyCommand(t.cw, t.d, async (args, opts) => {
      if (hung) return { code: null, stdout: '', stderr: 'skipped' };
      const r = await rawGit(args, opts);
      if (r.hung) hung = args.join(' ');
      return r;
    });
    if (hung) failures.push(`${name} (pins alone): git hung and was stopped after 30 s: ${hung}; the later commands were skipped`);
    fired(t, `${name} (pins alone)`);
  });
  // A program that ran after its case was looked at is caught here.
  for (const [name, t] of done) { fired(t, `${name} (after the sweep)`); await t.net.close(); }
  assert.equal(done.length, cases.length);
  assert.deepEqual(failures.sort(), []);
});

test('L36 sweep, control: the planted programs run when git is used the careless way', { timeout: 120_000 }, async () => {
  const w = await trapWorld();
  const markers = join(w.root, 'markers');
  mkdirSync(markers);
  const prog = (name) => { const p = join(w.root, name); writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\ncat\n`); chmodSync(p, 0o755); return p; };
  writeFileSync(join(w.gd, 'config'), `${readFileSync(join(w.gd, 'config'), 'utf8')}[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${prog('gpg')}\n[gpg "ssh"]\n\tprogram = ${prog('gpg-ssh')}\n\tallowedSignersFile = ${prog('signers')}\n[filter "x"]\n\tclean = ${prog('clean')}\n[diff "x"]\n\ttextconv = ${prog('textconv')}\n`);
  writeFileSync(join(w.d, '.gitattributes'), '* filter=x diff=x\n');
  writeFileSync(join(w.d, 'a.txt'), 'changed\n');
  const env = { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: w.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...NO_PROMPT };
  for (const a of [['log', '-n4', '--format=%H %s', 'main'], ['add', '-A'], ['diff', '--cached']]) spawnSync('git', ['--no-pager', '-C', w.d, ...a], { env, timeout: 60_000 });
  assert.deepEqual(readdirSync(markers).sort(), ['clean', 'gpg', 'gpg-ssh', 'textconv']);
  // The reported case through safe-git: refused (the textconv and filter keys) or no program run.
  rmSync(markers, { recursive: true }); mkdirSync(markers);
  await git(['log', '-n4', '--format=%H %s', 'main'], { gitDir: w.gd });
  assert.deepEqual(readdirSync(markers), []);
});

test('L36: the no-program flags go right after a diff-family command, once; other commands are unchanged', () => {
  assert.deepEqual(withNoPrograms(['--literal-pathspecs', 'log', '-n1']), ['--literal-pathspecs', 'log', '--no-ext-diff', '--no-textconv', '-n1']);
  assert.deepEqual(withNoPrograms(['diff-tree', '--no-ext-diff', '-p']), ['diff-tree', '--no-textconv', '--no-ext-diff', '-p']);
  for (const c of ['show', 'diff', 'diff-index', 'diff-files', 'format-patch']) assert.deepEqual(withNoPrograms([c]), [c, '--no-ext-diff', '--no-textconv']);
  for (const a of [['status'], ['cat-file', 'blob', 'log'], ['rev-parse', 'HEAD'], []]) assert.deepEqual(withNoPrograms(a), a);
});

test('L36: the flags reach git: a diff-family command runs with them', async () => {
  const d = tmp();
  const fake = join(d, 'fake-git');
  writeFileSync(fake, '#!/bin/sh\necho "$@"\n');
  chmodSync(fake, 0o755);
  mkdirSync(join(d, 'empty'));
  const r = await git(['--literal-pathspecs', 'log', '-n1'], { gitDir: join(d, 'empty'), gitBin: fake });
  assert.equal(r.stdout.toString().trim(), '--no-pager --literal-pathspecs log --no-ext-diff --no-textconv -n1');
});

test('L36: a repository config that cannot be read is refused; a folder with no config yet is not; nothing there is refused but for init', async () => {
  const d = tmp();
  assert.match(await repoConfigWhy(join(d, 'none')) ?? '', /missing/);
  assert.equal((await git(['status'], { gitDir: join(d, 'none') })).code, -1);
  mkdirSync(join(d, 'empty'));
  assert.equal(await repoConfigWhy(join(d, 'empty')), null);
  const gd = join(d, '.git');
  await gitOk(['init', '-q', d], { gitDir: gd });
  assert.equal(await repoConfigWhy(gd), null);
  writeFileSync(join(gd, 'config'), '[core\n\tbroken');
  assert.match(await repoConfigWhy(gd), /could not be read/);
  const r = await git(['status'], { gitDir: gd, workTree: d });
  assert.equal(r.code, -1);
});

test('L36: a program named in a file the repository config includes is refused, by plain and conditional include', async () => {
  for (const how of ['[include]\n\tpath', '[includeIf "gitdir:/"]\n\tpath']) {
    const d = tmp();
    const gd = join(d, '.git');
    await gitOk(['init', '-q', d], { gitDir: gd });
    writeFileSync(join(d, 'more.cfg'), '[filter "x"]\n\tclean = /usr/bin/false\n');
    writeFileSync(join(gd, 'config'), `${readFileSync(join(gd, 'config'), 'utf8')}${how} = ${join(d, 'more.cfg')}\n`);
    assert.match(await repoConfigWhy(gd) ?? '', /include(?:if\.gitdir:\/)?\.path/, how);
    assert.equal((await git(['status'], { gitDir: gd, workTree: d })).code, -1, how);
  }
});

test('L36: a credential helper in the repository config never runs when git asks for a login', async () => {
  const d = tmp();
  const gd = join(d, '.git');
  await gitOk(['init', '-q', d], { gitDir: gd });
  const marker = join(d, 'helper-ran');
  const helper = join(d, 'helper');
  writeFileSync(helper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(helper, 0o755);
  writeFileSync(join(gd, 'config'), `${readFileSync(join(gd, 'config'), 'utf8')}[credential]\n\thelper = ${helper}\n`);
  await git(['credential', 'fill'], { gitDir: gd, input: 'protocol=https\nhost=example.invalid\n\n' });
  assert.ok(!existsSync(marker), 'the helper ran');
});

// LEAD-CALLS L49: deny by default. Every key the installed git documents, planted with a program as its value, is
// refused and named, unless it is on the safe list; each key the list lets through, planted the same way or with a
// network address, starts no program and reaches no network across every kind of command.
test('L49 sweep: every key git lists is refused and named unless it is on the safe list; those let through start nothing', { timeout: 120_000 }, async () => {
  const listed = spawnSync('git', ['help', '--config'], { encoding: 'utf8', env: safeGitEnv() }).stdout.split('\n')
    .filter((l) => /^[A-Za-z0-9][A-Za-z0-9.<>*_-]*$/.test(l) && l.includes('.'));
  assert.ok(listed.length > 900, `git listed only ${listed.length} keys`);
  // Keys ordinary repositories have that git does not list (#32 round 2, Minor 6): swept the same way.
  listed.push('extensions.relativeWorktrees', 'remote.<name>.gh-resolved', 'branch.<name>.vscode-merge-base');
  const w = await trapWorld();
  const markers = join(w.root, 'markers');
  mkdirSync(markers);
  const prog = join(w.root, 'trap');
  writeFileSync(prog, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, 'ran'))}\ncat\n`);
  chmodSync(prog, 0o755);
  const clean = readFileSync(join(w.gd, 'config'), 'utf8');
  const section = (key, value) => {
    const parts = key.replace(/<[^>]+>|\*/g, 'x').split('.');
    const v = parts.pop();
    const head = parts.length > 1 ? `[${parts[0]} "${parts.slice(1).join('.')}"]` : `[${parts[0]}]`;
    return { name: parts.concat(v).join('.'), text: `${head}\n\t${v} = ${value}\n` };
  };
  const failures = [];
  const let_through = [];
  // Each slot plants its keys, one at a time, in its own copy of the repository.
  const slots = await Promise.all(Array.from({ length: POOL }, async (_, k) => { const d = join(w.root, 'keys', String(k)); await cp(w.d, d, { recursive: true }); return join(d, '.git'); }));
  const whys = [];
  await inPool(listed, POOL, async (key, k, i) => {
    await writeFile(join(slots[k], 'config'), clean + section(key, prog).text);
    whys[i] = await repoConfigWhy(slots[k]);
  });
  for (const [i, key] of listed.entries()) {
    const { name } = section(key, prog);
    const why = whys[i];
    const listedAs = name.split('.').map((x, i, a) => (i === 0 || i === a.length - 1 ? x.toLowerCase() : x)).join('.');
    if (inertSetting(listedAs, prog)) {
      if (why) failures.push(`${key}: on the list but refused: ${why}`);
      let_through.push(key);
    } else if (!why) failures.push(`${key}: let through`);
    else if (!why.includes(listedAs) && !/could not be read/.test(why)) failures.push(`${key}: refused without naming it: ${why}`);
  }
  assert.equal(whys.length, listed.length);
  assert.deepEqual(failures, []);
  // What the list lets through is these keys, nothing more. A fixed list, not INERT_KEYS itself: a key added to the
  // safe list (say core.pager, harmless only while it stays pinned) passed a check made against the list (#35), so
  // adding one now means changing this test too.
  const SAFE_LIST = new Set(['core.repositoryformatversion', 'core.bare', 'core.filemode', 'core.logallrefupdates', 'core.ignorecase',
    'core.precomposeunicode', 'core.symlinks', 'extensions.objectformat', 'extensions.worktreeconfig', 'user.name', 'user.email',
    'core.autocrlf', 'core.untrackedcache', 'extensions.relativeworktrees',
    'remote.<name>.url', 'remote.<name>.pushurl', 'remote.<name>.fetch', 'remote.<name>.gh-resolved',
    'branch.<name>.merge', 'branch.<name>.rebase', 'branch.<name>.vscode-merge-base']);
  assert.deepEqual(let_through.filter((k) => !SAFE_LIST.has(k.toLowerCase())), [], 'let through, but not on the fixed list');
  assert.deepEqual([...INERT_KEYS].filter((k) => !SAFE_LIST.has(k)), [], 'on INERT_KEYS, but not on the fixed list');
  // Each of those, planted with the program or with a network address, starts nothing and reaches nothing. Each case
  // has its own program, markers and listener, so the cases run side by side.
  const cases = let_through.flatMap((key) => [[key, 'prog'], [key, 'net']]);
  const done = [];
  let ran = 0;
  await inPool(cases, POOL, async ([key, kind]) => {
    const t = await sweepCase(w, `${key}-${kind}`);
    done.push([key, kind, t]);
    const trap = join(t.dir, 'trap');
    await writeFile(trap, `#!/bin/sh\ntouch ${JSON.stringify(join(t.markers, 'ran'))}\ncat\n`);
    await chmod(trap, 0o755);
    const value = kind === 'prog' ? trap : `${t.net.url}/x.git`;
    await writeFile(join(t.d, '.git', 'config'), clean + section(key, value).text);
    if (await repoConfigWhy(join(t.d, '.git'))) return; // a value the list refuses (an http address)
    ran += 1;
    await everyCommand(t.cw, t.d, (args, opts) => git(args, opts));
  });
  // Looked at once every case is done, so a program that ran late is caught too.
  for (const [key, kind, t] of done) {
    const f = readdirSync(t.markers);
    if (f.length || t.net.hits()) failures.push(`${key} = ${kind === 'prog' ? 'a program' : 'a network address'}: ran ${f.length}, network ${t.net.hits()}`);
    await t.net.close();
  }
  assert.equal(done.length, cases.length);
  assert.ok(ran >= let_through.length, `only ${ran} of the cases ran their commands`);
  assert.deepEqual(failures.sort(), []);
});

test('L49: a planted program behind a pointer file, a commondir, a worktree or a submodule config is refused, naming the file', async () => {
  const w = await trapWorld();
  const bad = '[filter "x"]\n\tclean = /usr/bin/false\n';
  const planted = async (name, put) => {
    const d = join(w.root, name);
    cpSync(w.d, d, { recursive: true });
    const gd = join(d, '.git');
    const gitDir = put(d, gd) ?? gd;
    return { d, gitDir, why: await repoConfigWhy(gitDir), r: await git(['status', '--porcelain'], { gitDir, workTree: d }) };
  };
  const cases = {
    'pointer file': (d, gd) => { const p = join(d, 'ptr'); writeFileSync(join(gd, 'config'), `${readFileSync(join(gd, 'config'), 'utf8')}${bad}`); writeFileSync(p, `gitdir: ${gd}\n`); return p; },
    'relative pointer file': (d, gd) => { const p = join(d, 'sub', 'ptr'); mkdirSync(dirname(p)); writeFileSync(join(gd, 'config'), `${readFileSync(join(gd, 'config'), 'utf8')}${bad}`); writeFileSync(p, 'gitdir: ../.git\n'); return p; },
    commondir: (d, gd) => { const c = join(d, 'common'); cpSync(gd, c, { recursive: true }); writeFileSync(join(c, 'config'), `${readFileSync(join(c, 'config'), 'utf8')}${bad}`); writeFileSync(join(gd, 'commondir'), '../common\n'); },
    'config.worktree': (d, gd) => { writeFileSync(join(gd, 'config.worktree'), bad); },
    "another worktree's config": (d, gd) => { mkdirSync(join(gd, 'worktrees', 'w2'), { recursive: true }); writeFileSync(join(gd, 'worktrees', 'w2', 'config.worktree'), bad); },
    'submodule config': (d, gd) => { mkdirSync(join(gd, 'modules', 's'), { recursive: true }); writeFileSync(join(gd, 'modules', 's', 'config'), bad); },
    'nested submodule config': (d, gd) => { mkdirSync(join(gd, 'modules', 'a', 'modules', 'b/c'), { recursive: true }); writeFileSync(join(gd, 'modules', 'a', 'modules', 'b/c', 'config'), bad); },
  };
  // Since #32 round 3 (L51) a pointer leads only to a linked worktree's folder, and a commondir only from one: these
  // three are refused for where they lead, before any config is read.
  const byPlace = { 'pointer file': /pointer leads to .*not a linked worktree/, 'relative pointer file': /pointer leads to .*not a linked worktree/, commondir: /commondir leads outside/ };
  for (const [name, put] of Object.entries(cases)) {
    const { why, r } = await planted(name.replace(/[^a-z]+/gi, '-'), put);
    assert.match(why ?? '', byPlace[name] ?? /filter\.x\.clean/, name);
    assert.equal(r.code, -1, name);
  }
  // A pointer file to a clean repository that is not a linked worktree is refused too (the worktree test covers the
  // pointer git itself writes).
  const ok = await planted('clean-pointer', (d, gd) => { const p = join(d, 'ptr'); writeFileSync(p, `gitdir: ${gd}\n`); return p; });
  assert.match(ok.why ?? '', /not a linked worktree/);
  assert.equal(ok.r.code, -1, ok.r.stderr);
  for (const p of ['not a pointer\n', 'gitdir: /nonexistent-folder\n']) {
    const f = join(ok.d, 'bad-ptr'); writeFileSync(f, p);
    assert.match(await repoConfigWhy(f) ?? '', /pointer/);
  }
});

test('L49 Minor: no empty diff.external pin, which breaks a submodule diff once submodule diffs are shown', () => {
  // Diff-family commands already get --no-ext-diff; an empty diff.external only made `diff --submodule=diff` fail.
  assert.equal(SAFE_CONFIG.some(([k]) => k.toLowerCase() === 'diff.external'), false);
  assert.ok(SAFE_CONFIG.some(([k, v]) => k === 'diff.ignoreSubmodules' && v === 'all'), 'submodule diffs stay hidden');
});

test('L49: a repository nested in the work tree is never looked into, and a submodule diff still works', async () => {
  const w = await trapWorld();
  const o = { gitDir: w.gd, workTree: w.d };
  const sub = join(w.d, 'sub');
  await gitOk(['init', '-q', sub], { gitDir: join(sub, '.git') });
  writeFileSync(join(sub, 'a.txt'), 'a\n');
  await gitOk(['add', '-A'], { gitDir: join(sub, '.git'), workTree: sub });
  await gitOk(['commit', '-qm', 'a'], { gitDir: join(sub, '.git'), workTree: sub });
  await gitOk(['add', 'sub'], o);
  await gitOk(['commit', '-qm', 'sub'], o);
  const marker = join(w.root, 'ran');
  const prog = join(w.root, 'trap');
  writeFileSync(prog, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
  chmodSync(prog, 0o755);
  writeFileSync(join(sub, '.git', 'config'), `${readFileSync(join(sub, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = ${prog}\n[core]\n\tfsmonitor = ${prog}\n`);
  writeFileSync(join(sub, '.gitattributes'), '* filter=x\n');
  writeFileSync(join(sub, 'a.txt'), 'changed\n');
  for (const a of [['diff', '--submodule=diff'], ['diff', '--submodule=diff', 'HEAD'], ['status', '--porcelain'], ['log', '-p', '-1', '--submodule=diff'], ['add', '-A']]) {
    const r = await git(a, o);
    assert.equal(r.code, 0, `${a.join(' ')}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /cannot run|external diff died/, a.join(' '));
    assert.equal(existsSync(marker), false, `${a.join(' ')} ran the nested repository's program`);
  }
  // Control: with the nested repository looked into, its program runs.
  await git(['diff', '--submodule=diff'], { ...o, extraConfig: [['diff.ignoreSubmodules', 'none']] });
  assert.equal(existsSync(marker), true, 'control: the nested program should run when submodules are looked into');
});

test('L49 Minor: the no-program flags find the command after -c, -C and the other options that take a value', () => {
  assert.deepEqual(withNoPrograms(['-c', 'x.y=z', 'log', '-1']), ['-c', 'x.y=z', 'log', '--no-ext-diff', '--no-textconv', '-1']);
  assert.deepEqual(withNoPrograms(['-C', '/r', 'diff']), ['-C', '/r', 'diff', '--no-ext-diff', '--no-textconv']);
  assert.deepEqual(withNoPrograms(['--git-dir', '/g', '--work-tree', '/w', '--literal-pathspecs', 'show']), ['--git-dir', '/g', '--work-tree', '/w', '--literal-pathspecs', 'show', '--no-ext-diff', '--no-textconv']);
  assert.deepEqual(withNoPrograms(['-c', 'diff', 'status']), ['-c', 'diff', 'status'], 'a value that looks like a command is skipped');
  assert.deepEqual(withNoPrograms(['-C', 'log']), ['-C', 'log']);
});

test('L49: a remote address is let through only as plain https, ssh, file or a local path', () => {
  for (const v of ['https://github.com/o/r.git', 'ssh://git@github.com/o/r.git', 'git@github.com:o/r.git', 'file:///srv/r.git', '/srv/r.git']) {
    assert.equal(inertSetting('remote.origin.url', v), true, v);
    assert.equal(inertSetting('remote.origin.pushurl', v), true, v);
  }
  for (const v of ['ext::sh -c x', 'fd::3', 'http://example.invalid/r.git', 'ssh://-oProxyCommand=x/r', 'git@host:-oProxyCommand=x', 'rel/path', '../r.git', 'https://a b', '', undefined, 'trap::https://x']) {
    assert.equal(inertSetting('remote.origin.url', v), false, String(v));
  }
  assert.equal(inertSetting('remote.origin.uploadpack', '/srv/r.git'), false);
  assert.equal(inertSetting('core.worktree', '/x'), false, 'a submodule work tree setting is not on the list');
});

test('L49: git is handed the folder the check read, not the pointer file', async () => {
  const w = await trapWorld();
  const wt = join(w.root, 'wt');
  await gitOk(['worktree', 'add', '-q', wt, 'side'], { gitDir: w.gd, workTree: w.d });
  const fake = join(w.root, 'fake-git');
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = config ] && exit 0\necho "$GIT_DIR|$GIT_COMMON_DIR"\n');
  chmodSync(fake, 0o755);
  const r = await git(['status'], { gitDir: join(wt, '.git'), gitBin: fake });
  const real = realpathSync.native(w.gd);
  assert.equal(r.stdout.toString().trim(), `${real}/worktrees/wt|${real}`);
});

// #32 round 2: a hook named in config (git 2.54 runs these even with core.hooksPath pinned), and a repository copy.
const hookConfig = (marker) => `[hook "x"]\n\tcommand = touch ${marker}\n\tevent = reference-transaction\n`;
const copyOf = (w, name) => { const d = join(w.root, name); cpSync(w.d, d, { recursive: true }); return { d, gd: join(d, '.git') }; };

test('#32 round 2 M1: a commondir git reads differently (a trailing space; a link then ..) never lets a planted hook run', async () => {
  const w = await trapWorld();
  // A: commondir is "c " plus a newline. Git keeps the space and reads the hooked "c "; trim() read the clean "c".
  const a = join(w.root, 'A');
  mkdirSync(a);
  cpSync(w.gd, join(a, 'c'), { recursive: true });
  cpSync(w.gd, join(a, 'c '), { recursive: true });
  const markA = join(w.root, 'PWNED-A');
  appendFileSync(join(a, 'c ', 'config'), hookConfig(markA));
  writeFileSync(join(a, 'HEAD'), readFileSync(join(w.gd, 'HEAD')));
  writeFileSync(join(a, 'commondir'), 'c \n');
  // B: commondir is lnk/../x, and lnk leads to other/sub. Git reads other/x; resolve() read the clean B/x.
  const b = join(w.root, 'B');
  mkdirSync(join(w.root, 'other', 'sub'), { recursive: true });
  mkdirSync(b);
  symlinkSync(join(w.root, 'other', 'sub'), join(b, 'lnk'));
  cpSync(w.gd, join(b, 'x'), { recursive: true });
  cpSync(w.gd, join(w.root, 'other', 'x'), { recursive: true });
  const markB = join(w.root, 'PWNED-B');
  appendFileSync(join(w.root, 'other', 'x', 'config'), hookConfig(markB));
  writeFileSync(join(b, 'HEAD'), readFileSync(join(w.gd, 'HEAD')));
  writeFileSync(join(b, 'commondir'), 'lnk/../x\n');

  // Since #32 round 3 (L51), B is refused for where its commondir leads (outside the repository) before any config is read.
  for (const [gitDir, mark, why] of [[a, markA, /commondir is not one path/], [b, markB, /commondir leads outside the repository/]]) {
    assert.match(await repoConfigWhy(gitDir) ?? '', why, gitDir);
    const r = await git(['update-ref', 'refs/heads/zz', 'HEAD'], { gitDir });
    assert.equal(r.code, -1, r.stderr);
    assert.equal(existsSync(mark), false, `${gitDir}: the planted hook ran`);
    // Control: the pins alone, with git reading commondir itself, run the hook.
    await rawGit(['update-ref', 'refs/heads/zz', 'HEAD'], { gitDir });
    assert.equal(existsSync(mark), true, `${gitDir}: control: the hook should run when git reads commondir itself`);
    rmSync(mark);
  }
  // The link-then-.. read the right way, in a layout let through: a worktree's own folder M/worktrees/b whose commondir
  // is lnk/../../../.., with lnk leading to M/worktrees/b/deep/x. Through the real folders that is M; by its text it
  // would be the folder above M, whose config is hooked.
  const m = join(w.root, 'M');
  cpSync(w.gd, m, { recursive: true });
  const adm = join(m, 'worktrees', 'b');
  mkdirSync(join(adm, 'deep', 'x'), { recursive: true });
  writeFileSync(join(adm, 'HEAD'), readFileSync(join(w.gd, 'HEAD')));
  symlinkSync(join(adm, 'deep', 'x'), join(adm, 'lnk'));
  writeFileSync(join(adm, 'commondir'), 'lnk/../../../..\n');
  writeFileSync(join(w.root, 'config'), `[core]\n\trepositoryformatversion = 0\n${hookConfig(markB)}`);
  assert.equal(await repoConfigWhy(adm), null);
  const found = repoConfigFiles(adm);
  assert.equal(found.common, realpathSync.native(m));
  assert.equal((await git(['update-ref', 'refs/heads/zz', 'HEAD'], { gitDir: adm })).code, 0);
  assert.equal(existsSync(markB), false, 'git read a commondir other than the one checked');
  assert.equal((await gitOk(['rev-parse', '--git-common-dir'], { gitDir: adm })).trim(), found.common);
});

test('#32 round 2 M1: a pointer or commondir path is taken only when git and the check read it the same way', () => {
  for (const ok of ['c\n', 'c', '../x\n', 'a b\n', '/abs/path\n']) assert.equal(pointerPath(Buffer.from(ok)), ok.replace(/\n$/, ''), JSON.stringify(ok));
  for (const bad of ['c \n', ' c\n', 'c\t\n', '\uFEFFc\n', 'c\r\n', 'c\n\n', 'c\0\n', 'c\nd\n', '', '\n', 'c\u00a0\n', '\u00a0c']) {
    assert.equal(pointerPath(Buffer.from(bad)), null, JSON.stringify(bad));
  }
  assert.equal(pointerPath(Buffer.from([0x63, 0xff, 0x0a])), null, 'not UTF-8');
  assert.equal(pointerPath(Buffer.from('gitdir: ../.git\n'), 'gitdir: '), '../.git');
  for (const bad of ['gitdir:  x\n', 'gitdir: x \n', 'gitdir:x\n', 'x\ngitdir: y\n']) assert.equal(pointerPath(Buffer.from(bad), 'gitdir: '), null, JSON.stringify(bad));
});

test('#32 round 2 M1: a missing or dangling .git is refused; only git init runs where nothing is yet', async () => {
  const d = tmp();
  symlinkSync(join(d, 'nowhere'), join(d, 'dangling'));
  assert.match(await repoConfigWhy(join(d, 'dangling')) ?? '', /leads nowhere/);
  assert.match(await repoConfigWhy(join(d, 'none')) ?? '', /missing/);
  assert.equal((await git(['status'], { gitDir: join(d, 'none') })).code, -1);
  assert.equal((await git(['init', '-q', join(d, 'dangling')], { gitDir: join(d, 'dangling') })).code, -1, 'init never follows a dangling link');
  assert.equal((await git(['init', '-q', join(d, 'r')], { gitDir: join(d, 'r', '.git') })).code, 0);
  assert.equal((await checkGitVersion()).ok, true, 'a call with no command opens no repository');
});

test('#32 round 2 M1: git and the check agree on every config file and folder, for every allowed command, on a linked worktree', { timeout: 120_000 }, async () => {
  const w = await trapWorld();
  const wt = join(w.root, 'wt');
  await gitOk(['worktree', 'add', '-q', '-b', 'wt', wt, 'main'], { gitDir: w.gd, workTree: w.d });
  appendFileSync(join(w.gd, 'config'), '[extensions]\n\tworktreeConfig = true\n');
  writeFileSync(join(w.gd, 'config.worktree'), '[user]\n\temail = main@localhost\n');
  writeFileSync(join(w.gd, 'worktrees', 'wt', 'config.worktree'), '[user]\n\tname = wt\n');
  for (const [gitDir, workTree] of [[w.gd, w.d], [join(wt, '.git'), wt]]) {
    const found = repoConfigFiles(gitDir);
    assert.equal(found.why, undefined, found.why);
    const origins = (await gitOk(['config', '--list', '--show-origin', '--show-scope'], { gitDir, workTree })).split('\n')
      .map((l) => l.split('\t')).filter(([scope]) => scope === 'local' || scope === 'worktree').map(([, o]) => realpathSync.native(o.replace(/^file:/, '')));
    assert.deepEqual([...new Set(origins)].sort(), [join(found.common, 'config'), join(found.dir, 'config.worktree')].sort(), gitDir);
    const checked = new Set(found.files.map((f) => realpathSync.native(f)));
    for (const o of origins) assert.ok(checked.has(o), `git read ${o}, which the check did not`);
    assert.deepEqual((await gitOk(['rev-parse', '--git-dir', '--git-common-dir'], { gitDir, workTree })).trim().split('\n'), [found.dir, found.common]);
  }
  // Every command the scripts run is handed exactly the folders the check read.
  const found = repoConfigFiles(join(wt, '.git'));
  const log = join(w.root, 'env.log');
  const wrapper = join(w.root, 'git-wrapper');
  writeFileSync(wrapper, `#!/bin/sh\n[ -n "$GIT_DIR" ] && printf '%s|%s|%s\\n' "$GIT_DIR" "$GIT_COMMON_DIR" "$*" >> ${JSON.stringify(log)}\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);
  await everyCommand(w, wt, (args, opts) => git(args, { ...opts, gitBin: wrapper }));
  const lines = readFileSync(log, 'utf8').trim().split('\n').filter((l) => !l.includes('/into-'));
  assert.ok(lines.length >= 40, `only ${lines.length} commands ran`);
  for (const l of lines) assert.ok(l.startsWith(`${found.dir}|${found.common}|`), l);
});

test('#32 round 2 Minors 1 and 2: a remote named like an address, or a branch whose remote is not a plain name, is refused', async () => {
  const w = await trapWorld();
  for (const name of ['a/b', 'x:y', `file://${w.root}/A`]) {
    for (const k of ['url', 'pushurl', 'fetch', 'gh-resolved']) assert.equal(inertSetting(`remote.${name}.${k}`, '/srv/r.git'), false, `${name} ${k}`);
  }
  for (const v of ['origin', 'up-stream_2', '.x', 'x.']) assert.equal(inertSetting('branch.main.remote', v), true, v);
  // `.`, `..` and `~…` are refused since #32 round 3 (`branch.main.remote = ..` fetched the folder above).
  for (const v of ['ext::sh -c touch', '/srv/r.git', 'a:b', 'a/b', '-x', '', undefined, 'a b', '.', '..', '~', '~x']) assert.equal(inertSetting('branch.main.remote', v), false, String(v));
  for (const name of ['.', '..', '~', '~x']) {
    for (const k of ['url', 'pushurl', 'fetch', 'gh-resolved']) assert.equal(inertSetting(`remote.${name}.${k}`, '/srv/r.git'), false, `${name} ${k}`);
  }
  for (const name of ['.x', 'x.y', 'a..b']) assert.equal(inertSetting(`remote.${name}.url`, '/srv/r.git'), true, name);
  const { d, gd } = copyOf(w, 'remote-name');
  appendFileSync(join(gd, 'config'), `[remote "file://${w.root}/A"]\n\turl = ${w.src}\n`);
  assert.match(await repoConfigWhy(gd) ?? '', /remote\.file:/);
  const args = ['fetch', '-q', '--no-tags', `file://${w.root}/A`, 'refs/heads/src-main:refs/heads/got'];
  assert.equal((await git(args, { gitDir: gd, workTree: d })).code, -1);
  assert.equal(existsSync(join(gd, 'refs', 'heads', 'got')), false);
  // Control: git fetches from the address the remote's config names, not the one the call named.
  await rawGit(args, { gitDir: gd, workTree: d });
  assert.equal(existsSync(join(gd, 'refs', 'heads', 'got')), true, 'control: the planted remote should redirect the fetch');
  const b = copyOf(w, 'branch-remote');
  appendFileSync(join(b.gd, 'config'), '[branch "main"]\n\tremote = ext::sh -c touch\n');
  assert.match(await repoConfigWhy(b.gd) ?? '', /branch\.main\.remote/);
});

test('#32 round 2 Minor 6: keys ordinary repositories have are let through (the L49 sweep runs each); http and hooksPath stay refused', async () => {
  for (const k of ['core.autocrlf', 'core.untrackedcache', 'extensions.relativeworktrees', 'remote.origin.gh-resolved', 'branch.main.vscode-merge-base']) {
    assert.equal(inertSetting(k, 'true'), true, k);
  }
  assert.equal(inertSetting('remote.origin.url', 'http://example.invalid/r.git'), false);
  const w = await trapWorld();
  const { gd } = copyOf(w, 'ordinary');
  appendFileSync(join(gd, 'config'), '[core]\n\tautocrlf = input\n\tuntrackedCache = true\n[remote "origin"]\n\tgh-resolved = base\n[branch "main"]\n\tvscode-merge-base = origin/main\n');
  assert.equal(await repoConfigWhy(gd), null);
  appendFileSync(join(gd, 'config'), '[extensions]\n\tworktreeConfig = true\n');
  writeFileSync(join(gd, 'config.worktree'), '[core]\n\thooksPath = /x\n');
  assert.match(await repoConfigWhy(gd) ?? '', /core\.hookspath \(config\.worktree\)/);
});

test('#32 round 2 Minor 3: old-style remote files are refused; an empty folder is not', async () => {
  const w = await trapWorld();
  const { d, gd } = copyOf(w, 'legacy');
  mkdirSync(join(gd, 'branches'));
  assert.equal(await repoConfigWhy(gd), null, 'an empty branches folder is let through');
  mkdirSync(join(gd, 'remotes'));
  writeFileSync(join(gd, 'remotes', 'origin'), `URL: ${w.src}\nPull: refs/heads/src-main:refs/heads/got\n`);
  assert.match(await repoConfigWhy(gd) ?? '', /old-style remote files in remotes/);
  assert.equal((await git(['fetch', '-q', '--no-tags', 'origin'], { gitDir: gd, workTree: d })).code, -1);
  assert.equal(existsSync(join(gd, 'refs', 'heads', 'got')), false);
  await rawGit(['fetch', '-q', '--no-tags', 'origin'], { gitDir: gd, workTree: d });
  assert.equal(existsSync(join(gd, 'refs', 'heads', 'got')), true, 'control: the remotes file should redirect the fetch');
  rmSync(join(gd, 'remotes'), { recursive: true });
  writeFileSync(join(gd, 'branches', 'origin'), `${w.src}#src-main\n`);
  assert.match(await repoConfigWhy(gd) ?? '', /old-style remote files in branches/);
});

test('#32 round 2 Minor 4: a borrowed-objects list is refused unless it names only the folders the call allows', async () => {
  const w = await trapWorld();
  const only = (await gitOk(['hash-object', '-w', '--stdin'], { gitDir: join(w.src, '.git'), input: 'only in src\n' })).trim();
  const { gd } = copyOf(w, 'alt');
  const srcObjects = join(w.src, '.git', 'objects');
  const alt = join(gd, 'objects', 'info', 'alternates');
  writeFileSync(alt, `${srcObjects}\n`);
  assert.match(await repoConfigWhy(gd) ?? '', /alternates/);
  assert.equal((await git(['cat-file', '-e', only], { gitDir: gd })).code, -1);
  assert.equal((await rawGit(['cat-file', '-e', only], { gitDir: gd })).code, 0, 'control: git reads the borrowed object');
  assert.equal((await git(['cat-file', '-e', only], { gitDir: gd, allowObjects: [srcObjects] })).code, 0);
  writeFileSync(alt, '../../../src/.git/objects\n');
  assert.equal(await repoConfigWhy(gd, { allowObjects: [srcObjects] }), null, 'a relative line is read from the objects folder, as git reads it');
  writeFileSync(alt, `${srcObjects}\n${join(w.peer, 'objects')}\n`);
  assert.match(await repoConfigWhy(gd, { allowObjects: [srcObjects] }) ?? '', /alternates/);
  writeFileSync(alt, '');
  assert.equal(await repoConfigWhy(gd), null, 'an empty list borrows nothing');
  writeFileSync(join(gd, 'objects', 'info', 'http-alternates'), '');
  assert.match(await repoConfigWhy(gd) ?? '', /http-alternates/);
});

// #32 round 3 (LEAD-CALLS L51): where git may go is named by the call, never by the repository's own files.
test('#32 round 3 (L51): a command that reaches another repository runs only with an absolute path or the address the call allows', () => {
  const ok = (args, address) => assert.equal(placeWhy(args, 0, address), null, args.join(' '));
  const no = (args, why, address) => assert.match(placeWhy(args, 0, address) ?? '', why, args.join(' '));
  ok(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', '/srv/mirror', 'main:main']);
  ok(['push', '--porcelain', '--atomic', '--no-verify', '/srv/peer.git', 'a:refs/heads/b']);
  ok(['ls-remote', '--heads', '/srv/peer.git', 'refs/heads/x']);
  ok(['fetch', '-q', '--', '/srv/b.bundle', 'x:y']);
  const gh = 'https://github.com/o/r';
  ok(['ls-remote', '--heads', gh, 'refs/heads/x'], gh);
  ok(['push', '--porcelain', gh, 'a:refs/heads/b'], gh);
  for (const args of [['fetch'], ['fetch', '-q'], ['ls-remote'], ['ls-remote', '--heads'], ['push', '-q'], ['pull'], ['fetch', '-q', '--', ]]) no(args, /names no place/);
  for (const place of ['origin', '.', '..', '~x', 'rel/path', 'file:///srv/r', 'git@host:r', 'ssh://host/r', gh]) {
    for (const cmd of ['fetch', 'push', 'ls-remote', 'pull']) no([cmd, '-q', place, 'main'], /only an absolute local path/);
  }
  no(['fetch', gh], /only an absolute local path/, 'https://github.com/o/other');
  no(['fetch', 'origin'], /only an absolute local path/, 'origin');
  for (const opt of ['--all', '--multiple', '--upload-pack=/x', '--upload-pack', '--receive-pack=/x', '--exec=/x', '--repo=origin', '-o', '--server-option=x', '--depth=1', '--get-url', '--set-upstream', '-u']) {
    no(['fetch', opt, '/srv/mirror'], /only plain switches/);
  }
  no(['fetch', '/srv/mirror', '--multiple', 'origin'], /only plain switches/);
  for (const args of [['remote', 'update'], ['remote', 'add', 'x', '/srv/r'], ['submodule', 'update'], ['maintenance', 'run', '--task=prefetch'], ['send-pack', '--remote=origin', '/srv/r'], ['request-pull', 'main', 'origin'], ['archive', '--remote=origin', 'main'], ['archive', '--remote', 'origin', 'main'], ['lfs', 'fetch'],
    ['remote-https', 'origin'], ['remote-http', 'origin'], ['remote-ext', 'x'], ['remote-fd', '0'], ['remote-ftp', 'origin']]) {
    no(args, /never runs it/);
  }
  ok(['archive', '--format=tar', 'main']);
  for (const args of [['status'], ['log', '-1'], ['bundle', 'create', '-q', '/x.bundle', 'main'], ['init', '-q', '/x']]) assert.equal(placeWhy(args, 0), null, args.join(' '));
});

test('#32 round 3 M1 (L51): an origin planted as https, ssh, git@host: or a local path is never reached, by any allowed command', { timeout: 120_000 }, async () => {
  const w = await trapWorld();
  const net = await listener();
  const port = net.url.split(':').pop();
  const failures = [];
  const plants = {
    https: `https://127.0.0.1:${port}/x.git`,
    ssh: `ssh://git@127.0.0.1:${port}/x.git`,
    // This form carries no port, so its host never resolves: a broken rule fails fast, never dialling this machine's ssh server.
    scp: 'git@scp-plant.invalid:x.git',
    path: w.src,
  };
  const byName = [['fetch', '-q', 'origin'], ['fetch', '-q', 'origin', 'refs/heads/src-main:refs/heads/got'], ['fetch', '-q'], ['fetch', '-q', '--all'],
    ['fetch', '-q', '--multiple', 'origin'], ['ls-remote'], ['ls-remote', 'origin'], ['ls-remote', '--heads'], ['push', '-q'], ['push', '-q', 'origin', 'main'],
    ['pull', '-q'], ['pull', '-q', 'origin', 'src-main'], ['remote', 'update'], ['remote', 'show', 'origin'], ['submodule', 'update', '--remote'],
    ['maintenance', 'run', '--task=prefetch'], ['archive', '--remote=origin', 'main'], ['fetch', '-q', w.src, '--multiple', 'origin']];
  for (const [name, url] of Object.entries(plants)) {
    const { d, gd } = copyOf(w, `origin-${name}`);
    appendFileSync(join(gd, 'config'), `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/src-main\n`);
    assert.equal(await repoConfigWhy(gd), null, `${name}: the planted origin is on the safe list, so only the place rule stops it`);
    const o = { gitDir: gd, workTree: d };
    for (const args of byName) {
      const r = await git(args, o);
      if (!(r.code === -1 && /^safe-git: refused: /.test(r.stderr))) failures.push(`${name}: ${args.join(' ')} ran (${r.code})`);
    }
    const peer = join(w.root, `peer-${name}.git`);
    await gitOk(['init', '--bare', '-q', peer], { gitDir: peer });
    const res = await everyCommand({ ...w, peer }, d, (args, opts) => git(args, opts));
    // The commands that name an absolute path still work with the planted origin there.
    for (const c of ['fetch -q --no-tags --no-write-fetch-head --no-auto-gc --no-recurse-submodules', 'push -q', 'ls-remote --heads']) {
      const hit = res.find(([k]) => k.startsWith(c) && !k.endsWith(c));
      if (hit?.[1].code !== 0) failures.push(`${name}: ${hit?.[0]} failed: ${hit?.[1].stderr}`);
    }
    if (net.hits()) failures.push(`${name}: reached the listener ${net.hits()} times`);
    net.reset();
    if (readdirSync(join(gd, 'refs')).includes('remotes') || existsSync(join(gd, 'refs', 'heads', 'got'))) failures.push(`${name}: the planted origin was fetched from`);
    if (name === 'https') {
      // Control: the pins alone (no place rule) let a by-name fetch reach the planted address.
      await rawGit(['fetch', '-q', 'origin'], o);
      if (!net.hits()) failures.push('control: a by-name fetch should reach the planted https origin with the pins alone');
      net.reset();
    }
    if (name === 'path') {
      await rawGit(['fetch', '-q', 'origin', 'refs/heads/src-main:refs/heads/got'], o);
      if (!existsSync(join(gd, 'refs', 'heads', 'got'))) failures.push('control: a by-name fetch should take the planted local origin with the pins alone');
    }
  }
  // Minor 1: a branch whose remote is .. is refused by the config check before the place rule is needed.
  const up = copyOf(w, 'branch-dotdot');
  appendFileSync(join(up.gd, 'config'), '[branch "main"]\n\tremote = ..\n\tmerge = refs/heads/main\n');
  assert.match(await repoConfigWhy(up.gd) ?? '', /branch\.main\.remote/);
  await net.close();
  assert.deepEqual(failures, []);
});

test('#32 round 3 (L51): every place a .git, a pointer, a commondir or a link inside the repository leads stays inside it', async () => {
  const w = await trapWorld();
  // The victim: another repository with a commit and an object the copies do not have.
  const v = copyOf(w, 'victim');
  const vo = { gitDir: v.gd, workTree: v.d };
  writeFileSync(join(v.d, 'secret.txt'), 'victim only\n');
  await gitOk(['add', '-A'], vo);
  await gitOk(['commit', '-q', '-m', 'victim secret'], vo);
  const vMain = (await gitOk(['rev-parse', 'refs/heads/main'], vo)).trim();
  const vBlob = (await gitOk(['rev-parse', 'main:secret.txt'], vo)).trim();
  await gitOk(['worktree', 'add', '-q', join(w.root, 'victim-wt'), 'side'], vo);
  const hasZz = () => existsSync(join(v.gd, 'refs', 'heads', 'zz'));
  const refused = async (label, gitDir, args, why) => {
    assert.match(await repoConfigWhy(gitDir) ?? '', why, label);
    const r = await git(args, { gitDir });
    assert.equal(r.code, -1, `${label}: ${r.stderr}`);
    return r;
  };

  // The lead's four repros, each with its control (git reading the files itself goes to the victim).
  const a = copyOf(w, 'commondir-victim');
  writeFileSync(join(a.gd, 'commondir'), `${v.gd}\n`);
  await refused('commondir', a.gd, ['update-ref', 'refs/heads/zz', 'HEAD'], /commondir leads outside the repository/);
  assert.equal(hasZz(), false, 'a ref was written into the victim');
  await rawGit(['update-ref', 'refs/heads/zz', 'HEAD'], { gitDir: a.gd });
  assert.equal(hasZz(), true, 'control: with git reading commondir itself, the ref lands in the victim');
  rmSync(join(v.gd, 'refs', 'heads', 'zz'));

  const b = copyOf(w, 'pointer-victim');
  rmSync(b.gd, { recursive: true });
  writeFileSync(b.gd, `gitdir: ${v.gd}\n`);
  const rb = await refused('pointer', b.gd, ['log', '-1', '--format=%s', 'main'], /pointer leads to .*not a linked worktree/);
  assert.doesNotMatch(rb.stdout.toString(), /victim secret/);
  assert.match((await rawGit(['log', '-1', '--format=%s', 'main'], { gitDir: b.gd })).stdout, /victim secret/, 'control: git follows the pointer to the victim');

  const c = copyOf(w, 'objects-victim');
  rmSync(join(c.gd, 'objects'), { recursive: true });
  symlinkSync(join(v.gd, 'objects'), join(c.gd, 'objects'));
  await refused('objects', c.gd, ['cat-file', '-e', vBlob], /its objects is a link to .*outside the repository/);
  assert.equal((await rawGit(['cat-file', '-e', vBlob], { gitDir: c.gd })).code, 0, 'control: git reads the victim\'s objects');

  const d = copyOf(w, 'ref-victim');
  symlinkSync(join(v.gd, 'refs', 'heads', 'main'), join(d.gd, 'refs', 'heads', 'v'));
  await refused('loose ref', d.gd, ['rev-parse', 'refs/heads/v'], /its refs\/heads\/v is a link to .*outside the repository/);
  assert.equal((await rawGit(['rev-parse', 'refs/heads/v'], { gitDir: d.gd })).stdout.trim(), vMain, 'control: git reads the victim\'s ref');

  // More of the same class.
  const e = join(w.root, 'link-dotgit');
  mkdirSync(e);
  symlinkSync(v.gd, join(e, '.git'));
  await refused('.git a link', join(e, '.git'), ['status'], /its \.git is a link/);
  const f = join(w.root, 'other-worktree');
  mkdirSync(f);
  writeFileSync(join(f, '.git'), `gitdir: ${join(v.gd, 'worktrees', 'victim-wt')}\n`);
  await refused('another worktree\'s folder', join(f, '.git'), ['status'], /does not name this pointer back/);
  const g = copyOf(w, 'dangling');
  symlinkSync(join(w.root, 'nowhere'), join(g.gd, 'info', 'gone'));
  await refused('dangling link', g.gd, ['status'], /its info\/gone is a link that leads nowhere/);
  const h = copyOf(w, 'packed-victim');
  writeFileSync(join(v.gd, 'packed-refs'), `${vMain} refs/heads/pv\n`);
  symlinkSync(join(v.gd, 'packed-refs'), join(h.gd, 'packed-refs'));
  await refused('packed-refs', h.gd, ['rev-parse', 'refs/heads/pv'], /its packed-refs is a link to/);

  // Let through: a link that stays inside, the victim's own worktree, and objects linked to a folder the call allows.
  const i = copyOf(w, 'inside-link');
  symlinkSync(join(i.gd, 'description'), join(i.gd, 'info', 'inside'));
  assert.equal(await repoConfigWhy(i.gd), null);
  assert.equal((await git(['status', '--porcelain'], { gitDir: i.gd, workTree: i.d })).code, 0);
  assert.equal(await repoConfigWhy(join(w.root, 'victim-wt', '.git')), null);
  assert.equal(await repoConfigWhy(c.gd, { allowObjects: [join(v.gd, 'objects')] }), null);
  // An object file with a second name is let through: a local clone hard-links its objects, and an object's name is its
  // content, so it can't be another repository's anything else.
  const ho = copyOf(w, 'hard-object');
  const obj = join(v.gd, 'objects', vBlob.slice(0, 2), vBlob.slice(2));
  mkdirSync(join(ho.gd, 'objects', vBlob.slice(0, 2)), { recursive: true });
  linkSync(obj, join(ho.gd, 'objects', vBlob.slice(0, 2), vBlob.slice(2)));
  assert.equal(await repoConfigWhy(ho.gd), null);

  // Last, since it gives the victim's own files a second name too. A hard link is not a link to the walk above, but it
  // is the same file as the other repository's (#32 cosmetic): a ref,
  // packed-refs or config with a second name is refused. Control: git reads the victim's ref through it.
  for (const [label, from, to, args] of [
    ['hard-linked loose ref', join(v.gd, 'refs', 'heads', 'main'), ['refs', 'heads', 'hv'], ['rev-parse', 'refs/heads/hv']],
    ['hard-linked packed-refs', join(v.gd, 'packed-refs'), ['packed-refs'], ['rev-parse', 'refs/heads/pv']],
  ]) {
    const k = copyOf(w, label.replace(/ /g, '-'));
    const at = join(k.gd, ...to);
    rmSync(at, { force: true });
    linkSync(from, at);
    await refused(label, k.gd, args, new RegExp(`its ${to.join('/')} has a second name \\(a hard link\\)`));
    assert.equal((await rawGit(args, { gitDir: k.gd })).stdout.trim(), vMain, `control: git reads the victim's ref through the ${label}`);
  }
  const hc = copyOf(w, 'hard-config');
  rmSync(join(hc.gd, 'config'));
  linkSync(join(v.gd, 'config'), join(hc.gd, 'config'));
  await refused('hard-linked config', hc.gd, ['status'], /its config has a second name \(a hard link\)/);
});

test('#32 round 3 (L51): the address a call allows is reached; the same address unallowed, or another one, is refused', async () => {
  const w = await trapWorld();
  const net = await listener();
  const url = `${net.url.replace('http:', 'https:')}/x.git`;
  const o = { gitDir: w.gd, workTree: w.d };
  const r = await git(['ls-remote', '--heads', url], { ...o, address: url });
  assert.notEqual(r.code, -1, r.stderr);
  assert.ok(net.hits() > 0, 'the allowed address should be reached');
  net.reset();
  for (const address of [undefined, `${url}/other`, net.url]) {
    const n = await git(['ls-remote', '--heads', url], { ...o, address });
    assert.equal(n.code, -1, String(address));
    assert.match(n.stderr, /only an absolute local path/);
  }
  assert.equal(net.hits(), 0);
  await net.close();
});

// The lead's standing rule (30 Oct 2026): no call may wait forever. A stuck git, one that leaves a program holding
// its output, and one whose program left its process group all end at the time limit; git gets no terminal.
test('no hang: a git that never ends is stopped at the time limit, with everything it started', { timeout: 60_000 }, async () => {
  const d = tmp();
  const fake = (name, body) => { const f = join(d, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  const stuck = fake('stuck', `/bin/sleep 20 & echo $! > ${d}/bg.pid\n/bin/sleep 20`);
  const left = fake('left', `/usr/bin/perl -e 'use POSIX; exit if fork; POSIX::setsid(); sleep 4'\n/bin/sleep 20`);
  const tty = fake('tty', 'if (exec 3</dev/tty) 2>/dev/null; then echo tty; else echo none; fi');
  for (const [name, bin] of [['stuck', stuck], ['left its group', left]]) {
    const t0 = Date.now();
    const r = await git(['--version'], { gitDir: '/dev/null', gitBin: bin, timeoutMs: 500 });
    assert.ok(Date.now() - t0 < 3000, `${name}: the call took ${Date.now() - t0} ms`);
    assert.equal(r.code, -1, name);
    assert.match(r.stderr, /git did not end within 500 ms and was stopped/, name);
  }
  const bg = Number(readFileSync(join(d, 'bg.pid'), 'utf8'));
  await new Promise((ok) => setTimeout(ok, 200));
  assert.throws(() => process.kill(bg, 0), /ESRCH/, 'the program the stuck git started was stopped with it');
  // The config read before a command ends the same way, and the call is refused.
  const repo = join(d, 'r');
  await gitOk(['init', '-q', repo], { gitDir: join(repo, '.git') });
  const t0 = Date.now();
  const r = await git(['status'], { gitDir: join(repo, '.git'), workTree: repo, gitBin: stuck, timeoutMs: 500 });
  assert.ok(Date.now() - t0 < 3000, `the config read took ${Date.now() - t0} ms`);
  assert.match(r.stderr, /^safe-git: refused: its config .* could not be read: .*did not end within 500 ms/);
  const t = await git(['--version'], { gitDir: '/dev/null', gitBin: tty });
  assert.equal(t.stdout.toString().trim(), 'none', 'git has no terminal to ask for a password on');
  assert.equal(safeGitEnv({}).GCM_INTERACTIVE, 'never');
});

// The terminal check above passes in any run that has no terminal of its own, so it can't show `detached` is on. This
// one can (#32 cosmetic, H4): git leads a process group of its own, in a new session, so it can have no terminal,
// whether or not this run has one.
test('no hang (H4): git runs in a process group of its own, never this run\'s', async () => {
  const d = tmp();
  const group = join(d, 'group');
  writeFileSync(group, '#!/bin/sh\necho "$$ $(/bin/ps -o pgid= -p $$)"\n');
  chmodSync(group, 0o755);
  const [pid, pgid] = (await git(['--version'], { gitDir: '/dev/null', gitBin: group })).stdout.toString().trim().split(/\s+/).map(Number);
  assert.ok(pid > 0, 'the fake git said its process id');
  assert.equal(pgid, pid, 'git leads a process group of its own');
  const mine = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  assert.notEqual(pgid, Number(mine.stdout.trim()), 'and not the group of this run');
});

// #32 round 4 (LEAD-CALLS L54): a reftable repository is refused, so its `tables.list` can never name another
// repository's ref files.
test('#32 round 4 (L54): a repository in the reftable ref format is refused before git runs; the other repository keeps its refs', async () => {
  const d = tmp();
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const plain = (args, cwd) => spawnSync('git', args, { cwd, env, stdio: 'pipe', timeout: 60_000 });
  for (const name of ['other', 'worker']) {
    const r = join(d, name);
    mkdirSync(r);
    assert.equal(plain(['init', '-q', '--ref-format=reftable', r], d).status, 0);
    assert.equal(plain(['commit', '-q', '--allow-empty', '-m', 'x'], r).status, 0);
  }
  const ot = join(d, 'other', '.git', 'reftable');
  const table = readdirSync(ot).find((f) => f.endsWith('.ref'));
  appendFileSync(join(d, 'worker', '.git', 'reftable', 'tables.list'), `../../../other/.git/reftable/${table}\n`);
  const gd = join(d, 'worker', '.git');
  const wt = join(d, 'worker');
  assert.match(await repoConfigWhy(gd) ?? '', /extensions\.refstorage/);
  const sha = plain(['rev-parse', 'HEAD'], wt).stdout.toString().trim();
  assert.notEqual((await git(['for-each-ref'], { gitDir: gd, workTree: wt })).code, 0);
  assert.notEqual((await git(['update-ref', 'refs/heads/z', sha], { gitDir: gd, workTree: wt })).code, 0);
  assert.ok(readdirSync(ot).includes(table), 'the other repository keeps its ref file');
  // Control: a repository in the default format names no ref format and is let through.
  const p = join(d, 'plain');
  mkdirSync(p);
  assert.equal(plain(['init', '-q', p], d).status, 0);
  assert.equal(await repoConfigWhy(join(p, '.git')), null);
});
