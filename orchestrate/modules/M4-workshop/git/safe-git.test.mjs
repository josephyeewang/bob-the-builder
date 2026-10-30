import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, existsSync, chmodSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { safeGitEnv, sweepStaleHomes, git, gitOk, checkGitVersion, checkMirror, initMirror, MIRROR_CONFIG_TEMPLATE, SAFE_CONFIG, withNoPrograms, repoConfigWhy } from './safe-git.mjs';
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
  writeFileSync(join(gd, 'config'), readFileSync(join(gd, 'config'), 'utf8') + `[core]\n\tfsmonitor = /bin/sh -c 'touch ${marker}'\n\thooksPath = ${join(gd, 'hooks')}\n`);
  writeFileSync(join(d, 'a.txt'), 'a');
  await gitOk(['add', 'a.txt'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['commit', '-q', '-m', 'x'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['status', '--porcelain'], { gitDir: gd, workTree: d, cwd: d });
  assert.throws(() => statSync(marker), 'a planted hook or fsmonitor ran');
  // Planted fault: drop the safe fsmonitor setting and the same planted program does run,
  // so the check above can fail.
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

test('L36 sweep: no git command safe-git runs starts a program a repository config names; per-name keys are refused', { timeout: 600_000 }, async () => {
  const w = await trapWorld();
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
    'http.proxy': () => ['[http]', `\tproxy = http://127.0.0.1:9`],
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
    'http.url.proxy': () => ['[http "https://example.invalid"]', '\tproxy = http://127.0.0.1:9'],
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
  for (const [name, lines] of Object.entries(pinned)) {
    const d = copyFor(name);
    writeFileSync(join(d, '.git', 'config'), `${readFileSync(join(d, '.git', 'config'), 'utf8')}${fill(lines())}\n`);
    await everyCommand(w, d, (args, opts) => git(args, opts));
    const fired = readdirSync(markers);
    if (fired.length) failures.push(`${name}: ${fired.join(', ')}`);
    for (const f of fired) rmSync(join(markers, f));
  }
  for (const [name, lines] of Object.entries(named)) {
    const d = copyFor(name);
    writeFileSync(join(d, '.git', 'config'), `${readFileSync(join(d, '.git', 'config'), 'utf8')}${fill(lines())}\n`);
    const res = await everyCommand(w, d, (args, opts) => git(args, opts));
    // Every command in the trapped repository is refused; the fetch from it into a clean one does not read its config.
    const ran = res.filter(([c, r]) => c !== 'fetch from it' && !(r.code === -1 && /safe-git: refused: .*config names a program/.test(r.stderr)));
    if (ran.length) failures.push(`${name}: not refused: ${ran.map(([c]) => c).join('; ')}`);
    const fired = readdirSync(markers);
    if (fired.length) failures.push(`${name}: ${fired.join(', ')}`);
    for (const f of fired) rmSync(join(markers, f));
  }
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
    assert.match(await repoConfigWhy(gd) ?? '', /filter\.x\.clean/, how);
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
