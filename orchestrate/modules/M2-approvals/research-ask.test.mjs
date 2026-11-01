import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '../M4-workshop/hooks/plain-files.mjs';
import { makeSnapshot } from '../M4-workshop/hooks/snapshot.mjs';
import { intakePass, kindsFor } from '../M11-dispatcher/outbox-intake.mjs';
import { env as m2env, must, PRODUCT } from './fixtures.test-helper.mjs';
import { outboxFile as m9file } from '../M9-record/fixtures.test-helper.mjs';
import { checkOutboxFile, intakePush, outboxFile } from '../M1-front-door/outbox.mjs';
import { waitingItems, waitingLines } from '../M13-ledger/waiting.mjs';
import { askStore } from './ask-store.mjs';
import { landResearch, openResearchAsks, researchBrief, researchFileName, runLine } from './research-ask.mjs';

const SKILL = readFileSync(new URL('../M1-front-door/skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
const FAKE_KEY = ['sk', '_live_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join(''); // planted fake, never a real key

// The Front Door's "find out X": the file the skill writes, intake's check and push, then the record keeps it as a report.
function fileAsk(t, brief, id = '20261103-0915-ra', product = PRODUCT, sid = 'F-1') {
  const f = outboxFile('ask-request', id, { ask: 'research', product, brief });
  assert.equal(f.ok, true, f.reason);
  const c = checkOutboxFile(f.name, f.text, { products: [PRODUCT, 'other-app'], seenIds: [] });
  assert.equal(c.ok, true, c.reason);
  must(t.record.applyOutbox({ role: 'front_door', sessionId: sid }, m9file(t, 'front_door', sid, f.name, f.text)), 'ask request');
  return intakePush(f.name, c);
}

// STAND-IN for lane 2's R-0b-135 (rerun against the real intake once it merges): a `research-<ask>.md` from the owner's
// desktop session is taken in only while that research ask is open, onto a go-free research_copy card into
// docs/research/; the real M9 writer makes the binding and the one-card-per-ask rules.
function standIn135(t, name, text) {
  const m = /^research-(R-[1-9]\d{0,5})\.md$/.exec(name);
  if (!m) return { ok: false, reason: 'not a research file name' };
  const a = askStore(t.record).ask(m[1]);
  if (!a || a.doc.kind !== 'research' || a.doc.state !== 'open' || !a.doc.wait) return { ok: false, reason: `no open research ask ${m[1]}` };
  return t.record.write({ actor: 'dispatcher', entity: 'card', id: `RC-${m[1]}`, expectRev: 0, doc: { state: 'draft', product: PRODUCT,
    kind: 'research_copy', research_ask: m[1], module: 'docs', files: [`docs/research/${m[1]}.md`], done_when: 'the report is copied as it is',
    tier: 2, source: { file: name, sha256: createHash('sha256').update(text).digest('hex') } } });
}

test('R-0b-136: "find out X" puts a research ask with its brief on "waiting on you"', () => {
  const t = m2env();
  const push = fileAsk(t, 'find out how the top three rivals price their annual plan');
  assert.match(push, /^Request taken: research ask for sample-app\. Nothing has started yet/);
  const r = openResearchAsks(t.ctx);
  assert.deepEqual(r.refused, []);
  assert.equal(r.opened.length, 1);
  const { id } = r.opened[0];
  assert.equal(id, 'R-1');
  assert.match(r.opened[0].push, /research ask R-1 for sample-app: find out how the top three rivals price.*say "run research ask R-1"/);
  const lines = waitingLines(waitingItems(t.record));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ask R-1: waits on joe for "run research ask R-1" in a desktop session on the Mini: find out how the top three rivals price their annual plan, since 2026-/);
  // Once per report, also after a restart (the ask names its report).
  assert.deepEqual(openResearchAsks(t.ctx).opened, []);
  assert.equal(t.record.list('ask').length, 1);
});

test('R-0b-136: "run research ask R-1" needs nothing pasted, and the report lands in the record (stand-in for R-0b-135)', () => {
  const t = m2env();
  fileAsk(t, 'find out which payroll tools small agencies use');
  const { id } = openResearchAsks(t.ctx).opened[0];
  // The desktop session reads the brief and the file to leave from the record, by the ask's number alone.
  const b = researchBrief(t.record, id);
  assert.deepEqual(b, { ok: true, id, product: PRODUCT, brief: 'find out which payroll tools small agencies use', file: 'research-R-1.md' });
  assert.equal(runLine(id), 'run research ask R-1');
  const report = '# Payroll tools\n\nThree tools came up most.\n';
  must(standIn135(t, researchFileName(id), report), 'research report');
  const card = t.record.read('card', 'RC-R-1').doc;
  assert.equal(card.kind, 'research_copy'); assert.equal(card.research_ask, id);
  assert.equal(card.source.sha256, createHash('sha256').update(report).digest('hex'));
  // The ask leaves the waiting list; a second report for it is refused.
  must(landResearch(t.ctx, id), 'land');
  assert.deepEqual(waitingItems(t.record), []);
  assert.equal(t.record.read('ask', id).doc.landed.card, 'RC-R-1');
  assert.equal(standIn135(t, researchFileName(id), 'again').ok, false);
  assert.equal(researchBrief(t.record, id).ok, false, 'a landed ask is not run again');
  // A planted research file with no open ask is refused (R-0b-135's check, here in the stand-in).
  assert.match(standIn135(t, 'research-R-99.md', 'x').reason, /no open research ask R-99/);
});

test('R-0b-136: what opens nothing', () => {
  const t = m2env();
  // A brief holding a key never gets past the Front Door's check.
  const k = outboxFile('ask-request', '20261103-0915-rk', { ask: 'research', product: PRODUCT, brief: `find out why ${FAKE_KEY} fails` });
  assert.equal(checkOutboxFile(k.name, k.text).ok, false);
  // A changed report (never checked), another product's ask, and a report from another role are refused, not opened.
  must(t.record.applyOutbox({ role: 'front_door', sessionId: 'F-2' }, m9file(t, 'front_door', 'F-2', 'ask-request-20261103-0915-rb.json', '{"ask":"research","product":"sample-app","brief":"a\\u000ab"}\n')));
  fileAsk(t, 'find out the other thing', '20261103-0915-rc', 'other-app');
  must(t.record.applyOutbox({ role: 'incident', sessionId: 'I-1' }, m9file(t, 'incident', 'I-1', 'ask-request-20261103-0915-rd.json', '{"ask":"research","product":"sample-app","brief":"find out x"}\n')));
  const r = openResearchAsks(t.ctx);
  assert.deepEqual(r.opened, []);
  assert.equal(r.refused.length, 3);
  assert.deepEqual(r.refused.map((f) => f.reason).sort(), ['an ask request comes only from the Front Door', 'that product is not this record\'s', 'the file holds an escape (\\u); write plain text'].sort());
  assert.equal(t.alerts.filter((a) => a.kind === 'ask_request_refused').length, 3);
  // With a state folder, a refused report is alerted once, not on every pass (audit r1 Minor 11).
  const ctx = { ...t.ctx, stateDir: join(t.base, 'state') };
  t.alerts.length = 0;
  openResearchAsks(ctx); openResearchAsks(ctx);
  assert.equal(t.alerts.filter((a) => a.kind === 'ask_request_refused').length, 3);
  assert.equal(t.record.list('ask').length, 0);
  // L84 3: a state folder that can't be written loses no opened ask (its push still goes out); the failure is alerted.
  const blocked = join(t.base, 'not-a-folder');
  writeFileSync(blocked, 'a file, so no folder can be made here');
  fileAsk(t, 'find out the thing that must still open', '20261103-0915-rz');
  const r2 = openResearchAsks({ ...t.ctx, stateDir: join(blocked, 'state') });
  assert.equal(r2.opened.length, 1);
  assert.ok(t.alerts.some((a) => a.kind === 'research_refused_state_not_saved'));
  // The shapes the Front Door may not write.
  const bad = (doc) => checkOutboxFile('ask-request-20261103-0915-re.json', JSON.stringify(doc)).ok;
  assert.equal(bad({ ask: 'research', product: PRODUCT, brief: 'ok' }), true);
  assert.equal(bad({ ask: 'undo', product: PRODUCT, brief: 'ok' }), false, 'research only');
  assert.equal(bad({ ask: 'research', product: null, brief: 'ok' }), false, 'names its product');
  assert.equal(bad({ ask: 'research', product: PRODUCT, brief: 'x'.repeat(301) }), false);
  assert.equal(bad({ ask: 'research', product: PRODUCT, brief: 'a\nb' }), false);
  assert.equal(bad({ ask: 'research', product: PRODUCT, brief: 'ok', what: 'x' }), false);
  assert.equal(researchBrief(t.record, 'R-7').ok, false);
  assert.equal(researchBrief(t.record, '../R-1').ok, false);
});

test('R-0b-136: the skill writes the research ask in the shape intake takes', () => {
  const shape = /`(\{"ask":"research"[^`]+\})`/.exec(SKILL)?.[1];
  assert.ok(shape, 'the skill gives the ask-request shape');
  const filled = shape.replace('"X"', `"${PRODUCT}"`).replace(/"<[^"]+>"/, '"find out the churn rate"');
  assert.equal(checkOutboxFile('ask-request-20261103-0915-rf.json', filled, { products: [PRODUCT], seenIds: [] }).ok, true);
  assert.match(SKILL, /"run research ask R-12"/);
  assert.match(SKILL, /never ask the owner to paste it/);
  assert.doesNotMatch(SKILL, /Research asks, anything else/);
});

// Audit kit-lane3 r1 M-1: the real path, not applyOutbox directly. The Front Door's Write passes M4's plain-files hook
// (the role's kinds from its real profile), the Dispatcher's intake reads it with M4's readOutboxFile and hands it to the
// record, and the ask opens. It FAILS until lane 2's M4 fix lets the Front Door hand in `ask-request-` files; then
// drop the todo.
test('audit r1 M-1: a research ask handed in on the real path (hook, intake) reaches "waiting on you"',
  { todo: 'fails until lane 2 lets the Front Door hand in ask-request- files (M4 role-profiles, audit M-1) and intake may record its hand-in fact in the real record (M11 outbox-intake vs M9 permissions)' }, async () => {
    const t = m2env();
    const sid = 'F-1';
    const outbox = join(t.outRoot, 'front_door', sid);
    mkdirSync(outbox, { recursive: true });
    const snapshot = join(t.base, 'rules.json');
    writeFileSync(snapshot, makeSnapshot({ production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [] } }));
    const f = outboxFile('ask-request', '20261103-0915-rp', { ask: 'research', product: PRODUCT, brief: 'find out what the rivals charge' });
    const kinds = kindsFor({ role: 'front_door' });
    const hook = decide({ tool_name: 'Write', tool_input: { file_path: join(outbox, f.name), content: f.text } }, { role: 'front_door', outbox, snapshot, kinds });
    assert.equal(hook.block, false, `the Write hook blocked the Front Door's file: ${hook.reason}`);
    writeFileSync(join(outbox, f.name), f.text);
    const alerts = [];
    const out = await intakePass({ rec: t.record, sessions: [{ sessionId: sid, role: 'front_door', outbox, uid: process.getuid(), card: null, product: PRODUCT }],
      wait: async () => {}, alert: (a) => alerts.push(a), note: () => {}, startReadonly: async () => ({ ok: false }), replyToLead: () => {} });
    assert.equal(out[0]?.refused, undefined, `intake refused it: ${out[0]?.refused}`);
    const r = openResearchAsks(t.ctx);
    assert.equal(r.opened.length, 1, JSON.stringify(r.refused));
    assert.ok(waitingLines(waitingItems(t.record)).some((l) => l.includes('find out what the rivals charge')));
  });
