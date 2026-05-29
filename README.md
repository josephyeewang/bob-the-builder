# Bob the Builder

**A skill that guides you step-by-step to build and audit real products in Claude Code. For non-engineers.**

---

## What this does

3 things:

1. **NEW** — Start a product from scratch. Bob takes you from "I have an idea" → spec → build plan → working product, pausing for your sign-off at every step.
2. **AUDIT** — Inspect a product you've already started (yours or someone else's). Bob runs 30 ready-made audits across engineering, UX, AI behavior, security, pricing, strategy, and growth — and tells you what's solid, what's hollow, and what to fix first.
3. **EVOLVE** — Add a feature to a product Bob already built. Bob classifies the change (small / medium / large) and runs the right level of discipline for it.

---

## Why it's amazing

1. **Built for non-engineers** — built by a non-engineer (former McKinsey, Fifth Wall, Clari — never wrote production code) who was sick of Claude going sideways. Every design choice was made for someone who is great at scoping a product but can't read or debug code themselves.
2. **Easy install** — copy/paste once into Claude Code and you're installed. No multi-step chaos or downloads.
3. **Easy to use** — type `/bob` and it works. Every step is in plain language, no jargon. Bob narrates what's happening and pauses for your sign-off before doing anything irreversible. You don't need to know how to code.
4. **NEW prevents hallucinations** — instead of letting Claude guess what to build, Bob locks the spec, scope, and AI behavior upfront. Claude can't quietly drift, add features you didn't ask for, or forget what it agreed to two sessions ago.
5. **AUDIT saves you the trouble of inventing your own audits** — Bob ships 30 ready-made audit prompts synthesized from 46+ industry sources (CodeRabbit, OWASP, Nielsen, Microsoft HAX, April Dunford, Reforge, and more). You don't have to know what to look for — Bob does.

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

Bob asks one question — which mode (NEW / AUDIT / EVOLVE) — and walks you from there.

### What happens when you type `/bob`

1. **Bob senses the project silently.** Does a Bob manifest exist? Is the git tree clean? What kind of project is this? (No questions asked — it just looks.)
2. **Bob shows one short summary** — what it sees, a tentative complexity classification, and any housekeeping flags (e.g., uncommitted work).
3. **Bob asks one question: which mode?** (NEW / AUDIT / EVOLVE.) That's the only thing you decide at startup.
4. **You pick.** Bob takes it from there — gathering what it needs, narrating as it goes.

Narrator Mode is on by default — Bob explains each step in plain language and summarizes after every completion. Say **"terse mode"** any time if you'd rather it be quieter.

---

## How often do I invoke Bob?

- **Install:** once per machine
- **Type `/bob`:** once at the start of each new project
- **After that:** every session auto-resumes — just say "let's continue"
- **Updates:** automatic — each time you type `/bob`, Bob checks (at most once a day) whether a newer version exists and offers to grab it before you start. You just say yes; you never have to remember. You can also type `update bob` any time to force a check.

---

## What it does EXACTLY

Five concrete capabilities. Three are the modes you invoke; two are cross-cutting things Bob does *during* the modes.

### 1. NEW — Build from scratch

You bring an idea. Bob walks you through:

- **Bulletproof Product Spec** — what you're building, who it's for, what's explicitly out of scope
- **AI Behavior Guardrails** — for AI products, Bob locks down how your AI thinks (tone, refusal patterns, edge-case behavior) *before* any code is written
- **Phased Build Plan** — exactly what to build when, with a sign-off gate at every step
- **Reconciliation after every phase** — Bob checks built-vs-planned, flags drift, won't move on until you sign off

Invoke with `/bob NEW` or pick **A) NEW** from the menu.

### 2. AUDIT — Inspect a product (yours or someone else's)

As of v2.17, AUDIT is dramatically different from what you'd get from a generic code review tool. Bob ships a **30-lens audit library** — 30 ready-made audit prompts each attacking the product from a different angle, in 8 bands:

| Band | What it audits |
|---|---|
| **Engineering Foundation** (L01–L06) | Code hygiene + liveness execution, spec fidelity, capability quality, security (STRIDE + OWASP T10:2025 + ASVS 5.0), data protection + privacy (GDPR Art.30), supply chain + configuration |
| **User Experience** (L07–L10) | Cognitive ease (Nielsen + Norman), friction + trust (Brignull dark patterns), wow + emotional peaks (Peak-End + JTBD), edge states + recovery |
| **AI Behavior** (L11–L14) | Accuracy + calibration (TruLens, RAGAS, promptfoo), right-sizing + model fit, interaction safety (Microsoft HAX + Garak + OWASP LLM Top 10), cost + latency efficiency |
| **Performance Economics** (L15–L16) | Cost / speed drivers including the **tradeoff-inversion lens** — *where should we DELIBERATELY pay more or accept more latency for value?* |
| **Reach & Distribution** (L17–L20) | Mobile / form factor, internationalization, accessibility (WCAG 2.2+), shareability / virality / discoverability |
| **Operational** (L21–L23) | Observability + incident readiness, vendor + dependency risk, documentation + onboardability (Diátaxis) |
| **Strategic & Market** (L24–L28) | Competitive benchmarking, pricing & monetization (incl. FTC Click-to-Cancel), marketing + copy, persona simulation (adversarial reasoning), **strategic edge & wedge sharpness** (the anti-convergence lens) |
| **Growth & Adoption** (L29–L30) | Onboarding + activation (Sean Ellis + Reforge), retention + compounding loops (Hook model, growth loops, network effects) |

