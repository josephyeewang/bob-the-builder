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
// Each entry has exactly one status:
//   tested: <file>.test.mjs > <test name>   that test exists, imports the entry's file, and is proven at run time
//                                           (L143 M-2): run as it is, it passes and the entry's own function reaches a
//                                           fakeAlert answering false and one throwing; run with fakeAlert's false
//                                           turned into true, it fails; run with its throw turned into true, it fails
//   ruled: L<n>, <why>                       a lead call says this one is fine (the ruled list grows only by a lead call)
//   wrapped: <file> <fn>                     the call goes through a listed wrapper whose contract test is proven
//                                           (L139 item 4): see the wrappers below
//   open: <lane n|lead>, <#PR|none yet>      still to fix or test; the gate below passes only with none open
//
// The other lists, same file: wrappers (a function named like an alert that calls one: "passes" when it hands back the
// answer), silent (a production alert that answers nothing, so it counts as sent under !== false) and standins (a test
// alert made from anything but fakeAlert()). They are pinned by file + line hash, as a multiset.
//
// A wrapper may carry a `contract_test` ("<file>.test.mjs > <test name>", L139 item 4): a test that imports the
// wrapper's file and shows, with fakeAlert({ answer: false }) and fakeAlert({ throws }), that the wrapper never takes
// a lost alert as sent. It is proven when that test exists, runs both, is not a todo, passes the same run-time proof
// as a "tested" entry (L143 M-2, with the wrapper as the function that must be reached), the wrapper's body still
// matches its pin, and every wrapper in its `inner` is proven too. Only then may a call the wrapper `covers` be
// `wrapped:`, and only then may a wrapper be "passes" (L143 M-3). `answer_unused` (a lead call) excuses only the run
// with false turned into true, for a wrapper that acts the same whatever the alert answers. A wrapper the scanner
// cannot see (not named like an alert) is listed with `by_lead: true`.
//
// Change control (L135 item 4, L139 item 6, L143 Minor 1): in a PR that is not the lead's (branch lead-* or
// claude/lead-*), the checker's own files (LEAD_FILES, the list among them) may not change at all, and the list is
// also compared entry by entry with the merge-base: a lane may only re-pin an open entry. A list
// missing at the merge-base fails a lane PR (L143 Minor 3). The test always prints what changed.
//
// What this cannot see (a reviewer still reads for these):
//   - a method on an object a factory hands back (`store.read(` where `read` holds an alert): only plain calls,
//     `this.x(`, `ns.x(` of `import * as ns`, and imported or re-exported names are followed;
//   - a dynamic import, `require`, or a function passed around in a data structure and called from there;
//   - an alert port handed on inside an object (`step({ rec, send: alert })`) under a name that is not alert-like;
//   - a stand-in passed by position, or built by a helper the test file imports;
//   - whether a ruled "retried next pass" stays true: the ruling is re-checked only when its pins change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  inventory, orchestrateFiles, readList, compare, keyOf, short, parseStatus, testedProblem, hintsFor, countList,
  changeControl, LEAD_BRANCH, LIST, contractProblems, fnBody, leadFilesIn, LEAD_FILES, runtimeCache, runtimeProblems,
  isTestCode, badTestPath, answerFlow,
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
const RUNTIME = runtimeCache(ROOT);   // each contract or tested test is run three times, once per file and name

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

test('every list entry is well formed: its text matches its hash, and its status parses (L135)', () => {
  const bad = [];
  for (const k of ['alerts', 'silent', 'standins']) for (const e of LISTED[k]) {
    if (short(squash(e.text)) !== e.hash) bad.push(`${k}: ${e.file} ${e.fn ?? ''}: the text does not match its hash`);
    if (parseStatus(e.status).kind === 'bad') bad.push(`${k}: ${e.file} ${e.fn ?? ''}: ${parseStatus(e.status).why}: ${e.status}`);
  }
  for (const k of ['silent', 'standins']) for (const e of LISTED[k]) if (parseStatus(e.status).kind === 'tested') bad.push(`${k}: ${e.file}: a ${k} entry is fixed, not tested: ${e.status}`);
  for (const w of LISTED.wrappers) if (w.status !== 'passes' && !['ruled', 'open'].includes(parseStatus(w.status).kind)) bad.push(`wrappers: ${w.file} ${w.fn}: status must be "passes", "ruled: ..." or "open: ...": ${w.status}`);
  assert.deepEqual(bad, []);
});

