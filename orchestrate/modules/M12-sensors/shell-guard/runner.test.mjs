import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { corpus, cases, pathForms, askHook, runCorpus } from './runner.mjs';

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
const STRICT = [/^ls$/, /^git status$/, /^node --test$/, /^cat README\.md$/, /^echo hello > \/tmp\/scratch\.txt$/];
const strict = (c) => (STRICT.some((r) => r.test(c)) ? 'allow' : 'refuse');
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
