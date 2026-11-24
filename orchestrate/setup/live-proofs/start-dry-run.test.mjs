// The start dry run (L1346): every failure told in one run, a clean world PASS, nothing spawned, nothing left, keep-going real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { walledLaunchSettings } from '../../wiring/runner-launch.mjs';
import { FLAGS, namesIn } from '../../modules/M4-workshop/launcher/settings-names.mjs';
import { DRY_START_SAID, STAGES, dryCopyOf, dryRun, drySessionId, guardProblem, main, report } from './start-dry-run.mjs';

const HEAD = 'b'.repeat(40);
const SID = 'DRYRUN-test-0001';
const VERSION = '2.1.300';

function world({ plant = {} } = {}) {
  const d = realpathSync(tempDir('orch-dryrun-'));
  const copiesRoot = join(d, 'copies'); const outboxRoot = join(d, 'outboxes'); const settingsDir = join(d, 'runner', 'settings');
  const mine = { copies: join(copiesRoot, 'p1'), outboxes: join(outboxRoot, 'p1') };
  for (const f of [mine.copies, join(mine.outboxes, 'worker'), settingsDir, join(d, 'requests'), join(d, 'state')]) mkdirSync(f, { recursive: true });
  const c = { copiesRoot, outboxRoot, settingsDir, home: join(d, 'home'), path: '/usr/bin:/bin', claudeBin: '/bin/sleep', ownDir: join(d, 'runner'),
    workerRunner: { requestsDir: join(d, 'requests'), statusFile: join(d, 'state', 'status.json') },
    products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: { hooksDir: '/w/hooks', snapshot: '/w/snapshots/rules.json', node: '/w/node', notes: '/w/notes', bobFolder: '/w/bob', mirror: '/w/mirror.git',
      deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', proposals: ['/w/proposals/p1'] } },
    product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: ['/w/proposals/p1'] } } } };
  const confirmed = {};
  for (const f of Object.values(FLAGS)) if (f.startsWith('--')) confirmed[f] = { by: 'readback:stand-in', version: VERSION };
  const w = { d, c, mine, calls: [], ran: {}, spawns: 0 };
  const check = (n) => async () => {
    w.ran[n] = (w.ran[n] ?? 0) + 1;
    if (plant.checkThrows === n) throw new Error(`check ${n} blew up`);
    return plant.checks?.[n] ? { ok: false, reason: plant.checks[n] } : { ok: true };
  };
  const ports = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => [n, check(n)]));
  w.io = {
    sessionId: SID,
    roots: () => plant.roots ?? null,
    inputs: async () => ({ budget: null, bobManifest: null }),
    wallGate: async () => () => plant.wall ?? null,
    snapshots: () => ({ held: () => plant.snapshot ?? null }),
    testProduct: () => plant.testProduct ?? null,
    memory: () => { if (plant.memory) throw new Error(plant.memory); return { sessions: [], requests: {} }; },
    readCard: (id) => (plant.card ? { ok: false, reason: plant.card } : { ok: true, doc: { id, state: 'ready', product: 'p1' } }),
    wire: () => ({ startDeps: { names: { version: VERSION, confirmed }, checksFor: () => ports,
      beforeStart: async () => { w.calls.push('beforeStart'); return plant.recheck ?? null; } } }),
    deps: {
      startCommit: async () => { w.calls.push('startCommit'); return HEAD; },
      mainOf: async () => 'c'.repeat(40),
      prepare: async (x) => { w.calls.push(['prepare', x.dest]); if (plant.prepare) return { ok: false, reason: plant.prepare }; mkdirSync(x.dest, { recursive: true }); return { ok: true, dest: x.dest, head: HEAD }; },
      promptFor: () => { w.calls.push('promptFor'); return plant.prompt ? { ok: false, reason: plant.prompt } : 'do the card'; },
      account: () => (plant.signin ? { account: null, reason: plant.signin } : { account: 'a', dir: join(d, 'home', '.claude'), env: {} }),
      walled: (x) => {
        w.calls.push(['walled', x.phase ?? 'session', typeof x.check === 'function']);
        if (plant.walledThrows && (x.phase ?? 'session') === 'session') throw new Error('the render blew up');
        if (plant.wallCheck && x.phase === undefined && typeof x.check !== 'function') return { ok: false, reason: `not walled: ${plant.wallCheck}` };
        const r = walledLaunchSettings(typeof x.check === 'function' ? x : x);
        if (r.ok) for (const n of namesIn(r.settings)) if (!plant.unconfirmed) confirmed[n] = { by: 'readback:stand-in', version: VERSION };
        return r;
      },
      spawn: () => { w.spawns += 1; throw new Error('spawned'); },
    },
  };
  w.run = (over = {}) => dryRun({ c, product: 'p1', card: 'C-1', io: { ...w.io, ...over } });
  w.byStage = (out) => Object.fromEntries(out.results.map((r) => [r.stage, r]));
  w.leftovers = () => [
    ...readdirSync(mine.copies).filter((n) => n.includes(SID)),
    ...readdirSync(join(mine.outboxes, 'worker')).filter((n) => n.includes(SID)),
    ...readdirSync(settingsDir).filter((n) => n.includes(SID)),
  ];
  w.done = () => rmSync(d, { recursive: true, force: true });
  return w;
}

