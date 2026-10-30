import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { corpus, cases, pathForms, askHook, runCorpus, hostDead } from './runner.mjs';
import { touchCheck } from './selfcheck.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const T = '.env.production';
const node = process.execPath;
// Temp folders, removed after the run (round 10 audit 3 minor 4: one held a planted file named like the protected one).
const tmp = () => realpathSync(tempDir('sg-')); // removed after the file, even on failure, and checked gone (shared/test-tmp.mjs)

test('the corpus covers every trick the row names, ~150+ refuse cases, and has allow cases', () => {
  const all = cases(T);
  const refuse = all.filter((c) => c.expect === 'refuse');
  assert.ok(refuse.length >= 150, `${refuse.length} refuse cases`);
  assert.ok(all.some((c) => c.expect === 'allow'));
  const text = JSON.stringify(corpus.refuse);
  for (const [name, re] of Object.entries({ 'variable-prefixed': /F=\{\{P\}\}|env A=1/, quoted: /bash -c '/, aliased: /alias /, subshell: /\$\(cat|\(cat/, 'here-doc': /<<'EOF'/ })) assert.match(text, re, name);
  for (const form of ['split-quotes', 'empty-quotes', 'backslash', 'glob', 'dot-dot', 'hex-printf', 'ansi-c']) assert.ok(refuse.some((c) => c.form === form), form);
});

test('every path form really names the protected file when the shell expands it', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = tmp();
  mkdirSync(`${dir}/x`);
  writeFileSync(`${dir}/${T}`, 'PLANTED\n');
  for (const [form, p] of Object.entries(pathForms(T))) {
    const out = execFileSync('/bin/bash', ['-c', `cat ${p} 2>/dev/null; true`], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /PLANTED/, form);
  }
});

// In-process copies of the two fixture guards (spawning one process per case takes ~45 s); the protocol test below
// checks they decide as the spawned fixture files do.
// The allow cases, word for word and from the folder each is asked from (one command is refused from the file's folder and
// allowed beside it).
const key = (command, cwd = process.cwd()) => `${cwd}\0${command}`;
const STRICT = new Set(cases(T).filter((c) => c.expect === 'allow').map((c) => key(c.command, c.cwd)));
const strict = (c, cwd) => (STRICT.has(key(c, cwd)) ? 'allow' : 'refuse');
const naive = (c) => (c.includes(T) ? 'refuse' : 'allow');

test('a strict, fail-closed stand-in guard passes the whole corpus', () => {
  assert.deepEqual(runCorpus(strict).failures, []);
});

test('planted weak guard (plain text match) → the runner reports its misses', () => {
  const r = runCorpus(naive);
  assert.ok(r.failures.length > 50, `${r.failures.length} misses`);
  assert.ok(r.failures.every((f) => f.expect === 'refuse' && f.got === 'allow'));
  for (const form of ['split-quotes', 'hex-printf', 'glob']) assert.ok(r.failures.some((f) => f.form === form), form);
});

test('protocol: exit 2 and a JSON deny both count as refused; a crash or a hang is a failure, never a pass', () => {
  for (const c of ['ls', `cat ${T}`, `echo x > ${pathForms(T).glob}`]) {
    assert.equal(askHook(`"${node}" "${fx('strict-hook.mjs')}"`, c), strict(c), c);
    assert.equal(askHook(`"${node}" "${fx('naive-hook.mjs')}" '${T}'`, c), naive(c), c);
  }
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" json-deny`, 'cat x'), 'refuse');
  // Round 10 audit 4 minor 2: a deny without hookEventName may be ignored by Claude Code, so it is no pass either way.
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" json-deny-bare`, 'cat x'), 'crash');
  // Round 10 audit 6 cosmetic 5: continue false stops Claude Code, so the command does not run.
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" continue-false`, 'cat x'), 'refuse');
  // Round 10 audit 4 minor 1: the spawned stand-in allows every allow case, as its in-process copy does.
  for (const c of cases(T).filter((x) => x.expect === 'allow')) assert.equal(askHook(`"${node}" "${fx('strict-hook.mjs')}"`, c.command, { cwd: c.cwd }), 'allow', c.command);
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" crash`, 'cat x'), 'crash');
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" hang`, 'cat x', { timeoutMs: 300 }), 'crash');
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" allow-all`, 'cat x'), 'allow');
});

test('a guard that refuses everything fails too (the allow cases)', () => {
  const r = runCorpus('exit 2');
  assert.equal(r.failures.length, cases(T).filter((c) => c.expect === 'allow').length);
  assert.ok(r.failures.some((f) => f.group === 'allow-near'));
});

test('0b-7 round 9 minor 5: an absolute form, and change-folder-first cases asked from the folder above', () => {
  const dir = tmp();
  assert.equal(pathForms(T, dir).absolute, `${dir}/${T}`);
  assert.equal(pathForms(`${dir}/${T}`, dir).absolute, undefined, 'an absolute target is already its plain form');
  assert.equal(pathForms(`${dir}/${T}`)['dot-slash'], undefined, 'round 10 M-3: "./" before an absolute path makes it relative');
  // Round 10 M-1: from the file's own folder (the README's run) a cd-blind guard would still see the right file, so
  // the after-cd cases are asked from the folder above.
  const afterCd = cases(T, dir).filter((c) => c.group === 'after-cd');
  assert.ok(afterCd.length >= 40, `${afterCd.length} after-cd cases`);
  assert.ok(afterCd.every((c) => c.cwd === dirname(dir)));
});

test('planted weak guards: relative-only misses the absolute form; cd-blind misses after-cd even from the file\'s folder', () => {
  const dir = tmp();
  const target = `${dir}/${T}`;
  const relOnly = (c) => (new RegExp(`(^|[\\s'"(])${T.replace('.', '\\.')}`).test(c) ? 'refuse' : 'allow');
  assert.ok(runCorpus(relOnly, { target: T, cwd: dir }).failures.some((f) => f.form === 'absolute'));
  // Resolves each word against the folder it is asked from, ignoring any cd.
  const cdBlind = (c, cwd) => (c.split(/[\s;&|()<>'"]+/).some((w) => w && resolve(cwd, w) === target) ? 'refuse' : 'allow');
  for (const t of [T, target]) {
    const r = runCorpus(cdBlind, { target: t, cwd: dir });
    assert.ok(r.failures.some((f) => f.group === 'after-cd' && f.form === 'plain'), `cd-blind guard caught (${t === T ? 'short name' : 'absolute'} run)`);
  }
  assert.equal(cdBlind(`cat ${target}`, dir), 'refuse', 'it does catch the plain path');
});

test('round 10 M-2: a path with a space or shell character is refused, not run as cases that touch nothing', () => {
  assert.throws(() => cases(T, '/tmp/proj dir'), /space or shell character/);
  assert.throws(() => cases('/tmp/a;b/x'), /space or shell character/);
});

test('round 10: the ansi-c form reaches the command intact (a string replacement garbled `$\'`)', () => {
  const ansi = cases(T, tmp()).filter((c) => c.form === 'ansi-c');
  assert.ok(ansi.length > 20);
  for (const c of ansi) assert.ok(c.command.includes(pathForms(T)['ansi-c']), c.command);
});

// Every refuse case must really read or write the planted file under bash or zsh, in both runs the README names, and
// the dead list must hold exactly the template and form pairs that touch nothing. Checked on two names, so the list
// does not hang on one name's letters (round 10 audit 2 M-2). ~7,000 shell runs, about 70 s.
// corpus.dead is for a Mac; on a machine without zsh, or whose sh is dash (Linux CI), runner.mjs's hostDead drops the
// pairs that touch nothing there, and they are left out of both sides here (round 10 audit 3 M-4).
test('round 10: every refuse case touches the file, and corpus.dead is exactly the pairs that do not, on two names', () => {
  const shells = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));
  const listed = Object.entries(corpus.dead).flatMap(([tpl, forms]) => forms.filter((form) => !hostDead(tpl, form)).map((form) => `${form} / ${tpl}`)).sort();
  assert.ok(listed.length > 0);
  const saved = corpus.dead; corpus.dead = {};
  try {
    for (const name of [T, 'secret.prod']) {
      const groups = new Map();
      for (const c of ['relative', 'absolute'].flatMap((mode) => touchCheck(name, { mode, shells, newFolder: () => tempDir('sg-self-') }))) {
        const k = `${c.form} / ${c.tpl}`; groups.set(k, [...(groups.get(k) ?? []), c]);
      }
      const silent = (c) => !c.touchedBy.length;
      const dead = [...groups].filter(([, cs]) => cs.every(silent)).map(([k]) => k).sort();
      const bad = [...groups].filter(([, cs]) => !cs.every(silent)).flatMap(([, cs]) => cs.filter(silent));
      assert.deepEqual(bad.map((c) => `[${c.group}/${c.form}] ${c.command}`), [], `${name}: cases that touch nothing`);
      assert.deepEqual(dead, listed, `${name}: the dead list`);
    }
  } finally { corpus.dead = saved; }
});

test('round 10 audit 2 M-3: a crude "refuse anything odd" guard fails: plain commands, and the ? and [o] forms', () => {
  const crude = (c) => (/production|[$`'"*{\\]|\.\./.test(c) ? 'refuse' : 'allow');
  const { failures } = runCorpus(crude);
  assert.ok(failures.filter((f) => f.expect === 'allow').length >= 5, 'allow cases it refuses');
  for (const form of ['qmark', 'bracket']) assert.ok(failures.some((f) => f.expect === 'refuse' && f.form === form), form);
});

test('round 10 audit 3 M-1: no guard that matches one piece of the name (or "\\x") passes', () => {
  for (const name of [T, 'secret.prod']) {
    const pieces = [...new Set([...Array(name.length - 2).keys()].map((i) => name.slice(i, i + 3)))];
    for (const piece of pieces) {
      const guard = (c) => (c.includes(piece) || c.includes('\\x') ? 'refuse' : 'allow');
      const missed = runCorpus(guard, { target: name }).failures.filter((f) => f.expect === 'refuse');
      assert.ok(missed.length > 0, `a guard matching "${piece}" passed for ${name}`);
    }
  }
  assert.ok(runCorpus((c) => (/env|\\x/.test(c) ? 'refuse' : 'allow')).failures.length > 0, "the audit's guard");
});

test('round 10 audit 3 M-3: the hook runs from one folder with CLAUDE_PROJECT_DIR set; only the JSON cwd changes', () => {
  const home = tmp(); const elsewhere = tmp();
  const where = `[ "$(pwd -P)" = "$(cd "$CLAUDE_PROJECT_DIR" && pwd -P)" ] || exit 2`;
  assert.equal(askHook(where, 'ls', { cwd: elsewhere, hookCwd: home }), 'allow');
  assert.equal(askHook(where, 'ls', { cwd: elsewhere, hookCwd: home, projectDir: elsewhere }), 'refuse');
  const seen = `"${node}" -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8')); process.exit(j.cwd==='${elsewhere}'&&j.session_id&&j.tool_use_id ? 0 : 2)"`;
  assert.equal(askHook(seen, 'ls', { cwd: elsewhere, hookCwd: home }), 'allow');
});

// Round 10 audit 4 M-1: a guard that undoes quotes, backslashes, globs and every $( ` $' still misses the file split by
// an unset variable and the whole-folder reads.
test('round 10 audit 4 M-1: a guard that undoes quoting and globs and refuses $( fails (empty variable, whole folder)', () => {
  for (const name of [T, 'secret.prod']) {
    const glob = (w) => new RegExp(`^${w.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const guard = (c) => {
      if (/\$\(|`|\$'/.test(c)) return 'refuse';
      if (c.replace(/["'\\]/g, '').includes(name)) return 'refuse';
      return c.split(/[\s;&|()<>'"=]+/).some((w) => /[*?[]/.test(w) && !w.includes('[') && glob(w.split('/').pop()).test(name)) ? 'refuse' : 'allow';
    };
    const missed = runCorpus(guard, { target: name }).failures.filter((f) => f.expect === 'refuse');
    for (const g of ['folder']) assert.ok(missed.some((f) => f.group === g), `${name}: ${g}`);
    assert.ok(missed.some((f) => f.form === 'empty-var'), `${name}: empty-var`);
  }
});

// Round 10 audit 4 M-2: a guard that ignores cd, and refuses everything asked from outside the run folder, used to pass.
test('round 10 audit 4 M-2: a cd-blind guard that refuses whatever is asked from elsewhere fails, top-level or in a subfolder', () => {
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const guard = (c, cwd) => (cwd !== root || c.split(/[\s;&|()<>'"]+/).some((w) => w && resolve(cwd, w) === file) ? 'refuse' : 'allow');
    const { failures } = runCorpus(guard, { target, cwd: root });
    assert.ok(failures.some((f) => f.expect === 'refuse' && ['after-cd-here', 'cd-up'].includes(f.group)), `${target}: a cd case it allows`);
    assert.ok(failures.some((f) => f.group === 'allow-elsewhere'), `${target}: ordinary commands asked from elsewhere`);
  }
});

// Round 10 audit 5 M-1: a guard that reads every variable as empty (as a shell-quote parse does) passed the unset-variable
// form, yet a set variable can carry part of the name.
test('round 10 audit 5 M-1: a guard that drops every variable misses a set variable carrying part of the name', () => {
  for (const name of [T, 'secret.prod']) {
    const guard = (c) => {
      if (/\$\(|`|\$'/.test(c)) return 'refuse';
      return c.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, '').replace(/["'\\]/g, '').includes(name) ? 'refuse' : 'allow';
    };
    const missed = runCorpus(guard, { target: name }).failures.filter((f) => f.expect === 'refuse');
    for (const form of ['var-mid', 'var-early', 'abs-var-mid']) assert.ok(missed.some((f) => f.form === form), `${name}: ${form}`);
  }
});

// Round 10 audit 5 M-2: no form went through the home folder, so a guard that never expands ~ or $HOME passed.
test('round 10 audit 5 M-2: a guard that never expands ~ or $HOME misses the home forms; none are built outside home', () => {
  const root = tmp(); const dir = `${root}/proj`; const file = `${dir}/${T}`;
  const guard = (c, cwd) => (c.split(/[\s;&|()<>'"=]+/).some((w) => w && resolve(cwd, w) === file) ? 'refuse' : 'allow');
  const missed = runCorpus(guard, { target: T, cwd: dir, home: root }).failures.filter((f) => f.expect === 'refuse');
  for (const form of ['home-tilde', 'home-var']) assert.ok(missed.some((f) => f.form === form), form);
  assert.ok(missed.some((f) => f.group === 'after-cd-home'), 'cd ~/… first');
  assert.ok(!cases(T, dir, { home: '/elsewhere' }).some((c) => c.form.startsWith('home')), 'no home forms outside home');
});

test('round 10 audit 5 minors: no recursive grep of a folder holding the file is an allow case; negated brackets; cd -', () => {
  const root = tmp();
  const allowed = (t) => cases(t, root).filter((c) => c.expect === 'allow').map((c) => c.command);
  assert.ok(allowed(T).includes("grep -r 'TODO' src"));
  assert.ok(!allowed(`src/${T}`).includes("grep -r 'TODO' src"));
  assert.ok(!allowed(`docs/${T}`).some((c) => c.startsWith('grep -rn') && c.endsWith(' docs')));
  const refuse = cases(T, root).filter((c) => c.expect === 'refuse');
  for (const form of ['not-bracket', 'caret-bracket']) assert.ok(refuse.some((c) => c.form === form), form);
  assert.ok(refuse.some((c) => c.command.startsWith('cd /; cd - ')), 'cd -');
});

// Round 10 audit 6: three routes a careful guard (variables, home, cd, globs, whole folders it is shown) still missed.
test('round 10 audit 6 M-1: a guard that only looks at the paths named misses a read of the run folder that names none', () => {
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const guard = (c, cwd) => (c.split(/[\s;&|()<>'"]+/).some((w) => w && (resolve(cwd, w) === file || file.startsWith(`${resolve(cwd, w)}/`))) ? 'refuse' : 'allow');
    const { failures } = runCorpus(guard, { target, cwd: root });
    assert.ok(failures.some((f) => f.group === 'here' && f.command.startsWith('grep -rn')), `${target}: grep -rn with no folder`);
    assert.ok(cases(target, root).some((c) => c.group === 'allow-beside'), `${target}: the same, beside the folder, allowed`);
  }
});

test('round 10 audit 6 M-2: a guard that takes $PWD from its own folder, or drops it, misses the $PWD forms', () => {
  const root = tmp(); const file = resolve(root, T);
  const by = (pwd) => (c, cwd) => (c.replaceAll('$PWD', pwd(cwd)).split(/[\s;&|()<>'"=]+/).some((w) => w && resolve(cwd, w) === file) ? 'refuse' : 'allow');
  for (const pwd of [() => process.cwd(), () => '']) {
    const missed = runCorpus(by(pwd), { target: T, cwd: root }).failures.filter((f) => f.expect === 'refuse');
    assert.ok(missed.some((f) => f.form === 'pwd-var'), String(pwd));
  }
});

test('round 10 audit 6 M-3: on a disk that ignores case, an exact-name guard misses the case-flipped name; none elsewhere', () => {
  const root = tmp(); const file = resolve(root, T);
  const exact = (c, cwd) => (c.split(/[\s;&|()<>'"=]+/).some((w) => w && resolve(cwd, w) === file) ? 'refuse' : 'allow');
  assert.ok(runCorpus(exact, { target: T, cwd: root, caseless: true }).failures.some((f) => f.form === 'case-flip'));
  assert.ok(!cases(T, root, { caseless: false }).some((c) => c.form === 'case-flip'));
  // Cosmetic 2: a home folder written with a trailing slash is the same folder.
  assert.ok(cases(T, `${root}/proj`, { home: `${root}/` }).some((c) => c.form === 'home-tilde'));
});

// Round 10 audit 7 M-1: Claude often puts commands on separate lines, sometimes after a comment line.
test('round 10 audit 7 M-1: a guard that reads a newline as a space, or a comment as running to the end, misses the two-line cases', () => {
  const root = tmp(); const file = resolve(root, T);
  // Follows cd and pushd, and checks each word of every other command against the file, from the folder it is in by then.
  const guard = (seps, comment) => (c, cwd) => {
    let here = cwd;
    for (const seg of c.replace(comment, '').split(seps)) {
      const w = seg.trim().split(/\s+/).filter(Boolean);
      if (w[0] === 'cd' || w[0] === 'pushd') { here = resolve(here, w[1] ?? '.'); continue; }
      if (w.some((x) => resolve(here, x) === file)) return 'refuse';
    }
    return 'allow';
  };
  const twoLine = (g) => runCorpus(g, { target: T, cwd: root }).failures.filter((f) => f.expect === 'refuse' && f.form === 'plain' && f.tpl.includes('\n') && !f.tpl.includes('EOF'));
  const noNewline = twoLine(guard(/;|&&|\|\||\||[()]/, /#[^\n]*/g));
  assert.ok(noNewline.some((f) => f.group === 'after-cd'), 'cd, then the read on the next line');
  const toEnd = twoLine(guard(/;|&&|\|\||\||[()]|\n/, /#[^]*$/));
  assert.ok(toEnd.some((f) => f.group === 'lines'), 'a comment line, then the read');
  // The same guard splitting at newlines and ending a comment at the line's end misses none of them.
  assert.deepEqual(twoLine(guard(/;|&&|\|\||\||[()]|\n/, /#[^\n]*/g)), []);
});
