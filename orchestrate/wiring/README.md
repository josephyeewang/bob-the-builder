# wiring/: the modules a config names

The login job's config names a wiring module by its path, and the entry script imports it. This folder holds the
Dispatcher's (R-0b-162). The review runner's wiring is in `modules/M4-workshop/launcher/review-wiring.mjs`.

| File | What it is |
|---|---|
| `dispatcher-wiring.mjs` | `wire(config, { limitedSync })` for `modules/M11-dispatcher/main.mjs`. It returns the real Record (M9), the real rules (the M10 reader, engine and `shared/rules.mjs`, with a read-only GitHub client) and the tick's ports. The config keys are listed at the top of the file. |
| `dispatcher-wiring.test.mjs` | Runs `node main.mjs <config>` as a separate process with this wiring. It checks one full pass, a second run, rules Joe has not approved, an unknown config key, and that every port not wired yet refuses. It runs in CI. |
| `fake-github.test-helper.mjs` | The test's only stand-in, for api.github.com. It can be loaded into a whole process with `node --import`. |

**Not wired yet (PR A of R-0b-162).** Every port other than the Record, the rules and the lock throws `not wired yet: <port>` when called. The step that needs that port fails, and Joe is told which step and why. Nothing answers with a made-up value. PRs C and D wire these ports.

**No channel to Joe exists yet**, in this folder or anywhere else in the code. The alert port writes each alert to the login job's log and answers "not delivered", so alerts stay in the record's unsent queue and are never marked as told.
