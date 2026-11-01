// Tests for setup part 3: the ownerTaps folder, the proposals folders, the owner's git trusting the mirror, and the
// watch-only token file. Same stand-in Mac as the other setup tests (fake-mac.test-helper.mjs). PLANT tests break one clause
// each and name the check that catches it. The last tests run read-only tools on this Mac.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROPOSALS_PARENT, folderTable, mirrorPath, ownerTapsPath, parseConfig, proposalRows } from './layout.mjs';
import { readSecretFromTty, realIo } from './mac.mjs';
import { aclEntries, apply, check } from './users-folders.mjs';
import { checkProposals, checkSafeDirectory, checkToken, planProposals, planSafeDirectory, planToken, tokenPath, tokenProblem } from './extras.mjs';
import { main, parseArgs, planCommand } from './setup.mjs';
import { fakeMac } from './fake-mac.test-helper.mjs';

const BASE = '/Library/orch-test';
const RAW = { base: BASE, owner: 'joe', products: ['alpha', 'beta'] };
const cfg = parseConfig(RAW);
const SECRET = 'github_pat_11AAAAAAA0abcdefghijklmnop_QRSTUVWXYZ0123456789abcdef';   // a made-up one, never real
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };

function cfgFile(raw = RAW) { const d = mkdtempSync(join(tmpdir(), 'extras-cfg-')); const f = join(d, 'c.json'); writeFileSync(f, JSON.stringify(raw)); return f; }

