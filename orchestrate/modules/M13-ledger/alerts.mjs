// alerts.mjs — one updated GitHub issue per alert condition, never a new one each pass (review-0b-7 M10;
// design v4 R2/R3 "updates it, rather than opening a new one", M13 card "one updated … issue").
//
// WHY. The watcher runs every minute and the heartbeat every 10. A condition left standing (an unsupported deploy still
// live, a Dispatcher down for an hour) would otherwise open ~60 issues an hour, and that volume can hit GitHub's rate
// limits on the robot's token, the same token the Merge Gate and Approvals use. So each alert has a stable key
// (product, kind, subject); the record keeps its state; a repeat only edits the open issue's body (silent); a comment,
// which notifies, goes out when the condition changes, and again every 24 h while it stands (L315: an open issue is not
// telling the owner again, so this goes through the shared stillWaiting); the issue closes when the condition clears. If
// the owner closes it while the same condition still holds, nothing reopens or comments on it: closing it is their
// answer. That answer covers that cause only (L371): a different status, or the condition coming back after it cleared,
// opens a new issue, so a close never silences a later problem. Who closed it is read from GitHub, not the Record: the
// Record can say "open" over the robot's own close when it refused to save that clear (L393).
//
// Every alert is a robot GitHub issue assigned to the owner (login from private config, passed in). No mail, no
// other channel (design: alerts are only GitHub notices, Actions failure notices or Remote Control pushes).
//
// Injected GitHub client for one product repo (a fake in tests):
//   open({ title, body, assignee }) → number      edit(number, body)      comment(number, text)
//   close(number, text)                           isClosed(number) → boolean
//   closedByOwner(number) → true only when GitHub shows someone other than the robot closed it; can't tell → false
//   findOpen(marker) → the number of an open issue whose body holds marker, null when there is none
//   latestOwnComment(number, since) → the robot's latest comment since that time, as { at, body }, or null
// edit, comment and close answer false when GitHub refused them; open answers the new issue's number, anything else is
// a lost open (L143). findOpen and latestOwnComment answer false when GitHub refused them. A failed findOpen sends
// nothing, because a second issue never goes away. A failed latestOwnComment sends anyway: that read only matters when
// the Record has refused, so a comment too many takes both failing, while holding back would lose real alerts.
//
// A write the Record refuses (L389). The Record remembers what was told, so a refused write would otherwise mean the
// same comment or a new issue on every pass. Two things stop that. raise and clear answer a refusal, { refused: reason },
// and wasTold reads it, so a caller treats it as a lost alert and shows it red. And the limit on what goes out is read
// from GitHub, because the Record is what refused: no second issue for a key, and no second comment for 24 h. A status
// change is limited by what it says, not by the clock: the robot's latest comment naming the same status, under 24 h
// old, means the owner already has it, while a different status still notifies at once.

import { createHash } from 'node:crypto';
import { makeFactWriter, wasSaved } from '../M12-sensors/facts.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';
import { pastTime, STILL_WAITING_MS, stillWaiting } from '../../shared/still-waiting.mjs';

