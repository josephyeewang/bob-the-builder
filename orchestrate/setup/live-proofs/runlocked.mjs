// Live proof 9, runLocked on the Mini (modules/M4-workshop/README.md "Live proofs still to run", item 9; L969, L974,
// L987, L988). Joe pastes one command on the Mini, as the worker runner's own Mac user (never with sudo):
//
//   node <installed copy>/orchestrate/setup/live-proofs/runlocked.mjs --config <the worker runner's config> --product <the test product>
//
// It prints one line per step, PASS, FAIL or NOT RUN with a plain reason (step 8: SEEN or NOT SEEN, a known limit to
// tell the Lead), and exits 0 only when steps 1 to 7 pass and step 8 was looked at. A NOT RUN step is never a pass.
// Each step and what was found is also written to runlocked-proof-<time>.jsonl in the user's home, with the claude pin:
// the result holds for that pin only, and is void, to be run again, whenever the pin moves (Principle 9).
//
// No Dispatcher and no --check-locked flag: the runner's own builders are called directly (runner-main.mjs lockedOf and
// lockedWiring, runner-ports.mjs startPort, as realRunnerPorts builds them), on throwaway cards of the test product.
// Two inputs are this proof's own, since no Dispatcher runs: the card is read as claimed for its session (readCard),
// and the session is given a short do-nothing prompt (promptFor, not wired on main yet). The variants a step needs (an
// install command, a shorter lockedMs) are made on a copy of the config in memory: the config file is never written.
//
// It refuses to run (every step NOT RUN, exit 1) unless: it runs as the user that owns the runner's own folder, and not
// as root; the product is in the runner's config and its repository is the test repository (TEST_REPO); the config
// names the pinned claude and `claude --version` is that pin; the product declares an install command and registry
// hosts (none of them github.com, which step 2 must not reach); the worker runner is not running (its lock is taken for
// the proof's run, so the two never share a folder); and the runner's memory lists no session still live.
//
// A launch that stops before or after check 4 for a reason that is not runLocked's (launch check 0, the setting names
// not yet confirmed on the pin, live proof L2; check 12 or 13 refusing, e.g. an input the runner's own launchInputs
// could not load, L1092) makes the steps it blocks NOT RUN, with that reason: never FAIL, which would blame runLocked,
// and never PASS. The run's last line names the check that
// blocked it, and the run exits 1, so a blocked run can never be read as done (L989).
// Capability note (Principle 9): step 6 reads claude's stream-json lines (`system`/`init` permissionMode, `tool_use`,
// `tool_result` is_error, `result` permission_denials, and a `system` hook line naming PreToolUse) by names not yet
// confirmed on any pin. A line missing reads as "can't tell", which fails the step; a renamed is_error would not be
// seen, so step 6 also needs save-work's own ok answer. Claude Code's own transcripts of the proof's sessions stay in the
// workers' home (<configDir>/projects/); the run's last line says so.

import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn as childSpawn, spawnSync } from 'node:child_process';
import { makeLock } from '../../modules/M9-record/lock.mjs';
import { checkRunnerConfig, launchInputs, lockedOf, lockedWiring, readRunnerConfig } from '../../wiring/runner-main.mjs';
import { JOBS_DIR, lockedRunner, LOCKED_SAVE_MS, quoted } from '../../wiring/runner-locked.mjs';
import { startPort, removeAll, chmodTree, saveSettingsName } from '../../wiring/runner-ports.mjs';
import { loadMemory, processGroupPorts } from '../../wiring/runner-loop.mjs';
import { runnerCopy, runnerOutbox, RUNNER_ROLE_OF } from '../../wiring/owner-status.mjs';
import { CLONE_CONFIG_TEMPLATE } from '../../modules/M4-workshop/git/save-work.mjs';
import { bundleName } from '../../modules/M4-workshop/git/push.mjs';

export const TEST_REPO = 'orchestrate-test';
export const STEPS = Object.freeze([
  [1, 'the install, check 4: passes, and the session settings keep none of the registry hosts'],
  [2, 'the install is walled: no network, no write to the home folder'],
  [3, 'save-work: the card\'s bundle is in the outbox and verifies from the mirror'],
  [4, 'save-work of a trapped copy: a new bundle is made, the planted hook and include are disarmed, none ran'],
  [5, 'the time limit: an install past lockedMs is stopped, its whole process group too'],
  [6, 'claude runs the job: save-work ran under dontAsk with the worker hooks set, nothing denied'],
  [7, 'save-work in time: the first save (called directly, no Dispatcher) answered inside save-work\'s limit'],
  [8, 'an install\'s leftover: a process the install moved into its own session (a known limit)'],
]);
const TITLE = Object.fromEntries(STEPS);
export const PROOF_PROMPT = 'This session is a live test of the worker runner. Make no changes and run nothing. Reply with the word done.';
export const LEFTOVER_WAIT_MS = 25_000;
const SHORT_LOCKED_MS = 60_000;

const pass = (n, found = {}) => ({ step: n, result: 'PASS', found });
const fail = (n, why, found = {}) => ({ step: n, result: 'FAIL', why, found });
const notRun = (n, why) => ({ step: n, result: 'NOT RUN', why });

