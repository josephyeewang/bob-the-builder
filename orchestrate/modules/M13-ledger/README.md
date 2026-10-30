# M13 Ledger

Lane 3 builds this folder (LANES.md). The Ledger tells the owner what is going on: alerts, the heartbeat, what is
waiting on whom, and the "caught up" message after the Mini was away.

| File | Row | What it does |
|---|---|---|
| `alerts.mjs` | R-0b-71/73 | One updated robot issue per alert condition; a comment only when it changes; closed when it clears. |
| `heartbeat.mjs` | R-0b-73 | The pinned heartbeat issue, rewritten every 10 min; an alert per red fact; signed-out; account switch; usage steps. |
| `caught-up.mjs` | R-0b-76 | Idea issues from the owner (by numeric user ID) into the inbox; one "caught up" push after the Mini was away. |
| `waiting.mjs` | R-0b-77 | Who / what / since for every waiting item, from the record; a missing field shows as a record error. |
| `outside-check/` | R-0b-72 | The template for the hourly outside check's own public repo (its README has the owner steps). |

## What is proven, and what is not yet

As in M12: the code is tested against fakes; each row's real half needs the owner. Not done until both are.

## Owner steps (Joe), for the (b) halves

1. **Outside check:** the ten steps in `outside-check/README.md` (repo, read-only key via `/apikeys`, product list,
   pinned audit files, stop it on purpose, a week at 0 minutes, a second account's PR and issue, day 61).
2. **Heartbeat** (R-0b-73), with Claude watching: stop the Dispatcher → an alert; separately break the rules file → an
   alert; sign the Mini out (test account) → one issue within 10 minutes; a planned switch to account B → the phone
   gets "switch the phone app to account B too"; turn the Mini's Wi-Fi off → one "heartbeat" issue in the outside-check
   repo within about 2 hours, updated hourly, not re-opened.
3. **Phone fallbacks** (R-0b-76), Mini's network off: file an idea issue and Approve a test PR from the phone; network
   back within the hour → the idea is in the inbox, the merge happens, one "caught up" push arrives.
