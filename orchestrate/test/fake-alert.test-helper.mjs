// fake-alert.test-helper.mjs — the one alert stand-in every test uses (lead call L130), and the one wrapper contract
// every alert wrapper is held to (lead call L155, assertWrapperContract below).
//
// An alert can be lost: the real outbox answers false when its queue write is refused, and a thrown error counts as
// false too. A stand-in that can only succeed (`() => {}` answers undefined, `(a) => alerts.push(a)` answers a number)
// never runs the lost-alert path, so a step that marks "told" after a lost alert passes every test. This one can answer
// false, and alert-answer.test.mjs fails on any other stand-in.
//
//   const alert = fakeAlert();                          // answers true; alert.calls holds what it was handed
//   const alert = fakeAlert({ answer: false });         // every alert is lost
//   const alert = fakeAlert({ answer: (text, n) => n !== 1 });   // a function of what it was handed and the call's number (0-based)
//   const alert = fakeAlert({ throws: new Error('down') });      // throws (an Error, or a string made into one)
//   const alert = fakeAlert({ throws: (text, n) => n === 0 && 'first one down' });   // throws when this answers truthy
//   const alert = fakeAlert({ rejects: new Error('down'), delay: 20 });   // answers a promise that rejects after 20 ms
//
// alert.calls is every call's arguments as an array ([text, opts]); alert.texts is each call's first argument (the text,
// or the alert object), so `alert.texts` reads like the old `alerts` array. alert.answers is what each call answered
// ('threw' for a throw, 'rejected' for a rejection). alert.reset() empties all three.
//
// Proof runs (L143 M-2, L155; alert-inventory.test.mjs starts them, a test never does). The inventory runs a proof test
// three times with two settings, which this file reads once when it loads and then removes from the process, so the
// test itself cannot see them:
//   FAKE_ALERT_LOG   each call appends one line: what it answered ('false', 'threw', 'rejected' or 'other'), whether it
//                    ran inside assertWrapperContract, and the calling code's stack frames ({ fn, file, line }), so
//                    the inventory can see that an entry's own call line reached a fake that answered false, and one
//                    that threw;
//   FAKE_ALERT_FLIP  'false' turns an answer of false into true; 'throws' turns a throw or a rejection into an answer of
//                    true. A proof test must fail under each flip, by an assertion (L155 item 3).
// In a proof run, reading .calls, .texts or .answers throws (L155 item 3): a proof rests on what the code did, never on
// the fake's own record, which a flip changes along with the answer.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

const LOG_VAR = 'FAKE_ALERT_LOG';
const FLIP_VAR = 'FAKE_ALERT_FLIP';
const PROOF = Object.freeze({ log: process.env[LOG_VAR] || null, flip: process.env[FLIP_VAR] || null });
delete process.env[LOG_VAR];
delete process.env[FLIP_VAR];
let inContract = 0;

function framesHere() {
  const was = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = was;
  return stack.split('\n').slice(2).flatMap((l) => {
    const x = /^\s*at (?:async )?(?:(.*?) \()?(.*?):(\d+)(?::\d+)?\)?$/.exec(l);
    if (!x) return [];
    let file = x[2];
    if (file.startsWith('file://')) { try { file = fileURLToPath(file); } catch { /* keep it */ } }
    const fn = (x[1] ?? '').replace(/^new /, '').replace(/ \[as [^\]]+\]$/, '').split('.').pop();
    return [{ fn, file, line: Number(x[3]) }];
  });
}
function logLine(o) { if (PROOF.log) appendFileSync(PROOF.log, `${JSON.stringify(o)}\n`); }
function logCall(outcome) { if (PROOF.log) logLine({ outcome, inContract: inContract > 0, frames: framesHere() }); }
const asError = (boom) => (boom instanceof Error ? boom : new Error(typeof boom === 'string' ? boom : 'the alert could not be sent'));

