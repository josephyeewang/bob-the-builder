// Outbox intake (R-0b-56, R-0b-58; design v4 rail A2, §6.1 item 3, §14.1.2; review 0b-6 M15, M20, m1).
//
// AI sessions never write the record. Each writes plain files into its own outbox; each pass the
// Dispatcher hands them to `rec.applyOutbox()` tagged with the role from ITS OWN session map
// (outbox folder -> session -> role), never from anything inside the file. A file is applied once,
// keyed by session id, file name and sha256, and that key is kept in the record so a restarted
// Dispatcher does not apply it again. The same name with new content is refused, told once and then daily.
// A file whose size or time changes between two looks 2 s apart is half-written and waits.
//
// Files are opened only through M4's `readOutboxFile` (no links, one link count, the role's own
// user, an allowed name for that role). The Lead's think-, scout- and write- files ask for a short
// read-only session (m1): think -> reviewer profile, scout -> scout, write -> writer. Each such
// session hands back report- files.

import { createHash } from 'node:crypto';
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readOutboxFile, OUTBOX_NAME } from '../M4-workshop/launcher/outbox.mjs';
import { outboxKindOf } from '../../shared/record-names.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';
import { checkPlan } from '../M3-lead/lead-wording.mjs';
import { tellThen, dropCause, isQueued, clearCause, queuedMarks, writeFrom } from './alerts.mjs';
import { HOLD_FACT, HOLD_REPEAT_MS, causeOf, guarded, holdAlert, refusalReport } from './pass.mjs';
import { stillWaiting, STILL_WAITING_MS, pastTime } from '../../shared/still-waiting.mjs';
import { OUTBOX_KINDS, leadLaunchHead } from '../../shared/record.mjs';
import { NEVER_RAN } from '../M9-record/outbox.mjs';

export const READONLY_REQUESTS = Object.freeze({ think: 'reviewer', scout: 'scout', write: 'writer' });
export const SETTLE_MS = 2000;

// L140: a kind whose only job is to start something has no record rule, so the Record has nothing to take from it
// (the real one answers "no record rule yet"). Once its read-only session starts, the hand-in is done: it is marked
// applied here, with no applyOutbox call and no alert. Lane 1's table marks such kinds `record: 'none'`; until then a
// read-only request kind with no entity is the same thing.
/** `kind` is the request word (think, scout, write), as `word` is in intakePass; since L82 M-1 a file's kind is its prefix. */
export const startsOnly = (kind) => {
  const spec = OUTBOX_KINDS[`${kind}-`];
  return Boolean(spec) && (spec.record === 'none' || (!spec.entity && Object.hasOwn(READONLY_REQUESTS, kind)));
};
// The answer applyOutbox gives a `record: 'none'` kind (L140): handled, not refused.
const notARecord = (applied) => applied?.not_a_record === true || applied?.outcome === 'not_a_record';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// What a Lead's waiting request keeps through each write of its fact: when it began, and the mark of its tell.
const WAIT_FIELDS = ['waiting_since', 'told_at'];
const appliedId = (sessionId, name) => `intake-applied-${sessionId}-${name}`;
// The files that change a plan: their Lead hears what became of them.
const PLAN_FILES = Object.freeze(['plan-', 'roadmap-']);
// A plan file's check (R-0b-170, L460): what the Lead must fix, or nothing. The Record applies only these bytes.
function planProblems(text) {
  let plan;
  try { plan = JSON.parse(text); } catch { return ['it is not JSON']; }
  return checkPlan(plan);
}

// What became of a plan, for the Lead. A card a live plan left out stays as it was, and is named, so the Lead can act.
function planOutcome(name, applied) {
  if (!applied.ok) return `Your plan ${name} was not applied: ${applied.reason}`;
  const list = (words, ids) => (ids?.length ? ` ${words} ${ids.join(', ')}.` : '');
  return `Your plan ${name} was applied.${list('Created:', applied.created)}${list('Updated:', applied.updated)}${list('Not in this plan and left as they were:', applied.dropped)}`;
}

