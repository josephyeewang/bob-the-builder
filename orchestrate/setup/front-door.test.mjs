// front-door.test.mjs — the Front Door's start command (Track A step 6).
// Run: node --test orchestrate/setup/front-door.test.mjs
//
// The settings are the real renderer's, written to a real temp folder; claude (check 6 and the interactive start) is a
// stand-in that records what it was given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { NO_FILE_SOURCES } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { FILED_NAME } from '../modules/M1-front-door/filed.mjs';
import { FILED_EVERY_MS, FILED_TABS, SETTINGS_NAME, SETUP_FILE, SKILL_FILE, USAGE, frontDoorEnv, main, startFrontDoor } from './front-door.mjs';

const P = 'orchestrate-test';
const OWNER = 'joe';
const FD = DESIGN_PROFILES.front_door;
// A profile as it was before L1334 option a: the Skill tool and the orchestrate skill.
const WITH_SKILL = { ...FD, tools: [...FD.tools, 'Skill'], skills: ['orchestrate'] };

function world({ rc = {}, check = { ok: true, version: '2.1.316' } } = {}) {
  const base = realpathSync(tempDir('m1-fd-start-'));
  const home = join(base, 'home-joe'); mkdirSync(home);
  for (const d of ['outboxes/front_door', 'install/orchestrate/hooks', 'owner-taps', 'worker-rules', 'keys', 'private', 'bob']) mkdirSync(join(base, d), { recursive: true });
  const setupFile = join(base, 'setup.json');
  writeFileSync(setupFile, JSON.stringify({ base, owner: OWNER, products: ['insiderintent', P], dispatcher: { product: P } }));
  const installRoot = join(base, 'install', 'orchestrate');
  const review = { claudeBin: join(installRoot, 'claude-code', '2.1.316', 'claude'), hooksDir: join(installRoot, 'hooks'), pin: '2.1.316', bobFolder: join(base, 'bob'),
    recordRoot: join(base, 'products', P, 'store'), recordUid: process.getuid(), rules: { secrets: { paths: [join(base, 'secret-one')] }, production: { env_files: [], hosts: [], programs: [] } }, ...rc };
  writeFileSync(join(installRoot, RUNNER_CONFIG), JSON.stringify(review));
  const calls = { check: [], run: [], timers: [] };
  const io = {
    readText: (f) => readFileSync(f, 'utf8'),
    mkdir: (d, mode) => mkdirSync(d, { mode }),
    writeFile: (f, t, mode) => writeFileSync(f, t, { mode, flag: 'wx' }),
    rm: (d) => rmSync(d, { recursive: true, force: true }),
    uid: 501, user: OWNER, home, env: { PATH: '/usr/bin', HOME: home, TERM: 'xterm-ghostty', ANTHROPIC_API_KEY: 'never-passed', GH_TOKEN: 'never-passed' },
    now: () => new Date(2026, 10, 23, 9, 5, 7).getTime(), uuid: () => '00000000-0000-4000-8000-000000000001',
    check: async (x) => { calls.check.push(x); return check; },
    run: async (bin, args, opts) => { calls.run.push({ bin, args, opts, filedAtStart: readFileSync(join(opts.cwd, FILED_NAME), 'utf8'), timers: calls.timers.length }); return 0; },
    putFiled: (f, text) => writeFileSync(f, text, { mode: 0o600 }),
    every: (fn, ms) => { calls.timers.push({ fn, ms, stopped: false }); return calls.timers.length - 1; },
    stop: (t) => { calls.timers[t].stopped = true; },
  };
  return { base, home, setupFile, installRoot, review, io, calls, outbox: join(base, 'outboxes', 'front_door', `fd-${P}-20261123090507`) };
}

const flagValue = (args, f) => args[args.indexOf(f) + 1];

