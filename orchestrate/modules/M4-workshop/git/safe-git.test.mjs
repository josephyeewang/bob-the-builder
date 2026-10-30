import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, existsSync, chmodSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { safeGitEnv, sweepStaleHomes, git, gitOk, checkGitVersion, checkMirror, initMirror, MIRROR_CONFIG_TEMPLATE, SAFE_CONFIG, withNoPrograms, repoConfigWhy, repoConfigFiles, inertSetting, INERT_KEYS } from './safe-git.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const tmp = () => tempDir('orch-sg-');

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
const KNOWN_EXCEPTIONS = {
  'modules/M12-sensors/history.mjs': 'L36, 29 Oct 2026: lane 3 routes it through safe-git.mjs once this is on main',
};
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
  return { url: `http://127.0.0.1:${server.address().port}`, hits: () => hits, reset: () => { hits = 0; }, close: () => new Promise((ok) => server.close(ok)) };
}

/** git run with safe-git's environment and flags but without its config check: the second layer alone. */
function rawGit(args, { gitDir, workTree, input } = {}) {
  return new Promise((done) => {
    const child = spawn('git', ['--no-pager', ...withNoPrograms(args)], { cwd: tmp(), env: safeGitEnv({ gitDir, workTree }), stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => done({ code, stderr: err }));
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
  ];
  const out = [];
  for (const [args, opts] of cmds) out.push([args.join(' '), await run(args, opts)]);
  // The trapped repository as a source: fetched from, into a clean one.
  await gitOk(['init', '-q', into], { gitDir: join(into, '.git') });
  out.push(['fetch from it', await run(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', gd, 'refs/heads/main:refs/heads/x'], { gitDir: join(into, '.git') })]);
  return out;
}

test('L36/L49 sweep: every planted key is refused before git runs; the pins alone still start no program and reach no network', { timeout: 900_000 }, async () => {
  const w = await trapWorld();
  const net = await listener();
  const markers = join(w.root, 'markers');
  mkdirSync(markers);
  const prog = (name) => {
    const p = join(w.root, 'traps', name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\ncat\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const hooks = join(w.root, 'traps', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'post-index-change', 'pre-auto-gc']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${JSON.stringify(join(markers, `hook-${h}`))}\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const attrs = join(w.root, 'traps', 'attributes');
  writeFileSync(attrs, '* filter=y diff=y merge=y\n');
  const sign = (k) => ['[log]', '\tshowSignature = true', '[merge]', '\tverifySignatures = true', '[pull]', '\tverifySignatures = true',
    '[commit]', '\tgpgSign = true', '[tag]', '\tgpgSign = true', '\tforceSignAnnotated = true', '[push]', '\tgpgSign = if-asked', k];
  // Pinned: the repository sets them, SAFE_CONFIG wins.
  const pinned = {
    'core.fsmonitor': () => ['[core]', `\tfsmonitor = ${prog('core.fsmonitor')}`],
    'core.hooksPath': () => ['[core]', `\thooksPath = ${hooks}`],
    'core.pager': () => ['[core]', `\tpager = ${prog('core.pager')}`, '[pager]', `\tlog = ${prog('pager.log')}`],
    'core.editor': () => ['[core]', `\teditor = ${prog('core.editor')}`, '[sequence]', `\teditor = ${prog('sequence.editor')}`],
    'core.sshCommand': () => ['[core]', `\tsshCommand = ${prog('core.sshCommand')}`],
    'core.askPass': () => ['[core]', `\taskPass = ${prog('core.askPass')}`],
    'core.attributesFile': () => ['[core]', `\tattributesFile = ${attrs}`],
    'diff.external': () => ['[diff]', `\texternal = ${prog('diff.external')}`],
    'interactive.diffFilter': () => ['[interactive]', `\tdiffFilter = ${prog('interactive.diffFilter')}`],
    'credential.helper': () => ['[credential]', `\thelper = !${prog('credential.helper')}`],
    'gpg.program': () => sign(`[gpg]\n\tprogram = ${prog('gpg.program')}`),
    'gpg.openpgp.program': () => sign(`[gpg "openpgp"]\n\tprogram = ${prog('gpg.openpgp.program')}`),
    'gpg.x509.program': () => sign(`[gpg]\n\tformat = x509\n[gpg "x509"]\n\tprogram = ${prog('gpg.x509.program')}`),
    'gpg.ssh.program': () => sign(`[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = ${prog('gpg.ssh.program')}\n\tdefaultKeyCommand = ${prog('gpg.ssh.defaultKeyCommand')}\n\tallowedSignersFile = ${attrs}`),
    'submodule.recurse': () => ['[submodule]', '\trecurse = true', '[fetch]', '\trecurseSubmodules = true', '[push]', '\trecurseSubmodules = on-demand'],
    'transfer.bundleURI': () => ['[transfer]', '\tbundleURI = true', '[fetch]', `\tbundleURI = file://${prog('bundle-uri')}`],
    'http.proxy': () => ['[http]', `\tproxy = ${net.url}`, '[remote "origin"]', '\turl = https://example.invalid/r.git'],
    'fetch.bundleURI': () => ['[fetch]', `\tbundleURI = ${net.url}/b.bundle`],
    'protocol.ext.allow': () => ['[protocol "ext"]', '\tallow = always', '[remote "origin"]', `\turl = ext::${prog('ext-protocol')}`],
  };
  // Per-name: refused before git runs in the repository.
  const named = {
    'filter.x': () => ['[filter "x"]', `\tclean = ${prog('filter.clean')}`, `\tsmudge = ${prog('filter.smudge')}`, `\tprocess = ${prog('filter.process')}`, '\trequired = true'],
    'diff.x': () => ['[diff "x"]', `\ttextconv = ${prog('diff.textconv')}`, `\tcommand = ${prog('diff.command')}`],
    'merge.x.driver': () => ['[merge "x"]', `\tdriver = ${prog('merge.driver')}`],
    'trailer.x': () => ['[trailer "x"]', `\tcommand = ${prog('trailer.command')}`, `\tcmd = ${prog('trailer.cmd')}`],
    'remote.uploadpack': () => ['[remote "origin"]', `\turl = ${'$'}{SRC}`, `\tuploadpack = ${prog('remote.uploadpack')}`, `\treceivepack = ${prog('remote.receivepack')}`],
    'remote.vcs': () => ['[remote "origin"]', '\tvcs = trap', `\turl = ${'$'}{SRC}`],
    'url.insteadOf': () => [`[url "ext::${prog('url.insteadof')}"]`, `\tinsteadOf = ${'$'}{SRC}`, `\tpushInsteadOf = ${'$'}{PEER}`],
    'credential.url.helper': () => ['[credential "https://example.invalid"]', `\thelper = !${prog('credential.url.helper')}`],
    'submodule.update': () => ['[submodule "s"]', `\tupdate = !${prog('submodule.update')}`],
    'http.url.proxy': () => ['[http "https://example.invalid"]', `\tproxy = ${net.url}`],
    'hook.x': () => ['[hook "x"]', `\tcommand = ${prog('hook.x')}`, '\tevent = reference-transaction', '\tevent = pre-commit', '\tevent = post-checkout'],
    'HOOK.y (upper case)': () => ['[HOOK "y"]', `\tCOMMAND = ${prog('hook.y')}`, '\tEVENT = reference-transaction'],
    'bundle list': () => ['[bundle]', '\tversion = 1', '\tmode = all', '[bundle "b"]', `\turi = ${net.url}/c.bundle`],
    'promisor': () => ['[extensions]', '\tpartialClone = origin', '[remote "origin"]', `\turl = ${'$'}{SRC}`, '\tpromisor = true'],
    'core.alternateRefsCommand': () => ['[core]', `\talternateRefsCommand = ${prog('core.alternateRefsCommand')}`],
    'core.gitProxy': () => ['[core]', `\tgitProxy = ${prog('core.gitProxy')}`],
    'include of a named key': () => { const inc = join(w.root, 'traps', 'inc.cfg'); writeFileSync(inc, `[filter "x"]\n\tclean = ${prog('include.clean')}\n`); return ['[include]', `\tpath = ${inc}`]; },
  };
  const fill = (lines) => lines.join('\n').replaceAll('${SRC}', w.src).replaceAll('${PEER}', w.peer);
  const copyFor = (name) => {
    const d = join(w.root, 'cases', name.replace(/[^a-z0-9]+/gi, '-'));
    cpSync(w.d, d, { recursive: true });
    writeFileSync(join(d, '.gitattributes'), '* filter=x diff=x merge=x\n');
    return d;
  };
  const failures = [];
  const fired = (name) => {
    const f = readdirSync(markers);
    if (f.length) failures.push(`${name}: ${f.join(', ')}`);
    for (const x of f) rmSync(join(markers, x));
    if (net.hits()) failures.push(`${name}: reached the network ${net.hits()} times`);
    net.reset();
  };
  const refusedAll = (name, res) => {
    // Every command in the trapped repository is refused; the fetch from it into a clean one does not read its config.
    const ran = res.filter(([c, r]) => c !== 'fetch from it' && !(r.code === -1 && /safe-git: refused: .*not on the safe list/.test(r.stderr)));
    if (ran.length) failures.push(`${name}: not refused: ${ran.map(([c]) => c).join('; ')}`);
  };
  for (const [name, lines] of Object.entries(pinned)) {
    const d = copyFor(name);
    const clean = readFileSync(join(d, '.git', 'config'), 'utf8');
    writeFileSync(join(d, '.git', 'config'), `${clean}${fill(lines())}\n`);
    refusedAll(name, await everyCommand(w, d, (args, opts) => git(args, opts)));
    fired(name);
    // The second layer alone: the same commands with the config check skipped.
    await everyCommand(w, d, rawGit);
    fired(`${name} (pins alone)`);
  }
  for (const [name, lines] of Object.entries(named)) {
    const d = copyFor(name);
    writeFileSync(join(d, '.git', 'config'), `${readFileSync(join(d, '.git', 'config'), 'utf8')}${fill(lines())}\n`);
    refusedAll(name, await everyCommand(w, d, (args, opts) => git(args, opts)));
    fired(name);
  }
  await net.close();
  assert.deepEqual(failures, []);
});

test('L36 sweep, control: the planted programs run when git is used the careless way', { timeout: 120_000 }, async () => {
  const w = await trapWorld();
  const markers = join(w.root, 'markers');
  mkdirSync(markers);
  const prog = (name) => { const p = join(w.root, name); writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\ncat\n`); chmodSync(p, 0o755); return p; };
  writeFileSync(join(w.gd, 'config'), `${readFileSync(join(w.gd, 'config'), 'utf8')}[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${prog('gpg')}\n[gpg "ssh"]\n\tprogram = ${prog('gpg-ssh')}\n\tallowedSignersFile = ${prog('signers')}\n[filter "x"]\n\tclean = ${prog('clean')}\n[diff "x"]\n\ttextconv = ${prog('textconv')}\n`);
  writeFileSync(join(w.d, '.gitattributes'), '* filter=x diff=x\n');
  writeFileSync(join(w.d, 'a.txt'), 'changed\n');
  const env = { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: w.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const a of [['log', '-n4', '--format=%H %s', 'main'], ['add', '-A'], ['diff', '--cached']]) spawnSync('git', ['--no-pager', '-C', w.d, ...a], { env });
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
  const r = await git(['--literal-pathspecs', 'log', '-n1'], { gitDir: join(d, 'none'), gitBin: fake });
  assert.equal(r.stdout.toString().trim(), '--no-pager --literal-pathspecs log --no-ext-diff --no-textconv -n1');
});

test('L36: a repository config that cannot be read is refused; a folder with no config yet is not', async () => {
  const d = tmp();
  assert.equal(await repoConfigWhy(join(d, 'none')), null);
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
test('L49 sweep: every key git lists is refused and named unless it is on the safe list; those let through start nothing', { timeout: 900_000 }, async () => {
  const listed = spawnSync('git', ['help', '--config'], { encoding: 'utf8', env: safeGitEnv() }).stdout.split('\n')
    .filter((l) => /^[A-Za-z0-9][A-Za-z0-9.<>*_-]*$/.test(l) && l.includes('.'));
  assert.ok(listed.length > 900, `git listed only ${listed.length} keys`);
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
  for (const key of listed) {
    const { name, text } = section(key, prog);
    writeFileSync(join(w.gd, 'config'), clean + text);
    const why = await repoConfigWhy(w.gd);
    const listedAs = name.split('.').map((x, i, a) => (i === 0 || i === a.length - 1 ? x.toLowerCase() : x)).join('.');
    if (inertSetting(listedAs, prog)) {
      if (why) failures.push(`${key}: on the list but refused: ${why}`);
      let_through.push(key);
    } else if (!why) failures.push(`${key}: let through`);
    else if (!why.includes(listedAs) && !/could not be read/.test(why)) failures.push(`${key}: refused without naming it: ${why}`);
  }
  writeFileSync(join(w.gd, 'config'), clean);
  assert.deepEqual(failures, []);
  // What the list lets through is the safe list itself, nothing more.
  assert.deepEqual(let_through.filter((k) => !INERT_KEYS.has(k.toLowerCase()) && !/^(?:remote\.<name>\.(?:url|pushurl|fetch)|branch\.<name>\.(?:remote|merge|rebase))$/.test(k)), []);
  // Each of those, planted with the program or with a network address, starts nothing and reaches nothing.
  const net = await listener();
  for (const key of let_through) {
    for (const value of [prog, `${net.url}/x.git`]) {
      const { text } = section(key, value);
      const d = join(w.root, 'cases', `${key.replace(/[^a-z0-9]+/gi, '-')}-${value === prog ? 'prog' : 'net'}`);
      cpSync(w.d, d, { recursive: true });
      writeFileSync(join(d, '.git', 'config'), clean + text);
      if (await repoConfigWhy(join(d, '.git'))) continue; // a value the list refuses (an http address)
      await everyCommand(w, d, (args, opts) => git(args, opts));
      const f = readdirSync(markers);
      if (f.length || net.hits()) failures.push(`${key} = ${value}: ran ${f.length}, network ${net.hits()}`);
      for (const x of f) rmSync(join(markers, x));
      net.reset();
    }
  }
  await net.close();
  assert.deepEqual(failures, []);
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
  for (const [name, put] of Object.entries(cases)) {
    const { why, r } = await planted(name.replace(/[^a-z]+/gi, '-'), put);
    assert.match(why ?? '', /filter\.x\.clean/, name);
    assert.equal(r.code, -1, name);
  }
  // A pointer file to a clean repository works, and git is handed the folder that was checked.
  const ok = await planted('clean-pointer', (d, gd) => { const p = join(d, 'ptr'); writeFileSync(p, `gitdir: ${gd}\n`); return p; });
  assert.equal(ok.why, null);
  assert.equal(ok.r.code, 0, ok.r.stderr);
  assert.equal(repoConfigFiles(ok.gitDir).dir, join(ok.d, '.git'));
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
  const d = tmp();
  const gd = join(d, '.git');
  await gitOk(['init', '-q', d], { gitDir: gd });
  const ptr = join(d, 'ptr');
  writeFileSync(ptr, `gitdir: ${gd}\n`);
  const fake = join(d, 'fake-git');
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = config ] && exit 0\necho "$GIT_DIR"\n');
  chmodSync(fake, 0o755);
  const r = await git(['status'], { gitDir: ptr, gitBin: fake });
  assert.equal(r.stdout.toString().trim(), gd);
});
