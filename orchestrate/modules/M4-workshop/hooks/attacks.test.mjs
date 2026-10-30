// Audit R-0b-44 round 1, M-2 to M-5: every way past a hook the audit found is a test here, plus
// the ordinary commands that must still pass (so a fix that blocks everything is caught too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSnapshot } from './snapshot.mjs';
import { landingPath } from './lib.mjs';
import * as plain from './plain-files.mjs';
import * as merge from './merge-guard.mjs';
import * as noVerify from './no-verify-block.mjs';
import * as secret from './secret-file-block.mjs';
import * as prodGuard from './production-write-guard.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function world() {
  const root = landingPath(tempDir('orch-attack-'));
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  const copy = join(root, 'copy'); mkdirSync(copy);
  const home = join(root, 'home'); mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const prodDir = join(root, 'prod-app'); mkdirSync(prodDir);
  const envFile = join(prodDir, 'prod.settings'); writeFileSync(envFile, 'X=1\n');
  const keyDir = join(home, '.ssh'); mkdirSync(keyDir);
  const key = join(keyDir, 'id_ed25519'); writeFileSync(key, 'fake key for a test\n');
  const shellRc = join(home, '.zshrc'); writeFileSync(shellRc, '# rc\n');
  const snapshot = join(root, 'rules.json');
  writeFileSync(snapshot, makeSnapshot({ production: { env_files: [envFile], programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [] } }));
  return { root, outbox, copy, home, prodDir, envFile, key, shellRc, snapshot };
}
const args = (w, role = 'worker') => ({ role, outbox: w.outbox, snapshot: w.snapshot, kinds: role === 'lead' ? ['handoff'] : ['report'], copy: role === 'worker' ? w.copy : undefined });
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });
const blocked = (r, what) => assert.equal(r.block, true, `passed: ${what}`);
const passed = (r, what) => assert.equal(r.block, false, `blocked: ${what} (${r.reason})`);

test('M-2: the plain-files hook blocks a write through a link to nowhere yet, a file link and a hard link', () => {
  const w = world();
  const agent = join(w.home, 'Library', 'LaunchAgents', 'evil.plist');
  symlinkSync(agent, join(w.outbox, 'report-T-9.md'));
  symlinkSync(agent, join(w.outbox, 'handoff-T-9.md'));
  symlinkSync(join(w.home, 'nowhere-yet'), join(w.copy, 'pending.md'));
  symlinkSync(w.shellRc, join(w.copy, 'linked.md'));
  linkSync(w.shellRc, join(w.copy, 'readme.md'));
  linkSync(w.shellRc, join(w.outbox, 'report-T-8.md'));
  blocked(plain.decide(write(join(w.outbox, 'report-T-9.md')), args(w)), 'worker, outbox link to nowhere');
  blocked(plain.decide(write(join(w.outbox, 'handoff-T-9.md')), args(w, 'lead')), 'lead, outbox link to nowhere');
  blocked(plain.decide(write(join(w.copy, 'pending.md')), args(w)), 'copy link to nowhere');
  blocked(plain.decide(write(join(w.copy, 'linked.md')), args(w)), 'copy file link');
  blocked(plain.decide(write(join(w.copy, 'readme.md')), args(w)), 'copy hard link');
  blocked(plain.decide(write(join(w.outbox, 'report-T-8.md')), args(w)), 'outbox hard link');
  // Ordinary writes still pass.
  passed(plain.decide(write(join(w.copy, 'src', 'new.js')), args(w)), 'a new file in the copy');
  writeFileSync(join(w.copy, 'plain.md'), 'x');
  passed(plain.decide(write(join(w.copy, 'plain.md')), args(w)), 'an existing plain file in the copy');
  passed(plain.decide(write(join(w.outbox, 'report-T-1.md')), args(w)), 'a new outbox file');
});

