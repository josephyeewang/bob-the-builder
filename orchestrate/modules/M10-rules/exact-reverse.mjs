// exact-reverse.mjs — is a merged change exactly the undo of a named commit? (spec review 0b-9 M4 and R2-M3;
// 0b-1 R3-M3.) The Merge Gate fills a merge subject's `exact_reverse_ok` from this, and the GitHub-side audit and
// deploy check use the same function, so all three recognise an undo the same way.
//
// WHY RECOMPUTE. An undo skips the pause, the Tier-1 hours and (when the reversed merge's audit failed) Joe's
// Approve. So "this is an undo" must be proven from the files, never taken from who opened it or what the pull
// request says. The proof: after the merge, every path the flagged commit touched is back exactly as it was before
// that commit, the merge touched nothing else, and nothing else had changed those paths in between (otherwise the
// "undo" would also wipe out later work).
//
//   await checkExactReverse({ view, reverses, merged }) → { ok, reasons: [...] }
//     view     = makeGitView(...) for the product's repository
//     reverses = the flagged commit (40-hex); its first parent is "before"
//     merged   = the commit that would land (the reverse's merge result); its first parent is main before it
//
// This answers only "is it the exact reverse". The robot's merge mark (0b-9 M4's other half) is checked by the
// caller, and what an undo is still classified as (protected files, risky classes) is M10's `merge` answer.

import { touchedPaths, sameEntry } from './git-view.mjs';

const SHA = /^[0-9a-f]{40}$/;

export async function checkExactReverse({ view, reverses, merged }) {
  const reasons = [];
  try {
    if (!SHA.test(reverses ?? '') || !SHA.test(merged ?? '')) return no('both commits must be full commit ids');
    if (reverses === merged) return no('a commit cannot reverse itself');
    const flagged = await view.commit(reverses);
    const result = await view.commit(merged);
    if (!flagged.parents.length) return no('the flagged commit has no parent to go back to');
    if (!result.parents.length) return no('the merge result has no parent');
    const before = flagged.parents[0];
    const mainBefore = result.parents[0];
    if (!(await view.onHistory(reverses, mainBefore))) return no('the flagged commit is not on main before this merge');

    const paths = touchedPaths(await view.files(before, reverses));
    if (!paths.size) return no('the flagged commit changed no files');
    for (const f of await view.files(mainBefore, merged)) {
      for (const p of touchedPaths([f])) if (!paths.has(p)) reasons.push(`touches ${p}, which the flagged commit did not`);
    }
    for (const p of [...paths].sort()) {
      const [atFlagged, atMainBefore, atBefore, atResult] = await Promise.all([
        view.entry(reverses, p), view.entry(mainBefore, p), view.entry(before, p), view.entry(merged, p)]);
      if (!sameEntry(atMainBefore, atFlagged)) reasons.push(`${p} changed again after the flagged commit`);
      if (!sameEntry(atResult, atBefore)) reasons.push(`${p} is not back to its version before the flagged commit`);
    }
    return { ok: reasons.length === 0, reasons };
  } catch (e) {
    return no(`could not check: ${e.message}`);
  }
  function no(why) { reasons.push(why); return { ok: false, reasons }; }
}
