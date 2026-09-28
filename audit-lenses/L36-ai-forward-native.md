---
id: L36
name: AI-Forward / AI-Native
band: 3
band_name: AI Behavior
when_to_run: Every product, at spec time and at any major-version planning. The assistant running Bob is itself an AI and must bring AI-native capability to the table unprompted. Especially load-bearing when the spec was authored as a "feature list" rather than around an AI core.
estimated_duration: 30-60 min — generative + comparative reasoning
session_pattern: fresh session; reads the Product Spec + Architecture Contract; biases toward proposing, not just grading
output_markdown: audit-artifacts/L36-ai-forward-native-{YYYY-MM-DD}.md
output_json: audit-artifacts/L36-ai-forward-native-{YYYY-MM-DD}.json
source_frameworks:
  - Rule 19 (Build Protocol v2.27) — AI-forward by default
  - Anthropic/Claude capability surface (agents, tool-use, structured generation, long context, embeddings/RAG, computer-use, MCP) — verify current specifics via the claude-api skill
  - Origin case — the InsiderIntent build (an excellent but pre-LLM-shaped spec until AI-native pieces were forced in)
---

# L36 — AI-Forward / AI-Native

## Question this lens answers

*Is this product built AROUND an AI core — or is it a spec a great **pre-LLM** product manager would have written, with AI bolted on?* The most common miss for a capable team (and for an AI assistant that pattern-matches to "good PM specs") is to produce a competent, conventional product and never ask what becomes possible *because* modern AI exists. This lens forces the AI-native reframe.

## Why this lens exists / what other lenses miss

L11–L14 evaluate whether the AI you *have* is accurate, right-sized, safe, and efficient. None of them ask the prior, bigger question: **are you using AI ambitiously enough — or at all in the places that matter?** A spec can pass every AI-behavior lens while being fundamentally un-ambitious about AI: a CRUD app with a chatbot stapled on, a dashboard that could have been a conversation, a manual workflow that an agent could run, a fixed feature set where a self-improving loop belonged.

The bias this counters is specific and was observed directly in the origin build: **the assistant produced a spec a world-class *pre-LLM* PM would be proud of, and the human had to ask "what about this screams AI-first?"** That ask should never be the human's job — the assistant *is* the AI. L36 makes "bring the AI-native version unprompted" a checklist instead of a hope.

Distinct from neighbors: L12 (Right-Sizing) asks "is this the *right model/size* for the task you chose"; L36 asks "did you choose the *right task* given what AI can now do." L32 (Method Soundness) asks "is the method valid"; L36 asks "is there an AI-native method you didn't consider." L28/L35 protect the edge; L36 asks whether AI *is* the edge and isn't being left on the table.

## When this lens fires

- ✅ **Always, at spec time** — every product. (It is cheap and the default-miss is expensive.)
- ✅ **Mandatory** — when the spec reads as a conventional feature list, a CRUD/dashboard product, or a workflow tool; when "AI" appears only as one feature; or at any major-version planning.
- ⏸ **Skip** — only genuinely AI-irrelevant products (and even then, note why).

## Audit method (bias toward PROPOSING, not grading)

1. **State the AI thesis in one sentence.** What is AI's *load-bearing* role here? If the honest answer is "it has a chatbot" or "AI is one feature," that's the finding — AI is decorative, not structural.

2. **Run the AI-native reframe across the product surface.** For each major capability/screen/workflow, ask the five AI-native questions:
   - **Conversation over UI** — could this rigid form/dashboard/navigation be a natural-language interaction or an MCP/agent surface the user drives in plain language?
   - **Agent over manual workflow** — is the user doing multi-step work an agent (plan → tool-use → verify) could do for them?
   - **Generation over configuration** — is the user assembling/configuring something the system could *generate* from intent (theses, layouts, queries, content, code)?
   - **Semantic over keyword/structured** — are there search/match/dedup/recommendation steps that embeddings/RAG would make dramatically better?
   - **Self-improving over static** — is there a discovery → test → learn → evolve loop, an eval-driven improvement cycle, or a knowledge corpus that should *compound* — instead of a fixed feature that never gets smarter?

