---
id: L38
name: Agent Setup & Extension Surface
band: 1
band_name: Engineering Foundation
when_to_run: Always for any product that loads third-party agent extensions (skills, plugins, MCP servers, sub-agents) or that IS agent tooling. Also run periodically against the BUILDER'S OWN machine — this is the only lens whose target can be the workstation rather than the product.
estimated_duration: 30-75 min (machine scan ~10 min; the judgment pass is the rest)
session_pattern: fresh session; reads `_evidence-accounting.md` first; reads L04 and L06 reports if available
output_markdown: audit-artifacts/L38-agent-setup-extension-surface-{YYYY-MM-DD}.md
output_json: audit-artifacts/L38-agent-setup-extension-surface-{YYYY-MM-DD}.json
source_frameworks:
  - Snyk Agent Scan — https://github.com/snyk/agent-scan (Apache-2.0, 3,074★ as of 2026-09-20)
  - Snyk "Emerging threats of the agent skill ecosystem" technical report — shipped in that repo at .github/reports/skills-report.pdf
  - OWASP Top 10 for LLM Applications — https://owasp.org/www-project-top-10-for-large-language-model-applications/
  - Cloudflare security-audit skill, AI-AND-LLM companion — https://github.com/cloudflare/security-audit-skill (MIT)
---

# L38 — Agent Setup & Extension Surface

## Question this lens answers

*What third-party instructions and tools are loaded into the agent — on this machine, or in this product — and which of them can take an action, reach data, or shape a decision that nobody deliberately granted?*

## Why this lens exists / what other lenses miss

Every other lens in this library audits **the thing being built**. This one audits **the thing doing the building**, and the extension surface of any agent product built with it.

The gap is concrete and current. Bob is a multi-agent system. Joe runs Claude Code with a large, actively-growing set of third-party extensions: installed skills, marketplace plugins, MCP servers, per-project `.claude/` configs, hooks, and a `settings.json` synced across machines. **Every one of those is instructions or executable capability, authored elsewhere, loaded into a session that holds live credentials and writes to live products.** L04 audits the product's attack surface. L06 audits the dependency tree. Neither has ever looked at the agent's own extensions — and the standing `/verdict` habit of harvesting promising repos means that surface grows every month by design.

The threat is not hypothetical. The whole category is text files that an agent treats as instructions:
- a skill file that says something the reader never intended to authorize;
- two plugin servers offering a tool of the same name, where the wrong one answers;
- a tool description that quietly instructs the model to send data somewhere;
- credentials read into a context that then writes to a shared file;
- an extension that was fine on install and changed three versions later.

The one-line framing: **an installed skill is code you did not review, running with your authority, in a session holding your keys.**

## When this lens fires

- ✅ **Always** — for products that load third-party agent extensions, or that *are* agent tooling (skills, plugins, MCP servers).
- ✅ **Always** — before publishing any Bob-built skill/plugin others will install. You are the supply chain in that direction.
- ✅ **Periodic, against the builder's own machine** — quarterly, and after any batch of new installs (e.g. a `/verdict` harvest round).
- ✅ **Mandatory** — before granting any agent setup access to client work (🔴 zone) or to production credentials.
- ⏸ Skip — products with no agent surface and no third-party extensions.

## Session setup

- Start a **fresh Claude Code session.**
- **Read `audit-lenses/_evidence-accounting.md` first.** §7 (the fail-closed contract for executing untrusted code) is directly load-bearing here — see the warning below.
- Read prior L04 and L06 reports if they exist.
- Decide and record the **target**: the product's extension surface, the builder's machine, or both. They produce different reports.

### Tooling — and a real warning before you run it

**Snyk Agent Scan** (`snyk/agent-scan`) is the incumbent for the machine scan. Per D-003, orchestrate it; do not build a scanner.

```bash
# Prerequisites: `uv` installed (brew install uv), and a free Snyk account.
# Token: https://app.snyk.io/account  → API Token → KEY
export SNYK_TOKEN=<token>

uvx snyk-agent-scan@latest ~/.claude/skills   # scan skills only — SAFE, no execution
uvx snyk-agent-scan@latest ~/path/to/SKILL.md # scan one skill
uvx snyk-agent-scan@latest                    # whole machine — READ THE WARNING FIRST
```

