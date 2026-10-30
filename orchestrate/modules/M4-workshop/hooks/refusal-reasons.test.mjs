// Planted-failure tests for the hooks' refusal lines (audit R-0b-44 M-6). Each test makes one
// refusal fire and checks its own reason, so switching that line off fails a test even when a
// later line would still refuse for another reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeSnapshot } from './snapshot.mjs';
import { parseArgs, runHook, pass, landingPath } from './lib.mjs';
import * as plain from './plain-files.mjs';
import * as merge from './merge-guard.mjs';
import * as noVerify from './no-verify-block.mjs';
import * as secret from './secret-file-block.mjs';
import * as prodGuard from './production-write-guard.mjs';
import * as compact from './compact-note.mjs';
import { tmpFolder } from '../tmp-folders.test-helper.mjs';

function world(rules = { production: { env_files: ['/nowhere/settings.production'], programs: ['fakehost'], hosts: ['db.prod.example.net'] }, secrets: { paths: [] } }) {
  const root = landingPath(tmpFolder('orch-refuse-'));
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  const copy = join(root, 'copy'); mkdirSync(copy);
  const snapshot = join(root, 'rules.json');
  writeFileSync(snapshot, makeSnapshot(rules));
  return { root, outbox, copy, snapshot };
}
const args = (w, role = 'worker', extra = {}) => ({ role, outbox: w.outbox, snapshot: w.snapshot, kinds: role === 'lead' ? ['wish', 'ask', 'handoff'] : ['report'], copy: role === 'worker' ? w.copy : undefined, ...extra });
const bash = (command, cwd = '/') => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });

test('lib: a bad argument, a missing argument, input that is not an object and a hook with no decision each refuse with their own reason', async () => {
  assert.throws(() => parseArgs(['role', 'worker']), /^Error: bad argument role$/);
  assert.throws(() => parseArgs(['--outbox', '/o', '--snapshot', '/s']), /^Error: missing --role$/);
  const io = (stdin) => { const err = []; return { argv: ['--role', 'worker', '--outbox', '/o', '--snapshot', '/s'], stdin: Readable.from([Buffer.from(stdin)]), exit: (c) => c, stderr: (t) => err.push(t), err }; };
  const a = io('5');
  assert.equal(await runHook(() => pass(), a), 2);
  assert.match(a.err.join(''), /hook input is not an object/);
  const b = io('{}');
  assert.equal(await runHook(() => undefined, b), 2);
  assert.match(b.err.join(''), /hook gave no decision/);
});

test('plain-files: each refusal gives its own reason', () => {
  const w = world();
  assert.equal(plain.decide({ tool_name: 'Write', tool_input: {} }, args(w)).reason, 'no file path in the write');
  assert.match(plain.decide(write('relative/x.txt'), args(w)).reason, /is not a plain absolute path/);
  assert.equal(plain.decide(write(join(w.copy, 'a.txt')), args(w, 'worker', { outbox: join(w.root, 'gone') })).reason, 'the outbox is missing');
  assert.equal(plain.decide(write(join(w.outbox, 'notes.md')), args(w)).reason, '"notes.md" is not an outbox file name');
  assert.equal(plain.decide(write(join(w.copy, 'a.txt')), args(w, 'lead', { copy: w.copy })).reason, 'the lead role writes only to its outbox');
});

test('compaction note: an outbox that is a link, and a note that is a folder, each refuse with their own reason', () => {
  const w = world();
  const link = join(w.root, 'outbox-link');
  symlinkSync(w.outbox, link);
  const a = { ...args(w, 'worker', { outbox: link }), kind: 'report', event: 'PreCompact' };
  assert.equal(compact.decide({ session_id: 's1' }, a).reason, 'the outbox is missing or a link');
  assert.deepEqual(readdirSync(w.outbox), [], 'nothing written through the link');
  mkdirSync(join(w.outbox, compact.noteName('report', 's1')));
  const b = { ...args(w), kind: 'report', event: 'SessionStart' };
  assert.equal(compact.decide({ session_id: 's1', source: 'compact' }, b, { stdout: () => {} }).reason, 'the note is not a plain file');
});

test('merge guard: the plain-text and the word-level merge address checks each catch what the other cannot', () => {
  // A variable in a web call would be refused for another reason; the address check comes first.
  assert.equal(merge.decide(bash('curl $X https://api.github.com/repos/o/r/merges')).reason, 'the command reaches GitHub\'s merge address');
  // A quote inside the address hides it from the plain-text check; the word check still sees it.
  assert.equal(merge.decide(bash('curl "https://api.github.com/repos/o/r/pulls/1/mer"ge')).reason, 'the command reaches GitHub\'s merge address');
});

test('no-verify: the plain-text checks give their own reasons ahead of the shortened-form check', () => {
  assert.equal(noVerify.decide(bash('git commit --no-verify -m x')).reason, '--no-verify');
  assert.equal(noVerify.decide(bash('git -c core.hooksPath=/x commit --no-verif')).reason, 'changing git\'s hooks folder');
  assert.equal(noVerify.decide(bash('HUSKY=0 git commit --no-verif')).reason, 'a hook-skip variable');
});

test('production guard: a missing snapshot, no production block and a production host in a web address each refuse with their own reason', () => {
  const w = world();
  assert.equal(prodGuard.decide(bash('true'), args(w, 'worker', { snapshot: join(w.root, 'none.json') })).reason, 'rules snapshot is missing or unreadable');
  const bare = world({ secrets: { paths: [] } });
  assert.equal(prodGuard.decide(bash('true'), args(bare)).reason, 'the rules snapshot has no production block');
  assert.equal(prodGuard.decide({ tool_name: 'WebFetch', tool_input: { url: 'https://DB.prod.example.net/x' } }, args(w)).reason, 'the call names a production host');
  assert.equal(prodGuard.decide({ tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.net/x' } }, args(w)).block, false);
});

test('secret-file block: a missing snapshot refuses with its own reason', () => {
  const w = world();
  assert.equal(secret.decide(bash('true'), args(w, 'worker', { snapshot: join(w.root, 'none.json') })).reason, 'rules snapshot is missing or unreadable');
});
