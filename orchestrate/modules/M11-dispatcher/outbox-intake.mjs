// Outbox intake (R-0b-56, R-0b-58; design v4 rail A2, §6.1 item 3, §14.1.2; review 0b-6 M15, M20, m1).
//
// AI sessions never write the record. Each writes plain files into its own outbox; each pass the
// Dispatcher hands them to `rec.applyOutbox()` tagged with the role from ITS OWN session map
// (outbox folder -> session -> role), never from anything inside the file. A file is applied once,
// keyed by session id, file name and sha256, and that key is kept in the record so a restarted
// Dispatcher does not apply it again. The same name with new content is refused with an alert.
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
import { tellThen, isQueued } from './alerts.mjs';
import { OUTBOX_KINDS } from '../../shared/record.mjs';

export const READONLY_REQUESTS = Object.freeze({ think: 'reviewer', scout: 'scout', write: 'writer' });
export const SETTLE_MS = 2000;

// L140: a kind whose only job is to start something has no record rule, so the Record has nothing to take from it
// (the real one answers "no record rule yet"). Once its read-only session starts, the hand-in is done: it is marked
// applied here, with no applyOutbox call and no alert. Lane 1's table marks such kinds `record: 'none'`; until then a
// read-only request kind with no entity is the same thing.
export const startsOnly = (kind) => {
  const spec = OUTBOX_KINDS[`${kind}-`];
  return Boolean(spec) && (spec.record === 'none' || (!spec.entity && Object.hasOwn(READONLY_REQUESTS, kind)));
};
// The answer applyOutbox gives a `record: 'none'` kind (L140): handled, not refused.
const notARecord = (applied) => applied?.not_a_record === true || applied?.outcome === 'not_a_record';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const appliedId = (sessionId, name) => `intake-applied-${sessionId}-${name}`;
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
 * `replyToLead({ lead, text })` leaves a report- note for the Lead. `note(text)` writes a diary line.
 * `vet({ session, kind, text })` may refuse a file before it is used (null = fine); a vetted-out file
 * is not marked as used, so the session can write it again under the same name (an oversize handoff).
 * Returns what happened to each file.
 */
