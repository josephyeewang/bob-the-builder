// pr-writer.mjs — the pull request writer the push script asks for (M4 push.mjs `pullRequests.upsert`; lane N, N1;
// LEAD-CALLS L1079 Q3, L1082 Q6). A pushed card branch with no pull request is work Joe never hears of: GitHub tells
// him of a pull request, not of a branch.
//
//   prWriter({ record, fetchFn?, now?, mask?, timeoutMs? }) → { upsert, retryPending }
//     upsert({ repo, branch, base, title, body, token }) → { number, url } | null       (push.mjs's port; never throws)
//     retryPending({ getToken, repos, every }) → { opened: [branch], waiting: [[branch, reason, since]], unreadable: [id] }
//       a pending one tried less than `every` ago (its `at`, by pastTime, I4) waits, still listed so it stays told
//
// UPSERT. Safe to repeat: an open pull request already there for `<owner>:<branch>` counts as done, and is left as it
// is (Joe may have edited it). Otherwise one is opened from the branch into `base`. GitHub's 422 for "one already
// exists" (a race with a run before) is answered by looking again. Title and body are masked first (M4 README m2: the
// card's words could hold something secret-shaped) and cut to GitHub's sizes.
//
// PENDING (L1082 Q6). push.mjs turns a failed upsert into `pr: null`, still records the push, and the bundle then
// reads as taken, so nothing would ask again. So a failed upsert writes the fact PR_FACT(branch) =
// { state: 'pending', repo, branch, base, title, body, since, tries, last_reason, at }: masked text and names only,
// NEVER a token (condition 1). The push pass calls retryPending each round it runs (its own RETRY_MS spacing) with the
// round's robot token; each pending one is upserted again, and on success marked { state: 'opened', number, url }. A
// success through upsert marks it opened too. The pass keeps Joe told until then (holdAlert's still-waiting cadence).
// The fact is the Workshop's (actor `workshop`, M9 family `push.`), as push.mjs's own push facts are: no new actor, no
// new permission. Its id has three dots where PUSH_FACT has two (card and attempt hold none), so it can't be taken for one.
// Endpoint shapes from GitHub's REST docs (pulls list/create), 13 Nov 2026 (Principle 9).

import { makeMasker } from '../modules/M12-sensors/mask.mjs';
import { pastTime } from '../shared/still-waiting.mjs';

export const PR_FACT_PREFIX = 'push.pr-open.';
export const PR_FACT = (branch) => `${PR_FACT_PREFIX}${String(branch).replace(/[^a-z0-9-]/g, '-')}.pending`;
const REPO = /^([A-Za-z0-9-]{1,39})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[a-z0-9][a-z0-9/_-]{0,120}$/;
const TITLE_MAX = 256;
const BODY_MAX = 60_000;
const short = (s) => String(s ?? '').slice(0, 300);

