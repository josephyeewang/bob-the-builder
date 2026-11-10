// research-intake.test.mjs — R-0b-135: a research report from the proposals folder goes onto one go-free research_copy
// card, only while its ask is open, carrying its bytes as proof; the merge gate lets the copy touch only that one path
// with those bytes (refusal 10). Real M9 Record, real M2 research asks, the real proposals intake.
// Run: node --test orchestrate/modules/M11-dispatcher/research-intake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchHandler, researchPass, researchCopyPass, researchCardDoc, researchPath, settleCause, alreadyCarded, CLOSED_CAUSE, NOCOPY_CAUSE, COPY_NOT_ON, COPY_WIRED, RESEARCH_CARD, RESEARCH_OFF, RETRY_MS, READY_FACT, BYTES_FACT, COPY_RUN, EMPTY_SHA256, EMPTY_BLOB } from './research-intake.mjs';
import { REPORT_CHANGED } from '../M4-workshop/git/push.mjs';
import { isQueued } from './alerts.mjs';
import { proposalsPass, bytesFactId } from './proposals-intake.mjs';
import { NEVER_STARTED, HOLD_FACT, holdAlert } from './pass.mjs';
import { outbox, sendAlerts } from './alerts.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { setup, must, PRODUCT, UID } from '../M9-record/fixtures.test-helper.mjs';
import { outboxFile as m9file } from '../M9-record/fixtures.test-helper.mjs';
import { checkOutboxFile, outboxFile } from '../M1-front-door/outbox.mjs';
import { openResearchAsks, researchBrief, landResearch } from '../M2-approvals/research-ask.mjs';
import { waitingItems } from '../M13-ledger/waiting.mjs';
import { judge, researchCopyProblem } from '../M6-merge-gate/refusals.mjs';
import { blobSha } from '../M10-rules/reader.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';
import { GO_FREE_KEY } from '../M9-record/ready.mjs';
import { product as productOf } from '../M9-record/fixtures.test-helper.mjs';
import { gatherFacts } from '../M6-merge-gate/gather.mjs';
import { fakeGateGitHub } from '../M6-merge-gate/fixtures/fake-gate-github.mjs';
import { rulesFromText } from '../M10-rules/from-text.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { T0 } from './fixtures.test-helper.mjs';

const ON = { [`${GO_FREE_KEY}.research_copy`]: true };
const sha = (t) => createHash('sha256').update(t).digest('hex');
const REPORT = '# What the top three rivals charge\n\nAnnual plans run 20-30% under monthly.\n';

// A product, active, with research asks opened the way M2 opens them (the Front Door's file, then openResearchAsks).
function world({ values = ON, state = 'active', asks = 1 } = {}) {
  const t = setup({ values, prefix: 'm11-research-' });
  if (state) must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state } }), 'product');
  const ctx = { record: t.record, rules: t.rules, product: PRODUCT, now: () => t.clock.t, alert: fakeAlert() };
  for (let i = 1; i <= asks; i += 1) {
    const f = outboxFile('ask-request', `20261103-0915-r${"abcdefgh"[i]}`, { ask: 'research', product: PRODUCT, brief: `find out thing ${i}` });
    const c = checkOutboxFile(f.name, f.text, { products: [PRODUCT], seenIds: [] });
    assert.equal(c.ok, true, c.reason);
    must(t.record.applyOutbox({ role: 'front_door', sessionId: `F-${i}` }, m9file(t, 'front_door', `F-${i}`, f.name, f.text)), 'ask request');
  }
  assert.equal(openResearchAsks(ctx).opened.length, asks);
  const alert = fakeAlert();
  const research = researchHandler({ rules: t.rules, alert });
  // What the intake hands a handler (L290 M-1): the fenced text and the raw bytes' sha256, blob id and size; never the text.
  const hand = (id, text, over = {}) => research({ rec: t.record, product: PRODUCT, kind: 'research', id, name: `research-${id}.md`, source: 'research-file', fenced: cleanOutside(text, 'research-file'),
    sha256: sha(text), blob: blobSha(Buffer.from(text)), size: Buffer.byteLength(text), now: t.clock.t, ...over });
  return { t, rec: t.record, research, hand, alert };
}

test('a report for an open ask goes onto one ready research_copy card with its bytes as proof, and the ask leaves the waiting list', () => {
  const w = world();
  const r = w.hand('R-1', REPORT);
  assert.deepEqual(r, { ok: true, card: RESEARCH_CARD('R-1') });
  const c = w.rec.read('card', RESEARCH_CARD('R-1')).doc;
  assert.equal(c.kind, 'research_copy');
  assert.equal(c.state, 'ready', 'go-free: ready with no go');
  assert.equal(c.research_ask, 'R-1');
  assert.deepEqual(c.files, ['docs/research/research-R-1.md']);
  assert.equal(c.tier, 2);
  assert.equal(c.source.sha256, sha(REPORT));
  assert.equal(c.source.size, Buffer.byteLength(REPORT));
  assert.equal(w.rec.createdBy?.('card', RESEARCH_CARD('R-1')) ?? 'dispatcher', 'dispatcher');
  // The blob id is git's own for these bytes.
  const gitSays = execFileSync('git', ['hash-object', '--stdin'], { input: REPORT }).toString().trim();
  assert.equal(c.source.blob, gitSays);
  assert.equal(w.rec.read('ask', 'R-1').doc.landed.card, RESEARCH_CARD('R-1'));
  assert.deepEqual(waitingItems(w.rec), []);
  // Ready, but never a worker's (the start loop skips it; lane 2's copier makes the commit, L286).
  assert.ok(w.rec.ready().some((x) => x.id === RESEARCH_CARD('R-1')));
  assert.ok(NEVER_STARTED.includes('research_copy'));
});

test('fail closed: with research copies off in the rules, nothing is written and the reason says which key', () => {
  for (const values of [{}, { [`${GO_FREE_KEY}.research_copy`]: false }]) {
    const w = world({ values });
    assert.deepEqual(w.hand('R-1', REPORT), { ok: false, reason: RESEARCH_OFF });
    assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')), null);
    assert.ok(researchBrief(w.rec, 'R-1').ok, 'the ask still waits on the owner');
  }
  assert.match(RESEARCH_OFF, /approvals\.plan_go\.go_free\.research_copy/);
});

