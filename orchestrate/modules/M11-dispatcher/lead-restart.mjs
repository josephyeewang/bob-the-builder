// Restarting a large Lead from its own handoff (R-0b-63; design v4 §5.5; review 0b-6 M18, m8, m9).
//
// Trigger: the first finished turn past context.lead.soft with nothing in flight (no quiet-minutes
// wait). Then:
//   1. WRAP goes through sendSafe; if refused (the Lead is busy or waiting on an answer), it is tried
//      again at the next finished turn;
//   2. the Lead writes handoff-<session>.md to its outbox and replies DONE;
//   3. the outbox intake checks the handoff is under context.handoff_cap.role, estimated as
//      ceil(utf-8 bytes / 4) (`handoffVet`), and applies it; an oversize one is not used;
//   4. once applied: a `handoff` entry, the old session stopped (its transcript kept), the new Lead
//      started on the same profile with the handoff first.
// A missing or oversize handoff gets one re-ask; after that the old Lead keeps running and Joe is
// told. A Lead is never stopped without an applied handoff. A Lead read above
// context.lead.hard + 50k means Claude Code's own compaction did not fire: alert once (m9).
// The step's progress is the fact `lead-restart-<session>`.

import { KEYS, need } from './keys.mjs';
import { tellThen } from './alerts.mjs';
import { ENTITIES } from '../../shared/record.mjs';

export const RESTART_FACT = (sid) => `lead-restart-${sid}`;
export const HANDOFF_NAME = (sid) => `handoff-${sid}.md`;
export const HARD_MARGIN = 50_000;
const SID = /^[A-Za-z0-9-]+$/;
const iso = (ms) => new Date(ms).toISOString();

/** The handoff estimate (m8): ceil(utf-8 bytes / 4). */
export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4);

/** The intake's vet for handoff files: refuses one over the cap, so the session can write it again. */
export const handoffVet = (rules) => ({ kind, text }) => {
  if (kind !== 'handoff') return null;
  const cap = need(rules, KEYS.handoffCapRole);
  const est = estimateTokens(text);
  return est > cap ? `the handoff is about ${est} tokens, over the ${cap} cap` : null;
};

/**
 * Whether anything is in flight for this Lead (M18): a file in its outbox not yet used (or still
 * being written), any record entry waiting on the Lead, or an open question box.
 * `outboxNames`: the names in the Lead's outbox now. `questionOpen`: from the activity tracker.
 */
export function leadInFlight({ rec, sessionId, outboxNames, questionOpen }) {
  if (questionOpen) return 'a question box is open';
  for (const name of outboxNames) {
    const used = rec.read('fact', `intake-applied-${sessionId}-${name}`)?.doc?.state;
    // A read-only request queued on a refusal (`waiting`, held by the red band or a cap) is not in flight:
    // it could wait until the weekly reset, and the Lead's restart is never held by the budget (audit
    // 0b-6 r3 MAT-4, L31). WRAP tells the Lead that queued requests do not carry over.
    if (name.startsWith('.') || !['applied', 'refused', 'interrupted', 'waiting'].includes(used)) return `outbox file ${name} not used yet`;
  }
  // `claim` leaves the record's entities in 0b-2; only the ones the record still has are read.
  for (const entity of ['card', 'merge', 'ask', 'go', 'claim', 'report'].filter((e) => ENTITIES.includes(e))) {
    // The Record has no Lead waiter (WAIT_WHO): a card waiting for the Lead's split waits on a dependency, `needs_split`.
    for (const { id, doc } of rec.list(entity)) if (doc?.state === 'waiting' && doc.wait?.what === 'needs_split') return `${entity} ${id} waits on the Lead`;
  }
  return null;
}

/**
 * One pass for one Lead. `size` = readSize() of its transcript; `inFlight` = leadInFlight()'s
 * answer; `send(text)` = sendSafe to this Lead -> { outcome }; `stopSession()`, `startLead({
 * handoff })` -> { ok, reason }; `alert(text)`. Returns the action taken.
 */
