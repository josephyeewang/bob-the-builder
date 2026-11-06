// A proposal's way through at the first cutover (R-0b-128 part 2; lead call L325). The intake (proposals-intake.mjs)
// asks docsCheck whether a proposal's change is the docs lane's; anything else stays with MAIN, who merges code by hand.
//
// The list of files is the push script's own, read from the bytes the intake holds (L77 m1), never one a proposal
// declares. The answer is M10's, the same rule the merge gate asks at merge, so the two can't disagree on what a docs
// change is.
//
// Only a real answer about the change is final (L597 (2)). Anything that may pass by itself is a wait: the look could
// not finish, the card could not be read this once, the bytes moved during the check, or M10 refused for a reason that
// is not the change (a pause, an hours window, its own error). The intake keeps the file and tells Joe once, then daily.
//
//   createDocsCheck({ record, rules, pushProposal }) -> docsCheck({ product, card, bundle })
//     null                 the change is the docs lane's
//     'why'                it is not: MAIN merges it by hand (FIRST_CUTOVER at the intake)
//     { refuse: 'why' }    the push script's look refused the bundle for good (it touches a file no card may, say)
//     { retry: 'why' }     nothing final could be said this pass: the file waits
//
// A proposal's way to review (R-0b-128 part 2, L549), at either cutover. `toReview` is the intake's last step and only
// takes the card, at the revision the intake checked, so a card changed since is refused. The rest is proposalRoutePass,
// every pass, from wherever the card is (the shape of routeCopy, L387): push, then the moves to running and in_review,
// so a stop anywhere is picked up next pass. A push that can't finish is tried every pass; told past ROUTE_TELL_MS, then
// daily. While it waits the route beats for its own claim (the Dispatcher's tab_heartbeat), so the claim does not lapse
// into the pool workers are launched from (L718 M1); M9's running limit still lapses it, and a lapsed claim is taken
// again from ready.
//
// No end but a cancel is quiet (L718 M1). A push refused for good gives the card back to ready ('refused'); a card lost
// to another holder, or moved anywhere but cancelled ('lost'), ends the route. Either is told once, and the intake then
// takes a new proposal and bundle under the same names (routeReopened). A cancel ends it quietly ('over'), names kept.
// A refusal after a push that already reached GitHub is a stop, not an end: that card's branch holds the first bundle.
//
// Words from outside (the push script's reasons, which can quote file names the proposer wrote) are cut and fenced
// once, as the intake fences the same words from the docs check (shownName; R-0b-126, L597 (3)); the Record's own
// reasons are cut (plainError), so no local path reaches an alert, the route fact or the diary (L718 M2, m1, m2).
//
//   createToReview({ host, now }) -> toReview({ rec, product, card, cardRev, bundle }) -> { ok, reason? }
//   proposalRoutePass({ rec, pushProposal, alert, now, host }) -> [[card, what happened]]
//   routeReopened(rec, card) -> true once the route ended refused or lost: the proposal's names take new bytes

import { plainError, PUSH_FACT, PROPOSAL_ATTEMPT } from '../M4-workshop/git/push.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';
import { hostname } from 'node:os';
import { move } from './moves.mjs';
import { tellThen, dropCause, isQueued } from './alerts.mjs';
import { TAB_HEARTBEAT_FAMILY } from '../M9-record/permissions.mjs';
import { HOLD_FACT, putFact, writeLaunch } from './pass.mjs';
import { lapsedRun } from './research-intake.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';

