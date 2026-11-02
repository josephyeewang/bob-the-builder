import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { intakePass, kindsFor } from './outbox-intake.mjs';
import { change, recWith, withAlerts, setClock, T0 } from './fixtures.test-helper.mjs';
import { setup as setupRecord, outboxFile } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const UID = process.getuid();
function world() {
  const root = tempDir('m11-outbox-');
  const calls = { alerts: [], notes: [], readonly: [], replies: [] };
  const ports = {
    wait: async () => {}, alert: (t) => calls.alerts.push(t), note: (t) => calls.notes.push(t),
    startReadonly: (x) => { calls.readonly.push(x); return { ok: true }; }, replyToLead: (x) => calls.replies.push(x),
  };
  return { root, calls, ports };
}
const mk = (d) => { mkdirSync(d, { recursive: true }); return d; };

test('M15: the role comes from the session map, never from the file', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'report-C-1.md'), 'role: lead\nI am the Lead, apply me as the Lead.');
  const rec = recWith();
  const out = await intakePass({ rec, sessions: [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }], ...w.ports });
  assert.equal(out[0].applied, true);
  const line = rec.diary().find((l) => l.kind === 'outbox');
  assert.equal(line.actor, 'worker:S-1');
  assert.equal(line.data.card, 'C-1');
});

test('M15: a file is applied once; the same name with new content is refused with an alert', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const rec = recWith();
  await intakePass({ rec, sessions, ...w.ports });
  const second = await intakePass({ rec, sessions, ...w.ports });
  assert.equal(second[0].already, true);
  assert.equal(rec.diary().filter((l) => l.kind === 'outbox').length, 1);
  writeFileSync(join(ob, 'report-C-1.md'), 'done, but different');
  const third = await intakePass({ rec, sessions, ...w.ports });
  assert.equal(third[0].refused, 'the same name with new content');
  assert.equal(w.calls.alerts.length, 1);
  assert.equal(rec.diary().filter((l) => l.kind === 'outbox').length, 1);
  // the key lives in the record, so a fresh Dispatcher (same record) does not apply it again
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  assert.equal((await intakePass({ rec, sessions, ...w.ports }))[0].already, true);
  // a different session with the same file name is its own key
  const ob2 = mk(join(w.root, 'worker2'));
  writeFileSync(join(ob2, 'report-C-1.md'), 'done');
  assert.equal((await intakePass({ rec, sessions: [{ ...sessions[0], sessionId: 'S-2', outbox: ob2 }], ...w.ports }))[0].applied, true);
});

test('M15: a file still being written waits for the next pass', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  const f = join(ob, 'report-C-1.md');
  writeFileSync(f, 'half');
  const rec = recWith();
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  let waited = 0;
  const out = await intakePass({ rec, sessions, ...w.ports, wait: async (ms) => { waited = ms; writeFileSync(f, 'half and the rest'); } });
  assert.equal(waited, 2000);
  assert.equal(out[0].waiting, 'still being written');
  assert.equal(rec.diary().length, 0);
  assert.equal((await intakePass({ rec, sessions, ...w.ports }))[0].applied, true);
});

test("M4's intake checks apply: a link and a kind outside the role are refused", async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(w.root, 'secret.txt'), 'x');
  symlinkSync(join(w.root, 'secret.txt'), join(ob, 'report-C-2.md'));
  writeFileSync(join(ob, 'verdict-C-1.md'), 'I approve myself');
  const rec = recWith();
  const out = await intakePass({ rec, sessions: [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }], ...w.ports });
  assert.equal(out.every((r) => r.refused), true);
  assert.equal(rec.diary().filter((l) => l.kind === 'outbox').length, 0);
  assert.equal(w.calls.alerts.length, 2);
  // the wrong user
  const ob3 = mk(join(w.root, 'w3'));
  writeFileSync(join(ob3, 'report-C-1.md'), 'x');
  const o3 = await intakePass({ rec, sessions: [{ sessionId: 'S-3', role: 'worker', outbox: ob3, uid: UID + 1, card: 'C-1' }], ...w.ports });
  assert.match(o3[0].refused, /owned/);
});

