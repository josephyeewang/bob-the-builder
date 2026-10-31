// The account switch's Bob script (R-1-89 (a), (b)), in throwaway home folders only: no real sign-in is read or
// touched, and `status` runs a fake `claude` that prints made-up answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { ACCOUNTS, ACCOUNT_FILE, OWN, accountEnv, accountInUse, isSetUp, readAuthStatus, setupSecondFolder, useAccount } from './accounts.mjs';
import { checkRoleEnv, roleEnv } from './env-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'accounts.mjs');
const lstat = (p) => { try { return lstatSync(p); } catch { return null; } };

// The links the second folder must have, in the order they are made: named here, not taken from the code (L61 (2)).
const LINKS = ['hooks', 'settings.json', 'settings.local.json', 'skills', 'agents', 'commands', 'plugins', 'keybindings.json',
  'CLAUDE.md', 'projects'];
const sorted = (a) => [...a].sort();

// A home folder as a Mac user's looks: the first folder with everything the second one shares, plus a sign-in file
// and the settings file Claude keeps beside the first folder. The sign-in files are made unreadable: nothing here may
// need to read them. `firstAsLink`: `~/.claude` is a link to a real folder elsewhere in the home (L61 (5)).
function home({ without = [], firstAsLink = false } = {}) {
  const h = realpathSync(tempDir('m4-acct-'));
  const A = join(h, ACCOUNTS.a);
  if (firstAsLink) { mkdirSync(join(h, 'real-first')); symlinkSync(join(h, 'real-first'), A); }
  mkdirSync(join(A, 'hooks'), { recursive: true });
  for (const d of ['skills', 'agents', 'commands', 'plugins', 'projects']) if (!without.includes(d)) mkdirSync(join(A, d));
  for (const f of ['CLAUDE.md', 'keybindings.json', 'settings.local.json']) if (!without.includes(f)) writeFileSync(join(A, f), '{}\n');
  writeFileSync(join(A, 'hooks', 'mark.sh'), '#!/bin/sh\n: > "$MARKS/$1.$ACCT"\n', { mode: 0o755 });
  writeFileSync(join(A, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: '~/.claude/hooks/mark.sh tilde' },
        { type: 'command', command: '"$HOME/.claude/hooks/mark.sh" home' },
        { type: 'command', command: '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/mark.sh" configdir' },
      ] }],
      Stop: [{ hooks: [{ type: 'command', command: `/bin/sh ${join(A, 'hooks', 'mark.sh')} absolute` }] }],
    },
  }));
  for (const f of [join(A, '.credentials.json'), join(h, '.claude.json')]) { writeFileSync(f, '{}\n'); chmodSync(f, 0o000); }
  return { h, A, B: join(h, ACCOUNTS.b) };
}
const entries = (dir) => readdirSync(dir).sort().map((n) => { const st = lstatSync(join(dir, n)); return [n, st.isSymbolicLink() ? readlinkSync(join(dir, n)) : st.isDirectory() ? 'folder' : 'file']; });

test('accounts setup: the second folder links what it shares to the first folder, and never the sign-in', () => {
  const { h, A, B } = home();
  const r = setupSecondFolder({ home: h });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.made, LINKS, 'every link, in the fixed order');
  assert.equal(lstatSync(B).mode & 0o777, 0o700, 'the second folder is the user\'s alone');
  // Exactly the shared names, each a link to the first folder's own: nothing else, so no sign-in file is linked.
  assert.deepEqual(entries(B), sorted(LINKS).map((n) => [n, join(A, n)]));
  for (const own of OWN) assert.equal(lstat(join(B, own)), null, `${own} is not in the second folder`);
  for (const [n] of entries(B)) assert.ok(!OWN.some((o) => realpathSync(join(B, n)).endsWith(o)), `${n} leads to no sign-in file`);
  // A shared name missing from the first folder is left out, and named.
  const k = home({ without: ['plugins'] });
  const r2 = setupSecondFolder({ home: k.h });
  assert.deepEqual(r2.skipped, ['plugins']);
  assert.equal(lstat(join(k.B, 'plugins')), null);
});

test('accounts setup: running it twice changes nothing', () => {
  const { h, B } = home();
  assert.equal(setupSecondFolder({ home: h }).ok, true);
  const before = entries(B);
  const r = setupSecondFolder({ home: h });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.made, []);
  assert.deepEqual(r.kept, LINKS);
  assert.deepEqual(entries(B), before);
});

