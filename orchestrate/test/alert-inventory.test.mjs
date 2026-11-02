// alert-inventory.test.mjs — lead call L135: every alert-like call in production code is on one list, and each has a
// status a person gave it. (L130's rule stands: an alert's answer is never ignored before something that says it went
// out. L135 changes how that is checked: a scan that guesses "is this answer ignored?" cannot be the gate.)
//
// The list is alert-inventory.json (lead-owned). alert-inventory.mjs finds the calls; `node orchestrate/test/alert-inventory.mjs`
// prints what the list is missing, with the scanner's hints (alert-answer-scan.mjs) and a suggested status.
//
// Each alerts entry is pinned by file + function + a short hash of the call's line + a short hash of its whole
// function (comments left out). The pins are compared with ===, as a multiset. A changed line or function shows up as
// an entry gone and a new one, so any edit near an alert gets a fresh look before the list is re-pinned.
//
// Each entry has exactly one status (L170):
//   ruled: L<n>, <why>                       a lead call says this one is fine, on the code as it is now. L<n> must be
//                                           an entry in LEAD-CALLS.md (read by path where it exists) and on the
//                                           lead-owned LEAD_CALL_NUMBERS (what CI, with no Dropbox, checks)
//   open: <lane n|lead>, <#PR|none yet|L<n> follow-up>   still to fix; the gate passes only with none open
// L170 removed "tested" (a run-time proof through fakeAlert's flips and stack frames) and "wrapped" (a call through a
// wrapper proven by assertWrapperContract). The r4 audit beat both eight ways, three on the real path, so neither may
// pass an entry: the single-door alert API is what closes the open ones.
//
// The other lists, same file: wrappers (a function named like an alert that calls one), silent (a production alert
// port that may answer nothing, a fixed "sent", or never: found where a port is handed in, and passed only when it is
// a plain arrow that answers false or throws, L170) and standins (a test alert made from anything but fakeAlert()).
// Silent and standins entries are pinned by file + the hash of their line's text, as a multiset.
//
// A wrapper is ruled or open, like an entry (L170: "passes" is gone). A ruled wrapper pins its body ("body"), so a
// change to it fails until the lead rules it again; `rethrows` ("L<n>: <why>") names the lead call that says a throw
// is handed back as that throw. What the scanner reads in a wrapper is advice only: it is printed, never a pass. A
// wrapper the scanner cannot see (not named like an alert) is listed with `by_lead: true`.
//
// Change control (L135 item 4, L139 item 6, L143 Minor 1): in a PR that is not the lead's (branch lead-* or
// claude/lead-*), the checker's own files (LEAD_FILES, the list among them) may not change at all, and the list is
// also compared entry by entry with the merge-base: a lane may only re-pin an open alerts entry. A list
// missing at the merge-base fails a lane PR (L143 Minor 3). On a lead branch too, a ruled entry whose code changed
// fails until it is set open or ruled again (L155 m4). The branch is GITHUB_HEAD_REF, else git's; a detached checkout
// reads ORCH_BRANCH and fails without it (L155 m6). The branch name is an early warning, not the guard: safe-merge's
// LEAD_OK is (L143). The test always prints what changed.
//
// What this cannot see (a reviewer still reads for these):
//   - a method on an object a factory hands back (`store.read(` where `read` holds an alert): only plain calls,
//     `this.x(`, `ns.x(` of `import * as ns`, and imported or re-exported names are followed;
//   - a dynamic import, `require`, or a function passed around in a data structure and called from there;
//   - an alert port handed on inside an object (`step({ rec, send: alert })`) under a name that is not alert-like;
//   - a stand-in passed by position, or built by a helper the test file imports;
//   - whether a ruled "retried next pass" stays true: the ruling is re-checked only when its pins change;
//   - whether a lead call says what the ruling claims: only that the call exists is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  inventory, orchestrateFiles, readList, compare, keyOf, short, parseStatus, hintsFor, countList, changeControl,
  LEAD_BRANCH, LIST, fnBody, leadFilesIn, LEAD_FILES, isTestCode, isTestPath, answerFlow, branchName,
  readLeadCalls, leadCallsIn, leadCallProblem, citedCalls, LEAD_CALL_NUMBERS,
} from './alert-inventory.mjs';
import { wrappers, standIns, losingStandIns, silentDefaults } from './alert-answer-scan.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';
import { outbox, ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { holdAlert, HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { recWith, T0 } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));   // orchestrate/
const HELPER = 'test/fake-alert.test-helper.mjs';
const FILES = orchestrateFiles(ROOT);
const PROD = FILES.filter((f) => !f.testCode);
const TESTS = FILES.filter((f) => f.testCode && f.rel !== HELPER);
const LISTED = readList(ROOT);
const squash = (t) => t.replace(/\s+/g, ' ').trim();
const readSrc = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; } };
const CLI = 'run `node orchestrate/test/alert-inventory.mjs` for the pins and a suggested status';

// ---- 1. the pins ----

test('every alert-like call in production code is on the list, pinned exactly, and the list holds nothing else (L135)', () => {
  const { fresh, gone, moved } = compare(inventory(PROD), LISTED.alerts);
  const was = new Map(moved.map(([e, g]) => [e, g]));
  const back = new Set(moved.map(([, g]) => g));
  const hints = new Map(PROD.map((f) => [f.rel, hintsFor(f.src)]));
  const bad = [];
  for (const e of fresh) {
    const g = was.get(e);
    const h = hints.get(e.file)?.get(e.line);
    bad.push(`${g ? 'changed' : 'new'}: ${e.file}:${e.line} ${e.fn} ${e.call}${e.via ? ` (via ${e.via})` : ''}: ${e.text.slice(0, 120)}`
      + `${g ? `\n  it was "${g.status}": the code there changed, so look again before re-pinning it` : '\n  add it with a status'}`
      + `${h ? `\n  scanner (${h.level}): ${h.why}` : ''}`);
  }
  for (const g of gone) if (!back.has(g)) bad.push(`gone: ${g.file} ${g.fn} ${g.call} (${g.status}) is on the list but not in the code: ${g.text.slice(0, 120)}`);
  assert.deepEqual(bad, [], `${bad.length} difference(s); ${CLI}`);
});