Why this is different from running CodeRabbit / Greptile / Snyk:

- **Synthesized from 46+ industry sources, not one angle.** 12 commercial code-review tools, 14 audit taxonomies, 13 UX/product methods, and strategic frameworks from April Dunford, Patrick Campbell, Nir Eyal, Reforge, Andrew Chen, and others.
- **Bob picks the panel, not you.** Bob proposes a curated 6–10 lens panel based on your project profile (greenfield consumer? launched B2B SaaS? pre-fundraise scrub? post-incident audit?). You confirm with one gate.
- **L28 anti-convergence veto.** Most audits push products toward "best-practice average." Bob's L28 explicitly pushes back. It can mark earlier UX findings as "do not fix — that friction is your wedge" (Linear keyboard-first, Superhuman shortcuts). The first audit library designed to NOT make every product converge to mediocrity.
- **Execution-first.** Bob doesn't just *read* code — Bob *runs* it. Playwright for user journeys, Schemathesis against APIs, Garak red-teams on AI surfaces, programmatic signup-to-cancel walks. Every lens names what Claude should EXECUTE vs READ vs leave to a HUMAN walk.
- **Audit memory.** Bob remembers what you ran last and offers four options on entry: **Same** (drift check) / **Complementary Curated** (broaden coverage) / **Full Enchilada** (all 30) / **Custom**.
- **Self-learning library.** After every audit Bob auto-emits a *lens retro* — a critique of the lenses themselves, distinct from findings about your product. Retros accumulate; weak lenses get flagged; a human decides which to sharpen. Bob never auto-edits its own lenses.

Invoke with `/bob AUDIT` or pick **B) AUDIT** from the menu. See `audit-lenses/README.md` in the repo for the full library + provenance.

### 3. EVOLVE — Add a feature

Bob classifies the change (Small / Medium / Large) and runs the right level of discipline. Small = quick edit + smoke test. Medium = reference scan + spec update + phased build. Large = full discipline including reconciliation and audit.

Invoke with `/bob EVOLVE` or pick **C) EVOLVE**.

### 4. Drift prevention (during every mode)

This is the load-bearing thing Bob does *while* you're in any of the modes above:

- **Spec lock** — Bob catches Claude every time it wanders off-spec (adding features you didn't approve, silently changing behavior, forgetting earlier decisions)
- **Class-level fixes** — bug in one place? Bob audits every similar pattern, not just the symptom that surfaced
- **AI behavior eval re-runs** — for AI products, your eval set re-runs at every phase. Drift on a previously-passing eval is a stop sign, not a "ship it anyway"

### 5. Project memory (across every session)

Bob writes the important stuff to disk so context survives session boundaries, compaction, and tool switches:

- **Spec** — living, updated during the build, not just at the start
- **Decision log** — every non-obvious choice recorded with the *why*
- **Build manifest** — what's done, what's next, where drift was caught
- **Audit history** — which lenses ran, what they found

And every Bob-built project ships with both `CLAUDE.md` and `AGENTS.md` so you're not locked to Claude. Try Codex, Cursor, or Aider later — your project's context comes with you.

---

## Why this beats just asking Claude directly

| If you do this | What Bob does instead |
| --- | --- |
| Write a longer, better prompt | A prompt is a paragraph. Bob is a 2,600-line versioned protocol baked from real shipped products and lessons learned the hard way. |
| Tell Claude to "be more disciplined" | Claude agrees, then drifts ten messages later. Bob installs as a Claude Code skill with explicit pause-and-confirm gates the model can't quietly skip. |
| One-shot prompt Claude and hope | Bob locks the spec **before** any code happens, with explicit "in scope / out of scope" at every phase. |
| Use Cursor / Windsurf rules | Those govern code style (semicolons, formatting). Bob governs *what* to build: spec, behavior, scope, success metrics, decision log. Complementary, not substitutes. |
| Run CodeRabbit / Greptile / Snyk for audits | Each is one angle. Bob runs 30 lenses synthesized from 46+ sources with an explicit anti-convergence veto (L28) so audits don't push your product toward "best-practice average." |
| Trust that "tests passing" means it works | Tests pass, then it breaks in production. Bob's audits **execute** — Playwright, Schemathesis, Garak red-teams, API queries. Execution evidence > reasoning inference. |
| Try to remember what you did last session | Bob writes spec + decision log + build manifest to disk. Full context is always loadable next session, and portable to other AI tools via `AGENTS.md`. |

---

## Creator

**[Joe Wang](https://joe.wang)** — business guy who just wanted something that worked. Former McKinsey consultant, Fifth Wall venture capitalist, Clari SaaS exec. Not an engineer.

If Bob helps you ship something, shoot me an email at [joe@joe.wang](mailto:joe@joe.wang) — I'd love to see it.

---

**Q:** Why "Bob the Builder"?

**A:** Because I'd ask Claude to build something and I'd wonder — "Can he build it?"

Now, finally, the answer is: "Yes he can!" 🔨

---

## License

[MIT](LICENSE) — use it, fork it, adapt it, share it.
