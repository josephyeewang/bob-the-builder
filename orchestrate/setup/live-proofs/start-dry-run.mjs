#!/usr/bin/env node
// The start dry run (L1346): every check the worker runner's start makes on one card, in one run, each told PASS or FAIL,
// instead of one refusal per Dispatcher pass. Joe pastes one command on the Mini, as the worker runner's own Mac user:
//
//   sudo -H -u builder <installRoot>/bin/node <installRoot>/setup/live-proofs/start-dry-run.mjs --config <installRoot>/worker-runner.json --product <product> --card <card>
//
// (<installRoot> is the installed copy, <base>/install/orchestrate: setup/install.mjs installPaths.) The launch's kind is
// the one a Dispatcher pass gives the card (pass.mjs kindOf); an undo card is not tried (its reversed commit is the pass's).
//
// What it runs is the runner's own code, never a copy of it: main's config reading (runner-main.mjs configFrom), its roots
// check (rootsProblem), launch checks 12 and 13's inputs (launchInputs), the builder wall (wallGateOf), the test-product
// gate (testProductProblem) and the rules snapshot (rootSnapshots), the other live sessions' walls (runner-ports.mjs
// liveWallProblem, on the runner's memory read as the runner reads it), then the start port itself (startPort, with the
// ports lockedWiring builds for it, as realRunnerPorts does), through every launch check (launch.mjs) to the point where
// claude would be started. There it stops: nothing is spawned for the session, and the last line says "dry run: would
// start claude now". The launch checks are run for real: check 4 runs the product's install inside the lock-down, check 6
// starts the pinned claude once headless to read its settings back, and check 11 runs the smoke test and the baseline
// tests in a throwaway copy. That takes a few minutes and a little of the sign-in's usage.
//
// Keep going: where a stage fails and a later one can still be tried meaningfully, its failure is recorded and a stand-in
// takes its place (the sign-in: account a's folder with no token; the worker prompt: a short stand-in text; a settings
// wall that fails: the same settings with the wall check left out; launch check 0's unconfirmed names: confirmed for this
// run; a failing launch check: passed on). Every stage tried after a stand-in says which stand-ins it ran on, and a stage
// that could not be tried says NOT TRIED with the stage that stopped it. Nothing on a stand-in, and nothing not tried, is
// ever a PASS: "claude would start now" is a PASS only when every stage before it passed.
//
// What it changes: only what the real start makes, under names that hold this run's own session id (DRYRUN-…, never a
// Dispatcher's: those are UUIDs): a copy beside the card's own (<card>..dryrun-<id>, so the card's real copy is never
// taken), the session's outbox, its settings files in the runner's settings folder, and check 11's throwaway copy. Every
// removal and write it makes is held to those names (any other is refused and told), and all of them are removed at the
// end, on every path, a thrown error too; the last stage says whether anything was left. It never writes the Record, the
// requests folder or the status file, takes no runner lock, needs no sudo of its own, and reads the card as it is
// (claimed or not: it is read as claimed for this run's session in memory only). Claude Code keeps its own transcript of
// check 6's headless run in the workers' home, as it does for any start.
// Capability note (Principle 9): the start's order is startPort's as of this commit; a stage added to startPort is run by
// this dry run (it drives the real port) but is told under the stage after it until STAGES names it.
// Stopped part way (Ctrl-C, a closed window, kill): SIGINT, SIGTERM and SIGHUP remove what it made, then it exits 1.
// Only a kill -9 or a power cut can leave its files: names holding DRYRUN- in the runner's settings, copies and outbox
// folders, which no start reads as its own; remove those by hand (the last line of a finished run says none were left).

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configFrom, heldOf, launchInputs, lockedWiring, readRunnerConfig, rootSnapshots, rootsProblem, testProductProblem, wallGateOf } from '../../wiring/runner-main.mjs';
import { cardStartCommit, chmodTree, liveWallProblem, mirrorMain, removeAll, sessionSettingsOf, startPort, workerAccount, workerPromptText, writeNew } from '../../wiring/runner-ports.mjs';
import { walledLaunchSettings } from '../../wiring/runner-launch.mjs';
import { loadMemory } from '../../wiring/runner-loop.mjs';
import { RUNNER_ROLE_OF, live as isLive, runnerCopy, runnerOutbox, runnerPlaces } from '../../wiring/owner-status.mjs';
import { RUNNER_JOB_UMASK } from '../../wiring/runner-job.mjs';
import { readCardFile } from '../../modules/M4-workshop/launcher/review-runner-main.mjs';
import { prepareWorkerCopy } from '../../modules/M4-workshop/launcher/worker-copy.mjs';
import { CHECKS, launch } from '../../modules/M4-workshop/launcher/launch.mjs';
import { CONFIRMED, NAMES_CHECK_REFUSALS as NCR, unconfirmedNames } from '../../modules/M4-workshop/launcher/settings-names.mjs';
import { accountDir, accountEnv } from '../../modules/M4-workshop/launcher/accounts.mjs';
import { CARD_ID } from '../../modules/M9-record/outbox.mjs';
import { holdsSecret } from '../../shared/secret-guard.mjs';
import { kindOf } from '../../modules/M11-dispatcher/pass.mjs';
import { configUnreadable, notOwnUser } from './before-run.mjs';

