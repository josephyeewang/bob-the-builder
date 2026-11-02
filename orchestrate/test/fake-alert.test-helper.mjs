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
//   const alert = fakeAlert({ rejects: new Error('down'), delay: 20 });   // answers a promise that rejects after 20 ms
//   const alert = fakeAlert({ never: true });           // answers a promise that never settles (an alert that hangs)
//
// alert.calls is every call's arguments as an array ([text, opts]); alert.texts is each call's first argument (the text,
// or the alert object), so `alert.texts` reads like the old `alerts` array. alert.answers is what each call answered
// ('threw' for a throw, 'rejected' for a rejection, 'pending' for one that never settles). alert.reset() empties all
// three.
//
// L170: this is a stand-in, not a proof. The run-time proof that used it (its log and flip settings, stack frames) and
// assertWrapperContract were beaten by the r4 audit and are gone; a test that uses fakeAlert is an ordinary test, and
// no entry in alert-inventory.json passes because of one.
const asError = (boom) => (boom instanceof Error ? boom : new Error(typeof boom === 'string' ? boom : 'the alert could not be sent'));

export function fakeAlert({ answer = true, throws = null, rejects = null, never = false, delay = 20 } = {}) {
  const calls = [];
  const texts = [];
  const answers = [];
  const alert = (...args) => {
    const n = calls.length;
    calls.push(args);
    texts.push(args[0]);
    const boom = typeof throws === 'function' ? throws(args[0], n, args) : throws;
    if (boom) { answers.push('threw'); throw asError(boom); }
    const hang = typeof never === 'function' ? never(args[0], n, args) : never;
    if (hang) { answers.push('pending'); return new Promise(() => {}); }
    const late = typeof rejects === 'function' ? rejects(args[0], n, args) : rejects;
    if (late) {
      answers.push('rejected');
      // Marked handled here, so a wrapper that drops the promise is caught by its answer, not by a crash after the test.
      const p = new Promise((ok, no) => { setTimeout(() => no(asError(late)), delay); });
      p.catch(() => {});
      return p;
    }
    const a = typeof answer === 'function' ? answer(args[0], n, args) : answer;
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
