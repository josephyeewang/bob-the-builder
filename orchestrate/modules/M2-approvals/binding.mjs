// binding.mjs — when a tap of the owner's counts (R-0b-48; 0b-5 spec review round 1 M1, round 2 M2-1/M2-2/m2-1/m2-5,
// round 3 M3-1/m3-6/m3-7, round 4 M4-1/m4-1/m4-3/m4-4, round 5 M5-1/M5-2/M5-3/m5-2/m5-3).
//
// WHAT COUNTS. A tap counts only as the answer to a question box M2 worded (payload.mjs), asked in a Front Door or
// thinking session the Dispatcher launched, read from M2's tamper-checked copy of that session's log. In order:
//   1. Binding. An AskUserQuestion call whose input canonicalises to exactly the ask's `payload` or `payload_still_open`,
//      at or after the ask's created_at, while the ask is open or pushed, with no other live box for that ask anywhere and
//      none for any ask in that session. Binding counts as delivering the ask (M5-1): open → pushed in the same write,
//      first_pushed_at and raised_at set if unset. Anything else that names an ask is `mismatched_question` (binds nothing).
//   2. The answer. The tool result for exactly that box (tool_use_id), in the same session, while the ask is still
//      pushed and before it lapses, holding exactly that question and one answer exactly equal (case-sensitive) to one
//      of the ask's choices. M10 must also allow the channel (count_approval). Then the ask is answered and the box is
//      `answered` for good.
//   3. Anything else on the box releases it: a non-choice answer (typed "Other"), a declined box, the session replaced or
//      ended, a tampered log, or the ask moving on (lapse, withdrawn, expired, answered through another box). A release
//      moves the ask back to open only when the ask is pushed and this was its live box (M5-2), clocks unchanged.
//   Never counted: plain typed text, [watchdog]/[relay] lines, meta or sidechain entries, a result for another box, a
//   session not in the launch record, the Lead's session (m4-3), an "Other" answer.
//
// TYPED VS TAPPED (m4-4, m5-2). Checked 30 Oct 2026 against Claude Code 2.1.312's logs on this Mac: a tapped choice and
// a typed "Other" with the same words are stored identically (toolUseResult.answers holds only the text). So an exact,
// case-sensitive match to a choice counts as the tap; anything else releases the box. This is a claim about the tool
// and expires: R-0b-84's real phone capture re-checks it.
//
//   createAsk(ctx, { id, kind, card, title, choices?, recommended?, tier?, risky?, fingerprint?, files?, origin_session? })
//   const r = processSession(ctx, { sessionId, sourcePath })  → { ok, events: [{ type, ask, card, … }] }
//   releaseSessions(ctx) → events     release boxes whose session was replaced or ended (call each pass)
//   releaseBoxes(doc, reason, at, { keepState })   used by the schedule when it moves an ask on
//   ctx = { record, rules, product, copies, now: () => ms, alert }
//
// Events tell the Front Door what to say: `answered`, `released_typed` (typedReplyLine), `closed` (CLOSED_LINE),
// `mismatched_question`, `tampered`.

import { ownerTurns, QUESTION_TOOL } from '../M1-front-door/transcript.mjs';
import { canonicalJson } from '../../shared/plan-fingerprint.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { askIdOf, payloadSha, renderPayload } from './payload.mjs';
import { lapseAt, readConfig } from './kinds.mjs';

export const BOX_ROLES = Object.freeze(['front_door', 'thinking']);
const MAX_MISMATCHED = 20;
const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

