// Tests for setup part 3: the ownerTaps folder, the proposals folders, the owner's git trusting the mirror, and the
// watch-only token file. Same stand-in Mac as the other setup tests (fake-mac.test-helper.mjs). PLANT tests break one clause
// each and name the check that catches it. The last tests run read-only tools on this Mac.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { DEFAULT_PROPOSALS_PARENT, ROOT_CONFIG_PATH, folderTable, mirrorPath, ownerTapsPath, parseConfig, proposalRows, proposalsParentOf } from './layout.mjs';
import { readSecretFromTty, realIo, writeNewFile } from './mac.mjs';
import { aclEntries, apply, check } from './users-folders.mjs';
import { proposalsProblem, checkProposals, checkSafeDirectory, checkToken, planProposals, planSafeDirectory, planToken, tokenPath, tokenProblem } from './extras.mjs';
import { main, parseArgs, planCommand } from './setup.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const BASE = '/Library/orch-test';
const RAW = { base: BASE, owner: 'sam', products: ['alpha', 'beta'] };
const cfg = parseConfig(RAW);
const SECRET = 'github_pat_11AAAAAAA0abcdefghijklmnop_QRSTUVWXYZ0123456789abcdef';   // a made-up one, never real
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };

function cfgFile(raw = RAW) { const d = tempDir('orch-extras-cfg-'); const f = join(d, 'c.json'); writeFileSync(f, JSON.stringify(raw)); return f; }

/** Root reads only the root-owned config at the fixed place; a run without root passes --config. Returns the argv. */
function withConfig(mac, file, raw, args) {
  if (mac.as !== 0) return [...args, '--config', file];
  const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return args;
}