test('every "tested" entry names a test that imports its code and proves at run time that a lost alert is not taken as sent (L135, L143 M-2)', () => {
  const bad = [];
  const byTest = new Map();
  for (const e of LISTED.alerts) {
    const s = parseStatus(e.status);
    if (s.kind !== 'tested') continue;
    const path = join(ROOT, s.file);
    if (!existsSync(path)) { bad.push(`${e.file} ${e.fn}: ${s.file} does not exist`); continue; }
    const why = testedProblem(readFileSync(path, 'utf8'), s.test, { testRel: s.file, file: e.file, fn: e.fn });
    if (why) { bad.push(`${e.file} ${e.fn}: ${s.file} > ${s.test}: ${why}`); continue; }
    const k = JSON.stringify([s.file, s.test]);
    byTest.set(k, [...(byTest.get(k) ?? []), e]);
  }
  for (const [k, es] of byTest) {
    const [file, name] = JSON.parse(k);
    const targets = [...new Map(es.map((e) => [`${e.file} ${e.fn}`, { file: e.file, fn: e.fn }])).values()];
    for (const why of RUNTIME(file, name, targets)) bad.push(`${file} > ${name}: ${why}`);
  }
  assert.deepEqual(bad, []);
});

// ---- 2. the other lists ----

test('every alert wrapper is on the list, and one listed as passing hands back the inner answer (L130, L135)', () => {
  const found = new Map();
  for (const f of PROD) for (const w of wrappers(f.src)) found.set(`${f.rel} ${w.fn}`, { ...w, file: f.rel });
  const bad = [];
  const listed = new Map(LISTED.wrappers.filter((e) => !e.by_lead).map((e) => [`${e.file} ${e.fn}`, e]));
  for (const e of LISTED.wrappers.filter((x) => x.by_lead)) {
    const code = readSrc(e.file);
    if (code === null || fnBody(code, e.fn) === null) bad.push(`stale: ${e.file} ${e.fn} (listed by the lead) is no longer there`);
    else if (e.status === 'passes') for (const why of contractProblems({ ...e, inner: [] }, LISTED.wrappers, readSrc, new Set(), RUNTIME)) bad.push(`${e.file} ${e.fn} is listed as passing, but its contract is not proven: ${why}`);
  }
  for (const [k, w] of found) {
    const e = listed.get(k);
    if (!e) bad.push(`new wrapper ${w.file}:${w.line} ${w.fn}: ${w.passes ? 'it hands back the answer; the lead adds it as "passes"' : `it loses the answer (${w.why}): return the inner call's answer, or test it === false / !== false`}`);
    else if (e.status === 'passes' && !w.passes) bad.push(`${w.file}:${w.line} ${w.fn} is listed as passing but loses the answer: ${w.why}`);
    // L143 M-3: "passes" also needs a contract test that passes the run-time proof.
    else if (e.status === 'passes') for (const why of contractProblems(e, LISTED.wrappers, readSrc, new Set(), RUNTIME)) bad.push(`${w.file}:${w.line} ${w.fn} is listed as passing, but its contract is not proven: ${why}`);
    else if (e.status !== 'passes' && w.passes) bad.push(`${w.file}:${w.line} ${w.fn} now hands back the answer: set its status to "passes"`);
  }
  for (const [k, e] of listed) if (!found.has(k) && !e.lands_with) bad.push(`stale: ${k} is no longer a wrapper here; remove it from the list`);
  assert.deepEqual(bad, []);
});

test('every wrapper contract is pinned to the wrapper as it is now, and names a test that exists (L139 item 4)', () => {
  const bad = [];
  const report = [];
  for (const w of LISTED.wrappers.filter((x) => x.contract_test || x.covers || x.inner)) {
    const id = `${w.file} ${w.fn}`;
    if (!w.contract_test) { bad.push(`${id}: covers or inner without a contract_test`); continue; }
    const code = readSrc(w.file);
    const now = code === null ? null : fnBody(code, w.fn);
    if (!w.body) bad.push(`${id}: a wrapper with a contract_test pins its body ("body": "${now}")`);
    else if (now !== w.body) bad.push(`${id}: the wrapper changed since its contract was pinned (body ${now}, list ${w.body}); re-check its contract test, then re-pin`);
    const x = /^(\S+\.test\.mjs) > (.+)$/.exec(w.contract_test);
    if (!x || readSrc(x[1]) === null || /no test/.test(testedProblem(readSrc(x[1]), x[2]) ?? '')) bad.push(`${id}: contract_test "${w.contract_test}" names no test that exists`);
    const why = contractProblems(w, LISTED.wrappers, readSrc, new Set(), RUNTIME);
    report.push(`${id}: ${why.length ? `not proven: ${why.join('; ')}` : 'proven'}`);
    if (w.answer_unused && !/^L\d{1,4}: .{8,}/.test(w.answer_unused)) bad.push(`${id}: answer_unused is a lead call: "L<n>: <why>"`);
  }
  console.log(`wrapper contracts (L139):\n  ${report.join('\n  ')}`);
  assert.deepEqual(bad, []);
});

test('every "wrapped" entry goes through a listed wrapper that covers it and whose contract is proven (L139 item 4)', () => {
  const bad = [];
  for (const e of LISTED.alerts) {
    const s = parseStatus(e.status);
    if (s.kind !== 'wrapped') continue;
    const w = LISTED.wrappers.find((x) => x.file === s.file && x.fn === s.fn);
    if (!w) { bad.push(`${e.file} ${e.fn} ${e.call}: no wrapper ${s.file} ${s.fn} on the list`); continue; }
    if (!(w.covers ?? []).some((c) => c.file === e.file && c.call === e.call && (!c.fn || c.fn === e.fn))) bad.push(`${e.file} ${e.fn} ${e.call}: ${s.file} ${s.fn} does not cover this call`);
    for (const why of contractProblems(w, LISTED.wrappers, readSrc, new Set(), RUNTIME)) bad.push(`${e.file} ${e.fn} ${e.call}: ${why}`);
  }
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
    branch = process.env.GITHUB_HEAD_REF || git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const to = process.env.GITHUB_BASE_REF || 'main';
    const ref = [`origin/${to}`, to].find((r) => { try { git(['rev-parse', '--verify', '--quiet', r]); return true; } catch { return false; } });
    if (!ref) return t.skip(`no ${to} branch to compare with`);
    const mb = git(['merge-base', 'HEAD', ref]);
    changed = git(['diff', '--name-only', mb, 'HEAD']).split('\n').filter(Boolean);
    try { base = JSON.parse(git(['show', `${mb}:orchestrate/${LIST}`])); } catch { base = null; }
  } catch (e) { return t.skip(`no git history here: ${e.message.split('\n')[0]}`); }
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
  assert.equal(lane({ alerts: [e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'dddddddd')] }), 1, 'a ruled entry re-pinned');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet'), e('ruled: L135, retried next pass', 'cccccccc'), e('open: lane 1, none yet', 'eeeeeeee')] }), 1, 'one more open');
  assert.equal(lane({ alerts: base.alerts, wrappers: [{ file: 'f.mjs', fn: 'safeX', status: 'passes' }] }), 1, 'a new wrapper');
  assert.equal(lane({ alerts: base.alerts, standins: [{ file: 't.test.mjs', hash: 'x', text: 'x', status: 'open: lane 1, none yet' }] }), 1, 'a new stand-in');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet', 'ffffffff'), base.alerts[1]] }), 0, 'an open entry re-pinned');
  assert.equal(lane({ alerts: [...base.alerts, e('open: lane 1, none yet', 'eeeeeeee')].slice(0, 2) }), 0, 'nothing changed');
  // L143 Minor 1: entry by entry, not net counts.
  assert.equal(lane({ alerts: [e('tested: x.test.mjs > y'), base.alerts[1]] }), 1, 'an open entry marked tested (the lead checks the test)');
  assert.equal(lane({ alerts: [base.alerts[1]] }), 1, 'an entry removed');
  assert.equal(lane({ alerts: [e('open: lane 2, none yet'), base.alerts[1]] }), 1, 'an owner changed');
  assert.equal(lane({ alerts: [{ ...e('open: lane 1, none yet'), lands_with: '#9' }, base.alerts[1]] }), 1, 'lands_with added');
  assert.equal(lane({ alerts: [e('open: lane 1, none yet', 'ffffffff'), base.alerts[1], e('ruled: L1, a new ruled entry', '99999999')] }), 1, 'a new entry that is not open');
  assert.equal(lane({ alerts: [base.alerts[1], e('open: lane 1, none yet', '11111111'), e('open: lane 1, none yet', '22222222')] }), 1, 'an open entry re-pinned and one added');
  assert.equal(lane({ alerts: [e('tested: x.test.mjs > y', '33333333'), e('ruled: L135, retried next pass', 'cccccccc'), e('open: lane 1, none yet', '44444444')] }), 1,
    'net open unchanged, but one entry turned tested');
  const wb = { ...base, wrappers: [{ file: 'f.mjs', fn: 'safeX', status: 'open: lane 1, none yet', body: 'aaaaaaaa' }] };
  const laneW = (wrappers) => changeControl(wb, { ...wb, wrappers }, { lead: false }).problems.length;
  assert.equal(laneW([{ ...wb.wrappers[0], status: 'passes' }]), 1, 'a wrapper status changed');
  assert.equal(laneW([{ ...wb.wrappers[0], body: 'bbbbbbbb' }]), 1, 'a wrapper re-pinned');
  assert.equal(laneW([]), 1, 'a wrapper removed');
  assert.equal(changeControl(base, { ...base, standins: [{ file: 't.test.mjs', hash: 'x', text: 'x', status: 'open: lead, none yet' }] }, { lead: false }).problems.length, 1, 'a new stand-in');
  assert.equal(changeControl(base, { alerts: [e('ruled: L999, the lead says so')], wrappers: [], silent: [], standins: [] }, { lead: true }).problems.length, 0, 'a lead PR');
  assert.ok(LEAD_BRANCH.test('lead-alert-sweep') && LEAD_BRANCH.test('claude/lead-x') && !LEAD_BRANCH.test('claude/orch-lane1-x') && !LEAD_BRANCH.test('orch-lane2-lead-x'));
});

