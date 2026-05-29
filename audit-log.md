# Audit Log

> Cross-audit register for Bob the Builder itself. Created to fix v2.13 finding F22 — Bob mandates registering deferred items per A7i, but Bob wasn't doing it for itself. Each audit pass appends an entry; deferred items carry forward until they're either closed in a later release or explicitly re-Rejected.

This is the operational counterpart to `decision-log.md`. The decision log records *intentional non-goals* (Reject verdicts); this log records *deliberate deferrals* (Defer verdicts) so they don't get forgotten.

---

## EVOLVE pass — v2.23 (2026-05-29) — L34 gains Audit→Action-Plan + strategic opportunity discovery (evolution 002 continued)

**Origin:** Joe's same-day follow-up to v2.22 — "make sure it's not just doing the audit but also *what fixes to make*," across tactical (change tags), work-oriented (build blogs/FAQ/comparison), and strategic (find hot/searched topics, test relevance, suggest where to invest content) altitudes; his call on whether to split.

**Decision:** kept **one lens, made it two-phase** (Audit → Action Plan) rather than splitting (D-EVO9). Rationale: the plan derives directly from the findings + opportunity scan — splitting would fragment a tightly-coupled flow and add the sprawl Bob warns against. One lens stays invokable as "run the SEO audit" while delivering the plan.

**What was missing (honest gap Joe caught):** v2.22 L34 had per-finding tactical recommendations only. Content-production was *implied* (Tier 1/2 mention FAQ + depth) but not delivered as a build backlog; **strategic opportunity discovery was entirely absent** — the lens only audited the *existing* site and never asked *what to create next*.

