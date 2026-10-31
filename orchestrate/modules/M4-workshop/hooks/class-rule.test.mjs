// The class rule for the shell guards (audit R-0b-44 round 2 MAT-1, MAT-2, MIN-3; R-0b-70): every
// shape the round-2 probe got through, letter case on a Mac disk, and the lane-3 corpus's
// remaining forms. Throwaway folders only; names of secret files are built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSnapshot } from './snapshot.mjs';
import { expansionIn, expandBraces, unreadable, shellCommands, shellWords, globRe, heredocs } from './lib.mjs';
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
  const run = (command) => spawnSync(process.execPath, [script, '--role', 'builder', '--outbox', w.outbox, '--snapshot', w.snapshot], { input: JSON.stringify(bash(command, w.work)), encoding: 'utf8', timeout: 60_000 }).status;
  assert.equal(run('ls'), 0);
  assert.equal(run('git status'), 0);
  assert.equal(run(`echo x > ${ENV_PROD}`), 2);
  // Without the arguments every call is refused, which is why the corpus must be run with them.
  assert.equal(spawnSync(process.execPath, [script], { input: JSON.stringify(bash('ls', w.work)), encoding: 'utf8', timeout: 60_000 }).status, 2);
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
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'src/**/*.{ts,tsx}' }, cwd: w.work }, w.args), 'a plain search');
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

// LEAD-CALLS L41 G1 (lane 3's corpus, round 13): a `[^x]` set never matched, because the pattern escaped `^`. One
// pattern maker now serves both guards. The control shows the set really means "not": `[^n]` cannot be the n.
test('L41 G1: a [^x] or [!x] set matches as the shell does, in both guards', () => {
  const w = world();
  assert.equal(globRe(dot('e[^Q]v')).test(dot('env')), true);
  assert.equal(globRe(dot('e[!Q]v')).test(dot('env')), true);
  assert.equal(globRe('[!a]').test('a'), false);
  assert.equal(globRe('[]a]').test(']'), true, 'a ] first in the set is a plain ]');
  assert.equal(globRe('a[b').test('a[b'), true, 'an unclosed [ is a plain [');
  const caret = `${dot('e[^Q]v')}.production`;
  for (const c of [`cat ${caret}`, `echo x > ${caret}`, `rm -f ${caret}`, `cd .. && cat work/${caret}`, `cat ${dot('e[!Q]v')}.production`]) {
    blocked(prodGuard.decide(bash(c, w.work), w.args), c);
  }
  passed(prodGuard.decide(bash(`cat ${dot('e[^n]v')}.production`, w.work), w.args), 'control: [^n] is not the n');
  for (const c of [`cat ${dot('e[^Q]v')}`, `cat ${dot('[^a]sh')}/config`]) blocked(secret.decide(bash(c, w.work), w.args), c);
  blocked(secret.decide({ tool_name: 'Glob', tool_input: { pattern: `**/${dot('e[^Q]v')}` }, cwd: w.work }, w.args), 'Glob [^Q]');
});

// L41: the secret guard reads the value after `=` too, as the production guard does (`dd of=<file>`).
test('L41: the secret guard reads a name after "="', () => {
  const w = world();
  for (const c of [`dd if=/dev/zero of=${dot('en', 'v')}`, `dd if=${w.home}/${dot('ss', 'h')}/id_x of=/tmp/y`, `tool --file=${dot('ne', 'trc')}`]) {
    blocked(secret.decide(bash(c, w.work), w.args), c);
  }
  passed(secret.decide(bash('dd if=/dev/zero of=/tmp/y bs=1 count=1', w.work), w.args), 'control: plain dd');
});

// Lead, after the L37 confirm (a): `[ ]` is a pattern in the shell too. A route folder with a real `[id]` passes as a
// path; a letter range that could spell a secret name is caught as a pattern.
test('L41 (a): [ ] in a shell word is read as a pattern: route folders pass, a range spelling a secret is caught', () => {
  const w = world();
  for (const c of ['cat app/[id]/page.tsx', "ls 'app/[slug]/(group)'", 'cat app/[...all]/page.tsx']) passed(secret.decide(bash(c, w.work), w.args), c);
  for (const c of [`cat ${dot('[d-f]nv')}`, `cat ${dot('[a-z]nv')}.local`, `cat ${dot('[s]sh')}/config`]) blocked(secret.decide(bash(c, w.work), w.args), c);
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'app/[id]/**/*.tsx' }, cwd: w.work }, w.args), 'a route-folder search');
});

// Lead, deny by default for searches: a wildcard folder part, or a Grep (always every folder below), from a folder
// holding the key folder, a listed secret or the home folder, is refused whatever its last part is.
test('deny by default: a search that could reach into the key folder is refused, even naming no secret', () => {
  const w = world();
  mkdirSync(join(w.home, dot('ss', 'h')));
  mkdirSync(join(w.home, 'sub'));
  const no = (input, what) => assert.match(secret.decide(input, w.args).reason ?? 'passed', /could reach into a folder holding secret files/, what);
  no({ tool_name: 'Glob', tool_input: { pattern: '**/config', path: w.home } }, '** from the folder holding the key folder');
  no({ tool_name: 'Glob', tool_input: { pattern: '*/hosts', path: w.home } }, 'one * folder');
  no({ tool_name: 'Glob', tool_input: { pattern: `${w.home}/**/x` } }, 'an absolute pattern');
  no({ tool_name: 'Glob', tool_input: { pattern: '../**/config' }, cwd: join(w.home, 'sub') }, 'the folder above, by ..');
  no({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }, 'no folder to judge from');
  no({ tool_name: 'Grep', tool_input: { pattern: 'x', path: w.home } }, 'Grep searches every folder below');
  no({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.md', path: w.root } }, 'Grep from above a listed secret');
  no({ tool_name: 'Glob', tool_input: { pattern: '**/x', path: process.env.HOME } }, 'the home folder');
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'src/**/*.ts' }, cwd: w.work }, w.args), 'control: a project search');
  passed(secret.decide({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.ts', path: w.work } }, w.args), 'control: a project Grep');
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'config', path: w.home } }, w.args), 'control: no wildcard folder part');  // Each reason alone, with no secret listed: a folder holding the key folder, and a folder above the home folder.
  const none = join(w.root, 'none.json');
  writeFileSync(none, makeSnapshot({ production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [] } }));
  const bare = { ...w.args, snapshot: none };
  for (const [input, what] of [[{ tool_name: 'Glob', tool_input: { pattern: '**/config', path: w.home } }, 'holds the key folder'],
    [{ tool_name: 'Glob', tool_input: { pattern: '**/x', path: '/' } }, 'above the home folder']]) {
    assert.match(secret.decide(input, bare).reason ?? 'passed', /could reach into a folder holding secret files/, what);
  }
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: '**/x', path: w.work } }, bare), 'control: a folder holding neither');
});

// LEAD-CALLS L41 G2: deny by default for whole-folder writes. Each is refused when its target folder holds the
// production settings file, and a recursive delete of the working folder or anything above it always is.
test('L41 G2: a whole-folder write, delete, move, copy-onto or unpack over a folder holding a protected file is refused', () => {
  const w = world();
  mkdirSync(join(w.work, 'src'));
  symlinkSync(w.work, join(w.root, 'link'));
  const refuse = [
    `rm -rf ${w.work}`, 'rm -rf .', 'rm -r ../work', 'cd .. && rm -rf work', `cd ${w.root} && rm -rf work`, 'rm -rf /', `rm -rf ${w.root}`,
    `cd ${w.root} && rm -rf w*`, `rm -rf ${w.root}/link/`, 'rm -d -r src/..', 'rmdir ../work', `mv ${w.work} /tmp/old`, 'cd src && rm -rf ..',
    'find . -delete', `find ${w.work} -name x -delete`, 'git clean -fdx', `git -C ${w.work} clean -n`, 'tar xf /tmp/a.tar', `tar -xf /tmp/a.tar -C ${w.work}`,
    `tar --extract -f /tmp/a.tar --directory=${w.work}`, `unzip /tmp/a.zip -d ${w.work}`, 'unzip /tmp/a.zip', `cp -r /tmp/src/. ${w.work}`, 'cp -a /tmp/src/ ..',
    `rsync -a /tmp/src/ ${w.work}/`, `ditto /tmp/src ${w.work}`, 'chmod -R 777 .', `chown -R nobody ${w.work}`, 'cd sub* && rm -rf x',
    '(cd .. && rm -rf work)', 'pushd .. && rm -rf work', `rm -rf ${w.home}`,
  ];
  for (const c of refuse) blocked(prodGuard.decide(bash(c, w.work), w.args), c);
  const pf = [fold(w.envFile)];
  for (const c of ['rm -rf ~/work', 'rm -rf $HOME/work', 'rm -rf ${HOME}/work', 'cd ~ && rm -rf work', 'rm -rf $PWD', 'cd && rm -rf work']) {
    assert.ok(prodGuard.folderWriteWhy(c, { cwd: w.work, protectedFiles: pf, home: w.root }), c);
  }
  const allow = ['rm -rf build', 'rm -rf node_modules dist', 'cp -r src /tmp/x', 'tar cf /tmp/a.tar src', 'tar -czf /tmp/a.tgz --exclude=x src', 'mv a.txt b.txt',
    'unzip -l /tmp/a.zip', 'rm notes.txt', 'chmod 644 a.txt', 'cd src && rm -rf gen', 'cp a.txt src/', 'cp /tmp/a.txt .', 'find . -name "*.log"', 'git status'];
  for (const c of allow) passed(prodGuard.decide(bash(c, w.work), w.args), c);  // A recursive delete of the working folder or one above it is refused even when no protected file is inside.
  const deep = join(w.root, 'other', 'deep');
  mkdirSync(deep, { recursive: true });
  for (const c of ['rm -rf .', 'rm -rf ..', `rm -r ${join(w.root, 'other')}`, 'find .. -delete']) {
    assert.match(prodGuard.decide(bash(c, deep), w.args).reason ?? 'passed', /working folder or a folder above it/, c);
  }
  passed(prodGuard.decide(bash('rm -rf gen', deep), w.args), 'control: a folder below');
  // The settings file listed through a folder link is still found where it really is.
  const viaLink = join(w.root, 'via-link.json');
  writeFileSync(viaLink, makeSnapshot({ production: { env_files: [join(w.root, 'link', ENV_PROD)], programs: [], hosts: [] }, secrets: { paths: [] } }));
  blocked(prodGuard.decide(bash(`rm -rf ${w.work}`, w.root), { ...w.args, snapshot: viaLink }), 'listed through a link');
});

