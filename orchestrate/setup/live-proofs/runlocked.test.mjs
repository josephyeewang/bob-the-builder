// Live proof 9 (runLocked on the Mini) harness: its guards, its judging and its loop, with stand-ins for the runner.
// The real run needs the Mini's worker user and lock-down; here every port is a stand-in (L988).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CURL_UNREACHED, LEFTOVER_INSTALL, LEFTOVER_WAIT_MS, SLOW_INSTALL, STEPS, TEST_REPO, blockedBy, guardProblem, hooksSet, main, proveRunLocked, readStream, realWiring, report, variant, walledInstall } from './runlocked.mjs';
import { JOBS_DIR, LOCKED_SAVE_MS, quoted } from '../../wiring/runner-locked.mjs';
import { CLONE_CONFIG_TEMPLATE } from '../../modules/M4-workshop/git/save-work.mjs';

const INSTALL = 'npm ci';
const HOSTS = ['registry.npmjs.org'];
const cfg = (over = {}) => ({ ownDir: '/w/state', settingsDir: '/w/state/settings', home: '/Users/workers', claudeBin: '/opt/claude', pin: '2.1.316',
  copiesRoot: '/w/copies', outboxRoot: '/w/outboxes',
  products: { trial: { repo: `someone/${TEST_REPO}`, mirror: '/m/trial.git', render: { registryHosts: HOSTS, product: { commands: { install: INSTALL, test: 'npm test' } }, paths: {} } } }, ...over });
