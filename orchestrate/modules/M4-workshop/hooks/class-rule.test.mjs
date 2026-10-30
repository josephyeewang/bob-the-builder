// The class rule for the shell guards (audit R-0b-44 round 2 MAT-1, MAT-2, MIN-3; R-0b-70): every
// shape the round-2 probe got through, letter case on a Mac disk, and the lane-3 corpus's
// remaining forms. Throwaway folders only; names of secret files are built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSnapshot } from './snapshot.mjs';
import { expansionIn, expandBraces, unreadable, shellCommands } from './lib.mjs';
import * as merge from './merge-guard.mjs';
import * as noVerify from './no-verify-block.mjs';
import * as prodGuard from './production-write-guard.mjs';
import * as secret from './secret-file-block.mjs';
import * as plain from './plain-files.mjs';
import { fold } from './lib.mjs';
import { fold as pushFold } from '../git/push-refusals.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const dot = (...p) => `.${p.join('')}`;
const ENV_PROD = dot('en', 'v.production');

function world() {
  const root = realpathSync(tempDir('m4-class-'));
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
  for (const c of ['git status', 'gh pr view 7', 'git log main', 'echo $HOME']) passed(merge.decide(bash(c, '/')), c);
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

// A Mac disk also opens long s (U+017F) as s, sharp s (U+00DF) as ss and the ligature U+FB01 as fi (audit R-0b-44
// round 3 MAT-1, checked on disk). Characters are written as escapes so the source stays plain.
test('round 3 MAT-1: names spelled with letters a Mac disk folds to plain ones are still refused', () => {
  const w = world();
  const LONG_S = '\u017f', SHARP_S = '\u00df', FI = '\ufb01';
  const keyDir = dot('ss', 'h');
  assert.equal(pushFold, fold, 'one fold, shared by the hooks and the push check');
  assert.equal(fold(`.${LONG_S}sh`), keyDir);
  assert.equal(fold(`.${SHARP_S}h`), keyDir);
  assert.equal(fold(`.con${FI}g`), '.config');
  assert.equal(fold('a\u00adb\u034fc'), 'abc', 'soft hyphen and other invisible marks dropped');
  assert.equal(fold('\uff53\u2071'), 'si', 'compatibility forms (full-width s, superscript i) fold too: errs on the side of refusing');
  const reads = [join(w.home, `.${LONG_S}sh`, 'config'), join(w.home, `.${SHARP_S}h`, 'config'), join(w.home, `.con${FI}g`, 'gh', 'hosts.yml')];
  for (const p of reads) blocked(secret.decide({ tool_name: 'Read', tool_input: { file_path: p } }, w.args), p);
  for (const c of [`cat ${w.home}/.${LONG_S}sh/config`, `cat ${w.home}/.con${FI}g/gh/hosts.yml`]) blocked(secret.decide(bash(c, w.work), w.args), c);
  for (const p of [`.mcp.j${LONG_S}on`, `.v${LONG_S}code/settings.json`, `${LONG_S}KILL.md`, `.con${FI}g/x`]) assert.equal(plain.isSetupPath(join(w.work, p)), true, p);
  blocked(prodGuard.decide(bash(`fakeho${LONG_S}t --x`, w.work), w.args), 'program spelled with long s');
});

// LEAD-CALLS L37: plain names only. The 11 letters the round 3 audit found a Mac disk opens as plain ones (long s,
// sharp s and its capital, the seven joined pairs, the Kelvin sign), and one look-alike on no list (Cyrillic e),
// are each refused by the secret guard (tool path, search, shell word) and the protected-file guard.
test('L37: every one of the 11 letters, and a look-alike on no list, is refused by both guards; plain ASCII names pass', () => {
  const w = world();
  const a = { ...w.args, role: 'worker', copy: w.work };
  const ELEVEN = ['ſ', 'ß', 'ẞ', 'ﬀ', 'ﬁ', 'ﬂ', 'ﬃ', 'ﬄ', 'ﬅ', 'ﬆ', 'K'];
  const CYRILLIC_E = 'е';
  assert.deepEqual(ELEVEN.map((c) => fold(c)), ['s', 'ss', 'ss', 'ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st', 'k'], 'control: the fold opens all 11 as the disk does');
  blocked(secret.decide({ tool_name: 'Read', tool_input: { file_path: join(w.home, '.\u1e9eh', 'config') } }, w.args), 'the key folder spelled with capital sharp s');
  assert.equal(fold(CYRILLIC_E), CYRILLIC_E, 'control: the look-alike is on no list, and the fold leaves it alone');
  for (const c of [...ELEVEN, CYRILLIC_E]) {
    const name = `notes${c}.md`;
    blocked(secret.decide({ tool_name: 'Read', tool_input: { file_path: join(w.work, name) } }, w.args), `Read ${name}`);
    blocked(secret.decide({ tool_name: 'Glob', tool_input: { pattern: `**/${name}` } }, w.args), `Glob ${name}`);
    blocked(secret.decide({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: `*${c}*` } }, w.args), `Grep glob ${name}`);
    blocked(secret.decide(bash(`cat ${name}`, w.work), w.args), `cat ${name}`);
    const r = plain.decide({ tool_name: 'Write', tool_input: { file_path: join(w.work, name) } }, a);
    blocked(r, `Write ${name}`);
    assert.match(r.reason, /is not a plain name/, name);
  }
  // An invisible mark is no letter, but the fold drops it: refused in the shell as well (soft hyphen).
  blocked(secret.decide(bash('cat notes\u00ad.md', w.work), w.args), 'a soft hyphen inside a shell word');
  // Confirm audit of L37: a search pattern with a wildcard or a letter range that could match a secret is refused,
  // and an odd space stays inside its shell word, as bash keeps it. Patterns are built at run time.
  for (const g of [`${dot('en')}?`, `${dot('e')}*`, `${dot('e')}[l-o]v`, '.[!a]nv', '.[d-f]nv']) {
    blocked(secret.decide({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: g, path: w.work } }, w.args), `Grep glob ${g}`);
    blocked(secret.decide({ tool_name: 'Glob', tool_input: { pattern: `**/${g}`, path: w.work } }, w.args), `Glob ${g}`);
  }
  blocked(secret.decide({ tool_name: 'Glob', tool_input: { pattern: `**/${dot('s')}[r-t]h/*` } }, w.args), 'Glob into the key folder by a letter range');
  blocked(secret.decide(bash(`cat ${dot('e')}\u00a0nv`, w.work), w.args), 'an odd space inside a shell word');
  // Plain ASCII passes: capitals, scoped packages, route folders, and a dash in a message.
  for (const p of ['src/App.tsx', 'node_modules/@types/x/index.d.ts', 'app/[id]/(group)/page.tsx', 'a+b.md']) {
    passed(secret.decide({ tool_name: 'Read', tool_input: { file_path: join(w.work, p) } }, w.args), p);
    passed(plain.decide({ tool_name: 'Write', tool_input: { file_path: join(w.work, p) } }, a), p);
  }
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'src/**/*.{ts,tsx}' } }, w.args), 'a plain search');
  passed(secret.decide(bash('git commit -m "fix — tidy"', w.work), w.args), 'a dash in a message is not a letter');
});

