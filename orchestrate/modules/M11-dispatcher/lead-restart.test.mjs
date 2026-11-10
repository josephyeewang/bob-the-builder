import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { leadRestartStep, leadInFlight, recordLeadLaunch, handoffVet, estimateTokens, RESTART_FACT, HANDOFF_NAME } from './lead-restart.mjs';
import { intakePass } from './outbox-intake.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, change, T0, MIN, iso, withAlerts, handoffNote } from './fixtures.test-helper.mjs';
import { rulesFromText } from '../M10-rules/from-text.mjs';
import { leadLaunchHead } from '../../shared/record.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { handoffText } from '../M3-lead/handoff.mjs';

const R = rulesWith(); // soft 250k, hard 400k, handoff cap 8,000 tokens
const SID = 'L-1';
const UID = process.getuid();
const ended = (tokens, atMin = 0) => ({ tokens, turnEnded: true, endedAt: T0 + atMin * MIN, openTools: [], compactions: 0 });
const midTurn = (tokens) => ({ tokens, turnEnded: false, endedAt: null, openTools: ['t1'], compactions: 0 });

function world() {
  const outbox = join(tempDir('m11-lead-'), 'lead');
  mkdirSync(outbox);
  const calls = { sent: [], stops: 0, starts: [], alerts: [] };
  let outcome = 'sent';
  let rec = recWith();
  const step = (size, min, over = {}) => withAlerts(rec, T0 + min * MIN, over.alert ?? ((t) => calls.alerts.push(t)), (alert) => leadRestartStep({
    rec, rules: over.rules ?? R, now: T0 + min * MIN, lead: { sessionId: SID, product: 'p' }, size, alert: over.answer ?? alert,
    inFlight: over.inFlight ?? null, handoffRefused: over.handoffRefused,
    send: async (t) => { calls.sent.push(t); return { outcome }; },
    stopSession: async () => { calls.stops += 1; return over.stopFails ? { ok: false, reason: 'still running' } : { ok: true }; },
    startLead: async (x) => { calls.starts.push(x); return over.startFails ? { ok: false, reason: 'no' } : { ok: true, sessionId: 'L-2' }; },
    mainSha: over.mainSha ?? (async () => 'a'.repeat(40)),
  }));
  // The pass's own intake, with the handoff vet, over the Lead's real outbox folder.
  const intake = (min = 3, { product = 'p', vet = handoffVet(R) } = {}) => intakePass({ rec, now: T0 + min * MIN, sessions: [{ sessionId: SID, role: 'lead', outbox, uid: UID, product: product ?? undefined }], wait: async () => {},
    alert: (t) => calls.alerts.push(t), note: () => {}, startReadonly: () => ({ ok: true }), replyToLead: () => {}, vet });
  const handIn = (bytes) => writeFileSync(join(outbox, HANDOFF_NAME(SID)), handoffNote(bytes));
  return { rec, calls, step, intake, handIn, outbox, refuse: (o) => { outcome = o; }, useRec: (r) => { rec = r; } };
}
const phase = (rec) => rec.read('fact', RESTART_FACT(SID))?.doc?.phase ?? 'none';

test('m8: the handoff estimate is ceil(bytes / 4); 31,000 bytes is accepted and 33,000 refused', () => {
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('é'), 1); // 2 utf-8 bytes
  const vet = handoffVet(R);
  const session = { product: 'p' };
  assert.equal(vet({ session, kind: 'handoff-', text: handoffNote(31_000) }), null);
  assert.match(vet({ session, kind: 'handoff-', text: handoffNote(33_000) }), /8250 tokens, over the 8000 cap/);
  assert.equal(vet({ session, kind: 'handoff-', text: handoffNote(32_000) }), null); // exactly the cap
  assert.equal(vet({ session, kind: 'wish-', text: 'x'.repeat(99_000) }), null);
});

// On the real engine a per-product key read with no product is missing, so these read real rules text, with no stand-in
// (L564, L115). Every value differs from the test rules', so a value from anywhere else fails.
const REAL = rulesFromText({ p: `${readFileSync(new URL('../M10-rules/fixtures/policy.yaml', import.meta.url), 'utf8')}
context:
  lead:
    soft: 150000
    hard: 300000
  handoff_cap:
    role: 4000
` });

test('L564: the Lead step reads each context line for its product, from real rules text', async () => {
  const w = world();
  assert.equal(await w.step(ended(149_000), 0, { rules: REAL }), 'under the soft line');
  assert.equal(await w.step(ended(351_000), 1, { rules: REAL }), 'WRAP sent');
  assert.match(w.calls.sent[0], /under 4000 tokens/);
  assert.match(w.calls.alerts[0], /past 300000 \+ 50000: its compaction did not happen/);
});