// The launch that makes `sid` a box session, or why not (round 2 m2-1, round 4 m4-3, round 2 m2-5).
export function boxSession(record, sid) {
  const launches = record.list('launch').filter((l) => l?.doc && !l.corrupt);
  const mine = launches.filter((l) => l.doc.session_id === sid);
  if (!mine.length) return { ok: false, reason: 'not in the launch record' };
  const role = mine.at(-1).doc.role;
  if (!BOX_ROLES.includes(role)) return { ok: false, reason: `a ${role} session holds no approval box` };
  const s = record.read('session', sid);
  if (s?.doc?.state === 'ended') return { ok: false, reason: 'session ended', ended: true };
  if (role === 'front_door') {
    const latest = launches.filter((l) => l.doc.role === 'front_door').sort((a, b) => (ms(a.doc.launched_at) ?? 0) - (ms(b.doc.launched_at) ?? 0)).at(-1);
    if (latest.doc.session_id !== sid) return { ok: false, reason: 'a newer Front Door replaced this session', replaced: true };
  }
  return { ok: true, role };
}

const liveBox = (doc) => (doc.boxes ?? []).find((b) => b.status === 'bound') ?? null;

// Release every bound box on this ask document (mutates). `moveBack`: the ask is pushed and returns to open (M5-2);
// the schedule passes false when it is itself moving the ask on.
export function releaseBoxes(doc, reason, at, { moveBack = true, session = null } = {}) {
  let released = 0;
  for (const b of doc.boxes ?? []) {
    if (b.status !== 'bound' || (session && b.session_id !== session)) continue;
    Object.assign(b, { status: 'released', reason, closed_at: iso(at) });
    released++;
  }
  if (released && moveBack && doc.state === 'pushed') doc.state = 'open';
  return released;
}

function addMismatch(doc, box) {
  doc.boxes = [...(doc.boxes ?? []), box];
  const mism = doc.boxes.filter((b) => b.status === 'mismatched_question');
  if (mism.length > MAX_MISMATCHED) { const drop = mism[0]; doc.boxes = doc.boxes.filter((b) => b !== drop); }
}


// A new ask, open, with its box payloads written once (M5-3). GitHub kinds carry no payload; their answer is a review.
export function createAsk(ctx, { id, kind, card, title, choices, recommended, tier = null, risky = [], fingerprint, files, origin_session = null, extra = {} } = {}) {
  const k = activeKind(kind);
  if (!k) return { ok: false, reason: `unknown or inactive ask kind "${kind}"` };
  if (askStore(ctx.record).ask(id) || ctx.record.read('ask', id)) return { ok: false, reason: `ask ${id} already exists` };
  const doc = { kind, product: ctx.product, card, title, state: 'open', created_at: iso(ctx.now()), reask_count: 0, tier, risky, boxes: [], window_pushes: [], ...extra };
  if (origin_session !== null) doc.origin_session = origin_session;
  if (k.go) Object.assign(doc, { fingerprint, files });
  if (k.channel === 'tap') {
    const p = renderPayload({ askId: id, kind, card, title, choices, fingerprint, files });
    if (!p.ok) return p;
    doc.choices = p.payload.questions[0].options.map((o) => o.label);
    doc.recommended = recommended ?? doc.choices[0];
    if (!doc.choices.includes(doc.recommended)) return { ok: false, reason: 'the recommended choice is not one of the choices' };
    Object.assign(doc, { payload: p.payload, payload_sha256: p.payload_sha256, payload_still_open: p.payload_still_open, payload_still_open_sha256: p.payload_still_open_sha256 });
  } else if (choices !== undefined) {
    doc.choices = choices;
    if (recommended !== undefined) doc.recommended = recommended;
  }
  const w = writeDoc(ctx.record, 'ask', { id, rev: 0 }, doc);
  return w.ok ? { ok: true, id, rev: w.rev } : w;
}

