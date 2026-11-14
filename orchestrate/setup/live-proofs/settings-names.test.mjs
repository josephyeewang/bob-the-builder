// Live check L2 with L6 harness (R-0b-177): its pairs, its judging, its guards and the user settings file's backup, with
// a stand-in claude. The real run needs the Mini's worker user and the pinned claude (L988); here claude is a function
// that honours a few settings the way the pin does, and plants show each way a run must turn red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tempDir } from '../../shared/test-tmp.mjs';
import { BACKUP_SUFFIX, BAD_EFFORT, CONNECTORS_FALLBACK, META_SUFFIX, NOT_TRIED, NOT_USED, SPELLING_LABEL, misspell, READBACK_NAMES, TESTS, allNames, finish, guardProblem, judgeNames, main, report, restoreUserFile, roleReadback, runAll, runArgs, runProblem, runToEnd, withUserSettings, writeReceipt } from './settings-names.mjs';
import { CONFIRMED, FLAGS as F, PROOF_KIND, REFUSED_SETTINGS, SPELLING_ONLY, noToolServerArgs, proofCounts, sourcesArgs, unconfirmedNames } from '../../modules/M4-workshop/launcher/settings-names.mjs';
import { FIRST_ROUND_EFFORT, SEND_BACK_EFFORT } from '../../modules/M4-workshop/launcher/review-launch.mjs';
import { sourcesProblem } from '../../modules/M4-workshop/launcher/readback.mjs';
import { DESIGN_PROFILES } from '../../modules/M4-workshop/launcher/role-profiles.mjs';

const PIN = '2.1.316';
const byId = (id) => TESTS.find((t) => t.id === id);

