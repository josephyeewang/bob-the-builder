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

1. **Easy install** — one paste into Claude Code and you're done. No git commands, no terminal wrestling.
2. **Easy to use** — every step is in plain language, no jargon. Bob narrates what's happening and pauses for your sign-off before doing anything irreversible. You don't need to know how to code.
3. **NEW prevents hallucinations** — instead of letting Claude guess what to build, Bob locks the spec, scope, and AI behavior upfront. Claude can't quietly drift, add features you didn't ask for, or forget what it agreed to two sessions ago.
4. **AUDIT saves you the trouble of inventing your own audits** — Bob ships 30 ready-made audit prompts synthesized from 46+ industry sources (CodeRabbit, OWASP, Nielsen, Microsoft HAX, April Dunford, Reforge, and more). You don't have to know what to look for — Bob does.

---

## How to install

### Step 1: Paste this into Claude Code to install Bob

```
Please install Bob the Builder from https://github.com/josephyeewang/bob-the-builder. Set it up as a Claude Code skill so I can type /bob in any project.
```

---

## How to use it

In any project folder, open Claude Code and type:

```
/bob
```

Bob asks one question — which mode (NEW / AUDIT / EVOLVE) — and walks you from there.

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

---

# More detail

Everything below is the long version — deeper explanations, tradeoffs, edge cases, and the full audit-library breakdown. Skip unless you want the details.

---

## Who this is for

- You're not an engineer but you want to ship real products, not just play with prototypes
- You use Claude Code (or want to) but Claude hallucinates or produces tons of errors
- You'd rather be guided step by step instead of "try to be a better prompter"

---

## What it does for you

- **Bulletproof Product Spec** — structures what you're building, who it's for, and what's explicitly out of scope
- **AI Behavior Guardrails** — for AI products, locks down how your AI thinks before any code is written
- **Phased Build Plan** — maps exactly what to build when, with sign-off gates at every step
- **Drift Prevention** — Bob catches Claude when it starts wandering off-spec
- **Class-Level Fixes** — bug in one place? Bob audits every similar pattern, not just the symptom
- **30-Lens Audit Library (v2.17)** — instead of the engineer-default "run a security scan and call it done," Bob ships **30 ready-made audit prompts** across 8 bands: engineering hygiene, spec fidelity, capability quality, security, privacy, supply chain, UX (ease / friction / wow / edge states), AI behavior (accuracy / right-sizing / safety / cost), performance economics, mobile, i18n, accessibility, virality, observability, vendor risk, documentation, competitive positioning, pricing mechanics, marketing copy, persona simulation, strategic wedge sharpness, onboarding, retention loops. **Surveyed across 46+ industry sources** (CodeRabbit, Greptile, Sourcery, ISO 25010, OWASP T10:2025, OWASP ASVS 5.0, STRIDE, WCAG 2.2, GDPR, Microsoft HAX, Nielsen, Don Norman, Brignull dark patterns, Dunford positioning, Linear/Saarinen craft principles, Ramanujam pricing, Patrick Campbell value-metrics, Nir Eyal Hook model, Reforge growth loops, Andrew Chen network effects, and more). Bob picks the right 6-10 lenses for your project profile, OR you pick "Full Enchilada" to run all 30 before a launch.
- **Execution Principle (v2.17.1)** — Bob doesn't just *read* your code and reason about it. Bob *runs* it — drives Playwright through user flows, executes Schemathesis against your APIs, runs Garak red-teams on your AI, queries cost APIs, programmatically walks signup-to-cancel flows. Execution catches what reading misses. Every lens names what Claude should EXECUTE vs READ vs leave to HUMAN walk.
- **Audit Memory** — Bob remembers what audits you ran last and offers four options: Same / Complementary Curated / Full Enchilada / Custom. You never have to remember which lenses you used or invent them from scratch.
- **Anti-Convergence Wedge Audit (L28)** — most audits force products toward "best-practice average." Bob includes a dedicated lens that pushes the OPPOSITE direction: is your product sharpening its strategic edge, or sanding it off? L28 can veto earlier UX findings as "do not fix — that friction is the wedge" (Linear keyboard-first, Superhuman, 37signals patterns). The first audit library that's explicitly designed to NOT make every product converge to mediocrity.
- **Living Decision Log** — every non-obvious choice recorded with the why
- **3 Modes** — NEW (build) / AUDIT (assess) / EVOLVE (extend)
- **Not locked to Claude** — every Bob-built project ships with both `CLAUDE.md` and `AGENTS.md`, so if you later try Codex, Cursor, or Aider, your project's context comes with you

