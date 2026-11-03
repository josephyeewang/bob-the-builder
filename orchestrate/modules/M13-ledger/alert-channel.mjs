// alert-channel.mjs — the channel to Joe: the Record's alert queues become GitHub issues (L235–L245).
//
// WHY. Every alert site only queues (M11 alerts.mjs `outbox`, and the store's own unsent-alerts.jsonl); until now
// nothing delivered them, so Joe heard nothing. This pass is that delivery. It runs LAST in each robot round (lane 4's
// robot job, `deliver({ rec, now })`), never in the Dispatcher's tick, so a dead or hung Dispatcher is still told (L236,
// L242). An alert counts as told only after GitHub accepted the issue write; anything else leaves it queued for the next
// round (L235 c).
//
//   deliverAlertsPass({ rec, now, recordRoot, product, products, repos, owner, token, fetchFn?, issuesFor?, ... })
//     → { sent, failed, left, refused?, locked? }               never throws
//   deliverWith(bound) → ({ rec, now }) => deliverAlertsPass({ ...bound, rec, now })   (the robot job binds it at start-up)
//   githubIssues({ repo, owner, token, fetchFn?, timeoutMs? }) → the M13 alerts.mjs client, plus findOpen(marker)
//
// Config (the robot job's private Mac config, never the rules file; L237): `owner` is Joe's GitHub login, the assignee;
// `repos` maps each product to its "owner/name" repository; `products` is the products list in order. An alert goes to
// its Record's product's repo, and one with no product (the store's own) to the first product's. Bob's own repository is
// refused: Bob is public, and alerts carry a product's private state.
// `token` is () → Promise<{ ok, token } | { ok: false, reason }>, built by the robot job from M6 token.mjs
// mintInstallationToken (L237), asked once per pass. The App needs "Issues: read and write" on each product repo.
//
// Each queue entry is one issue key (M13 alerts.mjs: one issue per key, a repeat edits it): a marked entry keys on its
// mark (product, mark.kind, mark.fact); an unmarked one on a hash of its full text. An issue Joe closed does not silence
// its key: an alert is news, so the next one opens a new issue (L237). Nothing here closes an alert's issue by itself;
// wiring `clear` to causes that clear is a follow-up row.
//
// The Record's lock (L242, L244, L245). The pass first takes and drops M9's own lock with a bounded wait, so a lock
// left by a dead process is broken by M9's rule. A live holder makes the pass give up with nothing lost. When that
// holder has kept the lock longer than the heartbeat's red limit (or can't be read), the pass tells Joe straight through
// GitHub, since the Record can't be written: one issue, found again by a hidden marker, edited while it lasts and closed
// once the lock is free. No state file.

import { createHash } from 'node:crypto';
import { alertKey, makeAlerts } from './alerts.mjs';
import { DISPATCHER_LATE_MIN } from './heartbeat.mjs';
import { ALERT_BUDGET_MS, ALERT_SEND_MS, sendAlerts } from '../M11-dispatcher/alerts.mjs';
import { makeLock, readHolder } from '../M9-record/lock.mjs';
import { markSent, readUnsent } from '../M9-record/store.mjs';

export const RECORD_LOCKED_MIN = DISPATCHER_LATE_MIN;
export const RECORD_LOCKED_MARKER = '<!-- orch:record_locked -->';
export const LOCK_WAIT_MS = 5_000;
const MIN = 60_000;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BOB = /^bob-the-builder$/i;
const ISSUE = (n) => Number.isSafeInteger(n) && n > 0;
const TOLD = new Set(['opened', 'updated', 'changed']);
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const msg = (e) => String(e?.message ?? e).slice(0, 200);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Why a repository setting can't take alerts, or null. */
export function repoProblem(repo) {
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/')[1].startsWith('.')) return `"${String(repo).slice(0, 80)}" is not an owner/name repository`;
  if (BOB.test(repo.split('/')[1])) return `alerts never go to Bob's own repository (${repo})`;
  return null;
}

/** Why the channel's config can't be used, or null. */
export function channelProblem({ product, products, repos, owner } = {}) {
  if (typeof owner !== 'string' || !LOGIN.test(owner)) return 'no GitHub login to assign alerts to (owner)';
  if (!Array.isArray(products) || !products.length || !products.every((p) => typeof p === 'string' && p)) return 'no products list';
  if (!repos || typeof repos !== 'object') return 'no repository for any product (repos)';
  for (const r of Object.values(repos)) { const bad = repoProblem(r); if (bad) return bad; }
  for (const p of new Set([product ?? products[0], products[0]])) if (!own(repos, p)) return `no repository for the product ${p}`;
  return null;
}

// One answer within `ms`, or a throw: no GitHub call can hold the pass past its budget.
async function within(ms, f) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(f), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer within ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

// The token, asked once per pass however many calls use it; a throw reads as a refusal.
const once = (token) => {
  let p;
  return () => (p ??= Promise.resolve().then(token).catch((e) => ({ ok: false, reason: msg(e) })));
};