const ISSUE = (n) => Number.isSafeInteger(n) && n > 0;
const idOf = (key) => `alert-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

const keyMark = (id) => `<!-- alert-key ${id} -->`;
const statusMark = (status) => `<!-- alert-status ${createHash('sha256').update(status).digest('hex').slice(0, 16)} -->`;

export function alertKey(product, kind, subject) { return `${product}|${kind}|${subject}`; }

/** Whether raise's answer means the alert is told and saved: not when GitHub lost it (false), nor when the Record refused it. */
export const wasTold = (answer) => answer !== false && !answer?.refused;

export function makeAlerts({ rec, gh, owner, actor = 'ledger', now = () => new Date(), masker = makeMasker(), writer = makeFactWriter(rec, { actor, now, masker }) }) {
  const bodyOf = (s) => `${s.body}\n\n---\nfirst seen ${s.since} · last seen ${s.last} · seen ${s.count} times\n${keyMark(idOf(s.key))}`;
  // The answer `answer`, once the Record holds the write; a refusal with its reason, in plain words, when it does not.
  const saved = (id, doc, answer) => {
    const r = writer.put(id, doc);
    if (wasSaved(r)) return answer;
    return { refused: `the Record refused to save this alert's state: ${masker.maskSecrets(String(r?.reason ?? 'no reason given')).text.slice(0, 200)}` };
  };
  // The robot's latest comment on the issue if it is under 24 h old, otherwise null, also when GitHub refused the read.
  const spokeLately = async (issue, tMs) => {
    const last = await gh.latestOwnComment(issue, new Date(tMs - STILL_WAITING_MS).toISOString());
    return last && tMs - Date.parse(last.at) < STILL_WAITING_MS ? last : null;
  };

  // The condition holds now. Returns what happened: opened | updated | changed | reminded (the 24 h comment) | suppressed
  // (the owner closed it), false when GitHub lost it (L143), or { refused: reason } when the Record refused the write.
  // `status` is the condition's stable state; only a change of it comments (and so notifies). A body that carries a
  // changing figure ("down 40 minutes") is edited silently (0b-7 audit M-3). Without a status, the body is the status.
  // `note` is the comment's text when the status changes (default "Changed: <first line>"); masked like the body.
  // Title and body are masked before they are compared, stored or posted.
  // A GitHub call that throws makes raise throw; one that answers false (or an `open` with no issue number) makes raise
  // answer false. Either way nothing is saved that would stop the next pass trying again: no open alert without an
  // issue (every later pass would read it as closed by the owner), no new status whose comment was lost. A caller that
  // keeps something after a raise (a baseline, a login) keeps it only when wasTold says so.
  async function raise({ key, title: rawTitle, body: rawBody, status: rawStatus, note: rawNote }) {
    const id = idOf(key);
    const title = masker.maskSecrets(rawTitle).text;
    const body = masker.maskSecrets(rawBody).text;
    const status = rawStatus === undefined ? body : masker.maskSecrets(rawStatus).text;
    const t = now().toISOString();
    const s = writer.get(id);
    // An open alert saved without an issue number (before L143) is opened again, not read as closed by the owner.
    const known = s && (s.status === 'closed-by-owner' || (s.status === 'open' && ISSUE(s.issue)));
    const closed = known && (s.status === 'closed-by-owner' || await gh.isClosed(s.issue));
    // The same cause on a closed issue is held back only when the owner closed it. The robot's own close, or one that
    // can't be read, goes on to a new issue: noise, never silence (L393).
    if (closed && status === (s.status_text ?? s.body) && (s.status === 'closed-by-owner' || await gh.closedByOwner(s.issue))) {
      return saved(id, { ...s, kind: 'fact.alert', status: 'closed-by-owner', last: t }, 'suppressed');
    }
    if (known && !closed) {
      const next = { ...s, kind: 'fact.alert', last: t, count: s.count + 1, body, status_text: status };
      if (await gh.edit(s.issue, bodyOf(next)) === false) return false;
      if (status !== (s.status_text ?? s.body)) {
        const note = rawNote === undefined ? `Changed: ${body.split('\n')[0]}` : masker.maskSecrets(rawNote).text;
        const mark = statusMark(status);
        const last = await spokeLately(s.issue, Date.parse(t));
        if (!last?.body?.includes(mark) && await gh.comment(s.issue, `${note}\n\n${mark}`) === false) return false;
        return saved(id, { ...next, told_at: t }, 'changed');
      }
      // Told again every 24 h while it stands (L315). The mark is written only once GitHub took the comment. tell is
      // async, so its answer is awaited here; a throw reaches raise's caller, as every GitHub call's does. An alert
      // saved before told_at is dated from when it opened: opening it told the owner. stillWaiting can't see inside an
      // async tell, so `did` is always 'told' here; only told.answer says what happened.
      const told = stillWaiting({
        now: Date.parse(t), waiting: true, clear: () => {},
        read: () => ({ told_at: s.told_at ?? s.since }),
        tell: async ({ told_at }) => {
          const last = await spokeLately(s.issue, Date.parse(t));
          // GitHub's time, kept only when it is a readable past time: an outside clock never moves told_at ahead.
          const seen = pastTime(last?.at, Date.parse(t));
          if (last) return saved(id, { ...next, told_at: seen === null ? told_at : new Date(seen).toISOString() }, 'updated');
          if (await gh.comment(s.issue, `Still open since ${s.since}: ${body.split('\n')[0]}`) === false) return false;
          return saved(id, { ...next, told_at }, 'reminded');
        },
      });
      if (told.did !== 'quiet') return told.answer;
      return saved(id, next, 'updated');
    }
    const st = { kind: 'fact.alert', key, title, body, status_text: status, status: 'open', since: t, last: t, count: 1, told_at: t };
    // An open issue for this key whose number the Record never kept is used again, never a second one.
    const found = await gh.findOpen(keyMark(id));
    if (found === false) return false;
    if (ISSUE(found)) {
      if (await gh.edit(found, bodyOf(st)) === false) return false;
      return saved(id, { ...st, issue: found }, 'updated');
    }
    const issue = await gh.open({ title, body: bodyOf(st), assignee: owner });
    if (!ISSUE(issue)) return false;
    return saved(id, { ...st, issue }, 'opened');
  }

  // The condition no longer holds. Closes an open issue with a note; re-arms a owner-closed one. Answers false, and
  // keeps the alert open so the next pass closes it, when GitHub answers the close false (L143); { refused: reason } when
  // the Record refused the write. The next clear finds the issue closed and only tries the write again; a raise first
  // finds the robot closed it, so it is not read as the owner's close.
  async function clear({ key, note = 'Cleared: the condition no longer holds.' }) {
    const id = idOf(key);
    const s = writer.get(id);
    if (!s || s.status === 'cleared') return 'none';
    if (s.status === 'open' && ISSUE(s.issue) && !(await gh.isClosed(s.issue)) && await gh.close(s.issue, note) === false) return false;
    return saved(id, { ...s, kind: 'fact.alert', status: 'cleared', cleared: now().toISOString() }, 'cleared');
  }

  function state(key) { return writer.get(idOf(key)); }
  return Object.freeze({ raise, clear, state });
}

