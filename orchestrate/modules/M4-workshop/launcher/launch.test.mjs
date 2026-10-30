// Launch checks 3, 4, 6-11 and 13, the launch order, and the attack tests (R-0b-33 to 43).
// Everything runs against fakes and throwaway folders: no real Claude session is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, cpSync, rmSync, linkSync, symlinkSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { REFUSED_ENV, SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { renderRoleSettings, POLICY_HOOKS } from './render-settings.mjs';
import { roleArgs, checkInit, readBack } from './readback.mjs';
import { roleEnv, checkRoleEnv, checkMachineWide } from './env-check.mjs';
import { HOOKS_SOURCE, installHooks, checkHooks, checkVersion, pinnedBinary, productionProbe, checkSnapshot } from './hooks-check.mjs';
import { emptyOutbox, readOutboxFile } from './outbox.mjs';
import { namesIn, unconfirmedNames, FLAGS } from './settings-names.mjs';
import { CHECKS, launch, installStep, needsInstall, checkBobFolder, lockedRunCommand, smokeTest, baselineTest } from './launch.mjs';
import { removeProtected } from './worker-copy.mjs';
import { makeSnapshot } from '../hooks/snapshot.mjs';
import { sha256 } from './role-profiles.mjs';
import { memoryRecord } from '../../../shared/record.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'orch-launch-')));

// The names check (audit R-0b-44 M-1): a real rendered role file and the start flags, with a
// stand-in table that marks every name confirmed on the test version.
const N_PATHS = {
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node',
  deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', robotKeys: '/w/keys', record: '/w/record', otherCopies: ['/w/copy2'] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git',
};
const N_VERSION = '2.1.300';
const N_FLAGS = Object.values(FLAGS).filter((f) => f.startsWith('-'));
function NAMES(role, over = {}) {
  const r = renderRoleSettings({ role, profile: DESIGN_PROFILES[role], paths: N_PATHS, product: { commands: { test: 'npm test' } } });
  assert.equal(r.ok, true, `${role}: ${r.reason}`);
  const confirmed = Object.fromEntries([...namesIn(r.settings), ...N_FLAGS].map((n) => [n, { by: 'readback:stand-in', version: N_VERSION }]));
  return { settings: r.settings, flags: N_FLAGS, version: N_VERSION, confirmed, ...over };
}

// ---- the order (§14.1.3) ----

test('launch: the first failing check stops the launch; later checks never run and nothing starts', async () => {
  const worker = DESIGN_PROFILES.worker;
  for (const k of CHECKS.map((c) => c.n)) {
    const called = [];
    const checks = Object.fromEntries(CHECKS.map((c) => [c.n, async () => { called.push(c.n); return c.n === k ? { ok: false, reason: 'planted' } : { ok: true }; }]));
    let started = 0;
    const r = await launch({ role: 'worker', profile: worker, checks, start: async () => { started += 1; }, names: NAMES('worker') });
    assert.equal(r.ok, false);
    assert.equal(r.failedAt, k);
    assert.deepEqual(called, CHECKS.map((c) => c.n).filter((n) => n <= k), `check ${k}`);
    assert.equal(started, 0);
  }
  // A missing port, a throwing port and a port with no answer all refuse.
  for (const bad of [undefined, async () => { throw new Error('boom'); }, async () => undefined, async () => ({ ok: 'yes' })]) {
    const checks = Object.fromEntries(CHECKS.map((c) => [c.n, async () => ({ ok: true })]));
    checks[7] = bad;
    let started = 0;
    const r = await launch({ role: 'worker', profile: worker, checks, start: async () => { started += 1; }, names: NAMES('worker') });
    assert.equal(r.failedAt, 7);
    assert.equal(started, 0);
  }
  // All pass: one start.
  const checks = Object.fromEntries(CHECKS.map((c) => [c.n, async () => ({ ok: true })]));
  let started = 0;
  assert.equal((await launch({ role: 'worker', profile: worker, checks, start: async () => { started += 1; return 'w-1'; }, names: NAMES('worker') })).ok, true);
  assert.equal(started, 1);
});