test('a clean world: every stage PASS (or SKIP for a check that does not apply), claude never spawned, nothing left', async () => {
  const w = world();
  try {
    const out = await w.run();
    const s = w.byStage(out);
    const bad = out.results.filter((r) => r.result !== 'PASS' && r.result !== 'SKIP');
    assert.deepEqual(bad, [], JSON.stringify(bad));
    assert.equal(s.start.result, 'PASS'); assert.equal(s.start.why, DRY_START_SAID);
    assert.equal(s.check13.result, 'PASS');
    assert.equal(out.spawned, 0); assert.equal(w.spawns, 0);
    assert.ok(w.calls.includes('beforeStart'), 'the recheck ran');
    assert.deepEqual(w.leftovers(), []);
    assert.deepEqual(out.left, []);
    assert.ok(out.made.some((f) => f.endsWith(`C-1..dryrun-${SID}`)), 'its copy was made beside the card\'s, under its own name');
    assert.deepEqual(readdirSync(w.c.workerRunner.requestsDir), [], 'nothing written to the requests folder');
    assert.equal(existsSync(w.c.workerRunner.statusFile), false, 'the status file is never written');
    const r = report(out.results, { sessionId: SID });
    assert.equal(r.ok, true); assert.match(r.text, /ALL PASS: dry run: would start claude now/);
    assert.equal(r.text.split('\n').filter((l) => /^PASS\s/.test(l)).length, STAGES.length);
  } finally { w.done(); }
});

