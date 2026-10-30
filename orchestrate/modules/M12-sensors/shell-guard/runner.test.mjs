import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { corpus, cases, pathForms, askHook, runCorpus } from './runner.mjs';
import { touchCheck } from './selfcheck.mjs';

const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const T = '.env.production';
const node = process.execPath;

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
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/sg-`);
  mkdirSync(`${dir}/x`);
  writeFileSync(`${dir}/${T}`, 'PLANTED\n');
  for (const [form, p] of Object.entries(pathForms(T))) {
    const out = execFileSync('/bin/bash', ['-c', `cat ${p} 2>/dev/null; true`], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /PLANTED/, form);
  }
});

// In-process copies of the two fixture guards (spawning one process per case takes ~45 s); the protocol test below
// checks they decide as the spawned fixture files do.
const STRICT = new Set(corpus.allow); // the allow cases, word for word
const strict = (c) => (STRICT.has(c) ? 'allow' : 'refuse');
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
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" crash`, 'cat x'), 'crash');
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" hang`, 'cat x', { timeoutMs: 300 }), 'crash');
  assert.equal(askHook(`"${node}" "${fx('odd-hooks.mjs')}" allow-all`, 'cat x'), 'allow');
});

test('a guard that refuses everything fails too (the allow cases)', () => {
  const r = runCorpus('exit 2');
  assert.equal(r.failures.length, corpus.allow.length);
});

test('0b-7 round 9 minor 5: an absolute form, and change-folder-first cases asked from the folder above', () => {
  const dir = mkdtempSync(`${tmpdir()}/sg-`);
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
  const dir = mkdtempSync(`${tmpdir()}/sg-`);
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
  const ansi = cases(T, mkdtempSync(`${tmpdir()}/sg-`)).filter((c) => c.form === 'ansi-c');
  assert.ok(ansi.length > 20);
  for (const c of ansi) assert.ok(c.command.includes(pathForms(T)['ansi-c']), c.command);
});

// Every refuse case must really read or write the planted file under bash or zsh, in both runs the README names, and
// the dead list must hold exactly the template and form pairs that touch nothing. Checked on two names, so the list
// does not hang on one name's letters (round 10 audit 2 M-2). ~3,600 shell runs, about 30 s.
// zsh, the Mac's shell, also writes through a brace form after ">"; bash calls it an ambiguous redirect. Without zsh
// (a Linux CI box) those few cases are excused, by that exact shape.
const zshOnly = (c) => c.form === 'brace' && /> ?\S*\{/.test(c.command);
test('round 10: every refuse case touches the file, and corpus.dead is exactly the pairs that do not, on two names', () => {
  const shells = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));
  const excuse = shells.includes('/bin/zsh') ? () => false : zshOnly;
  const listed = Object.entries(corpus.dead).flatMap(([tpl, forms]) => forms.map((form) => `${form} / ${tpl}`)).sort();
  assert.ok(listed.length > 0);
  const saved = corpus.dead; corpus.dead = {};
  try {
    for (const name of [T, 'secret.prod']) {
      const groups = new Map();
      for (const c of ['relative', 'absolute'].flatMap((mode) => touchCheck(name, { mode, shells }))) {
        const k = `${c.form} / ${c.tpl}`; groups.set(k, [...(groups.get(k) ?? []), c]);
      }
      const silent = (c) => !c.touchedBy.length && !excuse(c);
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
