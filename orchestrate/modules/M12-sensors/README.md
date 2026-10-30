# M12 Sensors

Lane 3 builds this folder (LANES.md). The Sensors are plain scripts on the Mini that read the outside world (GitHub,
Vercel, the repo) and write facts into the record. Everything they write is masked first (`mask.mjs`, through
`facts.mjs`); text that came from outside is fenced (`escape.mjs`, `cleanOutside`).

| File | Row | What it does |
|---|---|---|
| `mask.mjs`, `fakes.mjs` | R-0b-125 | Masks secrets at every depth; fake keys for tests are built at run time, never committed. |
| `record-scan.mjs` | R-0b-125 | The weekly scan: an independent looser detector plus gitleaks when installed, with a planted control. |
| `escape.mjs`, `fixtures/outside-text.json` | R-0b-126 | `cleanOutside(text, source)`: mask then fence outside text; fixtures with exact expected output. |
| `fact-shapes.mjs` | R-0b-125, lead call L25 | The allow-list: each fact kind's fields and their types. Only those are stored as written; every other value, at any depth, is masked (its name kept). A kind with no shape keeps only `kind` and `ts`. A new fact kind needs a shape here (a test checks every `kind: 'fact.…'` in M1, M12 and M13). |
| `facts.mjs` | R-0b-125 | The one fact writer (allow-list, then masks token shapes and known values, writes only if unchanged since read). No second masking by field name: the allow-list did that, and a name rule misfired on map keys an outside system chose (round 7). |
| `pr-facts.mjs` | R-0b-74 | Each PR's changed files and diff summary, with checks, threads and "behind main". |
| `history.mjs` | R-0b-75 | The repo-history file (main's first-parent log) and safe answers to history requests. |
| `supported.mjs` | R-0b-71/72 | The one rule for "a supported main commit", per product stage. |
| `vercel-reader.mjs`, `prod-watcher.mjs` | R-0b-71 | The production watcher: unsupported deploys, older version live, settings changed (never values). |
| `outside-watch.mjs` | R-0b-72 | Every 10 min: is the hourly outside check still running, and which of its steps fail. Writes `outside-robot-merges-<product>` (last green time); `robotMergesGreen()` is the Merge Gate's one test (green within 120 min; lead calls L19, L20). The step counts only when the slot's public tag matches this product's; two failed runs, a 5-day gap or a first pass latch it shut until the owner's `cleared` time (0b-7 audit round 4). |
| `outside-watch.mjs` (`checkNoPush`) | lead call L24 | Each pass, tests every Mini token against the outside repo; writes `outside-no-push` and raises a home alert if any can write. The Merge Gate stays shut without a green one from the last 120 min. The robot-merges step counts only with the newest run's repo-guard step green too. |
| `air-health.mjs` | R-0b-84, lead call L23 | The Air's health result as a dated file a machine writes (`node air-health.mjs <red count> <folder>`); `checkAirHealthFile` and `airFactFromFile` date the fact by the check itself, never by when it arrived. Joe never types a count. |
| `start-gate.mjs` | lead call L3 | The two Vercel facts lane 2's launcher gate reads: skip command equals the pinned one; no env name in both Preview and Production. Lane 2's shape: `start_gate.vercel_skip.<product>` / `start_gate.vercel_env.<product>`, `{ product, vercel_project, read_at, result }`. M4's startGate decides (≤10 min old), so the Sensors re-read every 5 min; `startGateOpen` is a test helper. |
| `device-checks.mjs` | R-0b-78 | The decisions behind the owner's private `/host` and `/configaudit` for the Air. |
| `shell-guard/` | R-0b-70 | Shell-trick cases and a runner for the production guard (the guard is lane 2's R-0b-36). `selfcheck.mjs` proves each case really touches the file, each in a new folder, under bash and zsh where present. The pairs that touch nothing on a Mac are listed as dead in `corpus.json` (a test keeps that list exact on two names); the runner also drops those that touch nothing on the machine it runs on (no zsh, or an sh without `$'…'`). Both sides are samples. The refuse side (many spellings of the path, whole-folder reads, change-folder cases asked from three places) catches the simple guards a test here builds, but cannot prove a guard blocks every way to reach the file. The allow side (ordinary commands, near misses built from the file's folder and name, commands asked from other folders) catches a guard that refuses too much, but cannot prove it never does. The cases are checked in a folder holding only the file; beside a similar name (say a `.local` copy) a glob form may match both. |

## What is proven, and what is not yet

Every row has two halves (review-0b-7 M1). **(a)** The code, tested against fakes: all the `*.test.mjs` here.
**(b)** The same thing for real, which needs the owner's accounts. Rows stay open until (b) is done.

Not here on purpose: the N14 ref watch (second cutover); usage numbers (R-0b-66, milestone 0b-6, not built yet: the
heartbeat says "usage: unknown" until it is).

## Join items (other lanes or the lead)

- R-0b-126: lane 1/2 intake (research, lesson and idea files, the Lead's input) must go through `cleanOutside` and pass
  `fixtures/outside-text.json` end to end. Until then R-0b-126 is "half: intake wiring pending".
- R-0b-70: from the project's top folder (where Claude Code runs the hook; if you must run from elsewhere, set
  `CLAUDE_PROJECT_DIR` to the top folder), run `node <Bob's folder>/orchestrate/modules/M12-sensors/shell-guard/runner.mjs
  '<the installed hook command, exactly as in settings>' <the file's path from there>` and again with its absolute
  path; every miss goes to lane 2. The hook runs from that folder with `CLAUDE_PROJECT_DIR` set, as in Claude Code;
  only each case's `cwd` changes. Each run also tries the absolute form and "change folder, then use the short name"
  (asked from the folder above). A path with a space is refused. Until both runs are green, R-0b-70 is pending.
- Lead call L25: any lane that writes a fact through `facts.mjs` adds its kind to `fact-shapes.mjs` (ask lane 3);
  without a shape every field but `kind` and `ts` is masked.
- Lead call L3 (lane 2's contract): the Sensors' loop runs `readStartGate` for each product at least every
  `START_GATE_READ_EVERY_MIN` (5) minutes, passing the rules entry's skip command and Vercel project. M4's startGate
  treats a fact older than 10 minutes as shut. Checked end to end against lane 2's `vercelFact` on 29 Oct 2026.
- Push requests (`push-request-<key>` facts, written by M13) are delivered by the Front Door (lane 2's restart path).
- Lead call L24: lane 2's Mini loop calls `checkNoPush` every pass with each token the Mini holds (the GitHub ones the
  Front Door and the robots use), and the probe from `outside-check.mjs`'s `writeProbe`. With no tokens passed it
  writes red, so a loop that forgets it keeps the gate shut.
- Lead call L23: the owner's `/configaudit` on the Air ends by running `node air-health.mjs <red count> <folder>` into
  the Mini's air-health folder (a synced folder the Front Door can't write); the Mini's intake runs
  `checkAirHealthFile` on each new file and stores `airFactFromFile(doc, now, storedFact)` under `air-health` when it isn't null (only a newer check replaces it).

## Owner steps (Joe), for the (b) halves

Plain steps; the lead turns each into paste-ready blocks with the real names.

1. **Vercel read key** (run `/apikeys` first): a Vercel token for the Sensors on the Mini, kept in the Sensors'
   environment only. Then, on the Vercel **test** project, Claude runs the watcher once to confirm the field names
   (they were taken from Vercel's docs on 29 Oct 2026) and the five R-0b-71 cases: a normal deploy, a CLI deploy, a
   promotion of an older deploy, an env change, a cancelled build.
2. **The Air** (R-0b-79): wire `device-checks.mjs` into your private `/host` and `/configaudit`, and have
   `/configaudit` end by writing the air-health file (above). Then run `/configaudit` on the Air until it shows 0 red; push to the test repo from the Air with `git push --no-verify` and see GitHub
   refuse it.
3. **A real week's scan** (R-0b-125): after a week of real facts, Claude writes one control fact holding a fake key,
   calls `scanRecordLoose` over every entity (its default) and `runGitleaks` on the record folder, and the scan counts
   only if it found the control and left no entity out.