/** The throwaway Mac with part 1 done, and the shared folder the proposals parent goes in. Every call the Mac saw is kept. */
function world({ raw = RAW } = {}) {
  const mac = fakeMac({ euid: 0 });
  mkdirSync(mac.at('/Users/Shared'), { recursive: true }); chmodSync(mac.at('/Users/Shared'), 0o1777); mac.owners.set('/Users/Shared', { uid: mac.rootUid, gid: 0 });   // as on a real Mac: root's, sticky
  const calls = []; const realRun = mac.run;
  mac.run = (cmd, args) => { calls.push([cmd, ...args]); return realRun(cmd, args); };
  const file = cfgFile(raw);
  const run = (args) => { const s = sink(); const code = main(withConfig(mac, file, raw, args), { io: mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') }; };
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
  assert.equal(w.mac.owners.get(ownerTapsPath(cfg)).uid, Number(w.mac.users.get('sam').UniqueID));
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
  const joe = Number(w.mac.users.get('sam').UniqueID);
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
  const c = w.run(['check-proposals']); assert.match(c.text, /NEEDS ROOT .*needs root/);
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
  assert.deepEqual(p.problems, []); assert.match(p.ops[0].text, /every folder above/); assert.match(p.ops[1].text, /check that .* is a plain folder/);
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
  assert.deepEqual(w.mac.gitSafe.get('sam'), [mirrorPath(cfg)]);
  const sudo = w.calls.filter((c) => c[2] === '-H' || c.includes('/usr/bin/git')).flat();
  assert.ok(sudo.includes('-u') && sudo.includes('sam'), 'git did not run as the owner');
  const n = w.mac.log.length; const again = w.run(['safe-directory']); assert.match(again.text, /nothing to do/); assert.equal(w.mac.log.length, n);
  assert.equal(w.run(['check-safe-directory']).code, 0);
});

test('PLANT safe.directory = * → refused with a plain sentence, nothing changed; the check FAILs', () => {
  const w = world(); w.mac.gitSafe.set('sam', ['*']);
  const r = w.run(['safe-directory']); assert.equal(r.code, 1); assert.match(r.text, /trusts more than the mirror/); assert.deepEqual(w.mac.gitSafe.get('sam'), ['*']);
  assert.match(failing(checkSafeDirectory(w.mac, w.cfg)).map((x) => x.why).join(), /more than the mirror/);
});

test('PLANT the mirror path missing → check-safe-directory FAILs; dry run prints the exact command and changes nothing', () => {
  const w = world();
  assert.match(failing(checkSafeDirectory(w.mac, w.cfg)).map((x) => x.why).join(), /not in its safe\.directory list/);
  const r = w.run(['safe-directory', '--dry-run']); assert.match(r.text, /would run: as sam: git config --global --add safe\.directory .*\/mirror/); assert.equal(w.mac.gitSafe.get('sam'), undefined);
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
  const c = w.run(['check-token']); assert.equal(c.code, 3); assert.match(c.text, /NEEDS ROOT .*needs root/);
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
  const d = tempDir('orch-extras-real-'); const f = join(d, 'p'); mkdirSync(f, { mode: 0o700 });
  const io = realIo();
  assert.equal(io.run('/bin/chmod', ['+a', 'user:daemon allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit', f]).status, 0);
  assert.deepEqual(aclEntries(io, f).entries, ['user:daemon allow directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search']);
  assert.equal(statSync(f).mode & 0o7777, 0o700);
});

test('REAL: git config --global --get-all of an unset key exits 1 (what planSafeDirectory relies on)', { skip: !isDarwin }, () => {
  const home = tempDir('orch-extras-home-');
  const r = spawnSync('/usr/bin/git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 1, r.stderr);
  const add = spawnSync('/usr/bin/git', ['config', '--global', '--add', 'safe.directory', '/x/mirror'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(add.status, 0, add.stderr);
  const got = spawnSync('/usr/bin/git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(got.stdout, '/x/mirror\n');
});

// ───────────────────────────────────────────── prove-token (L99 (3))

const RAWW = { ...RAW, watch: { repo: 'org/repo' } };
const GH_NO_WRITE = '{"message":"Resource not accessible by personal access token"}';
/** A stand-in for GitHub that refuses what GitHub refuses: no/wrong bearer → 401; the repo is private; the write answers what `write` says. */
function github(w, { write = 403, writeText = GH_NO_WRITE, writeRemaining, prs = [{ number: 7, title: 'A title' }], repo = { private: true, archived: false } } = {}) {
  w.mac.github = (url, init) => {
    if (init.headers.Authorization !== `Bearer ${SECRET}`) return { status: 401, text: '{"message":"Bad credentials"}' };
    const u = new URL(url);
    if (u.host !== 'api.github.com') return { status: 404, text: '' };
    if ((init.method ?? 'GET') === 'GET' && u.pathname === '/repos/org/repo') return { status: 200, text: JSON.stringify(repo) };
    if ((init.method ?? 'GET') === 'GET' && /^\/repos\/org\/repo\/pulls$/.test(u.pathname)) return { status: 200, text: JSON.stringify(prs) };
    if (init.method === 'PATCH' && /^\/repos\/org\/repo\/pulls\/7$/.test(u.pathname)) { w.patched = JSON.parse(init.body); return { status: write, text: writeText, rateRemaining: writeRemaining }; }
    return { status: 404, text: '' };
  };
}
const withToken = (raw = RAWW) => { const w = world({ raw }); w.raw = raw; w.mac.secretInput = SECRET; assert.equal(w.run(['token']).code, 0); return w; };
const prove = async (w, raw = w.raw ?? RAWW) => { const lines = []; const code = await main(withConfig(w.mac, w.file, raw, ['prove-token']), { io: w.mac, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }); return { code, text: lines.join('\n') }; };
const gets = (w) => w.mac.fetchLog.map((x) => x.method);

test('prove-token: private repo from the config, the read works, the no-op write is refused as "this token may not" → PASS; only fixed sentences and numbers are printed', async () => {
  const w = withToken(); github(w);
  const r = await prove(w);
  assert.equal(r.code, 0, r.text); assert.match(r.text, /PASS .*is a private repository/); assert.match(r.text, /PASS .*open pull requests works/); assert.match(r.text, /PASS .*pull request #7's title set to itself\) is refused because this token may not write/);
  assert.deepEqual(w.patched, { title: 'A title' });
  assert.deepEqual(gets(w), ['GET', 'GET', 'PATCH']);
  assert.ok(!r.text.includes(SECRET) && !r.text.includes('Resource not accessible'));
});

test('L150 m4 the token is read AS orchestrate (sudo -n -H -u orchestrate /bin/cat <file>), never by root through the name; the token is in no argument', async () => {
  const w = withToken(); github(w); const mark = w.calls.length;
  assert.equal((await prove(w)).code, 0);
  const cats = w.calls.slice(mark).filter((c) => c.includes('/bin/cat'));
  assert.deepEqual(cats, [['/usr/bin/sudo', '-n', '-H', '-u', 'orchestrate', '/bin/cat', tokenPath(cfg)]]);
  assert.ok(!w.calls.flat().some((x) => String(x).includes(SECRET)));
});

test('L150 m4 P7 the stand-in refuses `sudo -u` without -H, as the real one keeps the caller\'s home; every setup call passes -H', async () => {
  const w = world();
  assert.equal(w.mac.run('/usr/bin/sudo', ['-n', '-u', 'orchestrate', '/usr/bin/true']).status, 1);
  assert.equal(w.mac.run('/usr/bin/sudo', ['-n', '-H', '-u', 'orchestrate', '/usr/bin/true']).status, 0);
  assert.equal(w.run(['proposals']).code, 0); assert.equal(w.run(['check-proposals']).code, 0);   // these ride on asUser: they would fail without -H
});

test('L150 m4 the repo is the config\'s: --repo is gone, a config without watch.repo FAILs plainly, a bad one is refused when the config is read', async () => {
  assert.throws(() => parseArgs(['prove-token', '--repo', 'org/repo']), /not one this command takes/);
  let w = withToken(RAW); github(w); let r = await prove(w, RAW); assert.equal(r.code, 1); assert.match(r.text, /"watch": \{ "repo"/); assert.equal(w.mac.fetchLog.length, 0);
  for (const bad of ['../x', 'a', 'a/b/c', '', 5, 'a/..']) assert.throws(() => parseConfig({ ...RAW, watch: { repo: bad } }), /watch.repo must look like owner\/name/, String(bad));
  assert.throws(() => parseConfig({ ...RAW, watch: 'org/repo' }), /watch.repo/);
});

test('L150 m4 PLANT a public repository → FAIL (reading it proves nothing), no pull-request call, no write', async () => {
  const w = withToken(); github(w, { repo: { private: false, archived: false } });
  const r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /FAIL .*is a private repository.*public/); assert.deepEqual(gets(w), ['GET']);
});

test('L150 m4 PLANT an archived repository → FAIL (an archived repo refuses every write), no write tried', async () => {
  const w = withToken(); github(w, { repo: { private: true, archived: true } });
  const r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /FAIL .*is not archived/); assert.deepEqual(gets(w), ['GET']);
});

test('L150 c6 PLANT a rate-limit 403 or any other 403 is not proof → FAIL; only GitHub\'s "this token may not" answer passes', async () => {
  let w = withToken(); github(w, { writeText: '{"message":"API rate limit exceeded"}', writeRemaining: '0' });
  let r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /rate limit, which says nothing about the token/);
  w = withToken(); github(w, { writeText: '{"message":"API rate limit exceeded"}' });   // no header: still not the "may not" answer
  r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /not with its "this token may not write" answer/);
  w = withToken(); github(w, { writeText: '{"message":"Repository was archived so is read-only."}' });
  r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /not with its "this token may not write" answer/);
  w = withToken(); github(w, { write: 429, writeText: '{}' }); r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /rate limit/);
  assert.ok(!r.text.includes('Repository was archived'));
});

test('L150 m4 PLANT a token file that is a link, someone else\'s, or loose (0644) → FAIL before anything is read or sent', async () => {
  const f = (w) => w.mac.at(tokenPath(cfg));
  let w = withToken(); github(w); chmodSync(f(w), 0o644);
  let r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /mode is 644, not 600/);
  w = withToken(); github(w); w.mac.owners.set(tokenPath(cfg), { uid: 4242, gid: 4242 });
  r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /not orchestrate's/);
  w = withToken(); github(w); const real = f(w); const hidden = w.mac.at('/hidden-token'); writeFileSync(hidden, `${SECRET}\n`, { mode: 0o600 }); rmSync(real); symlinkSync(hidden, real);
  r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /it is a link/);
  for (const x of [w]) { assert.equal(x.mac.fetchLog.length, 0); assert.ok(!x.calls.flat().includes('/bin/cat')); }
});

