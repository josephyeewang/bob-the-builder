# L04 Appendix — Stack checklists (Supabase + Next.js)

> Adapted from usestrix/strix@98e3df14258cd58d8b26d6ba8d17014c6182f755, Apache-2.0; modified by Joe Wang, 2026-10.
> Ideas only — no code and no attack payloads were copied. Strix's files are an offensive pentest
> playbook (attack surfaces, payloads, bypass recipes); Bob keeps only the defensive review questions,
> reworded as "confirm X is configured / verify Y is enforced." Licence: `third_party/strix/LICENSE`
> (Copyright 2025 OmniSecure Inc.). Source files: `skills/technologies/supabase.md`, `skills/frameworks/nextjs.md`.

STRIDE and OWASP (in `L04-security-threat-surface.md`) are framework-agnostic. This appendix adds the stack-specific review questions the generic sweep does not name — the places a Supabase + Next.js app actually leaks. **Every item is a defensive review question: confirm X is configured, verify Y is enforced.** Run them as part of L04's OWASP sweep (mostly Broken Access Control and Security Misconfiguration) and record each as a coverage unit (`_evidence-accounting.md` §1).

These are review checklists, not test scripts. L04 reads code and settings and optionally points OWASP ZAP at staging; it does not attack a running app. A "no," or an "I can't tell from the source," is a finding or a **needs-checking** item (`_evidence-accounting.md` §2) — never a guess.

## A.1 — Supabase pack

**Row-Level Security (RLS).**
1. Is RLS enabled on **every** non-public table, with no permit-all / always-true policy left in place?
2. Does each table's policy set cover **writes as well as reads** — INSERT, UPDATE and DELETE, not only SELECT? A read-only policy is not isolation.
3. Does every policy derive the user and the tenant from **server context** (`auth.uid()` and verified token claims), never from a client-supplied id or a column in the request body?
4. On multi-tenant tables, does every policy constrain by the tenant/org identifier, including the null-tenant case?

**Keys and the privileged (service) role.**
5. Does the secret/privileged key stay server-side only — never in a client bundle, and never echoed in a serverless-function response or error? (A browser rejecting a leaked secret key is a user-agent restriction, not revocation; server-side use still works.)
6. After any migration to new publishable/secret key formats, were the **legacy keys actually revoked**? Creating new keys does not disable the old ones.

**Database functions (RPC).**
7. Does every privileged ("definer") function perform its **own** ownership / tenant check in SQL and set an explicit search path? A definer function bypasses RLS, so a missing in-function check is a direct bypass.
8. Do such functions re-derive the caller from server context rather than trusting an id passed in the payload?

**REST (PostgREST).**
9. Do write endpoints restrict **which columns** a request can set, so a partial update cannot touch unintended columns (ownership, role, price) — enforced by policy or column grants, not client code?
10. Do embedded / nested relation reads enforce per-row ownership at **each** level, not only on the top-level row?
11. Can row **counts, filters or wildcard search** disclose the existence or volume of rows the caller cannot read?

**Storage.**
12. Are private buckets actually private (not public), and do list/read policies require the right identity?
13. Are signed URLs scoped so one cannot be reused across tenants or paths, with a sensible expiry?
14. Is uploaded HTML/SVG served as an attachment with content-type-sniffing disabled, so a stored file cannot run as a page?

**Serverless (edge) functions, realtime, GraphQL, tokens.**
15. Does each serverless function **verify the user's identity** (signature, issuer, audience) before it uses a privileged client? Passing the platform's token-presence check with a project key is not a signed-in user.
16. Is cross-origin sharing on functions free of wildcard-origin-with-credentials, and can a **user-supplied address** never make a function fetch an internal/metadata endpoint (server-side request forgery)?
17. Do realtime channels and GraphQL nested relations enforce the **same** row rules as REST, with no parity gap between transports?
18. Do custom token validators pin issuer and audience and handle key rotation / revocation (no stale cached signing key), and are tokens kept out of any place client script can read?

## A.2 — Next.js pack

**Middleware is not an authorization boundary.**
1. Does every protected route and route handler enforce authorization **itself**, so the app is still safe if middleware is skipped? Middleware-only auth has a known bypass class (an internal subrequest header, CVE-2025-29927). Confirm the installed version is patched and that external copies of that header cannot reach the origin.
2. Do middleware and the route handler **normalize paths the same way** (trailing slash, double slash, dot segments), and is each parameter read from exactly one place (no duplicate-parameter split between the check and the handler)?

**Server Actions.**
3. Does each Server Action enforce authorization **server-side**, rather than trusting client state, and re-check ownership of the object it acts on?
4. Are action identifiers treated as discoverable (they appear in source maps and hydration data), so a hidden action is not relied on for secrecy?

**Caching boundaries.**
5. Are user- or tenant-specific responses kept out of any **shared cache / CDN** — identity in the cache key, no-store on sensitive fetches, variation on auth cookies?
6. Where cache-components are used, do cached closures, cache tags and lifetimes keep users and tenants separate, with correct invalidation?

**Data exposure.**
7. Does server-fetched data handed to the client (hydration payload, server-component flight payloads, page props) contain **only what the UI renders** — no full user objects, internal IDs, tokens or admin-only fields, and no cross-user data?
8. In production, are source maps and build manifests not exposing internal route structure and server-action identifiers?

**Image optimizer / server-side request forgery.**
9. Are remote-image allowlists narrow, so a user-supplied image URL cannot make the optimizer fetch an internal address, and is the version patched against the current optimizer / image-response advisories?

**Runtime, rendering, auth.**
10. Is every security check enforced consistently across **edge and node** runtimes (including forwarded-header trust), with no check present on one and absent on the other?
11. Is the framework / React version patched against the current **server-components** advisories (source-code exposure, denial of service, the decoder remote-code-execution class)?
12. Are draft/preview secrets kept out of client bundles, and can preview mode not be enabled via an open redirect or a subdomain cookie?
13. Is client-side HTML sanitized wherever it is injected (raw-HTML props, markdown renderers, user-controlled link/source attributes), with a content-security-policy covering server render, client render and hydration?
14. For the auth library: are anti-forgery state / nonce / PKCE present per provider, is the post-login redirect restricted to an allowlist (open-redirect), and is token audience/issuer enforced on every route?