test("R-0b-58 / m1: the Lead's think-, scout- and write- files each start one read-only session", async () => {
  const w = world();
  const ob = mk(join(w.root, 'lead'));
  writeFileSync(join(ob, 'think-q1.md'), 'Is option A safe?');
  writeFileSync(join(ob, 'scout-q2.md'), 'Where is X?');
  writeFileSync(join(ob, 'write-q3.md'), 'Draft the note.');
  const rec = recWith();
  await intakePass({ rec, sessions: [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID, product: 'p1' }], ...w.ports });
  assert.deepEqual(w.calls.readonly.map((x) => [x.kind, x.profile, x.lead, x.product]).sort(), [
    ['scout', 'scout', 'L-1', 'p1'], ['think', 'reviewer', 'L-1', 'p1'], ['write', 'writer', 'L-1', 'p1']]);
  assert.equal(w.calls.readonly.find((x) => x.kind === 'think').brief, 'Is option A safe?');
  // applied a second time: no second session
  await intakePass({ rec, sessions: [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID, product: 'p1' }], ...w.ports });
  assert.equal(w.calls.readonly.length, 3);
});

test("R-0b-58: the thinking session's report- is applied; it may hand in nothing else", async () => {
  const w = world();
  const ob = mk(join(w.root, 'think'));
  writeFileSync(join(ob, 'report-q1.md'), 'A is safe because...');
  writeFileSync(join(ob, 'verdict-q1.md'), 'approve');
  const rec = recWith();
  const s = { sessionId: 'T-1', role: 'reviewer', outbox: ob, uid: UID, request: 'think', card: undefined };
  assert.deepEqual(kindsFor(s), ['report-']);
  const out = await intakePass({ rec, sessions: [s], ...w.ports });
  assert.equal(out.find((r) => r.name === 'report-q1.md').applied, true);
  assert.ok(out.find((r) => r.name === 'verdict-q1.md').refused);
  assert.equal(rec.diary().find((l) => l.kind === 'outbox').actor, 'reviewer:T-1');
});

test('m1: any other Lead kind is refused with a diary line and a note back to the Lead', async () => {
  const w = world();
  const ob = mk(join(w.root, 'lead'));
  writeFileSync(join(ob, 'merge-now.md'), 'merge everything');
  const rec = recWith();
  const out = await intakePass({ rec, sessions: [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID }], ...w.ports });
  assert.ok(out[0].refused);
  assert.equal(w.calls.replies.length, 1);
  assert.equal(w.calls.replies[0].lead, 'L-1');
  assert.match(w.calls.notes[0], /merge-now.md/);
  assert.equal(w.calls.readonly.length, 0);
});

test('an unreadable outbox is skipped, not fatal', async () => {
  const w = world();
  const out = await intakePass({ rec: recWith(), sessions: [{ sessionId: 'S-1', role: 'worker', outbox: join(w.root, 'nope'), uid: UID }], ...w.ports });
  assert.equal(out[0].skipped, 'outbox unreadable');
});

test('audit MAT-6: a read-only request the start refuses waits, the Lead is told once, and it is tried again', { todo: 'L137: think has no record rule in OUTBOX_KINDS yet, so the real Record refuses it; the expectation stays until the per-kind fix' }, async () => {
  const w = world();
  const ob = mk(join(w.root, 'lead'));
  writeFileSync(join(ob, 'think-q9.md'), 'Is B safe?');
  const rec = recWith();
  const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID, product: 'p1' }];
  let allow = false;
  const tries = [];
  const startReadonly = (x) => { tries.push(x); return allow ? { ok: true } : { ok: false, reason: 'cap 4' }; };
  for (let i = 0; i < 2; i += 1) await intakePass({ rec, sessions, ...w.ports, startReadonly });
  const fact = rec.read('fact', 'intake-applied-L-1-think-q9.md').doc;
  assert.equal(fact.state, 'waiting');
  assert.equal(fact.tries, 2);
  assert.equal(w.calls.replies.length, 1);
  assert.match(w.calls.replies[0].text, /queued: cap 4/);
  assert.equal(tries.length, 2);
  allow = true;
  await intakePass({ rec, sessions, ...w.ports, startReadonly });
  assert.equal(rec.read('fact', 'intake-applied-L-1-think-q9.md').doc.state, 'applied');
  await intakePass({ rec, sessions, ...w.ports, startReadonly });
  assert.equal(tries.length, 3); // started once, never again
  assert.equal(w.calls.replies.length, 1);
});

