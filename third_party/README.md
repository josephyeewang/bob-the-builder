# Third-party material in Bob

Bob itself is MIT (see `../LICENSE`). A few pieces were taken from other open-source projects.
Their licences are kept here, and every file that carries borrowed text or logic says so at the top.

| Source | Licence | What Bob took | Where it lives in Bob |
|---|---|---|---|
| [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) @ `a8380ab5f0aba392c97e31c79f9a6666b3f09f14` | Apache-2.0 — full text in `egm/LICENSE` | Two reviewer prompts (design critic; implementation readiness, plus its "zero decisions left to the builder" standard) and the finding-sorting rules from its resolve skill | `audit-lenses/prebuild-reviewers/design-critic.md`, `audit-lenses/prebuild-reviewers/implementation-readiness.md`, `audit-lenses/_aggregation.md` § "Sorting reviewer findings" |
| [pullboard-dev/pullboard](https://github.com/pullboard-dev/pullboard) @ `1694efbcc4cd6e60976ca7354e90b3247e9a0d21` (v0.9.3) | MIT, Copyright (c) 2026 Corey Olson — full text in `pullboard/LICENSE` | The *method* only (no files copied): revert-the-fix-and-require-a-failing-test (`src/guard-revert.js`), and the longest-prefix folder-ownership check (`laneOf` / `outOfLane` in `src/lanes.js`) | `scripts/prove-test-fails.mjs`, `scripts/lane-check.mjs` |

**Apache-2.0 changes notice (§4b).** The EGM-derived files were modified by Joe Wang in October 2026:
the brainstorm mode was removed, a plain-English summary for a non-engineer was added, the
implementation-readiness reviewer gained a "check only the next phase at full detail" scope rule,
and the wording was fitted to Bob's Pre-Build Gate. Each modified file states this in its header.

No NOTICE file ships with either upstream project at the commits above, so none is reproduced.
