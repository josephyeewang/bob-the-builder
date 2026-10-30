// R-0b-36 (production block), R-0b-37 (merge guard, fail closed), R-0b-38 (plain-files hook),
// R-0b-42 (compaction notes), secret-file and no-verify blocks. Every hook is run as the real
// script, fed canned tool calls; production programs are fakes that record whether they ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSnapshot } from './snapshot.mjs';
import { shellCommands, landingPath } from './lib.mjs';
import * as plain from './plain-files.mjs';
import * as merge from './merge-guard.mjs';
import * as noVerify from './no-verify-block.mjs';
import * as secret from './secret-file-block.mjs';
import * as prodGuard from './production-write-guard.mjs';
import * as compact from './compact-note.mjs';
import { tmpFolder } from '../tmp-folders.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => tmpFolder('orch-hook-');

function world({ rules } = {}) {
  const root = landingPath(tmp());
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  const copy = join(root, 'copy'); mkdirSync(copy);
  const store = join(root, 'store'); mkdirSync(store);
  const start = join(root, 'start'); mkdirSync(start);
  const envFile = join(root, 'prod-app', 'settings.production'); mkdirSync(dirname(envFile)); writeFileSync(envFile, 'X=1\n');
  const keys = join(root, 'keys'); mkdirSync(keys);
  const snapshot = join(root, 'rules.json');
  const r = rules ?? { production: { env_files: [envFile], programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [keys] } };
  writeFileSync(snapshot, makeSnapshot(r));
  // Fake production programs that leave a mark when they run.
  const bin = join(root, 'bin'); mkdirSync(bin);
  const marks = join(root, 'marks'); mkdirSync(marks);
  for (const p of ['fakehost', 'fakedb']) { writeFileSync(join(bin, p), `#!/bin/sh\ntouch "${marks}/${p}"\n`); chmodSync(join(bin, p), 0o755); }
  return { root, outbox, copy, store, start, envFile, keys, snapshot, bin, marks };
}
const args = (w, role = 'worker', extra = {}) => ({ role, outbox: w.outbox, snapshot: w.snapshot, kinds: { worker: ['report'], lead: ['wish', 'ask', 'handoff'], front_door: ['request', 'state', 'idea'] }[role] ?? ['report'], copy: role === 'worker' ? w.copy : undefined, ...extra });
const bash = (command, cwd = '/') => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });

// Runs a hook script for real: a new Node process, the input on standard input.
function runScript(name, a, input, opts = {}) {
  const argv = ['--role', a.role, '--outbox', a.outbox, '--snapshot', a.snapshot, '--kinds', a.kinds.join(',')];
  if (a.copy) argv.push('--copy', a.copy);
  if (a.kind) argv.push('--kind', a.kind);
  if (a.event) argv.push('--event', a.event);
  const r = spawnSync(process.execPath, [opts.script ?? join(HERE, `${name}.mjs`), ...argv], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

// ---- plain-files (R-0b-38) ----

test('plain-files: every blocked path exits 2 from the real script, no card made', () => {
  const w = world();
  const a = args(w);
  const blocked = [
    join(w.copy, '.envrc'), join(w.copy, '.git', 'config'), join(w.copy, '.npmrc'), join(w.copy, '.pnpmfile.cjs'), join(w.copy, '.vscode', 'settings.json'),
    join(w.copy, '.claude', 'skills', 'x', 'SKILL.md'), join(w.copy, '.mcp.json'), join(w.copy, 'lefthook.yml'),
    join(w.copy, 'pyrightconfig.json'), join(w.copy, 'pkg', '.Claude', 'settings.json'), join(w.start, 'notes.md'),
    join(w.store, 'card-C-1.json'), 'relative/path.txt', join(w.copy, '..', 'store', 'x.json'),
    join(w.outbox, '.envrc'), join(w.outbox, 'sub', 'report-T-1.md'), join(w.outbox, 'verdict-T-1.md'), join(w.outbox, 'report-T 1.md'),
  ];
  for (const p of blocked) {
    const r = runScript('plain-files', a, write(p));
    assert.equal(r.code, 2, p);
    assert.match(r.stderr, /blocked/);
  }
  assert.equal(runScript('plain-files', a, write(join(w.copy, 'src', 'app.js'))).code, 0);
  assert.equal(runScript('plain-files', a, write(join(w.outbox, 'report-T-0001.md'))).code, 0);
  assert.equal(runScript('plain-files', a, { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(w.copy, 'n.ipynb') } }).code, 0);
  assert.equal(readdirSync(w.store).length, 0);
});

test('plain-files: the Lead and Front Door write only to their outbox, by their own kinds', () => {
  const w = world();
  assert.equal(plain.decide(write(join(w.outbox, 'ask-T-0001.json')), args(w, 'lead')).block, false);
  assert.equal(plain.decide(write(join(w.copy, 'src', 'a.js')), args(w, 'lead')).block, true);
  assert.equal(plain.decide(write(join(w.outbox, 'report-T-1.md')), args(w, 'lead')).block, true);
  assert.equal(plain.decide(write(join(w.outbox, 'state-compact-S1.md')), args(w, 'front_door')).block, false);
  assert.equal(plain.decide(write(join(w.outbox, 'handoff-compact-S1.md')), args(w, 'front_door')).block, true, 'only the Lead hands in handoff files (L2)');
});

test('plain-files: a link inside the copy that points at the store is refused', () => {
  const w = world();
  symlinkSync(w.store, join(w.copy, 'escape'));
  assert.equal(plain.decide(write(join(w.copy, 'escape', 'card.json')), args(w)).block, true);
  symlinkSync(join(w.copy, '.git-x'), join(w.copy, 'innocent'));
  mkdirSync(join(w.copy, '.git'));
  symlinkSync(join(w.copy, '.git'), join(w.copy, 'g'));
  assert.equal(plain.decide(write(join(w.copy, 'g', 'config')), args(w)).block, true);
});

// ---- fail closed (R-0b-37 break-it inputs) ----

test('every hook refuses on bad input, bad arguments or a missing snapshot', () => {
  const w = world();
  const a = args(w);
  for (const name of ['plain-files', 'secret-file-block', 'production-write-guard', 'merge-guard', 'no-verify-block']) {
    assert.equal(runScript(name, a, 'not json').code, 2, `${name} bad input`);
    assert.equal(runScript(name, a, '').code, 2, `${name} empty input`);
    assert.equal(runScript(name, { ...a, outbox: 'relative' }, bash('ls')).code, 2, `${name} bad args`);
    const r = spawnSync(process.execPath, [join(HERE, `${name}.mjs`)], { input: JSON.stringify(bash('ls')), encoding: 'utf8' });
    assert.equal(r.status, 2, `${name} no args`);
  }
  for (const name of ['secret-file-block', 'production-write-guard']) {
    assert.equal(runScript(name, { ...a, snapshot: join(w.root, 'none.json') }, bash('ls')).code, 2, `${name} missing snapshot`);
    writeFileSync(join(w.root, 'stale.json'), makeSnapshot({ production: {}, secrets: { paths: [] } }, new Date(Date.now() - 600000)));
    assert.equal(runScript(name, { ...a, snapshot: join(w.root, 'stale.json') }, bash('ls')).code, 2, `${name} stale snapshot`);
    writeFileSync(join(w.root, 'empty.json'), makeSnapshot({ other: 1 }));
    assert.equal(runScript(name, { ...a, snapshot: join(w.root, 'empty.json') }, bash('ls')).code, 2, `${name} snapshot without its block`);
  }
});

// ---- production-write guard (R-0b-36, review M8) ----

function runIfAllowed(w, cmd, snapshot = w.snapshot) {
  const r = runScript('production-write-guard', { ...args(w), snapshot }, bash(cmd));
  if (r.code === 0) spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: `${w.bin}:/usr/bin:/bin` }, cwd: w.copy });
  return r.code;
}