test('L564: the handoff check reads the cap for the session\'s product, and a session with no product is refused, its file kept', async () => {
  const vet = handoffVet(REAL);
  const session = { product: 'p' };
  assert.equal(vet({ session, kind: 'handoff-', text: handoffNote(16_000) }), null);
  assert.match(vet({ session, kind: 'handoff-', text: handoffNote(16_004) }), /4001 tokens, over the 4000 cap/);
  assert.throws(() => vet({ session: {}, kind: 'handoff-', text: 'x' }), /names no product, so context\.handoff_cap\.role/);
  assert.throws(() => vet({ session: { product: 'nobody' }, kind: 'handoff-', text: 'x' }), /context\.handoff_cap\.role/);
  // Through intake, as production calls it: a session with no product gets "could not be checked", and the file waits.
  const w = world();
  w.handIn(100);
  const [r] = await w.intake(3, { product: null, vet });
  assert.match(r.refused, /^could not be checked/);
  assert.equal(readdirSync(w.outbox).length, 1);
});

test('L584 m1: a Lead told about the hard line mid-turn still gets its WRAP at the finished turn', async () => {
  const w = world();
  assert.equal(await w.step(midTurn(451_000), 0), 'mid-turn');
  assert.equal(w.calls.alerts.length, 1);
  assert.equal(await w.step(ended(452_000, 1), 1), 'WRAP sent');
  assert.match(w.calls.sent[0], /^WRAP: /);
});

test('M18: 260k at a finished turn with nothing in flight -> WRAP; the handoff applied -> restarted on it', async () => {
  const w = world();
  assert.equal(await w.step(ended(240_000), 0), 'under the soft line');
  assert.equal(await w.step(ended(260_000), 1), 'WRAP sent');
  assert.match(w.calls.sent[0], /^WRAP: .*handoff-L-1\.md, in the handoff shape your wording gives \(every heading, once, in order\), under 8000 tokens/);
  assert.equal(await w.step(midTurn(262_000), 2), 'mid-turn');
  w.handIn(31_000);
  await w.intake();
  assert.equal(await w.step(ended(265_000, 3), 3), 'restarted');
  assert.equal(w.calls.stops, 1);
  assert.deepEqual(w.calls.starts, [{ handoff: 'handoff-L-1' }]);
  // The handoff is the Lead's own record, made from its file by applyOutbox (L74): one entry, written as the Lead.
  const handoffs = w.rec.list('handoff');
  assert.deepEqual(handoffs.map((h) => [h.doc.session_id, w.rec.meta('handoff', h.id).createdBy]), [[SID, `lead:${SID}`]]);
  assert.equal(phase(w.rec), 'done');
  assert.equal(await w.step(ended(265_000, 4), 4), 'done');
  assert.equal(w.calls.sent.length, 1);
});

test('M18: WRAP refused while the Lead waits on an answer is tried again at the next finished turn', async () => {
  const w = world();
  w.refuse('suppressed_awaiting_user');
  assert.match(await w.step(ended(260_000), 1), /WRAP not sent \(suppressed_awaiting_user\)/);
  assert.equal(phase(w.rec), 'none');
  assert.equal(await w.step(midTurn(261_000), 2), 'mid-turn');
  assert.equal(w.calls.sent.length, 1, 'never sent mid-turn');
  w.refuse('sent');
  assert.equal(await w.step(ended(262_000), 3), 'WRAP sent');
});

test('M18: anything in flight blocks the WRAP', async () => {
  const w = world();
  assert.equal(await w.step(ended(260_000), 1, { inFlight: 'a question box is open' }), 'waiting: a question box is open');
  assert.equal(w.calls.sent.length, 0);
  // what leadInFlight finds
  // The Record has no Lead waiter: a card waiting on the Lead's split waits on a dependency, needs_split.
  const split = { who: 'dependency', what: 'needs_split', since: iso(T0), next_check: iso(T0), resume: 'continue', return_to: 'ready' };
  const rec = recWith([['card', 'C-1', { state: 'waiting', wait: split }]]);
  assert.match(leadInFlight({ rec, sessionId: SID, outboxNames: [], questionOpen: false }), /card C-1 waits on the Lead/);
  assert.match(leadInFlight({ rec: recWith(), sessionId: SID, outboxNames: ['wish-1.md'], questionOpen: false }), /wish-1\.md not used yet/);
  assert.match(leadInFlight({ rec: recWith(), sessionId: SID, outboxNames: ['.wish-1.md.partial'], questionOpen: false }), /not used yet/);
  assert.match(leadInFlight({ rec: recWith(), sessionId: SID, outboxNames: [], questionOpen: true }), /question box/);
  const used = recWith([['fact', `intake-applied-${SID}-wish-1.md`, { state: 'applied' }], ['card', 'C-1', { state: 'waiting', wait: { ...split, who: 'joe', what: 'approve' } }]]);
  assert.equal(leadInFlight({ rec: used, sessionId: SID, outboxNames: ['wish-1.md'], questionOpen: false }), null);
});

test('M18: an oversize handoff gets one re-ask; a second miss keeps the old Lead and alerts Joe', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(33_000);
  const r = await w.intake();
  assert.match(r[0].refused, /over the 8000 cap/);
  assert.equal(await w.step(ended(262_000, 2), 2), 're-asked');
  assert.match(w.calls.sent[1], /not used .*Write handoff-L-1\.md again/);
  // the Lead writes it again under the same name, still too big
  w.handIn(40_000);
  await w.intake();
  assert.equal(await w.step(ended(263_000, 3), 3), 'gave up; the old Lead keeps running');
  assert.equal(w.calls.stops, 0, 'never stopped without an applied handoff');
  assert.equal(w.calls.alerts.length, 1);
  assert.equal(await w.step(ended(264_000, 4), 4), 'gave_up');
});

