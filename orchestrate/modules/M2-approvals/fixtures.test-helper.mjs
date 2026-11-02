// fixtures.test-helper.mjs — set-up for M2's tests: a real M9 record (every write through the writer), the owner's
// settings, a rules fake whose count_approval follows M10's answer, and a conversation log written the way Claude Code
// 2.1.312 writes one (checked 30 Oct 2026: the box is a tool_use with input {questions}; the tap is a user entry with a
// tool_result and toolUseResult {questions, answers: {question: label}, annotations}).

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, launch, must, PRODUCT, fullTimeouts } from '../M9-record/fixtures.test-helper.mjs';
import { ask, deny, fakeRules } from '../../shared/rules.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { makeTranscriptCopies } from './transcript-copy.mjs';

export { PRODUCT, must, launch };

export const OWNER_ID = 4242;
export const CONFIG = {
  'accounts.joe.github_id': OWNER_ID,
  'accounts.joe.tz': 'America/Los_Angeles',
  'approvals.push_windows': ['08:00', '17:00'],
  'approvals.decisions_dir': 'decisions',
};

// count_approval as M10 answers it (engine.mjs): the channel a kind needs, at the tier that channel means.
export function countApproval(s) {
  const k = activeKind(s?.ask_kind);
  if (!k) return deny('unknown ask kind');
  if (!Array.isArray(s.risky)) return deny('bad risky list');
  const need = k.channel === 'github_review' || s.risky.length || (k.go && s.tier === 1) ? 1 : 2;
  const got = s.channel === 'github_review' ? 1 : s.channel === 'tap' ? 2 : 0;
  return got === need ? ask(need, 'the owner answers') : deny(`needs the ${need === 1 ? 'GitHub' : 'tap'} channel`);
}

export function env({ values = {}, answers = {} } = {}) {
  const e = setup({ prefix: 'm2-' });
  const rules = fakeRules({ values: { timeouts: fullTimeouts(), ...CONFIG, ...values }, answers: { count_approval: countApproval, ...answers } });
  const alerts = [];
  const copies = makeTranscriptCopies({ root: join(e.base, 'copies') });
  // The sink answers like M11's outbox (L124 M-1): true once queued; set sink.answer = false and it refuses, queuing nothing;
  // 'throws' and it throws (L130: a throw counts as false).
  const sink = { answer: true };
  const alert = (a) => { if (sink.answer === 'throws') throw new Error('the alert could not be sent'); if (sink.answer === false) return false; alerts.push(a); return true; };
  const ctx = { record: e.record, rules, product: PRODUCT, copies, now: () => e.clock.t, alert };
  return { ...e, ctx, alerts, sink, log: (sid) => join(e.base, `${sid}.jsonl`) };
}

// A session the Dispatcher launched (front_door / thinking / lead / worker …).
export function session(t, sid, role = 'front_door') {
  must(t.record.write({ actor: 'dispatcher', entity: 'launch', id: `launch-${sid}`, expectRev: 0,
    doc: { session_id: sid, role, card: 'C-0', head: 'a'.repeat(40), rev: 1, launched_at: new Date(t.clock.t).toISOString() } }), 'launch');
}

let n = 0;
const iso = (ms) => new Date(ms).toISOString();
export const write = (t, sid, ...entries) => { for (const e of entries) appendFileSync(t.log(sid), `${JSON.stringify({ sessionId: sid, ...e })}\n`); };

export function box(input, at, id = `toolu_${++n}`) {
  return { id, entry: { type: 'assistant', uuid: `u${++n}`, timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } } };
}
export function tap(boxId, input, label, at, { isError = false, answers } = {}) {
  const q = input.questions[0].question;
  return { type: 'user', uuid: `u${++n}`, timestamp: iso(at), sourceToolAssistantUUID: 'x',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: boxId, content: isError ? 'declined' : `User has answered your questions: "${q}"="${label}".`, ...(isError ? { is_error: true } : {}) }] },
    ...(isError ? {} : { toolUseResult: { questions: input.questions, answers: answers ?? { [q]: label }, annotations: {} } }) };
}
export const typed = (text, at) => ({ type: 'user', uuid: `u${++n}`, timestamp: iso(at), message: { role: 'user', content: text } });
export const queuedLine = (text, at) => ({ type: 'attachment', uuid: `u${++n}`, timestamp: iso(at), attachment: { type: 'queued_command', prompt: text, origin: { kind: 'human' } } });