test('refused: no open ask by that number, an odd name, another product, no proof of the bytes, a landed ask', () => {
  const w = world({ asks: 2 });
  assert.match(w.hand('R-9', REPORT).reason, /there is no research ask R-9/);
  assert.match(w.hand('r1', REPORT).reason, /named research-R-<number>\.md/);
  assert.match(w.hand('R-1', REPORT, { name: 'research-R-2.md' }).reason, /named research-R-<number>\.md/);
  assert.match(w.hand('R-1', REPORT, { product: 'other-app' }).reason, /research ask R-1 is for product sample-app, not this one/);
  // No proof of the bytes (L290 M-1): a missing or odd sha256, blob id or size is refused, never made up here.
  for (const over of [{ sha256: undefined }, { sha256: 'X'.repeat(64) }, { blob: undefined }, { blob: sha(REPORT) }, { size: undefined }, { size: -1 }, { size: '10' }]) {
    assert.match(w.hand('R-1', REPORT, over).reason, /did not hand on the report's sha256, blob id and size/, JSON.stringify(over));
  }
  // An empty report is no report (#154 audit Minor 6), and a handler with no clock from the pass uses none of its own.
  const EMPTY = /^the research report for R-1 is empty or only blank space, so there is nothing to copy; the ask stays open$/;
  for (const text of ['', '\n', ' \t\n', '\r\n\r\n', '\u200b\n']) assert.match(w.hand('R-1', text).reason, EMPTY, JSON.stringify(text));
  // The empty file's own sha256 or blob id is empty whatever else is claimed (#154 r2 cosmetic 1).
  assert.match(w.hand('R-1', REPORT, { sha256: EMPTY_SHA256 }).reason, EMPTY);
  assert.match(w.hand('R-1', REPORT, { blob: EMPTY_BLOB }).reason, EMPTY);
  assert.equal(EMPTY_SHA256, sha(''));
  assert.equal(EMPTY_BLOB, blobSha(Buffer.from('')));
  // No fenced copy, or something else in its place, is refused, never taken as not blank.
  for (const fenced of [undefined, REPORT, '<outside-text source="x">a</outside-text> trailing']) {
    assert.match(w.hand('R-1', REPORT, { fenced }).reason, /did not hand on the report's fenced text/, String(fenced));
  }
  assert.match(w.hand('R-1', REPORT, { now: undefined }).reason, /did not hand on its clock/);
  assert.throws(() => researchPass({ rec: w.rec, alert: w.alert }), /needs the pass's clock/);
  // Fail closed (L303): with no alert, a refused move would be silent, so neither runs without one.
  assert.throws(() => researchPass({ rec: w.rec, now: w.t.clock.t }), /needs the alert/);
  assert.throws(() => researchHandler({ rules: w.t.rules }), /needs the alert/);
  assert.equal(researchBrief(w.rec, 'R-1').ok, true, 'the ask is still open');
  assert.equal(w.rec.list('card').length, 0);
  // Taken in once; the ask has landed, so a second report for it is refused, naming its card and what to do (L303),
  // never only "not open".
  assert.equal(w.hand('R-2', REPORT).ok, true);
  assert.equal(w.hand('R-2', 'a second take').reason, alreadyCarded('R-2', sha(REPORT)));
  // L736 m6 (R6): other bytes from another product's folder, for an ask that has its card: the reason names the product,
  // never the "already has its card" advice meant for the ask's own owner.
  assert.equal(w.hand('R-2', 'a third take', { product: 'other-app' }).reason, 'research ask R-2 is for product sample-app, not this one');
  assert.equal(w.rec.list('card').length, 1);
});

test('restart-safe: a card written before a crash is landed by the same bytes or by the next researchPass; other bytes are refused', () => {
  const w = world({ asks: 2 });
  // The card is written, then the pass stops before landing (here: written directly, as the handler writes it).
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id: RESEARCH_CARD('R-1'), expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  assert.match(w.hand('R-1', 'other bytes').reason, /R-1 already has its research_copy card/);
  // With what to do (L303): which version the card holds, and the two ways on.
  assert.equal(w.hand('R-1', 'other bytes').reason, alreadyCarded('R-1', sha(REPORT)));
  assert.match(alreadyCarded('R-1', sha(REPORT)), new RegExp(`version ${sha(REPORT).slice(0, 12)}\\), so this one was not used\\. The first report is already on its card and will be copied; nothing to do for it\\. To have this one used instead, ask again with a new research ask$`));
  assert.doesNotMatch(alreadyCarded('R-1', sha(REPORT)), /put it back/, 'L736 m1');
  assert.match(w.hand('R-1', REPORT, { blob: 'b'.repeat(40) }).reason, /R-1 already has its research_copy card/, 'same sha256, another blob');
  assert.equal(w.hand('R-1', REPORT).ok, true);
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.state, 'ready');
  assert.ok(w.rec.read('ask', 'R-1').doc.landed);
  // researchPass: a card left in draft by a paused product goes ready once the product is active again.
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  assert.equal(w.hand('R-2', REPORT).ok, true, 'the file is used; the card waits in draft');
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-2')).doc.state, 'draft');
  // L736 m2: the ask leaves the waiting list only once its card is ready, so a withdrawal meanwhile is still seen.
  assert.equal(w.rec.read('ask', 'R-2').doc.landed, undefined);
  assert.ok(researchBrief(w.rec, 'R-2').ok, 'still waiting on the owner while its card is a draft');
  // The refused move is told from the handler (L303), on the card's own ready cause, never in silence.
  const readyMark = HOLD_FACT(settleCause('ready', RESEARCH_CARD('R-2')));
  const toldReady = () => w.alert.calls.filter(([, o]) => o?.mark?.fact === readyMark);
  assert.equal(toldReady().length, 1, 'the handler told it');
  assert.match(toldReady()[0][0], /research ask R-2 was taken in, but its card research-R-2 could not go to ready \(.+\), so it is not copied yet/);
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: w.alert }).map(([, x]) => x.replace(/:.*/, '')), ['not ready']);
  // This stand-in never marks a tell delivered, so holdAlert asks again: the pass's refusal reaches Joe too.
  assert.equal(toldReady().length, 2, 'researchPass told it');
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'active' } }), 'resume');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: w.alert }), [[RESEARCH_CARD('R-2'), 'ready'], [RESEARCH_CARD('R-2'), 'landed']]);
  assert.ok(w.rec.read('ask', 'R-2').doc.landed, 'landed once ready');
  assert.equal(toldReady().length, 2, 'a move made is not told');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: w.alert }), [], 'nothing left to do');
  assert.equal(w.alert.calls.filter(([, o]) => o?.mark?.fact === HOLD_FACT(settleCause('land', RESEARCH_CARD('R-2')))).length, 0, 'both asks landed: no land tell');
});

// The Record with its ask writes refused (a full disk, say): landResearch can't mark the ask answered.
const askWritesRefused = (rec) => new Proxy({}, { get: (_, k) => (k === 'write' ? (x) => (x?.entity === 'ask' ? { ok: false, reason: 'the disk is full' } : rec.write(x)) : typeof rec[k] === 'function' ? rec[k].bind(rec) : rec[k]) });

test('L303: a card whose ask can\'t be marked answered is told from researchPass, and not again once it lands', () => {
  const w = world({ asks: 1 });
  const id = RESEARCH_CARD('R-1');
  // A pass wrote the card and stopped; the next pass can't write the ask, so it can't be marked answered.
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  const landMark = HOLD_FACT(settleCause('land', id));
  const toldLand = () => w.alert.calls.filter(([, o]) => o?.mark?.fact === landMark);
  const out = researchPass({ rec: askWritesRefused(w.rec), now: w.t.clock.t, alert: w.alert });
  assert.deepEqual(out.map(([, x]) => x.replace(/:.*/, '')), ['ready', 'not landed']);
  assert.equal(toldLand().length, 1, 'told, never silent');
  assert.match(toldLand()[0][0], /research ask R-1 is on its card research-R-1, but the ask could not be marked as answered \(.*the disk is full.*\); it is tried again each pass$/);
  // The ask still open and waiting: the next pass lands it, and a landing is not told.
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: w.alert }), [[id, 'landed']]);
  assert.equal(toldLand().length, 1);
});

// L736 M1: a report whose ask Joe withdrew between its card and the ready move never goes ready, is never copied, and
// Joe is told once.
test('L736 M1 planted: withdrawn between the card and the ready move: the card stays a draft, is never copied, and Joe is told once', async () => {
  const w = world({ asks: 1 });
  const id = RESEARCH_CARD('R-1');
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  assert.equal(w.hand('R-1', REPORT).ok, true);
  assert.equal(w.rec.read('card', id).doc.state, 'draft');
  const ask = w.rec.read('ask', 'R-1');
  must(w.rec.write({ actor: 'approvals', entity: 'ask', id: 'R-1', expectRev: ask.rev, doc: { ...ask.doc, state: 'withdrawn' } }), 'withdraw');
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'active' } }), 'resume');
  // The real queue, sent each pass: told once however many passes.
  const port = fakeAlert();
  const pass = async (at) => { const q = outbox(w.rec, at); const o = researchPass({ rec: w.rec, now: at, alert: q }); await sendAlerts(w.rec, port, at); return o; };
  assert.deepEqual(await pass(w.t.clock.t), [[id, 'not used: the ask was withdrawn']]);
  // Told, then left quietly (self-review m7): not settled again every pass.
  for (const dt of [60_000, DAY, 3 * DAY]) assert.deepEqual(await pass(w.t.clock.t + dt), []);
  assert.equal(w.rec.read('card', id).doc.state, 'draft', 'never ready');
  const closed = port.texts.filter((t) => /the report for research ask R-1 was not used: the ask was withdrawn; its card research-R-1 is not copied/.test(t));
  assert.equal(closed.length, 1, port.texts.join(' | '));
  // Its old "could not go to ready" is cleared, not left to be sent.
  assert.equal(isQueued(w.rec, HOLD_FACT(settleCause('ready', id))), false);
  assert.equal(w.rec.read('ask', 'R-1').doc.state, 'withdrawn', 'the withdrawal stands');
});