// R-0b-143, L87 M-2 (b) and (c): the vet also reads the note as M3's one shape, before the old Lead is stopped.
const GOOD_TYPED = '# Lead handoff\n\n## Claim\nLead of product p, session L-1\n\n## Open card\nC-3\n\n## Next step\nsend C-4\n\n## Decisions\n- export format: Markdown only (1 Nov)\n\n## Messages\n- queued: ask the owner about pricing\n';
const handInText = (w, text) => writeFileSync(join(w.outbox, HANDOFF_NAME(SID)), text);

test('R-0b-143: the handoff vet refuses a note that does not read as the one shape, whatever its size', () => {
  const vet = handoffVet(R);
  const session = { product: 'p' };
  assert.equal(vet({ session, kind: 'handoff-', text: GOOD_TYPED }), null);
  assert.equal(vet({ session, kind: 'handoff-', text: handoffText({ claim: 'c', next: 'n' }) }), null);
  for (const [bad, why] of [
    [GOOD_TYPED.replace('## Messages', '## Queued requests\n- pricing\n\n## Messages'), /does not read: the headings must be exactly/],
    [GOOD_TYPED.replace(' (1 Nov)', ''), /does not read: a decision line is not/],
    [GOOD_TYPED.replace('# Lead handoff', '# Handoff'), /does not read: not a Lead handoff/],
    [GOOD_TYPED.replace('send C-4', 'none'), /does not read: the handoff has no Next step/],
    ['', /does not read/],
    ['x'.repeat(1_000), /does not read/],
  ]) assert.match(vet({ session, kind: 'handoff-', text: bad }) ?? 'used', why, JSON.stringify(bad.slice(0, 60)));
  // The cap is still checked first, and a Lead's own line in the reason is one line and cut.
  assert.match(vet({ session, kind: 'handoff-', text: 'x'.repeat(33_000) }), /over the 8000 cap/);
  const long = vet({ session, kind: 'handoff-', text: GOOD_TYPED.replace('- export format: Markdown only (1 Nov)', `- ${'y'.repeat(500)}`) });
  assert.ok(long.length <= 'the handoff does not read: '.length + 200 && !long.includes('\n'), long);
});

test('R-0b-143 (c): a hand-typed note that does not read, through the composed vet: refused, re-asked, the old Lead not stopped', async () => {
  const w = world();
  assert.equal(await w.step(ended(260_000), 1), 'WRAP sent');
  assert.match(w.calls.sent[0], /in the handoff shape your wording gives/);
  handInText(w, GOOD_TYPED.replace('## Messages', '## Queued requests\n- pricing\n\n## Messages'));
  const [r] = await w.intake();
  assert.match(r.refused, /^the handoff does not read: /);
  assert.equal(w.rec.read('fact', `intake-applied-${SID}-${HANDOFF_NAME(SID)}`), null, 'not marked used, so it can be written again');
  assert.equal(w.rec.list('handoff').length, 0);
  assert.equal(await w.step(ended(262_000, 2), 2, { handoffRefused: r.refused }), 're-asked');
  assert.match(w.calls.sent[1], /not used \(the handoff does not read: the headings must be exactly .*\)\. Write handoff-L-1\.md again/);
  assert.equal(w.calls.stops, 0, 'never stopped on a note that does not read');
  assert.deepEqual(w.calls.starts, []);
  // Written again in the shape: used, and the restart goes ahead.
  handInText(w, GOOD_TYPED);
  const [again] = await w.intake();
  assert.equal(again.refused, undefined);
  assert.equal(await w.step(ended(263_000, 3), 3), 'restarted');
  assert.equal(w.calls.stops, 1);
  assert.deepEqual(w.calls.starts, [{ handoff: 'handoff-L-1' }]);
});

test('R-0b-143 (c): a second note that does not read keeps the old Lead running, and the owner is told why', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  handInText(w, '# Lead handoff\n\nclaim: p\nnext: carry on\n');
  const [r] = await w.intake();
  assert.equal(await w.step(ended(262_000, 2), 2, { handoffRefused: r.refused }), 're-asked');
  handInText(w, GOOD_TYPED.replace(' (1 Nov)', ''));
  const [r2] = await w.intake();
  assert.equal(await w.step(ended(263_000, 3), 3, { handoffRefused: r2.refused }), 'gave up; the old Lead keeps running');
  assert.equal(w.calls.stops, 0);
  assert.match(w.calls.alerts.join(' | '), /did not hand in a usable handoff after a second ask \(the handoff does not read: a decision line/);
});

test('M18: an oversize handoff rewritten small after the re-ask is used (same name, not refused)', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(33_000);
  await w.intake();
  await w.step(ended(262_000, 2), 2);
  w.handIn(20_000);
  await w.intake();
  assert.equal(await w.step(ended(263_000, 3), 3), 'restarted');
  assert.equal(w.calls.alerts.length, 0);
});