test('every list entry is well formed: its text matches its hash, and its status parses (L135, L170)', () => {
  const bad = [];
  for (const k of ['alerts', 'silent', 'standins']) for (const e of LISTED[k]) {
    if (short(squash(e.text)) !== e.hash) bad.push(`${k}: ${e.file} ${e.fn ?? ''}: the text does not match its hash`);
    if (parseStatus(e.status).kind === 'bad') bad.push(`${k}: ${e.file} ${e.fn ?? ''}: ${parseStatus(e.status).why}: ${e.status}`);
  }
  for (const w of LISTED.wrappers) {
    if (parseStatus(w.status).kind === 'bad') bad.push(`wrappers: ${w.file} ${w.fn}: ${parseStatus(w.status).why}: ${w.status}`);
    for (const k of ['contract_test', 'covers', 'inner', 'answer_unused']) if (k in w) bad.push(`wrappers: ${w.file} ${w.fn}: "${k}" belonged to the wrapper proof L170 removed; take it off`);
  }
  assert.deepEqual(bad, []);
});

// ---- 2. the other lists ----

test('every alert wrapper is on the list, and a ruled one is pinned to its body as it is now (L130, L135, L170)', () => {
  const found = new Map();
  for (const f of PROD) for (const w of wrappers(f.src)) found.set(`${f.rel} ${w.fn}`, { ...w, file: f.rel });
  const bad = [];
  const advice = [];   // L155 item 1: what the scanner reads in a wrapper is printed, never a pass or a failure
  const listed = new Map(LISTED.wrappers.filter((e) => !e.by_lead).map((e) => [`${e.file} ${e.fn}`, e]));
  for (const e of LISTED.wrappers) {
    const code = readSrc(e.file);
    const now = code === null ? null : fnBody(code, e.fn);
    if (e.by_lead && now === null) bad.push(`stale: ${e.file} ${e.fn} (listed by the lead) is no longer there`);
    // L170: a ruling is made on the wrapper as it was, like an entry's (L155 m4): a ruled wrapper pins its body.
    if (parseStatus(e.status).kind === 'ruled') {
      if (!e.body) bad.push(`${e.file} ${e.fn} is ruled, so it pins its body ("body": "${now}")`);
      else if (now !== e.body) bad.push(`${e.file} ${e.fn} changed since it was ruled (body ${now}, list ${e.body}); set it open, or rule it again on the code as it is`);
    }
  }
  for (const [k, w] of found) {
    const e = listed.get(k);
    if (!e) bad.push(`new wrapper ${w.file}:${w.line} ${w.fn}: ${w.passes ? 'it reads as handing back the answer; the lead lists it, ruled or open' : `it loses the answer (${w.why}): return the inner call's answer, or test it === false / !== false`}`);
    else if (parseStatus(e.status).kind === 'ruled' && !w.passes) advice.push(`${w.file}:${w.line} ${w.fn} is ruled; the scanner reads it as losing the answer (${w.why})`);
  }
  for (const [k, e] of listed) if (!found.has(k) && !e.lands_with) bad.push(`stale: ${k} is no longer a wrapper here; remove it from the list`);
  if (advice.length) console.log(`the wrapper scanner's advice (L155: advice only):\n  ${advice.join('\n  ')}`);
  assert.deepEqual(bad, []);
});

// L170 item 3 (the r4 Minor: rethrows was checked by format only): every lead call the list cites is a real one.
const LEAD_CALLS = readLeadCalls();
test('every lead call the list cites (a ruling, a follow-up, a rethrows note) is an entry in LEAD-CALLS.md and on LEAD_CALL_NUMBERS (L170)', () => {
  const bad = [];
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) for (const e of LISTED[k]) for (const { ref, where } of citedCalls(e)) {
    const why = leadCallProblem(ref, { calls: LEAD_CALLS });
    if (why) bad.push(`${k}: ${e.file} ${e.fn ?? ''} ${e.call ?? ''}: ${where}: ${why}`);
  }
  // The lead-owned list itself: where LEAD-CALLS.md is readable, every number on it is an entry there.
  if (LEAD_CALLS) for (const n of LEAD_CALL_NUMBERS) if (!LEAD_CALLS.has(n)) bad.push(`LEAD_CALL_NUMBERS holds L${n}, which is not an entry in LEAD-CALLS.md`);
  console.log(`lead calls: ${LEAD_CALLS ? `LEAD-CALLS.md read (${LEAD_CALLS.size} entries)` : 'LEAD-CALLS.md is not here (CI): checked against LEAD_CALL_NUMBERS only'}`);
  assert.deepEqual(bad, []);
});

const multiset = (name, found, listed, how) => {
  const left = new Map();
  for (const e of listed) { const k = `${e.file} ${e.hash}`; left.set(k, (left.get(k) ?? 0) + 1); }
  const bad = [];
  for (const e of found) {
    const k = `${e.file} ${e.hash}`;
    if (left.get(k)) left.set(k, left.get(k) - 1);
    else bad.push(`new ${name}: ${e.file}:${e.line}: ${e.text.slice(0, 120)}\n  ${how}`);
  }
  for (const [k, n] of left) if (n > 0) bad.push(`gone ${name}: ${k} (${n} on the list not in the code); remove it from the list`);
  return bad;
};