test('L150 m4 prove-token needs root (the read is done as orchestrate) → without it, FAIL "run with sudo", nothing read or sent', async () => {
  const w = withToken(); github(w); w.mac.as = 1234;
  const r = await prove(w); assert.equal(r.code, 1, r.text); assert.match(r.text, /run with sudo/); assert.equal(w.mac.fetchLog.length, 0); assert.ok(!w.calls.flat().includes('/bin/cat'));
});

test('PLANT a token GitHub does not accept (the first look answers 401) → FAIL, nothing else is tried', async () => {
  const w = withToken(); github(w); w.mac.github = () => ({ status: 401, text: '' });
  const r = await prove(w); assert.equal(r.code, 1); assert.match(r.text, /answered 401/); assert.deepEqual(gets(w), ['GET']);
});

test('PLANT a token that CAN write (the no-op write answers 200) → FAIL that says to revoke it, exit 1', async () => {
  const w = withToken(); github(w, { write: 200 });
  const r = await prove(w); assert.equal(r.code, 1); assert.match(r.text, /FAIL .*THE WRITE WENT THROUGH.*Revoke it/);
});

test('PLANT any other answer to the write (404, 422, 500) is not proof → FAIL', async () => {
  for (const write of [404, 422, 500]) { const w = withToken(); github(w, { write }); const r = await prove(w); assert.equal(r.code, 1, String(write)); assert.match(r.text, new RegExp(`answered ${write}, not 403`)); }
});