const okGuard = { c: cfg(), product: 'trial', uid: 501, ownDirUid: 501, claudeVersion: '2.1.316' };
const HOOKS = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/h/guard.mjs' }] }] };
const SETTINGS = JSON.stringify({ hooks: HOOKS, sandbox: { network: { allowedDomains: ['api.anthropic.com'] } } });
const INSTALL_SETTINGS = JSON.stringify({ hooks: HOOKS, sandbox: { network: { allowedDomains: ['api.anthropic.com', ...HOSTS] } } });
const SCRIPT = quoted(join(JOBS_DIR, 'save-work.mjs'));
const stream = (over = {}) => [
  JSON.stringify({ type: 'system', subtype: 'init', permissionMode: over.mode ?? 'dontAsk' }),
  ...(over.hook === false ? [] : [JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse' })]),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: over.command ?? `'/n/node' ${SCRIPT} 'e30=' '/c/.orch-job'` } }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: over.error === true }] } }),
  ...(over.result === false ? [] : [JSON.stringify({ type: 'result', permission_denials: over.denied ?? [] })]),
].join('\n');
const withRender = (render) => cfg({ products: { trial: { ...cfg().products.trial, render: { ...cfg().products.trial.render, ...render } } } });

test('guardProblem: the proof runs only as the runner\'s own user, on the test product, with the pinned claude', () => {
  assert.equal(guardProblem(okGuard), null, 'the control');
  const bad = [
    [{ uid: 0, ownDirUid: 0 }, /as root/],
    [{ ownDirUid: 502 }, /uid 501.*uid 502/],
    [{ ownDirUid: null }, /uid 501/],
    [{ product: undefined }, /no --product/],
    [{ product: 'other' }, /not in the worker runner's config/],
    [{ c: cfg({ products: { trial: { ...cfg().products.trial, repo: 'someone/live-product' } } }) }, /not the test repository/],
    [{ c: cfg({ products: { trial: { ...cfg().products.trial, repo: `${TEST_REPO}/x` } } }) }, /not the test repository/],
    [{ c: cfg({ claudeBin: undefined }) }, /no pinned claude/],
    [{ c: cfg({ pin: undefined }) }, /no claude pin/],
    [{ claudeVersion: '2.1.317' }, /claude is 2\.1\.317.*pin is 2\.1\.316/],
    [{ claudeVersion: null }, /not readable/],
    [{ c: withRender({ product: { commands: {} } }) }, /no install command/],
    [{ c: withRender({ registryHosts: [] }) }, /no registry hosts/],
    [{ c: withRender({ registryHosts: [...HOSTS, 'codeload.github.com'] }) }, /include github\.com/],
    [{ c: withRender({ registryHosts: ['GitHub.com'] }) }, /include github\.com/],
  ];
  for (const [over, re] of bad) assert.match(guardProblem({ ...okGuard, ...over }) ?? 'null', re, JSON.stringify(over).slice(0, 80));
  assert.equal(guardProblem({ ...okGuard, c: withRender({ registryHosts: ['notgithub.com'] }) }), null, 'only github.com and its own names');
});

test('variant: changes the one product\'s install and lockedMs in a copy, never the config itself', () => {
  const c = cfg(); const before = JSON.stringify(c);
  const v = variant(c, 'trial', { install: 'sleep 1213', lockedMs: 60_000 });
  assert.equal(v.products.trial.render.product.commands.install, 'sleep 1213');
  assert.equal(v.products.trial.render.product.commands.test, 'npm test', 'the other commands are kept');
  assert.equal(v.lockedMs, 60_000);
  assert.equal(JSON.stringify(c), before, 'the config is untouched');
  assert.equal(variant(c, 'trial').products.trial.render.product.commands.install, INSTALL);
  assert.ok(!('lockedMs' in variant(c, 'trial', { install: 'x' })));
});

test('the plant installs: walled tries the network and the home folder; leftover proves its own session first; slow is one to look for', () => {
  const w = walledInstall("/Users/o'w");
  assert.match(w, /curl .*https:\/\/github\.com/);
  assert.match(w, /touch '\/Users\/o'\\''w\/x'/, 'quoted, a quote in the home too');
  assert.match(w, /exit \$r$/);
  assert.match(LEFTOVER_INSTALL, /POSIX::setsid\(\) > 0 or die/);
  assert.match(LEFTOVER_INSTALL, /'touch started; sleep 20; touch leftover'/);
  assert.match(LEFTOVER_INSTALL, /& exit 0$/);
  assert.match(SLOW_INSTALL, /^sleep \d+$/);
  assert.ok(Number(SLOW_INSTALL.split(' ')[1]) * 1000 > 15 * 60_000, 'longer than any lockedMs');
  assert.deepEqual(CURL_UNREACHED, [6, 7, 28, 35, 56]);
});

test('blockedBy: a launch stopped by the names check or checks 12 and 13 is not runLocked\'s, and says which check', () => {
  assert.equal(blockedBy('setting names not confirmed on the pinned Claude Code: hooks'), 'launch check 0');
  assert.equal(blockedBy('the role file given to the names check is not locked down: x'), 'launch check 0');
  assert.equal(blockedBy('launch check 12 (budget, caps and disjoint files): no check is wired'), 'launch check 12');
  assert.equal(blockedBy('launch check 13 (Bob method folder): no check is wired'), 'launch check 13');
  for (const r of ['launch check 4 (dependencies): the install exited 1', 'launch check 11 (smoke): x', 'launch check 1 (fresh copy): y', 'launch check 120 (x): y', 'x launch check 12 (y)', undefined]) assert.equal(blockedBy(r), null, String(r));
});

test('readStream and hooksSet read what claude did; a stream with no start line is "can\'t tell"', () => {
  assert.deepEqual(readStream(stream()), { mode: 'dontAsk', commands: [`'/n/node' ${SCRIPT} 'e30=' '/c/.orch-job'`], denied: 0, errors: 0, hooks: 1 });
  assert.equal(readStream(stream({ hook: false })).hooks, 0);
  assert.equal(readStream(stream({ denied: [{}] })).denied, 1);
  assert.equal(readStream(stream({ error: true })).errors, 1);
  assert.equal(readStream('not json\n{"type":"result"}'), null);
  assert.equal(readStream(stream({ result: false })).denied, null, 'no result line: not known');
  assert.equal(hooksSet(SETTINGS), true);
  assert.equal(hooksSet(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{}] }] } })), true);
  assert.equal(hooksSet(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{}] }] } })), false, 'a hook that does not cover Bash');
  assert.equal(hooksSet(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } })), false, 'a matcher with no hook');
  assert.equal(hooksSet('{"hooks":{}}'), false);
  assert.equal(hooksSet('nope'), false);
});

