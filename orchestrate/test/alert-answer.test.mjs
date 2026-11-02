// alert-answer.test.mjs — lead call L130: an alert's answer is never ignored before something that says it went out.
//
// The rule: anything that marks "told", moves a card to wait on Joe, writes a note saying someone was told, records a
// state that stops a re-ask, or returns told / sent / alerted happens only after the alert answered something other
// than false (a thrown error counts as false), or the step is retried next pass (L133). The allowed forms:
//   tellThen(alert, text, mark)                         M11 alerts.mjs: the sender writes the mark once the alert is out
//   if (alert(...) !== false) { follow-up }             the follow-up sits inside the guard
// A wrapper (safeAlert, say, tellOnce and the like) hands back the inner call's answer, or tests it === false / !== false.
//
// L135: the gate is the inventory (alert-inventory.json, checked by alert-inventory.test.mjs), not this scan. The scan
// (alert-answer-scan.mjs) is a helper that suggests where to look: `node orchestrate/test/alert-inventory.mjs` prints
// its hints next to each new entry. Its wrapper, stand-in and silent-default checks run against the inventory's lists.
// This file holds the scan's controls (each planted form is caught, the allowed forms are not) and fakeAlert's own test.
//
// What the scan cannot see (it reads text, it is not a parser): an answer kept in a variable and not looked at, a
// `told` value carried to another file, an alert more than one call away, whether a step is retried next pass. The
// inventory lists those calls anyway; their status is a person's call.
// M11's alert-sites.test.mjs stays (L135): its L47 direct-send rule and r7 drop-cause rule are not this class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertSites, wrappers, standIns, losingStandIns, silentDefaults, probeSilent, isPlainRefusal } from './alert-answer-scan.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';

