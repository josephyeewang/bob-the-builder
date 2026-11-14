# Writing a skill (test first)

<!-- Adapted from obra/superpowers@22f0b463e7a5e579904dd6211a520321035526f7 (skills/writing-skills/SKILL.md and references/discovery.md, references/bulletproofing.md), MIT, Copyright (c) 2025 Jesse Vincent. Licence: third_party/superpowers/LICENSE. Changes: reworded for Bob and a non-engineer owner; superpowers' cross-skill references replaced by Bob's files; the two Bob checks added as the last step; the deployment checklist cut to what Bob uses. -->

> Adapted from obra/superpowers@22f0b46 (writing-skills), MIT.

**Use this when** you write a new skill, change an existing one (a Bob skill, a project skill, or a change a
self-improvement run proposes), or need to prove a skill works before it is merged. Its two companions:
`testing-skills-with-helpers.md` (how to run the tests this method asks for) and `testing-instruction-files.md`
(the same idea for CLAUDE.md / AGENTS.md).

## The idea in one line

**Writing a skill is test-first development for instructions.** Watch a helper session fail at the task *without*
the skill, write the smallest skill that fixes exactly that failure, watch it pass *with* the skill, then close the
loopholes it found. If you never saw it fail without the skill, you don't know the skill teaches the right thing.

| Code testing | Skill writing |
|---|---|
| Test case | A realistic task (for rules: a scenario with pressure to skip the rule), given to a fresh helper session |
| Code | The SKILL.md |
| Test fails (red) | Without the skill, the helper gets it wrong; write down what it did and the reasons it gave, word for word |
| Test passes (green) | With the skill, the helper gets it right |
| Refactor | Close each new excuse the helper found, then re-test |

**No skill and no skill change without a failing test first.** That includes "just adding a section" and
"only a wording fix". An untested change kept "for reference" is still an untested change.

## When a skill is the right tool

Write one when the technique was not obvious, you will use it again across projects, and it applies broadly.
Don't, for a one-off fix, something well documented elsewhere, a project's own conventions (those go in its
AGENTS.md), or anything a script can enforce: **if a regular expression or a check can enforce it, write the
check and keep the skill for judgement.**

Three kinds, each tested differently (see the testing method):
- **Technique** — steps to follow (a debugging method). Test: can the helper apply it to a new case?
- **Discipline** — a rule people skip under pressure (test first; verify before done). Test: does it hold under
  three pressures at once?
- **Reference** — facts to look up (an API, a command list). Test: does the helper find the right fact and use it?

## The description decides whether the skill is ever read

The `description` in the frontmatter is what a session reads to decide whether to open the skill.

- Say **only when to use it**: the situations and the words a user would say. Start with "Use when…".
- **Never summarise the workflow in it.** A session that reads a workflow summary follows the summary and skips the
  skill. (Superpowers found a description saying "review between tasks" got one review where the skill required two.)
- Third person; under the limit `scripts/skill-review-check.mjs` sets; name with letters, numbers and hyphens only.

```yaml
# Bad: summarises the steps, so they get followed instead of the skill
description: Use for debugging - reproduce, trace to the source, fix, add a test
# Good: only when
description: Use when a test fails, a bug is reported, or a fix did not work the first time
```

## The body

A lean SKILL.md holds what every run needs: a one-line core idea, when to use it (and when not), the steps or the
pattern, a quick-reference table, and common mistakes. Move anything needed only sometimes (a long reference, a
worked campaign) into `references/`, and say in the SKILL.md at which step to open it. A skill that is too long
gets cut after a compaction; `scripts/skill-size/test-skill-size.sh` holds that limit.

- **One excellent example** beats five mediocre ones in five languages. Complete, real, commented with *why*.
- Call bundled scripts through their interpreter (`bash scripts/x.sh`, `node scripts/x.mjs`), never by bare path.
- Write instructions in the imperative ("Read the notes"), not "you should".
- No story of one session ("on 3 Oct we found…"): a skill is reusable, not a diary.

## Match the form to the failure

Before writing the fix, name what kind of failure the red test showed. The wrong form makes it worse.

| What the helper did wrong | Right form | Wrong form |
|---|---|---|
| Skipped a rule it knew, under pressure | A flat rule, a table of its excuses with the answer to each, and a red-flags list | Soft advice ("consider…") |
| Followed the skill but produced the wrong shape | A recipe: what the output **is**, its parts in order | A list of don'ts |
| Left out a required part | A required slot in the template it fills in | A reminder near the template |
| Should act differently depending on something | "If <thing you can see>, do X" | A rule plus exceptions |

Two traps: **a "unless it matters" clause reopens the argument** (state a real exception as its own "if…"), and
**an exemption doesn't scope** ("this limit doesn't apply to code" still suppresses code; restructure instead).

### Closing loopholes (discipline skills only)

- Forbid the specific workaround, not just the act: "Delete it. Don't keep it as reference. Don't adapt it."
- Say early: **breaking the letter of the rule is breaking the rule.** It cuts off "I followed the spirit".
- Keep an **excuse table** (each excuse the red test produced, and the answer) and a **red-flags list** ("If you
  catch yourself thinking X, stop").
- Put the symptoms of *about to break the rule* in the description, so the skill loads at that moment.

## Check the wording cheaply before the full test

Full pressure tests are slow. First test the wording: one fresh helper per sample, with the realistic context the
words will live in and a task that tempts the failure; **always a control with no guidance** (if the control does
not fail, there is nothing to fix: stop); **five or more samples each**; read every flagged answer yourself; and
treat disagreement between samples as a sign the wording doesn't bind yet. This checks wording; it does not replace
the pressure test for a discipline skill.

## Before it is merged: the checklist

**Red**
- [ ] Wrote the test tasks (three pressures combined, for a discipline skill)
- [ ] Ran them **without** the skill; wrote down choices and excuses word for word

**Green**
- [ ] Name: letters, numbers, hyphens; frontmatter has `name` and `description`
- [ ] Description says only when to use it, in a user's words, and no workflow
- [ ] The skill answers the failures the red run showed, in the form the table above gives
- [ ] Ran the same tasks **with** the skill: the helper now gets it right

**Refactor**
- [ ] Each new excuse closed and re-tested; excuse table and red flags updated (discipline skills)

**Bob's checks** (both must pass)
- [ ] `node "$(realpath ~/.claude/skills/bob/..)/scripts/skill-review-check.mjs" <skill-folder>` reports no Material finding
- [ ] For a skill in Bob: `bash ~/.claude/skills/bob/../scripts/skill-size/test-skill-size.sh` passes
- [ ] A fresh helper ran the skill reviewer (`reference/skill-craft/skill-reviewer.md`) and its verdict is Pass

**One skill at a time.** Don't write several skills and test them together: finish the checklist for each.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing the skill before the red run | You wrote what you think goes wrong, not what does. Run the red test first |
| A test with no pressure ("what does the skill say?") | The helper recites the skill. Give it a real task with a reason to cut the corner |
| "The helper got it wrong" | Record the exact words of its excuse; that is what the fix answers |
| A generic counter ("don't cheat") | Name the specific workaround and forbid it |
| Stopping after one green run | Re-test after each fix until no new excuse appears |