> **⚠️ Scanning MCP configurations EXECUTES the commands inside them.** The tool starts each stdio MCP server to read its tool descriptions. That is the only way to inspect them, and it is also exactly the behavior a malicious config would want. Their own guidance: run untrusted configs inside a container or disposable VM; read the per-server consent prompt (interactive runs ask y/n per server); and **never pass `--dangerously-run-mcp-servers`** outside a setup you have already verified.
>
> **Bob's rule:** start with `~/.claude/skills` (static analysis of text — no execution, no risk). Escalate to the whole-machine scan only in a sandbox, or after reading each MCP config by hand. This is `_evidence-accounting.md` §7 applied to the audit's own tooling: if the controls cannot be enforced, do not execute — record it as "needs checking" instead.

**Two caveats that affect how the results are used:**
1. **It requires a Snyk account and sends component metadata to their service.** That is a privacy-zone decision, not a neutral install. Do not point it at 🔴 client-work configs without a deliberate call.
2. **Snyk states the CLI output format is experimental** — risk names, scores and field names may change between releases without notice. **Do not build a script that parses it.** Read the output as evidence; keep the judgment in this lens.

What it detects (15+ risk classes as of v0.6): for MCP servers — prompt injection, tool poisoning, tool shadowing, and toxic flows; for skills — prompt injection, malware payloads, untrusted content, credential handling, and hardcoded secrets. It auto-discovers configs for Claude Code/Desktop, Cursor, Copilot, Windsurf, Gemini CLI, Amp and Amazon Q.

## Audit method

1. **Inventory the extension surface.** Enumerate every loaded skill, plugin, marketplace source, MCP server, sub-agent definition, hook, and per-project `.claude/` override. For each, record: where it came from, who wrote it, when it was installed, when it last changed, its license, and whether anyone read it. This inventory is the coverage record for this lens — an extension absent from the list has not been cleared, it has been missed.

2. **Run the scanner** per the escalation order above. Treat its output as evidence for specific units, not as the audit.

3. **Read the highest-authority extensions by hand.** The scanner finds patterns; it does not understand intent. Hand-read anything that: runs shell commands, touches credentials or `.env` files, writes outside its own directory, makes network calls, or is loaded into *every* session. Concretely for this setup, that means the always-loaded skills and anything with `Bash(*)`.

4. **Trace authority, not just content.** For each extension, answer: what is the *most* it could do if its instructions were hostile? Which credentials are in the session it loads into? What can it write? Bob's own standing rule applies — *a guardrail sentence in a skill file is not a security boundary;* only the permission layer, the deny-list and the sandbox are.