---

## Why this beats just asking Claude directly

**When you one-shot prompt Claude, you spend 100x hours fixing bugs after. Bob builds it properly upfront.**

| Without Bob | With Bob |
| --- | --- |
| Claude guesses what to build | Spec gets locked in **before** any code happens |
| Claude forgets things between sessions | A `build-manifest.md` tracks where you are |
| You ask for feature A, get features A through G | Explicit "in scope / out of scope" at every phase |
| Tests pass, then it breaks in production | **30-lens audit library** covers engineering, UX, AI, mobile, accessibility, pricing, virality, persona simulation, wedge sharpness, and more — synthesized from 46+ industry sources |
| Audits only catch what one angle of attack catches | Bob runs **multiple lenses with ~15% intentional overlap** so different angles produce *confirmation signals*, not noise |
| Audits push your product toward "best-practice average" | Bob includes an explicit **anti-convergence lens** (L28 Strategic Edge & Wedge) that can veto earlier findings as "do not fix — that's the wedge" |
| You can't tell when something is "done enough" | Quality bar templates show good vs weak examples |
| Claude assumes things you didn't approve | Pauses for your sign-off at every important step |
| AI behavior drifts as you add features | Eval set re-runs at every phase; drift is a stop sign |
| Code audits *read* the code and reason about it | Bob's lenses **EXECUTE** — drive Playwright, run Schemathesis, query APIs, simulate user behavior. Execution evidence > reasoning inference. |

---

## "But couldn't I just…"

| Alternative | The honest answer |
| --- | --- |
| **Just write a better prompt.** | A prompt is a paragraph. Bob is a 2,600-line versioned protocol baked from real shipped products and lessons learned the hard way. |
| **Use Cursor / Windsurf rules.** | Those govern code style — semicolons, formatting, framework idioms. Bob governs *what* to build: spec, behavior, scope, success metrics, decision log. It's the product-thinking layer, not the code-style layer. They're complementary, not substitutes. |
| **Just tell Claude to be more disciplined.** | Tried it. Claude agrees, then drifts ten messages later. Bob installs as a first-party Claude Code skill with explicit pause-and-confirm gates the model can't quietly skip. |

---

## How often do I invoke Bob?

- **Install:** once per machine
- **Type `/bob`:** once at the start of each new project
- **After that:** every session auto-resumes — just say "let's continue"
- **Updates (optional):** type `update bob` to Claude whenever

---

## 3 most common things to try

### 1. Build something new from scratch — you have an idea, no code yet

```
/bob NEW
```

Or just `/bob` and pick **A) NEW** when Bob shows the menu. Bob will ask what you're building.

### 2. Audit something you've been "vibe coding" — clean up before going further

```
/bob AUDIT
```

Or `/bob` and pick **B) AUDIT**. Bob inventories what you've got, maps it to its 5-doc hierarchy, finds gaps, and proposes a remediation plan.

**As of v2.17, Bob's AUDIT phase is dramatically different from what you'd get with a generic code review tool.** Bob ships a **30-lens audit library** (`audit-lenses/`) — 30 ready-made audit prompts each attacking the product from a different angle, organized into 8 bands:

| Band | What it audits |
|---|---|
| 1. **Engineering Foundation** (L01-L06) | Code hygiene + liveness execution, spec fidelity, capability quality, security (STRIDE + OWASP T10:2025 + ASVS 5.0), data protection + privacy (GDPR Art.30), supply chain + configuration |
| 2. **User Experience** (L07-L10) | Cognitive ease (Nielsen + Norman + Cognitive Walkthrough), friction + trust (Brignull dark patterns), wow + emotional peaks (Peak-End + JTBD), edge states + recovery |
| 3. **AI Behavior** (L11-L14) | Accuracy + calibration (TruLens, RAGAS, Phoenix, promptfoo, ECE), right-sizing + model fit, interaction safety (Microsoft HAX + Garak red-team + OWASP LLM Top 10), cost + latency efficiency |
| 4. **Performance Economics** (L15-L16) | Cost / speed drivers including the unique **tradeoff-inversion lens** — *where should we DELIBERATELY pay more or accept more latency for value?* |
| 5. **Reach & Distribution** (L17-L20) | Mobile / form factor (Lighthouse + touch targets), internationalization, accessibility (WCAG 2.2+), shareability / virality / discoverability (OpenGraph + viral mechanics) |
| 6. **Operational** (L21-L23) | Observability + incident readiness (SRE four golden signals), vendor + dependency risk (single-points-of-failure, sunset risk), documentation + onboardability (Diátaxis framework) |
| 7. **Strategic & Market** (L24-L28) | Competitive benchmarking, **pricing & monetization** (4 sub-streams: strategy, discoverability, mechanics, FTC Click-to-Cancel compliance), marketing + copy + website (AI-slop detection per Google HCU), **persona simulation** (adversarial reasoning as domain expert, competitor power-user, privacy-paranoid skeptic), **strategic edge & wedge sharpness** (the anti-convergence lens) |
| 8. **Growth & Adoption** (L29-L30) | Onboarding + activation (Sean Ellis + Reforge + Lenny benchmarks), retention + compounding loops (Hook model, growth loops, network effects, smile curves) |

**Why this is different from running CodeRabbit / Greptile / Snyk alone:**

- **Synthesized from 46+ sources, not one angle.** Bob surveyed 12 commercial AI code-review tools (CodeRabbit, Greptile, Bito, Qodo, Sourcery, DeepSource, Cursor Bugbot, Copilot, Diamond, CodeAnt, diffray, Kodus), 14 industry audit taxonomies (ISO 25010, OWASP T10:2025, ASVS, STRIDE, CWE25, NIST SSDF, WCAG 2.2, GDPR, Microsoft SDL, SonarQube, Snyk, GitLab Secure, CodeQL, OWASP LLM Top 10), 13 UX/product methods (Nielsen, Don Norman, Cognitive Walkthrough, JTBD, Friction Log, Peak-End, Microsoft HAX, Brignull dark patterns), and strategic frameworks (April Dunford positioning, Play Bigger, Linear/Karri Saarinen, 37signals, Patrick Hanlon, Madhavan Ramanujam pricing, Patrick Campbell value-metrics, Joanna Wiebe conversion copy, Nir Eyal Hooked, Reforge growth loops, Andrew Chen network effects).
- **Three lenses are Bob-distinctive.** L01 Liveness (executes code rather than reading), L02 Spec Fidelity (built-vs-planned census), L03 Critical Capability Quality (grades each capability A/B/C/D/F for whether it's solid or hollow). No surveyed tool generalizes any of these.
- **Bob picks the panel, not you.** Bob proposes a Curated panel of 6-10 lenses based on your project profile (greenfield consumer product? launched B2B SaaS? methodology product? pre-fundraise scrub? post-incident audit?). You confirm with one gate. The point: a non-engineer never has to invent or even pick lenses cold.
- **Audit memory.** Bob remembers what you ran last and offers four options on every AUDIT entry: **Same** (drift check) / **Complementary Curated** (broaden coverage) / **Full Enchilada** (all 30 — rocketship-launch scrub) / **Custom**.
- **L28 anti-convergence veto.** Most audits push products toward "best-practice average." Bob's L28 lens explicitly pushes back. It can mark earlier UX findings as "do not fix — that friction is your wedge" (Linear's keyboard-first onboarding, Superhuman's keyboard shortcuts, Vim's learning curve). The first audit library designed to NOT make every product converge to mediocrity.
- **Execution-first (v2.17.1).** Bob doesn't just read your code and reason. Bob *runs* it — drives Playwright through user journeys, executes Schemathesis against APIs, runs Garak red-teams on AI surfaces, programmatically tests signup-to-cancel flows, queries cost APIs, triggers edge states via DevTools. Execution evidence > reasoning inference. Every lens names what Claude should EXECUTE vs READ vs leave to genuine HUMAN walk.
- **Self-learning library (v2.18).** The audit library gets better every time it runs. After each audit, Bob auto-emits a **lens retro** — a critique of the *lenses themselves* ("L20 was noise for an SMS-only product; nothing caught the provider-429 retry storm"), distinct from the findings about your product. Retros accumulate; `scripts/lens-retro.sh` flags lenses that are consistently low-signal or mis-targeted; a human then decides which lenses to sharpen. Bob never auto-edits its own lenses — convergence across retros is *signal, not a verdict*. The audit instrument improves under human judgment, not on autopilot.