3. **Inventory the modern AI capability surface and map it to opportunities.** Tool-use/function-calling, structured/JSON generation, long-context synthesis, multimodal, embeddings/vector retrieval, agents & orchestration, computer-use, MCP integrations, eval-driven development, fine-tuning/distillation where warranted. For each: is there a high-value use here the spec missed? *(Verify current model/capability/pricing specifics with the `claude-api` skill — don't assert from memory.)*

4. **Check the AI-native infrastructure posture.** Is the architecture built for an AI core — eval harness in CI, prompt/version management, cost-per-call tracking + caching, structured-output validation, a retrieval/memory layer, agent observability/tracing, guardrails at the right layer (Rule 15)? Or is AI a side-effecting call bolted onto a conventional stack?

5. **The "10× with AI" prompt.** If you removed the constraint that this had to look like existing products in the category, what would the *AI-native-first* version do that no pre-LLM product could? Name it. This is where the differentiated, AI-forward wedge usually hides.

6. **Reverse check — don't force AI where it doesn't belong.** Flag anywhere AI is used for show, adds latency/cost/unreliability over a deterministic solution, or where "agentic" is riskier than a simple form. AI-forward ≠ AI-everywhere; it's AI where it's load-bearing.

## Check questions

1. State AI's load-bearing role in one sentence. Is it structural or decorative?
2. Which rigid UI/workflow/config surfaces should be conversation / agent / generation instead?
3. What multi-step manual work here could an agent (plan→tool-use→verify) own end-to-end?
4. Where would embeddings/RAG/semantic retrieval beat the keyword/structured approach the spec assumes?
5. Is there a *self-improving / compounding* loop, or is every capability static?
6. Which modern AI capabilities (tool-use, structured gen, long-context, multimodal, MCP, eval-driven dev) are high-value here and absent from the spec?
7. Is the infrastructure AI-native (evals-in-CI, prompt/version mgmt, cost tracking + caching, structured-output validation, retrieval/memory, agent tracing)?
8. The 10× test: what would the AI-native-first version do that no pre-LLM product in this category could?
9. Did we (the AI assistant) bring the AI-forward version *unprompted*, or did we produce a great pre-LLM PM's spec?
10. Reverse check: where is AI decorative / latency-adding / less reliable than a deterministic path — and should be removed?

## Output schema

### Markdown report
```markdown
# L36 — AI-Forward / AI-Native — {YYYY-MM-DD}
## AI thesis (one sentence) — structural or decorative?
## AI-native reframe (per surface)
| Surface / capability | Current (conventional) | AI-native version | Value | Effort | Recommend? |
## Modern-capability opportunity map
| Capability (tool-use / RAG / agent / structured-gen / multimodal / MCP / eval-driven / self-improving) | High-value use here? | In spec? |
## AI-native infrastructure posture
## The 10×-with-AI version (the AI-forward wedge)
## Reverse check — where AI is decorative / harmful (remove)
## Findings (numbered, severity-tagged, JSON-mirrored)
```

### JSON sidecar
```json
{
  "lens_id": "L36",
  "lens_name": "AI-Forward / AI-Native",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "ai_thesis": "{one sentence}",
  "ai_role": "structural|decorative|absent",
  "native_reframes": [],
  "capability_gaps": [],
  "infra_native_score": "native|partial|bolted-on",
  "ten_x_version": "{the AI-forward wedge}",
  "decorative_ai_to_remove": [],
  "findings": [
    {"id": "L36-F001", "severity": "critical|major|minor|cosmetic",
     "category": "ai_decorative|conventional_ui_should_be_conversational|manual_should_be_agentic|static_should_be_self_improving|missing_capability|bolted_on_infra|forced_ai",
     "title": "{short}", "opportunity": "{the AI-native version}", "recommendation": "{specific}"}
  ]
}
```

## Severity rubric
- **Critical** — AI is decorative/absent in a product that should be AI-native; the spec is a pre-LLM product with AI stapled on; a self-improving/agentic/generative core was the obvious wedge and is missing entirely.
- **Major** — significant AI-native opportunities unexploited (key workflows should be agentic; key surfaces should be conversational; embeddings/RAG/eval-driven-dev missing where high-value); infrastructure is bolted-on not native.
- **Minor** — incremental AI-native upgrades available; some surfaces could be smarter.
- **Cosmetic** — already strongly AI-native; polish opportunities.

## Anti-patterns / Bias instructions
- **Bias toward proposing the bold AI-native version**, not cataloguing what exists. This lens generates the reframe the human shouldn't have to ask for.
- **Verify capability/model/pricing facts with the `claude-api` skill** — never assert current model names, context windows, or prices from memory.
- **AI-forward ≠ AI-everywhere.** Run the reverse check honestly; deterministic is often right. Forcing agents/LLM-calls where a form suffices is its own failure mode.
- **Don't confuse "uses an LLM" with "AI-native."** A CRUD app calling an LLM once is not AI-forward. The test is whether AI is *load-bearing and structural* — does the product's core value depend on capabilities only modern AI provides?
- **Tie opportunities to the wedge (L28/L35).** The strongest AI-native finding is usually also the differentiation: the thing no pre-LLM competitor can do.

## Stop conditions
1. **Genuinely AI-irrelevant product** (a deterministic utility, infra primitive). Note why and skip.
2. **Already AI-native and ambitious** — run forward-looking: what's the *next* AI capability to adopt as the frontier moves (Rule 19 + the frontier-tracker pattern).

## Cross-lens handoff
- **Upstream:** L02 (declared intent), L12 (right-sizing), L32 (method soundness).
- **Downstream:** findings feed the Product Spec (new AI-native capabilities), the Architecture Contract (AI-native infra), and L28/L35 (the AI-native wedge).
- **Adjacent ~15% overlap:** L12 (model fit — but L36 questions the *task*, not the model); L11/L13 (the AI you have — L36 asks if you're ambitious enough about AI at all).