test('launch: which checks apply to which role', async () => {
  const ran = async (role) => {
    const called = [];
    const checks = Object.fromEntries(CHECKS.map((c) => [c.n, async () => { called.push(c.n); return { ok: true }; }]));
    await launch({ role, profile: DESIGN_PROFILES[role], checks, start: async () => {}, names: NAMES(role) });
    return called;
  };
  assert.deepEqual(await ran('worker'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(await ran('lead'), [3, 5, 6, 7, 8, 9, 10, 12, 13]);
  assert.deepEqual(await ran('front_door'), [3, 5, 6, 7, 8, 9, 10, 12]);
  // Every role with a shell runs the smoke test (check 11), not only the worker (audit R-0b-44 M-1).
  assert.deepEqual(await ran('reviewer'), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(await ran('auditor'), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(await ran('learning'), [3, 5, 6, 7, 8, 9, 10, 12, 13]);
  // A shell added to a role that had none brings check 11 with it.
  const called = [];
  const checks = Object.fromEntries(CHECKS.map((c) => [c.n, async () => { called.push(c.n); return { ok: true }; }]));
  const leadWithShell = { ...DESIGN_PROFILES.lead, tools: [...DESIGN_PROFILES.lead.tools, 'Bash'] };
  await launch({ role: 'lead', profile: leadWithShell, checks, start: async () => {}, names: NAMES('lead') });
  assert.ok(called.includes(11));
});

test('launch: a setting name not confirmed on the pinned version refuses before check 1 (audit R-0b-44 M-1)', async () => {
  const run = async (names) => {
    const called = [];
    let started = 0;
    const checks = Object.fromEntries(CHECKS.map((c) => [c.n, async () => { called.push(c.n); return { ok: true }; }]));
    const r = await launch({ role: 'worker', profile: DESIGN_PROFILES.worker, checks, start: async () => { started += 1; }, names });
    return { r, called, started };
  };
  const good = NAMES('worker');
  assert.equal((await run(good)).r.ok, true);
  const bad = [
    ['no names given', undefined],
    ['no role file', { ...good, settings: undefined }],
    ['no version', { ...good, version: '' }],
    ['another version', { ...good, version: '2.1.301' }],
    ['one setting unconfirmed', { ...good, confirmed: Object.fromEntries(Object.entries(good.confirmed).filter(([k]) => k !== S.sandbox)) }],
    ['one hook field unconfirmed', { ...good, confirmed: Object.fromEntries(Object.entries(good.confirmed).filter(([k]) => k !== H.command)) }],
    ['one flag unconfirmed', { ...good, confirmed: Object.fromEntries(Object.entries(good.confirmed).filter(([k]) => k !== FLAGS.tools)) }],
    ['a misspelt name in the file', { ...good, settings: { ...good.settings, sandbx: { enabled: true } } }],
    ['proof of the wrong kind', { ...good, confirmed: { ...good.confirmed, [S.sandbox]: { by: 'guess', version: N_VERSION } } }],
    ['proof on another version', { ...good, confirmed: { ...good.confirmed, [S.sandbox]: { by: 'readback:x', version: '2.1.299' } } }],
    ['the shipped table (empty today)', { ...good, confirmed: undefined }],
  ];
  for (const [what, names] of bad) {
    const { r, called, started } = await run(names);
    assert.equal(r.ok, false, what);
    assert.equal(r.failedAt, 0, what);
    assert.deepEqual(called, [], what);
    assert.equal(started, 0, what);
  }
  // The names inside the variables block and the plugin list are checked as names or skipped as data.
  const withVars = { [S.env]: { SOME_VAR: '1' }, [S.enabledPlugins]: { 'x@y': false } };
  assert.deepEqual(namesIn(withVars), ['SOME_VAR', S.enabledPlugins, S.env].sort());
  assert.deepEqual(unconfirmedNames({ settings: withVars, version: N_VERSION, confirmed: {} }).sort(), ['SOME_VAR', S.enabledPlugins, S.env].sort());
});

// ---- check 6: headless read-back (R-0b-35, 34, 39, 43) ----

const goodInit = (role) => {
  const p = DESIGN_PROFILES[role];
  return { type: 'system', subtype: 'init', tools: [...p.tools, 'EndConversation'], mcp_servers: [], plugins: [], skills: [...(p.skills ?? [])],
    setting_sources: ['managed', 'flag'], permissionMode: p.mode, claude_code_version: '2.1.300' };
};

// A fake `claude`: prints a line of noise, the canned start message, then waits to be stopped.
function fakeClaude(dir) {
  const f = join(dir, 'fake-claude.mjs');
  writeFileSync(f, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// Like the real thing, it would load a project settings file from its folder and run its hooks.
if (existsSync('.claude/settings.json')) {
  const s = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
  for (const c of [s.statusLine?.command, ...(s.hooks?.SessionStart ?? []).flatMap((m) => m.hooks.map((h) => h.command))]) if (c) execFileSync('/bin/sh', ['-c', c]);
}
if (existsSync('.mcp.json')) writeFileSync(process.env.FAKE_MARK, 'mcp loaded');
console.log('not json at all');
if (process.env.FAKE_INIT !== 'none') console.log(process.env.FAKE_INIT);
if (process.env.FAKE_EXIT) process.exit(0);
setTimeout(() => {}, 60000);
`);
  return (init, extraEnv = {}) => (bin, args, opts) => spawn(process.execPath, [f, ...args], { ...opts, env: { ...opts.env, PATH: process.env.PATH, FAKE_INIT: typeof init === 'string' ? init : JSON.stringify(init), ...extraEnv } });
}

test('read-back: each role starts only with exactly its own tools, no servers, plugins or extra skills', async () => {
  const dir = tmp();
  const fake = fakeClaude(dir);
  for (const role of Object.keys(DESIGN_PROFILES)) {
    const profile = DESIGN_PROFILES[role];
    const args = roleArgs({ profile, settingsFile: '/w/role.json' });
    assert.ok(args.includes('--strict-mcp-config') && args.includes('{"mcpServers":{}}'));
    assert.equal(args[args.indexOf('--tools') + 1], profile.tools.join(','));
    const r = await readBack({ claudeBin: 'claude', args, env: {}, cwd: dir, role, profile, spawnFn: fake(goodInit(role)) });
    assert.equal(r.ok, true, `${role}: ${r.reason}`);
  }
});

test('read-back: every mismatch or missing field means no start', async () => {
  const dir = tmp();
  const fake = fakeClaude(dir);
  const worker = DESIGN_PROFILES.worker;
  const bad = [
    ['one extra tool', { ...goodInit('worker'), tools: [...goodInit('worker').tools, 'WebFetch'] }],
    ['a missing tool', { ...goodInit('worker'), tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] }],
    ['a never-list tool', { ...goodInit('worker'), tools: [...goodInit('worker').tools, 'SendMessage'] }],
    ['a tool server', { ...goodInit('worker'), mcp_servers: [{ name: 'github', status: 'connected' }] }],
    ['a plugin', { ...goodInit('worker'), plugins: [{ name: 'x' }] }],
    ['a skill', { ...goodInit('worker'), skills: ['deploy'] }],
    ['a project settings source', { ...goodInit('worker'), setting_sources: ['managed', 'flag', 'project'] }],
    ['a user settings source', { ...goodInit('worker'), setting_sources: ['user', 'flag'] }],
    ['no --settings source', { ...goodInit('worker'), setting_sources: ['managed'] }],
    ['another permission mode', { ...goodInit('worker'), permissionMode: 'bypassPermissions' }],
    ['tools not a list', { ...goodInit('worker'), tools: 'Read' }],
    // The version the session reports (audit R-0b-44 round 1, minor).
    ['a version below the floor', { ...goodInit('worker'), claude_code_version: '2.1.294' }],
    ['a version that is not a version', { ...goodInit('worker'), claude_code_version: 'latest' }],
  ];
  for (const k of ['tools', 'mcp_servers', 'plugins', 'skills', 'setting_sources', 'permissionMode', 'claude_code_version']) {
    const i = goodInit('worker'); delete i[k]; bad.push([`no ${k}`, i]);
  }
  for (const [what, init] of bad) {
    const c = checkInit(init, { role: 'worker', profile: worker });
    assert.equal(c.ok, false, what);
    if (what === 'a never-list tool') assert.match(c.reason, /never-list/);
    const r = await readBack({ claudeBin: 'claude', args: [], env: {}, cwd: dir, role: 'worker', profile: worker, spawnFn: fake(init) });
    assert.equal(r.ok, false, what);
  }
  // A session on another version than the pin refuses; on the pin it passes.
  assert.equal(checkInit(goodInit('worker'), { role: 'worker', profile: worker, pin: '2.1.301' }).ok, false);
  assert.equal(checkInit(goodInit('worker'), { role: 'worker', profile: worker, pin: '2.1.300' }).ok, true);
  assert.equal((await readBack({ claudeBin: 'claude', args: [], env: {}, cwd: dir, role: 'worker', profile: worker, pin: '2.1.301', spawnFn: fake(goodInit('worker')) })).ok, false);
  // No start message: by the time limit, or because the program ended, or it would not start.
  assert.equal((await readBack({ claudeBin: 'claude', args: [], env: {}, cwd: dir, role: 'worker', profile: worker, spawnFn: fake('none'), timeoutMs: 300 })).reason, 'no start message in time');
  assert.equal((await readBack({ claudeBin: 'claude', args: [], env: {}, cwd: dir, role: 'worker', profile: worker, spawnFn: fake('none', { FAKE_EXIT: '1' }) })).ok, false);
  assert.equal((await readBack({ claudeBin: join(dir, 'no-such-claude'), args: [], env: {}, cwd: dir, role: 'worker', profile: worker })).ok, false);
});

test('read-back: the Lead has exactly Read, Glob, Grep, Write and AskUserQuestion; the Front Door only the orchestrate skill (R-0b-34, 39)', () => {
  const lead = DESIGN_PROFILES.lead;
  assert.deepEqual([...lead.tools].sort(), ['AskUserQuestion', 'Glob', 'Grep', 'Read', 'Write']);
  assert.equal(checkInit(goodInit('lead'), { role: 'lead', profile: lead }).ok, true);
  for (const t of ['Bash', 'Agent', 'Edit', 'WebFetch']) assert.equal(checkInit({ ...goodInit('lead'), tools: [...goodInit('lead').tools, t] }, { role: 'lead', profile: lead }).ok, false, t);
  const fd = DESIGN_PROFILES.front_door;
  assert.equal(checkInit(goodInit('front_door'), { role: 'front_door', profile: fd }).ok, true);
  assert.equal(checkInit({ ...goodInit('front_door'), skills: ['orchestrate', 'bob'] }, { role: 'front_door', profile: fd }).ok, false);
  assert.equal(checkInit({ ...goodInit('front_door'), skills: [] }, { role: 'front_door', profile: fd }).ok, false);
  // thinking is the Front Door's list without Skill (review m7).
  assert.deepEqual([...DESIGN_PROFILES.thinking.tools].sort(), fd.tools.filter((t) => t !== 'Skill').sort());
  assert.equal(checkInit({ ...goodInit('thinking'), tools: [...goodInit('thinking').tools, 'Skill'] }, { role: 'thinking', profile: DESIGN_PROFILES.thinking }).ok, false);
});

test('read-back: planted worker-bundle files are removed by check 2 before the start, so nothing they hold runs', async () => {
  const copy = tmp();
  const mark = join(tmp(), 'marker');
  const hook = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${mark}` }] }] }, statusLine: { type: 'command', command: `touch ${mark}` } };
  mkdirSync(join(copy, '.claude', 'skills', 'x'), { recursive: true });
  mkdirSync(join(copy, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(copy, '.claude', 'workflows'), { recursive: true });
  mkdirSync(join(copy, 'src', '.claude'), { recursive: true });
  writeFileSync(join(copy, '.claude', 'settings.json'), JSON.stringify(hook));
  writeFileSync(join(copy, '.claude', 'settings.local.json'), JSON.stringify(hook));
  writeFileSync(join(copy, '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n!`touch marker`\n');
  writeFileSync(join(copy, '.claude', 'agents', 'h.md'), '---\nmcpServers: [evil]\n---\n');
  writeFileSync(join(copy, '.claude', 'workflows', 'a.js'), 'export default 1');
  writeFileSync(join(copy, 'src', '.claude', 'settings.json'), JSON.stringify(hook));
  writeFileSync(join(copy, '.mcp.json'), '{"mcpServers":{"evil":{}}}');
  // Positive control: without check 2 the fake does run the planted hook.
  const fake = fakeClaude(tmp());
  const control = await readBack({ claudeBin: 'claude', args: [], env: {}, cwd: copy, role: 'worker', profile: DESIGN_PROFILES.worker, spawnFn: fake(goodInit('worker'), { FAKE_MARK: mark }) });
  assert.equal(control.ok, true);
  assert.equal(existsSync(mark), true, 'the planted hook ran without check 2');
  rmSync(mark);
  removeProtected(copy);
  assert.deepEqual(readdirSync(copy).sort(), ['src']);
  assert.deepEqual(readdirSync(join(copy, 'src')), []);
  const r = await readBack({ claudeBin: 'claude', args: [], env: {}, cwd: copy, role: 'worker', profile: DESIGN_PROFILES.worker, spawnFn: fake(goodInit('worker'), { FAKE_MARK: mark }) });
  assert.equal(r.ok, true);
  assert.equal(existsSync(mark), false);
});