export const DRY_START_SAID = 'dry run: would start claude now';
// startPort's own words when stopped() answers true inside start(), just before claude would be spawned.
const STOPPING_AT_START = 'the worker runner is stopping, so claude was not started';

/** Every stage, in the start's order: [key, what it shows]. */
export const STAGES = Object.freeze([
  ['config', 'the worker runner\'s config is read and passes its check'],
  ['roots', 'the copies and outbox folders are their own real paths'],
  ['inputs', 'launch checks 12 and 13\'s inputs load (the budget and the Bob file list)'],
  ['wall', 'the builder wall lets sessions start'],
  ['testProduct', 'the product is a test product'],
  ['snapshot', 'the product\'s rules snapshot is root\'s, fresh and matches'],
  ['memory', 'the runner\'s memory is read (its other live sessions)'],
  ['liveWalls', 'every other live session is walled off from this product'],
  ['card', 'the card is read from the Record, and is this product\'s'],
  ['request', 'the start request is one the runner takes'],
  ['signin', 'the sign-in is read'],
  ['commit', 'the copy\'s start commit is read'],
  ['folders', 'setup made the product\'s copies and outbox folders'],
  ['main', 'the mirror\'s main is read'],
  ['copy', 'the copy is made, and main did not move meanwhile'],
  ['outbox', 'the session\'s outbox is made'],
  ['prompt', 'the worker prompt is built'],
  ['list', 'the other folders to wall off are listed'],
  ['settings', 'the session\'s settings are made and walled'],
  ['saveSettings', 'the save\'s settings are made and walled'],
  ['env', 'the session\'s environment is built (check 9\'s form)'],
  ['check0', 'launch check 0: the setting and flag names are confirmed on the pinned claude'],
  ...CHECKS.map((k) => [`check${k.n}`, `launch check ${k.n}: ${k.name}`]),
  ['recheck', 'the gates and checks 1, 2, 3 and 8 once more, just before claude starts'],
  ['start', 'claude would start now'],
  ['cleanup', 'everything the dry run made is removed'],
]);
const LABEL = Object.fromEntries(STAGES);
const ORDER = STAGES.map(([k]) => k);
const INSIDE = ORDER.slice(ORDER.indexOf('request'), ORDER.indexOf('cleanup'));

/** A session id the Dispatcher never makes (its are UUIDs), within the start port's SESSION_ID. */
export const drySessionId = (now = Date.now(), rand = () => randomBytes(4).toString('hex')) => `DRYRUN-${now.toString(36)}-${rand()}`;
/** The dry run's copy: beside the card's own, in the product's copies folder, never the card's (`..` is in no card id). */
export const dryCopyOf = ({ copiesRoot, product, card, sessionId }) => join(runnerPlaces({ copiesRoot, outboxRoot: '/', product }).copies, `${card}..dryrun-${sessionId}`);

