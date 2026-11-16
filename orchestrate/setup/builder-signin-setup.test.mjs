// `setup builder-signin` and `check-builder-signin` (L1261): the builder sessions' Claude sign-in, saved as builder's own
// 0600 file. The value (a made-up one) must never reach the output, a step's text, the Mac's call log or a program's
// arguments. PLANT tests break one clause each.

import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CONFIG_PATH, builderSigninDir, builderSigninPath, folderTable, parseConfig } from './layout.mjs';
import { main } from './setup.mjs';
import { checkBuilderSignin, planBuilderSignin } from './builder-signin-setup.mjs';
import { spawnSync } from 'node:child_process';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const BASE = '/Library/orch-test';
const RAW = { base: BASE, owner: 'sam', products: ['alpha'] };
const cfg = parseConfig(RAW);
const VALUE = `sk-ant-oat01-${'Zx9_q-'.repeat(15)}WW`;   // made up: the shape only
const F = builderSigninPath(cfg);
const failing = (res) => res.filter((r) => !r.ok);

function world() {
  const mac = fakeMac({ euid: 0 });
  mkdirSync(mac.at('/Users/Shared'), { recursive: true }); chmodSync(mac.at('/Users/Shared'), 0o1777); mac.owners.set('/Users/Shared', { uid: mac.rootUid, gid: 0 });
  const calls = []; const realRun = mac.run;
  mac.run = (cmd, args) => { calls.push([cmd, ...args]); return realRun(cmd, args); };
  const d = tempDir('orch-signin-cfg-'); const file = join(d, 'c.json'); writeFileSync(file, JSON.stringify(RAW));
  const run = (args) => {
    const lines = [];
    let argv = args;
    if (mac.as === 0) { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(RAW)); chmodSync(f, 0o644); } else argv = [...args, '--config', file];
    const code = main(argv, { io: mac, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) });
    return { code, text: lines.join('\n') };
  };
  const first = run(['users-folders']); assert.equal(first.code, 0, first.text);
  const builder = Number(mac.users.get('builder').UniqueID);
  return { mac, run, calls, builder };
}
const leaked = (w, ...more) => { const all = JSON.stringify([w.mac.log, w.calls, w.mac.secretPrompts, ...more]); return all.includes(VALUE) || all.includes(VALUE.slice(0, 24)); };

test('the folder table has the sign-in folder: builder\'s, 0700, no access list, right under the base', () => {
  const row = folderTable(cfg).find((r) => r.path === builderSigninDir(cfg));
  assert.deepEqual({ owner: row.owner, mode: row.mode }, { owner: 'builder', mode: 0o700 });
  assert.equal(builderSigninDir(cfg), `${BASE}/builder-signin`);
});

test('builder-signin: saved as builder\'s own 0600 file; the value NEVER in the output, the steps, the call log or any program\'s arguments; check passes', () => {
  const w = world(); w.mac.secretInput = `${VALUE}\n`;
  const dry = w.run(['builder-signin', '--dry-run']);
  assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /would run: read the sign-in token from the terminal/); assert.equal(w.mac.secretPrompts.length, 0, 'a dry run read the terminal');
  const r = w.run(['builder-signin']); assert.equal(r.code, 0, r.text);
  const f = w.mac.at(F);
  assert.equal(statSync(f).mode & 0o7777, 0o600);
  assert.equal(w.mac.owners.get(F).uid, w.builder);
  assert.equal(readFileSync(f, 'utf8'), `${VALUE}\n`);
  assert.equal(w.mac.secretPrompts.length, 1);
  assert.ok(!leaked(w, r.text, dry.text), 'the value leaked');
  const c = w.run(['check-builder-signin']); assert.equal(c.code, 0, c.text); assert.ok(!leaked(w, c.text));
  assert.deepEqual(failing(checkBuilderSignin(w.mac, cfg)), []);
});

