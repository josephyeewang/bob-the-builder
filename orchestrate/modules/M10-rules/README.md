# M10-rules

M10 Rules answers "may X happen?" for every other module. It decides and never acts. Other modules don't import this folder: they ask through `orchestrate/shared/rules.mjs` (see `shared/README.md`). The few pure checks that other modules call directly are listed under "Called directly".

See LANES.md for who builds this folder, and the build rows (0b-1, R-0b-13..19) for what.

## The files

| File | What it does |
|---|---|
| `reader.mjs` | Fetches each product's `orchestrate/policy.yaml` from GitHub `main` and adopts a new version only when Joe approved it. Otherwise it keeps the last good version and raises one alert, or denies everything. Also holds `findApprovingPull` and `pullRequestVerifier`. |
| `policy.mjs` | Reads and checks a rules file. A file that is half-right is "corrupt", never partly used. |
| `paths.mjs` | The one path matcher (tiers, protected files, lanes), plus the protected floor that a rules file can add to but never remove from. |
| `lane-check.mjs` | The first cutover's merge check (L34): passes only a change that is wholly plain text docs in the docs or research lane. |
| `first-cutover.mjs` | Is a product's rules file fit to be its first-cutover onboarding entry? (R-0b-106a) Stage `first` said outright, editing cap 0, only the docs and research lanes (the ones the merge check reads), each inside the docs folders, the script role off, every path-only effect field filled, required checks named, and a products.json entry with the same GitHub id. It also runs every module's own key list (M2, M6, M9 `required-keys.mjs`, M11's from `keys.mjs`) on M10's real engine; until step 2 it refuses every file, each reason labeled as a known reader gap (`known-gaps.mjs`). The product's own values go in its onboarding pull request, never in Bob. |
| `classify.mjs` | Works out a change's tier and risky classes from the files it touches. Pure, so the Mini and the GitHub-side checker give the same answer. |
| `db-lines.mjs` | Second cutover. The deny-by-default line check (lead call L32): a line in a code file counts as a possible database change unless it is proven harmless. |
| `engine.mjs` | The answers that `shared/rules.mjs` `makeRules()` wraps: start, push, merge, Mac-wide values, Tier-1 hours, exact reverse. |
| `roles.mjs`, `roles/` | Loads the role profiles and refuses any profile that gives a role more than the design allows. |
| `snapshot.mjs` | The small on-disk copy of the rules that hooks read without the network. |
| `repair-plain.mjs` | Is a data-repair file only plain statements? (0b-9 M8) |
| `git-view.mjs` | Read-only questions about a GitHub repository, shared by the three checks below. |
| `exact-reverse.mjs` | Is a merge exactly the undo of a named commit? (0b-9 M4) |
| `carry-over.mjs` | Does a review or audit done on one version of a change still count after a catch-up merge? (0b-9 M7, 0b-5 M3) |
| `*.test.mjs` | One test file per module above (`git-view.test.mjs` covers the view's refusals). |
| `fixtures/` | A sample rules file and an in-memory fake GitHub repository (`fake-repo.mjs`) for tests. |

## Running the tests

Plain Node, no packages:

```bash
node --test --test-timeout=20000 orchestrate/modules/M10-rules/*.test.mjs orchestrate/shared/*.test.mjs
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
- **The robot's merge mark is the caller's check.** `checkExactReverse` proves only that the files are an exact undo. That the robot made the merge (the other half of 0b-9 M4) is checked by the Merge Gate. What the undo still counts as (protected files, risky classes) is M10's `merge` answer. An undo that touches a database change (the `schema` or `production_data` class) always asks Joe, even when the reversed merge failed its audit (0b-9 M4). Because a code file can hold a table change outside the migration folders, the Merge Gate passes each code file's `removed_lines` and `added_lines` from the compare; a code file without both, or with both empty, makes the undo ask Joe. **When GitHub's compare leaves out a file's diff text (large or binary files), the Merge Gate must leave the line fields out, never pass `[]`.** An undo that puts back a `delete from` or `truncate` in code also asks, and so does any `needs-joe` or `needs-joe:<class>` label on the undone change, in any case or with any punctuation; a label with any character outside plain ASCII (an accent, a letter from another script, an emoji, an invisible character) counts as `needs-joe` too, because no list of look-alike letters is ever complete (audit round 15). A renamed or copied code file on an undo always asks: its diff shows only what changed from its source, never the content it carries over (audit round 14). Each file's lines are read once and every check judges that one copy; once a change holds more than 1,000,000 lines in all, the rest are not read and the change asks.
- **`carryOver` takes a git view as `gh`**, not the raw GitHub client.

## Notes for callers

- **Gate only on `may()`.** `get()` is for display and sizing. An undefined `get()` means refuse.
- **Full rules ids.** `rules.rev` is short (`<commit7>:<blob7>`), for diary lines only. To compare versions (the Merge Gate's `rules_not_adopted` hold, `launch`, `merge_request`), use `rules.get('rules.adopted', { product })`, which returns the full 40-character `{ commit, blob }`, or undefined when there are no usable rules.
- **Two sets of rules, on purpose (R3-M1(c)).** On the Mini, everything is judged by the rules M10 has adopted. The Merge Gate holds a merge (`rules_not_adopted`) while the file at the expected parent commit differs from them. The GitHub-side checker judges by the file at the parent commit, through `classifyWithRulesText`. `classify()` through the shared interface drops any rules a caller hands it (R2-M10, r2-m5).
- **Rules changes (R2-M1(e)).** Until the second cutover installs the post-merge audit on a product, the reader is the only thing that stops a direct push to the rules file from taking effect.
- **How a rules change is approved.** A new version is adopted only through the one merged pull request that put it on `main` (`findApprovingPull`). This works with all three merge methods (squash, merge commit, rebase). The pull request's head must hold the same file as `main`, and its merge commit must be on `main`. Until 0b-5 M2 Approvals lands, the reader's default check is the stopgap allow-list `approved-rules.json` (blob ids Joe pinned). `pullRequestVerifier({ judge })` is where 0b-5 plugs in its judgement of Joe's Approve.
- **New keys enter as optional (R3-m10).** A key added to the rules later is optional, with a missing value read as the stricter choice, so an older rules file stays valid.
- **The snapshot.** Its hash proves the file wasn't damaged. It does not prove who wrote it: the guard against a looser copy is that only its owner may write it (a file writable by others is refused). Hooks read it only through `snapshotAnswer`, which adds the protected floor.

## The first cutover's merge: the docs lane only (lead call L34)

At the first cutover the robot merges only the docs and research lane, so `merge` answers by one strict path check (`lane-check.mjs`). A change passes only when all of these hold; otherwise the answer is deny, "not this lane's change; MAIN merges it as today":
- every file, by its new name and any old name, is inside the rules file's `lanes.docs` or `lanes.research` patterns, inside `docs_paths`, and inside the built-in floor (`docs/*.md`, `docs/domains/**`, `docs/research/**`);
- every file is plain text by its name (`.md`, `.txt`, `.csv`): no images, PDFs or other binaries (L28), nothing that can run (`.mdx`, `.html`, `.svg`), and no JSON or YAML, because tools read too many such names as settings to list them all (confirm audit round 2);
- nothing is protected, Tier 1 or an effect path (secrets, migrations, repairs, senders, flags, new customer-visible files) in the rules, and nothing is removed or renamed out of a folder where removals are watched;
- no link, submodule or runnable file (a given `mode` must be `100644`), and an old name only on a rename or copy;
- the folder names are exact (`docs/`, `research/`, `domains/`; on GitHub `Docs/` is another folder), no part of the path is hidden (starts with `.`), the path is at most 512 characters and 16 parts, and no file is markdown other tools read as instructions (`AGENTS.override.md`, `AGENT.md`, `GEMINI.md`, `WARP.md`, `CRUSH.md`, `QWEN.md`, `copilot-instructions.md`, `CONVENTIONS.md`, `SKILL.md`, `IFLOW.md`, `CODEBUDDY.md`, `*.instructions.md`, `*.prompt.md`, `*.agent.md`, `*.chatmode.md`, `llms.txt`, anything under a `commands/`, `skills/`, `agents/` or `rules/` folder, pull request and issue templates, `SECURITY.md`), nor a page GitHub shows as the repository's own (`docs/README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `GOVERNANCE.md`; public pages are ask-first);
- the change is declared Tier 2, its file list is whole (not cut off, under 3,000 files) and the labels are a list of at most 1,000, each at most 256 characters, and none asks for Joe (any `needs-joe` spelling anywhere in the label, so `status: needs-joe` counts, or any label outside plain ASCII). Every route (merge and `push_branch`) reads the change once, refuses a path over 4,096 characters before scanning it, and refuses a file list that is not a whole-number count under 3,000.

The engine reads each field of the change by name and each list by position, so a field inherited from a class or hidden from a copy is still seen, and a list's own iterator can't hide an entry (confirm audit of L34). An exact reverse is held to the same check; while a product is paused (or its rules say `undo_only`) only an exact reverse of a docs-lane change merges. The check never throws: a field it can't read is a reason to refuse. GitHub's file list carries no `mode`, so a link or runnable file is caught only when the Merge Gate passes the mode; it must, whenever GitHub gives one.

The deep classifier below (`classify.mjs`, `db-lines.mjs`) is `cutover: second`. It is built and tested, and `makeEngine({ deepMerge: true })` switches it on for `merge`; nothing does yet. `rules.classify()` still uses it for read-backs.

## Database changes in code: deny by default (lead call L32, second cutover)

Audit rounds 3 to 11 each found one more way of writing a database change that a list of patterns missed. So `db-lines.mjs` reads the other way round: every added or removed line in a code file counts as a possible database change (class `schema`, Tier 1, Joe's Approve) unless it is blank (spaces and tabs only).

The lead's first list (L32) also let plain SELECT reads, comments and test-file strings through. Audit rounds 12 and 13 broke each of those: a SELECT can call any function; a comment can hold a line break some language honours, be run (MySQL `/*!`, `//go:generate`, a Python coding line), or change which nearby lines are code (`// */` after a `/*`); a quoted string runs in shell, Ruby and YAML. A line can't be proven harmless on its own, so only a blank one is. Text built at run time, lines over 20,000 characters and a side of a file over 1,000,000 characters count; a change with over 5,000,000 characters of lines (each line counting its length plus one) is unclassifiable. Every check runs in time proportional to the text. The pattern scans in `classify.mjs` stay; they only name the reason more clearly in the read-back.

**What this changes.** A false alarm costs Joe one Approve tap; a miss costs live data. Every normal merge of code was already Tier 1, so nothing changes there. The visible change is the exact reverse: the undo of a code change now asks Joe unless every changed line is blank. In practice only an undo of docs goes through on its own after a failed audit.

## Known limits (logged by the 0b-1 code audit, rounds 1 to 14)

First-cutover docs lane (confirm audit of L34, round 2):
- **A doc can become instructions by reference.** A path check can't see that a `CLAUDE.md` or `AGENTS.md` pulls in `@docs/x.md`; once it does, a docs-lane change to that file changes what agents are told. Keep instruction files from pointing into `docs/research/` and `docs/domains/`, or list the file they point at in the rules' `protected_files`.
- **A `.md` file can run code when a docs site is built.** Some site builders compile `.md` as code (Docusaurus treats it as MDX; MyST-NB runs code cells), and a `requirements.txt` or `CMakeLists.txt` under `docs/research/` matters if a build reads it there. A product whose `docs/` feeds a site builder must list that folder in its rules' `protected_files`, so the docs lane refuses it. (Confirm audit round 3.)
- **A product that publishes GitHub Pages from `docs/` makes every merged doc public.** Public pages are ask-first. Such a product must list its `docs/` folder under `first_customer_visible.new_files_under` (or `protected_files`) in its rules, so the docs lane refuses it.

- **No lane pushes under `.github/`** (lead call L39). `push_branch` refuses any changed file, new or old name, inside a `.github/` folder at any depth and in any case, for every lane, before the exact-reverse exception, so not even an undo writes a workflow. The same goes for a file named `CODEOWNERS` at any depth (GitHub reads it at the root, in `docs/` and in `.github/` to decide whose review a pull request needs). A workflow or CODEOWNERS change is the owner's to make by hand.
- **An exact-reverse push trusts its file list.** `push_branch` lets an exact reverse through, even while paused, when every file is in the subject's `reverses_files`. The caller fills that list from the reversed commit. The merge still needs `exact_reverse_ok`, which M10's `checkExactReverse` recomputes from GitHub, so a wrong list can only push a branch, never merge it.
- **The last good rules on disk.** After a restart, the reader re-checks the saved copy's hash and parse, and uses it again after the next successful GitHub read. If that read finds a new, unapproved version, the saved copy stays the last good one (MAT-3). Anyone who can write the reader's private folder (owner-only) could change it, as they could change the code itself.
- **Non-ASCII file names are refused.** A changed path with a letter outside plain ASCII is unclassifiable and cannot be pushed, because the Mac treats some look-alikes as the same file.
- **The approval check only moves forward.** A rules change is adopted only through a pull request merged after the last good version. With the stopgap allow-list, a version must be listed after the current one (append new versions; never reorder). The one exception is the very first read with no saved copy at all: then there is no "after", so any approved version is accepted. Seeding a product (or losing the saved copy) is a hand step for that reason.
- **Carry-over trusts the caller on `main`.** `carryOver` checks that the reviewed and current bases are each the change's base, but not that the current base (or a catch-up's second parent) is on `main`. The caller passes the base it read from `main`.
- **Links and submodules are caught only when the caller gives each file's mode.** GitHub's file lists for a pull request or a compare carry no mode, so a caller that wants this check reads modes from the git view (`entry`).
- **(Deep classifier, second cutover.) Ordinary docs ignore letter case.** `DOCS/x.md` counts as a doc, as `docs/x.md` does (the Mac treats them as one folder). On GitHub they are two folders. Either way the file is still a plain doc by its extension, and a protected name is still protected. The first cutover's docs-lane check needs the exact folder names.
- **(Deep classifier, second cutover.) `docs/package.json` is an ordinary doc.** It only matters if `docs/` is ever made a package folder; that is a process step (R3-m11), not a check here. The first cutover's docs-lane check refuses every JSON file.
- **A large catch-up can hold an approved rules change.** The forward-only check reads a compare from the last good version, and a compare of 300 files or more is refused. If `main` moved that far, the change waits (fails closed); a hand re-seed adopts it.
- **`checkExactReverse` trusts the caller's `main` and file list.** It does not check that the "before" commit it is given is the current `main`, or that the merge request's `files` are the merged commit's. The Merge Gate passes both from its own GitHub reads.
- **The snapshot's `mac` and `pin_ok` fields are carried, not judged.** In 0b the snapshot answers only `write_production` (always no) and `snapshot_fresh`; a hook that needs a Mac-wide value gets a named action and a test first.
- **Role profiles are read once.** The engine loads the role profiles once per Claude Code pin and keeps them until the Mini restarts. An edited profile takes effect on restart.
- **One alert per rules problem, per rules version.** The reader raises an alert once for each product, reason and rules version. If GitHub goes unreachable a second time while the rules are unchanged, the deny still happens but no second alert is sent.
- **Unknown product-state values load, then deny.** A rules file can name a `product_state_rules` value the engine doesn't know. The file is accepted and the engine denies that state at run time (fail closed), so the checker and the engine disagree on what is valid.
- **An unchanged rules version skips the rewind check.** When `main`'s rules file is the same version as the one adopted, the reader answers "unchanged" before it checks whether `main` was rewound. The rules in force are the same text either way.
- **A pattern can still name nothing.** `.` and `..` parts are refused, but a pattern that matches no file in the repository (a typo, or `[abc]`, which is read as a literal name) is accepted, so a protected entry can protect nothing. A typo in `migration_paths` or `repair_folder` also stops the folder rule from spotting a database change, including on an undo (the text scan still reads the lines). Brackets stay allowed because real file names use them (`[id].tsx`).
- **A run-permission change is not seen on an undo.** A file's `mode` is used only to spot links and submodules. An undo that makes a code file runnable (`100755`) with only blank-line changes is judged by its lines, so it can go through after a failed audit. Making a file runnable does not run it; anything that later runs it is a separate change that is checked (audit round 14, logged as Minor).
- **A merge request needs no card id.** `push_branch` refuses a missing card id (MAT-5); `merge` answers from the files and the reverse fields only, so it doesn't require one.
- **The snapshot checks permission bits only.** macOS access-control lists on the folder or file are not read. Adding one needs the owner's own access, the same as editing the file.

## Repair files: what the check cannot see

`repair-plain.mjs` is an allow-list and is stricter than the spec (see its header). An undeclared `repairs.max_statements` refuses every repair file. What it cannot see: a trigger, a custom operator or cast, a column default, a view, a row-level security policy or a domain check on the target table, a function called by attribute notation (`t.fn`), or a function named like a keyword it lets stand before `(` (for example `like`, `join`, `is`, `by`, `set`) runs code the file doesn't show. Each needs a function or trigger in the database first. Those are schema changes, which ship only as migrations under the `schema` class and always need Joe's Approve.