test('prove-token: no open pull request (the advice names the config\'s repo), no network, no token file → each FAILs plainly; no write without a pull request', async () => {
  let w = withToken(); github(w, { prs: [] }); let r = await prove(w); assert.equal(r.code, 1); assert.match(r.text, /org\/repo has none open\. Open one there/); assert.deepEqual(gets(w), ['GET', 'GET']);
  w = withToken(); w.mac.github = null; r = await prove(w); assert.equal(r.code, 1); assert.match(r.text, /no answer \(ENOTFOUND\)/);
  w = world({ raw: RAWW }); w.raw = RAWW; github(w); r = await prove(w); assert.equal(r.code, 1); assert.match(r.text, /is not there/); assert.equal(w.mac.fetchLog.length, 0);
});

test('PLANT a token file holding something that is not a token → FAIL before any call is made', async () => {
  const w = withToken(); github(w); writeFileSync(w.mac.at(tokenPath(cfg)), 'not a token at all, just words that are long enough\n');
  const r = await prove(w); assert.equal(r.code, 1); assert.match(r.text, /does not look like one/); assert.equal(w.mac.fetchLog.length, 0);
});

// ───────────────────────────── L150 m1: a hard link at the token name can never get the victim chowned ─────────────────────────────

test('L150 m1 PLANT a hard link to a victim swapped in at the token name right after the old file is removed → the write refuses (exclusive create), the victim keeps its owner, mode and text', () => {
  const w = world(); w.mac.secretInput = SECRET;
  const victim = w.mac.at('/victim.txt'); writeFileSync(victim, 'keep\n', { mode: 0o644 }); w.mac.owners.set('/victim.txt', { uid: 4242, gid: 4242 });
  const unlink = w.mac.unlink.bind(w.mac);
  w.mac.unlink = (p) => { unlink(p); linkSync(victim, w.mac.at(p)); };   // the attacker wins the race
  const r = w.run(['token']); assert.equal(r.code, 1, r.text);
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n'); assert.equal(statSync(victim).mode & 0o777, 0o644);
  assert.deepEqual(w.mac.owners.get('/victim.txt'), { uid: 4242, gid: 4242 });
  assert.ok(!w.mac.log.some((x) => /^chown .* \/victim/.test(x)));
  assert.doesNotMatch(r.text, new RegExp(SECRET));
});

