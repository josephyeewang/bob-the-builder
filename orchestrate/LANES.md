# Lanes: who builds which folder

Set 29 Oct 2026 for the parallel build. One writer per folder. A lane that needs a change in another lane's folder asks that lane, or the lead; it never edits the folder itself.

| Lane | Folders | Milestones of the safety-rails phase (0b), in order |
|---|---|---|
| 1. Rules, Record, Approvals, Merge Gate | `orchestrate/modules/M10-rules`, `orchestrate/modules/M9-record`, `orchestrate/modules/M2-approvals`, `orchestrate/modules/M6-merge-gate`, `orchestrate/shared/` | 0b-0 (Claude-side rows), 0b-1, 0b-2, then 0b-5, 0b-9 |
| 2. Workshop and Dispatcher | `orchestrate/modules/M4-workshop`, `orchestrate/modules/M11-dispatcher` | 0b-3, 0b-4, then 0b-6 |
| 3. Sensors, Ledger, devices, Front Door | `orchestrate/modules/M12-sensors`, `orchestrate/modules/M13-ledger`, `orchestrate/modules/M1-front-door` | 0b-7, then 0b-8 |
| Lead (the ORCHESTRATE lead session) | `orchestrate/modules/M3-lead`, `orchestrate/modules/M5-review-audit`, `orchestrate/modules/M7-live-check`, `orchestrate/modules/M14-learning`, `orchestrate/test/`, this file | the cutover kit and the first cutover's runbook; the build rows; fresh audits |

Only rows tagged `cutover: first` are built before the first cutover. Rows tagged `cutover: second` wait until after it.