// One call's limit, under the tick's 120 s for the whole step (STEP_DEADLINE_MS), so a hung call can't take the step with
// it. A start is given longer. The pass has a budget too (L497 m5): past it no more notes or files are taken, and what
// was left waits for the next pass. One file already begun can still take a note, a start and a note, and that fits
// inside the step's limit (L520 s3).
export const INTAKE_PORT_MS = 5_000;
export const INTAKE_START_MS = 30_000;
export const INTAKE_PASS_MS = 75_000;
// Told only if files are still being left out this long after the first pass that left some.
export const LEFT_OUT_TELL_MS = 15 * 60 * 1000;
const LEFT_OUT_FACT = HOLD_FACT('intake-left-out-since');
// The ended records' share of a pass, in port limits, however many verdicts wait. The rest are asked next pass.
const ENDED_LIMITS = 3;
const SLOW_FACTS = HOLD_FACT('intake-slow-');
const SLOW_FACT = (key) => `${SLOW_FACTS}${shortHash(key)}`;

// A Lead that has not heard is tried again after these waits, by how many tries it has had, then each day (L497).
export const LEAD_NOTE_WAITS_MS = [5 * 60 * 1000, 60 * 60 * 1000];
const noteWait = (tries) => LEAD_NOTE_WAITS_MS[tries - 1] ?? HOLD_REPEAT_MS;

// A note for the Lead, reworded for the owner, who reads it in place of the Lead (L497 c2).
const ownerText = ({ lead, product, text, reason }) => `${product ? `Product ${product}: ` : ''}${text.replace(/^Your /, `the Lead ${lead}'s `).replace(/ (Fix it and hand|Hand) it in under a new name\.$/, '').replace(/; (hand it in again under a new name if no report comes|check the board before handing it in again)\.$/, '.')} The Lead could not be told (${reason}).`;

// Leaves a note for the Lead. Only an answer of { ok: true } means it was left.
async function leaveNote(replyToLead, lead, text) {
  try { return await replyToLead({ lead, text }); } catch (e) { return { ok: false, reason: e.message }; }
}

// L475: a file that fails the read step stays in the outbox, so every pass reads it again. Its tell is once per file
// and reason, then once a day while it stays, on `hold-outbox-read-<session>-<file>-<reason>`. The file is never moved
// or deleted, and each pass still reports it as refused. Session and file are hashed to one length: a bad file name can
// hold anything, and a fixed length lets one prefix mean one session.
const shortHash = (s) => sha256(s).slice(0, 12);
const readHoldsOf = (sessionId) => HOLD_FACT(`outbox-read-${shortHash(sessionId)}-`);
const readHoldsOfFile = (sessionId, name) => `${readHoldsOf(sessionId)}${shortHash(name)}-`;
const readHold = (sessionId, name, why) => `${readHoldsOfFile(sessionId, name)}${why}`.slice(HOLD_FACT('').length);

// A note that has no fact to be kept on, so it is tried once, and the owner reads what the Lead could not. Answers whether
// either heard it, so the caller can say when neither did (L539).
async function tellLead({ replyToLead, alert, lead, product, text }) {
  const r = await leaveNote(replyToLead, lead, text);
  return r?.ok === true || alert(ownerText({ lead, product, text, reason: r?.reason ?? 'no answer' })) !== false;
}

// A tell with a dated try (L490 m4, m10, L494, L497). The date goes on the Record before the tell and is never taken back.
// A pass is one process, so the Record is the only thing that outlives it, and a pass killed or cut off mid-tell leaves
// the date behind, so the tell's outcome is not known. The date says a try was started, never that anyone heard. A date
// the Record refuses stops the tell, and the owner hears. Answers { saved, heard, reason }.
async function tellDated({ rec, replyToLead, report, lead, fact, was, tried, text, cause, kind }) {
  const m = writeFrom(rec, fact, was, tried, kind);
  if (!m?.ok) { report(`the Lead ${lead} was not told, as the mark could not be saved (${m?.reason ?? 'no answer'}): ${text}`, cause); return { saved: false }; }
  const r = await leaveNote(replyToLead, lead, text);
  return { saved: true, heard: r?.ok === true, reason: r?.reason ?? 'no answer' };
}

