# Bob the Builder

**Stop Claude from going off the rails when you try to build a real product with it.**

Bob is a structured playbook that you hand to Claude Code. Instead of Claude making things up as it goes, it follows a clear sequence — figure out what you're building, design it carefully, then build it phase by phase with checkpoints where you actually look at the work.

You don't install anything. You point Claude at this repo. It does the rest.

---

## Who this is for

This is built for people like you if:

- You have ideas for products but you're not an engineer
- You use Claude Code (or want to) but you've watched it go in circles, build the wrong thing, or generate code you can't actually use
- You'd rather have a structured conversation than try to "be a better prompter"
- You want to ship things — not just play with prototypes that never see daylight

**Skip Bob if:** you have a team of engineers, you're building a quick throwaway, or you're doing pure research with no shipping deadline. Bob is opinionated about scope — it's for solo / very small builders who want discipline without overhead.

---

## What you actually get

After working through Bob with Claude, you walk away with:

- **A clear written spec** — what your product does, who it's for, what's in scope and what's not
- **A behavioral plan** (for AI products) — exactly how your AI should think and respond
- **A build plan** — a list of phases with checkpoints, so progress is visible
- **A working product** — built phase by phase, tested at each step
- **A security/abuse review** — Claude audits its own work before you ship
- **A decision log** — every non-obvious choice with the reason why

And just as important: **you get to make decisions at every step**, not get surprised at the end.

---

## Why this beats just asking Claude directly

Most people use Claude Code by saying "build me X" and then steering as they go. That works for small things. For real products it usually goes one of these directions:

| Without Bob | With Bob |
|---|---|
| Claude builds, you discover halfway through it's the wrong thing | Spec gets locked in before any code happens |
| Claude forgets things between sessions | A `build-manifest.md` tracks where you are |
| You ask for feature A, get features A through G that you didn't want | Explicit "what's in scope, what's out" at every phase |
| Tests pass, then it breaks in production | Five separate security/integrity audits before ship |
| You can't tell when something is "done enough" | Quality bar templates show you good vs weak examples |
| Claude assumes things you didn't approve | Pauses for your sign-off at every important step |
| AI behavior drifts as you add features | Eval set re-runs at every phase; drift is a stop sign |

The trade is upfront time. Bob is heavier than vibing. But "spec phase takes 2 days" beats "I've been debugging the same thing for a week."

---

## Get started in 3 steps

### Step 1 — Get the protocol onto your machine (one time, ~30 seconds)

Open **Terminal** (it's an app on your Mac — search Spotlight for "Terminal").

Paste this and press return:

```bash
mkdir -p ~/tools && cd ~/tools && git clone https://github.com/josephyeewang/bob-the-builder.git
```

**What that did:** Created a folder called `tools` in your home directory and downloaded Bob into it. The protocol now lives at `~/tools/bob-the-builder/`. You'll never touch this folder directly — Claude reads from it.

### Step 2 — Open Claude Code in the folder where your project will live

Make a new folder for your project (or use an existing one). Open Claude Code there.

If you don't have Claude Code yet, get it at [claude.com/claude-code](https://claude.com/claude-code).

### Step 3 — Tell Claude to use Bob

Paste this into Claude (replace the description with what you're trying to build):

```
Read ~/tools/bob-the-builder/build-protocol.md and help me build a new product.
Narrator Mode on — I've never used this before.

The product I want to build: [one or two sentences about your idea — don't
worry about being complete, Bob will walk you through the questions]
```

That's it. Claude will show you the map of where you're going, ask which mode fits, and then guide you through it. Pause and ask questions any time.

---

## Three things to try first

Once Bob is set up, here are the three most useful ways to invoke it:

### 1. Build something new from scratch

```
Read ~/tools/bob-the-builder/build-protocol.md and start MODE: NEW.
Narrator Mode on. I want to build: [your idea].
```

Use this when you have an idea and no code yet. Bob will run you through an interview, draft a spec, get your approval, and only then start writing code.

### 2. Add a feature to a project you've already started

```
Read ~/tools/bob-the-builder/build-protocol.md and start MODE: EVOLVE.
I want to add this feature to my existing project: [describe the change].
```

Use this when you have something working and want to add to it. Bob figures out how big the change is and applies the right amount of process — small changes don't need the full machinery.

### 3. Audit something you've been building messily

```
Read ~/tools/bob-the-builder/build-protocol.md and start MODE: AUDIT.
Help me figure out what state this project is actually in.
```

Use this when you've been "vibe coding" and want to clean up. Bob inventories what you have, finds gaps, and proposes a plan to get back on track.

---

## Pro tip — "Is Bob useful for what I want to build?"

If you're not sure whether Bob is right for your project, paste this into Claude (no setup needed — Claude can read GitHub URLs):

```
Please look at this repo: https://github.com/josephyeewang/bob-the-builder

I'm thinking about building: [describe your idea in 2-3 sentences].

Based on what Bob does, would it be useful for me? Be honest — if my idea is
too small or wrong-shaped for this framework, say so. If it would help, tell
me which mode (NEW / AUDIT / EVOLVE) and what to expect.
```

Claude will read the README, evaluate your idea against what Bob is good and bad at, and give you a straight answer. No commitment.

---

## What Bob doesn't do

Being honest so you don't get surprised:

- **It doesn't replace product judgment.** It asks the right questions; you still have to know your customer and your market.
- **It stops at "ready to ship."** It doesn't run your customer support, monitor production, or manage your roadmap after launch.
- **It doesn't do design.** It'll force you to think about user experience at key checkpoints, but no Figma flows, no UI kit.
- **It's opinionated.** It won't help much with hardware, multi-team coordination, or one-off prototypes you'll throw away.
- **It's not perfect.** It's a living protocol — updated as projects reveal new gaps. Run `cd ~/tools/bob-the-builder && git pull` whenever you want the latest.

---

## What's in the repo

You don't need to read these — Claude does — but if you're curious:

```
README.md              ← This file
build-protocol.md      ← The full reference Claude reads (~2400 lines)
build-protocol-core.md ← A compact version for daily sessions
CLAUDE.md              ← Project-level instructions
templates/             ← Reusable templates (eval sets, phase reports, etc.)
LICENSE                ← MIT (use it freely)
```

---

## Staying current

Bob is updated as new lessons emerge. To get the latest version any time:

```bash
cd ~/tools/bob-the-builder && git pull
```

**What that does:** Pulls any improvements that have been added since you last cloned. Safe to run anytime — it doesn't touch your projects.

---

## Credits

Built by [Joe Wang](https://github.com/josephyeewang) — former McKinsey, Fifth Wall, Clari — pairing with Claude Code to ship side projects without losing the discipline that bigger orgs spend years acquiring.

Bob is derived from lessons learned across multiple personal projects (an AI blood-test interpreter, a personal task-management app with SMS+AI workflows, a tax auction analysis tool, and a strategy-research framework). Each one's failure modes shaped the protocol. The goal: make those mistakes harder to repeat — for me and for anyone else who finds it useful.

If Bob helps you ship something, that's the whole point.

---

## License

[MIT](LICENSE) — use it, fork it, adapt it, share it.
