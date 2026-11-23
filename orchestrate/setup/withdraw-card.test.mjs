// withdraw-card.test.mjs — the owner withdraws a card the go command made (L1343): on a real Record, real M2 asks and
// gos, a card made by setup/go-card.mjs and moved to ready by the Dispatcher's own pass (R-S1-1's path), then withdrawn.
// Plus the plants: each refused by the command with nothing written, and, written straight to the Record as
// owner_command, by M9 itself (moves, permissions, writer).
// Run: node --test orchestrate/setup/withdraw-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { env, PRODUCT, must } from '../modules/M2-approvals/fixtures.test-helper.mjs';
import { product } from '../modules/M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from '../modules/M2-approvals/fixtures/fake-github.mjs';
import { makeGitView } from '../modules/M10-rules/git-view.mjs';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { raiseGo } from '../modules/M2-approvals/go.mjs';
import { planGoPass } from '../modules/M11-dispatcher/plan-go.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { CANCEL_REASON_MAX } from '../modules/M9-record/permissions.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { goCard, ttyConfirm } from './go-card.mjs';
import { USAGE, WITHDRAW_WORDS, main, withdrawCard } from './withdraw-card.mjs';

const ROWS = { 'R-1': { id: 'R-1', what: 'row R-1', module: 'M1', tier: 2, done_when: 'tests pass for R-1', status: 'planned' } };
const FILES = ['src/a.mjs', 'docs/blueprint/rows/R-1.yaml'];
const OWNER = 501;
const BRIEF = { goal: 'Add the first thing.', done_when: 'tests pass for R-1', files: FILES, not_in_scope: 'Any other file.' };
const CARD = { id: 'C-1', product: PRODUCT, module: 'M1', kind: 'ordinary', tier: 2, what: 'add the first thing', files: FILES, brief: BRIEF };
const RULES = { 'caps.rounds': 3, 'product_state_rules.active.start': 'within_caps', 'product_state_rules.paused.start': 'none' };
const REASON = 'made with the wrong brief; replaced by C-2';

function world(opts = {}) {
  const testProduct = Object.hasOwn(opts, 'testProduct') ? opts.testProduct : 'true';
  const t = env({ values: { ...RULES, ...(testProduct === undefined ? {} : { 'product.test_product': testProduct }) } });
  product(t);
  const g = fakeGitHub({ now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one', 'docs/blueprint/rows/R-1.yaml': 'id: R-1\n' });
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const w = { t, M0, view, shown: [], words: [] };
  w.yes = ({ cardId, text, words }) => { w.shown.push(text); w.words.push(words); return { ok: true, cardId }; };
  return w;
}
const ports = (w) => ({ startPlanReview: async () => ({ ok: false, reason: 'not here' }), planReviewAnswer: async () => ({ ok: false, reason: 'not here' }),
  planRows: async () => ROWS, planView: async () => w.view, mainSha: async () => w.M0, replyToLead: async () => ({ ok: true }) });
// R-S1-1's path: the go command writes the card and gives the go; the Dispatcher's pass moves it to ready.
async function readyCard(w) {
  const r = await goCard({ ctx: w.t.ctx, cardText: JSON.stringify(CARD), sudoUid: OWNER, readRows: async () => ROWS, view: w.view, mainSha: w.M0, confirm: () => ({ ok: true }) });
  must(r, 'go-card');
  must(await planGoPass(w.t.ctx, { ...ports(w), alert: outbox(w.t.record, w.t.clock.t) }));
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'ready');
}
const { id: _id, ...DOC } = CARD;
const draftDoc = { state: 'draft', ...DOC, done_when: 'tests pass for R-1' };
const draftCard = (w, id = 'C-1', over = {}) => must(w.t.record.write({ actor: 'owner_command', entity: 'card', id, expectRev: 0, doc: { ...draftDoc, ...over } }), `draft ${id}`);
// A card put straight in the store as if a given writer made it (a seed, past the writer's checks).
const stored = (w, id, doc, actor) => w.t.store.transaction((tx) => tx.commit([{ entity: 'card', id, doc }], { actor, kind: 'seed' }));
const run = (w, over = {}) => withdrawCard({ ctx: w.t.ctx, cardId: 'C-1', reason: REASON, confirm: w.yes, ...over });
const lastWriter = (w, id) => w.t.record.diary().filter((l) => l.entity === 'card' && l.id === id).at(-1);

test('a ready card the go command made (R-S1-1\'s path) is withdrawn: cancelled with its reason, by owner_command, and the Dispatcher leaves it', async () => {
  const w = world();
  await readyCard(w);
  const r = run(w);
  assert.deepEqual(r, { ok: true, card: 'C-1', from: 'ready' });
  const doc = w.t.record.read('card', 'C-1').doc;
  assert.equal(doc.state, 'cancelled');
  assert.equal(doc.cancel_reason, REASON);
  // Nothing else about the card changed.
  const { state: _s, cancel_reason: _c, ...rest } = doc;
  const { state: _s2, ...before } = { ...draftDoc, round: doc.round };
  assert.deepEqual(rest, before);
  assert.match(JSON.stringify(lastWriter(w, 'C-1')), /owner_command/);
  // What the owner read: the id, its state, its brief and the reason; and the retype was asked in withdrawal words.
  assert.equal(w.shown.length, 1);
  for (const s of ['Card C-1', 'now ready', 'Add the first thing.', `Reason given: ${REASON}`]) assert.ok(w.shown[0].includes(s), s);
  assert.equal(w.words[0], WITHDRAW_WORDS);
  // The Dispatcher's next pass leaves a cancelled card alone, and a second withdrawal is refused.
  must(await planGoPass(w.t.ctx, { ...ports(w), alert: outbox(w.t.record, w.t.clock.t) }));
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'cancelled');
  assert.match(run(w).reason, /C-1 is already cancelled \(made with the wrong brief/);
});

test('a draft card the go command made, with no go asked, is withdrawn from draft', () => {
  const w = world();
  draftCard(w);
  assert.deepEqual(run(w), { ok: true, card: 'C-1', from: 'draft' });
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'cancelled');
});