const refuse = (reason) => ({ ok: false, reason });
const said = (e) => e?.message ?? String(e);

/**
 * The dry run. c: the config as configFrom gives it (or null with `configWhy`); product, card; io: ports, each the
 * real one when left out (tests stand in for them): { roots, inputs, wallGate, snapshots, testProduct, memory, readCard,
 * readSettings, wire, deps (startPort's own deps, put under the dry run's wrappers), fs, sessionId, log }.
 * → { results: [{ stage, label, result: 'PASS'|'FAIL'|'NOT TRIED'|'SKIP', why?, on? }], sessionId, made, left, spawned }.
 */
export async function dryRun({ c, configWhy, product, card, io = {} }) {
  const log = io.log ?? (() => {});
  const sid = io.sessionId ?? drySessionId();
  const res = new Map();
  const standIns = [];
  const progress = io.progress ?? (() => {});
  const set = (k, result, why) => { if (!res.has(k)) { res.set(k, { stage: k, label: LABEL[k], result, ...(why ? { why } : {}), ...(standIns.length && result !== 'NOT TRIED' ? { on: [...standIns] } : {}) }); if (result !== 'NOT TRIED') progress(`${result} ${LABEL[k]}`); } };
  const pass = (k) => set(k, 'PASS');
  const fail = (k, why) => set(k, 'FAIL', why);
  // A gate the real start stops at: told, and the rest goes on as though it had let the start through (a stand-in).
  const failOn = (k, why, standIn) => { fail(k, why); standIns.push(standIn); };
  const made = new Set();
  let spawned = 0;
  let stopper = null;   // the stage whose failure stopped the run
  const stopAt = (k, why) => { fail(k, why); if (!stopper) stopper = k; };
  const fsReal = { mkdir: mkdirSync, rm: rmSync, writeNew, list: readdirSync, lstat: lstatSync, chmodTree, rename: renameSync, ...(io.fs ?? {}) };
  let copyPath = null;
  io.onAbort?.(() => cleanup());
  try {
    if (!c) { stopAt('config', configWhy ?? 'no config'); return finish(); }
    pass('config');
    // Main's order: the roots, then launch checks 12 and 13's inputs. Main stops on either; the dry run tells and goes on.
    let why; try { why = (io.roots ?? ((x) => rootsProblem(x)))(c); } catch (e) { why = said(e); }
    if (why) failOn('roots', why, 'the copies and outbox roots'); else pass('roots');
    const inputs = await (io.inputs ?? ((x) => launchInputs(x, { log })))(c);
    let budget = null; let bobManifest = null;
    if (inputs?.problem) failOn('inputs', inputs.problem, 'launch checks 12 and 13 with no inputs');
    else {
      ({ budget = null, bobManifest = null } = inputs ?? {});
      const missing = [c.budget !== undefined && !budget ? 'the budget module did not load' : null, c.bobManifest !== undefined && !bobManifest ? 'the Bob file list did not load' : null].filter(Boolean);
      if (missing.length) failOn('inputs', `${missing.join('; ')} (its launch check then has no port)`, 'launch checks 12 and 13 with no inputs'); else pass('inputs');
    }
    // productHeld's three parts, each asked on its own (main asks them in this order and stops at the first).
    const wallGate = await (io.wallGate ?? ((x) => wallGateOf(x, { log })))(c);
    const snaps = (io.snapshots ?? ((x) => rootSnapshots(x, { log })))(c);
    const testProduct = io.testProduct ?? testProductProblem;
    const ask = (k, f) => { let w; try { w = f(); } catch (e) { w = `it can't be checked (${said(e)})`; } if (w) failOn(k, w, `${LABEL[k]} (let through)`); else pass(k); };
    ask('wall', () => wallGate());
    ask('testProduct', () => testProduct(budget, product));
    ask('snapshot', () => snaps.held(product));
    const realHeld = heldOf(wallGate, budget, snaps.held, testProduct);
    // The other live sessions, as the runner's loop gives them to a start (worker-runner.mjs `live`): its listed live
    // sessions, and its waiting starts marked unstarted.
    let live = null; let busy = null;
    try {
      const m = (io.memory ?? ((x) => loadMemory(x.memoryFile, { uid: process.getuid() })))(c);
      live = [...(Array.isArray(m?.sessions) ? m.sessions : []).filter((s) => s && typeof s === 'object' && isLive(s)).map((s) => ({ id: s.id, product: s.product })),
        ...Object.entries(m?.requests && typeof m.requests === 'object' ? m.requests : {}).filter(([, r]) => r?.state === 'waiting').map(([q, r]) => ({ id: q, product: r.product, unstarted: true }))];
      // One session per card's copy (worker-runner.mjs, #358 r1 m4): a live listed one, or a start that may be on.
      if ((Array.isArray(m?.sessions) ? m.sessions : []).some((s) => s && typeof s === 'object' && s.card === card && isLive(s))
        || Object.values(m?.requests && typeof m.requests === 'object' ? m.requests : {}).some((r) => r?.state === 'waiting' && r.card === card)) busy = `card ${card} already has a session the runner started, or a start still on`;
      pass('memory');
    } catch (e) { failOn('memory', `it can't be read (${said(e)})`, 'no other live sessions'); set('liveWalls', 'NOT TRIED', 'the runner\'s memory could not be read'); }
    const readSettings = io.readSettings ?? sessionSettingsOf(c.settingsDir);
    if (live) {
      const p = c.products?.[product];
      let w2;
      try { w2 = p ? liveWallProblem(live, product, { ...runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: c.outboxRoot, product }), mirror: p.mirror }, readSettings) : null; } catch (e) { w2 = said(e); }
      if (w2) failOn('liveWalls', w2, 'the other live sessions\' walls (let through)'); else pass('liveWalls');
    }
    // The card as the Record holds it; the start port is given it as claimed for this run's session (in memory only).
    const rc = (io.readCard ?? ((id) => readCardFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, card: id })))(card);
    if (!rc?.ok) { stopAt('card', `it can't be read from the Record (${rc?.reason ?? 'no answer'})`); return finish(); }
    if (rc.doc?.product !== product) { stopAt('card', rc.doc?.product === undefined ? 'the card names no product' : `the card is product ${rc.doc.product}'s`); return finish(); }
    const kind = kindOf(rc.doc);
    if (kind === 'undo') { stopAt('card', 'it is an undo card; the dry run does not try an undo\'s start (its reversed commit is the pass\'s to name)'); return finish(); }
    set('card', 'PASS', `its state is ${rc.doc.state ?? 'not named'}; read as claimed for this run`);
    // What the real start meets that a dry run, beside the card, would not: the runner's one session per card, and
    // the card's own copy still there (prepareWorkerCopy refuses a copy folder that exists).
    if (busy) failOn('request', busy, 'the card taken as free');
    let ownCopy = null; try { ownCopy = runnerCopy({ copiesRoot: c.copiesRoot, product, card }); (io.fs?.lstat ?? lstatSync)(ownCopy); } catch { ownCopy = null; }
    if (ownCopy) failOn('copy', `the card's own copy is still there, so the real start refuses: copy folder already exists (${ownCopy})`, 'a copy beside the card\'s own');
    const claimed = { ...rc.doc, state: 'claimed', claim: { ...(rc.doc.claim ?? {}), session_id: sid } };

    // ---- the start port, with the runner's own ports, each wrapped to tell its stage and keep going ----
    const reached = new Set();
    // A stage reached means every stage before it inside the start passed, unless it was told already.
    const reach = (k) => { for (const s of INSIDE.slice(0, INSIDE.indexOf(k))) if (!res.has(s)) pass(s); reached.add(k); };
    const ownPath = (f) => typeof f === 'string' && f.includes(sid);
    const guard = (verb, f) => { if (!ownPath(f)) { log(`dry run: refused to ${verb} ${f}: not the dry run's own`); throw Object.assign(new Error(`the dry run does not ${verb} ${f}, which is not its own`), { code: 'EDRYRUN' }); } };
    const fs = {
      ...fsReal,
      mkdir: (f, o) => {
        guard('make', f);
        const box = f === outboxAt;
        if (box) reach('outbox');
        try { const r = fsReal.mkdir(f, o); made.add(f); if (box) pass('outbox'); return r; } catch (e) { if (box) stopAt('outbox', `the outbox can't be made (${e?.code ?? said(e)})`); throw e; }
      },
      writeNew: (f, t) => { guard('write', f); fsReal.writeNew(f, t); made.add(f); },
      rename: (a, b) => { guard('rename', a); guard('rename onto', b); fsReal.rename(a, b); made.add(b); },
      rm: (f, o) => { guard('remove', f); return fsReal.rm(f, o); },
      chmodTree: (f) => { guard('change', f); return fsReal.chmodTree(f); },
    };
    let outboxAt = null;
    try { outboxAt = runnerOutbox({ outboxRoot: c.outboxRoot, product, role: RUNNER_ROLE_OF[kind], sessionId: sid }); } catch { /* the start refuses it */ }
    let armed = false;
    let heldAgain = null; let recheckWhy = null;
    const base = io.deps ?? {};
    const wired = (io.wire ?? lockedWiring)(c, { stopped: () => armed, log, productHeld: () => null, budget, bobManifest, account: () => workerAccount(c) });
    const sd = { ...wired.startDeps, ...base };
    const baseAccount = base.account ?? (() => workerAccount(c));
    const baseCommit = base.startCommit ?? cardStartCommit;
    const basePrepare = base.prepare ?? prepareWorkerCopy;
    const baseMain = base.mainOf ?? mirrorMain;
    const basePrompt = base.promptFor ?? workerPromptText;
    const baseWalled = base.walled ?? walledLaunchSettings;
    const baseLaunch = base.launchFn ?? launch;
    let heldCalls = 0; let mainCalls = 0; let wallStandIn = false;
    const noWallCheck = () => ({ ok: true });
    const deps = {
      ...sd,
      fs,
      stopped: () => armed,
      log,
      readSettings,
      copyOf: (x) => { copyPath = dryCopyOf(x); return copyPath; },
      readCard: () => ({ ok: true, doc: claimed }),
      productHeld: (q) => {
        heldCalls += 1;
        if (heldCalls === 1) { reach('signin'); return null; }   // the gates were told above, each on its own
        try { heldAgain = realHeld(q); } catch (e) { heldAgain = said(e); }
        return null;
      },
      account: () => {
        let who; try { who = baseAccount(); } catch (e) { who = { account: null, reason: said(e) }; }
        if (who?.account) { pass('signin'); return who; }
        fail('signin', who?.reason ?? 'no answer');
        standIns.push('the sign-in (account a, no token)');
        return { account: 'a', dir: accountDir(c.home, 'a'), env: accountEnv(c.home, 'a') };
      },
      startCommit: async (x) => {
        try { const h = await baseCommit(x); pass('commit'); return h; } catch (e) { stopAt('commit', said(e)); throw e; }
      },
      mainOf: async (m) => {
        mainCalls += 1;
        if (mainCalls === 1) {
          reach('main');
          try { const h = await baseMain(m); pass('main'); return h; } catch (e) { stopAt('main', said(e)); throw e; }
        }
        return baseMain(m);
      },
      prepare: async (x) => {
        if (x.dest !== copyPath) return basePrepare(x);   // check 11's throwaway copy
        let r; try { r = await basePrepare(x); } catch (e) { r = refuse(said(e)); }
        if (!r?.ok) stopAt('copy', `the copy can't be made (${r?.reason ?? 'no answer'})`);
        else made.add(x.dest);
        return r;
      },
      promptFor: async (x) => {
        let g; try { g = await basePrompt(x); } catch (e) { g = refuse(said(e)); }
        if (typeof g === 'string' && g) { pass('prompt'); return g; }
        fail('prompt', `no worker prompt is given${g && typeof g === 'object' && g.reason ? ` (${String(g.reason).slice(0, 300)})` : ''}`);
        standIns.push('the worker prompt');
        return 'This is a dry run of the worker runner\'s start. Make no changes.';
      },
      walled: (x) => {
        const key = x.phase === 'save' ? 'saveSettings' : x.phase === undefined && x.paths?.copy === copyPath && !res.has('settings') ? 'settings' : null;
        if (key === 'settings') reach('settings');
        if (!key) return wallStandIn ? baseWalled({ ...x, check: noWallCheck }) : baseWalled(x);
        let r; try { r = baseWalled(x); } catch (e) { r = refuse(said(e)); }
        if (r?.ok) { pass(key); return r; }
        fail(key, r?.reason ?? 'no answer');
        let s; try { s = baseWalled({ ...x, check: noWallCheck }); } catch (e) { s = refuse(said(e)); }
        if (!s?.ok) { stopper = stopper ?? key; return r; }
        if (!wallStandIn) { wallStandIn = true; standIns.push('the settings, with the runner wall check left out'); }
        return s;
      },
      beforeStart: async (x) => {
        let w; try { w = sd.beforeStart ? await sd.beforeStart(x) : null; } catch (e) { w = said(e); }
        recheckWhy = w;
        return null;
      },
      spawn: () => { spawned += 1; throw new Error('the dry run never spawns claude'); },
      launchFn: async (a) => {
        reach('check0');
        let lastFailed = null;
        const checks = {};
        for (const k of CHECKS) {
          if (!k.applies(a.role, a.profile)) { set(`check${k.n}`, 'SKIP', `it does not apply to a ${a.role}`); continue; }
          const port = a.checks?.[k.n];
          checks[k.n] = async (ctx) => {
            let r;
            if (typeof port !== 'function') r = refuse('no check is wired');
            else { try { r = await port(ctx); } catch (e) { r = refuse(`the check failed: ${said(e)}`); } }
            if (r?.ok === true) pass(`check${k.n}`);
            else {
              fail(`check${k.n}`, `${r?.reason ?? 'no answer'}${lastFailed ? ` (ran after check ${lastFailed} failed)` : ''}`);
              lastFailed = k.n;
              if (!standIns.includes('the launch checks that failed')) standIns.push('the launch checks that failed');
            }
            return { ok: true };
          };
        }
        const start = async (ctx) => {
          reach('recheck');
          armed = true;
          const r = await a.start(ctx);
          armed = false;
          if (r?.ok === false && r.reason === STOPPING_AT_START) {
            const why = [heldAgain, recheckWhy].filter(Boolean).join('; ');
            if (why) fail('recheck', why); else pass('recheck');
            const bad = [...res.values()].filter((x) => x.stage !== 'start' && (x.result === 'FAIL' || x.result === 'NOT TRIED'));
            if (bad.length) set('start', 'NOT TRIED', `reached only past ${bad.length} failed stage${bad.length === 1 ? '' : 's'} (on stand-ins)`);
            else set('start', 'PASS', DRY_START_SAID);
            return refuse(DRY_START_SAID);
          }
          return r;
        };
        let l = await baseLaunch({ ...a, checks, start });
        if (l && l.ok === false && l.failedAt === 0) {
          fail('check0', l.reason);
          if (!String(l.reason).startsWith(NCR.unconfirmed)) { stopper = stopper ?? 'check0'; return l; }
          // Stand-in: every name not yet confirmed counts as confirmed for this run, so checks 1 to 13 can be tried.
          const left = unconfirmedNames({ ...a.names, confirmed: a.names?.confirmed ?? CONFIRMED });
          const confirmed = { ...(a.names?.confirmed ?? CONFIRMED), ...Object.fromEntries(left.map((n) => [n, { by: 'readback:dry-run-stand-in', version: a.names?.version }])) };
          standIns.push('launch check 0 (its unconfirmed names)');
          l = await baseLaunch({ ...a, names: { ...a.names, confirmed }, checks, start });
          if (l && l.ok === false && l.failedAt === 0) { res.get('check0').why += `; and then: ${l.reason}`; stopper = stopper ?? 'check0'; }
          return l;
        }
        if (!res.has('check0')) pass('check0');
        return l;
      },
    };
    const go = startPort(c, deps);
    let a;
    try { a = await go({ card, kind, product, sessionId: sid, live: [] }); } catch (e) { a = refuse(`the start threw (${said(e)})`); }
    if (!res.has('start')) {
      // Where the start stopped: the first stage not told yet, unless a stage told its own stop.
      for (const k of INSIDE) {
        if (res.has(k)) continue;
        if (stopper) set(k, 'NOT TRIED', `stopped at: ${LABEL[stopper]}`);
        else { stopAt(k, a?.reason ?? 'no answer'); }
      }
    }
    return finish();
  } catch (e) {
    for (const k of ORDER) if (k !== 'cleanup' && !res.has(k)) set(k, 'NOT TRIED', `the dry run stopped: ${said(e)}`);
    return finish();
  }

  function finish() {
    for (const k of ORDER) if (k !== 'cleanup' && !res.has(k)) set(k, 'NOT TRIED', stopper ? `stopped at: ${LABEL[stopper]}` : 'not reached');
    const left = cleanup();
    if (!res.has('cleanup')) { if (left.length) fail('cleanup', `left behind: ${left.join(', ')}`); else pass('cleanup'); }
    return { results: ORDER.map((k) => res.get(k)), sessionId: sid, made: [...made], left, spawned };
  }

  function cleanup() {
    const own = new Set(made);
    if (copyPath) own.add(copyPath);
    if (c?.settingsDir) { try { for (const n of fsReal.list(c.settingsDir)) if (n.startsWith(`${sid}.`)) own.add(join(c.settingsDir, n)); } catch { /* none made */ } }
    if (c?.copiesRoot && c?.products?.[product]) {
      try { const d = runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: '/', product }).copies; for (const n of fsReal.list(d)) if (n.includes(sid)) own.add(join(d, n)); } catch { /* none made */ }
    }
    const left = [];
    for (const f of own) {
      if (!f.includes(sid)) continue;   // never anything not this run's own
      let there = true; try { fsReal.lstat(f); } catch { there = false; }
      if (!there) continue;
      removeAll(fsReal, f, log);
      try { fsReal.lstat(f); left.push(f); } catch { /* gone */ }
    }
    return left;
  }
}