// ---- a stand-in claude ----
// It reads the --settings file and, unless --setting-sources or --restricted says otherwise, the user, project and
// local files too; runs every SessionStart hook in them; and prints a start message with the model and session id.
// `plant` breaks one thing the way a wrong name would.
const word = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
function fakeClaude({ userFile, plant = {} }) {
  return async (args, { cwd }) => {
    const files = [word(args, F.settings)];
    const limited = args.includes(F.settingSources) && !plant.ignoreSources;
    if (!limited && !(args.includes(F.restricted) && !plant.ignoreRestricted)) files.push(userFile, join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
    for (const f of files) {
      if (!existsSync(f)) continue;
      const s = JSON.parse(readFileSync(f, 'utf8'));
      if (plant.noHooks) continue;
      for (const h of s.hooks?.SessionStart ?? []) for (const x of h.hooks ?? []) execFileSync('/bin/sh', ['-c', x.command]);
    }
    const init = { type: 'system', subtype: 'init', session_id: plant.ownSessionId ? randomUUID() : (word(args, F.sessionId) ?? randomUUID()),
      model: plant.oneModel ? 'claude-sonnet' : `claude-${word(args, F.model)}`, claude_code_version: PIN };
    return { out: `${JSON.stringify(init)}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ready' })}\n`, err: '', code: 0 };
  };
}
const FAKE_TESTS = ['settingSources', 'sessionStart', 'restricted', 'sessionId', 'model', 'version'].map(byId);
async function fakeRun({ plant, userText, tests = FAKE_TESTS, guardPassed = true, readback = { ok: true } } = {}) {
  const root = tempDir('orch-names-');
  const base = join(root, 'runs'); mkdirSync(base);
  const userFile = join(root, 'account', 'settings.json'); mkdirSync(join(root, 'account'));
  if (userText !== undefined) { writeFileSync(userFile, userText); chmodSync(userFile, 0o640); }
  const io = { claude: fakeClaude({ userFile, plant }), readbackAll: async () => readback, userFile, guardPassed, sleep: async () => {} };
  const res = await runAll({ base, io, tests });
  return { ...res, userFile, root };
}

// ---- the pairs ----

test('each test is a pair that differs in one thing, and every run limits the settings sources unless it is about them', () => {
  const d = '/x/run';
  for (const t of TESTS.filter((x) => !x.byGuard)) {
    const on = t.run('on', d, { sessionId: 's' }); const off = t.run('off', d, { sessionId: 's' });
    const a = runArgs({ ...on, settingsFile: '/f' }); const b = runArgs({ ...off, settingsFile: '/f' });
    const differ = JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(on.settings ?? {}) !== JSON.stringify(off.settings ?? {})
      || JSON.stringify(t.files?.('on', d) ?? {}) !== JSON.stringify(t.files?.('off', d) ?? {}) || t.user !== undefined;
    assert.ok(differ, `${t.id}: the two sides are the same`);
    for (const [side, args, o] of [['on', a, on], ['off', b, off]]) {
      if (o.sources === false) assert.ok(!args.includes(F.settingSources), `${t.id} ${side}`);
      else assert.equal(sourcesProblem(args), null, `${t.id} ${side}: ${sourcesProblem(args)}`);
      assert.equal(args[args.length - 1], o.prompt ?? 'Reply with the word ready.', `${t.id}: the prompt is last`);
    }
    assert.ok(t.names.length > 0 && t.names.every((n) => allNames().includes(n)), `${t.id}: names a name the launcher does not use`);
  }
  // The sources test is the one that leaves the limit off, on its off side only.
  assert.ok(runArgs({ ...byId('settingSources').run('on', d), settingsFile: '/f' }).includes(F.settingSources));
  assert.ok(!runArgs({ ...byId('settingSources').run('off', d), settingsFile: '/f' }).includes(F.settingSources));
});

// A judge's "no": a reason why it failed, or (L1114) why the pair could not show the name.
const isNo = (v) => typeof v === 'string' || (v !== null && typeof v === 'object' && typeof v.notTried === 'string' && v.notTried.length > 20);

test('every judge passes only what the setting does: nothing happening on both sides, or both sides alike, is a FAIL', () => {
  // The spelling control (off) must be the normal run; the swapped pair, the name's side normal and the control not, is no.
  const sp = [['skipped|-', 'loaded|-'], ['loaded|-', 'loaded|-'], ['skipped|named', 'skipped|named'], ['loaded|named', 'loaded|named'], ['loaded|-', 'skipped|-'], ['loaded|-', 'loaded|named'], ['skipped|named', 'skipped|-']];
  const samples = { disableBundledSkills: [[3, 9], [9, 9], [9, 3], [null, 9]], disableClaudeAiConnectors: [[0, 2], [0, 0], [2, 2], [null, 2], [0, null], [null, null]], strictMcp: [[false, true], [false, false], [true, true], [null, true], [true, false], [null, null], [false, null]],
    'spelling-failIfUnavailable': sp, 'spelling-strictAllowlist': sp, 'spelling-crossSessionInbound': sp,
    model: [['claude-haiku-4', 'claude-sonnet-4'], ['claude-sonnet-4', 'claude-sonnet-4'], ['', ''], ['claude-sonnet', 'claude-haiku']] };
  for (const t of TESTS.filter((x) => !x.byGuard)) {
    const [good, ...bad] = samples[t.id] ?? (() => {
      // sameBut: its own wanted pair passes; each side alone, and the swapped pair, fail.
      const probe = []; for (const on of [true, false, '111', '000', 'pre/post', '-/-', '-,-,-', 'user,project,local']) for (const off of [true, false, '111', '000', 'pre/post', '-/-', '-,-,-', 'user,project,local']) if (t.judge(on, off) === null) probe.push([on, off]);
      assert.equal(probe.length, 1, `${t.id}: ${probe.length} outcomes pass, want exactly one`);
      const [on, off] = probe[0];
      return [[on, off], [off, off], [on, on], [off, on]];
    })();
    assert.equal(t.judge(...good), null, `${t.id}: the good outcome fails`);
    for (const b of bad) assert.ok(isNo(t.judge(...b)), `${t.id}: ${JSON.stringify(b)} passed`);
  }
});

test('L1114: a spelling pair with no difference, or an account with no connector, is NOT TRIED with its reason, never PASS or FAIL', () => {
  for (const id of ['spelling-failIfUnavailable', 'spelling-strictAllowlist', 'spelling-crossSessionInbound']) {
    const t = byId(id);
    assert.equal(t.kind, 'spelling');
    assert.equal(t.judge('loaded|-', 'loaded|-')?.notTried?.includes('no difference'), true, id);
    // The two sides hold the same value, one under the name and one under a spelling the CLI can't know.
    const d = '/x'; const on = JSON.stringify(t.run('on', d).settings); const off = JSON.stringify(t.run('off', d).settings);
    const [name] = t.names;
    assert.ok(on.includes(`"${name}"`) && !off.includes(`"${name}"`) && off.includes(`"${misspell(name)}"`), id);
    assert.notEqual(misspell(name), name); assert.equal(misspell(name).length, name.length);
    assert.equal(on.replace(name, misspell(name)), off, `${id}: the sides differ only in the spelling`);
  }
  assert.deepEqual(byId('disableClaudeAiConnectors').judge(0, 0), { notTried: CONNECTORS_FALLBACK, fallback: 'b' });
  assert.match(byId('strictMcp').judge(false, false).notTried, /nothing to hold out/);
  // A run whose start message had no server list is no answer at all: a FAIL, not the both-absent NOT TRIED.
  assert.equal(typeof byId('strictMcp').judge(null, null), 'string');
  // m6: both sides of the lock pair leave the sources limit off, so the project's server can reach the run.
  for (const side of ['on', 'off']) assert.ok(!runArgs({ ...byId('strictMcp').run(side, '/x'), settingsFile: '/f' }).includes(F.settingSources), side);
  // judgeNames: the reason reaches the line; the fallback too.
  const all = Object.fromEntries(TESTS.map((t) => [t.id, { ok: true }]));
  const lines = judgeNames({ outcomes: { ...all, disableClaudeAiConnectors: { ok: null, notTried: CONNECTORS_FALLBACK, fallback: 'b' },
    'spelling-crossSessionInbound': { ok: null, notTried: 'the spelling pair showed no difference (loaded|- both ways), so the name is not proven' } }, readback: { ok: true }, version: PIN, confirmed: {} });
  const conn = lines.find((l) => l.name === 'disableClaudeAiConnectors');
  assert.equal(conn.result, 'NOT TRIED'); assert.equal(conn.why, CONNECTORS_FALLBACK); assert.equal(conn.fallback, 'b');
  assert.equal(lines.find((l) => l.name === 'crossSessionInbound').result, 'NOT TRIED');
  // A not-tried outcome never borrows an older CONFIRMED entry.
  const c = { crossSessionInbound: { by: 'spelling:settings-names.mjs "x"', version: PIN } };
  assert.equal(judgeNames({ outcomes: { 'spelling-crossSessionInbound': { ok: null, notTried: 'the spelling pair showed no difference here' } }, version: PIN, confirmed: c })
    .find((l) => l.name === 'crossSessionInbound').result, 'NOT TRIED');
  // A spelling PASS is labelled as a name confirmed, never as behaviour, in the line and the printed report.
  const sp = lines.find((l) => l.name === 'failIfUnavailable');
  assert.equal(sp.result, 'PASS'); assert.equal(sp.proof, SPELLING_LABEL); assert.match(sp.by, /^spelling:settings-names\.mjs "/);
  assert.equal(lines.find((l) => l.name === 'deny').proof, undefined);
  assert.ok(report(lines, PIN).text.split('\n').some((l) => l.startsWith('PASS') && l.includes('failIfUnavailable') && l.includes(SPELLING_LABEL)));
  // enabledPlugins: NOT USED, not counted.
  assert.equal(lines.find((l) => l.name === 'enabledPlugins').result, 'NOT USED');
  // Every pair passing and the read-back passing leaves only allowUnsandboxedCommands (proven by the walls proof).
  assert.deepEqual(judgeNames({ outcomes: all, readback: { ok: true }, version: PIN, confirmed: {} }).filter((l) => l.result === 'NOT TRIED').map((l) => l.name), Object.keys(NOT_TRIED));
});


// ---- L1124: a side counts only when it ran properly ----

// A stand-in for one Bash pair (deny): the mark is the call's target; `how[side]` says what that side's run does.
const evt = (o) => JSON.stringify(o);
const INIT = evt({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-x', claude_code_version: PIN, cwd: '/x' });
const OK = evt({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
function bashFake(how) {
  return async (args, { cwd }) => {
    const side = JSON.parse(readFileSync(word(args, F.settings), 'utf8')).permissions?.deny ? 'on' : 'off';
    const m = join(cwd, 'mark'); const use = evt({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `touch ${m}` } }] } });
    const res = (o) => evt({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', ...o }] } });
    switch (how[side]) {
      case 'runs': writeFileSync(m, ''); return { out: [INIT, use, res({ content: '' }), OK].join('\n'), err: '', code: 0 };
      case 'refused': return { out: [INIT, use, res({ is_error: true, content: 'Permission to use Bash has been denied.' }), OK].join('\n'), err: '', code: 0 };
      case 'silent': return { out: [INIT, use, res({ content: 'ok' }), OK].join('\n'), err: '', code: 0 };
      case 'noCall': return { out: [INIT, OK].join('\n'), err: '', code: 0 };
      case 'api': return { out: [INIT, evt({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded' })].join('\n'), err: '', code: 1 };
      case 'nothing': return { out: '', err: 'Error: something broke', code: 1 };
      case 'timeout': return { out: INIT, err: '', signal: 'SIGKILL', timedOut: true };
      default: throw new Error(how[side]);
    }
  };
}
async function runDeny(how) {
  const root = tempDir('orch-names-');
  const base = join(root, 'runs'); mkdirSync(base);
  const io = { claude: bashFake(how), readbackAll: async () => ({ ok: true }), userFile: join(root, 'settings.json'), guardPassed: true, sleep: async () => {} };
  return (await runAll({ base, io, tests: [byId('deny')] })).outcomes.deny;
}

test('m1: a pair passes only when both sides ran properly and the refused side shows claude refusing', async () => {
  assert.equal((await runDeny({ on: 'refused', off: 'runs' })).ok, true);
  // Each way nothing happened on the "on" side, where the judge wants no mark, is NOT TRIED with its reason, never PASS.
  for (const [on, why] of [['nothing', /no start message.*something broke/], ['api', /API Error: 529/], ['silent', /no refusal from claude/], ['noCall', /no Bash call holding/], ['timeout', /time limit/]]) {
    const o = await runDeny({ on, off: 'runs' });
    assert.equal(o.ok, null, `${on}: ${JSON.stringify(o)}`); assert.match(o.notTried, why, on);
  }
  // A broken control side is NOT TRIED too, though the judge alone would call it a FAIL.
  assert.equal((await runDeny({ on: 'refused', off: 'api' })).ok, null);
  // Proper runs that show the wrong thing stay a FAIL.
  assert.equal((await runDeny({ on: 'runs', off: 'runs' })).ok, false);
});

test('m1: runProblem reads the start, the result, the call and the special endings', () => {
  const r = (out, extra = {}) => ({ out, err: '', code: 0, ...extra });
  assert.equal(runProblem(r([INIT, OK].join('\n'))), null);
  assert.match(runProblem(r(INIT)), /no result line/);
  assert.match(runProblem(r([INIT, evt({ type: 'result', is_error: false, result: 'API Error: 500' })].join('\n'))), /API Error/);
  assert.match(runProblem({ out: '', error: 'spawn ENOENT' }), /could not start/);
  assert.match(runProblem(undefined), /nothing back/);
  // turnsEnd: a turn-limit ending is proper, a plain success is not.
  const turns = evt({ type: 'result', subtype: 'error_max_turns', is_error: true });
  assert.equal(runProblem(r([INIT, turns].join('\n')), { turnsEnd: true }), null);
  assert.match(runProblem(r([INIT, OK].join('\n')), { turnsEnd: true }), /turn limit/);
  assert.match(runProblem(r([INIT, turns].join('\n'))), /error/);
  // refusedStart: no start is proper only when stderr names the value; startOrWarns, when the warnings name the key.
  assert.equal(runProblem({ out: '', err: `bad --effort ${BAD_EFFORT}`, code: 1 }, { refusedStart: BAD_EFFORT }), null);
  assert.match(runProblem({ out: '', err: 'segfault', code: 139 }, { refusedStart: BAD_EFFORT }), /no start message/);
  assert.equal(runProblem({ out: '', err: 'settings: strictAllowlist must be boolean', code: 1 }, { startOrWarns: 'strictAllowlist' }), null);
  assert.match(runProblem({ out: '', err: 'crash', code: 1 }, { startOrWarns: 'strictAllowlist' }), /no start message/);
});

test('m2: the spelling see reads the marker and the warnings, never the start message\'s folder', () => {
  const t = byId('spelling-strictAllowlist'); const [name] = t.names;
  const root = tempDir('orch-names-'); mkdirSync(join(root, 'work'));
  const withName = { out: evt({ type: 'system', subtype: 'init', cwd: `/runs/spelling-${name}-on/work` }), err: '' };
  assert.equal(t.see('on', root, withName.out, {}, withName), 'skipped|-');
  writeFileSync(join(root, 'work', 'start'), '');
  assert.equal(t.see('on', root, withName.out, {}, withName), 'loaded|-');
  assert.equal(t.see('on', root, '', {}, { out: '', err: `Settings: ${name} is not valid` }), 'loaded|named');
  assert.equal(t.see('on', root, '', {}, { out: evt({ type: 'system', subtype: 'warning', text: `${name}: bad value` }), err: '' }), 'loaded|named');
  // The run folders hold no name: run<i>-<side>-, the same for every test.
  const src = readFileSync(new URL('./settings-names.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("(join(base, `run${i}-${side}-`))"), "the run folders are run<i>-<side>-");
});

test('m3: a spelling pair confirms only the SPELLING_ONLY names, in the launcher\'s check and in the harness', () => {
  assert.deepEqual([...SPELLING_ONLY].sort(), ['crossSessionInbound', 'failIfUnavailable', 'strictAllowlist'].sort());
  assert.ok(!PROOF_KIND.test('foo:x') && !PROOF_KIND.test('spelling:') && PROOF_KIND.test('readback:x'));
  assert.equal(proofCounts('strictAllowlist', 'spelling:x'), true);
  assert.equal(proofCounts('deny', 'spelling:x'), false);
  assert.equal(proofCounts('deny', 'break-it:x'), true);
  assert.equal(proofCounts('deny', 'foo:x'), false);
  assert.ok(unconfirmedNames({ settings: {}, flags: ['deny'], confirmed: { deny: { by: 'spelling:x', version: PIN } }, version: PIN }).includes('deny'));
  assert.ok(!unconfirmedNames({ settings: {}, flags: ['strictAllowlist'], confirmed: { strictAllowlist: { by: 'spelling:x', version: PIN } }, version: PIN }).includes('strictAllowlist'));
  // The harness: a spelling-kind test of another name passing does not confirm it, and an old spelling entry is not borrowed.
  const fake = { id: 'spelling-deny', title: 'a spelling pair of deny', kind: 'spelling', names: ['deny'] };
  const lines = judgeNames({ outcomes: { 'spelling-deny': { ok: true } }, tests: [fake], readback: { ok: true }, version: PIN, confirmed: {} });
  assert.notEqual(lines.find((l) => l.name === 'deny').result, 'PASS');
  assert.notEqual(judgeNames({ outcomes: {}, version: PIN, confirmed: { deny: { by: 'spelling:x', version: PIN } } }).find((l) => l.name === 'deny').result, 'PASS');
});

test('m4: a cut-off run leaves the raw bytes and a note; --restore puts the file back, mode too, and checks it', async () => {
  const root = tempDir('orch-names-'); const f = join(root, 'settings.json');
  writeFileSync(f, '{"theme":"dark"}\n'); chmodSync(f, 0o640);
  // A run cut off mid-way: the backup and its note are left, the file holds the run's settings.
  await assert.rejects(withUserSettings(f, { x: 1 }, async () => { throw new Error('cut'); }, {
    exists: existsSync, read: (p) => readFileSync(p), mode: (p) => statSync(p).mode & 0o777,
    put: (p, d, m) => { writeFileSync(p, d); chmodSync(p, m); }, rm: (p) => { if (p === f) throw new Error('killed'); },
  }));
  assert.equal(readFileSync(`${f}${BACKUP_SUFFIX}`, 'utf8'), '{"theme":"dark"}\n', 'the backup is the file\'s own bytes');
  assert.equal(JSON.parse(readFileSync(`${f}${META_SUFFIX}`, 'utf8')).mode, 0o640);
  chmodSync(f, 0o600); writeFileSync(f, '{"x":1}\n');
  assert.match(restoreUserFile(f), /back as it was, mode 640/);
  assert.equal(readFileSync(f, 'utf8'), '{"theme":"dark"}\n'); assert.equal(statSync(f).mode & 0o777, 0o640);
  assert.ok(!existsSync(`${f}${BACKUP_SUFFIX}`) && !existsSync(`${f}${META_SUFFIX}`));
  // c3: a restore whose mode can't be set is refused, and the backup stays.
  writeFileSync(`${f}${BACKUP_SUFFIX}`, 'a'); writeFileSync(`${f}${META_SUFFIX}`, JSON.stringify({ had: true, mode: 0o640, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }));
  const noChmod = { exists: existsSync, read: (p) => readFileSync(p), mode: (p) => statSync(p).mode & 0o777, put: (p, d) => writeFileSync(p, d), rm: () => {} };
  chmodSync(f, 0o600);
  assert.throws(() => restoreUserFile(f, noChmod), /its bytes or its mode/);
  assert.ok(existsSync(`${f}${BACKUP_SUFFIX}`));
  assert.match(restoreUserFile(f), /back as it was/);
  // No file before: the restore removes it. A backup that is not the file it backed up is refused.
  writeFileSync(`${f}${META_SUFFIX}`, JSON.stringify({ had: false, mode: null, sha256: null }));
  assert.match(restoreUserFile(f), /removed/); assert.ok(!existsSync(f));
  writeFileSync(`${f}${BACKUP_SUFFIX}`, 'b'); writeFileSync(`${f}${META_SUFFIX}`, JSON.stringify({ had: true, mode: 0o600, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }));
  assert.throws(() => restoreUserFile(f), /checksum/);
  // The leftover message names --restore, not a hand copy of the backup.
  const src = readFileSync(new URL('./settings-names.mjs', import.meta.url), 'utf8');
  assert.match(src, /with --restore added/); assert.doesNotMatch(src, /put it back as \$\{/);
});

test('m5: every run ends with its own receipt; one that can\'t be written is NOT DONE and exit 1', () => {
  const all = Object.fromEntries(TESTS.map((t) => [t.id, { ok: true }]));
  const res = { outcomes: all, readback: { ok: true } };
  const home = tempDir('orch-names-'); let out = '';
  assert.equal(finish({ res, pin: PIN, base: null, home, at: 0, print: (t) => { out += t; } }), 0);
  assert.match(out.trimEnd().split('\n').at(-1), /^PASS/);
  const path = out.match(/Written to (\S+)/)[1]; assert.ok(existsSync(path) && path.startsWith(home));
  out = '';
  assert.equal(finish({ res, pin: PIN, base: null, home: join(home, 'gone'), at: 0, print: (t) => { out += t; } }), 1);
  assert.match(out.trimEnd().split('\n').at(-1), /^NOT DONE.*receipt could not be written/);
  // A NOT DONE run exits 1 even when its receipt is written.
  out = '';
  assert.equal(finish({ res: { outcomes: { ...all, deny: { ok: false, why: 'x' } }, readback: { ok: true } }, pin: PIN, base: null, home, at: 1, print: (t) => { out += t; } }), 1);
  assert.match(out.trimEnd().split('\n').at(-1), /^NOT DONE/);
});

test('m1: the real run keeps stderr, the exit code and a run past its time', async () => {
  const cwd = tempDir('orch-names-');
  const r = await runToEnd('/bin/sh', ['-c', 'echo out; echo said >&2; exit 3'], { cwd, env: process.env });
  assert.equal(r.out, 'out\n'); assert.equal(r.err, 'said\n'); assert.equal(r.code, 3); assert.equal(r.timedOut, false);
  const t = await runToEnd('/bin/sh', ['-c', 'sleep 5'], { cwd, env: process.env, timeoutMs: 100 });
  assert.equal(t.timedOut, true); assert.equal(t.signal, 'SIGKILL');
  assert.match(runProblem(t), /time limit/);
  assert.ok((await runToEnd('/nowhere/claude', [], { cwd, env: process.env })).error);
});

test('m5: a receipt is never overwritten', () => {
  const home = tempDir('orch-names-');
  const a = writeReceipt({ home, at: 0, header: { pin: PIN }, lines: [] });
  assert.ok(existsSync(a));
  assert.throws(() => writeReceipt({ home, at: 0, header: { pin: PIN }, lines: [{ x: 1 }] }), /EEXIST/);
  assert.equal(readFileSync(a, 'utf8').split('\n').filter(Boolean).length, 1);
});

test('m7: --effort is proven for each level a review passes, and a made-up level must be refused by name', async () => {
  const levels = TESTS.filter((t) => t.names.includes(F.effort)).map((t) => t.run('on', '/x').extra[1]);
  assert.deepEqual(levels.sort(), [...new Set([FIRST_ROUND_EFFORT, SEND_BACK_EFFORT])].sort());
  const t = TESTS.find((x) => x.id === `effort-${SEND_BACK_EFFORT}`);
  const go = async (off) => {
    const root = tempDir('orch-names-'); const base = join(root, 'runs'); mkdirSync(base);
    const claude = async (args) => (word(args, F.effort) === BAD_EFFORT ? off : { out: [INIT, OK].join('\n'), err: '', code: 0 });
    return (await runAll({ base, io: { claude, readbackAll: async () => ({ ok: true }), userFile: join(root, 's.json'), guardPassed: true, sleep: async () => {} }, tests: [t] })).outcomes[t.id];
  };
  // Refused, by name, with something on stdout that is not a start message: PASS (any output is not a start).
  assert.equal((await go({ out: 'Error: bad option\n', err: `error: option '--effort <level>' argument '${BAD_EFFORT}' is invalid`, code: 1 })).ok, true);
  // A crash that does not name the level shows nothing: NOT TRIED.
  assert.equal((await go({ out: '', err: 'Segmentation fault', code: 139 })).ok, null);
});

test('P: NOT USED and REFUSED lines are not counted; a run with nothing counted is not a PASS', () => {
  assert.equal(report([{ name: 'a', result: 'PASS', by: 'readback:x' }, { name: 'b', result: 'NOT USED', why: 'x' }, { name: 'c', result: 'REFUSED', why: 'x' }], PIN).ok, true);
  assert.equal(report([{ name: 'b', result: 'NOT USED', why: 'x' }], PIN).ok, false);
});

test('c2: one list of the empty tool-server words, used by every start', () => {
  assert.deepEqual(noToolServerArgs(), ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  assert.deepEqual(runArgs({ settingsFile: '/f' }).filter((a) => noToolServerArgs().includes(a)), noToolServerArgs());
  for (const f of ['../../modules/M4-workshop/launcher/readback.mjs', '../../modules/M4-workshop/launcher/review-launch.mjs', './settings-names.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(src.includes('noToolServerArgs()') && !src.includes(`'{"mcpServers":{}}', F.`), f);
  }
});

// ---- every name is accounted for ----

test('every name the launcher uses has a test, the role read-back, or a reason it is not tried yet', () => {
  const tested = new Set([...TESTS.flatMap((t) => t.names), ...READBACK_NAMES]);
  for (const n of allNames()) {
    if (REFUSED_SETTINGS.includes(n) || NOT_USED[n]) continue;
    assert.ok(tested.has(n) || NOT_TRIED[n], `${n}: no test and no reason`);
    if (NOT_TRIED[n] && !tested.has(n)) assert.ok(NOT_TRIED[n].length > 20, n);
  }
  assert.ok(allNames().length >= 37, `${allNames().length} names`);
});

// ---- judging names ----

test('a name is PASS only when a test of it ran and passed; skipped is NOT TRIED, a failure is FAIL', () => {
  const none = judgeNames({ outcomes: {}, readback: undefined, version: PIN, confirmed: {} });
  assert.ok(none.every((l) => ['NOT TRIED', 'REFUSED', 'NOT USED'].includes(l.result)), 'nothing ran, yet a name passed');
  assert.deepEqual(none.filter((l) => l.result === 'NOT USED').map((l) => l.name), Object.keys(NOT_USED));
  assert.deepEqual(none.filter((l) => l.result === 'REFUSED').map((l) => l.name).sort(), [...REFUSED_SETTINGS].sort());
  const r = report(none, PIN);
  assert.equal(r.ok, false); assert.match(r.verdict, /^NOT DONE/);

  const all = Object.fromEntries(TESTS.map((t) => [t.id, { ok: true }]));
  const ok = judgeNames({ outcomes: all, readback: { ok: true }, version: PIN, confirmed: {} });
  const left = ok.filter((l) => l.result === 'NOT TRIED').map((l) => l.name);
  assert.deepEqual(left.sort(), Object.keys(NOT_TRIED).filter((n) => !TESTS.some((t) => t.names.includes(n))).sort(), 'only the listed names are left');
  for (const l of ok.filter((x) => x.result === 'PASS')) { assert.equal(l.version, PIN); assert.match(l.by, /^(readback|break-it|spelling):settings-names\.mjs "/); }

  // One test failing fails every name it proves, even one another test passed.
  const oneBad = judgeNames({ outcomes: { ...all, deny: { ok: false, why: 'it ran' } }, readback: { ok: true }, version: PIN, confirmed: {} });
  assert.equal(oneBad.find((l) => l.name === 'deny').result, 'FAIL');
  assert.equal(oneBad.find((l) => l.name === 'permissions').result, 'FAIL', 'permissions: allow passed, deny failed');
  // An outcome that says neither yes nor no is no pass.
  assert.equal(judgeNames({ outcomes: { ...all, deny: {} }, readback: { ok: true }, version: PIN, confirmed: {} }).find((l) => l.name === 'deny').result, 'FAIL');
  // The read-back failing fails its flags.
  const rb = judgeNames({ outcomes: all, readback: { ok: false, why: 'worker: no init' }, version: PIN, confirmed: {} });
  for (const n of READBACK_NAMES) assert.equal(rb.find((l) => l.name === n).result, 'FAIL', n);
  // A name already confirmed on the pin passes without a run here; on another version it does not.
  const c = { allowUnsandboxedCommands: { by: 'break-it:review-walls-proof.mjs', version: PIN } };
  assert.equal(judgeNames({ outcomes: {}, version: PIN, confirmed: c }).find((l) => l.name === 'allowUnsandboxedCommands').result, 'PASS');
  assert.equal(judgeNames({ outcomes: {}, version: PIN, confirmed: { allowUnsandboxedCommands: { ...c.allowUnsandboxedCommands, version: '2.1.315' } } }).find((l) => l.name === 'allowUnsandboxedCommands').result, 'NOT TRIED');
  assert.equal(judgeNames({ outcomes: {}, version: PIN, confirmed: { allowUnsandboxedCommands: { by: '', version: PIN } } }).find((l) => l.name === 'allowUnsandboxedCommands').result, 'NOT TRIED', 'an empty by');
  // The table on main is read by default.
  assert.equal(judgeNames({ outcomes: {}, version: PIN }).filter((l) => l.result === 'PASS').length,
    allNames().filter((n) => CONFIRMED[n]?.version === PIN && PROOF_KIND.test(CONFIRMED[n].by)).length);
});

test('the report: the verdict is PASS only when every counted name passed', () => {
  const p = (name) => ({ name, result: 'PASS', by: 'readback:x', version: PIN });
  assert.equal(report([p('a'), p('b'), { name: 'apiKeyHelper', result: 'REFUSED', why: 'x' }], PIN).ok, true);
  assert.match(report([p('a')], PIN).verdict, /^PASS: all 1 names confirmed on Claude Code 2\.1\.316$/);
  assert.equal(report([], PIN).ok, false, 'no name at all');
  assert.equal(report([{ name: 'apiKeyHelper', result: 'REFUSED', why: 'x' }], PIN).ok, false, 'only refused names');
  const r = report([p('a'), { name: 'b', result: 'FAIL', why: 'w' }, { name: 'c', result: 'NOT TRIED', why: 'w' }], PIN);
  assert.equal(r.ok, false); assert.match(r.verdict, /^NOT DONE.*1 failed \(b\), 1 not tried \(c\)/);
  assert.match(r.text, /^PASS {6}a {2}readback:x\nFAIL {6}b {2}w\nNOT TRIED c {2}w\n$/);
});

// ---- runs with the stand-in claude ----

test('an honest stand-in passes its tests; the user settings file comes back byte for byte', async () => {
  const text = '{"theme":"dark"}\n  ';
  const { outcomes, userFile } = await fakeRun({ userText: text });
  for (const t of FAKE_TESTS) assert.equal(outcomes[t.id]?.ok, true, `${t.id}: ${outcomes[t.id]?.why}`);
  assert.equal(readFileSync(userFile, 'utf8'), text); assert.equal(statSync(userFile).mode & 0o777, 0o640);
  assert.ok(!existsSync(`${userFile}${BACKUP_SUFFIX}`));
});

test('with no user settings file before, there is none after', async () => {
  const { outcomes, userFile } = await fakeRun({});
  assert.equal(outcomes.settingSources.ok, true, outcomes.settingSources.why);
  assert.ok(!existsSync(userFile)); assert.ok(!existsSync(`${userFile}${BACKUP_SUFFIX}`));
});

test('plants: each way claude could ignore a name turns its test red', async () => {
  const cases = [[{ ignoreSources: true }, 'settingSources'], [{ ignoreRestricted: true }, 'restricted'], [{ noHooks: true }, 'sessionStart'],
    [{ noHooks: true }, 'settingSources'], [{ ownSessionId: true }, 'sessionId'], [{ oneModel: true }, 'model']];
  for (const [plant, id] of cases) {
    const { outcomes } = await fakeRun({ plant, tests: [byId(id)] });
    assert.equal(outcomes[id].ok, false, `${JSON.stringify(plant)}: ${id} passed`);
    const lines = judgeNames({ outcomes, readback: undefined, version: PIN, confirmed: {} });
    for (const n of byId(id).names) assert.equal(lines.find((l) => l.name === n).result, 'FAIL', `${id}: ${n}`);
  }
  // A claude that does nothing at all: every break-it and read-back test fails, none passes.
  const { outcomes } = await fakeRun({ tests: TESTS.filter((t) => !t.byGuard && !['sessionStart', 'restricted', 'settingSources', 'model', 'sessionId'].includes(t.id)) });
  for (const [id, o] of Object.entries(outcomes)) assert.ok(o.ok === false || (o.ok === null && o.notTried), `${id} passed with a claude that does nothing`);
  // ...and the three spelling pairs, seeing no difference, are NOT TRIED, not PASS (L1114).
  for (const id of ['spelling-failIfUnavailable', 'spelling-strictAllowlist', 'spelling-crossSessionInbound']) assert.equal(outcomes[id].ok, null, id);
  // --version is proven only by the guard having passed.
  assert.equal((await fakeRun({ guardPassed: false, tests: [byId('version')] })).outcomes.version, undefined);
});

test('a test that throws is a FAIL for its names, and the user file is still put back', async () => {
  const root = tempDir('orch-names-');
  const userFile = join(root, 'settings.json'); writeFileSync(userFile, 'before');
  const io = { claude: async () => { throw new Error('spawn failed'); }, readbackAll: async () => { throw new Error('no'); }, userFile, guardPassed: true, sleep: async () => {} };
  const { outcomes, readback } = await runAll({ base: root, io, tests: [byId('settingSources')] });
  assert.match(outcomes.settingSources.why, /could not run: spawn failed/);
  assert.equal(readback.ok, false);
  assert.equal(readFileSync(userFile, 'utf8'), 'before');
});

// ---- the user settings file (L1109) ----

test('withUserSettings: a backup left over refuses before anything changes', async () => {
  const root = tempDir('orch-names-'); const f = join(root, 'settings.json');
  writeFileSync(f, 'mine'); writeFileSync(`${f}${BACKUP_SUFFIX}`, 'old');
  let ran = false;
  await assert.rejects(withUserSettings(f, { x: 1 }, async () => { ran = true; }), /left from an earlier run/);
  assert.equal(ran, false); assert.equal(readFileSync(f, 'utf8'), 'mine'); assert.equal(readFileSync(`${f}${BACKUP_SUFFIX}`, 'utf8'), 'old');
});

test('withUserSettings: the file holds the settings during the run and comes back after, even when the run throws', async () => {
  const root = tempDir('orch-names-'); const f = join(root, 'settings.json');
  const bytes = Buffer.from([0x7b, 0x7d, 0x0a, 0xff, 0x00]); writeFileSync(f, bytes); chmodSync(f, 0o604);
  let during;
  await assert.rejects(withUserSettings(f, { hooks: {} }, async () => { during = readFileSync(f, 'utf8'); assert.ok(existsSync(`${f}${BACKUP_SUFFIX}`)); throw new Error('mid-run'); }), /mid-run/);
  assert.equal(during, '{"hooks":{}}\n');
  assert.equal(Buffer.compare(readFileSync(f), bytes), 0); assert.equal(statSync(f).mode & 0o777, 0o604);
  assert.ok(!existsSync(`${f}${BACKUP_SUFFIX}`));
  // Not there before: removed after.
  const g = join(root, 'none.json');
  assert.equal(await withUserSettings(g, {}, async () => 7), 7);
  assert.ok(!existsSync(g)); assert.deepEqual(readdirSync(root).sort(), ['settings.json']);
});

test('withUserSettings: if the file can\'t be put back, it says so and keeps the backup', async () => {
  const mem = new Map([['/u/s.json', Buffer.from('orig')]]);
  const fs = { exists: (p) => mem.has(p), read: (p) => mem.get(p), mode: () => 0o600, rm: (p) => mem.delete(p),
    put: (p, d) => { mem.set(p, p === '/u/s.json' && String(d) === 'orig' ? Buffer.from('torn') : Buffer.from(d)); } };
  await assert.rejects(withUserSettings('/u/s.json', {}, async () => {}, fs), /could not be put back/);
  assert.ok(mem.has(`/u/s.json${BACKUP_SUFFIX}`));
});

// ---- the role read-back ----

test('the role read-back renders every role, starts it with the sources limit, and fails on a bad or missing start message', async () => {
  const base = tempDir('orch-names-');
  const seen = [];
  const r = await roleReadback({ base, pin: PIN, start: async (args) => { seen.push(args); return ''; } });
  assert.equal(seen.length, Object.keys(DESIGN_PROFILES).length, `${r.why}`);
  for (const a of seen) assert.equal(sourcesProblem(a), null);
  assert.equal(r.ok, false); assert.match(r.why, /lead: /);
  const one = await roleReadback({ base, pin: PIN, roles: ['worker'], start: async () => `${JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.300' })}\n` });
  assert.equal(one.ok, false);
});

// ---- the guards ----

test('guards: root, another user, no pin, the wrong claude, no account each stop the run', () => {
  const c = { ownDir: '/w/state', claudeBin: '/opt/claude', pin: PIN };
  const ok = { c, uid: 501, ownDirUid: 501, claudeVersion: PIN, account: { account: 'a', dir: '/h/.claude' } };
  assert.equal(guardProblem(ok), null);
  assert.match(guardProblem({ ...ok, uid: 0 }), /root/);
  assert.match(guardProblem({ ...ok, ownDirUid: 502 }), /uid 502's/);
  assert.match(guardProblem({ ...ok, c: { ...c, claudeBin: 'claude' } }), /no pinned claude/);
  assert.match(guardProblem({ ...ok, c: { ...c, pin: undefined } }), /no claude pin/);
  assert.match(guardProblem({ ...ok, claudeVersion: '2.1.322' }), /claude is 2\.1\.322/);
  assert.match(guardProblem({ ...ok, account: { account: null, reason: 'not set up' } }), /not set up/);
});

test('a config that can\'t be read: every name NOT TRIED, the last line NOT DONE, exit 1', async () => {
  let out = '';
  const home = tempDir('orch-names-');
  const code = await main(['--config', '/nowhere/config.json'], { print: (t) => { out += t; }, uid: 501, home, now: () => 0 });
  assert.equal(code, 1);
  const lines = out.trimEnd().split('\n');
  // m5: a refused run writes its receipt too, saying why, so an older receipt can't stand in for it.
  const path = out.match(/Written to (\S+)/)?.[1];
  assert.ok(path && path.startsWith(home), out);
  const head = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
  assert.equal(head.ok, false); assert.match(head.refused, /config can't be read/);
  assert.match(lines.at(-1), /^NOT DONE/);
  assert.ok(!lines.some((l) => l.startsWith('PASS ')), 'a name passed with nothing run');
  assert.equal(lines.filter((l) => l.startsWith('NOT TRIED')).length, allNames().length - REFUSED_SETTINGS.length - Object.keys(NOT_USED).length);
});

test('the run sheet command and the receipt path are the ones the harness says', () => {
  const src = readFileSync(new URL('./settings-names.mjs', import.meta.url), 'utf8');
  assert.match(src, /sudo -H -u builder <installRoot>\/bin\/node <installRoot>\/setup\/live-proofs\/settings-names\.mjs --config <the worker runner's config>/);
  assert.match(src, /settings-names-proof-\$\{/);
  assert.deepEqual(sourcesArgs(), ['--setting-sources', '']);
});
