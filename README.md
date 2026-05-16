# Bob the Builder

**Stop Claude from going off the rails when you try to build a real product with it.**

*(Specifically, [Claude Code](https://claude.com/claude-code) — Anthropic's coding assistant that runs in your terminal. Like ChatGPT, but it can read your files, write code, and run commands. Bob plugs into it.)*

---

## What is this

- A Claude Code **skill** — a structured guide Claude loads when you type `/bob` — that turns it into a disciplined product-build collaborator
- Forces Claude through a clear sequence: spec → design → build → audit
- Install once → type `/bob` in any project (or use the no-install paste-this fallback below)
- **Made by a non-technical product person who just wanted it to work** — plain language, no jargon, no bloat

---

## Who this is for

**You'll get value from Bob if:**
- You have ideas for products but you're **not an engineer**
- You use Claude Code (or want to) but you've watched it go in circles
- You'd rather have a structured conversation than try to "be a better prompter"
- You want to **ship things**, not just play with prototypes

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

**Claude gets you live fast — then you spend 100x hours fixing bugs after. Bob builds it properly upfront, so you don't have to.**

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

The three things people ask when they hear about Bob:

| Alternative | The honest answer |
| --- | --- |
| **Just write a better prompt.** | A prompt is a paragraph. Bob is a 2,400-line versioned protocol baked from real shipped products and lessons learned the hard way. By the time your "better prompt" has every guardrail Bob has, you've reinvented Bob — minus the field-testing. |
| **Use Cursor / Windsurf rules.** | Those govern code style — semicolons, formatting, framework idioms. Bob governs *what* to build: spec, behavior, scope, success metrics, decision log. It's the product-thinking layer, not the code-style layer. They're complementary, not substitutes. |
| **Just tell Claude to be more disciplined.** | Tried it. Claude agrees, then drifts ten messages later. Bob installs as a first-party Claude Code skill with explicit pause-and-confirm gates the model can't quietly skip. Not a polite suggestion — a contract Claude follows. |

---

## How to use it — the fast path (`/bob` from anywhere)

**Prerequisite: install Claude Code first.** Get it at [claude.com/claude-code](https://claude.com/claude-code). It's free to install. (If you've used Claude in your browser before, the CLI is the same model, just running in your terminal where it can actually edit files.)

**One-time setup.** Open Terminal and paste:

```bash
mkdir -p ~/tools && cd ~/tools && git clone https://github.com/josephyeewang/bob-the-builder.git && mkdir -p ~/.claude/skills && ln -s ~/tools/bob-the-builder/skill ~/.claude/skills/bob
```

**What that did:** Cloned Bob to `~/tools/bob-the-builder/` and registered it as a Claude Code skill called `bob`. Now `/bob` works in every project on this machine.

**Verify it worked.** Open Claude Code in any folder. Type `/help` (or check the skill list shown at session start) — you should see `bob` listed as an available skill. If yes, you're done. If not, see "If something errored" below.

**If something errored.** The most common issues, with the fix you can paste back into Terminal:

- *"`directory '/Users/.../bob-the-builder' already exists`"* — you've already cloned it before. To update instead: `cd ~/tools/bob-the-builder && git pull`
- *"`File exists`" on the symlink line* — an old `bob` skill is already registered. Refresh it: `rm ~/.claude/skills/bob && ln -s ~/tools/bob-the-builder/skill ~/.claude/skills/bob`
- *Anything else* — paste the error into Claude Code itself: "I ran the Bob install one-liner and got this error: [paste]. Can you fix it?" Claude will debug shell errors directly.

**Use it.** Open Claude Code in any project folder and type:

```
/bob
```

Claude will show the mode menu (NEW / AUDIT / EVOLVE) and walk you from there. You can also say it in plain language — "use bob the builder to start a new project" — and Claude will trigger the skill.

**Updating Bob later:**

```bash
cd ~/tools/bob-the-builder && git pull
```

No need to re-symlink — the skill is a live pointer to the repo.

---

## How often do I have to invoke Bob?

Short answer: **install once per machine**, then **type `/bob` once per project**. After that, Claude auto-resumes every session — no command needed.

| What | How often |
|---|---|
| Run the one-liner above (clone + symlink) | Once per machine |
| Type `/bob` in a new project | Once at the start of that project — Bob takes it from there |
| Open Claude Code in an existing Bob project | Every session. Claude reads the project's `CLAUDE.md` automatically; the protocol is already loaded. Just say "let's continue." |
| `cd ~/tools/bob-the-builder && git pull` | Whenever you want updates. Optional. |

---

## 3 most common things to try

After the one-time install, in any project folder:

### Build something new from scratch

```
/bob NEW
```

Or just `/bob` and pick **A) NEW** when Bob shows the menu. Bob will ask what you're building.

**When to use:** you have an idea, no code yet.

### Audit something you've been building messily

```
/bob AUDIT
```

Or `/bob` and pick **B) AUDIT**. Bob inventories what you've got, maps it to its 5-doc hierarchy, finds gaps, and proposes a remediation plan.

**When to use:** you've been "vibe coding" and want to clean up before going further.

### Add a feature to an existing project

```
/bob EVOLVE
```

Or `/bob` and pick **C) EVOLVE**. Bob classifies the change (Small / Medium / Large) and runs the right level of discipline for it.

**When to use:** you have something working and want to extend it.

---

## What happens when you type `/bob`

So you don't fly blind, here's the exact startup:

1. **Bob senses the project silently.** Does a Bob manifest exist? Is the git tree clean? What kind of project is this? (No questions asked — it just looks.)
2. **Bob shows one short summary** — what it sees, a tentative complexity classification, and any housekeeping flags (e.g., uncommitted work).
3. **Bob asks one question: which mode?** (NEW / AUDIT / EVOLVE.) That's the only thing you decide at startup.
4. **You pick.** Bob takes it from there — gathering what it needs, narrating as it goes.

Narrator Mode is on by default — Bob explains each step in plain language and summarizes after every completion. Say **"terse mode"** any time if you'd rather it be quieter.

---

## Fallback — no install needed

If you can't install the skill (work machine you don't control, want to try before committing), open Claude Code in your project folder and paste this:

```
Read ~/tools/bob-the-builder/build-protocol.md and start.

If the repo isn't on this machine, first clone it:
git clone https://github.com/josephyeewang/bob-the-builder.git ~/tools/bob-the-builder

I want to: [build a new product / audit an existing one / add a feature]. [One sentence on what.]
```

Bob will load the protocol, do the silent project sense, and ask you to pick a mode — same as the `/bob` flow, just without the slash command.

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
skill/SKILL.md         ← Claude Code skill manifest (what makes /bob work)
templates/             ← Reusable templates (eval sets, phase reports, etc.)
scripts/               ← bob-init.sh scaffold + repo-map.sh
LICENSE                ← MIT
```

You don't need to read these — Claude does.

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
