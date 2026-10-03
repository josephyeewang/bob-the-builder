# Evidence Accounting — What the Audit Never Looked At

> **Cross-cutting companion, like `_execution-principle.md`.** That file answers *"did Claude run the check or just read the code?"* This one answers the question underneath it: **"which checks never ran at all, and does the report say so?"**
>
> An audit reports what it found. It does not, by default, report what it never looked at — and those two absences read identically in the output. A clean section means "we looked and it was fine" *or* "no agent was ever assigned here," and nothing in a normal report distinguishes them. This file is the machinery that makes the difference visible.
>
> **Origin:** harvested Sept 2026 from Cloudflare's open-source `security-audit` skill (MIT, github.com/cloudflare/security-audit-skill), plus the false-positive precedents in `anthropics/claude-code-security-review` (MIT). Roughly 60–70% of that skill restates OWASP/STRIDE/CWE, which L04 already carries. The 30% harvested here is not a checklist — it is an accounting system, and it is **not security-specific**. It belongs to every lens that can silently under-run.

---

## 0. Why this is a Bob-level concern, not a security detail

This is Principle 7 (*Green ≠ Correct*) pointed at the audit itself.

Principle 7 says a passing test suite verifies known-incident classes and syntactic success, not semantic correctness. Rule 30 (tiered definition of done) says Tier-1 work exits only after a fresh-context audit reports zero Material findings. **Both assume the audit covered the ground.** Neither has a mechanism that fails loudly when it didn't.

The exact defect class Joe has hit repeatedly in data work — a 100%-null column read as "no signal," a collapse key that silently blended distinct entities — has the same shape here: *an absence presented as a result*. A lens that ran four of its fourteen check questions and reported no findings is the audit-layer version of the dead axis.

Cloudflare's published run is the empirical anchor: **20,799 raw candidates → 7,245 actionable findings across 128 repositories**, with the share of raw candidates thrown out at first validation falling **40% → 11%** (Cloudflare credits better context from their Recon phase for that — it is a candidate-quality number, not a rate of real bugs wrongly dismissed; corrected 2026-10-03 against the source blog), and one ~30k-line repository going from first look to opened pull request in **14 hours**. Their own reported figure for why one pass is not enough: *"a single run found roughly half of the vulnerabilities that repeated runs found in total."*

**One pass is about 50% coverage.** Plan accordingly, and never let a single clean run stand as proof of anything but that pass.

---

## 1. The coverage record — the load-bearing mechanism

Before hunting starts, write down every area that *should* be examined, as a list of units. Each unit gets an ID and exactly one state, updated as the run proceeds:

| State | Meaning |
|---|---|
| `planned` | Should be checked. Nobody has started. |
| `in_progress` | Assigned to an agent right now. |
| `covered` | Checked, with named files and named checks, nothing unresolved. |
| `candidate` | Checked, and something came out of it that still needs validating. |
| `blocked` | Partially checked; a specific fact is missing. The blocker is written down. |
| `deferred` | Consciously not reached this run, **with the reason recorded.** |
| `out_of_scope` | Deliberately excluded up front. |

A unit is a stable combination of *surface × boundary × subsystem × check-class* — stable enough that the next run can match against it rather than re-inventing the map.

**Three rules that make it work, and without which it is decoration:**

1. **Only the coordinating session writes the record.** Sub-agents return results; they never edit the shared file. One writer, no merge races. (Same discipline as `templates/scheduled-work-protocol.md` §2.)
2. **`covered` requires evidence attached** — the specific files read and the specific checks made. A unit cannot be closed by assertion.
3. **Unreached units become `deferred` with a reason — never silently dropped, and never quietly folded into a `covered` count.** Cloudflare's rule, verbatim: *"Untouched budget/profile units become unassigned deferred units with empty evidence and a reason; do not hide partial evidence in deferred."*

The payoff is one sentence at the end of every audit that most audits cannot produce: **"Here is what we checked, here is what we did not check, and here is why."**

### The closing coverage statement (mandatory)

Every lens report gains a section that states, in plain language:

- how many units were planned, covered, deferred, blocked and out of scope;
- what was deliberately not looked at, and why;
- whether a prior run's ledger existed — and if not, that this is a first pass and therefore partial.

Never imply that one run exhausts the target.

---

## 2. The third verdict — "needs checking," and it gets no severity

Most lenses have two outcomes: a finding, or nothing. That forces every uncertain observation into one of two lies — inflated into a low-confidence finding, or dropped.

Add a third: **needs checking** (`needs_validation`), for when the deciding fact is real but not visible from here — a hosting setting, a proxy behavior, an identity-provider policy, a vendor's internal configuration, a value only the live environment holds.

Rules:

