// notify.mjs — one updated issue per failing check, in the outside-check repo itself (this job has no secrets and
// only `issues: write` here; the Mini's 10-minute watch puts the matching robot issue in the product's repo).
//
// Same rules as Bob's M13 alerts.mjs (review-0b-7 M10): a check still failing edits its open issue's body (silent; the
// owner is notified once, when it opens); a check that passes again closes its issue with a "cleared" comment; an
// issue the owner closed while the check still failed stays closed until a run sees it pass and fail again. Titles are
// the step names ("product N / <check>"), so no product data appears.
import { fileURLToPath } from 'node:url';

export const BOT = 'github-actions[bot]';
const CLEARED = 'Cleared: the check passes again.';

export async function notify({ ran, failed, api, now = () => new Date() }) {
  const done = [];
  const all = await api('GET', '/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100');
  const latest = new Map();
  for (const i of all.sort((a, b) => a.number - b.number)) latest.set(i.title, i);
  const stamp = now().toISOString();
  for (const title of ran) {
    const i = latest.get(title);
    const failing = failed.includes(title);
    if (failing) {
      if (i && i.state === 'open') { await api('PATCH', `/issues/${i.number}`, { body: bodyOf(title, i.body, stamp) }); done.push([title, 'updated']); continue; }
      if (i && i.state === 'closed' && !clearedByBot(i)) { done.push([title, 'suppressed']); continue; }
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
  return done;
}

// "Cleared" is a line the bot writes into the issue's own body, never read from comments: the repo is public, so anyone
// can comment, and a flood of 100 comments pushed the bot's "cleared" comment off the first page, which suppressed
// every later failure (0b-7 audit round 8 M-1). Only the bot (and the owner) can edit the body of the bot's issue.
const CLEARED_LINE = /^cleared at \S+$/m;
const clearedByBot = (issue) => CLEARED_LINE.test(issue.body ?? '');
const markCleared = (body, stamp) => `${String(body ?? '').replace(/\n*^cleared at \S+$/m, '')}\ncleared at ${stamp}`;

function bodyOf(title, old, stamp) {
  const since = /^failing since (\S+)$/m.exec(old ?? '')?.[1] ?? stamp;
  return `The outside check's step "${title}" is failing. Open the latest outside-check run for its reason code.\n\nfailing since ${since}\nlast seen ${stamp}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`notify: http ${r.status}`);
    return r.json();
  };
  const split = (s) => (s ?? '').split(',').filter(Boolean);
  for (const [t, what] of await notify({ ran: split(process.env.RAN), failed: split(process.env.FAILED), api })) console.log(`${t}: ${what}`);
}
