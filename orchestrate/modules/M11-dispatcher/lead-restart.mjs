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
//      started on the same profile with the handoff first, and its launch record written (below).
// A missing or oversize handoff gets one re-ask; after that the old Lead keeps running and Joe is
// told. A Lead is never stopped without an applied handoff. A Lead read above
// context.lead.hard + 50k means Claude Code's own compaction did not fire: alert once (m9).
// The step's progress is the fact `lead-restart-<session>`.

import { KEYS, need } from './keys.mjs';
import { USED_STATES } from './intake-facts.mjs';
import { plain, tellThen, writeFrom } from './alerts.mjs';
import { holdAlert } from './pass.mjs';
import { ENTITIES, leadLaunchHead } from '../../shared/record.mjs';
import { pastTime, stillWaiting, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';

export const RESTART_FACT = (sid) => `lead-restart-${sid}`;
export const HANDOFF_NAME = (sid) => `handoff-${sid}.md`;
export const HARD_MARGIN = 50_000;
const SID = /^[A-Za-z0-9-]+$/;
const namesSession = (sid) => typeof sid === 'string' && SID.test(sid);
const iso = (ms) => new Date(ms).toISOString();

/**
 * The Lead's launch record (R-0b-170, L460), written at every Lead start: the main commit it started on, read before the
 * start. A plan takes its main_commit from here, so a Lead with no record can't plan, and the owner is told why.
 * `head` is a sha, or null when it could not be read. Only a restart calls this today: nothing starts a Lead for the
 * first time yet, and until that is wired (on the cutover list) a first-started Lead has no record and its plans are held.
 */
export function recordLeadLaunch({ rec, now, alert, sessionId, head, product = null }) {
  const named = namesSession(sessionId);
  const w = !named ? { ok: false, reason: 'the start named no session' }
    : !/^[0-9a-f]{40}$/.test(String(head)) ? { ok: false, reason: 'the main commit could not be read' }
      : rec.write({ actor: 'dispatcher', entity: 'launch', id: `lead-${sessionId}-${now}`, expectRev: 0, kind: 'launch',
        doc: { session_id: sessionId, role: 'lead', card: null, head, rev: null, product, launched_at: iso(now) } });
  if (!w.ok) holdAlert({ rec, cause: named ? `lead-launch-${sessionId}` : 'lead-launch-no-session', text: `${named ? `the Lead ${sessionId}` : 'a Lead'} started with no launch record, so its plans will be refused: ${w.reason}`, alert, now });
  return w;
}

/** The handoff estimate (m8): ceil(utf-8 bytes / 4). */
export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4);

