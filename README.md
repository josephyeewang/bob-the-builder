# Bob the Builder

**A skill that guides you step-by-step to build real products in Claude Code. Made for non-engineers.**

---

## What is this

- A Claude Code skill — type `/bob` and it guides you in Claude to build real products properly
- Forces Claude through a clear sequence: spec → design → build → audit
- Install once → type `/bob` in any project
- Made by a non-technical product person who just wanted it to work — plain language, no jargon, no bloat

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
- **Pre-Ship Security Review** — five separate audits before you call it done
- **Living Decision Log** — every non-obvious choice recorded with the why
- **3 Modes** — NEW (build) / AUDIT (assess) / EVOLVE (extend)

---

## Why this beats just asking Claude directly

**When you one-shot prompt Claude, you spend 100x hours fixing bugs after. Bob builds it properly upfront.**

| Without Bob | With Bob |
| --- | --- |
| Claude guesses what to build | Spec gets locked in **before** any code happens |
| Claude forgets things between sessions | A `build-manifest.md` tracks where you are |
| You ask for feature A, get features A through G | Explicit "in scope / out of scope" at every phase |
| Tests pass, then it breaks in production | Five separate security and integrity audits before ship |
| You can't tell when something is "done enough" | Quality bar templates show good vs weak examples |
| Claude assumes things you didn't approve | Pauses for your sign-off at every important step |
| AI behavior drifts as you add features | Eval set re-runs at every phase; drift is a stop sign |

---

## "But couldn't I just…"

| Alternative | The honest answer |
| --- | --- |
| **Just write a better prompt.** | A prompt is a paragraph. Bob is a 2,600-line versioned protocol baked from real shipped products and lessons learned the hard way. |
| **Use Cursor / Windsurf rules.** | Those govern code style — semicolons, formatting, framework idioms. Bob governs *what* to build: spec, behavior, scope, success metrics, decision log. It's the product-thinking layer, not the code-style layer. They're complementary, not substitutes. |
| **Just tell Claude to be more disciplined.** | Tried it. Claude agrees, then drifts ten messages later. Bob installs as a first-party Claude Code skill with explicit pause-and-confirm gates the model can't quietly skip. |

---

## How to use it

### Step 0: Install Claude Code

Free at [claude.com/claude-code](https://claude.com/claude-code). Bob runs inside it.

### Step 1: One-time setup

Open Terminal and paste:

```bash
mkdir -p ~/tools && cd ~/tools && git clone https://github.com/josephyeewang/bob-the-builder.git && mkdir -p ~/.claude/skills && ln -s ~/tools/bob-the-builder/skill ~/.claude/skills/bob
```

*What that did:* registered Bob as a Claude Code skill on your machine.
*Verify:* open Claude Code in any folder, type `/help`, look for `bob` in the skill list.

### Step 2: Use it

Open Claude Code in any project folder and type:

```
/bob
```

Bob shows the mode menu (NEW / AUDIT / EVOLVE) and walks you from there.

### Step 3: Update Bob later

In any Claude Code session, just type:

```
update bob
```

Claude will pull the latest version. That's it.

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

## Fallback — no install needed

If you can't run Step 1 above, paste this into Claude Code in your project folder:

```
Clone https://github.com/josephyeewang/bob-the-builder to ~/tools/bob-the-builder, then read its build-protocol.md and start. I want to: [build / audit / add a feature]. [One sentence on what.]
```

---

## What Bob doesn't do

- **Doesn't replace product judgment** — you still need to know your customer and market
- **Stops at "ready to ship"** — no post-launch monitoring, support, or roadmap
- **Doesn't do design** — pushes you to think about UX but doesn't draw screens
- **Opinionated about scope** — not for hardware, multi-team coordination, or one-off throwaways

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
