import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { corpus, cases, pathForms, askHook, runCorpus, hostDead, hostLive, caselessAt, folderRead } from './runner.mjs';
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
    if (form === 'globstar') continue; // zsh only; the self-check runs it under zsh
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
// does not hang on one name's letters (round 10 audit 2 M-2). Several thousand shell runs, a few at once; past
// selfcheck.mjs's time budget the check fails, "guard not verified", never passes.
// corpus.dead is for a Mac; on a machine without zsh, or whose sh is dash (Linux CI), runner.mjs's hostDead drops the
// pairs that touch nothing there, and they are left out of both sides here (round 10 audit 3 M-4).
test('round 10: every refuse case touches the file, and corpus.dead is exactly the pairs that do not, on two names', async () => {
  const shells = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));
  const listed = Object.entries(corpus.dead).flatMap(([tpl, forms]) => forms.filter((form) => !hostDead(tpl, form) && !hostLive(tpl, form)).map((form) => `${form} / ${tpl}`)).sort();
  assert.ok(listed.length > 0);
  const saved = corpus.dead; corpus.dead = {};
  try {
    for (const name of [T, 'secret.prod']) {
      const groups = new Map();
      const checked = [];
      for (const mode of ['relative', 'absolute']) checked.push(...await touchCheck(name, { mode, shells, newFolder: () => tempDir('sg-self-') }));
      for (const c of checked) {
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
  const root = tmp(); tmp(); // a folder beside root, for the allow-beside cases
  mkdirSync(`${root}/apps/web`, { recursive: true }); mkdirSync(`${root}/apps/api`);
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

// Round 10 audit 8.
test('round 10 audit 8 M-1: the case-flip form follows the caseless option on any machine; the file\'s own disk by default', () => {
  const root = tmp();
  assert.ok(!hostDead('cat {{P}}', 'case-flip'), 'never dropped for the machine running the runner');
  assert.equal(hostDead('cat {{P}}', 'globstar'), !existsSync('/bin/zsh'), 'round 10 audit 9: `**/` only where zsh is');
  assert.equal(hostDead('echo x > {{P}}', 'inner-brace'), hostDead('echo x > {{P}}', 'brace'), 'round 10 audit 11: a brace inside the name, as one around it');
  for (const f of ['last-brace', 'inner-last-brace']) assert.equal(hostDead('echo x > {{P}}', f), hostDead('echo x > {{P}}', 'brace'), `round 12: ${f}`);
  for (const f of ['home-brace', 'pwd-brace']) assert.ok(!hostDead('echo x > {{P}}', f), `round 12 minor 4: bash expands ${f} after ">"`);
  assert.ok(cases(T, root, { caseless: true }).some((c) => c.form === 'case-flip'));
  // Minor 2: by default, the disk the file's folder is on.
  const flipped = `${dirname(root)}/${[...root.split('/').pop()].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')}`;
  assert.equal(caselessAt(root), existsSync(flipped));
  assert.equal(cases(T, root).some((c) => c.form === 'case-flip'), existsSync(flipped));
});

test('round 10 audit 8 M-2: a guard whose list of folder readers is grep, find, rm, ls and cat misses an archive or copy of the folder', () => {
  const root = tmp(); const file = resolve(root, 'apps/web', T);
  const holds = (d) => file.startsWith(`${d}/`);
  const guard = (readers) => (c, cwd) => {
    let here = cwd;
    for (const seg of c.split(/;|&&|\|\||\||\n/)) {
      const w = seg.trim().split(/\s+/).filter(Boolean);
      if (w[0] === 'cd') { here = resolve(here, w[1] ?? '.'); continue; }
      if (w.some((x) => resolve(here, x) === file)) return 'refuse';
      if (readers.includes(w[0]) && (w.slice(1).some((x) => !x.startsWith('-') && holds(resolve(here, x))) || holds(here))) return 'refuse';
    }
    return 'allow';
  };
  const copies = (readers) => runCorpus(guard(readers), { target: `apps/web/${T}`, cwd: root }).failures.filter((f) => f.expect === 'refuse' && /^(cd \.\. && )?(tar|cp)\b/.test(f.tpl ?? ''));
  const missed = copies(['grep', 'find', 'rm', 'ls', 'xargs', 'cat']);
  for (const g of ['folder', 'here', 'cd-up']) assert.ok(missed.some((f) => f.group === g), g);
  assert.deepEqual(copies(['grep', 'find', 'rm', 'ls', 'xargs', 'cat', 'tar', 'cp']), []);
  // Minor 1: a recursive grep spelled -R; minor 3: cd by the folder's own name, from the folder above.
  assert.ok(corpus.refuse_here.some((t) => t.startsWith('grep -R')));
  assert.ok(cases(`apps/web/${T}`, root).some((c) => c.group === 'after-cd' && c.command.startsWith('cd web && ') && c.cwd === resolve(root, 'apps')));
});

test('no case is built twice (a template that names no spelling of the file is one case, not one per form)', () => {
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const keys = cases(target, root).map((c) => `${c.expect}|${c.cwd ?? ''}|${c.command}`);
    assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], target);
  }
});

