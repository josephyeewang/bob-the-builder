# Open Loops — {Project Name}

> **What this is (Bob D-018).** The one list of every open item when more than one session works on the project at
> once — parallel Claude Code tabs, an overnight job, the owner. Every row has **one owner, a next action, a due date,
> and — to close — a proof**. It lives in the repo at `docs/open-loops.md` so the daily loop check
> (`scripts/loop-check.mjs`) can read it even when no session is running.
>
> **Why.** In a real multi-session build a plan sat in an open pull request for more than a week and its findings never
> reached the plan of record; every session assumed another one had it. A list nobody owns is how work gets dropped
> between sessions. Rules for running parallel sessions: `build-protocol.md` §"Parallel sessions".

## The rules (the loop check enforces the mechanical ones)

1. **One coordinator.** Exactly one session — named in the header below — owns this list, assigns work, and is the
   **only** session that merges pull requests and writes to production (database writes, switches, deploys). The other
   sessions propose: branches, pull requests, reports. A write refused in one session is never re-routed through
   another.
2. **Every finding gets a home in the same change.** An audit, review or overnight run is not done until each finding
   is either a row here (owner + due date), an item in the plan of record with a date, or a written "won't do" with
   the reason. *(A diagnosis isn't done until every finding has a home.)*
3. **Close only with proof.** A pull request, commit, run link or record ID. A message saying "done" is not proof.
4. **Exactly three status words:** `open` (being worked) · `waiting` (blocked on a named person or event — say which
   in Next action) · `closed` (has its proof). Nothing else — "in progress", "blocked", "done?" make the list
   uncountable.
5. **Unique IDs, never reused.** `L-001`, `L-002`, … in order. A closed row keeps its ID; a new item gets the next one.
   When two sessions add rows at once, the coordinator renumbers the later one before merging.
6. **One row ≤ ~600 bytes.** One line each: what, who, next step, when. Detail goes in a linked note or the pull
   request. A long row is a row nobody reads, and a list of long rows stops being a list.
7. **Archive.** Closed rows older than two weeks move to `docs/open-loops-archive.md` at the coordinator's weekly
   pass, so the live list shows what is live.
8. **Re-read before you report.** Before telling the owner what they still owe, re-read this list — never answer from
   memory; it may have been closed an hour ago in another session.

**Coordinator:** {session name, e.g. "coordinator tab"} · **Last pass:** {YYYY-MM-DD}

## Open loops

| ID | Item | Owner | Next action | Due | Closing proof | Status |
|---|---|---|---|---|---|---|
| L-001 | {one line: what} | {session or person} | {the very next step} | {YYYY-MM-DD} | | open |
| L-002 | {example: decide the retry budget} | owner | {waiting on: load test result} | {YYYY-MM-DD} | | waiting |
| L-003 | {example: fix the empty-state crash} | UI tab | — | — | PR #12, commit abc1234 | closed |
