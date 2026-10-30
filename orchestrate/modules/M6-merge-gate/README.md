# M6-merge-gate

M6 Merge Gate is the only way a change reaches main. It takes one merge request at a time, re-reads everything about the change from GitHub and the M9 record, judges it against fourteen refusals, and merges only the exact head it judged, as the robot. Every merge it makes carries the robot's mark, so the checks that run after a merge (the audit and the build-skip command) can tell a gate merge from a hand push.

See LANES.md for who builds this folder, and the build rows (0b-9, R-0b-86..99) for what.

## The files

| File | What it does |
|---|---|
| `gate.mjs` | One pass of the gate: intake of merge requests, the queue (undo cards first, then oldest), catching a branch up with main, the paired write (merge `checking` + card `merging`), the squash merge of the judged head, the mark, and recovery when a pass stopped half-way. Starts only while the outside check says the robot may merge and nobody pushed by hand. |
| `gather.mjs` | Reads every fact the refusals judge: the pull request, main, checks and statuses, the change's files (with their modes), M10's tier and lane answer, the reviewer's verdict, the go, the Approve, review threads, carry-over from the reviewed head, and whether the rules in force are the adopted ones. Anything it can't read arrives as "unknown" and refuses. |
| `refusals.mjs` | The fourteen refusals as one pure function over the facts (`judge`), plus the two holds (Tier-1 hours, rules not adopted). L44's accept side: a verdict counts only from a launched reviewer's own outbox, for that head, with the four-line checklist and zero Material. |
| `undo.mjs` | The gate's half of the undo route: what an undo card undoes (from its source: the Undo ask's card, or the audit issue's commit), and marking the undone card `reverted` once the undo merges. |
| `mark.mjs` | The robot's mark: a commit status by the robot's bot account naming the card and judged head, on the merge commit of a pull request the robot merged. |
| `token.mjs` | The robot's installation token: minted per run from the key file, held in memory only, refused if the key file is not owned by and private to the scripts' user. |
| `workflow-rule.mjs` | The audit rule for a product's GitHub workflows: all read-only except the audit workflow, and none of the patterns that let outside text steer a workflow. |
| `workflow-route.mjs` | A workflow change's own route: the owner approves the resulting files' fingerprint, and only exactly that may be pushed. |
| `audit-run.mjs` | Reads a post-merge audit run: flagged only when the named verdict step failed and every step before it passed; an issue may start an undo card only when it names a flagged run of the declared audit workflow. |
| `checker-entry.mjs` | The checker that runs on GitHub's side after a merge: the mark, the classification at the parent commit, and the owner's Approve where the files need it. |
| `build-checker.mjs` | Builds `github-checker.mjs`, the one-file copy of the checker the outside-check repo keeps. Rebuild with `node build-checker.mjs <40-hex commit>` whenever any file it bundles changes; its test fails if the committed copy is stale. |
| `github-checker.mjs` | Generated. Never edit by hand. |
| `build-skip.mjs` | The deploy's "ignored build step" command: build nothing but main, and in full mode only a marked main commit. Every failure skips the build. |
| `*.test.mjs` | The tests. `fixtures/` holds a fake GitHub for the gate and the checker; not tests. |

## The rules in one place

- **One merge at a time.** A merge moves `requested → queued → (catching_up) → checking → merging → merged`, and after the audit `audited_ok` or `audit_flagged`. Only one merge is ever in `checking` or `merging`.
- **The judged head is the merged head.** The merge call names the head that was judged; if the branch moved, GitHub refuses and the merge is refused.
- **First cutover:** the docs lane only (M10 decides by path, including file modes, so a link file is out). An undo merges at first cutover only if it reverses a merge the gate itself made. The daily card does not merge through the gate yet.
- **An undo** (an exact-reverse card) goes first in the queue and needs no review, request or Approve, but only when M10 recomputes the change as the exact reverse of the commit its source names. Anything else is refused (9).
- **A change sent back** keeps its place in the queue: its waiting time runs from its first request.
- **Proposals from the owner's own tabs** get every refusal a worker's change gets (the planted tests in `gate.test.mjs`: a workflow file, a link, a risky act with no Approve, a Tier-1 change whose go is for Tier 2).

## What the tests cover, and what they don't

- **GitHub is faked.** `fixtures/fake-gate-github.mjs` follows the REST shapes (API version 2022-11-28, checked 30 Oct 2026); the real API is not called.
- **The planted tests use M10's real engine on its sample policy**, at both cutovers. The push script's half of R-0b-98 is lane 2's (R-0b-45).

## Not built here (logged)

- **R-0b-97** (second cutover) is deferred.
- **A parent moved under a merge** (r3-m1) raises an alert with "Undo?" for the owner; the change is not re-judged at the real parent.
- **The Lead's fix card and telling the owner** when an undo can't be reversed cleanly are lane 2's.
- **Tab claim** on the gate's pass is not checked here.
- **The build-skip command's length** against the deploy host's field limit is not verified.

## Choices made while building (for the lead to confirm)

- The `orchestrate/needs-joe` status is how the checker learns the gate saw an Approve need; missing counts as needed.
- An undo pull request's body carries one `reverses: <40-hex>` line for the GitHub-side checker; the gate itself reads the undone commit from the card's source.
- The audit's read (did the run flag?) and the verdict (may an issue start an undo?) are separate functions.
- The owner's review must be on the exact merged head.

## Owner steps before this goes live

- Paste the build-skip command into the deploy host's project settings.
- Create the robot (GitHub App), install it, and put its key in the orchestrate key folder (set up with `/apikeys`; the key is never read by a session).
- Put the robot's numeric bot id in the rules (`product_profile.robot.bot_user_id`).