test('no production alert answers nothing (a silent default), beyond the list (L135 item 6)', () => {
  const found = PROD.flatMap((f) => silentDefaults(f.src).map((x) => ({ file: f.rel, line: x.line, text: x.text, hash: short(squash(x.text)) })));
  assert.deepEqual(multiset('silent default', found, LISTED.silent, 'an alert that answers nothing counts as sent under !== false: make the alert required, or default to one that answers false'), []);
});

test('every test alert stand-in is fakeAlert(), beyond the list (L130, L135 item 6)', () => {
  const found = TESTS.flatMap((f) => standIns(f.src).map((x) => ({ file: f.rel, line: x.line, text: x.text, hash: short(squash(x.text)) })));
  assert.deepEqual(multiset('stand-in', found, LISTED.standins, 'use fakeAlert() from orchestrate/test/fake-alert.test-helper.mjs'), []);
  const losing = TESTS.flatMap((f) => losingStandIns(f.src).map((l) => `${f.rel}:${l}`));
  if (losing.length) console.log(`stand-ins that already answer false or throw (fine; fakeAlert({ answer: false }) says it plainer): ${losing.join(', ')}`);
});

// ---- 3. the gate ----

const counts = countList(LISTED);
const openN = ['alerts', 'wrappers', 'silent', 'standins'].reduce((a, k) => a + (counts[k].open ?? 0), 0);
test('the gate: nothing is open before the first cutover (L135)', {
  todo: openN ? `${openN} open until the first cutover; by owner: ${Object.entries(counts.open_by_owner).map(([k, n]) => `${k} ${n}`).join(', ')}` : false,
}, () => {
  const open = ['alerts', 'wrappers', 'silent', 'standins'].flatMap((k) => LISTED[k].filter((e) => parseStatus(e.status).kind === 'open').map((e) => `${k}: ${e.file} ${e.fn ?? ''} ${e.status}`));
  assert.equal(open.length, 0, `${open.length} open, the first: ${open.slice(0, 5).join('; ')}`);
});

// ---- 4. change control ----

function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
test('the list and the checker change only in a lead PR: entry by entry, a lane may only re-pin an open entry, and no checker file changes (L135 item 4, L139 item 6, L143 Minor 1)', (t) => {
  let base; let branch; let changed = [];
  try {
    try { branch = branchName(process.env, git); } catch (e) { assert.fail(e.message); }   // L155 m6: never guessed
    const to = process.env.GITHUB_BASE_REF || 'main';
    const ref = [`origin/${to}`, to].find((r) => { try { git(['rev-parse', '--verify', '--quiet', r]); return true; } catch { return false; } });
    if (!ref) return t.skip(`no ${to} branch to compare with`);
    const mb = git(['merge-base', 'HEAD', ref]);
    changed = git(['diff', '--name-only', mb, 'HEAD']).split('\n').filter(Boolean);
    try { base = JSON.parse(git(['show', `${mb}:orchestrate/${LIST}`])); } catch { base = null; }
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; return t.skip(`no git history here: ${e.message.split('\n')[0]}`); }
  const lead = LEAD_BRANCH.test(branch);
  const mine = leadFilesIn(changed);
  if (mine.length) console.log(`the checker's own files changed on ${branch}${lead ? ' (a lead branch)' : ''}: ${mine.join(', ')}`);
  if (!lead) assert.deepEqual(mine, [], `only a lead PR changes the alert checker's files (L139 item 6): ${LEAD_FILES.join(', ')}`);
  if (!base) {
    // L143 Minor 3: a lane PR with a list the merge-base does not have is a lane writing the list; only the lead may.
    assert.ok(lead, `orchestrate/${LIST} is not on the merge-base: only a lead PR adds the list`);
    return t.skip('the list is new since the merge-base (a lead PR)');
  }
  const { problems, would, summary } = changeControl(base, LISTED, { lead });
  console.log(`alert list against the merge-base (branch ${branch}${lead ? ', a lead branch' : ''}):\n  ${summary.join('\n  ')}${would.length ? `\n  needs the lead:\n  ${would.join('\n  ')}` : ''}`);
  assert.deepEqual(problems, []);
});