test('M18: a missing handoff: the turn before the WRAP does not count; after the answer, one re-ask', async () => {
  const w = world();
  await w.step(ended(260_000, 0), 1);
  assert.equal(await w.step(ended(260_000, 0), 2), 'waiting for the handoff'); // the same old turn
  assert.equal(await w.step(ended(261_000, 2), 3), 're-asked');
  assert.equal(await w.step(ended(261_000, 2), 4), 'waiting for the handoff');
  assert.equal(await w.step(ended(262_000, 5), 5), 'gave up; the old Lead keeps running');
  assert.equal(w.calls.stops, 0);
});

test('M18: the new Lead failing to start alerts', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  assert.equal(await w.step(ended(261_000, 2), 2, { startFails: true }), 'stopped; new Lead failed to start');
  assert.equal(w.calls.alerts.length, 1);
  // audit 0b-6 r2 MIN-1: tried again every pass, one alert in all, never a second stop; mid-turn does not block it.
  assert.equal(await w.step(midTurn(261_000), 3, { startFails: true }), 'new Lead still not started; tried again next pass');
  assert.equal(await w.step(null, 4), 'restarted', 'the stopped Lead\'s transcript need not be readable');
  assert.equal(w.calls.alerts.length, 1);
  assert.equal(w.calls.stops, 1);
  assert.equal(w.calls.starts.length, 3);
  assert.equal(phase(w.rec), 'done');
});

// L130: `answer` stands in for the outbox's own answer; false (not queued) writes no told field, so the next pass tells.
test('L130: a start failure whose alert was not queued is told on the next pass, once', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  assert.equal(await w.step(ended(261_000, 2), 2, { startFails: true, answer: () => false }), 'stopped; new Lead failed to start');
  assert.equal(w.calls.alerts.length, 0);
  assert.equal(w.rec.read('fact', RESTART_FACT(SID)).doc.start_failed_told, undefined, 'not marked told');
  await w.step(midTurn(261_000), 3, { startFails: true });
  assert.equal(w.calls.alerts.length, 1);
  assert.equal(w.rec.read('fact', RESTART_FACT(SID)).doc.start_failed_told, true);
  await w.step(midTurn(261_000), 4, { startFails: true });
  assert.equal(w.calls.alerts.length, 1, 'told once');
});

test('L130: a give-up whose alert was not queued is told on the next pass, once', async () => {
  const w = world();
  await w.step(ended(260_000, 0), 1);
  await w.step(ended(261_000, 2), 3);
  assert.equal(await w.step(ended(262_000, 5), 5, { answer: () => false }), 'gave up; the old Lead keeps running');
  assert.equal(w.calls.alerts.length, 0);
  assert.equal(w.rec.read('fact', RESTART_FACT(SID)).doc.gave_up_told, undefined);
  await w.step(ended(262_000, 5), 6);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /gave up|handoff/i);
  await w.step(ended(262_000, 5), 7);
  assert.equal(w.calls.alerts.length, 1, 'told once');
});

test('M18 / m9: 410k mid-turn sends no WRAP; above hard + 50k alerts once', async () => {
  const w = world();
  assert.equal(await w.step(midTurn(410_000), 1), 'mid-turn');
  assert.equal(w.calls.sent.length, 0);
  assert.equal(w.calls.alerts.length, 0);
  await w.step(midTurn(451_000), 2);
  await w.step(midTurn(460_000), 3);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /compaction did not happen/);
  assert.equal(w.calls.sent.length, 0);
});

test('the lines come from the rules', async () => {
  const w = world();
  assert.equal(await w.step(ended(160_000), 1, { rules: rulesWith({ [K.leadSoft]: 150_000 }) }), 'WRAP sent');
  await assert.rejects(() => world().step(ended(1), 1, { rules: rulesWith({ [K.leadSoft]: undefined }) }), /context\.lead\.soft/);
  assert.throws(() => handoffVet(rulesWith({ [K.handoffCapRole]: undefined }))({ session: { product: 'p' }, kind: 'handoff-', text: '' }), /handoff_cap/);
  assert.equal(readdirSync(w.outbox).length, 0);
});

test('the transcript reader gives the finished turn its time, or null', async () => {
  const { readSize, parseTranscript } = await import('./transcript.mjs');
  const line = (o) => JSON.stringify(o);
  const a = (extra) => line({ type: 'assistant', message: { stop_reason: 'end_turn', usage: { input_tokens: 1 }, content: [] }, ...extra });
  assert.equal(readSize(parseTranscript(a({ timestamp: iso(T0) }))).endedAt, T0);
  assert.equal(readSize(parseTranscript(a({}))).endedAt, null);
  assert.equal(readSize(parseTranscript([a({ timestamp: iso(T0) }), line({ type: 'user', message: { content: 'go' }, timestamp: iso(T0 + 1) })].join('\n'))).endedAt, null);
});

