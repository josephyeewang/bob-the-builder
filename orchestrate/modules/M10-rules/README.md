# M10-rules

M10 Rules answers "may X happen?" for every other module. It decides and never acts. Other modules don't import this folder: they ask through `orchestrate/shared/rules.mjs` (see `shared/README.md`). The few pure checks that other modules call directly are listed under "Called directly".

See LANES.md for who builds this folder, and the build rows (0b-1, R-0b-13..19) for what.

## The files

| File | What it does |
|---|---|
| `reader.mjs` | Fetches each product's `orchestrate/policy.yaml` from GitHub `main` and adopts a new version only when Joe approved it. Otherwise it keeps the last good version and raises one alert, or denies everything. Also holds `findApprovingPull` and `pullRequestVerifier`. |
| `policy.mjs` | Reads and checks a rules file. A file that is half-right is "corrupt", never partly used. |
| `paths.mjs` | The one path matcher (tiers, protected files, lanes), plus the protected floor that a rules file can add to but never remove from. |
| `classify.mjs` | Works out a change's tier and risky classes from the files it touches. Pure, so the Mini and the GitHub-side checker give the same answer. |
| `engine.mjs` | The answers that `shared/rules.mjs` `makeRules()` wraps: start, push, merge, Mac-wide values, Tier-1 hours, exact reverse. |
| `roles.mjs`, `roles/` | Loads the role profiles and refuses any profile that gives a role more than the design allows. |
| `snapshot.mjs` | The small on-disk copy of the rules that hooks read without the network. |
| `repair-plain.mjs` | Is a data-repair file only plain statements? (0b-9 M8) |
| `git-view.mjs` | Read-only questions about a GitHub repository, shared by the three checks below. |
| `exact-reverse.mjs` | Is a merge exactly the undo of a named commit? (0b-9 M4) |
| `carry-over.mjs` | Does a review or audit done on one version of a change still count after a catch-up merge? (0b-9 M7, 0b-5 M3) |
| `fixtures/` | A sample rules file and an in-memory fake GitHub repository (`fake-repo.mjs`) for tests. |

## Running the tests

Plain Node, no packages:

```bash
node --test orchestrate/modules/M10-rules/*.test.mjs orchestrate/shared/*.test.mjs
```

Every test uses the sample product `sample-org/sample-app` and fakes for GitHub, the clock and the record.

## Called directly

These are pure functions; the Merge Gate, M2 Approvals and the GitHub-side checker import them, so they can't drift apart.

```js
import { makeGitView } from '../M10-rules/git-view.mjs';
import { checkExactReverse } from '../M10-rules/exact-reverse.mjs';
import { carryOver } from '../M10-rules/carry-over.mjs';
import { checkRepairFiles } from '../M10-rules/repair-plain.mjs';
import { classifyWithRulesText } from '../M10-rules/classify.mjs';

const view = makeGitView({ gh, owner, repo });          // gh = the reader's GitHub client ({ get(path) })
await checkExactReverse({ view, reverses, merged });    // → { ok, reasons }
await carryOver({ reviewed, current, between, catchUps, tier1MergesSince, gh: view });  // → { review, audit, reasons }
```

- **Any error means "no".** Each returns a plain answer and never throws. A missing commit, a cut-off file list (GitHub lists at most 300 files in a compare; a recursive tree can be truncated) or an unknown file status makes the answer "no".
- **The robot's merge mark is the caller's check.** `checkExactReverse` proves only that the files are an exact undo. That the robot made the merge (the other half of 0b-9 M4) is checked by the Merge Gate. What the undo still counts as (protected files, risky classes) is M10's `merge` answer.
- **`carryOver` takes a git view as `gh`**, not the raw GitHub client.

## Notes for callers

- **Gate only on `may()`.** `get()` is for display and sizing. An undefined `get()` means refuse.
- **Full rules ids.** `rules.rev` is short (`<commit7>:<blob7>`), for diary lines only. To compare versions (the Merge Gate's `rules_not_adopted` hold, `launch`, `merge_request`), use `rules.get('rules.adopted', { product })`, which returns the full 40-character `{ commit, blob }`, or undefined when there are no usable rules.
- **Two sets of rules, on purpose (R3-M1(c)).** On the Mini, everything is judged by the rules M10 has adopted. The Merge Gate holds a merge (`rules_not_adopted`) while the file at the expected parent commit differs from them. The GitHub-side checker judges by the file at the parent commit, through `classifyWithRulesText`. `classify()` through the shared interface drops any rules a caller hands it (R2-M10, r2-m5).
- **Rules changes (R2-M1(e)).** Until the second cutover installs the post-merge audit on a product, the reader is the only thing that stops a direct push to the rules file from taking effect.
- **How a rules change is approved.** A new version is adopted only through the one merged pull request that put it on `main` (`findApprovingPull`). This works with all three merge methods (squash, merge commit, rebase). The pull request's head must hold the same file as `main`, and its merge commit must be on `main`. Until 0b-5 M2 Approvals lands, the reader's default check is the stopgap allow-list `approved-rules.json` (blob ids Joe pinned). `pullRequestVerifier({ judge })` is where 0b-5 plugs in its judgement of Joe's Approve.
- **New keys enter as optional (R3-m10).** A key added to the rules later is optional, with a missing value read as the stricter choice, so an older rules file stays valid.
- **The snapshot.** Its hash proves the file wasn't damaged. It does not prove who wrote it: the guard against a looser copy is that only its owner may write it (a file writable by others is refused). Hooks read it only through `snapshotAnswer`, which adds the protected floor.

## Known limits (logged by the 0b-1 code audit, rounds 1 and 2)

- **An exact-reverse push trusts its file list.** `push_branch` lets an exact reverse through, even while paused, when every file is in the subject's `reverses_files`. The caller fills that list from the reversed commit. The merge still needs `exact_reverse_ok`, which M10's `checkExactReverse` recomputes from GitHub, so a wrong list can only push a branch, never merge it.
- **The last good rules on disk.** After a restart, the reader re-checks the saved copy's hash and parse, and uses it again after the next successful GitHub read. If that read finds a new, unapproved version, the saved copy stays the last good one (MAT-3). Anyone who can write the reader's private folder (owner-only) could change it, as they could change the code itself.
- **Non-ASCII file names are refused.** A changed path with a letter outside plain ASCII is unclassifiable and cannot be pushed, because the Mac treats some look-alikes as the same file.
- **The approval check only moves forward.** A rules change is adopted only through a pull request merged after the last good version. With the stopgap allow-list, a version must be listed after the current one (append new versions; never reorder). The one exception is the very first read with no saved copy at all: then there is no "after", so any approved version is accepted. Seeding a product (or losing the saved copy) is a hand step for that reason.
- **Carry-over trusts the caller on `main`.** `carryOver` checks that the reviewed and current bases are each the change's base, but not that the current base (or a catch-up's second parent) is on `main`. The caller passes the base it read from `main`.
- **The snapshot checks permission bits only.** macOS access-control lists on the folder or file are not read. Adding one needs the owner's own access, the same as editing the file.

## Repair files: what the check cannot see

`repair-plain.mjs` is an allow-list and is stricter than the spec (see its header). An undeclared `repairs.max_statements` refuses every repair file. What it cannot see: a trigger, a custom operator or cast, or a column default on the target table runs code the file doesn't show. Those are schema changes, which ship only as migrations under the `schema` class and always need Joe's Approve.
