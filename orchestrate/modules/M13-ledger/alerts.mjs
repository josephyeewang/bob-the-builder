// alerts.mjs — one updated GitHub issue per alert condition, never a new one each pass (review-0b-7 M10;
// design v4 R2/R3 "updates it, rather than opening a new one", M13 card "one updated … issue").
//
// WHY. The watcher runs every minute and the heartbeat every 10. A condition left standing (an unsupported deploy still
// live, a Dispatcher down for an hour) would otherwise open ~60 issues an hour, and that volume can hit GitHub's rate
// limits on the robot's token, the same token the Merge Gate and Approvals use. So each alert has a stable key
// (product, kind, subject); the record keeps its state; a repeat only edits the open issue's body (silent); a comment,
// which notifies, goes out only when the condition changes; the issue closes when the condition clears. If Joe closes
// it while the condition still holds, nothing reopens it until the condition has cleared and come back.
//
// Every alert is a robot GitHub issue assigned to the owner (login from private config, passed in). No mail, no
// other channel (design: alerts are only GitHub notices, Actions failure notices or Remote Control pushes).
//
// Injected GitHub client for one product repo (a fake in tests):
//   open({ title, body, assignee }) → number      edit(number, body)      comment(number, text)
//   close(number, text)                           isClosed(number) → boolean

import { createHash } from 'node:crypto';
import { makeFactWriter } from '../M12-sensors/facts.mjs';

const idOf = (key) => `alert-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

export function alertKey(product, kind, subject) { return `${product}|${kind}|${subject}`; }

export function makeAlerts({ rec, gh, owner, actor = 'ledger', now = () => new Date(), writer = makeFactWriter(rec, { actor, now }) }) {
  const bodyOf = (s) => `${s.body}\n\n---\nfirst seen ${s.since} · last seen ${s.last} · seen ${s.count} times\n<!-- alert-key ${idOf(s.key)} -->`;

  // The condition holds now. Returns what happened: opened | updated | changed | suppressed (Joe closed it).
  async function raise({ key, title, body }) {
    const id = idOf(key);
    const t = now().toISOString();
    const s = writer.get(id);
    if (s && (s.status === 'open' || s.status === 'closed-by-owner')) {
      if (s.status === 'open' && await gh.isClosed(s.issue)) {
        writer.put(id, { ...s, kind: 'fact.alert', status: 'closed-by-owner', last: t });
        return 'suppressed';
      }
      if (s.status === 'closed-by-owner') { writer.put(id, { ...s, kind: 'fact.alert', last: t }); return 'suppressed'; }
      const next = { ...s, kind: 'fact.alert', last: t, count: s.count + 1, body };
      await gh.edit(s.issue, bodyOf(next));
      if (body !== s.body) { await gh.comment(s.issue, `Changed: ${body.split('\n')[0]}`); writer.put(id, next); return 'changed'; }
      writer.put(id, next);
      return 'updated';
    }
    const st = { kind: 'fact.alert', key, title, body, status: 'open', since: t, last: t, count: 1 };
    st.issue = await gh.open({ title, body: bodyOf(st), assignee: owner });
    writer.put(id, st);
    return 'opened';
  }

  // The condition no longer holds. Closes an open issue with a note; re-arms a Joe-closed one.
  async function clear({ key, note = 'Cleared: the condition no longer holds.' }) {
    const id = idOf(key);
    const s = writer.get(id);
    if (!s || s.status === 'cleared') return 'none';
    if (s.status === 'open' && !(await gh.isClosed(s.issue))) await gh.close(s.issue, note);
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
