// read-facts.mjs — every Sensors fact family the Dispatcher reads, with the fields it reads from each (LEAD-CALLS L89).
//
// WHY. M11 acts on readings the Sensors (M12) write. Suppose M11 needs a field that M12 never writes. Nothing reports
// an error: M11 just sees "no fresh reading" and waits, forever (#68 r1 flag 2: an interrupted merge stayed `merging`
// because `pr-<n>` had no `observed_at`). This one list says what M11 reads. The Sensors' coverage test (R-0b-168) uses
// it to check, through the real Record, that each family has a real writer whose stored shape carries every field here.
//
// `family` is the M9 fact family (FACT_FAMILIES.sensors): a name ending in `-` is a prefix, any other an exact id.
// `fields` are dotted paths into the fact's document. `readers` are this folder's files that act on it. A field M11
// reads from only some readings is still listed: the writer may leave it null, never out of the shape. The README's fact
// table lists the same fields (read-facts.test.mjs keeps them equal and keeps this list true to the code). The merge
// gate (M6) also reads `pr-<n>`, through merge-outcome.mjs, for the same fields; it is not this folder's reader.

export const READ_FACTS = Object.freeze([
  { family: 'pr-', readers: ['merges.mjs', 'cleanup.mjs'],
    fields: ['state', 'merged', 'merge_commit_sha', 'head_sha', 'observed_at'] },
  { family: 'usage-', readers: ['usage.mjs'],
    fields: ['account', 'observed_at', 'week.used_pct', 'week.resets_at', 'h5.used_pct', 'h5.resets_at'] },
  { family: 'signed-in-account', readers: ['tick.mjs'], fields: ['account', 'observed_at'] },
  // The account is in the id (`limit-hit-<account>`), not a field M11 reads.
  { family: 'limit-hit-', readers: ['pass.mjs'], fields: ['resets_at', 'observed_at'] },
  { family: 'network-up', readers: ['phone-link.mjs'], fields: ['value', 'observed_at'] },
  { family: 'frontdoor-reachable', readers: ['phone-link.mjs'], fields: ['value', 'observed_at'] },
  { family: 'minibase-running', readers: ['phone-link.mjs'], fields: ['value', 'observed_at'] },
].map((f) => Object.freeze({ ...f, readers: Object.freeze(f.readers), fields: Object.freeze(f.fields) })));