// The start of M10's one answer that is about the change itself (engine.mjs mergeDocsLane). Any other deny is about the
// product or the rules at this moment, and passes by itself.
export const NOT_THIS_LANE = 'not this lane\'s change';
// M10's docs-lane check says these when its rules can't be read or name no lane (lane-check.mjs docsLaneProblem): a
// rules fault worded as an answer about the change. Fixed in the rules, the same bytes pass, so each is a wait (L669).
// "could not be read (...)" is M10's catch-all for a check that threw: always a wait here, even if the change itself had
// made it throw. With git's own path strings nothing in the change can make problem() throw today (r2 cosmetic 2); a
// check that could would need its own answer here.
const LANE_RULES_FAULTS = [/^could not be read \(/, /^no readable rules$/, /^the rules name no docs or research lane$/];
const LANE_PREFIX = `${NOT_THIS_LANE}; MAIN merges it as today: `;

/** The proposal's run: names the tab claim and the launch record. One per card and bytes, so a retry finds its own. */
export const ROUTE_RUN = (card, sha) => `prop-${card}-${PROPOSAL_ATTEMPT(sha)}`;
export const ROUTE_ROLE = 'proposal_run';
export const ROUTE_FACT = (card) => HOLD_FACT(`proposal-route-${card}`);
const ROUTE_PREFIX = ROUTE_FACT('');
/** Where the told mark goes while the route facts can't be listed. Outside ROUTE_PREFIX, so it is never taken as a route. */
export const ROUTE_LIST_FACT = HOLD_FACT('proposal-routes-unread');
/** The route's own beat for its claim, in the Dispatcher's heartbeat family (M9 lapseClaims counts only those). */
export const ROUTE_BEAT = (run) => `${TAB_HEARTBEAT_FAMILY}${run}`;
/** A blip is the next pass's to fix: the owner hears only of a push still not done after this long. */
export const ROUTE_TELL_MS = 60 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
// Where a card can be while its route is open. Anywhere else, the route is over.
const ROUTE_STATES = Object.freeze(['ready', 'claimed', 'running']);

// The ends that give the proposal's names back: its bytes went nowhere, and Joe is told to send it again.
const REOPENS = Object.freeze(['refused', 'lost']);
export const routeReopened = (rec, card) => REOPENS.includes(rec.read('fact', ROUTE_FACT(card))?.doc?.ended);

/** A file name, or any words from outside, as an alert or the diary may show them: one line, stripped, masked, fenced
 * (R-0b-126, probe P7). One definition: the intake uses it for its names and the docs check's reasons. */
export const shownName = (name) => cleanOutside(name, 'proposal-name');
/** An answer's text, or `none` when it has none: an empty or odd answer never reads as a pass, nor as "[object Object]". */
export const textOr = (v, none) => (typeof v === 'string' && v.trim() ? v : none);
// The push script's reason as it may be told and stored: local paths cut first, then fenced (a cut after the fence
// would break its closing tag).
const pushSaid = (why, none) => shownName(plainError(textOr(why, none)));
// A Record reason: the Record's own words, but they can name its files.
const cut = (why) => plainError(why ?? 'no answer');

const claimFor = (run, host) => ({ kind: 'tab', claim_id: run, host });

export function createToReview({ host = hostname(), now = Date.now } = {}) {
  return async function toReview({ rec, product, card, cardRev, bundle }) {
    const sha = bundle?.sha256;
    if (typeof sha !== 'string' || !SHA256.test(sha)) return { ok: false, reason: 'the proposal has no checked bundle' };
    const c = rec.read('card', card);
    if (!c?.doc || c.corrupt) return { ok: false, reason: `card ${card} could not be read` };
    if (c.rev !== cardRev) return { ok: false, reason: `card ${card} changed since it was checked` };
    const run = ROUTE_RUN(card, sha);
    const took = rec.write({ actor: 'dispatcher', entity: 'card', id: card, expectRev: cardRev, doc: { ...c.doc, state: 'claimed', claim: claimFor(run, host) }, kind: 'claim' });
    if (!took.ok) return { ok: false, reason: cut(took.reason) };
    // After the claim: an open route on a card this proposal never took would take it later. A stop here leaves a
    // claim with no route, which lapses to ready, and the intake says the file was interrupted.
    const id = ROUTE_FACT(card);
    const seen = rec.read('fact', id);
    const w = putFact(rec, id, { product, card, sha256: sha, run, since: new Date(now()).toISOString(), ended: null, reason: null, told_end: null, told_at: null }, 'proposal_route', seen?.corrupt ? undefined : seen?.doc);
    if (w?.ok) return { ok: true };
    const back = rec.release({ card, session_id: run, reason: 'its route could not be recorded' });
    return { ok: false, reason: `its route could not be recorded (${cut(w?.reason)})${back?.ok ? '' : '; the card is held until its claim lapses'}` };
  };
}

// One step of the route. -> null, or why it stopped.
function toRunning(rec, c) {
  const m = move(rec, 'card', c.id, { state: 'running' }, { kind: 'started' });
  return m.ok ? null : cut(m.reason);
}
function handIn(rec, c, run, product, now) {
  if (!rec.read('launch', run)) {
    const l = writeLaunch(rec, { sessionId: run, role: ROUTE_ROLE, kind: ROUTE_ROLE, card: c.id, head: c.doc.head, rev: c.rev, product, now });
    if (!l.ok) return `its launch could not be recorded (${cut(l.reason)})`;
  }
  const { claim: _claim, ...rest } = c.doc;
  const w = rec.write({ actor: 'dispatcher', entity: 'card', id: c.id, expectRev: c.rev, doc: { ...rest, state: 'in_review' }, kind: 'proposal_handed_in' });
  return w.ok ? null : cut(w.reason);
}

// Keeps the route's claim from lapsing while its push waits (L718 M1). A beat that can't be written is not a stop: the
// claim may lapse, and then it is taken again from ready, or the route ends lost and Joe is told.
function beat(rec, run, now) {
  const id = ROUTE_BEAT(run);
  try {
    const cur = rec.read('fact', id);
    if (cur?.corrupt) return;
    putFact(rec, id, { type: 'tab_heartbeat', claim_id: run, at: new Date(now).toISOString() }, 'tab_heartbeat', cur?.doc);
  } catch { /* as a refusal: see above */ }
}

// Whether this proposal's bytes already reached GitHub: then its card's branch holds them, and a later refusal must not
// give the card back nor open the names (L718 m4). One that can't be read counts as reached.
function pushedBefore(rec, card, sha) {
  try {
    const f = rec.read('fact', PUSH_FACT(card, PROPOSAL_ATTEMPT(sha)));
    return Boolean(f?.corrupt) || f?.doc?.result === 'pushed';
  } catch { return true; }
}

async function routeOne({ rec, pushProposal, id, doc, now, host }) {
  const { product, card, run } = doc;
  const read = () => rec.read('card', card);
  let c = read();
  if (!c?.doc || c.corrupt) return { stopped: `card ${card} could not be read` };
  if (lapsedRun(c.doc)) {
    const back = move(rec, 'card', card, { state: 'ready' }, { kind: 'proposal_run_lapsed' });
    if (!back.ok) return { stopped: `its lapsed run could not be taken back (${cut(back.reason)})` };
    c = read();
  }
  // Handed in already, by this route (its launch record is its own): a hand-in whose answer was lost is not a loss.
  if (c.doc.state === 'in_review' && rec.read('launch', run)?.doc) return { sent: true };
  if (c.doc.state === 'cancelled') return { over: 'card is cancelled' };
  if (!ROUTE_STATES.includes(c.doc.state)) return { lost: `the card is ${c.doc.state} now` };
  if (c.doc.state === 'ready') {
    // Its claim lapsed while the push could not finish. The Record's ready check runs again here.
    const w = rec.write({ actor: 'dispatcher', entity: 'card', id: card, expectRev: c.rev, doc: { ...c.doc, state: 'claimed', claim: claimFor(run, host) }, kind: 'claim' });
    if (!w.ok) return { stopped: `the card could not be taken again (${cut(w.reason)})` };
    c = read();
  } else if (c.doc.claim?.claim_id !== run) return { lost: 'someone else holds the card' };
  beat(rec, run, now);
  if (c.doc.state === 'claimed') {
    let r;
    // A throw is a retry; its words are cut and fenced below with every other push reason (pushSaid), once.
    try { r = await pushProposal({ product, card }); } catch (e) { r = { ok: false, retry: true, reason: String(e?.message ?? e) }; }
    if (!r?.ok && !r?.retry) {
      // One value, cut and fenced, for the release, the route fact and Joe (L718 m2).
      const said = pushSaid(r?.reason, 'no reason given');
      if (pushedBefore(rec, card, doc.sha256)) return { stopped: `its push was refused (${said}), but an earlier push of these bytes reached GitHub, so the card is kept` };
      const back = rec.release({ card, session_id: run, reason: `push refused: ${said}` });
      if (!back?.ok) return { stopped: `its push was refused (${said}) and the card could not be given back (${cut(back?.reason)})` };
      return { refused: said };
    }
    if (!r.ok) return { stopped: pushSaid(r.reason, 'the push could not finish') };
    c = read();
    if (c?.doc?.head !== r.tip) return { stopped: `the push reached GitHub but the card's head was not written` };
    const why = toRunning(rec, c);
    if (why) return { stopped: why };
    c = read();
  }
  const why = handIn(rec, c, run, product, now);
  return why ? { stopped: why } : { sent: true };
}

// After its queued telling is dropped (dropCause, at each site): told_at goes, so a wait that comes back is told afresh.
function untold(rec, id) {
  const cur = rec.read('fact', id);
  if (cur?.doc?.told_at != null) putFact(rec, id, { ...cur.doc, told_at: null }, 'hold_cleared', cur.doc, ['told_at']);
}

// The route facts, or why they can't be listed. The Record answers a list it can't read with one corrupt entry and
// no id (shared/record.mjs makeRecord).
function routeIds(rec) {
  let all;
  try { all = rec.list('fact'); } catch (e) { return { why: plainError(e?.message ?? e) }; }
  if (!Array.isArray(all)) return { why: 'the Record gave no list' };
  const bad = all.find((f) => typeof f?.id !== 'string');
  if (bad) return { why: cut(bad?.reason ?? 'an entry with no name') };
  return { ids: all.map((f) => f.id).filter((x) => x.startsWith(ROUTE_PREFIX)) };
}

/** Takes every open route one step further. A corrupt route fact is the Record's to report. */
export async function proposalRoutePass({ rec, pushProposal, alert, now, host = hostname() }) {
  if (!Number.isFinite(now)) throw new Error('proposalRoutePass needs the pass\'s clock (now)');
  // A list that can't be read: no route moves this pass, and Joe is told, then daily, until it reads (L718 m3).
  const listed = routeIds(rec);
  stillWaiting({
    now,
    waiting: Boolean(listed.why),
    read: () => rec.read('fact', ROUTE_LIST_FACT)?.doc,
    tell: (fields) => {
      const text = `The proposals on their way to review could not be listed, so none moves until they can: ${listed.why}.`;
      return tellThen(alert, text, { fact: ROUTE_LIST_FACT, fields: { text, ...fields }, kind: 'hold_alert' });
    },
    clear: () => { dropCause(rec, ROUTE_LIST_FACT); untold(rec, ROUTE_LIST_FACT); },
  });
  if (listed.why) return [['routes', `could not be listed: ${listed.why}`]];
  const out = [];
  for (const id of listed.ids) {
    const f = rec.read('fact', id);
    if (!f?.doc || f.corrupt) { out.push([id, 'its route could not be read']); continue; }
    const doc = f.doc;
    const { product, card } = doc;
    if (doc.ended) {
      // Told once, and again only if the telling never went out: a stop after the card was given back still tells.
      if (REOPENS.includes(doc.ended) && !doc.told_end && !isQueued(rec, id)) tellEnd(rec, alert, id, doc);
      continue;
    }
    const r = await routeOne({ rec, pushProposal, id, doc, now, host });
    stillWaiting({
      now,
      waiting: Boolean(r.stopped),
      after: { since: doc.since, limit: ROUTE_TELL_MS },
      read: () => rec.read('fact', id)?.doc,
      tell: (fields) => {
        const text = `${product}: the proposal for card ${card} has not reached review: ${r.stopped}.`;
        return tellThen(alert, text, { fact: id, fields: { text, ...fields }, kind: 'hold_alert' });
      },
      clear: () => { dropCause(rec, id); untold(rec, id); },
    });
    if (r.stopped) { out.push([card, `not sent to review: ${r.stopped}`]); continue; }
    const ended = r.refused ? 'refused' : r.sent ? 'sent' : r.lost ? 'lost' : 'over';
    const reason = r.refused ?? r.lost ?? r.over ?? null;
    const cur = rec.read('fact', id);
    const w = putFact(rec, id, { ...cur?.doc, ended, reason }, 'proposal_route_end', cur?.doc);
    if (!w?.ok) { out.push([card, `its route's end could not be recorded (${cut(w?.reason)})`]); continue; }
    if (REOPENS.includes(ended)) tellEnd(rec, alert, id, rec.read('fact', id).doc);
    out.push([card, r.sent ? 'sent to review' : r.refused ? `refused: ${r.refused}` : r.lost ? `dropped: ${r.lost}` : `route over: ${r.over}`]);
  }
  return out;
}

function tellEnd(rec, alert, id, doc) {
  const text = doc.ended === 'lost'
    ? `${doc.product}: the proposal for card ${doc.card} was dropped before review, and was not used: ${doc.reason}. Send a new proposal and bundle once the card is ready again.`
    : `${doc.product}: the proposal for card ${doc.card} was refused at the push, and the card is back to ready: ${doc.reason}. Send a new proposal and bundle to try again.`;
  return tellThen(alert, text, { fact: id, fields: { told_end: true }, kind: 'proposal_told' });
}

export function createDocsCheck({ record, rules, pushProposal }) {
  return async function docsCheck({ product, card, bundle }) {
    const seen = await pushProposal({ product, card }, { look: true });
    if (!seen.ok) return seen.retry ? { retry: seen.reason } : { refuse: seen.reason };
    // The look read the fact again: bytes that changed since this pass checked them are for the next pass to judge.
    if (seen.sha256 !== bundle?.sha256) return { retry: 'the bundle held changed while it was checked' };
    let c;
    try { c = record.read('card', card); } catch (e) { return { retry: `card ${card} could not be read (${plainError(e?.message ?? e)})` }; }
    if (!c?.doc || c.corrupt) return { retry: `card ${card} could not be read` };
    const d = rules.may('merge', { product, card: { id: card, ...c.doc }, truncated: false, labels: [], declared_tier: c.doc.tier, kind: c.doc.kind, files: seen.files });
    if (d.decision === 'allow') return null;
    // An ask is about the change too (a deep check that wants a person): it is not the docs lane's.
    const reason = String(d.reason);
    if (reason.startsWith(LANE_PREFIX) && LANE_RULES_FAULTS.some((re) => re.test(reason.slice(LANE_PREFIX.length)))) return { retry: `the rules could not say: ${plainError(reason.slice(LANE_PREFIX.length))}` };
    if (d.decision === 'ask' || reason.startsWith(NOT_THIS_LANE)) return reason;
    return { retry: `the rules said no for now: ${plainError(reason)}` };
  };
}
