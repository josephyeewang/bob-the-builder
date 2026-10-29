# APPENDIX G: ARCHITECTURE PATTERNS LIBRARY

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Reusable technical patterns extracted from past projects. Reference these during Step 3 (Architecture Contract) and Step 4 (Domain Specs). Not all patterns apply to every project — pick the ones relevant to yours.*

> **Maintenance note (v2.4):** Patterns G11+ cover newer or more domain-specific topics. The shape of these problems is stable; the specific tools/libraries cited (AI Gateway, Inngest, Manifest V3, Yjs, etc.) move fast. Verify current-state against the latest official docs before relying on specifics in a new project.

### G1. Normalized Input/Output Contracts (Multi-Surface Products)

If your product receives input from multiple surfaces (web, SMS, voice, email, API), define canonical message shapes that ALL surfaces must convert into before touching core logic.

```
[Surface A] → NormalizedInput → Core Logic → NormalizedOutput → [Delivery Channel]
[Surface B] → NormalizedInput → Core Logic → NormalizedOutput → [Delivery Channel]
```

**Why:** Lets you add new surfaces without changing core logic. Prevents surface-specific bugs from leaking into business logic.

**Enforcement:** Grep for provider-specific imports outside abstraction layers at every phase. Must be empty.

### G2. Orchestration as Single Entry Point

Define a single function that ALL inbound user actions pass through. API routes normalize input and call this function — they do NOT call business logic directly.

```
API route → normalize input → orchestrator → [capability/service/engine] → DB → output
```

**Why:** Ensures consistent behavior across all entry points. Makes it impossible for one surface to bypass validation or logging.

### G3. AI ↔ Logic Boundary (State Ownership)

```
AI layer:     Suggest structure, interpret intent, generate text
Logic layer:  Decide, enforce rules, validate, manage state transitions
DB layer:     Store truth
API layer:    Orchestrate the flow between layers
```

**Non-negotiable rules:**
- AI never writes to DB directly
- All state transitions are deterministic (not model-decided)
- All AI outputs are schema-validated (Zod or equivalent) before entering logic layer
- Raw AI output may NEVER reach business logic or database writes

### G4. Confidence → Behavior Matrix (AI Decision Products)

Map AI confidence scores to deterministic system behavior:

```
0.9–1.0   Near-certain    → Execute. Minimal confirmation.
0.7–0.89  Confident       → Execute and confirm. Show what was done.
0.5–0.69  Uncertain       → Execute best guess, flag uncertainty, invite correction.
0.3–0.49  Low             → Ask one targeted question. Do NOT execute.
0.0–0.29  Very low        → Ask for clarification. Do not act.
```

**Modifiers:** Memory context disambiguates (+0.1), high-risk action (deletion, financial) → always confirm regardless of score.

**Golden rule:** Prefer acting and confirming over asking and waiting. The undo path exists. The user's time is more valuable than perfect input.

### G5. Graceful Degradation

When critical systems fail, the user must never receive silence.

| Failure | User-Visible Behavior |
|---------|----------------------|
| AI model fails | "Got your message, but I'm having trouble. Try again shortly." |
| Messaging provider down (outbound) | Queue all messages. Deliver when recovered. |
| Database connection failure | "I'm temporarily unable to save that. Try again shortly." |
| Validation rejects AI output | "I couldn't understand that clearly. Can you try rephrasing?" |

**Non-negotiable:** Never confirm an action that didn't happen. Never send raw error details to users. Always log the failure.

### G6. Temporal Constants

Define all time-based thresholds as named constants, not magic numbers scattered through code.

```
CORRECTION_WINDOW_OPEN = 60        // seconds
CORRECTION_WINDOW_FADING = 300     // seconds
SESSION_TIMEOUT = 600              // seconds
DEDUP_WINDOW = 900                 // seconds
RECOMMENDATION_COOLDOWN = 2592000  // 30 days in seconds
MEMORY_DECAY_TO_STALE = 15552000   // 6 months
```