test('lane 2 follow-up (rsync vs cp -r): a copy of a folder holding a protected file is refused the same way by each copy program', () => {
  const w = world();
  mkdirSync(join(w.work, 'src'));
  const W = w.work;
  const why = (c, cwd = W) => prodGuard.decide(bash(c, cwd), w.args).reason ?? 'passed';
  // From the folder holding the settings file: copied out whole, refused with the copy reason, whichever program.
  for (const [c, t] of [['rsync -a ./ /tmp/y', './'], ['cp -r ./ /tmp/y', './'], ['cp -R . /tmp/y', '.'], ['cp -a . /tmp/y', '.'], ['ditto . /tmp/y', '.'],
    [`cp -R ${W} /tmp/y`, W], ['cp -R -t /tmp/y .', '.'], ['cp -r --target-directory=/tmp/y src .', '.'], ['rsync -a . /tmp/y --exclude x', '.'],
    ['rsync -av ../work/ /tmp/y/', '../work/'], ['cp -R src/.. /tmp/y', 'src/..'], ['cp -R {src,.} /tmp/y', '.']]) {
    assert.equal(why(c), `"${t}" is a folder holding a protected file, copied out as a whole`, c);
  }
  // From another folder, by its path, and the listed secret (a folder above it) too.
  assert.equal(why(`cp -R ${W} /tmp/y`, w.outbox), `"${W}" is a folder holding a protected file, copied out as a whole`);
  assert.equal(why(`rsync -a ${W}/ /tmp/y/`, w.outbox), `"${W}/" is a folder holding a protected file, copied out as a whole`);
  assert.equal(why('cp -R .config /tmp/y', w.home), '".config" is a folder holding a protected file, copied out as a whole');
  // Copied onto it still says written.
  assert.equal(why(`rsync -a /tmp/src/ ${W}/`, w.outbox), `"${W}/" is a folder holding a protected file, written as a whole`);
  assert.equal(why(`cp -R /tmp/src ${W}`, w.outbox), `"${W}" is a folder holding a protected file, written as a whole`);
  // Controls: a copy of a folder holding no protected file, and a plain file copy, pass from the same folder.
  for (const c of ['cp -r src /tmp/x', 'rsync -a src/ /tmp/x/', 'ditto src /tmp/x', 'cp -R -t /tmp/x src', 'cp a.txt /tmp/x']) passed(prodGuard.decide(bash(c, W), w.args), c);
  passed(prodGuard.decide(bash('rsync -a . /tmp/x/', w.outbox), w.args), 'control: the outbox holds no protected file');
  passed(prodGuard.decide(bash('cp -R . /tmp/x', w.outbox), w.args), 'control: cp the same');
});

// Confirm audit of L41, Material 1-7: whole-folder write forms the first cut missed. Each is refused by the
// production guard; the controls are ordinary work that must still pass.
test('L41 confirm: brace lists, rsync, tar/unzip folders, lost cd forms, links, stash --all, zip -m, trash', () => {
  const w = world();
  mkdirSync(join(w.work, 'src'));
  const W = w.work;
  const refuse = [
    // MAT-1: a brace list in the target
    `rm -rf ${w.root}/{work,dist}`, `cd ${w.root} && rm -rf {work,x}`,
    // MAT-2: rsync with an option after the names; every name is judged
    `rsync -a --delete /tmp/e/ ${W}/ --exclude x`, `rsync -a /tmp/e/ ${W}/ -e ssh`, `rsync -a --remove-source-files ${W}/ /tmp/x/`,
    // MAT-3: the unpack folder in a cluster, by bsdtar's long name, a later -C, unzip -od, the old form with C
    `tar -xC ${W} -f /tmp/a.tar`, `tar -xvC ${W} -f /tmp/a.tar`, `tar -xvC${W} -f /tmp/a.tar`, `tar -xf /tmp/a.tar --cd ${W}`, `tar -xf /tmp/a.tar --cd=${W}`,
    `tar -C ${w.outbox} -C ${W} -xf /tmp/a.tar`, `unzip -od ${W} /tmp/a.zip`, `tar xCf ${W} /tmp/a.tar`,
    // MAT-4: a cd through CDPATH, cd - after OLDPWD is set, another user's home
    `CDPATH=${w.root} cd work && tar xf /tmp/a.tar`, `export CDPATH=${w.root}; cd work; unzip /tmp/a.zip`, `OLDPWD=${W} cd - && tar xf /tmp/a.tar`,
    'cd ~nobody/x && tar xf /tmp/a.tar', 'tar -xf /tmp/a.tar -C ~nobody/x',
    // MAT-5: a link made in the same line
    `ln -s ${W} l && tar -C l -xf /tmp/a.tar`, `ln -s ${W} l; cd l; unzip -o /tmp/a.zip`, `ln -s ${W} /tmp/l2 && tar -C /tmp/l2 -xf /tmp/a.tar`,
    // MAT-6, MAT-7
    `git -C ${W} stash --all`, `git -C ${W} stash -a`, `git -C ${W} stash push --all`, `zip -rm /tmp/a.zip ${W}`, `zip -r --move /tmp/a.zip ${W}`, `trash ${W}`,
    // GNU cp's target folder
    `cp -r -t ${W} /tmp/src`, `cp -r --target-directory=${W} /tmp/src`,
  ];
  for (const c of refuse) blocked(prodGuard.decide(bash(c, w.outbox), w.args), c);
  for (const c of ['git stash -a', 'rm -rf {src,.}', 'rm -rf *']) blocked(prodGuard.decide(bash(c, W), w.args), `from the project: ${c}`);
  // From a folder holding no protected file, a delete of everything in it, or one taking the files away, is shielded.
  for (const c of ['rm -rf *', 'rsync -a --remove-source-files . /tmp/x/']) assert.match(prodGuard.decide(bash(c, w.outbox), w.args).reason ?? 'passed', /working folder/, c);
  passed(prodGuard.decide(bash('rsync -a . /tmp/x/', w.outbox), w.args), 'control: a copy out leaves the folder');
  const pf = [fold(w.envFile)];
  // `cd -` with no cd before it goes to a folder set before this call: not home, and not known (L45, round 2 minor).
  assert.match(prodGuard.folderWriteWhy('cd - && tar xf /tmp/a.tar', { cwd: w.outbox, protectedFiles: pf, home: w.work }) ?? 'none', /can't follow/, 'cd - with no cd before it');
  assert.match(prodGuard.folderWriteWhy('cd work && tar xf /tmp/a.tar', { cwd: w.root, protectedFiles: [], cdpath: '/x' }) ?? 'none', /can't follow/, 'CDPATH set outside the line');
  assert.equal(prodGuard.folderWriteWhy('cd ./work && tar xf /tmp/a.tar', { cwd: w.outbox, protectedFiles: [], cdpath: '/x' }), null, 'a ./ cd ignores CDPATH');
  assert.equal(prodGuard.folderWriteWhy('cd /tmp && cd - && rm -rf x', { cwd: w.outbox, protectedFiles: pf }), null, 'cd - goes back to a folder already counted');
  // A cd through a link: a later `..` is taken on disk from where the link leads (the folder holding the file).
  mkdirSync(join(w.outbox, 'a'));
  symlinkSync(join(W, 'src'), join(w.outbox, 'a', 'lnk'));
  for (const c of ['cd lnk && tar xf /tmp/a.tar -C ..', 'cd ln* && tar xf /tmp/a.tar -C ..']) blocked(prodGuard.decide(bash(c, join(w.outbox, 'a')), w.args), c);
  // Ordinary work still passes, from the project folder that holds the settings file.
  const allow = ['rm -rf *.egg-info', 'mv *.png src/', 'rm -rf src/gen*', 'rsync -a src/ /tmp/x/', 'tar -xf /tmp/a.tar -C /tmp/out', 'unzip -o /tmp/a.zip -d /tmp/out',
    'git stash', 'git stash -u', 'git stash pop', 'zip -r /tmp/a.zip src', 'ln -s src lnk', 'cp -r src /tmp/x'];
  for (const c of allow) passed(prodGuard.decide(bash(c, W), w.args), c);
});

// Confirm audit of L41, Material 8-10: letter classes, zsh groups in a word, and a search ending in `**`.
test('L41 confirm: a letter class fails closed, a zsh group reads whole, a trailing ** search is judged', () => {
  const w = world();
  assert.throws(() => globRe('.[[:alpha:]]x'), /letter class/);
  assert.throws(() => globRe('[[=e=]]'), /letter class/);
  assert.throws(() => globRe('[[.a.]]'), /letter class/);
  assert.equal(globRe('[a:]').test(':'), true, 'a plain : in a set is a letter');
  for (const c of [`cat ${w.work}/${dot('[[:alpha:]]nv.production')}`, `cat ${w.work}/${dot('e(n)v.production')}`, `cat ${w.work}/${dot('(x|q)nv.production')}`]) {
    blocked(prodGuard.decide(bash(c, w.outbox), w.args), `production: ${c}`);
    blocked(secret.decide(bash(c, w.outbox), w.args), `secret: ${c}`);
  }
  blocked(secret.decide(bash(`cat ${w.home}/${dot('[[:alpha:]]sh')}/config`, w.outbox), w.args), 'a class spelling the key folder');
  assert.deepEqual(shellWords('cat a(b)c', { groups: true }), ['cat', 'abc']);
  assert.deepEqual(shellWords('cat a(b)c'), ['cat', 'a', '(', 'b', ')', 'c']);
  assert.deepEqual(shellWords('(cd x && ls)'), ['(', 'cd', 'x', '&', '&', 'ls', ')']);
  passed(secret.decide(bash("ls 'app/(group)/page.tsx'", w.work), w.args), 'a route group, quoted');
  // Round 2 MAT-1: a quoted `|` is not a zsh choice; ordinary searches and filters pass both guards.
  for (const c of ["jq '.items | length' package.json", "grep -E 'a|b' src/x.ts", "git log --grep='fix|feat'", "sed -E 's/(a|b)/c/' x", 'echo "a|b"', "rg 'x(a|b)'"]) {
    passed(secret.decide(bash(c, w.work), w.args), `secret: ${c}`);
    passed(prodGuard.decide(bash(c, w.work), w.args), `production: ${c}`);
  }
  assert.match(unreadable('cat x(a|b)y') ?? 'none', /zsh pattern group/, 'an unquoted choice is still refused');
  // Both readings are checked: a name inside brackets in code fed to a program is still seen (lane 3's corpus).
  blocked(prodGuard.decide(bash(`python3 - <<'X'\nprint(open('${ENV_PROD}').read())\nX`, w.work), w.args), 'a name in brackets, production');
  blocked(secret.decide(bash(`python3 - <<'X'\nprint(open('${w.home}/${dot('ss', 'h')}/id_x').read())\nX`, w.work), w.args), 'a name in brackets, secret');
  const no = (input, what) => assert.match(secret.decide(input, w.args).reason ?? 'passed', /could reach into a folder holding secret files/, what);
  symlinkSync(w.home, join(w.work, 'hl'));
  mkdirSync(join(w.home, 'sub'));
  no({ tool_name: 'Glob', tool_input: { pattern: '**', path: w.home } }, '** alone');
  no({ tool_name: 'Glob', tool_input: { pattern: `${w.home}/**` } }, 'an absolute pattern ending in **');
  no({ tool_name: 'Glob', tool_input: { pattern: '../home/**' }, cwd: w.work }, '.. then **');
  no({ tool_name: 'Glob', tool_input: { pattern: 'hl/**' }, cwd: w.work }, 'a link to home then **');
  no({ tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: w.home }, '** from the home folder');
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: join(w.home, 'sub') }, w.args), 'control: ** below home reaches no secret');
  blocked(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'x', path: [w.home] }, cwd: w.work }, w.args), 'a search folder that is not a string');
  passed(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 'src/**' }, cwd: w.work }, w.args), 'control: ** in the project');
});

