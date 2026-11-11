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
//   githubIssues({ repo, token, fetchFn?, timeoutMs? }) → the M13 alerts.mjs client
//
// Config (the robot job's private Mac config, never the rules file; L237): `owner` is Joe's GitHub login, the assignee;
// `repos` maps each product to its "owner/name" repository; `products` is the products list; `product` is the product
// whose Record this is (required: there is one Record per product, so no default). Every issue of a round goes to that
// product's repository: the Record's queue, the store's own alerts and the "Record is locked" issue, each naming the
// product (L288 MAT-3). A Record whose product document names another product is refused. Bob's own repository is
// refused: Bob is public, and alerts carry a product's private state.
// `token` is () → Promise<{ ok, token, login?, login_reason? } | { ok: false, reason }>, built by the robot job from M6
// token.mjs mintInstallationToken (L237), asked once per pass. The App needs "Issues: read and write" on each product
// repo. `login` is how the robot's issues are told from another app's (L399). With none, any bot's counts, and the
// pass's answer says so.
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
import { alertKey, lastLine, lineIs, makeAlerts, wasTold } from './alerts.mjs';
import { TROUBLE_SOURCES } from '../M12-sensors/facts.mjs';
import { DISPATCHER_LATE_MIN } from './heartbeat.mjs';
import { ALERT_BUDGET_MS, ALERT_QUEUE_FACT, ALERT_SEND_MS, holdsDelivered, sendAlerts } from '../M11-dispatcher/alerts.mjs';
import { holderDead, readHolder, sleepMs } from '../M9-record/lock.mjs';
import { clearHeldFlag, heldCut, heldHolders, isOwnHolder, markSent, readHeldFlag, readUnsent } from '../M9-record/unsent.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';
import { storeWords } from './store-stopped.mjs';

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
const COMMENT_PAGE = 100;
const COMMENT_PAGES = 10;
const ISSUE_PAGES = 10;
const ISSUE = (n) => Number.isSafeInteger(n) && n > 0;
const TOLD = new Set(['opened', 'updated', 'changed', 'reminded']);
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
 * edit, close → true, or false when GitHub refused; comment → { at } (GitHub's time for it), or false.
 * read(n) → { open, body, ours, closedByOwner }, null when the issue is gone (deleted: 410; not found: 404), false when
 * GitHub refused the read. ours: the robot wrote it. closedByOwner: GitHub shows a person, not the robot and not any app,
 * closed it. Anyone can open an issue on a public repo and quote a marker, so the robot's own login decides (L399).
 * findOpen(test) → the number of an open issue of the robot's whose last line passes test, on any page, null when there
 * is none, false when GitHub refused the list or there are too many to read.
 * listOpen(test) → every open issue of the robot's whose last line passes test, as [{ number, body, updated_at }], read
 * whole or not at all: false when GitHub refused a page, a page was not a list, or there are too many to read (L957).
 * latestOwnComment(n, since) → the robot's latest comment since that ISO time, as { at, body }; null when there is none;
 * false when GitHub refused a read or there are too many comments to read them all.
 * `lastAnswer` says what GitHub answered to the latest call, so a refusal can tell the owner what GitHub said.
 * `lastServerTime` is GitHub's own time on its latest answer (its Date header), in ms, or null (L768). read also gives the
 * issue's created_at, GitHub's time it was opened, or null.
 * `loginTrouble` says why the robot's login is unknown, in which case any bot counts as the robot; null when it is known,
 * and null until the first call: `ready` makes sure of one.
 * A missing token throws "alert channel not set up: …". Host fixed; the repository is checked once, here.
 */
export function githubIssues({ repo, token, fetchFn = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const bad = repoProblem(repo);
  if (bad) throw new Error(`alert channel not set up: ${bad}`);
  if (typeof token !== 'function') throw new Error('alert channel not set up: no token');
  const num = (n) => { if (!ISSUE(n)) throw new Error(`not an issue number: ${JSON.stringify(n)}`); return n; };
  let last = null;
  let serverAt = null;
  let robot = null;
  let loginTrouble = null;
  async function bearer() {
    const t = await token();
    if (!t?.ok || typeof t.token !== 'string') throw new Error(`alert channel not set up: ${String(t?.reason ?? 'no token').slice(0, 200)}`);
    robot = typeof t.login === 'string' && t.login ? t.login : null;
    loginTrouble = robot ? null : `the robot's own login could not be read (${String(t.login_reason ?? 'none given').slice(0, 200)}), so any bot's issue counted as the robot's this round`;
    return t.token;
  }
  const mine = (user) => (robot ? user?.login === robot : user?.type === 'Bot');
  async function call(method, path, body) {
    const res = await fetchFn(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${await bearer()}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    if (res.status >= 200 && res.status < 300) { try { json = await res.json(); } catch { json = null; } }
    last = `GitHub answered ${res.status} to ${method} ${path.split('?')[0]}`;
    const d = Date.parse(res.headers?.get?.('date') ?? '');
    serverAt = Number.isFinite(d) ? d : null;
    return { status: res.status, json };
  }
  async function comment(n, text) {
    const r = await call('POST', `/issues/${num(n)}/comments`, { body: String(text) });
    return r.status === 201 ? { at: r.json?.created_at } : false;
  }
  return Object.freeze({
    /** What GitHub answered to this client's latest call ("GitHub answered 422 to POST /issues"), or null. */
    get lastAnswer() { return last; },
    get lastServerTime() { return serverAt; },
    get loginTrouble() { return loginTrouble; },
    /** Learns the login, for a pass that has made no call yet. A token that can't be had is the next call's to report. */
    async ready() { await bearer().catch(() => {}); },
    async open({ title, body, assignee, labels }) {
      const r = await call('POST', '/issues', { title: String(title), body: String(body), ...(assignee ? { assignees: [assignee] } : {}), ...(labels?.length ? { labels } : {}) });
      return r.status === 201 && ISSUE(r.json?.number) ? r.json.number : false;
    },
    async edit(n, body) { return (await call('PATCH', `/issues/${num(n)}`, { body: String(body) })).status === 200; },
    comment,
    async close(n, text) {
      if (text != null && (await comment(n, text)) === false) return false;
      return (await call('PATCH', `/issues/${num(n)}`, { state: 'closed' })).status === 200;
    },
    async read(n) {
      const r = await call('GET', `/issues/${num(n)}`);
      if (r.status === 404 || r.status === 410) return null;
      if (r.status !== 200 || !r.json) return false;
      const by = r.json.closed_by;
      const closed = r.json.state === 'closed';
      return { open: !closed, body: String(r.json.body ?? ''), ours: mine(r.json.user),
        closedByOwner: closed && by?.type === 'User' && typeof by.login === 'string' && !mine(by),
        created_at: typeof r.json.created_at === 'string' && Number.isFinite(Date.parse(r.json.created_at)) ? r.json.created_at : null };
    },
    async findOpen(test) {
      await bearer();
      const creator = robot ? `&creator=${encodeURIComponent(robot)}` : '';
      for (let page = 1; page <= ISSUE_PAGES; page++) {
        const r = await call('GET', `/issues?state=open${creator}&per_page=${COMMENT_PAGE}&page=${page}`);
        if (r.status !== 200 || !Array.isArray(r.json)) return false;
        const hit = r.json.find((i) => i && !i.pull_request && mine(i.user) && typeof i.body === 'string' && test(lastLine(i.body)) && ISSUE(i.number));
        if (hit) return hit.number;
        if (r.json.length < COMMENT_PAGE) return null;
      }
      last = `GitHub has more than ${ISSUE_PAGES * COMMENT_PAGE} open issues to look through for this alert, too many to read`;
      return false;
    },
    async listOpen(test) {
      await bearer();
      const creator = robot ? `&creator=${encodeURIComponent(robot)}` : '';
      const found = [];
      for (let page = 1; page <= ISSUE_PAGES; page++) {
        const r = await call('GET', `/issues?state=open${creator}&per_page=${COMMENT_PAGE}&page=${page}`);
        if (r.status !== 200 || !Array.isArray(r.json)) return false;
        for (const i of r.json) {
          if (!i || i.pull_request || !mine(i.user) || typeof i.body !== 'string' || !test(lastLine(i.body))) continue;
          if (!ISSUE(i.number)) return false;
          found.push({ number: i.number, body: i.body, updated_at: typeof i.updated_at === 'string' ? i.updated_at : null });
        }
        if (r.json.length < COMMENT_PAGE) return found;
      }
      last = `GitHub has more than ${ISSUE_PAGES * COMMENT_PAGE} open issues to look through, too many to read`;
      return false;
    },
    async latestOwnComment(n, since) {
      let latest = null;
      for (let page = 1; page <= COMMENT_PAGES; page++) {
        const r = await call('GET', `/issues/${num(n)}/comments?since=${encodeURIComponent(since)}&per_page=${COMMENT_PAGE}&page=${page}`);
        if (r.status !== 200 || !Array.isArray(r.json)) return false;
        for (const c of r.json) {
          if (!mine(c?.user)) continue;
          if (!Number.isFinite(Date.parse(c.created_at))) return false;
          if (!latest || Date.parse(c.created_at) >= Date.parse(latest.at)) latest = { at: c.created_at, body: String(c.body ?? '') };
        }
        if (r.json.length < COMMENT_PAGE) return latest;
      }
      last = `GitHub has more than ${COMMENT_PAGES * COMMENT_PAGE} comments on issue ${n} since ${since}, too many to read`;
      return false;
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
// queue's counter was reset still reads as new (L298 Minor 4). An issue Joe closed opens a new one (L237). Answers
// raise's answer; `suppressed` never comes back, since a key the owner closed is cleared and raised again.
async function raiseNews(alerts, key, text, entryId) {
  const body = cutBody(text);
  const one = { key, title: titleOf(body), body, status: `queue entry ${entryId}`, note: `New alert: ${titleOf(body)}` };
  let r = await alerts.raise(one);
  if (r === 'suppressed') {
    const cleared = await alerts.clear({ key });
    if (!wasTold(cleared)) return cleared;
    r = await alerts.raise(one);
  }
  return r;
}

// One raise: null when GitHub took it, else why not, in words the owner can act on (GitHub's answer, or the error). The
// Record refusing to keep where the issue is costs nothing here: the alert went out.
async function raiseWhy(alerts, gh, key, text, entryId) {
  try {
    const r = await raiseNews(alerts, key, text, entryId);
    return TOLD.has(r) ? null : (gh?.lastAnswer ?? 'GitHub refused the write');
  } catch (e) { return msg(e); }
}

// The store's own alert as issue text (masked by makeAlerts before it is posted). Each value is an error's or a caller's
// words and can name the owner's folders, so it is cut and fenced as a push reason is (L720 n2, L732 m1): local paths
// become <path>, a cut for length says so, and the words are fenced as outside text. Every store alert comes here.
export function storeText(event, product) {
  const e = event && typeof event === 'object' ? event : {};
  const lines = Object.entries(e).filter(([k]) => k !== 'type').map(([k, v]) => `${k}: ${storeWords(v)}`);
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
  const found = await within(ms, () => gh.findOpen(lineIs(marker)));
  if (found === false) return 'list refused';
  if (ISSUE(found)) return (await within(ms, () => gh.edit(found, body))) ? 'edited' : 'edit refused';
  return ISSUE(await within(ms, () => gh.open({ title: `${product}'s Record is locked: alerts are not being delivered`, body, assignee: owner }))) ? 'opened' : 'open refused';
}

async function clearLocked(gh, product, ms) {
  const found = await within(ms, () => gh.findOpen(lineIs(lockedMarker(product))));
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
      if (!clients.has(repo)) clients.set(repo, issuesFor ? issuesFor(repo) : githubIssues({ repo, token: tok, fetchFn }));
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
    // A queue the Record won't let shrink is sent again every round, so with no share of the time it would use all of it
    // and the store's lines, the way out of that very state, would never go (L558 M3). With any waiting, it gets half of
    // what can be started in a round. That stops the queue starting sends, not one already running, so the store's loop
    // below also always tries one line (L566 N1).
    // What the store holds in this process only, on no disk (L620), asked first: a held line the disk now takes goes back
    // to the store's file here, so the read below sends it from there (#260 r1 m2). Sent below either way.
    let held;
    try { held = rec?.heldHere?.() ?? null; } catch (e) { held = { error: msg(e) }; }
    let storeWaiting = false;
    try { storeWaiting = readUnsent(recordRoot).length > 0; } catch { /* the read below names it */ }
    const reserveMs = storeWaiting ? Math.max(0, (budgetMs - sendMs) / 2) : 0;
    // A delivered alert held for its mark (L527) stays on the queue by design, and was sent: it isn't waiting (L593).
    const unsentQueued = () => {
      try {
        const q = rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries;
        return Array.isArray(q) ? q.filter((e) => !holdsDelivered(e, nowMs())).length : 0;
      } catch { return 0; }   // as sendAlerts' own read: an unreadable queue counts as empty here
    };
    const queuedAtStart = unsentQueued();
    const r = await sendAlerts(rec, port, nowMs(), { sendMs, budgetMs: budgetMs - reserveMs, clock });
    out.sent += r.sent; out.failed += r.failed; out.left = r.left;
    // A send that hung past sendMs never came back to the port: it is named by that.
    if (r.failed && !first) first = { title: 'a Record alert', why: `no answer within ${sendMs} ms` };
    // A failed or hung Record send does not skip the store's alerts (L288 MAT-2 c): they are a separate queue, so a round
    // always tries at least one, past the budget by that one send if it must. The pass deadline, 120 s, has room (L566 N1).

    // The store's own unsent alerts (L239, L240), to this product's repo, naming the product (L288 MAT-3).
    let waiting;
    try { waiting = readUnsent(recordRoot); } catch (e) {
      if (e?.code === 'ENOENT') waiting = [];
      else return { ...out, refused: `the store's unsent alerts could not be read: ${msg(e)}` };
    }
    let storeLeft = waiting.length;
    let storeTried = 0;
    for (const x of waiting) {
      if (clock() - start + sendMs > budgetMs && storeTried > 0) break;
      storeTried += 1;
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
    // What the store still holds in this process only (L620): a warning whose unsent line could not be written, as on a
    // full disk, is in no file this pass reads, and the store's own resend only logs. The robot process that found it
    // runs this pass, so it is sent from here, on its own key (a repeat edits the same issue). Sent or not, the round is
    // never clean while any is held: the disk that refused the line still refuses. Nor while the store's disk can't take
    // a write (#260 r1 M2): a warning another process on this store raises (the Dispatcher's) is then held in that
    // process's memory, where this pass can't see it. Not known what is held is not clean either (#260 r1 m1).
    const heldLines = [];
    if (held?.error) heldLines.push(`what the store holds in memory could not be read: ${held.error}`);
    if (typeof held?.disk === 'string') heldLines.push(`${held.disk.slice(0, 200)}: a warning any process on this store raises now (the Dispatcher too) may be held in that process's memory only, where this round can't see it`);
    if (held && !held.error && (held.held.length || held.dropped)) {
      let heldSent = 0; let heldTried = 0;
      for (const x of held.held) {
        if (clock() - start + sendMs > budgetMs && (storeTried > 0 || heldTried > 0)) break;
        heldTried += 1;
        const text = storeText(x.event, target);
        let why;
        try { why = await within(sendMs, () => raiseWhy(alerts, gh, alertKey(target, 'held', x.id), text, x.id)); } catch (e) { why = msg(e); }
        if (why !== null) { out.failed += 1; failedOn(text, why); continue; }
        out.sent += 1; heldSent += 1;
      }
      out.held = held.held.length;
      if (held.held.length) heldLines.push(`${held.held.length} of the store's warnings could not be written to its disk (is it full?) and are held in this process only (${heldSent} sent this round); they are lost if it stops`);
      if (held.dropped) heldLines.push(`${held.dropped} count(s) of alerts the Record's queue would not take could not be written to the store's disk and are lost (is it full?)`);
    }
    // The held flag (#260 r2 M1): other processes on this store (the Dispatcher, which exits after each pass) held
    // warnings on no disk. The flag keeps every holder (#260 r3 M1): the first one's first warning is told here, on the
    // 'held' key its own process would use, every other holder is named with its count, and the total is said. This
    // process's own entries (its pid and a token of its own store, #260 r3 m1) are its held list above: they are left
    // out of what is told here, and kept in the flag when it is cleared. The flag is cleared once told; the round says
    // what it says, so the rest are not lost unheard.
    let flagged;
    try { flagged = readHeldFlag(recordRoot); } catch (e) { heldLines.push(`the store's held flag could not be read: ${msg(e)}`); }
    const all = flagged?.flag ? heldHolders(flagged.flag) : [];
    const others = all.filter((h) => !isOwnHolder(h));
    const cut = heldCut(flagged?.flag);
    if (flagged && (!flagged.flag || others.length || cut.holders)) {
      const f = flagged.flag ?? {};
      const firstOwn = all.length > 0 && all[0].first && isOwnHolder(all[0]);
      const ev = !firstOwn && f.event && typeof f.event === 'object' && !Array.isArray(f.event) ? f.event : null;
      let told = !ev;
      if (ev) {
        const text = storeText(ev, target);
        const id = typeof f.id === 'string' ? f.id : 'flag';
        let why;
        try { why = await within(sendMs, () => raiseWhy(alerts, gh, alertKey(target, 'held', id), text, id)); } catch (e) { why = msg(e); }
        if (why !== null) { out.failed += 1; failedOn(text, why); } else { out.sent += 1; told = true; }
      }
      const known = (v) => Number.isSafeInteger(v) && v >= 0;
      const who = (h) => (Number.isSafeInteger(h.pid) ? `process ${h.pid}` : 'a process');
      const when = (h) => (typeof h.at === 'string' ? ` at ${h.at.slice(0, 40)}` : '');
      const sum = (k) => others.reduce((a, h) => (a === null || !known(h[k]) ? null : a + h[k]), cut[k]);
      const n = sum('held');
      const lost = sum('dropped');
      const many = others.length + cut.holders > 1;
      const tail = !ev ? (firstOwn ? 'the first is this process\'s own, told above, and none of the others\' can be told from here' : 'none can be told from here')
        : !told ? 'the first could not be told this round'
          : n === null ? `the first is told this round; how many ${many ? 'they' : 'it'} held is not known, and any others are lost if ${many ? 'those processes have' : 'that process has'} stopped`
            : n > 1 ? `the first is told this round, and the others are lost if ${many ? 'those processes have' : 'that process has'} stopped`
              : 'it is told this round';
      const countOf = (v) => (known(v) ? v : 'some');
      const lostText = (v) => (v === null ? ', and lost some count(s) of alerts' : v ? `, and lost ${v} count(s) of alerts` : '');
      let line;
      if (!flagged.flag) line = 'the store\'s held flag is set but can\'t be read: a process on this store held warnings in its memory only, and they are lost if it stopped';
      else if (!many) {
        const h = others[0] ?? { held: cut.held, dropped: cut.dropped };
        line = `${who(h)} on this store held ${countOf(h.held)} warning(s) in its memory only${when(h)}, as the store's disk could not take them${lostText(known(h.dropped) ? h.dropped : (h.dropped == null ? 0 : null))}: ${tail}`;
      } else {
        const named = others.map((h) => `${who(h)}${when(h)}, ${countOf(h.held)}${known(h.dropped) && h.dropped ? ` and ${h.dropped} lost` : ''}`);
        if (cut.holders) named.push(`${cut.holders} more not named, as the flag is full, ${cut.held}${cut.dropped ? ` and ${cut.dropped} lost` : ''}`);
        line = `${others.length + cut.holders} processes on this store held ${n ?? 'some'} warning(s) in all in their memory only, as the store's disk could not take them${lostText(lost)} (${named.join('; ')}): ${tail}`;
      }
      if (f.torn_before) line += '; an earlier flag could not be read, so a process before these may have held more';
      heldLines.push(line);
      if (told) { try { clearHeldFlag(recordRoot, flagged.raw, all.length > others.length ? { keep: isOwnHolder } : undefined); } catch (e) { heldLines.push(`the store's held flag could not be cleared: ${msg(e)}`); } }
    }
    // Any alert this round should have delivered and did not: the robot job counts the pass as failed (L288 MAT-2 d).
    // It names the first one and what GitHub said, so Joe has something to act on (L298 Minor 5); masked like the issue.
    if (out.failed) {
      const m = makeMasker();
      const t = m.maskSecrets(first?.title ?? 'an alert').text;
      const why = m.maskSecrets(String(first?.why ?? 'unknown')).text.slice(0, 200);
      out.refused = `${out.failed} alert(s) could not be delivered this round and stay queued for the next; the first, "${t}": ${why}`;
    }
    // Things the round did not lose but the owner should hear of, added to whatever went wrong above.
    const plus = [...heldLines];
    // The queue is sent from its head, so while it can't shrink the entries past a round's reach are not sent at all. A
    // queue that didn't shrink is named, so that can't wait unheard; a backlog that is clearing fails no pass (L566 N2,
    // L579). The one that failed is named above, so it is taken off the count. Arrivals during a round can over-tell.
    // Arrivals between rounds can under-tell, as they count in the start size: a queue held steady by them looks as if
    // it shrank (L582). That delays this line and no alert is lost; past the queue's cap the oldest go, and the count
    // is told (L593).
    const unsentLeft = unsentQueued();
    if (unsentLeft >= queuedAtStart && unsentLeft > r.failed) plus.push(`${unsentLeft - r.failed} alert(s) are still in the Record's queue after this round, which did not shrink it`);
    if (storeTried < waiting.length) plus.push(`${waiting.length - storeTried} of the store's unsent alerts had no time this round and wait for the next`);
    try {
      if (await within(sendMs, () => alerts.reportTrouble(target, TROUBLE_SOURCES.CHANNEL)) === false) plus.push(`the alert about the Record refusing writes did not go out: ${gh?.lastAnswer ?? 'GitHub refused it'}`);
    } catch (e) { plus.push(`the alert about the Record refusing writes did not go out: ${msg(e)}`); }
    await within(sendMs, () => gh?.ready?.()); // a round with nothing to send may have made no call yet
    if (gh?.loginTrouble) plus.push(gh.loginTrouble);
    if (plus.length) out.refused = [out.refused, ...plus].filter(Boolean).join('; ');
  } catch (e) {
    out.refused = `the alert round failed: ${msg(e)}`;
  }
  return out;
}

/** The robot job's `deliver`, bound once at start-up (lane 4, robot-wiring.mjs `deliver({ rec, now })`). */
export const deliverWith = (bound) => ({ rec, now }) => deliverAlertsPass({ ...bound, rec, now });