test('audit MAT-7: a claim left at applying becomes interrupted with one alert, is never applied again, and blocks no Lead restart', async () => {
  const { createHash } = await import('node:crypto');
  const { leadInFlight } = await import('./lead-restart.mjs');
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const sha = createHash('sha256').update('done').digest('hex');
  const rec = recWith([['fact', 'intake-applied-S-1-report-C-1.md', { session: 'S-1', name: 'report-C-1.md', sha256: sha, state: 'applying' }]]);
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  // As the tick runs it: queued, then delivered, and marked told only then (L130 M7).
  const run = () => withAlerts(rec, Date.now(), (t) => { w.calls.alerts.push(t); return true; }, (alert) => intakePass({ rec, sessions, ...w.ports, alert }));
  const out = await run();
  assert.equal(out[0].already, true);
  assert.notEqual(out[0].applied, true);
  assert.equal(rec.read('fact', 'intake-applied-S-1-report-C-1.md').doc.state, 'interrupted');
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /interrupted/);
  assert.equal(rec.diary().filter((l) => l.kind === 'outbox').length, 0);
  await run();
  assert.equal(w.calls.alerts.length, 1);
  assert.equal(rec.diary().filter((l) => l.kind === 'outbox').length, 0);
  assert.equal(leadInFlight({ rec, sessionId: 'S-1', outboxNames: ['report-C-1.md'], questionOpen: false }), null);
});

// L130: an alert the queue did not take (answer false) writes no told_state; the next pass tells it once.
test('L130: an interrupted claim whose alert was not queued is told on the next pass, once', async () => {
  const { createHash } = await import('node:crypto');
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const sha = createHash('sha256').update('done').digest('hex');
  const rec = recWith([['fact', 'intake-applied-S-1-report-C-1.md', { session: 'S-1', name: 'report-C-1.md', sha256: sha, state: 'applying' }]]);
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  const run = () => withAlerts(rec, Date.now(), (t) => { w.calls.alerts.push(t); return true; }, (alert) => intakePass({ rec, sessions, ...w.ports, alert }));
  await intakePass({ rec, sessions, ...w.ports, alert: () => false });
  const f = () => rec.read('fact', 'intake-applied-S-1-report-C-1.md').doc;
  assert.equal(f().state, 'interrupted');
  assert.equal(f().told_state, undefined, 'not marked told');
  await run();
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /interrupted/);
  assert.equal(f().told_state, 'interrupted');
  await run();
  assert.equal(w.calls.alerts.length, 1, 'told once');
});

test('L130: a file the record refused, whose alert was not queued, is told on the next pass, once', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  // The record refusing the hand-in, as it does a transition the role may not make.
  const rec = Object.create(recWith(), { applyOutbox: { value: () => ({ ok: false, reason: 'not a hand-in this role may make' }) } });
  const run = () => withAlerts(rec, Date.now(), (t) => { w.calls.alerts.push(t); return true; }, (alert) => intakePass({ rec, sessions, ...w.ports, alert }));
  assert.equal((await intakePass({ rec, sessions, ...w.ports, alert: () => false }))[0].refused, 'not a hand-in this role may make');
  const f = () => rec.read('fact', 'intake-applied-S-1-report-C-1.md').doc;
  assert.equal(f().told_state, undefined, 'not marked told');
  await run();
  assert.equal(w.calls.alerts.length, 1, w.calls.alerts.join(' | '));
  assert.equal(f().told_state, 'refused');
  await run();
  assert.equal(w.calls.alerts.length, 1, 'told once');
});

