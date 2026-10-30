# M12 Sensors

Lane 3 builds this folder (LANES.md). The Sensors are plain scripts on the Mini that read the outside world (GitHub,
Vercel, the repo) and write facts into the record. Everything they write is masked first (`mask.mjs`, through
`facts.mjs`); text that came from outside is fenced (`escape.mjs`, `cleanOutside`).

| File | Row | What it does |
|---|---|---|
| `mask.mjs`, `fakes.mjs` | R-0b-125 | Masks secrets at every depth; fake keys for tests are built at run time, never committed. |
| `record-scan.mjs` | R-0b-125 | The weekly scan: an independent looser detector plus gitleaks when installed, with a planted control. |
| `escape.mjs`, `fixtures/outside-text.json` | R-0b-126 | `cleanOutside(text, source)`: mask then fence outside text; fixtures with exact expected output. |
| `facts.mjs` | R-0b-125 | The one fact writer (masks, writes only if unchanged since read). |
| `pr-facts.mjs` | R-0b-74 | Each PR's changed files and diff summary, with checks, threads and "behind main". |
| `history.mjs` | R-0b-75 | The repo-history file (main's first-parent log) and safe answers to history requests. |
| `supported.mjs` | R-0b-71/72 | The one rule for "a supported main commit", per product stage. |
| `vercel-reader.mjs`, `prod-watcher.mjs` | R-0b-71 | The production watcher: unsupported deploys, older version live, settings changed (never values). |
| `outside-watch.mjs` | R-0b-72 | Every 10 min: is the hourly outside check still running, and which of its steps fail. |
| `start-gate.mjs` | lead call L3 | The two Vercel facts lane 2's launcher gate reads: skip command equals the pinned one; no env name in both Preview and Production. `startGateOpen` decides (both ok, ≤120 min old). |
| `device-checks.mjs` | R-0b-78 | The decisions behind the owner's private `/host` and `/configaudit` for the Air. |
| `shell-guard/` | R-0b-70 | Shell-trick cases and a runner for the production guard (the guard is lane 2's R-0b-36). |

## What is proven, and what is not yet

Every row has two halves (review-0b-7 M1). **(a)** The code, tested against fakes: all the `*.test.mjs` here.
**(b)** The same thing for real, which needs the owner's accounts. Rows stay open until (b) is done.

Not here on purpose: the N14 ref watch (second cutover); usage numbers (R-0b-66, milestone 0b-6, not built yet: the
heartbeat says "usage: unknown" until it is).

## Join items (other lanes or the lead)

- R-0b-126: lane 1/2 intake (research, lesson and idea files, the Lead's input) must go through `cleanOutside` and pass
  `fixtures/outside-text.json` end to end. Until then R-0b-126 is "half: intake wiring pending".
- R-0b-70: run `node shell-guard/runner.mjs '<the installed hook command>'` against lane 2's guard; every miss goes
  to lane 2. Until it is green, R-0b-70 is pending.
- Push requests (`push-request-<key>` facts, written by M13) are delivered by the Front Door (lane 2's restart path).

## Owner steps (Joe), for the (b) halves

Plain steps; the lead turns each into paste-ready blocks with the real names.

1. **Vercel read key** (run `/apikeys` first): a Vercel token for the Sensors on the Mini, kept in the Sensors'
   environment only. Then, on the Vercel **test** project, Claude runs the watcher once to confirm the field names
   (they were taken from Vercel's docs on 29 Oct 2026) and the five R-0b-71 cases: a normal deploy, a CLI deploy, a
   promotion of an older deploy, an env change, a cancelled build.
2. **The Air** (R-0b-79): wire `device-checks.mjs` into your private `/host` and `/configaudit`, then run `/configaudit`
   on the Air until it shows 0 red; push to the test repo from the Air with `git push --no-verify` and see GitHub
   refuse it.
3. **A real week's scan** (R-0b-125): after a week of real facts, Claude writes one control fact holding a fake key,
   calls `scanRecordLoose` over every entity (its default) and `runGitleaks` on the record folder, and the scan counts
   only if it found the control and left no entity out.
