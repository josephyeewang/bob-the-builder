# IC-004 — Monitoring that cannot see a run that never started

- **Source:** a production data app (anonymized)
- **Class:** `absence-is-not-monitored` (a defect of **omission**)
- **Detection mode:** NOT FINDABLE BY READING — the artifacts are all correct
- **Earliest preventable phase:** SPEC/DESIGN
- **Cost:** a missed user-facing daily email; then, when the gap was noticed, a *phantom* incident
  in the other direction — 12 hours across four sessions, two untested "remedies," a PR closed
  unmerged, a support ticket held minutes before filing
- **Status:** **the corpus control.** This is the one fixture a fresh reader failed.

## THE PROMPT (hand this over, nothing else)

A product's daily report email is produced by a scheduled job. Here is the monitoring setup
around it, in full.

```yaml
# .github/workflows/daily-report.yml
on:
  schedule:
    - cron: "0 9 * * 1-5"     # 09:00 UTC, weekdays (illustrative)
  workflow_dispatch:
jobs:
  report:
    steps:
      - run: npm run report -- --send --asof "$REPORT_DATE"
      - name: Heartbeat — success
        if: success()
        run: curl -fsS "$HEARTBEAT_URL"          # dead-man ping
      - name: Heartbeat — failure
        if: failure()
        run: curl -fsS "$HEARTBEAT_URL/fail"
```

A hosted dead-man-switch monitoring service is configured with a 26-hour grace period on that
check: if no success ping arrives within 26 hours, it pages.

There is also a daily data-quality scan that verifies the report's *content* — row counts, null
rates, field coverage — and a weekly security audit. Both are green.

**QUESTION:** Is there any way this product could stop delivering the daily report to users
without anyone finding out quickly? Describe precisely how, or say plainly that the monitoring
is sound.

## THE ANSWER

Two defects, and the second is the one that matters.

**(a) Every signal here is success-side.** The heartbeat fires *from inside a run*. A run that
never starts emits nothing — and a schedule can stop firing for reasons that leave the workflow
looking healthy (a platform dropping the registration silently, a billing block that fails jobs
in seconds before any step executes, a repository setting change). The `/fail` ping has the
same blind spot: it needs a run in order to report.

**(b) The grace window and the schedule's own calendar are in contradiction.** The job runs
Monday to Friday. The longest *legitimate* gap between two successful runs is therefore Friday
morning to Monday morning — about **72 hours**. The dead-man's grace is **26 hours**. Those
cannot both be right:

- At 26h it pages every weekend, on a healthy system. Within a few weeks someone mutes it, and
  now nothing is watching at all.
- Widen it past 72h to stop the false pages, and a genuinely dead schedule is invisible for three
  full days.

Neither file is wrong on its own. The defect lives in the **relationship** between the cron's
calendar and the monitor's tolerance — which is why reading either one finds nothing.

**The correct design** needs a watcher that asks a different question — *"was a run CREATED
within 1.5× this job's period, measured against the job's own calendar?"* — running **outside
the scheduler it watches**, because a scheduled watcher of schedules dies with its patient.

## WHY IT IS NOT FINDABLE BY READING

There is no wrong line to find. The workflow is correct, the pings are correct, the
data-quality scan is correct and genuinely useful. What is absent is a capability, and absence
has no syntax.

When this prompt was run cold, the fresh reader produced a **different, genuinely real** finding
— that the heartbeat proves the script exited 0, not that any email was accepted by the provider,
so a silently-empty recipient list would pass every check. That is true and worth fixing. It is
also exactly what a good auditor does when the real defect is structurally invisible: it answers
the nearest answerable question well.

## THE SEQUEL, WHICH IS THE BETTER LESSON

When the gap was eventually noticed, it was *over*-corrected into a phantom. Four sessions
concluded three schedules had died. They had not: the date in question was a **Saturday**, and all
three jobs are weekday-only, so the silence was health. Nobody ran `date -u +%A` for twelve hours.

The detector that had been built for this gap **already encoded the right answer** — its
calendar-aware thresholds (forced in by an audit that caught a naive ×1.5 arithmetic that would
have false-paged weekly) would have reported healthy throughout. The machine was right; the
humans talked over it with a narrative.

So this fixture carries two checks, not one:

1. **Design:** for every scheduled job — what fires an alert if no run is *created* within 1.5×
   its period, computed against the job's own calendar, from outside its failure domain?
2. **Epistemics:** a claim of the form "X stopped running" is a receipts-class claim. The
   receipt is one command. (See fixture 007.)

## SCORING A CANDIDATE

- **Full marks:** identifies that nothing detects a run that never started, AND notices the
  26h-vs-72h contradiction (or equivalently, that the grace window must exceed the longest
  legitimate gap, which makes it useless for absence detection on a weekday-only schedule).
- **Partial:** identifies the success-side blind spot but not the calendar arithmetic.
- **Miss:** reports the monitoring as sound, or finds only adjacent gaps (e.g. send-outcome
  verification) without reaching absence.

**Expected result for an unaided reader: MISS.** That is the point of this fixture. If a
candidate rule or lens moves this from MISS to CAUGHT, it has earned its place in the library —
this is the regression test for any absence-detection check added to L21.
