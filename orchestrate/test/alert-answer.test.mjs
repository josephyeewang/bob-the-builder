// alert-answer.test.mjs — lead call L130: an alert's answer is never ignored before something that says it went out.
//
// The rule (no exceptions list): anything that marks "told", moves a card to wait on Joe, writes a note saying someone
// was told, records a state that stops a re-ask, or returns told / sent / alerted happens only after the alert answered
// something other than false (a thrown error counts as false). Only two forms are allowed:
//   tellThen(alert, text, mark)                         M11 alerts.mjs: the sender writes the mark once the alert is out
//   if (alert(...) !== false) { follow-up }             the follow-up sits inside the guard
// A wrapper (safeAlert, say, tellOnce and the like) hands back the inner call's answer unchanged.
//
// Five checks, every one over all of orchestrate/ (alert-answer-scan.mjs is the scan):
//   1. Alert-sites: no production alert call has its answer unused (or replaced by `return true` / `told: true`) next to
//      a write, before it or after it (L133). A function of the same file that drops an alert's answer and answers
//      nothing counts as an alert too, so `if (write(...)) closeX()` is caught when closeX ignores its alert (L133).
//      SITES holds the ones on main when L130 and L133 were ruled, by file and function.
//   2. Wrappers: every function named like an alert that calls one returns its answer. WRAPPERS is the allow-list of
//      the ones that do; BAD_WRAPPERS holds the ones on main that don't.
//   3. Stand-ins: a test's alert stand-in is fakeAlert() (fake-alert.test-helper.mjs), which can answer false. STANDINS
//      holds the stand-in lines on main, counted per file.
//   4. Silent defaults: no production `alert = () => {}` default, or `alert:` that only logs. Its undefined answer
//      passes `!== false`, so a lost alert passes the allowed form. SILENT holds the ones on main. (This one is the
//      lead PR's addition to L130; the lead can drop it by deleting its test.)
//   5. Controls: the scan catches each planted form and passes the two allowed forms.
//
// The lists only shrink (the #79 pattern). Each entry is cut when its owner's fix lands, and they must be empty before
// the first cutover. One more hit than listed fails (a new instance); one fewer fails too, so the list is cut to match;
// an entry with no hit left fails (stale). The length pins below stop a list from growing.
//
// What the scan cannot see (it reads text, it is not a parser), so a reviewer still reads for these:
//   - a write made by a local helper (`done()` in cleanup.mjs) or two blocks away from the alert;
//   - an alert two calls deep, or in a function of another file (the one-step check stays inside one file);
//   - whether something retries the step next pass (L133's other way a state can stand): a retried site is still flagged;
//   - an alert called by a name not on the list (`holdAlert(...)` in main.mjs, report m12), or as `cond && alert()`;
//   - an answer kept in a variable and then not looked at (`const ok = alert(x); note(...)`);
//   - a `told` value carried to another file and trusted there (report M4 and M5): it catches the `told: true` at the
//     source only;
//   - an alert inside a template literal's ${ }.
// M11's alert-sites.test.mjs stays: its L47 direct-send rule and r7 drop-cause rule are not this class (see the PR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { alertSites, wrappers, standIns, silentDefaults } from './alert-answer-scan.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));   // orchestrate/
const HELPER = 'test/fake-alert.test-helper.mjs';

// ---- the shrink-only lists (L130). owner: the lane whose fix removes the entry; pr: the PR that carries it. ----