test('controls: change control stops a lane ruling, adding a wrapper or growing open, and lets the lead', () => {
  const e = (status, hash = 'aaaaaaaa') => ({ file: 'f.mjs', fn: 'g', call: 'alert', hash, body: 'bbbbbbbb', text: 'x', status });
  const base = { alerts: [e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'cccccccc')], wrappers: [], silent: [], standins: [] };
  const lane = (head) => changeControl(base, { wrappers: [], silent: [], standins: [], ...head }, { lead: false }).problems.length;
  assert.equal(lane({ alerts: [e('ruled: L135, the lane says so'), e('ruled: L135, retried next pass', 'cccccccc')] }), 1, 'an open entry ruled');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'dddddddd')] }), 2, 'a ruled entry re-pinned (and, L155 m4, still ruled)');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'cccccccc'), e('open: lane 1, none yet', 'eeeeeeee')] }), 1, 'one more open');
  assert.equal(lane({ alerts: base.alerts, wrappers: [{ file: 'f.mjs', fn: 'safeX', status: 'ruled: L170, it hands back the answer' }] }), 1, 'a new wrapper');
  assert.equal(lane({ alerts: base.alerts, standins: [{ file: 't.test.mjs', hash: 'x', text: 'x', status: 'open: lane 1, none yet' }] }), 1, 'a new stand-in');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet', 'ffffffff'), base.alerts[1]] }), 0, 'an open entry re-pinned');
  assert.equal(lane({ alerts: [...base.alerts, e('open: lane 1, none yet', 'eeeeeeee')].slice(0, 2) }), 0, 'nothing changed');
  // L143 Minor 1: entry by entry, not net counts.
  assert.equal(lane({ alerts: [e('ruled: L170, the lane says it is fine'), base.alerts[1]] }), 1, 'an open entry ruled by a lane');
  assert.equal(lane({ alerts: [base.alerts[1]] }), 1, 'an entry removed');
  assert.equal(lane({ alerts: [e('open: lane 2, none yet'), base.alerts[1]] }), 1, 'an owner changed');
  assert.equal(lane({ alerts: [{ ...e('open: lane 1, none yet'), lands_with: '#9' }, base.alerts[1]] }), 1, 'lands_with added');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet', 'ffffffff'), base.alerts[1], e('ruled: L1, a new ruled entry', '99999999')] }), 1, 'a new entry that is not open');
  assert.equal(lane({ alerts: [base.alerts[1], e('open: lane 1, none yet', '11111111'), e('open: lane 1, none yet', '22222222')] }), 1, 'an open entry re-pinned and one added');
  assert.equal(lane({ alerts: [e('ruled: L170, the lane says it is fine', '33333333'), e('ruled: L135, retried next pass', 'cccccccc'), e('open: lane 1, none yet', '44444444')] }), 1,
    'net open unchanged, but one entry turned ruled');
  const wb = { ...base, wrappers: [{ file: 'f.mjs', fn: 'safeX', status: 'open: lane 1, none yet', body: 'aaaaaaaa' }] };
  const laneW = (wrappers) => changeControl(wb, { ...wb, wrappers }, { lead: false }).problems.length;
  assert.equal(laneW([{ ...wb.wrappers[0], status: 'ruled: L170, it hands back the answer' }]), 1, 'a wrapper status changed');
  assert.equal(laneW([{ ...wb.wrappers[0], body: 'bbbbbbbb' }]), 1, 'a wrapper re-pinned');
  assert.equal(laneW([]), 1, 'a wrapper removed');
  assert.equal(changeControl(base, { ...base, standins: [{ file: 't.test.mjs', hash: 'x', text: 'x', status: 'open: lead, none yet' }] }, { lead: false }).problems.length, 1, 'a new stand-in');
  assert.equal(changeControl(base, { alerts: [e('ruled: L999, the lead says so')], wrappers: [], silent: [], standins: [] }, { lead: true }).problems.length, 0, 'a lead PR');
  assert.ok(LEAD_BRANCH.test('lead-alert-sweep') && LEAD_BRANCH.test('claude/lead-x') && !LEAD_BRANCH.test('claude/orch-lane1-x') && !LEAD_BRANCH.test('orch-lane2-lead-x'));
  // L155 m4 (the auditor's N14): on a lead branch, a ruled entry whose code changed fails until it is open or ruled again.
  const leadOn = (alerts) => changeControl(base, { wrappers: [], silent: [], standins: [], alerts }, { lead: true }).problems;
  assert.equal(leadOn([e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'dddddddd')]).length, 1, 'a lead re-pin that keeps a ruling on changed code');
  assert.match(leadOn([e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'dddddddd')])[0], /code changed since the ruling/);
  assert.equal(leadOn([e('open: lane 1, none yet'), e('open: lead, none yet', 'dddddddd')]).length, 0, 'set open: fine');
  assert.equal(leadOn([e('open: lane 1, none yet'), e('ruled: L155, looked at again on the new code', 'dddddddd')]).length, 0, 'ruled again: fine');
  // L155 m3 (the auditor's R14, N12): a silent default or stand-in line swapped for another is a change, not a re-pin.
  const sil = (text, hash) => ({ file: 'g.mjs', hash, text, status: 'open: lane 1, none yet' });
  const sb = { alerts: [], wrappers: [], standins: [], silent: [sil('const alert = ctx.alert ?? (() => {});', '11111111')] };
  const swap = { ...sb, silent: [sil('const alert = ctx.alert ?? (() => true);', '22222222')] };
  assert.equal(changeControl(sb, swap, { lead: false }).problems.length, 1, 'a lane swaps one silent default for another');
  assert.match(changeControl(sb, swap, { lead: false }).problems[0], /pinned by its line's text/);
  assert.equal(changeControl(sb, swap, { lead: true }).problems.length, 0, 'the lead may');
  const stb = { alerts: [], wrappers: [], silent: [], standins: [{ ...sil('run({ alert: () => {} });', '33333333'), file: 't.test.mjs' }] };
  assert.equal(changeControl(stb, { ...stb, standins: [{ ...stb.standins[0], text: 'run({ alert: () => true });', hash: '44444444' }] }, { lead: false }).problems.length, 1, 'a stand-in swapped');
});

test('controls: the branch is GITHUB_HEAD_REF, then git; a detached checkout needs ORCH_BRANCH (L155 m6)', () => {
  const g = (b) => () => b;
  assert.equal(branchName({ GITHUB_HEAD_REF: 'claude/orch-lane1-x' }, g('lead-y')), 'claude/orch-lane1-x', 'a pull request in CI');
  assert.equal(branchName({}, g('lead-y')), 'lead-y', 'a checkout on a branch');
  assert.equal(branchName({ ORCH_BRANCH: 'lead-z' }, g('lead-y')), 'lead-y', 'git wins over ORCH_BRANCH when it has a name');
  assert.equal(branchName({ ORCH_BRANCH: 'claude/orch-lane2-x' }, g('HEAD')), 'claude/orch-lane2-x', 'detached: ORCH_BRANCH');
  assert.throws(() => branchName({}, g('HEAD')), /set ORCH_BRANCH/, 'detached with no ORCH_BRANCH: fail loudly, never guess');
  assert.throws(() => branchName({ ORCH_BRANCH: '' }, g('HEAD')), /set ORCH_BRANCH/, 'an empty ORCH_BRANCH is unset');
});

