# M4-workshop

See LANES.md for who builds this folder, and the build rows for what.

## Open items (written down so they are not lost)

| Item | Kind | What could go wrong | Who decides or checks | When |
|---|---|---|---|---|
| A question asked in plain text (audit R-0b-29 m11) | Decision for the lead | If a role asks Joe something in ordinary text and ends its turn, without the question box, the session looks idle and a WRAP nudge may be typed over the question. | The lead: either every role question must use the question box (a rule in its role file), or the Dispatcher checks the last message for an open question before any WRAP. | Before the Dispatcher's WRAP nudge is turned on (0b-6). |
| A stop while a helper's dialog is still open (audit R-0b-29 m12) | Live check, next to L1 | A turn's end counts as proof that any dialog was answered. If a background helper's permission dialog can still be on screen after the main turn ends, a nudge could be typed into it. | Joe and the builder, on the pinned Claude Code. | With live check L1, and again at every version pin change. |
| Two question boxes open at once (audit R-0b-29 round 2) | Live check, next to L1 | The code remembers every open box on the stored session record, so a restart of the tracker does not forget one; the check only confirms whether two boxes can happen. | Joe and the builder. | With live check L1. |
| The launch label is not yet passed in (audit R-0b-29 round 3 n1) | Wiring, for the row that builds the hook relay | The tracker can now ignore hooks from a stopped launch, but nothing yet gives each launch a label, passes it to the hooks or calls `beginLaunch`. Until then every session accepts every hook, as before. | The builder of the hook relay (the launcher's start step calls `beginLaunch`; each hook line carries the label). | Before the Lead or Front Door restart path (§5.5) is turned on. |
| One-shot runs inside a worker's folder (audit R-0b-29 round 3 n4) | Wiring, for the row that builds the hook relay | A one-shot `claude -p` run (the baseline and smoke runs, or the read-back) fires hooks too. If its hooks were counted as the worker's, its prompt would look like the person answering and could lift a dialog. | The builder of the hook relay: drop hooks whose session id is not the role's own (upstream does the same). | With the hook relay. |

The launch check (audit m3): the tracker's half is built (`ActivityTracker.beginLaunch`, tested); the wiring is the open item above.