**Why:** Prevents temporal edge cases from being "fixed" inconsistently across the codebase.

### G7. Provider Abstraction Layer

For each external dependency that might change, create an abstraction:

```
/lib/[capability]/
  ├── types.ts         # Canonical interface
  ├── [provider].ts    # Provider-specific implementation
  └── index.ts         # Exports active provider (configurable)
```

**Pattern:** All provider-specific code lives inside the provider file. Core logic imports only from the types and index. Switching providers = writing a new provider file + changing the index export.

### G8. Tier-Based Feature Gating

Feature access is enforced in the **service layer**, not in AI capabilities or API routes. The check happens BEFORE capabilities execute.

```
Service layer: checkTierAccess(user, feature) → allow / deny / upgrade-prompt
```

**Why:** Deterministic enforcement. AI cannot accidentally grant access to paid features. No tier logic in prompts.

### G9. Audit Logging

Log all critical actions for observability and compliance:
- User actions (create, update, delete)
- Admin actions (config changes, overrides)
- AI-triggered actions (auto-created items, suggestions acted on)
- Security events (auth failures, rate limit hits, webhook rejections)

Schema: `{ id, user_id, event_type, actor_type, payload, created_at }`

### G10. Row-Level Security (Multi-Tenant)

If using Supabase or similar:
- Enable RLS on ALL user-data tables
- Policy: `auth.uid() = user_id` (or group membership check for shared data)
- Admin routes use service role key (bypasses RLS) — server-side only, never client-side
- System tables (config, definitions) = service role only

### G11. RAG Pipeline (v2.4)

For products that retrieve from a corpus to answer user questions.

- **Chunking strategy:** size + overlap depends on content (300-800 tokens typical; smaller for dense legal/finance, larger for narrative). Make this a decision-log entry, not a guess.
- **Embedding model choice:** pick one with a **migration plan**. Embedding models change; if you can't reindex, you're stuck. Wrap behind provider abstraction (G7).
- **Hybrid retrieval:** vector search alone misses keyword matches. Combine BM25 + vector + reranker (Cohere, Voyage) for production-grade recall.
- **Reranker:** non-negotiable for serious products. Cheap, large quality lift, no infra cost if hosted.
- **Reindexing:** when corpus updates or embedding model changes — design from day one. Incremental for steady-state, full-rebuild path for migrations.
- **"Not in corpus" UX:** explicit refusal beats hallucinated answers. Test for it in the eval set.
- **Eval (Step 2d):** retrieval recall@k on a held-out QA set; answer faithfulness (does the answer cite real chunks?); refusal accuracy.

### G12. Agent / Tool-Use Loop (v2.4)

For products where the AI calls tools (functions, APIs, MCP servers) to act, often over multiple steps.

- **Tool definitions are contracts.** Each tool needs a precise schema and a description that explains *when* to call it, not just *how*. Vague descriptions = wrong tool calls.
- **Max-step bound (mandatory).** Every agent loop has a hard cap (e.g., 10 steps) to prevent runaways and cost blowouts. Exceeding the cap returns a partial result + user notification, never silent failure.
- **Tool-call eval:** part of the eval set (Step 2d). For each user intent: did the agent pick the right tool, with the right args? Negative cases: "this should NOT call any tool."
- **Tool-failure handling:** for each tool, define the retry/abort/ask-user behavior. Don't let tools silently fail — agents that don't know tools failed give worse output than agents that admit failure.
- **Observability:** every tool call logged with input, output, latency, cost. Critical for debugging agent behavior in prod.
- **MCP wrapping:** if exposing tools via MCP, treat the MCP server as its own subsystem with a domain spec.
- **Common failure mode:** agent loops calling the same tool with the same args because it didn't get the answer it wanted. Detect with loop detection + early stop.

### G13. Background Job Architecture (v2.4)

For products with async work: scheduled jobs, queued tasks, webhooks-with-work, long-running operations.

