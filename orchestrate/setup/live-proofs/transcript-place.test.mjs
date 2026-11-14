// L1134, L1137, L1141: the transcript-place live proof, on a stand-in claude that writes its conversation file by a
// rule each test picks: the one runner-ports has, or a way claude might differ (the linked path, no NFC, another hash).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { folderNameAsGiven, projectFolderName } from '../../wiring/runner-ports.mjs';
import { caseLeaves, findTranscript, judgeCase, main } from './transcript-place.mjs';

const PIN = '2.1.316';
const word = (args, k) => args[args.indexOf(k) + 1];
const otherHash = (p) => { const n = p.replace(/[^A-Za-z0-9]/g, '-'); if (n.length <= 200) return n; let h = 0; for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) | 0; return `${n.slice(0, 200)}-${Math.abs(h).toString(36)}`; };
const RULES = {
  right: (cwd) => projectFolderName(realpathSync(cwd)),
  linked: (cwd, env) => projectFolderName(env.PWD),
  noNfc: (cwd) => folderNameAsGiven(realpathSync(cwd)),
  otherHash: (cwd) => otherHash(realpathSync(cwd)),
};

// A temp folder reached through a link, as /var/folders is on a Mac, so every platform runs the linked case.
function setup(rule, { version = PIN, write = true, linked = true, extra = null } = {}) {
  const root = tempDir('orch-tplace-'); const real = join(root, 'real'); mkdirSync(real); symlinkSync(real, join(root, 'link'));
  const runs = [];
  const deps = { version: () => version, pin: () => PIN, tmp: () => (linked ? join(root, 'link') : realpathSync(real)),
    run: (bin, args, { cwd, env }) => {
      runs.push({ args, cwd, env });
      if (!write) return { status: 1, stdout: '', stderr: 'Not logged in · Please run /login' };
      const dir = join(env.CLAUDE_CONFIG_DIR, 'projects', RULES[rule](cwd, env)); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${word(args, '--session-id')}.jsonl`), '{}\n');
      extra?.(env.CLAUDE_CONFIG_DIR, word(args, '--session-id'), cwd);
      return { status: 0, stdout: '', stderr: '' };
    } };
  return { root, real, deps, runs };
}
const go = (argv, deps) => { let out = ''; const code = main(argv, { print: (t) => { out += t; }, deps }); return { code, out, last: out.trimEnd().split('\n').at(-1) }; };
const ARGV = ['--claude', '/opt/claude'];

test('L1137: every case at the computed path is PASS, and the three questions are settled', () => {
  const S = setup('right');
  const r = go(ARGV, S.deps);
  assert.equal(r.code, 0, r.out); assert.match(r.last, /^PASS: every case/);
  assert.equal((r.out.match(/^PASS /gm) ?? []).length, 5, r.out);
  assert.match(r.out, /The hash: the 31-multiplier/); assert.match(r.out, /The real path: claude keys on the real path/); assert.match(r.out, /NFC: claude puts the path in NFC first, as runner-ports does/);
  // Each case had its own fresh config folder, the PWD a shell gives (the linked name), and its own session id.
  assert.equal(new Set(S.runs.map((x) => x.env.CLAUDE_CONFIG_DIR)).size, 5);
  for (const x of S.runs) { assert.equal(x.env.PWD, x.cwd); assert.ok(x.cwd.startsWith(join(S.root, 'link')), x.cwd); }
  assert.equal(new Set(S.runs.map((x) => word(x.args, '--session-id'))).size, 5);
  // Nothing is left behind.
  assert.deepEqual(readdirSync(join(S.root, 'real')), []);
});

test('L1137: a temp folder that is not a link leaves the real-path question open, so the run can\'t end PASS', () => {
  const r = go(ARGV, setup('right', { linked: false }).deps);
  assert.equal((r.out.match(/^PASS /gm) ?? []).length, 5, r.out);
  assert.match(r.out, /The real path: not settled: the temp folder .* is not a link here/);
  assert.equal(r.code, 1); assert.match(r.last, /^NOT DONE: a question above is not settled/);
});

test('L1137: a disk that stores the decomposed name another way leaves the NFC question open', () => {
  const S = setup('right');
  const r = go(ARGV, { ...S.deps, real: (p) => realpathSync(p).replace(/e\u0301/g, '\u00e9') });
  assert.match(r.out, /NFC: not settled: this disk stored the decomposed name another way/);
  assert.equal(r.code, 1); assert.match(r.last, /^NOT DONE/);
});

test('L1137: the case names land where each case needs: 200 exactly, over 200, non-ASCII over 200', () => {
  const parent = '/private/var/folders/ab/cd/T/transcript-place-XYZ';
  const by = Object.fromEntries(caseLeaves(parent).map((c) => [c.id, projectFolderName(`${parent}/${c.leaf}`)]));
  assert.equal(by['exactly-200'].length, 200);
  assert.ok(by['over-200'].length > 200); assert.ok(by['non-ascii-over-200'].length > 200);
  assert.ok(caseLeaves(parent).find((c) => c.id === 'non-ascii-over-200').leaf.includes('\u00e9'));
  assert.ok(caseLeaves(parent).find((c) => c.id === 'decomposed-short').leaf.includes('e\u0301'));
});

test('L1137: a claude that keys on the linked path, skips the NFC step, or hashes another way FAILs, and the line says which', () => {
  const linked = go(ARGV, setup('linked').deps);
  assert.equal(linked.code, 1); assert.match(linked.out, /^FAIL short: .*the path as given \(the link\), not the real path/m); assert.match(linked.out, /The real path: not settled as wanted/);
  // L1141 m1: claude puts the real path in NFC before naming (checked: claude-code 2.1.316), so keeping the decomposed name is the FAIL.
  const nfc = go(ARGV, setup('noNfc').deps);
  assert.equal(nfc.code, 1); assert.match(nfc.out, /^FAIL decomposed-short: .*keeps the decomposed name as is \(no NFC step\)/m); assert.match(nfc.out, /^PASS short/m);
  assert.match(nfc.out, /NFC: not as runner-ports has it \(see the decomposed-short line\)/); assert.match(nfc.last, /^NOT DONE: decomposed-short FAIL$/);
  const hash = go(ARGV, setup('otherHash').deps);
  assert.equal(hash.code, 1); assert.match(hash.out, /^FAIL over-200: .*not the 31-multiplier hash/m); assert.match(hash.out, /^PASS exactly-200/m); assert.match(hash.out, /The hash: not as runner-ports has it/);
  assert.match(hash.last, /^NOT DONE: over-200 FAIL, non-ascii-over-200 FAIL/);
});

test('L1137: no conversation file (claude wants a sign-in) is NOT TRIED with what claude said; a wrong version runs nothing', () => {
  const r = go(ARGV, setup('right', { write: false }).deps);
  assert.equal(r.code, 1); assert.match(r.out, /^NOT TRIED short: claude wrote no conversation file .*Not logged in/m);
  assert.match(r.out, /The hash: not settled \(NOT TRIED\)/); assert.match(r.last, /^NOT DONE/);
  const S = setup('right', { version: '2.1.317' });
  const v = go(ARGV, S.deps);
  assert.equal(v.code, 1); assert.match(v.out, /not the pinned 2\.1\.316; nothing was run/); assert.equal(S.runs.length, 0);
  assert.equal(go([], S.deps).code, 2);
});

test('L1141 m2: the pin is the rules\' claude_code.pin; a typed --pin must match it, and an unreadable pin runs nothing', () => {
  const S = setup('right', { version: '2.1.317' });
  const typed = go([...ARGV, '--pin', '2.1.317'], S.deps);
  assert.equal(typed.code, 1); assert.match(typed.out, /--pin 2\.1\.317 is not the rules' pin, 2\.1\.316; nothing was run/); assert.equal(S.runs.length, 0);
  assert.equal(go(ARGV, { ...S.deps, pin: () => { throw new Error('no file'); } }).out.startsWith("NOT DONE: the pin can't be read"), true);
  assert.equal(S.runs.length, 0);
  assert.equal(go([...ARGV, '--pin', PIN], setup('right').deps).code, 0);
  // The real reader: the rules' pin, as capability-notes.mjs reads it.
  let out = ''; assert.equal(main(['--claude', '/nonexistent-claude'], { print: (t) => { out += t; }, deps: { version: () => null } }), 1);
  assert.match(out, /not the pinned 2\.1\.316; nothing was run/);
});

test('L1137, L1141 m4: with an account folder, what the run made is removed and anything else it changed is named', () => {
  // A stand-in that writes what a real claude writes beside the transcript: per-session folders and files named by the
  // session id, the account's .claude.json, and one file not named by the id.
  const extra = (config, id, cwd) => {
    for (const d of ['session-env', 'file-history']) { mkdirSync(join(config, d, id), { recursive: true }); writeFileSync(join(config, d, id, 'x'), '1'); }
    mkdirSync(join(config, 'todos'), { recursive: true }); writeFileSync(join(config, 'todos', `${id}-agent-${id}.json`), '[]');
    writeFileSync(join(config, '.claude.json'), JSON.stringify({ projects: { [cwd]: {} }, n: Math.random() }));
    mkdirSync(join(config, 'shell-snapshots'), { recursive: true }); writeFileSync(join(config, 'shell-snapshots', 'snapshot-zsh-1.sh'), '');
  };
  const S = setup('right', { extra }); const acct = join(S.root, 'acct');
  mkdirSync(join(acct, 'projects', '-other'), { recursive: true }); writeFileSync(join(acct, 'projects', '-other', 'old.jsonl'), '{}\n');
  mkdirSync(join(acct, 'todos')); writeFileSync(join(acct, 'todos', 'old.json'), '[]');
  writeFileSync(join(acct, '.claude.json'), '{"projects":{}}');
  const r = go([...ARGV, '--config-dir', acct], S.deps);
  assert.equal(r.code, 0, r.out);
  for (const x of S.runs) assert.equal(x.env.CLAUDE_CONFIG_DIR, acct);
  assert.deepEqual(readdirSync(join(acct, 'projects')), ['-other']); assert.deepEqual(readdirSync(join(acct, 'projects', '-other')), ['old.jsonl']);
  assert.deepEqual(readdirSync(join(acct, 'todos')), ['old.json']);
  assert.equal(existsSync(join(acct, 'session-env')), false); assert.equal(existsSync(join(acct, 'file-history')), false);
  assert.match(r.out, /^Left in .*acct \(not this run's own files, so not removed\): \.claude\.json \(changed\), shell-snapshots \(new\), shell-snapshots\/snapshot-zsh-1\.sh \(new\)$/m);
  // A run that changes nothing else says so.
  const T = setup('right'); const a2 = join(T.root, 'acct'); mkdirSync(a2);
  assert.match(go([...ARGV, '--config-dir', a2], T.deps).out, /^Left in .*acct: nothing$/m);
});

test('L1137: judgeCase and findTranscript', () => {
  assert.equal(judgeCase({ given: '/a', real: '/a', found: '-a' }).result, 'PASS');
  assert.equal(judgeCase({ given: '/a', real: '/a', found: null }).result, 'NOT TRIED');
  assert.equal(judgeCase({ given: '/a', real: '/a', found: '-b' }).result, 'FAIL');
  const d = tempDir('orch-tplace-'); mkdirSync(join(d, 'projects', '-x'), { recursive: true }); writeFileSync(join(d, 'projects', '-x', 'id1.jsonl'), '');
  assert.equal(findTranscript(d, 'id1'), '-x'); assert.equal(findTranscript(d, 'id2'), null); assert.equal(findTranscript(join(d, 'none'), 'id1'), null);
});