// ---- check 9: no stray keys (R-0b-36, 34) ----

test('check 9: every refused variable is stripped, and a planted one refuses the start', () => {
  const base = { HOME: '/h', PATH: '/usr/bin', LANG: 'C' };
  for (const k of REFUSED_ENV) base[k] = 'planted';
  base.GH_TOKEN = 'planted'; base.GITHUB_TOKEN = 'planted'; base.SSH_AUTH_SOCK = '/s'; base.RANDOM_SERVICE_API_KEY = 'planted';
  const env = roleEnv(base, { path: '/w/bin' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(checkRoleEnv(env).ok, true);
  for (const k of [...REFUSED_ENV, 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'SOME_API_KEY', 'DB_PASSWORD']) {
    assert.equal(checkRoleEnv({ ...env, [k]: 'x' }).ok, false, k);
  }
  // Extra variables are stripped too if they are on the list.
  assert.equal(checkRoleEnv(roleEnv({}, { extra: { [REFUSED_ENV[0]]: 'x' } })).ok, true);
});

// ---- check 10: the machine-wide production block (R-0b-36) ----

test('check 10: the machine-wide file must carry the production guard and no escape', () => {
  const guard = { [H.matcher]: '*', [H.hooks]: [{ [H.type]: 'command', [H.command]: '/o/node /o/hooks/production-write-guard.mjs --role any', [H.timeout]: 10, [H.onFailure]: 'block' }] };
  const files = { '/fake/managed.json': JSON.stringify({ [S.hooks]: { [E.preToolUse]: [guard] } }) };
  const readFile = (p) => { if (!(p in files)) throw new Error('missing'); return files[p]; };
  assert.equal(checkMachineWide({ readFile, path: '/fake/managed.json' }).ok, true);
  const bad = {
    missing: null,
    'not JSON': '{',
    'no guard': JSON.stringify({ [S.hooks]: {} }),
    'guard does not block': JSON.stringify({ [S.hooks]: { [E.preToolUse]: [{ ...guard, [H.hooks]: [{ ...guard[H.hooks][0], [H.onFailure]: 'ignore' }] }] } }),
    'guard on one tool only': JSON.stringify({ [S.hooks]: { [E.preToolUse]: [{ ...guard, [H.matcher]: 'Bash' }] } }),
    excludedCommands: JSON.stringify({ [S.hooks]: { [E.preToolUse]: [guard] }, [S.sandbox]: { [S.excludedCommands]: ['git'] } }),
    'unsandboxed commands': JSON.stringify({ [S.hooks]: { [E.preToolUse]: [guard] }, [S.sandbox]: { [S.allowUnsandboxedCommands]: true } }),
    'an allow rule': JSON.stringify({ [S.hooks]: { [E.preToolUse]: [guard] }, [S.permissions]: { [S.allow]: ['Bash(*)'] } }),
    'an extra host': JSON.stringify({ [S.hooks]: { [E.preToolUse]: [guard] }, [S.sandbox]: { [S.network]: { [S.allowedDomains]: ['example.com'] } } }),
  };
  for (const [what, text] of Object.entries(bad)) {
    const r = checkMachineWide({ readFile: (p) => { if (text === null) throw new Error('missing'); return text; }, path: '/fake/managed.json' });
    assert.equal(r.ok, false, what);
  }
});

// ---- check 7: hooks and version (R-0b-37, 40) ----

function hookWorld(role = 'worker') {
  const root = tmp();
  const source = join(root, 'source'); cpSync(HOOKS_SOURCE, source, { recursive: true });
  for (const n of readdirSync(source)) if (n.endsWith('.test.mjs')) rmSync(join(source, n));
  const hooksDir = join(root, 'hooks');
  installHooks(hooksDir, source);
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  const copy = join(root, 'copy'); mkdirSync(copy);
  const keys = join(root, 'keys'); mkdirSync(keys);
  const snapshot = join(root, 'rules.json');
  const rules = { production: { env_files: [join(root, 'prod.env')], programs: ['fakehost'], hosts: ['db.prod.example.net'] }, secrets: { paths: [keys] } };
  writeFileSync(snapshot, makeSnapshot(rules));
  const profile = DESIGN_PROFILES[role];
  const r = renderRoleSettings({ role, profile, paths: { copy, outbox, hooksDir, snapshot, node: process.execPath, deny: { secrets: [keys] } }, product: { commands: { test: 'npm test' } } });
  assert.equal(r.ok, true, r.reason);
  const check = (over = {}) => checkHooks({ settings: r.settings, hooksDir, source, kinds: profile.outbox, copy, outbox, harmfulProduction: productionProbe(rules), timeoutMs: 1500, ...over });
  return { root, source, hooksDir, outbox, settings: r.settings, check, rules };
}

test('check 7: the installed hooks pass, for a worker and for the Lead', () => {
  for (const role of ['worker', 'lead', 'front_door']) {
    const w = hookWorld(role);
    const r = w.check();
    assert.equal(r.ok, true, `${role}: ${r.reason}`);
    assert.deepEqual(readdirSync(w.outbox), [], 'the probes write nothing');
  }
});

test('check 7: for each of the five hooks, a missing, unreadable, failing, odd-answering, always-passing or slow script refuses', () => {
  const broken = {
    'exit 1': 'process.exit(1);\n',
    'bad output': "import { readFileSync } from 'node:fs';\nconst t = readFileSync(0, 'utf8');\nif (/probe|\"true\"/.test(t)) { console.log('not an answer'); process.exit(0); }\nprocess.exit(2);\n",
    'always passes': 'process.exit(0);\n',
    'sleeps past the limit': 'setTimeout(() => process.exit(0), 60000);\n',
  };
  for (const name of Object.keys(POLICY_HOOKS)) {
    for (const [what, body] of Object.entries(broken)) {
      const w = hookWorld();
      for (const d of [w.source, w.hooksDir]) writeFileSync(join(d, `${name}.mjs`), body);
      const r = w.check();
      assert.equal(r.ok, false, `${name} ${what}`);
      assert.match(r.reason, new RegExp(name), `${name} ${what}: ${r.reason}`);
      if (what === 'sleeps past the limit') assert.match(r.reason, /did not answer within/);
    }
    const missing = hookWorld();
    for (const d of [missing.source, missing.hooksDir]) rmSync(join(d, `${name}.mjs`));
    assert.equal(missing.check().ok, false, `${name} missing`);
    const unreadable = hookWorld();
    for (const d of [unreadable.source, unreadable.hooksDir]) chmodSync(join(d, `${name}.mjs`), 0o000);
    assert.equal(unreadable.check().ok, false, `${name} unreadable`);
    const notRunnable = hookWorld();
    chmodSync(join(notRunnable.hooksDir, `${name}.mjs`), 0o644);
    assert.equal(notRunnable.check().ok, false, `${name} not runnable`);
  }
});

test('check 7: a differing or extra file, or an entry that does not block within 10 s, refuses', () => {
  const differs = hookWorld();
  writeFileSync(join(differs.hooksDir, 'lib.mjs'), `${readFileSync(join(differs.hooksDir, 'lib.mjs'), 'utf8')}\n// changed\n`);
  assert.match(differs.check().reason, /differs/);
  const extra = hookWorld();
  writeFileSync(join(extra.hooksDir, 'extra.mjs'), '');
  assert.match(extra.check().reason, /different files/);
  const mutate = (fn) => { const w = hookWorld(); const s = structuredClone(w.settings); fn(s); return w.check({ settings: s }); };
  assert.equal(mutate((s) => { s[S.hooks][E.preToolUse][0][H.hooks][0][H.onFailure] = 'ignore'; }).ok, false);
  assert.equal(mutate((s) => { s[S.hooks][E.preToolUse][1][H.hooks][0][H.timeout] = 60; }).ok, false);
  assert.equal(mutate((s) => { s[S.hooks][E.preToolUse].splice(2, 1); }).ok, false);
  assert.equal(mutate((s) => { const h = s[S.hooks][E.preToolUse][0][H.hooks][0]; h[H.command] = h[H.command].replace(/ \S+\/plain-files\.mjs/, ' /elsewhere/plain-files.mjs'); }).ok, false);
  assert.equal(mutate((s) => { s[S.hooks][E.preCompact][0][H.hooks][0][H.onFailure] = 'ignore'; }).ok, false);
  assert.equal(mutate((s) => { delete s[S.hooks]; }).ok, false);
  // No harmful probe for the production guard (no production programs in the rules): refuse.
  assert.equal(hookWorld().check({ harmfulProduction: null }).ok, false);
});

test('check 7: merge guard blocks the GitHub merge routes fed as tool calls', () => {
  const w = hookWorld();
  const cmd = w.settings[S.hooks][E.preToolUse].find((m) => m[H.hooks][0][H.command].includes('/merge-guard.mjs '))[H.hooks][0][H.command].split(' ');
  for (const c of ['gh api -X PUT repos/o/r/pulls/1/merge', 'git push origin HEAD:refs/heads/main', 'curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge']) {
    const r = spawnSync(cmd[0], cmd.slice(1), { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: c } }), encoding: 'utf8' });
    assert.equal(r.status, 2, c);
  }
});