test('step 6: the start makes the session\'s outbox, writes the rendered settings there, runs check 6 on the full profile, then starts claude in the tab', async () => {
  const w = world();
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
  assert.deepEqual(r, { ok: true, sessionId: `fd-${P}-20261123090507`, outbox: w.outbox, code: 0, filed: `What Front Door tab fd-${P}-20261123090507 filed (from the Record):\n  nothing filed in this tab` });
  const settingsFile = join(w.outbox, SETTINGS_NAME);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const deny = JSON.stringify(settings.permissions.deny);
  for (const p of [w.review.recordRoot, w.home, join(w.base, 'keys'), join(w.base, 'private'), join(w.base, 'secret-one')]) assert.ok(deny.includes(p.slice(1)), `denied: ${p}`);
  // Check 6: the full locked profile, the headless start, the settings sources limited to none.
  const [c] = w.calls.check;
  assert.equal(c.profile, FD);
  assert.equal(c.role, 'front_door');
  assert.equal(c.pin, '2.1.316');
  assert.equal(c.cwd, w.outbox);
  assert.equal(flagValue(c.args, '--setting-sources'), NO_FILE_SOURCES);
  assert.equal(flagValue(c.args, '--settings'), settingsFile);
  assert.ok(c.args.includes('-p'));
  // The tab's start: the same walls, interactive, its own session id and name, in the outbox, the tab's basics only.
  const [run] = w.calls.run;
  assert.equal(run.bin, w.review.claudeBin);
  assert.equal(run.opts.cwd, w.outbox);
  assert.ok(!run.args.includes('-p') && !run.args.includes('--max-turns'), 'interactive');
  for (const [f, v] of [['--settings', settingsFile], ['--setting-sources', NO_FILE_SOURCES], ['--tools', FD.tools.join(',')], ['--permission-mode', 'acceptEdits'], ['--model', 'sonnet'],
    ['--session-id', '00000000-0000-4000-8000-000000000001'], ['--name', `Front Door ${P}`], ['--mcp-config', '{"mcpServers":{}}']]) assert.equal(flagValue(run.args, f), v, f);
  assert.ok(run.args.includes('--restricted') && run.args.includes('--strict-mcp-config'));
  assert.equal(flagValue(run.args, '--append-system-prompt-file'), join(w.installRoot, SKILL_FILE), 'L1334 option a: the skill is prompt text');
  assert.deepEqual(Object.keys(run.opts.env).sort(), ['HOME', 'PATH', 'TERM']);
});

test('#657 audit m4: a check 6 that throws is a refusal: nothing starts and the outbox is gone', async () => {
  const w = world();
  w.io.check = async () => { throw new Error('spawn EACCES'); };
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
  assert.equal(r.ok, false);
  assert.match(r.reason, /launch check 6 refused the Front Door: it failed \(spawn EACCES\)/);
  assert.equal(w.calls.run.length, 0);
  assert.equal(existsSync(w.outbox), false, 'no folder left for intake to take');
});

test('the setup config is layout.mjs\'s one name for it', async () => {
  const { ROOT_CONFIG_PATH } = await import('./layout.mjs');
  assert.equal(SETUP_FILE, ROOT_CONFIG_PATH);
});

test('step 6: while check 6 refuses, nothing starts and the outbox is gone', async () => {
  const w = world({ check: { ok: false, reason: 'skills differ: ' } });
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
  assert.equal(r.ok, false);
  assert.match(r.reason, /launch check 6 refused the Front Door: skills differ/);
  assert.equal(w.calls.run.length, 0);
  assert.equal(existsSync(w.outbox), false, 'no folder left for intake to take');
});

test('step 6 (L1334 option a): the Front Door has no Skill tool and no skill; a profile that names one starts nothing', async () => {
  assert.equal(FD.tools.includes('Skill'), false);
  assert.equal(FD.skills, undefined);
  const w = world();
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile, profile: WITH_SKILL }, w.io);
  assert.equal(r.ok, false);
  assert.match(r.reason, /names a skill or the Skill tool.*L1334/);
  assert.equal(w.calls.check.length + w.calls.run.length, 0);
  assert.equal(existsSync(w.outbox), false);
});

test('step 6 (L1334 option a): the copy\'s SKILL.md is given as prompt text, in check 6 and in the tab alike', async () => {
  const w = world();
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
  assert.equal(r.ok, true);
  const skill = join(w.installRoot, SKILL_FILE);
  assert.equal(flagValue(w.calls.check[0].args, '--append-system-prompt-file'), skill);
  assert.equal(w.calls.check[0].args.at(-1), 'Reply with the word ready.', 'the prompt stays last');
  assert.equal(flagValue(w.calls.run[0].args, '--append-system-prompt-file'), skill);
});

