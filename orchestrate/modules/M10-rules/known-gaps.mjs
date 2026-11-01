// known-gaps.mjs — the reasons the first-cutover fit check gives today that are not the rules file's fault (L96 m-D,
// L115). Each label goes on the end of the reason in the check's own output, so Joe reads "known, waits on X" and not
// "your file is wrong". The reason itself still counts: a file with a known gap is still refused. Each label goes when
// what it waits on lands; then this file shrinks, and at none left it is deleted.

export const KNOWN = Object.freeze({
  // yaml-lite has no numbers: the real engine hands `n: 30` over as "30" (L96).
  text: ' (known: rules numbers arrive as text, L96; waits on step 2)',
  // M11 reads these keys with no product; on the real engine a product key read that way is undefined (L115 M-A).
  scope: ' (known: M11 reads this key without the product, L115; waits on #79 for usage.red_runs, lane 2\'s L104 sweep for context.*)',
  // M11 gate.mjs matches daily-card patterns with its own matcher, not M10 compile (L115 M-B).
  pattern: ' (known: M11 reads this pattern differently from M10 compile, L115; waits on lane 2\'s sweep onto compile)',
});

// A rules value the real engine gave as text that would be a number: "30", "0.5", not "", " 3" or "3x". Lists are left
// alone; a map's values are converted one level down (caps.per_state).
const NUM = /^(0|[1-9]\d*)(\.\d+)?$/;
export const numeric = (v) => (typeof v === 'string' && NUM.test(v) ? Number(v)
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && NUM.test(x) ? Number(x) : x]))
    : v);

/** `rules` with each value it gives converted by numeric(): the rules as they will read once step 2 lands. */
export const asNumbers = (rules) => ({ get: (k, o) => numeric(rules.get(k, o)), classify: (c) => rules.classify(c) });