test('production: hosting and database programs are blocked before the fake runs', () => {
  const w = world();
  for (const cmd of ['fakehost deploy --prod', 'FOO=1 fakedb query "select 1"', 'npm test && fakehost env pull', 'env -i fakedb x', `${w.bin}/fakehost x`, 'npx fakehost@latest deploy', 'pnpm dlx fakedb', 'echo hi | xargs fakehost']) {
    assert.equal(runIfAllowed(w, cmd), 2, cmd);
  }
  assert.deepEqual(readdirSync(w.marks), [], 'no fake production program ran');
  assert.equal(runIfAllowed(w, 'psql -h db.prod.example.net'), 2);
  assert.equal(prodGuard.decide({ tool_name: 'Read', tool_input: { file_path: w.envFile } }, args(w)).block, true);
  assert.equal(prodGuard.decide(bash(`cat ${w.envFile}`), args(w)).block, true);
  assert.equal(prodGuard.decide(bash('npm test'), args(w)).block, false);
});

test('production planted fault: with the programs left out of the rules, the fake does run', () => {
  const w = world();
  const loose = join(w.root, 'loose.json');
  writeFileSync(loose, makeSnapshot({ production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [] } }));
  assert.equal(runIfAllowed(w, 'fakehost deploy', loose), 0);
  assert.ok(existsSync(join(w.marks, 'fakehost')), 'the positive control did not reach the fake');
});

// ---- merge guard (R-0b-37) ----

test('merge guard blocks every merge route and lets ordinary pushes through', () => {
  const blocked = [
    'gh api repos/o/r/pulls/7/merge -X PUT', 'gh api -X POST /repos/o/r/merges', 'gh pr merge 7 --squash',
    'git push origin HEAD:main', 'git push origin main', 'git push origin +card/c-1:refs/heads/main', 'git -C x push o master',
    'git push --mirror', 'git push origin --delete card/c-1',
    'curl -X PUT https://api.github.com/repos/o/r/pulls/7/merge', 'curl "https://api.github.com/repos/o/r/merges"',
    'cd x && git push origin main', 'true; gh pr merge 1',
  ];
  for (const c of blocked) assert.equal(merge.decide(bash(c)).block, true, c);
  for (const c of ['git push origin card/c-12', 'git status', 'gh pr view 7', 'echo main', 'git log main']) assert.equal(merge.decide(bash(c)).block, false, c);
  assert.equal(merge.decide({ tool_name: 'Read', tool_input: { file_path: '/x' } }).block, false);
});

// ---- no-verify and secrets ----

test('no-verify block refuses every way of skipping git checks', () => {
  for (const c of ['git commit --no-verify -m x', 'git commit -n -m x', 'git commit -nm x', 'git -c core.hooksPath=/dev/null commit -m x',
    'HUSKY=0 git commit -m x', 'git config core.hooksPath x', 'git push --no-verify', 'GIT_CONFIG_COUNT=1 git commit']) {
    assert.equal(noVerify.decide(bash(c)).block, true, c);
  }
  for (const c of ['git commit -m "no -n here"', 'git commit -am x', 'npm test', 'ls -n']) assert.equal(noVerify.decide(bash(c)).block, false, c);
});

test('secret-file block refuses key and env files and listed folders, by tool and in the shell', () => {
  const w = world();
  const a = args(w);
  const read = (p) => ({ tool_name: 'Read', tool_input: { file_path: p } });
  for (const p of [join(w.copy, '.env'), join(w.copy, '.env.local'), '/h/.ssh/id_ed25519', '/h/.config/gh/hosts.yml', join(w.keys, 'robot.pem'), join(w.keys, 'anything'), '/h/.aws/credentials']) {
    assert.equal(secret.decide(read(p), a).block, true, p);
  }
  assert.equal(secret.decide(read(join(w.copy, '.env.example')), a).block, false);
  assert.equal(secret.decide(read(join(w.copy, 'src', 'tokenizer.js')), a).block, false);
  assert.equal(secret.decide({ tool_name: 'Grep', tool_input: { pattern: 'x', path: w.keys } }, a).block, true);
  assert.equal(secret.decide({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '.env*' } }, a).block, true);
  assert.equal(secret.decide(bash('cat .env'), a).block, true);
  assert.equal(secret.decide(bash(`cp ${w.keys}/robot.pem /tmp/x`), a).block, true);
  assert.equal(secret.decide(bash('npm test'), a).block, false);
  assert.equal(runScript('secret-file-block', a, read(join(w.copy, '.env'))).code, 2);
  // A listed folder spelled in another case, or with an invisible character, is the same folder.
  for (const p of [w.keys.toUpperCase(), w.keys.replace('keys', 'k​eys')]) {
    assert.equal(secret.decide(read(join(p, 'anything')), a).block, true, p);
    assert.equal(secret.decide(bash(`cat ${p}/anything`), a).block, true, p);
  }
});

