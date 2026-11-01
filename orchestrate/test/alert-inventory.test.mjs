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
//   tested: <file>.test.mjs > <test name>   that test exists and runs fakeAlert({ answer: false }) and
//                                           fakeAlert({ throws }); it checks nothing says "told" after a lost alert
//   ruled: L<n>, <why>                       a lead call says this one is fine (the ruled list grows only by a lead call)
//   open: <lane n|lead>, <#PR|none yet>      still to fix or test; the gate below passes only with none open
//
// The other lists, same file: wrappers (a function named like an alert that calls one: "passes" when it hands back the
// answer), silent (a production alert that answers nothing, so it counts as sent under !== false) and standins (a test
// alert made from anything but fakeAlert()). They are pinned by file + line hash, as a multiset.
//
// Change control (L135 item 4): in a PR that is not the lead's (branch lead-* or claude/lead-*), the list may not rule
// an entry, add or rule a wrapper, or grow any list's open count. The test compares the list with the one at the
// merge-base, and always prints what changed.
//
// What this cannot see (a reviewer still reads for these):
//   - an alert more than one call away (a via entry covers one step: a same-file function, or one imported by name);
//   - an alert port handed on by position (`run(rec, alert)`) and called under another name in another file;
//   - a stand-in passed by position, or built by a helper the test file imports;
//   - whether a ruled "retried next pass" stays true: the ruling is re-checked only when its pins change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  inventory, orchestrateFiles, readList, compare, keyOf, short, parseStatus, testedProblem, hintsFor, countList,
  changeControl, LEAD_BRANCH, LIST,
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

test('every "tested" entry names a test that exists and runs fakeAlert answering false and throwing (L135)', () => {
  const bad = [];
  for (const e of LISTED.alerts) {
    const s = parseStatus(e.status);
    if (s.kind !== 'tested') continue;
    const path = join(ROOT, s.file);
    if (!existsSync(path)) { bad.push(`${e.file} ${e.fn}: ${s.file} does not exist`); continue; }
    const why = testedProblem(readFileSync(path, 'utf8'), s.test);
    if (why) bad.push(`${e.file} ${e.fn}: ${s.file} > ${s.test}: ${why}`);
  }
  assert.deepEqual(bad, []);
});

// ---- 2. the other lists ----

test('every alert wrapper is on the list, and one listed as passing hands back the inner answer (L130, L135)', () => {
  const found = new Map();
  for (const f of PROD) for (const w of wrappers(f.src)) found.set(`${f.rel} ${w.fn}`, { ...w, file: f.rel });
  const bad = [];
  const listed = new Map(LISTED.wrappers.map((e) => [`${e.file} ${e.fn}`, e]));
  for (const [k, w] of found) {
    const e = listed.get(k);
    if (!e) bad.push(`new wrapper ${w.file}:${w.line} ${w.fn}: ${w.passes ? 'it hands back the answer; the lead adds it as "passes"' : `it loses the answer (${w.why}): return the inner call's answer, or test it === false / !== false`}`);
    else if (e.status === 'passes' && !w.passes) bad.push(`${w.file}:${w.line} ${w.fn} is listed as passing but loses the answer: ${w.why}`);
    else if (e.status !== 'passes' && w.passes) bad.push(`${w.file}:${w.line} ${w.fn} now hands back the answer: set its status to "passes"`);
  }
  for (const [k, e] of listed) if (!found.has(k) && !e.lands_with) bad.push(`stale: ${k} is no longer a wrapper here; remove it from the list`);
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
test('the list changes only in a lead PR: no new ruling, no new wrapper, no list grows its open count (L135 item 4)', (t) => {
  let base; let branch;
  try {
    branch = process.env.GITHUB_HEAD_REF || git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const to = process.env.GITHUB_BASE_REF || 'main';
    const ref = [`origin/${to}`, to].find((r) => { try { git(['rev-parse', '--verify', '--quiet', r]); return true; } catch { return false; } });
    if (!ref) return t.skip(`no ${to} branch to compare with`);
    const mb = git(['merge-base', 'HEAD', ref]);
    try { base = JSON.parse(git(['show', `${mb}:orchestrate/${LIST}`])); } catch { return t.skip(`the list is new since the merge-base ${mb.slice(0, 7)}`); }
  } catch (e) { return t.skip(`no git history here: ${e.message.split('\n')[0]}`); }
  const lead = LEAD_BRANCH.test(branch);
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
  assert.equal(lane({ alerts: [e('tested: x.test.mjs > y'), base.alerts[1]] }), 0, 'an open entry now tested');
  assert.equal(lane({ alerts: [base.alerts[1]] }), 0, 'an entry fixed away');
  assert.equal(changeControl(base, { alerts: [e('ruled: L999, the lead says so')], wrappers: [], silent: [], standins: [] }, { lead: true }).problems.length, 0, 'a lead PR');
  assert.ok(LEAD_BRANCH.test('lead-alert-sweep') && LEAD_BRANCH.test('claude/lead-x') && !LEAD_BRANCH.test('claude/orch-lane1-x') && !LEAD_BRANCH.test('orch-lane2-lead-x'));
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
  assert.deepEqual(calls('function closeX(ctx) { return ctx.alert({ t: 1 }) !== false; }\nfunction run(ctx) { closeX(ctx); }'), ['closeX alert'], 'a function that decides on the answer itself is not a carrier');
  const two = inventory([
    { rel: 'a/x.mjs', src: 'export function closeX(ctx) { ctx.alert({ t: 1 }); }' },
    { rel: 'b/y.mjs', src: "import { closeX } from '../a/x.mjs';\nexport function run(ctx) { put(ctx); closeX(ctx); }" },
  ]).map((e) => `${e.file} ${e.fn} ${e.call} ${e.via ?? ''}`.trim());
  assert.deepEqual(two, ['a/x.mjs closeX alert', 'b/y.mjs run closeX a/x.mjs closeX'], 'a carrier imported from another file');
  assert.deepEqual(calls('function alert(t) { return t; }\nconst o = { notify(a) { return a; } };'), [], 'definitions');
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
});
test('controls: a "tested" status must name a test that runs fakeAlert answering false and throwing', () => {
  const imp = "import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';\n";
  assert.equal(testedProblem(`${imp}test('lost', () => { run(fakeAlert({ answer: false })); run(fakeAlert({ throws: new Error('x') })); });`, 'lost'), null);
  assert.match(testedProblem(`${imp}test('lost', () => { run(fakeAlert({ answer: false })); });`, 'lost'), /only answer: false/);
  assert.match(testedProblem(`${imp}test('lost', () => {});`, 'other'), /no test/);
  assert.match(testedProblem("test('lost', () => { run(fakeAlert({ answer: false })); run(fakeAlert({ throws: 1 })); });", 'lost'), /does not import/);
  assert.equal(parseStatus('open: lane 5, none yet').kind, 'bad');
  assert.equal(parseStatus('ruled: L135, ok').kind, 'bad', 'a ruling says why');
  assert.deepEqual(parseStatus('tested: modules/M2-approvals/x.test.mjs > a lost alert leaves the ask open'), { kind: 'tested', file: 'modules/M2-approvals/x.test.mjs', test: 'a lost alert leaves the ask open' });
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