test('check 7: Claude Code must be the pinned version, from its pinned folder, at least 2.1.295', () => {
  const root = '/o';
  const ok = (v) => () => `${v} (Claude Code)\n`;
  assert.equal(checkVersion({ claudeBin: pinnedBinary(root, '2.1.300'), root, pin: '2.1.300', run: ok('2.1.300') }).ok, true);
  assert.equal(checkVersion({ claudeBin: pinnedBinary(root, '2.1.300'), root, pin: '2.1.300', run: ok('2.1.301') }).ok, false);
  assert.equal(checkVersion({ claudeBin: pinnedBinary(root, '2.1.200'), root, pin: '2.1.200', run: ok('2.1.200') }).ok, false);
  assert.equal(checkVersion({ claudeBin: '/usr/local/bin/claude', root, pin: '2.1.300', run: ok('2.1.300') }).ok, false);
  assert.equal(checkVersion({ claudeBin: pinnedBinary(root, '2.1.300'), root, pin: undefined, run: ok('2.1.300') }).ok, false);
  assert.equal(checkVersion({ claudeBin: pinnedBinary(root, '2.1.300'), root, pin: '2.1.300', run: () => 'no version here' }).ok, false);
  assert.equal(checkVersion({ claudeBin: pinnedBinary(root, '2.1.300'), root, pin: '2.1.300', run: () => { throw new Error('x'); } }).ok, false);
});