test("audit MIN-20 (I6): a worker's think file starts no read-only session", async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'think-q1.md'), 'Is A safe?');
  const out = await intakePass({ rec: recWith(), sessions: [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }], ...w.ports });
  assert.equal(w.calls.readonly.length, 0);
  assert.ok(out[0].refused);
});

test('audit 0b-6 r2 MIN-7: the file is claimed before its read-only session starts; a pass that died after the claim never starts a second helper', async () => {
  const w = world();
  const ob = mk(join(w.root, 'lead'));
  writeFileSync(join(ob, 'think-q1.md'), 'Is A safe?');
  const rec = recWith();
  const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID, product: 'p1' }];
  let seen = null;
  // The start sees the claim already in the record; then the pass "dies" before it answers.
  const dies = () => { seen = rec.read('fact', 'intake-applied-L-1-think-q1.md')?.doc?.state; throw Object.assign(new Error('pass died'), { die: true }); };
  await intakePass({ rec, sessions, ...w.ports, startReadonly: dies });
  assert.equal(seen, 'starting');
  // Simulate the crash leaving the claim (the catch turned it into "waiting"; put it back as a crash would leave it).
  const cur = rec.read('fact', 'intake-applied-L-1-think-q1.md');
  assert.equal(cur.doc.state, 'waiting'); change(rec, 'fact', 'intake-applied-L-1-think-q1.md', { state: 'starting' });
  const tries = [];
  await intakePass({ rec, sessions, ...w.ports, startReadonly: (x) => { tries.push(x); return { ok: true }; } });
  assert.deepEqual(tries, [], 'never started twice');
  assert.equal(rec.read('fact', 'intake-applied-L-1-think-q1.md').doc.state, 'interrupted');
  assert.match(w.calls.alerts.at(-1), /read-only session may or may not have started/);
});

test('audit 0b-6 r2 MAT-8 (I5, I6): a read-only start that throws, or an apply that throws, does not stop the next file', async () => {
  const w = world();
  const lead = mk(join(w.root, 'lead'));
  writeFileSync(join(lead, 'think-q1.md'), 'Is A safe?');
  writeFileSync(join(lead, 'scout-q2.md'), 'Where is B?');
  const rec = recWith();
  const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: lead, uid: UID, product: 'p1' }];
  const tries = [];
  const out = await intakePass({ rec, sessions, ...w.ports, startReadonly: (x) => { tries.push(x.kind); if (tries.length === 1) throw new Error('port down'); return { ok: true }; } });
  assert.equal(tries.length, 2, 'the second file was still handled');
  assert.match(out.find((r) => r.waiting)?.waiting ?? '', /the start failed: port down/);
  const worker = mk(join(w.root, 'worker'));
  writeFileSync(join(worker, 'report-C-1.md'), 'one');
  writeFileSync(join(worker, 'report-C-2.md'), 'two');
  const inner = recWith();
  let n = 0;
  // The record handle is frozen, so the test wraps it in a plain object.
  const rec2 = { read: (...a) => inner.read(...a), write: (...a) => inner.write(...a), list: (...a) => inner.list(...a),
    applyOutbox: (...a) => { n += 1; if (n === 1) throw new Error('disk'); return inner.applyOutbox(...a); } };
  const out2 = await intakePass({ rec: rec2, sessions: [{ sessionId: 'S-1', role: 'worker', outbox: worker, uid: UID, card: 'C-1' }], ...w.ports });
  assert.equal(n, 2, 'the next file was still applied');
  assert.deepEqual(out2.map((r) => r.applied), [false, true]);
});

test('audit 0b-6 r2 MIN-10 (round 1 MIN-12): a hand-in whose check throws is not used, with the reason', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const rec = recWith();
  const out = await intakePass({ rec, sessions: [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }], ...w.ports, vet: () => { throw new Error('bad rules'); } });
  assert.notEqual(out[0].applied, true);
  assert.match(out[0].refused, /could not be checked: bad rules/);
  assert.match(w.calls.notes.join('\n'), /not used yet: could not be checked/);
});