// LEAD-CALLS L45: the confirm audit of L41, round 2, found new spellings of the same tricks, so each class is now
// refused whole. Every round-2 Material is planted here; the controls are ordinary work that must still pass.
test('L45: zsh groups and qualifiers, brace ranges, wrappers, short option names, cd forms, links, unpackers', () => {
  const w = world();
  const R = w.root;
  const W = w.work;
  mkdirSync(join(W, 'src'));
  symlinkSync(W, join(R, 'lnk'));
  symlinkSync(W, join(R, 'oldlink'));
  const refuse = [
    // MAT-2 to MAT-5: zsh groups anywhere in a word, in a command name, and glob qualifiers that run code
    `rm -rf ${R}/w(o)rk`, `cd ${R} && rm -rf (w)ork`, `/bin/(r)m -rf ${W}`, 'fakeh(o)st deploy', `cd ${R} && ls -d o*(e:'rm -rf work':)`, 'ls *(+x)',
    'ls (a|b)', 'a=(x y)', `cat =(ls ${W})`,
    // MAT-6: a brace range
    `rm -rf ${R}/wor{j..l}`, `rm -rf ${R}/{a..z}ork`,
    // MAT-7, MAT-12, MAT-13: a long option by a shorter name
    `tar -xf /tmp/a.tar --dir=${W}`, `tar --ext -f /tmp/a.tar -C ${W}`, `git -C ${W} stash push --al`, `zip -r --mov /tmp/a.zip ${W}`,
    `cp -r --target=${W} /tmp/s`, `mv --target-directory=${W} /tmp/s`, `rsync -a /tmp/s/ /tmp/d/ --backup-dir=${W}`, `rm --rec ${W}`,
    // MAT-12: git settings on the command line, and setting an alias
    `git -c alias.x='clean -fdx' -C ${W} x`, "git config alias.x 'clean -fdx'", `git --config-env=alias.x=V -C ${W} x`,
    // MAT-8: full paths kept from the archive, and unpackers not on the list while in a folder holding a protected file
    'tar -xPf /tmp/evil.tar', 'tar -x --absolute-paths -f /tmp/a.tar', 'tar --extract --abs -f /tmp/a.tar',
    `cd ${W}; cpio -idm < /tmp/a.cpio`, `cd ${W} && pax -r -f /tmp/a.pax`, `cd ${W} && aa extract -i /tmp/a.aar`,
    // MAT-9: cd forms the guard can't follow
    `cd ${R} && cd outbox work && tar xf /tmp/a.tar`, `cd ${R}; CDPATH+=..; cd work && tar xf /tmp/a.tar`,
    `cd ${R}; setopt cdablevars; cd ${W} && tar xf /tmp/a.tar`, `shopt -s cdable_vars; cd ${W} && tar xf /tmp/a.tar`, 'cd +1 && tar xf /tmp/a.tar',
    `cd ${R}; export CDPATH=${R}; cd .work && tar xf /tmp/a.tar`,
    // MAT-10, MAT-11: a link made without ln, and a link among a wildcard's matches
    `cp -R ${R}/oldlink /tmp/l && tar -C /tmp/l -xf /tmp/a.tar`, `tar -xf /tmp/a.tar -C ${R}/ln?`, `cp -r /tmp/evil/. ${R}/ln?`, `rm -rf ${R}/old*`,
    // MAT-14: wrappers, and Homebrew's g-named tools
    `nice -n 5 rm -rf ${W}`, `caffeinate -i rm -rf ${W}`, `sudo -u root rm -rf ${W}`, `env -u X rm -rf ${W}`, `timeout 5 rm -rf ${W}`,
    `caffeinate -i ln -s ${W} /tmp/l`, `grm -rf ${W}`, `gcp -r /tmp/s ${W}`, `time -p rm -rf ${W}`,
    // One case each that only its own check refuses (planted-failure gaps): a group after `&&` with its `)` stuck,
    // a plain wrapper given an option that takes a value, zsh's two-word cd, and a cd after a shell option change.
    `(r)m -rf ${W}`, `exec -a x rm -rf ${W}`, 'cd outbox work && tar xf /tmp/a.tar', 'shopt -s cdable_vars; cd zz && tar xf /tmp/a.tar',
  ];
  for (const c of refuse) blocked(prodGuard.decide(bash(c, w.outbox), w.args), c);
  for (const c of [`cat (${dot('e')})nv.production`, `cat ${dot('(e)')}nv.production`]) {
    blocked(prodGuard.decide(bash(c, W), w.args), `production: ${c}`);
    blocked(secret.decide(bash(c, W), w.args), `secret: ${c}`);
  }
  // The shield: a delete of every name in the working folder, however the pattern is spelled (`.[!.]*` is refused
  // first as a dot part holding `[`, L60).
  for (const c of ['rm -rf [a-z]*', 'rm -rf .[!.]*', 'rsync -a --remove-source . /tmp/x/']) assert.match(prodGuard.decide(bash(c, w.outbox), w.args).reason ?? 'passed', /working folder|pattern starting with a dot/, c);
  blocked(secret.decide({ tool_name: 'Glob', tool_input: { pattern: 5, path: w.home } }, w.args), 'a Glob pattern that is not text');
  // Ordinary work still passes, from the project folder that holds the settings file.
  const allow = ['rm -rf **/node_modules', "jq '.items | length' package.json", 'env NODE_ENV=test npm test', 'nohup npm start', 'time ls',
    '(cd src && ls)', 'if (true); then ls; fi', 'git -C src status', 'npm test', 'cat <(ls)', 'rm -rf src/gen*', 'rm -rf src/*.tmp',
    'find . \\( -name a -o -name b \\) -print', "git commit -m 'a (b) c'", 'tar -xf /tmp/a.tar -C /tmp/out', 'make build'];
  for (const c of allow) passed(prodGuard.decide(bash(c, W), w.args), c);
  passed(prodGuard.decide(bash('cpio -idm < /tmp/a.cpio', w.outbox), w.args), 'control: an unpacker away from protected files');
  // Each cd no longer doubles the work: 30 of them stay quick.
  const t = Date.now();
  passed(prodGuard.decide(bash(`${'cd . ; '.repeat(30)}rm -rf src/gen`, W), w.args), 'thirty cds');
  assert.ok(Date.now() - t < 3_000, 'thirty cds are checked quickly');
});