test('audit MAT-8: a failed stop alerts once, starts no new Lead, and is tried again', async () => {
  const w = world();
  assert.equal(await w.step(ended(260_000), 1), 'WRAP sent');
  w.handIn(1_000);
  await w.intake();
  assert.equal(await w.step(ended(265_000, 3), 3, { stopFails: true }), 'old Lead not stopped; tried again next pass');
  assert.equal(await w.step(ended(265_000, 4), 4, { stopFails: true }), 'old Lead not stopped; tried again next pass');
  assert.equal(w.calls.stops, 2);
  assert.equal(w.calls.starts.length, 0, 'two Leads never run at once');
  assert.equal(w.calls.alerts.filter((a) => /could not be stopped/.test(a)).length, 1);
  assert.equal(await w.step(ended(265_000, 5), 5), 'restarted');
  assert.equal(w.calls.stops, 3);
  assert.deepEqual(w.calls.starts, [{ handoff: 'handoff-L-1' }]);
});

test('audit MIN-13: a handoff that was refused or not recorded never stops the old Lead', async () => {
  const w = world();
  assert.equal(await w.step(ended(260_000), 1), 'WRAP sent');
  // the intake refused the handoff (the record would not take it): re-asked, never stopped
  const key = `intake-applied-${SID}-handoff-${SID}.md`;
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: key, expectRev: 0, doc: { session: SID, name: `handoff-${SID}.md`, sha256: 'x', state: 'refused' } });
  assert.equal(await w.step(ended(265_000, 3), 3), 're-asked');
  assert.match(w.calls.sent[1], /the record refused it/);
  assert.equal(w.calls.stops, 0);
  assert.equal(w.calls.starts.length, 0);
  // Applied, but the Record holds no handoff the Lead wrote (L74: the Lead's own entry, made by applyOutbox): not
  // stopped. Neither when the entry is missing, nor when one names this session but another role wrote it (look-alike).
  const w2 = world();
  assert.equal(await w2.step(ended(260_000), 1), 'WRAP sent');
  w2.handIn(1_000);
  await w2.intake();
  const base = { read: (...a) => w2.rec.read(...a), list: (...a) => w2.rec.list(...a), meta: (...a) => w2.rec.meta(...a), write: (a) => w2.rec.write(a) };
  const missing = { ...base, list: (e) => (e === 'handoff' ? [] : w2.rec.list(e)) };
  const lookalike = { ...base, meta: (e, id) => (e === 'handoff' ? { ...w2.rec.meta(e, id), createdBy: `learning:${SID}` } : w2.rec.meta(e, id)) };
  const run = (rec) => leadRestartStep({ rec, rules: R, now: T0 + 3 * MIN, lead: { sessionId: SID, product: 'p' }, size: ended(265_000, 3), inFlight: null,
    send: async () => ({ outcome: 'sent' }), stopSession: async () => { w2.calls.stops += 1; return { ok: true }; }, startLead: async () => { w2.calls.starts.push(1); return { ok: true, sessionId: 'L-2' }; }, mainSha: async () => 'a'.repeat(40), alert: fakeAlert() });
  assert.equal(await run(missing), 'handoff not recorded yet');
  assert.equal(await run(lookalike), 'handoff not recorded yet', 'a handoff another role wrote is not the Lead\'s');
  assert.equal(w2.calls.stops, 0);
  assert.equal(w2.calls.starts.length, 0);
  // Control: the same pass on the record as it is restarts the Lead.
  assert.equal(await run(base), 'restarted');
});

test('audit 0b-6 r2 MAT-3: a handoff applied before the WRAP never restarts the Lead; one applied after it does', async () => {
  const w = world();
  w.handIn(1_000);
  await w.intake(0);
  assert.equal(await w.step(ended(260_000), 1), 'WRAP sent');
  // The Lead writes a new handoff under the same name: intake refuses it as new content.
  w.handIn(2_000);
  await w.intake(2);
  assert.equal(await w.step(ended(262_000, 2), 3), 're-asked');
  assert.equal(w.calls.stops, 0, 'never stopped on the old note');
  assert.deepEqual(w.calls.starts, []);
  assert.match(w.calls.sent[1], /already used before the WRAP/);
  // An old fact with no time recorded counts as older too.
  const v = world();
  assert.equal(await v.step(ended(260_000), 1), 'WRAP sent');
  v.rec.write({ actor: 'dispatcher', entity: 'fact', id: `intake-applied-${SID}-${HANDOFF_NAME(SID)}`, expectRev: 0, doc: { state: 'applied', sha256: 'a'.repeat(64) } });
  assert.notEqual(await v.step(ended(262_000, 2), 3), 'restarted');
  assert.equal(v.calls.stops, 0);
});

// ---- audit 0b-6 round 3 ----

test('audit 0b-6 r3 MAT-4: a read-only request waiting on a refusal is not in flight; one not yet used still is', () => {
  const rec = recWith([['fact', 'intake-applied-L-1-think-q1.md', { session: SID, name: 'think-q1.md', state: 'waiting', reason: 'the red band holds it' }],
    ['fact', 'intake-applied-L-1-scout-q2.md', { session: SID, name: 'scout-q2.md', state: 'starting' }]]);
  assert.equal(leadInFlight({ rec, sessionId: SID, outboxNames: ['think-q1.md'], questionOpen: false }), null);
  assert.match(leadInFlight({ rec, sessionId: SID, outboxNames: ['think-q1.md', 'scout-q2.md'], questionOpen: false }), /scout-q2\.md not used yet/);
});