export function fakeAlert({ answer = true, throws = null, rejects = null, delay = 20 } = {}) {
  const calls = [];
  const texts = [];
  const answers = [];
  const alert = (...args) => {
    const n = calls.length;
    calls.push(args);
    texts.push(args[0]);
    const boom = typeof throws === 'function' ? throws(args[0], n, args) : throws;
    if (boom) {
      logCall('threw');
      if (PROOF.flip === 'throws') { answers.push(true); return true; }
      answers.push('threw');
      throw asError(boom);
    }
    const late = typeof rejects === 'function' ? rejects(args[0], n, args) : rejects;
    if (late) {
      logCall('rejected');
      if (PROOF.flip === 'throws') { answers.push(true); return new Promise((ok) => { setTimeout(() => ok(true), delay); }); }
      answers.push('rejected');
      // Marked handled here, so a wrapper that drops the promise is caught by its answer, not by a crash after the test.
      const p = new Promise((ok, no) => { setTimeout(() => no(asError(late)), delay); });
      p.catch(() => {});
      return p;
    }
    const a = typeof answer === 'function' ? answer(args[0], n, args) : answer;
    logCall(a === false ? 'false' : 'other');
    if (a === false && PROOF.flip === 'false') { answers.push(true); return true; }
    answers.push(a);
    return a;
  };
  const record = (name, value) => {
    Object.defineProperty(alert, name, {
      enumerable: true,
      get() {
        if (PROOF.log) throw new Error(`fakeAlert: a proof run may not read the fake's own record (.${name}); assert on what the code did (L155)`);
        return value;
      },
    });
  };
  record('calls', calls);
  record('texts', texts);
  record('answers', answers);
  alert.reset = () => { calls.length = 0; texts.length = 0; answers.length = 0; };
  alert.fake = true;
  return alert;
}

/**
 * The wrapper contract (L155 item 1). A wrapper is listed as "passes" only when its contract_test calls this, and a
 * proof run sees it finish. `setup(alert)` builds a fresh world around the fake it is handed, runs the wrapper once with
 * that fake as its alert port, and hands back what the wrapper answered (for a wrapper that lives inside another
 * function, what the wrapper answered as seen from outside: say, false when the thing it kept is raised again next
 * pass). `wrapper` is the wrapper itself, or the function that holds it; it only names the contract.
 *
 * Four runs, one fresh world each:
 *   the alert answers false                  the wrapper must answer === false
 *   the alert throws                         the wrapper must answer === false
 *   the alert rejects after a delay          the wrapper must answer === false
 *   the alert goes out (answers `sent`)      the wrapper must answer !== false
 * `rethrows: true` holds a wrapper whose contract (a lead call, the list's `rethrows` field) is to hand a throw back as
 * a throw: under it, the throw and the rejection must come back out as the very same error, never as any answer.
 * `sent` is what the port answers when the alert goes out (true; an issue number for a GitHub open).
 */
export async function assertWrapperContract(wrapper, setup, { rethrows = false, sent = true, delay = 20 } = {}) {
  const name = typeof wrapper === 'function' ? (wrapper.name || 'the wrapper') : String(wrapper);
  assert.equal(typeof setup, 'function', 'assertWrapperContract(wrapper, setup): setup(alert) runs the wrapper once and hands back its answer');
  const run = async (alert) => { try { return { answer: await setup(alert) }; } catch (e) { return { threw: e }; } };
  const said = (r) => ('threw' in r ? `it threw (${r.threw?.message ?? r.threw})` : `it answered ${inspect(r.answer)}`);
  inContract += 1;
  let ok = false;
  try {
    const lost = await run(fakeAlert({ answer: false }));
    assert.ok(!('threw' in lost) && lost.answer === false, `${name}: when the alert answers false, the wrapper must answer false; ${said(lost)}`);
    for (const [how, make] of [['throws', (e) => fakeAlert({ throws: e })], ['rejects after a delay', (e) => fakeAlert({ rejects: e, delay })]]) {
      const boom = new Error(`assertWrapperContract: the alert ${how}`);
      const r = await run(make(boom));
      if (rethrows) assert.ok('threw' in r && r.threw === boom, `${name}: when the alert ${how}, the wrapper must throw that same error (rethrows); ${said(r)}`);
      else assert.ok(!('threw' in r) && r.answer === false, `${name}: when the alert ${how}, the wrapper must answer false; ${said(r)}`);
    }
    const out = await run(fakeAlert({ answer: sent }));
    assert.ok(!('threw' in out) && out.answer !== false, `${name}: when the alert goes out, the wrapper must not answer false; ${said(out)}`);
    ok = true;
  } finally {
    inContract -= 1;
    logLine({ contract: name, ok, rethrows: !!rethrows });
  }
}
