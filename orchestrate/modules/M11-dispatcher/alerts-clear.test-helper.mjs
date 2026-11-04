// The second process in alerts-race.test.mjs's M-1 test (L335, L341): it opens the same store on disk as a separate
// node process and does one step of a clear site on one cause: 'clear' (the clear write: told false) or 'drop'
// (dropCause on the alert queue). The test runs the two steps at separate moments, in either order.
//   node alerts-clear.test-helper.mjs <store root> <fact> <clear|drop> <now ms>
import { openRecordWithStore } from '../M9-record/writer.mjs';
import { PRODUCT, UID, rulesFor } from '../M9-record/rules.test-helper.mjs';
import { dropCause } from './alerts.mjs';

const [root, fact, step, nowMs] = process.argv.slice(2);
const { record: rec } = openRecordWithStore({ root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), now: () => Number(nowMs), host: 'mac-a' });
if (step === 'drop') {
  if (dropCause(rec, fact) !== true) throw new Error('dropCause did not write the queue');
} else if (step === 'clear') {
  let done = false;
  for (let i = 0; i < 5 && !done; i += 1) {
    const cur = rec.read('fact', fact);
    done = rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: cur?.rev ?? 0, doc: { ...(cur?.doc ?? {}), told: false, cleared: true }, kind: 'step_ok' })?.ok === true;
  }
  if (!done) throw new Error('the clear write kept failing');
} else throw new Error(`no step ${step}`);
