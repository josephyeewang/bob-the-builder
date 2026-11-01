# orchestrate/shared/

Small helpers more than one module uses (the record file format, safe file writes). Secret masking is lane 3's, in `modules/M12-sensors/`; it is re-exported here once it merges. Owned by lane 1; other lanes ask the lead before adding here, so two lanes never edit the same file.

## The two interfaces other lanes code against

Import these, never the module folders behind them. Each has a fake for your own tests, so you don't wait on lane 1.

### `rules.mjs`: ask M10 Rules "may X happen?"

```js
import { makeRules, fakeRules, ACTIONS, RISKY_CLASSES } from '../../shared/rules.mjs';
const d = rules.may('push_branch', { product, card, files });  // { decision: 'allow'|'ask'|'deny', tier?, reason, rev }
rules.get('caps.editing_per_mac', { product });               // a value from the rules (Mac-wide ones: strictest across products)
rules.classify(change);                                       // { tier: 1|2, risky: [...RISKY_CLASSES], reasons, protected }
rules.rev;                                                    // the rules version, stamped on diary lines
```

- **It never throws and fails closed.** An unknown action, an error, or no readable rules is `deny`. A classification that fails is `unclassifiable`, Tier 1.
- `ask` means allowed only with the owner's answer, and `tier` names the answer channel: `tier: 1` is their own GitHub Approve, `tier: 2` a tap on M2's question box.
- Actions (`ACTIONS`): `start_session`, `write_production`, `push_branch`, `merge`, `count_approval`, `delete_copy`, `flip_switch`. A new one is added here first, by lane 1.
- What each action is asked with (missing fields are a deny):

  | Action | Subject |
  |---|---|
  | `start_session` | `{ product, role, tier, editing, card?, usage? }`. A Tier-1 start needs `usage.read_at` (an ISO time) that is fresh. |
  | `push_branch` | `{ product, card: { id, rows, kind?, doc: { lane } }, files }`. An exact reverse also passes `card.kind: 'exact_reverse'` and `reverses_files` (the reversed commit's paths). |
  | `merge` | `{ product, card, files, declared_tier, labels, truncated? }`. At the first cutover only a docs-lane change passes (`M10-rules/README.md`, L34); anything else is denied for MAIN to merge as today. An exact reverse also passes `kind: 'exact_reverse'`, `reverses` (the commit id), `exact_reverse_ok` (from M10's `checkExactReverse`) and `reversed_audit` (`failure`, `success` or `none`). |
  | `count_approval` | `{ product, ask_kind, risky, tier, channel }`. `channel` is where M2 read the answer (`github_review` or `tap`). The owner's own GitHub Approve (tier 1) is needed for a kind answered on GitHub, any risky class, or a Tier-1 go; a tap (tier 2) otherwise. "ask" at that tier when the channel matches, else deny. M2 counts an answer only on "ask" and its own binding check. |
  | `delete_copy`, `write_production`, `flip_switch` | denied in 0b |

- `classify(change)` takes `{ product, files: [{ path, previous_path?, status, mode?, added_lines?, removed_lines? }], truncated?, declared_tier?, labels? }`. It always uses the current rules: a `policy` or `atCommit` field is dropped, so a caller can't hand in looser rules. The GitHub-side checker reads the parent commit's rules with M10's `classifyWithRulesText`.
  - Until the effect-path scanner lands (second cutover), a changed file is ordinary only if it sits under `docs/` and is a plain file (`.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.yml`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.pdf`). Anything else comes back `unclassifiable`, Tier 1.
  - Any risky class or protected path makes the answer Tier 1, whatever the rules module returned.
  - Second cutover (the deep classifier; `classify()` uses it now, `merge` only with `deepMerge: true`): every added and removed line of a code file counts as a database change unless it is blank (deny by default, lead call L32, narrowed by audit rounds 12 and 13; see `M10-rules/README.md`). So the undo of a code change asks the owner unless every changed line is blank. On an exact-reverse merge, every code file must carry both `added_lines` and `removed_lines` (a file that is wholly removed or added must have lines on that side, and both may not be empty); a renamed or copied code file always asks; otherwise the answer is "ask the owner". `may()` and `classify()` read every field of the answer and the change inside a try, so even a throwing getter gives a deny or an unclassifiable answer.
  - If the rules can't classify a change at all, every file it names counts as protected (never an empty list).
- Every `files` entry has at least `{ path, status }`, with `previous_path` set for a rename or copy; `classify` and the `merge` answer also read `mode`, `added_lines` and `removed_lines` when given.
- **Held, not refused.** A `deny` whose reason is in `HOLD_REASONS` (`held_tier1_hours`, `rules_not_adopted`) means "wait and keep the place in the queue". Test membership in the list; never parse reason text. M10 answers `held_tier1_hours`; the Merge Gate sets `rules_not_adopted` itself while the rules file at the expected parent differs from the adopted one (`get('rules.adopted', { product })` gives the full ids).
- **Hooks don't call `may()`.** A hook that must answer without the network reads M10's snapshot through `snapshotAnswer` in `modules/M10-rules/snapshot.mjs` (`write_production`, and `snapshot_fresh` to check the snapshot is usable).
- **Gate only on `may()`.** `get()` is for display and sizing. An undefined `get()` means refuse, never "no limit".
- Tests: `fakeRules({ answers: { merge: allow('ok') }, values: { 'caps.rounds': 3 } })`. Unlisted actions are denied, as with the real rules.

### `record.mjs`: read and write M9 Record

```js
import { makeRecord, memoryRecord, STATES, ENTITIES, WAIT_FIELDS } from '../../shared/record.mjs';
rec.read('card', 'C-12');                       // { id, doc, rev } or null
rec.list('card');
rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-12', expectRev: 3, doc, kind: 'claim' });  // { ok, rev, seq } | { ok: false, reason }
rec.applyOutbox({ role: 'worker', sessionId: 'S-4', card: 'C-12' }, outboxFilePath);
rec.diary({ since: 0 });
rec.ready();                                    // cards that may start now (the one ready rule)
rec.overdue(now);                               // documents past their time limit or their wait's next_check
rec.release({ card: 'C-12', session_id: 'S-4' });   // only the claim's holder
rec.breakIfDead({ card: 'C-12' });              // only when the owner is provably gone (M9 README, "Claims")
rec.lapseClaims(now);
```

- **Claims are a field on the card** (`claim`), set by `ready → claimed` and cleared when the card leaves claimed and running. `claimed → ready` and `running → ready` are never a plain write: they happen only through `release`, `breakIfDead` or `lapseClaims`.
- **Outbox kinds** (`OUTBOX_KINDS`) are the file-name prefixes each AI role may send. A worker hands its card in with `handin-` (running → in_review). An `ask-request-` is stored as an inert report; only `approvals` turns it into an ask.
- **Plan fingerprint**: `plan-fingerprint.mjs` is the one fingerprint a go binds to. M2 Approvals stores it on the go; M9 recomputes it at `draft → ready`. Its `cleanPath` is the one rule for a plan's file path (L87).
- **Plan review pass**: `plan-review.mjs` is the one shape of a fresh plan reviewer's pass, which a Tier-1 go needs. `planPass` builds it from M3's read of the reviewer's answer plus ids the reviewer can't write (the card, its fingerprint, and the two sessions from the launch records). M2's `planCheckProblem` checks it (L87).

- **Required fields** (`REQUIRED_FIELDS`) are refused when missing, by the fake too: a card's `state` and `module`; a verdict's `session_id` and `head`; every field of `merge_request` and of `launch` (both written by the Dispatcher only), except that a launch names a `card` and `head` only for a worker, reviewer or auditor (`CARD_ROLES`; one check, `missingFields`).
- **Final states** (`FINAL_STATES`) need no time limit; every other state has one in the rules. `closed → reverted` is the one move out of a final state.
- **`joe` writes nothing**: the owner's answers reach the record through `approvals`.
- **Only plain scripts call `write`**, under their own actor name (`SCRIPT_ACTORS`). AI sessions never do: the Dispatcher hands their outbox files to `applyOutbox`, tagged with the session's role.
- **Every write is "only if unchanged since read"**: pass the `rev` you read (`0` to create). A mismatch is refused. Each accepted write leaves one diary line; a refused one leaves none.
- `write` and `applyOutbox` never throw; any failure is `{ ok: false, reason }`.
- The names (`SCRIPT_ACTORS`, `AI_ROLES`, `ENTITIES`, `STATES`, `FINAL_STATES`, `REQUIRED_FIELDS`, `WAIT_FIELDS`) are defined once, here.
- Tests: `memoryRecord()` keeps the rev check and the diary only. The real Store Writer (M9) adds the legal state moves and who may change what, so code that passes on the fake can still be refused by the real one.

## Test temp folders: `test-tmp.mjs`

Every orchestrate test that needs a temp folder gets it here, so it is removed when the test file ends, pass or fail (leftover test folders filled a Mac's disk, 29 Oct 2026):

```js
import { tempDir } from '../../shared/test-tmp.mjs';   // a static import at the top, never inside a test
const dir = tempDir('m12-history-');                    // a lane or module prefix: m1- to m99-, orch-, air-, sg-, hist-, roles-, scan-
```

`tmp-guard.test.mjs` fails any orchestrate file that calls `mkdtemp` itself, and runs every orchestrate suite with a private temp folder to check nothing is left. Files that haven't switched yet are listed in its `NOT_SWITCHED_YET`; delete your file's line when you switch.
