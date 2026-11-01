# Lanes: who builds which folder

Set 29 Oct 2026 for the parallel build. One writer per folder. A lane that needs a change in another lane's folder asks that lane, or the lead; it never edits the folder itself.

| Lane | Folders | Milestones of the safety-rails phase (0b), in order |
|---|---|---|
| 1. Rules, Record, Approvals, Merge Gate | `orchestrate/modules/M10-rules`, `orchestrate/modules/M9-record`, `orchestrate/modules/M2-approvals`, `orchestrate/modules/M6-merge-gate`, `orchestrate/shared/` | 0b-0 (Claude-side rows), 0b-1, 0b-2, then 0b-5, 0b-9 |
| 2. Workshop and Dispatcher | `orchestrate/modules/M4-workshop`, `orchestrate/modules/M11-dispatcher` | 0b-3, 0b-4, then 0b-6 |
| 3. Sensors, Ledger, devices, Front Door | `orchestrate/modules/M12-sensors`, `orchestrate/modules/M13-ledger`, `orchestrate/modules/M1-front-door` | 0b-7, then 0b-8 |
| 4. Mini setup kit (started 1 Nov, LEAD-CALLS L86) | `orchestrate/setup/` | R-0b-05, the install and background jobs, the owner folders and keys, then R-0b-122 (watch-only week) |
| Lead (the ORCHESTRATE lead session) | `orchestrate/modules/M3-lead`, `orchestrate/modules/M5-review-audit`, `orchestrate/modules/M7-live-check`, `orchestrate/modules/M14-learning`, `orchestrate/test/`, this file | the cutover kit and the first cutover's runbook; the build rows; fresh audits |

Exception (LEAD-CALLS L65, for the review runner, #50): lane 2 may edit M9's verdict intake (`M9-record/outbox.mjs` and the verdict matching in `writer.mjs`) and its tests, add the one new file `orchestrate/shared/review-roles.mjs` (no existing shared file changes), and (L65 addendum 2) edit M6 `gather.mjs`, `refusals.mjs` and the M6 tests, so the Merge Gate reads the review runner's launch records through M9's one check and never the Record's copy.

More exceptions (1 Nov 2026), each limited to the files named:
- **Lane 2, the install layout (L92 addendum):** an installed copy `<name>.v-<commit>` mirrors the repo: `orchestrate/` plus `scripts/blueprint/yaml-lite.mjs`, with installRoot at `<v>/orchestrate`. Lane 2's updater and install closure test own that copy rule. The yaml-lite file itself is not theirs to change.
- **Lane 2, M6 `gate.mjs` (L94):** only `recover()` and `land()` and their tests, so a lost merge answer is recorded as refused for good (L102).
- **Lane 4, M12 (L97):** new files only, `M12-sensors/loop.mjs` and `M12-sensors/probes/`, for the Sensors loop and its probes (R-0b-169). Existing M12 files stay lane 3's.
- **Lane 1, M11 `gate.mjs` lines 17-23 (L105):** only to switch that check to the shared `pathKey`. The rest of M11 stays lane 2's.

Only rows tagged `cutover: first` are built before the first cutover. Rows tagged `cutover: second` wait until after it.