test('step 6: root, another user, another product\'s rules and a product setup does not list are refused before anything is made', async () => {
  const cases = [
    [(w) => { w.io.uid = 0; }, /runs as root/],
    [(w) => { w.io.user = 'builder'; }, /the owner's \(joe\), and this is builder/],
    [(w) => writeFileSync(join(w.installRoot, RUNNER_CONFIG), JSON.stringify({ ...w.review, recordRoot: join(w.base, 'products', 'insiderintent', 'store') })), /another product's Record/],
    [(w) => writeFileSync(join(w.installRoot, RUNNER_CONFIG), JSON.stringify({ ...w.review, claudeBin: undefined })), /no pinned claude/],
  ];
  for (const [spoil, why] of cases) {
    const w = world();
    spoil(w);
    const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
    assert.equal(r.ok, false); assert.match(r.reason, why);
    assert.equal(existsSync(w.outbox), false); assert.equal(w.calls.check.length + w.calls.run.length, 0);
  }
  const w = world();
  const r = await startFrontDoor({ product: 'nope', setupFile: w.setupFile }, w.io);
  assert.match(r.reason, /does not list the product nope/);
});

test('step 6: the command line says how to use it, and says plainly when the start was refused', async () => {
  const said = [];
  assert.equal(await main([], {}, (s) => said.push(s)), 2);
  assert.equal(said.pop(), USAGE);
  const w = world({ check: { ok: false, reason: 'skills differ: ' } });
  assert.equal(await main(['start', P, '--setup', w.setupFile], w.io, (s) => said.push(s)), 1);
  assert.match(said.pop(), /^The Front Door did not start: launch check 6 refused/);
  assert.deepEqual(frontDoorEnv({ PATH: 'p', SECRET: 's', LANG: 'en' }), { PATH: 'p', LANG: 'en' });
});

test('step 7: `filed <product>` reads back the product\'s latest tabs, newest first, from its own Record; none started says so', async () => {
  const w = world();
  const said = [];
  assert.equal(await main(['filed', P, '--setup', w.setupFile], w.io, (s) => said.push(s)), 0);
  assert.equal(said.pop(), `No Front Door tab has been started for ${P}.`);
  const fd = join(w.base, 'outboxes', 'front_door');
  const ids = ['20261120080000', '20261121080000', '20261122080000', '20261123080000', '20261123090000', '20261123100000'].map((t) => `fd-${P}-${t}`);
  for (const id of [...ids, 'fd-insiderintent-20261123100000']) mkdirSync(join(fd, id));
  const asked = [];
  w.io.readFiled = (x) => { asked.push(x); return { text: `read ${x.sessionId}` }; };
  assert.equal(await main(['filed', P, '--setup', w.setupFile], w.io, (s) => said.push(s)), 0);
  assert.deepEqual(asked.map((x) => x.sessionId), ids.slice(1).reverse(), `the ${FILED_TABS} newest of this product's tabs`);
  assert.ok(asked.every((x) => x.recordRoot === w.review.recordRoot && x.recordUid === w.review.recordUid && x.outbox === join(fd, x.sessionId)));
  assert.equal(said.pop(), ids.slice(1).reverse().map((id) => `read ${id}`).join('\n'));
  // The session's own read-back is printed when the tab ends.
  assert.equal(await main(['start', P, '--setup', w.setupFile], w.io, (s) => said.push(s)), 0);
  assert.equal(said.pop(), `read fd-${P}-20261123090507`);
  // While the tab runs, .filed.md holds the read-back, from before claude starts, kept fresh on a timer stopped at the end.
  const run = w.calls.run.at(-1);
  assert.equal(run.filedAtStart, `read fd-${P}-20261123090507\n`);
  const t = w.calls.timers.at(-1);
  assert.equal(t.ms, FILED_EVERY_MS); assert.equal(t.stopped, true); assert.equal(run.timers, w.calls.timers.length, 'the timer runs while claude does');
  w.io.readFiled = () => ({ text: 'fresher' }); t.fn();
  assert.equal(readFileSync(join(fd, `fd-${P}-20261123090507`, FILED_NAME), 'utf8'), 'fresher\n');
  // Rules that name no Record owner can't read anything back: refused, not "nothing filed".
  writeFileSync(join(w.installRoot, RUNNER_CONFIG), JSON.stringify({ ...w.review, recordUid: undefined }));
  assert.equal(await main(['filed', P, '--setup', w.setupFile], w.io, (s) => said.push(s)), 1);
  assert.match(said.pop(), /names no Record owner/);
});
