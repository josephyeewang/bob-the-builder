# PART III: MODE — AUDIT

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Assessing an existing, partially-built product and aligning it to this process.*

### When to Use
- You have a half-built product and want to understand its state
- You want to find gaps, inconsistencies, or risks
- You want to create missing process artifacts (specs, manifests) from existing code

### Step A1: Inventory

Claude reads (in parallel where possible):
- Complete file and directory structure
- CLAUDE.md (if exists)
- All docs/, specs/, README, or process files
- Git log (recent 50 commits — understand development arc)
- Memory files (if exist)
- Package/dependency files
- .env.example or .env (for understanding integrations)

Output: Structured inventory of what exists

### Step A2: Map to Hierarchy

Assess each document in the hierarchy:

| Document | Exists? | Quality (1-5) | Gaps |
|----------|---------|---------------|------|
| Product Spec | Y / N / Partial | | |
| Behavioral Core | Y / N / Partial / N/A | | |
| Architecture Contract | Y / N / Partial | | |
| Domain Specs | Y / N / Partial | | |
| Build Manifest | Y / N / Partial | | |
| Decision Log | Y / N | | |
| Tool Decisions | Y / N | | |
| CLAUDE.md | Y / N / Partial | | |

For partial docs: note what's covered and what's missing.
For missing docs: note whether the information exists scattered elsewhere (in code, comments, git history, memory).

`→ HG:` Present assessment

### Step A3: Code-Spec Consistency

