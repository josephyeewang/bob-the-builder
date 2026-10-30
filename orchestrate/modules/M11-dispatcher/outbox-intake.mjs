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
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';

export const READONLY_REQUESTS = Object.freeze({ think: 'reviewer', scout: 'scout', write: 'writer' });
export const SETTLE_MS = 2000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const appliedId = (sessionId, name) => `outbox-${sessionId}-${name}`;
const statOf = (p) => { try { const s = lstatSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };

/** The kinds a session may hand in: its role's, except a read-only request session hands back report-. */
export function kindsFor(entry) {
  if (entry.request) return ['report'];
  return [...(DESIGN_PROFILES[entry.role]?.outbox ?? [])];
}

/**
 * `sessions`: the Dispatcher's session map, [{ sessionId, role, outbox, uid, card, product, request? }].
 * `wait(ms)`: a sleep (tests pass a fake that moves the fake clock). `alert(text)` reaches Joe.
 * `startReadonly({ lead, profile, kind, brief, product })` asks the pass to start a read-only session.
 * `replyToLead({ lead, text })` leaves a report- note for the Lead. `note(text)` writes a diary line.
 * Returns what happened to each file.
 */
export async function intakePass({ rec, sessions, wait, alert, note, startReadonly, replyToLead,
  list = (d) => readdirSync(d), look = statOf, read = readOutboxFile }) {
  const out = [];
  const seen = [];
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
      const m = OUTBOX_NAME.exec(name);
      note(`outbox file ${name} from ${s.role} ${s.sessionId} refused: ${file.reason}`);
      if (s.role === 'lead' && m && !kinds.includes(m[1])) {
        replyToLead({ lead: s.sessionId, text: `Your file ${name} was not used: "${m[1]}" is not a kind you can hand in (${kinds.join(', ')}).` });
      } else alert(`an outbox file from ${s.role} ${s.sessionId} was refused: ${file.reason}`);
      continue;
    }
    const hash = sha256(file.text);
    const key = appliedId(s.sessionId, name);
    const prev = rec.read('fact', key);
    if (prev) {
      if (prev.doc.sha256 === hash) { r.already = true; continue; }
      r.refused = 'the same name with new content';
      alert(`${s.role} ${s.sessionId} handed in ${name} again with different content; the second copy was not used`);
      continue;
    }
    // Claim the key first, so a crash after the apply cannot apply the file a second time.
    const claim = rec.write({ actor: 'dispatcher', entity: 'fact', id: key, expectRev: 0, doc: { session: s.sessionId, name, sha256: hash, state: 'applying' }, kind: 'outbox_claim' });
    if (!claim.ok) { r.refused = `could not record the hand-in: ${claim.reason}`; continue; }
    if (s.role === 'lead' && Object.hasOwn(READONLY_REQUESTS, file.kind)) {
      r.request = startReadonly({ lead: s.sessionId, profile: READONLY_REQUESTS[file.kind], kind: file.kind, brief: file.text, product: s.product });
    }
    const applied = rec.applyOutbox({ role: s.role, sessionId: s.sessionId, card: s.card }, path);
    r.applied = applied.ok;
    if (!applied.ok) { r.refused = applied.reason; alert(`the record refused ${name} from ${s.role} ${s.sessionId}: ${applied.reason}`); }
    rec.write({ actor: 'dispatcher', entity: 'fact', id: key, expectRev: claim.rev, doc: { session: s.sessionId, name, sha256: hash, state: applied.ok ? 'applied' : 'refused' }, kind: 'outbox_applied' });
  }
  return out;
}