test('check 8: the rules snapshot must be present and fresh', () => {
  const d = tmp();
  const p = join(d, 'rules.json');
  assert.equal(checkSnapshot(p).ok, false);
  writeFileSync(p, makeSnapshot({ a: 1 }));
  assert.equal(checkSnapshot(p).ok, true);
  writeFileSync(p, makeSnapshot({ a: 1 }, new Date(Date.now() - 6 * 60 * 1000)));
  assert.equal(checkSnapshot(p).ok, false);
});

// ---- check 3: the outbox (R-0b-38) ----

test('check 3: the outbox is emptied only when nothing holds it; odd entries raise an alert', () => {
  const d = tmp();
  const outbox = join(d, 'outbox'); mkdirSync(outbox);
  const outside = join(d, 'keep.txt'); writeFileSync(outside, 'keep');
  writeFileSync(join(outbox, 'report-T-1.md'), 'x');
  writeFileSync(join(outbox, '.envrc'), 'x');
  mkdirSync(join(outbox, 'sub')); writeFileSync(join(outbox, 'sub', 'a.md'), 'x');
  symlinkSync(outside, join(outbox, 'report-T-2.md'));
  // A background program still holds it: nothing is removed.
  assert.equal(emptyOutbox(outbox, { busy: () => ['pid 42 (helper)'] }).ok, false);
  assert.equal(readdirSync(outbox).length, 4);
  assert.equal(emptyOutbox(outbox, { busy: () => { throw new Error('x'); } }).ok, false);
  assert.equal(emptyOutbox(outbox, { busy: () => 'none' }).ok, false);
  const alerts = [];
  const r = emptyOutbox(outbox, { busy: () => [], alert: (m) => alerts.push(m) });
  assert.equal(r.ok, true);
  assert.deepEqual(readdirSync(outbox), []);
  assert.deepEqual(r.removed.sort(), ['.envrc', 'report-T-2.md', 'sub']);
  assert.equal(alerts.length, 1);
  assert.equal(readFileSync(outside, 'utf8'), 'keep', 'a link is removed, not its target');
  // The outbox itself as a link: refused, and the target is untouched.
  const real = join(d, 'real'); mkdirSync(real); writeFileSync(join(real, 'report-T-3.md'), 'x');
  const linked = join(d, 'linked'); symlinkSync(real, linked);
  assert.equal(emptyOutbox(linked, { busy: () => [] }).ok, false);
  assert.deepEqual(readdirSync(real), ['report-T-3.md']);
});

