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
import { alertSites, wrappers, standIns, losingStandIns, silentDefaults } from './alert-answer-scan.mjs';
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
