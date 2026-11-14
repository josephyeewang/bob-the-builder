// push-pass.mjs — the robot job's push pass (lane N, N1; LEAD-CALLS L1077, L1078): a finished card's bundle reaches
// GitHub through M4's push script, the only way any work does.
//
// WHY. push.mjs pushCard(sessionId) is built and checked (card branch only, never main, never forced, the refusal list,
// the secret scan, the rules and the start gate), but nothing called it, so no worker's work could ever become a pull
// request. The robot job is where it runs: the job holds the robot App's write key, runs as the Record's owner, and
// a crash here does not stop the Dispatcher.
//
//   pushPass({ rec, product, outboxRoot, pushCard, alert, now, prs?, getToken?, repos?, hold?, drop?, stat?, hashOf?, maxPushes? })
//     → { pushed: [card], waiting: [[card, why]], refused: [[card, why]], prs: [branch opened], told: n, untold: [cause] }
//   prs: pr-writer.mjs prWriter (the same one pushCard's pullRequests.upsert is), getToken: the round's robot token,
//   repos: this robot's product repos. With prs, step 6 runs each round.
//
// Each round, for every session in the Record of this product whose role is a card's own (PRODUCT_OUTBOX_ROLES):
//   1. its outbox is checked as the push script checks it (outboxProblemFor, under the real outbox root): an outbox that
//      is gone is "nothing to push"; any other problem is told, and the session is not touched (I6);
//   2. no bundle in it: nothing to push. A bundle changed in the last SETTLE_MS: it may still be being written, so it
//      waits a round, untold;
//   3. the bundle already taken by its push is asked of the drain's own rule (runner-ports.mjs bundleHeld, I7): taken,
//      the session's holds are cleared and nothing is pushed;
//   4. the attempt's last answer (its push fact) says whether to try now. Its last try is the later of its time and its
//      last refusal's (a push already made keeps its fact and gains `last_refusal`, push.mjs settle). A final refusal of
//      these same bytes (the bundle not changed since it, by pastTime, I4) is not tried again: it stays told, on the hold
//      cadence. Any other try of these same bytes, refused for now or pushed but not taken (head_refused: the card's head
//      could not be noted), is tried again once RETRY_MS has passed since it, told on the hold cadence meanwhile
//      (#536 r1 M1: never every round);
//   5. pushCard(sessionId). Its answer: pushed clears the holds, unless its fact says the card's head could not be noted:
//      that is told on its own cause, PUSH_HEAD_CAUSE; `retry` is the wait hold; any other refusal is the refused hold.
//      Each hold is holdAlert's: told at once, then once a day while it lasts (I3), marked told only once delivered. A hold
//      the queue refused is said in `untold`, so robot-main's failed-pass tell carries it (I5).
//   6. pull requests a push left unopened (pr-writer.mjs pending facts) are asked for again every RETRY_MS; each is told
//      on its branch's cause until it opens, then cleared (L1082 Q6).
// At most `maxPushes` pushCard calls a round: a push fetches from GitHub and runs the secret scan, and the pass has its
// own limit (robot-push.mjs PUSH_DEADLINE_MS). The line (#536 r1 M1): the session tried longest ago first, never tried
// before all, and among equals the oldest launch. A session tried is spaced RETRY_MS and goes to the back, so one that
// can never be taken does not hold the slot: the rest are each reached in turn as the slot comes free.
//
// FAIL CLOSED (I1). A Record whose session list can't be read throws: the pass fails, and robot-main tells it. A fact or
// session that can't be read, or a bundle that can't be hashed, is told for that session and the next one still runs. A
// bundle stamped in the future is told (#536 r1 m6), never left to settle for ever.
// Known limit: the Record's list leaves out a document it can't read (M9 store list), so a damaged session doc is not
// seen here, and nothing tells it yet: the worker runner's drain would tell it (record-unreadable or bundle-no-attempt),
// but its tells are not wired (tick.mjs gives the drain no drainHolds port; drain-alerts.mjs), so that backstop waits
// for them (#536 r1 M1).

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { bundleName, PUSH_FACT, SETTLE_MS } from '../modules/M4-workshop/git/push.mjs';
import { WORKER_OUTBOX_ROLES, outboxProblemFor } from '../modules/M4-workshop/git/session-outbox.mjs';
import { PRODUCT_OUTBOX_ROLES } from '../shared/product-paths.mjs';
import { pastTime } from '../shared/still-waiting.mjs';
import { holdAlert, HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { dropCause } from '../modules/M11-dispatcher/alerts.mjs';
import { bundleHeld, fileSha256 } from './runner-ports.mjs';

// A refusal that may pass by itself (GitHub, the mirror, the start gate) is tried again this long after it, not every
// minute: each try fetches from GitHub. The research copy's own retry (M11 research-intake.mjs) is the same 15 minutes.
export const RETRY_MS = 15 * 60_000;
export const MAX_PUSHES = 1;
// One cause per session attempt and kind, so a new attempt or new bytes are told afresh and each wait is its own.
// Card and attempt are joined by a dot, which neither can hold (push.mjs CARD, ATTEMPT), so no two pairs share a cause
// (#536 r2 c1).
export const PUSH_WAIT_CAUSE = (card, att) => `push-wait-${card}.${att}`;
export const PUSH_REFUSED_CAUSE = (card, att) => `push-refused-${card}.${att}`;
export const PUSH_TROUBLE_CAUSE = (session) => `push-trouble-${session}`;
// Pushed, but the card's head could not be noted, so the push is not taken and is made again (#536 r1 M1).
export const PUSH_HEAD_CAUSE = (card, att) => `push-head-${card}.${att}`;
// When this pass last called the push script for an attempt (#536 r2 Minor 5): a call that left no push fact (the script
// threw, its fact could not be written, or the pass limit cut it off) is spaced RETRY_MS by it, and goes to the back of
// the line, as a recorded try does. The Workshop's (M9 family `push.`), as the push facts and the PR writer's are; four
// dots, where PUSH_FACT has two and PR_FACT starts `push.pr-open.`, so it can't be taken for either.
export const PUSH_CALLED_FACT = (card, att) => `push.called.${card}.${att}.at`;
// A bundle stamped this far past the clock read just before is not told as stamped in the future (#536 r2 Minor 4).
export const FUTURE_SKEW_MS = 5_000;
// A branch pushed with no pull request yet, per branch (a card's branch outlives its attempts); one cause for a retry
// that can't run at all.
export const PR_WAIT_CAUSE = (branch) => `push-pr-${String(branch).replace(/[^a-z0-9-]/g, '-')}`;
export const PR_TROUBLE_CAUSE = 'push-pr-retry';
const CARD_OK = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const short = (s) => String(s ?? '').slice(0, 300);

const gone = (problem) => /ENOENT/.test(problem);

/**
 * The attempt's last try, from its push fact doc (#536 r1 M1): { at, refusal }, `at` the later of the fact's time and
 * its last refusal's (pastTime; null when neither can be read), `refusal` the last answer when it was a refusal
 * ({ reason, retry }), else null.
 */
export function lastTry(d, t) {
  if (!d || typeof d !== 'object') return { at: null, refusal: null };
  const own = pastTime(d.at, t);
  if (d.result === 'refused') return { at: own, refusal: own === null ? null : { reason: d.reason, retry: d.retry === true } };
  const lr = d.result === 'pushed' && d.last_refusal && typeof d.last_refusal === 'object' ? d.last_refusal : null;
  const lrAt = lr ? pastTime(lr.at, t) : null;
  if (lrAt !== null && (own === null || lrAt >= own)) return { at: lrAt, refusal: { reason: lr.reason, retry: lr.retry === true } };
  return { at: own, refusal: null };
}

/** The Record's fact as the drain reads one: { ok: true, doc } | { ok: false, missing?, reason }. */
function factReader(rec) {
  return (id) => {
    const f = rec.read('fact', id);
    if (!f) return { ok: false, missing: true };
    if (f.corrupt || !f.doc) return { ok: false, reason: 'the fact can\'t be read' };
    return { ok: true, doc: f.doc };
  };
}
function sessionReader(rec) {
  return (id) => {
    const s = rec.read('session', id);
    if (!s) return { ok: false, missing: true };
    if (s.corrupt || !s.doc) return { ok: false, reason: 'the session can\'t be read' };
    return { ok: true, doc: s.doc };
  };
}

export async function pushPass({ rec, product, outboxRoot, pushCard, alert, now, prs = null, getToken = null, repos = [],
  hold = holdAlert, drop = dropCause, stat = lstatSync, hashOf = fileSha256, maxPushes = MAX_PUSHES }) {
  if (typeof pushCard !== 'function') throw new Error('the push pass has no push script');
  const t = now();
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error('the push pass has no clock');
  // A list that can't be read is not "no sessions" (I1): the throw fails the pass, and robot-main tells it.
  const all = rec.list('session');
  if (!Array.isArray(all)) throw new Error('the Record\'s session list could not be read');
  const out = { pushed: [], waiting: [], refused: [], prs: [], told: 0, untold: [] };
  const tell = (cause, text) => {
    let r;
    try { r = hold({ rec, cause, text, alert, now: t }); } catch { r = false; }
    if (r === false) out.untold.push(cause);
    else if (r) out.told += 1;
    return r;
  };
  const clear = (...causes) => { for (const c of causes) { try { drop(rec, HOLD_FACT(c)); } catch { /* a stale queued copy is told at most once more */ } } };

  // The clock now (#536 r2 Minor 4): a push can take minutes, so each session's bundle is judged by a fresh read, never
  // by the pass's start. One that can't be read, or is behind the start, is the start.
  const clock = () => { let v; try { v = now(); } catch { v = t; } return typeof v === 'number' && Number.isFinite(v) && v > t ? v : t; };
  // The pass's last call of the push script for this attempt (PUSH_CALLED_FACT), or null.
  const calledAt = (card, att, at) => {
    let f; try { f = rec.read('fact', PUSH_CALLED_FACT(card, att)); } catch { return null; }
    return f && !f.corrupt ? pastTime(f.doc?.at, at) : null;
  };
  // The line (#536 r1 M1): tried longest ago first (never tried, or a try whose time can't be read, before all), then the
  // oldest launch (pastTime: a bad time sorts first, never last). So no session waits behind another for ever. A call
  // that left no fact counts as a try (#536 r2 Minor 5).
  const triedAt = (s) => {
    const { card, attempt } = s.doc;
    if (typeof card !== 'string' || !CARD_OK.test(card) || typeof attempt !== 'string' || !attempt) return -Infinity;
    let f; try { f = rec.read('fact', PUSH_FACT(card, attempt)); } catch { return -Infinity; }
    const at = lastTry(f?.corrupt ? null : f?.doc, t).at;
    const called = calledAt(card, attempt, t);
    return Math.max(at ?? -Infinity, called ?? -Infinity);
  };
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const mine = all.filter((s) => s?.doc?.product === product && PRODUCT_OUTBOX_ROLES.includes(s.doc.role))
    .map((s) => ({ s, tried: triedAt(s), launched: pastTime(s.doc.launched_at, t) ?? -Infinity }))
    .sort((a, b) => order(a.tried, b.tried) || order(a.launched, b.launched))
    .map((x) => x.s);
  let calls = 0;
  for (const s of mine) {
    const id = s.id;
    const { card, attempt: att, outbox } = s.doc;
    const say = (why) => `card ${card}, session ${id}: ${why}`;
    if (typeof card !== 'string' || !CARD_OK.test(card) || typeof att !== 'string' || !att) {
      tell(PUSH_TROUBLE_CAUSE(id), `session ${id}'s record names no card or attempt, so its work can't be pushed`);
      continue;
    }
    const bad = outboxProblemFor(outbox, id, { outboxRoot, product, role: WORKER_OUTBOX_ROLES });
    if (bad && gone(bad)) continue;
    if (bad) { tell(PUSH_TROUBLE_CAUSE(id), say(`its outbox ${bad}, so its work is not pushed`)); continue; }
    const path = join(outbox, bundleName(card));
    let st;
    try { st = stat(path); } catch (e) {
      if (e?.code === 'ENOENT') continue;
      tell(PUSH_TROUBLE_CAUSE(id), say(`its bundle could not be looked at (${e?.code ?? 'unknown error'})`));
      continue;
    }
    // Not a plain file: pushCard refuses it with the reason, recorded and told below. A bundle stamped ahead of this
    // clock would never settle: it is told, and waits until the clock passes it (#536 r1 m6). The clock is read after
    // the look, so a bundle written during an earlier push is not ahead of it; FUTURE_SKEW_MS more is allowed for the
    // file system's own stamp (#536 r2 Minor 4).
    const tn = clock();
    const age = tn - st.mtimeMs;
    if (st.isFile() && age < -FUTURE_SKEW_MS) { tell(PUSH_TROUBLE_CAUSE(id), say(`its bundle is stamped ${Math.ceil(-age / 1000)} s in the future, so it waits until this Mac's clock passes it`)); out.waiting.push([card, 'the bundle is stamped in the future']); continue; }
    if (st.isFile() && age < SETTLE_MS) { out.waiting.push([card, 'the bundle changed a moment ago']); continue; }
    const why = bundleHeld({ id, card, role: s.doc.role }, path, { readFact: factReader(rec), readSession: sessionReader(rec), hashOf });
    if (why === null) { clear(PUSH_WAIT_CAUSE(card, att), PUSH_REFUSED_CAUSE(card, att), PUSH_HEAD_CAUSE(card, att), PUSH_TROUBLE_CAUSE(id)); continue; }
    if (why === 'record-unreadable' || why === 'bundle-no-attempt' || why === 'file-unreadable') {
      tell(PUSH_TROUBLE_CAUSE(id), say(`whether its bundle was pushed can't be told (${why}), so it is not pushed`));
      continue;
    }
    // bundle-not-pushed, bundle-changed or not-a-plain-file: the attempt's last answer says whether to try now.
    const last = rec.read('fact', PUSH_FACT(card, att));
    // A backstop: bundleHeld reads this same fact and answers record-unreadable first (plant: removing it fails nothing).
    if (last?.corrupt) { tell(PUSH_TROUBLE_CAUSE(id), say('its push record can\'t be read, so it is not pushed')); continue; }
    const d = last?.doc;
    const tried = lastTry(d, tn);
    // A call after the last recorded try left no fact (#536 r2 Minor 5): the same bytes wait RETRY_MS from it, told.
    const called = calledAt(card, att, tn);
    if (called !== null && (tried.at === null || called > tried.at) && (!st.isFile() || st.mtimeMs <= called) && tn - called < RETRY_MS) {
      tell(PUSH_WAIT_CAUSE(card, att), say(`its last push, ${Math.round((tn - called) / 60_000)} min ago, left no answer in the Record (the push script failed, or was cut off). It is tried again every ${RETRY_MS / 60_000} minutes`));
      out.waiting.push([card, 'its last push left no answer']); continue;
    }
    // The same bytes as at the last try: its mtime not after it. Bytes other than those pushed (bundle-changed) are the
    // same only when the last answer was a refusal of them (#536 r2 Minor 2): a refusal after the bytes changed was of
    // these bytes, so they are not pushed again until the worker writes new ones. New bytes are a new try.
    const same = tried.at !== null && (!st.isFile() || st.mtimeMs <= tried.at) && (why !== 'bundle-changed' || Boolean(tried.refusal));
    if (same && tried.refusal && !tried.refusal.retry) { tell(PUSH_REFUSED_CAUSE(card, att), say(`its push was refused: ${short(tried.refusal.reason)}. It is not tried again until the work changes`)); out.refused.push([card, tried.refusal.reason]); continue; }
    // Any other try of these same bytes is spaced (#536 r1 M1): a wait, or a push made but not taken (its head).
    if (same && tn - tried.at < RETRY_MS) {
      const head = d?.result === 'pushed' && Boolean(d.head_refused);
      if (head) tellHead(card, att, d, say);
      const reason = tried.refusal?.reason ?? (head ? 'the card\'s head could not be noted' : 'its push was made but not taken');
      if (tried.refusal || !head) tell(PUSH_WAIT_CAUSE(card, att), say(`its push waits: ${short(reason)}. It is tried again every ${RETRY_MS / 60_000} minutes`));
      out.waiting.push([card, reason]); continue;
    }
    if (calls >= maxPushes) { out.waiting.push([card, 'its turn is a later round']); continue; }
    calls += 1;
    // Marked before the call, so a call that leaves no fact is still spaced (#536 r2 Minor 5). A mark that can't be
    // written is not a reason to push unspaced: told, and not pushed.
    let mark;
    try {
      const cur = rec.read('fact', PUSH_CALLED_FACT(card, att));
      mark = rec.write({ actor: 'workshop', entity: 'fact', id: PUSH_CALLED_FACT(card, att), expectRev: cur?.rev ?? 0, doc: { card, attempt: att, session: id, at: new Date(tn).toISOString() }, kind: 'push_called' });
    } catch (e) { mark = { ok: false, reason: String(e?.message ?? e) }; }
    if (!mark?.ok) {
      tell(PUSH_TROUBLE_CAUSE(id), say(`its push could not be marked as tried (${short(mark?.reason ?? 'no reason given')}), so it is not pushed`));
      out.waiting.push([card, 'its push could not be marked as tried']); continue;
    }
    let r;
    try { r = await pushCard(id); } catch (e) { r = { ok: false, retry: true, reason: `the push script failed: ${short(e?.message ?? e)}` }; }
    // The fact as the push left it: a push made whose head could not be noted is not taken, and is tried again in RETRY_MS
    // (step 4), so it is told on its own cause, never as done (#536 r1 M1).
    let after = null;
    try { const f = rec.read('fact', PUSH_FACT(card, att)); after = f?.corrupt ? null : f?.doc ?? null; } catch { after = null; }
    const headStuck = after?.result === 'pushed' && Boolean(after.head_refused);
    // A final refusal is told as refused below (not tried again until the work changes), never as a head tried again.
    if (headStuck && (r?.ok === true || r?.retry)) tellHead(card, att, after, say); else clear(PUSH_HEAD_CAUSE(card, att));
    if (r?.ok === true && headStuck) {
      out.waiting.push([card, 'the card\'s head could not be noted']);
      clear(PUSH_WAIT_CAUSE(card, att), PUSH_REFUSED_CAUSE(card, att), PUSH_TROUBLE_CAUSE(id));
      if (!r.pr) tell(PR_WAIT_CAUSE(r.branch), say(`its branch ${r.branch} was pushed, but no pull request was opened for it yet. It is asked for again every ${RETRY_MS / 60_000} minutes`));
      else clear(PR_WAIT_CAUSE(r.branch));
    } else if (r?.ok === true) {
      out.pushed.push(card);
      clear(PUSH_WAIT_CAUSE(card, att), PUSH_REFUSED_CAUSE(card, att), PUSH_TROUBLE_CAUSE(id));
      // Pushed with no pull request: Joe would never hear of the work (GitHub tells him of a pull request, not a branch).
      // The PR writer recorded it pending; the retry below asks again every RETRY_MS, told on the branch's own cause.
      if (!r.pr) tell(PR_WAIT_CAUSE(r.branch), say(`its branch ${r.branch} was pushed, but no pull request was opened for it yet. It is asked for again every ${RETRY_MS / 60_000} minutes`));
      else clear(PR_WAIT_CAUSE(r.branch));
    } else if (r?.retry) {
      out.waiting.push([card, r?.reason]);
      tell(PUSH_WAIT_CAUSE(card, att), say(`its push waits: ${short(r?.reason)}. It is tried again every ${RETRY_MS / 60_000} minutes`));
    } else {
      out.refused.push([card, r?.reason]);
      clear(PUSH_WAIT_CAUSE(card, att));
      tell(PUSH_REFUSED_CAUSE(card, att), say(`its push was refused: ${short(r?.reason ?? 'no reason given')}. It is not tried again until the work changes`));
    }
  }

  function tellHead(card, att, doc, say) {
    return tell(PUSH_HEAD_CAUSE(card, att), say(`its branch ${short(doc.branch)} was pushed, but the card's head could not be noted (${short(doc.head_refused)}), so the push is not taken and is made again every ${RETRY_MS / 60_000} minutes`));
  }

  // Pull requests a push left unopened (L1082 Q6): asked for again, each told until it opens (I3, I5).
  if (prs) {
    let r = null;
    try { r = await prs.retryPending({ getToken, repos, every: RETRY_MS }); } catch (e) {
      tell(PR_TROUBLE_CAUSE, `pull requests left unopened by a push could not be asked for again: ${short(e?.message ?? e)}`);
    }
    if (r) {
      clear(PR_TROUBLE_CAUSE);
      for (const b of r.opened) { out.prs.push(b); clear(PR_WAIT_CAUSE(b)); }
      for (const [b, why, since] of r.waiting) tell(PR_WAIT_CAUSE(b), `branch ${b} was pushed${since ? ` (${since})` : ''}, but its pull request is not open yet: ${short(why)}. It is asked for again every ${RETRY_MS / 60_000} minutes`);
      for (const id of r.unreadable) tell(PR_TROUBLE_CAUSE, `the pull request record ${id} can't be read, so whether that pull request is open is not known`);
    }
  }
  return out;
}