test('intake: only a plain, single-link file of the role user, with an allowed name and kind, is read', () => {
  const d = tmp();
  const outbox = join(d, 'outbox'); mkdirSync(outbox);
  const uid = process.getuid();
  writeFileSync(join(outbox, 'ask-T-0001.json'), '{"q":1}');
  assert.deepEqual(readOutboxFile(outbox, 'ask-T-0001.json', { kinds: ['ask'], uid }), { ok: true, kind: 'ask', text: '{"q":1}' });
  writeFileSync(join(outbox, 'report-T-1.md'), 'x');
  assert.equal(readOutboxFile(outbox, 'report-T-1.md', { kinds: ['report'], uid: uid + 1 }).ok, false, 'another owner');
  linkSync(join(outbox, 'report-T-1.md'), join(d, 'second-link'));
  assert.equal(readOutboxFile(outbox, 'report-T-1.md', { kinds: ['report'], uid }).ok, false, 'hard link');
  writeFileSync(join(d, 'elsewhere'), 'x'); symlinkSync(join(d, 'elsewhere'), join(outbox, 'report-T-2.md'));
  assert.equal(readOutboxFile(outbox, 'report-T-2.md', { kinds: ['report'], uid }).ok, false, 'link');
  mkdirSync(join(outbox, 'report-T-3.md'));
  assert.equal(readOutboxFile(outbox, 'report-T-3.md', { kinds: ['report'], uid }).ok, false, 'folder');
  assert.equal(readOutboxFile(outbox, 'ask-T-0001.json', { kinds: ['report'], uid }).ok, false, 'not this role\'s kind');
  for (const n of ['.ask-T-1.json', 'ask_T.json', 'ask-T-1.sh', '../ask-T-1.json', 'ASK-T-1.json']) assert.equal(readOutboxFile(outbox, n, { kinds: ['ask'], uid }).ok, false, n);
});

// ---- check 4: the install step (R-0b-33) ----

