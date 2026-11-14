# Lanes: who builds which folder

Set 29 Oct 2026 for the parallel build. One writer per folder. A lane that needs a change in another lane's folder asks that lane, or the lead; it never edits the folder itself.

| Lane | Folders | Milestones of the safety-rails phase (0b), in order |
|---|---|---|
| 1. Rules, Record, Approvals, Merge Gate | `orchestrate/modules/M10-rules`, `orchestrate/modules/M9-record`, `orchestrate/modules/M2-approvals`, `orchestrate/modules/M6-merge-gate`, `orchestrate/shared/` | 0b-0 (Claude-side rows), 0b-1, 0b-2, then 0b-5, 0b-9 |
| 2. Workshop and Dispatcher | `orchestrate/modules/M4-workshop`, `orchestrate/modules/M11-dispatcher` | 0b-3, 0b-4, then 0b-6 |
| 3. Sensors, Ledger, devices, Front Door | `orchestrate/modules/M12-sensors`, `orchestrate/modules/M13-ledger`, `orchestrate/modules/M1-front-door` | 0b-7, then 0b-8 |
| 4. Mini setup kit (started 1 Nov, LEAD-CALLS L86) | `orchestrate/setup/` | R-0b-05, the install and background jobs, the owner folders and keys, then R-0b-122 (watch-only week) |
| 7. Screen reading, the herdr harvest (LEAD-CALLS L1052, L1064) | `orchestrate/modules/M12-sensors/screen/`, `orchestrate/modules/M12-sensors/third_party/herdr/` (new files only; see the exception below) | 0b-herdr-harvest, then 0b-herdr-relay |
| Lead (the ORCHESTRATE lead session) | `orchestrate/modules/M3-lead`, `orchestrate/modules/M5-review-audit`, `orchestrate/modules/M7-live-check`, `orchestrate/modules/M14-learning`, `orchestrate/test/`, this file | the cutover kit and the first cutover's runbook; the build rows; fresh audits |
| Wiring (shared; owners per file below) | `orchestrate/wiring/` | none of its own: each file is wired for the milestone of the lane that owns it |

Exception (LEAD-CALLS L65, for the review runner, #50): lane 2 may edit M9's verdict intake (`M9-record/outbox.mjs` and the verdict matching in `writer.mjs`) and its tests, add the one new file `orchestrate/shared/review-roles.mjs` (no existing shared file changes), and (L65 addendum 2) edit M6 `gather.mjs`, `refusals.mjs` and the M6 tests, so the Merge Gate reads the review runner's launch records through M9's one check and never the Record's copy.

More exceptions (1 Nov 2026), each limited to the files named:
- **Lane 2, the install layout (L92 addendum):** an installed copy `<name>.v-<commit>` mirrors the repo: `orchestrate/` plus `scripts/blueprint/yaml-lite.mjs`, with installRoot at `<v>/orchestrate`. Lane 2's updater and install closure test own that copy rule. The yaml-lite file itself is not theirs to change.
- **Lane 2, M6 `gate.mjs` (L94):** only `recover()` and `land()` and their tests, so a lost merge answer is recorded as refused for good (L102).
- **Lane 4, M12 (L97):** new files only, `M12-sensors/loop.mjs` and `M12-sensors/probes/`, for the Sensors loop and its probes (R-0b-169). Existing M12 files stay lane 3's.
- **Lane 1, M11 `gate.mjs` lines 17-23 (L105):** only to switch that check to the shared `pathKey`. The rest of M11 stays lane 2's.
- **Lane 4, M6 (L107):** new files only, `M6-merge-gate/watch-only.mjs`, `watch-run.mjs` and their tests, for the watch-only week (R-0b-122). Existing M6 files stay lane 1's and lane 2's as above.
- **Lane 4, CI (L109):** the one macOS job in `.github/workflows/scripts-ci.yml` that runs the setup tests, and its guard test. The other jobs stay the lead's.
- **Lane 4, M4 `launcher/review-daemons.mjs` (L113):** an export-only change (`plist`, `str`, `arr`, `LABEL`, `ABS`), with no behaviour change, as its own commit with lane 2 told, so the watch-only week's hourly job reuses the one plist builder. The rest of M4 stays lane 2's.
- **Lane 7, M12 screen reading (L1052, L1064):** new files only, `M12-sensors/screen/` and `M12-sensors/third_party/herdr/`, for the herdr harvest (R-0b-149 to 153). `screen/waiting.mjs` is M4's decision, kept here until R-0b-153a wires it into sendSafe. Existing M12 and M4 files stay their lanes'.

**`orchestrate/wiring/`, the shared folder (lead call, 14 Nov 2026).** Each lane adds the files that connect its module to the real Mac, so this folder has one writer per file, not per folder. The owners below are taken from git history (the source pull request of every commit), or set by the lead where it was mixed. A shared file is edited the way AGENTS.md's "Who changes what" table says: pull first and keep edits small. The guard tests are `orchestrate/test/wired.test.mjs` and `orchestrate/wiring/*.test.mjs`; run them before a change here.
- **One owner.** A name with no note: that lane added the file, and any other lane edited it at most once. A name marked *(lead call)*: owner by lead call, 14 Nov 2026, where the history was mixed.
  - Lane N: `push-pass`, `pr-writer`, `gate-ports`, and `robot-push` once #536 lands.
  - Lane 2: `review-ports`, `worker-ports`, `worker-runner`, `owner-ports`, `runner-locked` (the containment side), `script-outbox.test` (outbox intake is lane 2's under L65); all *(lead call)*.
  - Lane 4: `heartbeat-probes`, `not-wired`, `phone-ports`, `runner-job`, `runner-launch`, `sensors-wiring`; and *(lead call)* `runner-ports`, `runner-main`, `runner-loop`, `runner-files`, `owner-status`, `owner-asks` (it goes with owner-status).
  - Lane 3: `private-folder`.
  - Lane 5: `owner-answer`, `sensors-ports`.
  - Lane A: `claude-folder-name`.
  - Lanes N, 5 and A are not in the table above.
  - Each name covers the `.mjs` file and its test.
- **Shared** (the entry points that every lane's pass is added to): `robot-wiring`, `robot-main`, `dispatcher-wiring`, `README.md` and `fake-github.test-helper.mjs`. Lanes 1 to 5 have edited them. Also `runner-checks` *(lead call)*: four lanes add checks to it.

Only rows tagged `cutover: first` are built before the first cutover. Rows tagged `cutover: second` wait until after it.
