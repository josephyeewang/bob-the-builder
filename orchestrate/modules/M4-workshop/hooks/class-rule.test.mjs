// The class rule for the shell guards (audit R-0b-44 round 2 MAT-1, MAT-2, MIN-3; R-0b-70): every
// shape the round-2 probe got through, letter case on a Mac disk, and the lane-3 corpus's
// remaining forms. Throwaway folders only; names of secret files are built at run time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSnapshot } from './snapshot.mjs';
import { expansionIn, expandBraces, unreadable, shellCommands } from './lib.mjs';
import * as merge from './merge-guard.mjs';
import * as noVerify from './no-verify-block.mjs';
import * as prodGuard from './production-write-guard.mjs';
import * as secret from './secret-file-block.mjs';

const dot = (...p) => `.${p.join('')}`;
const ENV_PROD = dot('en', 'v.production');

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'm4-class-')));
  const home = join(root, 'home');
  const work = join(root, 'work');
  const outbox = join(root, 'outbox');
  for (const d of [home, work, outbox]) mkdirSync(d);
  const envFile = join(work, ENV_PROD);
  writeFileSync(envFile, 'X=1\n');
  const snapshot = join(root, 'snap.json');
  writeFileSync(snapshot, makeSnapshot({ production: { env_files: [envFile], programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(home, '.config', 'gh', 'hosts.yml')] } }));
  return { root, home, work, outbox, envFile, snapshot, args: { role: 'builder', outbox, snapshot, kinds: [] } };
}
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const blocked = (r, what) => assert.equal(r.block, true, `passed: ${what}`);
const passed = (r, what) => assert.equal(r.block, false, `blocked: ${what} (${r.reason})`);

test('lib: the class rule names each shape it refuses, and lets plain words through', () => {
  assert.match(expansionIn('g${x}it push'), /variable \(\$x\)/);
  assert.match(expansionIn('echo $1'), /variable \(\$1\)/);
  assert.match(expansionIn('cat $(printf x)'), /\$\( \) substitution/);
  assert.match(expansionIn("cat $'\\x2e'"), /escape-built word/);
  assert.match(expansionIn('echo `id`'), /backtick/);
  for (const ok of ['echo $HOME', 'ls "${PWD}"', 'npm test; echo $?', "git commit -m 'costs $5'", 'echo \\$x']) assert.equal(expansionIn(ok), null, ok);
  assert.deepEqual(expandBraces('a{b,c}d{1,2}'), ['abd1', 'abd2', 'acd1', 'acd2']);
  assert.deepEqual(expandBraces('plain'), ['plain']);
  assert.equal(expandBraces('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}', 64).length, 64);
  const why = {
    'printf x | sh': /"sh" runs commands/, 'bash p.sh': /"bash" runs commands/, 'echo x | xargs git push': /"xargs" builds/,
    'find . -exec git push \\;': /find -exec/, 'env -S "git push"': /env -S/, 'env -iS "git push"': /env -S/, './p.sh': /runs a file by its path/,
    'sub/p.sh': /runs a file by its path/, '/usr/local/bin/fakehos? deploy': /pattern in it/, 'printf x | python3': /interpreter fed/,
    'node < x.js': /interpreter fed/, "awk 'BEGIN{system(\"id\")}'": /awk running/, 'python3 -c 1': /python3 -c/,
  };
  for (const [c, re] of Object.entries(why)) assert.match(unreadable(c) ?? 'null', re, c);
  for (const ok of ['ls -la', 'git status', 'node --test', 'node script.mjs', 'echo hi > /tmp/x.txt', '[ -f x ] && echo y', '/usr/bin/git status', 'cat < in.txt', 'node a.mjs < in.txt'])
    assert.equal(unreadable(ok), null, ok);
  // A backslash before a line break joins the lines; a redirect target is not a command.
  assert.deepEqual(shellCommands('git push origin \\\nHEAD:main'), [['git', 'push', 'origin', 'HEAD:main']]);
  assert.deepEqual(shellCommands('echo x > /tmp/f; ls'), [['echo', 'x'], ['ls']]);
  assert.deepEqual(shellCommands('if true; then fakehost x; fi'), [['true'], ['fakehost', 'x'], ['fi']]);
});

test('MAT-1: the merge guard refuses every round-2 rewrite of a push or merge to main', () => {
  const forms = [
    'git push origin \\\nHEAD:main', 'g${x}it push origin HEAD:main', 'git send-pack https://example.invalid/r HEAD:refs/heads/main',
    'gh alias set m "pr merge" && gh m 1', 'echo HEAD:main | xargs git push origin', 'printf "git push origin HEAD:main" | sh',
    'sh <<< "git push origin HEAD:main"', 'git push origin HEAD:mai?', 'git push origin HEAD:{main,}', 'git push origin HEAD:mai[n]',
    'find . -exec git push origin HEAD:main ;', 'env -S "git push origin HEAD:main"', './p.sh', 'bash p.sh',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main git push',
    'echo "  push = HEAD:main" >> .git/config && git push', 'if true; then gh pr merge 1; fi',
  ];
  for (const c of forms) blocked(merge.decide(bash(c, '/')), c);
  for (const c of ['git push origin card/c-12', 'git status', 'gh pr view 7', 'git log main', 'echo $HOME']) passed(merge.decide(bash(c, '/')), c);
});

