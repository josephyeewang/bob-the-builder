// go.test.mjs — the owner's go on a draft card already in the Record, by its id (Track A step 9).
// Run: node --test orchestrate/setup/go.test.mjs
//
// The same M2 world as go-card.test.mjs: a real Record, the real go ask and go record, a fake GitHub for the plan view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { env, PRODUCT, must } from '../modules/M2-approvals/fixtures.test-helper.mjs';
import { leadCard, product } from '../modules/M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from '../modules/M2-approvals/fixtures/fake-github.mjs';
import { makeGitView } from '../modules/M10-rules/git-view.mjs';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { doneBar } from '../modules/M2-approvals/go.mjs';
import { OWNER_COMMAND } from '../modules/M2-approvals/owner-command.mjs';
import { planGoPass } from '../modules/M11-dispatcher/plan-go.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { canonicalJson } from '../shared/plan-fingerprint.mjs';
import { RUN_AS } from './go-card.mjs';
import { USAGE, goById, main } from './go.mjs';

const ROWS = { 'R-1': { id: 'R-1', what: 'row R-1', module: 'M1', tier: 2, done_when: 'tests pass for R-1', status: 'planned' } };
const FILES = ['src/a.mjs', 'docs/blueprint/rows/R-1.yaml'];
const OWNER = 501;
const BRIEF = Object.freeze({ goal: 'Add the first thing.', done_when: 'tests pass for R-1', files: FILES, not_in_scope: 'Any other file.' });
const DOC = Object.freeze({ state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', tier: 2, what: 'add the first thing', files: FILES, brief: BRIEF, done_when: doneBar(ROWS) });
const RULES = { 'caps.rounds': 3, 'product_state_rules.active.start': 'within_caps', 'product_state_rules.paused.start': 'none' };
const sha = (s) => createHash('sha256').update(s).digest('hex');

function world({ testProduct = 'true', doc = DOC } = {}) {
  const t = env({ values: { ...RULES, ...(testProduct === undefined ? {} : { 'product.test_product': testProduct }) } });
  product(t);
  const g = fakeGitHub({ now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one', 'docs/blueprint/rows/R-1.yaml': 'id: R-1\n' });
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const w = { t, M0, view: makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' }), shown: [], rows: ROWS };
  w.readRows = async () => w.rows;
  w.yes = ({ cardId, text }) => { w.shown.push(text); return { ok: true, cardId }; };
  // The draft card the Lead's roadmap made, already in the Record: no card file anywhere.
  if (doc) { const { state: _s, product: _p, kind: _k, ...fields } = doc; leadCard(t, 'C-9', fields); }
  return w;
}
const go = (w, over = {}) => goById({ ctx: w.t.ctx, cardId: 'C-9', sudoUid: OWNER, readRows: w.readRows, view: w.view, mainSha: w.M0, confirm: w.yes, ...over });
const asks = (w) => askStore(w.t.record).asks();

test('step 9: `go C-9` gives the go on the draft card in the Record, by owner command, with no card file, and the Dispatcher then moves it to ready', async () => {
  const w = world();
  const rev = w.t.record.meta('card', 'C-9').rev;
  const r = await go(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.card, 'C-9');
  assert.equal(w.t.record.meta('card', 'C-9').rev, rev, 'the card itself is not written again');
  const g = askStore(w.t.record).go('go-C-9').doc;
  assert.equal(g.binding.kind, OWNER_COMMAND);
  assert.equal(g.binding.sudo_uid, OWNER);
  assert.equal(g.binding.card_json_sha256, sha(canonicalJson(DOC)), 'the sha256 of the card as the Record holds it');
  assert.equal(g.plan_fingerprint, r.fingerprint);
  // The owner saw the card's files, its pass test and the fingerprint before retyping the id.
  assert.equal(w.shown.length, 1);
  for (const f of FILES) assert.ok(w.shown[0].includes(f), f);
  assert.ok(w.shown[0].includes(r.fingerprint));
  must(await planGoPass(w.t.ctx, { startPlanReview: async () => ({ ok: false, reason: 'not here' }), planReviewAnswer: async () => ({ ok: false, reason: 'not here' }),
    planRows: async () => ROWS, planView: async () => w.view, mainSha: async () => w.M0, replyToLead: async () => ({ ok: true }), alert: outbox(w.t.record, w.t.clock.t) }));
  assert.equal(w.t.record.read('card', 'C-9').doc.state, 'ready');
  assert.match((await go(w)).reason, /C-9 is ready; a go is given on a draft card/);
});

test('step 9: refused with no go asked or given — no such card, a bad id, not the test product, a pass test that changed, a card the runner can\'t start, no retyped id', async () => {
  const cases = [
    [{}, { cardId: 'C-404' }, /there is no card C-404/],
    [{}, { cardId: '../C-9' }, /not a card id/],
    [{ testProduct: 'false' }, {}, /test product/],
    [{}, { readRows: async () => ({ 'R-1': { ...ROWS['R-1'], done_when: 'something else' } }) }, /pass test is not its rows' at main any more/],
    [{ doc: { ...DOC, brief: 'just do it' } }, {}, /the runner could not give this card to a worker/],
    [{}, { confirm: () => ({ ok: false, reason: 'the card id was not retyped' }) }, /not retyped/],
  ];
  for (const [opts, over, why] of cases) {
    const w = world(opts);
    const r = await go(w, over);
    assert.equal(r.ok, false, String(why));
    assert.match(r.reason, why);
    assert.equal(askStore(w.t.record).go('go-C-9'), null, `no go: ${why}`);
    if (!over.confirm) assert.equal(asks(w).length, 0, `no ask: ${why}`);
  }
});

test('step 9: the command names its use, and runs only through sudo as the Dispatcher\'s user', async () => {
  const said = [];
  assert.equal(await main([], { log: (s) => said.push(s) }), 1);
  assert.equal(said.pop(), `go: usage: ${USAGE}`);
  assert.match(USAGE, new RegExp(`^sudo -k -u ${RUN_AS} `));
});
