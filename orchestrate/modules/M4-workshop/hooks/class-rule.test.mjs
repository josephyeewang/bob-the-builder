// The class rule for the shell guards (audit R-0b-44 round 2 MAT-1, MAT-2, MIN-3; R-0b-70): every
// shape the round-2 probe got through, letter case on a Mac disk, and the lane-3 corpus's
// remaining forms. Throwaway folders only; names of secret files are built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSnapshot } from './snapshot.mjs';
import { expansionIn, expandBraces, unreadable, shellCommands, shellWords, globRe } from './lib.mjs';
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
  // The shield: a delete of every name in the working folder, however the pattern is spelled.
  for (const c of ['rm -rf [a-z]*', 'rm -rf .[!.]*', 'rsync -a --remove-source . /tmp/x/']) assert.match(prodGuard.decide(bash(c, w.outbox), w.args).reason ?? 'passed', /working folder/, c);
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
