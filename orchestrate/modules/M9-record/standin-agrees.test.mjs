// standin-agrees.test.mjs — the shared/record.mjs memory stand-in's applyOutbox against the real M9 applyOutbox,
// for every outbox kind × every AI role, plus names that break OUTBOX_NAME (LEAD-CALLS L129 M-1).
//
// The stand-in reads only a file's name and the tag, never the file, so it must agree with the real Record on the
// reasons that need nothing more: no outbox kind for the name, a kind not listed for the role, a kind with no record
// rule yet. Where the real Record refuses on what the file says or who owns it, the stand-in may accept; that is the
// only allowed difference, and the test counts it so a stand-in that drifts the other way (refusing what the real
// one takes) fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, outboxFile } from './fixtures.test-helper.mjs';
import { memoryRecord, OUTBOX_KINDS, AI_ROLES } from '../../shared/record.mjs';

const NAME_REASONS = /^(no outbox kind for file name|outbox kind \S+ is not listed for|outbox kind \S+ has no record rule yet|not_a_record$)/;
const EXTRA = ['notakind-X1.md', 'report-.md', 'REPORT-X1.md', 'report-X.1.md', 'report-X1.MD', 'report-X1.md.txt',
  'report_X1.md', 'report-X1', 'report-é.md', 'verdict-compact-S1.md'];

test('L129 M-1: the stand-in and the real applyOutbox agree on every name and role reason, case for case', () => {
  const env = setup({ prefix: 'm9-standin-' });
  const fake = memoryRecord();
  let n = 0;
  let cases = 0;
  let nameRefusals = 0;
  const wrong = [];
  for (const role of AI_ROLES) {
    const sid = `S${role.length}x${role.replace(/_/g, '')}`;
    const names = [...Object.keys(OUTBOX_KINDS).flatMap((k) => [`${k}X${++n}.md`, `${k}X${++n}.json`, `${k}compact-X${++n}.md`]), ...EXTRA];
    for (const name of names) {
      const p = outboxFile(env, role, sid, name, 'plain text body\n');
      const tag = { role, sessionId: sid, card: 'C-1' };
      const real = env.record.applyOutbox(tag, p);
      const f = fake.applyOutbox(tag, p);
      cases += 1;
      const realByName = !real.ok && NAME_REASONS.test(real.reason);
      if (realByName) {
        nameRefusals += 1;
        if (f.ok || f.reason !== real.reason) wrong.push(`${role} ${name}: real refused "${real.reason}", stand-in ${f.ok ? 'accepted' : `refused "${f.reason}"`}`);
      } else if (!f.ok) {
        wrong.push(`${role} ${name}: stand-in refused "${f.reason}", real ${real.ok ? 'accepted' : `refused on content "${real.reason}"`}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} disagreements`);
  // The loop must really have covered the cases the audit found (589 name/role refusals the old stand-in accepted).
  assert.ok(cases >= AI_ROLES.length * (Object.keys(OUTBOX_KINDS).length * 3 + EXTRA.length), `${cases} cases`);
  assert.ok(nameRefusals >= 589, `only ${nameRefusals} name/role refusals were exercised`);
});