test('report: passes only with steps 1 to 7 PASS and step 8 looked at; NOT RUN is never a pass', () => {
  const all = (r8 = 'SEEN', over = {}) => STEPS.map(([n]) => ({ step: n, result: n === 8 ? r8 : (over[n] ?? 'PASS') }));
  assert.equal(report(all()).ok, true);
  assert.equal(report(all('NOT SEEN')).ok, true);
  assert.equal(report(all('NOT RUN')).ok, false);
  for (const n of [1, 2, 3, 4, 5, 6, 7]) for (const r of ['FAIL', 'NOT RUN']) assert.equal(report(all('SEEN', { [n]: r })).ok, false, `${n} ${r}`);
  assert.equal(report(all().slice(0, 7)).ok, false, 'a step missing');
  assert.match(report(all()).text, /^PASS {5}1\. the install, check 4/m);
  assert.match(report(all('SEEN', { 3: 'NOT RUN' })).text, /runLocked proof: NOT PASSED\n$/);
});

// A stand-in runner: the start answers by the install command it is given; save-work by the world.
function world(over = {}) {
  const w = { files: new Map(), clock: 1_000, stopped: [], cleaned: [], slept: 0, launched: [], saves: 0,
    settingsText: SETTINGS, installSettings: INSTALL_SETTINGS, mainStart: { ok: true }, save: { ok: true }, saveMs: 3_000, stream: stream(), listed: false, sleepers: [], verify: null,
    xBefore: false, xWritten: false, walled: { ok: false, reason: 'the install exited 7' }, slow: { ok: false, reason: 'the install job did not finish inside the lock-down (it did not finish in time)' },
    walledStart: null, leftoverStart: { ok: true }, leftover: true, started: true, trapRuns: false, disarm: true, stopOk: { ok: true }, ...over };
  const c = cfg();
  const io = {
    wiring: (cv, rec) => {
      const install = cv.products.trial.render.product.commands.install;
      const kind = install === INSTALL ? 'main' : install === SLOW_INSTALL ? 'slow' : install === LEFTOVER_INSTALL ? 'leftover' : 'walled';
      return {
        start: async (req) => {
          w.launched.push({ kind, req, lockedMs: cv.lockedMs });
          const copy = `/w/copies/trial/${req.card}`; const outbox = `/w/outboxes/trial/worker/${req.sessionId}`;
          const started = { ok: true, pid: 900 + w.launched.length, pgid: 900 + w.launched.length, pidStart: '2026-11-03T10:00:00.000Z', copy, outbox };
          if (kind === 'main') {
            if (w.mainStart.four !== null) {
              rec.runs.push({ pid: 800, out: '/r/install', job: 'install', settingsText: w.installSettings });
              rec.answers[4] = w.mainStart.four ?? { ok: true }; rec.settingsText = w.settingsText;
            }
            if (w.mainStart.ok === false) return { ok: false, reason: w.mainStart.reason ?? 'launch check 11 (smoke and baseline): the baseline failed' };
            w.files.set(`${copy}/.git/config`, '[core]\n');
            return started;
          }
          if (kind === 'walled') {
            if (w.walledStart) return w.walledStart;
            if (w.walled !== null) rec.answers[4] = w.walled; if (w.xWritten) w.files.set('/Users/workers/x', ''); return { ok: false, reason: 'launch check 4 (dependencies): …' };
          }
          if (kind === 'slow') { rec.runs.push({ pid: 4242, out: '/r/slow', job: 'install' }); rec.answers[4] = w.slow; return { ok: false, reason: 'launch check 4 (dependencies): …' }; }
          rec.answers[4] = { ok: true };
          if (w.leftoverStart.ok === false) return { ok: false, reason: 'launch check 13 (Bob method folder): no check is wired' };
          if (w.leftoverStart.running) return { ok: false, running: true, pgid: 777, reason: 'still running' };
          if (w.started) w.files.set(`${copy}/started`, '');
          if (w.leftover) w.files.set(`${copy}/leftover`, '');
          return started;
        },
        saveWork: async (s) => {
          w.saves += 1;
          const out = `/r/save-${w.saves}`; rec.runs.push({ pid: 5000 + w.saves, out, job: 'save-work' }); w.files.set(out, w.stream);
          w.clock += w.saveMs;
          const a = typeof w.save === 'function' ? w.save(w.saves) : w.save;
          if (a.ok) w.files.set(`${s.outbox}/bundle-${s.card}.bundle`, 'b');
          if (w.saves === 2 && w.trapRuns) w.files.set(`${s.copy}/marker-include`, '');
          if (w.saves === 2 && w.disarm) { w.files.set(`${s.copy}/.git/config`, CLONE_CONFIG_TEMPLATE); if (w.disarm !== 'config') for (const k of [...w.files.keys()]) if (k.startsWith(`${s.copy}/.git/hooks`)) w.files.delete(k); }
          return a;
        },
      };
    },
    stopGroup: async (g) => { w.stopped.push(g); return w.stopOk; },
    groupListed: () => (typeof w.listed === 'function' ? w.listed() : w.listed),
    sleepers: () => w.sleepers,
    verifyBundle: () => { if (w.verify === 'throw') throw new Error('boom'); return w.verify; },
    exists: (p) => w.files.has(p) || (p === '/Users/workers/x' && w.xBefore),
    read: (p) => { if (!w.files.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return w.files.get(p); },
    write: (p, text) => { w.files.set(p, text); }, mkdir: (p) => { w.files.set(p, null); },
    sleep: async (ms) => { w.slept += ms; }, now: () => w.clock,
    id: (prefix) => `${prefix}-t-${w.launched.length + 1}`,
    cleanup: (x) => { w.cleaned.push(x); },
  };
  return { w, c, io };
}
const run = async (over) => { const { w, c, io } = world(over); const r = await proveRunLocked({ c, product: 'trial', io }); return { w, r, by: Object.fromEntries(r.map((x) => [x.step, x])) }; };

test('proveRunLocked: a runLocked that works passes 1 to 7, sees the leftover, and cleans up every session', async () => {
  const { w, r, by } = await run();
  assert.deepEqual(r.map((x) => x.result), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'SEEN']);
  assert.equal(report(r).ok, true);
  assert.deepEqual(w.launched.map((l) => l.kind), ['main', 'walled', 'slow', 'leftover']);
  assert.equal(w.launched[2].lockedMs, 60_000, 'step 5 runs with a short lockedMs');
  assert.ok(w.launched.every((l) => l.req.kind === 'editing' && l.req.product === 'trial'));
  assert.equal(w.saves, 2, 'saved once, then once more trapped');
  assert.equal(w.slept, LEFTOVER_WAIT_MS);
  assert.equal(w.stopped[0].pgid, 901, 'the main session is stopped before its save');
  assert.deepEqual(w.stopped[0], { pid: 901, pgid: 901, pid_start: '2026-11-03T10:00:00.000Z' });
  assert.ok(w.stopped.some((g) => g.pgid === 904), 'and the leftover session at the end');
  assert.deepEqual(w.cleaned.map((x) => x.settingsFile), w.launched.map((l) => `/w/state/settings/${l.req.sessionId}.json`), 'every session, refused ones too');
  assert.equal(w.cleaned[0].copy, `/w/copies/trial/${w.launched[0].req.card}`);
  assert.equal(w.cleaned[2].outbox, `/w/outboxes/trial/worker/${w.launched[2].req.sessionId}`, 'a refused start\'s own paths');
  assert.match(w.files.get(`/w/copies/trial/${w.launched[0].req.card}/trap.config`) ?? w.files.get(`/w/copies/trial/${w.launched[0].req.card}/.git/trap.config`), /fsmonitor/, 'the trap was planted');
  assert.match(by[6].found.command, /save-work\.mjs/);
  assert.equal(by[7].found.ms, 3_000);
  assert.equal((await run({ leftover: false })).by[8].result, 'NOT SEEN');
});