// L736 M1 (3): an ask closed between the ready move and the landing is told as it is: not tried again, not copied.
test('L736 M1 planted: an ask withdrawn just before its landing is told without a promise to try again', () => {
  const w = world({ asks: 1 });
  const id = RESEARCH_CARD('R-1');
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  // The withdrawal lands right after the ready move, before the ask is marked answered.
  const racing = new Proxy({}, { get: (_, k) => (k === 'write' ? (x) => {
    const r = w.rec.write(x);
    if (x?.kind === 'research_ready' && r.ok) { const a = w.rec.read('ask', 'R-1'); must(w.rec.write({ actor: 'approvals', entity: 'ask', id: 'R-1', expectRev: a.rev, doc: { ...a.doc, state: 'withdrawn' } }), 'withdraw'); }
    return r;
  } : typeof w.rec[k] === 'function' ? w.rec[k].bind(w.rec) : w.rec[k]) });
  assert.deepEqual(researchPass({ rec: racing, now: w.t.clock.t, alert: w.alert }).map(([, x]) => x.replace(/:.*/, '')), ['ready', 'not landed']);
  const told = w.alert.calls.filter(([, o]) => o?.mark?.fact === HOLD_FACT(settleCause('land', id)));
  assert.equal(told.length, 1);
  assert.match(told[0][0], /could not be marked as answered \(no open research ask R-1\); the ask was withdrawn, so the report is not copied$/);
  assert.doesNotMatch(told[0][0], /tried again/);
});

test('L736 M1 planted: researchCopyPass never pushes or sends on a card whose ask was withdrawn or expired, and says so once', async () => {
  for (const state of ['withdrawn', 'expired']) {
    const w = copyWorld();
    let ask = w.rec.read('ask', 'R-1');
    // An ask expires only after its one re-ask (M9 writer): lapsed once, then expired.
    if (state === 'expired') {
      must(w.rec.write({ actor: 'approvals', entity: 'ask', id: 'R-1', expectRev: ask.rev, doc: { ...ask.doc, reask_count: 1, lapsed_at: new Date(w.T).toISOString() } }), 'lapse');
      ask = w.rec.read('ask', 'R-1');
    }
    // Self-review m4: a "has waited over a day" and a "report changed" still queued go too.
    for (const f of [READY_FACT(w.card), BYTES_FACT(w.card)]) assert.notEqual(holdAlert({ rec: w.rec, cause: f.replace(/^.*?(research-)/, '$1'), text: `stale ${f}`, alert: (t, o) => outbox(w.rec, w.T)(t, o), now: w.T }), false);
    for (const f of [READY_FACT(w.card), BYTES_FACT(w.card)]) assert.equal(isQueued(w.rec, f), true, f);
    must(w.rec.write({ actor: 'approvals', entity: 'ask', id: 'R-1', expectRev: ask.rev, doc: { ...ask.doc, state } }), state);
    assert.deepEqual(await w.pass(), [[w.card, `not copied: the ask was ${state}`]]);
    for (const f of [READY_FACT(w.card), BYTES_FACT(w.card)]) assert.equal(isQueued(w.rec, f), false, f);
    assert.deepEqual(w.alerts.filter((t) => t.startsWith('stale')), []);
    // Told, then left quietly (self-review m7).
    assert.deepEqual(await w.pass(w.T + RETRY_MS * 4), []);
    assert.equal(w.calls.length, 0, 'never pushed');
    assert.equal(w.alerts.filter((t) => t.includes(`was not used: the ask was ${state}`)).length, 1, w.alerts.join(' | '));
    assert.equal(w.rec.read('card', w.card).doc.state, 'ready', 'left where it is');
  }
});

// Self-review M1: the ask closes after its card went ready and its landing was refused. The old "tried again each pass"
// goes, Joe is told once that the report is not copied, and the card is then left quietly.
test('L736 M1 planted: an ask closed after a refused landing clears the retry promise and is told once', async () => {
  const w = world({ asks: 1 });
  const id = RESEARCH_CARD('R-1');
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  const port = fakeAlert();
  const pass = async (rec, at) => { const o = researchPass({ rec, now: at, alert: outbox(w.rec, at) }); return o; };
  assert.deepEqual((await pass(askWritesRefused(w.rec), w.t.clock.t)).map(([, x]) => x.replace(/:.*/, '')), ['ready', 'not landed']);
  const landMark = HOLD_FACT(settleCause('land', id));
  assert.equal(isQueued(w.rec, landMark), true, 'the retry promise is queued');
  const ask = w.rec.read('ask', 'R-1');
  must(w.rec.write({ actor: 'approvals', entity: 'ask', id: 'R-1', expectRev: ask.rev, doc: { ...ask.doc, state: 'withdrawn' } }), 'withdraw');
  assert.deepEqual(await pass(w.rec, w.t.clock.t + 60_000), [[id, 'not used: the ask was withdrawn']]);
  assert.equal(isQueued(w.rec, landMark), false, 'the stale promise is never sent');
  await sendAlerts(w.rec, port, w.t.clock.t + 60_000);
  assert.equal(port.texts.filter((t) => /was not used: the ask was withdrawn; its card research-R-1 is not copied/.test(t)).length, 1, port.texts.join(' | '));
  assert.deepEqual(port.texts.filter((t) => /tried again/.test(t)), []);
  assert.deepEqual(await pass(w.rec, w.t.clock.t + DAY), [], 'then left quietly');
});

// Self-review m1: a draft card whose ask was already answered by it (a Record from before L736, which landed the ask
// even when the ready move was refused) still goes ready; it is not taken for a closed ask.
test('L736 m1 planted: a draft whose open ask already landed on it still goes ready', () => {
  const w = world({ asks: 1 });
  const id = RESEARCH_CARD('R-1');
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  assert.equal(landResearch({ record: w.rec, now: () => w.t.clock.t }, 'R-1').ok, true);
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: w.alert }), [[id, 'ready']]);
  assert.equal(w.rec.read('card', id).doc.state, 'ready');
  assert.deepEqual(w.alert.texts.filter((t) => /was not used/.test(t)), []);
});

// Self-review m3: the once-only "nothing copies it yet" is asked for again each pass until it is told, so a refused
// queue write never loses it.
test('L736 m2 planted: a refused "nothing copies it yet" is said in the lines and told on the next pass, once', async () => {
  const w = world({ asks: 1 });
  const id = RESEARCH_CARD('R-1');
  const port = fakeAlert();
  let refuse = true;
  const q = (at) => { const real = outbox(w.rec, at); return (text, o) => (refuse && text.includes(COPY_NOT_ON) ? false : real(text, o)); };
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  const one = researchPass({ rec: w.rec, now: w.t.clock.t, alert: q(w.t.clock.t) });
  assert.deepEqual(one.map(([, x]) => x), ['ready', 'landed', 'the note that nothing copies it yet could not be queued; tried again next pass']);
  refuse = false;
  for (const dt of [60_000, 2 * 60_000, DAY, 3 * DAY]) {
    const at = w.t.clock.t + dt;
    researchPass({ rec: w.rec, now: at, alert: q(at) });
    await sendAlerts(w.rec, port, at);
  }
  assert.equal(port.texts.filter((t) => t.includes(COPY_NOT_ON)).length, 1, port.texts.join(' | '));
});

test('L303: a tell still queued when the move is made leaves the queue, so a stale "could not go to ready" is never sent', () => {
  const w = world();
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  const id = RESEARCH_CARD('R-1');
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  const mark = HOLD_FACT(settleCause('ready', id));
  const queue = outbox(w.rec, w.t.clock.t);
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: queue }).map(([, x]) => x.replace(/:.*/, '')), ['not ready']);
  assert.equal(isQueued(w.rec, mark), true, 'queued, not sent yet');
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'active' } }), 'resume');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: queue }), [[id, 'ready'], [id, 'landed']]);
  assert.equal(isQueued(w.rec, mark), false, 'the move was made, so its tell is dropped');
});