/** The printed report: one line per stage, then every failure. → { text, ok }. Nothing that holds the sign-in is printed. */
export function report(results, { sessionId } = {}) {
  const mask = (t) => (holdsSecret(String(t)) ? '(withheld: it held the sign-in)' : String(t).replace(/sk-ant-[A-Za-z0-9_-]+/g, '(withheld)'));
  const lines = [`Start dry run${sessionId ? ` (session ${sessionId})` : ''}: every stage of the worker runner's start, in order.`];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    // A run of stages not tried for one reason is one line: the first, and how many more.
    let j = i; while (j + 1 < results.length && results[j + 1].result === 'NOT TRIED' && r.result === 'NOT TRIED' && results[j + 1].why === r.why) j += 1;
    if (j - i >= 2) { lines.push(`NOT TRIED ${r.label}, and the ${j - i} stages after it: ${mask(r.why)}`); i = j; continue; }
    const on = r.on?.length ? ` [after stand-ins for: ${r.on.join('; ')}]` : '';
    lines.push(`${r.result.padEnd(9)} ${r.label}${r.why && r.result !== 'PASS' ? `: ${mask(r.why)}` : ''}${r.result === 'PASS' && r.why ? ` (${mask(r.why)})` : ''}${on}`);
  }
  const failed = results.filter((r) => r.result === 'FAIL');
  const notTried = results.filter((r) => r.result === 'NOT TRIED');
  lines.push('');
  if (failed.length) {
    lines.push(`${failed.length} stage${failed.length === 1 ? '' : 's'} failed:`);
    failed.forEach((r, i) => lines.push(`  ${i + 1}. ${r.label}: ${mask(r.why)}`));
  } else lines.push('No stage failed.');
  if (notTried.length) lines.push(`${notTried.length} stage${notTried.length === 1 ? '' : 's'} could not be tried; they are not passes.`);
  const ok = results.every((r) => r.result === 'PASS' || r.result === 'SKIP');
  lines.push(ok ? `ALL PASS: ${DRY_START_SAID}.` : 'NOT READY: the real start would be refused.');
  return { text: `${lines.join('\n')}\n`, ok };
}