// LEAD-CALLS L46 (round 3 of the confirm audit): the five false refusals of ordinary work pass, the real-path tricks are
// judged where the system takes them, and the remaining zsh tricks are refused as whole classes.
test('L46: ordinary work passes, links and tar folders are judged on disk, shell options and functions are refused', () => {
  const w = world();
  const R = w.root;
  const W = w.work;
  mkdirSync(join(W, 'src'));
  mkdirSync(join(W, 'dist'));
  mkdirSync(join(w.outbox, 'deep', 'er'), { recursive: true });
  // A link in the outbox to a folder inside the project: `l/..` is the project on disk, the outbox as text.
  symlinkSync(join(W, 'src'), join(w.outbox, 'l'));
  const pass1 = (c, cwd = W) => { passed(prodGuard.decide(bash(c, cwd), w.args), `production: ${c}`); passed(secret.decide(bash(c, cwd), w.args), `secret: ${c}`); };
  // MAT-10 to MAT-14: false refusals.
  for (const c of [
    'git pull && rm -rf dist', 'rm -rf node_modules && rm -rf .next', 'npm ci && rm -rf dist',
    'curl -s localhost:3000/health', 'lsof -i :3000', 'kill 1234', 'ps aux | grep node', 'docker compose up -d', 'cargo test', 'go test ./...', 'sqlite3 db.sqlite .tables', 'brew list',
    'ls\n(cd src && npm test)', "git commit -F - <<'EOF'\nfeat(scope): add (x) for $5\nsrc/a.ts | 2 +-\nEOF", 'cat > notes.md <<EOF\nsee (a) and (b)\nEOF',
    'rm -rf **/node_modules', 'ls src/*', 'rm -rf dist/*', "find . -not -path './node_modules/*' -name '*.ts'", 'set -euo pipefail; npm test',
  ]) pass1(c);
  // MAT-1, MAT-2: a link followed by `..`.
  for (const c of ['rm -rf l/../../work', 'rm -rf l/..', 'cd -P l/.. && rm -rf ../work', 'cd l/.. && tar xf /tmp/a.tar', 'tar -xf /tmp/a.tar -C l/..', 'rm -rf l*/../x']) {
    blocked(prodGuard.decide(bash(c, w.outbox), w.args), c);
  }
  // MAT-4, MAT-5: tar's -C values add up; a C inside the -f value is not a -C.
  for (const c of ['tar -xf /tmp/a.tar -C deep -C ../../work', 'tar -xf /tmp/a.tar -C deep/er -C ../../.. -C work', 'git -C deep -C ../../work clean -n']) {
    blocked(prodGuard.decide(bash(c, w.outbox), w.args), c);
  }
  for (const c of ['tar -xfCa.tar', 'tar -xfC /tmp/a.tar', 'tar -xf a.tar member -C /tmp/out', 'tar xf -Cfoo']) blocked(prodGuard.decide(bash(c, W), w.args), `from the project: ${c}`);
  for (const c of ['tar -xf /tmp/a.tar -C /tmp/out', 'tar -xf /tmp/a.tar --exclude x -C /tmp/out', 'tar -C /tmp/out -xf /tmp/a.tar']) pass1(c);
  // MAT-3, MAT-6 to MAT-9 and *** (once ** passes): refused as whole classes, by both guards.
  for (const c of [
    `export HOME=${R} && rm -rf ~/work`, `HOME=${R}; rm -rf ~/work`, `TMPDIR=${R} rm -rf $TMPDIR/work`, 'unset HOME; cd; rm -rf work', `read HOME <<< ${R}`, `printf -v HOME ${R}`,
    '=rm -rf ../work', 'function f { rm -rf ../work; }; f', 'f () { rm -rf ../work; }; f', '() { rm -rf ../work }',
    'setopt extendedglob; rm -rf ../wor#k', 'unsetopt bareglobqual', 'emulate sh', 'shopt -s extglob', 'set -o extendedglob', 'set -B', 'zmodload zsh/files', 'builtin setopt braceccl',
    'rm -rf ../app<->', 'rm -rf ../w<1-9>', 'rm -rf ***/work', 'noglob rm -rf x',
    'cat <<X\n$(id)\nX', 'x=1 && (( y = 1 << z ))\nrm -rf /', 'cat <<X\na\\\nX\nrm -rf ../work', "echo a # it's\ncat <<X\nb\nX",
  ]) {
    blocked(prodGuard.decide(bash(c, w.outbox), w.args), `production: ${c}`);
    blocked(secret.decide(bash(c, w.outbox), w.args), `secret: ${c}`);
  }
  // A here-document's body is not commands, but its words are still read: a secret named in it is caught.
  blocked(secret.decide(bash(`cat <<'X'\n${w.home}/${dot('ss', 'h')}/id_x\nX`, W), w.args), 'a secret named in a body');
  // The command after a body is still a command.
  blocked(prodGuard.decide(bash(`cat <<'X'\nhello\nX\nrm -rf ${W}`, w.outbox), w.args), 'a command after a body');
  // An unpacker is still refused where a protected file is, and still runs elsewhere.
  blocked(prodGuard.decide(bash('cpio -idm < /tmp/a.cpio', W), w.args), 'an unpacker in the project');
  // A write after a command that can make a link is still refused (MAT-5).
  blocked(prodGuard.decide(bash(`ln -s ${W} k && tar -C k -xf /tmp/a.tar`, w.outbox), w.args), 'a link made first');
  // Secret names through a pattern that is not stars alone are still caught.
  blocked(secret.decide(bash(`cat ${w.home}/${dot('ss?')}/id_x`, W), w.args), 'a ? in the key folder name');
  blocked(prodGuard.decide(bash(`cat ${dot('e*')}`, W), w.args), 'a .e* word names the settings file');
  // A body's lines are not commands: a production program or a merge named in it is text.
  pass1("cat > notes.md <<'EOF'\nfakehost is our db tool\nEOF");
  passed(merge.decide(bash("git commit -F - <<'EOF'\ngh pr merge is done by the lead\nEOF", W)), 'a merge named in a commit message');
  // An end word that is not a plain name is refused, by both guards.
  for (const c of ["cat <<'A B'\nx\nA B\nsetopt nullglob", "cat <<'A;B'\nx\nA;B\nsetopt nullglob"]) {
    blocked(prodGuard.decide(bash(c, w.outbox), w.args), `production: ${c}`);
    blocked(secret.decide(bash(c, w.outbox), w.args), `secret: ${c}`);
  }
  // Every guard reads the raw command for here-documents: joining lines first would hide a body line's backslash.
  const hidden = 'cat <<X\na\\\nX\necho hi\nX';
  blocked(prodGuard.decide(bash(hidden, w.outbox), w.args), 'production: a backslash hidden by joining lines');
  blocked(merge.decide(bash(hidden, w.outbox)), 'merge: a backslash hidden by joining lines');
  blocked(noVerify.decide(bash(hidden, w.outbox)), 'no-verify: a backslash hidden by joining lines');
  // Every builtin that sets a variable by name counts.
  for (const c of ['strftime -s HOME %s 0', 'zformat -f HOME x', 'zparseopts -A HOME x']) blocked(prodGuard.decide(bash(c, w.outbox), w.args), c);
  // The old form's letters take their values in order: the archive is not a name, so the project is not judged.
  pass1('tar xf /tmp/a.tar -C /tmp/out');
  // git's -C values add up as tar's do.
  assert.deepEqual(prodGuard.folderWrites(['git', '-C', 'a', '-C', '../b', 'clean', '-fdx']).targets, ['.', 'a', 'a/../b']);
});
// Round 4 confirm audit (L46): real commands read as here-document text, and an unquoted $HOME refused.
test('L46 round 4: a control character, a comment after a line-break, a here-string; and $HOME unquoted', () => {
  const w = world();
  const W = w.work;
  const pass1 = (c) => passed(prodGuard.decide(bash(c, W), w.args), `production: ${c}`);
  const both = (c) => { blocked(prodGuard.decide(bash(c, W), w.args), c); blocked(merge.decide(bash(c.replace(`rm -rf ${W}`, 'git push origin HEAD:main'), W)), c); };
  for (const cc of ['\r', '\v', '\f', '\x1b']) both(`cat <<EOF${cc}\nhi\nEOF${cc}\nrm -rf ${W}\n`);
  both(`echo a \\\n# <<EOF\nrm -rf ${W}\nEOF`);
  both(`cat <<<hi\nrm -rf ${W}\nhi`);
  // Not a comment: `a\` + `#` is the word a#, so the here-document is real and the rm line is its text.
  pass1(`echo a\\\n# <<EOF\nrm -rf ${W}\nEOF`);
  for (const c of ['ls $HOME/projects', 'cd $HOME/code && git status', 'cat $PWD/package.json', 'npm test; echo $?', 'npm test || echo failed $?', 'echo ${HOME}',
    "jq . <<< '{\"a\":1}'", "wc -w <<< 'hello world'", "cat > Dockerfile <<'EOF'\nRUN apt-get update && \\\n  apt-get install -y x\nEOF"]) {
    pass1(c);
    passed(secret.decide(bash(c, W), w.args), c);
    passed(merge.decide(bash(c, W)), c);
    passed(noVerify.decide(bash(c, W)), c);
  }
  for (const c of ['$HOME/bin/x', '$USER', `rm -rf $PWD`, `rm -rf \${PWD}`, `cat > D <<EOF\nRUN a && \\\nEOF\nrm -rf ${W}\nEOF`]) blocked(prodGuard.decide(bash(c, W), w.args), c);
  assert.match(prodGuard.decide(bash("git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\"", W), w.args).reason, /git commit -F -/);
});