test('plants: refused by the command with nothing written or shown', async () => {
  const cases = [
    ['not the test product', (w) => stored(w, 'C-1', { ...draftDoc }, 'owner_command'), {}, /only on a product whose rules mark it the test product/, { testProduct: undefined }],
    ['test product false', (w) => stored(w, 'C-1', { ...draftDoc }, 'owner_command'), {}, /test product/, { testProduct: 'false' }],
    ['no such card', () => {}, {}, /the Record has no card C-1/],
    ['not a plain id', () => {}, { cardId: '../C-1' }, /one plain id/],
    ['no reason', (w) => draftCard(w), { reason: '' }, /needs a reason/],
    ['a reason over two lines', (w) => draftCard(w), { reason: 'one\ntwo' }, /one plain line/],
    ['a reason too long', (w) => draftCard(w), { reason: 'x'.repeat(CANCEL_REASON_MAX + 1) }, new RegExp(`over ${CANCEL_REASON_MAX} characters`)],
    ['a card the Lead made', (w) => stored(w, 'C-1', { ...draftDoc }, 'lead:L-1'), {}, /made by lead:L-1, not by your go command/],
    ['a claimed card', (w) => stored(w, 'C-1', { ...draftDoc, state: 'claimed', claim: { kind: 'session', host: 'mac-a', session_id: 'S-1', claimed_at: new Date(w.t.clock.t).toISOString() } }, 'owner_command'), {}, /C-1 is claimed; only a draft or ready card is withdrawn/],
    ['a Tier-1 card', (w) => stored(w, 'C-1', { ...draftDoc, tier: 1 }, 'owner_command'), {}, /not an ordinary Tier-2 card/],
    ['another product\'s card', (w) => stored(w, 'C-1', { ...draftDoc, product: 'other-app' }, 'owner_command'), {}, /not sample-app's/],
    // L1343: an open go ask. M2 has no withdraw for another writer, so the command refuses and names the ask.
    ['a go still being asked', async (w) => { draftCard(w); must(await raiseGo(w.t.ctx, { cardId: 'C-1', rows: ROWS, view: w.view, mainSha: w.M0 }), 'raise'); },
      {}, /your go is still being asked for card C-1 \(ask go-C-1-[0-9a-f]+, open\); M2 has no way for this command to withdraw an ask/],
  ];
  for (const [name, arrange, over, want, opts] of cases) {
    const w = world(opts);
    await arrange(w);
    const before = w.t.record.read('card', over.cardId ?? 'C-1');
    const asksBefore = JSON.stringify(askStore(w.t.record).asks());
    const r = run(w, over);
    assert.equal(r.ok, false, name);
    assert.match(r.reason, want, name);
    assert.deepEqual(w.t.record.read('card', over.cardId ?? 'C-1'), before, `${name}: the card is unchanged`);
    assert.equal(JSON.stringify(askStore(w.t.record).asks()), asksBefore, `${name}: no ask changed`);
    assert.equal(w.shown.length, 0, name);
  }
});

test('plants: not confirmed at the terminal (no terminal, piped input, another id typed) withdraws nothing', async () => {
  for (const [confirm, want] of [
    [({ cardId, text, words }) => ttyConfirm({ cardId, text, words, stdinIsTty: () => false }), /piped or redirected, not the Terminal, so the withdrawal can't be confirmed\. .*a session can't withdraw a card/],
    [({ cardId, text, words }) => ttyConfirm({ cardId, text, words, stdinIsTty: () => true, open: () => { throw new Error('ENXIO'); } }), /no terminal is attached, so the withdrawal can't be confirmed/],
    [() => ({ ok: false, reason: 'the id typed was not C-1; nothing was withdrawn' }), /the id typed was not C-1; nothing was withdrawn/],
  ]) {
    const w = world();
    await readyCard(w);
    const before = w.t.record.read('card', 'C-1');
    const r = run(w, { confirm });
    assert.equal(r.ok, false);
    assert.match(r.reason, want);
    assert.deepEqual(w.t.record.read('card', 'C-1'), before);
  }
});

test('plants (M9): the owner_command actor may withdraw only its own ordinary Tier-2 draft or ready card on the test product, with a plain reason, changing nothing else', async () => {
  const write = (w, id, fields) => {
    const cur = w.t.record.read('card', id);
    return w.t.record.write({ actor: 'owner_command', entity: 'card', id, expectRev: cur.rev, doc: { ...cur.doc, ...fields } });
  };
  const cancel = { state: 'cancelled', cancel_reason: REASON };
  // Control: its own draft, withdrawn.
  const ok = world();
  draftCard(ok);
  must(write(ok, 'C-1', cancel));
  for (const [name, arrange, fields, want, opts] of [
    ['someone else\'s card', (w) => stored(w, 'C-1', { ...draftDoc }, 'lead:L-1'), cancel, /owner_command may change only a card it created; C-1 was created by lead:L-1/],
    ['no reason', (w) => draftCard(w), { state: 'cancelled' }, /needs a reason \(cancel_reason\)/],
    ['a reason over two lines', (w) => draftCard(w), { state: 'cancelled', cancel_reason: 'a\nb' }, /one plain line/],
    ['a reason with spaces around it', (w) => draftCard(w), { state: 'cancelled', cancel_reason: ' a ' }, /starts or ends with a space/],
    ['a reason too long', (w) => draftCard(w), { state: 'cancelled', cancel_reason: 'x'.repeat(CANCEL_REASON_MAX + 1) }, /over 300 characters/],
    ['a reason with no move', (w) => draftCard(w), { cancel_reason: REASON }, /changes a card only to withdraw it/],
    ['the move with another field changed', (w) => draftCard(w), { ...cancel, what: 'changed' }, /may not change what/],
    ['draft → ready', (w) => draftCard(w), { state: 'ready' }, /may not move card draft → ready/],
    ['from claimed', (w) => stored(w, 'C-1', { ...draftDoc, state: 'claimed', claim: { kind: 'session', host: 'mac-a', session_id: 'S-1', claimed_at: new Date(w.t.clock.t).toISOString() } }, 'owner_command'), cancel, /may not move card claimed → cancelled/],
    ['a Tier-1 card', (w) => stored(w, 'C-1', { ...draftDoc, tier: 1 }, 'owner_command'), cancel, /withdraws only an ordinary Tier-2 card/],
    ['not the test product', (w) => stored(w, 'C-1', { ...draftDoc }, 'owner_command'), cancel, /only on a product whose rules mark it the test product/, { testProduct: undefined }],
  ]) {
    const w = world(opts);
    await arrange(w);
    const before = w.t.record.read('card', 'C-1');
    const r = write(w, 'C-1', fields);
    assert.equal(r.ok, false, name);
    assert.match(r.reason, want, name);
    assert.deepEqual(w.t.record.read('card', 'C-1'), before, name);
  }
});

test('main: a wrong number of arguments, or a config that is not the installed copy\'s, refuses with one line', async () => {
  const lines = [];
  const confirm = () => { throw new Error('asked to confirm'); };
  assert.equal(await main(['x', 'C-1'], { log: (s) => lines.push(s), confirm }), 1);
  assert.match(lines[0], /^withdraw-card: usage: sudo -k -u orchestrate .*withdraw-card\.mjs/);
  assert.equal(await main([join(tempDir('orch-withdraw-card-'), 'nope.json'), 'C-1', 'a', 'reason'], { log: (s) => lines.push(s), confirm }), 1);
  assert.match(lines[1], /^withdraw-card: /);
  assert.doesNotMatch(lines[1], /asked to confirm/);
  assert.ok(USAGE.startsWith('sudo -k -u orchestrate '));
});
