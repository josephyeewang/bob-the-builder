import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leadRestartStep, leadInFlight, handoffVet, estimateTokens, RESTART_FACT, HANDOFF_NAME } from './lead-restart.mjs';
import { intakePass } from './outbox-intake.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, T0, MIN, iso } from './fixtures.test-helper.mjs';

const R = rulesWith(); // soft 250k, hard 400k, handoff cap 8,000 tokens
const SID = 'L-1';
const UID = process.getuid();
const ended = (tokens, atMin = 0) => ({ tokens, turnEnded: true, endedAt: T0 + atMin * MIN, openTools: [], compactions: 0 });
const midTurn = (tokens) => ({ tokens, turnEnded: false, endedAt: null, openTools: ['t1'], compactions: 0 });

function world() {
  const outbox = join(mkdtempSync(join(tmpdir(), 'm11-lead-')), 'lead');
  mkdirSync(outbox);
  const calls = { sent: [], stops: 0, starts: [], alerts: [] };
  let outcome = 'sent';
  const rec = recWith();
  const step = (size, min, over = {}) => leadRestartStep({
    rec, rules: over.rules ?? R, now: T0 + min * MIN, lead: { sessionId: SID, product: 'p' }, size,
    inFlight: over.inFlight ?? null,
    send: async (t) => { calls.sent.push(t); return { outcome }; },
    stopSession: async () => { calls.stops += 1; return over.stopFails ? { ok: false, reason: 'still running' } : { ok: true }; },
    startLead: async (x) => { calls.starts.push(x); return over.startFails ? { ok: false, reason: 'no' } : { ok: true, sessionId: 'L-2' }; },
    alert: (t) => calls.alerts.push(t),
  });
  // The pass's own intake, with the handoff vet, over the Lead's real outbox folder.
  const intake = () => intakePass({ rec, sessions: [{ sessionId: SID, role: 'lead', outbox, uid: UID }], wait: async () => {},
    alert: (t) => calls.alerts.push(t), note: () => {}, startReadonly: () => ({ ok: true }), replyToLead: () => {}, vet: handoffVet(R) });
  const handIn = (bytes) => writeFileSync(join(outbox, HANDOFF_NAME(SID)), 'x'.repeat(bytes));
  return { rec, calls, step, intake, handIn, outbox, refuse: (o) => { outcome = o; } };
}
const phase = (rec) => rec.read('fact', RESTART_FACT(SID))?.doc?.phase ?? 'none';

test('m8: the handoff estimate is ceil(bytes / 4); 31,000 bytes is accepted and 33,000 refused', () => {
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('é'), 1); // 2 utf-8 bytes
  const vet = handoffVet(R);
  assert.equal(vet({ kind: 'handoff', text: 'x'.repeat(31_000) }), null);
  assert.match(vet({ kind: 'handoff', text: 'x'.repeat(33_000) }), /8250 tokens, over the 8000 cap/);
  assert.equal(vet({ kind: 'handoff', text: 'x'.repeat(32_000) }), null); // exactly the cap
  assert.equal(vet({ kind: 'wish', text: 'x'.repeat(99_000) }), null);
});

test('M18: 260k at a finished turn with nothing in flight -> WRAP; the handoff applied -> restarted on it', async () => {
  const w = world();
  assert.equal(await w.step(ended(240_000), 0), 'under the soft line');
  assert.equal(await w.step(ended(260_000), 1), 'WRAP sent');
  assert.match(w.calls.sent[0], /^WRAP: .*handoff-L-1\.md, under 8000 tokens/);
  assert.equal(await w.step(midTurn(262_000), 2), 'mid-turn');
  w.handIn(31_000);
  await w.intake();
  assert.equal(await w.step(ended(265_000, 3), 3), 'restarted');
  assert.equal(w.calls.stops, 1);
  assert.deepEqual(w.calls.starts, [{ handoff: 'handoff-L-1' }]);
  assert.equal(w.rec.read('handoff', 'handoff-L-1').doc.session, SID);
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
  const rec = recWith([['merge', 'M-1', { state: 'requested', waiting: { who: 'lead', what: 'go', since: iso(T0), next_check: iso(T0) } }]]);
  assert.match(leadInFlight({ rec, sessionId: SID, outboxNames: [], questionOpen: false }), /merge M-1 waits on the Lead/);
  assert.match(leadInFlight({ rec: recWith(), sessionId: SID, outboxNames: ['wish-1.md'], questionOpen: false }), /wish-1\.md not used yet/);
  assert.match(leadInFlight({ rec: recWith(), sessionId: SID, outboxNames: ['.wish-1.md.partial'], questionOpen: false }), /not used yet/);
  assert.match(leadInFlight({ rec: recWith(), sessionId: SID, outboxNames: [], questionOpen: true }), /question box/);
  const used = recWith([['fact', `outbox-${SID}-wish-1.md`, { state: 'applied' }], ['card', 'C-1', { state: 'waiting', waiting: { who: 'joe' } }]]);
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
  assert.throws(() => handoffVet(rulesWith({ [K.handoffCapRole]: undefined }))({ kind: 'handoff', text: '' }), /handoff_cap/);
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
  const key = `outbox-${SID}-handoff-${SID}.md`;
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: key, expectRev: 0, doc: { session: SID, name: `handoff-${SID}.md`, sha256: 'x', state: 'refused' } });
  assert.equal(await w.step(ended(265_000, 3), 3), 're-asked');
  assert.match(w.calls.sent[1], /the record refused it/);
  assert.equal(w.calls.stops, 0);
  assert.equal(w.calls.starts.length, 0);
  // applied, but the handoff entry cannot be written: not stopped
  const w2 = world();
  assert.equal(await w2.step(ended(260_000), 1), 'WRAP sent');
  w2.handIn(1_000);
  await w2.intake();
  const realWrite = w2.rec.write.bind(w2.rec);
  const rec = { read: (...a) => w2.rec.read(...a), list: (...a) => w2.rec.list(...a), write: (a) => (a.entity === 'handoff' ? { ok: false, reason: 'stale rev' } : realWrite(a)) };
  const r = await leadRestartStep({ rec, rules: R, now: T0 + 3 * MIN, lead: { sessionId: SID }, size: ended(265_000, 3), inFlight: null,
    send: async () => ({ outcome: 'sent' }), stopSession: async () => { w2.calls.stops += 1; return { ok: true }; }, startLead: async () => { w2.calls.starts.push(1); return { ok: true }; }, alert: () => {} });
  assert.equal(r, 'handoff not recorded: stale rev');
  assert.equal(w2.calls.stops, 0);
  assert.equal(w2.calls.starts.length, 0);
});
