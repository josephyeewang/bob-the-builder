// An outbox file's kind: the one rule (L82 M-1, L101). The plain-files hook, M4's intake read and M9 all read a name's
// kind with `kindAmong`. shared/record-names.mjs builds `outboxKindOf` from it over the whole table.
//
// WHY THE RULE LIVES IN THE HOOK FOLDER. The hook folder is copied alone into the Do plane (hooks-check.mjs
// `installHooks`), and a hook may import only files beside it. So the rule's one home is here, it imports nothing, and
// the shared table's reader imports it from here. Nothing else in the hook folder is shared.
//
// The rule: a kind is a name prefix that ends in a dash. The name's kind is the longest listed kind it starts with
// (so `report-compact-x` is report-compact-, not report-). A compaction note's kind holds `-compact-`, and only such a
// kind matches a name that holds the reserved form (L101). So `verdict-compact-S1.md` is no kind at all, never a
// verdict.
//
// THE RESERVED FORM (L121 Minor 4): `-compact`, in any case, anywhere in the name, whatever follows it (`-compact-`,
// `-compact.`, `-compactS1`, `-Compact-`, at the end). Such a name is a compaction note: its kind must hold
// `-compact-` and the name must start with that kind exactly, in lower case as the kinds are written, so
// `verdict-COMPACT-S1.md`, `verdict-compact.md` and `report-Compact-x.md` are no kind at all. No other kind may use the
// word: `report-compactness.md` is refused too. Wider than the notes the hook writes (`<kind>-compact-<session>.md`)
// on purpose, so a name that only looks like a verdict can't pass as one.

export const KIND_SHAPE = /^[a-z]+(-[a-z]+)*-$/;
export const COMPACT_MARK = '-compact-';
export const COMPACT_RESERVED = /-compact/i;

/** The longest kind in `kinds` that `name` starts with (and is longer than), under the compaction rule; else null. */
export function kindAmong(name, kinds) {
  if (typeof name !== 'string') return null;
  const note = COMPACT_RESERVED.test(name);
  let best = null;
  for (const k of kinds) {
    if (typeof k !== 'string' || !KIND_SHAPE.test(k)) continue;
    if (note && !k.includes(COMPACT_MARK)) continue;
    if (name.startsWith(k) && name.length > k.length && (!best || k.length > best.length)) best = k;
  }
  return best;
}
