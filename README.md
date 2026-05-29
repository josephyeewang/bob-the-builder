<img src="assets/bob-logo.svg" alt="Bob the Builder logo" width="180" align="right" />

# Bob the Builder

**A skill that guides you step-by-step to build and audit real products in Claude Code. For non-engineers.**

---

## What this does

3 things:

1. **NEW** — Start a product from scratch. Bob takes you from "I have an idea" → spec → build plan → working product, pausing for your sign-off at every step.
2. **AUDIT** — Inspect a product you've already started (yours or someone else's). Bob runs 30 ready-made audits across engineering, UX, AI, security, pricing, strategy, and growth — and tells you what's solid, what's hollow, and what to fix first.
3. **EVOLVE** — Add a feature to a product Bob already built. Bob right-sizes the change (small / medium / large) and runs the right level of discipline for it.

---

## Why it's amazing

1. **Built for non-engineers** — built by a non-engineer (former McKinsey, Fifth Wall, Clari) who was sick of Claude going sideways. Designed for someone who can scope a product but can't read code.
2. **Easy install** — one copy/paste into Claude Code. No git, no terminal, no downloads.
3. **Easy to use** — type `/bob` and it works. Plain language. Sign-off gates before anything irreversible.
4. **Prevents Hallucinations** — Bob locks the spec, scope, and AI behavior upfront. Claude can't quietly drift, add features you didn't ask for, or forget what it agreed to two sessions ago.
5. **Auto Audits Your Project** — 30 ready-made audits pulled from 46+ industry sources (OWASP, Nielsen, April Dunford, Reforge, and more). You don't have to know what to look for — Bob does.

---

## How to Install — Paste this into Claude Code

```
Please install Bob the Builder from
https://github.com/josephyeewang/bob-the-builder
as a Claude Code skill, so I can type
/bob in any project.
```

---

## How to use it

In any project folder, open Claude Code and type:

```
/bob
```

Bob asks one question — which mode (NEW / AUDIT / EVOLVE) — and walks you from there in plain language.

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

Invoke with `/bob NEW`.

### 2. AUDIT — Inspect a product (yours or someone else's)

Bob ships a **30-audit library** — 30 ready-made audits, each attacking the product from a different angle, in 8 categories:

| Category | What it audits |
|---|---|
| **Engineering Foundation** | Code hygiene, spec fidelity, capability quality, security, privacy, supply chain |
| **User Experience** | Cognitive ease, friction & trust, wow moments, edge states & recovery |
| **AI Behavior** | Accuracy, model fit, safety, cost & latency |
| **Performance Economics** | Where to save money/time — and where to *spend* more for value |
| **Reach & Distribution** | Mobile, internationalization, accessibility, shareability |
| **Operational** | Observability, vendor risk, documentation |
| **Strategic & Market** | Competitive position, pricing, marketing copy, persona simulation, strategic edge |
| **Growth & Adoption** | Onboarding & activation, retention loops |

Why it's different from a generic code-review tool:

- **Bob picks the audits for you** — proposes 6–10 based on what kind of product you have. Confirm with one gate. Or pick "Full Enchilada" to run all 30 before a launch.
- **Bob runs the code, not just reads it** — drives the app through real user flows, hits the APIs, simulates signup-to-cancel. Reading code can lie. Running it can't.
- **Anti-convergence veto** — most audits push every product toward "best-practice average." Bob has a dedicated audit that pushes back: *"do not fix this — that friction is your wedge."* (Think Linear's keyboard-first onboarding, Superhuman's shortcuts.)
- **Bob remembers** — each AUDIT, you can re-run the last set, broaden to new angles, or do the full 30.
- **Bob learns** — after every audit Bob critiques *its own audits*. Weak ones get flagged for you to sharpen. Bob never edits itself without you.

Invoke with `/bob AUDIT`.

### 3. EVOLVE — Add a feature

Bob classifies the change Small / Medium / Large and runs the right level of discipline. Small = quick edit + smoke test. Large = full discipline including reconciliation and audit.

Invoke with `/bob EVOLVE`.

### 4. Drift prevention (during every mode)

What Bob does *while* you're building:

- **Spec lock** — Bob catches Claude every time it wanders off-spec
- **Class-level fixes** — bug in one place? Bob audits every similar pattern, not just the symptom
- **AI behavior re-checks** — for AI products, your test set re-runs at every phase. Regressions are a stop sign, not a "ship anyway"

### 5. Project memory (across every session)

Bob writes the important stuff to disk so context survives session boundaries:

- Spec, decision log, build manifest, and audit history — all on disk
- Every Bob-built project ships with both `CLAUDE.md` and `AGENTS.md` so you can switch to Codex, Cursor, or Aider later without losing context

---

## Why this beats native Claude

| ❌ Issues with Claude | ✅ Why Bob is Amazing |
| --- | --- |
| ❌ **Hallucinates** — makes up features, libraries, or behaviors you never asked for | ✅ Bob locks the spec, scope, and AI behavior *before* any code is written. Claude can't quietly add features or invent behaviors that weren't approved. |
| ❌ **Forgets** what you talked about last session | ✅ Bob writes spec + decision log + build manifest to disk every session. Full context is always loadable — and portable to Codex / Cursor / Aider via `AGENTS.md`. |
| ❌ **Drifts** off-spec mid-build — agrees with your spec, then quietly does something else ten messages later | ✅ Reconciliation after every phase: Bob checks built-vs-planned, flags drift, and won't move on until you sign off. |
| ❌ **Audits narrowly** — one angle (usually a security scan) and calls it done | ✅ 30 ready-made audits across 8 categories, plus an anti-convergence veto so audits don't push your product toward "best-practice average." |
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