/**
 * A GitHub issues client for one repository, with the contract M13 alerts.mjs uses: open → the issue number, or false;
 * edit, comment, close → true, or false when GitHub refused; isClosed → boolean, or a throw; findOpen(marker) → the
 * number of an open issue whose body holds `marker`, null when there is none, false when GitHub refused the list.
 * A missing token throws "alert channel not set up: …". Host fixed; the repository is checked once, here.
 */
export function githubIssues({ repo, owner, token, fetchFn = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const bad = repoProblem(repo);
  if (bad) throw new Error(`alert channel not set up: ${bad}`);
  if (typeof token !== 'function') throw new Error('alert channel not set up: no token');
  const num = (n) => { if (!ISSUE(n)) throw new Error(`not an issue number: ${JSON.stringify(n)}`); return n; };
  async function call(method, path, body) {
    const t = await token();
    if (!t?.ok || typeof t.token !== 'string') throw new Error(`alert channel not set up: ${String(t?.reason ?? 'no token').slice(0, 200)}`);
    const res = await fetchFn(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${t.token}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    if (res.status >= 200 && res.status < 300) { try { json = await res.json(); } catch { json = null; } }
    return { status: res.status, json };
  }
  async function comment(n, text) { return (await call('POST', `/issues/${num(n)}/comments`, { body: String(text) })).status === 201; }
  return Object.freeze({
    async open({ title, body, assignee }) {
      const r = await call('POST', '/issues', { title: String(title), body: String(body), ...(assignee ? { assignees: [assignee] } : {}) });
      return r.status === 201 && ISSUE(r.json?.number) ? r.json.number : false;
    },
    async edit(n, body) { return (await call('PATCH', `/issues/${num(n)}`, { body: String(body) })).status === 200; },
    comment,
    async close(n, text) {
      if (!(await comment(n, text))) return false;
      return (await call('PATCH', `/issues/${num(n)}`, { state: 'closed' })).status === 200;
    },
    async isClosed(n) {
      const r = await call('GET', `/issues/${num(n)}`);
      if (r.status !== 200 || !r.json) throw new Error(`GitHub answered ${r.status} for issue ${n}`);
      return r.json.state === 'closed';
    },
    async findOpen(marker) {
      const r = await call('GET', `/issues?state=open&per_page=100${owner ? `&assignee=${encodeURIComponent(owner)}` : ''}`);
      if (r.status !== 200 || !Array.isArray(r.json)) return false;
      const hit = r.json.find((i) => i && !i.pull_request && typeof i.body === 'string' && i.body.includes(marker) && ISSUE(i.number));
      return hit ? hit.number : null;
    },
  });
}

/** The issue key of one Record queue entry: its mark's, or a hash of the full text sent when it has none (L237). */
export function entryKey(product, text, entry) {
  const m = entry?.mark;
  return m?.fact ? alertKey(product, m.kind ?? 'alert_told', m.fact) : alertKey(product, 'unmarked', sha256(text));
}

const titleOf = (text) => { const l = String(text).split('\n')[0].trim(); return (l.length > 120 ? `${l.slice(0, 119)}…` : l) || 'Alert'; };

// Raise one alert; an issue Joe closed opens a new one (L237). True only when GitHub took the write.
async function raiseNews(alerts, key, text, title = titleOf(text)) {
  let r = await alerts.raise({ key, title, body: String(text) });
  if (r === 'suppressed') {
    if (await alerts.clear({ key }) === false) return false;
    r = await alerts.raise({ key, title, body: String(text) });
  }
  return TOLD.has(r);
}

// The store's own alert as issue text (masked by makeAlerts before it is posted).
export function storeText(event) {
  const e = event && typeof event === 'object' ? event : {};
  const lines = Object.entries(e).filter(([k]) => k !== 'type').map(([k, v]) => `${k}: ${String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300)}`);
  return [`The Record's store: ${String(e.type ?? 'alert').slice(0, 100)}`, ...lines].join('\n');
}

// Take and drop M9's lock, waiting at most `ms`: a dead holder's lock is broken by M9's own rule; a live one is left.
function lockCheck({ recordRoot, ms, probe, host, nowMs }) {
  try {
    const lock = makeLock({ dir: recordRoot, timeoutMs: ms, ...(probe ? { probe } : {}), ...(host ? { host } : {}) });
    const { nonce } = lock.acquire();
    lock.release(nonce);
    return { free: true };
  } catch (e) {
    if (!e?.store) return { free: false, pid: '?', ageMin: null, reason: `the Record's lock could not be checked: ${msg(e)}` };
    let h = null;
    try { h = readHolder(recordRoot); } catch { h = null; }
    const at = Date.parse(h?.at ?? '');
    const ageMin = Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / MIN)) : null;
    const pid = Number.isInteger(h?.pid) ? h.pid : '?';
    return { free: false, pid, ageMin, reason: `the Record is locked by pid ${pid}${ageMin === null ? '' : ` for ${ageMin} min`}; alerts are queued and not delivered` };
  }
}

