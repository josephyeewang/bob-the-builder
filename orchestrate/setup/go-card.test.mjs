// go-card.test.mjs — the owner writes a Tier-2 card of the test product and gives his go by command (lane N, N2;
// L1082, L1096, L1100): on a real Record, real M2 asks and gos, through to the Dispatcher's own pass moving the card to
// ready. Plus the plants: L1100's (a wrong kind, Tier 1, a product not marked the test product, no terminal), each
// refused by the command and, written straight to the Record as owner_command, by M9 itself; and L1096's (stdin piped
// with the right id, no terminal, a wrong id).
// Run: node --test orchestrate/setup/go-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, PRODUCT, must } from '../modules/M2-approvals/fixtures.test-helper.mjs';
import { leadCard, product } from '../modules/M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from '../modules/M2-approvals/fixtures/fake-github.mjs';
import { makeGitView } from '../modules/M10-rules/git-view.mjs';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { createAsk } from '../modules/M2-approvals/binding.mjs';
import { doneBar } from '../modules/M2-approvals/go.mjs';
import { answerByOwnerCommand, OWNER_COMMAND } from '../modules/M2-approvals/owner-command.mjs';
import { planGoPass } from '../modules/M11-dispatcher/plan-go.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { AI_ROLES, outboxFolders } from '../shared/record.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { CARD_FILE_FIELDS, RUN_AS, USAGE, goCard, main, readCardFile, ttyConfirm, whoProblem, withPlannedCard } from './go-card.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROWS = { 'R-1': { id: 'R-1', what: 'row R-1', module: 'M1', tier: 2, done_when: 'tests pass for R-1', status: 'planned' } };
const FILES = ['src/a.mjs', 'docs/blueprint/rows/R-1.yaml'];
const OWNER = 501;
const CARD = Object.freeze({ id: 'C-1', product: PRODUCT, module: 'M1', kind: 'ordinary', tier: 2, what: 'add the first thing', files: FILES });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const RULES = { 'caps.rounds': 3, 'product_state_rules.active.start': 'within_caps', 'product_state_rules.paused.start': 'none' };

// testProduct: the product's product.test_product as rules text (yaml-lite gives text), or undefined for none.
function world(opts = {}) {
  const testProduct = Object.hasOwn(opts, 'testProduct') ? opts.testProduct : 'true';
  const t = env({ values: { ...RULES, ...(testProduct === undefined ? {} : { 'product.test_product': testProduct }) } });
  product(t);
  const g = fakeGitHub({ now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one', 'docs/blueprint/rows/R-1.yaml': 'id: R-1\n' });
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const w = { t, M0, view, shown: [], rowsAsked: [] };
  w.readRows = async (x) => { w.rowsAsked.push(x); return ROWS; };
  w.yes = ({ cardId, text }) => { w.shown.push(text); return { ok: true, cardId }; };
  return w;
}
const fileOf = (over = {}) => JSON.stringify({ ...CARD, ...over });
const run = (w, over = {}) => goCard({ ctx: w.t.ctx, cardText: fileOf(), sudoUid: OWNER, readRows: w.readRows, view: w.view, mainSha: w.M0, confirm: w.yes, ...over });
const asks = (w) => askStore(w.t.record).asks();
const ports = (w) => ({ startPlanReview: async () => ({ ok: false, reason: 'not here' }), planReviewAnswer: async () => ({ ok: false, reason: 'not here' }),
  planRows: async () => ROWS, planView: async () => w.view, mainSha: async () => w.M0, replyToLead: async () => ({ ok: true }) });
const { id: _id, ...CARD_DOC } = CARD;
const asWritten = { state: 'draft', ...CARD_DOC, done_when: doneBar(ROWS) };
// A card written straight to the Record as the owner command, past the command's own checks (the M9 plants).
const direct = (w, over = {}, id = 'C-9') => w.t.record.write({ actor: 'owner_command', entity: 'card', id, expectRev: 0, doc: { ...asWritten, ...over } });

test('the card is written by owner_command, the go recorded as an owner-command go, and the Dispatcher\'s own pass moves the card to ready', async () => {
  const w = world();
  const text = fileOf();
  const r = await run(w, { cardText: text });
  assert.equal(r.ok, true, r.reason);
  assert.equal(w.rowsAsked.length, 1);
  assert.equal(w.rowsAsked[0].cardId, 'C-1');
  // The card: what the file said, a draft, its pass test its rows', and its first diary line names the owner command.
  const { round: _r, ...card } = w.t.record.read('card', 'C-1').doc;
  assert.deepEqual(card, asWritten);
  assert.equal(w.t.record.meta('card', 'C-1').createdBy, 'owner_command');
  const go = askStore(w.t.record).go('go-C-1').doc;
  assert.equal(go.binding.kind, OWNER_COMMAND);
  assert.equal(go.binding.sudo_uid, OWNER);
  assert.equal(go.binding.card_json_sha256, sha(Buffer.from(text, 'utf8')), 'the sha256 of the card file\'s own bytes');
  assert.equal(go.plan_fingerprint, r.fingerprint);
  const [a] = asks(w);
  assert.equal(a.doc.state, 'consumed');
  assert.equal(a.doc.answer.channel, 'tap');
  assert.equal(a.doc.answer.binding.kind, OWNER_COMMAND);
  // What the owner read before retyping the id names every file, the pass test, the fingerprint and that this is not a tap.
  assert.equal(w.shown.length, 1);
  for (const f of FILES) assert.ok(w.shown[0].includes(f), f);
  assert.match(w.shown[0], /tests pass for R-1/);
  assert.ok(w.shown[0].includes(r.fingerprint));
  assert.match(w.shown[0], /written by owner command.*\(binding kind owner_command\), not as a phone tap/);
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'draft', 'the command moves no card');
  must(await planGoPass(w.t.ctx, { ...ports(w), alert: outbox(w.t.record, w.t.clock.t) }));
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'ready');
  // Taken up again once it is ready: refused.
  assert.match((await run(w)).reason, /C-1 is ready; a go is given on a draft card/);
});