test('MAT-1: the no-verify guard refuses every round-2 way of skipping the checks', () => {
  const forms = ['g${x}it commit -n -m x', 'git commit -m x \\\n-n', 'rm -f .git/hooks/pre-commit && git commit -m x', 'GIT_CONFIG_KEY_0=x git commit -m x', 'sh -c "git commit -n"'];
  for (const c of forms) blocked(noVerify.decide(bash(c, '/')), c);
  for (const c of ['git commit -m "a plain message"', "git commit -m 'costs $5'", 'npm test']) passed(noVerify.decide(bash(c, '/')), c);
});

test('MAT-1 and R-0b-70: the production guard refuses every round-2 and corpus form, and allows plain work', () => {
  const w = world();
  const forms = [
    'fake${x}host deploy', 'fake\\\nhost deploy', '/usr/local/bin/fakehos? deploy', 'find . -exec fakehost deploy ;', 'env -S "fakehost deploy"',
    './deploy.sh', `cat ${ENV_PROD.slice(0, 6)}\${x}${ENV_PROD.slice(6)}`, 'curl https://db.prod.exa${x}mple.net',
    // relative to the session's folder, in each corpus form left over after round 1
    `echo x > ${ENV_PROD}`, `cat {${ENV_PROD},nothing}`, `dd if=/tmp/x of=${ENV_PROD}`, `F=${ENV_PROD}; cat "$F"`,
    `cat $'\\x2e\\x65'`, `cat $(printf '\\x2e\\x65')`, `cat ${w.work}/{${ENV_PROD},x}`,
    // letter case: the Mac disk opens these as the same file and program
    `cat ${ENV_PROD.toUpperCase()}`, `cat ${w.envFile.toUpperCase()}`, 'FAKEHOST deploy', 'curl https://DB.prod.example.net',
  ];
  for (const c of forms) blocked(prodGuard.decide(bash(c, w.work), w.args), c);
  blocked(prodGuard.decide({ tool_name: 'Read', tool_input: { file_path: w.envFile.toUpperCase() } }, w.args), 'Read in capitals');
  assert.match(prodGuard.decide(bash('ls'), w.args).reason, /no working folder/);
  for (const c of ['ls', 'git status', 'npm test', 'cat README.md', 'echo hello > /tmp/scratch.txt', 'echo $HOME']) passed(prodGuard.decide(bash(c, w.work), w.args), c);
});

test('R-0b-70: run as the real script with --role, --outbox and --snapshot, ls and git status pass and a write is refused', () => {
  const w = world();
  const script = fileURLToPath(new URL('./production-write-guard.mjs', import.meta.url));
  const run = (command) => spawnSync(process.execPath, [script, '--role', 'builder', '--outbox', w.outbox, '--snapshot', w.snapshot], { input: JSON.stringify(bash(command, w.work)), encoding: 'utf8' }).status;
  assert.equal(run('ls'), 0);
  assert.equal(run('git status'), 0);
  assert.equal(run(`echo x > ${ENV_PROD}`), 2);
  // Without the arguments every call is refused, which is why the corpus must be run with them.
  assert.equal(spawnSync(process.execPath, [script], { input: JSON.stringify(bash('ls', w.work)), encoding: 'utf8' }).status, 2);
});

test('MAT-2: the secret-file guard compares names as a Mac disk does, ignoring letter case', () => {
  const w = world();
  const keyDir = dot('ss', 'h');
  const reads = [
    join(w.home, keyDir.toUpperCase(), 'config'), join(w.home, '.SsH', 'config'), join(w.home, '.CONFIG', 'GH', 'hosts.yml'),
    join(w.work, dot('en', 'v').toUpperCase()), join(w.work, '.Env.local'), join(w.work, 'ID_RSA'),
  ];
  for (const p of reads) {
    const r = secret.decide({ tool_name: 'Read', tool_input: { file_path: p } }, w.args);
    assert.equal(r.block, true, p);
    assert.match(r.reason, /is a secret file/, p);
  }
  passed(secret.decide({ tool_name: 'Read', tool_input: { file_path: join(w.work, 'README.md') } }, w.args), 'README');
});

test('MIN-3: the secret-file guard refuses variables, patterns and joined lines in the shell', () => {
  const w = world();
  const keyDir = dot('ss', 'h');
  const forms = [
    `cat ${w.home}/.config/g\${x}h/hosts.yml`, `cat ${w.home}/${keyDir.slice(0, 3)}?/config`, `cat ${w.home}/.s*/config`,
    `cat ${w.home}/${keyDir.slice(0, 2)}\\\n${keyDir.slice(2)}/config`, `cat ${w.home}/{${keyDir},x}/config`, `cat ${dot('e')}*`,
  ];
  for (const c of forms) blocked(secret.decide(bash(c, w.work), w.args), c);
  for (const c of ['ls', 'cat README.md', 'ls *.md', 'echo $HOME']) passed(secret.decide(bash(c, w.work), w.args), c);
});
