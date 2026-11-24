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
import { SETTINGS_NAME, SKILL_FILE, USAGE, frontDoorEnv, main, startFrontDoor } from './front-door.mjs';

const P = 'orchestrate-test';
const OWNER = 'joe';
const FD = DESIGN_PROFILES.front_door;
// The profile the lead may rule for (L1334): no Skill tool and no skills, the skill's text given as prompt.
const AS_PROMPT = { ...FD, tools: FD.tools.filter((t) => t !== 'Skill'), skills: [] };

function world({ rc = {}, check = { ok: true, version: '2.1.316' } } = {}) {
  const base = realpathSync(tempDir('m1-fd-start-'));
  const home = join(base, 'home-joe'); mkdirSync(home);
  for (const d of ['outboxes/front_door', 'install/orchestrate/hooks', 'owner-taps', 'worker-rules', 'keys', 'private', 'bob']) mkdirSync(join(base, d), { recursive: true });
  const setupFile = join(base, 'setup.json');
  writeFileSync(setupFile, JSON.stringify({ base, owner: OWNER, products: ['insiderintent', P], dispatcher: { product: P } }));
  const installRoot = join(base, 'install', 'orchestrate');
  const review = { claudeBin: join(installRoot, 'claude-code', '2.1.316', 'claude'), hooksDir: join(installRoot, 'hooks'), pin: '2.1.316', bobFolder: join(base, 'bob'),
    recordRoot: join(base, 'products', P, 'store'), rules: { secrets: { paths: [join(base, 'secret-one')] }, production: { env_files: [], hosts: [], programs: [] } }, ...rc };
  writeFileSync(join(installRoot, RUNNER_CONFIG), JSON.stringify(review));
  const calls = { check: [], run: [] };
  const io = {
    readText: (f) => readFileSync(f, 'utf8'),
    mkdir: (d, mode) => mkdirSync(d, { mode }),
    writeFile: (f, t, mode) => writeFileSync(f, t, { mode, flag: 'wx' }),
    rm: (d) => rmSync(d, { recursive: true, force: true }),
    uid: 501, user: OWNER, home, env: { PATH: '/usr/bin', HOME: home, TERM: 'xterm-ghostty', ANTHROPIC_API_KEY: 'never-passed', GH_TOKEN: 'never-passed' },
    now: () => new Date(2026, 10, 23, 9, 5, 7).getTime(), uuid: () => '00000000-0000-4000-8000-000000000001',
    check: async (x) => { calls.check.push(x); return check; },
    run: async (bin, args, opts) => { calls.run.push({ bin, args, opts }); return 0; },
  };
  return { base, home, setupFile, installRoot, review, io, calls, outbox: join(base, 'outboxes', 'front_door', `fd-${P}-20261123090507`) };
}

const flagValue = (args, f) => args[args.indexOf(f) + 1];

test('step 6: the start makes the session\'s outbox, writes the rendered settings there, runs check 6 on the full profile, then starts claude in the tab', async () => {
  const w = world();
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
  assert.deepEqual(r, { ok: true, sessionId: `fd-${P}-20261123090507`, outbox: w.outbox, code: 0 });
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
  assert.ok(!run.args.includes('--append-system-prompt-file'), 'the profile has the Skill tool: no prompt file');
  assert.deepEqual(Object.keys(run.opts.env).sort(), ['HOME', 'PATH', 'TERM']);
});

test('step 6 (L1334): while check 6 refuses (the skill can\'t load), nothing starts and the outbox is gone', async () => {
  const w = world({ check: { ok: false, reason: 'skills differ: ' } });
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile }, w.io);
  assert.equal(r.ok, false);
  assert.match(r.reason, /launch check 6 refused the Front Door: skills differ/);
  assert.equal(w.calls.run.length, 0);
  assert.equal(existsSync(w.outbox), false, 'no folder left for intake to take');
});

test('step 6: a profile with no Skill tool gets the copy\'s SKILL.md as prompt text, in check 6 and in the tab alike', async () => {
  const w = world();
  const r = await startFrontDoor({ product: P, setupFile: w.setupFile, profile: AS_PROMPT }, w.io);
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