test('controls: a cited lead call must be an entry in LEAD-CALLS.md and on the lead-owned list; CI checks the list alone (L170 item 3)', () => {
  const md = '# calls\n| # | Date |\n|---|---|\n| L9 | x |\n## L57 — a call\n### L134 · a call\n- 2026-11-01 · **L170 (#93 r4): a call.**\n  - **L148 addendum**: more\n- 2026-11-01 · **#87 MERGED** (L142 recheck)\nsee L99 and **L98** in passing\n';
  const calls = leadCallsIn(md);
  assert.deepEqual([...calls].sort((a, b) => a - b), [9, 57, 134, 170], 'rows, headings and bold log starts; not a mention in passing');
  const allowed = [9, 57, 134, 170, 999];
  assert.equal(leadCallProblem('L170', { calls, allowed }), null, 'in the file and on the list');
  assert.match(leadCallProblem('L142', { calls, allowed: [...allowed, 142] }), /not an entry in LEAD-CALLS\.md/, 'mentioned, not an entry (the r4 Minor: any L-number passed)');
  assert.match(leadCallProblem('L999', { calls, allowed }), /not an entry in LEAD-CALLS\.md/, 'on the list, not in the file');
  assert.equal(leadCallProblem('L999', { calls: null, allowed }), null, 'CI (no file): the list alone');
  assert.match(leadCallProblem('L57', { calls: null, allowed: [170] }), /not on LEAD_CALL_NUMBERS/, 'CI: a number the lead has not listed');
  assert.match(leadCallProblem('L57', { calls, allowed: [170] }), /not on LEAD_CALL_NUMBERS/, 'here too, so a list that passes here passes in CI');
  for (const ref of ['because', 'L', 'L12345', '170', 'l170']) assert.match(leadCallProblem(ref, { calls: null, allowed }), /not a lead call number/, `format: ${ref}`);
  // What an entry cites.
  assert.deepEqual(citedCalls({ status: 'ruled: L135, retried next pass' }), [{ ref: 'L135', where: 'its ruling' }]);
  assert.deepEqual(citedCalls({ status: 'open: lane 3, L152 follow-up' }), [{ ref: 'L152', where: 'its follow-up' }]);
  assert.deepEqual(citedCalls({ status: 'open: lane 1, none yet' }), []);
  assert.deepEqual(citedCalls({ status: 'open: lane 1, none yet', rethrows: 'L139: a throw stops the pass first' }).map((x) => x.ref), ['L139']);
  assert.deepEqual(citedCalls({ status: 'open: lane 1, none yet', rethrows: 'because it does' }).map((x) => x.ref), ['because it does'], 'a rethrows note with no call is cited as it is, and refused');
  assert.deepEqual(leadFilesIn(['orchestrate/test/alert-inventory.json', 'orchestrate/test/alert-answer-scan.mjs', 'orchestrate/modules/M2-approvals/x.mjs', 'docs/test/alert-inventory.json']),
    ['orchestrate/test/alert-inventory.json', 'orchestrate/test/alert-answer-scan.mjs'], "the checker's own files");
  assert.equal(parseStatus('open: lane 3, L152 follow-up').kind, 'open', 'L153: an open entry may name the lead call it follows up');
  assert.equal(parseStatus('open: lane 3, someday').kind, 'bad');
});

// ---- 5. controls: the inventory finds every form ----