test('L150 m1 a hard link already at the token name is only removed as a name: the victim is untouched and the new token is a new file, orchestrate\'s 0600', () => {
  const w = world(); w.mac.secretInput = SECRET;
  const victim = w.mac.at('/victim.txt'); writeFileSync(victim, 'keep\n', { mode: 0o644 }); linkSync(victim, w.mac.at(tokenPath(cfg)));
  const r = w.run(['token']); assert.equal(r.code, 0, r.text);
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n'); assert.equal(statSync(victim).mode & 0o777, 0o644);
  assert.notEqual(statSync(victim).ino, statSync(w.mac.at(tokenPath(cfg))).ino);
  assert.deepEqual(failing(checkToken(w.mac, w.cfg)), []);
});

test('L150 m1 the token file is made in one call that carries the owner and mode (unlink, write, chown, chmod — nothing reopens the name)', () => {
  const w = world(); w.mac.secretInput = SECRET; const mark = w.mac.log.length;
  assert.equal(w.run(['token']).code, 0);
  const steps = w.mac.log.slice(mark).filter((x) => x.includes('watch-only-token'));
  assert.deepEqual(steps.map((x) => x.split(' ')[0]), ['unlink', 'write', 'chown', 'chmod']);
  assert.ok(!(w.mac.reopened ?? []).includes(tokenPath(cfg)), 'the token name was opened a second time to set its owner');
});

// ───────────────────────────── L150 m3: proposals runs inside the wall ─────────────────────────────

test('L150 m3 proposals: the base wall is the first step, and a folder above the proposals parent that others can write gives no steps', () => {
  const w = world();
  const p = planCommand(w.mac, w.cfg, { cmd: 'proposals' });
  assert.match(p.ops[0].text, /every folder above/);
  chmodSync(w.mac.at('/Library'), 0o777); chmodSync(w.mac.at('/Users/Shared'), 0o777);
  const q = planCommand(w.mac, w.cfg, { cmd: 'proposals' }); assert.deepEqual(q.ops, []); assert.match(q.problems.join(' '), /not safe for root to work in/);
  assert.match(proposalsProblem(w.mac, w.cfg), /is not sticky/); chmodSync(w.mac.at('/Users/Shared'), 0o1777); chmodSync(w.mac.at('/Users'), 0o777);
  assert.match(proposalsProblem(w.mac, w.cfg), /the folders above .* are not safe for root to work in/);   // the proposals' own check, apart from the base wall
});

test('L150 m3 PLANT a proposals parent others can write (0777, not sticky) → refused; sticky (1777) is accepted', () => {
  const w = world(); assert.equal(w.run(['proposals']).code, 0);
  chmodSync(w.mac.at(PARENT), 0o777);
  const r = w.run(['proposals']); assert.equal(r.code, 1, r.text); assert.match(r.text, /can be written by others than root .* not sticky/);
  chmodSync(w.mac.at(PARENT), 0o1777);
  assert.deepEqual(planProposals(w.mac, w.cfg).problems, []);
});

// ───────────────────────────── L150 m6 / m5: safe.directory in every scope, the wall on every root command, exclusive create ─────────────────────────────

test('L150 m6 PLANT a wildcard in any form ("/x/*", "/*", "*") in ANY scope (global, system, an include) → refused, nothing added, the check FAILs', () => {
  const m = mirrorPath(cfg);
  for (const bad of ['*', '/*', `${m.replace(/\/mirror$/, '')}/*`, '/Library/*']) {
    let w = world(); w.mac.gitSafe.set('sam', [bad]);   // the global file
    let r = w.run(['safe-directory']); assert.equal(r.code, 1, bad); assert.match(r.text, /trusts more than the mirror/); assert.deepEqual(w.mac.gitSafe.get('sam'), [bad]);
    assert.match(failing(checkSafeDirectory(w.mac, w.cfg)).map((x) => x.why).join(), /more than the mirror/);
    w = world(); w.mac.gitSafeOther = [bad];   // only the system file or an include holds it
    r = w.run(['safe-directory']); assert.equal(r.code, 1, `other scope: ${bad}`); assert.match(r.text, /whichever git settings file/); assert.equal(w.mac.gitSafe.get('sam'), undefined);
    w.mac.gitSafe.set('sam', [m]);   // the mirror is there too, but the wildcard still fails the check
    assert.equal(failing(checkSafeDirectory(w.mac, w.cfg)).length, 1);
  }
});