test('accounts setup: a folder that can\'t be written is refused plainly, and a second run finishes a partial setup', () => {
  // The home can't be written: the second folder can't be made.
  const k = home();
  chmodSync(k.h, 0o555);
  let r;
  try { r = setupSecondFolder({ home: k.h }); } finally { chmodSync(k.h, 0o755); }
  assert.equal(r.ok, false);
  assert.match(r.reason, /^could not write in ~\/\.claude-b \(EACCES\): 0 of 10 new links made; make the folder writable, then run setup again to finish$/);
  assert.equal(lstat(k.B), null);
  // The second folder is there and read-only: nothing is made, and the message says so.
  const { h, A, B } = home();
  mkdirSync(B, { mode: 0o500 });
  try { r = setupSecondFolder({ home: h }); } finally { chmodSync(B, 0o700); }
  assert.match(r.reason, /^could not write in ~\/\.claude-b \(EACCES\): 0 of 10 new links made;/);
  assert.deepEqual(readdirSync(B), []);
  // A setup cut short after three links: the next run keeps those and makes the rest, in order.
  for (const n of LINKS.slice(0, 3)) symlinkSync(join(A, n), join(B, n));
  r = setupSecondFolder({ home: h });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.kept, LINKS.slice(0, 3));
  assert.deepEqual(r.made, LINKS.slice(3));
  assert.deepEqual(entries(B), sorted(LINKS).map((n) => [n, join(A, n)]));
});

test('accounts setup: ~/.claude may be a link to a folder the same user owns', () => {
  const { h, A, B } = home({ firstAsLink: true });
  const r = setupSecondFolder({ home: h });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.made, LINKS);
  // The links go through ~/.claude, so they follow it if it is pointed elsewhere.
  assert.deepEqual(entries(B), sorted(LINKS).map((n) => [n, join(A, n)]));
  assert.equal(realpathSync(join(B, 'hooks')), join(h, 'real-first', 'hooks'));
  assert.equal(isSetUp(h, 'a'), true);
  assert.equal(accountInUse({ home: h }).account, 'a');
  assert.equal(setupSecondFolder({ home: h }).made.length, 0, 'twice changes nothing');
  // A link that leads nowhere, to a file, or to the second folder is refused, and nothing is made.
  for (const [what, make, want] of [
    ['nowhere', (x) => symlinkSync(join(x.h, 'gone'), x.A), /nothing changed: ~\/\.claude is a link that leads nowhere/],
    ['a file', (x) => { writeFileSync(join(x.h, 'f'), 'x'); symlinkSync(join(x.h, 'f'), x.A); }, /nothing changed: ~\/\.claude is a link to something that is not a folder/],
    ['the second folder', (x) => { mkdirSync(x.B, { mode: 0o700 }); symlinkSync(x.B, x.A); }, /nothing changed: ~\/\.claude leads to ~\/\.claude-b/],
  ]) {
    const x = { h: realpathSync(tempDir('m4-acct-')) };
    x.A = join(x.h, ACCOUNTS.a);
    x.B = join(x.h, ACCOUNTS.b);
    make(x);
    const before = readdirSync(x.h).sort();
    assert.match(setupSecondFolder({ home: x.h }).reason, want, what);
    assert.deepEqual(readdirSync(x.h).sort(), before, `${what}: nothing made`);
    if (lstat(x.B)) assert.deepEqual(readdirSync(x.B), []);
  }
});

test('accounts setup (L63 m5): ~/.claude as a link to a folder another user owns is refused, and nothing changes', () => {
  // The owner check is handed the user, so a test can stand in for another user without admin rights.
  const { h, A } = home({ firstAsLink: true });
  const own = statSync(join(h, 'real-first')).uid;
  const before = readdirSync(h).sort();
  for (const other of [own + 1, 0 === own ? 1 : 0]) {
    assert.deepEqual(setupSecondFolder({ home: h, uid: other }), { ok: false, reason: 'nothing changed: ~/.claude is a link to a folder another user owns' }, `uid ${other}`);
    assert.deepEqual(readdirSync(h).sort(), before, 'no second folder made');
  }
  // The same link, owned by the user setting up: accepted. A plain folder is never checked by owner (it is the home's).
  assert.equal(setupSecondFolder({ home: h, uid: own }).ok, true);
  assert.equal(lstat(A).isSymbolicLink(), true);
  const plain = home();
  assert.equal(setupSecondFolder({ home: plain.h, uid: own + 1 }).ok, true);
});

