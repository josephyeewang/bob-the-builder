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
      answers.push('threw');
      throw boom instanceof Error ? boom : new Error(typeof boom === 'string' ? boom : 'the alert could not be sent');
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
