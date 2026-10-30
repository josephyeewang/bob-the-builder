// supported.mjs — the ONE definition of "a supported main commit", used by the production watcher on the Mini and by
// the hourly outside check (review-0b-7 M2, M3 and round 2; design v4 E5/E6, N19).
//
// Under N19 the first cutover leaves MAIN merging code as today, so the rule depends on the product's stage:
//   stage "first"  (MAIN merges as today): supported = a Git-integration deploy of a commit on main's first-parent
//                  history. The outside check's "main commit with no finished audit run" is not applicable unless the
//                  product's rules say the post-merge audit is on.
//   stage "second" (the full rule, v3): the same, AND evidence for that commit: on the Mini, the robot's merge-gate
//                  status on it; in the outside check, its post-merge audit run finished with success.
// A MISSING or unknown stage means the strict rule ("second"), with the audit-run check on, plus one alert
// "rules entry has no stage; using the strict rule" (round 2: a missing field must never loosen a safety check).
//
// The deploy's SOURCE decides first (M3): Vercel's command-line tool attaches the local git commit to a deploy, so a
// CLI deploy from a main checkout carries a main SHA. Only a deploy created by the Git integration can be supported;
// cli, redeploy, import, API and unknown sources never are, whatever their SHA.
// Field values ("git", "cli", …) are assumed from Vercel's API docs, 29 Oct 2026: check on the test project; void on
// change (Principle 9).

export const STAGES = Object.freeze(['first', 'second']);
export const GIT_SOURCES = Object.freeze(['git']);

export function resolveStage(rulesEntry) {
  const s = rulesEntry?.stage;
  if (STAGES.includes(s)) return { stage: s, fallback: false, auditCheck: s === 'second' || rulesEntry?.post_merge_audit === true };
  return { stage: 'second', fallback: true, auditCheck: true };
}

// deploy: { source, sha }. mainFirstParent: Set of main's first-parent SHAs. evidence: Set of SHAs with the stage-second
// evidence (merge-gate status on the Mini, audit success in the outside check). Returns { ok, why }.
export function isSupported(deploy, { stage, mainFirstParent, evidence = new Set() }) {
  if (!GIT_SOURCES.includes(deploy?.source)) return { ok: false, why: `deployed from ${deploy?.source ?? 'an unknown source'}, not the Git integration` };
  if (!deploy.sha) return { ok: false, why: 'Git deploy with no commit recorded' };
  if (!mainFirstParent.has(deploy.sha)) return { ok: false, why: 'commit is not on main' };
  if (stage !== 'first' && !evidence.has(deploy.sha)) return { ok: false, why: 'main commit without the merge gate / audit evidence' };
  return { ok: true, why: 'supported main commit' };
}
