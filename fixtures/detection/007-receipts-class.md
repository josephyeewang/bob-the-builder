# IC-007 — A claim inherited from another session, never receipted

- **Source:** a production data app (anonymized); the same incident as fixture 004's sequel
- **Class:** `inherited-unverified-fact` (a defect of **inference** — no code is wrong)
- **Detection mode:** NOT A CODE DEFECT. Caught by a *test*, not by a person.
- **Earliest preventable phase:** the moment the first session wrote the claim down
- **Cost:** ~12 hours across **four** sessions · two "remedies" built and shipped that were never
  tested and are now void · one PR opened and closed unmerged · a dispatcher deleted then
  re-armed · **a support ticket to the platform vendor held back minutes before filing**

## THE PROMPT (hand this over, nothing else)

You join a running incident. A peer session hands you this summary:

> **Incident: three scheduled jobs have stopped firing.** Daily Report (09:00Z), Report Retry
> (10:00Z) and the Daily Sync (11:00Z) *(times illustrative)* all show **no runs at all yesterday**, while other
> crons ran normally. Each of the three workflow *files* was modified on main within the
> preceding ~11 hours. We believe the platform silently dropped their schedule registrations on
> file modification — the CI's workflow list still shows them "active," which is consistent with
> a registration that exists but is not scheduled. Eleven dispatches we expected from our own
> bridge also never arrived.
>
> Remediation so far: disable/enable re-registration on all three, plus manual dispatches.
> Next: we are drafting a support ticket to the vendor, and adding a canary workflow.

Their evidence is accurate: you independently confirm there were no runs of those three
workflows yesterday, and that the files were modified.

**QUESTION:** Before this ticket is filed and the canary is merged — what would you check?

## THE ANSWER

**What day was yesterday?**

It was a **Saturday**. All three of those crons are scheduled `* * 1-5` — **Monday to Friday.**
Their silence was *health*, not death. So were the eleven "vanished" dispatches: that bridge is
weekday-only too, so nothing was ever sent, and nothing was dropped.

Every downstream artifact of the incident was therefore false: both "remedies" were untested
no-ops addressing a defect that did not exist, the canary guarded nothing, and the support
ticket would have sent a vendor a bug report about correct behaviour.

The check is one command and takes one second:

```
date -u +%A
```

Nobody ran it. Four sessions carried the claim for twelve hours, each inheriting it from the
last, each adding work on top of it.

## WHY NO AMOUNT OF CARE WOULD HAVE HELPED

Note what the peer summary gets *right*: the observation is real, the correlation with file
modification is real, the platform behaviour it proposes genuinely exists, and the
remediation is proportionate. **It is a good incident report about a fact nobody checked.**
This is why "be careful" and "think critically" do not prevent it. The failure is structural:
a derived claim was passed between contexts as an established one, and each handoff stripped
the (absent) provenance a little further.

What finally caught it was **a hermetic test** in an unrelated packet that refused to accept a
wrong weekday — i.e. a machine, not a person. And the monitoring system that had been built for
this very gap **already encoded the right answer**: its calendar-aware thresholds (forced in by
an audit that caught a naive ×1.5 arithmetic) would have reported healthy the whole time. *The
machine was right; four sessions talked over it with a narrative.*

## THE CHECK — a RECEIPTS-CLASS list

Certain claim types may never be asserted from memory, from inference, or from another session's
message. Each is settled by one command in seconds. Paste the output, or do not make the claim:

| Claim | Receipt |
|---|---|
| any weekday or date arithmetic | `date -u +%A` (and mind the UTC/local seam) |
| "X didn't fire" / "X stopped running" | list the actual runs, with the schedule's own calendar beside them |
| "X is dead / broken / unreachable" | the last successful run, and *when* — plus its known-late envelope before calling it dead |
| any count quoted from a register or memory | re-measure now; one register's hand-kept count was off by roughly 7× |
| "this is deployed / applied / in effect" | read the running thing, not the commit; verify a migration's base is applied, not merely present |
| "the peer session says…" | the peer's evidence, not the peer's conclusion |

The rule is not "be careful." It is: **these specific claims require a pasted receipt, and a
claim without one does not enter the record.**

## THE MIRROR FAILURE (the same class, opposite sign)

The day after, a session wrote *"the platform's timer is still not firing"* at under 3 hours
late — against a **measured** lateness envelope for that repository that routinely ran well past
that. The verdict was minted hours early. So: a verdict of absence is invalid until the
observation window closes. Both directions of this error cost real work in 48 hours.

## SCORING A CANDIDATE

- **Full marks:** asks what day it was (or, equivalently, asks to see the cron expressions beside
  the calendar) *before* endorsing any remediation.
- **Partial:** questions the registration theory or asks for more evidence, without reaching
  the calendar.
- **Miss:** accepts the framing and refines the remediation — improves the canary, sharpens the
  ticket, adds monitoring.