// Round 4 narrow check (L46): `$USER` and `$TMPDIR` were left as letters in a path, so a path through them named a
// folder that does not exist and passed. They are filled in now, and any other variable in a path is refused.
test('L46 round 4 check: $USER and $TMPDIR in a path are filled in; any other variable in a path is refused', () => {
  const w = world();
  const pf = [fold(w.envFile)];
  // The worker's copy is <users>/<user>/work, as on a Mac (/Users/<name>/proj).
  const user = basename(w.root);
  const users = dirname(w.root);
  const why = (c, more = {}) => prodGuard.folderWriteWhy(c, { cwd: w.work, protectedFiles: pf, home: w.home, user, tmpdir: w.root, ...more });
  const refuse = [`rm -rf ${users}/$USER/work`, 'rm -rf ../../$USER/work', 'rm -rf ../../$USER/*', 'rm -rf ../../$USER', 'mv ../../$USER /tmp/x',
    'rm -rf ../../${USER}/work', 'rm -rf $FOO/work', 'rm -rf $TMPDIR/work', 'rm -rf ${TMPDIR}', 'cd $FOO && rm -rf work', 'rm -rf $?/work', 'cp -r /tmp/a $1'];
  for (const c of refuse) assert.ok(why(c), c);
  // Without a value for $USER, a path through it is unknown, so refused.
  for (const c of ['rm -rf ../../$USER', 'rm -rf /tmp/scratch-$USER']) assert.ok(why(c, { user: '' }), c);
  for (const c of ['rm -rf $TMPDIR/build', 'rm -rf /tmp/$USER-scratch', 'rm -rf /tmp/${USER}-scratch', 'rm -rf ${TMPDIR}build', 'rm -rf build', 'mv a.txt $TMPDIR/']) {
    assert.equal(why(c, { tmpdir: join(users, 'elsewhere') }), null, c);
  }
  // Through decide: the hook fills $USER from its own surroundings.
  const was = process.env.USER;
  process.env.USER = user;
  try {
    for (const c of ['rm -rf ../../$USER', `rm -rf ${users}/$USER/work`]) blocked(prodGuard.decide(bash(c, w.work), w.args), c);
  } finally { if (was === undefined) delete process.env.USER; else process.env.USER = was; }
  blocked(prodGuard.decide(bash('rm -rf $FOO/work', w.work), w.args), '$FOO');
});

// Round 4 narrow check (L46), Minor: a carriage return right before a line break is read as the shell reads it.
test('L46 round 4 check: lines with Windows line ends are read as the shell reads them', () => {
  const w = world();
  const W = w.work;
  const pass1 = (c) => passed(prodGuard.decide(bash(c, W), w.args), JSON.stringify(c));
  const no = (c) => blocked(prodGuard.decide(bash(c, W), w.args), JSON.stringify(c));
  pass1("git commit -F - <<'EOF'\r\nFix the thing\r\n\r\nMore words\r\nEOF\r\n");
  pass1('git status\r\nnpm test\r\n');
  // The end word carries the return, as in the shell: the line after it is a command.
  no(`cat <<'EOF'\r\nhi\r\nEOF\r\nrm -rf ${W} \r\n`);
  // `rm -rf <folder>` + return names a folder whose name ends in the return, in the shell as in the guard.
  pass1(`rm -rf ${W}\r\n`);
  // A body line "EOF" without the return does not end it in the shell either; the end-word line with the return does.
  no(`cat <<EOF\r\nhi\nEOF\nx\r\nEOF\r\nrm -rf ${W}\n`);
  // A backslash before the return does not join the lines: the next line is its own command.
  no(`echo a \\\r\nrm -rf ${W} \r\n`);
  // A return anywhere else is still refused.
  for (const c of ['echo a\rrm -rf x', 'echo a\r', 'echo a\r\r\n']) no(c);
  passed(noVerify.decide(bash("git commit -F - <<'EOF'\r\nmsg\r\nEOF\r\n", W)), 'no-verify: CRLF message');
});

// Lane 2 follow-up (comment-quote): a quote, backtick or backslash in a comment made the guard read the next lines as
// part of the comment's word, while bash and zsh end the comment at the line break and run them.
test('comment-quote: a comment holding a quote, a backtick or a backslash is refused, with or without a here-document', () => {
  const w = world();
  const W = w.work;
  mkdirSync(join(W, 'config'));
  const second = join(W, 'config', ENV_PROD);
  writeFileSync(second, 'Y=1\n');
  writeFileSync(w.snapshot, makeSnapshot({ production: { env_files: [w.envFile, second], programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(w.home, '.config', 'gh', 'hosts.yml')] } }));
  const pf = [w.envFile, second].map(fold);
  const why = (c) => prodGuard.folderWriteWhy(c, { cwd: W, protectedFiles: pf, home: w.home, user: 'u', tmpdir: w.root, cdpath: '' });
  const allHooks = (c, what) => {
    blocked(prodGuard.decide(bash(c, W), w.args), `production: ${what}`);
    blocked(secret.decide(bash(c, W), w.args), `secret: ${what}`);
    blocked(merge.decide(bash(c, W)), `merge: ${what}`);
    blocked(noVerify.decide(bash(c, W)), `no-verify: ${what}`);
  };
  // The repro, as the shells read it: both run the line after the comment (a shell that isn't installed is skipped:
  // the CI machine has no zsh).
  for (const sh of ['/bin/bash', '/bin/zsh'].filter((x) => existsSync(x))) {
    for (const mark of ["it's", 'a"b', 'a`b', 'foo \\']) {
      const r = spawnSync(sh, ['-c', `echo A # ${mark}\necho HIDDEN`], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(r.stdout, /HIDDEN/, `${sh} runs the line after a comment holding ${mark}`);
    }
  }
  const marks = ["'", '"', '`', '\\'];
  const before = { 'start of line': (m) => `# it${m}s`, 'after ;': (m) => `ls; # it${m}s`, 'after &&': (m) => `ls && # it${m}s`, 'after a word': (m) => `ls # it${m}s`, 'after |': (m) => `ls | # it${m}s`, 'after a tab': (m) => `ls\t# it${m}s`, 'at the end': (m) => `ls # it${m}` };
  const hidden = ['rm -rf config', 'rm -rf *', 'git clean -fdx', 'npm test'];
  let n = 0;
  for (const m of marks) {
    for (const [where, line] of Object.entries(before)) {
      assert.ok(heredocs(line(m)).why, `the comment check: ${where}, ${m}`);
      for (const next of hidden) {
        const c = `${line(m)}\n${next}`;
        const what = `${where}, ${JSON.stringify(m)}, then ${next}`;
        assert.ok(why(c), `folder rule: ${what}`);
        allHooks(c, what);
        n += 1;
      }
    }
  }
  assert.equal(n, 112);
  // Also next to a here-document, as before, and inside a substitution in double quotes (refused as a substitution).
  allHooks("echo a # it's\ncat <<X\nb\nX\nrm -rf config", 'with a here-document');
  allHooks("echo \"$(echo a # it's\nrm -rf config\n)\"", 'in a substitution in double quotes');
  // Controls: a # inside quotes or inside a word is not a comment; a comment with no such mark passes and ends at the
  // line break, so the next line is still judged; a body line is text, not a comment.
  const pass1 = (c) => { assert.equal(why(c), null, `folder rule: ${JSON.stringify(c)}`); passed(prodGuard.decide(bash(c, W), w.args), JSON.stringify(c)); passed(secret.decide(bash(c, W), w.args), `secret: ${JSON.stringify(c)}`); };
  for (const c of ["echo '#x'", 'echo "a # b"', 'x=a#b', "echo '#x' \"it's\"", "echo \"a # it's\"", 'x=a#b"c"', "x=a#b && echo \"it's\"", "echo a#it\\'s", "echo \\#it\\'s", 'ls # fine\nnpm test', "git commit -F - <<'EOF'\n# it's done\nEOF"]) {
    assert.equal(heredocs(c).why, null, `the comment check: ${JSON.stringify(c)}`);
    pass1(c);
  }
  for (const c of ["echo '#x'\nrm -rf config", 'echo "a # b"\nrm -rf config', 'x=a#b\nrm -rf config', 'ls # fine\nrm -rf config']) {
    assert.match(why(c) ?? 'none', /"config" is a folder holding a protected file/, `the next line is judged: ${JSON.stringify(c)}`);
    blocked(prodGuard.decide(bash(c, W), w.args), JSON.stringify(c));
  }
  // The refusal says what to do.
  assert.match(unreadable("ls # it's\nnpm test"), /comment holding a quote, a backtick or a backslash \(take the comment out\)/);
});