test('round 3 MIN-1: every push is refused, paths are tidied before the git-files check, and secrets are matched by short name', () => {
  const w = world();
  for (const c of ['git switch -c main && git push origin HEAD', 'git checkout -B main && git push -u origin @', 'git push origin card/c-12', 'git send-pack x HEAD']) {
    assert.equal(merge.decide(bash(c, w.work)).reason, 'a push (only the push script pushes)', c);
  }
  for (const c of ['printf "push = HEAD:main" >> .git/./config && git status', 'cat .git//config']) {
    assert.equal(merge.decide(bash(c, w.work)).reason, 'the command touches git\'s own settings or hooks files', c);
  }
  assert.equal(noVerify.decide(bash('cd .git/./hooks && rm pre-commit; git commit -m x', w.work)).reason, 'the command touches git\'s own settings or hooks files');
  // A `cd` the guard cannot follow, then the short name: the built-in gh login and a listed secret's last part.
  const bare = join(w.root, 'bare.json');
  writeFileSync(bare, makeSnapshot({ production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [join(w.home, 'vault', 'token.txt')] } }));
  const a = { ...w.args, snapshot: bare };
  for (const c of [`cd ${w.home}/.config && cat gh/hosts.yml`, `cd ${w.home}/vault && cat token.txt`]) {
    assert.match(secret.decide(bash(c, w.work), a).reason, /by its short name/, c);
  }
  for (const c of ['cat hosts.yml', 'cat notes/token.md', 'git status']) passed(secret.decide(bash(c, w.work), a), c);
});
