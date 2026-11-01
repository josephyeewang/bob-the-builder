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
//   writeDoc(record, entity, cur, doc) → the record's answer (cur = null to create)   M2's own modules only (L85 m-3)
//   consumeAsk(ctx, id, note = {}) → the record's answer | { ok: false, reason }        for modules outside M2
//
// consumeAsk is the one way another module (e.g. the Dispatcher's cleanup) closes an ask, and it does only that: a
// trusted ask that is `answered` becomes `consumed`, with `consumed_at` set here. Every other state is refused. `note`
// may only ADD fields the ask does not have yet (e.g. `kept_at_card_change`); it can never set the state, the answer, or
// any field already on the ask. (A research ask's open → consumed joins once the record's research move is on main.)
// No module outside M2 imports writeDoc: consume-ask.test.mjs fails on one that does.

const ACTOR = 'approvals';

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
  return record.write({ actor: ACTOR, entity, id: cur.id, expectRev: cur.rev ?? 0, doc });
}

const NOTE_KEY = /^[a-z][a-z0-9_]{0,40}$/;
const isPlain = (o) => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;

export function consumeAsk(ctx, id, note = {}) {
  const a = askStore(ctx.record).ask(id);
  if (!a) return { ok: false, reason: `no trusted ask ${id}` };
  if (a.doc.state !== 'answered') return { ok: false, reason: `ask ${id} is ${a.doc.state}, not answered` };
  if (!isPlain(note)) return { ok: false, reason: 'the note is not a plain object' };
  for (const k of Object.keys(note)) {
    if (!NOTE_KEY.test(k) || k === 'state' || k === 'consumed_at' || Object.hasOwn(a.doc, k)) return { ok: false, reason: `the note may not set ${k}` };
  }
  return writeDoc(ctx.record, 'ask', a, { ...a.doc, ...structuredClone(note), state: 'consumed', consumed_at: new Date(ctx.now()).toISOString() });
}