test('several planted failures are all told in one run, and the run is not ready', async () => {
  const w = world({ plant: { wall: 'the builder wall is down', signin: 'the builder sign-in file can\'t be read (ENOENT)', checks: { 3: 'the outbox is not empty', 7: 'the hooks are not the pinned ones' } } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    for (const [k, re] of [['wall', /builder wall is down/], ['signin', /sign-in file can't be read/], ['check3', /outbox is not empty/], ['check7', /hooks are not the pinned ones \(ran after check 3 failed\)/]]) {
      assert.equal(s[k].result, 'FAIL', k); assert.match(s[k].why, re, k);
    }
    assert.equal(s.start.result, 'NOT TRIED');
    assert.equal(s.recheck.result, 'FAIL'); assert.match(s.recheck.why, /builder wall is down/, 'the wall asked again just before claude');
    for (const n of [4, 6, 11]) {
      assert.equal(s[`check${n}`].result, 'NOT TRIED', `check ${n} runs the branch's code: not past a failed gate`);
      assert.match(s[`check${n}`].why, /past a failed safety gate: the builder wall lets sessions start/);
      assert.equal(w.ran[n], undefined, `check ${n}'s port was never called`);
    }
    assert.match(s.start.why, /reached only past 8 failed stages/);
    const r = report(out.results);
    assert.equal(r.ok, false);
    assert.match(r.text, /5 stages failed:/);
    assert.match(r.text, /NOT READY/);
    assert.deepEqual(w.leftovers(), []);
    assert.equal(w.spawns, 0);
  } finally { w.done(); }
});

test('keep going really continues: after a failing check, the later checks run (their ports are called), each told on its stand-ins', async () => {
  const w = world({ plant: { prompt: 'the card has no plan', checks: { 7: 'the hooks are not the pinned ones' } } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.prompt.result, 'FAIL');
    assert.ok(w.calls.some((x) => Array.isArray(x) && x[0] === 'walled'), 'the settings were made after the prompt failed');
    assert.equal(s.check7.result, 'FAIL');
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) {
      assert.ok(w.ran[n] >= 1, `check ${n}'s port was called`);
      assert.equal(s[`check${n}`].result, 'PASS', `check ${n}`);
      assert.ok(s[`check${n}`].on.includes('the worker prompt'), `check ${n} says it ran on the prompt's stand-in`);
    }
    assert.ok(s.check12.on.includes('the launch checks that failed'));
    assert.equal(s.start.result, 'NOT TRIED', 'never a pass on stand-ins');
  } finally { w.done(); }
});

test('a settings wall that fails: told, then the rest runs on the settings with the wall check left out', async () => {
  const w = world({ plant: { wallCheck: 'the rules\' proposals folders are not all on the read-deny list' } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.settings.result, 'FAIL'); assert.match(s.settings.why, /proposals folders/);
    assert.ok(w.calls.some((x) => Array.isArray(x) && x[0] === 'walled' && x[1] === 'session' && x[2] === true), 'the stand-in leaves the wall check out');
    assert.equal(s.check12.result, 'PASS');
    assert.ok(s.check12.on.includes('the settings, with the runner wall check left out'));
    assert.equal(s.start.result, 'NOT TRIED');
    assert.deepEqual(w.leftovers(), []);
  } finally { w.done(); }
});

test('names not confirmed on the pin: check 0 FAIL, the checks still run on its stand-in', async () => {
  const w = world({ plant: { unconfirmed: true } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.check0.result, 'FAIL'); assert.match(s.check0.why, /^setting names not confirmed/);
    assert.equal(s.check5.result, 'PASS'); assert.ok(s.check5.on.includes('launch check 0 (its unconfirmed names)'));
    assert.equal(s.start.result, 'NOT TRIED');
  } finally { w.done(); }
});

test('a stage with no stand-in stops the run there: the copy refused, every later stage NOT TRIED (never PASS), nothing left', async () => {
  const w = world({ plant: { prepare: 'mirror: not a bare repository' } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.copy.result, 'FAIL'); assert.match(s.copy.why, /not a bare repository/);
    for (const k of ['outbox', 'prompt', 'list', 'settings', 'saveSettings', 'env', 'check0', 'check1', 'check12', 'recheck', 'start']) {
      assert.equal(s[k].result, 'NOT TRIED', k); assert.match(s[k].why, /stopped at: the copy is made/, k);
    }
    assert.equal(s.commit.result, 'PASS'); assert.equal(s.folders.result, 'PASS');
    assert.deepEqual(w.leftovers(), []);
  } finally { w.done(); }
});

test('the card can\'t be read: the start is not tried; the gates before it were still asked', async () => {
  const w = world({ plant: { card: 'no such card', snapshot: 'stale' } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.card.result, 'FAIL'); assert.equal(s.snapshot.result, 'FAIL');
    assert.equal(s.request.result, 'NOT TRIED'); assert.equal(s.start.result, 'NOT TRIED');
    assert.equal(s.cleanup.result, 'PASS');
  } finally { w.done(); }
});

test('a throw inside the start (past the copy and the outbox): told, and nothing is left (the start\'s own undo, then the dry run\'s cleanup)', async () => {
  const w = world({ plant: { walledThrows: true } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.copy.result, 'PASS'); assert.equal(s.outbox.result, 'PASS');
    assert.equal(s.settings.result, 'FAIL'); assert.match(s.settings.why, /the render blew up/);
    assert.equal(s.check0.result, 'NOT TRIED');
    assert.deepEqual(w.leftovers(), [], 'the copy and outbox the throw left are removed');
    assert.equal(s.cleanup.result, 'PASS');
  } finally { w.done(); }
});

test('a throw before the start (its inputs): every stage after it NOT TRIED, cleanup still runs', async () => {
  const w = world();
  try {
    const out = await w.run({ inputs: async () => { throw new Error('the budget threw'); } });
    const s = w.byStage(out);
    assert.equal(s.config.result, 'PASS'); assert.equal(s.roots.result, 'PASS');
    assert.equal(s.inputs.result, 'NOT TRIED'); assert.match(s.inputs.why, /the dry run stopped: the budget threw/);
    assert.equal(s.start.result, 'NOT TRIED'); assert.equal(s.cleanup.result, 'PASS');
  } finally { w.done(); }
});

test('it touches nothing not its own: the card\'s own copy and another start\'s baseline copy stay; the own copy still there is the real start\'s refusal', async () => {
  const w = world();
  const cardCopy = join(w.mine.copies, 'C-1'); const other = join(w.mine.copies, 'C-1..baseline-0f8fad5b-d9cb-469f-a165-70867728950e');
  mkdirSync(cardCopy); mkdirSync(other);
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(existsSync(cardCopy), true); assert.equal(existsSync(other), true);
    assert.equal(s.copy.result, 'FAIL'); assert.match(s.copy.why, /copy folder already exists/);
    assert.equal(s.start.result, 'NOT TRIED');
    assert.match(s.outbox.on.join(), /beside the card's own/, 'what ran after it says it ran on the stand-in');
    assert.ok(w.calls.some((x) => Array.isArray(x) && x[0] === 'prepare' && x[1] === dryCopyOf({ copiesRoot: w.c.copiesRoot, product: 'p1', card: 'C-1', sessionId: SID })));
    assert.deepEqual(w.leftovers(), []);
  } finally { w.done(); }
});

test('a card the runner already has a session or a waiting start for: the request stage FAILs, as the runner refuses it', async () => {
  for (const mem of [{ sessions: [{ id: 'S-9', card: 'C-1', product: 'p1', state: 'running' }], requests: {} }, { sessions: [], requests: { q9: { state: 'waiting', card: 'C-1', product: 'p1' } } }]) {
    const w = world();
    try {
      const out = await w.run({ memory: () => mem });
      const s = w.byStage(out);
      assert.equal(s.request.result, 'FAIL'); assert.match(s.request.why, /already has a session the runner started, or a start still on/);
      assert.equal(s.start.result, 'NOT TRIED'); assert.equal(w.spawns, 0);
    } finally { w.done(); }
  }
});

test('a gate the real start stops at marks every later PASS as on a stand-in', async () => {
  const w = world({ plant: { wall: 'the builder wall is down' } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.wall.result, 'FAIL');
    assert.match((s.card.on ?? []).join(), /let through/);
    assert.equal(report(out.results).ok, false);
  } finally { w.done(); }
});

test('stopped part way: no later check starts, nothing is spawned, the run ends normally and removes everything', async () => {
  const w = world();
  let stop = null;
  try {
    const out = await w.run({ onAbort: (f) => { stop = f; }, deps: { ...w.io.deps, promptFor: () => { stop('SIGINT'); return 'do the card'; } } });
    const s = w.byStage(out);
    assert.deepEqual(w.ran, {}, 'no launch check ran after the stop');
    assert.equal(s.check1.result, 'NOT TRIED'); assert.match(s.check1.why, /stopped \(SIGINT\)/);
    assert.equal(s.start.result, 'NOT TRIED'); assert.equal(w.spawns, 0);
    assert.equal(s.cleanup.result, 'PASS'); assert.deepEqual(w.leftovers(), []);
    assert.equal(report(out.results).ok, false);
  } finally { w.done(); }
});

test('main: a signal during the run waits for it to end (no early exit), takes its handlers off, exits 1; ALL PASS exits 0', async () => {
  for (const sigAt of ['promptFor', null]) {
    const w = world();
    const handlers = {}; let text = ''; let said = '';
    const signals = { on: (k, f) => { handlers[k] = f; }, off: (k) => { delete handlers[k]; } };
    const deps = { ...w.io.deps, promptFor: () => { if (sigAt) { handlers.SIGINT('SIGINT'); handlers.SIGINT('SIGINT'); } return 'do the card'; } };
    const argv = ['--product', 'p1', '--card', 'C-1'];
    try {
      const code = await main(argv, { print: (t) => { text += t; }, uid: 603, readConfig: () => w.c, configOf: (x) => x, umask: () => {}, say: (t) => { said += t; }, signals,
        io: { ...w.io, ownDirUid: 603, deps } });
      assert.deepEqual(handlers, {});
      if (sigAt) { assert.equal(code, 1); assert.match(said, /Stopping \(SIGINT\)/, text); assert.match(said, /Still stopping/); assert.match(text, /NOT READY/); }
      else { assert.equal(code, 0, text); assert.match(text, /ALL PASS/); }
      assert.deepEqual(w.leftovers(), []); assert.equal(w.spawns, 0);
    } finally { w.done(); }
  }
});

test('main: a closed window (SIGHUP, then every write failing) still ends the run and removes everything', async () => {
  const w = world();
  const handlers = {}; let writes = 0;
  const signals = { on: (k, f) => { handlers[k] = f; }, off: (k) => { delete handlers[k]; } };
  const gone = () => { writes += 1; throw Object.assign(new Error('write EIO'), { code: 'EIO' }); };
  const deps = { ...w.io.deps, promptFor: () => { handlers.SIGHUP('SIGHUP'); return 'do the card'; } };
  const argv = ['--product', 'p1', '--card', 'C-1'];
  try {
    const code = await main(argv, { print: gone, say: gone, uid: 603, readConfig: () => w.c, configOf: (x) => x, umask: () => {}, signals,
      io: { ...w.io, ownDirUid: 603, deps } });
    assert.equal(code, 1);
    assert.ok(writes >= 1, 'it did try to write before the hang-up');
    assert.deepEqual(w.leftovers(), []); assert.deepEqual(w.ran, {}, 'no check started after the hang-up'); assert.equal(w.spawns, 0);
  } finally { w.done(); }
});

test('the recheck just before claude: a gate or check failing there is told, and claude still not spawned', async () => {
  const w = world({ plant: { recheck: 'check 2: the setup files differ' } });
  try {
    const out = await w.run();
    const s = w.byStage(out);
    assert.equal(s.recheck.result, 'FAIL'); assert.match(s.recheck.why, /setup files differ/);
    assert.equal(s.start.result, 'NOT TRIED');
    assert.equal(w.spawns, 0);
    assert.deepEqual(w.leftovers(), []);
  } finally { w.done(); }
});

test('a session id the Dispatcher never makes; the guard refuses root, another user and a bad request', () => {
  assert.match(drySessionId(0, () => 'ab12'), /^DRYRUN-0-ab12$/);
  const c = { ownDir: '/r', products: { p1: {} } };
  assert.match(guardProblem({ c, product: 'p1', card: 'C-1', uid: 0, ownDirUid: 0 }), /runs as root/);
  assert.match(guardProblem({ c, product: 'p1', card: 'C-1', uid: 501, ownDirUid: 603 }), /Run it as that user/);
  assert.match(guardProblem({ c, product: 'p9', card: 'C-1', uid: 603, ownDirUid: 603 }), /not in the worker runner's config/);
  assert.match(guardProblem({ c, product: 'p1', card: 'a..b', uid: 603, ownDirUid: 603 }), /not a card id/);
  assert.equal(guardProblem({ c, product: 'p1', card: 'C-1', uid: 603, ownDirUid: 603 }), null);
});

test('main: a config that can\'t be read is a FAIL line and exit 1, with every other stage NOT TRIED', async () => {
  let text = ''; const masks = []; const sigs = [];
  const code = await main(['--config', '/nope', '--product', 'p1', '--card', 'C-1'], { print: (t) => { text += t; }, uid: 603, readConfig: () => { throw new Error('ENOENT'); }, umask: (m) => { masks.push(m); }, say: () => {}, signals: { on: (k) => sigs.push(k), off: (k) => sigs.splice(sigs.indexOf(k), 1) } });
  assert.deepEqual(masks, [0o077], 'the runner job\'s umask, so check 1 sees a 0700 copy'); assert.deepEqual(sigs, [], 'its signal handlers are taken off');
  assert.equal(code, 1);
  assert.match(text, /^FAIL\s+the worker runner's config is read/m);
  assert.match(text, /NOT READY/);
});