See `audit-lenses/README.md` in the repo for the full library + provenance.

### 3. Add a feature to an existing project — extend what's already working

```
/bob EVOLVE
```

Or `/bob` and pick **C) EVOLVE**. Bob classifies the change (Small / Medium / Large) and runs the right level of discipline for it.

---

## What happens when you type `/bob`

1. **Bob senses the project silently.** Does a Bob manifest exist? Is the git tree clean? What kind of project is this? (No questions asked — it just looks.)
2. **Bob shows one short summary** — what it sees, a tentative complexity classification, and any housekeeping flags (e.g., uncommitted work).
3. **Bob asks one question: which mode?** (NEW / AUDIT / EVOLVE.) That's the only thing you decide at startup.
4. **You pick.** Bob takes it from there — gathering what it needs, narrating as it goes.

Narrator Mode is on by default — Bob explains each step in plain language and summarizes after every completion. Say **"terse mode"** any time if you'd rather it be quieter.

---

## Manual install (fallback)

If the paste-into-Claude install in Step 1 didn't work, you can install Bob by hand. Open Terminal and paste:

```bash
mkdir -p ~/tools && cd ~/tools && { [ -d bob-the-builder ] || git clone https://github.com/josephyeewang/bob-the-builder.git; } && mkdir -p ~/.claude/skills && ln -sfn ~/tools/bob-the-builder/skill ~/.claude/skills/bob
```

*What that does:* registers Bob as a Claude Code skill on your machine. Safe to re-run — it skips the clone if Bob is already installed, and updates the symlink in place.

*Verify:* open Claude Code in any folder and type `/bob`. If Claude says it doesn't know that skill, run `bash ~/tools/bob-the-builder/scripts/bob-doctor.sh` for a plain-English diagnosis.

**Windows users:** Bob assumes macOS or Linux. On Windows, run the install above inside [WSL](https://learn.microsoft.com/windows/wsl/install), then use Claude Code from inside WSL. Native Windows + PowerShell is not supported.

**Update Bob later:** in any Claude Code session, type `update bob` and Claude will pull the latest version. If Bob's install has local changes or has diverged from the canonical repo, the update refuses to pull and tells you — no silent failures.

---

## What Bob doesn't do

- **Doesn't replace product judgment** — you still need to know your customer and market
- **Stops at "ready to ship"** — no post-launch monitoring, support, or roadmap
- **Doesn't do design** — pushes you to think about UX but doesn't draw screens
- **Opinionated about scope** — not for hardware, multi-team coordination, or one-off throwaways
