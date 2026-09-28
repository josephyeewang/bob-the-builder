# IC-002 — A kill that leaves the real worker running

- **Source:** a production data app (anonymized); round 5 of a six-round review of one PR
- **Class:** `signal-does-not-reach-the-worker` · also exemplifies `vacuous-receipt`
- **Detection mode:** CODE-READ-ONLY (green tests, green live run, green receipts)
- **Earliest preventable phase:** SPEC/DESIGN — *"what process must this kill actually reach?"*
- **Found by:** the integrator, at round 5 of 6, after four prior review rounds missed it

## THE PROMPT (hand this over, nothing else)

A long-running local job yields the shared database to production when production needs it. If
it does not stop writing within seconds, two bulk writers contend and **neither makes progress**.

Here is the stop path, and the launcher for the steps it stops.

```zsh
# each step is launched like this
run_step() {
  local dir="$1"; shift
  ( cd "$dir" && exec "$@" ) &
  cmd_pid=$!
}

# the three steps that get run
run_step "$REPO" python3 scripts/job.py --mode a
run_step "$REPO" python3 scripts/job.py --mode b
run_step "$REPO" npm run job -- --mode c        # <- the npm step

# the preemption path: production has taken the lane, stop NOW
preempt() {
  echo "── PREEMPTED — aborting step pid ${cmd_pid} ──"
  kill "$cmd_pid" 2>/dev/null
  sleep 5
  kill -0 "$cmd_pid" 2>/dev/null && kill -9 "$cmd_pid" 2>/dev/null
  return 125
}
```

And here is the receipt that was accepted as proof the stop path works:

> **Receipt A** — launched the job, triggered a preemption, asserted `step pid <pid>: gone
> (kill -0 fails)`. PASS.
> *(Harness note: to avoid writing to the production database, the npm step was replaced via
> a PATH shim that turns `npm run job` into `sleep 300`.)*

**QUESTION:** Does this reliably stop the job from writing? If not, describe the exact failure,
and say what Receipt A does and does not prove.

## THE ANSWER

`$cmd_pid` is the pid of the backgrounded subshell — but **what that subshell *is* differs per
step**:

- For the two **python** steps, the subshell `exec`s python, so the subshell *is replaced by* the
  worker. `$cmd_pid` is the worker. Killing it kills the writer. Correct.
- For the **npm** step the command is `npm run job -- --mode c`, which is a **tree**:
  `npm` → `tsx` → the node process that actually writes to the database. `kill $cmd_pid` signals
  **only `npm`**.

So on preemption the job prints `PREEMPTED`, returns 125, exits "yielded," and its supervisor
logs a clean hand-off — **while the node worker keeps writing underneath production's run.**
Every log line and every exit code says "I stood aside." The database says otherwise. The same
shape defeats the manual-stop path and the wall-clock bound (a hung step is "terminated" while
its worker survives).

**What Receipt A proves:** that a *single process* dies when signalled. **What it does not
prove:** anything about a process *tree* — because the shim replaced the one step that has a
tree with a step that has none. The receipt's abstraction and the defect's location are the
same place. That is the reusable lesson.

## WHY EVERY GREEN SIGNAL WAS GREEN

- **Tests:** the stop path was exercised against stubs. A stub built to avoid database writes
  necessarily flattens the process shape — which is the only property under test.
- **The live run:** checked before fixing — `npm → tsx → node` all died within seconds of one
  TERM. **The live run was green because npm and tsx happen to forward signals.** That is a
  version-dependent courtesy of two third-party packages, not a property of this code. A minor
  bump in either silently reintroduces a double-writer with clean logs.
- **Four prior review rounds** read the kill logic as a mechanism and judged it correct in
  general. It *is* correct in general. It is wrong per-call-site.

## THE REASONING STEP THAT EXPOSED IT

Not "is this kill correct?" but **"what is `$cmd_pid`, at each of the three call sites,
specifically?"** Two different answers fall out immediately. Then: "does the receipt that proves
the kill distinguish those two answers?" — no, its stub has one level.

Generalised: **ask what each identifier IS at every call site, not in general.**

## THE FIX, AND ITS OWN SUBTLETY

Signal the whole descendant tree. The fix was itself audited and found incomplete: the KILL
fallback must use the **union** of (a) a descendant set collected *before* any signal and (b) a
fresh walk from the root. (a) still reaches a grandchild that got reparented when its parent
died; (b) reaches a child spawned between collection and TERM. **Neither alone covers both.**
And deliberately *not* a process-group kill: supervisor, job and step share a pgid, so
`kill -- -pgid` would take the supervisor down too — re-creating a different failure (fixture
006) by another route.

## SCORING A CANDIDATE

- **Full marks:** identifies that the npm step is a tree and `$cmd_pid` is `npm`; states the
  consequence (a clean "yielded" while still writing); AND names Receipt A's stub as unable to
  distinguish the two cases.
- **Partial:** spots the tree problem but accepts Receipt A, or accepts a green live run as proof.
- **Miss:** reads the kill-then-KILL ladder as sufficient.