test('check 4: the registry is allowed for the install step only', async () => {
  const profile = DESIGN_PROFILES.worker;
  const paths = { copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node' };
  const registryHosts = ['registry.example.org'];
  const render = (phase) => renderRoleSettings({ role: 'worker', profile, paths, product: { commands: { test: 'npm test' } }, registryHosts, phase });
  const written = [];
  const write = (s) => { written.push(s[S.sandbox][S.network][S.allowedDomains]); return { ok: true }; };
  let seenDuringInstall;
  assert.equal((await installStep({ render, write, install: async () => { seenDuringInstall = written.at(-1); return { ok: true }; }, registryHosts })).ok, true);
  assert.deepEqual(seenDuringInstall, registryHosts);
  assert.deepEqual(written.at(-1), []);
  // A failed install still leaves the session file without the registry, and refuses.
  written.length = 0;
  assert.equal((await installStep({ render, write, install: async () => { throw new Error('network'); }, registryHosts })).ok, false);
  assert.deepEqual(written.at(-1), []);
  // A session file that still allows the registry is refused, even if the renderer kept it.
  const leaky = (phase) => { const x = render('install'); return phase === 'install' ? x : x; };
  assert.match((await installStep({ render: leaky, write: () => ({ ok: true }), install: async () => ({ ok: true }), registryHosts })).reason, /still allowed/);
  // Only a worker has an install step.
  assert.equal(renderRoleSettings({ role: 'lead', profile: DESIGN_PROFILES.lead, paths, phase: 'install' }).ok, false);
  // A card that changes the dependency files triggers an install at the next round.
  const first = needsInstall({ lastInstalledHash: null, files: [['package-lock.json', 'a']] });
  assert.equal(first.needed, true);
  assert.equal(needsInstall({ lastInstalledHash: first.hash, files: [['package-lock.json', 'a']] }).needed, false);
  assert.equal(needsInstall({ lastInstalledHash: first.hash, files: [['package-lock.json', 'b']] }).needed, true);
});

// ---- check 13: the Bob method folder ----

test('check 13: the Bob folder matches the pin, holds no skill, and is read-only', () => {
  const d = tmp();
  const bob = join(d, 'bob'); mkdirSync(join(bob, 'modes'), { recursive: true });
  writeFileSync(join(bob, 'rules.md'), 'r'); writeFileSync(join(bob, 'modes', 'audit.md'), 'a');
  const manifest = { 'rules.md': sha256(Buffer.from('r')), [join('modes', 'audit.md')]: sha256(Buffer.from('a')) };
  const abs = bob.replace(/^\/+/, '');
  const settings = { [S.permissions]: { [S.deny]: [`Edit(/${abs}/**)`, `Write(/${abs}/**)`] } };
  assert.equal(checkBobFolder({ folder: bob, manifest, settings }).ok, true);
  assert.equal(checkBobFolder({ folder: bob, manifest, settings: {} }).ok, false, 'not read-only');
  assert.equal(checkBobFolder({ folder: join(d, 'none'), manifest, settings }).ok, false, 'missing');
  assert.equal(checkBobFolder({ folder: bob, manifest: {}, settings }).ok, false, 'no pin');
  assert.equal(checkBobFolder({ folder: bob, manifest: { ...manifest, 'core.md': 'x' }, settings }).ok, false, 'a pinned file is missing');
  const plant = (rel, fn) => { const p = join(bob, rel); mkdirSync(join(p, '..'), { recursive: true }); fn(p); const r = checkBobFolder({ folder: bob, manifest, settings }); rmSync(join(bob, rel.split('/')[0]), { recursive: true, force: true }); return r; };
  assert.equal(plant('SKILL.md', (p) => writeFileSync(p, 's')).ok, false);
  assert.equal(plant('skills/x/a.md', (p) => writeFileSync(p, 's')).ok, false);
  assert.equal(plant('skill/a.md', (p) => writeFileSync(p, 's')).ok, false);
  assert.equal(plant('extra.md', (p) => writeFileSync(p, 's')).ok, false);
  assert.match(plant('link.md', (p) => symlinkSync(join(bob, 'rules.md'), p)).reason, /link/);
  writeFileSync(join(bob, 'rules.md'), 'changed');
  assert.equal(checkBobFolder({ folder: bob, manifest, settings }).ok, false, 'changed file');
});

// ---- check 11: baseline and smoke (R-0b-41) ----

test('check 11: baseline and smoke run through the worker start, as the same user, with Bash only', async () => {
  const c = lockedRunCommand({ claudeBin: '/o/claude-code/2.1.300/claude', settingsFile: '/w/worker.json', command: 'npm test', roleArgs, profile: DESIGN_PROFILES.worker });
  assert.equal(c.ok, true);
  assert.equal(c.args[c.args.indexOf('--settings') + 1], '/w/worker.json');
  assert.equal(c.args[c.args.indexOf('--tools') + 1], 'Bash');
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!('uid' in c.spawnOptions) && !('gid' in c.spawnOptions));
  assert.ok(!c.args.some((a) => /^(sudo|su)$/.test(a)));
  assert.equal(lockedRunCommand({ claudeBin: 'x', settingsFile: 'y', command: ' ', roleArgs, profile: DESIGN_PROFILES.worker }).ok, false);
  // Smoke: the write outside the copy and the reach to github.com must both fail.
  const d = tmp(); const marker = join(d, 'outside');
  const markerExists = () => existsSync(marker);
  assert.equal((await smokeTest({ run: async () => ({ exitCode: 1, networkReached: false }), markerExists })).ok, true);
  assert.equal((await smokeTest({ run: async () => ({ exitCode: 0, networkReached: true }), markerExists })).ok, false);
  assert.equal((await smokeTest({ run: async () => ({ exitCode: 0 }), markerExists })).ok, false, 'unknown network result');
  assert.equal((await smokeTest({ run: async () => { throw new Error('x'); }, markerExists })).ok, false);
  writeFileSync(marker, 'x');
  assert.equal((await smokeTest({ run: async () => ({ exitCode: 1, networkReached: false }), markerExists })).ok, false);
  // Baseline: a planted test-setup file that reads the key folder and calls GitHub fails inside
  // the lock-down, so the baseline fails and the launch stops.
  assert.equal((await baselineTest({ run: async () => ({ exitCode: 0 }) })).ok, true);
  assert.equal((await baselineTest({ run: async () => ({ exitCode: 1, stderr: 'keys: operation not permitted' }) })).ok, false);
});

// ---- attack tests (R-0b-43, code part) ----

test('attacks from a worker: writing the store, pushing to main and appending an approval are all refused', () => {
  const w = hookWorld();
  const pre = w.settings[S.hooks][E.preToolUse];
  const cmdOf = (name) => pre.find((m) => m[H.hooks][0][H.command].includes(`/${name}.mjs `))[H.hooks][0][H.command].split(' ');
  const run = (name, input) => { const c = cmdOf(name); return spawnSync(c[0], c.slice(1), { input: JSON.stringify(input), encoding: 'utf8' }).status; };
  const store = join(w.root, 'store'); mkdirSync(store);
  assert.equal(run('plain-files', { tool_name: 'Write', tool_input: { file_path: join(store, 'card-C-1.json') } }), 2);
  assert.equal(run('merge-guard', { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } }), 2);
  assert.equal(run('plain-files', { tool_name: 'Write', tool_input: { file_path: join(w.outbox, 'go-C-1.json') } }), 2, 'not a worker kind');
  // Even if such a file got into the outbox, the intake refuses the kind, and the record refuses
  // a direct write by any AI role.
  writeFileSync(join(w.outbox, 'go-C-1.json'), '{"approved":true}');
  assert.equal(readOutboxFile(w.outbox, 'go-C-1.json', { kinds: DESIGN_PROFILES.worker.outbox, uid: process.getuid() }).ok, false);
  const rec = memoryRecord();
  assert.equal(rec.write({ actor: 'worker:s-1', entity: 'go', id: 'G-1', expectRev: 0, doc: { approved: true }, kind: 'approval' }).ok, false);
});

// ---- planted failures for each refusal line, checked by their own reasons (audit R-0b-44 M-6) ----