/** Why the proof must not run, or null. Every input is read by the caller; nothing here touches the disk. */
export function guardProblem({ c, product, uid, ownDirUid, claudeVersion }) {
  if (!Number.isInteger(uid) || uid === 0) return 'it runs as root (with sudo). Run it as the worker runner\'s own user, without sudo';
  if (ownDirUid !== uid) return `it runs as uid ${uid}, but the worker runner's own folder ${c?.ownDir} is uid ${ownDirUid}'s. Run it as that user`;
  if (typeof product !== 'string' || !product) return 'no --product was named. Name the test product';
  const p = Object.hasOwn(c?.products ?? {}, product) ? c.products[product] : null;
  if (!p) return `product ${product} is not in the worker runner's config`;
  if (String(p.repo).split('/')[1] !== TEST_REPO) return `product ${product}'s repository is ${p.repo}, not the test repository (${TEST_REPO}). This proof runs on the test product only`;
  if (typeof c.claudeBin !== 'string' || !c.claudeBin.startsWith('/')) return 'the config names no pinned claude (claudeBin), so nothing can run inside the lock-down';
  if (typeof c.pin !== 'string') return 'the config names no claude pin (pin)';
  if (claudeVersion !== c.pin) return `claude is ${claudeVersion ?? 'not readable'}, but the config's pin is ${c.pin}. Run it with the pinned claude`;
  const install = p.render?.product?.commands?.install;
  if (typeof install !== 'string' || !install.trim()) return `product ${product} declares no install command, so check 4 has nothing to run`;
  if (!Array.isArray(p.render?.registryHosts) || !p.render.registryHosts.length) return `product ${product} declares no registry hosts, so step 1 would prove nothing`;
  if (p.render.registryHosts.some((h) => /(^|\.)github\.com$/i.test(String(h)))) return `product ${product}'s registry hosts include github.com, which step 2 shows the install can't reach`;
  return null;
}

/** The config with one product's install command, and perhaps lockedMs, changed: in memory only. */
export function variant(c, product, { install, lockedMs } = {}) {
  const p = c.products[product];
  const commands = { ...(p.render.product?.commands ?? {}), ...(install !== undefined ? { install } : {}) };
  return { ...c, ...(lockedMs !== undefined ? { lockedMs } : {}), products: { ...c.products, [product]: { ...p, render: { ...p.render, product: { ...p.render.product, commands } } } } };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** Step 2's install: curl to github.com, then a write to the home folder; it exits with curl's own code. */
export const walledInstall = (home) => `curl -sS --max-time 20 https://github.com >/dev/null 2>&1; r=$?; touch ${q(join(home, 'x'))} 2>/dev/null; exit $r`;
/** Step 8's install: a process in a session of its own (perl's POSIX setsid; macOS has no setsid program) that writes
 * `leftover` in the folder the install runs in, the copy, 20 seconds later; the install itself exits 0 at once. */
export const LEFTOVER_INSTALL = `perl -MPOSIX -e 'POSIX::setsid() > 0 or die; exec @ARGV' sh -c 'touch started; sleep 20; touch leftover' </dev/null >/dev/null 2>&1 & exit 0`;
/** Step 5's install: a sleep past any lockedMs, by a number no other process is likely to use, so it can be looked for. */
export const SLOW_INSTALL = 'sleep 1213';
/** curl's own exit codes for a host it could not reach (6 no name, 7 no connection, 28 timed out, 35 TLS, 56 receive). */
export const CURL_UNREACHED = Object.freeze([6, 7, 28, 35, 56]);
/** A launch refused for a reason that is not runLocked's: the names check (launch check 0), or checks 12 and 13. */
// → 'launch check 0' | 'launch check 12' | 'launch check 13', or null for any other reason (L989: the line names the check).
// The check-0 prefixes are a copy of the names check's own wording until #531 lands (R-0b-177, L1108); then this uses
// isNamesCheckRefusal from modules/M4-workshop/launcher/settings-names.mjs instead.
export const blockedBy = (reason) => {
  const r = String(reason ?? '');
  if (/^(setting names not confirmed|the role file given to the names check)/.test(r)) return 'launch check 0';
  const n = /^launch check (12|13) \(/.exec(r)?.[1];
  return n ? `launch check ${n}` : null;
};
/** The plain why of a step that something other than runLocked stopped. */
const blockedWhy = (at, reason, what) => `blocked at ${at}, not by runLocked: ${what} (${reason})`;

/** The lines of a stream-json run that say what claude did. Names checked against nothing yet (Principle 9): a stream
 * without them is "can't tell", never a pass. → { mode, commands, denied, errors } or null. */
export function readStream(text) {
  let mode = null; const commands = []; let denied = null; let errors = 0; let seen = false; let hooks = 0;
  for (const line of String(text ?? '').split('\n')) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m?.type === 'system' && m?.subtype === 'init') { seen = true; mode = m.permissionMode ?? null; }
    if (m?.type === 'system' && /hook/i.test(String(m?.subtype ?? '')) && line.includes('PreToolUse')) hooks += 1;
    for (const part of Array.isArray(m?.message?.content) ? m.message.content : []) {
      if (m.type === 'assistant' && part?.type === 'tool_use' && part.name === 'Bash') commands.push(String(part.input?.command ?? ''));
      if (m.type === 'user' && part?.type === 'tool_result' && part.is_error === true) errors += 1;
    }
    if (m?.type === 'result') denied = Array.isArray(m.permission_denials) ? m.permission_denials.length : null;
  }
  return seen ? { mode, commands, denied, errors, hooks } : null;
}