// The one record_locked issue (L244, L245): told straight through GitHub, found again by its marker.
async function tellLocked(gh, owner, st, ms) {
  if (st.ageMin !== null && st.ageMin <= RECORD_LOCKED_MIN) return 'waiting';
  const text = st.ageMin === null
    ? 'the Record is locked and who holds it can\'t be read; alerts are queued and not delivered'
    : `the Record has been locked for ${st.ageMin} min by pid ${st.pid}; alerts are queued and not delivered`;
  const body = `${text}\n\n${RECORD_LOCKED_MARKER}`;
  const found = await within(ms, () => gh.findOpen(RECORD_LOCKED_MARKER));
  if (found === false) return 'list refused';
  if (ISSUE(found)) return (await within(ms, () => gh.edit(found, body))) ? 'edited' : 'edit refused';
  return ISSUE(await within(ms, () => gh.open({ title: 'The Record is locked: alerts are not being delivered', body, assignee: owner }))) ? 'opened' : 'open refused';
}

async function clearLocked(gh, ms) {
  const found = await within(ms, () => gh.findOpen(RECORD_LOCKED_MARKER));
  if (!ISSUE(found)) return;
  await within(ms, () => gh.close(found, 'Cleared: the Record is no longer locked, and the queued alerts are being delivered.'));
}

/**
 * One delivery round. Never throws: every problem is an answer, `refused` saying why nothing (more) was sent.
 * `left` is how many Record queue entries still wait (null when the queue wasn't read).
 */
export async function deliverAlertsPass({ rec, now = Date.now, recordRoot, product, products, repos, owner, token, fetchFn, issuesFor,
  lockWaitMs = LOCK_WAIT_MS, probe, host, sendMs = ALERT_SEND_MS, budgetMs = ALERT_BUDGET_MS, clock = Date.now } = {}) {
  const out = { sent: 0, failed: 0, left: null };
  try {
    const nowMs = () => Number(typeof now === 'function' ? now() : now);
    const bad = channelProblem({ product, products, repos, owner });
    if (bad) return { ...out, refused: `alert channel not set up: ${bad}` };
    if (typeof recordRoot !== 'string' || !recordRoot) return { ...out, refused: 'alert channel not set up: no Record folder (recordRoot)' };
    const first = products[0];
    const target = product ?? first;
    const tok = typeof token === 'function' ? once(token) : null;
    if (!issuesFor) {
      if (!tok) return { ...out, refused: 'alert channel not set up: no token' };
      const t = await within(sendMs, tok);
      if (!t?.ok) return { ...out, refused: `alert channel not set up: ${String(t?.reason ?? 'no token').slice(0, 200)}` };
    }
    const clients = new Map();
    const ghFor = (p) => {
      const repo = repos[p];
      if (!clients.has(repo)) clients.set(repo, issuesFor ? issuesFor(repo) : githubIssues({ repo, owner, token: tok, fetchFn }));
      return clients.get(repo);
    };

    const lock = lockCheck({ recordRoot, ms: lockWaitMs, probe, host, nowMs: nowMs() });
    if (!lock.free) {
      let told;
      try { told = await tellLocked(ghFor(first), owner, lock, sendMs); } catch (e) { told = `not told: ${msg(e)}`; }
      return { ...out, refused: lock.reason, locked: told };
    }
    try { await clearLocked(ghFor(first), sendMs); } catch { /* closed on a later round */ }

    const start = clock();
    const when = () => new Date(nowMs());
    const alerts = makeAlerts({ rec, gh: ghFor(target), owner, now: when });
    const port = (text, entry) => raiseNews(alerts, entryKey(target, text, entry), text);
    const r = await sendAlerts(rec, port, nowMs(), { sendMs, budgetMs, clock });
    out.sent += r.sent; out.failed += r.failed; out.left = r.left;
    if (out.failed) return out;

    // The store's own unsent alerts (L239, L240), to the first product's repo.
    let waiting;
    try { waiting = readUnsent(recordRoot); } catch (e) {
      if (e?.code === 'ENOENT') waiting = [];
      else return { ...out, refused: `the store's unsent alerts could not be read: ${msg(e)}` };
    }
    const storeAlerts = repos[target] === repos[first] && target === first ? alerts : makeAlerts({ rec, gh: ghFor(first), owner, now: when });
    for (const x of waiting) {
      if (clock() - start + sendMs > budgetMs && out.sent + out.failed > 0) break;
      let ok = false;
      try { ok = await within(sendMs, () => raiseNews(storeAlerts, alertKey(first, 'store', x.id), storeText(x.event))); } catch { ok = false; }
      if (!ok) { out.failed += 1; break; }
      out.sent += 1;
      // A mark that fails: the next round raises it again on the same key, so the same issue is edited, not a second opened.
      try { markSent(recordRoot, x.id, when().toISOString()); } catch { /* raised again next round */ }
    }
  } catch (e) {
    out.refused = `the alert round failed: ${msg(e)}`;
  }
  return out;
}

/** The robot job's `deliver`, bound once at start-up (lane 4, robot-wiring.mjs `deliver({ rec, now })`). */
export const deliverWith = (bound) => ({ rec, now }) => deliverAlertsPass({ ...bound, rec, now });
