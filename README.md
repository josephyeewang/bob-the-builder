# Bob the Builder

**Stop Claude from going off the rails when you try to build a real product with it.**

---

## What is this

- A structured playbook you hand to Claude Code
- Instead of Claude making things up, it follows a clear sequence: figure out what you're building → design it → build phase by phase → audit before ship
- You don't install anything — you point Claude at this repo
- **Made by a non-technical product person who just wanted it to work.** Written in plain language. No engineering jargon. No bureaucratic bloat.

---

## Who this is for

**You'll get value from Bob if:**
- You have ideas for products but you're **not an engineer**
- You use Claude Code (or want to) but you've watched it go in circles
- You'd rather have a structured conversation than try to "be a better prompter"
- You want to **ship things**, not just play with prototypes

**Skip Bob if:**
- You have a team of engineers
- You're building a throwaway prototype
- You're doing pure research with no shipping deadline

---

## What it does

After working through Bob with Claude, you walk away with:

- **A clear written spec** — what your product does, who it's for, what's in scope
- **A behavioral plan** (for AI products) — how your AI thinks and responds
- **A build plan** — phases with checkpoints, so progress is visible
- **A working product** — built phase by phase, tested at each step
- **A security and abuse review** — before you ship
- **A decision log** — every non-obvious choice with the reason why
- **Decisions at every step** — not surprises at the end

---

## Why this beats just asking Claude directly

| Without Bob | With Bob |
| --- | --- |
| Claude builds, you discover halfway through it's the wrong thing | Spec gets locked in **before** any code happens |
| Claude forgets things between sessions | A `build-manifest.md` tracks where you are |
| You ask for feature A, get features A through G | Explicit "in scope / out of scope" at every phase |
| Tests pass, then it breaks in production | Five separate security and integrity audits before ship |
| You can't tell when something is "done enough" | Quality bar templates show good vs weak examples |
| Claude assumes things you didn't approve | Pauses for your sign-off at every important step |
| AI behavior drifts as you add features | Eval set re-runs at every phase; drift is a stop sign |

**Tradeoff:** Bob is heavier than vibing. The upfront spec phase takes time. But that's better than debugging the same thing for a week.

---

## How to use it

### Step 1 — Get the protocol on your machine (one time)

Open **Terminal** (search Spotlight on your Mac for "Terminal").

Paste and press return:

```bash
mkdir -p ~/tools && cd ~/tools && git clone https://github.com/josephyeewang/bob-the-builder.git
```

**What that did:** Created a `tools` folder in your home directory and downloaded Bob. The protocol now lives at `~/tools/bob-the-builder/`. You'll never touch this folder — Claude reads from it.

### Step 2 — Open Claude Code in your project folder

- Make a new folder for your project (or use an existing one)
- Open Claude Code in that folder
- Don't have Claude Code yet? Get it at [claude.com/claude-code](https://claude.com/claude-code)

### Step 3 — Tell Claude to use Bob

Paste this into Claude:

```
Read ~/tools/bob-the-builder/build-protocol.md and help me build a new product.
Narrator Mode on — I've never used this before.

The product I want to build: [one or two sentences about your idea]
```

Claude will show you the map, ask which mode fits, and guide you from there. Pause and ask questions anytime.

---

## 3 most common things to try

### Build something new from scratch

```
Read ~/tools/bob-the-builder/build-protocol.md and start MODE: NEW.
Narrator Mode on. I want to build: [your idea].
```

**When to use:** you have an idea, no code yet.

### Add a feature to an existing project

```
Read ~/tools/bob-the-builder/build-protocol.md and start MODE: EVOLVE.
I want to add this feature: [describe the change].
```

**When to use:** you have something working and want to extend it.

### Audit something you've been building messily

```
Read ~/tools/bob-the-builder/build-protocol.md and start MODE: AUDIT.
Help me figure out what state this project is actually in.
```

**When to use:** you've been "vibe coding" and want to clean up.

---

## Pro tip — "Is Bob useful for what I want to build?"

Not sure if Bob fits your project? **No setup needed** — paste this into Claude:

```
Please look at this repo: https://github.com/josephyeewang/bob-the-builder

I'm thinking about building: [describe your idea in 2-3 sentences].

Based on what Bob does, would it be useful for me? Be honest — if my idea is
too small or wrong-shaped for this framework, say so. If it would help, tell
me which mode (NEW / AUDIT / EVOLVE) and what to expect.
```

Claude will read the README, evaluate your idea, and give you a straight answer. No commitment.

---

## What Bob doesn't do

- **Doesn't replace product judgment** — Bob asks the right questions; you still need to know your customer and market
- **Stops at "ready to ship"** — no production monitoring, no customer support, no roadmap management after launch
- **Doesn't do design** — no Figma, no UI kit; pushes you to think about UX at checkpoints but doesn't draw screens
- **Opinionated about scope** — won't help much with hardware, multi-team coordination, or one-off throwaways
- **Not perfect** — it's a living protocol, updated as projects reveal new gaps

---

## What's in the repo

```
README.md              ← This file
build-protocol.md      ← Full reference Claude reads (~2400 lines)
build-protocol-core.md ← Compact version for daily sessions
CLAUDE.md              ← Project-level instructions
templates/             ← Reusable templates (eval sets, phase reports, etc.)
LICENSE                ← MIT
```

You don't need to read these — Claude does.

---

## Staying current

To get the latest version of Bob anytime:

```bash
cd ~/tools/bob-the-builder && git pull
```

**What that does:** Pulls any improvements added since you last cloned. Safe to run anytime — it doesn't touch your projects.

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

## License

[MIT](LICENSE) — use it, fork it, adapt it, share it.
