// L83 M-3 (audit R-0b-147): a review session goes through the same launch() every role runs, with a real port for
// each check that applies to it. Each port is run here against real files, a real git copy and a fake claude; the
// whole path is run through launch() and stops where it must (check 2 has no port until lane 2 declares it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, cpSync, rmSync, symlinkSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { DESIGN_PROFILES, sha256 } from './role-profiles.mjs';
import { renderRoleSettings } from './render-settings.mjs';
import { namesIn, FLAGS as F, SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { HOOKS_SOURCE, installHooks } from './hooks-check.mjs';
import { makeSnapshot, writeSnapshot } from '../hooks/snapshot.mjs';
import { templateText } from './review-settings.mjs';
import { startGate } from '../../M11-dispatcher/gate.mjs';
import { rulesWith, recWith } from '../../M11-dispatcher/fixtures.test-helper.mjs';
import { reviewChecks, launchReview, sessionArgs, spawnClaude, smokeFiles, smokeCommand, GATE_KIND } from './review-launch.mjs';

const PIN = '2.1.300';
const ME = process.getuid();
// The review roles run as this test's own user; every other role as someone else (the review user is separate).
const UIDS = Object.fromEntries(Object.keys(DESIGN_PROFILES).map((r) => [r, ['reviewer', 'auditor'].includes(r) ? ME : ME + 1000]));

const initFor = (role, over = {}) => {
  const p = DESIGN_PROFILES[role];
  return { type: 'system', subtype: 'init', tools: [...p.tools, 'EndConversation'], mcp_servers: [], plugins: [], skills: [...(p.skills ?? [])],
    setting_sources: ['managed', 'flag'], permissionMode: p.mode, claude_code_version: PIN, ...over };
};

// A fake claude. Asked to run the smoke command, it does what FAKE_SMOKE says: 'sandboxed' marks only that it ran
// (the walls held), 'open' writes all three files, 'net' marks it ran and reached the network, 'none' does nothing.
// Otherwise it prints its start message (FAKE_INIT) and waits to be stopped.
function fakeClaude(dir) {
  const f = join(dir, 'fake-claude.mjs');
  writeFileSync(f, `
import { writeFileSync } from 'node:fs';
const prompt = process.argv.at(-1);
if (prompt.startsWith('Run exactly this shell command once')) {
  const [ran, outside, net] = [...prompt.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const mode = process.env.FAKE_SMOKE;
  if (mode !== 'none') writeFileSync(ran, '');
  if (mode === 'open') writeFileSync(outside, '');
  if (mode === 'open' || mode === 'net') writeFileSync(net, '');
  process.exit(0);
}
console.log('not json at all');
console.log(process.env.FAKE_INIT);
setTimeout(() => {}, 60000);
`);
  return f;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

function world({ role = 'reviewer', smoke = 'sandboxed', init = initFor(role) } = {}) {
  const root = realpathSync(tempDir('orch-review-launch-'));
  const d = (n) => { const p = join(root, n); mkdirSync(p, { recursive: true }); return p; };
  const copy = d('copy'); chmodSync(copy, 0o700);
  git(copy, 'init', '-q');
  writeFileSync(join(copy, 'a.txt'), 'the change\n');
  git(copy, 'add', 'a.txt');
  git(copy, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'c');
  const head = git(copy, 'rev-parse', 'HEAD');
  const outbox = d('outbox');
  const notes = d('notes'); // the session's compaction notes, apart from the outbox (L101)
  const reviewHome = d('home');
  const keys = d('keys');
  const bobFolder = d('bob');
  writeFileSync(join(bobFolder, 'rules.md'), 'the rules\n');
  const source = d('hooks-source'); cpSync(HOOKS_SOURCE, source, { recursive: true });
  for (const n of readdirSync(source)) if (n.endsWith('.test.mjs')) rmSync(join(source, n));
  const hooksDir = join(root, 'hooks'); installHooks(hooksDir, source);
  const snapshot = join(root, 'rules.json');
  const rules = { production: { env_files: [join(root, 'prod.cfg')], programs: ['fakehost'], hosts: ['db.prod.example.net'] }, secrets: { paths: [keys] } };
  writeSnapshot(snapshot, rules); // the runner's pass writes it before any start (readyProblem)
  const profile = DESIGN_PROFILES[role];
  const r = renderRoleSettings({ productionFiles: [], role, profile, product: { commands: { test: 'npm test' } },
    paths: { copy, outbox, hooksDir, snapshot, node: process.execPath, bobFolder, notes, mirror: join(root, 'mirror.git'),
      deny: { secrets: [keys], claudeHome: join(reviewHome, '.claude'), otherCopies: [join(root, 'copy2')] },
      reviewWalls: { outboxRoot: join(root, 'ro'), runnerRoot: join(root, 'rr') } } });
  assert.equal(r.ok, true, r.reason);
  const settingsFile = join(d('settings'), 'S-1.json');
  writeFileSync(settingsFile, templateText(r.settings)); // as sessionSettings writes it
  const guard = { [H.matcher]: '*', [H.hooks]: [{ [H.type]: 'command', [H.command]: `${process.execPath} ${hooksDir}/production-write-guard.mjs --role any`, [H.timeout]: 10, [H.onFailure]: 'block' }] };
  const machineWide = join(root, 'managed.json');
  writeFileSync(machineWide, JSON.stringify({ [S.hooks]: { [E.preToolUse]: [guard] } }));
  const fake = fakeClaude(root);
  const spawned = [];
  const fakeSpawn = (bin, args, opts) => { spawned.push(args); return spawn(process.execPath, [fake, ...args], { ...opts, env: { ...opts.env, PATH: process.env.PATH, FAKE_INIT: JSON.stringify(init), FAKE_SMOKE: smoke } }); };
  const alerts = [];
  const x = {
    role, profile, sessionId: 'S-1', card: 'C-1', head, copy, outbox, env: { PATH: '/usr/bin:/bin', HOME: reviewHome },
    claudeBin: join(root, 'claude-code', PIN, 'claude'), pin: PIN, versionRun: () => `${PIN} (Claude Code)`,
    hooksDir, hooksSource: source, reviewHome, settings: { file: settingsFile, settings: r.settings }, rules, snapshot, writeSnapshot,
    machineWide, busy: () => [], alert: (t) => alerts.push(t), spawn: fakeSpawn, ownUid: () => ME, uids: UIDS,
    cardDoc: null, budget: null, bobFolder, bobManifest: null, probeMs: 10_000,
  };
  const flags = sessionArgs({ profile, settingsFile, sessionId: 'S-1', prompt: 'p' }).filter((a) => a.startsWith('--'));
  const names = { flags, version: PIN, confirmed: Object.fromEntries([...namesIn(r.settings), ...flags].map((n) => [n, { by: 'readback:stand-in', version: PIN }])) };
  return { root, x, names, spawned, alerts };
}

const port = (x, n) => reviewChecks(x)[n]();

test('M-3: a review role has a port for checks 1, 3 and 5 to 11; 12 and 13 only when the config names their source; none for 2 or 4', () => {
  const { x } = world();
  assert.deepEqual(Object.keys(reviewChecks(x)), ['1', '3', '5', '6', '7', '8', '9', '10', '11']);
  const full = reviewChecks({ ...x, budget: { rules: rulesWith(), rec: recWith([]), bandsNow: () => ({}), runningNow: () => [] }, bobManifest: { 'rules.md': 'x' } });
  assert.deepEqual(Object.keys(full), ['1', '3', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
  for (const f of Object.values(full)) assert.equal(typeof f, 'function');
});

test('M-3 planted: a review session goes through launch(): checks 0 and 1 pass on the real copy, check 2 has no port, and claude is never spawned', async () => {
  for (const role of ['reviewer', 'auditor']) {
    const { x, names } = world({ role });
    let spawnedSession = 0;
    const r = await launchReview(x, { spawnSession: async () => { spawnedSession += 1; return { ok: true, pid: 1 }; }, names });
    assert.equal(r.ok, false, role);
    assert.equal(r.failedAt, 2, `${role}: ${r.reason}`);
    assert.match(r.reason, /launch check 2 \(setup files put back\): no check is wired/);
    assert.deepEqual(r.log, [{ n: 1, ok: true }, { n: 2, ok: false, reason: 'no check is wired' }]);
    assert.equal(spawnedSession, 0, 'claude is spawned only after every check passed');
  }
  // Check 0 still runs first: a name not confirmed, or a launcher not running as the review user, stops it there.
  const w = world();
  const r0 = await launchReview(w.x, { spawnSession: async () => assert.fail('spawned'), names: { ...w.names, confirmed: {} } });
  assert.equal(r0.failedAt, 0);
  assert.match(r0.reason, /setting names not confirmed/);
  const notReview = await launchReview(w.x, { spawnSession: async () => assert.fail('spawned'), names: w.names, ownUid: () => ME + 1000 });
  assert.equal(notReview.failedAt, 0);
  assert.match(notReview.reason, /runs only as the review user/);
});

test('M-3 check 1: the copy must be a plain folder of this user\'s alone, holding the head', async () => {
  const w = world();
  assert.deepEqual(await port(w.x, 1), { ok: true });
  assert.match((await port({ ...w.x, head: 'b'.repeat(40) }, 1)).reason, /not the head bbbbbbb/);
  chmodSync(w.x.copy, 0o750);
  assert.match((await port(w.x, 1)).reason, /not this user's alone/);
  chmodSync(w.x.copy, 0o700);
  assert.match((await port({ ...w.x, ownUid: () => ME + 1 }, 1)).reason, /not this user's alone/);
  const link = join(w.root, 'link'); symlinkSync(w.x.copy, link);
  assert.match((await port({ ...w.x, copy: link }, 1)).reason, /not a plain folder/);
  assert.match((await port({ ...w.x, copy: join(w.root, 'gone') }, 1)).reason, /missing/);
});

test('M-3 check 3: the outbox is emptied, and refused while something holds it', async () => {
  const w = world();
  writeFileSync(join(w.x.outbox, 'reviewer-old.md'), 'old');
  assert.equal((await port(w.x, 3)).ok, true);
  assert.deepEqual(readdirSync(w.x.outbox), []);
  assert.match((await port({ ...w.x, busy: () => [4242] }, 3)).reason, /still held by 4242/);
  assert.match((await port({ ...w.x, busy: () => { throw new Error('lsof'); } }, 3)).reason, /could not check/);
});

test('M-3 check 5: the settings file read back must be the very settings the runner wrote, and locked down', async () => {
  const w = world();
  assert.deepEqual(await port(w.x, 5), { ok: true });
  const f = w.x.settings.file;
  const good = readFileSync(f, 'utf8');
  writeFileSync(f, good.replace('"deny": [', '"deny": [\n      "Read(/x)",'));
  assert.match((await port(w.x, 5)).reason, /differs from what was written/);
  writeFileSync(f, JSON.stringify(w.x.settings.settings)); // the same settings, other bytes (L83 minor 2)
  assert.match((await port(w.x, 5)).reason, /differs from what was written/);
  writeFileSync(f, '{');
  assert.match((await port(w.x, 5)).reason, /not JSON/);
  const real = join(w.root, 'real.json'); writeFileSync(real, good); rmSync(f); symlinkSync(real, f);
  assert.match((await port(w.x, 5)).reason, /can't be read back/);
});

test('M-3 check 6: the read-back starts the role headless and compares its start message', async () => {
  assert.equal((await port(world().x, 6)).ok, true);
  const extra = world({ init: initFor('reviewer', { tools: [...DESIGN_PROFILES.reviewer.tools, 'Write', 'EndConversation'] }) });
  assert.equal((await port(extra.x, 6)).ok, false);
  assert.equal(extra.spawned.length, 1);
  assert.equal(extra.spawned[0][extra.spawned[0].indexOf(F.settings) + 1], extra.x.settings.file, 'the read-back runs with the session\'s own file');
});

test('M-3 check 7: the pinned version and the installed hooks', async () => {
  const w = world();
  assert.equal((await port(w.x, 7)).ok, true, (await port(w.x, 7)).reason);
  assert.match((await port({ ...w.x, versionRun: () => '2.1.299' }, 7)).reason, /Claude Code is 2.1.299/);
  assert.match((await port({ ...w.x, claudeBin: join(w.root, 'claude') }, 7)).reason, /pinned folder/);
  writeFileSync(join(w.x.hooksDir, 'production-write-guard.mjs'), 'process.exit(0);\n');
  assert.match((await port(w.x, 7)).reason, /production-write-guard/);
});

test('M-3 check 8 (L83 minor): the snapshot is written afresh before each start and must hold the config\'s rules', async () => {
  const w = world();
  writeFileSync(w.x.snapshot, makeSnapshot(w.x.rules, new Date(Date.now() - 60 * 60_000)));
  assert.deepEqual(await port(w.x, 8), { ok: true }, 'a stale snapshot is rewritten, not refused');
  const other = { ...w.x.rules, secrets: { paths: [] } };
  assert.match((await port({ ...w.x, writeSnapshot: (p) => writeSnapshot(p, other) }, 8)).reason, /other rules than the runner's config/);
  assert.match((await port({ ...w.x, writeSnapshot: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }, 8)).reason, /could not be written \(EACCES\)/);
});

test('M-3 checks 9 and 10: no key in the session\'s environment; the machine-wide block in force', async () => {
  const w = world();
  assert.deepEqual(await port(w.x, 9), { ok: true });
  assert.match((await port({ ...w.x, env: { ...w.x.env, ANTHROPIC_API_KEY: 'x' } }, 9)).reason, /ANTHROPIC_API_KEY/);
  assert.deepEqual(await port(w.x, 10), { ok: true });
  assert.match((await port({ ...w.x, machineWide: join(w.root, 'gone.json') }, 10)).reason, /missing or not JSON/);
  writeFileSync(w.x.machineWide, JSON.stringify({ [S.hooks]: {} }));
  assert.match((await port(w.x, 10)).reason, /not in force/);
});

test('M-3 planted check 11: the smoke runs through the role\'s own start; a write outside the copy, the network, or a run that never ran refuses', async () => {
  const ok = world({ smoke: 'sandboxed' });
  assert.deepEqual(await port(ok.x, 11), { ok: true });
  const args = ok.spawned.at(-1);
  assert.equal(args[args.indexOf(F.settings) + 1], ok.x.settings.file, 'the smoke uses the session\'s own settings');
  assert.equal(args[args.indexOf(F.tools) + 1], 'Bash');
  for (const p of Object.values(smokeFiles(ok.x))) assert.equal(existsSync(p), false, 'the smoke files are cleaned up');
  assert.match((await port(world({ smoke: 'open' }).x, 11)).reason, /wrote outside the copy/);
  assert.match((await port(world({ smoke: 'net' }).x, 11)).reason, /reached the network/);
  assert.match((await port(world({ smoke: 'none' }).x, 11)).reason, /could not say/);
  // A file left from an earlier run doesn't count: the port removes them first.
  const stale = world({ smoke: 'none' });
  writeFileSync(smokeFiles(stale.x).ran, '');
  assert.match((await port(stale.x, 11)).reason, /could not say/);
  assert.throws(() => smokeCommand({ ran: "/a'b", outside: '/o', net: '/n' }), /quote/);
});

test('M-3 check 12: M11\'s own gate, given the config\'s budget source, with the card from the Record', async () => {
  const w = world();
  const rules = rulesWith();
  const rec = recWith([['product', 'p1', { state: 'active' }]]);
  const cardDoc = { id: 'C-1', product: 'p1', tier: 2, files: ['src/a.js'] };
  for (const b of [{ band: 'green', own_building: 'open', prodBlocked: false }, { band: 'red', own_building: 'open', prodBlocked: false }, { band: 'unknown', own_building: 'unknown', prodBlocked: true }]) {
    const budget = { rules, rec, bandsNow: () => b, runningNow: () => [] };
    for (const role of ['reviewer', 'auditor']) {
      const got = await port({ ...w.x, role, budget, cardDoc }, 12);
      assert.deepEqual(got, startGate({ rules, rec, card: cardDoc, kind: GATE_KIND[role], product: 'p1', b, running: [] }), `${role} ${b.band}`);
    }
  }
  assert.equal((await port({ ...w.x, budget: { rules, rec, bandsNow: () => ({ band: 'green', own_building: 'open', prodBlocked: false }), runningNow: () => [] }, cardDoc }, 12)).ok, true);
  assert.match((await port({ ...w.x, budget: { rules, rec, bandsNow: () => ({}), runningNow: () => [] } }, 12)).reason, /not in the Record/);
});

test('M-3 check 13: the Bob folder against the pinned list the config names', async () => {
  const w = world();
  const manifest = { 'rules.md': sha256(readFileSync(join(w.x.bobFolder, 'rules.md'))) };
  assert.match((await port({ ...w.x, bobManifest: { 'rules.md': 'f'.repeat(64) } }, 13)).reason, /differs from the pinned/);
  assert.match((await port({ ...w.x, bobManifest: { 'other.md': 'f'.repeat(64) } }, 13)).reason, /a file the pin does not/);
  writeFileSync(join(w.x.bobFolder, 'SKILL.md'), 'x');
  assert.match((await port({ ...w.x, bobManifest: manifest }, 13)).reason, /holds a skill/);
});

// Found while wiring L83 M-3: render-settings writes the Bob folder's read-only rules in Claude's "//path" form
// (`Edit(//Users/.../**)`), and launch.mjs checkBobFolder looks for the one-slash form, so check 13 refuses every real
// rendered role file. launch.mjs is lane 2's; the exact change is in the L83 report. Take off `todo` once it lands.
test('M-3 check 13: a real rendered role file with the right Bob folder passes', { todo: 'lane 2: checkBobFolder must read the "//path" rules render-settings writes' }, async () => {
  const w = world();
  const manifest = { 'rules.md': sha256(readFileSync(join(w.x.bobFolder, 'rules.md'))) };
  assert.deepEqual(await port({ ...w.x, bobManifest: manifest }, 13), { ok: true });
});

test('R-0b-163 planted: the session starts with --settings naming the runner\'s file, once, and no other settings source', () => {
  const args = sessionArgs({ profile: DESIGN_PROFILES.reviewer, settingsFile: '/r/settings/S-1.json', sessionId: 'S-1', prompt: 'the prompt' });
  const at = args.flatMap((a, i) => (a === F.settings ? [i] : []));
  assert.equal(at.length, 1, '--settings appears exactly once');
  assert.equal(args[at[0] + 1], '/r/settings/S-1.json');
  for (const other of ['--setting-sources', '--add-dir', '--dangerously-skip-permissions', '--allowedTools', '--allowed-tools']) assert.equal(args.includes(other), false, `no ${other}`);
  assert.equal(args[args.indexOf(F.sessionId) + 1], 'S-1', 'claude takes the runner\'s session id, so the pid check finds it');
  assert.equal(args[args.indexOf(F.tools) + 1], DESIGN_PROFILES.reviewer.tools.join(','));
  assert.equal(args[args.indexOf(F.permissionMode) + 1], DESIGN_PROFILES.reviewer.mode);
  assert.equal(args.includes(F.restricted), true);
  assert.equal(args[args.indexOf(F.mcpConfig) + 1], '{"mcpServers":{}}');
  assert.equal(args.at(-1), 'the prompt');
});

test('R-0b-163: spawnClaude hands back claude\'s own pid, detached, or says it never spawned', async () => {
  const calls = [];
  const fake = ({ fail = false } = {}) => (bin, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    calls.push({ bin, args, opts, child });
    setImmediate(() => { if (fail) child.emit('error', new Error('no')); else { child.pid = 4242; child.emit('spawn'); } });
    return child;
  };
  assert.deepEqual(await spawnClaude(fake(), '/i/claude', ['a'], { cwd: '/rc/S-1', env: { PATH: '/usr/bin' } }), { ok: true, pid: 4242 });
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.cwd, '/rc/S-1');
  assert.equal(calls[0].child.unrefed, true);
  assert.deepEqual(await spawnClaude(fake({ fail: true }), '/i/claude', [], {}), { ok: false, reason: 'claude could not be spawned' });
  assert.match((await spawnClaude(() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, '/i/claude', [], {})).reason, /\(EACCES\)/);
});