test('audit 0b-6 r3 MIN-3: a handoff applied in the same pass that sent WRAP is older than the WRAP and not used; Cosmetic 1: the re-ask time is not the WRAP time', async () => {
  const w = world();
  assert.equal(await w.step(ended(260_000, 1), 1), 'WRAP sent');
  w.handIn(1_000);
  await w.intake(1);
  assert.notEqual(await w.step(ended(262_000, 2), 2), 'restarted');
  assert.equal(w.calls.stops, 0);
  // After a re-ask, a hand-off applied between the WRAP and the re-ask still counts (it is after the WRAP).
  const v = world();
  assert.equal(await v.step(ended(260_000, 1), 1), 'WRAP sent');
  assert.equal(await v.step(ended(261_000, 2), 2), 're-asked');
  v.handIn(1_000);
  await v.intake(2.5);
  const f = v.rec.read('fact', RESTART_FACT(SID));
  v.rec.write({ actor: 'dispatcher', entity: 'fact', id: RESTART_FACT(SID), expectRev: f.rev, doc: { ...f.doc, sent_at: iso(T0 + 3 * MIN) } });
  assert.equal(await v.step(ended(262_000, 4), 4), 'restarted');
});

// Audit 0b-6 r5 MAT-2: the Lead's alerts are marked told only once sent; one that fails is sent next pass.
test('r5 MAT-2: a hard-line alert that fails is told on the next pass, once', async () => {
  for (const bad of [() => { throw new Error('down'); }, () => Promise.reject(new Error('down'))]) {
    const w = world();
    const sent = [];
    let down = true;
    const alert = (t) => (down ? bad(t) : sent.push(t));
    await w.step(midTurn(460_000), 1, { alert });
    down = false;
    await w.step(midTurn(461_000), 2, { alert });
    await w.step(midTurn(462_000), 3, { alert });
    assert.equal(sent.filter((t) => /compaction did not happen/.test(t)).length, 1, sent.join(' | '));
  }
});

// R-0b-170 (L460): every Lead start leaves a launch record naming main as it was before the start.
const launches = (rec) => rec.list('launch').map((l) => l.doc);

test('R-0b-170: a restarted Lead has a launch record naming main read before the start', async () => {
  const w = world();
  const order = [];
  const mainSha = async (x) => { order.push(['main', x.product, w.calls.starts.length]); return 'b'.repeat(40); };
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  assert.equal(await w.step(ended(261_000, 2), 2, { mainSha }), 'restarted');
  assert.deepEqual(order, [['main', 'p', 0]], 'read once, before the start');
  const [l] = launches(w.rec);
  assert.deepEqual([l.session_id, l.role, l.card, l.head, l.rev, l.product], ['L-2', 'lead', null, 'b'.repeat(40), null, 'p']);
  assert.equal(leadLaunchHead(w.rec, 'L-2').head, 'b'.repeat(40));
  assert.equal(w.calls.alerts.length, 0);
});

test('R-0b-170: a start that failed and was tried again leaves one launch record, from the try that worked', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  await w.step(ended(261_000, 2), 2, { startFails: true });
  assert.deepEqual(launches(w.rec), []);
  assert.equal(await w.step(null, 3, { mainSha: async () => 'c'.repeat(40) }), 'restarted');
  assert.deepEqual(launches(w.rec).map((l) => l.head), ['c'.repeat(40)]);
});

test('R-0b-170: main unreadable at the start: the Lead still starts, no record is written, and the owner is told why its plans will wait', async () => {
  for (const mainSha of [async () => { throw new Error('GitHub is down'); }, async () => null, async () => 'not a sha']) {
    const w = world();
    await w.step(ended(260_000), 1);
    w.handIn(1000);
    await w.intake();
    assert.equal(await w.step(ended(261_000, 2), 2, { mainSha }), 'restarted');
    assert.deepEqual(launches(w.rec), []);
    assert.equal(w.calls.alerts.length, 1);
    assert.match(w.calls.alerts[0], /the Lead L-2 started with no launch record, so its plans will be refused: the main commit could not be read/);
  }
});

test('L490 m5: main unreadable at a start is tried again each pass for that session, quietly, until the record is written', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  const down = async () => { throw new Error('GitHub is down'); };
  await w.step(ended(261_000, 2), 2, { mainSha: down });
  assert.deepEqual(launches(w.rec), []);
  const next = (min, mainSha) => leadRestartStep({ rec: w.rec, rules: R, now: T0 + min * MIN, lead: { sessionId: 'L-2', product: 'p' }, size: ended(1000, min), alert: fakeAlert(), inFlight: null, mainSha,
    send: async () => ({ outcome: 'sent' }), stopSession: async () => ({ ok: true }), startLead: async () => ({ ok: true, sessionId: 'L-3' }) });
  const lines = w.rec.diary().length;
  await next(3, down);
  await next(4, down);
  assert.deepEqual(launches(w.rec), []);
  assert.equal(w.rec.diary().length, lines, 'still unreadable: nothing moved, so nothing is written');
  await next(5, async () => 'c'.repeat(40));
  assert.deepEqual(launches(w.rec).map((l) => [l.session_id, l.head]), [['L-2', 'c'.repeat(40)]]);
  await next(6, async () => 'd'.repeat(40));
  assert.equal(launches(w.rec).length, 1, 'written once');
});

