// research-intake.test.mjs — R-0b-135: a research report from the proposals folder goes onto one go-free research_copy
// card, only while its ask is open, carrying its bytes as proof; the merge gate lets the copy touch only that one path
// with those bytes (refusal 10). Real M9 Record, real M2 research asks, the real proposals intake.
// Run: node --test orchestrate/modules/M11-dispatcher/research-intake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchHandler, researchPass, researchCardDoc, researchPath, RESEARCH_CARD, RESEARCH_OFF } from './research-intake.mjs';
import { proposalsPass } from './proposals-intake.mjs';
import { NEVER_STARTED } from './pass.mjs';
import { outbox, sendAlerts } from './alerts.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { setup, must, PRODUCT, UID } from '../M9-record/fixtures.test-helper.mjs';
import { outboxFile as m9file } from '../M9-record/fixtures.test-helper.mjs';
import { checkOutboxFile, outboxFile } from '../M1-front-door/outbox.mjs';
import { openResearchAsks, researchBrief } from '../M2-approvals/research-ask.mjs';
import { waitingItems } from '../M13-ledger/waiting.mjs';
import { judge, researchCopyProblem } from '../M6-merge-gate/refusals.mjs';
import { blobSha } from '../M10-rules/reader.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';
import { GO_FREE_KEY } from '../M9-record/ready.mjs';

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
  const research = researchHandler({ rules: t.rules });
  // What the intake hands a handler (L290 M-1): the fenced text and the raw bytes' sha256, blob id and size; never the text.
  const hand = (id, text, over = {}) => research({ rec: t.record, product: PRODUCT, kind: 'research', id, name: `research-${id}.md`, source: 'research-file', fenced: cleanOutside(text, 'research-file'),
    sha256: sha(text), blob: blobSha(Buffer.from(text)), size: Buffer.byteLength(text), now: t.clock.t, ...over });
  return { t, rec: t.record, research, hand };
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
  assert.equal(w.rec.list('card').length, 0);
  // Taken in once; the ask has landed, so a second report for it is refused.
  assert.equal(w.hand('R-2', REPORT).ok, true);
  assert.match(w.hand('R-2', 'a second take').reason, /research ask R-2 is not open/);
  assert.equal(w.rec.list('card').length, 1);
});

test('restart-safe: a card written before a crash is landed by the same bytes or by the next researchPass; other bytes are refused', () => {
  const w = world({ asks: 2 });
  // The card is written, then the pass stops before landing (here: written directly, as the handler writes it).
  must(w.rec.write({ actor: 'dispatcher', entity: 'card', id: RESEARCH_CARD('R-1'), expectRev: 0, kind: 'research_card',
    doc: researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha(REPORT), blob: blobSha(Buffer.from(REPORT)), size: 10 }) }), 'card');
  assert.match(w.hand('R-1', 'other bytes').reason, /R-1 already has its research_copy card/);
  assert.match(w.hand('R-1', REPORT, { blob: 'b'.repeat(40) }).reason, /R-1 already has its research_copy card/, 'same sha256, another blob');
  assert.equal(w.hand('R-1', REPORT).ok, true);
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.state, 'ready');
  assert.ok(w.rec.read('ask', 'R-1').doc.landed);
  // researchPass: a card left in draft by a paused product goes ready once the product is active again.
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  assert.equal(w.hand('R-2', REPORT).ok, true, 'the file is used; the card waits in draft');
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-2')).doc.state, 'draft');
  assert.ok(w.rec.read('ask', 'R-2').doc.landed, 'the owner\'s part is done: the ask leaves the waiting list');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t }).map(([, x]) => x.replace(/:.*/, '')), ['not ready']);
  must(w.rec.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.rec.read('product', PRODUCT).rev, doc: { state: 'active' } }), 'resume');
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t }), [[RESEARCH_CARD('R-2'), 'ready']]);
  assert.deepEqual(researchPass({ rec: w.rec, now: w.t.clock.t }), [], 'nothing left to do');
});

test('through the real proposals intake: taken in once, and a refusal is told to the owner once', async () => {
  const w = world({ asks: 1 });
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
  await pass();
  await pass();
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.source.sha256, sha(REPORT));
  assert.equal(w.rec.list('card').length, 1);
  assert.equal(alerts.filter((a) => /research-R-7\.md/.test(a) && /there is no research ask R-7/.test(a)).length, 1, 'told once');
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