// ---- controls: each planted form is caught, the allowed forms are not ----

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
test('controls: the wider write list and the whole-function search (L135 item 3)', () => {
  for (const w of ['renameSync(a, b)', 'rmSync(p)', 'ftruncateSync(fd, 0)', 'appendFileSync(f, x)', 'seen.add(k)', 'store.set(k, v)', 'db.update(k, v)']) {
    assert.equal(sites(`function a(s) { alert("x"); ${w}; }`).length, 1, w);
  }
  const far = `function a(ctx, rec) {\n  ctx.alert({ t: 1 });\n${'  step();\n'.repeat(12)}  rec.write({ told: true });\n}`;
  assert.equal(sites(far).length, 0, 'twelve lines apart: past the window');
  assert.equal(alertSites(far, { wholeFn: true }).length, 1, 'the whole-function search sees it');
  const before = 'function a(ctx, rec) {\n  rec.write({ asked: true });\n  if (ctx.alert({ t: 1 }) !== false) step();\n}';
  assert.deepEqual(alertSites(before, { wholeFn: true }).map((x) => x.before), [true], 'a write before a guarded alert is a hint (L133)');
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
  assert.deepEqual(w('function safeAlert(ctx, f) { return (a) => { try { if (ctx.alert(a) === false) { f.n += 1; return false; } return true; } catch { f.n += 1; return false; } }; }'), [['safeAlert', true]], '#87 safeAlert: the answer tested === false (L135)');
  assert.deepEqual(w('function safeAlert(ctx, a) { try { if (ctx.alert(a) === false) return false; return true; } catch { return true; } }'), [['safeAlert', false]], 'a catch that answers true');
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
  for (const x of ['function alert(t) { sent.push(t); }', 'const sink = (a) => 1; run({ alert: sink });', 'run({ alert: mock.fn() });', 'ctx.alert = function (a) {};',
    'run({ alert: noop });', 'x({ alerts: { raise: async (a) => ({}) } });', 'const a = homeAlerts({ gh: fakeIssues() });', 'run({ notify: (e) => seen.push(e) });']) {
    assert.equal(n(x), 1, `L135 item 6: ${x}`);
  }
  assert.equal(n('run({ alert: () => false });'), 0, 'a stand-in that answers false already runs the lost path');
  assert.equal(n('run({ alert: () => { throw new Error("down"); } });'), 0, 'nor one that throws');
  assert.deepEqual(losingStandIns('run({ alert: () => false });'), [1], 'but the test names it, to move it to fakeAlert');
  assert.equal(n('run({ alert });'), 0, 'a port passed on');
  const d = (src) => silentDefaults(src).length;
  for (const x of ['export function f({ alert = () => {} }) {}', 'export function f({ alert = (t) => {} }) {}', 'export function f({ alert = () => undefined }) {}',
    'export function f({ alert = noop }) {}', 'export function f({ alert: tell = () => {} }) {}', 'const alert = ctx.alert ?? (() => {});', 'run({ alert: ctx.alert ?? noop });',
    'ctx.alert?.({ t: 1 });', 'alert?.("x");', 'run({ alert: (t) => log(t) });']) {
    assert.equal(d(x), 1, `L135 item 6: ${x}`);
  }
  assert.equal(d('export function f({ alert }) {}'), 0);
  assert.equal(d('if (alert(x) !== false) y();'), 0);
  // L143 rerun (the auditor's P15/P16): a default that answers a fixed "sent" is the same; one answering false is not.
  for (const x of ['const alert = ctx.alert ?? (() => true);', 'export function f({ alert = () => true }) {}', 'run({ alert: ctx.alert ?? Boolean });', 'const alert = ctx.alert ?? ((t) => 1);']) {
    assert.equal(d(x), 1, `L143: ${x}`);
  }
  assert.equal(d('const alert = ctx.alert ?? (() => false);'), 0);
  // L155 m1 (the auditor's N09-N11): decided by calling the default once in a sandbox, not by its spelling.
  for (const x of ['const alert = ctx.alert || (() => true);', 'const alert = ctx.alert || (() => {});', "const alert = ctx.alert ?? (() => 'sent');",
    'const alert = ctx.alert ?? function () { return true; };', 'const alert = ctx.alert ?? (() => !0);', 'const alert = ctx.alert ?? (async () => true);',
    'const quiet = () => 1;\nrun({ alert: ctx.alert ?? quiet });', 'function quiet() { return [] }\nrun({ alert: quiet });', 'run({ alert: console.log });',
    'export function f({ notifyOwner = () => true }) {}', 'run({ alert: (t) => { log(t); return "queued"; } });']) {
    assert.equal(d(x), 1, `L155 m1: ${x}`);
  }
  for (const x of ['const alert = ctx.alert ?? (() => { throw new Error("no alert port"); });',
    'run({ alert: (t) => outbox.send(t) });', 'run({ alert: tellIt });', 'const alerts = { raise };', 'this.notify = notify;']) {
    assert.equal(d(x), 0, `L155 m1, not silent: ${x}`);
  }
  // L170: these two were "not silent" under L155. An async default answers a promise, which a caller's !== false takes
  // as sent; and one that pushes the alert to a queue keeps it where no one reads, whatever it answers.
  for (const x of ['const alert = ctx.alert ?? (async () => false);', 'run({ alert: ctx.alert ?? ((t) => queue.push(t) && false) });']) {
    assert.equal(d(x), 1, `L170, now silent: ${x}`);
  }
  assert.match(silentDefaults("const alert = ctx.alert ?? (() => 'sent');")[0].why, /answers 'sent'/, 'it says what the default answered');
});

