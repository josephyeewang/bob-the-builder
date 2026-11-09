// known-gaps.mjs — the reasons the first-cutover fit check gives today that are not the rules file's fault (L96 m-D,
// L115). Each label goes on the end of the reason in the check's own output, so Joe reads "known, waits on X" and not
// "your file is wrong". The reason itself still counts: a file with a known gap is still refused. Each label goes when
// what it waits on lands; then this file shrinks, and at none left it is deleted.

export const KNOWN = Object.freeze({
  // (None left. usage.red_runs went with #79, Mac-wide in the rules, L131. scopeNew, the per-product time limits, went with
  // #68, L144. scopeContext, the three context.* reads, went when M11 read them for the product, L564.)
});
// Each per-product key M11 still reads Mac-wide, and the label naming its owner (L125 c-1, L131), in M11 KEYS order. A key not here gets no
// label and no scope reason, so first-cutover.test's scope test fails on a new gap until it is placed here, and on a
// key here once M11 reads it with the product (then it comes off).
export const SCOPE_OWNERS = Object.freeze({
});
/** The scope label for a key M11 reads Mac-wide, naming that key's owner; '' for a key with no known gap. */
export const scopeLabel = (key) => (Object.hasOwn(SCOPE_OWNERS, key) ? KNOWN[SCOPE_OWNERS[key]] : '');