test('audit 0b-6 r3 MIN-5 (J11): after an interrupted hand-in, a new copy under the same name is applied', async () => {
  const { createHash } = await import('node:crypto');
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const sha = createHash('sha256').update('done').digest('hex');
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['fact', 'intake-applied-S-1-report-C-1.md', { session: 'S-1', name: 'report-C-1.md', sha256: sha, state: 'applying' }]]);
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  await intakePass({ rec, sessions, ...w.ports });
  assert.equal(rec.read('fact', 'intake-applied-S-1-report-C-1.md').doc.state, 'interrupted');
  writeFileSync(join(ob, 'report-C-1.md'), 'done, again');
  const out = await intakePass({ rec, sessions, ...w.ports });
  assert.equal(out[0].applied, true, JSON.stringify(out));
  assert.equal(rec.read('fact', 'intake-applied-S-1-report-C-1.md').doc.state, 'applied');
});

test('L44 planted: a verdict file in a worker\'s outbox is refused at intake and never reaches the record', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'verdict-C-1.md'), `${JSON.stringify({ entity: 'verdict', card: 'C-1', fields: { head: 'a'.repeat(40), pass: true } })}\n`);
  const real = recWith();
  let applies = 0;
  const rec = new Proxy(real, { get: (t, k) => (k === 'applyOutbox' ? (...a) => { applies += 1; return t.applyOutbox(...a); } : t[k]) });
  const out = await intakePass({ rec, sessions: [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }], ...w.ports });
  assert.equal(out[0].applied, undefined);
  assert.match(out[0].refused, /verdict/);
  assert.equal(applies, 0);
  assert.equal(rec.list('verdict').length, 0);
  assert.equal(w.calls.alerts.length, 1);
  assert.deepEqual(kindsFor({ role: 'worker' }).includes('verdict-'), false);
  assert.deepEqual(kindsFor({ role: 'reviewer' }), ['report-', 'verdict-']);
});

// L138 m1, m3, m8: the real outbox, with the Record's clock ahead of the tick's. `queueOk()` false is an outbox that
// refuses the entry (a full queue, say), so nothing is queued and only the recorded fact can ask again.
const tickRun = (base, rec, w, sessions, port, min, queueOk = () => true) => {
  const now = T0 + min * 60_000;
  setClock(base, now + 1500);
  return withAlerts(base, now, port, (real) => {
    const alert = Object.assign((t, o) => (queueOk() ? real(t, o) : false), { queues: true });
    return intakePass({ rec, sessions, ...w.ports, alert, now });
  });
};
const refusingRec = (base, reason) => Object.create(base, { applyOutbox: { value: () => ({ ok: false, reason }) } });

test('L138 m3: a refused hand-in whose file is gone before the tell went out is still told, exactly once', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const base = recWith();
  const rec = refusingRec(base, 'not a hand-in this role may make');
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  let queueOk = false;
  await tickRun(base, rec, w, sessions, port, 1, () => queueOk);
  assert.deepEqual(got, [], 'the outbox took nothing');
  const f = () => base.read('fact', 'intake-applied-S-1-report-C-1.md').doc;
  assert.equal(f().state, 'refused');
  assert.equal(f().told_state, undefined, 'a lost tell marks nothing');
  // The file is cleaned away before the next pass.
  rmSync(join(ob, 'report-C-1.md'));
  queueOk = true;
  await tickRun(base, rec, w, sessions, port, 2);
  assert.deepEqual(got, ['the record refused report-C-1.md from worker S-1: not a hand-in this role may make'], 'told from the recorded fact');
  assert.equal(f().told_state, 'refused');
  for (const min of [3, 4, 5]) await tickRun(base, rec, w, sessions, port, min);
  assert.equal(got.length, 1, 'told exactly once once delivered (P20)');
});

test('L138 m8 (P20): a refused hand-in delivered at once is told exactly once over later passes, file listed or not', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const base = recWith();
  const rec = refusingRec(base, 'refused here');
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  for (const min of [1, 2, 3]) await tickRun(base, rec, w, sessions, port, min);
  rmSync(join(ob, 'report-C-1.md'));
  for (const min of [4, 5]) await tickRun(base, rec, w, sessions, port, min);
  assert.deepEqual(got, ['the record refused report-C-1.md from worker S-1: refused here']);
});

