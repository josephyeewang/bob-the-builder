// L140 condition 3: the two passes that walk every report (research-ask.mjs openResearchAsks, undo-flag.mjs
// openUndoFlags) act only on ask-request- reports. Every other kind stored as a report (wish-, history-, request-,
// state-, idea-, check-, prune-, and the older report-, report-compact-, state-compact-) is passed over: not opened and
// not even refused. Each file below carries an undo or a research ask's own words, so a pass that dropped its kind filter would
// pick it up (and refuse it, or worse); the test fails on either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOX_KINDS } from '../../shared/record.mjs';
import { outboxFile as m9file } from '../M9-record/fixtures.test-helper.mjs';
import { env as m2env, must, PRODUCT } from './fixtures.test-helper.mjs';
import { openResearchAsks } from './research-ask.mjs';
import { openUndoFlags } from './undo-flag.mjs';

const OTHER_REPORT_KINDS = Object.entries(OUTBOX_KINDS).filter(([k, s]) => s.entity === 'report' && k !== 'ask-request-');
// Each kind is stored twice: once in an undo ask's words (undo-flag picks those up) and once in a research ask's
// (research-ask hands an undo claim to undo-flag, so only these would reach it).
const ASK_WORDS = [JSON.stringify({ ask: 'undo', product: PRODUCT, pr: 7, brief: 'undo the pricing change' }),
  JSON.stringify({ ask: 'research', product: PRODUCT, brief: 'find out x' })];

function storeAll(t) {
  let n = 0;
  for (const [k, spec] of OTHER_REPORT_KINDS) {
    for (const role of spec.roles) {
      for (const words of ASK_WORDS) {
        const sid = `I-${++n}`;
        must(t.record.applyOutbox({ role, sessionId: sid }, m9file(t, role, sid, `${k}x${n}.json`, words)), `${role} ${k}`);
      }
    }
  }
  return n;
}

test('L140: every report kind but ask-request- is listed, the new ones included (the test reads something)', () => {
  const kinds = OTHER_REPORT_KINDS.map(([k]) => k).sort();
  for (const k of ['wish-', 'history-', 'idea-', 'check-', 'prune-', 'report-']) assert.ok(kinds.includes(k), k);
  // request- and state- are refused until their consumers land (L151 M-1), so they are not stored reports.
  for (const k of ['request-', 'state-']) assert.ok(!kinds.includes(k), k);
});

test('L140 condition 3: the research-ask and undo passes pass over every report that is not an ask-request-', async () => {
  const t = m2env();
  const stored = storeAll(t);
  assert.equal(t.record.list('report').length, stored, 'every file is stored as a report');
  const r = openResearchAsks(t.ctx);
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.refused, [], 'a research pass that read these would refuse them');
  const u = await openUndoFlags(t.ctx, { entriesOf: async () => [], addedBy: async () => [] });
  assert.deepEqual(u.opened, []);
  assert.deepEqual(u.byHand, []);
  assert.deepEqual(u.refused, [], 'an undo pass that read these would refuse them');
  assert.equal(t.record.list('ask').length, 0);
});