const calls = (src, rel = 'm.mjs') => inventory([{ rel, src }]).map((e) => `${e.fn} ${e.call}${e.via ? ' via' : ''}`);
test('controls: the inventory lists plain, member, optional, aliased, renamed and handed-on alert calls', () => {
  assert.deepEqual(calls('function a(ctx) { ctx.alert({ t: 1 }); }'), ['a alert'], 'ctx.alert(');
  assert.deepEqual(calls('function a(opts) { opts.alert?.({ t: 1 }); }'), ['a alert'], 'opts.alert?.(');
  assert.deepEqual(calls('function a(alert) { alert?.("x"); }'), ['a alert'], 'alert?.(');
  assert.deepEqual(calls('function a(ctx) { const tell = ctx.alert; tell("x"); }'), ['a tell'], 'a local alias');
  assert.deepEqual(calls('function a({ alert: tell }) { tell("x"); }'), ['a tell'], 'renamed in destructuring');
  assert.deepEqual(calls("import { say as tell } from './s.mjs';\nfunction a() { tell('x'); }"), ['a tell'], 'a renamed import');
  assert.deepEqual(calls('function a(p) { p.then(alert); }'), ['a alert'], '.then(alert)');
  assert.deepEqual(calls('function a(ctx, p) { p.catch(ctx.alert); }'), ['a alert'], '.catch(ctx.alert)');
  assert.deepEqual(calls('function a(ctx) { ctx.alert({ t: 1 }).then(() => {}); }'), ['a alert'], 'alert(...).then');
  assert.deepEqual(calls('function a(alerts) { alerts.raise({ key: 1 }); }'), ['a raise'], 'alerts.raise(');
  assert.deepEqual(calls('function a(rec) { holdAlert({ rec }); queueAlert(rec, "x"); }'), ['a holdAlert', 'a queueAlert'], 'a name with alert in it');
  assert.deepEqual(calls('function a(alert) { log(`${alert("x")}`); }'), ['a alert'], 'inside a template ${ }');
});
test('controls: the inventory lists a function one step out that holds an alert (via), and skips what is not a call', () => {
  assert.deepEqual(calls('function closeX(ctx) { if (bad) ctx.alert({ t: 1 }); }\nfunction run(ctx) { write(ctx); closeX(ctx); }'), ['closeX alert', 'run closeX via'], 'L133: a same-file carrier');
  // L143 M-1: a function that hands back an answer made from the alert's, in any form, passes it on: its callers are listed.
  for (const form of ['return ctx.alert({ t: 1 }) !== false;', 'const sent = ctx.alert({ t: 1 }); return sent;', 'return ctx.alert({ t: 1 }) || true;',
    'return ctx.alert({ t: 1 }) ? "sent" : "lost";', 'const r = ctx.alert({ t: 1 }); const ok = r !== false; return { ok };', 'if (ctx.alert({ t: 1 }) === false) return false; return true;']) {
    assert.deepEqual(calls(`function closeX(ctx) { ${form} }\nfunction run(ctx) { closeX(ctx); }`), ['closeX alert', 'run closeX via'], `passes the answer on: ${form}`);
  }
  // Handled: the answer feeds tellThen, or an if with no write after it, or an if that leaves the function.
  assert.deepEqual(calls('function closeX(ctx, rec) { if (ctx.alert({ t: 1 }) === false) return; rec.write({}); }\nfunction run(ctx) { closeX(ctx); }'), ['closeX alert'], 'an if that leaves before the write');
  assert.deepEqual(calls('function closeX(ctx, rec) { const s = ctx.alert({ t: 1 }); if (s) rec.write({}); }\nfunction run(ctx) { closeX(ctx); }'), ['closeX alert'], 'an if around the write');
  assert.deepEqual(calls('function closeX(ctx, rec) { const s = ctx.alert({ t: 1 }); if (s) log(1); rec.write({}); }\nfunction run(ctx) { closeX(ctx); }'), ['closeX alert', 'run closeX via'], 'a write after the if');
  // The auditor's r2 shapes (audit-pr93-r2 F1, F2, P05), and depth.
  const at = (fs) => inventory(fs).map((e) => `${e.file} ${e.fn} ${e.call}${e.via ? ` via ${e.via}` : ''}`);
  assert.ok(at([{ rel: 'm/s.mjs', src: "async function closeDecisionPr(ctx, id) {\n  const c = await gh(id);\n  if (c?.status !== 200) return ctx.alert({ t: 1 }) !== false;\n  return true;\n}\nexport async function runOut(ctx, rec) {\n  if (write(ctx)) await closeDecisionPr(ctx, 1);\n}\nfunction write(ctx) { return true; }\n" }])
    .includes('m/s.mjs runOut closeDecisionPr via m/s.mjs closeDecisionPr'), 'F1/F1b: closeDecisionPr returns alert(...) !== false; runOut stays listed');
  assert.ok(at([{ rel: 'm/close-it.mjs', src: "export async function closeIt(ctx, id) {\n  const sent = await ctx.alert({ type: 'pr_not_closed', ask: id });\n  return sent;\n}\n" },
    { rel: 'm/expire-it.mjs', src: "import { closeIt } from './close-it.mjs';\nexport async function expireIt(ctx, rec, a) {\n  rec.write({ kind: 'ask' });\n  await closeIt(ctx, a.id);\n}\n" }])
    .includes('m/expire-it.mjs expireIt closeIt via m/close-it.mjs closeIt'), 'F2: the helper returns the answer through a variable; its caller in another file is listed');
  assert.ok(at([{ rel: 'm/undo.mjs', src: "export function markReverted({ record, alert }, id) {\n  const w = record.write({ id });\n  if (!w.ok) alert('x');\n  return w;\n}\n" },
    { rel: 'm/gate.mjs', src: "import { markReverted, markReverted as undoMark } from './undo.mjs';\nexport function settleUndo(record, alert, card) {\n  record.write({ kind: 'card' });\n  undoMark({ record, alert }, card.id);\n}\n" }])
    .includes('m/gate.mjs settleUndo undoMark via m/undo.mjs markReverted'), 'P05: a renamed import of a function that drops its alert');
  assert.deepEqual(at([{ rel: 'a.mjs', src: "export const one = (ctx) => ctx.alert('x') || true;\n" }, { rel: 'b.mjs', src: "export { one as two } from './a.mjs';\n" },
    { rel: 'c.mjs', src: "import * as ns from './b.mjs';\nexport function three(ctx) { const r = ns.two(ctx); return r ? 1 : 0; }\n" },
    { rel: 'd.mjs', src: "import { three as four } from './c.mjs';\nexport function five(ctx, rec) { four(ctx); rec.write({}); }\n" }]).filter((x) => / via /.test(x)),
  ['c.mjs three two via b.mjs two', 'd.mjs five four via c.mjs three'], 'any depth: a re-export, a namespace import, a renamed import');
  assert.deepEqual(calls("function step(rec, send) { send('stuck'); rec.write({}); }\nexport function stall6(rec, alert) { step(rec, alert); }"), ['step send', 'stall6 step via'], 'P20: an alert port handed on by position');
  assert.deepEqual(calls("export class W {\n  warn(t) { this.alert(t); }\n  step(rec) { rec.write({}); this.warn('x'); }\n}"), ['warn alert', 'step warn via'], 'a this.method that drops its alert');
  // L143 Minor 4: tell* / notify* / safe* / *Joe / *Owner names are alerts; one that is a function we can see is followed.
  assert.deepEqual(calls("export function s({ rec, tellJoe }) { tellJoe('x'); rec.write({}); }"), ['s tellJoe'], 'P08: tellJoe');
  assert.deepEqual(calls("export function s(rec, safeNotify) { safeNotify('x'); rec.write({}); }"), ['s safeNotify'], 'P09: safeNotify');
  assert.deepEqual(calls("export function s(ctx) { ctx.pingOwner('x'); ctx.notifyAll('y'); }"), ['s notifyAll', 's pingOwner'].sort(), 'pingOwner, notifyAll');
  assert.deepEqual(calls("const safeName = (p) => p.replace(/x/g, '');\nexport function s(p) { return safeName(p); }"), [], 'a safe* function we can see that holds no alert');
  const two = inventory([
    { rel: 'a/x.mjs', src: 'export function closeX(ctx) { ctx.alert({ t: 1 }); }' },
    { rel: 'b/y.mjs', src: "import { closeX } from '../a/x.mjs';\nexport function run(ctx) { put(ctx); closeX(ctx); }" },
  ]).map((e) => `${e.file} ${e.fn} ${e.call} ${e.via ?? ''}`.trim());
  assert.deepEqual(two, ['a/x.mjs closeX alert', 'b/y.mjs run closeX a/x.mjs closeX'], 'a carrier imported from another file');
  assert.deepEqual(calls('function alert(t) { return t; }\nconst o = { notify(a) { return a; } };'), [], 'definitions');
  // L155 m2: test code is told by its path alone (the auditor's N13: a production fixtures-stall.mjs was skipped).
  assert.equal(isTestCode('m/s.mjs', "// Tested from s.test.mjs (import { test } from 'node:test').\nexport function s(ctx) { ctx.alert('x'); }"), false, 'a comment (P19)');
  assert.equal(isTestCode('shared/t.mjs', "import { test } from 'node:test';"), false, 'what a file imports does not make it test code');
  for (const rel of ['modules/M4-workshop/fixtures-stall.mjs', 'modules/M1-front-door/fixtures.mjs', 'shared/test-tmp.mjs', 'modules/testing/x.mjs', 'modules/M4-workshop/launcher/test-runner.mjs']) assert.equal(isTestPath(rel), false, `production: ${rel}`);
  for (const rel of ['m/a.test.mjs', 'm/a.test-helper.mjs', 'test/alert-inventory.mjs', 'modules/M4-workshop/fixtures/x.mjs', 'modules/x/test/y.mjs']) assert.equal(isTestPath(rel), true, `test code: ${rel}`);
  assert.deepEqual(calls('function a() { const t = "alert(x)"; /* alert(y) */ }'), [], 'strings and comments');
  assert.deepEqual(calls('function a(rec, alerts) { const list = alerts; rec.list("x"); }'), [], 'an alias is a plain call only');
});
test('controls: a change anywhere in the function changes a pin', () => {
  const pin = (src) => inventory([{ rel: 'm.mjs', src }]).map(keyOf);
  const was = pin('function a(ctx, rec) {\n  ctx.alert({ t: 1 });\n  step();\n}');
  assert.notDeepEqual(pin('function a(ctx, rec) {\n  ctx.alert({ t: 1 });\n  step();\n  rec.told = true;\n}'), was, 'a mark added lines later');
  assert.notDeepEqual(pin('function a(ctx, rec) {\n  ctx.alert({ t: 2 });\n  step();\n}'), was, 'the call line');
  assert.deepEqual(pin('function a(ctx, rec) {\n  // a note\n  ctx.alert({ t: 1 });\n  step();\n}'), was, 'a comment does not');
  assert.deepEqual(pin('\n\nfunction a(ctx, rec) {\n  ctx.alert({ t: 1 });\n  step();\n}'), was, 'a move does not');
  // The auditor's F1b on the real code: two holders called on one line share a line hash; the call is in the key, so
  // when one stops holding an alert its entry goes, and the other's entry cannot answer for it.
  const two = 'function w(ctx) { ctx.alert(1); return false; }\nfunction c(ctx) { return ctx.alert(2) !== false; }\nasync function r(ctx, rec) {\n  if (w(ctx)) await c(ctx);\n  rec.write(1);\n}';
  const listed = inventory([{ rel: 'm.mjs', src: two }]).filter((e) => e.fn === 'r');
  assert.deepEqual(listed.map((e) => e.call).sort(), ['c', 'w']);
  const after = inventory([{ rel: 'm.mjs', src: two.replace('ctx.alert(1); return false;', 'if (ctx.alert(1) === false) events.push(1); return false;') }]).filter((e) => e.fn === 'r');
  const { fresh, gone } = compare(after, listed);
  assert.deepEqual([fresh.length, gone.map((e) => e.call)], [0, ['w']], 'the w entry goes; the c entry stays as it was');
});
test('controls: a status is ruled or open; tested and wrapped no longer pass (L170)', () => {
  assert.deepEqual(parseStatus('ruled: L170, the refused file stays and is seen again'), { kind: 'ruled', call: 'L170', why: 'the refused file stays and is seen again' });
  assert.deepEqual(parseStatus('open: lane 2, #68'), { kind: 'open', owner: 'lane 2', pr: '#68' });
  assert.equal(parseStatus('open: lane 5, none yet').kind, 'bad');
  assert.equal(parseStatus('ruled: L135, ok').kind, 'bad', 'a ruling says why');
  assert.match(parseStatus('tested: modules/M2-approvals/x.test.mjs > a lost alert leaves the ask open').why, /L170/, 'tested is gone');
  assert.match(parseStatus('wrapped: modules/M13-ledger/heartbeat.mjs set').why, /L170/, 'wrapped is gone');
  assert.equal(parseStatus('passes').kind, 'bad', 'a wrapper does not pass either');
});