/** The settings keep a PreToolUse hook whose matcher covers Bash (the worker hooks), read from the session's settings text. */
export const hooksSet = (text) => {
  try {
    const h = JSON.parse(text)?.hooks?.PreToolUse;
    return Array.isArray(h) && h.some((e) => Array.isArray(e?.hooks) && e.hooks.length > 0 && (e.matcher === undefined || e.matcher === '' || e.matcher === '*' || new RegExp(`^(?:${e.matcher})$`).test('Bash')));
  } catch { return false; }
};

/**
 * The proof's steps, with every port given (tests pass stand-ins). → results, one per step, in STEPS order.
 * io: { wiring(cfg, rec) → { start, saveWork }, stopGroup(s), groupListed(pid) → true/false/null, sleepers() → pids of
 * SLOW_INSTALL still running, verifyBundle(mirror, file) → null | why, exists(p), read(p), write(p, text, mode?), mkdir(p),
 * sleep(ms), now(), id(tag), reachable() → true/false (github.com from outside the sandbox, step 2's control),
 * warn(text), rm(p) (a link removed, not followed), cleanup({ copy, outbox, settingsFile, saveSettingsFile, settingsDir,
 * sessionId, sleepers? }) }.
 * rec (one per launch, filled by io.wiring): answers (check n → its answer), settingsText (the session's settings after
 * check 4), runs (each claude run: pid, out, job, settingsText it started with), groups (each group runLocked was told of,
 * as { name: 'install'|'save-work', group: { pgid, pid, pid_start, job?: { pgid, pid, pid_start } } }).
 */