// A fake GitHub issue client that records every call but its two reads (tests, and the owner's dry runs). With no `now`
// its comments carry no time, so latestOwnComment finds none; a test of the 24 h limit passes its clock. close is the
// robot's and ownerCloses the owner's, as closedByOwner tells them apart.
export function fakeIssues({ now = null } = {}) {
  const issues = new Map();
  const calls = [];
  const spoken = [];
  const said = (i, body) => { if (now) spoken.push({ i, at: now().toISOString(), body }); };
  let n = 0;
  return {
    calls, issues,
    async open({ title, body, assignee }) { n += 1; issues.set(n, { title, body, assignee, closed: false, comments: [] }); calls.push(['open', n]); return n; },
    async edit(i, body) { issues.get(i).body = body; calls.push(['edit', i]); },
    async comment(i, text) { issues.get(i).comments.push(text); said(i, text); calls.push(['comment', i]); },
    async close(i, text) { const x = issues.get(i); x.closed = true; x.byOwner = false; x.comments.push(text); said(i, text); calls.push(['close', i]); },
    // Strict, as GitHub would be (#98 r1 m2, Principle 10): asking about an issue that was never opened, or about
    // something that is not an issue number, is a caller's bug, so it throws rather than answering "closed".
    async isClosed(i) {
      if (!Number.isSafeInteger(i) || i <= 0) throw new Error(`fakeIssues.isClosed: not an issue number: ${JSON.stringify(i)}`);
      if (!issues.has(i)) throw new Error(`fakeIssues.isClosed: no issue ${i}`);
      return issues.get(i).closed;
    },
    async closedByOwner(i) { return issues.get(i)?.closed === true && issues.get(i).byOwner === true; },
    async findOpen(marker) { for (const [k, x] of issues) if (!x.closed && x.body.includes(marker)) return k; return null; },
    async latestOwnComment(i, since) { return spoken.filter((c) => c.i === i && c.at >= since).at(-1) ?? null; },
    ownerCloses(i) { const x = issues.get(i); x.closed = true; x.byOwner = true; },
  };
}