test('L494 Minor 6: a retry mark that can\'t be cleared adds no second launch record, and is told once a day', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  await w.step(ended(261_000, 2), 2, { mainSha: async () => { throw new Error('down'); } });
  const rec = Object.create(w.rec, { write: { value: (x) => (x.kind === 'lead_launch_pending' ? { ok: false, reason: 'turned down' } : w.rec.write(x)) } });
  const owner = fakeAlert();
  const next = (min) => withAlerts(rec, T0 + min * MIN, owner, (alert) => leadRestartStep({ rec, rules: R, now: T0 + min * MIN, lead: { sessionId: 'L-2', product: 'p' }, size: ended(1000, min), alert, inFlight: null, mainSha: async () => 'c'.repeat(40),
    send: async () => ({ outcome: 'sent' }), stopSession: async () => ({ ok: true }), startLead: async () => ({ ok: true, sessionId: 'L-3' }) }));
  for (let min = 3; min < 9; min++) await next(min);
  assert.equal(launches(w.rec).length, 1);
  const told = owner.texts.map((t) => t?.text ?? t);
  assert.equal(told.filter((t) => /the Lead L-2 has a launch record, but its retry mark could not be cleared \(turned down\)/.test(t)).length, 1, told.join(' | '));
});

test('L494 Minor 6: a retry that can\'t be saved is told, as nothing will try again', async () => {
  const w = world();
  await w.step(ended(260_000), 1);
  w.handIn(1000);
  await w.intake();
  const rec = Object.create(w.rec, { write: { value: (x) => (x.kind === 'lead_launch_pending' ? { ok: false, reason: 'turned down' } : w.rec.write(x)) } });
  w.useRec(rec);
  await w.step(ended(261_000, 2), 2, { mainSha: async () => { throw new Error('down'); } });
  assert.equal(w.calls.alerts.filter((t) => /the Lead L-2 has no launch record, and its retry could not be saved, so nothing will try again \(turned down\)/.test(t?.text ?? t)).length, 1, JSON.stringify(w.calls.alerts));
});

test('L490 m5: a Lead that was never marked is not given a launch record by a pass', async () => {
  const w = world();
  await w.step(ended(1000), 1);
  assert.deepEqual(launches(w.rec), []);
});

test('L490 m5: a start that names no session has its own cause and is told, whatever it answered', () => {
  for (const sessionId of [undefined, null, 'not a session!']) {
    const w = world();
    const alert = fakeAlert();
    recordLeadLaunch({ rec: w.rec, now: T0, alert, sessionId, head: 'a'.repeat(40) });
    assert.equal(alert.texts.length, 1);
    assert.equal(alert.calls?.[0]?.[1]?.mark?.fact ?? 'hold-lead-launch-no-session', 'hold-lead-launch-no-session');
    assert.match(alert.texts[0].text ?? alert.texts[0], /^a Lead started with no launch record, so its plans will be refused: the start named no session/);
  }
});

test('R-0b-170: recordLeadLaunch refuses a start that named no session, and says so', () => {
  const w = world();
  const alert = fakeAlert();
  const r = recordLeadLaunch({ rec: w.rec, now: T0, alert, sessionId: undefined, head: 'a'.repeat(40) });
  assert.equal(r.ok, false);
  assert.deepEqual(launches(w.rec), []);
  assert.equal(alert.texts.length, 1);
});

// L329: the ask's time is read through the shared pastTime; one that can't be read, or lies an hour ahead, counts as
// long ago (the wait ends), and the wait for the handoff has a 24 h cap.
test('L329: an ask time unreadable or an hour ahead ends the wait: re-asked, not "waiting for the handoff" for ever', async () => {
  for (const [label, bad] of [['unreadable', 'garbage'], ['an hour ahead', iso(T0 + 62 * MIN)]]) {
    const w = world();
    assert.equal(await w.step(ended(260_000, 0), 1), 'WRAP sent');
    change(w.rec, 'fact', RESTART_FACT(SID), { sent_at: bad });
    // No turn time either, so only the ask's own time can end the wait.
    assert.equal(await w.step({ ...ended(260_000, 0), endedAt: null }, 2), 're-asked', label);
  }
});