export function prWriter({ record, fetchFn = globalThis.fetch, now = () => Date.now(), mask, timeoutMs = 15_000 }) {
  // A mask that is not a function would only fail at the first write, after the push (#536 r1 m6): refused when built.
  if (mask !== undefined && mask !== null && typeof mask !== 'function') throw new Error('prWriter: mask must be a function');
  const masker = mask ?? ((s) => makeMasker().maskSecrets(s).text);
  const clean = (s, max) => masker(String(s ?? '')).slice(0, max);

  async function call(token, method, path, body) {
    const res = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  const prOf = (p) => (Number.isSafeInteger(p?.number) && p.number > 0 ? { number: p.number, url: typeof p.html_url === 'string' ? p.html_url : null } : null);

  async function findOpen(token, repo, owner, branch) {
    const r = await call(token, 'GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub answered ${r.status} when asked for the branch's pull request`);
    return r.json.map(prOf).find(Boolean) ?? null;
  }

  // → { number, url }, or throws the reason.
  async function open({ repo, branch, base, title, body, token }) {
    const m = REPO.exec(String(repo));
    if (!m) throw new Error('no repo to open the pull request in');
    if (!BRANCH.test(String(branch)) || !BRANCH.test(String(base))) throw new Error('the branch or its base is not a branch name');
    if (typeof token !== 'string' || !token) throw new Error('no robot token');
    const there = await findOpen(token, repo, m[1], branch);
    if (there) return there;
    const r = await call(token, 'POST', `/repos/${repo}/pulls`, { title: clean(title, TITLE_MAX) || branch, head: branch, base, body: clean(body, BODY_MAX), maintainer_can_modify: false });
    if (r.status === 201 && prOf(r.json)) return prOf(r.json);
    if (r.status === 422) {
      const again = await findOpen(token, repo, m[1], branch);
      if (again) return again;
    }
    throw new Error(`GitHub answered ${r.status} when the pull request was opened`);
  }

  function mark(branch, doc) {
    const id = PR_FACT(branch);
    const cur = record.read('fact', id);
    if (cur?.corrupt) throw new Error(`the pull request record ${id} can't be read`);
    if (doc.state === 'opened' && !cur) return true;
    const w = record.write({ actor: 'workshop', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc: { ...(cur?.doc ?? {}), ...doc }, kind: doc.state === 'opened' ? 'pr_opened' : 'pr_pending' });
    return w?.ok !== false;
  }

  async function upsert(args) {
    const at = new Date(now()).toISOString();
    try {
      const pr = await open(args);
      try { mark(args.branch, { state: 'opened', number: pr.number, url: pr.url, at }); } catch { /* opened is what counts; the pending one is asked again and found */ }
      return pr;
    } catch (e) {
      try {
        const cur = record.read('fact', PR_FACT(args?.branch))?.doc;
        const since = cur?.state === 'pending' && typeof cur.since === 'string' ? cur.since : at;
        mark(args?.branch, { state: 'pending', repo: String(args?.repo ?? ''), branch: String(args?.branch ?? ''), base: String(args?.base ?? ''),
          title: clean(args?.title, TITLE_MAX), body: clean(args?.body, BODY_MAX), since, tries: (cur?.state === 'pending' ? cur.tries ?? 0 : 0) + 1, last_reason: short(masker(String(e?.message ?? e))), at });
      } catch { /* the push pass still tells "no pull request" for this round's answer */ }
      return null;
    }
  }

  // getToken: () → Promise<token string>, asked only when a pending one is due, at most once a call (no mint for nothing).
  async function retryPending({ getToken, repos, every = 0 }) {
    const out = { opened: [], waiting: [], unreadable: [] };
    if (!Array.isArray(repos) || repos.length === 0) throw new Error('the pull request retry names no repo');
    const all = record.list('fact');
    if (!Array.isArray(all)) throw new Error('the Record\'s facts could not be read');
    let tok;
    const token = async () => (tok ??= Promise.resolve().then(getToken).then((x) => {
      if (typeof x !== 'string' || !x) throw new Error('no robot token');
      return x;
    }));
    for (const f of all) {
      if (typeof f?.id !== 'string' || !f.id.startsWith(PR_FACT_PREFIX)) continue;
      const d = f.doc;
      if (f.corrupt || !d) { out.unreadable.push(f.id); continue; }
      if (d.state !== 'pending' || f.id !== PR_FACT(d.branch)) continue;
      // Only this robot's own repos (I6): a row naming another is that product's robot's to retry and tell.
      if (!repos.includes(d.repo)) continue;
      const t = now();
      const last = pastTime(d.at, t);
      if (last !== null && t - last < every) { out.waiting.push([d.branch, short(d.last_reason ?? 'not opened yet'), d.since]); continue; }
      let key;
      try { key = await token(); } catch (e) { out.waiting.push([d.branch, `no robot token: ${short(masker(String(e?.message ?? e)))}`, d.since]); continue; }
      const pr = await upsert({ repo: d.repo, branch: d.branch, base: d.base, title: d.title, body: d.body, token: key });
      if (pr) out.opened.push(d.branch);
      else out.waiting.push([d.branch, record.read('fact', f.id)?.doc?.last_reason ?? 'no reason given', d.since]);
    }
    return out;
  }

  return Object.freeze({ upsert, retryPending });
}
