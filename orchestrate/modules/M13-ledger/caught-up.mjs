// caught-up.mjs — the phone's GitHub fallbacks while the Mini is down, and one "caught up" push when it is back
// (R-0b-76; design v4 §7.2 R3; review-0b-7 M11, M12 and minors).
//
// While the Mini is down the owner still has GitHub on the phone: an idea is an issue with the `idea` label, an Approve is
// the normal Approve on the PR (M2 reads it), and status is the heartbeat issue. This file runs on every Dispatcher pass
// and does two things:
//   1. idea intake: each open `idea` issue written by the OWNER (matched by numeric user ID, never by login, which can
//      be renamed and reused) becomes an idea fact once (`idea-issue-<n>`), its title and body masked and fenced as
//      outside text. An idea issue from any other account is ignored and counted, never filed.
//   2. caught up: when this pass comes more than 15 minutes after the last good Dispatcher pass (a "return"), one
//      push request listing what happened while down: ideas filed, approvals now merging, and approvals that EXPIRED
//      and need a fresh Approve. Idempotent: one return → one push, however many passes see it.
// Expiry is never computed here: it is M2's (R-0b-51; the 24 h runs from the ask's raised_at). This reads M2's ask
// `state` ('expired', or 'answered' = approved and waiting for the Mini) and lists; nothing here merges.

import { createHash } from 'node:crypto';
import { cleanOutside } from '../M12-sensors/escape.mjs';

export const RETURN_GAP_MIN = 15;

// gh.listIdeaIssues() → [{ number, title, body, user: { id, login } }] (open issues labelled `idea`, product repo).
export async function intakeIdeas({ gh, writer, ownerId }) {
  const owner = Number(ownerId);
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('intakeIdeas needs the owner\'s numeric GitHub user ID');
  const filed = []; let ignored = 0;
  for (const i of await gh.listIdeaIssues()) {
    if (Number(i.user?.id) !== owner) { ignored += 1; continue; }
    const id = `idea-issue-${i.number}`;
    if (writer.get(id)) continue;
    writer.put(id, { kind: 'fact.idea-issue', number: i.number, state: 'inbox',
      title: cleanOutside(i.title ?? '', 'issue-title'), body: cleanOutside(i.body ?? '', 'idea-issue') });
    filed.push(i.number);
  }
  return { filed, ignored };
}

// lastGoodPass: ISO time of the Dispatcher's previous good pass (read before this pass records its own).
export async function caughtUpOnce({ rec, gh, writer, ownerId, product, lastGoodPass, now = () => new Date() }) {
  const intake = await intakeIdeas({ gh, writer, ownerId });
  const gapMin = lastGoodPass ? (now() - Date.parse(lastGoodPass)) / 60e3 : 0;
  if (!(gapMin > RETURN_GAP_MIN)) return { returned: false, ...intake };

  const downSince = lastGoodPass;
  // Only asks that reached their state while the Mini was down, judged by the record's diary (the time the record
  // itself stamped), so an ask that expired weeks ago is not listed again on every return (0b-7 audit M-7).
  const reached = new Map();
  for (const l of rec.diary({ since: 0 })) if (l.entity === 'ask' && l.to_state) reached.set(l.id, { state: l.to_state, ts: l.ts });
  const whileDown = (a) => reached.get(a.id)?.state === a.state && Date.parse(reached.get(a.id).ts) >= Date.parse(downSince);
  const asks = rec.list('ask').map((a) => ({ id: a.id, ...a.doc }));
  const expired = asks.filter((a) => a.state === 'expired' && whileDown(a));
  const waiting = asks.filter((a) => a.state === 'answered' && whileDown(a));
  const ideasWhileDown = rec.list('fact').filter((f) => f.doc.kind === 'fact.idea-issue' && Date.parse(f.doc.ts) >= Date.parse(downSince)).length;

  const idem = createHash('sha256').update(`caught-up|${product}|${downSince}`).digest('hex').slice(0, 16);
  const pid = `push-request-${idem}`;
  if (writer.get(pid)) return { returned: true, pushed: false, ...intake };
  const hours = Math.round(gapMin / 6) / 10;
  const lines = [`Caught up after ${hours} h without the Mini (${product}).`,
    `Ideas filed from GitHub: ${ideasWhileDown}.`,
    `Approvals now going ahead: ${waiting.length}${waiting.length ? ` (${waiting.map((a) => a.pr ? `PR ${a.pr}` : a.id).join(', ')})` : ''}.`];
  if (expired.length) lines.push(`Expired, need a fresh Approve: ${expired.map((a) => a.pr ? `PR ${a.pr}` : a.id).join(', ')}. Nothing merged on them.`);
  writer.put(pid, { kind: 'fact.push-request', idempotency_key: idem, state: 'requested', product, text: lines.join('\n') });
  return { returned: true, pushed: true, expired: expired.map((a) => a.id), ...intake };
}
