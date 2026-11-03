// alert-channel.mjs — the channel to Joe: the Record's alert queues become GitHub issues (L235–L245).
//
// WHY. Every alert site only queues (M11 alerts.mjs `outbox`, and the store's own unsent-alerts.jsonl); until now
// nothing delivered them, so Joe heard nothing. This pass is that delivery. It runs LAST in each robot round (lane 4's
// robot job, `deliver({ rec, now })`), never in the Dispatcher's tick, so a dead or hung Dispatcher is still told (L236,
// L242). An alert counts as told only after GitHub accepted the issue write; anything else leaves it queued for the next
// round (L235 c).
//
//   deliverAlertsPass({ rec, now, recordRoot, product, products, repos, owner, token, fetchFn?, issuesFor?, ... })
//     → { sent, failed, left, refused?, locked? }               never throws; any alert not delivered → `refused`
//   deliverWith(bound) → ({ rec, now }) => deliverAlertsPass({ ...bound, rec, now })   (the robot job binds it at start-up)
//   githubIssues({ repo, owner, token, fetchFn?, timeoutMs? }) → the M13 alerts.mjs client, plus findOpen(marker)
//
// Config (the robot job's private Mac config, never the rules file; L237): `owner` is Joe's GitHub login, the assignee;
// `repos` maps each product to its "owner/name" repository; `products` is the products list; `product` is the product
// whose Record this is (required: there is one Record per product, so no default). Every issue of a round goes to that
// product's repository: the Record's queue, the store's own alerts and the "Record is locked" issue, each naming the
// product (L288 MAT-3). A Record whose product document names another product is refused. Bob's own repository is
// refused: Bob is public, and alerts carry a product's private state.
// `token` is () → Promise<{ ok, token } | { ok: false, reason }>, built by the robot job from M6 token.mjs
// mintInstallationToken (L237), asked once per pass. The App needs "Issues: read and write" on each product repo.
//
// Each queue entry is one issue key (M13 alerts.mjs: one issue per key): a marked entry keys on its mark (product,
// mark.kind, mark.fact); an unmarked one on a hash of its full text. Every new queue entry notifies (L288 MAT-1): the
// entry's own id is the alert's status, so a new entry on a key whose issue is open adds a comment ("New alert: …"),
// which GitHub notifies on; a body edit alone notifies nobody. Only a retry of the same entry (its mark was lost) is a
// silent edit. An issue Joe closed, deleted or moved away does not silence its key: the next alert opens a new issue
// (L237; GitHub's "not found" or "gone" reads as closed). A body over BODY_MAX characters is cut, and says so, since
// GitHub refuses a body over 65,536 every time (L288 MAT-2). Nothing here closes an alert's issue by itself; wiring
// `clear` to causes that clear is a follow-up row.
//
// The Record's lock (L242, L244, L245). The pass reads M9's lock and never takes it: only the store breaks a dead
// holder's lock, because only the store recovers after a break (store.mjs `broke`), so a break from here would leave a
// process that already opened its store not rolling forward a write the dead holder committed (lane 1's review). A
// dead holder's lock is left for the store's next write. A live holder, waited on for a few seconds, makes the pass
// give up with nothing lost. When that
// holder has kept the lock longer than the heartbeat's red limit (or can't be read, or its start time is in the future),
// the pass tells Joe straight through
// GitHub, since the Record can't be written: one issue, found again by a hidden marker, edited while it lasts and closed
// once the lock is free. No state file.

import { createHash } from 'node:crypto';
import { alertKey, makeAlerts } from './alerts.mjs';
import { DISPATCHER_LATE_MIN } from './heartbeat.mjs';
import { ALERT_BUDGET_MS, ALERT_SEND_MS, sendAlerts } from '../M11-dispatcher/alerts.mjs';
import { holderDead, readHolder, sleepMs } from '../M9-record/lock.mjs';
import { markSent, readUnsent } from '../M9-record/unsent.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';

export const RECORD_LOCKED_MIN = DISPATCHER_LATE_MIN;
/** The record_locked issue's marker for one product (two products may share a repository). */
export const lockedMarker = (product) => `<!-- orch:record_locked ${product} -->`;
/** GitHub refuses an issue body over 65,536 characters; an alert is cut well under it, leaving room for the footer. */
export const BODY_MAX = 60_000;
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
  if (typeof product !== 'string' || !product) return 'no product for this Record (product)';
  if (!products.includes(product)) return `the product ${product} is not in the products list`;
  if (!own(repos, product)) return `no repository for the product ${product}`;
  return null;
}