test('accounts setup: a target that is there and is not the expected link is refused, and nothing changes', () => {
  for (const n of LINKS) {
    for (const plant of ['file', 'folder', 'other link']) {
      const { h, B } = home();
      mkdirSync(B, { mode: 0o700 });
      if (plant === 'file') writeFileSync(join(B, n), 'x');
      else if (plant === 'folder') mkdirSync(join(B, n));
      else symlinkSync(join(h, 'elsewhere'), join(B, n));
      const before = entries(B);
      const r = setupSecondFolder({ home: h });
      assert.equal(r.ok, false, `${n} as a ${plant}`);
      assert.match(r.reason, new RegExp(`nothing changed: .*${n.replace('.', '\\.')} is there and is not the link`));
      assert.deepEqual(entries(B), before, `${n} as a ${plant}: nothing else made`);
    }
  }
  // The second folder itself as a link to the first would share the sign-in.
  const k = home();
  symlinkSync(k.A, k.B);
  assert.match(setupSecondFolder({ home: k.h }).reason, /not a folder/);
  assert.equal(readlinkSync(k.B), k.A);
  // A sign-in file in the second folder that is a link.
  for (const own of OWN) {
    const m = home();
    mkdirSync(m.B, { mode: 0o700 });
    symlinkSync(join(m.h, '.claude.json'), join(m.B, own));
    const before = entries(m.B);
    assert.match(setupSecondFolder({ home: m.h }).reason, new RegExp(`${own.replace('.', '\\.')} is a link: the two accounts would share a sign-in`));
    assert.deepEqual(entries(m.B), before);
  }
  // A shared name in the second folder whose original is gone.
  const g = home({ without: ['skills'] });
  mkdirSync(g.B, { mode: 0o700 });
  mkdirSync(join(g.B, 'skills'));
  assert.match(setupSecondFolder({ home: g.h }).reason, /skills is there but ~\/\.claude\/skills is not/);
});

test('accounts setup: every hook in the linked settings resolves and fires in both folders', () => {
  const { h, A, B } = home();
  assert.equal(setupSecondFolder({ home: h }).ok, true);
  const marks = join(h, 'marks');
  mkdirSync(marks);
  const commands = (dir) => {
    const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return Object.values(s.hooks).flat().flatMap((m) => m.hooks.map((x) => x.command));
  };
  assert.equal(realpathSync(join(B, 'settings.json')), join(A, 'settings.json'));
  assert.equal(realpathSync(join(B, 'hooks', 'mark.sh')), join(A, 'hooks', 'mark.sh'));
  let ran = 0;
  for (const [acct, dir] of [['a', A], ['b', B]]) {
    const cmds = commands(dir);
    assert.equal(cmds.length, 4);
    for (const cmd of cmds) {
      // As Claude Code runs a hook: a shell, in the account's environment (account a with the folder variable unset).
      const env = { HOME: h, PATH: '/usr/bin:/bin', MARKS: marks, ACCT: acct, ...(acct === 'b' ? { CLAUDE_CONFIG_DIR: B } : {}) };
      const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: h, env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      assert.equal(r.status, 0, `${acct}: ${cmd}: ${r.stderr}`);
      ran += 1;
    }
  }
  assert.equal(ran, 8);
  assert.deepEqual(readdirSync(marks).sort(), ['absolute', 'configdir', 'home', 'tilde'].flatMap((n) => [`${n}.a`, `${n}.b`]).sort());
});

test('accounts use: one file names the account in use; a or b only, and only once its folder is set up', () => {
  const { h } = home();
  assert.equal(accountInUse({ home: h }).account, 'a', 'no file means the first account');
  assert.match(useAccount({ home: h, name: 'b' }).reason, /not set up; run setup first/);
  assert.match(useAccount({ home: h, name: 'c' }).reason, /use a or b/);
  assert.equal(lstat(join(h, ACCOUNT_FILE)), null, 'a refused use writes nothing');
  assert.equal(setupSecondFolder({ home: h }).ok, true);
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  assert.equal(readFileSync(join(h, ACCOUNT_FILE), 'utf8'), 'b\n');
  assert.deepEqual(accountInUse({ home: h }), { account: 'b', dir: join(h, ACCOUNTS.b), env: { CLAUDE_CONFIG_DIR: join(h, ACCOUNTS.b) } });
  assert.equal(useAccount({ home: h, name: 'a' }).ok, true);
  assert.deepEqual(accountInUse({ home: h }), { account: 'a', dir: join(h, ACCOUNTS.a), env: {} });
  writeFileSync(join(h, ACCOUNT_FILE), 'z\n');
  assert.match(accountInUse({ home: h }).reason, /names neither a nor b/);
  // Run as the script, as Joe would.
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { env: { HOME: h, PATH: '/usr/bin:/bin' }, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const u = run('use', 'b');
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, /New sessions start on account b\. Sessions already running keep their account/);
  assert.equal(run('use', 'x').status, 1);
  assert.equal(readFileSync(join(h, ACCOUNT_FILE), 'utf8'), 'b\n');
  assert.equal(run('setup').status, 0, 'setup run twice from the script');
});