test('plants (L1100): refused by the command with nothing written or shown — a product not marked the test product, a wrong kind, Tier 1, and the rest', async () => {
  const cases = [
    [{ testProduct: undefined }, {}, /only on a product whose rules mark it the test product/],
    [{ testProduct: 'false' }, {}, /test product/],
    [{ testProduct: 'yes' }, {}, /test product/],
    [{}, { cardText: fileOf({ kind: 'fix' }) }, /"fix" card; this command makes an ordinary card only/],
    [{}, { cardText: fileOf({ kind: 'lead_daily_card' }) }, /ordinary card only/],
    [{}, { cardText: fileOf({ tier: 1 }) }, /Tier 1; this command makes a Tier-2 card only/],
    [{}, { cardText: fileOf({ tier: '2' }) }, /Tier-2 card only/],
    [{}, { cardText: fileOf({ product: 'other-app' }) }, /for product "other-app"/],
    [{}, { cardText: fileOf({ done_when: 'my own words' }) }, /may not set done_when \(the pass test comes from the card's rows\)/],
    [{}, { cardText: fileOf({ state: 'ready' }) }, /may not set state/],
    [{}, { cardText: fileOf({ plan_sha256: 'a'.repeat(64) }) }, /may not set plan_sha256/],
    [{}, { cardText: fileOf({ id: '../x' }) }, /card id must be/],
    [{}, { cardText: fileOf({ files: [] }) }, /no file list/],
    [{}, { cardText: fileOf({ what: ' ' }) }, /no what/],
    [{}, { cardText: '[1]' }, /one JSON object/],
    [{}, { cardText: 'not json' }, /not JSON/],
    [{}, { cardText: ' '.repeat(70 * 1024) }, /far larger/],
    [{}, { readRows: async () => { throw new Error('row R-1 is missing at main'); } }, /rows could not be read: row R-1 is missing/],
  ];
  for (const [opts, over, want] of cases) {
    const w = world(opts);
    const r = await run(w, over);
    assert.equal(r.ok, false, `${JSON.stringify(opts)} ${JSON.stringify(over).slice(0, 80)}`);
    assert.match(r.reason, want);
    assert.equal(w.t.record.read('card', 'C-1'), null);
    assert.equal(asks(w).length, 0);
    assert.equal(w.shown.length, 0);
  }
});

test('plant (L1100): with no terminal (not confirmed) nothing is written — no card, no ask, no go; a later run with a terminal goes through', async () => {
  const w = world();
  const r = await run(w, { confirm: ({ cardId, text }) => ttyConfirm({ cardId, text, open: () => { throw Object.assign(new Error('Device not configured'), { code: 'ENXIO' }); } }) });
  assert.match(r.reason, /no terminal is attached/);
  assert.equal(w.t.record.read('card', 'C-1'), null);
  assert.equal(asks(w).length, 0);
  assert.equal(askStore(w.t.record).go('go-C-1'), null);
  assert.equal((await run(w)).ok, true);
});

test('plants (L1100): M9 itself holds the owner_command actor to one Tier-2 ordinary draft card on the test product', () => {
  // Control: the one card it may make, and its diary names it.
  const ok = world();
  must(direct(ok));
  assert.equal(ok.t.record.meta('card', 'C-9').createdBy, 'owner_command');
  // A wrong kind, Tier 1, another state, a field outside its row.
  for (const [over, want] of [[{ kind: 'fix' }, /fix/], [{ kind: 'lead_daily_card' }, /lead_daily_card/], [{ tier: 1 }, /Tier-2 cards only/],
    [{ state: 'ready' }, /./], [{ plan_sha256: 'a'.repeat(64) }, /plan_sha256/], [{ needs_joe: true }, /needs_joe/]]) {
    const w = world();
    const r = direct(w, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.reason, want, JSON.stringify(over));
    assert.equal(w.t.record.read('card', 'C-9'), null);
  }
  // A product whose rules don't mark it the test product: missing, false, or not exactly true.
  for (const testProduct of [undefined, 'false', 'yes', 'TRUE']) {
    const w = world({ testProduct });
    assert.match(direct(w).reason, /only on a product whose rules mark it the test product/, String(testProduct));
  }
  // It updates nothing, not even the card it made, and writes no ask and no go (only M2 does).
  const rev = ok.t.record.read('card', 'C-9').rev;
  for (const fields of [{ what: 'changed' }, { needs_joe: true }, { summary: 'x' }]) {
    const r = ok.t.record.write({ actor: 'owner_command', entity: 'card', id: 'C-9', expectRev: rev, doc: { ...ok.t.record.read('card', 'C-9').doc, ...fields } });
    assert.equal(r.ok, false, JSON.stringify(fields));
  }
  assert.equal(ok.t.record.read('card', 'C-9').rev, rev);
  assert.equal(ok.t.record.write({ actor: 'owner_command', entity: 'ask', id: 'go-C-9', expectRev: 0, doc: { state: 'open' } }).ok, false);
  assert.equal(ok.t.record.write({ actor: 'owner_command', entity: 'go', id: 'go-C-9', expectRev: 0, doc: { product: PRODUCT, card_id: 'C-9', plan_fingerprint: 'a'.repeat(64) } }).ok, false);
  assert.equal(askStore(ok.t.record).go('go-C-9'), null);
  // No session's outbox can hand a document in under the name: it is a script actor, not an AI role.
  assert.ok(!AI_ROLES.includes('owner_command'));
  assert.match(ok.t.record.applyOutbox({ role: 'owner_command', sessionId: 'S-1' }, 'roadmap-C-8.json').reason, /unknown role "owner_command"/);
  assert.equal(outboxFolders({ outboxRoot: '/x', tag: { role: 'owner_command', sessionId: 'S-1' } }).ok, false);
});

// L1111 1: a refused write is never read as success. The Record is wrapped so one kind of write is refused (or throws);
// the command fails, says which step, and never reports a go that isn't recorded.
const refusing = (w, when, how = 'refuse') => ({ ...w.t.record, write: (x) => {
  if (!when(x)) return w.t.record.write(x);
  if (how === 'throw') throw new Error('the disk is full');
  return { ok: false, reason: 'the disk is full' };
} });
const withRecord = (w, record) => ({ ...w.t.ctx, record });
const isAnswer = (x) => x.entity === 'ask' && x.doc?.state === 'answered';
const isGo = (x) => x.entity === 'go';
const isConsumed = (x) => x.entity === 'ask' && x.doc?.state === 'consumed';

test('L1111 1: a refused card write, answer write or go write is a failure that names its step, and no go is reported', async () => {
  for (const [when, want, after] of [
    [(x) => x.entity === 'card', /the Record refused the card: the disk is full/, { card: false, asks: 0 }],
    [isAnswer, /refused the answer: the disk is full/, { card: true, asks: 1, state: 'pushed' }],
    [isGo, /the answer is recorded, but the go is not: the record refused the go: the disk is full/, { card: true, asks: 1, state: 'answered' }],
    [isConsumed, /the answer is recorded, but the go is not: the go is recorded, but the ask could not be closed/, { card: true, asks: 1, state: 'answered', go: true }],
  ]) {
    const w = world();
    const r = await run(w, { ctx: withRecord(w, refusing(w, when)) });
    assert.equal(r.ok, false, String(want));
    assert.match(r.reason, want);
    assert.equal(r.go, undefined);
    assert.equal(!!w.t.record.read('card', 'C-1'), after.card);
    assert.equal(asks(w).length, after.asks);
    if (after.state) assert.equal(asks(w)[0].doc.state, after.state);
    assert.equal(!!askStore(w.t.record).go('go-C-1'), !!after.go);
  }
  // A write that throws is not caught as a success either: the command's main reports it and exits 1.
  const w = world();
  await assert.rejects(run(w, { ctx: withRecord(w, refusing(w, isGo, 'throw')) }), /the disk is full/);
  assert.equal(askStore(w.t.record).go('go-C-1'), null);
});

test('L1111 2: a rerun after the answer was written but the go was not records the go, behind the same retype; only this owner\'s command answer', async () => {
  // Stopped between the answer and the go (and, second, between the go and closing the ask): a rerun finishes it.
  for (const when of [isGo, isConsumed]) {
    const w = world();
    assert.equal((await run(w, { ctx: withRecord(w, refusing(w, when)) })).ok, false);
    const shownBefore = w.shown.length;
    const r = await run(w);
    assert.equal(r.ok, true, r.reason);
    assert.equal(w.shown.length, shownBefore + 1, 'the rerun is shown and retyped again');
    assert.equal(asks(w).length, 1, 'the same ask');
    assert.equal(asks(w)[0].doc.state, 'consumed');
    const go = askStore(w.t.record).go('go-C-1').doc;
    assert.equal(go.binding.kind, OWNER_COMMAND);
    assert.equal(go.plan_fingerprint, r.fingerprint);
  }
  // Not confirmed on the rerun: still no go.
  const n = world();
  await run(n, { ctx: withRecord(n, refusing(n, isGo)) });
  assert.match((await run(n, { confirm: () => ({ ok: false, reason: 'the id typed was not C-1; no go was given' }) })).reason, /no go was given/);
  assert.equal(askStore(n.t.record).go('go-C-1'), null);
  // Plant: an answer by another owner id is not this command's to finish.
  const o = world();
  await run(o, { ctx: withRecord(o, refusing(o, isGo)) });
  assert.match((await run(o, { sudoUid: 777 })).reason, /already answered, and not by your owner command/);
  assert.equal(askStore(o.t.record).go('go-C-1'), null);
  // A rerun after it all went through, before the Dispatcher's pass: nothing new, the same go.
  const d = world();
  const first = await run(d);
  const again = await run(d);
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.go, first.go);
  assert.equal(asks(d).length, 1);
});

test('a rerun after a stop takes up only a draft the command made, with the same plan', async () => {
  // Its own draft, same plan (a stop after the card was written): taken up, one card, one ask.
  const w = world();
  must(direct(w, {}, 'C-1'));
  const rev = w.t.record.read('card', 'C-1').rev;
  const r = await run(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(asks(w).length, 1);
  assert.equal(w.t.record.read('card', 'C-1').rev, rev, 'not written again');
  // Its own draft with another plan: refused, nothing shown.
  const v = world();
  must(direct(v, { what: 'something else' }, 'C-1'));
  assert.match((await run(v)).reason, /already in the Record with another plan/);
  assert.equal(v.shown.length, 0);
  // A card of that id another writer made (here the Lead, through its outbox): refused, whatever its plan.
  const l = world();
  leadCard(l.t, 'C-1', { what: CARD.what, files: FILES, done_when: doneBar(ROWS) });
  assert.match((await run(l)).reason, /already in the Record, made by lead:L-1; pick another id/);
  assert.equal(asks(l).length, 0);
});

test('the card file holds the owner_command create row less state and done_when, plus the id; withPlannedCard shows the planned card only', () => {
  assert.deepEqual([...CARD_FILE_FIELDS].sort(), ['brief', 'desired', 'files', 'id', 'kind', 'lane', 'module', 'product', 'tier', 'what']);
  assert.equal(readCardFile(fileOf({ lane: 'L-1', brief: 'b', desired: 'd' }), PRODUCT).ok, true);
  const rec = { read: (e, id) => ({ e, id, from: 'record' }), other: 1 };
  const p = withPlannedCard(rec, 'C-1', { what: 'x' });
  assert.deepEqual(p.read('card', 'C-1'), { id: 'C-1', doc: { what: 'x' } });
  assert.deepEqual(p.read('card', 'C-2'), { e: 'card', id: 'C-2', from: 'record' });
  assert.deepEqual(p.read('ask', 'C-1'), { e: 'ask', id: 'C-1', from: 'record' });
  assert.equal(p.other, 1);
});

test('M2 answerByOwnerCommand: only a live Tier-2 go of this product, with no risky class, counted by the same rule as a tap', () => {
  const w = world();
  const fp = 'a'.repeat(64);
  const mk = (id, kind, over = {}) => must(createAsk(w.t.ctx, { id, kind, card: 'C-9', title: 'x', tier: kind === 'go_t1' ? 1 : 2, fingerprint: fp, files: ['src/a.mjs'], ...over }));
  const who = { sudoUid: OWNER, cardJsonSha256: 'b'.repeat(64) };
  mk('go-risky', 'go_t2', { risky: ['deletes'] });
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-risky', who).reason, /rules do not count this go: needs the GitHub channel/);
  mk('go-one', 'go_t1');
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-one', who).reason, /only a Tier-2 go/);
  mk('yes-no', 'tap_yes_no');
  assert.match(answerByOwnerCommand(w.t.ctx, 'yes-no', who).reason, /only a Tier-2 go/);
  mk('go-ok', 'go_t2');
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-ok', { ...who, sudoUid: 0 }).reason, /sudo_uid/);
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-ok', { ...who, cardJsonSha256: 'x' }).reason, /sha256/);
  assert.match(answerByOwnerCommand(w.t.ctx, 'nope', who).reason, /no trusted ask/);
  assert.deepEqual(asks(w).map((a) => a.doc.state), ['open', 'open', 'open', 'open'], 'the refusals wrote nothing');
  assert.equal(answerByOwnerCommand(w.t.ctx, 'go-ok', who).ok, true);
  assert.equal(askStore(w.t.record).ask('go-ok').doc.state, 'answered');
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-ok', who).reason, /is answered, so it can't be answered/);
});

// ---- L1096 Q11: the retyped id comes from the terminal only ----

test('plant: no terminal (opening /dev/tty fails) is refused', () => {
  const r = ttyConfirm({ cardId: 'C-1', text: 'x', open: () => { throw Object.assign(new Error('Device not configured'), { code: 'ENXIO' }); } });
  assert.match(r.reason, /no terminal is attached/);
});

test('plant: a wrong id at the terminal is refused; the right one is taken (control)', () => {
  const dir = tempDir('orch-go-card-');
  let n = 0;
  // The prompt goes to `prompts`, so the typed line is read untouched, kept apart as a terminal keeps them.
  const prompts = [];
  const typeIn = (typed) => { const f = join(dir, `t${++n}`); writeFileSync(f, typed); return ttyConfirm({ cardId: 'C-1', text: 'x', open: () => openSync(f, 'r'), isTty: () => true, show: (_fd, s) => prompts.push(s) }); };
  assert.match(typeIn('C-2\n').reason, /the id typed was not C-1/);
  assert.match(typeIn('c-1\n').reason, /not C-1/);
  assert.match(typeIn('\n').reason, /not C-1/);
  assert.match(typeIn('').reason, /not C-1/);
  assert.match(typeIn(`${'C'.repeat(300)}\n`).reason, /far longer/);
  assert.equal(typeIn('C-1\n').ok, true);
  assert.equal(typeIn(' C-1 \r\n').ok, true);
  assert.match(prompts[0], /type the card id \(C-1\)/);
});

test('plant: a file that is not a terminal is refused even with the right id in it', () => {
  const f = join(tempDir('orch-go-card-'), 'answer');
  writeFileSync(f, 'C-1\n');
  assert.match(ttyConfirm({ cardId: 'C-1', text: 'x', open: () => openSync(f, 'r+') }).reason, /no terminal is attached/);
});

test('plant: stdin piped with the right id, in a process with no terminal (as a session\'s shell), is refused', async () => {
  const src = `import { ttyConfirm } from ${JSON.stringify(join(HERE, 'go-card.mjs'))}; process.stdout.write(JSON.stringify(ttyConfirm({ cardId: 'C-1', text: 'x' })));`;
  // detached: the child starts its own session, so it has no controlling terminal whatever ran this test.
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('C-1\nC-1\n');
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((ok) => child.on('close', ok));
  assert.equal(code, 0, err);
  const r = JSON.parse(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no terminal is attached/);
});

test('who may run it: the Dispatcher\'s user, started through sudo by the owner', async () => {
  const { DISPATCHER_USER } = await import('./dispatcher-setup.mjs');
  assert.equal(RUN_AS, DISPATCHER_USER, 'go-card\'s own copy of the Dispatcher\'s user name');
  assert.ok(USAGE.startsWith(`sudo -u ${RUN_AS} `));
  const ok = { uid: 300, sudoUid: String(OWNER), dispatcherUid: 300, ownerUid: OWNER };
  assert.equal(whoProblem(ok), null);
  assert.match(whoProblem({ ...ok, uid: OWNER }), /sudo -u orchestrate/);
  assert.match(whoProblem({ ...ok, uid: 0 }), /sudo -u orchestrate/);
  assert.match(whoProblem({ ...ok, sudoUid: undefined }), /not started through sudo/);
  assert.match(whoProblem({ ...ok, sudoUid: '502' }), /by user 502, not by the owner/);
  assert.match(whoProblem({ ...ok, sudoUid: '501x' }), /not started through sudo/);
  assert.match(whoProblem({ ...ok, dispatcherUid: undefined }), /could not be found/);
  assert.match(whoProblem({ ...ok, ownerUid: 300 }), /ownerUid/);
});

test('main: a wrong number of arguments, or a config that is not the installed copy\'s, refuses with one line', async () => {
  const lines = [];
  const confirm = () => { throw new Error('asked to confirm'); };
  assert.equal(await main([], { log: (s) => lines.push(s), confirm }), 1);
  assert.match(lines[0], /^go-card: usage: sudo -u orchestrate/);
  assert.equal(await main([join(tempDir('orch-go-card-'), 'nope.json'), 'C-1'], { log: (s) => lines.push(s), confirm }), 1);
  assert.match(lines[1], /^go-card: /);
  assert.doesNotMatch(lines[1], /asked to confirm/);
});

// L1096: anywhere a go is shown to the owner it shows binding.kind. Today no code shows one; these files read go records
// to check or record them. A new reader fails here, so whoever adds it decides whether it shows a go to the owner, and
// if so shows binding.kind (an owner-command go is never presented as a phone tap).
test('L1096: the readers of go records are the known checkers (a new one must show binding.kind if it shows a go)', () => {
  const READERS = ['modules/M11-dispatcher/plan-go.mjs', 'modules/M2-approvals/ask-store.mjs', 'modules/M2-approvals/go.mjs', 'modules/M6-merge-gate/gather.mjs', 'modules/M9-record/ready.mjs'];
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.mjs$/.test(n) || /\.test(-helper)?\.mjs$/.test(n)) continue;
      if (/(read|list)\('go'|\.go\(|\.gos\(\)/.test(readFileSync(p, 'utf8'))) found.push(relative(ROOT, p).split(sep).join('/'));
    }
  };
  walk(ROOT);
  assert.deepEqual(found.sort(), READERS);
});