const arg = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }

/** Why the dry run must not run, or null: root, another user than the runner's, or a request the runner would not take. */
export function guardProblem({ c, product, card, uid, ownDirUid }) {
  if (!Number.isInteger(uid) || uid === 0) return 'it runs as root. Run it as the worker runner\'s own user (sudo -H -u builder)';
  const own = notOwnUser({ c, uid, ownDirUid }); if (own) return own;
  if (typeof product !== 'string' || !product) return 'no --product was named';
  if (!Object.hasOwn(c?.products ?? {}, product)) return `product ${product} is not in the worker runner's config`;
  if (typeof card !== 'string' || !CARD_ID.test(card) || card.startsWith('.')) return 'no --card was named, or it is not a card id';
  return null;
}

export async function main(argv, { print = (t) => process.stdout.write(t), uid = process.getuid?.(), readConfig = (f) => readRunnerConfig(f, selfPath()), io = {},
  umask = (m) => process.umask(m), say = (t) => process.stderr.write(t), signals = process } = {}) {
  // The runner's job runs with this umask (runner-job.mjs); sudo's is 022, and check 1 refuses a copy others can read.
  umask(RUNNER_JOB_UMASK);
  const product = arg(argv, '--product'); const card = arg(argv, '--card');
  let c = null; let configWhy;
  try { c = configFrom(readConfig(arg(argv, '--config'))); } catch (e) { configWhy = configUnreadable(e); }
  if (c) {
    let ownDirUid; try { const st = lstatSync(c.ownDir); ownDirUid = st.isDirectory() && !st.isSymbolicLink() ? st.uid : null; } catch { ownDirUid = null; }
    const bad = guardProblem({ c, product, card, uid, ownDirUid: io.ownDirUid ?? ownDirUid });
    if (bad) { print(`The dry run did not run: ${bad}.\n`); return 1; }
  }
  // Progress and the runner's own log lines as they come (the launch checks take minutes); the report follows.
  // A stop part way removes what it made first.
  let undo = null;
  const onSignal = (sig) => { say(`\nStopped (${sig}): removing what the dry run made.\n`); try { undo?.(); } finally { process.exit(1); } };
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of sigs) signals.on(s, onSignal);
  let out;
  try {
    out = await dryRun({ c, configWhy, product, card, io: { progress: (t) => say(`  ${t}\n`), log: (t) => say(`  (log) ${t}\n`), ...io, onAbort: (f) => { undo = f; io.onAbort?.(f); } } });
  } finally { for (const s of sigs) signals.off(s, onSignal); }
  const r = report(out.results, { sessionId: out.sessionId });
  print(r.text);
  return r.ok ? 0 : 1;
}

const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
// No top-level await at the entry (M4 review-install-closure.test.mjs).
if (invoked && invoked === selfPath()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