5. **Check for name collisions and shadowing.** Two skills whose descriptions compete for the same trigger, or two MCP servers exposing the same tool name, mean the wrong one can answer. (Precedent: `doc-coauthoring` had its trigger deliberately narrowed so it could not steal Bob's "spec" trigger — that fix was correct and is the pattern.)

6. **Check the sync and update path.** An extension that is fine today can change under you. Where does each one update from? Is anything pinned? Does a synced `settings.json` mean a change on one machine silently lands on the others? **Is anything loading from a directory that another process can write?**

7. **Check the privacy-zone boundaries.** Does any extension cross 🟢 personal / 🔵 capability / 🔴 client-work? Does any phone home? Would running it inside a client repo send that client's content anywhere?

8. **If the product IS agent tooling, audit it as the supplier.** Everything above, pointed outward: what authority does your skill/plugin ask for, does it ask for more than it needs, does it handle credentials, and does its documentation tell an installer what it will do?

9. **Write the coverage statement** per `_evidence-accounting.md` §1 — including every extension that was inventoried but not examined, and why.

## Check questions

1. Is there a complete inventory of installed skills, plugins, MCP servers, sub-agents, hooks and per-project overrides?
2. For each: source, author, install date, last-changed date, license — and **has a human or an audit actually read it?**
3. Has Snyk Agent Scan run against `~/.claude/skills` (static, safe)? Any prompt-injection, credential-handling or hardcoded-secret hits?
4. If a whole-machine scan ran, was it sandboxed or consent-gated? Was `--dangerously-run-mcp-servers` avoided?
5. Which extensions can run shell commands, and what is the effective permission mode when they do?
6. Which extensions read credentials, `.env` files, or the keychain?
7. Which extensions make network calls, and to where?
8. Which extensions load into **every** session versus being invoked deliberately?
9. Are there trigger collisions between skills, or tool-name collisions between MCP servers?
10. Can any extension's instructions reach a sink the user did not intend — file write, commit, push, publish, send, purchase?
11. Is any extension loaded from a path that a sync process or another program can modify?
12. Does the update path pin versions, or does it silently take the latest?
13. Does any extension cross a privacy zone (🟢/🔵/🔴)?
14. Does any extension send data to a third-party service, and was that a deliberate decision?
15. For published Bob-built extensions: does the documentation state plainly what authority the installer is granting?
16. Is a guardrail *sentence* doing work that a permission *control* should be doing?
17. (Per `_evidence-accounting.md`) Does the report state which extensions were **not** examined?

## Output schema

### Markdown report

```markdown
# L38 — Agent Setup & Extension Surface — {YYYY-MM-DD}

## Target
{product extension surface | builder machine | both} · {machine name if applicable}

## Extension inventory
| Extension | Type | Source | Installed | Last changed | Read by a human? | Authority | Zone |
|---|---|---|---|---|---|---|---|

## Scanner results
{tool + version + exact command + what was scanned and what was deliberately NOT scanned}

## Findings (severity-tagged)

## Hardening (no reachable violation — kept separate from findings)

## Needs checking (no severity)

## Coverage statement
Inventoried: N · Examined: N · Deferred: N (with reasons) · Out of scope: N
```

### JSON sidecar

Standard lens sidecar (see README schema) plus:
- `extensions_inventoried`, `extensions_examined`, `extensions_deferred`
- `scanner_version`, `scanner_scope`, `execution_sandboxed` (bool)
- `zone_crossings` (array)

## Severity rubric (calibrated to this lens)

- **Critical** — An extension can execute arbitrary commands with the session's full authority and was never read; or a hardcoded credential sits in a loaded extension; or an extension exfiltrates content to a third party.
- **Major** — An extension reads credentials or writes outside its scope without that being documented or intended; a tool-name/trigger collision routes work to the wrong handler; an unpinned extension auto-updates into a credentialed session.
- **Minor** — An extension asks for broader permission than it needs but has no reachable abuse path; documentation doesn't state what authority is granted.
- **Cosmetic** — Inventory/housekeeping gaps with no authority implication.

## Anti-patterns / Bias instructions

- **Do NOT treat "the scanner found nothing" as coverage.** It reads patterns in text. It cannot tell you that a well-written skill asks for far more authority than its job needs.
- **Do NOT run the whole-machine scan casually.** It executes MCP server commands. Escalate deliberately.
- **Do NOT build a parser around the scanner's output** — Snyk explicitly says the format is experimental and will change.
- **Do NOT count a guardrail sentence as a control.** Only the permission layer, deny-list and sandbox are controls.
- **Do NOT flag every third-party extension as a finding.** The finding is *unreviewed authority*, not third-party origin. Name the specific capability and the specific reachable consequence.
- **Do NOT let the scan's own privacy cost go unstated.** It needs an account and sends component metadata; say so in the report, especially if pointed anywhere near 🔴.

## Stop conditions (the gap IS the finding)

1. **No inventory exists.** That is the first finding. Build it, and note that prior audits cleared a surface nobody had enumerated.
2. **`uv` or the Snyk token is unavailable.** Do the hand-read pass anyway; record the scanner gap as "needs checking" with the exact blocker.
3. **An MCP config cannot be safely inspected** (untrusted, and no sandbox available). Do not execute it. Record it as "needs checking" with the safe plan.

## Cross-lens handoff

- **Upstream:** L06 (Supply Chain & Configuration) — same instinct, different surface: L06 covers the product's dependencies, L38 covers the agent's extensions.
- **Downstream:** L04 (Security & Threat Surface) — its AI/agent attack classes (method step 9) apply to any agent capability this lens finds; L05 (Data Protection) for anything crossing a privacy zone.
- **Adjacent:** L13 (AI Interaction & Safety) — L13 audits how the *product's* AI behaves toward users; L38 audits what the *builder's* agent has been given.
