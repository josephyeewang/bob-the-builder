// fake-alert.test-helper.mjs — the one alert stand-in every test uses (lead call L130).
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
//
// alert.calls is every call's arguments as an array ([text, opts]); alert.texts is each call's first argument (the text,
// or the alert object), so `alert.texts` reads like the old `alerts` array. alert.answers is what each call answered
// ('threw' for a throw). alert.reset() empties all three.
//
// Proof hooks (L143 M-2; alert-inventory.test.mjs sets them, a test never does):
//   FAKE_ALERT_LOG=<file>   each call appends one JSON line: what it answered ('false', 'threw' or 'other') and the
//                           calling code's stack frames ({ fn, file }), so the inventory test can see that a "tested"
//                           entry's own function reached a fake that answered false, and one that threw.
//   FAKE_ALERT_FLIP=false   an answer of false becomes true;   FAKE_ALERT_FLIP=throws   a throw becomes an answer of
//                           true. A test that still passes with a flip never depended on the lost alert.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
function logCall(outcome) {
  const to = process.env.FAKE_ALERT_LOG;
  if (!to) return;
  appendFileSync(to, `${JSON.stringify({ outcome, frames: framesHere() })}\n`);
}

export function fakeAlert({ answer = true, throws = null } = {}) {
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
      if (process.env.FAKE_ALERT_FLIP === 'throws') { answers.push(true); return true; }
      answers.push('threw');
      throw boom instanceof Error ? boom : new Error(typeof boom === 'string' ? boom : 'the alert could not be sent');
    }
    const a = typeof answer === 'function' ? answer(args[0], n, args) : answer;
    logCall(a === false ? 'false' : 'other');
    if (a === false && process.env.FAKE_ALERT_FLIP === 'false') { answers.push(true); return true; }
    answers.push(a);
    return a;
  };
  alert.calls = calls;
  alert.texts = texts;
  alert.answers = answers;
  alert.reset = () => { calls.length = 0; texts.length = 0; answers.length = 0; };
  alert.fake = true;
  return alert;
}