- **Pick one orchestrator, abstract it.** Options: Inngest (event-driven, generous free), Trigger.dev (similar), Vercel Workflow (Vercel-native, durable), DB-backed queue (simplest, less powerful). Wrap behind G7 abstraction — you WILL switch eventually.
- **Idempotency is mandatory.** Every job has an idempotency key. Running twice = same result. Without this, retries duplicate charges/emails/whatever.
- **Retry policy:** exponential backoff, capped retries (3-5 typical), dead letter on final failure. Document the policy per job type.
- **Dead-letter handling:** failed jobs go somewhere visible. "Logs alert" is not a dead-letter strategy.
- **Concurrency limits:** per-user, per-tool, global. Prevents a single user spamming the queue and blocking everyone.
- **Observability:** job runs visible in a UI (Inngest/Trigger.dev give this free). Cost per job tracked.
- **Critical Architecture Decision** required when introducing the orchestrator (per Step [N]a) — answer the standard verification questions: server restart → pending jobs survive? two workers → no double-processing? failed jobs → retry with backoff? 3x-failed → dead letter?

### G14. Mobile App Considerations (v2.4 — Tier 3)

For native iOS/Android, React Native, Expo, or Flutter apps. Pattern is signposts, not a playbook — mobile has enough quirks to deserve its own protocol if you go deep.