test('L150 m5 P20 a "*" sitting NEXT TO the mirror path still FAILs check-safe-directory (the mirror alone passes)', () => {
  const w = world(); const m = mirrorPath(cfg); w.mac.gitSafe.set('sam', [m]);
  assert.deepEqual(failing(checkSafeDirectory(w.mac, w.cfg)), []);
  w.mac.gitSafe.set('sam', [m, '*']); assert.equal(failing(checkSafeDirectory(w.mac, w.cfg)).length, 1);
  w.mac.gitSafe.set('sam', ['*', m]); assert.equal(failing(checkSafeDirectory(w.mac, w.cfg)).length, 1);
});

test('L150 m5 P13 P14 reload-account and token both run behind the folder-chain wall: a folder above the base others can write gives no steps and nothing is read', () => {
  for (const cmd of ['token', 'daemons']) {
    const w = world(); w.mac.secretInput = SECRET; chmodSync(w.mac.at('/Library'), 0o777);
    const o = cmd === 'token' ? { cmd: 'token' } : { cmd: 'daemons', sub: 'reload-account' };
    const p = planCommand(w.mac, w.cfg, o); assert.deepEqual(p.ops, [], cmd); assert.match(p.problems.join(' '), /not safe for root to work in/, cmd);
    assert.equal(w.mac.secretPrompts.length, 0);
  }
  const w = world(); w.mac.secretInput = SECRET;
  assert.match(planCommand(w.mac, w.cfg, { cmd: 'token' }).ops[0].text, /every folder above/);   // and the guard is the FIRST step
});

test('L150 m5 P22 a new file is made exclusively and never through a link: writeNewFile refuses a name that exists, and a link, whatever it points at', () => {
  const d = tempDir('orch-extras-wnf-'); const f = join(d, 'a'); const victim = join(d, 'victim');
  writeFileSync(victim, 'keep\n');
  writeNewFile(f, 'x', 0o600); assert.throws(() => writeNewFile(f, 'y', 0o600), /EEXIST/);
  symlinkSync(victim, join(d, 'link')); assert.throws(() => writeNewFile(join(d, 'link'), 'y', 0o600), /EEXIST|ELOOP/);
  symlinkSync(join(d, 'nowhere'), join(d, 'dangling')); assert.throws(() => writeNewFile(join(d, 'dangling'), 'y', 0o600), /EEXIST|ELOOP/);
  linkSync(victim, join(d, 'hard')); assert.throws(() => writeNewFile(join(d, 'hard'), 'y', 0o600), /EEXIST/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n');
  // with an owner: set on the open handle, before the first byte is written
  const order = []; const g = join(d, 'g');
  writeNewFile(g, 'secret', 0o600, { uid: 7, gid: 8, mode: 0o600 }, { chown: (fd, u, gi) => order.push(`chown ${u}:${gi} size=${statSync(g).size}`), chmod: (fd, m) => order.push(`chmod ${m.toString(8)} size=${statSync(g).size}`) });
  assert.deepEqual(order, ['chown 7:8 size=0', 'chmod 600 size=0']);
});

test('REAL: git config --includes --get-all of an unset key exits 1, and reads a value that sits in an included file (what the all-scopes read relies on)', { skip: !isDarwin }, () => {
  const home = tempDir('orch-extras-home2-'); const env = { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const none = spawnSync('/usr/bin/git', ['config', '--includes', '--get-all', 'safe.directory'], { encoding: 'utf8', env, cwd: home }); assert.equal(none.status, 1, none.stderr);
  writeFileSync(join(home, 'extra.cfg'), '[safe]\n\tdirectory = /y/*\n');
  assert.equal(spawnSync('/usr/bin/git', ['config', '--global', '--add', 'include.path', join(home, 'extra.cfg')], { encoding: 'utf8', env }).status, 0);
  const got = spawnSync('/usr/bin/git', ['config', '--includes', '--get-all', 'safe.directory'], { encoding: 'utf8', env, cwd: home }); assert.equal(got.stdout, '/y/*\n');
  const globalOnly = spawnSync('/usr/bin/git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8', env, cwd: home }); assert.equal(globalOnly.status, 1);   // --global alone never saw it
});

// ───────────────────────────── L173 ─────────────────────────────

test('L173 n1 prove-token says what it proved (pull requests only) and tells Joe to check the token page by eye; a FAIL prints no such note; nothing says "proves watch-only"', async () => {
  const w = withToken(); github(w);
  const r = await prove(w); assert.equal(r.code, 0, r.text);
  assert.match(r.text, /What this proved: the token cannot write pull requests\. It did not prove the token cannot change code/);
  assert.match(r.text, /Fine-grained tokens/); assert.match(r.text, /Contents = Read-only and Pull requests = Read-only, and nothing else/); assert.match(r.text, /only the one repository/);
  const bad = withToken(); github(bad, { write: 200 }); const f = await prove(bad);
  assert.equal(f.code, 1); assert.doesNotMatch(f.text, /What this proved/);
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /proves the token is watch-only/); assert.match(readme, /does not prove the token cannot change code/);
});

