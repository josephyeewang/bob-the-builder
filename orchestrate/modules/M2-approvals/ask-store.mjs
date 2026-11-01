// ask-store.mjs — how M2 reads and writes its asks and gos in the M9 record (0b-5 spec review round 1 m6, round 2 m2-9).
//
// WHY. Only the `approvals` actor may write an ask or a go (M9's who-may-change-what table). M2's reader checks it again:
// an ask or go whose latest diary line was written by anyone else is not trusted, and is alerted once per pass. Every
// write carries the whole document (the writer compares every field), as actor `approvals`, at the rev just read.
//
//   const st = askStore(record);           one snapshot of the diary's writers, taken now
//   st.asks() → [{ id, rev, doc }]          trusted asks only
//   st.ask(id) / st.go(id) → { id, rev, doc } | null
//   st.gos() → [{ id, rev, doc }]
//   st.untrusted → [`ask/<id>`, …]          for the caller's alert
//   writeDoc(record, entity, cur, doc) → the record's answer (to create, cur = { id, rev: 0 })   M2's own modules only (L85 m-3)
//   consumeAsk(ctx, id, note = {}) → the record's answer | { ok: false, reason }        for modules outside M2
//   markPushSent(ctx, id, kinds) → the record's answer | { ok: false, reason }        once a pass's push has gone out
//   markSent(ctx, id, kinds, field) → the same, for a SENT_FIELDS mark (MAIN's by-hand alert uses main_alert_sent_at)
//   Callers use the wrappers that fix the kinds: research-ask.mjs markResearchPushSent, undo-flag.mjs markByHandPushSent.
//
// consumeAsk is the one way another module (e.g. the Dispatcher's cleanup) closes an ask, and it does only that: a
// trusted ask that is `answered` becomes `consumed`, with `consumed_at` set here. Every other state is refused. `note`
// may hold only the fields in NOTE_KEYS (L95, audit stack r3 Minor 7: a free note could add a `wait`, which puts the ask
// back on the owner's waiting list, or a `request`, which stops a report from ever opening): each a string of at most
// 500 characters, a finite number, or null, and never a field already on the ask. (A research ask's open → consumed
// joins once the record's research move is on main.)
// No module outside M2 calls writeDoc. The fence is writeDoc itself (L124 m-1): it reads who called it from the call
// stack and refuses a caller whose file is not in M2's folder (both sides real paths as the disk spells them, so a
// symlink or another letter case on macOS names the same folder). consume-ask.test.mjs's scan of import routes stays as an early warning, not the fence.
// Its limit: it stops honest mistakes, not hostile code. A caller can still reach it through an M2 function that hands
// writeDoc out, or by code with no file of its own (eval, new Function), which is refused, as is a caller it can't name.

import { realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTOR = 'approvals';
const HERE = fileURLToPath(import.meta.url);
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const M2_DIR = real(dirname(HERE));

// The file of the function that called writeDoc, as a real path, or null when there is none to name.
function callerFile() {
  const prep = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  let frames;
  try {
    Error.stackTraceLimit = 3;
    Error.prepareStackTrace = (_, f) => f;
    frames = new Error().stack;
  } finally {
    Error.prepareStackTrace = prep;
    Error.stackTraceLimit = limit;
  }
  // frames[0] is callerFile, frames[1] writeDoc, frames[2] its caller.
  const name = Array.isArray(frames) ? frames[2]?.getFileName?.() : null;
  if (typeof name !== 'string' || !name) return null;
  let path = name;
  if (name.startsWith('file:')) { try { path = fileURLToPath(name); } catch { return null; } }
  else if (!name.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(name)) return null;
  return real(path);
}

export function lastWriters(record) {
  const by = new Map();
  for (const line of record.diary({ since: 0 })) {
    for (const w of line.writes ?? []) by.set(`${w.entity}/${w.id}`, line.actor);
  }
  return by;
}

export function askStore(record) {
  const writers = lastWriters(record);
  const untrusted = [];
  const trusted = (entity, e) => {
    if (!e || e.corrupt || !e.doc || typeof e.doc !== 'object') return null;
    if (writers.get(`${entity}/${e.id}`) !== ACTOR) { untrusted.push(`${entity}/${e.id}`); return null; }
    return { id: e.id, rev: e.rev, doc: structuredClone(e.doc) };
  };
  const all = (entity) => record.list(entity).map((e) => trusted(entity, e)).filter(Boolean);
  return {
    untrusted,
    asks: () => all('ask'),
    gos: () => all('go'),
    ask: (id) => trusted('ask', record.read('ask', id)),
    go: (id) => trusted('go', record.read('go', id)),
  };
}

export function writeDoc(record, entity, cur, doc) {
  const from = callerFile();
  if (!M2_DIR || !from || !from.startsWith(`${M2_DIR}${sep}`)) {
    return { ok: false, reason: `writeDoc is M2's own writer; it was called from ${from ?? 'code with no file'}` };
  }
  return record.write({ actor: ACTOR, entity, id: cur.id, expectRev: cur.rev ?? 0, doc });
}

// What the Dispatcher's copy cleanup records when it consumes its delete-copy ask (lane 2's M11 cleanup.mjs): the card
// change it kept the copy at, and why a delete didn't happen. A new key is added here, with its reader named.
export const NOTE_KEYS = Object.freeze(['kept_at_card_change', 'not_deleted']);
const isPlain = (o) => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
const noteValue = (v) => v === null || (typeof v === 'string' && v.length <= 500) || (typeof v === 'number' && Number.isFinite(v));

export function consumeAsk(ctx, id, given = {}) {
  const a = askStore(ctx.record).ask(id);
  if (!a) return { ok: false, reason: `no trusted ask ${id}` };
  if (a.doc.state !== 'answered') return { ok: false, reason: `ask ${id} is ${a.doc.state}, not answered` };
  if (!isPlain(given)) return { ok: false, reason: 'the note is not a plain object' };
  for (const k of Reflect.ownKeys(given)) {
    if (typeof k !== 'string' || !NOTE_KEYS.includes(k) || Object.hasOwn(a.doc, k)) return { ok: false, reason: `the note may not set ${String(k)}` };
  }
  // Each value is read once, here, and only the copy is checked and written (L117 c2: a getter could answer the check
  // with one value and the write with another).
  let note;
  try { note = structuredClone(given); } catch { return { ok: false, reason: 'the note is not plain data' }; }
  for (const k of Object.keys(note)) {
    if (!noteValue(note[k])) return { ok: false, reason: `the note's ${k} is not a short text, a number or null` };
  }
  const add = Object.fromEntries(NOTE_KEYS.filter((k) => Object.hasOwn(note, k)).map((k) => [k, note[k]]));
  return writeDoc(ctx.record, 'ask', a, { ...a.doc, ...add, state: 'consumed', consumed_at: new Date(ctx.now()).toISOString() });
}

// A push a pass hands back (a research ask's "on your waiting list", an undo-by-hand note) is handed back on every pass
// until its sender marks it sent here (L95, audit stack r3 Minors 1 and 3); MAIN's by-hand alert the same way, marked by
// the pass itself once the alert went through (L117 m-2). Only an open, trusted ask of the kinds given; once set, a mark
// is never moved, so a second call is refused and nothing is sent twice.
export const SENT_FIELDS = Object.freeze(['push_sent_at', 'main_alert_sent_at']);
export function markSent(ctx, id, kinds, field) {
  if (!SENT_FIELDS.includes(field)) return { ok: false, reason: `${String(field)} is not a sent mark` };
  if (!Array.isArray(kinds) || !kinds.length) return { ok: false, reason: 'a sent mark needs the ask kinds it may be set on' };
  const a = askStore(ctx.record).ask(id);
  if (!a) return { ok: false, reason: `no trusted ask ${id}` };
  if (!kinds.includes(a.doc.kind)) return { ok: false, reason: `ask ${id} is not a ${kinds.join(' or ')} ask` };
  if (a.doc.state !== 'open') return { ok: false, reason: `ask ${id} is ${a.doc.state}, not open` };
  if (a.doc[field]) return { ok: false, reason: `ask ${id}'s ${field} is already set` };
  return writeDoc(ctx.record, 'ask', a, { ...a.doc, [field]: new Date(ctx.now()).toISOString() });
}
export const markPushSent = (ctx, id, kinds) => markSent(ctx, id, kinds, 'push_sent_at');