- **Stack choice:** native (max performance, separate teams) vs RN (one codebase, JS ecosystem) vs Expo (RN + managed services, fastest path) vs Flutter (one codebase, custom rendering). For solo/Claude Code: Expo is the default unless you have a reason.
- **App store review prep:** budget 2-5 days for first submission, including assets (icons, screenshots, privacy nutrition label, data-collection disclosure). Apple is stricter than Google. First rejection is normal; second rejection is a process problem.
- **Push notifications:** provider choice (Expo Notifications, FCM, OneSignal); permissions UX (don't ask on first launch — earn it); user-controlled categories; deep-link routing on tap.
- **Offline behavior:** explicit decision — fully offline-first, offline-tolerant (queue actions, sync later), or online-only (with clear UX when disconnected). "Crash if no signal" is a real-world outcome of leaving this implicit.
- **OTA updates (Expo / RN):** what gets pushed OTA vs requires native binary update. Native code changes always require app-store resubmission.
- **Deep / universal links:** configure early; testing them retroactively is painful.
- **Common gotchas:** assumed permissions always granted; tokens stored in non-secure storage; analytics/crash reporting blocked by App Tracking Transparency on iOS; in-app purchases must use Apple/Google IAP for digital goods (15-30% fee).

### G15. Browser Extension (v2.4 — Tier 3)

For Chrome/Firefox/Edge/Safari extensions. The lifecycle is fundamentally different from a web app.

- **Manifest version:** MV3 is mandatory (Chrome killed MV2 by mid-2024). Background "service worker" replaces persistent background page — *it stops when idle*. Anything that needs to run continuously needs a workaround (alarms API, declarativeContent, etc.).
- **Boundary discipline:** content script (runs in page context, can access DOM) vs background service worker (runs in extension context, handles cross-origin) vs popup/options UI (separate context). Messaging between them is async; treat it like a subsystem boundary in your domain specs.
- **Permissions:** request the minimum — broad permissions delay/block store review. Optional permissions (request-at-use) are reviewed more favorably.
- **Storage:** `chrome.storage.local` (persistent, ~10MB) vs `chrome.storage.sync` (syncs across devices, smaller). Avoid `localStorage` in content scripts — different context, different storage.
- **CSP issues:** many sites have strict Content Security Policy that breaks content scripts. Defensive coding required.
- **Store review:** Chrome Web Store is faster than Apple but still 1-7 days. Reviews tighten when you request broad permissions or modify too many sites.
- **Common gotchas:** service worker dies mid-operation; content script breaks when site updates DOM; cross-browser API differences (use `webextension-polyfill`); auto-updates can land while user has the extension open and break state.

### G16. Real-time / Collaborative (v2.4 — Tier 3)

For products with multi-user real-time state: co-editing, presence, live cursors, chat, multiplayer.

- **Transport:** WebSocket (full-duplex, complex) vs Server-Sent Events (one-way server→client, simpler) vs WebRTC (peer-to-peer, lowest latency). Managed providers (Liveblocks, PartyKit, Pusher, Ably, Supabase Realtime) eliminate most of the infra pain — use them unless you have scale/cost reason not to.
- **Conflict resolution:** CRDTs (Yjs, Automerge — eventually consistent, no central authority needed) vs OT (operational transform — needs central server) vs last-write-wins (simplest, lossy). Pick based on what kind of conflicts you'll see: text editing → CRDT; structured data → CRDT or OT; presence/cursors → LWW is fine.
- **Presence model:** how do you detect a user is online, in this doc, on this section? How quickly does "left" propagate? Stale presence is a UX bug.
- **Offline-first:** if users can edit offline, the merge story is the product. Design it deliberately; don't let it emerge.
- **Permissions:** real-time updates must respect permissions — don't broadcast a doc's changes to users who can't see the doc.
- **Common gotchas:** clock skew causing CRDT divergence (use logical clocks, not wall clocks); reconnect storms after a network blip; presence "online" forever because cleanup never ran; replaying entire history on join (scale issue).

### G17. Voice / Audio Pipeline (v2.4 — Tier 3)

For products that transcribe, generate, or process audio.

- **STT (speech-to-text):** Deepgram (low latency, strong accents), OpenAI Whisper (high accuracy, batch-friendly), AssemblyAI (good speaker diarization). Wrap behind provider abstraction (G7).
- **TTS (text-to-speech):** ElevenLabs (quality, voice cloning), OpenAI (cheaper, decent), Cartesia (low latency for conversational). Same wrapping rule.
- **Streaming vs batch:** real-time conversation needs streaming both directions; transcribing a recording is batch. Mixing modes adds complexity.
- **Latency budget:** end-to-end for conversational AI: user finishes speaking → TTS audio starts. Target <1.5s for natural feel; <800ms feels human. Each hop (VAD → STT → LLM → TTS → audio) eats budget. Optimize the whole pipeline, not one hop.
- **Recording storage & retention:** explicit decision per jurisdiction. EU/CA require disclosure + consent + deletion. Default: short retention (hours-days) unless product needs longer.
- **Legal disclosure:** recording laws vary (one-party vs two-party consent states); for B2B sales/support tools, the disclosure pattern is mandatory.
- **Common gotchas:** STT accuracy degrades on non-native English / specialized vocab — fix with domain prompts or custom models; TTS prosody bad on long output — split at sentence boundaries; audio file format mismatches (sample rate, codec) breaking the pipeline silently.

### G18. Marketplace / Two-Sided Platform (v2.4 — Tier 3)

For products with distinct supply and demand sides where the product brokers their interaction.

- **Two user models, two flows.** Supply side (sellers, providers, hosts) and demand side (buyers, customers, guests) often share an identity layer but have separate onboarding, separate dashboards, separate notification preferences. Don't try to unify the UX prematurely.
- **Trust & safety:** ratings/reviews, reports, block/ban, dispute resolution. This is its own subsystem with its own domain spec.
- **Identity verification:** if money flows, KYC is likely required somewhere. Stripe Connect Identity, Persona, Onfido. Tier-gated (only require KYC at first payout, not at signup) to reduce friction.
- **Payments + payouts:** Stripe Connect is the default for two-sided (handles platform-fee split + payouts). Watch refunds — refund-after-payout creates a balance debt to the platform.
- **Dispute resolution:** define the state machine (open → investigating → resolved-for-buyer / resolved-for-seller / no-resolution → appealed). Audit trail mandatory.
- **Take-rate / fee model:** explicit in Product Spec. Changes here break unit economics retroactively.
- **Common gotchas:** unverified supply side committing fraud; demand side abusing dispute system; payouts incorrect after refund chains; one side's PII leaking to the other (e.g., real names/addresses in messaging); review brigading.
