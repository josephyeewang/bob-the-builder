# Diagnosing why a skill misbehaved

<!-- Adapted from obra/superpowers@22f0b463e7a5e579904dd6211a520321035526f7 (skills/diagnosing-superpowers/SKILL.md, templates/case.md, templates/report.md, prompts/analyst-common.md, prompts/skill-timeline.md, prompts/stumbles.md, references/context-safety.md), MIT, Copyright (c) 2025 Jesse Vincent. Licence: third_party/superpowers/LICENSE. Changes: widened from superpowers' own skills to any skill; the report names a likely cause in the skill (upstream only states involvement), because Bob uses it to fix its own skills; the bug-bundle, export, GitHub-issue and similar-session steps dropped; seven analysts cut to three; reworded for a non-engineer owner. -->

> Adapted from obra/superpowers@22f0b46 (diagnosing-superpowers), MIT.

**Use this when** a skill did not fire when it should have, fired and was ignored, made a session repeat work
or stumble, or cost far more than expected, and you want the cause before changing the skill. The fix itself
then follows `writing-skills.md` (the red run is this diagnosis's evidence).

**Core rule: every finding cites `file:line` in the session record. No citation, no finding.** Every number
comes from the record or a command you ran, never from memory.

## Steps

1. **Agree the problem.** Ask the owner one question at a time until you can write one paragraph: which
   session, which turns, what was expected, what happened, and what they care about (time, cost, a repeated
   action, one wrong action). "It was slow" is a complaint, not a problem. Don't start step 2 until they answer.
2. **Find the record.** Locate the session's transcript file(s) (for Claude Code:
   `~/.claude/projects/<folder>/<session-id>.jsonl`, plus `subagents/`). Confirm it by quoting its first prompt
   and time. Fill in the case template below.
3. **Read, then send analysts.** Read the region around the problem yourself. Then give each of three fresh
   helper sessions the case file and one brief from § Analyst briefs. Drop any finding without `file:line`.
4. **Report.** Fill every section of the report template, in order, and give the owner its path.

## Reading session files safely

One line of a transcript can be a megabyte. For every file, every time:
1. **Measure first:** `wc -lc "$F"` and `awk '{ if (length($0) > 100000) print NR, length($0) }' "$F"`.
2. **Never print whole records.** Get line numbers first (`grep -n … | cut -d: -f1`), then small fields from
   specific lines (`sed -n 'Np' "$F" | jq -c '{type, …}'` or `| cut -c1-500`).
3. **Narrow anything over 500 characters.**
4. **Read-only:** never change, move or delete a session file.

Only the owner's own typed prompts count as the owner's words. Hook output, system reminders and tool results
are not; in a helper session's transcript, "user" is the session that started it.

## Analyst briefs

Each analyst gets: the case file's path, the rules above, and one brief. Each returns only this:

```text
## <Dimension> findings
- finding: <one sentence, what happened>
  evidence: <absolute path>:<line> — "<quote, at most 200 characters>"
  turns: <first>–<last>
  confidence: high | medium | low
Checked: <files, line ranges, commands used>
```

**1. Skill timeline.** List the owner's prompts with line and time. List every skill invoked and every
`SKILL.md` read, with line and turn. Then compare each prompt with the `description` of every installed skill
(read their frontmatter). Report: each invocation and the prompt before it; **each prompt that matches a skill's
description with no invocation in that turn** (quote both); each late invocation.

**2. Stumbles.** Every point the session stopped going forward: errors and failed commands, the same call
retried after an error, an edit later reverted, the assistant backtracking ("actually", "that was wrong"), the
owner correcting it, permission denials, hook failures, compactions mid-task. For each: line, turn, what failed,
and whether it recovered (same turn / later at line N / never). Group repeats with a count.

**3. Skill adherence.** For each skill that was invoked: quote the steps it requires, and for each step say
whether the session did it (line), skipped it, or did something the skill forbids (line). Note when the session
followed the skill's `description` instead of its body.

## Case template (`case.md`)

```markdown
# Case: <session-id>
Created: <time>

## Problem (agreed with the owner)
<one paragraph: session, turns, expected, happened, what matters>

## Sessions
| Role | Session id | Absolute path | Lines | Bytes | Longest line | First prompt (120 chars) | First time |
|---|---|---|---|---|---|---|---|

Rejected candidates: <id — path — why>, or "none".  Still running when read: yes | no

## Environment
- Harness and version; models seen
- Skills installed (path, and a hash or "unavailable"), and which were read or invoked
- Instruction files present (paths only)
Label each item: from the record · current only (may differ from then) · unknown.
```

## Report template (`report.md`)

```markdown
# Why <skill> misbehaved in <session-id>

## 1. Problem            (copied from the case)
## 2. What happened      (prose; `file:line` after every claim; confidence high/medium/low and what would raise it)
## 3. Environment        (from the case, each item labelled)
## 4. Sessions examined  (table; rejected candidates)
## 5. Timeline           (one row per owner prompt: turn | line | time | request | skills and events)
## 6. Findings           (6.1 skill timeline · 6.2 stumbles · 6.3 skill adherence; "none found — checked: …" if empty)
## 7. Likely cause in the skill
   One of: description never matched the request · description summarised the workflow and was followed instead
   of the body · a step is missing or unclear · two instructions contradict · the skill is too long and was cut ·
   not the skill (say what instead) · unknown.
   Evidence: <file:line list>. The fix is a separate change, made with writing-skills.md.
## 8. Coverage           (not read and why; session still running; what the owner should double-check)
```

## Red flags

| Thought | Reality |
|---|---|
| "The problem is obvious; skip agreeing it" | The problem statement scopes everything. Ask |
| "They're away, so I'll write the problem for them" | You can't. Write the questions and stop |
| "I'll fix the skill while I'm here" | Diagnose first; the fix goes through writing-skills.md with a red run |
| "The cost per token is well known" | A number not computed from the record is invented. Cite it or drop it |