- If specs exist: walk them against the code and flag divergences
- If specs don't exist: infer what the specs WOULD say from the code and present as a draft
- Identify:
  - Dead code (implemented but not in any spec or user path)
  - Missing features (in spec but not implemented)
  - Inconsistencies (spec says X, code does Y)
  - Over-built areas (code that's more complex than the product needs)
  - Under-built areas (simplistic implementation of something the spec defines as complex)

`→ HG:` Present findings

### Step A4: Risk Assessment

Evaluate across dimensions:
- **Security gaps:** Auth, input validation, secrets handling, permissions
- **Technical debt:** Code duplication, dead code, inconsistent patterns, massive files
- **Spec-code divergence severity:** How far apart are the docs and the code?
- **Test coverage:** What's tested, what's not, what's most risky to change
- **Provider lock-in:** Direct integrations without abstraction layers
- **Scalability concerns:** Obvious bottlenecks at 10x current scale

`→ HG:` Present risk report with severity ratings

### Step A5: Remediation Plan

Based on findings, propose:
1. **Missing docs to create** (prioritized: which docs give the most leverage?)
2. **Inconsistencies to resolve** (with severity and effort estimate)
3. **Code issues to fix** (critical vs nice-to-have)
4. **Process gaps to close** (what's missing from the workflow?)

Organize as a phased plan — don't propose fixing everything at once.

`→ HG:` Human prioritizes, approves remediation scope

### Step A6: Execute Remediation

Follow the approved plan. For each remediation item, use the Na/Nb/Nc pattern:
- **a:** Execute the fix or create the missing artifact
- **b:** Verify it's correct and consistent
- **c:** Reconcile with other docs that might be affected

### Step A7: Multi-Lens Audit (v2.17 — lens library replaces prior A7a–A7j)

After remediation, run the **multi-lens audit** — a curated panel (or full enchilada) of named audit lenses from `audit-lenses/`, run sequentially in fresh sessions per the writer/reviewer pattern. v2.17 replaced the prior single A7a–A7j audit phase with a multi-lens library organized into 8 bands; it has since grown (the current count is in `audit-lenses/README.md`) (L31–L34 in v2.21–v2.22, L35–L36 later, **L37 the perpetual data-fidelity crawler in v2.32**), with Bob selecting the panel based on project profile and the user confirming with one gate.

This is the second meaning of "audit" in Bob: A1–A6 is the **macro** audit (does the project match the 5-doc hierarchy?); A7 is the **micro** audit, multi-angle.

**Design principle:** Single audits are 90% effective and miss the rest. Different lenses catch *qualitatively different* finding categories — engineering-hygiene catches code issues, UX catches journey issues, strategic catches positioning drift. Running multiple lenses with intentional ~15% overlap converts overlap into *confirmation signal* rather than noise.

**Design principle: audits aren't all-or-nothing AND aren't one-shot.** A half-built product still has built subsystems that benefit from selective auditing now. v2.17's lens library + Curated panel mechanism replaces the prior "scope map of A7a–A7j" pattern with a richer "which 6-10 lenses fit this project's profile right now" decision.

---

**A7.0: Entry — Audit Memory + Panel Selection (always runs first)**

Before any lens fires, Bob reads `audit-artifacts/audit-history.json` and presents the history-aware entry experience defined in `audit-lenses/_audit-memory.md`:

1. **Audit history surfaced** — last audit date, mode (Curated / Full / Custom), lenses run, findings count by severity, open findings still in `audit-log.md`.
2. **Panel proposal** — Bob proposes a Curated panel (6-10 lenses) based on project profile, per `audit-lenses/_selection-rubric.md`. Each included lens gets a one-line justification; the most relevant excluded lenses get a one-line skip reason.
3. **Prerequisite pass (v2.37 — Rule 29, MANDATORY before any lens fires).** For each proposed lens, check which of its *individual checks* have their input artefacts. Many read backwards from a shipped feature history, a decided technical design, or running code. Retire the checks whose inputs do not exist, note the stage that unlocks each, and say so in the panel proposal — a lens run without inputs does not fail cleanly, it manufactures a confident finding. See the check-level prerequisite table in `_selection-rubric.md`. **Partial-lens runs are legitimate and must be recorded AS partial in the output artefact.**
4. **Four options** offered to user:
   - **Same** — re-run same lenses (drift check)
   - **Complementary Curated** — Bob picks lenses you haven't run (broaden coverage)
   - **Full Enchilada** — every lens (rocketship-launch scrub, typically 1–3 hours over multiple sessions; note L37 is a STANDING/perpetual crawler, not a one-shot — schedule it post-launch rather than only running it once here)
   - **Custom** — user specifies

   Bob recommends the default option based on time-since-last-audit, project state, and whether a milestone (launch, fundraise, post-incident) is named.

`→ HG:` User picks mode + panel. Bob does not auto-proceed.

---

**A7.1: Sequential Lens Execution**

For each lens in the selected panel, in foundation-first order (L01 → L02 → L03 → risk band → UX band → AI band → strategic band → growth band):

1. **Open a fresh Claude Code session.** Writer/reviewer pattern — same rule as prior A7a–A7e. The session that built or remediated capabilities rationalizes; the reviewer catches what the writer missed.
2. **Paste the lens entry prompt:** *"Read `audit-lenses/L{NN}-{slug}.md` AND `audit-lenses/_execution-principle.md` (the per-lens execution catalog). Run this audit on the current project. Read prior reports in `audit-artifacts/` first to avoid re-litigating findings. **Execute checks wherever possible** (drive Playwright, run tools, query APIs, simulate behavior) rather than only reading code — execution evidence > reasoning inference. As your final step, append a `retro_fragment` block to your JSON sidecar per `audit-lenses/_lens-retro.md` Tier 1 — your own signal verdict, false positives you generated, executed-vs-read, confusing check questions, stop conditions hit. Write it while fresh; it's the durable record the end-of-run retro reads."*
3. **Lens executes** per its file:
   - Loads its source frameworks (cited URLs)
   - Walks its audit method
   - Answers its check questions
   - Produces output: markdown report + JSON sidecar at `audit-artifacts/L{NN}-{slug}-{YYYY-MM-DD}.md` / `.json`
   - Names stop conditions if signal cannot be produced
   - **Appends its `retro_fragment` (v2.18.1)** to the JSON sidecar as the final step — the live, fresh self-assessment of how the *lens itself* performed (Tier 1 of the retro, per `_lens-retro.md`). This persists to disk so it survives the fresh-session boundary and any compaction.
4. **Move to next lens.** Sequential, not parallel — each lens reads prior lens reports to convert intentional ~15% overlap into confirmation signal rather than noise.

**A7.1 long-lens resilience (v2.19).** Big lenses (L05 data-protection, L04 security, L13 safety) have run long enough to exhaust a single session — a consumer AI app's Full Enchilada hit two subagent socket-closes (one lens lost *all* work at ~32 min because nothing had been written yet) and four provider 529 overloads. So:
- **Flush findings to disk incrementally**, not only at the end. Write each finding (and the running `retro_fragment`) to the JSON sidecar as it's confirmed, and checkpoint after each major sub-area. A mid-lens session drop should lose at most one sub-area, never the whole lens.
- **On provider overload (429/529) or subagent socket-close**, retry with backoff; if the subagent keeps failing, fall back to running the lens inline in the main session. Lens *content* is independent of execution infrastructure — don't let an overload abort the panel.
- **A lens is only "complete" once its sidecar (findings + `retro_fragment`) is on disk.** Until then, treat it as in-progress and resumable.

The library covers 8 bands (lens IDs are append-only — L31–L33 added in v2.21, L34 in v2.22, L35–L36 later, L37 the perpetual data-fidelity crawler in v2.32, sitting in earlier bands; group by the band, not the number):

| Band | Lenses | Question |
|---|---|---|
| 1. Engineering Foundation | L01–L06, **L31** | Does the code work, match spec, hold up to security / privacy / supply-chain? **L31:** does one input/field flow all the way through — stored, deduped, propagated to every consumer, terminal states resolved? |
| 2. User Experience | L07–L10 | Can users navigate, trust, delight, recover? |
| 3. AI Behavior | L11–L14, **L32** | Is the AI accurate, right-sized, safe, efficient? **L32:** is the analytical *method* sound (right inputs, defensible weights, valid assumptions) — for AI **and** deterministic logic? |
| 4. Performance Economics | L15–L16 | What drives cost / speed / effectiveness — and where should we *invest more* for value? |
| 5. Reach & Distribution | L17–L20, **L34** | Does it work on mobile, in other languages, for users with disabilities, and unfurl when shared? **L34:** will search / answer / generative engines find, rank, extract, and cite the site? (SEO / AEO / GEO, 4-tier funnel) |
| 6. Operational | L21–L23 | Can ops see prod, survive vendor failures, hand off to new collaborators? |
| 7. Strategic & Market | L24–L28, **L33** | Where do we win/lose, how do we price, do we sound clear, what would each persona say, are we sharpening our wedge or sanding it off? **L33:** does *generated in-product output* match the audience register/jargon + house structure? |
| 8. Growth & Adoption | L29–L30 | Do users activate fast and return? |

See `audit-lenses/README.md` for full lens inventory + provenance (the "we surveyed ~46 sources" claim).

**Liveness execution remains in L01.** Bob's existing A7j Liveness Audit (v2.14, v2.15) is folded into L01 — the Hygiene & Liveness lens executes Knip / Vulture / Schemathesis / Playwright / Vitest / pytest / promptfoo per stack. Bob still orchestrates incumbent tooling per D-003 (no custom test harness).

---

**A7.2: Aggregation**

After all lenses in the panel finish, run aggregation per `audit-lenses/_aggregation.md`:

1. **Dedup** findings that surfaced from multiple lenses (overlap = confirmation, not noise)
2. **Apply L28 vetoes** — L28 Strategic Edge & Wedge can mark earlier-lens findings as "do_not_fix_wedge" — intentional friction, not bug. Aggregation honors L28's pushback explicitly (every veto is shown, never silent)
3. **Rank** by severity × frequency × user-impact
4. **Produce** `audit-artifacts/audit-summary-{YYYY-MM-DD}.md` (+ JSON) with top 10, critical fix list, major triage queue, wedge vetoes, convergence signals
5. **Update** `audit-history.json` with run metadata (mode, lenses, findings, open/resolved)

The aggregated summary is the user-facing artifact. Individual lens reports are drill-down references.

---

**A7.3: Fix & Defer Register (replaces prior A7i)**

After aggregation:

1. **Fix** all approved Critical findings from the aggregated summary (writer/reviewer rules from `[N+1]f` apply). L01 Liveness 5xx / function-throws findings remain *always Critical* — they represent code that does not run at all and are higher-priority than most static findings.
   - **1a. Class-level fix verification (v2.19 — mandatory).** After closing any finding, grep the whole project for the *same class* of issue and fix every instance in the same pass — do not fix only the instance the lens happened to land on. This applies to *every* lens's fixes (copy that lies, missing auth, silent catches, unvalidated input, …). Origin: an audit closed a false-claim copy bug in a sign-in dialog but the identical broken copy survived in mobile nav and the homepage hero because no lens re-grepped for the class — three fix cycles for one class. Reinforces Joe's engineering principle #3 (class-level fixes) at the audit fix step.
   - **1b. Post-deploy verification (v2.19 — mandatory for risky fixes).** For any fix that touches build config, the bundler, routing, or deploy settings, you are not done when the local build passes — drive Playwright (or equivalent) against the **live deployed URL** to confirm the app still loads, then check observability for new errors. Origin: an audit's bundle-splitting perf fix passed the local build but white-screened production for 65 minutes (a P0 the audit itself caused). The optimization wasn't done until the deployed URL was verified. (Pairs with L01 check question 13.)
2. **Triage Major findings** — user marks each as Fix / Defer / Reject at `→ HG`.
3. **Register deferred items** in `audit-log.md` with **named revisit triggers** (no silent deferrals — same rule as v2.15's per-phase deferrals).
4. **Log Reject decisions** in `decision-log.md` with rationale so they aren't re-litigated by future audits (continues D-001, D-003, D-004 precedent).
5. **Update CTM:** capabilities passing the panel's hygiene + spec-fidelity + capability-quality lenses (L01–L03) get `H` status; capabilities also passing strategic + UX lenses get `H++`.
6. **PR-back prompt (v2.13).** Claude offers the [N+2]c PR-back template proactively, scoped to "this audit pass." Run `bash ~/.claude/skills/bob/../scripts/bob-stats.sh` for auto-computed fix-commit ratio.

`→ HG:` Audit pass complete. Deferred items locked into `audit-log.md`. Reject decisions logged.

---

**A7.4: Lens Retro (v2.18 — auto-emit, no opt-in; two-tier capture v2.18.1)**

After the fix & defer register, Bob **automatically** writes a lens retro — a critique of the *lenses as instruments*, distinct from the findings about the product. This is the raw material for Bob's audit self-learning loop. The user does not have to ask; the retro is emitted every audit pass.

**Captured in two tiers so context loss can't degrade it (v2.18.1).** Lenses run in fresh sessions, so the end session never saw 29 of 30 lens runs — it must not reconstruct the retro from memory. Instead:
- **Tier 1 (live, per lens):** each lens already wrote its `retro_fragment` to its JSON sidecar as its final step (A7.1) — the fresh, in-context self-assessment of how *that lens* performed.
- **Tier 2 (end of run, A7.4):** the end session **reads the durable fragments off disk** (globs `audit-artifacts/L*-*.json`, the same way A7.2 globs findings) and assembles the `lens_scorecard`, then adds the cross-lens judgments that genuinely need the whole-run vantage.

1. **Assemble** `audit-artifacts/audit-retro-{YYYY-MM-DD}.md` + `.json` per the schema in `audit-lenses/_lens-retro.md`: build `lens_scorecard` from the per-lens `retro_fragment` blocks (do **not** re-derive from memory), then add **selection-rubric accuracy**, the **coverage gap no lens caught**, **aggregation quality**, and **ranked change-requests** for Bob.
2. **The retro critiques the instrument, never restates the findings.** "L04 found unauth `/api/results`" is a finding (belongs in A7.2). "L04 was gold and executed via Schemathesis; L20 was noise for an SMS-only product; nothing modeled the provider-429 retry storm" is a retro — it teaches Bob something reusable.
3. **A deeper critique can be run later** in a fresh session with the standalone retro prompt in `_lens-retro.md` §A — but the two-tier auto-emit guarantees a faithful retro always exists even if nobody asks.

Retros feed the **Lens Retro Ritual** (`_lens-retro.md` §B): collected into `lens-retros/`, aggregated by `scripts/lens-retro.sh` once ≥3 accumulate, and turned into a human-gated proposal to edit specific lenses. **Bob never auto-edits its own lenses** — convergence across retros is signal, not a verdict (D-004 / F35 lesson; non-goal logged as D-005). Approved edits go through a normal EVOLVE + F47 dogfood.

`→ HG:` not required — A7.4 is a silent auto-write. The gate was A7.3.

---

**A7 fresh-session rules (unchanged from v2.13–v2.16)**

- Every lens runs in a **fresh Claude Code session.** The session that ran A1–A6 (or any prior lens) is the "writer"; each lens session is a clean-context "reviewer."
- Hand-off prompt at end of A6: *"Remediation complete. Multi-lens audit entry below — start a new session per lens and paste the entry prompt from `audit-lenses/L{NN}-{slug}.md`."*
- L01 Liveness portions and L11 AI Accuracy require tool execution, not just code-reading; install tooling per the lens file before running.

**A7 can be re-invoked any time.** During an active build, the user can return to MODE: AUDIT → A7 to re-run a Curated panel as new subsystems ship. Standard cadence: a Curated panel after each major phase; a Full Enchilada before launch.

### Step A8: Re-entry

After remediation and scoped hardening are complete, the project is aligned to the Build Protocol. Claude presents the next-step options based on Build Manifest state:

- **If unbuilt capabilities remain:** "Your project is aligned and the built surface is hardened. There are [N] unbuilt capabilities with [M] hardening obligations registered against them. To continue building, resume in NEW mode at Step 7 (Build Phases) — each phase will pick up its inherited hardening items at verification. A final full-scope hardening pass runs at Step [N+1] before launch."
- **If the product is feature-complete:** "Your project is aligned and fully hardened. For new features or changes, use MODE: EVOLVE — start at E1."
- **If the user wants to re-scope hardening mid-build:** "Re-invoke MODE: AUDIT → A7 anytime. The scope map will reflect new subsystems and let you harden them without redoing the rest."

`→ HG:` Human chooses next action.
