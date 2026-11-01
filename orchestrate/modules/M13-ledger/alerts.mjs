// alerts.mjs — one updated GitHub issue per alert condition, never a new one each pass (review-0b-7 M10;
// design v4 R2/R3 "updates it, rather than opening a new one", M13 card "one updated … issue").
//
// WHY. The watcher runs every minute and the heartbeat every 10. A condition left standing (an unsupported deploy still
// live, a Dispatcher down for an hour) would otherwise open ~60 issues an hour, and that volume can hit GitHub's rate
// limits on the robot's token, the same token the Merge Gate and Approvals use. So each alert has a stable key
// (product, kind, subject); the record keeps its state; a repeat only edits the open issue's body (silent); a comment,
// which notifies, goes out only when the condition changes; the issue closes when the condition clears. If the owner closes
// it while the condition still holds, nothing reopens it until the condition has cleared and come back.
//
// Every alert is a robot GitHub issue assigned to the owner (login from private config, passed in). No mail, no
// other channel (design: alerts are only GitHub notices, Actions failure notices or Remote Control pushes).
//
// Injected GitHub client for one product repo (a fake in tests):
//   open({ title, body, assignee }) → number      edit(number, body)      comment(number, text)
//   close(number, text)                           isClosed(number) → boolean
// edit, comment and close answer false when GitHub refused them; open answers the new issue's number, anything else is
// a lost open (L143).

import { createHash } from 'node:crypto';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';

const ISSUE = (n) => Number.isSafeInteger(n) && n > 0;
const idOf = (key) => `alert-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

export function alertKey(product, kind, subject) { return `${product}|${kind}|${subject}`; }

export function makeAlerts({ rec, gh, owner, actor = 'ledger', now = () => new Date(), masker = makeMasker(), writer = makeFactWriter(rec, { actor, now, masker }) }) {
  const bodyOf = (s) => `${s.body}\n\n---\nfirst seen ${s.since} · last seen ${s.last} · seen ${s.count} times\n<!-- alert-key ${idOf(s.key)} -->`;

  // The condition holds now. Returns what happened: opened | updated | changed | suppressed (the owner closed it), or
  // false when GitHub lost it (L143).
  // `status` is the condition's stable state; only a change of it comments (and so notifies). A body that carries a
  // changing figure ("down 40 minutes") is edited silently (0b-7 audit M-3). Without a status, the body is the status.
  // Title and body are masked before they are compared, stored or posted.
  // A GitHub call that throws makes raise throw; one that answers false (or an `open` with no issue number) makes raise
  // answer false. Either way nothing is saved that would stop the next pass trying again: no open alert without an
  // issue (every later pass would read it as closed by the owner), no new status whose comment was lost. A caller that
  // keeps something after a raise (a baseline, a login) keeps it only when raise did not answer false.
  async function raise({ key, title: rawTitle, body: rawBody, status: rawStatus }) {
    const id = idOf(key);
    const title = masker.maskSecrets(rawTitle).text;
    const body = masker.maskSecrets(rawBody).text;
    const status = rawStatus === undefined ? body : masker.maskSecrets(rawStatus).text;
    const t = now().toISOString();
    const s = writer.get(id);
    // An open alert saved without an issue number (before L143) is opened again, not read as closed by the owner.
    const known = s && (s.status === 'closed-by-owner' || (s.status === 'open' && ISSUE(s.issue)));
    if (known) {
      if (s.status === 'open' && await gh.isClosed(s.issue)) {
        writer.put(id, { ...s, kind: 'fact.alert', status: 'closed-by-owner', last: t });
        return 'suppressed';
      }
      if (s.status === 'closed-by-owner') { writer.put(id, { ...s, kind: 'fact.alert', last: t }); return 'suppressed'; }
      const next = { ...s, kind: 'fact.alert', last: t, count: s.count + 1, body, status_text: status };
      if (await gh.edit(s.issue, bodyOf(next)) === false) return false;
      if (status !== (s.status_text ?? s.body)) {
        if (await gh.comment(s.issue, `Changed: ${body.split('\n')[0]}`) === false) return false;
        writer.put(id, next);
        return 'changed';
      }
      writer.put(id, next);
      return 'updated';
    }
    const st = { kind: 'fact.alert', key, title, body, status_text: status, status: 'open', since: t, last: t, count: 1 };
    const issue = await gh.open({ title, body: bodyOf(st), assignee: owner });
    if (!ISSUE(issue)) return false;
    writer.put(id, { ...st, issue });
    return 'opened';
  }

  // The condition no longer holds. Closes an open issue with a note; re-arms a owner-closed one. Answers false, and
  // keeps the alert open so the next pass closes it, when GitHub answers the close false (L143).
  async function clear({ key, note = 'Cleared: the condition no longer holds.' }) {
    const id = idOf(key);
    const s = writer.get(id);
    if (!s || s.status === 'cleared') return 'none';
    if (s.status === 'open' && ISSUE(s.issue) && !(await gh.isClosed(s.issue)) && await gh.close(s.issue, note) === false) return false;
    writer.put(id, { ...s, kind: 'fact.alert', status: 'cleared', cleared: now().toISOString() });
    return 'cleared';
  }

  function state(key) { return writer.get(idOf(key)); }
  return Object.freeze({ raise, clear, state });
}

// A fake GitHub issue client that records every call (tests, and the owner's dry runs).
export function fakeIssues() {
  const issues = new Map();
  const calls = [];
  let n = 0;
  return {
    calls, issues,
    async open({ title, body, assignee }) { n += 1; issues.set(n, { title, body, assignee, closed: false, comments: [] }); calls.push(['open', n]); return n; },
    async edit(i, body) { issues.get(i).body = body; calls.push(['edit', i]); },
    async comment(i, text) { issues.get(i).comments.push(text); calls.push(['comment', i]); },
    async close(i, text) { const x = issues.get(i); x.closed = true; x.comments.push(text); calls.push(['close', i]); },
    async isClosed(i) { return issues.get(i)?.closed ?? true; },
    ownerCloses(i) { issues.get(i).closed = true; },
  };
}
