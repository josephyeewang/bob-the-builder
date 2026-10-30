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
- `ask` means allowed only with Joe's answer: `tier: 1` is his GitHub Approve, `tier: 2` a tap.
- Actions (`ACTIONS`): `start_session`, `write_production`, `push_branch`, `merge`, `count_approval`, `delete_copy`, `flip_switch`. A new one is added here first, by lane 1.
- What each action is asked with (missing fields are a deny):

  | Action | Subject |
  |---|---|
  | `start_session` | `{ product, role, tier, editing, card?, usage? }`. A Tier-1 start needs `usage.read_at` (an ISO time) that is fresh. |
  | `push_branch` | `{ product, card: { id, rows, kind?, doc: { lane } }, files }`. An exact reverse also passes `card.kind: 'exact_reverse'` and `reverses_files` (the reversed commit's paths). |
  | `merge` | `{ product, card, files, declared_tier, labels, truncated? }`. An exact reverse also passes `kind: 'exact_reverse'`, `reverses` (the commit id), `exact_reverse_ok` (from M10's `checkExactReverse`) and `reversed_audit` (`failure`, `success` or `none`). |
  | `count_approval` | denied until 0b-5 M2 Approvals switches it on |
  | `delete_copy`, `write_production`, `flip_switch` | denied in 0b |

- `classify(change)` takes `{ product, files: [{ path, previous_path?, status, mode?, added_lines?, removed_lines? }], truncated?, declared_tier?, labels? }`. It always uses the current rules: a `policy` or `atCommit` field is dropped, so a caller can't hand in looser rules. The GitHub-side checker reads the parent commit's rules with M10's `classifyWithRulesText`.
  - Until the effect-path scanner lands (second cutover), a changed file is ordinary only if it sits under `docs/` and is a plain file (`.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.yml`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.pdf`). Anything else comes back `unclassifiable`, Tier 1.
  - Any risky class or protected path makes the answer Tier 1, whatever the rules module returned.
  - Every added and removed line of a code file counts as a database change unless it is a comment, a blank line, a plain read or a test fixture (deny by default, lead call L32; see `M10-rules/README.md`). So the undo of a code change asks Joe unless only comments change. On an exact-reverse merge, every code file must carry both `added_lines` and `removed_lines` (a file that is wholly removed or added must have lines on that side, and both may not be empty), or the answer is "ask Joe". `may()` and `classify()` read every field of the answer and the change inside a try, so even a throwing getter gives a deny or an unclassifiable answer.
  - If the rules can't classify a change at all, every file it names counts as protected (never an empty list).
- `files` is always `[{ path, status, previous_path? }]`, with `previous_path` set for a rename or copy.
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
```

- **Required fields** (`REQUIRED_FIELDS`) are refused when missing, by the fake too: a card's `state` and `module`; a verdict's `session_id` and `head`; every field of `launch` and `merge_request` (both written by the Dispatcher only).
- **Final states** (`FINAL_STATES`) need no time limit; every other state has one in the rules. `closed → reverted` is the one move out of a final state.
- **`joe` writes nothing**: Joe's answers reach the record through `approvals`.
- **Only plain scripts call `write`**, under their own actor name (`SCRIPT_ACTORS`). AI sessions never do: the Dispatcher hands their outbox files to `applyOutbox`, tagged with the session's role.
- **Every write is "only if unchanged since read"**: pass the `rev` you read (`0` to create). A mismatch is refused. Each accepted write leaves one diary line; a refused one leaves none.
- `write` and `applyOutbox` never throw; any failure is `{ ok: false, reason }`.
- The names (`SCRIPT_ACTORS`, `AI_ROLES`, `ENTITIES`, `STATES`, `FINAL_STATES`, `REQUIRED_FIELDS`, `WAIT_FIELDS`) are defined once, here.
- Tests: `memoryRecord()` keeps the rev check and the diary only. The real Store Writer (M9) adds the legal state moves and who may change what, so code that passes on the fake can still be refused by the real one.
