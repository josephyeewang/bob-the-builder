# Execution Principle — Claude Should EXECUTE, Not Just READ

> **Cross-cutting principle applied to every lens in the library.** Bob's audits are run by Claude Code. Claude Code can drive Playwright, run scripts, query APIs, execute code, install tools, simulate user behavior, and observe results. Many lenses default to "read code and reason" when they could be "execute the code and observe." Execution catches what reading misses — race conditions, silent failures, broken UI states, real network behavior, real cost, real latency.
>
> v2.17.1 adds this principle as a load-bearing rule. Before running any lens, Claude reads this file to know what to EXECUTE vs READ vs delegate to HUMAN.

## Why this matters

The DLL audit (2026-05-23) found that memory decay engine "exists, exported, but `processMemoryDecay` never scheduled — will silently hit 500-record cap." That finding required *running* the code (or grep-ing the scheduler config), not just reading the function. Bob's v2.14 A7j Liveness Audit was the first lens to mandate execution over reading; v2.17.1 generalizes that principle to all 30 lenses.

The failure mode this principle prevents: *"I read the code and it looked correct."* If a check question is verifiable by execution and Claude relied only on code reading, the audit is incomplete.

## Three modes per check question

For every check question in every lens, classify the verification path:

- **EXECUTE** — Claude can directly verify by running a tool, executing code, driving Playwright, querying an API, or simulating user behavior. **Bias toward this mode.** Execution evidence > reasoning inference.
- **READ** — Claude verifies by reading source / docs / configs. Some questions are inherently static and cannot be executed (e.g., is the threat model documented?).
- **HUMAN** — Verification requires human judgment, perception, or external action: subjective UX response, brand voice intuition, talking to a real customer, real-device testing where emulators miss things. Minimize but accept where genuine.

A lens that has only READ-mode checks is suspect. Re-examine each READ check: could Claude EXECUTE it instead?

## Per-lens execution catalog

This table names, for each lens, what Claude should be doing. When running a lens, read this row + the lens file. Aim to execute everything in the EXECUTE column before falling back to READ or HUMAN.

