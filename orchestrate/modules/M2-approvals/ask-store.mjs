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
//   writeDoc(record, entity, cur, doc) → the record's answer (cur = null to create)

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
