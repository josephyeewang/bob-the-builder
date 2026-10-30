# M4-workshop

See LANES.md for who builds this folder, and the build rows for what.

## Open items (written down so they are not lost)

| Item | Kind | What could go wrong | Who decides or checks | When |
|---|---|---|---|---|
| A question asked in plain text (audit R-0b-29 m11) | Decision for the lead | If a role asks Joe something in ordinary text and ends its turn, without the question box, the session looks idle and a WRAP nudge may be typed over the question. | The lead: either every role question must use the question box (a rule in its role file), or the Dispatcher checks the last message for an open question before any WRAP. | Before the Dispatcher's WRAP nudge is turned on (0b-6). |
| A stop while a helper's dialog is still open (audit R-0b-29 m12) | Live check, next to L1 | A turn's end counts as proof that any dialog was answered. If a background helper's permission dialog can still be on screen after the main turn ends, a nudge could be typed into it. | Joe and the builder, on the pinned Claude Code. | With live check L1, and again at every version pin change. |
| Two question boxes open at once (audit R-0b-29 round 2) | Live check, next to L1 | The code now remembers every open box, so this is safe either way; the check only confirms whether it can happen. | Joe and the builder. | With live check L1. |

The launch check (audit m3) is no longer open: hooks from a stopped launch are dropped (`ActivityTracker.beginLaunch`).