| Lens | EXECUTE (Claude runs / drives) | READ (Claude inspects) | HUMAN (genuine human needed) |
|---|---|---|---|
| **L01 Hygiene & Liveness** | Knip / Vulture / Ruff / deptry (dead code); Schemathesis (HTTP fuzz); Playwright (browser flows + the **live deployed URL** after any build-config/routing change, q13); Vitest / pytest (functions); promptfoo (LLM surfaces); Semgrep + Gitleaks (overlap with L04/L06); `git log --since='<last audit date>'` to ground any "drift" claim in real commits | input validation patterns; secret-handling code; integration contracts | — |
| **L02 Spec Fidelity** | grep / AST queries for each capability reference; curl / CLI each user-facing capability to confirm wiring; check `evals/behavioral-core.yaml` coverage | Product Spec, Behavioral Core, Architecture Contract, Domain Specs end-to-end | strategic intent disputes (when spec is wrong, not code) |
| **L03 Critical Capability Quality** | drive each critical capability via UI / API / CLI; trigger failure modes (empty input, malformed, partial); observe actual behavior; measure error paths | code structure of each capability | A/B/C/D/F grading judgment requires reasoning |
| **L04 Security & Threat Surface** | Semgrep with security rulesets; CodeQL; Snyk Code; Gitleaks (full git history); Bandit; OWASP ZAP baseline scan; test specific attacks against each surface | threat model doc; ASVS chapter checks; business-logic vulns | — |
| **L05 Data Protection & Privacy** | Microsoft Presidio against DB samples + log samples; query DB for unredacted PII; test data-subject-rights endpoints (access, erasure) end-to-end | privacy policy; data-flow doc; consent UI | regulator-facing readability of policy |
| **L06 Supply Chain & Configuration** | Snyk test; OSV-Scanner; npm audit / pip-audit / cargo audit; Gitleaks; Trufflehog; Checkov; tfsec; ScanCode for licenses; `docker history` for image secret leakage | CI workflow pin status; SBOM presence; vendor health | vendor business-health judgment |
| **L07 UX Ease & Cognitive Path** | drive Playwright through the primary journey; capture screenshots at each step; check focus order, hover states, feedback timing programmatically; run Lighthouse a11y for adjacent signals | copy / labels / consistency across surfaces | subjective "would I be confused here?" judgment |
| **L08 UX Friction & Trust** | drive signup → cancel flow programmatically (FTC Click-to-Cancel compliance test); drive opt-in → opt-out programmatically; run grep for weasel-word patterns ("may," "up to," "in some cases"); check for confirmshaming copy patterns | dark-pattern instances in code; pricing flow code | "does this feel manipulative to a user?" judgment |
| **L09 UX Wow & Emotional Peaks** | drive Playwright through journey; capture screenshots + transcripts at each step (raw material for human peak-scoring); identify silent system actions via grep | journey map; brand voice doc | emotional intensity scoring; peak-vs-non-peak judgment is inherently subjective |
| **L10 UX Edge States & Recovery** | programmatically trigger every state: disable network (offline), throttle to 3G (slow), submit empty data (empty state), invalid input (errors), deny browser permissions, trigger backend 500, navigate to stale link (404), trigger AI timeout / refusal / malformed output via Playwright + DevTools | code paths for each state | recovery-path quality judgment |
| **L11 AI Accuracy & Calibration** | run `evals/behavioral-core.yaml` via promptfoo; run TruLens RAG triad on N≥20 samples; compute ECE on confidence buckets; run hallucination spot-check against ground truth | eval coverage matrix; judge-prompt calibration | ground-truth labeling on novel domains |
| **L12 AI Right-Sizing & Model Fit** | A/B test current model vs cheaper alternative on golden set (cost-per-quality measurement); attempt model swap via gateway and run smoke evals on fallback | model choice rationale in code; vendor-specific feature usage | "should this be AI vs deterministic?" strategic judgment |
| **L13 AI Interaction (HAX) & Safety** | Garak full probe suite; promptfoo redteam against actual prompts; PyRIT crescendo attacks (multi-turn); XSTest / OR-Bench subset (over-refusal); attempt system-prompt extraction via standard exfiltration prompts | HAX 18 guidelines coverage in UI; tool-use permission code | "does the AI interaction respect the user?" judgment on HAX guidelines |
| **L14 AI Cost & Latency Efficiency** | query Anthropic / OpenAI usage dashboards via API; measure cache hit rate live; benchmark token-bloat by removing 30% of prompt and re-running evals; measure p50/p95/p99 latency per endpoint via load test | client SDK config (caching enabled? batching?); prompt structure (static prefix first?) | — |
| **L15 Cost & Speed Drivers** | query infra billing APIs (Vercel, AWS Cost Explorer, etc.); query APM data (p50/p95/p99 via Datadog/Vercel Speed Insights); run Lighthouse on top pages; run load test if relevant | bill breakdown by category; APM dashboards | tradeoff-inversion judgment (where to *invest more* for value) |
| **L16 Effectiveness & Quality Drivers** | query analytics API (PostHog, Mixpanel, Amplitude) for feature usage + retention cohorts; run grep on top 50 support tickets for category patterns | declared success metrics | "is feature X driving the metric or is it the proxy?" causal judgment |
| **L17 Device & Form Factor** | Lighthouse mobile audit via CLI; Playwright across 375×667 / 768×1024 / 1280×800 viewports with screenshots; BrowserStack real-device runs if available; measure touch targets via Playwright + getBoundingClientRect | viewport meta tags; CSS breakpoints | real-device feel (rotation, edge taps, scroll behavior — emulators miss this) |
| **L18 Internationalization & Language** | run W3C i18n-checker on top pages; grep for hardcoded English strings; check HTML lang attributes; pseudo-localize all strings at 1.4× expansion and screenshot via Playwright (detect truncations); run `Intl.*` API check for date/number/currency formatting | translation file completeness; ICU MessageFormat usage | translator-facing context judgment |
| **L19 Accessibility (WCAG+)** | axe-core CLI / browser extension on top pages; Lighthouse a11y audit; Playwright keyboard-only walk (no mouse); programmatically measure color contrast via puppeteer; ARIA APG compliance via axe rules | WCAG 2.2 SC coverage; accessibility statement | screen-reader walk via NVDA / VoiceOver (Claude can't yet drive these reliably); cognitive accessibility reading-level requires human judgment in context |
| **L20 Shareability, Virality & Discoverability** | Meta Sharing Debugger via API; X Card Validator; LinkedIn Post Inspector; Google Rich Results Test API; programmatically render OG image at each platform's size; test attribution survival through redirect chain via curl | sitemap.xml + robots.txt; structured data JSON-LD | actually paste link into iMessage on real phone (web-based debuggers miss platform-specific bugs) |
| **L21 Observability & Incident Readiness** | trigger a synthetic incident (5xx endpoint, breaking change in staging) and time how long it takes ops dashboards to surface it; query log retention; verify alert firing via test signals; run a "fire drill" tabletop exercise via simulated incident | runbook completeness; SLO definitions | "is this enough signal at 3am?" judgment |
| **L22 Vendor & Dependency Risk** | attempt actual fallback swap on critical vendor in staging (e.g., swap from Anthropic to OpenAI via gateway and re-run smoke tests); measure RTO empirically | vendor SLAs; concentration risk; pricing trajectory | vendor business-health judgment (funding, layoffs — Claude can do web research but human judgment integrates) |
| **L23 Documentation & Onboardability** | run the cold-collaborator test by asking a fresh Claude session to set up + contribute (Claude can self-test docs by trying to use them); grep for stale references; check ENV vars docs vs code; run Diátaxis coverage check | code comment quality (sample); CLAUDE.md hygiene | "would a new dev actually be productive?" judgment |
| **L24 Competitive Benchmarking** | web-research competitor pages via WebFetch; build capability matrix programmatically; compare pricing pages side-by-side | competitor positioning copy; capability matrix | "is gap real differentiator or happen-to-have?" strategic judgment |
| **L25 Pricing & Monetization** | walk signup → trial → paid → upgrade → downgrade → cancel programmatically with test cards; test Click-to-Cancel compliance by measuring clicks-to-cancel vs clicks-to-signup; trigger dunning flow with declined card; test webhook idempotency with replayed events | pricing tier structure; receipt automation; vendor billing config | WTP testing requires real customer interviews; pricing strategy judgment |
| **L26 Marketing, Copy & Website** | run readability analyzer (Flesch-Kincaid) programmatically; grep for AI-slop signals ("delve," "tapestry," excessive em-dashes); SEO crawler for internal link graph; cross-surface contradiction sweep via NLP comparison of homepage/pricing/docs/blog claims | hero structure; CTA presence; trust signals | 5-second test on real strangers; voice consistency requires brand judgment |
| **L27 Persona Simulation** | drive Playwright through the product as different personas (Claude can adopt different "lenses" via system prompt — privacy paranoid, competitor power-user, etc.); capture screenshots + decision points per persona | Product Spec persona definitions; privacy policy (read as skeptic) | real persona research (talking to actual doctors, actual Notion power-users) — Claude can simulate but not replace |
| **L28 Strategic Edge & Wedge Sharpness** | grep last 10 features in git log + compare to competitor feature lists (convergence drift detection); WebFetch competitor positioning to compare hero copy | wedge articulation; anti-feature list; decision-log Rejects | "is our edge sharpening or dulling?" — strategic judgment dominates; minimal execution opportunity |
| **L29 Onboarding & Activation** | drive Playwright through signup → activation milestone, measure TTFV in ms; count clicks-to-value; query analytics API for activation rate + retention lift; trigger welcome email sequence and check open/click rates programmatically | activation milestone definition; first-screen empty state | "is the milestone the right milestone?" strategic judgment |
| **L30 Retention & Compounding Loops** | query analytics API for D1 / D7 / D30 / D90 retention cohorts; compute cohort half-life; measure k-factor empirically (signup attribution); query content loop output (UGC pages, organic acquisition share) | hook model presence per primary action; pause / win-back surfaces | "is this an actual network effect or aspiration?" — measurement helps, judgment integrates |

## Cross-lens design rule

When a check question can be expressed as either "is X true?" (READ) or "does Y happen when I do Z?" (EXECUTE), prefer the latter. Examples:

| Read-mode question | Execute-mode rephrasing |
|---|---|
| Is rate limiting enabled? | Send 200 requests in 1 second — what HTTP codes come back? |
| Does the empty state exist? | Drive Playwright to a known-empty list — screenshot. |
| Does Click-to-Cancel work? | Sign up + cancel via Playwright + Stripe test cards. Measure clicks. |
| Are touch targets ≥44px? | Run Playwright + `el.getBoundingClientRect()` over every interactive element. |
| Is prompt caching enabled? | Make 10 API calls with cache control + measure usage object's `cache_read_input_tokens`. |
| Is OG image correct? | curl the OG image URL, check dimensions + size + HTTPS + safe-zone via Sharp. |
| Does the welcome email send? | Sign up with a fresh email and inspect the inbox via IMAP / Mailtrap. |
| Are docs accurate? | Spawn a fresh Claude session, point it at the docs only, ask it to do a task, observe outcome. |

## When execution genuinely isn't possible

Three categories:

1. **Subjective UX judgment** — peak intensity (L09), brand voice (L08, L26), strategic conviction (L28), persona quit-point reasoning (L27). Use execution to *gather evidence* (screenshots, transcripts, journey traces), then human or Claude-reasoning scores it.
2. **Real-people-required signals** — WTP testing (L25), persona interviews (L27), screen-reader real-user testing (L19), real-device specific bugs (L17, L20). Execution can scaffold; humans complete.
3. **Causal judgment** — "is feature X driving the metric or is it the proxy?" (L16) — requires reasoning over data, not just data collection.

## Execution principle in practice

When Claude runs a lens, the lens prompt should be augmented with this sequence:

1. **Read** `audit-lenses/_execution-principle.md` (this file) and the relevant per-lens row in the catalog above
2. **Plan**: for each check question in the lens, classify as EXECUTE / READ / HUMAN
3. **Execute first**: run all EXECUTE-mode checks; capture evidence (tool output, screenshots, API responses)
4. **Read second**: do the READ-mode static analysis
5. **Mark HUMAN**: explicitly call out checks that require human follow-up
6. **Report**: findings cite their verification mode ("via Schemathesis run" / "via code reading" / "human walk required")

A finding with "via Schemathesis run" is materially stronger than "via code reading." The audit's overall confidence is bounded by how much of it was EXECUTE vs READ.

## Execution adherence gate (v2.19)

Having this catalog is not the same as honoring it. An EMBT Full Enchilada retro found ~8 lenses (L01, L02, L03, L14, L18, L21, L22, L24) **defaulted to Read even though their EXECUTE column says otherwise** — e.g., L18 asserted "95% English-hardcoded" without running the `lang=` grep that would ground it; L21 asserted "zero alert rules" without hitting the Sentry API. The catalog was right; adherence failed.

So every lens, before it finishes, runs an **adherence gate**:

1. List this lens's EXECUTE-column items (from the catalog row above).
2. For each, state **ran** (with the command/tool + a one-line result) or **skipped** (with why).
3. A skipped EXECUTE item that *could* have run is recorded in the `retro_fragment` as `executed_vs_read: "should_have_executed"` and noted as a stop-condition-adjacent caveat — the finding's confidence is downgraded accordingly.
4. **Any quantitative claim ("95% hardcoded," "zero alerts," "apiVersion missing") must cite the command that produced the number** — a grep count, an API response, a query result. A number without an execution behind it is a Read-mode guess and must be labeled as such or re-derived by executing.

This makes "I read the code and it looked correct" visible at the per-lens level instead of only surfacing later in the retro.

## Anti-pattern callouts

- **Do NOT skip execution on a check question whose answer can be executed.** "I read the code and it looked correct" is the failure mode this principle prevents.
- **Do NOT mark a lens "fully run" if EXECUTE-mode checks were not actually run.** If tooling couldn't be installed, name it as a stop condition.
- **Do NOT default to "manual human walk required" when Playwright could drive the journey.** Most UX walks are programmable; subjective scoring is the human-only part.
- **Do NOT confuse "Claude can read the test file" with "Claude ran the test."** Reading the test asserts what the test would test; running the test asserts what's true now.

## Updates to this catalog

When a new lens is added, update this catalog with its row. When a check question moves from READ to EXECUTE (e.g., a new tool ships that automates it), update the row. This file is the source of truth for what each lens should be DOING vs READING vs DELEGATING.

## See also

- `audit-lenses/README.md` — library index + per-lens links
- `audit-lenses/_selection-rubric.md` — how panels get picked
- `audit-lenses/_aggregation.md` — how findings get combined
- `audit-lenses/_audit-memory.md` — history-aware entry experience
- `build-protocol.md` §A7.1 — sequential lens execution
- Bob's D-003 — orchestrate, don't reinvent — execution principle is the natural consequence: orchestrate Claude's execution surface (Playwright, code-running, tool-driving) wherever possible