test('proveRunLocked: each step fails on its own break', async () => {
  const cases = [
    [{ settingsText: JSON.stringify({ hooks: HOOKS, sandbox: { network: { allowedDomains: HOSTS } } }) }, 1, /still name registry\.npmjs\.org/],
    [{ settingsText: null }, 1, /could not be read back/],
    [{ installSettings: SETTINGS }, 1, /ran without registry\.npmjs\.org allowed/],
    [{ installSettings: null }, 1, /install's settings were not seen/],
    [{ mainStart: { four: { ok: false, reason: 'the install exited 1' } } }, 1, /refused the product's own install/],
    [{ mainStart: { ok: false, four: null, reason: 'launch check 2 (setup files): x' } }, 1, /never ran \(the launch stopped first: launch check 2/],
    [{ walled: { ok: true } }, 2, /reached github\.com/],
    [{ xWritten: true }, 2, /wrote \/Users\/workers\/x/],
    [{ walled: { ok: false, reason: 'the install job did not finish inside the lock-down' } }, 2, /could-not-reach exit code/],
    [{ walled: { ok: false, reason: 'the install exited 127' } }, 2, /could-not-reach exit code/],
    [{ walled: { ok: false, reason: 'the install exited 1' } }, 2, /could-not-reach exit code/],
    [{ walled: null }, 2, /never ran/],
    [{ verify: 'bad header' }, 3, /does not verify from the mirror: bad header/],
    [{ save: { ok: false, reason: 'lock-down' } }, 3, /save-work refused: lock-down/],
    [{ trapRuns: true }, 4, /a planted trap ran/],
    [{ disarm: false }, 4, /not put back to the clone's template/],
    [{ disarm: 'config' }, 4, /hooks folder is still there/],
    [{ save: (n) => (n === 2 ? { ok: false, reason: 'no' } : { ok: true }) }, 4, /refused the trapped copy/],
    [{ slow: { ok: true } }, 5, /passed an install that sleeps/],
    [{ slow: { ok: false, reason: 'the install exited 1' } }, 5, /not for the time limit/],
    [{ slow: { ok: false, reason: 'the install job did not finish inside the lock-down (spawn ENOENT)' } }, 5, /not for the time limit/],
    [{ listed: true }, 5, /still lists processes/],
    [{ listed: null }, 5, /can't be told/],
    [{ sleepers: [4321] }, 5, /still runs \(4321\)/],
    [{ sleepers: null }, 5, /still runs can't be told/],
    [{ stream: stream({ mode: 'default' }) }, 6, /mode default, not dontAsk/],
    [{ stream: stream({ command: "'/n/node' '/elsewhere/save-work.mjs'" }) }, 6, /did not run/],
    [{ stream: stream({ denied: [{}] }) }, 6, /denied 1/],
    [{ stream: stream({ result: false }) }, 6, /denied an unknown number of/],
    [{ stream: stream({ error: true }) }, 6, /returned an error/],
    [{ stream: stream({ hook: false }) }, 6, /no worker hook running/],
    [{ stream: 'garbage' }, 6, /can't be told/],
    [{ settingsText: '{"sandbox":{}}' }, 6, /no worker hook for Bash/],
    [{ save: { ok: false, reason: 'x' } }, 6, /did not answer ok/],
    [{ saveMs: LOCKED_SAVE_MS + 1 }, 7, /past save-work's limit/],
    [{ save: { ok: false, reason: 'x' } }, 7, /did not answer ok/],
  ];
  for (const [over, n, re] of cases) {
    const { r, by } = await run(over);
    assert.equal(by[n].result, 'FAIL', `${JSON.stringify(over).slice(0, 80)}: step ${n}`);
    assert.match(by[n].why, re, JSON.stringify(over).slice(0, 80));
    assert.equal(report(r).ok, false);
  }
  assert.equal((await run({ saveMs: LOCKED_SAVE_MS })).by[7].result, 'PASS', 'at the limit is inside it');
  let k = 0;
  assert.equal((await run({ listed: () => (k++ < 3) })).by[5].result, 'PASS', 'a group still being reaped is waited for');
  for (const code of CURL_UNREACHED) assert.equal((await run({ walled: { ok: false, reason: `the install exited ${code}` } })).by[2].result, 'PASS', String(code));
});

test('proveRunLocked: a step that could not be tried is NOT RUN, with why, never a pass', async () => {
  let { by } = await run({ mainStart: { ok: false, reason: 'launch check 12 (budget, caps and disjoint files): no check is wired' } });
  assert.equal(by[1].result, 'PASS', 'check 4 itself passed');
  for (const n of [3, 4, 6, 7]) { assert.equal(by[n].result, 'NOT RUN'); assert.match(by[n].why, /^blocked at launch check 12, not by runLocked: the session did not start/); }
  let x = await run({ mainStart: { ok: false, four: null, reason: 'setting names not confirmed on the pinned Claude Code: hooks' }, walledStart: { ok: false, reason: 'setting names not confirmed on the pinned Claude Code: hooks' }, leftoverStart: { ok: false } });
  for (const n of [1, 2]) { assert.equal(x.by[n].result, 'NOT RUN', String(n)); assert.match(x.by[n].why, /^blocked at launch check 0, not by runLocked: check 4 never ran \(setting names/); }
  assert.match(x.by[8].why, /^blocked at launch check 13, not by runLocked/);
  const rep = report(x.r);
  assert.equal(rep.ok, false, 'a blocked run is never done');
  assert.match(rep.text, /runLocked proof: NOT PASSED \(blocked at launch check 0 and launch check 13, not by runLocked: not done\)\n$/);
  ({ by } = await run({ mainStart: { ok: false, reason: 'launch check 11 (smoke and baseline): the baseline failed' } }));
  assert.match(by[3].why, /^the session did not start \(launch check 11/, 'any other refusal is not called blocked');
  ({ by } = await run({ stopOk: { ok: false, reason: 'EPERM' } }));
  for (const n of [3, 4, 6, 7]) assert.match(by[n].why, /could not be stopped \(EPERM\)/);
  ({ by } = await run({ xBefore: true }));
  assert.equal(by[2].result, 'NOT RUN'); assert.match(by[2].why, /is there already/);
  ({ by } = await run({ leftoverStart: { ok: false } }));
  assert.equal(by[8].result, 'NOT RUN');
  ({ by } = await run({ leftover: false, started: false }));
  assert.equal(by[8].result, 'NOT RUN', 'no own session made: not tried'); assert.match(by[8].why, /no `started` file/);
  const { r } = await run({ leftoverStart: { ok: false } });
  assert.equal(report(r).ok, false, 'step 8 not looked at is not a pass');
});

test('proveRunLocked: a start still running, and a proof that throws part way, are still cleaned up', async () => {
  const { w } = await run({ leftoverStart: { running: true } });
  const last = w.cleaned.at(-1);
  assert.equal(last.copy, `/w/copies/trial/${w.launched[3].req.card}`, 'its paths named by the proof');
  assert.ok(w.stopped.some((g) => g.pgid === 777), 'and its group stopped');
  const x = world({ verify: 'throw' });
  await assert.rejects(proveRunLocked({ c: x.c, product: 'trial', io: x.io }), /boom/);
  assert.equal(x.w.cleaned.length, 1, 'the session started before the throw');
  const y = world({ sleepers: [4321] });
  await proveRunLocked({ c: y.c, product: 'trial', io: y.io });
  assert.deepEqual(y.w.cleaned[2].sleepers, [4321], 'a sleep left by step 5 is handed to the cleanup');
});

test('main: a config that can\'t be read runs no step and exits 1', async () => {
  let text = '';
  const code = await main(['--config', 'relative.json', '--product', 'trial'], { print: (t) => { text += t; } });
  assert.equal(code, 1);
  assert.equal(text.match(/^NOT RUN /gm)?.length, 8);
  assert.match(text, /config can't be read/);
  assert.match(text, /runLocked proof: NOT PASSED/);
});

test('realWiring: the runner\'s own start port, with the card read as claimed for the very session and product asked', async () => {
  const c = { ...cfg(), home: '/nonexistent-proof-home', copiesRoot: '/nonexistent-proof/copies', outboxRoot: '/nonexistent-proof/outboxes', workerRunner: {}, path: '/usr/bin:/bin' };
  c.products.trial.render.paths = { deny: {} };
  const { start, saveWork } = realWiring('/nonexistent-proof/runs', () => {})(c, { answers: {}, settingsText: null, runs: [] });
  const r = await start({ card: 'proof-rl-main-t-1', kind: 'editing', product: 'trial', sessionId: 'proof-rl-main-t-2', live: [] });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /claimed|another product|names no product/, 'the stand-in card passes the claim checks');
  assert.match(r.reason, /no sign-in/, 'and the real port goes on to the sign-in');
  assert.equal(typeof saveWork, 'function');
});
