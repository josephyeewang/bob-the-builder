# APPENDIX L: INTEGRATION PLAYBOOKS (v2.7)

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Per-service playbooks for the most common integrations, numbered P1–P11 (they were L1–L11 until 2026-10-29, which clashed with the audit lenses L01–L38). Reference at Step 3 (Architecture Contract) when choosing tools, and at the relevant Build Phase when wiring the integration in. Each playbook is signposts, not exhaustive docs — verify current-state against the provider's docs.*

> **Maintenance note:** Tool docs and SDKs evolve. The shape of these problems is stable; the specific SDK versions, endpoint names, and pricing referenced here may drift. Use the playbook as a checklist; verify exact API surface against current docs when wiring up.

### P1. Stripe (payments / subscriptions)

- **Env vars:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Never expose secret key client-side.
- **Provider abstraction (G7) shape:** `PaymentProvider` interface — `createCheckoutSession(input)`, `verifyWebhook(rawBody, signature)`, `getCustomer(id)`. Wrap because EU customers may push you toward alternatives (Paddle, Lemon Squeezy).
- **Webhook signature verification (mandatory):** use `stripe.webhooks.constructEvent(rawBody, signature, secret)`. Raw body matters — middleware that parses JSON breaks it.
- **Idempotency:** every Stripe write call accepts an `Idempotency-Key` header. Use it for retried mutations. Without it, network retries double-charge.
- **Test events:** Stripe CLI's `stripe trigger` is your friend during build. Real-money tests via test mode only.
- **Common failure modes:** webhook never verified → silent acceptance of forged events; non-idempotent retries → double-charges; subscription state diverges between Stripe and your DB (handle every relevant webhook: `customer.subscription.*`); refunds after a payout create a platform balance debt.
- **Eval/test that proves it works:** end-to-end test mode purchase → webhook received → DB updated → confirmation email sent.

### P2. Supabase Auth + RLS

- **Env vars:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (client), `SUPABASE_SERVICE_ROLE_KEY` (server-only — never client).
- **RLS posture (mandatory):** enable RLS on **every** user-data table. Policy: `auth.uid() = user_id` (or group membership for shared data). See G10 for the full pattern.
- **Service role usage:** server-side only, bypasses RLS. Use sparingly (admin routes, background jobs); never from client.
- **Session handling:** `@supabase/ssr` for Next.js App Router. Older `auth-helpers-nextjs` is deprecated as of 2024.
- **Common failure modes:** RLS not enabled on a table → cross-tenant data leak (the highest-severity Supabase bug); service role key leaked to client → full DB access for anyone; expired JWT not refreshed → silent 401s users can't recover from.
- **Eval/test:** two test accounts; user A cannot read user B's rows under any combination of (logged out, wrong session, guessed ID).

### P3. Resend (transactional email)