// L140: think-, scout- and write- only start a read-only session; the Record has no rule for them.
test('L140: a real think- start is marked applied, with no applyOutbox call and no alert (real Record)', async () => {
  const E = setupRecord({ prefix: 'm11-intake-l140-' });
  const w = world();
  const ob = mk(join(w.root, 'lead'));
  writeFileSync(join(ob, 'think-q1.md'), 'Is option A safe?');
  let applies = 0;
  const real = E.record;
  const rec = Object.create(real, { applyOutbox: { value: (...a) => { applies += 1; return real.applyOutbox(...a); } } });
  const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID, product: 'p1' }];
  const got = [];
  const run = () => withAlerts(real, E.clock.t, (t) => { got.push(typeof t === 'string' ? t : t.text); return true; }, (alert) => intakePass({ rec, sessions, ...w.ports, alert, now: E.clock.t }));
  const [r] = await run();
  assert.equal(r.started, true, JSON.stringify(r));
  assert.equal(w.calls.readonly.length, 1);
  assert.equal(applies, 0, 'nothing for the Record to take');
  assert.deepEqual(got, [], 'no alert');
  assert.equal(real.read('fact', 'intake-applied-L-1-think-q1.md').doc.state, 'applied');
  E.clock.t += 60_000;
  await run();
  assert.equal(w.calls.readonly.length, 1, 'not started twice');
  assert.deepEqual(got, []);
});

test('L140: an apply answering not_a_record is handled, with no alert', async () => {
  const w = world();
  const ob = mk(join(w.root, 'worker'));
  writeFileSync(join(ob, 'report-C-1.md'), 'done');
  const base = recWith();
  const rec = Object.create(base, { applyOutbox: { value: () => ({ ok: false, outcome: 'not_a_record', not_a_record: true, reason: 'no record rule' }) } });
  const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: ob, uid: UID, card: 'C-1' }];
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  const [r] = await tickRun(base, rec, w, sessions, port, 1);
  assert.equal(r.applied, true);
  assert.equal(base.read('fact', 'intake-applied-S-1-report-C-1.md').doc.state, 'applied');
  await tickRun(base, rec, w, sessions, port, 2);
  assert.deepEqual(got, []);
});

// L168 (2): writer.mjs marks a refused outbox file seen before its own alert, whose answer it does not read. The owner
// still hears of it once: the Dispatcher's intake tells every refusal the Record answers, until its own tell is taken.
// Real Record; its own alert lost (false, or a throw, which the store's send turns into false).
for (const [path, place] of [['a hand-in for a card the Record does not have', 'own'], ['a file in another session\'s folder', 'other']]) {
  for (const [how, lost] of [['false', () => false], ['throws', () => { throw new Error('queue gone'); }]]) {
    test(`L168 (2): ${path}, the Record's own alert lost (${how}): the intake tells the owner exactly once`, async () => {
      let recordAlerts = 0;
      const E = setupRecord({ prefix: 'm11-intake-l168-', extra: { alert: (a) => { recordAlerts += 1; return lost(a); } } });
      const name = 'handin-C-9.md';
      const file = outboxFile(E, 'worker', place === 'own' ? 'S-1' : 'S-2', name, `${JSON.stringify({ entity: 'card', id: 'C-9', from_state: 'running', to_state: 'in_review' })}\n`);
      const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: dirname(file), uid: UID, card: 'C-9' }];
      const w = world();
      const got = [];
      const run = () => withAlerts(E.record, E.clock.t, (t) => { got.push(typeof t === 'string' ? t : t.text); return true; }, (alert) => intakePass({ rec: E.record, sessions, ...w.ports, alert, now: E.clock.t }));
      const [r] = await run();
      assert.ok(r.refused, JSON.stringify(r));
      assert.ok(recordAlerts >= 1, 'the Record tried its own alert');
      for (let i = 0; i < 3; i++) { E.clock.t += 60_000; await run(); }
      assert.equal(got.length, 1, got.join(' | '));
      assert.match(got[0], new RegExp(`refused ${name.replace('.', '\\.')} from worker S-1`));
    });
  }
}