// #40 (lane 2 follow-up, cd-glob): a shortcut that judged the rest of a `cd <folder> && …` line from the subfolder
// alone was tried for three rounds (fresh checks found 3, 1 and 1 Material) and dropped under LEAD-CALLS L53. The
// folder rule is main's: every folder the line may be in counts, the working folder included. These tests keep the
// forms each round found refused, and pin the false refusals as a known cost, so a future loosening changes them on
// purpose.
function cdWorld() {
  const w = world();
  for (const d of ['dist/sub', 'Dist2/deep', 'deep', 'locked', 'config']) mkdirSync(join(w.work, d), { recursive: true });
  writeFileSync(join(w.work, 'dist', 'a.txt'), 'x');
  writeFileSync(join(w.work, 'notdir'), 'x');
  symlinkSync(w.root, join(w.work, 'out'));
  symlinkSync(join(w.work, 'dist'), join(w.work, 'in'));
  symlinkSync(w.outbox, join(w.work, 'ob'));
  chmodSync(join(w.work, 'notdir'), 0o755);
  // A second protected file, in a folder of its own, for the reviewer's `rm -rf config` forms.
  const configEnv = join(w.work, 'config', ENV_PROD);
  writeFileSync(configEnv, 'X=1\n');
  writeFileSync(w.snapshot, makeSnapshot({ production: { env_files: [w.envFile, configEnv], programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(w.home, '.config', 'gh', 'hosts.yml')] } }));
  const pf = [fold(w.envFile), fold(configEnv)];
  const why = (c, more = {}) => prodGuard.folderWriteWhy(c, { cwd: w.work, protectedFiles: pf, home: w.home, cdpath: '', ...more });
  const no = (c, more) => {
    assert.ok(why(c, more), `allowed: ${JSON.stringify(c)}`);
    if (!more) blocked(prodGuard.decide(bash(c, w.work), w.args), JSON.stringify(c));
  };
  return { ...w, why, no };
}

test('L53 known false refusal: a plain cd into a subfolder does not move where globs and . are judged', () => {
  const w = cdWorld();
  // Each of these deletes only inside the subfolder, but the working folder holds a protected file and the rule
  // judges from there too. Refused on purpose (the cost of L53).
  for (const c of ['cd dist && rm -rf *', 'cd dist; rm -rf *', 'cd dist && rm -rf .', 'cd dist && rm -rf ./*', 'cd ./dist && rm -rf *', 'cd dist/ && rm -rf *',
    'cd dist/sub && rm -rf *', 'cd dist && cd sub && rm -rf .', 'cd dist ; rm -rf * && ls', 'cd in && rm -rf *', 'cd dist && rm -rf * && rmdir sub',
    'cd\tdist\t&&\trm -rf *', 'cd dist&&rm -rf *', 'cd dist && find . -delete', 'cd dist && git clean -fdx']) w.no(c);
  // The workarounds the README gives pass: name the subfolder. (Running `rm -rf *` from the subfolder is no
  // workaround: main's rule refuses a bare `*` in the folder the call runs in, whatever it holds.)
  for (const [c, cwd] of [['rm -rf dist/*', w.work], ['rm -rf dist', w.work], ['rm -rf dist/sub', w.work]]) {
    assert.equal(prodGuard.folderWriteWhy(c, { cwd, protectedFiles: [fold(w.envFile)], home: w.home, cdpath: '' }), null, c);
    passed(prodGuard.decide(bash(c, cwd), w.args), c);
  }
});

test('#40, all rounds: every form a check found stays refused, as are the reviewer\'s background and later-step forms', () => {
  const w = cdWorld();
  chmodSync(join(w.work, 'locked'), 0o600);
  try {
    // The first build's own refusal list.
    for (const c of ['cd dist && rm -rf ../*', 'cd dist; rm -rf ..', 'cd dist && rm -rf ../.', 'cd dist || rm -rf *', '(cd dist); rm -rf *', '(cd dist && true); rm -rf *',
      '(cd dist; true); rm -rf *', 'cd ob && rm -rf *', 'cd nope; rm -rf *', 'cd notdir; rm -rf *', 'cd locked; rm -rf *', 'cd out && rm -rf *', 'cd dist & rm -rf *',
      'cd dist | rm -rf *', 'cd dist && cd .. && rm -rf *', 'cd dist; cd -; rm -rf *', 'cd .. && rm -rf *', 'cd dist/.. && rm -rf *', 'cd d* && rm -rf *',
      'cd -P dist && rm -rf ../*', 'ls; cd dist && rm -rf *', 'cd dist && rm -rf * ; cd .. ; rm -rf *', 'rm -rf *', 'if cd dist; then true; fi; rm -rf *',
      'CDPATH=/x; cd dist; rm -rf *', 'cd dist && setopt cdablevars && rm -rf *']) w.no(c);
    w.no('cd dist && rm -rf *', { cdpath: '/x' });
    // Round 2 (M1-M3): a line break, a return or a non-ASCII blank in the cd part.
    w.no('cd\nDist2; rm -rf .config', { protectedFiles: [fold(join(w.home, '.config', 'gh', 'hosts.yml'))] });
    for (const c of ['cd\nDist2; rm -rf *', 'cd Dist2\r\n; rm -rf *', 'cd Dist2\r\n; rm -rf .', 'cd Dist2 \r\n; rm -rf *']) w.no(c);
    w.no('cd Dist2\r\n; rm -rf deep', { protectedFiles: [fold(join(w.work, 'deep', ENV_PROD))] });
    for (const tail of ['rm -rf *', 'git clean -fdx', 'find . -delete']) w.no(`cd Dist2 ; ${tail}`);
    for (const c of ['cd Dist2;; rm -rf *', 'cd Dist2 &&& rm -rf *', 'cd Dist2;& rm -rf *', 'cd Dist2;| rm -rf *', 'cd Dist2 &&| rm -rf *']) w.no(c);
    const blanks = [];
    for (let c = 0; c <= 0xffff; c += 1) {
      const ch = String.fromCharCode(c);
      if (ch !== ' ' && ch !== '\t' && (/\s/.test(ch) || /[\p{White_Space}\p{Zs}\p{Zl}\p{Zp}]/u.test(ch))) blanks.push(ch);
    }
    blanks.push('᠎', '​', '⁠');
    for (const ch of ['\r', '\n', '\v', '\f', '\u0085', ' ', ' ', ' ', '　', '﻿']) assert.ok(blanks.includes(ch), `the sweep holds U+${ch.charCodeAt(0).toString(16)}`);
    for (const ch of blanks) for (const j of [';', '&&', ' ;', ' &&']) {
      for (const c of [`cd${ch}Dist2${j} rm -rf *`, `cd ${ch}Dist2${j} rm -rf *`, `cd Dist2${ch}${j} rm -rf *`, `cd Dist2 ${ch}${j} rm -rf *`]) w.no(c);
    }
    // Round 3 (M1): git clean with a path and git stash -a reach the whole repository; and other commands after the cd.
    for (const c of ['cd Dist2 && git clean -fdx :/', 'cd Dist2 && git clean -fdx ..', 'cd Dist2 && git clean -fdx -- ../', "cd Dist2 && git clean -fdx ':(top)'",
      'cd Dist2 && git clean -fdx -e x :/', 'cd Dist2 && git stash --all', 'cd Dist2 && git stash -a', 'cd Dist2 && git stash push -a',
      'cd Dist2 && unzip -: x.zip', 'cd Dist2 && rm -rf * && find . -delete', 'cd Dist2 && rm -rf * | cat', 'cd Dist2 && sudo rm -rf *', 'cd Dist2 && command rm -rf *',
      'cd Dist2 && X=1 rm -rf *', 'cd Dist2 && { rm -rf *; }', 'cd Dist2 && (rm -rf *)', 'cd Dist2 && chmod -R 777 .', 'cd Dist2 && mv * /tmp/x',
      'cd Dist2; rm -rf *', 'cd Dist2 ; rm -rf .', 'cd Dist2 && cd deep; rm -rf *']) w.no(c);
    blocked(prodGuard.decide(bash('cd Dist2 && rm -rf $(echo *)', w.work), w.args), 'a substitution');
    // Round 4 (the reviewer's Material and Minors): under bash a later `&` backgrounds the whole `cd … && rm x`, so
    // what follows runs in the working folder; so does what follows `||`, `;` or a line break.
    for (const c of ['cd dist && rm x & rm -rf config', 'cd dist && rm -rf x&rm -rf config', 'cd dist && rmdir sub & rm -rf *', 'cd dist && cd sub && rm x & rm -rf *',
      'cd dist && rm x || rm -rf config', 'cd dist && rm x ; rm -rf config', 'cd dist && rm x\nrm -rf config']) w.no(c);
  } finally { chmodSync(join(w.work, 'locked'), 0o755); }
});

