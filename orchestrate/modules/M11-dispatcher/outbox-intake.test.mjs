import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, mkdirSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { intakePass, kindsFor } from './outbox-intake.mjs';
import { recordLeadLaunch } from './lead-restart.mjs';
import { change, recWith, withAlerts, setClock, T0 } from './fixtures.test-helper.mjs';
import { PRODUCT, must, setup as setupRecord, outboxFile, product, runnerLaunch, runnerEndedRecord, seed, HEAD, CLEAN_CHECKLIST } from '../M9-record/fixtures.test-helper.mjs';
import { NEVER_RAN, runnerEnded } from '../M9-record/outbox.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';

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

// L137, switched on in #95: think- is record: 'none' (handledBy outbox-intake.mjs), so the real Record answers not_a_record.
test('audit MAT-6: a read-only request the start refuses waits, the Lead is told once, and it is tried again', async () => {
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

// L189 m2 (L167 c-4): the Front Door's state- (pause/away) and request- (resume, wrap-up, rotate, mode) files are refused
// at the Dispatcher's own read, before the Record sees them, through kindsFor as intake uses it. The kinds it keeps reach
// the Record (control). A kindsFor that handed the Front Door the full table would let both through to applyOutbox.
test('L189 m2: a Front Door state- or request- file is refused at intake\'s read and never reaches the record', async () => {
  const w = world();
  const ob = mk(join(w.root, 'front_door'));
  const held = ['state-20261103-0915-aa.json', 'request-resume-20261103-0915-ad.json', 'request-think-1.json'];
  const kept = ['idea-1.md', 'ask-request-20261103-0915-ab.json'];
  for (const n of [...held, ...kept]) writeFileSync(join(ob, n), '{}\n');
  const real = recWith();
  const applied = [];
  const rec = Object.create(real, { applyOutbox: { value: (meta, file) => { applied.push(file.split('/').pop()); return real.applyOutbox(meta, file); } } });
  const out = await intakePass({ rec, sessions: [{ sessionId: 'F-1', role: 'front_door', outbox: ob, uid: UID }], ...w.ports });
  for (const n of held) {
    assert.match(out.find((r) => r.name === n).refused, /is not a kind this role may hand in/, `${n} is refused at the read`);
    assert.ok(!applied.includes(n), `${n} never reaches the record`);
  }
  for (const n of kept) assert.ok(applied.includes(n), `${n}, a kind the Front Door keeps, reaches the record`);
  assert.deepEqual(kindsFor({ role: 'front_door' }).filter((k) => k === 'state-' || k === 'request-'), []);
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
  for (const [how, lost] of [['false', { answer: false }], ['throws', { throws: 'queue gone' }]]) {
    test(`L168 (2): ${path}, the Record's own alert lost (${how}): the intake tells the owner exactly once`, async () => {
      const recordAlert = fakeAlert(lost);
      const E = setupRecord({ prefix: 'm11-intake-l168-', extra: { alert: recordAlert } });
      const name = 'handin-C-9.md';
      const file = outboxFile(E, 'worker', place === 'own' ? 'S-1' : 'S-2', name, `${JSON.stringify({ entity: 'card', id: 'C-9', from_state: 'running', to_state: 'in_review' })}\n`);
      const sessions = [{ sessionId: 'S-1', role: 'worker', outbox: dirname(file), uid: UID, card: 'C-9' }];
      const w = world();
      const got = [];
      const run = () => withAlerts(E.record, E.clock.t, (t) => { got.push(typeof t === 'string' ? t : t.text); return true; }, (alert) => intakePass({ rec: E.record, sessions, ...w.ports, alert, now: E.clock.t }));
      const [r] = await run();
      assert.ok(r.refused, JSON.stringify(r));
      assert.ok(recordAlert.calls.length >= 1, 'the Record tried its own alert');
      for (let i = 0; i < 3; i++) { E.clock.t += 60_000; await run(); }
      assert.equal(got.length, 1, got.join(' | '));
      assert.match(got[0], new RegExp(`refused ${name.replace('.', '\\.')} from worker S-1`));
    });
  }
}

// L424/L425: the real Record, the real ended-record reader and the real outbox folders. Only the session entry is built
// here, as the wiring builds it from the runner's launch record.
function endedWorld(prefix, role = 'reviewer') {
  const E = setupRecord({ prefix });
  const w = world();
  const sid = 'R-1';
  seed(E, 'card', 'C-1', { state: 'in_review', head: HEAD });
  runnerLaunch(E, 'C-1', sid, role, HEAD);
  const name = `verdict-${sid}.md`;
  outboxFile(E, role, sid, name, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: true, checklist: CLEAN_CHECKLIST } })}\n`);
  const session = { sessionId: sid, role, outbox: join(E.outRoot, role, sid), uid: UID, card: 'C-1', head: HEAD };
  const reviewEnded = (s) => runnerEnded({ root: join(E.base, 'ended'), uid: UID, role: s.role, card: s.card, head: s.head, sessionId: s.sessionId });
  const pass = (over = {}) => intakePass({ rec: E.review, sessions: [session], now: E.clock.t, ...w.ports, reviewEnded, ...over });
  return { E, w, sid, name, pass, session, reviewEnded, verdicts: () => E.record.list('verdict').length };
}

test('L424: a verdict sitting still before its ended record exists waits and takes nothing, then is taken once it exists', async () => {
  const { E, w, sid, name, pass, verdicts } = endedWorld('m11-intake-ended-');
  const [r] = await pass();
  assert.equal(r.waiting, 'its session has not ended');
  assert.equal(r.applied, undefined);
  assert.equal(verdicts(), 0);
  assert.equal(E.record.read('fact', `intake-applied-${sid}-${name}`), null, 'no claim, so nothing stops the finalized file being taken');
  assert.deepEqual(w.calls.alerts, []);
  assert.deepEqual(w.calls.notes, [], 'a session still running is no event');
  // The runner finalizes (the file changes), then writes the ended record: the new file is what is taken.
  const p = join(E.outRoot, 'reviewer', sid, name);
  writeFileSync(p, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: true, checklist: CLEAN_CHECKLIST, notes: [] } })}\n`);
  runnerEndedRecord(E, 'C-1', sid, 'reviewer', HEAD);
  const [t] = await pass();
  assert.equal(t.applied, true, JSON.stringify(t));
  assert.equal(verdicts(), 1);
  assert.deepEqual(w.calls.alerts, [], 'never "the same name with new content"');
});

