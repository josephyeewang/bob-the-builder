# APPENDIX K: PROJECT PROFILES (v2.4)

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Used in Step 0.5. Each profile is an **additive addendum** to the core protocol — extra things to consider, never replacements. If addendum and core protocol conflict, core wins.*

> **Maintenance note:** Profiles reflect best practice as of 2026-05-15. Tech in some of these (especially the "Specialist" ones) moves fast. Verify against current sources when you actually start a project in that profile.

### Profile index

| Profile | Pattern refs | How well Bob fits |
|---|---|---|
| K1. AI Chat / Copilot / Assistant | G3, G4, G11 (if RAG), G12 (if tools) | Core fit |
| K2. Internal B2B Tool / Dashboard | G7, G9, G10 | Core fit |
| K3. RAG Pipeline | G11 | Core fit |
| K4. Vertical SaaS (CRUD-heavy) | G8, G9, G10 | Core fit |
| K5. Agent / Tool-Use Workflow | G3, G4, G12, G13 | Core fit |
| K6. Background Job-Heavy / Workflow Orchestration | G13 | Core fit |
| K7. E-commerce / Subscriptions | G7, G9, G10 | Common |
| K8. Marketplace / Two-Sided Platform | G10, G18 | Specialist |
| K9. Content / Community | G8, G10 | Common |
| K10. Real-time / Collaborative | G16 | Specialist |
| K11. Mobile-First / Native | G14 | Specialist |
| K12. Browser Extension | G15 | Specialist |
| K13. Voice / Audio / Video | G17 | Specialist |
| K14. Data Pipeline / ETL | G7, G13 | Specialist |
| K15. SEO / Marketing Site | (specific addendum below) | Common |

### K1. AI Chat / Copilot / Assistant

- **Product Spec additions:** conversation memory bounds (how many turns? when does context reset?); citations & sourcing UX; "I don't know" behavior; redirect-out-of-scope behavior; user feedback capture (thumbs up/down, regenerate).
- **Architecture Contract additions:** streaming response strategy; rate limits per user/per-day; AI cost-per-conversation budget (not just per-request); prompt versioning approach.
- **Common gotchas:** prompt injection from user input; context window blowups when memory grows unbounded; tone drift when system prompt is too long.
- **Eval set focus (Step 2d):** disambiguation, refusal, citation accuracy, tone under frustration.

### K2. Internal B2B Tool / Dashboard

- **Product Spec additions:** role-based access (admin/viewer/etc.); audit log requirements; data export expectations; bulk-action workflows.
- **Architecture Contract additions:** SSO strategy (SAML/OIDC if enterprise); audit logging required; row-level security if multi-team.
- **Common gotchas:** assumed roles never enforced; export endpoints leaking data across tenants; bulk actions that lock the DB.

### K3. RAG Pipeline

- **Product Spec additions:** corpus size + update frequency; expected query latency; retrieval accuracy target; "answer found" vs "not in corpus" UX.
- **Architecture Contract additions:** chunking strategy; embedding model choice (and migration plan when it changes); reranker decision; hybrid retrieval (BM25 + vector); reindexing strategy when corpus updates.
- **Patterns:** see **G11** for full pattern.
- **Common gotchas:** chunk size wrong for content type (legal vs slack convos); no reranker = poor retrieval; embeddings stale after corpus update; "I don't know" mishandled.
- **Eval set focus:** retrieval recall@k, answer faithfulness (does the answer cite real chunks?), refusal when not in corpus.

### K4. Vertical SaaS (CRUD-heavy)

- **Product Spec additions:** primary entity hierarchy (Organization → User → Resource); permissions matrix; common workflows (create, edit, delete, share, archive); empty-state design.
- **Architecture Contract additions:** RLS or app-level permissions; soft-delete vs hard-delete; data migration strategy as schema evolves.
- **Common gotchas:** permission checks missing on one endpoint; cascading deletes that nuke too much; no soft-delete = no "undo".

### K5. Agent / Tool-Use Workflow

- **Product Spec additions:** what tools does the agent have access to; what's the max-step bound; how does the user observe agent progress; how does the user stop or redirect mid-run.
- **Architecture Contract additions:** tool definition discipline (schemas, descriptions); tool-call eval; tool-failure handling (retry vs abort vs ask user); MCP integration if applicable.
- **Patterns:** see **G12** for full pattern.
- **Common gotchas:** agent calls wrong tool because description is unclear; infinite loops; agent's tool calls fail silently; no observability into multi-step runs.
- **Eval set focus:** tool selection accuracy, refusal on out-of-scope requests, max-step compliance, recovery from tool errors.

### K6. Background Job-Heavy / Workflow Orchestration