// What a Lead must hear about a plan stays on the file's fact until the Lead's own port answers { ok: true } (L494 MAT-1,
// L497 m1). The owner reading it is not the Lead hearing it. A failed tell, or one a pass was cut off in, is tried again
// after LEAD_NOTE_WAITS_MS and then daily: a repeat beats a loss. The owner has the text from the first failure, then daily
// while the Lead has not heard. Each try is one date on the fact, and the owner's tell is one a day.
async function deliverNote({ rec, replyToLead, alert, report, now }, id) {
  const was = rec.read('fact', id)?.doc;
  if (typeof was?.lead_note !== 'string') return;
  const tries = Number.isInteger(was.lead_note_tries) ? was.lead_note_tries : 0;
  const last = pastTime(was.lead_note_tried_at, now);
  if (last !== null && now - last < noteWait(tries)) return;
  const text = was.lead_note;
  const lead = was.session;
  // Keyed on the text too: a second note on the same file is new to the owner, whatever the first one's day (L520 n1).
  const cause = `lead-note-${shortHash(`${id} ${text}`)}`;
  const tried = { ...was, lead_note_tried_at: new Date(now).toISOString(), lead_note_tries: tries + 1 };
  const t = await tellDated({ rec, replyToLead, report, lead, fact: id, was, tried, text, cause, kind: 'outbox_told' });
  if (!t.saved) return;
  if (!t.heard) {
    const said = holdAlert({ rec, cause, now, alert, text: ownerText({ lead, product: was.lead_note_product, text, reason: t.reason }) });
    if (said === false) report(`neither the Lead ${lead} nor the owner could be told, so it is tried again: ${text}`, cause);
    return;
  }
  const { lead_note: heard, lead_note_tried_at: at, lead_note_tries: n, lead_note_product: p, ...done } = tried;
  const cleared = writeFrom(rec, id, tried, done, 'outbox_told');
  if (!cleared?.ok) { report(`the Lead ${lead} was told, but the note could not be cleared (${cleared?.reason ?? 'no answer'}), so it is told again: ${text}`, cause); return; }
  // The wait is over, so a later note in the same words is a new one to the owner (L534 m1).
  const hold = HOLD_FACT(cause);
  if (rec.read('fact', hold)?.doc?.told_at != null || isQueued(rec, hold)) clearTold(rec, hold, now, report);
}

// A cause that has cleared: a queued copy goes, and the mark, so the next time it happens it is told at once.
function clearTold(rec, id, now, report) {
  clearCause(rec, id, () => {
    const was = rec.read('fact', id)?.doc;
    if (was) writeFrom(rec, id, was, { ...was, told_at: null, replied_at: null, cleared_at: new Date(now).toISOString() }, 'hold_cleared');
  }, (line) => report(line, 'outbox-read-clear'));
}

// Files in the order a pass takes them. A verdict whose ended record was slow goes behind the rest, and the slow ones take
// turns by the minute, so records that hang cost ENDED_LIMITS port limits a pass and can't keep any file from being reached.
function inTurn(rec, seen, now) {
  const isSlow = ({ s, name }) => pastTime(rec.read('fact', SLOW_FACT(appliedId(s.sessionId, name)))?.doc?.at, now) !== null;
  const slow = seen.filter(isSlow);
  const k = slow.length ? Math.floor(now / 60_000) % slow.length : 0;
  return [...seen.filter((x) => !isSlow(x)), ...slow.slice(k), ...slow.slice(0, k)];
}

function saveSlow({ rec, report }, id, doc) {
  const w = writeFrom(rec, id, rec.read('fact', id)?.doc, doc, 'intake_slow');
  if (!w?.ok) report(`the slow mark on an outbox file could not be saved (${w?.reason ?? 'no answer'})`, 'intake-slow');
}

// Marks a verdict slow when it first is. The mark stays, so a record that hangs on some passes and not others can't write
// a diary line each pass (L520 C). It goes when the verdict is taken, or on a quick answer once a day has passed since it
// was set, so one verdict writes at most a set and a clear a day. `clearGoneSlow` takes it when the file is gone.
function markSlow(notes, key, where, { slow, taken }) {
  const id = SLOW_FACT(key);
  const at = pastTime(notes.rec.read('fact', id)?.doc?.at, notes.now);
  if (at === null) { if (slow && !taken) saveSlow(notes, id, { at: new Date(notes.now).toISOString(), ...where }); return; }
  if (taken || (!slow && notes.now - at >= HOLD_REPEAT_MS)) saveSlow(notes, id, { at: null });
}

// Only a session whose outbox was listed this pass says anything about its files.
function clearGoneSlow(notes, listed, seen) {
  const here = new Set(seen.map(({ s, name }) => appliedId(s.sessionId, name)));
  for (const f of notes.rec.list('fact')) {
    if (!f.id.startsWith(SLOW_FACTS) || pastTime(f.doc?.at, notes.now) === null || !listed.includes(f.doc.session)) continue;
    if (!here.has(appliedId(f.doc.session, f.doc.name))) saveSlow(notes, f.id, { at: null });
  }
}

