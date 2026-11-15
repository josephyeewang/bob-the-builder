// L1226, the runner side (L1252): a worker session's rules snapshot is root's worker-rules job's, and the worker runner only
// reads it, at each start (runner-main.mjs rootSnapshots) and in launch check 8 (runner-checks.mjs). Root's files can't be
// made here, so the file's owner is the test's own uid standing in for root (`owner`), as the hooks' tests do
// (M4 hooks/worker-snapshot.test.mjs); with root itself (the default, 0) the same file is refused as not root's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { workerChecks, workerSnapshotProblem } from './runner-checks.mjs';
import { checkRunnerConfig, rootSnapshots, workerCheckInputs } from './runner-main.mjs';
import { rulesText } from '../setup/worker-rules.mjs';
import { renderRoleSettings } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';

const ME = process.getuid();
const RULES = Object.freeze({ production: { env_files: ['/p/.env'], programs: ['vercel'], hosts: ['db.example.com'] } });
const OTHER_RULES = { production: { env_files: ['/p/.env'], programs: ['vercel'], hosts: ['db.example.com', 'more.example.com'] } };
const SHA = createHash('sha256').update('the bytes of worker-runner.json the runner read').digest('hex');
const OTHER_SHA = createHash('sha256').update('other bytes').digest('hex');