test('accounts status: each folder signed in or not and the plan, and no token, address or raw answer', () => {
  const { h } = home();
  const fake = join(h, 'fake');
  mkdirSync(fake);
  // A made-up token, built at run time so no file holds one.
  const token = ['sk', 'ant', 'oat01', 'Q'.repeat(48)].join('-');
  const email = ['someone', 'example.com'].join('@');
  const answers = {
    a: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', configDirectory: join(h, ACCOUNTS.a), email, orgId: 'org-123', orgName: 'Some Org', accessToken: token },
    bIn: { loggedIn: true, authMethod: token, subscriptionType: token, configDirectory: '/somewhere/else', email },
    bOut: { loggedIn: false, authMethod: 'none', configDirectory: join(h, ACCOUNTS.b), refreshToken: token },
  };
  for (const [k, v] of Object.entries(answers)) writeFileSync(join(fake, `${k}.json`), JSON.stringify(v));
  const claude = join(fake, 'claude');
  // Not signed in exits 1, as the real one does; any other call is refused.
  writeFileSync(claude, `#!/bin/sh\n[ "$*" = "auth status --json" ] || exit 9\nif [ -z "$CLAUDE_CONFIG_DIR" ]; then cat "${fake}/a.json"; else cat "${fake}/$(cat "${fake}/which")"; [ "$(cat "${fake}/which")" = bOut.json ] && exit 1; fi\nexit 0\n`, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, [SCRIPT, 'status', '--claude', claude], { env: { HOME: h, PATH: '/usr/bin:/bin' }, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const clean = (out) => {
    for (const bad of [token, email, 'org-123', 'Some Org', '/somewhere/else', '{', '"']) assert.ok(!out.includes(bad), `status printed ${JSON.stringify(bad)}:\n${out}`);
  };
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  clean(r.stdout + r.stderr);
  assert.match(r.stdout, /^Account in use: a$/m);
  assert.match(r.stdout, /^\* a {2}~\/\.claude +signed in \(claude\.ai\), plan: max$/m);
  assert.match(r.stdout, /^ {2}b {2}~\/\.claude-b +not set up$/m);
  assert.equal(setupSecondFolder({ home: h }).ok, true);
  writeFileSync(join(fake, 'which'), 'bOut.json');
  r = run();
  clean(r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}b {2}~\/\.claude-b +not signed in$/m);
  writeFileSync(join(fake, 'which'), 'bIn.json');
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  r = run();
  clean(r.stdout + r.stderr);
  assert.match(r.stdout, /^\* b {2}~\/\.claude-b +signed in, plan: unknown; Claude reports a different folder$/m);
  // An answer that is not JSON is not shown either.
  writeFileSync(join(fake, 'which'), 'raw.txt');
  writeFileSync(join(fake, 'raw.txt'), `token=${token}\n`);
  r = run();
  clean(r.stdout + r.stderr);
  assert.match(r.stdout, /b {2}~\/\.claude-b +sign-in unknown/);
});

test('accounts: the launcher\'s role environment carries the folder for account b only', () => {
  const h = '/home-x';
  // A folder variable set where the launcher runs never reaches account a's session: roleEnv keeps its own short list.
  const base = { HOME: h, USER: 'u', CLAUDE_CONFIG_DIR: '/stray', PATH: '/x' };
  const a = roleEnv(base, { path: '/usr/bin:/bin', extra: accountEnv(h, 'a') });
  assert.equal(Object.hasOwn(a, 'CLAUDE_CONFIG_DIR'), false);
  const b = roleEnv(base, { path: '/usr/bin:/bin', extra: accountEnv(h, 'b') });
  assert.equal(b.CLAUDE_CONFIG_DIR, join(h, ACCOUNTS.b));
  assert.deepEqual(checkRoleEnv(a), { ok: true });
  assert.deepEqual(checkRoleEnv(b), { ok: true }, 'the folder variable is not a key');
  for (const v of Object.values(b)) assert.equal(typeof v, 'string');
});

test('accounts status: the answer is read for its four known fields only, so nothing else can come through', () => {
  const token = ['sk', 'ant', 'oat01', 'Z'.repeat(40)].join('-');
  const keys = ['readable', 'signedIn', 'method', 'plan', 'folderMatches'];
  const r = readAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', configDirectory: '/d', plan: token, accessToken: token, nested: { loggedIn: true } }), '/d');
  assert.deepEqual(r, { readable: true, signedIn: true, method: 'claude.ai', plan: 'pro', folderMatches: true });
  assert.deepEqual(Object.keys(r), keys);
  assert.ok(!JSON.stringify(r).includes(token));
  // Signed in only when the answer itself says so: not from a nested or inherited field, not from a list.
  assert.equal(readAuthStatus('{"nested":{"loggedIn":true}}', '/d').signedIn, false);
  assert.equal(readAuthStatus('{"__proto__":{"loggedIn":true}}', '/d').signedIn, false);
  assert.deepEqual(readAuthStatus('[{"loggedIn":true}]', '/d'), { readable: false });
  assert.deepEqual(readAuthStatus('"signed in"', '/d'), { readable: false });
  assert.equal(readAuthStatus('{"loggedIn":"true"}', '/d').signedIn, false, 'the word, not the value true, is not signed in');
});
