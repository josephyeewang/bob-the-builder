# M13 Ledger

Lane 3 builds this folder (LANES.md). The Ledger tells the owner what is going on: alerts, the heartbeat, what is
waiting on whom, and the "caught up" message after the Mini was away.

| File | Row | What it does |
|---|---|---|
| `alerts.mjs` | R-0b-71/73, L143 | One updated robot issue per alert condition; a comment only when it changes; closed when it clears. A GitHub call that answers false, or an open with no issue number, makes `raise`/`clear` answer false and save nothing, so the next pass tries again. `sweep` (L402, L957, L959, L965) closes an issue left open because the Record refused its number, only on proof: a clear in the same round answered 'none' for that key and nothing raised it again. That key's own clear then finds and closes it on GitHub, unless the issue was told or seen at or after the proof. The product keeps one known-clear list, trusted an hour from its first write (L973), used only to limit how often GitHub's list is read: a pass whose proven keys are all on it reads nothing, and a raise takes its key off the list so the next proof reads again (a refused take-off is told as the Record refusing). A key goes on it only once its issue was closed, refused or not listed; a list read that throws, or a login stop, puts nothing on. A key gets its own mark only when the list held an issue for it, naming that issue, and keys with no issue leave no mark: a refused close is not tried again for a day, a kept issue for an hour. A second orphan of the same key closes on the key's next proof once the list is read again: at once when its raise took the key off the list, within the hour when that was refused. Known limits: an issue told between the clear's read and its close is closed anyway and opened again on the next raise, so Joe gets a repeated notice, never a lost one; clocks that disagree between computers can misjudge the proof time, which the host lock mostly prevents by keeping one computer running at a time. Only the named product's keys are swept; the home checks never. An alert nothing clears is never closed. It closes nothing when the issue list, the robot's login or the list mark is not known. Its caller is the robot job's heartbeat pass (`wiring/robot-wiring.mjs`, L977): one alerts object a round, the sweep after the beat's raises and clears on it; each kind of why is told to the owner under its own queue cause. |
| `heartbeat.mjs` | R-0b-73, L143 | The pinned heartbeat issue, rewritten every 10 min; an alert per red fact; signed-out; account switch; usage steps. The new login is saved only once its change alert (unplanned) or push request (planned) went out, on every path: a lost or refused one is told again on the next pass. Every switch is counted and its notice carries that number and the saved record's time, so a repeat switch to the same account, planned or not, is a fresh notice, and a lost count never reuses a closed one, unless the record has no time or the clock gives the same millisecond twice (L152, L158, #98 r2). |
| `caught-up.mjs` | R-0b-76 | Idea issues from the owner (by numeric user ID) into the inbox; one "caught up" push after the Mini was away. |
| `waiting.mjs` | R-0b-77 | Who / what / since for every waiting item, from the record; a missing field shows as a record error. |
| `digest.mjs` | R-1-29 | The digest of a window of the record's diary: every merge (card, PR), every flag (a merge the post-merge audit flagged, a card undone) and every wait open now (who / what / since, from `waiting.mjs`, marked when it began in the window). A line it can't place is a record error, shown, never dropped; a diary that can't be read throws. Stored times are read through `pastTime`. Not wired yet: nothing writes `reports/digest.json` or the digest issue. |
| `handoff-copy.mjs` | R-1-31 | The Ledger writes the record's newest Lead handoff, word for word, to `<its folder>/<product>.md`. A handoff list it can't read, a corrupt entry or an empty newest handoff writes nothing, so the copy stays the last good one. It never writes into Dropbox. Not wired yet: no Ledger pass calls it. |
| `handoff-copier.mjs` | R-1-32 | A plain script, no AI, run as the owner's own user every 15 minutes: copies the Ledger's file to Dropbox's `handoffs/<product>.md` and makes the copy read-only. An edit synced back from another Mac, or a permission change, is overwritten at the next run and the difference logged (`handoff-copier.log` in its own folder). Links, a bad product name and root are refused. The folder itself stays writable, so a copy deleted and written again is caught at the next run, not prevented. |
| `outside-check/` | R-0b-72 | The template for the hourly outside check's own public repo (its README has the owner steps). |

## What is proven, and what is not yet

As in M12: the code is tested against fakes; each row's real half needs the owner. Not done until both are.

## Owner steps, for the (b) halves

1. **Outside check:** the ten steps in `outside-check/README.md` (repo, read-only key via `/apikeys`, product list,
   pinned audit files, stop it on purpose, a week at 0 minutes, a second account's PR and issue, day 61).
2. **Heartbeat** (R-0b-73), with Claude watching: stop the Dispatcher → an alert; separately break the rules file → an
   alert; sign the Mini out (test account) → one issue within 10 minutes; a planned switch to account B → the phone
   gets "switch the phone app to account B too"; turn the Mini's Wi-Fi off → one "heartbeat" issue in the outside-check
   repo within about 2 hours, updated hourly, not re-opened.
3. **Phone fallbacks** (R-0b-76), Mini's network off: file an idea issue and Approve a test PR from the phone; network
   back within the hour → the idea is in the inbox, the merge happens, one "caught up" push arrives.
4. **Read-only handoff copy** (R-1-32): make a folder for the copier (`mkdir -m 700`), then load its LaunchAgent as your own
   user (the plist comes from `copierAgentPlist`, with the Ledger's handoff folder, the Dropbox `handoffs/` folder and
   the product names). Then: the copy is read-only on the Mini; edit it on another Mac → within 15 minutes it is the
   record's again and the edit is in the log.
