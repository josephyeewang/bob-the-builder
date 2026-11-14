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
//   4. the attempt's last answer (its push fact) says whether to try now. A final refusal of these same bytes (the bundle
//      not changed since it, by pastTime, I4) is not tried again: it stays told, on the hold cadence. A refusal that may
//      pass by itself (retry) is tried again once RETRY_MS has passed since it, told on the hold cadence meanwhile;
//   5. pushCard(sessionId). Its answer: pushed clears both holds; `retry` is the wait hold; any other refusal is the
//      refused hold. Each hold is holdAlert's: told at once, then once a day while it lasts (I3), marked told only once
//      delivered. A hold the queue refused is said in `untold`, so robot-main's failed-pass tell carries it (I5).
//   6. pull requests a push left unopened (pr-writer.mjs pending facts) are asked for again every RETRY_MS; each is told
//      on its branch's cause until it opens, then cleared (L1082 Q6).
// At most `maxPushes` pushCard calls a round (oldest launch first): a push fetches from GitHub and runs the secret scan,
// and the pass has robot-main's 120 s. The rest wait a minute for the next round; nothing is skipped for ever, since a
// session pushed (or refused) leaves the front of the line.
//
// FAIL CLOSED (I1). A Record whose session list can't be read throws: the pass fails, and robot-main tells it. A fact or
// session that can't be read, or a bundle that can't be hashed, is told for that session and the next one still runs.
// Known limit: the Record's list leaves out a document it can't read (M9 store list), so a damaged session doc is not
// seen here. It is not silent: the worker runner keeps that outbox open, and its drain tells the cause (record-unreadable
// or bundle-no-attempt).

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { PUSH_RETRY_MS as RETRY_MS, bundleName, PUSH_FACT, SETTLE_MS } from '../modules/M4-workshop/git/push.mjs';
import { WORKER_OUTBOX_ROLES, outboxProblemFor } from '../modules/M4-workshop/git/session-outbox.mjs';
import { PRODUCT_OUTBOX_ROLES } from '../shared/product-paths.mjs';
import { pastTime } from '../shared/still-waiting.mjs';
import { holdAlert, HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { dropCause } from '../modules/M11-dispatcher/alerts.mjs';
import { bundleHeld, fileSha256 } from './runner-ports.mjs';

// A refusal that may pass by itself (GitHub, the mirror, the start gate) is tried again this long after it, not every
// minute: each try fetches from GitHub. The research copy's own retry (M11 research-intake.mjs) is the same one,
// push.mjs's PUSH_RETRY_MS (I7: one home).
export { RETRY_MS };
export const MAX_PUSHES = 1;
// One cause per session attempt and kind, so a new attempt or new bytes are told afresh and each wait is its own.
export const PUSH_WAIT_CAUSE = (card, att) => `push-wait-${card}-${att}`;
export const PUSH_REFUSED_CAUSE = (card, att) => `push-refused-${card}-${att}`;
export const PUSH_TROUBLE_CAUSE = (session) => `push-trouble-${session}`;
// A branch pushed with no pull request yet, per branch (a card's branch outlives its attempts); one cause for a retry
// that can't run at all.
export const PR_WAIT_CAUSE = (branch) => `push-pr-${String(branch).replace(/[^a-z0-9-]/g, '-')}`;
export const PR_TROUBLE_CAUSE = 'push-pr-retry';
const CARD_OK = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const short = (s) => String(s ?? '').slice(0, 300);

const gone = (problem) => /ENOENT/.test(problem);

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
  };
  const clear = (...causes) => { for (const c of causes) { try { drop(rec, HOLD_FACT(c)); } catch { /* a stale queued copy is told at most once more */ } } };

  const mine = all.filter((s) => s?.doc?.product === product && PRODUCT_OUTBOX_ROLES.includes(s.doc.role))
    // Oldest launch first, so no session waits behind newer ones for ever (pastTime: a bad time sorts first, never last).
    .sort((a, b) => (pastTime(a.doc.launched_at, t) ?? -Infinity) - (pastTime(b.doc.launched_at, t) ?? -Infinity));
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
    // Not a plain file: pushCard refuses it with the reason, recorded and told below.
    if (st.isFile() && t - st.mtimeMs < SETTLE_MS) { out.waiting.push([card, 'the bundle changed a moment ago']); continue; }
    const why = bundleHeld({ id, card, role: s.doc.role }, path, { readFact: factReader(rec), readSession: sessionReader(rec), hashOf });
    if (why === null) { clear(PUSH_WAIT_CAUSE(card, att), PUSH_REFUSED_CAUSE(card, att), PUSH_TROUBLE_CAUSE(id)); continue; }
    if (why === 'record-unreadable' || why === 'bundle-no-attempt' || why === 'file-unreadable') {
      tell(PUSH_TROUBLE_CAUSE(id), say(`whether its bundle was pushed can't be told (${why}), so it is not pushed`));
      continue;
    }
    // bundle-not-pushed, bundle-changed or not-a-plain-file: the attempt's last answer says whether to try now.
    const last = rec.read('fact', PUSH_FACT(card, att));
    // A backstop: bundleHeld reads this same fact and answers record-unreadable first (plant: removing it fails nothing).
    if (last?.corrupt) { tell(PUSH_TROUBLE_CAUSE(id), say('its push record can\'t be read, so it is not pushed')); continue; }
    const d = last?.doc;
    const lastAt = d ? pastTime(d.at, t) : null;
    if (d?.result === 'refused' && lastAt !== null) {
      // The same bytes as at the refusal: its mtime not after it. New bytes from the worker are a new try.
      const same = !st.isFile() || st.mtimeMs <= lastAt;
      if (same && !d.retry) { tell(PUSH_REFUSED_CAUSE(card, att), say(`its push was refused: ${short(d.reason)}. It is not tried again until the work changes`)); out.refused.push([card, d.reason]); continue; }
      if (same && t - lastAt < RETRY_MS) { tell(PUSH_WAIT_CAUSE(card, att), say(`its push waits: ${short(d.reason)}. It is tried again every ${RETRY_MS / 60_000} minutes`)); out.waiting.push([card, d.reason]); continue; }
    }
    if (calls >= maxPushes) { out.waiting.push([card, 'its turn is a later round']); continue; }
    calls += 1;
    let r;
    try { r = await pushCard(id); } catch (e) { r = { ok: false, retry: true, reason: `the push script failed: ${short(e?.message ?? e)}` }; }
    if (r?.ok === true) {
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