// Alert-sites on main, by file and function: n is how many flagged calls the function holds.
const SITES = [
  { file: 'modules/M10-rules/reader.mjs', fn: 'say', n: 1, owner: 'lane 1', pr: 'none yet', what: 'say() marks the key sent, then ignores the sink' },
  { file: 'modules/M11-dispatcher/lead-restart.mjs', fn: 'leadRestartStep', n: 2, owner: 'lane 2', pr: '#68', what: 'report M10 start_failed; m5 gave_up' },
  { file: 'modules/M11-dispatcher/merges.mjs', fn: 'timeLimits', n: 1, owner: 'lane 2', pr: '#68', what: 'report M2: no reviewer twice, waitOn then a bare alert' },
  { file: 'modules/M11-dispatcher/merges.mjs', fn: 'merged', n: 1, owner: 'lane 2', pr: '#68', what: 'report m2: merged at another head' },
  { file: 'modules/M11-dispatcher/merges.mjs', fn: 'refuse', n: 1, owner: 'lane 2', pr: '#68', what: 'report M3: refused twice, success branch' },
  { file: 'modules/M11-dispatcher/outage.mjs', fn: 'outageStep', n: 1, owner: 'lane 2', pr: '#68', what: 'report M11: outage' },
  { file: 'modules/M11-dispatcher/outbox-intake.mjs', fn: 'intakePass', n: 3, owner: 'lane 2', pr: '#68', what: 'report M7, M8; m6' },
  { file: 'modules/M11-dispatcher/pass.mjs', fn: 'stopPass', n: 1, owner: 'lane 2', pr: '#68', what: 'report M9: unsaved work' },
  { file: 'modules/M11-dispatcher/pass.mjs', fn: 'starts', n: 1, owner: 'lane 2', pr: '#68', what: 'report m4: launch not recorded' },
  { file: 'modules/M11-dispatcher/phone-link.mjs', fn: 'phoneLinkStep', n: 1, owner: 'lane 2', pr: '#68', what: 'report m9' },
  { file: 'modules/M11-dispatcher/tick.mjs', fn: 'actOnDead', n: 2, owner: 'lane 2', pr: '#68', what: 'report M1 dead card; m1 restart' },
  { file: 'modules/M11-dispatcher/tick.mjs', fn: 'tick', n: 1, owner: 'lane 2', pr: '#68', what: 'report m13: error fallback' },
  { file: 'modules/M11-dispatcher/undo.mjs', fn: 'fixCards', n: 1, owner: 'lane 2', pr: '#68', what: 'report m11: fix card, then a note' },
  { file: 'modules/M12-sensors/prod-watcher.mjs', fn: 'watchOnce', n: 1, owner: 'lane 3', pr: 'none yet', what: 'raise() per setting change, then the new baseline is put' },
  { file: 'modules/M13-ledger/heartbeat.mjs', fn: 'heartbeatOnce', n: 3, owner: 'lane 3', pr: 'none yet', what: 'account changed / usage step / a red check (set) raised, then the state is put' },
  { file: 'modules/M2-approvals/research-ask.mjs', fn: 'refusedAlerts', n: 1, owner: 'lane 3', pr: '#87', what: 'report m16: the refused state file is written after an ignored alert' },
  { file: 'modules/M2-approvals/schedule.mjs', fn: 'configAlert', n: 1, owner: 'lane 3', pr: '#87', what: 'report m16: config-alert.json written after an ignored alert (L130 gave it to lane 1; #87 r3 fixes it)' },
  { file: 'modules/M2-approvals/schedule.mjs', fn: 'runOut', n: 1, owner: 'lane 3', pr: '#87', what: 'L133: the ask is written expired, then closeDecisionPr ignores its decision_pr_not_closed alert' },
  { file: 'modules/M2-approvals/undo-flag.mjs', fn: 'openUndoFlags', n: 1, owner: 'lane 3', pr: '#87', what: 'report m16: undo_by_hand' },
  { file: 'modules/M6-merge-gate/gate.mjs', fn: 'serve', n: 1, owner: 'lane 1', pr: 'none yet', what: 'merge_refused after the merge is moved' },
  { file: 'modules/M6-merge-gate/gate.mjs', fn: 'refuse', n: 1, owner: 'lane 1', pr: 'none yet', what: 'merge refused, written and moved' },
  { file: 'modules/M6-merge-gate/gate.mjs', fn: 'finish', n: 3, owner: 'lane 1', pr: 'none yet', what: 'merge_parent_moved asks "Undo?" once, after the merge is recorded; complete() after the move (gatePass redoes complete until marked_at, so L133\'s retry clause may clear that one)' },
  { file: 'modules/M6-merge-gate/gate.mjs', fn: 'complete', n: 1, owner: 'lane 1', pr: '#91', what: 'report m17: merge_marked_after_audit (fix due in #91 r3)' },
  { file: 'modules/M6-merge-gate/gate.mjs', fn: 'recover', n: 1, owner: 'lane 2', pr: 'none yet', what: 'recover() is lane 2 under L94' },
  { file: 'modules/M9-record/store.mjs', fn: 'tellOnce', n: 1, owner: 'lane 1', pr: 'none yet', what: 'report m15: tellOnce marks the key told, then ignores the sink' },
  { file: 'modules/M9-record/writer.mjs', fn: 'breakIfDead', n: 1, owner: 'lane 1', pr: 'none yet', what: 'report m15: store.alert then markSeen(key, "alerted")' },
];