/** Why `rec` is not `product`'s Record, or null: its product document, when there is one, must be this product's. */
export function recordProductProblem(rec, product) {
  const docs = rec.list('product');
  const other = docs.find((d) => d.id !== product);
  if (other && (typeof other.id !== 'string' || !other.id)) return `this Record's product can't be read, so it can't be told apart from ${product}'s`;
  if (other) return `this Record holds product ${other.id.slice(0, 100)}'s state, not ${product}'s`;
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
 * `lastAnswer` says what GitHub answered to the latest call, so a refusal can tell Joe what GitHub said.
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
    last = `GitHub answered ${res.status} to ${method} ${path.split('?')[0]}`;
    return { status: res.status, json };
  }
  let last = null;
  async function comment(n, text) { return (await call('POST', `/issues/${num(n)}/comments`, { body: String(text) })).status === 201; }
  return Object.freeze({
    /** What GitHub answered to this client's latest call ("GitHub answered 422 to POST /issues"), or null. */
    get lastAnswer() { return last; },
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
    // An issue that is gone (deleted: 410; not found: 404) reads as closed, so the next alert opens a new one rather
    // than failing on it every round (L288 MAT-2 a).
    async isClosed(n) {
      const r = await call('GET', `/issues/${num(n)}`);
      if (r.status === 404 || r.status === 410) return true;
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

/** An alert's text cut to BODY_MAX characters, saying so when it was cut. */
export function cutBody(text) {
  const s = String(text);
  if (s.length <= BODY_MAX) return s;
  return `${s.slice(0, BODY_MAX)}\n\n[cut: this alert was ${s.length} characters; the first ${BODY_MAX} are shown]`;
}

// Raise one queue entry; `entryId` is its status, so a new entry on an open issue comments (notifies) and a retry of the
// same entry only edits (L288 MAT-1). A Record entry's status is its id and queue time, so an id used again after the
// queue's counter was reset still reads as new (L298 Minor 4). An issue Joe closed opens a new one (L237). True only
// when GitHub took the write.
async function raiseNews(alerts, key, text, entryId) {
  const body = cutBody(text);
  const one = { key, title: titleOf(body), body, status: `queue entry ${entryId}`, note: `New alert: ${titleOf(body)}` };
  let r = await alerts.raise(one);
  if (r === 'suppressed') {
    if (await alerts.clear({ key }) === false) return false;
    r = await alerts.raise(one);
  }
  return TOLD.has(r);
}

// One raise: null when GitHub took it, else why not, in words Joe can act on (GitHub's answer, or the error).
async function raiseWhy(alerts, gh, key, text, entryId) {
  try {
    return (await raiseNews(alerts, key, text, entryId)) ? null : (gh?.lastAnswer ?? 'GitHub refused the write');
  } catch (e) { return msg(e); }
}

// The store's own alert as issue text (masked by makeAlerts before it is posted).
export function storeText(event, product) {
  const e = event && typeof event === 'object' ? event : {};
  const lines = Object.entries(e).filter(([k]) => k !== 'type').map(([k, v]) => `${k}: ${String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300)}`);
  return [`${product}'s Record store: ${String(e.type ?? 'alert').slice(0, 100)}`, ...lines].join('\n');
}

// Read M9's lock, waiting at most `ms` for a live holder to let go. Free: no lock, or a dead holder's (M9's own test),
// which the store's next write breaks and recovers from. Never taken or broken here.
function lockCheck({ recordRoot, ms, probe, host, nowMs }) {
  const deadline = Date.now() + ms;
  for (;;) {
    let h;
    try { h = readHolder(recordRoot); } catch (e) { return { free: false, pid: '?', ageMin: null, reason: `the Record's lock could not be checked: ${msg(e)}` }; }
    if (h === null || holderDead(h, { host, probe })) return { free: true };
    if (!h.unreadable && Date.now() < deadline) { sleepMs(25); continue; }
    const at = Date.parse(h?.at ?? '');
    // A start time in the future can't say how long the lock is held: unknown, so it is told at once (L288).
    const future = Number.isFinite(at) && at > nowMs;
    const ageMin = Number.isFinite(at) && !future ? Math.floor((nowMs - at) / MIN) : null;
    const pid = Number.isInteger(h?.pid) ? h.pid : '?';
    return { free: false, pid, ageMin, future, reason: `the Record is locked by pid ${pid}${ageMin === null ? '' : ` for ${ageMin} min`}; alerts are queued and not delivered` };
  }
}

// The one record_locked issue (L244, L245): told straight through GitHub, found again by its marker.
async function tellLocked(gh, owner, product, st, ms) {
  if (st.ageMin !== null && st.ageMin <= RECORD_LOCKED_MIN) return 'waiting';
  const text = st.future
    ? `${product}'s Record is locked by pid ${st.pid}, whose start time is in the future, so how long it has been held can't be told; alerts are queued and not delivered`
    : st.ageMin === null
      ? `${product}'s Record is locked and who holds it can't be read; alerts are queued and not delivered`
      : `${product}'s Record has been locked for ${st.ageMin} min by pid ${st.pid}; alerts are queued and not delivered`;
  const marker = lockedMarker(product);
  const body = `${text}\n\n${marker}`;
  const found = await within(ms, () => gh.findOpen(marker));
  if (found === false) return 'list refused';
  if (ISSUE(found)) return (await within(ms, () => gh.edit(found, body))) ? 'edited' : 'edit refused';
  return ISSUE(await within(ms, () => gh.open({ title: `${product}'s Record is locked: alerts are not being delivered`, body, assignee: owner }))) ? 'opened' : 'open refused';
}

async function clearLocked(gh, product, ms) {
  const found = await within(ms, () => gh.findOpen(lockedMarker(product)));
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
    const target = product;
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

    // Whose Record this is comes first: a locked Record of another product tells no repository anything (L298).
    const wrong = recordProductProblem(rec, target);
    if (wrong) return { ...out, refused: `alert channel not set up: ${wrong}` };
    const lock = lockCheck({ recordRoot, ms: lockWaitMs, probe, host, nowMs: nowMs() });
    if (!lock.free) {
      let told;
      try { told = await tellLocked(ghFor(target), owner, target, lock, sendMs); } catch (e) { told = `not told: ${msg(e)}`; }
      return { ...out, refused: lock.reason, locked: told };
    }
    try { await clearLocked(ghFor(target), target, sendMs); } catch { /* closed on a later round */ }

    const start = clock();
    const when = () => new Date(nowMs());
    const gh = ghFor(target);
    const alerts = makeAlerts({ rec, gh, owner, now: when });
    let first = null;
    const failedOn = (text, why) => { first ??= { title: titleOf(text), why }; };
    const port = async (text, entry) => {
      const why = await raiseWhy(alerts, gh, entryKey(target, text, entry), text, `${entry?.id ?? 'unknown'} ${entry?.queued_at ?? ''}`.trim());
      if (why !== null) failedOn(text, why);
      return why === null;
    };
    const r = await sendAlerts(rec, port, nowMs(), { sendMs, budgetMs, clock });
    out.sent += r.sent; out.failed += r.failed; out.left = r.left;
    // A send that hung past sendMs never came back to the port: it is named by that.
    if (r.failed && !first) first = { title: 'a Record alert', why: `no answer within ${sendMs} ms` };
    // A failed Record send does not skip the store's alerts (L288 MAT-2 c): they are a separate queue.

    // The store's own unsent alerts (L239, L240), to this product's repo, naming the product (L288 MAT-3).
    let waiting;
    try { waiting = readUnsent(recordRoot); } catch (e) {
      if (e?.code === 'ENOENT') waiting = [];
      else return { ...out, refused: `the store's unsent alerts could not be read: ${msg(e)}` };
    }
    let storeLeft = waiting.length;
    for (const x of waiting) {
      if (clock() - start + sendMs > budgetMs && out.sent + out.failed > 0) break;
      const text = storeText(x.event, target);
      let why;
      try { why = await within(sendMs, () => raiseWhy(alerts, gh, alertKey(target, 'store', x.id), text, x.id)); } catch (e) { why = msg(e); }
      // One store alert GitHub refuses does not hold back the ones after it; it is tried again next round.
      if (why !== null) { out.failed += 1; failedOn(text, why); continue; }
      out.sent += 1;
      storeLeft -= 1;
      // A mark that fails: the next round raises it again on the same key, so the same issue is edited, not a second opened.
      try { markSent(recordRoot, x.id, when().toISOString()); } catch { /* raised again next round */ }
    }
    out.storeLeft = storeLeft;
    // Any alert this round should have delivered and did not: the robot job counts the pass as failed (L288 MAT-2 d).
    // It names the first one and what GitHub said, so Joe has something to act on (L298 Minor 5); masked like the issue.
    if (out.failed) {
      const m = makeMasker();
      const t = m.maskSecrets(first?.title ?? 'an alert').text;
      const why = m.maskSecrets(String(first?.why ?? 'unknown')).text.slice(0, 200);
      out.refused = `${out.failed} alert(s) could not be delivered this round and stay queued for the next; the first, "${t}": ${why}`;
    }
  } catch (e) {
    out.refused = `the alert round failed: ${msg(e)}`;
  }
  return out;
}

/** The robot job's `deliver`, bound once at start-up (lane 4, robot-wiring.mjs `deliver({ rec, now })`). */
export const deliverWith = (bound) => ({ rec, now }) => deliverAlertsPass({ ...bound, rec, now });
