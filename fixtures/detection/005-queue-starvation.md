# IC-005 — The fix for starvation re-created starvation through another door

- **Source:** a production data app (anonymized); the defect landed the day after the fix it
  followed
- **Class:** `shared-queue-starvation`
- **Detection mode:** CODE-READ-ONLY, given one platform rule
- **Earliest preventable phase:** SPEC/DESIGN
- **Cost:** one supersession = **one full week**, because the lane's only trigger is the weekly
  job's completion. The project's own decision log: *"the same starvation the previous fix exists
  to end, arriving through a different door."* Measured on day one: cancelled **having executed
  zero steps.**
- **Baseline test result (2026-09-18): CAUGHT**, plus a second hazard nobody had logged.

## THE PROMPT (hand this over, nothing else)

A project has one shared database that cannot tolerate two heavy jobs writing at once, so all
heavy workflows are placed in a single CI concurrency group.

```yaml
# db-pipeline.yml   — the nightly data pipeline
on: { schedule: [{ cron: "0 3 * * *" }] }          # 03:00 UTC daily (illustrative)
concurrency: { group: db-pipeline, cancel-in-progress: false }

# daily-report.yml  — the user-facing daily email
on: { schedule: [{ cron: "0 9 * * 1-5" }] }        # 09:00 UTC weekdays (illustrative)
concurrency: { group: db-pipeline, cancel-in-progress: false }

# weekly-refresh.yml — the weekly model refresh (several hours)
on: { schedule: [{ cron: "0 1 * * 5" }] }          # 01:00 UTC Friday (illustrative)
concurrency: { group: db-pipeline, cancel-in-progress: false }

# analysis-lane.yml — an exploratory analysis job; deliberately given a COMPLETION trigger
#                     so it runs right after the weekly model refresh finishes
on:
  workflow_run: { workflows: ["weekly-refresh"], types: [completed] }
concurrency: { group: db-pipeline, cancel-in-progress: false }
```

This arrangement was introduced **deliberately to stop the analysis lane being starved** — it
previously competed with the pipeline and rarely ran.

Also relevant: this repository has measured the CI platform delivering its scheduled events
**several hours later** than their cron time, by a variable amount.

**QUESTION:** Will the analysis lane now run reliably? Explain precisely what happens to it, or
say plainly that the design is sound.

## THE ANSWER

No. The fix moved the starvation rather than removing it.

**The platform rule that decides it:** a concurrency group holds **at most one running job and
one pending job**. A third arrival does not queue behind the pending one — it **replaces** it.
`cancel-in-progress: false` protects whatever is *running*; nothing protects whatever is
*waiting*.

Now apply the measured lateness. On the one day the analysis lane matters — Friday, right
after a multi-hour refresh — both the nightly pipeline and the weekday report have their own
late-arriving triggers that can land anywhere in a multi-hour window. If either arrives **after**
the analysis lane takes the pending slot and **before** it starts running, the analysis lane is
evicted — silently, no error, no run. Given lateness is effectively random across a wide window,
a collision is a real probability each week, not a corner case.

**And the cost is asymmetric:** the lane's only trigger is `weekly-refresh` *completion*, which
happens weekly. One eviction therefore costs a **full week**, not one slot.

**Second defect, same file:** `types: [completed]` fires on success, failure **and cancelled**.
Since `weekly-refresh` sits in the same group and can itself be evicted from the pending slot,
the analysis lane can fire off the "completion" of a refresh that never ran — working from a
stale model while reporting normally. There is no `conclusion == 'success'` gate.

**The durable fix is not a better trigger.** Separation that depends on two jobs not overlapping
is unsound when delivery time is unreliable; it must be enforced by a mechanism. Either make the
analysis work a job *inside* the refresh's own run, or give it its own lane with an explicit
priority/lease rather than relying on arrival order.

## WHY EVERY GREEN SIGNAL WAS GREEN

- The YAML is valid and the intent is legible; reading it as a *design* it looks like a careful
  improvement.
- When the lane is evicted there is no failure anywhere — an evicted pending run simply never
  exists. The only symptom is an **absence**, which nothing here detects (see fixture 004).
- It had just been introduced *as the fix for this exact problem*, so reviewers were reading it
  as a solution rather than as a new mechanism with its own failure modes.

## THE CHECK THAT CATCHES IT

For any shared-lane or queue mechanism, ask two mechanical questions:

1. **How many items can be pending at once, and what happens to the (N+1)th?** — the answer is a
   platform fact, must be looked up, and is usually the whole story.
2. **Which member arrives last under normal timing, and what is the cost of losing it once?** —
   a completion-triggered member always arrives while the group is busy, and a weekly member
   pays a week per loss.

Plus the general one the original project minted the hard way: *"separation must be enforced by
a mechanism, never by a schedule."*

## SCORING A CANDIDATE

- **Full marks:** states the one-running/one-pending rule, identifies the analysis lane as the
  member that loses the pending slot, and notes that one loss costs a week.
- **Partial:** worries about contention generally without naming the replacement semantics.
- **Miss:** accepts it as sound because the completion trigger looks like priority.