// Wrappers that hand back the inner call's answer. Each must still exist and still pass.
const WRAPPERS = [
  { file: 'modules/M11-dispatcher/alerts.mjs', fn: 'tellThen' },
];

// Wrappers on main that lose the answer (they return nothing, or swallow a throw).
const BAD_WRAPPERS = [
  { file: 'modules/M10-rules/reader.mjs', fn: 'say', owner: 'lane 1', pr: 'none yet' },
  { file: 'modules/M12-sensors/prod-watcher.mjs', fn: 'raise', owner: 'lane 3', pr: 'none yet' },
  { file: 'modules/M9-record/store.mjs', fn: 'tellOnce', owner: 'lane 1', pr: 'none yet' },
  { file: 'modules/M9-record/store.mjs', fn: 'say', owner: 'lane 1', pr: 'none yet' },
];

// Test stand-ins not made by fakeAlert(), lines per file. pr is 'none yet' throughout: fakeAlert arrives with this PR.
const STANDINS = {
  'modules/M10-rules/approving-pull.test.mjs': { count: 2, owner: 'lane 1', pr: 'none yet' },
  'modules/M10-rules/reader.test.mjs': { count: 3, owner: 'lane 1', pr: 'none yet' },
  'modules/M11-dispatcher/account-ports.test.mjs': { count: 3, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/cleanup.test.mjs': { count: 3, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/installed.test.mjs': { count: 1, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/lead-restart.test.mjs': { count: 4, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/merges.test.mjs': { count: 1, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/outage.test.mjs': { count: 22, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/outbox-intake.test.mjs': { count: 1, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/pass.test.mjs': { count: 24, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/phone-link.test.mjs': { count: 2, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/tick.test.mjs': { count: 13, owner: 'lane 2', pr: 'none yet' },
  'modules/M11-dispatcher/undo.test.mjs': { count: 5, owner: 'lane 2', pr: 'none yet' },
  'modules/M2-approvals/decision.test.mjs': { count: 1, owner: 'lane 1', pr: 'none yet' },
  'modules/M2-approvals/fixtures.test-helper.mjs': { count: 1, owner: 'lane 1', pr: 'none yet' },
  'modules/M2-approvals/go-view.test.mjs': { count: 1, owner: 'lane 1', pr: 'none yet' },
  'modules/M2-approvals/research-ask.test.mjs': { count: 1, owner: 'lane 1', pr: 'none yet' },
  'modules/M4-workshop/launcher/launch.test.mjs': { count: 1, owner: 'lane 2', pr: 'none yet' },
  'modules/M4-workshop/launcher/review-launch.test.mjs': { count: 1, owner: 'lane 2', pr: 'none yet' },
  'modules/M4-workshop/send-safe/toolflight.test.mjs': { count: 1, owner: 'lane 2', pr: 'none yet' },
  'modules/M6-merge-gate/gate.test.mjs': { count: 1, owner: 'lane 1', pr: 'none yet' },
  'modules/M9-record/crash.test.mjs': { count: 1, owner: 'lane 1', pr: 'none yet' },
  'modules/M9-record/fixtures.test-helper.mjs': { count: 2, owner: 'lane 1', pr: 'none yet' },
  'modules/M9-record/outbox.test.mjs': { count: 2, owner: 'lane 1', pr: 'none yet' },
  'modules/M9-record/store.test.mjs': { count: 8, owner: 'lane 1', pr: 'none yet' },
};

// Production alerts that answer nothing, by file and the text of their line.
const SILENT = [
  { file: 'modules/M11-dispatcher/tick.mjs', has: 'export function actOnDead(', owner: 'lane 2', pr: 'none yet' },
  { file: 'modules/M4-workshop/launcher/outbox.mjs', has: 'export function emptyOutbox(', owner: 'lane 2', pr: 'none yet' },
  { file: 'modules/M4-workshop/launcher/review-runner-main.mjs', has: 'alert: (t) => log(', owner: 'lane 2', pr: 'none yet' },   // report m14
  { file: 'modules/M4-workshop/send-safe/activity.mjs', has: 'constructor(store, { notify = () => {}', owner: 'lane 2', pr: 'none yet' },
  { file: 'modules/M6-merge-gate/undo.mjs', has: 'export function markReverted(', owner: 'lane 1', pr: 'none yet' },
  { file: 'modules/M9-record/store.mjs', has: 'export function openStore(', owner: 'lane 1', pr: 'none yet' },
  { file: 'modules/M9-record/writer.mjs', has: 'export function openRecord(', owner: 'lane 1', pr: 'none yet' },
];

// The pins: a list may only get shorter.
const PIN = { sites: 26, siteCalls: 34, badWrappers: 4, standinFiles: 25, standinLines: 105, silent: 7 };

// ---- the walk ----

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.mjs') ? [p] : []);
  });
}
// Test code: a *.test.mjs or *.test-helper.mjs, anything in a fixtures folder or a fixtures file, this test/ folder,
// or a file that imports node:test (shared/test-tmp.mjs).
function isTestCode(rel, src) {
  const parts = rel.split(sep);
  const base = parts[parts.length - 1];
  return /\.test(?:-helper)?\.mjs$/.test(base) || base.startsWith('fixtures') || parts.includes('fixtures') || parts[0] === 'test'
    || /from\s+['"]node:test['"]/.test(src);
}
const FILES = walk(ROOT).map((p) => {
  const rel = relative(ROOT, p);
  const src = readFileSync(p, 'utf8');
  return { rel: rel.split(sep).join('/'), src, testCode: isTestCode(rel, src) };
});
const PROD = FILES.filter((f) => !f.testCode);
const TESTS = FILES.filter((f) => f.testCode && f.rel !== HELPER);

const HOW = 'use tellThen(alert, text, mark), or put the follow-up inside if (alert(...) !== false) { ... }';

// ---- 1. alert-sites ----

test('every production alert-site on the shrink list is still there, and there is no new one (L130)', () => {
  const found = new Map();
  for (const f of PROD) for (const s of alertSites(f.src)) {
    const k = `${f.rel} ${s.fn}`;
    if (!found.has(k)) found.set(k, []);
    found.get(k).push(`${f.rel}:${s.line} (${s.fn}) ${s.call}(...) then ${s.why}: ${s.text.slice(0, 120)}`);
  }
  const listed = new Map(SITES.map((e) => [`${e.file} ${e.fn}`, e]));
  const bad = [];
  for (const [k, hits] of found) {
    const e = listed.get(k);
    if (!e) bad.push(`new: ${hits.join('\n  ')}\n  The alert's answer is ignored next to a write; ${HOW}.`);
    else if (hits.length > e.n) bad.push(`one more than listed (${hits.length}, list says ${e.n}):\n  ${hits.join('\n  ')}\n  ${HOW}.`);
    else if (hits.length < e.n) bad.push(`${e.file} ${e.fn}: ${hits.length} left, list says ${e.n}; cut its n to ${hits.length} in SITES.`);
  }
  for (const [k, e] of listed) if (!found.has(k)) bad.push(`stale: ${k} has no flagged alert left; remove it from SITES (owner ${e.owner}, ${e.pr}).`);
  assert.deepEqual(bad, []);
});

// ---- 2. wrappers ----

test('every alert wrapper hands back the inner answer, or is on the shrink list (L130)', () => {
  const found = new Map();
  for (const f of PROD) for (const w of wrappers(f.src)) found.set(`${f.rel} ${w.fn}`, { ...w, file: f.rel });
  const ok = new Set(WRAPPERS.map((e) => `${e.file} ${e.fn}`));
  const badList = new Set(BAD_WRAPPERS.map((e) => `${e.file} ${e.fn}`));
  const bad = [];
  for (const [k, w] of found) {
    if (ok.has(k)) { if (!w.passes) bad.push(`${w.file}:${w.line} ${w.fn} is on WRAPPERS but no longer hands back the answer: ${w.why}`); }
    else if (badList.has(k)) { if (w.passes) bad.push(`${w.file}:${w.line} ${w.fn} now hands back the answer: move it from BAD_WRAPPERS to WRAPPERS.`); }
    else if (w.passes) bad.push(`${w.file}:${w.line} ${w.fn} is a new wrapper that hands back the answer: add it to WRAPPERS.`);
    else bad.push(`${w.file}:${w.line} ${w.fn} is a new wrapper that loses the alert's answer (${w.why}): return the inner call's answer.`);
  }
  for (const k of [...ok, ...badList]) if (!found.has(k)) bad.push(`stale: ${k} is no longer a wrapper here; remove it from its list.`);
  assert.deepEqual(bad, []);
});

// ---- 3. stand-ins ----

test('every test alert stand-in is fakeAlert(), or is on the shrink list (L130)', () => {
  const bad = [];
  const seen = new Set();
  for (const f of TESTS) {
    const s = standIns(f.src);
    if (!s.length) continue;
    seen.add(f.rel);
    const e = STANDINS[f.rel];
    const where = s.map((x) => `${f.rel}:${x.line}: ${x.text.slice(0, 100)}`).join('\n  ');
    if (!e) bad.push(`new alert stand-in, use fakeAlert() from orchestrate/test/fake-alert.test-helper.mjs:\n  ${where}`);
    else if (s.length > e.count) bad.push(`${f.rel}: ${s.length} stand-ins, list says ${e.count}; a new one must be fakeAlert():\n  ${where}`);
    else if (s.length < e.count) bad.push(`${f.rel}: ${s.length} stand-ins left, list says ${e.count}; cut its count to ${s.length} in STANDINS.`);
  }
  for (const [file, e] of Object.entries(STANDINS)) if (!seen.has(file)) bad.push(`stale: ${file} has no stand-in left; remove it from STANDINS (owner ${e.owner}).`);
  assert.deepEqual(bad, []);
});

// ---- 4. silent defaults ----

test('no production alert answers nothing (a silent default), beyond the shrink list', () => {
  const bad = [];
  const hit = new Set();
  for (const f of PROD) for (const s of silentDefaults(f.src)) {
    const e = SILENT.find((x) => x.file === f.rel && s.text.includes(x.has));
    if (e) hit.add(e);
    else bad.push(`${f.rel}:${s.line}: ${s.text.slice(0, 120)}\n  An alert that answers nothing counts as sent under !== false: make the alert required, or default to one that answers false.`);
  }
  for (const e of SILENT) if (!hit.has(e)) bad.push(`stale: ${e.file} "${e.has}" is gone; remove it from SILENT.`);
  assert.deepEqual(bad, []);
});

// ---- the lists only shrink ----

test('the shrink-only lists never grow, and every entry names an owner and a PR', () => {
  assert.ok(SITES.length <= PIN.sites, `SITES has ${SITES.length} entries; it may only shrink (pin ${PIN.sites})`);
  assert.ok(SITES.reduce((a, e) => a + e.n, 0) <= PIN.siteCalls, 'SITES counts may only shrink');
  assert.ok(BAD_WRAPPERS.length <= PIN.badWrappers, 'BAD_WRAPPERS may only shrink');
  assert.ok(Object.keys(STANDINS).length <= PIN.standinFiles, 'STANDINS may only shrink');
  assert.ok(Object.values(STANDINS).reduce((a, e) => a + e.count, 0) <= PIN.standinLines, 'STANDINS counts may only shrink');
  assert.ok(SILENT.length <= PIN.silent, 'SILENT may only shrink');
  const OWNERS = ['lane 1', 'lane 2', 'lane 3', 'lane 4'];
  for (const e of [...SITES, ...BAD_WRAPPERS, ...Object.values(STANDINS), ...SILENT]) {
    assert.ok(OWNERS.includes(e.owner), `owner must be one of ${OWNERS.join(', ')}: ${JSON.stringify(e)}`);
    assert.match(e.pr, /^(#\d+|none yet)$/, `pr must be "#N" or "none yet": ${JSON.stringify(e)}`);
  }
  assert.equal(new Set(SITES.map((e) => `${e.file} ${e.fn}`)).size, SITES.length, 'one SITES entry per function');
});

// ---- 5. controls: each planted form is caught, the allowed forms are not ----

const sites = (src) => alertSites(src).map((s) => s.why);
test('controls: the scan catches an ignored answer next to a write', () => {
  assert.equal(sites('function a(rec) { alert("x"); note(rec, "told the owner"); }').length, 1, 'a bare alert, then a note');
  assert.equal(sites('function a(rec) { waitOn(rec, "c", {}); alert("x"); }').length, 1, 'a card waits on Joe, then a bare alert');
  assert.equal(sites('function a() { alert("x"); return { ok: false, told: true }; }').length, 1, 'told: true after an ignored alert');
  assert.equal(sites('function a(s) { if (s.bad) alert("x"); s.sent = true; }').length, 1, 'sent = true after a braceless if');
  assert.equal(sites('function a(r) { if (r.ok) { step(); alert("x"); } }\nconst r = rec.write(x);').length, 0, 'no write near it');
  assert.equal(sites('function a(rec) { const r = rec.write(x); if (r.ok) { step(); alert("x"); } }').length, 1, 'inside a branch taken on a write that went through');
  assert.equal(sites('function a(ctx) { ctx.alert?.({ kind: "k" }); writeFileSync(f, "{}"); }').length, 1, 'an optional member call, then a state file');
  assert.equal(sites('function a(store, tx) { store.alert({ t: 1 }); tx.markSeen(k, "alerted"); }').length, 1, 'store.alert, then markSeen');
  assert.equal(sites('function a(p) { try { alert("x"); } catch { } put(p); }').length, 1, 'an alert in a try, then a put');
  const L133 = 'function closeX(ctx) { const c = ctx.gh.patch(); if (c.status !== 200) ctx.alert({ t: 1 }); }\nfunction run(ctx, a) { if (write(ctx, a)) closeX(ctx); }';
  assert.deepEqual(alertSites(L133).map((x) => [x.fn, x.call]), [['run', 'closeX']], 'a state written, then a function that drops its alert (L133)');
  assert.equal(sites('function closeX(ctx) { if (bad) ctx.alert({ t: 1 }); return false; }\nfunction run(ctx, a) { if (write(ctx, a)) closeX(ctx); }').length, 0, 'a function that answers something is not a carrier');
  assert.equal(sites('function push(ctx) { if (!ctx.push) ctx.alert({ t: 1 }); }\nfunction w(events, e) { put(e); events.push(e); }').length, 0, 'a member call with the same name is not the carrier');
});
test('controls: the two allowed forms, and a failure report, pass', () => {
  assert.equal(sites('function a(rec) { tellThen(alert, "x", { fact: "f" }); note(rec, "y"); }').length, 0, 'tellThen');
  assert.equal(sites('function a(rec) { if (alert("x") !== false) { note(rec, "told"); waitOn(rec, "c", {}); } }').length, 0, 'if (alert(...) !== false) { ... }');
  assert.equal(sites('function a(rec) { const r = rec.write(x); if (!r.ok) alert("refused"); }').length, 0, 'the alert reports the write that failed');
  assert.equal(sites('function a(rec) { const r = rec.write(x); if (r.ok) step(); else alert("refused"); }').length, 0, 'the same, in an else');
  assert.equal(sites('function a() { const t = "alert(x); note(y)"; /* alert(); note() */ }').length, 0, 'words in a string or comment');
});
test('controls: a wrapper must hand back the inner answer', () => {
  const w = (src) => wrappers(src).map((x) => [x.fn, x.passes]);
  assert.deepEqual(w('function safeAlert(ctx, a) { try { ctx.alert(a); return true; } catch { return false; } }'), [['safeAlert', false]]);
  assert.deepEqual(w('function safeAlert(ctx, a) { try { return ctx.alert(a); } catch { return false; } }'), [['safeAlert', true]]);
  assert.deepEqual(w('const say = (e) => alert({ at: 1, ...e });'), [['say', true]]);
  assert.deepEqual(w('const say = (e) => { try { alert(e); } catch { } };'), [['say', false]]);
  assert.deepEqual(w('const textAlerts = (alert, who) => (e) => alert(`${who}: ${e}`);'), [['textAlerts', true]]);
  assert.deepEqual(w('export function tellThen(alert, text, mark) { return alert(text, { mark }); }'), [['tellThen', true]]);
});
test('controls: a stand-in not made by fakeAlert() is seen; fakeAlert() is not', () => {
  const n = (src) => standIns(src).length;
  assert.equal(n('run({ alert: () => {} });'), 1);
  assert.equal(n('run({ alert: (a) => alerts.push(a) });'), 1);
  assert.equal(n('const alert = (t) => sent.push(t);'), 1);
  assert.equal(n('run({ ...a, alert: a.alert ?? (() => {}) });'), 1);
  assert.equal(n('writeFileSync(f, `export const ports = { alert: () => {} };`);'), 1, 'inside a template a test writes out');
  assert.equal(n('run({ alert: fakeAlert({ answer: false }) });'), 0);
  assert.equal(n('// alert: () => {} was the old way'), 0);
  assert.equal(silentDefaults('export function f({ alert = () => {} }) {}').length, 1);
  assert.equal(silentDefaults('export function f({ alert }) {}').length, 0);
});

// ---- fakeAlert itself ----

test('fakeAlert answers what it is told, records every call, and can throw', () => {
  const yes = fakeAlert();
  assert.equal(yes('a', { mark: 1 }), true);
  assert.deepEqual(yes.calls, [['a', { mark: 1 }]]);
  assert.deepEqual(yes.texts, ['a']);
  const no = fakeAlert({ answer: false });
  assert.equal(no('b'), false);
  assert.deepEqual(no.answers, [false]);
  const second = fakeAlert({ answer: (text, n) => n !== 1 });
  assert.deepEqual([second('x'), second('y'), second('z')], [true, false, true]);
  const down = fakeAlert({ throws: new Error('down') });
  assert.throws(() => down('c'), /down/);
  assert.deepEqual(down.texts, ['c']);
  assert.deepEqual(down.answers, ['threw']);
  const first = fakeAlert({ throws: (text, n) => n === 0 && 'first one down' });
  assert.throws(() => first('d'), /first one down/);
  assert.equal(first('e'), true);
  first.reset();
  assert.deepEqual([first.calls, first.texts, first.answers], [[], [], []]);
});