export function processSession(ctx, { sessionId, sourcePath }) {
  const events = [];
  const nowMs = ctx.now();
  // Nothing counts while the owner's settings are missing (round 2 m2-6): the lines stay unread until they are fixed.
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) return { ok: false, reason: cfg.reason, events };
  const synced = ctx.copies.sync(sessionId, sourcePath);
  if (!synced.ok) return { ok: false, reason: synced.reason, events };
  if (synced.tampered) {
    // Every pending answer from this session is refused for good (round 1 M2(a)); its live boxes are released.
    for (const a of askStore(ctx.record).asks()) {
      const doc = a.doc;
      if (!(doc.boxes ?? []).some((b) => b.status === 'bound' && b.session_id === sessionId)) continue;
      releaseBoxes(doc, 'tampered', nowMs, { session: sessionId });
      const w = writeDoc(ctx.record, 'ask', a, doc);
      if (!w.ok) ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason });
    }
    // Marked told only once delivered: a lost alert (false, or a throw) is sent again next pass (L135 site B).
    if (synced.untold && ctx.alert({ type: 'transcript_tampered', session: sessionId }) !== false) { ctx.copies.told(sessionId); events.push({ type: 'tampered', session: sessionId }); }
    return { ok: true, events };
  }
  const sess = boxSession(ctx.record, sessionId);
  for (const { entry, end } of ctx.copies.pending(sessionId)) {
    if (sess.ok) handleEntry(ctx, sessionId, sess.role, entry, events);
    ctx.copies.done(sessionId, end);
  }
  return { ok: true, events };
}

function handleEntry(ctx, sid, role, e, events) {
  if (e.isMeta || e.isSidechain || e.isCompactSummary) return;
  if (e.sessionId !== undefined && e.sessionId !== sid) return;
  const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
  if (e.type === 'assistant') {
    for (const b of blocks) if (b?.type === 'tool_use' && b.name === QUESTION_TOOL) tryBind(ctx, sid, role, e, b, events);
    return;
  }
  const results = e.type === 'user' ? blocks.filter((b) => b?.type === 'tool_result') : [];
  if (results.length) { for (const b of results) answer(ctx, sid, e, b, events); return; }
  // The owner typed instead of tapping (a plain message, or one queued while a turn ran): it releases the session's live
  // box (M3-1). ownerTurns already leaves out [watchdog]/[relay] lines and text Claude Code injects.
  if (ownerTurns([e]).some((t) => t.kind === 'typed')) {
    for (const a of askStore(ctx.record).asks()) {
      if (!(a.doc.boxes ?? []).some((x) => x.status === 'bound' && x.session_id === sid)) continue;
      release(ctx, a, 'typed', sid, events);
    }
  }
}

function tryBind(ctx, sid, role, e, b, events) {
  const qs = Array.isArray(b.input?.questions) ? b.input.questions : [];
  const askId = qs.map((q) => askIdOf(q?.question)).find(Boolean);
  if (!askId) return;   // not one of M2's boxes (the session's own question)
  const st = askStore(ctx.record);
  const a = st.ask(askId);
  const at = Math.min(ms(e.timestamp) ?? ctx.now(), ctx.now());
  const mismatch = (reason) => {
    events.push({ type: 'mismatched_question', ask: askId, session: sid, reason });
    if (!a) return;
    if ((a.doc.boxes ?? []).some((x) => x.session_id === sid && x.tool_use_id === b.id)) return;
    addMismatch(a.doc, { session_id: sid, tool_use_id: b.id, status: 'mismatched_question', reason, at: iso(at) });
    const w = writeDoc(ctx.record, 'ask', a, a.doc);
    if (!w.ok) ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason });
  };
  if (!a) return mismatch('no such ask');
  const doc = a.doc;
  if ((doc.boxes ?? []).some((x) => x.tool_use_id === b.id && x.session_id === sid)) return;   // seen before
  const sha = payloadSha(b.input);
  const version = sha && sha === doc.payload_sha256 ? 'payload' : sha && sha === doc.payload_still_open_sha256 ? 'still_open' : null;
  if (!version) return mismatch('the box is not M2\'s exact question');
  if (doc.state !== 'open' && doc.state !== 'pushed') return mismatch(`the ask is ${doc.state}`);
  if (ms(doc.created_at) === null || ms(e.timestamp) === null || ms(e.timestamp) < ms(doc.created_at)) return mismatch('asked before the ask was created');
  if (ms(e.timestamp) >= lapseAt(doc)) return mismatch('the ask has lapsed');
  if (role === 'thinking' && doc.origin_session !== sid) return mismatch('a thinking room asks only its own questions');
  if (liveBox(doc)) return mismatch('the ask already has a live box');
  const busy = st.asks().some((o) => o.id !== a.id && (o.doc.boxes ?? []).some((x) => x.status === 'bound' && x.session_id === sid));
  if (busy) return mismatch('this session already has a live box');
  doc.boxes = [...(doc.boxes ?? []), { session_id: sid, tool_use_id: b.id, status: 'bound', version, bound_at: iso(at) }];
  if (doc.state === 'open') doc.state = 'pushed';
  if (!doc.first_pushed_at) doc.first_pushed_at = iso(at);
  if (!doc.raised_at || doc.raised_reask !== doc.reask_count) { doc.raised_at = iso(at); doc.raised_reask = doc.reask_count; }
  const w = writeDoc(ctx.record, 'ask', a, doc);
  if (!w.ok) { ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason }); return; }
  events.push({ type: 'bound', ask: a.id, card: doc.card, session: sid });
}