// L736 m6 (R1): a card that has gone past draft by another way clears its old "could not go to ready", so a refusal that
// comes back later is told afresh, and a stale one is never sent.
test('L736 m6 planted: a card already past draft clears its old "could not go to ready" tell', () => {
  const w = world();
  const id = RESEARCH_CARD('R-1');
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  const queue = outbox(w.rec, w.t.clock.t);
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: queue }).map(([, x]) => x.replace(/:.*/, '')), ['not ready']);
  const mark = HOLD_FACT(settleCause('ready', id));
  assert.equal(isQueued(w.rec, mark), true);
  // The card goes ready by another way (here: the move itself, made directly), while the ask still waits.
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'active' } }), 'resume');
  const c = w.rec.read('card', id);
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: c.rev, kind: 'research_ready', doc: { ...c.doc, state: 'ready' } }), 'ready');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t, alert: queue }), [[id, 'landed']]);
  assert.equal(isQueued(w.rec, mark), false, 'cleared by a card past draft');
});

test('through the real proposals intake: taken in once, and a refusal is told to the owner once', async () => {
  const w = world({ asks: 4 });
  const dir = join(w.t.base, 'proposals'); mkdirSync(dir); chmodSync(dir, 0o750);
  // The real queue: each alert is queued in the Record, then sent to a fake port, which writes its told mark (as the tick).
  const port = fakeAlert();
  const alerts = port.texts;
  const now = w.t.clock.t + 3_600_000;
  const rules = { get: (k, o) => (k === 'proposals.outbox' ? dir : w.t.rules.get(k, o)) };
  const pass = async () => {
    await proposalsPass({ rec: w.rec, rules, products: [PRODUCT], ownerUid: UID, wait: async () => {}, alert: outbox(w.rec, now), handlers: { research: w.research }, now });
    await sendAlerts(w.rec, port, now);
  };
  writeFileSync(join(dir, 'research-R-1.md'), REPORT);
  writeFileSync(join(dir, 'research-R-7.md'), 'no such ask');
  writeFileSync(join(dir, 'research-R-2.md'), '');
  writeFileSync(join(dir, 'research-R-3.md'), '\n');
  writeFileSync(join(dir, 'research-R-4.md'), ' \t\n');
  await pass();
  await pass();
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.source.sha256, sha(REPORT));
  assert.equal(w.rec.list('card').length, 1);
  assert.equal(alerts.filter((a) => /research-R-7\.md/.test(a) && /there is no research ask R-7/.test(a)).length, 1, 'told once');
  // An empty report, and one of only blank space, is refused and told once; its ask stays open (#154 audit Minor 6, r2 Minor 1).
  for (const id of ['R-2', 'R-3', 'R-4']) {
    assert.equal(alerts.filter((a) => a.includes(`research-${id}.md`) && /is empty or only blank space/.test(a)).length, 1, `${id} is told once`);
    assert.equal(researchBrief(w.rec, id).ok, true, `${id} is still open`);
    assert.equal(w.rec.read('card', RESEARCH_CARD(id)), null, `${id} got a card`);
  }
  // The pass's clock, handed on by the intake, not this machine's (#154 audit cosmetic).
  assert.equal(w.rec.read('ask', 'R-1').doc.landed.at, new Date(now).toISOString());
});

test('L290: through the real proposals intake, the card\'s sha256 and blob are the raw bytes\', git\'s own, for BOM, CRLF and non-UTF-8 reports', async () => {
  const reports = {
    'R-1': Buffer.from('﻿# Report\nA & B < C\n', 'utf8'),
    'R-2': Buffer.from('# Report\r\nline two\r\n', 'utf8'),
    'R-3': Buffer.from([0x23, 0x20, 0xFF, 0xFE, 0x41, 0x0D, 0x0A, 0x80]),
  };
  const w = world({ asks: 3 });
  const dir = join(w.t.base, 'proposals'); mkdirSync(dir); chmodSync(dir, 0o750);
  const now = w.t.clock.t + 3_600_000;
  const rules = { get: (k, o) => (k === 'proposals.outbox' ? dir : w.t.rules.get(k, o)) };
  for (const [id, bytes] of Object.entries(reports)) writeFileSync(join(dir, `research-${id}.md`), bytes);
  const out = await proposalsPass({ rec: w.rec, rules, products: [PRODUCT], ownerUid: UID, wait: async () => {}, alert: outbox(w.rec, now), handlers: { research: w.research }, now });
  for (const [id, bytes] of Object.entries(reports)) {
    assert.equal(out.find((r) => r.name === `research-${id}.md`)?.applied, true, id);
    const src = w.rec.read('card', RESEARCH_CARD(id)).doc.source;
    const git = execFileSync('git', ['hash-object', '--stdin'], { input: bytes }).toString().trim();
    assert.deepEqual(src, { file: `research-${id}.md`, sha256: sha(bytes), blob: git, size: bytes.length }, id);
  }
});

// L736 m3: the write that marks the file applied is read. Refused, the pass's lines say the file was used and the mark is
// tried again; the next pass marks it, and nothing is told as an interruption.
test('L736 m3 planted: a refused "applied" mark is said in the pass\'s lines and made next pass, never told as an interruption', async () => {
  const w = world({ asks: 1 });
  const dir = join(w.t.base, 'proposals'); mkdirSync(dir); chmodSync(dir, 0o750);
  const port = fakeAlert();
  const now = w.t.clock.t + 3_600_000;
  const rules = { get: (k, o) => (k === 'proposals.outbox' ? dir : w.t.rules.get(k, o)) };
  const refusesApplied = new Proxy({}, { get: (_, k) => (k === 'write' ? (x) => (x?.kind === 'proposal_applied' ? { ok: false, reason: 'the disk is full' } : w.rec.write(x)) : typeof w.rec[k] === 'function' ? w.rec[k].bind(w.rec) : w.rec[k]) });
  const pass = async (rec, at) => {
    const out = await proposalsPass({ rec, rules, products: [PRODUCT], ownerUid: UID, wait: async () => {}, alert: outbox(w.rec, at), handlers: { research: w.research }, now: at });
    await sendAlerts(w.rec, port, at);
    return out.find((r) => r.name === 'research-R-1.md');
  };
  writeFileSync(join(dir, 'research-R-1.md'), REPORT);
  const one = await pass(refusesApplied, now);
  assert.equal(one.applied, true);
  assert.match(one.unmarked, /^used, but it could not be marked applied \(.*the disk is full.*\); the mark is tried again next pass$/);
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.source.sha256, sha(REPORT), 'the file was used');
  // Still refused next pass: said again, and never used twice.
  const two = await pass(refusesApplied, now + 60_000);
  assert.match(two.marked, /still could not be marked applied/);
  assert.equal(w.rec.list('card').length, 1);
  const three = await pass(w.rec, now + 120_000);
  assert.equal(three.marked, 'used in an earlier pass; marked applied now');
  const four = await pass(w.rec, now + 180_000);
  assert.equal(four.already, true);
  assert.deepEqual(port.texts.filter((t) => /interrupted/.test(t)), [], port.texts.join(' | '));
  assert.equal(w.rec.list('card').length, 1);
  const bytes = w.rec.read('fact', bytesFactId(sha(REPORT))).doc;
  assert.equal(bytes.used_at, undefined, 'the used note goes once the mark is made');
  assert.equal(bytes.used_name, undefined);
});