// A snapshot folder as root's job makes it (0755) holding p1's file (0644), the test's uid standing in for root.
async function place(fn) {
  const d = realpathSync.native(tempDir('orch-rootsnap-'));
  try {
    chmodSync(d, 0o755);
    const dir = join(d, 'worker-rules'); mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755);
    const path = join(dir, 'p1.json');
    const put = (text, mode = 0o644) => { rmSync(path, { force: true }); writeFileSync(path, text); chmodSync(path, mode); };
    put(rulesText('p1', RULES, SHA));
    return await fn({ d, dir, path, put });
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const ask = (path, o = {}) => workerSnapshotProblem({ path, product: 'p1', rules: RULES, sourceSha256: SHA, ...o }, { owner: ME });

test('L1226 control: root\'s file, fresh, p1\'s, the runner\'s rules, from the bytes it read: no problem; with root itself the same file is not root\'s', () => place(({ path }) => {
  assert.equal(ask(path), null);
  assert.match(workerSnapshotProblem({ path, product: 'p1', rules: RULES, sourceSha256: SHA }), /the worker sessions' rules snapshot .* is not root's alone \(it must be owned by root and written by no one else\)|the folder .* above the worker sessions' rules snapshot .* is not root's alone/,
    'plant 1: a file the builder owns (the runner writing it again, the old way) is refused under the real owner');
}));

test('L1226 plants 2–5, 11: the reader\'s own refusals reach the runner: 0664, 0646, a folder others can write, a link at the name, a hard link, 61 s ahead', () => place(({ d, dir, path, put }) => {
  put(rulesText('p1', RULES, SHA), 0o664); assert.match(ask(path), /is not root's alone/, 'plant 2: 0664');
  put(rulesText('p1', RULES, SHA), 0o646); assert.match(ask(path), /is not root's alone/, 'plant 2: 0646');
  put(rulesText('p1', RULES, SHA));
  chmodSync(dir, 0o775); assert.match(ask(path), new RegExp(`the folder ${dir} above the worker sessions' rules snapshot .*is not root's alone`), 'plant 3: group-writable folder');
  chmodSync(dir, 0o755); assert.equal(ask(path), null, 'control again');
  const real = join(d, 'elsewhere.json'); writeFileSync(real, rulesText('p1', RULES, SHA)); chmodSync(real, 0o644);
  rmSync(path); symlinkSync(real, path); assert.match(ask(path), /missing or unreadable/, 'plant 4: a link at the name is never followed');
  rmSync(path); put(rulesText('p1', RULES, SHA)); linkSync(path, join(d, 'second-name.json'));
  assert.match(ask(path), /has 2 names \(a hard link\)/, 'plant 5: a hard link');
  rmSync(join(d, 'second-name.json')); assert.equal(ask(path), null);
  put(rulesText('p1', RULES, SHA, new Date(Date.now() + 61_000))); assert.match(ask(path), /from the future/, 'plant 11: 61 s ahead');
}));

test('L1252 (b), plant 6: a snapshot root\'s job stopped refreshing (5 min + 1 s old) holds; one 4 min 59 s old passes', () => place(({ path, put }) => {
  put(rulesText('p1', RULES, SHA, new Date(Date.now() - 301_000))); assert.match(ask(path), /rules snapshot is stale \(30\d s old, the limit is 300 s\)/);
  put(rulesText('p1', RULES, SHA, new Date(Date.now() - 299_000))); assert.equal(ask(path), null);
}));

test('L1226 plants 7–9, L1252 (c): other rules, another product\'s root file at p1\'s path, and a root\'s fresh file from other config bytes each hold p1', () => place(({ path, put }) => {
  put(rulesText('p1', OTHER_RULES, SHA)); assert.match(ask(path), /holds other rules than the runner's config/, 'plant 7');
  // (c) another product's root file at the right path: the very rules and bytes too, so only the product tells it apart.
  put(rulesText('p2', RULES, SHA)); assert.equal(ask(path), 'the rules snapshot is for "p2", not p1', 'plant 8');
  put(`${JSON.stringify({ ...JSON.parse(rulesText('p1', RULES, SHA)), product: undefined })}\n`); assert.equal(ask(path), 'the rules snapshot is for no product, not p1');
  // (c) root's and fresh, the same rules, but written from another read of the config.
  put(rulesText('p1', RULES, OTHER_SHA)); assert.match(ask(path), /written from other bytes of worker-runner\.json than the runner read/, 'plant 9');
  put(rulesText('p1', RULES, SHA)); assert.equal(ask(path), null);
}));

test('L1226: the runner\'s side must be whole: no source hash (a config not read through one handle), no rules, no path each refuse', () => place(({ path }) => {
  for (const s of [null, undefined, '', 'abc', SHA.toUpperCase()]) assert.match(ask(path, { sourceSha256: s }), /not read from its file through one handle/, String(s));
  assert.match(ask(path, { rules: undefined }), /no rules/);
  assert.match(ask(undefined), /no rules snapshot is named/);
}));

// The session's settings as the start port renders them for a worker, naming this test's snapshot.
const settingsFor = (snapshot, snapshotOwner) => {
  const r = renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role: 'worker', profile: DESIGN_PROFILES.worker, rulesHosts: [],
    product: { commands: { test: 'npm test' } },
    paths: { copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot, node: '/w/node', notes: '/w/notes',
      deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: [] },
      ...(snapshotOwner === undefined ? {} : { snapshotOwner }) } });
  assert.equal(r.ok, true, r.reason);
  return r.settings;
};
const check8 = (x, o = {}) => workerChecks({ product: 'p1', rules: RULES, sourceSha256: SHA, ...x }, { snapshotOwner: ME, ...o })[8]();

test('L1250 m2 / L1251 m4, plant 10: check 8 takes the session only when every hook reads that snapshot as its owner\'s alone; undefined, another uid or a mix is refused', async () => place(async ({ path }) => {
  const ok = await check8({ snapshot: path, settings: { settings: settingsFor(path, ME) } });
  assert.deepEqual(ok, { ok: true }, 'control');
  const none = await check8({ snapshot: path, settings: { settings: settingsFor(path) } });
  assert.equal(none.ok, false); assert.match(none.reason, /must name --snapshot-owner \d+; none names an owner/, 'plant 10: the owner word dropped');
  const other = await check8({ snapshot: path, settings: { settings: settingsFor(path, ME + 1) } });
  assert.match(other.reason, new RegExp(`must name --snapshot-owner ${ME}; they name ${ME + 1}`));
  // L1251 m4: every hook names 501 (the owner's uid on the Mini), checked with the real owner, root: refused before the file is read.
  const s501 = await check8({ snapshot: path, settings: { settings: settingsFor(path, 501) } }, { snapshotOwner: 0 });
  assert.match(s501.reason, /must name --snapshot-owner 0; they name 501/);
  const s0 = await check8({ snapshot: path, settings: { settings: settingsFor(path, 0) } }, { snapshotOwner: 0 });
  assert.match(s0.reason, /is not root's alone/, 'hooks right, then the file itself is held to root');
  // One hook differs: the owner can't be read as one.
  const mixed = settingsFor(path, ME); const first = Object.values(mixed.hooks)[0][0].hooks[0];
  first.command = first.command.replace(` --snapshot-owner ${ME}`, '');
  assert.match((await check8({ snapshot: path, settings: { settings: mixed } })).reason, /they differ, or one names it twice or not as a uid/);
  // Hooks that read another snapshot than the runner's.
  assert.match((await check8({ snapshot: path, settings: { settings: settingsFor(`${path}x`, ME) } })).reason, /hooks do not read root's rules snapshot/);
}));

test('L1252 (b): check 8 says a stale snapshot\'s reason, and has no port without a snapshot or rules; it never writes the file', async () => place(async ({ path, put }) => {
  put(rulesText('p1', RULES, SHA, new Date(Date.now() - 301_000)));
  const r = await check8({ snapshot: path, settings: { settings: settingsFor(path, ME) } });
  assert.equal(r.ok, false); assert.match(r.reason, /rules snapshot is stale/);
  assert.equal(workerChecks({ product: 'p1', rules: RULES, sourceSha256: SHA })[8], undefined, 'no snapshot, no port');
  assert.equal(workerChecks({ product: 'p1', snapshot: path, sourceSha256: SHA })[8], undefined, 'no rules, no port');
  // The config's inputs carry the config's source hash and no writer (the runner writes no snapshot).
  const c = { sourceSha256: SHA, products: { p1: { mirror: '/m', rules: RULES, render: { paths: { snapshot: path, hooksDir: '/w/hooks' } } } } };
  const x = workerCheckInputs(c, { product: 'p1' });
  assert.equal(x.sourceSha256, SHA); assert.equal(x.snapshot, path); assert.equal('writeSnapshot' in x, false);
}));

test('L1252 (b): rootSnapshots holds a product whose snapshot fails, failing closed; each reason told once per product, again when it changes; a pass told as root\'s, fresh, matches', () => place(({ path }) => {
  const c = { sourceSha256: SHA, products: { p1: { rules: RULES, render: { paths: { snapshot: path } } }, p2: { rules: RULES, render: { paths: { snapshot: `${path}.p2` } } }, p3: { render: { paths: {} } } } };
  const logs = []; let answer = { p1: null, p2: null };
  const s = rootSnapshots(c, { log: (t) => logs.push(t), problem: (x) => answer[x.product] });
  assert.equal(s.held('p1'), null); assert.equal(s.held('p1'), null);
  assert.deepEqual(logs, ['product p1\'s rules snapshot: root\'s, fresh, matches'], 'a pass told once');
  answer.p1 = 'rules snapshot is stale (301 s old, …)';
  assert.equal(s.held('p1'), 'product p1\'s rules snapshot: rules snapshot is stale (301 s old, …), so its sessions are not started');
  s.held('p1'); s.held('p1');
  answer.p2 = 'rules snapshot is stale (301 s old, …)'; s.held('p2');
  assert.equal(logs.filter((l) => /p1.*stale/.test(l)).length, 1, 'once per reason');
  assert.equal(logs.filter((l) => /p2.*stale/.test(l)).length, 1, 'per product: p2 told its own');
  answer.p1 = 'the rules snapshot is for "p2", not p1'; s.held('p1');
  answer.p1 = 'rules snapshot is stale (301 s old, …)'; s.held('p1');
  assert.equal(logs.filter((l) => /p1.*stale/.test(l)).length, 2, 'told again when the reason changes back');
  answer.p1 = null; assert.equal(s.held('p1'), null);
  assert.equal(logs.filter((l) => /p1.*root's, fresh, matches/.test(l)).length, 2, 'the pass after a hold is told');
  const thrower = rootSnapshots(c, { problem: () => { throw new Error('boom'); } });
  assert.match(thrower.held('p1'), /it can't be checked \(boom\)/, 'a check that throws holds');
  assert.equal(s.held('p3'), null, 'a product with no snapshot or rules is not held here: check 8 has no port for it, so it starts nothing');
  // The real check, with root as owner: the test's own file is not root's, so p1 is held.
  const real = rootSnapshots(c);
  assert.match(real.held('p1'), /p1's rules snapshot: .*not root's alone/);
}));

test('L1250 m2 / L1251 m4: the config names a snapshot only with snapshotOwner 0, and the owner only with a snapshot', () => {
  const DENY = { record: '/x/record', ssh: '/x/h/.ssh', gh: '/x/h/.config/gh', claudeHome: '/x/h/.claude', robotKeys: '/x/keys', secrets: ['/x/secrets'] };
  const cfg = (paths) => ({ installRoot: '/x/install', requestsDir: '/x/requests', statusFile: '/x/runner/status.json', orchestrateUid: 501, outboxRoot: '/x/outboxes', copiesRoot: '/x/copies',
    home: '/x/h', path: '/usr/bin:/bin', claudeBin: '/x/install/claude', recordRoot: '/x/record', recordUid: 501, claimMs: 600_000,
    products: { p1: { repo: 'o/p1', mirror: '/x/mirror', render: { paths: { deny: DENY, ...paths } } } } });
  assert.doesNotThrow(() => checkRunnerConfig(cfg({ snapshot: '/x/worker-rules/p1.json', snapshotOwner: 0 })));
  assert.doesNotThrow(() => checkRunnerConfig(cfg({})), 'neither: no check 8 port, so nothing starts');
  for (const o of [undefined, 501, -1, '0', 0.5, null]) assert.throws(() => checkRunnerConfig(cfg({ snapshot: '/x/worker-rules/p1.json', ...(o === undefined ? {} : { snapshotOwner: o }) })), /snapshotOwner must be 0/, String(o));
  assert.throws(() => checkRunnerConfig(cfg({ snapshotOwner: 0 })), /snapshotOwner is given with no render\.paths\.snapshot/);
});