**Added:**
- **3-altitude Action Plan** as the primary deliverable: ① Tactical fixes (exact edits) · ② Content to produce (specific pages w/ target query, format, tier, GEO-evidence plan) · ③ Strategic positioning (ranked opportunity roadmap).
- **Strategic opportunity-discovery** method block: seed topic space from product authority (relevance gate) → harvest demand from **free signals** (GSC striking-distance, autocomplete, PAA, community, AI sub-questions) → competitor content-gap → score **relevance × demand × winnability** → sequenced roadmap.
- JSON `opportunities[]` + `action_plan{}`; 5 new check questions; 4 new anti-patterns (don't stop at findings; relevance-gate opportunities; no fabricated volumes; every page-to-build names its GEO evidence); new stop condition for no-demand-data sites.

**Guardrails:** relevance is a hard gate (high-demand-but-irrelevant = keyword-stuffing at the strategy level); no fabricated search volumes (free signals only; volume validation → paid follow-up, ties to F58).

**Files:** L34 (substantial in-place rewrite) + version bumps (CLAUDE.md, build-protocol-core footer, lens README version, SKILL.md, public README). Lens count unchanged (34).

---

## EVOLVE pass — v2.22 (2026-05-29) — L34 SEO / AEO / GEO Discoverability lens

**Origin:** Joe — "almost every product will have a website, which means it needs SEO and AI-EO." Asked for a deep research run across the fragmented SEO/AEO/GEO field and a master structured audit that beats them all, selectively invokable ("Bob, run the SEO audit").

**Classification:** Medium EVOLVE (1 new lens + wiring; new domain → Reference Scan fired). Deep research sweep (8 web searches + source fetches) → reference scan → spec → lens → wire → reconcile. Docs under `evolutions/002-seo-aeo-geo-lens/`.

**Research backbone:** the only peer-reviewed GEO evidence — *GEO: Generative Engine Optimization*, Aggarwal et al., **ACM KDD 2024** (Princeton/GT/IIT-Delhi/AI2), arXiv 2311.09735 — plus the technical-SEO 12-category consensus, AEO featured-snippet/FAQ-schema practice, the emerging `llms.txt` standard, AI-visibility tooling (Profound/Otterly/Semrush-AI), and OSS crawlers to orchestrate.

**The thesis that beats the field:** every surveyed guide is a flat checklist for *one* of SEO/AEO/GEO. L34 unifies them into a **4-tier funnel sharing a common substrate** — Tier 0 Foundation (crawl/index/render/CWV/schema) → Tier 1 SEO → Tier 2 AEO → Tier 3 GEO — and makes recommendations **evidence-ranked** by the paper's measured effect sizes (cite sources +115%, statistics +41%, quotations +28%, keyword stuffing −10%/hurts) rather than opinion. Leverage-ordered: a Tier-0 break caps all three funnels. Tiers independently runnable.

**Design decisions:**
- **D-EVO5** — one lens, four tiers, tiers independently runnable (honors "one invokable SEO audit"; rejected splitting into 3 lenses → would fragment the shared-foundation insight + add sprawl).
- **D-EVO6** — evidence-ranked, not opinion-ranked; `llms.txt` labeled low-confidence forward hedge.
- **D-EVO7** — reference/don't-re-run overlaps: CWV → L17, content voice → L26, social unfurl → L20.
- **D-EVO8** — append-only ID (L34, Band 5); profile-conditional (any web surface); new **Panel L** "SEO / AI-visibility scrub" (L34+L26+L20+L17+L24).

**Distinctness (anti-sprawl gate):** no lens did technical SEO; AEO/GEO entirely absent. vs L20 (social discoverability) / L26 (copy clarity + readability-SEO) / L17 (CWV) / L19 (semantic HTML) — declared seams, overlap only on OG/meta. Routed as **actionable** (normal queue), not strategic bucket, except the share-of-AI-voice-vs-competitors read which may feed L24.

**Files:** 1 new lens + 2 planning docs; wiring across `audit-lenses/{README,_selection-rubric,_aggregation,_execution-principle,_audit-memory}.md`, `build-protocol(-core).md`, `skill/SKILL.md`, public `README.md`, `CLAUDE.md`. Live counts 33→34; historical frozen.

**Deferred:**
- **F58 — Backlink/domain-authority depth.** Needs paid data (Ahrefs/Semrush); L34 flags off-page authority for human/paid-tool follow-up rather than faking a score. Revisit if a reliable free source appears.
- **F59 — GEO effect-size drift.** Princeton numbers are 2024; generative engines change fast (40-60% of cited sources churn monthly). **Revisit trigger:** a newer peer-reviewed GEO study, or a real field retro that contradicts the rankings.

---

## EVOLVE pass — v2.21 (2026-05-29) — Three new audit lenses (L31–L33), batch-built via Bob's own EVOLVE protocol

**Origin:** Joe's three-part question while reflecting on EMBT audits — were there audits for (1) end-to-end user-input-flow tracing (e.g. doc-upload extracts age/gender but never propagates them to scoring/recommendation), (2) the analytical quality/depth of processing/diagnosis/recommendation algorithms, and (3) audience-appropriate output language (jargon for non-technical users; McKinsey-style structure). Tracing each against the live 30-lens library (not the changelog) confirmed all three are **genuine gaps**, with only partial adjacency to L03/L05 (gap 1), L11/L16 (gap 2), L26/L18 (gap 3).

**Classification:** Medium EVOLVE, batch of 3 interdependent lenses (shared rubric/aggregation/execution-principle wiring → classified one tier up per the multiple-concurrent-changes rule). Ran the full Medium path: E3-pre Reference Scan → spec → wire → reconcile. Planning docs under `evolutions/001-trace-process-present-lenses/`.

### Lenses added

| Lens | Band | Spine framework(s) | Distinctness (anti-sprawl gate) |
|---|---|---|---|
| **L31 Input & Data-Flow Trace** | 1 | Taint-tracking + column-level data lineage + STRIDE DFD; Engineering Principle #2 | L03 grades one capability *vertically*; L05 is PII *compliance*. L31 traces one field *horizontally* across all consumers — propagation completeness. |
| **L32 Analytical Method Soundness** | 3 | SR 11-7 *conceptual-soundness* pillar (covers deterministic **and** AI) | L11 = outcomes analysis (evals, AI-only); L16 = ongoing monitoring. L32 = the method-design pillar neither owns; uniquely covers deterministic logic. |
| **L33 Output Register & Audience Fit** | 7 | ISO 24495-1 Plain Language + Minto Pyramid + NN/g tone | L26 = marketing surfaces only (skips in-product output); L18 = translation readiness. L33 = generated in-product output register/structure. |

### Design decisions (logged for reversibility)

- **D-EVO1 — Append-only IDs.** L31/L32/L33 keep the next free IDs and declare `band:` in frontmatter rather than renumbering L01–L30 (blast radius across 30 files + every cross-ref; zero benefit). Convention shift noted in README + core + full protocol: group by band, not ID arithmetic.
- **D-EVO2 — L33 is actionable content, not strategic-veto.** Routed like L26 to the normal code-fix queue, NOT the v2.19 strategic/non-code bucket (a jargon-laden diagnosis is a fixable defect, not a positioning opinion). `_aggregation.md` "Band ≠ bucket" note makes this explicit.
- **D-EVO3 — L32 owns conceptual soundness only.** Explicit SR 11-7 three-pillar split with L11/L16 prevents overlap-litigation; when L32+L11 flag the same site, both pillars stay cited.
- **D-EVO4 — Selection-rubric restraint.** The three lenses are **profile-conditional** (fire on data-fan-out / analytical-engine / non-technical-audience triggers), added to Panels A and K conditionally + a dedicated "New-lens inclusion triggers (v2.21)" note. Minimal panels (Internal-tool D = 3 lenses) untouched. Directly heeds the v2.17 "sprawl is the #1 risk, not shortfall" meta-finding.

### Files touched

3 new lens files; 2 planning docs (`evolutions/001-…/{reference-scan,spec}.md`); wiring across `audit-lenses/{README,_selection-rubric,_aggregation,_execution-principle,_audit-memory}.md`, `build-protocol-core.md`, `build-protocol.md`, `skill/SKILL.md`, public `README.md`, `CLAUDE.md`. Live counts 30→33 throughout; **historical changelog/audit-log entries left frozen at 30** (rewriting a past version's count would falsify the record); illustrative "29 of 30 fresh-session" narratives left as-is.

### Deferred (revisit triggers)

- **F56 — N=1 framework validation.** L31/L32/L33's frameworks (taint/lineage, SR 11-7, ISO 24495+Minto) are established, but their *fit as Bob lenses* is unproven against a real audit. **Revisit trigger:** first real retro that runs any of the three — does it produce signal or noise? (Same posture as v2.19 F55.)
- **F57 — Profile-trigger tuning.** D-EVO4's conditional-inclusion triggers are a first guess. **Revisit trigger:** if users consistently swap the three in or out of recommended panels (tracked via `audit-history.json` "swaps from recommended"), retune the rubric.

---

## EVOLVE pass — v2.19 (2026-05-25) — First lens-library improvement driven by a real field retro

**Milestone:** this is the first time Bob's lens library was improved from a **real audit retro** (not a Bob-on-Bob dogfood). The self-learning loop (v2.18) produced its first field signal — a Full Enchilada retro from a live consumer health product (EMBT) — and that signal drove concrete lens edits. The loop closed end-to-end: audit → retro → ritual (`scripts/lens-retro.sh`) → human verdict → lens edits → ship.

**D-005 compliance:** Bob did not auto-edit anything. The retro *surfaced* ranked change-requests; the human (Joe) reviewed and gave the verdict "fix all of them." These edits are the human-approved result, per D-005.

**N=1 caveat (recorded so future retros can revisit):** all of this is from a **single** project with one profile (launched · AI-pipeline · health-data · solo-dev · production). The two top changes (deploy-verification, class-level-fix) are backed by a concrete production incident, so they're profile-independent. The rest (L25 demotion, strategic bucket, measurement plans, etc.) are plausibly general but unconfirmed at N=1 — if a second project's retro disagrees, revisit. Nothing was *deleted* (e.g., L25 was demoted in the rubric, not removed) specifically to keep N=1 changes reversible.

### Change-requests addressed (all 10 ranked + 5 coverage gaps + 3 meta-findings)

| Retro CR | Fix shipped |
|---|---|
| #1 Deploy-verification (the audit *caused a 65-min P0*) | L01 check-q13 (drive Playwright against the **live deployed URL** after build-config/routing changes) + build-protocol **§A7.3 step 1b** (mandatory post-deploy verify for risky fixes) |
| #2 Class-level fix not enforced (same broken copy in 3 places) | build-protocol **§A7.3 step 1a** (mandatory class-grep after every fix, all lenses) + pointed anti-patterns in L07 + L26 |
| #3 L25 Pricing = Noise → fold | `_selection-rubric.md`: L25 removed from default panels + "rarely standalone" note (demoted, **not deleted** — reversible) |
| #4 AI→DB constraint drift | L13 check-q16 (server-side normalization + non-silent error path for AI writes to constrained columns) |
| #5 L29/L30 end with "measure later," no query | L29 + L30 check-q16 (require a day-30 measurement plan: exact events, exact query, window, threshold) |
| #6 L25 verify-before-claim (false "apiVersion missing") | L25 check-q16 (grep all call-sites before claiming a config absent) |
| #7 L05 too big / subagent socket-close | build-protocol **§A7.1 long-lens resilience** (flush findings to disk incrementally; 529/socket-close → retry-backoff → inline fallback; lens "complete" only when sidecar on disk) + L05 checkpoint note |
| #8 L18 i18n → 7 findings for half-shipped feature | L18 anti-pattern (compress to one "commit OR revert i18n" binary decision) |
| #9 Jargon: HAX / wedge / shareability | L13 HAX gloss ("Human-AI eXperience"); L28 q1 "<8-word wedge" concrete test; L20 virality-scope note (don't score a deliberately-non-viral product as deficient) |
| #10 Strategic lenses rank-pollute Criticals | `_aggregation.md`: separate "Strategic / non-code" bucket (L24/L25/L27/L28 out of the code-fix queue) |
| Coverage gap: state-change blindness | `_aggregation.md` convergence section: name cross-lens latent meta-patterns ("stateful at data, stateless at UX") |
| Meta: Full Enchilada too big for solo-dev/prod | `_selection-rubric.md` **Panel K (12)** as production default + Full-Enchilada incident-risk caution (the 30-lens scrub is what exposed EMBT to the P0) |
| Meta: ~8 lenses Read when they could Execute | `_execution-principle.md` **execution adherence gate** (per-lens ran/skipped accounting; every quantitative claim must cite the command behind the number) |

### Files touched (15)

11 lens files (L01, L05, L07, L13, L18, L20, L25, L26, L28, L29, L30 — targeted check-questions / anti-patterns / glosses) + 3 infra files (`_selection-rubric.md`, `_aggregation.md`, `_execution-principle.md`) + `build-protocol.md` (§A7.1 + §A7.3). Per the v2.17 "sprawl is the #1 risk" meta-finding, cross-cutting fixes (class-grep, deploy-verify, adherence gate) live in shared files (A7.1/A7.3/`_execution-principle.md`) rather than being copied into 30 lens files; only the genuinely lens-specific items edited individual lenses.

### Convergence with prior decisions

- **D-005:** human supplied the verdict; loop only surfaced. Honored.
- **v2.17 sprawl meta-finding:** preferred cross-cutting single-file edits over per-lens duplication.
- **F47 dogfood pattern:** the retro *is* the field evidence; these edits are its product.

### Deferred (revisit triggers named)

- **F55 — confirm N=1 changes against retro #2.** When a second project (different profile) produces a retro, re-check the non-incident-backed changes (L25 demotion, strategic bucket, measurement-plan requirement, L18 compression). **Revisit trigger:** second real retro lands in `lens-retros/`.

---

## EVOLVE pass — v2.18.2 (2026-05-25) — Retros are private-by-default (fixes a confidentiality flaw in v2.18)

**Trigger:** processing the first real retro (from a live consumer health product audit) surfaced a design flaw in v2.18: the `lens-retros/` collection point was a **tracked folder in a public repo**, and the README/`_lens-retro.md` prose instructed users (and maintainers) to *PR raw retros into it*. A raw retro embeds project-specific security detail — vulnerable routes/tables, finding descriptions, commit hashes, still-open issues. The first retro was briefly committed and pushed to the public repo before being caught; it was purged from git history (force-push of a rewritten branch after temporarily lifting the `main-no-force-push-no-delete` ruleset, then restoring it).

**The flaw:** the loop's value (sharing audit-instrument learnings) was conflated with the artifact's risk (the artifact also contains product-specific findings). Sharing the *signal* is safe; sharing the *raw retro* is not.

**Fix:**
- `.gitignore` now excludes `lens-retros/*.json` (only `.gitkeep` + README tracked). Raw retros are **local-only**; `scripts/lens-retro.sh` reads them off the machine.
- `lens-retros/README.md` + `_lens-retro.md` §B rewritten: external contributors submit a **sanitized** change-request set (lens IDs + verdicts + generic notes, no finding detail/tables/routes/hashes) via issue or email — never a raw retro PR.
- The lesson is recorded inline in both docs so it isn't re-introduced.

**Lesson for the loop's own design:** an artifact that critiques *the instrument* can still carry *the workpiece's* secrets if it cites specifics. Future artifact designs that get shared upstream must separate "signal to share" from "context that stays local" at emit time. (Candidate follow-up: have A7.4 emit a sanitized companion `audit-retro-{date}.public.json` alongside the private full one — deferred as F54.)

### Deferred (revisit triggers named)

- **F54 — sanitized retro companion at emit time.** A7.4 could auto-emit a `*.public.json` (lens IDs + verdicts + generic notes only, no finding text) so sharing upstream is a copy, not a manual sanitization. **Revisit trigger:** first time an external user actually wants to contribute a retro, or if manual sanitization proves error-prone.

---

## EVOLVE pass — v2.18.1 (2026-05-25) — Two-tier retro capture (fixes a context-loss flaw in v2.18)

**Trigger:** Joe's design-review question hours after v2.18 shipped — *"the audit takes a lot of time and tokens and the session will compact context along the way. Is that a problem for the accuracy of learnings if the loop only runs at the end of a 30-audit chain? Or does it need to store learnings throughout then compile at the end?"*

**The flaw he caught (real, and bigger than compaction):** v2.18's A7.4 wrote the retro at the end of the audit, assuming "the session that ran aggregation has full context of what each lens produced." False. Lenses run in **fresh sessions** (writer/reviewer, A7.1), so the end session never witnessed 29 of 30 lens runs — it could only read the *findings* artifacts on disk. Those record what's wrong with the **product**, not the instrument-level nuance the retro needs (ambiguous check questions, executed-vs-read struggles, noise/false-positive judgments, "couldn't run because X"). That nuance lives only in each lens's live context and evaporates at the session boundary (and can compact within a long lens). The end-of-run retro was therefore a **lossy reconstruction** — exactly the accuracy problem Joe flagged. Compaction is the secondary risk; the fresh-session architecture is the primary one.

**Fix — two-tier capture (store throughout, compile at end):**
- **Tier 1 (live, per lens):** each lens, as its **final output step** in A7.1, appends a `retro_fragment` block to its own JSON sidecar — self signal verdict, false positives it generated, executed-vs-read, confusing check questions, stop conditions hit, free-text `self_note`. Written while fresh and in-context; persisted to disk so it survives the fresh-session boundary and any compaction. Written even on a stop condition ("couldn't run because X" is high-value signal).
- **Tier 2 (end of run, A7.4):** the end session **reads the durable fragments off disk** (globs `audit-artifacts/L*-*.json`, exactly as A7.2 globs findings) to assemble the `lens_scorecard`, then adds the cross-lens synthesis that genuinely needs the whole-run vantage — selection-rubric accuracy, the coverage gap **no** lens caught, aggregation quality, ranked change-requests. The end session no longer needs 30 lenses in its context window.

This reuses Bob's existing **disk-is-memory** pattern (findings already work this way) rather than inventing anything — consistent with D-003.

### Changes shipped in v2.18.1

- **`audit-lenses/_lens-retro.md`** — replaced the "end session has full context" framing with the two-tier model (added a Tier-1/Tier-2 table + the `retro_fragment` JSON schema + the rule that `lens_scorecard` is assembled from fragments, not memory). Standalone fresh-session prompt updated to build from fragments.
- **`build-protocol.md` §A7.1** — lens entry prompt + output contract now require appending `retro_fragment` as the final step. **§A7.4** — reframed from "write from full context" to "assemble Tier-1 fragments off disk + add Tier-2 synthesis."
- **`build-protocol-core.md`** — A7.4 line notes the two-tier capture.
- **`audit-lenses/README.md`** — per-lens output schema note mentions the `retro_fragment` final step.
- **`CLAUDE.md`** + version headers → v2.18.1.

### Why this is v2.18.1 (not v2.19)

It corrects how the v2.18 mechanism *captures* data; it adds no new capability and no new lens. Same class of increment as v2.17.1 (sharpened v2.17's execution discipline). `scripts/lens-retro.sh` is unchanged — it still consumes the final `audit-retro-*.json`, whose `lens_scorecard` is now assembled from fragments rather than authored from memory.

### Closes / supersedes

- **Partially closes F52** (retro auto-emit fidelity). v2.18 deferred F52 with the worry that the auto-emit was a same-session rationalization. Two-tier capture addresses the structural half (the end session no longer relies on memory). The *remaining* F52 concern — a lens being self-congratulatory in its **own** fragment — stands; revisit trigger unchanged (if 2+ fragments are all-Gold/no-gaps, make the fresh-session critique mandatory).

---

## EVOLVE pass — v2.18 (2026-05-25) — Audit Self-Learning Loop (Lens Retro)

**Trigger:** Joe's three-part question (2026-05-24) after kicking off a full lens-library audit on EMBT (Explain My Blood Test): (1) how should a project *self-apply* its audit learnings for future hygiene; (2) what prompt makes the project session emit detailed learnings to paste back to Bob so Bob's audit knows what worked / what to add; (3) how do we make (2) a *semi-automatic* self-learning capability so the audit library gets better every time it runs on any project. Joe selected building **A + B** (auto-emit + accumulate-and-flag); explicitly *not* full automation.

**Framing that shaped the design:** three distinct loops were being conflated. (1) is project-side hygiene — not Bob's concern (handled by a paste-in prompt that stays in the project). (2) is the auto-emit **lens retro** — a critique of the *lenses as instruments*, NOT the findings about the product. The load-bearing distinction: a retro that restates findings teaches Bob nothing (findings are project-specific); a retro that says *"L20 was noise for an SMS-only product and check-question Q3 wrongly assumes a web surface"* improves the lens for every future project. (3) is the **Lens Retro Ritual** — accumulate retros, flag consistently weak lenses, human decides.

### Changes shipped in v2.18

- **`audit-lenses/_lens-retro.md`** (new) — the core spec. Defines the retro artifact (markdown + JSON schema), the finding-vs-instrument distinction, the standalone fresh-session retro prompt, the collection mechanism, and the full Lens Retro Ritual with its human gate.
- **`scripts/lens-retro.sh`** (new) — thin jq aggregator (same class as `bob-stats.sh`). Reads `lens-retros/*.json` (+ optional project-dir args), tallies per-lens Noise rate / swap-out rate / should-have-executed rate / change-request count, and prints a ranked REVIEW-CANDIDATES board plus coverage-gap and change-request roll-ups. Validates `artifact_type == "audit_retro"`; warns below a 3-retro floor (don't act on N=1).
- **`lens-retros/`** (new folder + README + `.gitkeep`) — collection point. Retros arrive via Joe copying his own project retros, external-user PR-back, or email — no telemetry, no phone-home.
- **`build-protocol.md` §A7.4** (new sub-step) — Bob auto-emits the retro at the end of every audit pass. No `→ HG` (silent auto-write; the gate was A7.3).
- **`build-protocol-core.md`** — A7.4 added to sub-steps; AUDIT header bumped v2.17 → v2.18.
- **`audit-lenses/_audit-memory.md`** — retro artifacts added to the Files table; `audit_run_id` links retro ↔ run.
- **`audit-lenses/README.md`** — new "Lens Retro — the self-learning loop" section.
- **`decision-log.md` D-005** (new) — the surface-only non-goal: Bob never auto-edits its own lenses. Convergence across retros is signal, not a verdict (the D-004 / F35 lesson, applied to Bob's own improvement loop).
- **`CLAUDE.md`** — Current Version → v2.18 + entry.

### Dogfood pass (per F47 meta-pattern)

`scripts/lens-retro.sh` was smoke-tested against two synthetic retros (EMBT + DLL, both SMS/AI profiles). It correctly flagged **L20 (Shareability/Virality)** as a REVIEW candidate — Noise in 2/2 runs, swapped out in 2/2, 2 change-requests targeting it — surfacing the convergent "virality lens is noise for SMS-only products" signal, and **L07** for a should-have-executed gap. The output footer correctly reminds the human that convergence is signal not verdict (D-005). The first *real* retro will be EMBT's, emitted when Joe runs A7.4 at the end of the in-flight audit.

### Why this is v2.18 (not v2.17.2)

It adds a new audit *capability* (the self-learning loop) with new artifacts, a new script, a new folder, and a new protocol sub-step — not a prose sharpening of existing lenses (which is what v2.17.1 was). Minor-version increment is correct.

### Relationship to existing deferred items (honest accounting)

- **F48 (audit-history.json as a live artifact)** — NOT closed. v2.18 introduces a *sibling* live-artifact discipline (retro JSON with a validated `artifact_type` + a script that consumes it), which is partial precedent for formalizing F48, but F48 specifically calls for JSON-Schema validation of `audit-history.json`. Its revisit trigger (3+ external users report friction) is unchanged.
- **F51 (findings-aggregation script `aggregate-audit.sh`)** — NOT closed and deliberately distinct. `_aggregation.md` + a future `aggregate-audit.sh` combine *findings within one run*; `_lens-retro.md` + `lens-retro.sh` combine *retros across runs*. Different artifacts, different scripts, different purpose. v2.18 does not satisfy F51.

### Convergence with prior decisions

- **D-003 (orchestrate, don't reinvent):** `lens-retro.sh` is a thin jq aggregator producing paste-ready output (same class as `bob-stats.sh`), not new audit infrastructure. The retro loop orchestrates Claude's own judgment + a human gate; it builds no scoring engine.
- **D-004 / F35 (convergence is signal, not a verdict):** this is the *governing* principle of D-005. The whole reason the loop is surface-only is the F35 lesson — mechanical convergence (5/9 tools wanted sharded rules) was correctly overridden by human judgment. The retro loop is designed to reproduce that override-able structure, never bypass it.
- **F47 meta-pattern (propose → dogfood on Bob → reshape prose → ship):** followed — the script was dogfooded on synthetic Bob-profile retros before shipping, and the dogfood result (L20 flagged) is recorded above.

### Deferred (revisit triggers named)

- **F52 — Retro auto-emit fidelity.** A7.4's auto-emit is written by the same session that ran aggregation (it has context but also rationalization bias). The standalone fresh-session retro prompt exists as the higher-fidelity path. **Revisit trigger:** if 2+ retros are observably self-congratulatory (every lens rated Gold, no coverage gaps), make the fresh-session critique mandatory rather than optional.
- **F53 — Selection-rubric auto-refinement from retros.** The retro `selection_rubric_accuracy` fields (swaps, should-not-have-run, missing-from-panel) are aggregated by the script but the rubric edits are still manual. **Revisit trigger:** once the ritual has run twice and produced stable swap patterns per profile, consider a rubric-update sub-step that proposes default-panel changes (still human-gated per D-005).

---

## EVOLVE pass — v2.17.1 (2026-05-23) — Execution Principle across all 30 lenses

**Trigger:** Joe's question minutes after v2.17 shipped — *"are we fully utilizing Claude Code's ability to self-check and self-test features vs requiring manual checks vs not checking at all? (functions, buttons, workflows, experiences, databases, simulations, etc.)"*

**Approach:** Quick audit of all 30 lens prompts against the question. Findings: 8 lenses already mandate execution (L01 Knip/Schemathesis/Playwright, L04 Semgrep/Snyk/Gitleaks, L06 Snyk/OSV/Checkov, L11 promptfoo/TruLens, L13 Garak/PyRIT/promptfoo-redteam, L17 Lighthouse, L19 axe-core, L20 link-unfurl validators). ~10 lenses are mixed (cite tools but default to "have Claude read the config"). ~12 lenses default to reading + human walk when Claude could execute via Playwright / API queries / programmatic flow walks (L02, L03, L07-L09, L15-L16, L21, L25-L27, L29, L30).

**Decision:** Don't rewrite 30 lens files inline. Ship a cross-cutting principle file (`audit-lenses/_execution-principle.md`) that:
- Names the principle: execution evidence > reasoning inference
- Catalogs per-lens what Claude should EXECUTE / READ / leave to HUMAN
- Provides read-mode-to-execute-mode rephrasing examples for common check question shapes
- Documents the failure mode it prevents: *"I read the code and it looked correct"*

Every lens prompt now gets `_execution-principle.md` loaded as a companion read at run time, via an updated A7.1 instruction in `build-protocol.md`. Future lens prompt edits add their row to the per-lens execution catalog.

### Changes shipped in v2.17.1

- **`audit-lenses/_execution-principle.md`** (new) — principle + per-lens catalog + rephrasing examples + anti-patterns.
- **`audit-lenses/README.md`** — added "Execution Principle" section pointing to the new file.
- **`build-protocol.md` §A7.1 step 2** — lens entry prompt now includes "Read `audit-lenses/_execution-principle.md`... Execute checks wherever possible..."
- **`CLAUDE.md`** — v2.17.1 entry surfaces the principle + the meta-finding (8 fully execute / 10 mixed / 12 default-to-reading).

### Why this isn't a v2.18

It doesn't add new audit *capabilities* or new lenses; it sharpens how the existing 30 lenses run. v2.17.1 is the appropriate version increment for a cross-cutting prose addition that operationalizes a rule the library already implicitly favored (L01 Liveness was the first instance) but didn't make explicit.

### Convergence with prior decisions

- **D-003 (orchestrate, don't reinvent):** the execution principle is the natural consequence — orchestrate Claude's execution surface (Playwright, code-running, tool-driving) wherever possible, don't re-invent verification by reading.
- **F47 meta-pattern (propose → dogfood → reshape prose → ship):** v2.17 had just shipped, so there's no separate dogfood run on Bob for v2.17.1 — but the meta-finding (8 fully execute / 10 mixed / 12 reading-heavy) IS the dogfood evidence informing the principle's prose.

---

## EVOLVE pass — v2.17 (2026-05-23) — Multi-Lens Audit Library

**Trigger:** Joe's challenge in two parts. (1) Observation: even structured Claude builds miss things, and audits run on those builds also miss things — each audit catches different gaps depending on its angle. (2) Hypothesis: instead of a single A7 audit phase, Bob should ship a *library* of pre-written audit lens prompts attacking the codebase from many angles (hygiene, structure, security, UX, AI accuracy, pricing, virality, mobile, accessibility, wedge sharpness, persona simulation, etc.) — locked-and-loaded so a non-engineer doesn't have to invent them per project.

**Approach:** External research across four parallel agents — (1) industry code/quality audit taxonomies (ISO 25010, OWASP T10/ASVS, STRIDE, CWE25, NIST SSDF, WCAG, GDPR), (2) UX/product audit methods (Nielsen, NN/g, JTBD, Friction Log, Peak-End, Microsoft HAX, Brignull dark patterns), (3) AI-era code review tools (CodeRabbit, Greptile, Bito, Qodo PR-Agent, Sourcery, DeepSource, Cursor Bugbot, Copilot, Diamond, CodeAnt, diffray, Kodus), (4) strategic / growth frameworks (Dunford, Play Bigger, Linear/Saarinen, 37signals, Hanlon, Ramanujam, Campbell, Wiebe, Eyal, Reforge, Andrew Chen). Joe-driven extension: the lens taxonomy must cover operator-distinctive angles engineering audits never touch (pricing mechanics, mobile-first, i18n, virality, wedge sharpness, persona simulation).

### Library shipped: 30 lenses across 8 bands

- **Band 1 Engineering Foundation (6):** L01 Hygiene & Liveness (folds prior A7a-A7j) · L02 Spec Fidelity · L03 Critical Capability Quality · L04 Security & Threat Surface · L05 Data Protection & Privacy · L06 Supply Chain & Configuration
- **Band 2 User Experience (4):** L07 Ease & Cognitive Path · L08 Friction & Trust · L09 Wow & Emotional Peaks · L10 Edge States & Recovery
- **Band 3 AI Behavior (4):** L11 Accuracy & Calibration · L12 Right-Sizing & Model Fit · L13 Interaction (HAX) & Safety · L14 Cost & Latency Efficiency
- **Band 4 Performance Economics (2):** L15 Cost & Speed Drivers (incl. tradeoff inversion — *when to pay more for value*) · L16 Effectiveness & Quality Drivers
- **Band 5 Reach & Distribution (4):** L17 Device & Form Factor · L18 i18n & Language · L19 Accessibility (WCAG+) · L20 Shareability, Virality & Discoverability
- **Band 6 Operational (3):** L21 Observability & Incident Readiness · L22 Vendor & Dependency Risk · L23 Documentation & Onboardability
- **Band 7 Strategic & Market (5):** L24 Competitive Benchmarking · L25 Pricing & Monetization · L26 Marketing, Copy & Website · L27 Persona Simulation · L28 Strategic Edge & Wedge Sharpness
- **Band 8 Growth & Adoption (2):** L29 Onboarding & Activation · L30 Retention & Compounding Loops

Plus three infrastructure files: `_selection-rubric.md` (Bob's panel-proposal logic), `_aggregation.md` (dedup + L28 vetoes + ranking), `_audit-memory.md` (history-aware entry + four options: Same / Complementary / Full Enchilada / Custom).

### Dogfood pass on Bob itself

Per the v2.16 meta-pattern (F47 — *propose new audit step → dogfood on Bob → let meta-findings reshape prose, then ship*), v2.17's lens library was stress-tested against Bob as a "methodology product" (Panel C — L01, L02, L03, L23, L24, L28).

**Meta-findings:**

1. **L28 Wedge applied to Bob:** wedge clearly articulable ("methodology for non-engineer product leaders building with Claude Code"); named enemies present (engineer-first agent-coding tools — Spec Kit, Cursor rules, BMad); anti-feature list non-empty (no telemetry by design per A7g; no sharded rules per D-004; no custom liveness CLI per D-003); convergence drift low per v2.16 dogfood (5 of 9 tools converged on sharded rules — Bob rejected). **No new L28 findings.** Bob's wedge is intact and the lens library reinforces it (orchestrate incumbent tooling rather than build custom audit infrastructure).

2. **L02 Spec Fidelity applied to v2.17 work itself:** all 30 lens files referenced in `audit-lenses/README.md` exist on disk (verified). All three infrastructure files exist. `audit-history.json` schema documented in `_audit-memory.md` but not yet a live artifact — that's expected; it gets created on first real audit run. **No critical L02 findings.**

3. **L23 Documentation:** README.md needs an update to surface the lens library and v2.17. CLAUDE.md "Current Version" block needs bump from v2.16 to v2.17. Both addressed in this release.

4. **L01 Hygiene applied to lens-library writing:** lens files are markdown prose, no code, no liveness check needed. **N/A.**

**Headline meta-finding (informs future EVOLVE):** *the lens library's biggest risk is sprawl, not shortfall.* 30 lenses × ~225 lines each = ~6,750 lines of lens content + 3 infrastructure files = ~7,200 lines added in one EVOLVE. That's load-bearing infrastructure for the foreseeable future, but it crosses Bob's protocol size from one repo of ~3,000 lines to ~10,200 lines. Mitigations baked in: (a) sequential execution + prior-report reading prevents re-litigation; (b) L28 explicit veto mechanism prevents convergence-to-mediocrity; (c) selection rubric defaults to Curated 6-10 lenses per run, not Full Enchilada; (d) audit-memory entry surfaces history so users don't reinvent panel choice each time.

### Changes shipped in v2.17

- **A7 rewritten** from prior A7a-A7j scope-map structure to A7.0 (entry + panel selection), A7.1 (sequential lens execution), A7.2 (aggregation), A7.3 (fix & defer register). Prior A7a-A7j content folded into L01 Hygiene & Liveness lens prompt.
- **30 lens prompt files** at `audit-lenses/L01-L30.md`, each self-contained (purpose, source frameworks cited, audit method, check questions, output schema markdown + JSON, severity rubric, anti-pattern instructions, stop conditions, cross-lens handoff).
- **3 infrastructure files** at `audit-lenses/_{selection-rubric,aggregation,audit-memory}.md`.
- **`audit-lenses/README.md`** — library index, format spec, mode design, provenance (~46 sources cited).
- **`build-protocol.md` A7 section** rewritten (~250 lines → ~130 lines, with detail moved to lens files).
- **`build-protocol-core.md` AUDIT section** updated.
- **Version footers** bumped to v2.17.

### Deferred (revisit triggers named)

- **F48 — audit-history.json as a live artifact.** Currently the schema is documented in `_audit-memory.md` prose; Bob's protocol tells Claude to write to this file at A7.2. No tooling validates or constructs it. **Revisit trigger:** if 3+ external Bob users self-report friction with manual audit-history maintenance, or if Bob ever ships a programmatic helper, formalize the schema with JSON Schema validation. Until then, prose-driven is consistent with D-003.

- **F49 — Lens prompt evolution cadence.** 30 lens files reference dated industry sources. Industry frameworks evolve (OWASP ASVS will roll past 5.0; WCAG to 3.0; new AI safety standards; new pricing frameworks). **Revisit trigger:** annually, or when a major lens-referenced source has a non-trivial release (e.g., WCAG 3.0 ships).

- **F50 — Mobile / device / i18n auditing on Bob itself.** Bob is a markdown methodology — no UI, no mobile, no i18n. L17/L18/L19 are not applicable as long as Bob stays methodology-only. **Revisit trigger:** if Bob ever ships a hosted dashboard, telemetry pipeline, or community marketplace (revisit trigger per D-002).

- **F51 — Aggregation tooling.** Aggregation logic (dedup, L28 vetoes, ranking) is documented in `_aggregation.md` as prose. No script implements it. **Revisit trigger:** if users report inability to mentally aggregate findings across 6+ lenses per run, write a `scripts/aggregate-audit.sh` that consumes the JSON sidecars and produces the summary mechanically. Until then, prose-driven per D-003.

### Convergence with prior decisions

- **D-003 (orchestrate, don't reinvent):** every Tier 1 lens cites incumbent tooling (Knip, Schemathesis, Semgrep, Snyk, Gitleaks, axe-core, Lighthouse, TruLens, RAGAS, promptfoo, Garak, PyRIT, Stripe, etc.). Bob does not implement any audit scanners — Bob orchestrates them.
- **D-004 (single CLAUDE.md, not sharded):** unchanged. Lens prompts live in `audit-lenses/`, not in CLAUDE.md.
- **F47 meta-pattern (propose → dogfood on Bob → reshape prose → ship):** followed for v2.17. This entry is the dogfood evidence.

### Future audit consideration

The v2.17 lens library is itself a candidate for first-party stress-testing through future external Bob users. The PR-back template (v2.13, Step [N+2]c) is the lightweight feedback mechanism — when external users report which Curated panels they swap from, the selection rubric (`_selection-rubric.md`) gets refined. Track swap patterns in `audit-history.json` `user_swaps_from_recommended` field.

---

## EVOLVE pass — v2.16 (2026-05-20) — Reference Scan integration + dogfood findings

**Trigger:** User challenge — *"Bob feels inward-looking / self-sufficient. There are tons of interesting OSS repos with smart patterns; it's not hard for Claude Code to find the top 10 and grab the best of their capabilities. (1) Where in NEW / EVOLVE / AUDIT should this go? (2) Have we done it for Bob itself?"* Honest analysis confirmed the hypothesis: Bob had exactly **one** external-research touchpoint (`A7f Capability Gap` in AUDIT only), and it operated at the strategic-positioning level — never at the mechanism-borrowing level. The "orchestrate, don't reinvent" principle (D-003) existed but was buried in an ADR, not promoted to a load-bearing rule.

**Approach:** Joe authorized "do both" against my proposal (c) — dogfood the proposed new step on Bob itself FIRST, then ship the protocol edits informed by what the dogfood produced. This is the canonical Bob-on-Bob workflow.

### Dogfood pass (A7f-implementation, run on Bob v2.15 vs the 9 tools in D-001)

A research subagent scanned all 9 strategically-Rejected competitors (Plandex, Roo Code, goose, Continue.dev, Spec Kit, Cursor Rules, BMad, Aider, Cline) for borrow-worthy mechanisms. Output: 3 Adopts, 6 Reject/Defer per-tool findings, 3 convergence signals across ≥3 tools, and a meta-finding that **the step must be biased toward Reject** or it silently becomes a noise generator.

The meta-finding directly shaped how the new protocol prose is written (bias-toward-Reject is now a named instruction in NEW Step 3a-pre, EVOLVE E3-pre, and AUDIT A7f-implementation — all three reference this audit-log entry as the dogfood evidence).

**Convergence signals (≥3 tools shared):**
1. Markdown-with-YAML-frontmatter as the unit of reusable AI instruction (Cursor `.mdc`, Continue `.prompt`, Cline `.clinerules`, Roo `.roomodes`, goose `.goosehints`, BMad templates)
2. Per-feature directory pattern: `{feature-id}/` containing spec + plan + tasks + reconciliation (Spec Kit, BMad, Cline, Aider, Plandex)
3. Architect/planner ≠ executor as an explicit model boundary (Aider, Cline, Spec Kit, BMad)

### Changes shipped in v2.16

- **NEW mode Step 3a-pre — Reference Scan (new sub-step).** Mandatory for Standard/Heavy, optional for Light. Scan 5-10 recent OSS repos matching the project profile, harvest mechanisms with Adopt/Defer/Reject verdicts, bias toward Reject. Output: `docs/reference-scan.md`. Adopts must name a concrete insertion point or they become Defers.
- **EVOLVE E3-pre — Scoped Reference Scan (new sub-step).** Fires for Large always, Medium with new subsystems/integrations/patterns. Skip Small and pattern-extending Medium (already vetted at NEW 3a-pre).
- **EVOLVE E3 — Per-evolution folder structure (F33, borrowed from Spec Kit's `specs/{FEATURE-ID}/` idiom).** Medium+ evolutions create `evolutions/{NNN-short-name}/` containing spec-delta + plan + reference-scan + reconciliation note. Solves the "evolution 7 scattered across 4 docs" pain. Small evolutions skip — overhead exceeds value.
- **EVOLVE E3 → E4 — Plan-mode hard gate (F34, borrowed from Cline's Plan/Act model).** Medium+ evolutions must be drafted in Claude Code plan mode; switching to E4 is a named, deliberate transition. Names a gate Bob already implied softly via v2.7 prose; promoting it to a hard boundary directly attacks scope-creep at the highest-risk moment.
- **AUDIT mode A7f split into A7f-capability + A7f-implementation.** A7f-capability is the existing positioning scan, unchanged. A7f-implementation is the new mechanism scan, runs *only* on tools A7f-capability marked Reject, biased toward Reject. The dogfood meta-finding's "≤3 Adopts per 9 tools scanned" guidance is encoded in the prose.
- **Section 3 — "Orchestrate, don't reinvent" promoted to a load-bearing principle.** Previously implicit (D-003 + audit-log F32). Now a named selection rule on top of the 6 Decision Factors, with explicit convergence-check + custom-build-threshold + document-the-choice steps. Mandates `tool-decisions.md` rows include a "Considered orchestrating: [tool]" line every time.
- **Compact reference (build-protocol-core.md) updated:** NEW step 3 sequence now includes 3a-pre; EVOLVE sequence includes E3-pre + per-evolution folder + plan-mode gate; AUDIT A7f description names both sub-audits; rule 14 added for orchestrate-don't-reinvent. Version footer bumped to v2.16.

### Closed in v2.16

| # | Title | Notes |
|---|---|---|
| F33 | Per-evolution folder pattern in EVOLVE E3 (Spec Kit borrow) | Shipped opportunistically — insertion point lined up exactly with the new E3 prose. Validated by dogfood Top Adopt #2. |
| F34 | Plan-mode hard gate at EVOLVE E3 → E4 (Cline borrow) | Shipped opportunistically — directly attacks Joe's existing scope-lock concern. Validated by dogfood Top Adopt #3. |
| F36 | NEW 3a-pre Reference Scan step | The protocol infrastructure Joe asked for, informed by dogfood meta-finding |
| F37 | EVOLVE E3-pre Scoped Reference Scan (size-gated) | Same family as F36 but scoped per-evolution |
| F38 | AUDIT A7f split into capability + implementation | Resolves the "A7f silently lost mechanism-level signal" failure mode |
| F39 | "Orchestrate, don't reinvent" promoted to Section 3 load-bearing principle | Was implicit (D-003, F32); now mandatory on every tool decision |
| F40 | D-001 addendum clarifying strategic-Reject ≠ mechanism-Reject | See decision-log entry |

### Rejected on user review

| # | Title | Verdict | Logged in |
|---|---|---|---|
| F35 | Sharded rules files with frontmatter scope (Cursor `.mdc` borrow) — strongest single Adopt from dogfood (5-of-9 tool convergence) | **Reject** — Joe applied higher-order filter on user review: *"not sure why anyone would deviate from a single rules file."* Convergence across tools ≠ Adopt for Bob's target user. Now the canonical example of the bias-toward-Reject principle: the mechanism scan correctly surfaced it; the human filter correctly rejected it. | D-004 |

### Deferred from v2.16

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F41 | `.claude-ignore` companion file convention (Roo `.rooignore` borrow) | L | Lightweight Adopt; previously gated on F35 but that dependency dissolved when F35 was Rejected. Standalone value: excluding generated artifacts (audit reports, screenshots) from Claude's working context. Defer for now until at least one user reports artifact-pollution friction. | First PR-back citing context pollution from generated files |
| F42 | Frontmatter-tagged templates as named slash commands (Continue `.prompt` borrow) | L | Bob's `templates/` folder could be wrapped with `name`/`description`/`invokable` frontmatter so they become first-class slash commands. Lightweight; defer until at least one user reports template-discovery friction. | First PR-back citing template invocation friction |
| F43 | Explicit handoff prompts in protocol prose (BMad borrow) | L | A7.0 hardening scope map already implies the next-session priming; adding the literal "paste this to start A7b" block would reduce friction. Lightweight prose change, bundle with next AUDIT pass. | Next AUDIT pass |
| F44 | Branched plan versioning (Plandex borrow) | L | No clear pain today; Build Manifest + decision-log carry the equivalent. | First user report of plan-history churn |
| F45 | Recipe YAML for hardening audits (goose borrow) | L | Per D-003, Bob stays markdown-only. Revisit if Bob ever needs to run unattended in CI. | First real ask for Bob to run unattended |

### Informational

| # | Note |
|---|---|
| F46 | Dogfood meta-finding from the v2.16 A7f-implementation scan: **3 Adopts per 9 tools scanned (~33% hit rate) is the realistic high end**. The protocol prose now mandates bias-toward-Reject because, without it, the step degrades into a perpetual maybe-pile. This is the canonical reference for "scan should produce closure, not aspiration." Future scans that produce >50% Adopt rates should be re-run with stricter filtering — reference this finding in the re-run prompt. |
| F47 | The "do (b) first, then (a)" sequencing — dogfood the proposed step before mandating it — is itself a meta-pattern worth naming. When proposing a new audit step in future EVOLVE passes, run the proposed step on Bob first and let the dogfood meta-finding shape the prose. v2.16 is the canonical instance of this pattern; reference when proposing future audit additions. |

---

## EVOLVE pass — v2.15 (2026-05-20) — close v2.14 deferred items

**Trigger:** User challenge — "why not do the deferred items now?" Honest review: F26 was the actual fix for the failure mode v2.14 existed to address (per-phase Liveness catches dead functions the day they ship, not at next audit), F28 was trivial (10-line JSON spec addition), and F27 was reshapeable from a brittle cross-stack script into per-stack protocol prose that's strictly better.

**Changes shipped:**

- **F26 — Per-phase Liveness check (now Tier 1).** Added as step 3 in the Phase Gate enumeration (build-protocol.md §7 and build-protocol-core.md PHASE GATE). Scoped to phase deltas only (git diff vs prior phase tag). Same tool set as A7j but narrowed: only routes/functions/jobs/AI surfaces this phase touched. Stop condition if anything reachable returns 5xx. Skipped (with logged note in Phase Report) only if no runnable target OR phase touched no callable surface.
- **F27 reshaped — Per-stack auth-token recipes.** Added a table in `[N+1]j` covering Clerk, NextAuth/Auth.js, Supabase Auth, Auth0, custom JWT, and Rails/Django/Flask-Login session cookies. Tokens stash to `.env.test`. Pattern is "Claude detects auth provider during inventory, walks user through matching recipe, stashes token once." The original-shape F27 (a script) was rejected per D-003's no-reinvention stance.
- **F28 — `liveness-report.json` machine-readable output.** Both A7j and per-phase Liveness now write structured findings to `audit-artifacts/liveness-report-<timestamp>.json` alongside the markdown verdict table. Schema versioned (`schema_version: "1.0"`). Append-not-overwrite so diff-across-time works. Default `.gitignore` for `audit-artifacts/` unless user opts in.

**Order-of-operations note:** Per-phase Liveness (F26) is the more important of the three. v2.14 with only A7j would have caught the blood-test bug at the next audit; v2.15 catches it at phase verification. The latency between bug-shipped and bug-found shrinks from "weeks" to "minutes."

### Closed in v2.15

| # | Title | Notes |
|---|---|---|
| F26 | Per-phase Liveness check in Nb verification | Now Tier 1 Phase Gate step. Scoped to phase deltas. |
| F27 | Auth-token guidance (reshaped from script to per-stack recipes) | 6-stack table in `[N+1]j` |
| F28 | `liveness-report.json` machine-readable artifact | Versioned schema, append-not-overwrite |

### Deferred from v2.15

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F30 | A7j orchestration script (`bob-liveness.sh`) that detects stack and runs the right tool sweep with one command | L | Per D-003, Bob orchestrates via protocol prose, not custom tooling. Revisit only if external users report tool-orchestration friction as the biggest A7j pain point in PR-backs. | Multiple PR-back reports citing orchestration friction |
| F31 | History diff tooling on `liveness-report.json` (e.g., "since the last audit, 3 new surfaces went red") | L | The JSON shape now supports this; no consumer yet exists. Build when there's a second data point worth diffing. | After A7j has been run ≥3 times on the same project |

### Informational

| # | Note |
|---|---|
| F32 | F27's reshape — from "build a cross-stack script" to "per-stack recipes in protocol prose" — is the canonical example of how D-003 ("orchestrate, don't reinvent") applies to non-tool work too. The script would have been brittle (each auth provider's API surface drifts independently); the prose stays load-bearing because Claude reads it fresh each invocation and uses current docs. Reference this pattern when future deferred items tempt a custom-tool implementation. |

---

## EVOLVE pass — v2.14 (2026-05-20) — A7j Liveness Audit added

**Trigger:** User report — two functions in a downstream Bob-built product (Explain My Blood Test) implemented the previous day were silently broken on manual spot-check. Failure mode: static review and spec-match passed, but functions threw at first runtime invocation. Root cause: no A7 step actually executes code; every existing audit reads source and reasons about it.

**Change shipped:**

- **New audit step:** `[N+1]j Liveness Audit` (canonical playbook in NEW mode) and `A7j Liveness Audit` (scoped reference in AUDIT mode). Inserted after [N+1]e / A7e, before [N+1]f / A7f.
- **A7 categories restructured:** "two categories" → "three categories." Internal correctness now splits into *static* (A7a–A7e, read code) and *live* (A7j, run code).
- **A7.0 scope map updated:** new A7j row; new precondition rule ("if no runnable target, surface 'Liveness unverifiable' as the finding rather than skipping silently").
- **A7i updated:** A7j 5xx / function-throws findings are explicitly tagged as always-critical (they represent code that does not run at all).
- **Compact reference (build-protocol-core.md) updated:** N+1 sequence now includes Liveness; A7 description includes the third category.

**Tool selection (decision rationale captured in D-003):**
- Knip (JS/TS dead exports + inventory) — incumbent; ts-prune is effectively dead
- Vulture + Ruff + deptry (Python) — same job split across three tools because the Python ecosystem split them
- Schemathesis (HTTP fuzz from OpenAPI) — uncontested in its niche
- Playwright (browser flows) — settled vs Cypress in 2025–26
- Vitest / pytest (function-level smoke harness)
- promptfoo (LLM/AI surface smoke)

All have JSON reporters, all CLI-callable by Claude Code without human in the loop.

**Bob's stance:** orchestrate, don't reinvent. A7j is glue + triage + reporting on top of mature OSS tools.

### Closed in v2.14

| # | Title | Notes |
|---|---|---|
| F25 | A7j Liveness Audit added | Resolves blind spot where AUDIT could not catch silently-broken runtime code |

### Deferred from v2.14

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F26 | A7j as per-phase Nb verification step (not just A7) | M | Higher-impact change — would catch dead functions the day they ship, not weeks later. Deferred to keep v2.14 surgical. | Next AUDIT pass on Bob, OR after first real user runs A7j and reports back |
| F27 | A7j auth-token bootstrap helper (script that generates `.env.test` token from project config) | L | Today users have to provide a test-user token manually. Tooling that auto-generates it would be useful but not blocking. | If multiple PR-back reports cite auth-token setup as friction |
| F28 | A7j writes findings into a structured `liveness-report.json` artifact | L | Currently the verdict table is markdown only. A machine-readable artifact would let downstream tools / CI consume A7j output. | When A7j is run more than ~3 times by external users |

### Informational

| # | Note |
|---|---|
| F29 | A7j is the first A7 audit that has a hard precondition (runnable target). Surfacing "Liveness unverifiable" as a *first-class finding* rather than skipping silently is deliberate — it makes the gap visible instead of papering over it, same pattern as A7g's stop condition for missing success metrics (v2.13 F17). |

---

## Audit pass — v2.13 (2026-05-20)

**Auditor:** Fresh Claude Opus session, no involvement in v2.10–v2.12 authoring.
**Scope:** Full A1–A7 (incl. A7f/g/h External Fit & Value audits).
**Total findings:** 24 — 16 Adopt, 5 Defer, 2 Reject, 1 informational.

### Closed in v2.13 (Adopts shipped)

| # | Title | Milestone |
|---|---|---|
| F1 | `update bob` symlink preflight | M2 |
| F2 | bob-init.sh git config preflight | M2 |
| F3 | README prerequisite section | M1 |
| F4 | Install one-liner idempotent | M1 |
| F5 | Supply-chain CI (shellcheck + smoke tests) | M5 |
| F6 | Branch protection (Option A) applied via Rulesets API: no force-push, no deletion on `main`; no update, no deletion on `v*` tags. Signed commits deferred (see checklist below). | M5 + post-ship |
| F7 | CTM template file | M4 |
| F8 | CTM H / H++ hardening column in template | M4 |
| F11 | AGENTS.md scaffold in bob-init | M4 |
| F15 | bob-stats.sh + multi-location PR-back + parallel channel | M6 |
| F16 | CLAUDE.md self-effectiveness rephrase | M3 |
| F17 | A7g stop condition as first-class finding | M3 |
| F18 | README Terminal/git/xcode preflight | M1 |
| F19 | Step 2 worked example extended to all 7 sections | M3 |
| F21 | Step [N+2]d Closing Checkpoint Summary template | M3 |
| F22 | This audit-log.md file | M7 |

### Deferred (revisit at next audit)

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F9 | README "eight separate audits before ship" implies all 8 always run; protocol actually defers most via A7.0 scope map | L | Cosmetic; no signal yet that this misleads real users | If a user reports confusion in a PR-back or issue |
| F10 | README "Fallback — no install" path doesn't set up symlink, doesn't enable `/bob`, doesn't enable `update bob` — silently degraded experience | L | Fallback is a v2.6 escape hatch; primary install path is the recommended one and the README correctly leads with it | If we ever see fallback-mode usage become common |
| F12 | Cursor / Codex / Copilot now have native plan modes that overlap Bob's plan-mode mandate at Step [N]a; positioning may need a rethink | L | Strategic, not tactical. Bob's depth (spec → behavior → arch → domain + audit modes) is the durable differentiation, not plan mode | When one of those tools ships an external-fit-style audit step |
| F20 | Streamlined startup proposes a complexity classification the user can't meaningfully push back on | L | Trade-off accepted: hiding the classification loses signal value, surfacing it creates a small friction the user can't act on | If users ever ask to change it |
| F24 | v2.12 SECURITY.md "user-side pinning" instructions buried in prose; cautious adopters unlikely to find them | L | Pinning is opt-in by design; making it more prominent risks signaling that the default install is unsafe (it isn't) | If a security incident makes pinning a higher-priority default |

### Informational

| # | Note |
|---|---|
| F14 | Verdicts from the v2.10 → v2.11 → v2.12 audit chain all held under re-inspection. Implementation bias did not produce bad Adopts; the failure mode of that chain was *what got missed*, not *what got shipped*. |

### F6 — branch & tag protection (status)

**Applied via Rulesets API (2026-05-20):**

- [x] **Ruleset `main-no-force-push-no-delete`** (id 16664976) — `non_fast_forward` + `deletion` rules on `refs/heads/main`. Bypass: never. Solo-dev direct-to-main commits still allowed; history cannot be rewritten or branch deleted.
- [x] **Ruleset `tag-v-no-update-no-delete`** (id 16664978) — `update` + `deletion` rules on `refs/tags/v*`. Released tags cannot be moved or removed.

**Deferred:**

- [ ] **Require status checks to pass before merging** — not applied. Solo-dev direct-to-main pattern means commits often need to land before CI catches an issue (Joe's CLAUDE.md: "Push is pre-authorized; changes can't be evaluated until live"). CI failures will still surface via the GitHub UI; chose ergonomics over strict gating.
- [ ] **Require pull request reviews** — skipped, incompatible with solo-dev direct-to-main pattern.
- [ ] **Require signed commits** — deferred. Needs Joe to set up GPG/SSH commit signing first; recommended but not zero-effort.

Document any future decision to skip or revisit any of these in `decision-log.md` so it doesn't get re-litigated next audit.

---

## How to use this log

- Every AUDIT pass appends a section at the top with: closed items, deferred items, informational notes, and any user-action checklist.
- Deferred items stay in the log until they're either closed in a release (move to the closed section of that release's entry) or formally Rejected (move to `decision-log.md`).
- Reference the audit-log from A7i prose so future audits actually find this file.