// L170 item 3: the r4 audit's S0-S6, defaults that answered false to the one call ('an alert', {}) the probe made.
const R4_SILENT = [
  ['S0', 'export function f({ rec, alert = () => true }) { alert({ type: "x" }); }', '() => true'],
  ['S1', "export function f({ rec, alert = (e) => (typeof e === 'string' ? false : true) }) { alert({ type: 'x' }); }", "(e) => (typeof e === 'string' ? false : true)"],
  ['S2', 'export function f({ rec, alert = ((n) => () => n++ > 0)(0) }) { alert({ type: "x" }); }', '((n) => () => n++ > 0)(0)'],
  ['S3', "const pending = [];\nexport function f(ctx) { const alert = ctx.alert ?? ((t) => pending.push(t)); alert({ type: 'x' }); }", '((t) => pending.push(t))'],
  ['S4', 'export function f({ rec, alert = () => ({ then() {} }) }) { if (alert({ type: "x" }) !== false) rec.push("told"); }', '() => ({ then() {} })'],
  ['S5', 'export function f({ rec, alert = () => new Promise(() => {}) }) { alert({ type: "x" }); }', '() => new Promise(() => {})'],
  ['S6', 'export function f({ rec, alert = (t, o) => Object.keys(o ?? { a: 1 }).length > 0 }) { alert({ type: "x" }); }', '(t, o) => Object.keys(o ?? { a: 1 }).length > 0'],
];
test('controls: a default is silent unless it is a plain arrow that answers false or throws; the probe sees shapes, counts, thenables and pushes (L170 item 3)', () => {
  const d = (src) => silentDefaults(src).length;
  for (const [id, src, expr] of R4_SILENT) {
    assert.equal(silentDefaults(src).length, 1, `${id}: ${expr}`);
    assert.ok(probeSilent(expr), `${id}: the probe alone catches it too, so a port in an object (wiring, not a default) is caught the same`);
    assert.equal(isPlainRefusal(expr), false, `${id}: and it is not a plain refusal`);
  }
  assert.match(silentDefaults(R4_SILENT[1][1])[0].why, /an alert object/, 'S1: says which shape');
  assert.match(silentDefaults(R4_SILENT[2][1])[0].why, /call 2 of 3/, 'S2: says which call');
  assert.match(silentDefaults(R4_SILENT[3][1])[0].why, /pending\.push/, 'S3: says what it touched');
  assert.match(silentDefaults(R4_SILENT[4][1])[0].why, /never settles/, 'S4');
  assert.match(silentDefaults(R4_SILENT[5][1])[0].why, /never settles/, 'S5');
  // The probe on its own (a port written in an object is judged by it alone).
  for (const x of ['run({ alert: (t) => { seen.last = t; return false; } });', 'run({ alert: (t) => { last = t; return false; } });',
    'run({ alert: async () => true });', 'run({ alert: () => Promise.resolve("sent") });', 'run({ alert: (t) => (t ? false : true) });']) {
    assert.equal(d(x), 1, `L170 probe: ${x}`);
  }
  for (const x of ['run({ alert: async () => false });', 'run({ alert: () => Promise.reject(new Error("down")) });', 'run({ alert: (t) => outbox.send(t) });']) {
    assert.equal(d(x), 0, `L170 probe, not silent in an object: ${x}`);
  }
  // The form rule: only a plain refusal passes as a default, a name included.
  for (const x of ['export function f({ alert = () => false }) {}', 'export function f({ alert = (t, o) => false }) {}', 'export function f({ alert = t => (false) }) {}',
    'export function f({ alert = (t) => { return false; } }) {}', "export function f({ alert = () => { throw new Error('no alert port'); } }) {}",
    'const alert = ctx.alert ?? (() => { throw new TypeError(); });', 'const alert = ctx.alert || ((() => false));']) {
    assert.equal(d(x), 0, `L170, a plain refusal: ${x}`);
  }
  for (const x of ['export function f({ alert = defaultAlert }) {}', 'const alert = ctx.alert ?? makeAlert(rec);', 'export function f({ alert = (t, x = q.push(t)) => false }) {}',
    "export function f({ alert = () => { throw new Error(`no ${q.push(1)}`); } }) {}", 'export function f({ alert = function () { return false; } }) {}',
    'export function f({ alert = async () => { throw new Error("x"); } }) {}', 'const alert = ctx.alert ?? ((t) => { log(t); return false; });']) {
    assert.equal(d(x), 1, `L170, not a plain refusal: ${x}`);
  }
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