export async function leadRestartStep({ rec, rules, now, lead, size, inFlight, send, stopSession, startLead, alert }) {
  const sid = lead.sessionId;
  if (!SID.test(String(sid))) return 'refused: a session id the outbox names cannot hold';
  const soft = need(rules, KEYS.leadSoft);
  const hard = need(rules, KEYS.leadHard);
  const cap = need(rules, KEYS.handoffCapRole);
  let cur = rec.read('fact', RESTART_FACT(sid));
  let st = cur?.doc ?? { phase: 'none', reasks: 0 };
  const save = (doc, kind) => {
    const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: RESTART_FACT(sid), expectRev: cur?.rev ?? 0, doc: { ...st, ...doc, changed_at: iso(now) }, kind });
    if (w.ok) { cur = rec.read('fact', RESTART_FACT(sid)); st = cur.doc; }
    return w;
  };

  const noSize = !size || size.tokens == null;
  // Told only once sent (audit 0b-6 r5 MAT-2).
  if (!noSize && size.tokens > hard + HARD_MARGIN && !st.hard_told) {
    tellThen(alert, `the Lead ${sid} is at ${size.tokens} tokens, past ${hard} + ${HARD_MARGIN}: its compaction did not happen`, { fact: RESTART_FACT(sid), fields: { hard_told: true }, kind: 'lead_hard_alert' });
  }
  // A give-up whose alert the queue refused is told again each pass until it is delivered (L130).
  if (st.phase === 'gave_up' && !st.gave_up_told) tellThen(alert, gaveUpText(sid, st.gave_up_why), { fact: RESTART_FACT(sid), fields: { gave_up_told: true }, kind: 'lead_gave_up_alert' });
  if (['done', 'gave_up'].includes(st.phase)) return st.phase;
  // The old Lead is stopped and the new one did not start (audit 0b-6 r2 MIN-1): try again every pass,
  // whatever the old transcript says; Joe was told once.
  if (st.phase === 'start_failed') {
    let again;
    try { again = await startLead({ handoff: `handoff-${sid}` }); } catch (e) { again = { ok: false, reason: e.message }; }
    if (!again?.ok) {
      // Told once delivered (L130): a first alert the queue refused is asked again here, each pass.
      if (!st.start_failed_told) tellThen(alert, startFailedText(sid, again?.reason), { fact: RESTART_FACT(sid), fields: { start_failed_told: true }, kind: 'lead_start_failed_alert' });
      return 'new Lead still not started; tried again next pass';
    }
    save({ phase: 'done', restarted_at: iso(now), new_lead: again.sessionId ?? null }, 'lead_restarted');
    return 'restarted';
  }
  if (noSize) return 'no size';
  // Every move happens only at a finished turn: never WRAP mid-turn, never act on a turn in progress.
  if (!size.turnEnded) return 'mid-turn';

  if (st.phase === 'none') {
    if (size.tokens <= soft) return 'under the soft line';
    if (inFlight) return `waiting: ${inFlight}`;
    const r = await send(wrapText(sid, cap));
    if (r?.outcome !== 'sent') return `WRAP not sent (${r?.outcome ?? 'no answer'}); tried again at the next finished turn`;
    save({ phase: 'wrap_sent', sent_at: iso(now), wrap_at: iso(now), reasks: 0 }, 'lead_wrap');
    return 'WRAP sent';
  }

  // wrap_sent or reasked: wait for the Lead's answer (a turn ended after the ask) or the handoff.
  const used = rec.read('fact', `intake-applied-${sid}-${HANDOFF_NAME(sid)}`)?.doc;
  const answered = size.endedAt != null && size.endedAt > Date.parse(st.sent_at);
  // Only a hand-off applied after WRAP counts (audit 0b-6 r2 MAT-3): an older one under the same name
  // would start the new Lead from an out-of-date note. No time recorded counts as older.
  const since = Date.parse(st.wrap_at ?? st.sent_at);
  // Strictly after: intake and this step share one `now`, so a hand-off applied in the pass that sent WRAP
  // was written before it (audit 0b-6 r3 MIN-3).
  const fresh = used?.state === 'applied' && Date.parse(used.applied_at ?? '') > since;
  if (fresh) {
    // The hand-off is the Lead's own record, made from its outbox file by the Record (applyOutbox, kind handoff; L74):
    // the Dispatcher writes none, it only checks the Record holds this one.
    const held = rec.list('handoff').some((h) => h.doc?.session_id === sid && h.doc.sha256 === used.sha256 && /^lead(:|$)/.test(rec.meta?.('handoff', h.id)?.createdBy ?? ''));
    if (!held) return 'handoff not recorded yet';
    // Two Leads never run at once (audit MAT-8): the new one starts only once the old one is stopped.
    let stopped;
    try { stopped = await stopSession(); } catch (e) { stopped = { ok: false, reason: e.message }; }
    if (!stopped?.ok) {
      save({ stop_failed_at: iso(now) }, 'lead_stop_failed');
      if (!st.stop_told) tellThen(alert, `the Lead ${sid} handed off but could not be stopped (${stopped?.reason ?? 'no answer'}); no new Lead starts until it is`, { fact: RESTART_FACT(sid), fields: { stop_told: true }, kind: 'lead_stop_failed' });
      return 'old Lead not stopped; tried again next pass';
    }
    let started;
    try { started = await startLead({ handoff: `handoff-${sid}` }); } catch (e) { started = { ok: false, reason: e.message }; }
    if (!started?.ok) {
      save({ phase: 'start_failed', stopped_at: iso(now) }, 'lead_start_failed');
      tellThen(alert, startFailedText(sid, started?.reason), { fact: RESTART_FACT(sid), fields: { start_failed_told: true }, kind: 'lead_start_failed_alert' });
      return 'stopped; new Lead failed to start';
    }
    save({ phase: 'done', restarted_at: iso(now), new_lead: started.sessionId ?? null }, 'lead_restarted');
    return 'restarted';
  }
  if (!answered) return 'waiting for the handoff';
  const why = used?.state === 'refused' ? 'the record refused it' : used?.state === 'interrupted' ? 'its hand-in was interrupted'
    : used?.state === 'applied' ? 'a handoff under that name was already used before the WRAP' : 'it is missing or over the cap';
  if ((st.reasks ?? 0) < 1) {
    const r = await send(`Your handoff was not used (${why}). Write ${HANDOFF_NAME(sid)} again, under ${cap} tokens (about ${cap * 4} bytes), then reply DONE.`);
    if (r?.outcome !== 'sent') return `re-ask not sent (${r?.outcome ?? 'no answer'})`;
    save({ phase: 'reasked', sent_at: iso(now), reasks: 1 }, 'lead_reask');
    return 're-asked';
  }
  save({ phase: 'gave_up', gave_up_why: why }, 'lead_restart_gave_up');
  tellThen(alert, gaveUpText(sid, why), { fact: RESTART_FACT(sid), fields: { gave_up_told: true }, kind: 'lead_gave_up_alert' });
  return 'gave up; the old Lead keeps running';
}

const startFailedText = (sid, reason) => `the Lead ${sid} was stopped after its handoff, but the new Lead did not start: ${reason ?? 'no answer'}; it is tried again every pass`;
const gaveUpText = (sid, why) => `the Lead ${sid} did not hand in a usable handoff after a second ask (${why ?? 'no reason recorded'}); it keeps running`;
const wrapText = (sid, cap) => `WRAP: this session is large. Write your handoff to your outbox as ${HANDOFF_NAME(sid)}, under ${cap} tokens (about ${cap * 4} bytes), then reply DONE. Requests still queued in your outbox do not carry over: name any you still need in the handoff.`;