function release(ctx, a, reason, sid, events) {
  const doc = a.doc;
  const n = releaseBoxes(doc, reason, ctx.now(), { session: sid });
  if (!n) return;
  if (reason === 'typed') doc.released_typed = true;
  const w = writeDoc(ctx.record, 'ask', a, doc);
  if (!w.ok) { ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason }); return; }
  events.push({ type: reason === 'typed' ? 'released_typed' : 'released', reason, ask: a.id, card: doc.card, session: sid });
}

function answer(ctx, sid, e, b, events) {
  const st = askStore(ctx.record);
  const a = st.asks().find((o) => (o.doc.boxes ?? []).some((x) => x.session_id === sid && x.tool_use_id === b.tool_use_id && x.status !== 'mismatched_question'));
  if (!a) return;
  const doc = a.doc;
  const box = doc.boxes.find((x) => x.session_id === sid && x.tool_use_id === b.tool_use_id);
  if (box.status === 'answered') return;   // the same result read again
  if (box.status !== 'bound') { events.push({ type: 'closed', ask: a.id, card: doc.card, session: sid }); return; }
  const at = ms(e.timestamp);
  // The ask moved on while the box was open (m4-1): the box is released, nothing counts, and the owner is told.
  if (doc.state !== 'pushed' || at === null || at >= lapseAt(doc) || at < (ms(box.bound_at) ?? Infinity)) {
    const reason = doc.state === 'withdrawn' ? 'withdrawn' : doc.state === 'expired' ? 'expired' : doc.state === 'answered' || doc.state === 'consumed' ? 'answered_elsewhere' : 'lapsed';
    releaseBoxes(doc, reason, ctx.now(), { moveBack: false, session: sid });
    const w = writeDoc(ctx.record, 'ask', a, doc);
    if (!w.ok) ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason });
    events.push({ type: 'closed', ask: a.id, card: doc.card, session: sid });
    return;
  }
  if (b.is_error === true) return release(ctx, a, 'declined', sid, events);
  const bound = box.version === 'still_open' ? doc.payload_still_open : doc.payload;
  const q = bound?.questions?.[0]?.question;
  const r = e.toolUseResult;
  const answers = r && typeof r === 'object' && !Array.isArray(r) ? r.answers : null;
  let same = false;
  try { same = canonicalJson(r?.questions) === canonicalJson(bound.questions); } catch { same = false; }
  const keys = answers && typeof answers === 'object' && !Array.isArray(answers) ? Object.keys(answers) : [];
  const choice = same && keys.length === 1 && keys[0] === q && typeof answers[q] === 'string' ? answers[q] : null;
  if (choice === null || !(doc.choices ?? []).includes(choice)) return release(ctx, a, 'typed', sid, events);
  const verdict = ctx.rules.may('count_approval', { product: ctx.product, card: doc.card, ask_kind: doc.kind, channel: 'tap', tier: doc.tier ?? null, risky: doc.risky ?? [] });
  if (verdict.decision !== 'ask' || verdict.tier !== 2) {
    ctx.alert({ type: 'approval_not_counted', ask: a.id, reason: verdict.reason });
    return release(ctx, a, 'declined', sid, events);
  }
  Object.assign(box, { status: 'answered', closed_at: iso(ctx.now()) });
  doc.state = 'answered';
  doc.answer = { channel: 'tap', choice, approves: choice === doc.choices[0], session_id: sid, tool_use_id: b.tool_use_id, at: iso(at) };
  const w = writeDoc(ctx.record, 'ask', a, doc);
  if (!w.ok) { ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason }); return; }
  events.push({ type: 'answered', ask: a.id, card: doc.card, choice, session: sid });
}