test('controls: a wrapper hands back the answer as it is, and every catch answers false or throws again (L143 M-3)', () => {
  const ok = (src) => wrappers(src).map((w) => w.passes);
  assert.deepEqual(ok('function safeA(t) { try { return alert(t); } catch {} }'), [false], 'r2: try { return alert() } catch {}');
  assert.deepEqual(ok('function safeB(t) { return alert(t) || true; }'), [false], 'r2: || true');
  assert.deepEqual(ok('function safeC(t) { try { return alert(t); } catch (e) { return "sent"; } }'), [false], 'r2: catch returns "sent"');
  assert.deepEqual(ok('function safeD(t) { return alert(t) !== false; }'), [true], 'L153: !== false keeps a lost alert false');
  assert.deepEqual(ok('function safeD2(t) { return alert(t) === true; }'), [false], 'a comparison that turns undefined into false is still a change');
  assert.deepEqual(ok('function safeE(t) { return alert(t) ?? true; }'), [false], '??');
  assert.deepEqual(ok('function safeF(t) { return alert(t) ? true : false; }'), [false], 'a ternary');
  assert.deepEqual(ok('const safeG = (t) => alert(t).catch(() => true);'), [false], '.catch(() => true)');
  assert.deepEqual(ok('function safeH(t) { try { return alert(t); } catch { return false; } }'), [true], 'catch answers false');
  assert.deepEqual(ok('function safeI(t) { try { return alert(t); } catch (e) { log(e); throw e; } }'), [true], 'catch throws again');
  assert.deepEqual(ok('async function safeJ(t) { return await alert(t); }'), [true], 'return await');
  assert.deepEqual(ok('function safeK(t) { if (alert(t) === false) return false; return true; }'), [true], 'tested in an if');
  // L153 item 1, advice only since L155: the answer held in a const and returned (prod-watcher's raise).
  assert.deepEqual(ok('const raise = async (k) => { const result = await alerts.raise({ k }); out.push(result); return result !== false; };'), [true], 'const result ... return result !== false');
  assert.deepEqual(ok('async function raise(k) { const result = await alerts.raise({ k }); out.push(result); return true; }'), [false], 'held but dropped');
  assert.deepEqual(ok('async function raise(k) { let result = await alerts.raise({ k }); result = true; return result !== false; }'), [false], 'held in a let and assigned again');
  assert.deepEqual(ok('async function raise(k) { const result = await alerts.raise({ k }); return result || true; }'), [false], 'held and changed on return');
  // L155 m7: notify* names are wrapper names.
  assert.deepEqual(wrappers('function notifyOwner(t) { alert(t); }').map((w) => [w.fn, w.passes]), [['notifyOwner', false]], 'notifyOwner');
});
test('controls: every alert stand-in shape is caught (L143 Minor 5)', () => {
  const n = (src) => standIns(src).length;
  assert.equal(n('const ctx1 = { rec: null, alert(t) { return true; } };'), 1, 'P11: a one-line method');
  assert.equal(n('const ctx2 = { alert: (() => true) };'), 1, 'P12: a parenthesised arrow');
  assert.equal(n('const ctx3 = { alert: Boolean };'), 1, 'P13: alert: Boolean');
  assert.equal(n('const ctx = { say: console.log };'), 1, 'say: console.log');
  assert.equal(n('const f = fakeAlert(); const o = { alert: f };'), 0, 'fakeAlert');
});
test('controls: fakeAlert answers, throws, rejects or never settles, as asked (L170: a stand-in, not a proof)', async () => {
  const never = fakeAlert({ never: true });
  const p = never('x');
  const raced = await Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((ok) => { setTimeout(() => ok('pending'), 30); })]);
  assert.equal(raced, 'pending', 'never: a promise that does not settle');
  assert.deepEqual(never.answers, ['pending']);
  const late = fakeAlert({ rejects: new Error('down'), delay: 1 });
  await assert.rejects(late('x'), /down/);
  assert.throws(() => fakeAlert({ throws: 'down' })('x'), /down/);
  const some = fakeAlert({ answer: (t, n) => n !== 1 });
  assert.deepEqual([some('a'), some('b'), some('c')], [true, false, true]);
  assert.deepEqual(some.texts, ['a', 'b', 'c']);
  some.reset();
  assert.deepEqual([some.calls, some.texts, some.answers], [[], [], []]);
});