// Self-review m2: the used note is the file's own. The bytes record is shared by every name with those bytes, so a note
// left by another name, or older than this claim, never marks this one applied: it is told as an interruption.
test('L736 m3 planted: a used note of another name, or older than the claim, is never read as this file\'s', async () => {
  for (const spoil of [{ used_name: 'research-R-9.md' }, { used_at: new Date(0).toISOString() }]) {
    const w = world({ asks: 1 });
    const dir = join(w.t.base, 'proposals'); mkdirSync(dir); chmodSync(dir, 0o750);
    const port = fakeAlert();
    const now = w.t.clock.t + 3_600_000;
    const rules = { get: (k, o) => (k === 'proposals.outbox' ? dir : w.t.rules.get(k, o)) };
    const refusesApplied = new Proxy({}, { get: (_, k) => (k === 'write' ? (x) => (x?.kind === 'proposal_applied' ? { ok: false, reason: 'the disk is full' } : w.rec.write(x)) : typeof w.rec[k] === 'function' ? w.rec[k].bind(w.rec) : w.rec[k]) });
    const pass = async (rec, at) => {
      const out = await proposalsPass({ rec, rules, products: [PRODUCT], ownerUid: UID, wait: async () => {}, alert: outbox(w.rec, at), handlers: { research: w.research }, now: at });
      await sendAlerts(w.rec, port, at);
      return out.find((r) => r.name === 'research-R-1.md');
    };
    writeFileSync(join(dir, 'research-R-1.md'), REPORT);
    assert.equal((await pass(refusesApplied, now)).applied, true);
    const f = w.rec.read('fact', bytesFactId(sha(REPORT)));
    assert.equal(f.doc.used_name, 'research-R-1.md');
    must(w.rec.write({ actor: 'dispatcher', entity: 'fact', id: bytesFactId(sha(REPORT)), expectRev: f.rev, doc: { ...f.doc, ...spoil }, kind: 'proposal_bytes' }), 'spoil');
    const two = await pass(w.rec, now + 60_000);
    assert.equal(two.marked, undefined, JSON.stringify(spoil));
    assert.equal(port.texts.filter((t) => /interrupted/.test(t)).length, 1, `${JSON.stringify(spoil)}: ${port.texts.join(' | ')}`);
  }
});

// ---- the merge gate, refusal 10 ----

const card = (over = {}) => ({ id: RESEARCH_CARD('R-1'), doc: { ...researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 1 }), ...over } });
const PATH = researchPath('R-1');
const file = (over = {}) => ({ path: PATH, status: 'added', mode: '100644', blob: blobSha(Buffer.from(REPORT)), ...over });
const problem = (files, c = card()) => researchCopyProblem({ card: c, files });