// One write when files are first left out and one when none are, and a tell only if they stay left out.
function noteLeftOut({ rec, alert, report, now }, count) {
  const was = rec.read('fact', LEFT_OUT_FACT)?.doc;
  const since = pastTime(was?.since, now);
  if (!count && since === null) return;
  if (count && since !== null) {
    if (now - since >= LEFT_OUT_TELL_MS) holdAlert({ rec, cause: 'intake-left-out', now, alert, text: `outbox intake has run out of time on its passes since ${was.since}; files left for the next pass: ${count}` });
    return;
  }
  const w = writeFrom(rec, LEFT_OUT_FACT, was, { since: count ? new Date(now).toISOString() : null }, 'intake_left_out');
  if (!w?.ok) report(`the record of outbox files left for the next pass could not be saved (${w?.reason ?? 'no answer'})`, 'intake-left-out');
}

const statOf = (p) => { try { const s = lstatSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };

/** The kinds a session may hand in (name prefixes, L82 M-1): its role's, except a read-only request session hands back report-. */
export function kindsFor(entry) {
  if (entry.request) return ['report-'];
  return [...(DESIGN_PROFILES[entry.role]?.outbox ?? [])];
}

/**
 * `sessions`: the Dispatcher's session map, [{ sessionId, role, outbox, uid, card, product, request? }].
 * `wait(ms)`: a sleep (tests pass a fake that moves the fake clock). `alert(text)` reaches Joe.
 * `startReadonly({ lead, profile, kind, brief, product })` starts a read-only session through the wiring
 *   port; the tick puts the start gate in front of it (audit 0b-6 r2 MAT-2), so it answers { ok, reason }.
 * `replyToLead({ lead, text })` leaves a report- note for the Lead; a plan's answer needs it to return { ok: true }.
 * It and `reviewEnded` have `portMs` to answer, and `startReadonly` has `startMs`. Past `passMs` the pass takes nothing
 * more: what is left is reported as waiting, and goes on the next pass.
 * `note(text, id)` writes a diary line, on the fact `id` when it names one. The diary keeps every line for good, so a
 * note is written when something moved or was told, never because a file was seen again (L490 M3). `failureLog` hears a
 * refused mark (main.mjs logs it).
 * `vet({ session, kind, text })` may refuse a file before it is used (null = fine); a vetted-out file
 * is not marked as used, so the session can write it again under the same name (an oversize handoff).
 * `reviewEnded(session)` answers from the runner's own ended record (M9 `runnerEnded`), now or as a promise: { ok, ended }
 * | { ok: false, none?, reason }. Left out, its stand-in answers "not ended" with a reason, noted every pass. A session's
 * `head` comes from the runner's launch record.
 * Returns what happened to each file.
 */
export async function intakePass({ rec, sessions, wait, alert, note, startReadonly, replyToLead: replyPort, now = Date.now(),
  list = (d) => readdirSync(d), look = statOf, read = readOutboxFile, vet = () => null,
  reviewEnded = () => ({ ok: false, reason: 'nothing can read the ended records' }), failureLog, portMs = INTAKE_PORT_MS, startMs = INTAKE_START_MS, passMs = INTAKE_PASS_MS }) {
  const out = [];
  const ends = Date.now() + passMs;
  const outOfTime = () => Date.now() >= ends;
  let leftOut = 0;
  let endedMs = 0;
  const report = refusalReport({ rec, alert, now, lines: [], failureLog });
  const replyToLead = (x) => guarded(() => replyPort(x), portMs);
  const notes = { rec, replyToLead, alert, report, now };
  // Once a day per file and reason, for a wait nobody is told about: the note's own fact is its mark.
  const noteDaily = (s, name, reason, text) => {
    const id = HOLD_FACT(`outbox-note-${shortHash(`${s.sessionId} ${name}`)}-${causeOf(reason)}`);
    const at = pastTime(rec.read('fact', id)?.doc?.at, now);
    if (at === null || now - at >= HOLD_REPEAT_MS) note(text, id);
  };
  const seen = [];
  const listed = [];
  const held = new Set();
  const unsettled = new Set();
  // L138 m3: a refused or interrupted hand-in is told until a copy is delivered, from its recorded fact, whether or
  // not its file is still in the outbox (a file removed before the tell went out is still told).
  retellHandIns(rec, alert);
  for (const f of rec.list('fact')) {
    if (typeof f.doc?.lead_note !== 'string' || f.id !== appliedId(f.doc.session, f.doc.name)) continue;
    if (outOfTime()) { leftOut += 1; continue; }
    await deliverNote(notes, f.id);
  }
  for (const s of sessions) {
    let names;
    try { names = list(s.outbox).filter((n) => !n.startsWith('.')); } catch { out.push({ session: s.sessionId, skipped: 'outbox unreadable' }); continue; }
    listed.push(s.sessionId);
    for (const name of names) seen.push({ s, name, first: look(join(s.outbox, name)) });
  }
  if (seen.length) await wait(SETTLE_MS);
  for (const { s, name, first } of inTurn(rec, seen, now)) {
    const path = join(s.outbox, name);
    const r = { session: s.sessionId, name };
    out.push(r);
    if (outOfTime()) { r.waiting = 'left for the next pass: this one ran out of time'; leftOut += 1; unsettled.add(readHoldsOfFile(s.sessionId, name)); continue; }
    if (first === null || look(path) !== first) { r.waiting = 'still being written'; unsettled.add(readHoldsOfFile(s.sessionId, name)); continue; }
    const kinds = kindsFor(s);
    const file = read(s.outbox, name, { kinds, uid: s.uid });
    if (!file.ok) {
      r.refused = file.reason;
      const k = OUTBOX_NAME.test(name) ? outboxKindOf(name) : null;
      const notItsKind = s.role === 'lead' && OUTBOX_NAME.test(name) && !kinds.includes(k);
      const cause = readHold(s.sessionId, name, notItsKind ? 'kind' : causeOf(file.reason));
      const fact = HOLD_FACT(cause);
      held.add(fact);
      // An alert still in the queue asks again each pass; only a new tell is a new line.
      const queued = isQueued(rec, fact);
      const told = notItsKind
        ? await tellLeadDaily({ ...notes, lead: s.sessionId, product: s.product, fact, text: `Your file ${name} was not used: it is not a kind you can hand in (${kinds.join(', ')}).` })
        : holdAlert({ rec, cause, now, alert, text: `an outbox file from ${s.role} ${s.sessionId} (${name}) was refused: ${file.reason}` });
      if (told && !queued) note(`outbox file ${name} from ${s.role} ${s.sessionId} refused: ${file.reason}`);
      continue;
    }
    const hash = sha256(file.text);
    const key = appliedId(s.sessionId, name);
    let prev = rec.read('fact', key);
    const forLead = (text) => ({ lead_note: text, ...(s.product ? { lead_note_product: s.product } : {}) });
    const put = (doc, kind) => {
      const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: key, expectRev: prev?.rev ?? 0, doc: { session: s.sessionId, name, sha256: hash, ...doc }, kind });
      if (w.ok) prev = rec.read('fact', key);
      return w;
    };
    if (prev?.doc?.state === 'applying' || prev?.doc?.state === 'starting') {
      // A claim left by a pass that crashed or threw between the claim and the apply (audit MAT-7). The
      // pass lock means no other pass is running, so it is not still in progress. Whether the record
      // took the file is not known, so it is never applied a second time: Joe is told once, and a new
      // copy may be handed in under the same name.
      // A `starting` claim (audit 0b-6 r2 MIN-7) is the same for a read-only start: it may have started, so it is never started twice.
      const startCut = prev.doc.state === 'starting';
      const what = startCut ? 'its read-only session may or may not have started, and was not started again' : 'it may or may not have reached the record, and was not applied again';
      // Told until delivered (L130 M7): the text is kept on the fact, and a pass that sees it untold asks again.
      const said = `the hand-in of ${name} from ${s.role} ${s.sessionId} was interrupted; ${what}`;
      // A Lead waits for that session's report, or for what became of its plan, so it hears too. The note is kept on the
      // fact, because this path runs once and a failed tell would be lost (L497 m6, L520 A, B).
      const leadNote = startCut ? `Your ${file.kind.slice(0, -1)} request ${name} may not have started; hand it in again under a new name if no report comes.`
        : PLAN_FILES.includes(file.kind) ? `Your plan ${name} may or may not have been applied; check the board before handing it in again.` : null;
      const w = put({ ...prev.doc, sha256: prev.doc.sha256, state: 'interrupted', at: new Date(now).toISOString(), alert_text: said, ...(leadNote ? forLead(leadNote) : {}) }, 'outbox_interrupted');
      if (w.ok) tellThen(alert, said, { fact: appliedId(s.sessionId, name), fields: { told_state: 'interrupted' }, kind: 'outbox_told' });
      if (w.ok && leadNote) await deliverNote(notes, key);
      prev = rec.read('fact', key);   // both may have written it, and the writes below go from this version
    }
    if (prev) {
      const was = prev.doc.state;
      if (prev.doc.sha256 === hash && was !== 'waiting') { r.already = true; continue; }
      // A file that was never used (refused, interrupted, or a plan only held) may be handed in again with new content.
      if (prev.doc.sha256 !== hash && !['refused', 'interrupted'].includes(was) && !(was === 'waiting' && file.kind === 'plan-')) {
        r.refused = 'the same name with new content';
        // One cause per file, so a file rewritten every pass is still once a day; the text names the latest bytes (L494).
        const cause = `outbox-new-${shortHash(key)}`;
        holdAlert({ rec, cause, now, alert, text: `${s.role} ${s.sessionId} handed in ${name} again with different content (latest ${hash.slice(0, 12)}); it was not used` });
        if (PLAN_FILES.includes(file.kind)) await tellLeadDaily({ ...notes, lead: s.sessionId, product: s.product, fact: HOLD_FACT(`${cause}-lead`), text: `Your file ${name} has new content under a name already used, so it was not used. Hand it in under a new name.` });
        continue;
      }
    }
    // New bytes under this name would replace the fact, and with it what the Lead has yet to hear. So the file waits for that
    // note, which is retried and told to the owner meanwhile (L534 m2).
    if (typeof prev?.doc?.lead_note === 'string') { r.waiting = 'an earlier note about this file has yet to reach its Lead'; continue; }
    // L424: a verdict is taken only once its session's ended record exists, never because the file sat still for
    // SETTLE_MS. The runner finalizes the file (it may rewrite it) and only then writes that record. Anything short of
    // a readable record waits, and takes nothing; a verdict still untaken 15 minutes after its end is told by the runner,
    // and again each day while it stays untaken (#181, L458).
    // The file was read above, before this question: the runner may have finalized it in between, so a record naming
    // other bytes also waits (L445 m2). A claim on the old bytes would make every later pass say "new content".
    // Taken only as M9 sessionVerdict counts it (L446): the file the record names, or a file found after a start that
    // never ran. Everything else waits and is noted, a value not known yet too.
    if (file.kind === 'verdict-') {
      if (endedMs >= ENDED_LIMITS * portMs) { r.waiting = 'its ended record was not asked this pass: earlier ones were slow'; continue; }
      const asked = Date.now();
      const e = await guarded(() => reviewEnded(s), portMs);
      const took = Date.now() - asked;
      // A timer can fire just before the clock reaches its delay, so a call that hit its limit costs the whole limit (L546).
      endedMs += e?.timedOut === true ? Math.max(took, portMs) : took;
      const want = e?.ended?.verdict_sha256;
      const held = e?.ok !== true ? (e?.reason ?? 'no answer from the ended record')
        : want === hash || want === NEVER_RAN ? null
          : typeof want !== 'string' ? 'its ended record does not say what verdict file it ended with'
            : want === 'none' ? 'its ended record says it ended with no verdict file'
              : want === 'refused' ? 'its ended record says its verdict could not be counted'
                : /^[0-9a-f]{64}$/.test(want) ? 'this is not the file its ended record names'
                  : 'its ended record names a verdict in a way this does not know';
      markSlow(notes, key, { session: s.sessionId, name }, { slow: took >= portMs / 2, taken: !held });
      if (held) {
        r.waiting = e?.ok === true ? held : 'its session has not ended';
        if (!e?.none) noteDaily(s, name, held, `verdict ${name} from ${s.role} ${s.sessionId} waits: ${held}`);
        continue;
      }
    }
    let why;
    try { why = vet({ session: s, kind: file.kind, text: file.text }); } catch (e) { why = `could not be checked: ${e.message}`; } // audit MIN-12
    if (why) { r.refused = why; noteDaily(s, name, why, `outbox file ${name} from ${s.role} ${s.sessionId} not used yet: ${why}`); continue; }
    // A Lead's read-only request starts its session first. Refused (at the cap, in red) -> the file waits
    // and is tried again next pass (audit MAT-6); the Lead is told once that it is queued, and the owner once it has
    // waited a day, then each day it still waits (L315). The wait's start and mark go through each write of the fact.
    const word = file.kind.slice(0, -1);   // the request's word: think-, scout-, write- -> think, scout, write
    if (s.role === 'lead' && Object.hasOwn(READONLY_REQUESTS, word)) {
      // Claim first (audit 0b-6 r2 MIN-7): a crash between the start and the claim must not start a second helper.
      const waitingSince = prev?.doc?.waiting_since ?? new Date(now).toISOString();
      const kept = Object.fromEntries(Object.entries({ ...prev?.doc, waiting_since: waitingSince }).filter(([k, v]) => WAIT_FIELDS.includes(k) && v != null));
      const claimStart = put({ state: 'starting', tries: prev?.doc?.tries ?? 0, ...kept }, 'outbox_starting');
      if (!claimStart.ok) { r.refused = `could not record the start: ${claimStart.reason}`; continue; }
      const started = await guarded(async () => {
        try { return await startReadonly({ lead: s.sessionId, profile: READONLY_REQUESTS[word], kind: word, brief: file.text, product: s.product }); }
        catch (e) { return { ok: false, reason: `the start failed: ${e.message}` }; }
      }, startMs);
      r.request = started;
      // It may have started, so it is left as a crash would leave it: the next pass tells that, and starts nothing.
      if (/^it did not answer within /.test(started?.reason ?? '')) { r.refused = `the start ${started.reason}`; continue; }
      if (!started?.ok) {
        const reason = started?.reason ?? 'no answer';
        const told = (prev?.doc?.tries ?? 0) > 0;
        put({ state: 'waiting', reason, tries: (prev?.doc?.tries ?? 0) + 1, ...kept }, 'outbox_waiting');
        if (!told) await leaveNote(replyToLead, s.sessionId, `Your ${word} request ${name} is queued: ${reason}. It starts by itself when it can.`);
        r.waiting = reason;
        stillWaiting({
          now, waiting: true, every: STILL_WAITING_MS, after: { since: waitingSince, limit: STILL_WAITING_MS },
          read: () => prev?.doc,
          tell: (fields) => tellThen(alert, `${s.role} ${s.sessionId}: the ${word} request ${name} has waited since ${waitingSince} and has not started: ${reason}`, { fact: key, fields, kind: 'outbox_told' }),
          clear: () => dropCause(rec, key),
        });
        continue;
      }
      dropCause(rec, key);
      // L140: the session started, and that was the hand-in's whole job.
      if (startsOnly(word)) {
        put({ state: 'applied', started: true, applied_at: new Date(now).toISOString() }, 'outbox_applied');
        r.applied = true;
        r.started = true;
        continue;
      }
    }
    const isPlan = file.kind === 'plan-';
    if (isPlan) {
      const problems = planProblems(file.text);
      if (problems.length) {
        const why = problems.slice(0, 10).join('; ');
        const w = put({ state: 'refused', reason: why, at: new Date(now).toISOString(), ...forLead(`Your plan ${name} was not applied: ${why}. Fix it and hand it in under a new name.`) }, 'outbox_applied');
        if (w.ok) await deliverNote(notes, key);
        else report(`the plan ${name} from ${s.sessionId} failed its check, the refusal could not be recorded (${w.reason}), and the Lead was not told: ${why}`, `plan-refused-${shortHash(key)}`);
        r.refused = why;
        continue;
      }
      if (!leadLaunchHead(rec, s.sessionId)) {
        const why = `Lead ${s.sessionId} has no launch record, so its plan ${name} can't say which main commit it was made on and is held`;
        holdAlert({ rec, cause: `plan-no-launch-${s.sessionId}`, text: why, alert, now });
        if (prev?.doc?.state !== 'waiting' || prev.doc.sha256 !== hash) put({ state: 'waiting', reason: why }, 'outbox_waiting');
        r.waiting = why;
        continue;
      }
    }
    // Claim the key first, so a crash after the apply cannot apply the file a second time.
    const claim = put({ state: 'applying' }, 'outbox_claim');
    if (!claim.ok) { r.refused = `could not record the hand-in: ${claim.reason}`; continue; }
    let applied;
    try { applied = rec.applyOutbox({ role: s.role, sessionId: s.sessionId, card: s.card, ...(isPlan ? { checked_sha256: hash } : {}) }, path); }
    catch (e) { applied = { ok: false, reason: e.message }; }
    // L140: a kind with no record rule is handled, not refused, so it is no alert.
    if (notARecord(applied)) applied = { ok: true, not_a_record: true };
    r.applied = applied.ok;
    // applied_at lets the Lead restart tell a hand-off written after WRAP from an older one (audit 0b-6 r2 MAT-3).
    // A refusal is recorded with its text first, then told until delivered (L130 M8).
    const said = applied.ok ? null : `the record refused ${name} from ${s.role} ${s.sessionId}: ${applied.reason}`;
    // A roadmap file is a plan change too, and the Lead that wrote it hears when it is turned down (L473).
    const outcome = isPlan || (!applied.ok && file.kind === 'roadmap-') ? planOutcome(name, applied) : null;
    const done = put({ state: applied.ok ? 'applied' : 'refused', applied_at: new Date(now).toISOString(), ...(said ? { alert_text: said } : {}), ...(outcome ? forLead(outcome) : {}) }, 'outbox_applied');
    if (!applied.ok) {
      r.refused = applied.reason;
      // A refusal the record would not keep has no fact to re-ask from, so it is told now either way.
      if (done.ok) tellThen(alert, said, { fact: appliedId(s.sessionId, name), fields: { told_state: 'refused' }, kind: 'outbox_told' });
      else alert(said);
    }
    if (outcome && done.ok) await deliverNote(notes, key);
    else if (outcome && !await tellLead({ ...notes, lead: s.sessionId, product: s.product, text: outcome })) report(`neither the Lead ${s.sessionId} nor the owner could be told, and the outcome could not be saved to try again: ${outcome}`, `lead-note-${shortHash(`${key} ${outcome}`)}`);
  }
  noteLeftOut(notes, leftOut);
  clearGoneSlow(notes, listed, seen);
  clearReadHolds({ rec, alert, now, listed, held, unsettled });
  return out;
}