test('L173 n2 PLANT a hard link to a victim swapped in at the token name right AFTER the token is written → the victim keeps its owner, mode and text (nothing reopens the name)', () => {
  const w = world(); w.mac.secretInput = SECRET;
  const victim = w.mac.at('/victim2.txt'); writeFileSync(victim, 'keep\n', { mode: 0o644 }); w.mac.owners.set('/victim2.txt', { uid: 4242, gid: 4242 });
  const orig = w.mac.writeOwned.bind(w.mac);
  let swappedAt = -1;
  w.mac.writeOwned = (p, text, own) => { orig(p, text, own); rmSync(w.mac.at(p)); linkSync(victim, w.mac.at(p)); swappedAt = w.mac.log.length; };   // the attacker wins the race after the write
  const r = w.run(['token']); assert.ok(r.code === 0 || r.code === 1, r.text);
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n'); assert.equal(statSync(victim).mode & 0o777, 0o644);
  assert.deepEqual(w.mac.owners.get('/victim2.txt'), { uid: 4242, gid: 4242 });
  assert.ok(swappedAt > 0, 'the swap happened');
  assert.deepEqual(w.mac.log.slice(swappedAt).filter((x) => x.includes('watch-only-token')), [], 'nothing touched the token name after the swap');
  assert.doesNotMatch(r.text, new RegExp(SECRET));
});

test('L173 n3 PLANT the folder the proposals parent sits in belongs to someone else (mode 0755) → no steps, "is not root\'s"', () => {
  const w = world(); const up = dirname(proposalsParentOf(w.cfg));
  chmodSync(w.mac.at(up), 0o755); w.mac.owners.set(up, { uid: 4242, gid: 4242 });
  assert.match(proposalsProblem(w.mac, w.cfg), /is not root's, so someone else could swap what is inside it/);
  const p = planCommand(w.mac, w.cfg, { cmd: 'proposals' }); assert.deepEqual(p.ops, []); assert.match(p.problems.join(' '), /is not root's/);
});

test('L173 n4 REAL realIo.unlink: removes one name (a file, a link without touching its target, one of two hard links), is quiet when the name is gone, and REFUSES a folder without touching what is in it', () => {
  const d = tempDir('orch-unlink-'); const io = realIo({ prefix: d });
  writeFileSync(join(d, 'f'), 'x'); io.unlink('/f'); assert.ok(!existsSync(join(d, 'f')));
  writeFileSync(join(d, 'target'), 'keep'); symlinkSync(join(d, 'target'), join(d, 'ln')); io.unlink('/ln');
  assert.ok(!existsSync(join(d, 'ln'))); assert.equal(readFileSync(join(d, 'target'), 'utf8'), 'keep');
  linkSync(join(d, 'target'), join(d, 'hard')); io.unlink('/hard'); assert.equal(readFileSync(join(d, 'target'), 'utf8'), 'keep');
  io.unlink('/nothing-here');
  mkdirSync(join(d, 'dir')); writeFileSync(join(d, 'dir', 'inside'), 'precious');
  assert.throws(() => io.unlink('/dir'), /EISDIR|EPERM|EACCES/);
  assert.equal(readFileSync(join(d, 'dir', 'inside'), 'utf8'), 'precious');
});