test('refusal 10: a research copy changes only its one path, as a plain file, with the owner\'s bytes', () => {
  assert.equal(problem([file()]), null);
  assert.equal(problem([file({ status: 'modified' })]), null);
  const fin = (x, re) => { assert.equal(x?.temporary, false, JSON.stringify(x)); assert.match(x.reason, re); };
  fin(problem([file(), { path: 'src/app.mjs', status: 'modified', mode: '100644', blob: 'c'.repeat(40) }]), /may change only docs\/research\/research-R-1\.md; this change touches docs\/research\/research-R-1\.md, src\/app\.mjs/);
  fin(problem([file({ path: 'docs/research/research-R-2.md' })]), /may change only/);
  fin(problem([file({ status: 'renamed', previous_path: 'src/secret-plan.md' })]), /touches docs\/research\/research-R-1\.md, src\/secret-plan\.md/);
  fin(problem([]), /touches no file/);
  fin(problem([file({ status: 'removed' })]), /this change has it removed/);
  fin(problem([file({ mode: '100755' })]), /must be a plain file \(mode 100644\), not 100755/);
  fin(problem([file({ mode: '120000' })]), /not 120000/);
  // The bytes: a wrong blob is final; a missing one is not known yet.
  fin(problem([file({ blob: blobSha(Buffer.from('rewritten by someone')) })]), /is not the owner's report byte for byte/);
  const missing = problem([file({ blob: undefined })]);
  assert.equal(missing.temporary, true);
  assert.match(missing.reason, /GitHub gave no blob id/);
  // The card itself: its one file must be its ask's path, and it must carry the blob.
  fin(problem([file()], card({ files: ['docs/research/research-R-1.md', 'src/x.mjs'] })), /one file must be its ask's docs\/research\/research-R-1\.md/);
  fin(problem([file()], card({ files: ['src/x.mjs'] })), /one file must be/);
  fin(problem([file()], card({ research_ask: undefined })), /one file must be/);
  fin(problem([file()], card({ source: { sha256: sha(REPORT) } })), /no blob id for the report/);
  // #154 audit Minor 1: a path that differs only in case, or by a look-alike character, is another path. On the
  // change side the copy touches a file that isn't its one path; on the card side the card's one file isn't its ask's.
  const LOOKS = ['docs/research/Research-R-1.md', 'docs/Research/research-R-1.md', 'DOCS/research/research-R-1.md', 'docs/research/research-r-1.md',
    'docs/research/research-R-1.MD', 'docs/research/research-\uFF32-1.md', 'docs/research/r\u0435search-R-1.md', 'docs/research/research-R-\u0661.md',
    'docs/research/research-R-1.md\u200B', 'docs/research/research\u2010R-1.md'];
  for (const p of LOOKS) {
    fin(problem([file({ path: p })]), /may change only docs\/research\/research-R-1\.md/);
    fin(problem([file({ path: p })], card({ files: [p] })), /one file must be its ask's docs\/research\/research-R-1\.md/);
    fin(problem([file()], card({ files: [p] })), /one file must be its ask's/);
  }
  // A blob that is some other id of the same bytes (the sha256, cut to 40) is not git's own: refused.
  fin(problem([file({ blob: sha(REPORT).slice(0, 40) })]), /is not the owner's report byte for byte/);
});

test('refusal 10 in judge: a go-free research copy that touches another file is refused there; unread files wait', () => {
  const facts = (files, filesProblem = null) => ({ cutoverStage: 'first', card: card(), files, filesProblem, go: { ok: true, reasons: [], skipped: true } });
  const r10 = (f) => judge(f).refusals.filter((x) => x.n === 10);
  assert.deepEqual(r10(facts([file()])), []);
  const bad = r10(facts([file(), { path: 'src/app.mjs', status: 'modified', mode: '100644', blob: 'c'.repeat(40) }]));
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /may change only/);
  assert.notEqual(bad[0].temporary, true);
  assert.equal(judge(facts([file(), { path: 'src/app.mjs', status: 'modified', mode: '100644', blob: 'c'.repeat(40) }])).decision, 'refuse');
  const unread = r10(facts(null));
  assert.equal(unread.length, 1);
  assert.equal(unread[0].temporary, true);
  assert.match(unread[0].reason, /research copy can't be checked/);
  // Files that can never be read (too many) make it final.
  assert.notEqual(r10(facts(null, 'too_many'))[0].temporary, true);
});

// #154 audit Minor 1, end to end: the real handler makes the card, the real gather reads the change from the fake GitHub,
// and the real judge decides. An exact copy passes refusal 10; a path off only by case or a look-alike is refused, final.
test('refusal 10 end to end: the real handler, gather and judge refuse a copy whose path differs only in case or by a look-alike', async () => {
  const policy = readFileSync(new URL('../M10-rules/fixtures/policy.yaml', import.meta.url), 'utf8')
    + '\napprovals:\n  plan_go:\n    go_free:\n      exact_reverse: true\n      research_copy: true\n';
  const g = fakeGateGitHub({ owner: 'sample-org', repo: 'sample-app' });
  const base = g.commit([], { 'README.md': 'hi' }); g.main = base;
  let env = null;
  const rules = rulesFromText({ [PRODUCT]: policy }, { productState: (p) => env?.record.read('product', p)?.doc ?? null, clock: () => env?.clock.t ?? T0 });
  env = setup({ prefix: 'm11-research-e2e-', extra: { rules } }); env.clock.t = T0; productOf(env, 'active');
  const f = outboxFile('ask-request', '20261103-0915-ra', { ask: 'research', product: PRODUCT, brief: 'find out x' });
  must(env.record.applyOutbox({ role: 'front_door', sessionId: 'F-1' }, m9file(env, 'front_door', 'F-1', f.name, f.text)), 'ask');
  openResearchAsks({ record: env.record, rules, product: PRODUCT, now: () => env.clock.t, alert: fakeAlert() });
  must(researchHandler({ rules, alert: fakeAlert() })({ rec: env.record, product: PRODUCT, kind: 'research', id: 'R-1', name: 'research-R-1.md',
    source: 'research-file', fenced: cleanOutside(REPORT, 'research-file'), sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: Buffer.byteLength(REPORT), now: env.clock.t }), 'handed in');
  const ctx = { record: env.record, rules, product: PRODUCT, gh: g.gh, owner: 'sample-org', repo: 'sample-app',
    view: makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' }), now: () => env.clock.t, alert: fakeAlert(), readFact: () => null };
  let n = 10;
  const r10 = async (path) => {
    const head = g.commit([base], { 'README.md': 'hi', [path]: REPORT }, { from: base });
    g.openPull({ number: ++n, head, files: { [path]: REPORT } });
    const facts = await gatherFacts(ctx, { id: `M-${n}`, doc: { card: RESEARCH_CARD('R-1'), pr: n } });
    assert.ok(Array.isArray(facts.files), `${path}: ${facts.filesProblem}`);
    return judge(facts).refusals.filter((x) => x.n === 10);
  };
  assert.deepEqual(await r10(researchPath('R-1')), [], 'the exact copy passes refusal 10');
  for (const p of ['docs/research/Research-R-1.md', 'docs/Research/research-R-1.md', 'docs/research/research-Ｒ-1.md', 'docs/research/rеsearch-R-1.md']) {
    const got = await r10(p);
    assert.equal(got.length, 1, p);
    assert.notEqual(got[0].temporary, true, `${p}: final`);
    assert.match(got[0].reason, /may change only docs\/research\/research-R-1\.md/, p);
  }
});

// ---- the copy pass (L286, L290, L313, L384 4): pushes the card, and it never sits in ready untold ----
const DAY = 24 * 3_600_000;
// The real queue and a fake push door that records its fact under the name the real one does.
function copyWorld({ answer = () => ({ ok: true, branch: 'card/research-r-1', tip: 'a'.repeat(40) }), writeHead = false, ...opts } = {}) {
  const w = world(opts);
  assert.equal(w.hand('R-1', REPORT).ok, true);
  const card = RESEARCH_CARD('R-1');
  const fact = `push.${card}.r-${sha(REPORT).slice(0, 12)}`;
  const port = fakeAlert();
  const calls = [];
  const pushResearch = async (input) => {
    calls.push(input);
    const now = w.t.clock.t;
    const r = { reason: undefined, ...answer(calls.length) };
    if (r.ok === undefined) return r;
    if (r.ok && writeHead) { const k = w.rec.read('card', card); must(w.rec.write({ actor: 'workshop', entity: 'card', id: card, expectRev: k.rev, kind: 'push_head', doc: { ...k.doc, head: r.tip } })); }
    const cur = w.rec.read('fact', fact);
    must(w.rec.write({ actor: 'workshop', entity: 'fact', id: fact, expectRev: cur?.rev ?? 0, kind: 'push',
      doc: r.ok ? { result: 'pushed', branch: r.branch, tip: r.tip, at: new Date(now).toISOString(), from: 'research', product: PRODUCT } : { result: 'refused', reason: r.reason, at: new Date(now).toISOString(), from: 'research' } }), 'push fact');
    return r;
  };
  const pass = async (at = w.t.clock.t, rules = w.t.rules) => {
    w.t.clock.t = at;
    const out = await researchCopyPass({ rec: w.rec, rules, pushResearch, alert: outbox(w.rec, at), now: at });
    await sendAlerts(w.rec, port, at);
    return out;
  };
  return { ...w, card, fact, calls, pass, port, alerts: port.texts, T: w.t.clock.t };
}

test('the card has the docs lane M10 needs, as M9 lets the Dispatcher write it', () => {
  const w = world();
  w.hand('R-1', REPORT);
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.lane, 'docs');
});

test('L286: a ready card is pushed once; a pushed one is never asked again; a card not ready is left', async () => {
  const w = copyWorld();
  assert.deepEqual(await w.pass(), [[w.card, 'pushed']]);
  assert.deepEqual(w.calls, [{ product: PRODUCT, card: w.card }]);
  assert.deepEqual(await w.pass(w.T + RETRY_MS * 4), []);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.alerts, [], 'nothing to tell inside the first day');
});

test('L286: a refused copy rests RETRY_MS between tries, and a door that throws is a refusal, not a stopped pass', async () => {
  const w = copyWorld({ answer: (n) => (n < 3 ? { ok: false, reason: 'the start gate is shut' } : { ok: true, branch: 'b', tip: 't' }) });
  assert.match((await w.pass())[0][1], /not pushed: the start gate is shut/);
  await w.pass(w.T + RETRY_MS - 1);
  assert.equal(w.calls.length, 1);
  await w.pass(w.T + RETRY_MS);
  assert.equal(w.calls.length, 2);
  await w.pass(w.T + 2 * RETRY_MS);
  assert.equal(w.calls.length, 3);
  const b = copyWorld();
  const out = await researchCopyPass({ rec: b.rec, rules: b.t.rules, pushResearch: async () => { throw new Error('no network'); }, alert: outbox(b.rec, b.T), now: b.T });
  assert.deepEqual(out, [[b.card, 'not pushed: no network']]);
});

test('L286: with the rules turned off after the intake, nothing is copied, and the owner is told why at the day', async () => {
  const w = copyWorld();
  const off = { flag: () => false, get: () => undefined };
  assert.deepEqual(await w.pass(w.T, off), []);
  assert.equal(w.calls.length, 0);
  await w.pass(w.T + DAY, off);
  assert.equal(w.calls.length, 0);
  assert.equal(w.alerts.length, 1);
  assert.ok(w.alerts[0].includes(RESEARCH_OFF), w.alerts[0]);
});

test('L290: a report whose bytes changed is told once, at once, however often it is tried; a lost alert is sent again', async () => {
  const w = copyWorld({ answer: () => ({ ok: false, reason: REPORT_CHANGED }) });
  await w.pass();
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /research ask R-1 changed after it was taken in, so it was not copied/);
  await w.pass(w.T + RETRY_MS);
  await w.pass(w.T + 2 * RETRY_MS);
  assert.equal(w.alerts.length, 1, 'once');
  assert.equal(w.calls.length, 3, 'still tried: the owner may put the original back');
  // Another refusal is no such tell.
  const o = copyWorld({ answer: () => ({ ok: false, reason: 'GitHub refused the push' }) });
  await o.pass();
  assert.deepEqual(o.alerts, []);
  // Queued and not delivered: no second queue entry, and delivered on the next send.
  const q = copyWorld({ answer: () => ({ ok: false, reason: REPORT_CHANGED }) });
  q.port.reset();
  const lost = fakeAlert({ answer: false });
  await researchCopyPass({ rec: q.rec, rules: q.t.rules, pushResearch: async () => ({ ok: false, reason: REPORT_CHANGED }), alert: lost, now: q.T });
  assert.equal(lost.calls.length, 1);
  assert.equal(q.rec.read('fact', BYTES_FACT(q.card))?.doc?.told_at ?? null, null, 'a lost alert marks nothing');
  // The bytes come back and the copy goes: an alert still waiting to be sent about it is dropped.
  const b = copyWorld();
  await researchCopyPass({ rec: b.rec, rules: b.t.rules, pushResearch: async () => ({ ok: false, reason: REPORT_CHANGED }), alert: outbox(b.rec, b.T), now: b.T });
  assert.equal(isQueued(b.rec, BYTES_FACT(b.card)), true);
  await b.pass(b.T + RETRY_MS);
  assert.equal(isQueued(b.rec, BYTES_FACT(b.card)), false);
  assert.deepEqual(b.alerts, [], 'dropped, not sent');
});

test('L313: a card a day in ready is told, then daily, whether it could not be copied or is pushed and waiting for its merge', async () => {
  const w = copyWorld({ answer: () => ({ ok: false, reason: 'the start gate is shut' }) });
  await w.pass();
  await w.pass(w.T + DAY - 1);
  assert.deepEqual(w.alerts, [], 'not before the day');
  await w.pass(w.T + DAY);
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /research ask R-1 has waited over a day: it has not been copied \(the start gate is shut\)\.$/);
  await w.pass(w.T + DAY + RETRY_MS);
  assert.equal(w.alerts.length, 1, 'once a day');
  await w.pass(w.T + 2 * DAY);
  assert.equal(w.alerts.length, 2);
  const p = copyWorld();
  await p.pass();
  await p.pass(p.T + DAY);
  assert.equal(p.alerts.length, 1, 'L384 4: a pushed copy still in ready is still told, and a card with no head never moves');
  assert.match(p.alerts[0], /it is on branch card\/research-r-1 but its card could not take the new head \(the card names another head\)\.$/);
  // A start time that can't be read is told, never waited out.
  const u = copyWorld();
  await researchCopyPass({ rec: { list: (...a) => u.rec.list(...a), read: (...a) => u.rec.read(...a), write: (...a) => u.rec.write(...a), meta: () => ({ stateSince: 'not a time' }) }, rules: u.t.rules, pushResearch: async () => ({ ok: true }), alert: outbox(u.rec, u.T), now: u.T });
  assert.equal(isQueued(u.rec, READY_FACT(u.card)), true);
});

// A Record that refuses one kind of write, `times` times.
const refusing = (rec, kind, times = 1) => { let left = times; return { ...Object.fromEntries(['list', 'read', 'meta'].map((k) => [k, (...a) => rec[k](...a)])), write: (w) => {
  if ((w.kind === kind || w.entity === kind) && left > 0) { left -= 1; return { ok: false, reason: `no ${kind}` }; }
  return rec.write(w);
} }; };
const TIP = 'a'.repeat(40);
const routed = () => {
  const w = copyWorld({ writeHead: true });
  const run = COPY_RUN(w.card, sha(REPORT));
  const passOn = (rec, at = w.t.clock.t) => { w.t.clock.t = at; return researchCopyPass({ rec, rules: w.t.rules, pushResearch: async () => assert.fail('pushed twice'), alert: outbox(w.rec, at), now: at, host: 'the-host' }); };
  return { ...w, run, passOn, state: () => w.rec.read('card', w.card).doc.state };
};

test('L387: a pushed copy goes to review in one pass, on a tab claim, with one launch record of the start loop\'s shape', async () => {
  const w = routed();
  await w.pass();
  const c = w.rec.read('card', w.card);
  assert.equal(c.doc.state, 'in_review');
  assert.equal(c.doc.head, TIP);
  assert.equal(c.doc.claim, undefined, 'the claim ends at the hand-in, so M9 will take a merge request');
  assert.match(w.run, new RegExp(`^copy-${w.card}-r-[0-9a-f]{12}$`));
  const l = w.rec.read('launch', w.run).doc;
  assert.deepEqual(Object.keys(l).sort(), ['card', 'config_dir', 'copy', 'head', 'kind', 'launched_at', 'product', 'rev', 'role', 'session_id', 'signin']);
  assert.deepEqual([l.session_id, l.role, l.kind, l.card, l.head, l.product], [w.run, 'copy_run', 'copy_run', w.card, TIP, PRODUCT]);
  assert.ok(Number.isInteger(l.rev) && l.rev > 0);
  await w.pass(w.T + 5 * DAY);
  assert.equal(w.calls.length, 1, 'pushed once');
  assert.deepEqual(w.alerts, [], 'nothing to tell once it is with review');
  assert.equal(w.rec.list('launch').length, 1);
});

test('L387: the pass that sends a stopped copy to review, on the day its tell falls due, tells nothing', async () => {
  const u = routed();
  u.t.clock.t = u.T;
  await researchCopyPass({ rec: refusing(u.rec, 'claim'), rules: u.t.rules, pushResearch: async () => { const k = u.rec.read('card', u.card); must(u.rec.write({ actor: 'workshop', entity: 'card', id: u.card, expectRev: k.rev, kind: 'push_head', doc: { ...k.doc, head: TIP } })); must(u.rec.write({ actor: 'workshop', entity: 'fact', id: u.fact, expectRev: 0, kind: 'push', doc: { result: 'pushed', branch: 'b', tip: TIP, at: new Date(u.T).toISOString(), from: 'research', product: PRODUCT } })); return { ok: true }; }, alert: outbox(u.rec, u.T), now: u.T, host: 'the-host' });
  assert.equal(u.state(), 'ready');
  const later = u.T + DAY + 1;
  await u.passOn(u.rec, later);
  await sendAlerts(u.rec, u.port, later);
  assert.equal(u.state(), 'in_review');
  assert.deepEqual(u.alerts, []);
});

for (const [stop, at] of [['claim', 'ready'], ['started', 'claimed'], ['launch', 'running'], ['copy_handed_in', 'running']]) {
  test(`L387: a stop at ${stop} leaves the card ${at}, is told daily, and the next pass goes on from there`, async () => {
    const w = routed();
    await w.pass();
    assert.equal(w.state(), 'in_review');
    const v = routed();
    v.t.clock.t = v.T;
    const pushOnly = await researchCopyPass({ rec: refusing(v.rec, stop), rules: v.t.rules, pushResearch: async () => { const k = v.rec.read('card', v.card); must(v.rec.write({ actor: 'workshop', entity: 'card', id: v.card, expectRev: k.rev, kind: 'push_head', doc: { ...k.doc, head: TIP } })); must(v.rec.write({ actor: 'workshop', entity: 'fact', id: v.fact, expectRev: 0, kind: 'push', doc: { result: 'pushed', branch: 'b', tip: TIP, at: new Date(v.T).toISOString(), from: 'research', product: PRODUCT } })); return { ok: true }; }, alert: outbox(v.rec, v.T), now: v.T, host: 'the-host' });
    assert.match(pushOnly.at(-1)[1], /^not sent to review: /);
    assert.equal(v.state(), at);
    const later = v.T + DAY + 1;
    await v.passOn(refusing(v.rec, stop), later);
    await sendAlerts(v.rec, v.port, later);
    assert.equal(v.state(), at, 'still stopped');
    assert.match(v.alerts.at(-1), /but could not go to review \(/);
    await v.passOn(v.rec, later + 1);
    assert.equal(v.state(), 'in_review');
    assert.equal(v.rec.list('launch').length, 1);
    assert.equal(v.rec.read('fact', READY_FACT(v.card)).doc.told_at, null, 'the tell ends with the wait');
  });
}

// L441: the real lapse step between passes, as the tick runs it. A stop at `stop` that never clears. Six-hourly, so four
// days stay quick: a claim goes stale in 10 minutes, so each tick still lapses what the last one moved.
const TICK = 6 * 3_600_000;
const stuck = async (stop, days, { clockOff = false } = {}) => {
  const v = routed();
  v.t.clock.t = v.T;
  const push = async () => { const k = v.rec.read('card', v.card); must(v.rec.write({ actor: 'workshop', entity: 'card', id: v.card, expectRev: k.rev, kind: 'push_head', doc: { ...k.doc, head: TIP } })); must(v.rec.write({ actor: 'workshop', entity: 'fact', id: v.fact, expectRev: 0, kind: 'push', doc: { result: 'pushed', branch: 'b', tip: TIP, at: new Date(v.T).toISOString(), from: 'research', product: PRODUCT } })); return { ok: true }; };
  const stopped = () => { const r = refusing(v.rec, stop, Infinity); return clockOff ? refusing(r, 'hold_waiting', Infinity) : r; };
  await researchCopyPass({ rec: stopped(), rules: v.t.rules, pushResearch: push, alert: outbox(v.rec, v.T), now: v.T, host: 'the-host' });
  const seen = new Set();
  let lapses = 0;
  const end = v.T + days * DAY;
  for (let at = v.T + TICK; at < end; at += TICK) {
    v.t.clock.t = at;
    lapses += must(v.rec.lapseClaims(at)).lapsed.length;
    seen.add(v.state());
    await v.passOn(stopped(), at);
    await sendAlerts(v.rec, v.port, at);
  }
  return { v, seen, lapses, end, stopped };
};
const lifted = async ({ v, end }) => {
  must(v.rec.lapseClaims(end));
  await v.passOn(v.rec, end);
  await sendAlerts(v.rec, v.port, end);
};

for (const stop of ['launch', 'copy_handed_in']) {
  test(`L441 M1: a run stopped at ${stop} lapses to waiting, is taken back each time, is told daily, and goes to review once the step works`, async () => {
    const r = await stuck(stop, 4);
    assert.ok(r.seen.has('waiting'), 'the lapse step really did park it');
    assert.equal(r.v.state(), 'running', 'not left in waiting');
    assert.equal(r.v.alerts.length, 3, 'at one, two and three days');
    assert.match(r.v.alerts[0], /has waited over a day: it is on branch b but could not go to review \(/);
    await lifted(r);
    assert.equal(r.v.state(), 'in_review');
    assert.equal(r.v.rec.list('launch').length, 1, 'one run for these bytes');
    const f = r.v.rec.read('fact', READY_FACT(r.v.card)).doc;
    assert.equal(f.told_at, null);
    assert.equal(f.waiting_since, undefined);
  });
}

test('L441 M1: a lapsed run that can\'t be taken back stays told, and is not sent on from waiting', async () => {
  const r = await stuck('launch', 1);
  const { v, end } = r;
  must(v.rec.lapseClaims(end + 2 * TICK));
  assert.equal(v.state(), 'waiting');
  const late = end + 2 * DAY;
  const out = await v.passOn(refusing(v.rec, 'copy_run_lapsed', Infinity), late);
  await sendAlerts(v.rec, v.port, late);
  assert.equal(v.state(), 'waiting');
  assert.match(out.at(-1)[1], /its lapsed run could not be taken back/);
  assert.match(v.alerts.at(-1), /could not go to review \(its lapsed run could not be taken back \(/);
});

test('L441 M1: a card waiting on something else is left alone', async () => {
  const { v, end } = await stuck('launch', 1);
  must(v.rec.lapseClaims(end + 2 * TICK));
  const k = v.rec.read('card', v.card);
  v.t.clock.t = end + 3 * TICK;
  must(v.rec.write({ actor: 'dispatcher', entity: 'card', id: v.card, expectRev: k.rev, kind: 'test', doc: { ...k.doc, wait: { ...k.doc.wait, what: 'something else', since: new Date(v.t.clock.t).toISOString() } } }));
  await v.passOn(v.rec, end + 3 * TICK);
  assert.equal(v.state(), 'waiting');
});

test('L441 M2: a step refused for four days bounces ready and claimed, and is told at a day, then daily', async () => {
  const r = await stuck('started', 4);
  assert.ok(r.lapses > 10, `it did bounce (${r.lapses} lapses)`);
  assert.equal(r.v.alerts.length, 3, 'at one, two and three days, from the first held pass');
  await lifted(r);
  assert.equal(r.v.state(), 'in_review');
  assert.equal(r.v.rec.read('fact', READY_FACT(r.v.card)).doc.waiting_since, undefined, 'over, so a later wait starts afresh');
});

test('L528 1: the wait\'s start can\'t be written on any pass, the card bounces, and the owner is still told, from the push', async () => {
  const r = await stuck('started', 4, { clockOff: true });
  assert.ok(r.lapses > 10);
  assert.equal(r.v.rec.read('fact', READY_FACT(r.v.card))?.doc?.waiting_since, undefined, 'never written');
  assert.equal(r.v.alerts.length, 3, 'at one, two and three days');
});

// L528 2: no lapse in the last stretch, so the pass that tells starts with the card in claimed or running, and the
// card's own clock is too young to tell: only the kept start can.
for (const [stop, at] of [['started', 'claimed'], ['launch', 'running']]) {
  test(`L528 2: a card that starts the pass ${at} keeps the wait\'s start and is told on it`, async () => {
    const r = await stuck(stop, 0.5);
    const { v, end, stopped } = r;
    assert.ok(r.lapses > 0, 'it moved, so its own clock restarted');
    must(v.rec.lapseClaims(end));
    await v.passOn(stopped(), end);
    assert.equal(v.state(), at);
    const late = v.T + DAY + 1;
    v.t.clock.t = late;
    await v.passOn(stopped(), late);
    await sendAlerts(v.rec, v.port, late);
    assert.equal(v.state(), at);
    assert.equal(v.alerts.length, 1);
  });
}

test('L441 M2: not told before the day, however many moves it made', async () => {
  const r = await stuck('started', 1);
  assert.ok(r.lapses > 1);
  assert.deepEqual(r.v.alerts, []);
});

test('L387: a card over a day old that goes to review in this pass is not told it is waiting', async () => {
  const w = routed();
  await w.pass(w.T + 2 * DAY);
  assert.equal(w.state(), 'in_review');
  assert.deepEqual(w.alerts, []);
});

test('L441 m5: the Record checks ready again at the claim: a card that stopped being ready stays ready and is not sent on', async () => {
  const w = routed();
  w.t.clock.t = w.T;
  const k = w.rec.read('card', w.card);
  must(w.rec.write({ actor: 'workshop', entity: 'card', id: w.card, expectRev: k.rev, kind: 'push_head', doc: { ...k.doc, head: TIP } }));
  must(w.rec.write({ actor: 'workshop', entity: 'fact', id: w.fact, expectRev: 0, kind: 'push', doc: { result: 'pushed', branch: 'b', tip: TIP, at: new Date(w.T).toISOString(), from: 'research', product: PRODUCT } }));
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  const out = await w.passOn(w.rec, w.T);
  assert.equal(w.state(), 'ready');
  assert.match(out.at(-1)[1], /^not sent to review: .*no work starts/);
});

test('L387: rules off, a pushed card is not sent to review', async () => {
  const w = routed();
  w.t.clock.t = w.T;
  const k = w.rec.read('card', w.card);
  must(w.rec.write({ actor: 'workshop', entity: 'card', id: w.card, expectRev: k.rev, kind: 'push_head', doc: { ...k.doc, head: TIP } }));
  must(w.rec.write({ actor: 'workshop', entity: 'fact', id: w.fact, expectRev: 0, kind: 'push', doc: { result: 'pushed', branch: 'b', tip: TIP, at: new Date(w.T).toISOString(), from: 'research', product: PRODUCT } }));
  await researchCopyPass({ rec: w.rec, rules: { flag: () => false, get: () => undefined }, pushResearch: async () => assert.fail('off'), alert: outbox(w.rec, w.T), now: w.T });
  assert.equal(w.state(), 'ready');
});

test('L387: a pushed card whose head write was refused is pushed again after the wait, and only then goes to review', async () => {
  const w = copyWorld({ writeHead: true });
  must(w.rec.write({ actor: 'workshop', entity: 'fact', id: w.fact, expectRev: 0, kind: 'push', doc: { result: 'pushed', branch: 'b', tip: TIP, head_refused: 'the card moved', at: new Date(w.T).toISOString(), from: 'research', product: PRODUCT } }));
  await w.pass(w.T + RETRY_MS - 1);
  assert.equal(w.calls.length, 0, 'not before the wait');
  assert.equal(w.rec.read('card', w.card).doc.state, 'ready');
  await w.pass(w.T + RETRY_MS);
  assert.equal(w.calls.length, 1);
  assert.equal(w.rec.read('card', w.card).doc.state, 'in_review');
});

test('L387: another claim is not ours: a card someone else holds is never moved', async () => {
  const w = copyWorld({ writeHead: true });
  const k = w.rec.read('card', w.card);
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id: w.card, expectRev: k.rev, kind: 'test', doc: { ...k.doc, state: 'claimed', claim: { kind: 'tab', claim_id: 'someone-else', host: 'the-host' } } }));
  await w.pass();
  assert.equal(w.rec.read('card', w.card).doc.state, 'claimed');
  assert.equal(w.calls.length, 0);
});

test('L384 4: the tell stops when the card leaves ready, a queued one is dropped, and a later wait in ready is told afresh', async () => {
  const w = copyWorld();
  await w.pass();
  await w.pass(w.T + DAY);
  assert.equal(w.alerts.length, 1);
  assert.ok(w.rec.read('fact', READY_FACT(w.card)).doc.told_at);
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id: w.card, expectRev: w.rec.read('card', w.card).rev, kind: 'test', doc: { ...w.rec.read('card', w.card).doc, state: 'claimed', claim: { kind: 'tab', claim_id: 'copy-1', host: 'the-host' } } }), 'claim');
  await w.pass(w.T + 2 * DAY);
  await w.pass(w.T + 3 * DAY);
  assert.equal(w.alerts.length, 1, 'quiet once out of ready');
  assert.equal(w.rec.read('fact', READY_FACT(w.card)).doc.told_at, null, 'the mark is cleared, so a wait that comes back is told');
  assert.equal(w.calls.length, 1, 'a card out of ready is never pushed');
});
