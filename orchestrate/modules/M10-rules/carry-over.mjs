// carry-over.mjs — does a review (or a Tier-1 audit) done on one version of a change still count for the version
// about to merge? (spec review 0b-9 M7; 0b-5 M3; 0b-1 R2-M9.) One pure function, imported by M2 Approvals, M6's
// queue and refusals 5 and 8, and the GitHub-side checker, so the four can't drift apart.
//
// WHY. Between Joe's review and the merge, the robot may merge `main` into the branch to catch it up. That should not
// cost a fresh review, unless the catch-up could have changed what Joe read. "Identical" means the files, not the
// patch text (which shifts when main edits nearby).
//
//   await carryOver({ reviewed: { base, head }, current: { base, head }, between, catchUps, tier1MergesSince, gh })
//     → { review: bool, audit: bool, reasons: [...] }
//   B0/H0 = reviewed base and head, B1/H1 = current; a base is the change's merge base with main.
//   between  = the branch's commits after H0 up to H1, oldest first
//   catchUps = the record's catch-up merges [{ pr, before_sha, after_sha }]
//   tier1MergesSince = merges with a COMPUTED tier of 1 that landed on the product after the audit's main read
//   gh       = a git view (makeGitView) of the product's repository
//
// THE RULE (both must hold, or a fresh review is needed):
//   own diff identical — diff(B0..H0) and diff(B1..H1) list the same (path, previous_path, status), and for every
//     path (old and new names), the version (blob and mode) is the same at H0 and H1, and at B0 and B1;
//   catch-up touched none of its files — diff(B0..B1) on main shares no path with the change.
// AND every commit between H0 and H1 is a recorded catch-up, in a chain from H0 (a push by anyone else, even with an
// identical diff, is refused). The audit carries over only if, in addition, tier1MergesSince is 0.
// Any error, missing commit or missing version means no carry-over (fail closed).

import { touchedPaths, sameEntry } from './git-view.mjs';

const SHA = /^[0-9a-f]{40}$/;
const key = (f) => JSON.stringify([f.path, f.previous_path ?? null, f.status]);

export async function carryOver({ reviewed, current, between, catchUps, tier1MergesSince, gh } = {}) {
  const reasons = [];
  const no = (why) => { reasons.push(why); return { review: false, audit: false, reasons }; };
  try {
    const [B0, H0, B1, H1] = [reviewed?.base, reviewed?.head, current?.base, current?.head];
    if (![B0, H0, B1, H1].every((s) => typeof s === 'string' && SHA.test(s))) return no('every base and head must be a full commit id');
    if (!Array.isArray(between) || !between.every((s) => typeof s === 'string' && SHA.test(s))) return no('between must be a list of full commit ids');
    if (!Array.isArray(catchUps)) return no('no catch-up list');
    if (!gh || typeof gh.files !== 'function' || typeof gh.entry !== 'function' || typeof gh.commit !== 'function') return no('no git view');

    // Only recorded catch-ups, chained from H0 to H1.
    if (H0 === H1 ? between.length !== 0 : between.at(-1) !== H1) return no('the commits between do not end at the current head');
    let prev = H0;
    for (const s of between) {
      const c = catchUps.find((u) => u && u.after_sha === s);
      if (!c) return no(`${s.slice(0, 7)} is not a recorded catch-up merge`);
      if (c.before_sha !== prev) return no(`catch-up ${s.slice(0, 7)} does not follow ${prev.slice(0, 7)}`);
      const commit = await gh.commit(s);
      if (commit.parents.length !== 2 || commit.parents[0] !== prev) return no(`catch-up ${s.slice(0, 7)} is not a merge onto ${prev.slice(0, 7)}`);
      prev = s;
    }

    const [d0, d1] = await Promise.all([gh.files(B0, H0), gh.files(B1, H1)]);
    // A reviewed change with no files carries nothing over (that is what a base given as the head itself looks like);
    // an empty current change fails the file-list check below.
    if (!d0.length) return no('the reviewed change lists no files against its base');
    const k0 = new Set(d0.map(key)); const k1 = new Set(d1.map(key));
    if (k0.size !== k1.size || [...k0].some((k) => !k1.has(k))) reasons.push('the change lists different files, renames or statuses');
    const paths = new Set([...touchedPaths(d0), ...touchedPaths(d1)]);
    for (const p of [...paths].sort()) {
      const [h0, h1, b0, b1] = await Promise.all([gh.entry(H0, p), gh.entry(H1, p), gh.entry(B0, p), gh.entry(B1, p)]);
      if (!sameEntry(h0, h1)) reasons.push(`${p} differs between the reviewed and current head`);
      if (!sameEntry(b0, b1)) reasons.push(`${p} differs between the reviewed and current base`);
    }
    for (const f of await gh.files(B0, B1)) {
      for (const p of touchedPaths([f])) if (paths.has(p)) reasons.push(`main changed ${p} since the review`);
    }
    if (reasons.length) return { review: false, audit: false, reasons };
    const auditOk = tier1MergesSince === 0;
    if (!auditOk) reasons.push(Number.isSafeInteger(tier1MergesSince) ? `${tier1MergesSince} Tier-1 merge(s) landed since the audit` : 'unknown Tier-1 merges since the audit');
    return { review: true, audit: auditOk, reasons };
  } catch (e) {
    return no(`could not check: ${e.message}`);
  }
}