test('the same token again changes nothing (no write, no rename); a new token replaces it, whole', () => {
  const w = world(); w.mac.secretInput = VALUE; assert.equal(w.run(['builder-signin']).code, 0);
  const before = w.mac.log.length;
  assert.equal(w.run(['builder-signin']).code, 0);
  assert.deepEqual(w.mac.log.slice(before).filter((l) => /^(write|rename) /.test(l)), [], 'a second run with the same value wrote');
  const next = `${VALUE.slice(0, -4)}ABCD`; w.mac.secretInput = next;
  assert.equal(w.run(['builder-signin']).code, 0);
  assert.equal(readFileSync(w.mac.at(F), 'utf8'), `${next}\n`);
  assert.deepEqual(failing(checkBuilderSignin(w.mac, cfg)), []);
});

test('PLANT a wrong paste (a GitHub token, a password) → refused, nothing written, the message does not repeat it', () => {
  for (const bad of ['my-password-is-hunter2-and-quite-long-indeed', `github_pat_11AAAAAAA0${'a'.repeat(60)}`]) {
    const w = world(); w.mac.secretInput = bad;
    const r = w.run(['builder-signin']); assert.equal(r.code, 1, r.text);
    assert.match(r.text, /does not look like a Claude sign-in token/); assert.ok(!r.text.includes(bad.slice(0, 16)), r.text);
    assert.throws(() => statSync(w.mac.at(F)));
  }
});

test('PLANT no terminal → refused, nothing written; without root → refused before reading', () => {
  const w = world(); w.mac.secretInput = null;
  const r = w.run(['builder-signin']); assert.equal(r.code, 1); assert.match(r.text, /no terminal/);
  assert.throws(() => statSync(w.mac.at(F)));
  w.mac.secretInput = VALUE; w.mac.as = 1234;
  assert.notEqual(w.run(['builder-signin']).code, 0); assert.equal(w.mac.secretPrompts.length, 1, 'only the first run asked');
});