/** The throwaway Mac with part 1 done, and the shared folder the proposals parent goes in. Every call the Mac saw is kept. */
function world({ raw = RAW } = {}) {
  const mac = fakeMac({ euid: 0 });
  mkdirSync(mac.at('/Users/Shared'), { recursive: true });
  const calls = []; const realRun = mac.run;
  mac.run = (cmd, args) => { calls.push([cmd, ...args]); return realRun(cmd, args); };
  const file = cfgFile(raw);
  const run = (args) => { const s = sink(); const code = main([...args, '--config', file], { io: mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') }; };
  const first = run(['users-folders']); assert.equal(first.code, 0, first.text);
  return { mac, run, calls, cfg: parseConfig(raw), file };
}
const PARENT = DEFAULT_PROPOSALS_PARENT;
const failing = (res) => res.filter((r) => !r.ok);

// ───────────────────────────────────────────── ownerTaps (A6)

test('the table has the ownerTaps folder: the owner\'s, 0755, no access list, inside the base', () => {
  const row = folderTable(cfg).find((r) => r.path === ownerTapsPath(cfg));
  assert.deepEqual({ owner: row.owner, mode: row.mode, acl: row.acl }, { owner: 'owner', mode: 0o755, acl: [] });
  assert.ok(ownerTapsPath(cfg).startsWith(`${cfg.base}/`));
  assert.equal(folderTable(cfg).filter((r) => r.path === mirrorPath(cfg)).length, 1);
});

test('users-folders makes the ownerTaps folder for the owner; check passes', () => {
  const w = world();
  const st = statSync(w.mac.at(ownerTapsPath(cfg)));
  assert.equal(st.mode & 0o7777, 0o755);
  assert.equal(w.mac.owners.get(ownerTapsPath(cfg)).uid, Number(w.mac.users.get('joe').UniqueID));
  assert.deepEqual(failing(check(w.mac, cfg)), []);
});

test('PLANT ownerTaps writable by others → check FAILs on its mode (the folder-table check), and a second users-folders run puts it right', () => {
  const w = world();
  chmodSync(w.mac.at(ownerTapsPath(cfg)), 0o775);
  assert.match(failing(check(w.mac, cfg)).map((r) => `${r.what} ${r.why}`).join('\n'), /owner-taps .*mode is 775, want 755/);
  assert.equal(w.run(['users-folders']).code, 0);
  assert.deepEqual(failing(check(w.mac, cfg)), []);
});

test('PLANT an access-list entry on ownerTaps → check FAILs (the exact access-list compare)', () => {
  const w = world();
  assert.equal(w.mac.run('/bin/chmod', ['+a', 'user:orchestrate allow list', w.mac.at(ownerTapsPath(cfg))]).status, 0);
  assert.match(failing(check(w.mac, cfg)).map((r) => r.why).join('\n'), /access list has an entry that is not wanted/);
});

// ───────────────────────────────────────────── proposals folders (A7)

test('config: proposalsParent is checked; the default is used when it is not given', () => {
  assert.equal(parseConfig(RAW).proposalsParent, undefined);
  assert.equal(parseConfig({ ...RAW, proposalsParent: '/Users/Shared/x-props' }).proposalsParent, '/Users/Shared/x-props');
  for (const bad of ['relative/x', '/Users/Shared/../x', '/x', '/Users/Shared/', '/Users/Shared/has space', 5]) assert.throws(() => parseConfig({ ...RAW, proposalsParent: bad }), /proposalsParent/, String(bad));
});

test('the proposals rows: the parent root\'s 0711, each product the owner\'s 0700 with the one orchestrate entry', () => {
  const rows = proposalRows(cfg);
  assert.deepEqual(rows.map((r) => [r.path, r.owner, r.mode, r.acl.length]), [[PARENT, 'root', 0o711, 0], [`${PARENT}/alpha`, 'owner', 0o700, 1], [`${PARENT}/beta`, 'owner', 0o700, 1]]);
});

test('proposals: makes the parent and one folder per product with the exact owner, mode and access list; the read-back passes; a second run does nothing', () => {
  const w = world();
  const r = w.run(['proposals']); assert.equal(r.code, 0, r.text);
  assert.equal(statSync(w.mac.at(PARENT)).mode & 0o7777, 0o711);
  assert.equal(w.mac.owners.get(PARENT).uid, w.mac.rootUid);
  const joe = Number(w.mac.users.get('joe').UniqueID);
  for (const prod of ['alpha', 'beta']) {
    const f = `${PARENT}/${prod}`;
    assert.equal(statSync(w.mac.at(f)).mode & 0o7777, 0o700); assert.equal(w.mac.owners.get(f).uid, joe);
    assert.deepEqual(aclEntries(w.mac, f).entries, ['user:orchestrate allow directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search']);
  }
  const c = w.run(['check-proposals']); assert.equal(c.code, 0, c.text);
  assert.match(c.text, /PASS .*as orchestrate, reading .*alpha works/); assert.match(c.text, /PASS .*as orchestrate, writing .*alpha fails/); assert.match(c.text, /PASS .*as review, reading .*alpha fails/);
  const n = w.mac.log.length;
  const again = w.run(['proposals']); assert.equal(again.code, 0); assert.match(again.text, /nothing to do/); assert.equal(w.mac.log.length, n);
});

test('proposals --dry-run prints every step and changes nothing', () => {
  const w = world(); const n = w.mac.log.length;
  const r = w.run(['proposals', '--dry-run']);
  assert.equal(r.code, 0, r.text); assert.match(r.text, /would run: mkdir -m 700 .*orchestrate-proposals/); assert.match(r.text, /dry run: \d+ step\(s\), nothing changed/);
  assert.equal(w.mac.log.length, n);
});

test('proposals refuses when not root; the check twin runs without root and SKIPs the as-other-user proofs, saying so', () => {
  const w = world(); w.mac.as = 1234;
  const r = w.run(['proposals']); assert.equal(r.code, 2); assert.match(r.text, /must run as root/);
  const c = w.run(['check-proposals']); assert.match(c.text, /SKIP .*needs root/);
});

test('PLANT a proposals parent someone else made first → plan gives no steps and says so (planProposals refuses a parent not owned by root)', () => {
  const w = world();
  mkdirSync(w.mac.at(PARENT)); chmodSync(w.mac.at(PARENT), 0o777); w.mac.owners.set(PARENT, { uid: w.mac.rootUid + 1, gid: 20 });
  const p = planProposals(w.mac, w.cfg);
  assert.deepEqual(p.ops, []); assert.match(p.problems.join('\n'), /belongs to uid \d+, not root/);
  const r = w.run(['proposals']); assert.equal(r.code, 1); assert.equal(statSync(w.mac.at(PARENT)).mode & 0o7777, 0o777, 'it was taken over');
});

test('PLANT the proposals parent is a link to a victim folder → refused, the victim unchanged', () => {
  const w = world();
  const victim = w.mac.at('/victim'); mkdirSync(victim, { mode: 0o700 }); symlinkSync(victim, w.mac.at(PARENT));
  const r = w.run(['proposals']); assert.equal(r.code, 1, r.text); assert.match(r.text, /exists but is a link/);
  assert.equal(statSync(victim).mode & 0o7777, 0o700); assert.equal(w.mac.owners.get('/victim'), undefined);
});

test('PLANT the parent swapped for a link between the plan and the run → the first step stops it, nothing changed, the victim unchanged', () => {
  const w = world(); assert.equal(w.run(['proposals']).code, 0);
  chmodSync(w.mac.at(`${PARENT}/alpha`), 0o755);   // so the plan has something to do
  const p = planCommand(w.mac, w.cfg, { cmd: 'proposals' });
  assert.deepEqual(p.problems, []); assert.match(p.ops[0].text, /check that .* is a plain folder/);
  const victim = w.mac.at('/victim'); mkdirSync(victim, { mode: 0o700 });
  rmSync(w.mac.at(PARENT), { recursive: true }); symlinkSync(victim, w.mac.at(PARENT));
  const n = w.mac.log.length;
  assert.throws(() => apply(p.ops), /exists but is a link/);
  assert.equal(w.mac.log.length, n); assert.equal(statSync(victim).mode & 0o7777, 0o700);
});

test('PLANT a product proposals folder readable by others (0755) → check-proposals FAILs on the mode AND on "as review, reading fails"', () => {
  const w = world(); assert.equal(w.run(['proposals']).code, 0);
  chmodSync(w.mac.at(`${PARENT}/alpha`), 0o755);
  const bad = failing(checkProposals(w.mac, w.cfg)).map((r) => `${r.what} | ${r.why}`).join('\n');
  assert.match(bad, /alpha .*mode is 755, want 700/); assert.match(bad, /as review, reading .*alpha fails \| review CAN read it/);
});

test('PLANT a group-style loosening (0770) on a product folder → FAIL on mode; and the run puts it back to 0700', () => {
  const w = world(); assert.equal(w.run(['proposals']).code, 0);
  chmodSync(w.mac.at(`${PARENT}/beta`), 0o770);
  assert.match(failing(checkProposals(w.mac, w.cfg)).map((r) => r.why).join('\n'), /mode is 770, want 700/);
  assert.equal(w.run(['proposals']).code, 0); assert.deepEqual(failing(checkProposals(w.mac, w.cfg)), []);
});

test('PLANT orchestrate\'s read entry removed → check FAILs on the access list AND on "as orchestrate, reading works"', () => {
  const w = world(); assert.equal(w.run(['proposals']).code, 0);
  assert.equal(w.mac.run('/bin/chmod', ['-N', w.mac.at(`${PARENT}/alpha`)]).status, 0);
  const bad = failing(checkProposals(w.mac, w.cfg)).map((r) => `${r.what} | ${r.why}`).join('\n');
  assert.match(bad, /access list is missing/); assert.match(bad, /as orchestrate, reading .*alpha works/);
});

test('PLANT orchestrate can WRITE a proposals folder (0707 for the stand-in\'s "other") → check FAILs on "as orchestrate, writing fails"', () => {
  const w = world(); assert.equal(w.run(['proposals']).code, 0);
  chmodSync(w.mac.at(`${PARENT}/alpha`), 0o707);
  assert.match(failing(checkProposals(w.mac, w.cfg)).map((r) => `${r.what} | ${r.why}`).join('\n'), /as orchestrate, writing .*alpha fails \| orchestrate CAN write it/);
});

test('proposals refuses with no orchestrate user, no owner, or no products, and changes nothing', () => {
  const w = world(); w.mac.users.delete('orchestrate');
  assert.match(planProposals(w.mac, w.cfg).problems.join('\n'), /orchestrate user does not exist/);
  assert.match(planProposals(w.mac, { ...w.cfg, owner: 'nobody-here' }).problems.join('\n'), /owner's Mac user nobody-here was not found/);
  assert.match(planProposals(w.mac, { ...w.cfg, products: [] }).problems.join('\n'), /no products/);
});

// ───────────────────────────────────────────── safe.directory

test('safe-directory: the owner\'s git is told the mirror path, run AS the owner (never root writing into their home); a second run does nothing', () => {
  const w = world();
  const r = w.run(['safe-directory']); assert.equal(r.code, 0, r.text);
  assert.deepEqual(w.mac.gitSafe.get('joe'), [mirrorPath(cfg)]);
  const sudo = w.calls.filter((c) => c[2] === '-H' || c.includes('/usr/bin/git')).flat();
  assert.ok(sudo.includes('-u') && sudo.includes('joe'), 'git did not run as the owner');
  const n = w.mac.log.length; const again = w.run(['safe-directory']); assert.match(again.text, /nothing to do/); assert.equal(w.mac.log.length, n);
  assert.equal(w.run(['check-safe-directory']).code, 0);
});

test('PLANT safe.directory = * → refused with a plain sentence, nothing changed; the check FAILs', () => {
  const w = world(); w.mac.gitSafe.set('joe', ['*']);
  const r = w.run(['safe-directory']); assert.equal(r.code, 1); assert.match(r.text, /trusts every folder/); assert.deepEqual(w.mac.gitSafe.get('joe'), ['*']);
  assert.match(failing(checkSafeDirectory(w.mac, w.cfg)).map((x) => x.why).join(), /every folder/);
});

test('PLANT the mirror path missing → check-safe-directory FAILs; dry run prints the exact command and changes nothing', () => {
  const w = world();
  assert.match(failing(checkSafeDirectory(w.mac, w.cfg)).map((x) => x.why).join(), /not in its safe\.directory list/);
  const r = w.run(['safe-directory', '--dry-run']); assert.match(r.text, /would run: as joe: git config --global --add safe\.directory .*\/mirror/); assert.equal(w.mac.gitSafe.get('joe'), undefined);
});

test('safe-directory needs root; without it the plan says so and git is not run', () => {
  const w = world(); w.mac.as = 1234;
  const r = w.run(['safe-directory']); assert.equal(r.code, 2); assert.match(r.text, /must run as root/);
});

// ───────────────────────────────────────────── the watch-only token file

test('tokenProblem accepts real-looking tokens and refuses everything else without saying what it saw', () => {
  assert.equal(tokenProblem(SECRET), null);
  assert.equal(tokenProblem(`ghp_${'a'.repeat(36)}`), null);
  for (const bad of ['', 'hunter2', 'github_pat_short', `${SECRET} extra`, `${SECRET}\n`, null, undefined, 5]) {
    const why = tokenProblem(bad); assert.ok(why); assert.ok(!why.includes(String(bad)) || String(bad).length < 3, 'the message repeats what was typed');
  }
});

test('token: saved as orchestrate\'s own 0600 file in keys; the text is NEVER in the output, the steps, the Mac\'s call log or any program\'s arguments', () => {
  const w = world(); w.mac.secretInput = `${SECRET}\n`;
  const dry = w.run(['token', '--dry-run']);
  assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /would run: read the token from the terminal/); assert.equal(w.mac.secretPrompts.length, 0, 'a dry run read the terminal');
  const r = w.run(['token']); assert.equal(r.code, 0, r.text);
  const f = w.mac.at(tokenPath(cfg));
  assert.equal(statSync(f).mode & 0o7777, 0o600);
  assert.equal(w.mac.owners.get(tokenPath(cfg)).uid, Number(w.mac.users.get('orchestrate').UniqueID));
  assert.equal(readFileSync(f, 'utf8'), `${SECRET}\n`);
  const everything = JSON.stringify([r.text, dry.text, w.mac.log, w.calls, w.mac.secretPrompts]);
  assert.ok(!everything.includes(SECRET), 'the token text leaked');
  assert.ok(!everything.includes(SECRET.slice(0, 20)), 'part of the token leaked');
  const c = w.run(['check-token']); assert.equal(c.code, 0, c.text); assert.ok(!c.text.includes(SECRET));
});

test('PLANT a wrong paste (not a token) → refused, nothing written, and the message does not repeat it', () => {
  const w = world(); w.mac.secretInput = 'my-password-is-hunter2';
  const r = w.run(['token']); assert.equal(r.code, 1, r.text);
  assert.match(r.text, /does not look like a GitHub token/); assert.ok(!r.text.includes('hunter2'));
  assert.throws(() => statSync(w.mac.at(tokenPath(cfg))));
});

test('PLANT no terminal (input piped) → refused with a plain message, nothing written', () => {
  const w = world(); w.mac.secretInput = null;
  const r = w.run(['token']); assert.equal(r.code, 1); assert.match(r.text, /no terminal/);
  assert.throws(() => statSync(w.mac.at(tokenPath(cfg))));
});

test('token run twice replaces the old file; the file is still 0600 and orchestrate\'s', () => {
  const w = world(); w.mac.secretInput = SECRET; assert.equal(w.run(['token']).code, 0);
  w.mac.secretInput = `${SECRET.slice(0, -4)}ZZZZ`; assert.equal(w.run(['token']).code, 0);
  assert.equal(readFileSync(w.mac.at(tokenPath(cfg)), 'utf8'), `${SECRET.slice(0, -4)}ZZZZ\n`);
  assert.deepEqual(failing(checkToken(w.mac, w.cfg)), []);
});

test('token needs root and the keys folder; without either it refuses and reads nothing', () => {
  const w = world(); w.mac.secretInput = SECRET; w.mac.as = 1234;
  assert.equal(w.run(['token']).code, 2); assert.equal(w.mac.secretPrompts.length, 0);
  w.mac.as = 0; rmSync(w.mac.at(`${BASE}/keys`), { recursive: true });
  const r = w.run(['token']); assert.equal(r.code, 1); assert.match(r.text, /is not there \(run users-folders first\)/); assert.equal(w.mac.secretPrompts.length, 0);
});

test('PLANT keys folder not orchestrate\'s own 0700 → token refuses (a token must not land where others can reach it)', () => {
  const w = world(); w.mac.secretInput = SECRET; chmodSync(w.mac.at(`${BASE}/keys`), 0o755);
  const r = w.run(['token']); assert.equal(r.code, 1); assert.match(r.text, /not orchestrate's own 0700 folder/); assert.equal(w.mac.secretPrompts.length, 0);
});

test('PLANT the token path is a link to a victim file → refused, the victim unchanged', () => {
  const w = world(); w.mac.secretInput = SECRET;
  const victim = w.mac.at('/victim.txt'); writeFileSync(victim, 'keep\n', { mode: 0o600 });
  symlinkSync(victim, w.mac.at(tokenPath(cfg)));
  const r = w.run(['token']); assert.equal(r.code, 1); assert.match(r.text, /not a plain file/); assert.equal(readFileSync(victim, 'utf8'), 'keep\n'); assert.equal(w.mac.secretPrompts.length, 0);
});

test('PLANT the token file readable by others (0644) → check-token FAILs on the mode; PLANT empty file → FAILs on the size', () => {
  const w = world(); w.mac.secretInput = SECRET; assert.equal(w.run(['token']).code, 0);
  chmodSync(w.mac.at(tokenPath(cfg)), 0o644);
  assert.match(failing(checkToken(w.mac, w.cfg)).map((r) => r.why).join(), /mode is 644, want 600/);
  chmodSync(w.mac.at(tokenPath(cfg)), 0o600); writeFileSync(w.mac.at(tokenPath(cfg)), '');
  assert.match(failing(checkToken(w.mac, w.cfg)).map((r) => r.why).join(), /size is not a token's/);
});

test('check-token without root SKIPs and says why; it never opens the file', () => {
  const w = world(); w.mac.as = 1234;
  const c = w.run(['check-token']); assert.equal(c.code, 0); assert.match(c.text, /SKIP .*needs root/);
});

test('unknown arguments are never echoed (a token pasted by mistake as an argument must not reach the screen)', () => {
  assert.throws(() => parseArgs(['token', '--config', 'x', SECRET]), (e) => !e.message.includes(SECRET) && /not one this command takes/.test(e.message));
});

// ───────────────────────────────────────────── the real tools, read only, on this Mac

const isDarwin = process.platform === 'darwin';

test('REAL: stty and the terminal read refuse cleanly when there is no terminal (this test has none)', { skip: !isDarwin }, () => {
  if (process.stdin.isTTY) return;   // run by hand in a terminal: this would wait for typing
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readSecretFromTty } from ${JSON.stringify(new URL('./mac.mjs', import.meta.url).href)}; try { readSecretFromTty('x'); } catch (e) { console.log(e.message); }`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  assert.ok(/no terminal|echo could not be turned off/.test(r.stdout), r.stdout + r.stderr);
});

test('REAL: ls -led and chmod -h parse the proposals access-list entry exactly (the tool\'s own wording on this Mac)', { skip: !isDarwin }, () => {
  const d = mkdtempSync(join(tmpdir(), 'extras-real-')); const f = join(d, 'p'); mkdirSync(f, { mode: 0o700 });
  const io = realIo();
  assert.equal(io.run('/bin/chmod', ['+a', 'user:daemon allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit', f]).status, 0);
  assert.deepEqual(aclEntries(io, f).entries, ['user:daemon allow directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search']);
  assert.equal(statSync(f).mode & 0o7777, 0o700);
});

test('REAL: git config --global --get-all of an unset key exits 1 (what planSafeDirectory relies on)', { skip: !isDarwin }, () => {
  const home = mkdtempSync(join(tmpdir(), 'extras-home-'));
  const r = spawnSync('/usr/bin/git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 1, r.stderr);
  const add = spawnSync('/usr/bin/git', ['config', '--global', '--add', 'safe.directory', '/x/mirror'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(add.status, 0, add.stderr);
  const got = spawnSync('/usr/bin/git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(got.stdout, '/x/mirror\n');
});