test('shell splitting finds the real command behind variables and wrappers', () => {
  assert.deepEqual(shellCommands('FOO=1 env -i nohup fakehost x && echo "a;b"'), [['fakehost', 'x'], ['echo', 'a;b']]);
  assert.deepEqual(shellCommands('a | b\nc'), [['a'], ['b'], ['c']]);
});

// ---- compaction notes (R-0b-42) ----

test('compaction hooks write one note in the outbox, with an allowed name, and nothing elsewhere', () => {
  for (const [role, kind] of [['lead', 'handoff'], ['worker', 'report'], ['front_door', 'state']]) {
    const w = world();
    const a = { ...args(w, role), kind };
    for (const event of ['PreCompact', 'PostCompact']) {
      const r = runScript('compact-note', { ...a, event }, { session_id: 'S-1', trigger: 'auto', hook_event_name: event });
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(readdirSync(w.outbox), [`${kind}-compact-S-1.md`]);
    assert.match(readFileSync(join(w.outbox, `${kind}-compact-S-1.md`), 'utf8'), /PreCompact \(auto\)[\s\S]*PostCompact/);
    assert.equal(plain.OUTBOX_NAME.test(`${kind}-compact-S-1.md`), true);
    assert.deepEqual(readdirSync(w.copy), []);
    const s = runScript('compact-note', { ...a, event: 'SessionStart' }, { session_id: 'S-1', source: 'compact' });
    assert.equal(s.code, 0);
    assert.match(s.stdout, /Re-read this note first/);
    assert.equal(runScript('compact-note', { ...a, event: 'SessionStart' }, { session_id: 'S-1', source: 'startup' }).stdout, '');
  }
});

test('compaction hooks never follow a link and refuse an unknown kind or event', () => {
  const w = world();
  const a = { ...args(w, 'lead'), kind: 'handoff' };
  const target = join(w.store, 'x.md');
  symlinkSync(target, join(w.outbox, 'handoff-compact-S-2.md'));
  assert.equal(runScript('compact-note', { ...a, event: 'PreCompact' }, { session_id: 'S-2' }).code, 2);
  assert.equal(existsSync(target), false, 'the planted link was followed');
  writeFileSync(join(w.root, 'other.md'), '');
  linkSync(join(w.root, 'other.md'), join(w.outbox, 'handoff-compact-S-3.md'));
  assert.equal(runScript('compact-note', { ...a, event: 'PreCompact' }, { session_id: 'S-3' }).code, 2, 'a hard link is refused');
  assert.equal(runScript('compact-note', { ...a, kind: 'report', event: 'PreCompact' }, { session_id: 'S-4' }).code, 2);
  assert.equal(runScript('compact-note', { ...a, event: 'Stop' }, { session_id: 'S-4' }).code, 2);
  assert.equal(runScript('compact-note', { ...a, event: 'PreCompact' }, { session_id: '../..' }).code, 2);
  assert.equal(compact.noteName('handoff', 'a/../b'), 'handoff-compact-ab.md');
});

test('L31: every hook still runs when reached the way it is installed: through a linked folder or a linked file', () => {
  const w = world();
  const a = args(w);
  const dir = tmp();
  symlinkSync(HERE, join(dir, 'linked'));
  for (const name of ['plain-files', 'secret-file-block', 'production-write-guard', 'merge-guard', 'no-verify-block', 'compact-note']) {
    symlinkSync(join(HERE, `${name}.mjs`), join(dir, `${name}.mjs`));
    for (const script of [join(dir, 'linked', `${name}.mjs`), join(dir, `${name}.mjs`)]) {
      // Bad input blocks; a script that skipped its body would exit 0 and let the call through.
      assert.equal(runScript(name, { ...a, kind: 'report', event: 'PreCompact' }, 'not json', { script }).code, 2, script);
    }
  }
  assert.equal(runScript('plain-files', a, write(join(w.copy, '.npmrc')), { script: join(dir, 'linked', 'plain-files.mjs') }).code, 2);
});