test('M-2: the real script blocks the link to nowhere (exit 2)', () => {
  const w = world();
  symlinkSync(join(w.home, 'Library', 'LaunchAgents', 'evil.plist'), join(w.outbox, 'report-T-9.md'));
  const a = args(w);
  const r = spawnSync(process.execPath, [join(HERE, 'plain-files.mjs'), '--role', a.role, '--outbox', a.outbox, '--snapshot', a.snapshot, '--kinds', a.kinds.join(','), '--copy', a.copy],
    { input: JSON.stringify(write(join(w.outbox, 'report-T-9.md'))), encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
});

test('M-3: the secret-file hook follows a file link before its built-in checks (Read and Bash, written and short names)', () => {
  const w = world();
  symlinkSync(w.key, join(w.copy, 'notes.txt'));
  const a = args(w);
  blocked(secret.decide({ tool_name: 'Read', tool_input: { file_path: join(w.copy, 'notes.txt') } }, a), 'Read through a file link');
  blocked(secret.decide(bash(`cat ${join(w.copy, 'notes.txt')}`), a), 'cat through a file link');
  blocked(secret.decide(bash('cat copy/notes.txt', w.root), a), 'cat of a relative link');
  blocked(secret.decide(bash('cat notes.txt', w.copy), a), 'cat of a short-name link');
  writeFileSync(join(w.copy, 'plain.txt'), 'x');
  passed(secret.decide(bash('cat plain.txt', w.copy), a), 'cat of a plain file');
  passed(secret.decide({ tool_name: 'Read', tool_input: { file_path: join(w.copy, 'plain.txt') } }, a), 'Read of a plain file');
});

test('M-4: the merge guard blocks pushes to main and merges by other routes', () => {
  const routes = [
    'git push origin HEAD:heads/main', 'git push origin HEAD:refs/heads/main', 'git push origin main',
    'sh -c "git push origin HEAD:main"', "bash -c 'gh pr merge 1'", 'bash -lc "gh pr merge 1"', 'eval git push origin HEAD:main', 'source ./p.sh', '. ./p.sh',
    'git push origin $(echo HEAD:main)', 'b=main; git push origin HEAD:$b', 'git push origin `echo HEAD:main`', '$G push origin HEAD:main',
    'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }\'',
    'curl -X POST https://api.github.com/graphql -d \'{"query":"mutation { mergePullRequest }"}\'',
    'git config remote.origin.push HEAD:main && git push', 'git config alias.p push && git p origin HEAD:main',
    'git -c remote.origin.push=HEAD:main push', 'git -c alias.p=push p origin HEAD:main', 'git config --global url.x.pushInsteadOf y',
  ];
  for (const c of routes) blocked(merge.decide(bash(c)), c);
  for (const c of ['git push origin card/c-1', 'git push origin HEAD:refs/heads/card/c-1', 'git status', 'npm test', 'echo $HOME', 'gh pr view 1', 'git log --oneline -5', 'git config user.name x'])
    passed(merge.decide(bash(c)), c);
});

test('M-5: the skip-the-checks guard blocks shortened, quote-split and wrapped forms', () => {
  const forms = ['git commit --no-veri -m x', 'git commit --no-verif -m x', 'git commit --no-v -m x', 'git commit --no-v""erify -m x', "git commit --no-'verify' -m x",
    'git -c core.hooks""Path=/dev/null commit -m x', 'sh -c "git commit -n -m x"', 'eval git commit -n -m x', 'g=git; $g commit -n -m x', 'git commit $F -m x', 'H""USKY=0 git commit -m x'];
  for (const c of forms) blocked(noVerify.decide(bash(c)), c);
  for (const c of ['git commit -m "a plain message"', 'git push origin card/c-1', 'npm test', 'git commit --no-edit']) passed(noVerify.decide(bash(c)), c);
});

test('M-5: the production guard blocks wrapped, built, wildcard, short-name and inline forms', () => {
  const w = world();
  const a = args(w);
  const forms = [
    'sh -c "fakehost deploy"', 'eval fakehost deploy', 'f=fakehost; $f deploy', '$(echo fakehost) deploy', '`echo fakehost` deploy',
    'npx --package=fakehost x', `cat ${w.prodDir}/p*.settings`, `cd ${w.prodDir} && cat prod.settings`, 'cat prod.settings',
    'node -e "require(\'child_process\').execSync(\'fakehost\')"', 'python3 -c "import os"', 'perl -e "system(1)"', 'if true; then $X deploy; fi',
  ];
  for (const c of forms) blocked(prodGuard.decide(bash(c, w.root), a), c);
  for (const c of ['npm test', 'node script.mjs', 'echo $HOME', 'ls -la', 'cat README.md', 'node --test'])
    passed(prodGuard.decide(bash(c, w.root), a), c);
});