test('L329: a Lead that never answers the WRAP is re-asked after a day, then given up on and the owner told', async () => {
  const w = world();
  const DAY = 24 * 60;
  assert.equal(await w.step(ended(260_000, 0), 1), 'WRAP sent');
  assert.equal(await w.step(ended(260_000, 0), 1 + DAY - 1), 'waiting for the handoff');
  assert.equal(await w.step(ended(260_000, 0), 1 + DAY), 're-asked');
  assert.match(w.calls.sent.at(-1), /not used \(no answer within a day of the ask\)/);
  assert.equal(await w.step(ended(260_000, 0), 1 + 2 * DAY - 1), 'waiting for the handoff');
  assert.equal(await w.step(ended(260_000, 0), 1 + 2 * DAY), 'gave up; the old Lead keeps running');
  assert.equal(w.calls.alerts.filter((a) => /did not hand in a usable handoff after a second ask \(no answer within a day of the ask\)/.test(a)).length, 1, w.calls.alerts.join(' | '));
  assert.equal(w.calls.stops, 0, 'never stopped without a handoff');
});

test('L355 m5: a Lead with no size reading, or never at a finished turn, a day after the ask is given up on and the owner told', async () => {
  const DAY = 24 * 60;
  for (const [label, size, why] of [
    ['no size', null, 'its size could not be read for a day after the ask'],
    ['mid-turn', midTurn(260_000), 'it did not finish a turn within a day of the ask'],
  ]) {
    const w = world();
    assert.equal(await w.step(ended(260_000, 0), 1), 'WRAP sent');
    assert.equal(await w.step(size, 1 + DAY - 1), label, `${label}: still waiting within the day`);
    assert.equal(await w.step(size, 1 + DAY), 'gave up; the old Lead keeps running', label);
    assert.equal(w.calls.alerts.filter((a) => a.includes(`did not hand in a usable handoff within a day of the ask (${why})`)).length, 1, w.calls.alerts.join(' | '));
    assert.equal(await w.step(size, 1 + DAY + 1), 'gave_up', `${label}: told once`);
    assert.equal(w.calls.alerts.length, 1);
    assert.equal(w.calls.stops, 0, 'never stopped');
    assert.equal(w.calls.sent.length, 1, 'nothing sent but the WRAP');
  }
  // After the re-ask, the same cap; the alert says a second ask was sent.
  const w = world();
  assert.equal(await w.step(ended(260_000, 0), 1), 'WRAP sent');
  assert.equal(await w.step(ended(260_000, 0), 1 + DAY), 're-asked');
  assert.equal(await w.step(null, 1 + 2 * DAY), 'gave up; the old Lead keeps running');
  assert.match(w.calls.alerts.at(-1), /after a second ask \(its size could not be read for a day after the ask\)/);
  // An ask time that can't be read counts as long ago (L329).
  const u = world();
  assert.equal(await u.step(ended(260_000, 0), 1), 'WRAP sent');
  change(u.rec, 'fact', RESTART_FACT(SID), { sent_at: 'garbage' });
  assert.equal(await u.step(midTurn(260_000), 2), 'gave up; the old Lead keeps running');
});

test('L355 m5: a give-up after no finished turn whose alert was not queued is told on the next pass with the same words', async () => {
  const w = world();
  assert.equal(await w.step(ended(260_000, 0), 1), 'WRAP sent');
  assert.equal(await w.step(null, 1 + 24 * 60, { answer: () => false }), 'gave up; the old Lead keeps running');
  assert.equal(w.calls.alerts.length, 0);
  assert.equal(await w.step(null, 2 + 24 * 60), 'gave_up');
  assert.deepEqual(w.calls.alerts, [`the Lead ${SID} did not hand in a usable handoff within a day of the ask (its size could not be read for a day after the ask); it keeps running, and a restart now needs a person`]);
});

test('L359: a re-ask the Lead keeps refusing is told from the first refusal, then daily, and cleared once sent', async () => {
  const DAY = 24 * 60;
  const w = world();
  const told = () => w.calls.alerts.filter((a) => /the second ask could not be sent since/.test(a)).length;
  assert.equal(await w.step(ended(260_000, 0), 1), 'WRAP sent');
  w.refuse('busy');
  assert.equal(await w.step(ended(260_000, 0), 1 + DAY), 're-ask not sent (busy)');
  assert.equal(told(), 1, 'told at the first refusal');
  assert.match(w.calls.alerts.at(-1), new RegExp(`since ${iso(T0 + (1 + DAY) * MIN)} \\(busy\\)`));
  assert.equal(await w.step(ended(260_000, 0), 2 + DAY), 're-ask not sent (busy)');
  assert.equal(await w.step(ended(260_000, 0), 1 + 2 * DAY - 1), 're-ask not sent (busy)');
  assert.equal(told(), 1, 'quiet within the day');
  assert.equal(await w.step(ended(260_000, 0), 1 + 2 * DAY), 're-ask not sent (busy)');
  assert.equal(told(), 2, 'again a day on, counted from the first refusal');
  w.refuse('sent');
  assert.equal(await w.step(ended(260_000, 0), 2 + 2 * DAY), 're-asked');
  const doc = w.rec.read('fact', RESTART_FACT(SID)).doc;
  assert.equal(doc.reask_refused_since, null, 'cleared once sent');
  assert.equal(doc.reask_refused_told, null);
  assert.equal(w.calls.stops, 0);
});
