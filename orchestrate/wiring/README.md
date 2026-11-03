# wiring/: the modules a config names

The login job's config names a wiring module by its path, and the entry script imports it. This folder holds the
Dispatcher's and the robot job's (R-0b-162). The review runner's wiring is in `modules/M4-workshop/launcher/review-wiring.mjs`.

| File | What it is |
|---|---|
| `dispatcher-wiring.mjs` | `wire(config, { limitedSync })` for `modules/M11-dispatcher/main.mjs`. It returns the real Record (M9), the real rules (the M10 reader, engine and `shared/rules.mjs`, with a read-only GitHub client) and the tick's ports. The config keys are listed at the top of the file. |
| `dispatcher-wiring.test.mjs` | Runs `node main.mjs <config>` as a separate process with this wiring. It checks one full pass, a second run, rules Joe has not approved, an unknown config key, and that every port not wired yet refuses. It runs in CI. |
| `robot-main.mjs` | The robot job's entry (L236, L238): `node robot-main.mjs <config>`. One round of the robot passes (gate, heartbeat, caught-up, watch, then deliver), each with its own time limit, under a lock of its own. A pass that fails is told to Joe once a day; the other passes still run. Exit 0 ran, 1 not started, 2 late. |
| `robot-wiring.mjs` | `wire(config)` for `robot-main.mjs`. The Dispatcher's config keys plus `keyDir`. It refuses to start unless the job runs as the Record's owner and owns `keyDir`, a private plain folder (L238). Real now: caught-up, and the heartbeat's "the Dispatcher is late" check. Gate, the rest of the heartbeat, and watch refuse until their clients exist. |
| `robot-wiring.test.mjs` | Runs `node robot-main.mjs <config>` as a separate process: every pass is told or runs, the startup refusals, caught-up pushing once on the Dispatcher's return (never mid-outage), and the late-Dispatcher alert. It runs in CI. |
| `fake-github.test-helper.mjs` | The test's only stand-in, for api.github.com. It can be loaded into a whole process with `node --import`. |

**Not wired yet (PR A of R-0b-162).** Every port other than the Record, the rules and the lock throws `not wired yet: <port>` when called. The step that needs that port fails, and Joe is told which step and why. Nothing answers with a made-up value. PRs C and D wire these ports. **Approvals (L270)** is wired: each tick it runs M2's schedule pass for the product, so a product whose rules file says `onboarding.state: active` is turned on. Its state folder is `<approvalsStateDir>/<product>`, one per product so two products never share a told-once mark; at start-up the folder and the product's subfolder are made if missing, and the start is refused unless each is a plain folder of this user's, private and writable (L295). Its GitHub writes and transcript copies still refuse (`not wired yet: approvals.gh` / `approvals.copies`) until a GitHub identity that can write exists, and there is no phone push. An ask that needs them is not failed: M2 alerts that ask's cause once (per ask and cause, kept in the state folder), and again only after a push for it went through and a new failure came.

**No channel to Joe is connected yet.** M13's `makeAlerts` (GitHub issues) is the channel; lane 3 is building its delivery adapter (L235), and this folder wires it in once it exists. Until then the alert port writes each alert to the login job's log and answers "not delivered", so alerts stay in the record's unsent queue and are never marked as told.

**Alerts reach Joe with the Dispatcher dead (L242).** The alert queue belongs to the Record, and delivery runs in the robot job, never in the Dispatcher (L236, L237). The robot job's last pass, `deliver`, sends what the passes before it queued, in the same round. Its port is lane 3's M13 `deliverAlertsPass`; until that lands, `deliver` refuses and the alerts stay queued.

**When the worker-exit port is wired (PR C):** it must call M12 `writeLimitHit` with its own default clock, never the pass's frozen `now`, and a test must pin that (audit #125 r1 m-2). A hit stamped with the pass's start time could be dated before the card's run began, and then it would never resume the card.