- **Product Spec additions:** which user actions trigger background work; expected latency between trigger and completion; user-visible status; retry policy from user's POV ("we'll keep trying for 24h").
- **Architecture Contract additions:** job runner choice (Inngest, Trigger.dev, Vercel Workflow, DB-backed queue) — see G13; idempotency keys; dead-letter handling; concurrency limits.
- **Patterns:** see **G13**.
- **Common gotchas:** non-idempotent jobs run twice → duplicate charges/emails; no dead-letter = silent loss; jobs not observable in prod.

### K7. E-commerce / Subscriptions

- **Product Spec additions:** payment flow (one-time, subscription, usage-based, freemium); cart/checkout vs single-product purchase; tax/region handling; refund + dispute flow; inventory model if physical goods.
- **Architecture Contract additions:** payment provider (Stripe default, alternatives if EU-heavy); webhook signature verification (G7 abstraction recommended); idempotency on payment retries; PCI scope (use Stripe Elements → out of scope).
- **Common gotchas:** double-charging from non-idempotent retries; webhook failures leaving payment ≠ DB state; tax handling wrong by region.

### K8. Marketplace / Two-Sided Platform

- **Product Spec additions:** supply side and demand side as distinct user types with separate flows; matching/discovery logic; trust & safety (reviews, reports, bans); dispute resolution; payouts to supply side (Stripe Connect or equivalent).
- **Architecture Contract additions:** identity verification (KYC if money flows); review/report system; ban/suspension state machine; escrow vs direct-pay; transaction fees.
- **Patterns:** see **G18**.
- **Common gotchas:** supply side abuses to extract user data; demand side abuses to get free work; payouts incorrect after refunds; no audit trail for disputes.

### K9. Content / Community

- **Product Spec additions:** content types (post, comment, message, reaction); moderation model (pre-publish, post-publish, community); spam/abuse mitigation; notification model (email, in-app, push).
- **Architecture Contract additions:** content storage (DB vs object store for media); moderation pipeline; notification fan-out (esp. for high-follower users); search/indexing strategy.
- **Common gotchas:** notification storms on viral posts; moderation queue grows unboundedly; PII in user content accidentally indexed.

### K10. Real-time / Collaborative

- **Patterns:** see **G16**.
- **Architecture Contract additions:** real-time transport (WebSocket, SSE, WebRTC); CRDT vs OT; presence model; conflict resolution; offline-first vs online-only.
- **Common gotchas:** clock skew causing CRDT divergence; presence leaks (still shows online after disconnect); merge conflicts that lose user work.

### K11. Mobile-First / Native

- **Patterns:** see **G14**.
- **Architecture Contract additions:** native vs RN vs Expo vs Flutter decision; push notification provider; OTA update strategy; app store review prep; offline behavior; deep links / universal links.
- **Common gotchas:** assumed always-online; first app-store review rejection costs a week; push notification permissions never granted; OTA updates breaking when binary differs.

### K12. Browser Extension

- **Patterns:** see **G15**.
- **Architecture Contract additions:** Manifest version (MV3 as of 2026); content-script vs background-worker boundary; cross-origin permissions; sync vs local storage; store review prep.
- **Common gotchas:** MV3 service worker lifecycle (it stops when idle); permissions broader than needed → store rejection; content script breaking on sites with strict CSP.

### K13. Voice / Audio / Video

- **Patterns:** see **G17**.
- **Architecture Contract additions:** STT/TTS provider (Deepgram, Whisper, ElevenLabs); streaming vs batch; latency budget; recording storage & retention; legal recording disclosure.
- **Common gotchas:** latency budget violated end-to-end; recording stored longer than disclosed; STT accuracy variance by accent/language unaddressed.

### K14. Data Pipeline / ETL

- **Product Spec additions:** sources + frequencies; freshness target; schema evolution policy; reprocessing/backfill capability; data quality monitoring.
- **Architecture Contract additions:** orchestrator (Airflow, Dagster, simple cron + scripts); idempotency at every stage; checkpointing; alerting on failure; cost per run.
- **Common gotchas:** late-arriving data corrupts aggregates; schema change downstream breaks consumers; backfills that double-count; silent failures hidden because no one watches the dashboard.

### K15. SEO / Marketing Site

- **Product Spec additions:** target keywords + pages; structured data (Schema.org); social sharing (OG / Twitter cards); analytics + conversion tracking; A/B testing scope.
- **Architecture Contract additions:** rendering strategy (SSG vs SSR vs ISR — favor SSG for SEO); image optimization; Core Web Vitals budget; sitemap + robots.txt; canonical URLs.
- **Common gotchas:** client-side rendering hurting indexability; missing canonical → duplicate-content penalty; CLS/LCP regressions from a careless commit; analytics blocking by ad-blockers.