test('L424: an ended record for another head does not let a verdict through, and the reason is noted', async () => {
  const { E, w, sid, pass, verdicts } = endedWorld('m11-intake-ended-head-');
  runnerEndedRecord(E, 'C-1', sid, 'reviewer', 'b'.repeat(40));
  const [r] = await pass();
  assert.equal(r.waiting, 'its session has not ended');
  assert.equal(verdicts(), 0);
  assert.match(w.calls.notes.join(' | '), /waits: .*another role, card or head/);
});

test('L424: a verdict waits when the ended check is missing, throws or answers nothing', async () => {
  for (const reviewEnded of [undefined, () => { throw new Error('boom'); }, () => null, () => ({ ok: true }).nope, () => ({ ok: 1 }), () => ({ ok: 'true' }), () => ({ ok: 1, ended: { verdict_sha256: NEVER_RAN } }), () => ({ ok: 'true', ended: { verdict_sha256: NEVER_RAN } }), async () => { throw new Error('boom'); }]) {
    const { pass, verdicts } = endedWorld('m11-intake-ended-port-');
    const [r] = await pass({ reviewEnded });
    assert.equal(r.waiting, 'its session has not ended');
    assert.equal(verdicts(), 0);
  }
});

test('L445 m4: an answer of ok with no ended record in it waits, and says so', async () => {
  const { w, pass, verdicts } = endedWorld('m11-intake-ended-empty-');
  const [r] = await pass({ reviewEnded: () => ({ ok: true }) });
  assert.match(r.waiting, /does not say what verdict file/);
  assert.equal(verdicts(), 0);
  assert.match(w.calls.notes.join(' | '), /does not say what verdict file/);
});

