# Bob the Builder

**Stop Claude from going off the rails when you try to build a real product with it.**

---

## What is this

- A Claude Code **skill** — type `/bob` and it walks Claude through building real products properly
- Forces Claude through a clear sequence: spec → design → build → audit
- Install once → type `/bob` in any project
- **Made by a non-technical product person who just wanted it to work** — plain language, no jargon, no bloat

---

## Who this is for

**You'll get value from Bob if:**
- You're **not an engineer** but you want to **ship real products**, not just play with prototypes
- You use Claude Code (or want to) but you've watched it go in circles
- You'd rather have a structured conversation than try to "be a better prompter"

---

## What it does for you

- **Bulletproof Product Spec** — structures what you're building, who it's for, and what's explicitly out of scope
- **AI Behavior Guardrails** — for AI products, locks down how your AI thinks before any code is written
- **Phased Build Plan** — maps exactly what to build when, with sign-off gates at every step
- **Drift Prevention** — Bob catches Claude when it starts wandering off-spec
- **Class-Level Fixes** — bug in one place? Bob audits every similar pattern, not just the symptom
- **Pre-Ship Security Review** — five separate audits before you call it done
- **Living Decision Log** — every non-obvious choice recorded with the why
- **3 Modes for Any Stage** — NEW (build from scratch) / AUDIT (assess what you have) / EVOLVE (extend what's working)

---

## Why this beats just asking Claude directly

**When you one-shot prompt Claude, you spend 100x hours fixing bugs after. Bob builds it properly upfront.**

| Without Bob | With Bob |
| --- | --- |
| Claude builds, you discover halfway through it's the wrong thing | Spec gets locked in **before** any code happens |
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
| **Just write a better prompt.** | A prompt is a paragraph. Bob is a 2,400-line versioned protocol baked from real shipped products and lessons learned the hard way. |
| **Use Cursor / Windsurf rules.** | Those govern code style — semicolons, formatting, framework idioms. Bob governs *what* to build: spec, behavior, scope, success metrics, decision log. It's the product-thinking layer, not the code-style layer. They're complementary, not substitutes. |
| **Just tell Claude to be more disciplined.** | Tried it. Claude agrees, then drifts ten messages later. Bob installs as a first-party Claude Code skill with explicit pause-and-confirm gates the model can't quietly skip. |

---

## How to use it — the fast path (`/bob` from anywhere)

**Prerequisite: install Claude Code first.** Free at [claude.com/claude-code](https://claude.com/claude-code).

**One-time setup.** Open Terminal and paste:

```bash
mkdir -p ~/tools && cd ~/tools && git clone https://github.com/josephyeewang/bob-the-builder.git && mkdir -p ~/.claude/skills && ln -s ~/tools/bob-the-builder/skill ~/.claude/skills/bob
```

**What that did:** registered Bob as a Claude Code skill. `/bob` now works in any project on this machine.

**Verify it worked.** Open Claude Code in any folder, type `/help`, and look for `bob` in the skill list.

**Use it.** Open Claude Code in any project folder and type:

```
/bob
```

Claude will show the mode menu (NEW / AUDIT / EVOLVE) and walk you from there.

**Updating Bob later:**

```bash
cd ~/tools/bob-the-builder && git pull
```

That's it — the skill picks up the update automatically.

---

## How often do I invoke Bob?

- **Install:** once per machine
- **Type `/bob`:** once at the start of each new project
- **After that:** every session auto-resumes — just say "let's continue"
- **Updates (optional):** `cd ~/tools/bob-the-builder && git pull` whenever

---

## 3 most common things to try

### 1. Build something new from scratch

```
/bob NEW
```

Or just `/bob` and pick **A) NEW** when Bob shows the menu. Bob will ask what you're building.

**When to use:** you have an idea, no code yet.

### 2. Audit something you've been building messily

```
/bob AUDIT
```

Or `/bob` and pick **B) AUDIT**. Bob inventories what you've got, maps it to its 5-doc hierarchy, finds gaps, and proposes a remediation plan.

**When to use:** you've been "vibe coding" and want to clean up before going further.

### 3. Add a feature to an existing project

```
/bob EVOLVE
```

Or `/bob` and pick **C) EVOLVE**. Bob classifies the change (Small / Medium / Large) and runs the right level of discipline for it.

**When to use:** you have something working and want to extend it.

---

## What happens when you type `/bob`

1. **Bob senses the project silently.** Does a Bob manifest exist? Is the git tree clean? What kind of project is this? (No questions asked — it just looks.)
2. **Bob shows one short summary** — what it sees, a tentative complexity classification, and any housekeeping flags (e.g., uncommitted work).
3. **Bob asks one question: which mode?** (NEW / AUDIT / EVOLVE.) That's the only thing you decide at startup.
4. **You pick.** Bob takes it from there — gathering what it needs, narrating as it goes.

Narrator Mode is on by default — Bob explains each step in plain language and summarizes after every completion. Say **"terse mode"** any time if you'd rather it be quieter.

---

## Fallback — no install needed

If you can't install the skill, paste this into Claude Code in your project folder:

```
Read ~/tools/bob-the-builder/build-protocol.md and start. Clone from https://github.com/josephyeewang/bob-the-builder if missing. I want to: [build / audit / add a feature]. [One sentence.]
```

---

## What Bob doesn't do

- **Doesn't replace product judgment** — you still need to know your customer and market
- **Stops at "ready to ship"** — no post-launch monitoring, support, or roadmap
- **Doesn't do design** — pushes you to think about UX but doesn't draw screens
- **Opinionated about scope** — not for hardware, multi-team coordination, or one-off throwaways

---

## Creator

**[Joe Wang](https://joe.wang)** — former McKinsey consultant, Fifth Wall venture capitalist, Clari SaaS exec. Not an engineer. Just wanted something that worked.

**Bob's lessons came from:**
- AI blood-test interpreter — 931 commits taught me what "no spec" feels like
- Personal task-management app with SMS+AI — taught me what "spec drift" feels like
- Tax auction analysis tool — proved good specs enable 3-day builds
- Strategy-research framework — proved Behavioral Cores are reusable

If Bob helps you ship something, that's the whole point.

---

*Why "Bob the Builder"? Because every time I'd ask Claude to build something real, I'd wonder — "can he build it?" Now, finally, the answer is: yes he can.* 🔨

---

## License

[MIT](LICENSE) — use it, fork it, adapt it, share it.
