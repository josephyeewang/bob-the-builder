# M11-dispatcher

See LANES.md for who builds this folder, and the build rows for what (0b-6: R-0b-55 to 65, 67, 68).

Every outside effect (launching, stopping, typing into a session, git, alerts) is a port that the wiring connects, so the tests run on fakes, throwaway folders and throwaway git repositories only. No file here starts a Claude session; `only-send-safe.test.mjs` checks that no file types into a session except through a `send` port wired to M4's send-safe guard.

## Files

| File | What it does | Rows |
|---|---|---|
| `pass.mjs` | The main pass: bands, host.lock, compactions, stops at a safe point, parked work resuming, starts, a paused product's Lead hand-off; `runPass` adds the one-pass-at-a-time lock | 55, 59, 64, 67 |
| `pass-lock.mjs` | Only one pass at a time | 55 (M16) |
| `gate.mjs` | The one start gate (band, caps, files don't overlap); also launch check 12 | 61, 67 |
| `usage.mjs` | Usage bands from the usage fact | 67 |
| `outage.mjs` | Dead sessions and outages | 56, 60 |
| `merges.mjs` | Merge attempts and the time limits | 57 |
| `cleanup.mjs` | Removing a worker's copy only when proven merged, else seal and ask | 57 |
| `transcript.mjs` | A session's size and safe point from its transcript | 58, 63, 64 |
| `outbox-intake.mjs` | Using outbox files | 62 |
| `lead-restart.mjs` | The Lead's restart from its handoff | 63 |
| `phone-link.mjs` | Network, phone link and Mini Base | 60 |
| `undo.mjs` | The [Undo] tap | 68 |
| `headless-result.mjs` | A headless worker's final result | 65 |
| `login-job.mjs` | The login job file | 55, 65 |
| `keys.mjs` | Every rules key this folder reads | all |

## Facts this folder reads or writes (the contracts)

| Fact id | Written by | Shape |
|---|---|---|
| `usage-<account>` | M12 Sensors (lane 3), to the review's M5 contract | `{ account, observed_at, source, week: {used_pct, resets_at}, h5: {used_pct, resets_at} }` |
| `usage-band` | this folder | `{ band: green/amber/red/unknown, own_building, reason, account, decided_at, unknown_since }` |
| `signed-in-account` | M12 | `{ account, observed_at }` |
| `pr-<n>` | M12 | `{ state, merged, merge_commit_sha, head_sha, observed_at }` |
| `outage` | this folder | `{ state: open/ended, ... }` |
| `limit-hit-<account>` | M12 (screen rules) or a worker's exit result | `{ resets_at }` |
| `network-up`, `frontdoor-reachable`, `minibase-running` | M12 | `{ value: true / false / "unknown", observed_at }` |
| `phone-link` | this folder | the phone-link step's memory |
| `lead-restart-<session>` | this folder | the Lead restart's phase |
| `cleanup-<card>`, ask `delete-copy-<card>` | this folder | the cleanup proof and the ask to Joe |
| `stop-<session>`, `compactions-<card>`, `host-lock-seen`, `pause-<product>`, `usage-unknown-alert` | this folder | the main pass's memory |
| `reverse-<undo card>` | M6 (lane 1, 0b-9) | `{ state: clean / not_clean, reason }` |

Card waits use `waiting` with every wait field. The causes this folder writes: `usage_band`, `limit_hit` (read), `needs_split`, `budget_stop`, `usage_unknown`.

## New rules keys (for lane 1's schema)

`usage.pace_min_share`, `caps.shakedown`, `usage.bands.amber.editing_per_product`, `usage.bands.amber.editing_per_mac`, `timeouts.cancel_grace_min`, `timeouts.park_wait_min`, `timeouts.dead_quiet_min`, `timeouts.claimed_no_session_min`, `timeouts.checking_max_min`, `timeouts.reporting_max_min`, `timeouts.in_review_no_reviewer_min`, `timeouts.front_door_stuck_min`, `timeouts.usage_unknown_max_min`, `outage.min_dead`, `outage.share`. The list is `NEW_KEYS` in `keys.mjs`. A missing key refuses (start nothing), except the two defaults there: the pace floor (L13) and shakedown on.

## Open items and deviations (written down so they are not lost)

| Item | Kind | What could go wrong | Who decides or checks | When |
|---|---|---|---|---|
| Own building does not change `band` | Deviation, logged | Own building amber or full narrows what starts, but the `band` fact stays green or amber. Anything that reads only `band` would miss it. | The lead (already told). | n/a |
| Thinking sessions hand in `report-` | Deviation, logged | A Lead's thinking session uses the reviewer profile but writes a `report-` file, because that is the reviewer's only outbox kind. | The lead. | n/a |
| Cleanup ignores Claude's own protected files | Deviation | When comparing a copy with the merged tree, `.claude` and the other protected names are skipped, because the launcher puts them there. A real change in them would not be compared. | The lead. | n/a |
| Untracked or ignored files count as unsaved edits | Open item, fails closed | A copy with a dependency folder or other ignored files never matches the tree, so its removal always becomes an ask. Safe, but Joe gets asks. | The lead: keep, or skip a named list of folders. | Before the first real cleanup. |
| The delete answer is the word `delete` | Contract for M2 | Cleanup removes a copy only when the answered ask says `answer: "delete"`. Any other answer keeps it. An "allow" from the rules is still treated as an ask. | M2's builder must write that exact word. | With M2's answer path. |
| The handoff size check sits in the outbox intake | Deviation | An oversize handoff is not claimed, so the Lead can rewrite it under the same name. | The lead. | n/a |
| A Lead session id must be letters, digits and dashes | Deviation | Any other id is refused before a handoff name is built from it. | n/a | n/a |
| The Lead after a hit limit | Open item | Cards waiting on a hit limit are handled (Tier 2 resumes, Tier 1 waits on Joe). The Lead itself is a session, not a card, so the "Lead waits on Joe after a reset" half of M8 is left to the Lead's launcher wiring. | This lane, with the Lead's launch wiring. | Before the Lead runs headless. |
| A parked card on a paused product goes back to `ready` | Deviation | The rules' `start_session` answer holds it while the product is paused, so it is not given a wait of its own. | The lead. | n/a |
| Undo cards skip the caps | Deviation | An undo card is "go-free and first": it starts in any band and is not counted against the editing caps or the files check. | The lead. | n/a |
| The headless result shape and the budget cap | Capability note, not yet checked (Principle 9) | The final result's fields and whether the budget cap works on a subscription login are unverified. `CHECKED_AGAINST` is empty and the code treats anything unreadable as a stop that needs Joe. | The builder, at the live proof, with the date and the Claude Code version. | Void at the next version pin. |
| The transcript format | Capability note, not yet checked (Principle 9) | The size, turn-end and compaction readings follow the format as reviewed, not as checked on the pinned version. | The builder, at the live proof. | Void at the next version pin. |

## Live proofs still to run (plain steps)

These need the real Mac Mini, its `orchestrate` Mac user and the test repo `orchestrate-test`, which do not exist yet. Joe's steps come first; the builder's (Claude's) checks follow.

**1. The Dispatcher starts at login (R-0b-55, R-0b-65). Who: Joe installs, both check.**
1. Joe: when the `orchestrate` Mac user exists, the builder writes the job file with `loginJobPlist` and tells you exactly where it goes.
2. Joe: log in to the Mac Mini as `orchestrate` (or restart the Mini if it logs in by itself).
3. Both: one minute later, the builder checks the record's diary for a pass, and the job's log file for no errors.
4. Both: write down whether the job needs the `orchestrate` user logged in, or runs as a background job without a login (G-m7), with the date.

**2. The phone link restarts (R-0b-60, L15). Who: both.**
1. Joe: with the Front Door open on the Mini, turn the phone's Wi-Fi and data off for 3 minutes, then on.
2. Both: the builder checks that `/remote-control` was typed once, and that nothing was typed while the Front Door was waiting on a question.

**3. A headless worker's budget stop (R-0b-65). Who: the builder, on the test repo.**
1. Start one worker on a throwaway card with a very small turn cap.
2. Check that its card ends `waiting` on Joe with `budget_stop`, and write down the result's exact fields and the Claude Code version.

**4. Two compactions (R-0b-64). Who: the builder, on the test repo.**
1. Force two compactions across two sessions of one card.
2. Check the card ends `waiting` on the Lead with `needs_split`.