// ---- 6. fakeAlert keeps the real outbox's contract (L135 item 5) ----

// The real M11 outbox answers false when the record refuses the queue write; fakeAlert({ answer: false }) stands in
// for that. One step (holdAlert, which marks hold-<cause> told only through tellThen) runs over both and must come out
// the same: false, and no told mark. With a working record, both answer true and leave the mark to the sender.
const refusing = (rec) => ({ read: rec.read, list: rec.list, diary: rec.diary, write: (w) => (w.id === ALERT_QUEUE_FACT ? { ok: false, reason: 'refused (test)' } : rec.write(w)) });
const hold = (rec, alert) => ({ answer: holdAlert({ rec, cause: 'c', text: 'held: c', alert, now: T0 }), mark: rec.read('fact', HOLD_FACT('c'))?.doc ?? null });
test('fakeAlert({ answer: false }) and the real outbox over a refusing record give one step the same outcome (L135 item 5)', () => {
  const realRec = refusing(recWith());
  const real = hold(realRec, outbox(realRec, T0));
  const fake = hold(recWith(), fakeAlert({ answer: false }));
  assert.deepEqual(real, { answer: false, mark: null });
  assert.deepEqual(fake, real);
  const ok = recWith();
  assert.deepEqual(hold(ok, outbox(ok, T0)), hold(recWith(), fakeAlert()), 'a working record: both answer true, and the mark waits for the send');
  assert.throws(() => hold(recWith(), fakeAlert({ throws: new Error('down') })), /down/, 'fakeAlert({ throws }) is the port failing outright; the real outbox turns that into false');
});
