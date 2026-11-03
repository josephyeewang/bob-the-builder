// undo-lane.test.mjs — L199 (2): the undo card M11's real undo step writes passes the first cutover's docs lane,
// asked the way the Merge Gate asks it. The lane takes only a change whose card declares Tier 2 (M10 lane-check.mjs),
// and M6 README says the Dispatcher declares the undo card Tier 2, so undo.mjs writes it (UNDO_TIER). No test here
// hands the card its tier: the card is written by undoStep, the facts are M6's real gatherFacts, and the lane is M10's
// real engine on the sample rules text. The fakes are GitHub (M6's fake-gate-github.mjs) and the mirror's file list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesFromText } from '../M10-rules/from-text.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { setup, seed, product, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';
import { gatherFacts } from '../M6-merge-gate/gather.mjs';
import { fakeGateGitHub } from '../M6-merge-gate/fixtures/fake-gate-github.mjs';
import { undoStep, UNDO_CARD, UNDO_TIER } from './undo.mjs';
import { outbox } from './alerts.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { undoEntries, UNDO_ASK, T0 } from './fixtures.test-helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// M10's sample rules, plus the one line of the first cutover's rules an undo needs: an undo card needs no go. (The
// whole first-cutover entry is M10's fixture, first-cutover.test.mjs; this test does not copy it.)
const SAMPLE = `${readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8')}
approvals:
  plan_go:
    go_free:
      exact_reverse: true
`;
const DOC = 'docs/research/note.md';
const OWNER = 'sample-org';
const REPO = 'sample-app';

// A docs change the gate merged (its commit on main), Joe's answered Undo tap on it, and the undo pull request.
async function undoWorld() {
  const g = fakeGateGitHub({ owner: OWNER, repo: REPO });
  const before = g.commit([], { [DOC]: 'one' });
  const merged = g.commit([before], { [DOC]: 'two' }, { from: before });
  g.main = merged;
  let env = null;
  const rules = rulesFromText({ [PRODUCT]: SAMPLE }, { productState: (p) => env?.record.read('product', p)?.doc ?? null, clock: () => env?.clock.t ?? T0 });
  env = setup({ prefix: 'm11-undo-lane-', extra: { rules } });
  env.clock.t = T0;
  product(env, 'active');
  // M11's undo fixtures up to the tap (the merged card, its merge, the answered ask), on the fake repo's merge
  // commit; the undo card itself is written below by the real undo step, never seeded.
  const before3 = undoEntries('U1', {}, { product: PRODUCT, files: [DOC], pr: 7 }).slice(0, 3);
  assert.deepEqual(before3.map(([e]) => e), ['card', 'merge', 'ask'], 'the undo fixture changed shape');
  for (const [entity, id, doc] of before3) seed(env, entity, id, doc.merge_commit ? { ...doc, merge_commit: merged } : doc);
  const out = await undoStep({ rec: env.record, rules, now: T0, filesOf: (sha) => (sha === merged ? [DOC] : null), alert: outbox(env.record, T0) });
  const id = UNDO_CARD(UNDO_ASK('U1'));
  assert.deepEqual(out, [[UNDO_ASK('U1'), 'undo card written']]);
  // The undo pull request: main with the docs change put back.
  const head = g.commit([merged], { [DOC]: 'one' }, { from: merged });
  g.openPull({ number: 8, head, files: { [DOC]: 'one' } });
  const ctx = { record: env.record, rules, product: PRODUCT, gh: g.gh, owner: OWNER, repo: REPO, view: makeGitView({ gh: g.gh, owner: OWNER, repo: REPO }),
    now: () => env.clock.t, alert: fakeAlert(), readFact: () => null };
  return { env, rules, ctx, id };
}

const lane = (ctx, card) => gatherFacts(ctx, { id: `M-${card}`, doc: { card, pr: 8 } });

test('L199: the undo card the real undo step writes declares Tier 2 and passes the docs lane through M6\'s real gather', async () => {
  const w = await undoWorld();
  const card = w.env.record.read('card', w.id).doc;
  assert.equal(card.kind, 'exact_reverse');
  assert.equal(card.tier, UNDO_TIER);
  assert.equal(UNDO_TIER, 2);
  const f = await lane(w.ctx, w.id);
  assert.deepEqual(f.files?.map((x) => x.path), [DOC], 'the gate read the change');
  assert.equal(f.lane?.decision, 'allow', `the docs lane refuses the undo: ${f.lane?.reason}`);
  assert.equal(f.exactReverse, true, 'M6 judged the pull request the exact reverse');
  assert.equal(f.lane.reason, 'exact reverse of a docs-lane change');
  // Control: the same card with no tier is refused by the same lane, for the tier.
  const { tier, ...untiered } = card;
  assert.equal(tier, 2);
  seed(w.env, 'card', 'U-no-tier', untiered);
  const g = await lane(w.ctx, 'U-no-tier');
  assert.notEqual(g.lane?.decision, 'allow');
  assert.match(g.lane?.reason ?? '', /not declared Tier 2/);
});