test('controls: a wrapper contract is proven only by a real, non-todo test with both fakes, on the pinned body, with proven inner wrappers (L139)', () => {
  const files = {
    'm/w.mjs': 'export function tellX(a) { return a(); }\nexport function inner(a) { return a(); }',
    'test/c.test.mjs': "import { fakeAlert } from './fake-alert.test-helper.mjs';\nimport { tellX } from '../m/w.mjs';\ntest('ok', () => { tellX(fakeAlert({ answer: false })); tellX(fakeAlert({ throws: new Error('x') })); });\ntest('later', { todo: 'not yet' }, () => { tellX(fakeAlert({ answer: false })); tellX(fakeAlert({ throws: 1 })); });\ntest('half', () => { tellX(fakeAlert({ answer: false })); });",
    'test/d.test.mjs': "import { fakeAlert } from './fake-alert.test-helper.mjs';\ntest('ok', () => { fakeAlert({ answer: false }); fakeAlert({ throws: 1 }); });",
  };
  const read = (r) => files[r] ?? null;
  const body = fnBody(files['m/w.mjs'], 'tellX');
  const w = (over) => ({ file: 'm/w.mjs', fn: 'tellX', body, contract_test: 'test/c.test.mjs > ok', ...over });
  const inner = { file: 'm/w.mjs', fn: 'inner', body: fnBody(files['m/w.mjs'], 'inner'), contract_test: 'test/c.test.mjs > later' };
  const n = (x, list = [x]) => contractProblems(x, list, read).length;
  assert.equal(n(w()), 0, 'proven');
  assert.equal(n(w({ contract_test: 'test/c.test.mjs > later' })), 1, 'a todo test proves nothing');
  assert.equal(n(w({ contract_test: 'test/c.test.mjs > half' })), 1, 'answer: false without a throw');
  assert.equal(n(w({ contract_test: 'test/d.test.mjs > ok' })), 1, 'a test that does not import the wrapper');
  assert.equal(n(w({ body: '00000000' })), 1, 'the wrapper changed since it was pinned');
  assert.equal(n(w({ contract_test: undefined })), 1, 'no contract test');
  assert.equal(n(w({ contract_test: '../outside/c.test.mjs > ok' })), 1, 'a test outside orchestrate/ (L143 Minor 9)');
  assert.equal(n(w({ inner: ['m/w.mjs inner'] }), [w({ inner: ['m/w.mjs inner'] }), inner]), 1, 'an inner wrapper not proven');
  assert.deepEqual(leadFilesIn(['orchestrate/test/alert-inventory.json', 'orchestrate/test/alert-answer-scan.mjs', 'orchestrate/modules/M2-approvals/x.mjs', 'docs/test/alert-inventory.json']),
    ['orchestrate/test/alert-inventory.json', 'orchestrate/test/alert-answer-scan.mjs'], "the checker's own files");
  assert.deepEqual(parseStatus('wrapped: modules/M13-ledger/heartbeat.mjs set'), { kind: 'wrapped', file: 'modules/M13-ledger/heartbeat.mjs', fn: 'set' });
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
  // L143 Minor 6: test code is a file that really imports node:test, not one whose comment says so (P19).
  assert.equal(isTestCode('m/s.mjs', "// Tested from s.test.mjs (import { test } from 'node:test').\nexport function s(ctx) { ctx.alert('x'); }"), false, 'a comment');
  assert.equal(isTestCode('m/s.mjs', "const t = \"import { test } from 'node:test'\";"), false, 'a string');
  assert.equal(isTestCode('shared/t.mjs', "import { test } from 'node:test';"), true, 'a real import');
  assert.equal(isTestCode('shared/t.mjs', "import 'node:test';"), true, 'a bare import');
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
test('controls: a "tested" status must name a test that runs fakeAlert answering false and throwing', () => {
  const imp = "import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';\n";
  assert.equal(testedProblem(`${imp}test('lost', () => { run(fakeAlert({ answer: false })); run(fakeAlert({ throws: new Error('x') })); });`, 'lost'), null);
  assert.match(testedProblem(`${imp}test('lost', () => { run(fakeAlert({ answer: false })); });`, 'lost'), /only answer: false/);
  assert.match(testedProblem(`${imp}test('lost', () => {});`, 'other'), /no test/);
  assert.match(testedProblem("test('lost', () => { run(fakeAlert({ answer: false })); run(fakeAlert({ throws: 1 })); });", 'lost'), /does not import/);
  // L143 M-2: a throw that cannot throw, a skip in the body, a test that never imports or names the code.
  for (const v of ['null', 'false', 'undefined', '0', "''"]) assert.match(testedProblem(`${imp}test('lost', () => { run(fakeAlert({ answer: false })); run(fakeAlert({ throws: ${v} })); });`, 'lost'), /only answer: false/, `throws: ${v}`);
  assert.match(testedProblem(`${imp}test('lost', (t) => { t.skip(); run(fakeAlert({ answer: false })); run(fakeAlert({ throws: new Error('x') })); });`, 'lost'), /skip\(\) or todo\(\)/);
  assert.match(testedProblem(`${imp}test('lost', (t) => { t.todo('later'); run(fakeAlert({ answer: false })); run(fakeAlert({ throws: new Error('x') })); });`, 'lost'), /skip\(\) or todo\(\)/);
  const target = { testRel: 'm/a.test.mjs', file: 'm/a.mjs', fn: 'closeIt' };
  const honest = `${imp}import { closeIt } from './a.mjs';\ntest('lost', () => { closeIt(fakeAlert({ answer: false })); closeIt(fakeAlert({ throws: new Error('x') })); });`;
  assert.equal(testedProblem(honest, 'lost', target), null);
  assert.match(testedProblem(honest.replace("from './a.mjs'", "from './b.mjs'"), 'lost', target), /does not import m\/a\.mjs/);
  assert.match(parseStatus('tested: ../x/y.test.mjs > lost').why, /inside orchestrate/, 'L143 Minor 9');
  assert.equal(badTestPath('modules/M2-approvals/x.test.mjs'), null);
  assert.equal(parseStatus('open: lane 5, none yet').kind, 'bad');
  assert.equal(parseStatus('ruled: L135, ok').kind, 'bad', 'a ruling says why');
  assert.deepEqual(parseStatus('tested: modules/M2-approvals/x.test.mjs > a lost alert leaves the ask open'), { kind: 'tested', file: 'modules/M2-approvals/x.test.mjs', test: 'a lost alert leaves the ask open' });
});

test('controls: a wrapper hands back the answer as it is, and every catch answers false or throws again (L143 M-3)', () => {
  const ok = (src) => wrappers(src).map((w) => w.passes);
  assert.deepEqual(ok('function safeA(t) { try { return alert(t); } catch {} }'), [false], 'r2: try { return alert() } catch {}');
  assert.deepEqual(ok('function safeB(t) { return alert(t) || true; }'), [false], 'r2: || true');
  assert.deepEqual(ok('function safeC(t) { try { return alert(t); } catch (e) { return "sent"; } }'), [false], 'r2: catch returns "sent"');
  assert.deepEqual(ok('function safeD(t) { return alert(t) !== false; }'), [false], 'a comparison on a returned call');
  assert.deepEqual(ok('function safeE(t) { return alert(t) ?? true; }'), [false], '??');
  assert.deepEqual(ok('function safeF(t) { return alert(t) ? true : false; }'), [false], 'a ternary');
  assert.deepEqual(ok('const safeG = (t) => alert(t).catch(() => true);'), [false], '.catch(() => true)');
  assert.deepEqual(ok('function safeH(t) { try { return alert(t); } catch { return false; } }'), [true], 'catch answers false');
  assert.deepEqual(ok('function safeI(t) { try { return alert(t); } catch (e) { log(e); throw e; } }'), [true], 'catch throws again');
  assert.deepEqual(ok('async function safeJ(t) { return await alert(t); }'), [true], 'return await');
  assert.deepEqual(ok('function safeK(t) { if (alert(t) === false) return false; return true; }'), [true], 'tested in an if');
});
test('controls: every alert stand-in shape is caught (L143 Minor 5)', () => {
  const n = (src) => standIns(src).length;
  assert.equal(n('const ctx1 = { rec: null, alert(t) { return true; } };'), 1, 'P11: a one-line method');
  assert.equal(n('const ctx2 = { alert: (() => true) };'), 1, 'P12: a parenthesised arrow');
  assert.equal(n('const ctx3 = { alert: Boolean };'), 1, 'P13: alert: Boolean');
  assert.equal(n('const ctx = { say: console.log };'), 1, 'say: console.log');
  assert.equal(n('const f = fakeAlert(); const o = { alert: f };'), 0, 'fakeAlert');
});
test('controls: the run-time proof fails a test that never reaches the code, ignores the answer, or ignores the throw (L143 M-2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-control-'));
  try {
    mkdirSync(join(dir, 'test')); mkdirSync(join(dir, 'm'));
    copyFileSync(join(ROOT, HELPER), join(dir, HELPER));
    writeFileSync(join(dir, 'm/c.mjs'), 'export function closeIt(alert, rec) {\n  const sent = alert("x");\n  if (sent !== false) rec.push("told");\n  return sent;\n}\n'
      + 'export function guard(alert) {\n  return (a) => {\n    try { return alert(a) !== false; } catch { return false; }\n  };\n}\nexport function other() { return 1; }\n');
    const imp = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fakeAlert } from '../test/fake-alert.test-helper.mjs';\nimport { closeIt, guard } from './c.mjs';\n";
    writeFileSync(join(dir, 'm/c.test.mjs'), `${imp}
test('honest', () => {
  const rec = []; assert.equal(closeIt(fakeAlert({ answer: false }), rec), false); assert.deepEqual(rec, []);
  assert.throws(() => closeIt(fakeAlert({ throws: new Error('down') }), []), /down/);
});
test('token', () => { const a = fakeAlert({ answer: false }); const b = fakeAlert({ throws: new Error('x') }); assert.ok(a && b && closeIt); });
test('ignores the answer', () => {
  closeIt(fakeAlert({ answer: false }), []);
  assert.throws(() => closeIt(fakeAlert({ throws: new Error('down') }), []), /down/);
});
test('ignores the throw', () => {
  const rec = []; assert.equal(closeIt(fakeAlert({ answer: false }), rec), false);
  try { closeIt(fakeAlert({ throws: new Error('down') }), []); } catch { /* not looked at */ }
});
test('skipped', (t) => { t.skip('later'); });
test('closure', () => {
  assert.equal(guard(fakeAlert({ answer: false }))('x'), false);
  assert.equal(guard(fakeAlert({ throws: new Error('down') }))('x'), false);
});
`);
    const target = [{ file: 'm/c.mjs', fn: 'closeIt' }];
    const why = (name, opts) => runtimeProblems(dir, 'm/c.test.mjs', name, target, opts).join(' | ');
    assert.equal(why('honest'), '', 'an honest test is proven');
    assert.match(why('token'), /never reached a fakeAlert that answered false.*never reached a fakeAlert that threw/, 'a token test (r2 F3) reaches nothing');
    assert.match(why('ignores the answer'), /still passes when the lost alert answers true/, 'a test that never checks the answer');
    assert.equal(why('ignores the answer', { answerUnused: 'L143: control' }), '', 'answer_unused excuses only that');
    assert.match(why('ignores the throw'), /still passes when the failing alert answers true/, 'a test that never checks the throw');
    assert.match(why('skipped'), /skipped or a todo/, 't.skip() in the body');
    assert.match(why('no such test'), /did not run/, 'a name that is not a test');
    // The closure a wrapper hands back has no name on the stack; a frame on a line inside the function counts (safeAlert).
    const closure = (fn) => runtimeProblems(dir, 'm/c.test.mjs', 'closure', [{ file: 'm/c.mjs', fn }]).join(' | ');
    assert.equal(closure('guard'), '', 'the closure guard hands back is reached inside guard');
    assert.match(closure('other'), /never reached a fakeAlert that answered false/, 'but not inside a function it never ran');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
