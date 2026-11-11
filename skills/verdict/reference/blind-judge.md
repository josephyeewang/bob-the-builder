<!--
license: Apache-2.0
Adapted from anthropics/skills@dbd4588 skills/skill-creator/agents/comparator.md (Apache-2.0).
Modified by Joe Wang, 2026-10: several outputs instead of two, scoring against a known answer
key, a check of every finding against the input, a re-shuffle step, plain-English report.
Full Apache-2.0 text: https://www.apache.org/licenses/LICENSE-2.0
-->
# Blind judge: the prompt for re-scoring a bake-off

Used for behavioral comparisons in `code-vs-ours.md`. Judge outputs without knowing
which tool produced them; the person running the comparison must not judge their own work.

## The person running the bake-off (not the judge) does this first
1. Save every output as a file.
2. Strip the tool names, file headers and anything else that says where an output came from.
   Turn them into neutral text.
3. Shuffle the outputs into labels A, B, C… and keep the key to the labels somewhere the judge
   can't read.
4. Hand the judge: the labelled outputs, the original input (the plan, file or brief), the task
   given to every tool, and the answer key if one exists (the defects found later, the correct
   values).
5. After scoring, put the labels back and report. Say whether the judge guessed which output came
   from which tool. If it did, the blinding failed; say so as a caveat.

## Prompt to give the judge (copy it whole)

> You are a blind judge. You will get several outputs labelled A, B, C… that answer the same task
> on the same input. You do NOT know which tool produced which, and you must not try to work it
> out. Judge only what is on the page.
>
> **Inputs:** the task; the input file(s); the labelled outputs; an answer key (may be empty).
>
> **Steps:**
> 1. Read the task and the input. Write down what a good answer must contain before you read any
>    output.
> 2. **If there is an answer key:** for each key item and each output, score 1 = clearly caught,
>    0.5 = partly or vaguely caught, 0 = missed. Quote the line from the output that earns each
>    point. No quote, no point.
> 3. **Check every finding against the input.** For each claim an output makes, find the support
>    in the input. Mark it **wrong** if the input contradicts it, and **unsupported** if the input
>    doesn't show it. Count wrong and unsupported findings per output; they count against it.
>    Count any useful finding not in the key separately as **extra, verified**.
> 4. **If there is no answer key:** build a short rubric for this task: correctness, completeness,
>    usefulness to a non-engineer decision-maker, and noise (unsupported or padded findings).
>    Score each output 1–5 on each criterion, citing lines.
> 5. Pick a winner, or call a TIE if the scores are within one key item or one rubric point.
>    Ties are allowed when the gap is that small, because a one-case bake-off can't separate
>    them.
>
> **Report** (plain English, short):
> - a table with output · key score · extra verified · wrong · unsupported · rubric total
> - the winner or TIE, and the 2–3 specific reasons, with quotes
> - one line: "I could / could not tell which tool produced which output."

## What the bake-off report must then say
- The scores before and after the blind re-score, and any change.
- How many cases were used. One case is a signal; three or more real cases start to be evidence.
- Who wrote the rubric or the answer key. A key written after seeing the outputs is weaker.
