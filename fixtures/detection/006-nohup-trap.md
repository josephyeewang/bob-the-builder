# IC-006 — A handler that re-arms a signal the launcher deliberately ignored

- **Source:** a production data app (anonymized); round 6 of the same six-round review as fixture 002
- **Class:** `handler-rearms-ignored-signal`
- **Detection mode:** CODE-READ-ONLY — invisible to tests, and **dormant in production by
  accident of how it is launched**
- **Earliest preventable phase:** BUILD
- **Found by:** the integrator's auditor, at round 6 of 6

## THE PROMPT (hand this over, nothing else)

A long-running local job is supervised so it restarts itself when production displaces it, and
so a human never has to notice and relaunch it. The whole point of the work is unattended
survival.

The job's own header documents how it is started:

```
cd ~/project && nohup scripts/supervise.sh > ~/logs/job.log 2>&1 &
```

Inside the inner worker script:

```zsh
on_signal() {
  echo "── signal received — stopping step ${CURRENT_STEP_PID:-none}, releasing the lease ──"
  kill_tree "${CURRENT_STEP_PID:-}"
  npm run --silent lane:release -- "${LANE_ARGS[@]}"
  exit 1          # a signal is NOT a voluntary yield
}
trap 'on_signal' INT TERM HUP
```

And in the supervisor that restarts it:

```bash
case "$rc" in
  3)  relaunch ;;                                  # yielded to production — restart
  *)  log "stopped with exit ${rc} (not a yield) — NOT restarting"; exit "$rc" ;;
esac
```

**QUESTION:** This is meant to survive unattended, including overnight. Is there a way it can
stop and stay stopped? Trace it precisely.

## THE ANSWER

Yes — and it is created by the `HUP` in the trap list.

Three facts compose:

1. **`nohup` sets SIGHUP's disposition to *ignored*,** and that disposition is inherited by the
   whole process tree. Ignoring HUP is exactly what lets the job survive a closed terminal or a
   dropped SSH session — it is the mechanism the unattended requirement rests on.
2. **zsh honours a `trap` on a signal that was ignored at entry.** So the moment `HUP` was added
   to the trap list, the job *stopped ignoring hangups and started handling them.*
3. **A hangup is delivered to the whole process group.** When a login shell exits or an SSH
   connection drops, supervisor and worker both receive it.

Chain: close the terminal → HUP to the group → the worker traps it, releases the lease, and
`exit 1` → the supervisor reads exit 1, correctly applies its own rule *"not a yield — do not
restart"*, and exits.

**The PR whose entire purpose was "a human never has to notice and relaunch this" introduced a
way for closing a laptop lid to kill both the job and its supervisor permanently.** It converted
a survivable event into precisely the failure being removed.

The fix is a **deletion** — `trap 'on_signal' INT TERM` — with a comment recording that the
absence of HUP is load-bearing, because it looks like an omission to the next reader.

## WHY EVERY GREEN SIGNAL WAS GREEN

- **The receipts:** every signal receipt sent INT or TERM. No HUP receipt existed, because HUP
  had been added to the trap list as an obvious-looking completeness gesture ("catch the three
  stop signals"), not as behaviour anyone thought needed proving. **You do not write a test for
  the line you added without thinking.**
- **The live run:** the supervisor is launched from a tool whose parent is already gone, so its
  ppid is 1 and nothing in normal operation sends that group a HUP. The defect is dormant *by
  accident of the launch path* and would fire the first time someone started it from a terminal
  window they later closed.
- **Five prior rounds** read the trap line against the list of signals a stop handler "should"
  catch — which is the wrong comparison.

## THE REASONING STEP THAT EXPOSED IT

The auditor did not read the trap against the signal list. They read it **against the launch
command in the script's own header** and asked: *what has `nohup` already done to HUP, and what
does adding a trap do to an inherited "ignore" in this specific shell?*

Generalised: **read the code against the runtime's own rules, named explicitly.** A rule you
cannot state, you cannot check. The three rules here — nohup sets ignore; zsh's trap overrides
an inherited ignore; a hangup targets the group — are individually harmless and lethal in
composition.

## A COMPANION DEFECT, FOUND WHILE WRITING THE FIX'S RECEIPT

zsh gives every **background** child (`cmd &`) `SIG_DFL` for HUP even when HUP was ignored at
entry; foreground children keep the ignore, and bash keeps it for both. Because the worker runs
its step with `&`, a HUP killed the *step* (rc 129) while the shell survived — so "the job
survived HUP" was true of the shell and false of the work. **Nobody had checked the step's pid
in a HUP receipt.** This is why a receipt must assert the state of the thing that matters
(the grandchild), not the wrapper.

## SCORING A CANDIDATE

- **Full marks:** names all three facts (nohup ignores HUP · the trap re-arms it · HUP hits the
  group) and concludes that the supervisor's own "not a yield" rule makes the stop permanent.
- **Partial:** spots the re-arm but not that the supervisor will refuse to restart, i.e. treats
  it as a restartable blip.
- **Miss:** reads `INT TERM HUP` as correct completeness.