// Release boxes whose session was replaced or ended (round 2 m2-5, round 3 m3-7). Run each pass.
export function releaseSessions(ctx) {
  const events = [];
  for (const a of askStore(ctx.record).asks()) {
    const sids = [...new Set((a.doc.boxes ?? []).filter((b) => b.status === 'bound').map((b) => b.session_id))];
    for (const sid of sids) {
      const s = boxSession(ctx.record, sid);
      if (s.ok) continue;
      const reason = s.ended ? 'session_ended' : 'session_replaced';
      const cur = askStore(ctx.record).ask(a.id);
      if (!cur) continue;
      releaseBoxes(cur.doc, reason, ctx.now(), { session: sid });
      const w = writeDoc(ctx.record, 'ask', cur, cur.doc);
      if (!w.ok) { ctx.alert({ type: 'approvals_write_refused', ask: a.id, reason: w.reason }); continue; }
      events.push({ type: 'released', reason, ask: a.id, card: a.doc.card, session: sid });
    }
  }
  return events;
}

// The ask the next question box in this session should show, or null (round 4 M4-1, round 5 m5-1). Urgent kinds first
// (undo, then incident_repair), then the card this reply is about, then the oldest. An ask with a live box anywhere is
// skipped; a non-urgent ask released in this same reply is held back to the next one (an urgent one may come straight
// back). A thinking room shows only its own questions. The box shows the "Still open" version once a typed reply was
// released (M4-1).
//   nextBox(ctx, { sessionId, role, card?, releasedThisReply?: [askIds] }) → { ask, card, payload, kind } | null
const URGENT_ORDER = ['undo', 'incident_repair'];
export function nextBox(ctx, { sessionId, role, card = null, releasedThisReply = [] } = {}) {
  if (!BOX_ROLES.includes(role)) return null;
  const nowMs = ctx.now();
  const held = new Set(releasedThisReply);
  const st = askStore(ctx.record);
  if (st.asks().some((a) => (a.doc.boxes ?? []).some((b) => b.status === 'bound' && b.session_id === sessionId))) return null;
  const urgentRank = (k) => { const i = URGENT_ORDER.indexOf(k); return i === -1 ? URGENT_ORDER.length : i; };
  const open = st.asks().filter(({ id, doc }) => {
    const k = activeKind(doc.kind);
    if (!k || k.channel !== 'tap' || (doc.state !== 'open' && doc.state !== 'pushed')) return false;
    if (liveBox(doc) || nowMs >= lapseAt(doc)) return false;
    if (role === 'thinking' && doc.origin_session !== sessionId) return false;
    if (held.has(id) && !k.urgent) return false;
    return true;
  });
  open.sort((a, b) => urgentRank(a.doc.kind) - urgentRank(b.doc.kind)
    || (a.doc.card === card ? 0 : 1) - (b.doc.card === card ? 0 : 1)
    || (ms(a.doc.created_at) ?? 0) - (ms(b.doc.created_at) ?? 0) || (a.id < b.id ? -1 : 1));
  const pick = open[0];
  if (!pick) return null;
  return { ask: pick.id, card: pick.doc.card, kind: pick.doc.kind, payload: structuredClone(pick.doc.released_typed ? pick.doc.payload_still_open : pick.doc.payload) };
}
