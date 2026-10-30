# Bob the Builder &nbsp; <img src="assets/bob-logo.svg" alt="Bob the Builder logo" height="120" align="center" />

**A skill that guides you step-by-step to build and audit real products in Claude Code. For non-engineers.**

---

## What this does

4 things:

1. **NEW** — Start a product from scratch. Bob takes you from "I have an idea" → spec → build plan → working product, pausing for your sign-off at every step.
2. **AUDIT** — Inspect a product you've already started (yours or someone else's). Bob runs 38 ready-made audits across engineering, UX, AI, security, SEO/AI-search visibility, pricing, strategy, and growth — and tells you what's solid, what's hollow, and what to fix first.
3. **EVOLVE** — Add a feature to a product Bob already built. Bob right-sizes the change (small / medium / large) and runs the right level of discipline for it.
4. **UPGRADE** — Bring a project Bob set up earlier up to date with today's Bob. Bob shows what has improved since, and why, and changes only what you approve.

---

## Why it's amazing

1. **Built for non-engineers** — built by a non-engineer (former McKinsey, Fifth Wall, Clari) who was sick of Claude going sideways. Designed for someone who can scope a product but can't read code.
2. **Easy install** — one copy/paste into Claude Code. No git, no terminal, no downloads.
3. **Easy to use** — type `/bob` and it works. Plain language. Sign-off gates before anything irreversible.
4. **Prevents Hallucinations** — Bob locks the spec, scope, and AI behavior upfront. Claude can't quietly drift, add features you didn't ask for, or forget what it agreed to two sessions ago.
5. **Auto Audits Your Project** — 38 ready-made audits pulled from 46+ industry sources (OWASP, Nielsen, April Dunford, Reforge, SR 11-7, ISO Plain Language, the Princeton GEO paper, and more). You don't have to know what to look for — Bob does. Includes a unified SEO + AI-search (AEO/GEO) audit, because almost every product has a website.

---

## How to Install — Paste this into Claude Code

```
Please install Bob the Builder from
https://github.com/josephyeewang/bob-the-builder
as Claude Code skills: link its skill/ folder
as ~/.claude/skills/bob, and its two design
skills (skills/design-gallery and
skills/design-mockups) under their own names,
so I can type /bob in any project.
```

To check the install at any time, ask Claude Code to run `bash ~/.claude/skills/bob/../scripts/bob-doctor.sh`. It explains anything missing in plain English.

---

## How to use it

In any project folder, open Claude Code and type:

```
/bob
```

Bob asks one question — which mode (NEW / AUDIT / EVOLVE / UPGRADE) — and walks you from there in plain language.

---

## How often do I invoke Bob?

- **Install:** once per machine
- **Type `/bob`:** once at the start of each new project
- **After that:** every session auto-resumes — just say "let's continue"
- **Updates:** automatic — Bob asks before pulling a new version; just say yes

---

## What it does EXACTLY

Five things. Three are the modes you invoke; two are what Bob does *during* the modes.

### 1. NEW — Build from scratch

You bring an idea. Bob walks you through:

- **Bulletproof Product Spec** — what you're building, who it's for, what's out of scope
- **AI Behavior Guardrails** — for AI products, locks how your AI thinks (tone, refusals, edge cases) *before* any code is written
- **Phased Build Plan** — what to build when, with a sign-off gate at every step
- **Pre-build review** — before any code, fresh reviewers who didn't write the plan pick it apart (including a design critic and a "could an engineer build the next phase without guessing?" check), then you sign off

Invoke with `/bob NEW`.

### 2. AUDIT — Inspect a product (yours or someone else's)

Bob ships a **38-audit library** — 38 ready-made audits, each attacking the product from a different angle, in 8 categories:

| Category | What it audits |
|---|---|
| **Engineering Foundation** | Code hygiene, spec fidelity, capability quality, security, privacy, supply chain, **end-to-end data-flow tracing** (does every field a user enters actually reach every feature that needs it?) |
| **User Experience** | Cognitive ease, friction & trust, wow moments, edge states & recovery |
| **AI Behavior** | Accuracy, model fit, safety, cost & latency, **analytical soundness** (is the *method* behind a score/diagnosis/recommendation actually sound?) |
| **Performance Economics** | Where to save money/time — and where to *spend* more for value |
| **Reach & Distribution** | Mobile, internationalization, accessibility, shareability, **SEO + AI-search visibility** (will Google, ChatGPT, Perplexity & AI Overviews find, rank, and *cite* your site?) — and a 3-altitude plan: tactical fixes, content to build, and which topics to invest in owning |
| **Operational** | Observability, vendor risk, documentation |
| **Strategic & Market** | Competitive position, pricing, marketing copy, persona simulation, strategic edge, **output language & audience fit** (does what the product *says* match who's reading it — no jargon for non-experts?) |
| **Growth & Adoption** | Onboarding & activation, retention loops |

Why it's different from a generic code-review tool:

- **Bob picks the audits for you** — proposes 6–10 based on what kind of product you have. Confirm with one gate. Or pick "Full Enchilada" to run every lens before a launch.
- **Bob runs the code, not just reads it** — drives the app through real user flows, hits the APIs, simulates signup-to-cancel. Reading code can lie. Running it can't.
- **Anti-convergence veto** — most audits push every product toward "best-practice average." Bob has a dedicated audit that pushes back: *"do not fix this — that friction is your wedge."* (Think Linear's keyboard-first onboarding, Superhuman's shortcuts.)
- **Bob remembers** — each AUDIT, you can re-run the last set, broaden to new angles, or do the full 38.
- **Bob learns** — after every audit Bob critiques *its own audits*. Weak ones get flagged for you to sharpen. Bob never edits itself without you.

Invoke with `/bob AUDIT`.

### 3. EVOLVE — Add a feature

Bob classifies the change Small / Medium / Large and runs the right level of discipline. Small = quick edit + smoke test. Large = full discipline including reconciliation and audit.

Invoke with `/bob EVOLVE`.

### 4. UPGRADE — Bring an older project up to date

Bob keeps getting better; projects started months ago don't get the improvements by themselves. UPGRADE checks every piece Bob put into your project (its safety hooks, the fresh-eyes reviewer, the daily dropped-work check, the lists it keeps) and tells you, in plain English, which are up to date, which Bob has improved — with the reason for each change — and which are new since you started. Then it changes only what you approve:

- Your old copy of anything it replaces is saved first
- A new check that could stop your work starts in **warn-only** mode — it tells you what it would have blocked, and you switch it on when you're ready
- Anything you changed on purpose stays as you left it — you list those once, with a one-line reason, and Bob leaves them alone
- It asks the reverse question too: is something in this project better than Bob? If so, that improvement goes back into Bob for every future project

Invoke with `/bob UPGRADE`.

### 5. Drift prevention (during every mode)

What Bob does *while* you're building:

- **Spec lock** — Bob catches Claude every time it wanders off-spec
- **Class-level fixes** — bug in one place? Bob audits every similar pattern, not just the symptom
- **AI behavior re-checks** — for AI products, your test set re-runs at every phase. Regressions are a stop sign, not a "ship anyway"
- **Proof a fix is real** — every fix names a test; a separate session removes the fix and confirms the test fails, puts it back and confirms it passes, and keeps a receipt
- **No moving the finish line** — a phase's done-criteria are fingerprinted when it starts; changing them later needs a dated reason
- **No merging on red** — a hook refuses a pull-request merge while any check you listed as required is failing, and refuses pushing straight to main. Brand-new projects with no checks yet aren't blocked; the guard switches on when you name your first check
- **Nothing dropped between sessions** — one open-items list with one owner per row, and a daily check that flags pull requests left open with no dated hold, findings with no owner or due date, and scheduled jobs that failed twice or never ran

### 6. Project memory (across every session)

Bob writes the important stuff to disk so context survives session boundaries:

- Spec, decision log, build manifest, and audit history — all on disk
- An audit record that a script can check, so "five clean audits in a row on this kind of work — relax it" is counted, not guessed
- The file every session reads first holds pointers, not status — and a check fails when a pointer breaks or the status page falls a week behind the decisions
- Every Bob-built project ships with both `CLAUDE.md` and `AGENTS.md` so you can switch to Codex, Cursor, or Aider later without losing context

---

## How Bob fits with your own setup

Your rules for working with Claude usually end up in three places. Bob keeps each rule in exactly one:

1. **Your own instructions** (in Claude Code, `~/.claude/CLAUDE.md`) — rules for *any* task: how you like to be spoken to, what "done" means for you, your safety rails.
2. **Bob** — the one current way to *build software*: the steps, the checkpoints, the reviewers, the checks. Your projects point to Bob instead of copying it.
3. **Each project** — only facts about that project, plus anything it does differently from Bob on purpose (listed with the reason in `.bob/differences.md`).

**Write a rule once, in the narrowest place that still covers every case it applies to, and point to it from everywhere else.** A copied rule drifts; a pointer can't. When a project finds a better way, it goes back into Bob (written in general terms). When Bob improves, `/bob UPGRADE` brings each project up to date.

---

## Why this beats native Claude

| ❌ Issues with Claude | ✅ Why Bob is Amazing |
| --- | --- |
| ❌ **Hallucinates** — makes up features, libraries, or behaviors you never asked for | ✅ Bob locks the spec, scope, and AI behavior *before* any code is written. Claude can't quietly add features or invent behaviors that weren't approved. |
| ❌ **Forgets** what you talked about last session | ✅ Bob writes spec + decision log + build manifest to disk every session. Full context is always loadable — and portable to Codex / Cursor / Aider via `AGENTS.md`. |
| ❌ **Drifts** off-spec mid-build — agrees with your spec, then quietly does something else ten messages later | ✅ Reconciliation after every phase: Bob checks built-vs-planned, flags drift, and won't move on until you sign off. |
| ❌ **Audits narrowly** — one angle (usually a security scan) and calls it done | ✅ 38 ready-made audits across 8 categories, plus an anti-convergence veto so audits don't push your product toward "best-practice average." |
| ❌ **Doesn't right-size effort** — treats a typo and a multi-file refactor with the same level of care | ✅ EVOLVE classifies every change Small / Medium / Large. Small = quick edit + smoke test. Large = full discipline. |
| ❌ **Reads code and reasons about it** instead of running it — "this looks correct" ≠ "this works" | ✅ Bob's audits *execute* — drives the app through real user flows, hits the APIs, simulates signup-to-cancel. Running it catches what reading it doesn't. |
| ❌ **Patches the symptom** you reported and leaves the same bug pattern in three other files | ✅ Class-level fixes: a bug in one place triggers a repo-wide grep for the same pattern. Fix once, fix all. |
| ❌ **Calls it shipped** when the local build passes — even if prod is white-screening | ✅ Post-deploy verification: after every fix Bob hits the live URL and confirms the page actually renders before declaring done. |

---

## Creator

**[Joe Wang](https://joe.wang)** — business guy who just wanted something that worked. Former McKinsey consultant, Fifth Wall venture capitalist, Clari SaaS exec. Not an engineer.

If Bob helps you ship something, shoot me an email at [joe@joe.wang](mailto:joe@joe.wang) — I'd love to see it.

---

## Why call it Bob?

Because I'd ask Claude to build something and I'd wonder — "Can he build it?"

Now, finally, the answer is: "Yes he can!" 🔨

---

## License

[MIT](LICENSE) — use it, fork it, adapt it, share it.

A few pieces are adapted from other open-source projects (Google's elephant-goldfish-model, Apache-2.0; and, all MIT: pullboard, ECC — whose two guard hooks `bob-init` installs in every new project — Cloudflare's security-audit skill, GitHub Spec Kit, ai-employees and ai-security-checklist-prompt). Their licences and what was taken are listed in [`third_party/README.md`](third_party/README.md); those files keep their original licence.