// holdAlert's once a day, for a tell that goes to the Lead. A note to the Lead is no alert, so its mark is `replied_at`:
// told fields are for what the alert queue delivers. Answers whether this call told it.
async function tellLeadDaily({ rec, replyToLead, alert, report, lead, product, fact, text, now }) {
  const was = rec.read('fact', fact)?.doc;
  const replied = pastTime(was?.replied_at, now);
  if (replied !== null && now - replied < HOLD_REPEAT_MS) return false;
  const cause = `lead-mark-${shortHash(fact)}`;
  const t = await tellDated({ rec, replyToLead, report, lead, fact, was, tried: { ...was, text, replied_at: new Date(now).toISOString() }, text, cause, kind: 'hold_replied' });
  if (!t.saved) return false;
  if (t.heard || alert(ownerText({ lead, product, text, reason: t.reason })) !== false) return true;
  report(`neither the Lead ${lead} nor the owner could be told, so it is tried again in a day: ${text}`, cause);
  return false;
}

// L475: a read-step cause ends when its file is gone or reads cleanly. Only sessions whose outbox was listed this pass
// are looked at, and a file still being written is left, since neither says anything about the file. A first tell
// still in the queue has no fact yet, so the queue is walked too (L347 m1).
function clearReadHolds({ rec, alert, now, listed, held, unsettled }) {
  const report = refusalReport({ rec, alert, now, lines: [] });
  const facts = rec.list('fact');
  for (const sessionId of listed) {
    const holds = readHoldsOf(sessionId);
    const told = facts.filter((f) => f.id.startsWith(holds) && (f.doc?.told_at != null || f.doc?.replied_at != null)).map((f) => f.id);
    for (const id of new Set([...told, ...queuedMarks(rec, holds)])) {
      if (held.has(id) || unsettled.has(id.slice(0, holds.length + 13))) continue;
      clearTold(rec, id, now, report);
    }
  }
}

// Each pass, before any file is looked at: every recorded hand-in left refused or interrupted, with its text, not
// marked told for that state and not already queued, is told again (L130 M7, M8; L138 m3).
function retellHandIns(rec, alert) {
  for (const f of rec.list('fact')) {
    if (!f.doc?.session || !f.doc?.name || f.id !== appliedId(f.doc.session, f.doc.name)) continue;
    const was = f.doc.state;
    if (!['refused', 'interrupted'].includes(was) || !f.doc.alert_text || f.doc.told_state === was) continue;
    if (isQueued(rec, appliedId(f.doc.session, f.doc.name))) continue;
    tellThen(alert, f.doc.alert_text, { fact: appliedId(f.doc.session, f.doc.name), fields: { told_state: was }, kind: 'outbox_told' });
  }
}
