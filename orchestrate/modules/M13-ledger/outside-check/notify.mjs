// notify.mjs — one updated issue per failing check, in the outside-check repo itself (this job has no secrets and
// only `issues: write` here; the Mini's 10-minute watch puts the matching robot issue in the product's repo).
//
// Same rules as Bob's M13 alerts.mjs (review-0b-7 M10): a check still failing edits its open issue's body (silent), and
// comments again every 24 h (L315: this issue is what still tells the owner when the host is down); a check that passes again closes its issue with a "cleared" comment and a
// "cleared at <time>" line in the issue's body (the line, not the comment, is what counts; see below); an
// issue the owner closed while the check still failed stays closed until a run sees it pass and fail again. A body
// update that fails after its comment can't mean a comment every run: the bot's own comments are read first (L389), and
// a comment found there is what the told line then says (L393).
// Titles are
// the step names ("product N / <check>"), so no product data appears.
import { fileURLToPath } from 'node:url';

export const BOT = 'github-actions[bot]';
// This file runs alone in the outside-check repo, so it can't import shared/still-waiting.mjs. Same rule, in small: a
// told time that can't be read, or is more than a minute ahead, tells now.
// alerts.test.mjs runs this and the shared rule over one table, so the two can't drift apart.
export const RETELL_MS = 24 * 60 * 60_000;
export const FUTURE_SKEW_MS = 60_000;
export const dueToTell = (told, nowMs) => {
  const t = typeof told === 'string' ? Date.parse(told) : NaN;
  return !Number.isFinite(t) || t > nowMs + FUTURE_SKEW_MS || nowMs - t >= RETELL_MS;
};
const CLEARED = 'Cleared: the check passes again.';
const pastOr = (at, stamp) => (Date.parse(at) <= Date.parse(stamp) + FUTURE_SKEW_MS ? new Date(Date.parse(at)).toISOString() : stamp);
// When the bot last commented, if under 24 h ago, read from GitHub, because the told line is what may have been lost.
// null if not. Only the bot's count: anyone can comment on a public repo. A time ahead of the run reads as the run's own.
async function spokeLately(api, number, nowMs) {
  const since = encodeURIComponent(new Date(nowMs - RETELL_MS).toISOString());
  const comments = await api('GET', `/issues/${number}/comments?since=${since}&per_page=100`);
  const times = comments.filter((c) => c?.user?.login === BOT).map((c) => Date.parse(c.created_at)).filter((t) => nowMs - t < RETELL_MS);
  return times.length ? new Date(Math.min(Math.max(...times), nowMs)).toISOString() : null;
}

export async function notify({ ran, failed, api, now = () => new Date() }) {
  const done = [];
  const all = await api('GET', '/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100');
  const latest = new Map();
  for (const i of all.sort((a, b) => a.number - b.number)) latest.set(i.title, i);
  const stamp = now().toISOString();
  for (const title of ran) {
    // One GitHub error no longer stops the run: the other titles still get their issues, and the job ends red
    // (0b-7 audit round 9 minor 2).
    try { await one(title); } catch { done.push([title, 'error']); }
  }
  return done;

  async function one(title) {
    const i = latest.get(title);
    const failing = failed.includes(title);
    if (failing) {
      if (i && i.state === 'open') {
        // Comment first: the told line goes in only once the comment was taken, so a lost one is sent by the next run.
        // An issue from before the told line is dated from when it opened.
        const due = dueToTell(toldOf(i.body) ?? sinceOf(i.body), Date.parse(stamp));
        // A told time already on GitHub means no comment went out this run, so this run reports `updated`.
        const spoke = due ? await spokeLately(api, i.number, Date.parse(stamp)) : null;
        const sent = due && !spoke ? await api('POST', `/issues/${i.number}/comments`, { body: `Still failing since ${sinceOf(i.body) ?? stamp}.` }) : null;
        // The told line is GitHub's time for the comment, when that is a past time: the next run compares it with GitHub's.
        const told = due ? (spoke ?? pastOr(sent?.created_at, stamp)) : toldOf(i.body);
        await api('PATCH', `/issues/${i.number}`, { body: bodyOf(title, i.body, stamp, told) });
        done.push([title, due && !spoke ? 'reminded' : 'updated']);
        return;
      }
      if (i && i.state === 'closed' && !clearedByBot(i)) { done.push([title, 'suppressed']); return; }
      await api('POST', '/issues', { title, body: bodyOf(title, '', stamp) });
      done.push([title, 'opened']);
    } else if (i && i.state === 'open') {
      await api('POST', `/issues/${i.number}/comments`, { body: CLEARED });
      await api('PATCH', `/issues/${i.number}`, { body: markCleared(i.body, stamp) }); // the marker first, then close
      await api('PATCH', `/issues/${i.number}`, { state: 'closed' });
      done.push([title, 'cleared']);
    } else if (i && i.state === 'closed' && !clearedByBot(i)) {
      // The owner closed it mid-failure and it now passes: mark it cleared so the next failure opens a fresh one.
      await api('POST', `/issues/${i.number}/comments`, { body: CLEARED });
      await api('PATCH', `/issues/${i.number}`, { body: markCleared(i.body, stamp) });
      done.push([title, 're-armed']);
    }
  }
}

// "Cleared" is a line the bot writes into the issue's own body, never read from comments: the repo is public, so anyone
// can comment, and a flood of 100 comments pushed the bot's "cleared" comment off the first page, which suppressed
// every later failure (0b-7 audit round 8 M-1). Only the bot (and the owner) can edit the body of the bot's issue.
const CLEARED_LINE = /^cleared at \S+$/m;
const clearedByBot = (issue) => CLEARED_LINE.test(issue.body ?? '');
const markCleared = (body, stamp) => `${String(body ?? '').replace(/\n*^cleared at \S+$/m, '')}\ncleared at ${stamp}`;

const sinceOf = (body) => /^failing since (\S+)$/m.exec(body ?? '')?.[1] ?? null;
const toldOf = (body) => /^last told (\S+)$/m.exec(body ?? '')?.[1] ?? null;

function bodyOf(title, old, stamp, told = stamp) {
  const since = sinceOf(old) ?? stamp;
  return `The outside check's step "${title}" is failing. Open the latest outside-check run for its reason code.\n\nfailing since ${since}\nlast seen ${stamp}\nlast told ${told ?? since}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`notify: http ${r.status}`);
    return r.json();
  };
  const split = (s) => (s ?? '').split(',').filter(Boolean);
  const done = await notify({ ran: split(process.env.RAN), failed: split(process.env.FAILED), api });
  for (const [t, what] of done) console.log(`${t}: ${what}`);
  if (done.some(([, what]) => what === 'error')) process.exitCode = 1;
}