- It names **the exact missing fact**, not a vague doubt.
- It carries **a safe way to find out** — a bounded local check, or something the owner can observe without probing production.
- **It never gets a severity score.** Severity is a statement about a demonstrated result. An unresolved question has no demonstrated result, and scoring it launders uncertainty into false precision.
- It is **not** a low-confidence finding, and a candidate *disproved* by the source is not "needs checking" — it is rejected.

This maps directly onto the Material / Minor / Cosmetic triage in Rule 30: **"needs checking" is a fourth bucket that does not block done, but must be listed** — because an unresolved question that never surfaces is indistinguishable from a question nobody asked.

---

## 3. The checker is never the finder — twice

Bob's fresh-context rule (Rule 30) already says the auditor must not be the builder. This sharpens it at the level of the individual finding:

1. **Refutation pass.** Every candidate goes to a *fresh* agent whose instruction is to **disprove it** from the source — not to "review" it. The framing matters: "verify this" and "try to break this" produce measurably different results. Cloudflare's prompt language: *"You did not write this candidate. Try to refute it from repository source."*
2. **Independent record check.** After the findings are written up, a *second, separate* fresh agent verifies the final written claims against the source. If it materially replaces a claim, that replacement goes through the loop again.

The cost is real — roughly one to two extra agent calls per surviving finding — which is exactly why §4 exists.