test('L445 m4: a port that answers later is waited for', async () => {
  const { E, sid, pass, reviewEnded, verdicts } = endedWorld('m11-intake-ended-async-');
  runnerEndedRecord(E, 'C-1', sid, 'reviewer', HEAD);
  const [r] = await pass({ reviewEnded: async (s) => reviewEnded(s) });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(verdicts(), 1);
});

test('L445 m4: an auditor\'s verdict waits for its ended record too', async () => {
  const { E, sid, pass, verdicts } = endedWorld('m11-intake-ended-auditor-', 'auditor');
  const [r] = await pass();
  assert.equal(r.waiting, 'its session has not ended');
  assert.equal(verdicts(), 0);
  runnerEndedRecord(E, 'C-1', sid, 'auditor', HEAD);
  const [t] = await pass();
  assert.equal(t.applied, true, JSON.stringify(t));
  assert.equal(verdicts(), 1);
});

test('L445 m4: two sessions of one card and role: only the one that ended is taken', async () => {
  const { E, w, sid, name, session, reviewEnded, verdicts } = endedWorld('m11-intake-ended-two-');
  const other = 'R-2';
  runnerLaunch(E, 'C-1', other, 'reviewer', HEAD);
  outboxFile(E, 'reviewer', other, `verdict-${other}.md`, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: true, checklist: CLEAN_CHECKLIST } })}\n`);
  runnerEndedRecord(E, 'C-1', other, 'reviewer', HEAD);
  const out = await intakePass({ rec: E.review, sessions: [session, { ...session, sessionId: other, outbox: join(E.outRoot, 'reviewer', other) }], now: E.clock.t, ...w.ports, reviewEnded });
  assert.equal(out.find((x) => x.session === sid).waiting, 'its session has not ended');
  assert.equal(out.find((x) => x.session === other).applied, true, JSON.stringify(out));
  assert.equal(verdicts(), 1);
  assert.equal(E.record.read('fact', `intake-applied-${sid}-${name}`), null);
});

test('L445 m2: the runner finalizing between the read and the question waits, and the final file is taken with no false alert', async () => {
  const { E, w, sid, name, pass, reviewEnded, verdicts } = endedWorld('m11-intake-ended-race-');
  const final = `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: true, checklist: CLEAN_CHECKLIST, notes: [] } })}\n`;
  const [r] = await pass({ reviewEnded: (s) => {
    writeFileSync(join(E.outRoot, 'reviewer', sid, name), final);
    runnerEndedRecord(E, 'C-1', sid, 'reviewer', HEAD);
    return reviewEnded(s);
  } });
  assert.equal(r.waiting, 'this is not the file its ended record names');
  assert.equal(verdicts(), 0);
  assert.equal(E.record.read('fact', `intake-applied-${sid}-${name}`), null, 'no claim on the old bytes');
  const [t] = await pass();
  assert.equal(t.applied, true, JSON.stringify(t));
  assert.equal(verdicts(), 1);
  assert.deepEqual(w.calls.alerts, [], 'never "the same name with new content"');
});

test('L445 m2: an ended record saying no verdict, with a file there, waits and is noted', async () => {
  const { E, w, sid, pass, verdicts } = endedWorld('m11-intake-ended-none-');
  runnerEndedRecord(E, 'C-1', sid, 'reviewer', HEAD, { sha: 'none' });
  const [r] = await pass();
  assert.equal(r.waiting, 'its ended record says it ended with no verdict file');
  assert.equal(verdicts(), 0);
  assert.match(w.calls.notes.join(' | '), /ended with no verdict file/);
});

test('L446: an ended record saying refused waits and is noted, as M9 never counts that verdict', async () => {
  const { E, w, sid, pass, verdicts } = endedWorld('m11-intake-ended-refused-');
  runnerEndedRecord(E, 'C-1', sid, 'reviewer', HEAD, { sha: 'refused' });
  const [r] = await pass();
  assert.equal(r.waiting, 'its ended record says its verdict could not be counted');
  assert.equal(verdicts(), 0);
  assert.match(w.calls.notes.join(' | '), /could not be counted/);
});

test('L446: a value the check does not know yet waits and is noted', async () => {
  const { w, pass, verdicts } = endedWorld('m11-intake-ended-later-');
  const [r] = await pass({ reviewEnded: () => ({ ok: true, ended: { verdict_sha256: 'something_later' } }) });
  assert.equal(r.waiting, 'its ended record names a verdict in a way this does not know');
  assert.equal(verdicts(), 0);
  assert.match(w.calls.notes.join(' | '), /does not know/);
});

test('L446: a file found after a start that never ran is taken, as M9 counts it', async () => {
  const { E, sid, pass, verdicts } = endedWorld('m11-intake-ended-never-');
  runnerEndedRecord(E, 'C-1', sid, 'reviewer', HEAD, { sha: NEVER_RAN });
  const [r] = await pass();
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(verdicts(), 1);
});

test('L424: only a verdict waits for the ended record; a report from the same session goes through', async () => {
  const w = world();
  const ob = mk(join(w.root, 'reviewer'));
  writeFileSync(join(ob, 'report-C-1.md'), 'a note');
  const [r] = await intakePass({ rec: recWith(), sessions: [{ sessionId: 'R-2', role: 'reviewer', outbox: ob, uid: UID, card: 'C-1' }], ...w.ports });
  assert.equal(r.applied, true, JSON.stringify(r));
});

// R-0b-170 (L460): a plan file through the real intake and the real Record.
const DAY = 24 * 3_600_000;
const planCard = (id, over = {}) => ({ id, wave: 1, tier: 2, module: 'store', brief: { goal: `the goal of ${id}`, done_when: 'tests pass', files: [`src/${id}.mjs`], not_in_scope: 'anything else' }, ...over });
function planWorld() {
  const E = setupRecord({ prefix: 'm11-intake-plan-' });
  product(E);
  const w = world();
  const ob = mk(join(E.outRoot, 'lead', 'L-1'));
  const told = [];
  const owner = [];
  const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: UID }];
  const run = ({ reply } = {}) => withAlerts(E.record, E.clock.t, (t) => { owner.push(typeof t === 'string' ? t : t.text); return true; },
    (alert) => intakePass({ rec: E.record, sessions, ...w.ports, alert, now: E.clock.t, replyToLead: reply ?? (async (x) => { told.push(x); return { ok: true }; }) }));
  const launch = (head = HEAD) => recordLeadLaunch({ rec: E.record, now: E.clock.t, alert: fakeAlert(), sessionId: 'L-1', head, product: PRODUCT });
  const hand = (name, cards) => writeFileSync(join(ob, name), typeof cards === 'string' ? cards : JSON.stringify({ cards }));
  return { E, rec: E.record, ob, ports: w.ports, sessions, told, owner, run, launch, hand };
}

test('R-0b-170: a plan that fails the plan check is refused, nothing is written, only the Lead is told, once', async () => {
  for (const [text, why] of [['{"cards":', /it is not JSON/], [[planCard('C-1', { tier: undefined })], /tier must be 1 or 2/], [[planCard('C-1', { module: undefined })], /needs a module/], [[planCard('C-1', { wave: 0 })], /wave must be/]]) {
    const p = planWorld();
    must(p.launch());
    p.hand('plan-a.json', text);
    const [r] = await p.run();
    assert.match(r.refused, why);
    assert.equal(p.rec.read('card', 'C-1'), null);
    assert.equal(p.told.length, 1);
    assert.equal(p.told[0].lead, 'L-1');
    assert.match(p.told[0].text, /Your plan plan-a\.json was not applied/);
    assert.match(p.told[0].text, why);
    assert.deepEqual(p.owner, [], 'the Lead fixes its own plan');
    p.E.clock.t += DAY;
    await p.run();
    assert.equal(p.told.length, 1, 'told once');
    assert.equal(p.rec.read('card', 'C-1'), null);
  }
});

test('R-0b-170: a plan from a Lead with no launch record is held, the owner told once a day, and applied once a launch is there', async () => {
  const p = planWorld();
  p.hand('plan-a.json', [planCard('C-1')]);
  const [r] = await p.run();
  assert.match(r.waiting, /no launch record/);
  assert.equal(p.owner.length, 1);
  assert.match(p.owner[0], /Lead L-1 has no launch record, so its plan plan-a\.json/);
  assert.equal(p.rec.read('card', 'C-1'), null);
  p.E.clock.t += 60_000;
  await p.run();
  assert.equal(p.owner.length, 1, 'once a day');
  p.E.clock.t += DAY;
  await p.run();
  assert.equal(p.owner.length, 2, 'told again the next day');
  assert.deepEqual(p.told, []);
  must(p.launch());
  const [done] = await p.run();
  assert.equal(done.applied, true, JSON.stringify(done));
  assert.equal(p.rec.read('card', 'C-1').doc.main_commit, HEAD);
  assert.equal(p.rec.read('card', 'C-1').doc.product, PRODUCT);
  assert.match(p.told[0].text, /plan-a\.json was applied\. Created: C-1\./);
});

test('R-0b-170: the Lead reads what a plan created and updated, and which cards it left out', async () => {
  const p = planWorld();
  must(p.launch());
  p.hand('plan-a.json', [planCard('C-1'), planCard('C-2')]);
  await p.run();
  p.hand('plan-b.json', [planCard('C-1', { tier: 1 }), planCard('C-3')]);
  await p.run();
  assert.equal(p.told.length, 2);
  assert.equal(p.told[1].text, 'Your plan plan-b.json was applied. Created: C-3. Updated: C-1. Not in this plan and left as they were: C-2.');
  assert.equal(p.rec.read('card', 'C-2').doc.state, 'draft');
});

test('R-0b-170: a plan the Record turns down reaches the Lead with the Record\'s reason', async () => {
  const p = planWorld();
  must(p.launch());
  p.hand('plan-a.json', [planCard('C-1')]);
  await p.run();
  p.hand('plan-b.json', [planCard('C-1', { module: 'other' })]);
  const [r] = await p.run();
  assert.notEqual(r.applied, true);
  assert.match(p.told[1].text, /plan-b\.json was not applied: card C-1 is in module store, and that can't change/);
  assert.equal(p.rec.read('card', 'C-1').doc.module, 'store');
});

test('L473: a plan file or a roadmap file changing a card with its go is refused, and the Lead hears which card and why', async () => {
  const p = planWorld();
  p.launch();
  const c = planCard('C-1');
  p.hand('plan-a.json', [c]);
  await p.run();
  const cur = p.rec.read('card', 'C-1');
  seed(p.E, 'card', 'C-1', { ...cur.doc, state: 'ready' });
  p.told.length = 0;
  p.hand('plan-b.json', [{ ...c, brief: { ...c.brief, goal: 'another goal' } }]);
  await p.run();
  assert.match(p.told[0].text, /plan-b\.json was not applied: card C-1 already has the owner's go and is ready to start, so its plan can't change/);
  assert.equal(p.rec.read('card', 'C-1').doc.state, 'ready');
  const rev = p.rec.read('card', 'C-1').rev;
  p.hand('roadmap-c.md', `${JSON.stringify({ entity: 'card', id: 'C-1', expectRev: rev, fields: { files: ['src/other.mjs'] } })}\nnotes\n`);
  await p.run();
  assert.match(p.told[1].text, /roadmap-c\.md was not applied: card C-1 already has the owner's go and is ready to start, so its plan can't change/);
  assert.deepEqual(p.rec.read('card', 'C-1').doc.files, cur.doc.files);
});

const OVER_A_DAY = 25 * 3600 * 1000;
const passes = async (p, n = 3, opts) => { let last; for (let i = 0; i < n; i++) last = await p.run(opts); return last; };
const badFile = (p, name = 'plan-z.json') => { symlinkSync(join(p.ob, 'nowhere'), join(p.ob, name)); return name; };

test('L475: a file that fails the read step is told once, then once a day, and stays where it is', async () => {
  const p = planWorld();
  const name = badFile(p);
  const last = await passes(p);
  assert.equal(p.owner.length, 1, JSON.stringify(p.owner));
  assert.match(p.owner[0], /plan-z\.json/);
  assert.match(last.find((r) => r.name === name).refused, /following a link/, 'every pass still reports it');
  assert.ok(lstatSync(join(p.ob, name)).isSymbolicLink(), 'the file is left alone');
  await passes(p);
  assert.equal(p.owner.length, 1);
  p.E.clock.t += OVER_A_DAY;
  await passes(p);
  assert.equal(p.owner.length, 2, 'told again a day later, once');
});

test('L475: a Lead file of a kind it can\'t hand in is told to the Lead once, then once a day, and stays where it is', async () => {
  const p = planWorld();
  p.hand('verdict-a.md', 'x');
  await passes(p);
  assert.equal(p.told.length, 1, JSON.stringify(p.told));
  assert.match(p.told[0].text, /verdict-a\.md was not used/);
  assert.deepEqual(p.owner, []);
  assert.ok(existsSync(join(p.ob, 'verdict-a.md')));
  p.E.clock.t += OVER_A_DAY;
  await passes(p);
  assert.equal(p.told.length, 2);
  rmSync(join(p.ob, 'verdict-a.md'));
  await p.run();
  p.hand('verdict-a.md', 'x');
  await passes(p);
  assert.equal(p.told.length, 3, 'gone, then back, is told at once');
});

test('L475: a Lead that can\'t be told means the owner reads it, once; if neither has it, the next pass asks again', async () => {
  const p = planWorld();
  p.hand('verdict-a.md', 'x');
  await passes(p, 3, { reply: async () => ({ ok: false, reason: 'tab closed' }) });
  assert.equal(p.owner.length, 1, JSON.stringify(p.owner));
  assert.match(p.owner[0], /could not be told \(tab closed\).*verdict-a\.md/);

  const q = planWorld();
  q.hand('verdict-a.md', 'x');
  const alert = fakeAlert({ answer: false });
  let asked = 0;
  for (let i = 0; i < 2; i++) await intakePass({ rec: q.rec, sessions: q.sessions, ...q.ports, alert, now: q.E.clock.t, replyToLead: async () => { asked += 1; return { ok: false, reason: 'tab closed' }; } });
  assert.equal(asked, 2, 'nobody has it, so it is not marked told');
});

test('L475: each file has its own cause, in each session, and a new reason is a new tell', async () => {
  const p = planWorld();
  badFile(p, 'plan-y.json');
  badFile(p, 'plan-z.json');
  const other = mk(join(p.E.outRoot, 'lead', 'L-2'));
  p.sessions.push({ sessionId: 'L-2', role: 'lead', outbox: other, uid: UID });
  symlinkSync(join(other, 'nowhere'), join(other, 'plan-z.json'));
  await passes(p);
  assert.equal(p.owner.length, 3, JSON.stringify(p.owner));

  const q = planWorld();
  const looks = ['it failed one way', 'it failed another way'];
  const pass = () => withAlerts(q.rec, q.E.clock.t, (x) => { q.owner.push(x); return true; }, (alert) => intakePass({ rec: q.rec, sessions: q.sessions, ...q.ports,
    list: () => ['plan-z.json'], look: () => 'same', read: () => ({ ok: false, reason: `plan-z.json: ${looks[0]}` }), alert, now: q.E.clock.t, replyToLead: async () => ({ ok: true }) }));
  await pass();
  await pass();
  looks.shift();
  await pass();
  assert.equal(q.owner.length, 2, JSON.stringify(q.owner));
});

test('L475: two files refused for the same reason are two tells, each naming its file', async () => {
  const p = planWorld();
  const pass = () => withAlerts(p.rec, p.E.clock.t, (x) => { p.owner.push(x); return true; }, (alert) => intakePass({ rec: p.rec, sessions: p.sessions, ...p.ports,
    list: () => ['plan-y.json', 'plan-z.json'], look: () => 'same', read: () => ({ ok: false, reason: 'it is too large' }), alert, now: p.E.clock.t, replyToLead: async () => ({ ok: true }) }));
  await pass();
  await pass();
  assert.equal(p.owner.length, 2, JSON.stringify(p.owner));
  assert.match(p.owner.join('\n'), /plan-y\.json[^]*plan-z\.json/);
});

test('L475: a first tell still waiting to go out is dropped when its file goes', async () => {
  const p = planWorld();
  const name = badFile(p);
  await withAlerts(p.rec, p.E.clock.t, () => false, (alert) => intakePass({ rec: p.rec, sessions: p.sessions, ...p.ports, alert, now: p.E.clock.t, replyToLead: async () => ({ ok: true }) }));
  assert.deepEqual(p.owner, []);
  rmSync(join(p.ob, name));
  await passes(p);
  assert.deepEqual(p.owner, [], 'nothing is told about a file that is gone');
});

test('L475: the cause ends when the file is gone or reads cleanly, so the same trouble later is told at once', async () => {
  const p = planWorld();
  must(p.launch());
  const name = badFile(p);
  await passes(p);
  assert.equal(p.owner.length, 1);
  rmSync(join(p.ob, name));
  await p.run();
  assert.equal(p.owner.length, 1, 'clearing tells nothing');
  badFile(p);
  await passes(p);
  assert.equal(p.owner.length, 2, 'gone, then back');

  rmSync(join(p.ob, name));
  p.hand(name, [planCard('C-1')]);
  await passes(p);
  assert.equal(p.owner.length, 2, 'the same name now reads cleanly');
  assert.equal(p.rec.read('card', 'C-1').doc.state, 'draft');
  rmSync(join(p.ob, name));
  badFile(p);
  await p.run();
  assert.equal(p.owner.length, 3, 'read cleanly, then bad again');
});

test('L475: nothing says a file is fine when its outbox could not be listed or it is still being written', async () => {
  const p = planWorld();
  badFile(p);
  await passes(p);
  const list = () => { throw new Error('EACCES'); };
  let flips = 0;
  const look = () => { flips += 1; return flips; };
  await withAlerts(p.rec, p.E.clock.t, (x) => { p.owner.push(x); return true; }, async (alert) => {
    const go = (extra) => intakePass({ rec: p.rec, sessions: p.sessions, ...p.ports, alert, now: p.E.clock.t, replyToLead: async () => ({ ok: true }), ...extra });
    await go({ list });
    await go({ look });
  });
  await passes(p);
  assert.equal(p.owner.length, 1, JSON.stringify(p.owner));
});

test('L474: a refused roadmap file is told to the Lead once, however many passes see it', async () => {
  const p = planWorld();
  p.launch();
  const c = planCard('C-1');
  p.hand('plan-a.json', [c]);
  await p.run();
  const cur = p.rec.read('card', 'C-1');
  seed(p.E, 'card', 'C-1', { ...cur.doc, state: 'ready' });
  p.told.length = 0;
  p.hand('roadmap-c.md', `${JSON.stringify({ entity: 'card', id: 'C-1', expectRev: p.rec.read('card', 'C-1').rev, fields: { files: ['src/other.mjs'] } })}\nnotes\n`);
  const passes = [];
  for (let n = 0; n < 3; n++) passes.push((await p.run()).find((r) => r.name === 'roadmap-c.md'));
  assert.match(passes[0].refused, /already has the owner's go/);
  assert.deepEqual(passes.slice(1).map((r) => r?.already), [true, true], 'the same file is looked at again on the later passes');
  assert.equal(p.told.length, 1, JSON.stringify(p.told));
  assert.match(p.told[0].text, /roadmap-c\.md was not applied/);
});

test('R-0b-170: a Lead that can\'t be told means the owner reads it instead', async () => {
  for (const reply of [async () => ({ ok: false, reason: 'the folder is gone' }), async () => { throw new Error('the folder is gone'); }, async () => undefined]) {
    const p = planWorld();
    must(p.launch());
    p.hand('plan-a.json', [planCard('C-1')]);
    await p.run({ reply });
    assert.equal(p.rec.read('card', 'C-1').doc.state, 'draft', 'the plan still counts');
    assert.equal(p.owner.length, 1);
    assert.match(p.owner[0], /the Lead L-1 could not be told .*plan-a\.json was applied/);
    p.hand('plan-b.json', '{"cards":');
    await p.run({ reply });
    assert.match(p.owner[1], /the Lead L-1 could not be told .*plan-b\.json was not applied/);
  }
});
