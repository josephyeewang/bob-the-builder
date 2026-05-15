# Bob the Builder

**A spec-driven build protocol for Claude Code, designed for non-engineer product leaders.**

Bob is a markdown framework that Claude Code reads and follows. It turns "I have an idea" into "I shipped a working product" by forcing structured spec, build, and audit phases — with explicit human checkpoints at every step.

You don't install Bob. You clone this repo, tell Claude Code to read the protocol, and Bob walks you through the rest.

---

## What it does

For a first-time user, a typical session opens like this:

```
Read ~/tools/bob-the-builder/build-protocol.md and help me build a new product.
```

Claude then:

1. Shows you the **Journey Map** — the full path from idea to shipped product
2. Confirms which mode you want (NEW / AUDIT / EVOLVE)
3. Walks you through the protocol step-by-step in **Narrator Mode** — explaining what each step does, what "good" looks like, and why it matters
4. Pauses at every Human Gate so you can approve, revise, reject, or defer
5. Updates a `docs/build-manifest.md` so you can resume across sessions and machines

By the end, you have:
- A complete spec hierarchy (Product Spec, Behavioral Core if AI, Architecture, Domain Specs, Build Manifest)
- A built, tested, hardened product with explicit traceability from every capability to the code that implements it
- A decision log explaining why each non-obvious choice was made

---

## Who this is for

- **Solo or very small teams** using Claude Code as primary engineer
- **Non-engineer product leaders** (PMs, ops leaders, founders) who can scope but rely on AI for implementation
- **AI-heavy products** where behavior drift is a risk and you need an eval harness
- **Multi-subsystem products** where integration seams cause silent production bugs
- **Anyone burned by:** silent scope creep, specs that went stale during build, "we forgot to build feature X" at launch, or debugging chains of 5-6 commits that should have been one

## Who this is NOT for

Bob is opinionated about scope. It will not help much with:

- Multi-developer teams (built for solo/small operators; no PM/eng/design role splits)
- Hardware products
- Pure research with no ship deadline
- Disposable prototypes (overhead exceeds value — skip Bob)
- Heavily regulated domains needing day-one SOC2/HIPAA depth (handled lightly, not deeply)

Bob also **stops at "ship-ready," not "operating in production."** It defines an observability plan but doesn't run your incident response. It sets cost guardrails but doesn't do ongoing FinOps. Pair it with a separate ops playbook if you need that.

---

## The three modes

| Mode | Use when | Roughly how long |
|---|---|---|
| **NEW** | Building from scratch | 4-12 sessions over 1-4 weeks |
| **AUDIT** | You inherited a half-built product and want to formalize | 1-3 sessions |
| **EVOLVE** | You have a working product and want to add/change features | 1 session (small) to 1+ week (large) |

---

## What makes it different

A few things you won't find in most build playbooks:

- **Narrator Mode** — guides non-engineer users through every step with plain-English previews, quality-bar rubrics ("what does done look like?"), and value narration ("why this matters")
- **Capability Traceability Matrix** — every capability in your Product Spec maps to a specific build phase. No more "we forgot to build feature X" at launch
- **AI eval harness** — for AI products, a golden eval set re-runs at every phase gate. Pass-rate drop is a stop condition
- **Machine-readable contracts** — subsystem boundaries enforced by the compiler, not by Claude reading two docs and comparing
- **Fresh-session hardening** — five separate audit sessions (security, abuse, integration seams, data integrity, spec-code) with clean context. Writer ≠ reviewer
- **Project Profiles** — 15 archetypes (RAG, Agent, Marketplace, Mobile, etc.) with additive addenda so the protocol tailors itself to your product type
- **Light / Standard / Heavy tracks** — Bob scales with project complexity instead of forcing one-size-fits-all

---

## Quickstart

**Step 1 — Clone the repo (one time):**

```bash
mkdir -p ~/tools && cd ~/tools && git clone https://github.com/josephyeewang/bob-the-builder.git
```

This puts the protocol at `~/tools/bob-the-builder/`. It lives separately from any actual product you build.

**Step 2 — Use Bob on a project:**

Open Claude Code in your project folder. Paste:

```
Read ~/tools/bob-the-builder/build-protocol.md and help me build a new product. Narrator Mode on.
```

Claude takes it from there.

**Step 3 — Get updates whenever:**

```bash
cd ~/tools/bob-the-builder && git pull
```

Pulls any improvements pushed since you last cloned. Run it whenever you want, or only when there's a notable release.

---

## The journey

```
Step 0:    Intake               (if you have existing materials)
Step 0.5:  Project Profile      (RAG? Agent? Marketplace? Mobile?)
Step 1:    Product Spec         WHAT it does
Step 2:    Behavioral Core      HOW the AI thinks (if AI product)
Step 3:    Architecture         HOW it's built
Step 4:    Domain Specs         DETAILS per subsystem
Step 5:    Build Manifest       PLAN of phases
Step 6:    Project Setup        Repo, hooks, environment
Step 7+:   Build Phases         Actual building, one phase at a time
Step N+1:  Hardening            Security/abuse/integrity audits
Step N+2:  Learning             What worked, what to improve
```

Every step has Human Gates where Claude pauses for your approval. You can stop, redirect, or defer at any time.

---

## File map

```
README.md                  ← You are here
build-protocol.md          ← Full reference (all sections, templates, appendices)
build-protocol-core.md     ← Compact reference (~200 lines) for daily session context
CLAUDE.md                  ← Project-level instructions for Claude Code
templates/                 ← Extractable templates
  ├── phase-report.md
  ├── behavioral-core.md
  ├── eval-set.md
  ├── decision-log-entry.md
  └── cowork-session.md
```

For day-to-day use, `build-protocol-core.md` is enough context. Load `build-protocol.md` when you need templates, the Architecture Patterns Library (G1-G18), the Project Profiles index (Appendix K), or the Glossary (Appendix J).

---

## Versioning

Bob is versioned in `build-protocol.md` and the changelog (Appendix I). Latest version is at the top of that file.

The protocol is intentionally living — when projects reveal a process gap, Bob gets updated. Major versions reflect structural changes; minor versions add capabilities.

To upgrade: `git pull` in your local clone.

---

## A few principles

If you read the protocol, you'll see these everywhere:

- **Specs are living documents.** Reconcile after every phase. Propagate changes downstream.
- **No silent refactoring.** Every change is named, explained, and approved.
- **Class-level fixes.** Bug in one place → grep for the same pattern everywhere; fix all instances.
- **Trust the gates.** Human Gates feel like friction. They're how the protocol works.
- **Scope lock.** The Acceptance Gate has both *exit criteria* (what must be true) and *scope boundary* (what must NOT have been built). Both matter.
- **Three strikes.** Same fix fails three times → STOP. The bug is not where you think it is.

---

## Credits

Built by [Joe Wang](https://github.com/josephyeewang) — former McKinsey, Fifth Wall, Clari — pairing with Claude Code for shipping side projects without losing the discipline that bigger orgs spend years acquiring.

Derived from lessons across multiple personal projects: an AI-driven blood-test interpretation tool, a personal task-management app with SMS+AI workflows, a tax auction analysis tool, and a strategy-research framework. The protocol learned from each one's failure modes and made them harder to repeat.

---

## License

[MIT](LICENSE) — use it, fork it, adapt it. If it helps you ship something, that's enough.
