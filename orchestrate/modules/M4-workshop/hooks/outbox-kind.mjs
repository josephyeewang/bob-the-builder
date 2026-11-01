// An outbox file's kind: the one rule (L82 M-1, L101). The plain-files hook, M4's intake read and M9 all read a name's
// kind with `kindAmong`. shared/record-names.mjs builds `outboxKindOf` from it over the whole table.
//
// WHY THE RULE LIVES IN THE HOOK FOLDER. The hook folder is copied alone into the Do plane (hooks-check.mjs
// `installHooks`), and a hook may import only files beside it. So the rule's one home is here, it imports nothing, and
// the shared table's reader imports it from here. Nothing else in the hook folder is shared.
//
// The rule: a kind is a name prefix that ends in a dash. The name's kind is the longest listed kind it starts with
// (so `report-compact-x` is report-compact-, not report-). A name holding `-compact-` is a compaction note, and only
// a kind holding `-compact-` matches it (L101). So `verdict-compact-S1.md` is no kind at all, never a verdict.

export const KIND_SHAPE = /^[a-z]+(-[a-z]+)*-$/;
export const COMPACT_MARK = '-compact-';

/** The longest kind in `kinds` that `name` starts with (and is longer than), under the compaction rule; else null. */
export function kindAmong(name, kinds) {
  if (typeof name !== 'string') return null;
  const note = name.includes(COMPACT_MARK);
  let best = null;
  for (const k of kinds) {
    if (typeof k !== 'string' || !KIND_SHAPE.test(k)) continue;
    if (note && !k.includes(COMPACT_MARK)) continue;
    if (name.startsWith(k) && name.length > k.length && (!best || k.length > best.length)) best = k;
  }
  return best;
}