// Round 10 audit 9: what a careful guard (quotes, variables, globs in the name, a list of folder readers) still passed.
test('round 10 audit 9 M-1: a guard matching globs against the name only misses a glob in the folder part, and zsh **/', () => {
  const root = tmp();
  const re = (g) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.')}$`);
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const nameOnly = (c, cwd) => (c.split(/[\s;&|()<>'"]+/).some((w) => w && dirname(resolve(cwd, w)) === dirname(file) && re(basename(resolve(cwd, w))).test(basename(file))) ? 'refuse' : 'allow');
    const missed = runCorpus(nameOnly, { target, cwd: root }).failures.filter((f) => f.expect === 'refuse');
    assert.ok(missed.some((f) => f.form === 'dir-glob'), `${target}: a glob in the folder part`);
    if (existsSync('/bin/zsh')) assert.ok(missed.some((f) => f.form === 'globstar'), `${target}: **/`);
    assert.equal(nameOnly(`cat ${pathForms(target, root).glob}`, root), 'refuse', 'it does catch a glob in the name');
  }
  assert.equal(pathForms(`apps/web/${T}`, root)['dir-glob'], `apps/*/${T}`);
});

test('round 10 audit 9 M-2: a guard missing < as a word break, or reading quoted script text as one word, misses those reads', () => {
  const root = tmp(); const file = resolve(root, T);
  const by = (sep) => (c, cwd) => (c.split(sep).some((w) => w && resolve(cwd, w) === file) ? 'refuse' : 'allow');
  const missed = (sep) => runCorpus(by(sep), { target: T, cwd: root }).failures.filter((f) => f.expect === 'refuse' && f.form === 'plain').map((f) => f.tpl);
  assert.ok(missed(/[\s;&|()'"]+/).includes('cat <{{P}}'), 'glued to <');
  assert.ok(missed(/[\s;&|()<>"]+/).some((t) => t.includes('{path:')), "set in an object, {path:'…'}");
  assert.ok(!missed(/[\s;&|()<>'"]+/).some((t) => t === 'cat <{{P}}' || t.includes('{path:')), 'a guard breaking words at both catches them');
});

test('round 10 audit 9 M-3: a guard taking only -r or -R as a recursive grep misses grep -nr and --recursive', () => {
  for (const t of ['grep -nr e', 'grep -inr e', 'grep --recursive -n e', 'rsync -a ./ /tmp/y']) assert.ok(corpus.refuse_here.includes(t), t);
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const guard = (c, cwd) => {
      const w = c.split(/\s+/);
      if (w[0] === 'grep' && /^-[rR]/.test(w[1]) && file.startsWith(`${resolve(cwd, w[3] ?? '.')}/`)) return 'refuse';
      return c.split(/[\s;&|()<>'"]+/).some((x) => x && resolve(cwd, x) === file) ? 'refuse' : 'allow';
    };
    const missed = runCorpus(guard, { target, cwd: root }).failures.filter((f) => f.expect === 'refuse' && f.tpl?.startsWith('grep'));
    for (const g of ['here', 'folder']) assert.ok(missed.some((f) => f.group === g && /grep (-nr|-inr|--recursive)/.test(f.command)), `${target}: ${g}`);
    assert.ok(!missed.some((f) => /grep -[rR]/.test(f.command)), `${target}: it does catch -r and -R`);
  }
  // Minor 3: a file beside it whose name differs in its last word is an allow case.
  assert.ok(cases(T, root).some((c) => c.group === 'allow-near' && c.command === `cat ${root}/.env.example`));
});

test('round 10 audit 9 M-4: allow-beside cases are asked from a folder that exists and does not hold the file', () => {
  const root = tmp(); tmp(); // a folder beside root
  mkdirSync(`${root}/apps/web`, { recursive: true }); mkdirSync(`${root}/apps/api`);
  for (const target of [T, `apps/web/${T}`]) {
    const beside = cases(target, root).filter((c) => c.group === 'allow-beside');
    assert.ok(beside.length > 0, target);
    for (const c of beside) assert.ok(existsSync(c.cwd) && !resolve(root, target).startsWith(`${c.cwd}/`), `${target}: ${c.cwd}`);
  }
  assert.ok(!cases(T, root, { beside: null }).some((c) => c.group === 'allow-beside'), 'none when there is no such folder');
  // Round 10 audit 10: the folder found is the one beside the file's, never a hidden one.
  mkdirSync(`${root}/apps/.cache`);
  assert.ok(cases(`apps/web/${T}`, root).filter((c) => c.group === 'allow-beside').every((c) => c.cwd === `${root}/apps/api`));
});

test('round 10 audit 9 M-5: run through a link to its folder, the runner still runs the corpus and fails a bad hook', async () => {
  const { symlinkSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const root = tmp();
  symlinkSync(dirname(fileURLToPath(import.meta.url)), `${root}/link`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(node, [`${root}/link/runner.mjs`, 'exit 2'], { cwd: root, encoding: 'utf8', env });
  assert.match(r.stdout, /cases as expected/);
  assert.equal(r.status, 1);
});

test('round 10 audit 10: a guard that skips here-doc bodies, or takes only lowercase cp flags, misses those reads', () => {
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const holds = (d) => file.startsWith(`${d}/`);
    const guard = ({ heredoc, cp }) => (c, cwd) => {
      const text = heredoc ? c : c.replace(/<<'EOF'\n[\s\S]*?\nEOF/g, "<<'EOF'");
      let here = cwd;
      for (const seg of text.split(/;|&&|\|\||\||\n/)) {
        const w = seg.trim().split(/[\s()<>'"]+/).filter(Boolean);
        if (w[0] === 'cd') { here = resolve(here, w[1] ?? '.'); continue; }
        if (w.some((x) => resolve(here, x) === file)) return 'refuse';
        if (w[0] === 'cp' && cp.test(w[1] ?? '') && w.slice(2).some((x) => holds(resolve(here, x)))) return 'refuse';
      }
      return 'allow';
    };
    const missed = (opts, forms = () => true) => runCorpus(guard(opts), { target, cwd: root }).failures.filter((f) => f.expect === 'refuse' && forms(f.form)).map((f) => f.command);
    const skipsBody = missed({ heredoc: false, cp: /^-\w*[rRa]/ });
    assert.ok(skipsBody.some((m) => m.startsWith('python3 - <<')) && skipsBody.some((m) => m.startsWith('bash <<')), `${target}: here-doc body`);
    const lower = missed({ heredoc: true, cp: /^-\w*r/ });
    assert.ok(lower.some((m) => /cp -R /.test(m)) && lower.some((m) => /cp -a /.test(m)), `${target}: cp -R and -a`);
    // (It reads no spelling but the plain one, so only the plain form, and the copies, which name no spelling.)
    const both = missed({ heredoc: true, cp: /^-\w*[rRa]/ }, (form) => form === 'plain' || form === '-');
    assert.ok(!both.some((m) => /<<'EOF'\n|^cp -[Ra] /.test(m)), `${target}: caught by a guard that does both`);
  }
});

test('round 10 audit 11: a guard reading brace pieces as names misses a brace inside the name; one judging by the asked folder misses cd then read', () => {
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const pieces = (c, cwd) => (c.split(/[\s;&|()<>'"{},]+/).some((w) => w && (resolve(cwd, w) === file || w === basename(file))) ? 'refuse' : 'allow');
    const missed = runCorpus(pieces, { target, cwd: root }).failures.filter((f) => f.expect === 'refuse');
    assert.ok(missed.some((f) => f.form === 'inner-brace') && !missed.some((f) => f.form === 'brace'), `${target}: inner brace`);
    // Refuses a no-folder read only when the folder it is asked from holds the file.
    const asked = (c, cwd) => ((/grep -r|^tar |\btar cf .* \.$|cp -r \./m.test(c) && file.startsWith(`${cwd}/`)) || c.includes(file) ? 'refuse' : 'allow');
    const missedCd = runCorpus(asked, { target, cwd: root }).failures.filter((f) => f.expect === 'refuse' && f.group === 'cd-here');
    assert.equal(missedCd.length, corpus.refuse_cd_here.length, `${target}: every cd-then-read case`);
  }
});

test('round 12: guards keeping a brace\'s first choice, judging only the file\'s own folder, reading grep\'s first option, or find only with -exec, miss cases', () => {
  const root = tmp();
  for (const target of [T, `apps/web/${T}`]) {
    const file = resolve(root, target);
    const words = (c) => c.split(/[\s;&|()<>'"]+/).filter(Boolean);
    const named = (c, cwd, pick) => words(c).some((w) => { const v = w.replace(/\{([^{}]*)\}/g, (_, l) => pick(l)); return resolve(cwd, v) === file || basename(v) === basename(file); });
    // A brace expanded to its first choice only, or with the braces dropped and the words split on commas.
    for (const [name, guard] of [
      ['first', (c, cwd) => (named(c, cwd, (l) => l.split(',')[0]) ? 'refuse' : 'allow')],
      ['strip', (c, cwd) => (words(c).flatMap((w) => w.replace(/[{}]/g, '').split(',')).some((v) => resolve(cwd, v) === file || basename(v) === basename(file)) ? 'refuse' : 'allow')],
    ]) {
      const missed = runCorpus(guard, { target, cwd: root }).failures.filter((f) => f.expect === 'refuse');
      assert.ok(missed.some((f) => f.form === 'last-brace') || missed.some((f) => f.form === 'inner-last-brace'), `${target}: ${name}`);
    }
    // Folder reads refused only of the file's own folder; grep refused only when its first option holds r; find only with -exec.
    const reader = ({ eq, firstOpt, execOnly }) => (c, cwd) => {
      if (c.includes(file) || basename(c).includes(basename(file))) return 'refuse';
      let here = cwd;
      for (const seg of c.split(/&&|;|\n/)) {
        const w = words(seg);
        if (w[0] === 'cd') { here = resolve(here, w[1] ?? '.'); continue; }
        const dirs = w.slice(1).filter((x) => !x.startsWith('-')).map((x) => resolve(here, x));
        const hit = (d) => (eq ? d === dirname(file) : file.startsWith(`${d}/`));
        const rec = w[0] === 'grep' && (firstOpt ? /^-\w*[rR]|^--recursive/.test(w[1] ?? '') : w.some((x) => /^-\w*[rR]|^--recursive/.test(x)));
        const find = w[0] === 'find' && (!execOnly || w.includes('-exec'));
        const other = /^(tar|rsync|rm)$/.test(w[0]) || (w[0] === 'cp' && /^-\w*[rRa]/.test(w[1] ?? '')) || (w[0] === 'ls' && /xargs/.test(seg));
        if ((rec || find || other) && (dirs.length ? dirs : [here]).some(hit)) return 'refuse';
      }
      return 'allow';
    };
    const miss = (o) => runCorpus(reader(o), { target, cwd: root }).failures.filter((f) => f.expect === 'refuse');
    assert.ok(miss({ eq: true }).some((f) => f.group === 'folder-up'), `${target}: the folder above`);
    assert.ok(miss({ firstOpt: true }).some((f) => /grep -n -r/.test(f.command)), `${target}: grep -n -r`);
    assert.ok(miss({ execOnly: true }).some((f) => /find .*\| xargs/.test(f.command)), `${target}: find | xargs`);
  }
});

test('round 13: aliased writes; L41: --no-folder-reads leaves out only reads of a whole folder, and no allow case uses xargs', () => {
  const root = tmp();
  const all = cases(T, root);
  // A guard that never refuses an aliased command misses writes, not just the read (round 13 M-1).
  const writes = all.filter((c) => c.group === 'wrapped' && /alias wr=tee/.test(c.tpl));
  assert.ok(writes.some((c) => c.form === 'plain' && !c.tpl.includes('eval')) && writes.some((c) => c.tpl.includes('eval')), 'alias writes, with and without eval');
  assert.ok(all.some((c) => c.tpl === '(echo x > {{P}})') && all.some((c) => c.tpl === 'A=1 cp /tmp/x {{P}}'), 'plain ( ) and A=1 writes');
  // A hook that judges only named paths (lane 2's design under L41) passes with folder reads left out, not with them in.
  const file = resolve(root, T);
  const named = (c, cwd) => (/\b(rm|mv) -?\w* ?\S+/.test(c) && c.split(/\s+/).some((w) => file.startsWith(`${resolve(cwd, w)}/`))) || c.includes(T) || c.includes(file) ? 'refuse' : 'allow';
  const kept = runCorpus(named, { target: T, cwd: root, folderReads: false }).failures;
  assert.ok(!kept.some((f) => f.expect === 'refuse' && folderRead(f)), 'no folder read is scored');
  assert.ok(runCorpus(named, { target: T, cwd: root }).failures.some((f) => folderRead(f)), 'scored by default');
  assert.ok(all.some((c) => c.group === 'folder-up' && /^rm -rf /.test(c.command)) && all.some((c) => /^mv \S+ \/tmp\/y$/.test(c.command) && c.group === 'folder'), 'L41 deletes and moves');
  assert.ok(!all.some((c) => c.group === 'allow-beside' && /xargs/.test(c.command)), 'L41: no xargs allow case');
});