// #40 check, Minor: bash 3.2 (/bin/bash on a Mac) lets a pattern starting with a dot match `..`. The fix for it left
// with the shortcut (L53 keeps main's rule as it is); the forms main refuses stay refused. The rest is open, with the
// lead (lane2-to-lead.md, item 7).
test('#40 check: the dot-pattern forms main refuses stay refused', () => {
  const w = cdWorld();
  for (const c of ['cd dist && find .? -delete', 'cd dist && rm -rf .*']) w.no(c);
  assert.ok(w.why('find .? -delete', { cwd: join(w.work, 'dist') }), 'find .? from a subfolder');
});

// Lane 2 follow-up (dot-glob, LEAD-CALLS L59): under bash 3.2 a pattern part that starts with `.` can match `..`, and
// `.*` matches `.` too, so `rm -rf .?/*` reached the folder above and `rm -rf .*/conf` this one. Reading such a part
// two ways missed words holding two of them (round 2, M1 and M2), so any such part is refused, for every command the
// folder rule judges.
test('dot-glob: a pattern part starting with . that can match . or .. is refused', (t) => {
  const w = world();
  const P = w.work;
  const S = join(P, 'sub');
  for (const d of ['a/x', 'conf', 'x', '.k/deep', '.cache', '.next']) mkdirSync(join(S, d), { recursive: true });
  mkdirSync(join(P, '.k', 'x'), { recursive: true });
  // Protected files at the given places below P (`.` is P itself), and nowhere else.
  const at = (rels) => {
    const files = rels.map((r) => join(P, r, ENV_PROD));
    for (const f of files) writeFileSync(f, 'X=1\n');
    writeFileSync(w.snapshot, makeSnapshot({ production: { env_files: files, programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(w.home, '.config', 'gh', 'hosts.yml')] } }));
    const pf = files.map(fold);
    const why = (c, cwd = S) => prodGuard.folderWriteWhy(c, { cwd, protectedFiles: pf, home: w.home, user: 'u', tmpdir: w.root, cdpath: '' });
    return {
      why,
      no: (c, cwd = S) => { assert.ok(why(c, cwd), `folder rule, ${rels}: ${JSON.stringify(c)}`); blocked(prodGuard.decide(bash(c, cwd), w.args), `production, ${rels}: ${JSON.stringify(c)}`); },
      ok: (c, cwd = S) => { assert.equal(why(c, cwd), null, `folder rule, ${rels}: ${JSON.stringify(c)}`); passed(prodGuard.decide(bash(c, cwd), w.args), `production, ${rels}: ${JSON.stringify(c)}`); },
    };
  };
  // The shells, on disk: bash 3.2 (the Mac's /bin/bash) matches `..` with each form, and `.*` matches `.` too; zsh
  // never matches `.` or `..`. Skipped where that bash or zsh is not installed (CI runs Linux, whose bash 5.2 skips
  // `.` and `..` too).
  const bash32 = /version 3\.2/.test(spawnSync('/bin/bash', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '');
  const forms = ['.?', '.*', '.[.]', '.[!x]', '.[[:punct:]]', '.?/*', 'a/.?/*', './.?/*'];
  const run = (sh, f, pre = '') => spawnSync(sh, ['-c', `${pre}cd sub && echo ${f}`], { cwd: P, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '';
  if (bash32) {
    for (const f of forms) assert.match(run('/bin/bash', f), /(^|[ /])\.\.(\/|\s|$)/, `bash 3.2 matches .. with ${f}`);
    for (const f of ['.*', '.**']) assert.match(run('/bin/bash', f), /(^| )\.( |$)/, `bash 3.2 matches . with ${f}`);
    assert.equal(run('/bin/bash', '.*/conf').trim(), './conf', 'bash 3.2: .*/conf is ./conf');
  } else t.diagnostic('bash 3.2 not here: the shell check is skipped');
  if (existsSync('/bin/zsh')) {
    for (const f of forms) assert.doesNotMatch(run('/bin/zsh', f, 'setopt nonomatch; '), /(^|[ /])\.\.(\/|\s|$)/, `zsh does not match .. with ${f}`);
    for (const f of ['.*', '.**', '.*/conf']) assert.doesNotMatch(run('/bin/zsh', f, 'setopt nonomatch; '), /(^| )\.(\/| |\n|$)/, `zsh does not match . with ${f}`);
  }
  // The round-2 lines (M1: two dot parts in one word; M2: `.*` as this folder), each with the reviewer's placements.
  for (const rels of [['sub/x'], ['.k/x']]) {
    const k = at(rels);
    for (const c of ['rm -rf .?/.?/x', 'chmod -R 777 .?/.?/x', 'rm -rf .*/.*/x', 'find .?/.?/x -delete']) k.no(c);
  }
  {
    const k = at(['sub/conf']);
    for (const c of ['rm -rf .*/conf', 'chmod -R 777 .*/conf', 'cp -R /tmp/in .*/conf', 'tar -xf a.tar -C .*/conf', 'rsync -a /tmp/in/ .*/conf/', 'rm -rf ./.*/conf', 'chmod -R 777 .**/conf']) k.no(c);
    assert.match(k.why('rm -rf .*/conf') ?? 'none', /a pattern starting with a dot, which can mean this folder or the one above \(name the files\)/);
  }
  at(['sub/a/x']).no('rm -rf a/.*/x');
  // Every spelling the shell reads as such a part (quotes and backslashes taken out, braces opened), refused.
  const k = at(['.']);
  const spellings = ['\\.?', "'.'?", "$'.'?", '{.,.}?', '.{?,x}', '.**', '.[!a]', '.[^a]', '.[\\.]', '.[].]', '..*', '.[.]*', '.[,-.]', '.[--.]', '.[-.]', '.[.-.]'];
  for (const f of spellings) for (const c of [`rm -rf ${f}/*`, `chmod -R 777 ${f}/*`]) k.no(c);
  // Every form x every command the folder rule judges x run from the subfolder, or from the parent after `cd sub &&`.
  const commands = { rm: (f) => `rm -rf ${f}`, rmdir: (f) => `rmdir ${f}`, chmod: (f) => `chmod -R 777 ${f}`, chown: (f) => `chown -R u ${f}`, mv: (f) => `mv ${f} /tmp/out`, cp: (f) => `cp -R /tmp/in ${f}`, find: (f) => `find ${f} -delete`, 'git clean': (f) => `git clean -fdx -- ${f}` };
  let n = 0;
  for (const f of forms) {
    for (const make of Object.values(commands)) {
      k.no(make(f));
      k.no(`cd sub && ${make(f)}`, P);
      n += 1;
    }
  }
  assert.equal(n * 2, 128);
  for (const c of ['rm -rf a/../a/.?/*', 'chmod -R 777 ./a/.*/', 'rm -rf .[.]/sub/conf', 'cp -R /tmp/in .?/.?/*', 'chmod -R 777 .?/deep']) k.no(c);
  // Known cost, asserted so a loosening is made on purpose: the word is refused wherever it runs, protected file near or not.
  assert.match(prodGuard.folderWriteWhy('chmod -R 755 .?/*', { cwd: w.root, protectedFiles: [], home: w.home, user: 'u', tmpdir: w.root, cdpath: '' }) ?? 'none', /pattern starting with a dot/);
  // Round 3 (L60): quoting inside `[...]` changes what bash matches (`.[\^.]` holds `^` and `.`, so it lists `..`), but
  // the guard reads the word with the quoting taken out (`.[^.]`), so a dot part holding `[` is refused however written.
  const quoted = ['.[\\^.]', '.[\\!.]', ".['^'.]", '.[.\\]]', '.[."]"]', '.[\\].]', '.[!\\]]', '.["!".]'];
  if (bash32) for (const f of quoted) assert.match(run('/bin/bash', f), /(^| )\.\.( |$)/m, `bash 3.2 matches .. with ${f}`);
  for (const c of ['chmod -R 777 .[\\^.]', 'find .[\\^.] -delete', 'chmod -R 777 .[\\!.]', 'find .["!".] -delete', "chmod -R 777 .['^'.]", 'find .[."]"] -delete',
    'chown -R u .[.\\]]', 'rm -rf .[\\^.]/*', 'cp -R /tmp/in .[.\\]]/', 'rm -rf .[.\\]]/*', 'rm -rf .[\\].]/*', 'rm -rf .[."]"]/*', "rm -rf .['.']/*",
    'rm -rf .[!\\]]/*', 'rm -rf .[!]]/*', 'rm -rf .[\\.-\\.]/*', 'chmod -R 777 .[.\\]]', 'find .[.\\]] -delete']) { k.no(c); k.no(`cd sub && ${c}`, P); }
  // Joined option values reach the rule too (L60 Minors): rsync's `-T.?`, and install's (and ginstall's) `-t` folder.
  for (const c of ['rsync -a -T.? /tmp/in/ x', 'rsync -aT.? /tmp/in/ x', 'rsync -a --temp-dir .? /tmp/in/ x', 'rsync -a /tmp/in/ x --backup-dir=.?',
    'install -t .? /tmp/in', 'install -t.? /tmp/in', 'install --target-directory=.? /tmp/in', 'install --target-directory .? /tmp/in', 'ginstall -t .? /tmp/in',
    'tar -xf a.tar -C.?', 'tar -xC.? -f a.tar', 'tar -xf a.tar --directory=.?', 'mv -t.? x', 'cp -R -t.? /tmp/in', 'unzip a.zip -d.?']) k.no(c);
  // Controls: no part here can be `.` or `..` (or nothing is written), so they pass, from the subfolder and after a cd.
  // Bash leaves a part that does not start with a written `.` as typed when nothing else matches (`[.]?`).
  const controls = ['rm -rf .next', 'rm -rf .cache/*', 'ls .?', 'rm -rf .x?', 'rm -rf ./.cache/*', 'chmod -R 755 .k', 'rm -rf .cache', 'rm -rf dist/.cache',
    'rm -rf .x*', 'chmod -R 755 .cache', 'find .cache -delete', 'rm -rf a/.x?/*', 'rm -rf a/*', 'chmod -R 755 a/?',
    'install -t dist /tmp/in', 'rsync -a -Tdist /tmp/in/ x',
    ...['[.]?', '[.][.]', '?[.]', '[!a-z]?'].flatMap((f) => [`rm -rf ${f}/*`, `chmod -R 777 ${f}/*`])];
  for (const c of controls) { k.ok(c); k.ok(`cd sub && ${c}`, P); }
});

// L60 known false refusal: `.[!.]`, `.[]]` and `.[\-]` can't match `.` or `..`, but a dot part holding `[` is refused
// whatever it holds, so they are refused too. Asserted so a loosening is made on purpose.
test('dot-glob L60: a dot part holding [ is refused even where it cannot match . or .. (known false refusal)', (t) => {
  const w = world();
  for (const f of ['.[!.]', '.[]]', '.[\\-]']) {
    for (const c of [`rm -rf ${f}/*`, `chmod -R 777 ${f}/*`, `chmod -R 755 ${f}`]) {
      assert.match(prodGuard.folderWriteWhy(c, { cwd: w.work, protectedFiles: [], home: w.home, user: 'u', tmpdir: w.root, cdpath: '' }) ?? 'none', /pattern starting with a dot/, c);
    }
  }
  if (/version 3\.2/.test(spawnSync('/bin/bash', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '')) {
    for (const f of ['.[!.]', '.[]]', '.[\\-]']) {
      const out = spawnSync('/bin/bash', ['-c', `echo ${f}`], { cwd: w.work, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '';
      assert.doesNotMatch(out, /(^| )\.\.?( |$)/m, `bash 3.2 matches neither . nor .. with ${f}`);
    }
  } else t.diagnostic('bash 3.2 not here: the shell check is skipped');
});

// Lane 2 follow-up (unicode-space), from #42's fresh check: JavaScript's \s takes a no-break space, U+2028 and the
// other Unicode spaces for a word gap, and the shells take them for letters. So in `echo x<U+2028>#<<EOF` the guard
// saw a comment where the shells see the word `x<U+2028>#` and a real here-document, and the line after its end ran.
// Every hook refuses a line holding such a character, and the guard's word gaps are the shells' (space, tab, line break).
const runHookScript = (name, w, command) => new Promise((done) => {
  const script = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const p = spawn(process.execPath, [script, '--role', 'builder', '--outbox', w.outbox, '--snapshot', w.snapshot], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
  p.stdout.resume();
  p.stderr.resume();
  p.on('close', (code) => done(code));
  p.stdin.end(JSON.stringify(bash(command, w.work)));
});
test('unicode-space: a space the shells read as a letter is refused by every hook, run as the real scripts', async () => {
  const w = world();
  const W = w.work;
  mkdirSync(join(W, 'config'));
  const second = join(W, 'config', ENV_PROD);
  writeFileSync(second, 'Y=1\n');
  writeFileSync(w.snapshot, makeSnapshot({ production: { env_files: [w.envFile, second], programs: ['fakehost', 'fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(w.home, '.config', 'gh', 'hosts.yml')] } }));
  const pf = [w.envFile, second].map(fold);
  const why = (c) => prodGuard.folderWriteWhy(c, { cwd: W, protectedFiles: pf, home: w.home, user: 'u', tmpdir: w.root, cdpath: '' });
  // Every character JavaScript's \s matches but space, tab and line break: \v, \f, \r and 19 Unicode spaces.
  const odd = [];
  for (let c = 0; c <= 0xffff; c += 1) { const ch = String.fromCharCode(c); if (/\s/.test(ch) && !' \t\n'.includes(ch)) odd.push(ch); }
  assert.equal(odd.length, 22);
  for (const ch of ['\v', '\f', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿']) assert.ok(odd.includes(ch));
  const hex = (ch) => `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  // The shells: each one is a letter, so the here-document is real and the line after its end runs (echo only).
  for (const sh of ['/bin/bash', '/bin/zsh'].filter((x) => existsSync(x))) {
    for (const ch of odd) {
      const r = spawnSync(sh, ['-c', `echo x${ch}#<<EOF\nit's\nEOF\necho HIDDEN`], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(r.stdout, /HIDDEN/, `${sh} runs the line after the here-document, with ${hex(ch)}`);
    }
  }
  // What each hook must refuse, written plainly: refused as plain lines too.
  const hooks = { 'production-write-guard.mjs': 'rm -rf config', 'secret-file-block.mjs': `cat ${dot('en', 'v')}`, 'merge-guard.mjs': 'gh pr merge 1', 'no-verify-block.mjs': 'git commit -n -m x' };
  const at = {
    'before #': (ch, d) => `echo x${ch}#<<EOF\nit's\nEOF\n${d}`,
    'before <<': (ch, d) => `cat${ch}<<EOF\nit's\nEOF\n${d}`,
    'between the program and its first word': (ch, d) => d.replace(' ', ch),
    'at line start': (ch, d) => `${ch}${d}`,
    // Deny by default: inside quotes the character is harmless, but the line is refused whole all the same.
    'inside single quotes': (ch) => `echo 'a${ch}b'`,
    'inside a commit message': (ch) => `git commit -m "a${ch}b"`,
  };
  const jobs = [];
  for (const ch of odd) {
    for (const [where, form] of Object.entries(at)) {
      const pc = form(ch, hooks['production-write-guard.mjs']);
      assert.ok(why(pc), `folder rule: ${where}, ${hex(ch)}`);
      if (ch !== '\r' && ch !== '\v' && ch !== '\f') assert.match(heredocs(pc).why ?? 'none', /a space other than a plain space or tab/, `${where}, ${hex(ch)}`);
      for (const [name, d] of Object.entries(hooks)) jobs.push({ name, c: form(ch, d), what: `${name}: ${where}, ${hex(ch)}` });
    }
  }
  assert.equal(jobs.length, 22 * 6 * 4);
  // A carriage return right before a line break stays let through (Windows line ends; L46 round 4).
  const controls = ["echo 'a b'", 'git commit -m "a b"', 'echo a\tb', 'git status\r\nls\r\n'];
  for (const c of controls) for (const name of Object.keys(hooks)) jobs.push({ name, c, what: `control, ${name}: ${JSON.stringify(c)}`, ok: true });
  for (const [name, d] of Object.entries(hooks)) jobs.push({ name, c: d, what: `plain, ${name}: ${d}` });
  const failed = [];
  for (let k = 0; k < jobs.length; k += 8) {
    const batch = jobs.slice(k, k + 8);
    const codes = await Promise.all(batch.map((j) => runHookScript(j.name, w, j.c)));
    batch.forEach((j, i) => { if (codes[i] !== (j.ok ? 0 : 2)) failed.push(`${j.what} (exit ${codes[i]})`); });
  }
  assert.deepEqual(failed, []);
  // Belt and braces: a comment holding << is refused, so no gap read wrong can make a here-document a comment.
  assert.match(heredocs('ls # see <<EOF').why ?? 'none', /a comment holding <</);
  for (const c of ['ls # see <<EOF\nnpm test', 'ls #<<EOF\nit\nEOF\nnpm test', '# <<X']) {
    blocked(prodGuard.decide(bash(c, W), w.args), `production: ${JSON.stringify(c)}`);
    blocked(secret.decide(bash(c, W), w.args), `secret: ${JSON.stringify(c)}`);
    blocked(merge.decide(bash(c, W)), `merge: ${JSON.stringify(c)}`);
    blocked(noVerify.decide(bash(c, W)), `no-verify: ${JSON.stringify(c)}`);
  }
  // Not comments: << inside quotes or inside a word.
  for (const c of ["echo '# <<x'", 'echo "a # <<b"', "x=a#<<EOF\nhi\nEOF"]) {
    assert.equal(heredocs(c).why, null, JSON.stringify(c));
    passed(prodGuard.decide(bash(c, W), w.args), JSON.stringify(c));
  }
});