**This is the single highest-value item in this file** — it is what keeps unconfirmed findings away from a human. *(Correction 2026-10-03: an earlier version said this refutation pass was "the mechanism behind the 40% → 11% wrong-rejection improvement." Cloudflare's blog says otherwise: 40% → 11% is the first-stage rejection rate of raw candidates, and they attribute the drop to better Recon context, not to refutation. The refutation pass stands on its own logic; it has no published number of its own. Measure it against our ledger.)*

---

## 4. Reserve the verification budget before starting — never thin evidence silently

The failure this prevents is subtle and common: a run that is going long quietly does fewer verification passes, reports the same way, and nobody can tell.

Before any agent launches, reserve, in this order:

1. the reconnaissance calls (mapping the ground),
2. **the gap-critic calls** (§5) — one after each wave, plus one final,
3. **the verification calls** (§3) — roughly 1–2 per expected finding; when unsure, hold back ~30% of what remains.

Hunters get what's left. **Never assign hunting work into either reserve.**

**If the budget cannot fund reconnaissance plus the reserves, launch nothing.** Say so, mark the run incomplete with the reason, and ask for more budget, a narrower scope, or a shallower profile. A run that cannot verify its own findings should not produce findings.

If verification budget runs out mid-run: stop hunting, verify what you can in a stable order, and keep every unverified item visibly unresolved. **Do not promote an unverified candidate into the findings list, and do not relabel it "needs checking" to make it look handled.**

> **Bob's version of the strict rule:** never exceed a stated budget silently, and never *shrink the evidence* silently to fit one.

---

## 5. The gap critic — an agent whose only job is what's missing

After each wave of work, one fresh agent reads the coverage record and the architecture map and returns **only**:

- units that should exist and don't,
- units that were closed without real evidence and need reassigning,
- prior unresolved items nothing is currently addressing,
- whether it believes the run is complete.

**It proposes coverage, never findings.** That constraint is what keeps it useful — a critic allowed to report findings starts hunting and stops auditing the hunt.

Loop until a clean pass. Then run one *final* critic, separately reserved, and only treat coverage as complete when that one also returns nothing.

> **Never use "we ran out of waves" or "we hit the agent cap" as evidence of complete coverage.** An early stop is an early stop; mark the untouched units `deferred` and disclose the gap in the report.

---

## 6. Two deliberately un-clever hunters

A taxonomy-driven audit has blind spots shaped exactly like its own taxonomy. L04 walks STRIDE and OWASP; anything that isn't a STRIDE category or an OWASP row is structurally invisible to it. Two cheap agents fix most of that:

- **The wildcard.** Given no category at all. Its brief is literally: *what is the strangest code in this codebase? What do the tests conspicuously not test?* No checklist, no rubric.
- **The literalist.** Runs a flat, boring, mechanical checklist end to end. As Cloudflare puts it: *"This agent does not need to be creative. It needs to be thorough and literal."*

They cost two agent calls and they catch different things than every other agent in the run. Include both in any Full-Enchilada panel.

---

## 7. Running untrusted code — the fail-closed contract

Any lens that *executes* target code (which `_execution-principle.md` actively pushes toward) is running code the audit does not trust, on Joe's machine. That needs a contract, not good intentions:

- no outside network access;
- a clean, minimal environment — never the ambient one, and never the real credentials;
- the target and tools mounted read-only; writes confined to one scratch directory;
- explicit, low limits on processor, memory, file size, disk and wall-clock — on *every* check, not just the ones expected to be expensive;
- dummy accounts and dummy data only; never production identities, never live endpoints, never paid quota;
- stop at the **smallest** result that settles the question — never extend a check into anything destructive or persistent.

**The rule that makes it a contract:** *if every control cannot be enforced, do not execute the code.* Record the missing capability as "needs checking" with a safe alternative plan. Do not run it anyway with a note.

This matters more than it looks: audits often run on a machine that also holds other work, live credentials and synced configuration. The blast radius of a careless audit is the whole setup.

---

## 8. Audits stack — read the prior run before planning this one

Because one pass is ~50%, runs must compound rather than repeat:

- Read every prior coverage record and findings file **before** planning.
- A prior "confirmed" finding carries forward **only if the relevant source is genuinely unchanged** — and it still goes through this run's verification path. *A prior source reference alone is not evidence that a path is unchanged.*
- Prior `needs_validation`, `deferred`, `blocked` and any changed-source unit become **current work**. These states never suppress a current unit.
- A prior `rejected` claim suppresses only that exact unchanged claim — not coverage of its area.
- A prior narrow or quick run contributes its evidence and its gaps, **never an implied "the rest was fine."**

This is what makes the audit ledger (Rule 30's scorekeeping) load-bearing rather than ceremonial: the ledger is how run *N+1* knows what run *N* actually covered.

---

## 9. Anti-patterns — reject these on sight

Cloudflare's list, with their first two aimed squarely at framework-grounded lenses like L04:

1. **Checklist deviations presented as vulnerabilities.** "ASVS says X and we don't do X" is not a finding. A finding needs a crossed boundary and a real consequence.
2. **Defense-in-depth advice with no reachable violation.** Hardening is a separate, clearly-labeled output — not a finding.
3. Testing against live or shared environments where a bounded local check would do.
4. Guessing hosting, proxy, browser, identity or deployment behavior not present in the source. (Use "needs checking.")
5. Treating a user's own authority over their own data as a boundary crossing.
6. Reporting an effect stronger than the one actually observed.
7. Prose-only results that cannot be deduplicated or verified.
8. Assigning severity to a "needs checking" item.
9. Writing the report before independent verification, or letting the prose and the structured data disagree.

### The false-positive precedents (from `anthropics/claude-code-security-review`)

Empirically-tuned judgments no framework gives you. Verbatim samples worth keeping:

- *"UUIDs can be assumed to be unguessable."*
- *"Environment variables and CLI flags are trusted values."*
- *"React is generally secure against XSS… unless they are using unsafe methods."*
- *"SSRF is only a concern if it can control the host or protocol."*
- *"Including user-controlled content in AI system prompts is not a vulnerability."*
- Denial-of-service, rate limiting and resource exhaustion are **excluded** from pull-request-scope review as noise.

> **Note the genuine disagreement, and choose per context:** Anthropic hard-excludes denial-of-service and resource exhaustion; Cloudflare ships a whole companion file for that class. They are tuned for different jobs — Anthropic for suppressing noise on a single pull request, Cloudflare for whole-repository coverage. **For a Bob audit (whole product, pre-launch), follow Cloudflare and keep the class in.** For a diff-scoped review, follow Anthropic and drop it.

### One finding that argues against Bob's own D-003

Cloudflare wired Semgrep into their agent loop and published the result: *"Semgrep [was] plumbed all the way through, and the Hunters invoked it **zero times in a month of runs.**"*

D-003 ("orchestrate incumbent tooling, don't reinvent") is not overturned by this — scanners remain the right call for the deterministic sweep, and L04 should keep running them. But it is real evidence, from the largest published agent-audit run available, that **scanner orchestration is not the load-bearing part of an *agentic* audit**, and that an audit which counts "Semgrep ran clean" as coverage is counting the wrong thing. Treat scanner output as one unit in the coverage record, not as the coverage.

---

## 10. How this plugs into Bob

| Where | What changes |
|---|---|
| **Rule 30 / definition of done** | A Tier-1 audit is not done at "zero Material findings" — it is done at "zero Material findings **plus a coverage statement**." An audit that cannot say what it didn't check hasn't finished. |
| **L04 (Security)** | Loads this file. Its four under-covered attack classes are listed in the lens itself. |
| **L38 (Agent Setup & Extension Surface)** | New lens, added in the same harvest — see `L38-agent-setup-extension-surface.md`. |
| **Any Full-Enchilada panel** | Add the wildcard and the literalist (§6). Reserve critic + verification budget (§4) before assigning lenses. |
| **`audit-ledger.json`** | Gains coverage counts per run, so "five consecutive clean Tier-1 audits" means five *covered* audits, not five *quiet* ones. |
| **Data-heavy work (L31, L32, L37)** | §1 and §2 transfer directly: an un-run fidelity check and a check that found nothing are different results, and today they look the same. |

**Attribution:** mechanisms adapted from `cloudflare/security-audit-skill` and `anthropics/claude-code-security-review`, both MIT-licensed. Quoted lines are theirs; the framing, the Bob mappings and the plain-language rewrite are ours.