test('PLANT the folder not builder\'s own 0700, or a link → refused before reading', () => {
  const w = world(); w.mac.secretInput = VALUE;
  chmodSync(w.mac.at(builderSigninDir(cfg)), 0o755);
  let r = w.run(['builder-signin']); assert.equal(r.code, 1); assert.match(r.text, /not builder's own 0700 folder/); assert.equal(w.mac.secretPrompts.length, 0);
  chmodSync(w.mac.at(builderSigninDir(cfg)), 0o700);
  const o = w.mac.owners.get(builderSigninDir(cfg)); w.mac.owners.set(builderSigninDir(cfg), { ...o, uid: w.mac.rootUid + 7 });
  r = w.run(['builder-signin']); assert.equal(r.code, 1); assert.match(r.text, /not builder's own 0700 folder/);
  w.mac.owners.set(builderSigninDir(cfg), o);
  const victim = w.mac.at('/victim.txt'); writeFileSync(victim, 'keep\n', { mode: 0o600 });
  symlinkSync(victim, w.mac.at(F));
  r = w.run(['builder-signin']); assert.equal(r.code, 1); assert.match(r.text, /not a plain file/); assert.equal(readFileSync(victim, 'utf8'), 'keep\n'); assert.equal(w.mac.secretPrompts.length, 0);
});

test('PLANT check-builder-signin FAILs on a wrong mode, owner, second name or access list, and on a missing file; it needs root', () => {
  const w = world(); w.mac.secretInput = VALUE; assert.equal(w.run(['builder-signin']).code, 0);
  const why = () => failing(checkBuilderSignin(w.mac, cfg)).map((r) => r.why).join('\n');
  chmodSync(w.mac.at(F), 0o644); assert.match(why(), /mode is 644, want 600/); chmodSync(w.mac.at(F), 0o600);
  const o = w.mac.owners.get(F); w.mac.owners.set(F, { ...o, uid: w.mac.rootUid }); assert.match(why(), /owner is uid/); w.mac.owners.set(F, o);
  linkSync(w.mac.at(F), w.mac.at(`${builderSigninDir(cfg)}/x`)); assert.match(why(), /another name/); rmSync(w.mac.at(`${builderSigninDir(cfg)}/x`));
  assert.deepEqual(failing(checkBuilderSignin(w.mac, cfg)), []);
  rmSync(w.mac.at(F)); assert.match(why(), /missing: as the owner run claude setup-token/);
  w.mac.as = 501; const s = checkBuilderSignin(w.mac, cfg); assert.equal(s.length, 1); assert.equal(s[0].skip, true); assert.match(s[0].why, /needs root/);
});

// r1 Minor 1: the same token is left alone only when the file is as the runner wants it: one name, no access list.
test('PLANT the same token with a second name, or an access list on the file → written again, so the new file has neither', () => {
  const w = world(); w.mac.secretInput = VALUE; assert.equal(w.run(['builder-signin']).code, 0);
  const other = `${builderSigninDir(cfg)}/second`;
  linkSync(w.mac.at(F), w.mac.at(other));
  let before = w.mac.log.length;
  assert.equal(w.run(['builder-signin']).code, 0);
  assert.ok(w.mac.log.slice(before).some((l) => l.startsWith('rename ')), 'a file with another name was left as it was');
  assert.equal(statSync(w.mac.at(F)).nlink, 1); assert.equal(readFileSync(w.mac.at(F), 'utf8'), `${VALUE}\n`);
  rmSync(w.mac.at(other));
  assert.equal(w.mac.run('/bin/chmod', ['+a', 'user:orchestrate allow read', w.mac.at(F)]).status, 0);
  assert.match(failing(checkBuilderSignin(w.mac, cfg)).map((r) => r.why).join(), /has an access list/);
  before = w.mac.log.length;
  assert.equal(w.run(['builder-signin']).code, 0);
  assert.ok(w.mac.log.slice(before).some((l) => l.startsWith('rename ')), 'a file with an access list was left as it was');
  assert.deepEqual(failing(checkBuilderSignin(w.mac, cfg)), []);
});

// r1 Minor 2: the compare read is the runner's own (one handle, O_NOFOLLOW|O_NONBLOCK): a named pipe or a link put in the
// file's place after the plan is refused, never read through and never waited on.
test('PLANT a link or a named pipe put in the file\'s place just after the run looked → the compare read refuses it, no wait, and the new file replaces it', () => {
  for (const kind of ['link', 'fifo']) {
    const w = world(); w.mac.secretInput = VALUE; assert.equal(w.run(['builder-signin']).code, 0);
    const plan = planBuilderSignin(w.mac, cfg); assert.deepEqual(plan.problems, []);
    // The same token sits in a file elsewhere: a compare that followed the link would find it "the same" and keep the link.
    const victim = w.mac.at('/victim.txt'); writeFileSync(victim, `${VALUE}\n`, { mode: 0o600 });
    const look = w.mac.lstat; let swapped = false;
    w.mac.lstat = (p) => {
      const st = look.call(w.mac, p);
      if (p === F && !swapped) {   // the run's own look saw the plain file; the swap comes right after it
        swapped = true; rmSync(w.mac.at(F));
        if (kind === 'fifo') assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', w.mac.at(F)]).status, 0);
        else symlinkSync(victim, w.mac.at(F));
      }
      return st;
    };
    try { plan.ops[0].run(); } finally { w.mac.lstat = look; }
    assert.ok(swapped, kind);
    const now = lstatSync(w.mac.at(F));
    assert.ok(now.isFile() && !now.isSymbolicLink(), `${kind}: the ${kind} was kept, so the compare read went through it`);
    assert.equal(readFileSync(w.mac.at(F), 'utf8'), `${VALUE}\n`); assert.equal(readFileSync(victim, 'utf8'), `${VALUE}\n`);
    // The port itself, asked straight about a link and a pipe: refused at once, its reason without the value.
    for (const make of [() => symlinkSync(victim, w.mac.at(F)), () => assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', w.mac.at(F)]).status, 0)]) {
      rmSync(w.mac.at(F)); make();
      const r = w.mac.readSignin(F, { uid: w.builder });
      assert.equal(r.ok, false, kind); assert.ok(!r.reason.includes(VALUE.slice(0, 20)));
    }
  }
});