test('check 7: a missing hook folder, no outbox kinds, a hook that is not a command or runs from elsewhere each refuse with their own reason', () => {
  const w = hookWorld();
  assert.equal(w.check({ hooksDir: join(w.root, 'none') }).reason, 'the hook folder is missing');
  assert.equal(w.check({ kinds: [] }).reason, 'the role has no outbox kinds');
  const edit = (fn) => { const s = structuredClone(w.settings); fn(s); return w.check({ settings: s }); };
  const plainHook = (s) => s[S.hooks][E.preToolUse].find((m) => m[H.hooks][0][H.command].includes('/plain-files.mjs '))[H.hooks][0];
  assert.equal(edit((s) => { plainHook(s)[H.type] = 'prompt'; }).reason, 'the plain-files hook is not a command');
  // A full, working copy of the hooks in another folder: only the folder check can refuse it.
  const other = join(w.root, 'other-hooks');
  installHooks(other, w.source);
  assert.equal(edit((s) => { const h = plainHook(s); h[H.command] = h[H.command].replace(join(w.hooksDir, 'plain-files.mjs'), join(other, 'plain-files.mjs')); }).reason,
    'the plain-files hook runs a script outside the hook folder');
  assert.equal(edit((s) => { const h = s[S.hooks][E.preCompact][0][H.hooks][0]; h[H.command] = h[H.command].replace(join(w.hooksDir, 'compact-note.mjs'), join(other, 'compact-note.mjs')); }).reason,
    'a PreCompact hook runs a script outside the hook folder');
  chmodSync(join(w.hooksDir, 'compact-note.mjs'), 0o644);
  assert.match(w.check().reason, /^the (PreCompact|PostCompact|SessionStart) hook is not readable and runnable$/);
});

test('check 4: a role file that will not write, before or after the install, refuses with its own reason', async () => {
  const paths = { copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node' };
  const render = (phase) => renderRoleSettings({ role: 'worker', profile: DESIGN_PROFILES.worker, paths, product: { commands: { test: 'npm test' } }, registryHosts: ['registry.example.org'], phase });
  const failOn = (n) => { let i = 0; return () => (++i === n ? { ok: false, reason: 'disk full' } : { ok: true }); };
  let ran = false;
  const install = async () => { ran = true; return { ok: true }; };
  assert.equal((await installStep({ render, write: failOn(1), install, registryHosts: ['registry.example.org'] })).reason, 'install role file: disk full');
  assert.equal(ran, false, 'no install without the install role file');
  assert.equal((await installStep({ render, write: failOn(2), install, registryHosts: ['registry.example.org'] })).reason, 'session role file: disk full');
});

test('check 13: each Bob folder refusal gives its own reason', () => {
  const d = tmp();
  const bob = join(d, 'bob'); mkdirSync(bob);
  writeFileSync(join(bob, 'rules.md'), 'r');
  const manifest = { 'rules.md': sha256(Buffer.from('r')) };
  const abs = bob.replace(/^\/+/, '');
  const settings = { [S.permissions]: { [S.deny]: [`Edit(/${abs}/**)`, `Write(/${abs}/**)`] } };
  const file = join(d, 'a-file'); writeFileSync(file, 'x');
  assert.equal(checkBobFolder({ folder: file, manifest, settings }).reason, 'the Bob folder is not a plain folder');
  assert.equal(checkBobFolder({ folder: bob, manifest: {}, settings }).reason, 'no pinned Bob file list');
  const plant = (rel, fn) => { const p = join(bob, rel); mkdirSync(join(p, '..'), { recursive: true }); fn(p); const r = checkBobFolder({ folder: bob, manifest, settings }); rmSync(join(bob, rel.split('/')[0]), { recursive: true, force: true }); return r.reason; };
  assert.equal(plant('link.md', (p) => symlinkSync(join(bob, 'rules.md'), p)), 'the Bob folder holds a link (link.md)');
  assert.equal(plant('SKILL.md', (p) => writeFileSync(p, 's')), 'the Bob folder holds a skill (SKILL.md)');
  assert.equal(plant('skills/a.md', (p) => writeFileSync(p, 's')), 'the Bob folder holds a skills folder (skills/a.md)');
  assert.equal(plant('extra.md', (p) => writeFileSync(p, 's')), 'the Bob folder holds a file the pin does not (extra.md)');
  assert.equal(checkBobFolder({ folder: bob, manifest, settings }).ok, true);
});

test('check 11: a smoke or baseline run that does not finish refuses with its own reason', async () => {
  const boom = async () => { throw new Error('boom'); };
  assert.equal((await smokeTest({ run: boom, markerExists: () => false })).reason, 'the smoke run did not finish: boom');
  assert.equal((await baselineTest({ run: boom })).reason, 'the baseline run did not finish: boom');
});

test('check 3 and intake: a missing outbox, and an outbox entry that is a folder, refuse with their own reason', () => {
  const d = tmp();
  assert.equal(emptyOutbox(join(d, 'none'), { busy: () => [] }).reason, 'the outbox is missing');
  mkdirSync(join(d, 'report-T-1.md'));
  assert.equal(readOutboxFile(d, 'report-T-1.md', { kinds: ['report'], uid: process.getuid() }).reason, '"report-T-1.md" is not a plain file');
});

test('check 6 and 10: a start message missing a field, and a machine-wide file that is not JSON, refuse with their own reason', () => {
  for (const k of ['tools', 'mcp_servers', 'plugins', 'skills', 'setting_sources', 'permissionMode']) {
    const i = goodInit('worker'); delete i[k];
    assert.equal(checkInit(i, { role: 'worker', profile: DESIGN_PROFILES.worker }).reason, `start message has no ${k}`);
  }
  assert.equal(checkMachineWide({ readFile: () => '{', path: '/w/managed.json' }).reason, 'machine-wide settings are missing or not JSON');
});