export async function proveRunLocked({ c, product, io }) {
  const out = new Map();
  const p = c.products[product];
  const sessions = [];
  const role = RUNNER_ROLE_OF.editing;
  // One launch of a throwaway card. Its copy and outbox are named before the start, so a start that answers "still
  // running" (no paths) is cleaned up too.
  const launchOne = async (cfg, tag) => {
    const rec = { answers: {}, settingsText: null, runs: [], groups: [] };
    const { start, saveWork } = io.wiring(cfg, rec);
    const card = io.id(`proof-rl-${tag}`); const sessionId = io.id(`proof-rl-${tag}`);
    const s = { card, sessionId, saveWork, rec, copy: runnerCopy({ copiesRoot: c.copiesRoot, product, card }), outbox: runnerOutbox({ outboxRoot: c.outboxRoot, product, role, sessionId }) };
    sessions.push(s);
    try { s.r = await start({ card, kind: 'editing', product, sessionId, live: [] }); } catch (e) { s.r = { ok: false, reason: e?.message ?? String(e) }; }
    return s;
  };
  const four = (s) => s.rec.answers[4];
  // A step whose check 4 never ran: NOT RUN when something other than runLocked stopped the launch first, else FAIL.
  const noFour = (n, s) => { const at = blockedBy(s.r?.reason); return at ? notRun(n, blockedWhy(at, s.r.reason, 'check 4 never ran')) : fail(n, `check 4 never ran (the launch stopped first: ${s.r?.reason ?? 'no answer'})`); };
  const groupOf = (r) => ({ pid: r.pid ?? r.pgid, pgid: r.pgid, pid_start: r.pidStart });
  const stop = async (r) => { try { return await io.stopGroup(groupOf(r)); } catch (e) { return { ok: false, reason: e?.message ?? String(e) }; } };
  try {
    // Steps 1, 3, 4, 6 and 7: one session of the product as declared.
    const main = await launchOne(c, 'main');
    const a4 = four(main);
    const install = main.rec.runs.find((r) => r.job === 'install');
    if (!a4) out.set(1, noFour(1, main));
    else if (!a4.ok) out.set(1, fail(1, `check 4 refused the product's own install: ${a4.reason}`));
    else {
      const during = p.render.registryHosts.filter((h) => !String(install?.settingsText ?? '').includes(h));
      const kept = p.render.registryHosts.filter((h) => String(main.rec.settingsText ?? '').includes(h));
      out.set(1, !install?.settingsText ? fail(1, 'the install\'s settings were not seen, so the registry hosts can\'t be shown allowed for it')
        : during.length ? fail(1, `the install ran without ${during.join(', ')} allowed, so their removal afterwards shows nothing`)
          : main.rec.settingsText === null ? fail(1, 'the session\'s settings file could not be read back after check 4')
            : kept.length ? fail(1, `the session's settings still name ${kept.join(', ')} after the install`) : pass(1, { hosts: p.render.registryHosts }));
    }
    if (main.r?.ok !== true) {
      const at = blockedBy(main.r?.reason);
      const why = at ? blockedWhy(at, main.r.reason, 'the session did not start, so its work can\'t be saved') : `the session did not start (${main.r?.reason ?? 'no answer'}), so its work can't be saved`;
      for (const n of [3, 4, 6, 7]) out.set(n, notRun(n, why));
    } else {
      const stopped = await stop(main.r);
      if (!stopped?.ok) for (const n of [3, 4, 6, 7]) out.set(n, notRun(n, `the test session could not be stopped (${stopped?.reason ?? 'no answer'})`));
      else {
        // The row as the runner keeps it: with the hash of the save settings its start wrote (save-work refuses a row
        // without one, #463 r1 m3; review M1).
        const s = { id: main.sessionId, product, kind: 'editing', copy: main.r.copy, card: main.card, outbox: main.r.outbox, save_settings_sha: main.r.saveSettingsSha };
        const bundle = join(s.outbox, bundleName(s.card));
        const before = main.rec.runs.length;
        const t0 = io.now(); let a; try { a = await main.saveWork(s); } catch (e) { a = { ok: false, reason: e?.message ?? String(e) }; }
        const took = io.now() - t0;
        const run = main.rec.runs[before];
        if (!a?.ok) out.set(3, fail(3, `save-work refused: ${a?.reason ?? 'no answer'}`));
        else { const v = io.verifyBundle(p.mirror, bundle); out.set(3, v ? fail(3, `the bundle ${bundle} does not verify from the mirror: ${v}`) : pass(3, { bundle })); }
        out.set(7, !a?.ok ? fail(7, 'the first save (called directly, no Dispatcher) did not answer ok')
          : took > LOCKED_SAVE_MS ? fail(7, `the save took ${took} ms, past save-work's limit of ${LOCKED_SAVE_MS} ms: a time limit to set again`) : pass(7, { ms: took }));
        let st = null; try { st = run ? readStream(io.read(run.out)) : null; } catch { st = null; }
        const script = quoted(join(JOBS_DIR, 'save-work.mjs'));
        const job = st?.commands.find((cmd) => cmd.includes(script));
        out.set(6, !a?.ok ? fail(6, 'save-work did not answer ok, so claude can\'t be shown to have run it') : !run ? fail(6, 'no claude run was seen for the save')
          : !st ? fail(6, 'claude\'s run said nothing that can be read, so it can\'t be told it ran the job')
            : st.mode !== 'dontAsk' ? fail(6, `claude ran in mode ${st.mode}, not dontAsk`) : !job ? fail(6, `claude did not run ${script}`)
              : st.denied !== 0 ? fail(6, `claude denied ${st.denied ?? 'an unknown number of'} calls`) : st.errors ? fail(6, 'a call claude made returned an error')
                : !hooksSet(run.settingsText) ? fail(6, 'the settings the save ran under set no worker hook for Bash')
                  : !st.hooks ? fail(6, 'claude\'s run shows no worker hook running on the call') : pass(6, { command: job }));
        // Step 4: the same copy, trapped, saved again. The traps can't fire in a save that never commits or reads the
        // index, so the proof is the disarm itself: the config back to the clone's template, the hooks folder gone.
        const git = join(s.copy, '.git');
        const markers = [join(s.copy, 'marker-hook'), join(s.copy, 'marker-include')];
        try {
          io.mkdir(join(git, 'hooks'));
          io.write(join(git, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${q(markers[0])}\n`, 0o755);
          const inc = join(git, 'trap.config');
          io.write(inc, `[core]\n\tfsmonitor = touch ${q(markers[1])}; true\n\thooksPath = ${join(git, 'hooks')}\n`);
          io.write(join(git, 'config'), `${io.read(join(git, 'config'))}[include]\n\tpath = ${inc}\n`);
        } catch (e) { out.set(4, notRun(4, `the trap could not be planted in the copy (${e?.code ?? e?.message})`)); }
        // Step 3's bundle removed, so only one this save makes verifies (review m2). Removed, never written: a link
        // planted there is taken away, not followed to a file of the owner's (r2 review m1).
        if (!out.has(4)) { try { io.rm(bundle); } catch (e) { out.set(4, notRun(4, `step 3's bundle ${bundle} could not be removed (${e?.code ?? e?.message})`)); } }
        if (!out.has(4)) {
          let b; try { b = await main.saveWork(s); } catch (e) { b = { ok: false, reason: e?.message ?? String(e) }; }
          const ran = markers.filter((m) => io.exists(m));
          let cfgNow = null; try { cfgNow = io.read(join(git, 'config')); } catch { cfgNow = null; }
          let v4 = null;
          out.set(4, ran.length ? fail(4, `a planted trap ran: ${ran.join(', ')} exists`) : !b?.ok ? fail(4, `save-work refused the trapped copy: ${b?.reason ?? 'no answer'}`)
            : !io.exists(bundle) ? fail(4, 'save-work answered, but no bundle is in the outbox')
              : (v4 = io.verifyBundle(p.mirror, bundle)) ? fail(4, `the trapped copy's bundle does not verify from the mirror: ${v4}`)
              : cfgNow !== CLONE_CONFIG_TEMPLATE ? fail(4, 'the copy\'s git config was not put back to the clone\'s template, so the planted include was not disarmed')
                : io.exists(join(git, 'hooks')) ? fail(4, 'the copy\'s hooks folder is still there after the save') : pass(4, { bundle }));
        }
      }
    }

    // Step 2: an install that reaches for the network and the home folder.
    const x = join(c.home, 'x');
    if (io.exists(x)) out.set(2, notRun(2, `${x} is there already. Remove it, then run this again`));
    // The control (review m5): github.com reached from outside the sandbox, else a walled curl shows nothing.
    else if (io.reachable() !== true) out.set(2, notRun(2, 'github.com could not be reached from outside the sandbox either, so a refused curl inside it shows nothing. Check the Mini\'s network, then run this again'));
    else {
      const s2 = await launchOne(variant(c, product, { install: walledInstall(c.home) }), 'walled');
      const b4 = four(s2);
      const code = Number(/the install exited (\d+)/.exec(b4?.reason ?? '')?.[1]);
      out.set(2, !b4 ? noFour(2, s2) : io.exists(x) ? fail(2, `the install wrote ${x}, outside the copy`)
        : b4.ok ? fail(2, 'the install reached github.com: check 4 passed')
          : !CURL_UNREACHED.includes(code) ? fail(2, `check 4 refused, but not with curl's could-not-reach exit code (${CURL_UNREACHED.join(', ')}): ${b4.reason}`)
            : pass(2, { reason: b4.reason }));
    }

    // Step 5: an install that runs past a short lockedMs. A sleeper already there (an earlier run's) would be taken for
    // this one's, so the step is not tried (review m4). The pass needs the job's own process group (the install's shell,
    // as runLocked kept it from its record, #463 r2 M1) to have been seen, apart from claude's, and both groups gone: an
    // install that never started its job can't pass (review M3).
    const already = io.sleepers();
    if (already === null || already.length) out.set(5, notRun(5, already === null ? `whether ${SLOW_INSTALL} already runs can't be told` : `${SLOW_INSTALL} already runs (${already.join(', ')}), left by an earlier run; it ends by itself within 20 minutes. Run this again then`));
    else {
      const s5 = await launchOne(variant(c, product, { install: SLOW_INSTALL, lockedMs: SHORT_LOCKED_MS }), 'slow');
      const c4 = four(s5); const run5 = s5.rec.runs.filter((r) => r.job === 'install').at(-1);
      const g5 = s5.rec.groups.filter((g) => g.name === 'install' && g.group?.job).at(-1)?.group;
      const jobPg = g5?.job?.pgid;
      const gone = async (pg) => { let l = Number.isInteger(pg) ? io.groupListed(pg) : null; for (let w = 0; l === true && w < 2_000; w += 200) { await io.sleep(200); l = io.groupListed(pg); } return l; };
      const listed = run5 ? await gone(run5.pid) : null;
      const jobListed = await gone(jobPg);
      const left = io.sleepers();
      s5.sleepers = left;
      out.set(5, !c4 ? noFour(5, s5) : c4.ok ? fail(5, `check 4 passed an install that sleeps 20 minutes (${SLOW_INSTALL})`)
        : !/did not finish inside the lock-down \(it did not finish in time\)/.test(c4.reason ?? '') ? fail(5, `check 4 refused, but not for the time limit: ${c4.reason}`)
          : !Number.isInteger(jobPg) ? fail(5, 'the install\'s own process group was never recorded, so the job may never have started; a stop with nothing to stop proves nothing')
            : jobPg === g5.pgid ? fail(5, `the job's process group (${jobPg}) is claude's own, not one of its own`)
              : listed === null ? fail(5, `whether claude's group (${run5?.pid}) is gone can't be told`) : listed ? fail(5, `ps -g ${run5.pid} still lists processes of claude's group`)
                : jobListed === null ? fail(5, `whether the job's group (${jobPg}) is gone can't be told`) : jobListed ? fail(5, `ps -g ${jobPg} still lists processes of the job's own group`)
                  : left === null ? fail(5, `whether ${SLOW_INSTALL} still runs can't be told`) : left.length ? fail(5, `${SLOW_INSTALL} still runs (${left.join(', ')}): the install was not stopped with claude. Left running, not killed; each ends by itself within 20 minutes`)
                    : pass(5, { reason: c4.reason, claudeGroup: run5.pid, jobGroup: jobPg,
                      limit: 'the job\'s group was recorded; that the sleep itself began is not shown (a record read in the last poll before the limit gets no go-ahead)' }));
    }

    // Step 8: an install's leftover, looked at once the session has started (a known limit, never a fail). NOT SEEN counts
    // only when the install's own session was made (`started`); otherwise the step was not tried.
    const s8 = await launchOne(variant(c, product, { install: LEFTOVER_INSTALL }), 'leftover');
    if (s8.r?.ok !== true) { const at = blockedBy(s8.r?.reason); out.set(8, notRun(8, at ? blockedWhy(at, s8.r.reason, 'the session did not start') : `the session did not start (${s8.r?.reason ?? 'no answer'})`)); }
    else {
      await io.sleep(LEFTOVER_WAIT_MS);
      const seen = io.exists(join(s8.r.copy, 'leftover'));
      const began = io.exists(join(s8.r.copy, 'started'));
      out.set(8, seen ? { step: 8, result: 'SEEN', why: 'a process the install moved into its own session outlived check 4 and wrote in the copy: a known limit, to tell the Lead', found: {} }
        : began ? { step: 8, result: 'NOT SEEN', why: 'the install\'s own session began, and nothing was left in the copy', found: {} }
          : notRun(8, 'the install could not move a process into its own session (no `started` file), so the leftover was not tried'));
    }
  } finally {
    // Each throwaway's group, folders and settings file go, whatever happened (startPort removes those of a start it undid).
    // A group that could not be stopped keeps its folders and settings, and is named (review m1): never removed from
    // under a claude still running.
    for (const s of sessions) {
      const files = { copy: s.r?.copy ?? s.copy, outbox: s.r?.outbox ?? s.outbox, settingsFile: join(c.settingsDir, `${s.sessionId}.json`),
        saveSettingsFile: join(c.settingsDir, saveSettingsName(s.sessionId)) };
      if (s.r?.ok === true || s.r?.running === true) {
        // A start still running answers no leader start time, and a group is never stopped without one (it might be
        // another's by now): named and left, its files with it (r2 review m3).
        const st = !Number.isInteger(s.r.pgid) ? { ok: false, reason: 'its process group is not known' }
          : typeof s.r.pidStart !== 'string' ? { ok: false, reason: 'its leader\'s start time is not known, so it can\'t be stopped safely' } : await stop(s.r);
        if (st?.ok !== true) { io.warn(`claude's group ${s.r.pgid ?? '(not known)'} for session ${s.sessionId} could not be stopped (${st?.reason ?? 'no answer'}); it may still run. Left in place: ${Object.values(files).join(', ')}. Stop it (ps -g ${s.r.pgid ?? '<pgid>'}), then remove them`); continue; }
      }
      io.cleanup({ ...files, settingsDir: c.settingsDir, sessionId: s.sessionId, sleepers: s.sleepers ?? [] });
    }
  }
  return STEPS.map(([n]) => out.get(n) ?? notRun(n, 'not reached'));
}

/**
 * The plain lines, and whether the proof passed: 1 to 7 PASS and 8 looked at. NOT RUN is never a pass, and a run some
 * launch check blocked says which in its last line (main exits 1 whenever ok is false, L989).
 */
export function report(results) {
  const lines = results.map((r) => `${r.result.padEnd(8)} ${r.step}. ${TITLE[r.step]}${r.why ? ` — ${r.why}` : ''}`);
  const ok = results.length === STEPS.length && results.every((r) => (r.step === 8 ? ['SEEN', 'NOT SEEN'].includes(r.result) : r.result === 'PASS'));
  const at = [...new Set(results.map((r) => /^blocked at (launch check \d+), not by runLocked/.exec(r.why ?? '')?.[1]).filter(Boolean))];
  const last = ok ? 'runLocked proof: PASS' : `runLocked proof: NOT PASSED${at.length ? ` (blocked at ${at.join(' and ')}, not by runLocked: not done)` : ''}`;
  return { ok, text: `${lines.join('\n')}\n${last}\n` };
}

const recordingSpawn = (rec, dir) => (bin, args, opts) => {
  const file = join(dir, `run-${rec.runs.length + 1}.jsonl`);
  const fd = openSync(file, 'w', 0o600);
  try {
    // Which job this is, and the settings claude is started with, read as it starts (step 1: the install's own settings).
    const job = /\.orch-job-(install|save-work)-/.exec(String(args.at(-1) ?? ''))?.[1] ?? null;
    const at = args.indexOf('--settings');
    let settingsText = null; try { settingsText = at >= 0 ? readFileSync(args[at + 1], 'utf8') : null; } catch { settingsText = null; }
    const child = childSpawn(bin, args, { ...opts, stdio: ['ignore', fd, 'ignore'] });
    rec.runs.push({ pid: child.pid, out: file, job, settingsText });
    return child;
  } finally { closeSync(fd); }
};

/** runLocked with every process group it keeps recorded in rec.groups as { name: the job, group }, the job's own too
 * (step 5, review M3); a caller's own onGroup is still told. A runLocked that is not a function is handed back. */
export const recordGroups = (base, rec) => (typeof base !== 'function' ? base : (o = {}) => base({ ...o, onGroup: (g) => {
  rec.groups.push({ name: o.job, group: g });
  if (typeof o.onGroup === 'function') o.onGroup(g);
} }));

/** The runner's own builders, as realRunnerPorts builds them, plus this proof's two inputs (see the top). `budget` and
 * `bobManifest` are launch checks 12 and 13's inputs, loaded by the runner's own launchInputs (L1092): a null one leaves
 * its check without a port, as in the runner, and the steps it stops read NOT RUN (blockedBy). */
export function realWiring(dir, log, { budget = null, bobManifest = null } = {}) {
  return (cfg, rec) => {
    const runLocked = recordGroups(lockedOf(cfg, { make: (o) => lockedRunner({ ...o, spawn: recordingSpawn(rec, dir) }) }), rec);
    const locked = lockedWiring(cfg, { runLocked, log, budget, bobManifest });
    const inner = locked.startDeps.checksFor;
    const checksFor = (x) => {
      const k = inner(x);
      return Object.fromEntries(Object.entries(k).map(([n, f]) => [n, typeof f !== 'function' ? f : async (...a) => {
        let ans; try { ans = await f(...a); } catch (e) { ans = { ok: false, reason: e?.message ?? String(e) }; }
        rec.answers[n] = ans;
        if (Number(n) === 4) { try { rec.settingsText = readFileSync(x.settings.file, 'utf8'); } catch { rec.settingsText = null; } }
        return ans;
      }]));
    };
    const readCard = (card) => ({ ok: true, doc: { state: 'claimed', claim: { session_id: rec.sessionId }, product: rec.product, tier: 2, id: card } });
    const start = startPort(cfg, { ...locked.startDeps, checksFor, readCard, promptFor: () => PROOF_PROMPT });
    return { start: (req) => { rec.sessionId = req.sessionId; rec.product = req.product; return start(req); }, saveWork: locked.saveWork, checksFor };
  };
}

function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }
const arg = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

/**
 * What the proof leaves behind, removed (#463 harness): the copy and outbox, and every settings file of the proof's own session
 * (`<id>.json`, `<id>.save.json`, `<id>..baseline.json`): a `.json` left in the settings folder stops the real runner from
 * starting. Nothing else in the folder is touched. Sleepers are named, never killed (L1013).
 */
export function cleanupProof({ copy, outbox, settingsFile, saveSettingsFile, settingsDir, sessionId, sleepers = [] }, log) {
  // Never killed: they are found by their command line, not by a pid this proof started (L1013). Step 5 has failed
  // and named them; each ends by itself within SLOW_INSTALL's 20 minutes.
  if (sleepers.length) log(`left running, not killed (found by command line, not started here): ${sleepers.join(', ')}`);
  const fs = { rm: rmSync, chmodTree };
  for (const d of [copy, outbox]) if (d) removeAll(fs, d, log);
  // Every settings file of the proof's own session (its id is the proof's, made by io.id): the session's, the save's,
  // and the baseline's `<id>..baseline.json` if check 11 left it (r2 review m4). A `.json` left would stop the real runner.
  let own = []; try { own = readdirSync(settingsDir).filter((n) => n.startsWith(`${sessionId}.`) && n.endsWith('.json')).map((n) => join(settingsDir, n)); } catch (e) { log(`the settings folder ${settingsDir} can't be listed (${e?.code ?? e?.message})`); }
  for (const f of new Set([settingsFile, saveSettingsFile, ...own])) if (f) { try { rmSync(f, { force: true }); } catch (e) { log(`the proof's settings file ${f} can't be removed (${e?.code ?? e?.message})`); } }
}

/** Launch checks 12 and 13's inputs for the proof, by the runner's own launchInputs (L1092). Files not root's alone, or a
 * loader that throws → { problem } (no step runs). Otherwise → { budget, bobManifest, said }: a null one (not in the
 * config, or not loadable, which `said` tells) leaves its check without a port, so the steps it stops read NOT RUN. */
export async function proofInputs(c, inputsOf = launchInputs) {
  const said = [];
  let r; try { r = await inputsOf(c, { log: (t) => said.push(t) }); } catch (e) { return { problem: `the worker runner would not start: ${e?.message ?? e}` }; }
  if (!r || r.problem) return { problem: `the worker runner would not start: ${r?.problem ?? 'its launch checks 12 and 13 inputs gave no answer'}` };
  return { budget: r.budget ?? null, bobManifest: r.bobManifest ?? null, said };
}

/**
 * The proof's run with the worker runner's lock held (L1121 m4): everything from the run folder on is inside one
 * try/finally, so the lock is released whatever throws (the folder, the group ports, the proof). `run(dir, log)` → the
 * steps. A throw anywhere makes every step NOT RUN with why. `inputs.said` is printed and logged first.
 * → { results, dir } (dir null when the folder could not be made).
 */
export async function underLock({ lock, held, inputs, run, print = () => {}, mkTemp = () => mkdtempSync(join(tmpdir(), 'runlocked-proof-')) }) {
  let dir = null;
  try {
    dir = mkTemp();
    const log = (t) => appendFileSync(join(dir, 'runner.log'), `${new Date().toISOString()} ${t}\n`);
    for (const t of inputs?.said ?? []) { log(t); print(`${t}\n`); }
    return { results: await run(dir, log), dir };
  } catch (e) {
    return { results: STEPS.map(([k]) => notRun(k, `the proof stopped: ${e?.message ?? e}`)), dir };
  } finally { try { lock.release(held.nonce); } catch { /* gone */ } }
}

export async function main(argv, { print = (t) => process.stdout.write(t), uid = process.getuid?.(), now = () => Date.now(), platform = process.platform, inputsOf = launchInputs } = {}) {
  const fails = (why) => { print(report(STEPS.map(([n]) => notRun(n, why))).text); return 1; };
  // macOS only (L1005): ps -g, pgrep and perl's setsid are read as the Mini's; anywhere else, a named skip, never a run.
  if (platform !== 'darwin') return fails(`SKIP: this proof runs on macOS only (the Mini), not on ${platform}`);
  let c; try { c = checkRunnerConfig(readRunnerConfig(arg(argv, '--config'), selfPath())); } catch (e) { return fails(`the worker runner's config can't be read (${e?.message ?? e})`); }
  const product = arg(argv, '--product');
  let ownDirUid; try { const st = lstatSync(c.ownDir); ownDirUid = st.isDirectory() && !st.isSymbolicLink() ? st.uid : null; } catch { ownDirUid = null; }
  let claudeVersion = null; try { claudeVersion = /^(\d+\.\d+\.\d+)/.exec(execFileSync(c.claudeBin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim())?.[1] ?? null; } catch { /* not readable */ }
  const bad = guardProblem({ c, product, uid, ownDirUid, claudeVersion });
  if (bad) return fails(bad);
  // Launch checks 12 and 13's inputs, loaded as the runner loads them (L1092): files not root's alone stop the proof, as
  // they stop the runner; one that can't be loaded is said, and its check then refuses the launch (NOT RUN, blockedBy).
  const inputs = await proofInputs(c, inputsOf);
  if (inputs.problem) return fails(inputs.problem);
  // A session the runner started may outlive it; the proof's starts check no other product's walls against it (live: []).
  let m; try { m = loadMemory(c.memoryFile, { uid }); } catch (e) { return fails(`the worker runner's memory can't be read (${e?.message ?? e})`); }
  const live = (Array.isArray(m?.sessions) ? m.sessions : []).filter((s) => s?.alive === true || (s?.alive !== false && s?.ended !== true));
  if (live.length) return fails(`the worker runner's memory lists ${live.length} session${live.length === 1 ? '' : 's'} that may still run (${live.slice(0, 3).map((s) => s.id).join(', ')}). Run this once none does`);
  const lock = makeLock({ dir: c.ownDir, timeoutMs: 2_000 }); let held;
  try { held = lock.acquire(); } catch (e) { return fails(/busy/.test(e?.message ?? '') ? 'the worker runner is running. Stop it first, then run this again' : `the worker runner's lock can't be taken (${e?.message ?? e})`); }
  const { results, dir } = await underLock({ lock, held, inputs, run: async (d, log) => {
    let n = 0; const tag = now().toString(36);
    const { stopGroup } = processGroupPorts();
    const io = {
      wiring: realWiring(d, log, { budget: inputs.budget, bobManifest: inputs.bobManifest }), stopGroup,
      // ps answers exit 1 with nothing for an empty group, and also for a bad argument, which it says on stderr: only the first is "gone".
      groupListed: (pid) => {
        if (!Number.isInteger(pid) || pid <= 1) return null;
        const r = spawnSync('/bin/ps', ['-g', String(pid), '-o', 'pid='], { encoding: 'utf8', env: { ...process.env, COMMAND_MODE: 'unix2003' } });
        return r.status === 0 && r.stdout.trim() !== '' ? true : r.status === 1 && r.stdout.trim() === '' && !String(r.stderr ?? '').trim() ? false : null;
      },
      sleepers: () => {
        const r = spawnSync('/usr/bin/pgrep', ['-u', String(uid), '-fx', SLOW_INSTALL], { encoding: 'utf8' });
        return r.status === 0 ? r.stdout.trim().split('\n').map(Number).filter(Number.isInteger) : r.status === 1 ? [] : null;
      },
      verifyBundle: (mirror, file) => { const r = spawnSync('/usr/bin/git', ['--git-dir', mirror, 'bundle', 'verify', file], { encoding: 'utf8', timeout: 120_000 }); return r.status === 0 ? null : (r.stderr || `exit ${r.status}`).trim().slice(0, 300); },
      exists: (p) => existsSync(p), read: (p) => readFileSync(p, 'utf8'),
      write: (p, text, mode) => { writeFileSync(p, text); if (mode !== undefined) chmodSync(p, mode); }, mkdir: (p) => mkdirSync(p, { recursive: true }),
      sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }), now,
      id: (prefix) => `${prefix}-${tag}-${(n += 1)}`,
      reachable: () => spawnSync('/usr/bin/curl', ['-sS', '--max-time', '20', '-o', '/dev/null', 'https://github.com'], { timeout: 30_000 }).status === 0,
      warn: (t) => { print(`${t}\n`); log(t); },
      rm: (p) => rmSync(p, { force: true }),
      cleanup: (x) => cleanupProof(x, log),
    };
    return proveRunLocked({ c, product, io });
  }, print });
  const r = report(results);
  print(r.text);
  print('Claude Code keeps its own transcripts of the proof\'s sessions in the workers\' home (<its config folder>/projects/); they are left there.\n');
  const evidence = join(homedir(), `runlocked-proof-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.jsonl`);
  try { writeFileSync(evidence, `${[{ pin: c.pin, product, at: new Date(now()).toISOString(), runs: dir }, ...results].map((x) => JSON.stringify(x)).join('\n')}\n`, { mode: 0o600 }); print(`Written to ${evidence}\n`); } catch (e) { print(`The record of this run could not be written (${e?.code ?? e?.message})\n`); }
  return r.ok ? 0 : 1;
}

const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (invoked && invoked === selfPath()) process.exitCode = await main(process.argv.slice(2));