export async function intakePass({ rec, sessions, wait, alert, note, startReadonly, replyToLead, now = Date.now(),
  list = (d) => readdirSync(d), look = statOf, read = readOutboxFile, vet = () => null }) {
  const out = [];
  const seen = [];
  // L138 m3: a refused or interrupted hand-in is told until a copy is delivered, from its recorded fact, whether or
  // not its file is still in the outbox (a file removed before the tell went out is still told).
  retellHandIns(rec, alert);
  for (const s of sessions) {
    let names;
    try { names = list(s.outbox).filter((n) => !n.startsWith('.')); } catch { out.push({ session: s.sessionId, skipped: 'outbox unreadable' }); continue; }
    for (const name of names) seen.push({ s, name, first: look(join(s.outbox, name)) });
  }
  if (seen.length) await wait(SETTLE_MS);
  for (const { s, name, first } of seen) {
    const path = join(s.outbox, name);
    const r = { session: s.sessionId, name };
    out.push(r);
    if (first === null || look(path) !== first) { r.waiting = 'still being written'; continue; }
    const kinds = kindsFor(s);
    const file = read(s.outbox, name, { kinds, uid: s.uid });
    if (!file.ok) {
      r.refused = file.reason;
      const k = OUTBOX_NAME.test(name) ? outboxKindOf(name) : null;
      note(`outbox file ${name} from ${s.role} ${s.sessionId} refused: ${file.reason}`);
      if (s.role === 'lead' && OUTBOX_NAME.test(name) && !kinds.includes(k)) {
        replyToLead({ lead: s.sessionId, text: `Your file ${name} was not used: it is not a kind you can hand in (${kinds.join(', ')}).` });
      } else alert(`an outbox file from ${s.role} ${s.sessionId} was refused: ${file.reason}`);
      continue;
    }
    const hash = sha256(file.text);
    const key = appliedId(s.sessionId, name);
    let prev = rec.read('fact', key);
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
      const what = prev.doc.state === 'starting' ? 'its read-only session may or may not have started, and was not started again' : 'it may or may not have reached the record, and was not applied again';
      // Told until delivered (L130 M7): the text is kept on the fact, and a pass that sees it untold asks again.
      const said = `the hand-in of ${name} from ${s.role} ${s.sessionId} was interrupted; ${what}`;
      const w = put({ ...prev.doc, sha256: prev.doc.sha256, state: 'interrupted', at: new Date(now).toISOString(), alert_text: said }, 'outbox_interrupted');
      if (w.ok) tellThen(alert, said, { fact: appliedId(s.sessionId, name), fields: { told_state: 'interrupted' }, kind: 'outbox_told' });
    }
    if (prev) {
      const was = prev.doc.state;
      if (prev.doc.sha256 === hash && was !== 'waiting') { r.already = true; continue; }
      // A file that was never used (refused or interrupted) may be handed in again with new content.
      if (prev.doc.sha256 !== hash && !['refused', 'interrupted'].includes(was)) {
        r.refused = 'the same name with new content';
        alert(`${s.role} ${s.sessionId} handed in ${name} again with different content; the second copy was not used`);
        continue;
      }
    }
    let why;
    try { why = vet({ session: s, kind: file.kind, text: file.text }); } catch (e) { why = `could not be checked: ${e.message}`; } // audit MIN-12
    if (why) { r.refused = why; note(`outbox file ${name} from ${s.role} ${s.sessionId} not used yet: ${why}`); continue; }
    // A Lead's read-only request starts its session first. Refused (at the cap, in red) -> the file waits
    // and is tried again next pass (audit MAT-6); the Lead is told once that it is queued.
    const word = file.kind.slice(0, -1);   // the request's word: think-, scout-, write- -> think, scout, write
    if (s.role === 'lead' && Object.hasOwn(READONLY_REQUESTS, word)) {
      // Claim first (audit 0b-6 r2 MIN-7): a crash between the start and the claim must not start a second helper.
      const claimStart = put({ state: 'starting', tries: prev?.doc?.tries ?? 0 }, 'outbox_starting');
      if (!claimStart.ok) { r.refused = `could not record the start: ${claimStart.reason}`; continue; }
      let started;
      try { started = await startReadonly({ lead: s.sessionId, profile: READONLY_REQUESTS[word], kind: word, brief: file.text, product: s.product }); }
      catch (e) { started = { ok: false, reason: `the start failed: ${e.message}` }; }
      r.request = started;
      if (!started?.ok) {
        const reason = started?.reason ?? 'no answer';
        const told = (prev?.doc?.tries ?? 0) > 0;
        put({ state: 'waiting', reason, tries: (prev?.doc?.tries ?? 0) + 1 }, 'outbox_waiting');
        if (!told) replyToLead({ lead: s.sessionId, text: `Your ${word} request ${name} is queued: ${reason}. It starts by itself when it can.` });
        r.waiting = reason;
        continue;
      }
      // L140: the session started, and that was the hand-in's whole job.
      if (startsOnly(file.kind)) {
        put({ state: 'applied', started: true, applied_at: new Date(now).toISOString() }, 'outbox_applied');
        r.applied = true;
        r.started = true;
        continue;
      }
    }
    // Claim the key first, so a crash after the apply cannot apply the file a second time.
    const claim = put({ state: 'applying' }, 'outbox_claim');
    if (!claim.ok) { r.refused = `could not record the hand-in: ${claim.reason}`; continue; }
    let applied;
    try { applied = rec.applyOutbox({ role: s.role, sessionId: s.sessionId, card: s.card }, path); }
    catch (e) { applied = { ok: false, reason: e.message }; }
    // L140: a kind with no record rule is handled, not refused, so it is no alert.
    if (notARecord(applied)) applied = { ok: true, not_a_record: true };
    r.applied = applied.ok;
    // applied_at lets the Lead restart tell a hand-off written after WRAP from an older one (audit 0b-6 r2 MAT-3).
    // A refusal is recorded with its text first, then told until delivered (L130 M8).
    const said = applied.ok ? null : `the record refused ${name} from ${s.role} ${s.sessionId}: ${applied.reason}`;
    const done = put({ state: applied.ok ? 'applied' : 'refused', applied_at: new Date(now).toISOString(), ...(said ? { alert_text: said } : {}) }, 'outbox_applied');
    if (!applied.ok) {
      r.refused = applied.reason;
      // A refusal the record would not keep has no fact to re-ask from, so it is told now either way.
      if (done.ok) tellThen(alert, said, { fact: appliedId(s.sessionId, name), fields: { told_state: 'refused' }, kind: 'outbox_told' });
      else alert(said);
    }
  }
  return out;
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