/** The intake's vet for handoff files: refuses one over the cap, so the session can write it again. */
export const handoffVet = (rules) => ({ session, kind, text }) => {
  if (kind !== 'handoff-') return null;
  // Said here, so the owner hears the true cause: the rules are fine, and need() would say they have no value (L584 M1).
  if (!session?.product) throw new Error(`the session names no product, so ${KEYS.handoffCapRole} can't be read for it`);
  const cap = need(rules, KEYS.handoffCapRole, { product: session.product });
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
    if (name.startsWith('.') || !USED_STATES.has(used)) return `outbox file ${name} not used yet`;
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
 * handoff })` -> { ok, reason, sessionId }; `mainSha({ product })` -> sha; `alert(text)`.
 * `handoffRefused`: why this pass's intake refused the Lead's handoff file, if it did. A refusal writes no fact, so the
 * tick hands it on, and the Lead and the owner hear the true cause (L584 M1). Returns the action taken. Throws when the
 * Lead's id or rules can't be read: the tick tells that Lead and goes on to the next (tellLeadSkipped).
 */
export async function leadRestartStep({ rec, rules, now, lead, size, inFlight, send, stopSession, startLead, mainSha, alert, handoffRefused }) {
  const sid = lead?.sessionId;
  if (!namesSession(sid)) throw new Error('its session id is missing, or is one the outbox names cannot hold');
  if (!lead.product) throw new Error('it names no product, so its rules can\'t be read');
  const soft = need(rules, KEYS.leadSoft, { product: lead.product });
  const hard = need(rules, KEYS.leadHard, { product: lead.product });
  const cap = need(rules, KEYS.handoffCapRole, { product: lead.product });
  let cur = rec.read('fact', RESTART_FACT(sid));
  // Spread, not `??`: the hard-line alert's mark makes this fact with no phase, and that Lead still needs its WRAP.
  let st = { phase: 'none', reasks: 0, ...cur?.doc };
  const pendingRefused = (id, what) => holdAlert({ rec, cause: `lead-launch-pending-${id}`, text: `the Lead ${id} has ${what}`, alert, now });
  // Main is read before the start, so the record names the commit the new Lead started on, not one that landed after.
  const startNext = async () => {
    const product = lead.product ?? null;
    let head = null;
    try { head = await mainSha({ product }); } catch { head = null; }
    let r;
    try { r = await startLead({ handoff: `handoff-${sid}` }); } catch (e) { r = { ok: false, reason: e.message }; }
    if (r?.ok && !recordLeadLaunch({ rec, now, alert, sessionId: r.sessionId, head, product }).ok && namesSession(r.sessionId)) {
      const w = writeFrom(rec, RESTART_FACT(r.sessionId), null, { phase: 'none', reasks: 0, launch_pending: true }, 'lead_launch_pending');
      if (!w?.ok) pendingRefused(r.sessionId, `no launch record, and its retry could not be saved, so nothing will try again (${w?.reason ?? 'no answer'})`);
    }
    return r;
  };
  const save = (doc, kind) => {
    const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: RESTART_FACT(sid), expectRev: cur?.rev ?? 0, doc: { ...st, ...doc, changed_at: iso(now) }, kind });
    if (w.ok) { cur = rec.read('fact', RESTART_FACT(sid)); st = cur.doc; }
    return w;
  };
  // The old Lead keeps running, and the owner is told until a copy is delivered (L130). `asked`: a second ask was sent.
  const giveUp = (why, asked = true) => {
    save({ phase: 'gave_up', gave_up_why: why, gave_up_asked: asked }, 'lead_restart_gave_up');
    tellThen(alert, gaveUpText(sid, why, asked), { fact: RESTART_FACT(sid), fields: { gave_up_told: true }, kind: 'lead_gave_up_alert' });
    return 'gave up; the old Lead keeps running';
  };

  // A start that left no launch record is tried again each pass for that session (L490 m5). Main is read now, so a commit
  // that landed since the start can be named; a plan made on an older one is still checked by the reviewer against main.
  if (st.launch_pending) {
    // A record that is already there means only the flag failed to clear: a second record would be one more each pass.
    let recorded = Boolean(leadLaunchHead(rec, sid));
    if (!recorded) {
      const product = lead.product ?? null;
      let head = null;
      try { head = await mainSha({ product }); } catch { head = null; }
      recorded = recordLeadLaunch({ rec, now, alert, sessionId: sid, head, product }).ok;
    }
    if (recorded) {
      const w = save({ launch_pending: false }, 'lead_launch_pending');
      if (!w.ok) pendingRefused(sid, `a launch record, but its retry mark could not be cleared (${w.reason})`);
    }
  }

  const noSize = !size || size.tokens == null;
  // Told only once sent (audit 0b-6 r5 MAT-2).
  if (!noSize && size.tokens > hard + HARD_MARGIN && !st.hard_told) {
    tellThen(alert, `the Lead ${sid} is at ${size.tokens} tokens, past ${hard} + ${HARD_MARGIN}: its compaction did not happen`, { fact: RESTART_FACT(sid), fields: { hard_told: true }, kind: 'lead_hard_alert' });
  }
  // A give-up whose alert the queue refused is told again each pass until it is delivered (L130).
  if (st.phase === 'gave_up' && !st.gave_up_told) tellThen(alert, gaveUpText(sid, st.gave_up_why, st.gave_up_asked !== false), { fact: RESTART_FACT(sid), fields: { gave_up_told: true }, kind: 'lead_gave_up_alert' });
  if (['done', 'gave_up'].includes(st.phase)) return st.phase;
  // The old Lead is stopped and the new one did not start (audit 0b-6 r2 MIN-1): try again every pass,
  // whatever the old transcript says; Joe was told once.
  if (st.phase === 'start_failed') {
    const again = await startNext();
    if (!again?.ok) {
      // Told once delivered (L130): a first alert the queue refused is asked again here, each pass.
      if (!st.start_failed_told) tellThen(alert, startFailedText(sid, again?.reason), { fact: RESTART_FACT(sid), fields: { start_failed_told: true }, kind: 'lead_start_failed_alert' });
      return 'new Lead still not started; tried again next pass';
    }
    save({ phase: 'done', restarted_at: iso(now), new_lead: again.sessionId ?? null }, 'lead_restarted');
    return 'restarted';
  }
  // The wait on the Lead's answer has its day's cap whatever its transcript shows (L355 m5): a Lead with no size reading,
  // or never at a finished turn, a day after the ask (or with an ask time that can't be read, L329) is given up on, and
  // the owner told. Nothing is sent mid-turn and the Lead is never stopped. One at a finished turn goes the re-ask path.
  if (['wrap_sent', 'reasked'].includes(st.phase) && (noSize || !size.turnEnded)) {
    const askedAt = pastTime(st.sent_at, now);
    if (askedAt === null || now - askedAt >= STILL_WAITING_MS) {
      return giveUp(noSize ? 'its size could not be read for a day after the ask' : 'it did not finish a turn within a day of the ask', st.phase === 'reasked');
    }
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
  // The ask's time through the shared pastTime (L329): one that can't be read or lies ahead counts as long ago, so the
  // wait ends. And the wait has a cap (STILL_WAITING_MS, the code default; no rules key while the rules file is frozen):
  // a Lead that never answers counts as not answering, and goes down the same re-ask, then gave-up-and-told path.
  const sentAt = pastTime(st.sent_at, now);
  const timedOut = sentAt === null || now - sentAt >= STILL_WAITING_MS;
  const answered = timedOut || (size.endedAt != null && size.endedAt > sentAt);
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
    const started = await startNext();
    if (!started?.ok) {
      save({ phase: 'start_failed', stopped_at: iso(now) }, 'lead_start_failed');
      tellThen(alert, startFailedText(sid, started?.reason), { fact: RESTART_FACT(sid), fields: { start_failed_told: true }, kind: 'lead_start_failed_alert' });
      return 'stopped; new Lead failed to start';
    }
    save({ phase: 'done', restarted_at: iso(now), new_lead: started.sessionId ?? null }, 'lead_restarted');
    return 'restarted';
  }
  if (!answered) return 'waiting for the handoff';
  const why = handoffRefused ?? (timedOut && !(size.endedAt != null && sentAt !== null && size.endedAt > sentAt) && !used ? 'no answer within a day of the ask'
    : used?.state === 'refused' ? 'the record refused it' : used?.state === 'interrupted' ? 'its hand-in was interrupted'
    : used?.state === 'applied' ? 'a handoff under that name was already used before the WRAP' : 'it is missing or over the cap');
  if ((st.reasks ?? 0) < 1) {
    const r = await send(`Your handoff was not used (${why}). Write ${HANDOFF_NAME(sid)} again, under ${cap} tokens (about ${cap * 4} bytes), then reply DONE.`);
    if (r?.outcome !== 'sent') {
      // A re-ask the Lead keeps refusing would be tried each finished turn with no word (L359): the owner is told
      // through stillWaiting, from the first refused re-ask, then daily; cleared once the re-ask is sent.
      if (st.reask_refused_since == null) save({ reask_refused_since: iso(now) }, 'lead_reask_refused');
      const since = String(st.reask_refused_since ?? iso(now));
      stillWaiting({
        now, waiting: true, since,
        read: () => st.reask_refused_told ?? null,
        tell: (mark) => tellThen(alert, reaskRefusedText(sid, r?.outcome, since), { fact: RESTART_FACT(sid), fields: { reask_refused_told: mark }, kind: 'lead_reask_refused_alert' }),
        clear: () => {},
      });
      return `re-ask not sent (${r?.outcome ?? 'no answer'})`;
    }
    save({ phase: 'reasked', sent_at: iso(now), reasks: 1, reask_refused_since: null, reask_refused_told: null }, 'lead_reask');
    return 're-asked';
  }
  return giveUp(why);
}

/**
 * One Lead whose step threw: the owner is told which Lead, which product and why, once a day, and the tick goes on to the
 * next Lead, so one product's problem holds no other product's Lead (L584 M2).
 */
export function tellLeadSkipped({ rec, lead, error, alert, now }) {
  const sid = lead?.sessionId;
  const where = lead?.product ? `product ${plain(lead.product)}` : 'no product named';
  // A bad id gets its own cause too, so two bad Leads are both told; the id goes into a fact name, so only its safe letters.
  return holdAlert({ rec, cause: `lead-skipped-${String(sid ?? 'no-session').replace(/[^A-Za-z0-9-]/g, '_').slice(0, 80)}`, alert, now,
    text: `the Lead ${sid == null ? 'with no session id' : plain(sid)} (${where}) was skipped this pass: ${plain(error?.message ?? error)}; the other Leads still ran, and it is tried again next pass` });
}

const startFailedText = (sid, reason) => `the Lead ${sid} was stopped after its handoff, but the new Lead did not start: ${reason ?? 'no answer'}; it is tried again every pass`;
const reaskRefusedText = (sid, outcome, since) => `the Lead ${sid} did not hand in a usable handoff, and the second ask could not be sent since ${since} (${outcome ?? 'no answer'}); it is tried again at each finished turn`;
const gaveUpText = (sid, why, asked = true) => `the Lead ${sid} did not hand in a usable handoff ${asked ? 'after a second ask' : 'within a day of the ask'} (${why ?? 'no reason recorded'}); it keeps running, and a restart now needs a person`;
const wrapText = (sid, cap) => `WRAP: this session is large. Write your handoff to your outbox as ${HANDOFF_NAME(sid)}, under ${cap} tokens (about ${cap * 4} bytes), then reply DONE. Requests still queued in your outbox do not carry over: name any you still need in the handoff.`;