- **Env vars:** `RESEND_API_KEY`. Domain verification required for production sending.
- **Provider abstraction (G7) shape:** `EmailProvider` interface — `send(to, subject, html, tags?)`. Wrap because email providers churn (Postmark, SendGrid alternatives all viable).
- **Idempotency:** Resend has no built-in idempotency key — add your own at the application layer (don't fire-and-forget transactional emails twice).
- **Deliverability:** SPF, DKIM, DMARC records on the sending domain — non-negotiable for production. Resend's dashboard shows verification status.
- **Templating:** use React Email (Resend's sibling tool) for type-safe email components. Plain HTML works but ages poorly.
- **Common failure modes:** unverified domain → all emails go to spam; sending marketing + transactional from the same domain → IP reputation degrades; no unsubscribe link on marketing emails → CAN-SPAM violation.
- **Eval/test:** send a real test email to an external inbox; verify it doesn't hit spam.

### P4. Twilio (SMS / voice)

- **Env vars:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
- **Provider abstraction (G7) shape:** `SMSProvider` — `send(to, body)`, `verifyWebhook(req)`. Wrap because Twilio is expensive at scale; MessageBird, Plivo are alternatives.
- **Webhook signature verification (mandatory):** Twilio signs inbound requests with `X-Twilio-Signature`. Verify against your webhook URL + body. Forged webhooks → spam-pump your backend.
- **A2P 10DLC registration (US):** for SMS to US numbers from a long code, you must register your brand and campaigns. ~$15-50/month + verification time. Skipping this → carriers filter your messages.
- **Common failure modes:** missing signature verification → forged inbound webhooks; non-E.164 phone numbers → silent failures (always normalize to `+15551234567` format); unregistered A2P → silently filtered messages with no error from Twilio; long-code-to-US rate limits (~1 msg/sec) → backed-up queues.
- **Eval/test:** send a test SMS to your own number; reply; verify inbound webhook fires + signature validates.

### P5. Anthropic SDK / Claude API

- **Env vars:** `ANTHROPIC_API_KEY`. Use Vercel AI Gateway (see P11 below) if you want provider failover.
- **Prompt caching:** for any prompt > ~1024 tokens that's reused across requests, mark cacheable sections with `cache_control: { type: 'ephemeral' }`. Saves ~90% on input cost for cached portion. Cache TTL is 5 minutes; refresh via a non-cached request when expiration matters.
- **Skill to invoke (v2.7):** during Step 2d (eval set) and any phase touching AI prompts, invoke the `claude-api` skill for prompt-caching configuration guidance.
- **Streaming:** use streaming for any user-facing AI output to keep perceived latency low. Server-sent events (SSE) is the default Vercel-compatible path.
- **Tool use:** for agent products (see K5, G12), every tool needs a precise JSON Schema and a clear description ("WHEN to call this", not just "WHAT it does"). Vague descriptions → wrong tool selection.
- **Common failure modes:** prompt-cache misses because system prompt changed by one char → 10× cost; rate limits hit in production (handle 429 with backoff + queueing); long contexts (>100K tokens) silently degrading quality.
- **Eval/test:** the Step 2d eval set IS the test. Drop in pass-rate vs prior phase = stop condition.

### P6. OpenAI SDK (LLM alternative)

- **Env vars:** `OPENAI_API_KEY`.
- **Provider abstraction (G7) shape:** wrap behind a `ModelProvider` interface so swapping Anthropic ↔ OpenAI is a one-file change. Common methods: `chat({ messages, model, tools? })`, `embed(text)`.
- **Tool use:** OpenAI function calling has slightly different schema from Anthropic tool use. The provider abstraction should normalize.
- **Common failure modes:** model deprecations (GPT-3.5 → GPT-4o → GPT-5 — code references stale model IDs); cost surprises (GPT-5 input is much more expensive than 4o-mini); response format inconsistency when requesting JSON without `response_format: { type: "json_object" }`.
- **Eval/test:** same as P5 — eval set re-run at every phase.

### P7. pgvector (vector DB via Postgres)

- **Env vars:** Postgres connection string (typically reusing your Supabase / Neon DB).
- **When to use:** small-to-medium RAG corpora (<10M chunks). Past that, dedicated vector DBs (Pinecone, Weaviate) outperform.
- **Migration:** enable the `vector` extension. Create a column of type `vector(1536)` (dimension matches your embedding model — OpenAI ada-002 is 1536, text-embedding-3-large is 3072). Index with `ivfflat` or `hnsw` for fast similarity search.
- **Embedding generation:** wrap behind provider abstraction. When embedding model changes, you must reindex — bake this into the migration plan from day one (see G11 RAG Pattern).
- **Hybrid retrieval:** combine vector search with full-text search (`tsvector`) and a reranker. Vector-only retrieval misses keyword matches; production-grade RAG needs hybrid.
- **Common failure modes:** dimension mismatch between stored embeddings and query embedding (cryptic SQL errors); no index → query times explode past ~100K rows; reindex during an embedding model migration takes hours, locking the table.
- **Eval/test:** retrieval recall@k on a held-out QA set (per G11).

### P8. Inngest (background jobs / workflow orchestration)

- **Env vars:** `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`.
- **When to use:** event-driven async work, scheduled jobs, multi-step workflows with retries. Generous free tier. Alternative: Trigger.dev (similar), Vercel Workflow (Vercel-native, durable), DB-backed queue (simplest, less powerful).
- **Idempotency (mandatory):** every step in an Inngest function should be idempotent. Inngest retries on failure — without idempotency, retries duplicate side effects.
- **Step functions:** wrap each side effect in `step.run("name", async () => { ... })`. Inngest checkpoints between steps — failures resume from the last successful checkpoint instead of restarting.
- **Common failure modes:** non-idempotent steps duplicating emails/charges on retry; concurrency limits not set → user spam blocks everyone else's jobs; missing dead-letter handling (Inngest has it built-in — enable it).
- **Eval/test:** kill the worker mid-job; restart; verify job resumes correctly. Run two workers concurrently with the same job; verify no double-processing.

### P9. Sentry (error monitoring)

- **Env vars:** `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (for releases).
- **Setup at Step 6c:** install at repo init, not later. "We'll add monitoring before launch" never happens before something breaks.
- **PII redaction (mandatory):** configure `beforeSend` to scrub user emails, names, tokens from error payloads. Sentry has built-in scrubbers — use them; don't ship PII to a third party.
- **Release tracking:** integrate with your CI/CD so deploys are tagged in Sentry. Lets you see "errors started after deploy 7dffbeb."
- **Source maps:** upload at build time so stack traces are readable. Without source maps, production errors are gibberish.
- **Common failure modes:** PII leaked in error context (user emails, payment metadata); alert fatigue (every error → page → ignored); source maps not uploaded → unreadable stack traces from prod.
- **Eval/test:** throw a test error in prod; verify it appears in Sentry with a readable stack trace and no PII.

### P10. PostHog (product analytics)

- **Env vars:** `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.
- **What to track (mandatory):** every success metric and leading indicator from the Product Spec Step 1a maps to a PostHog event. This is the v2.4 success-metric instrumentation map made concrete.
- **Self-host vs cloud:** self-hosted PostHog is free at scale but operationally non-trivial. Cloud is free up to 1M events/month and fine for most v1 products.
- **Feature flags:** PostHog includes feature flags — wire to the rollback-plan posture from Architecture Contract (Step 3a v2.2).
- **Common failure modes:** event spam (every page view + every click = useless data — track meaningful events only); naming inconsistency (`task_created` vs `taskCreated` vs `task created` — pick one convention in Architecture Contract); ad-blockers blocking client-side calls (mitigate with server-side capture for critical events).
- **Eval/test:** trigger your north-star event manually; verify it appears in PostHog with the right properties.

### P11. Vercel AI Gateway (LLM routing / failover)

- **Env vars:** `AI_GATEWAY_API_KEY`. Replaces individual provider keys.
- **When to use:** anytime you might want to swap LLM providers later, do cost-aware routing, or need failover. Drop-in replacement for direct SDK calls.
- **Skill to invoke (v2.7):** during Step 3a (Architecture Contract) for any AI product, invoke the `vercel:ai-gateway` skill for routing configuration guidance.
- **Cost tracking:** gateway logs every request with token counts and cost. Pipes into the cost-guardrail (Step 3a + phase-gate v2.2).
- **Common failure modes:** treating it as transparent when it's not (latency adds ~50ms vs direct); not configuring failover even though that's the main reason to use it; missing the unified billing benefit (one invoice across providers).
- **Eval/test:** force-fail your primary model in config; verify request routes to fallback without user-visible error.
