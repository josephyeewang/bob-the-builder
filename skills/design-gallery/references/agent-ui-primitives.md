# Agent / chat surface primitives — the checklist (from beautiful-ui)

**When to open this file.** Any product surface where a person talks to an AI and watches it
work: a chat panel, an "ask the data" view, an assistant that runs multi-step tasks, a
human-approves-the-agent flow. If the surface has none of that, close this file — it does not
apply to dashboards, reports, or marketing pages.

**What it is.** The vocabulary of pieces an agent screen needs, distilled from
[beautiful-ui](https://www.beautifului.dev/) (Shane Levine / Turbo, MIT, 27 components, Next.js
15 + React 19 + Tailwind v4 + `motion`). Use it two ways:

1. **As a checklist during the HTML-mockup lane** — before drawing an agent surface, walk the
   list and decide which pieces the page needs and what each looks like *in the locked design*.
   Mock every piece the page will show, including the boring states (loading, streaming,
   waiting-for-approval, tool running, failed).
2. **As a source to copy from during the transfer** — install a piece via the shadcn registry
   (`npx shadcn add https://www.beautifului.dev/r/<name>.json`), then **re-tokenize it to the
   lock before it ships**. Its own look is fixed (cool-blue-tinted neutrals, Inter + JetBrains
   Mono, tight radii) and its raw color literals WILL fail the CI token gate. Treat it as
   structure + behavior, never as the design.

## The 27 pieces, grouped by what the visitor is doing

**Reading the AI think and work**
- `thinking-state` — collapsible "reasoning" block; expands to show steps, collapses to one line
- `streaming-text` / `stream-text` — text that arrives word by word without layout jump
- `shimmer` / `loading-state` — placeholder while nothing has arrived yet
- `tool-chips` — each tool call as a small chip (name, status, expandable result)
- `task-rows` — a multi-step job as rows with per-row status (queued / running / done / failed)
- `flowchart` — the plan as a small diagram when steps branch

**Deciding and steering**
- `approval-card` — human-in-the-loop: what the agent wants to do, Approve / Edit / Reject
- `recommendation-card` — one suggested action with the "why" and a single primary button
- `selection-actions` — bulk actions bar that appears when rows are selected
- `fine-tune-card` — adjust an output along a few named dials before accepting it

**Asking**
- `chat-composer` — the full input: attachments, `@` sources, `/` commands, model picker, send
- `prompt-bar` — the compact single-line version of the composer
- `search` — search field with typed results

**Seeing the evidence**
- `context-cards` — the retrieved chunks/sources the answer leaned on, citable by number
- `insight-cards` — short findings as cards (title, one-line claim, supporting figure)
- `records-table` — the plain data table; `filter-table` adds column filters;
  `diff-table` shows before → after per cell (essential for "the agent changed these")
- `code-block` — monospace block with copy; also the right container for SQL / JSON the agent ran
- `entity-chip` / `value-pill` — inline tokens for a named thing (ticker, person) or a value

**Chrome**
- `sidebar-nav`, `glide-menu`, `button`, `foundation` (its global CSS — do NOT adopt wholesale;
  it is the collision with the lock)

## What to watch
- `sidebar-nav` depends on `@central-icons-react`, a **paid** icon set whose license check runs
  at `npm install`. Swap icons before adding it.
- Vercel's `ai-elements` (inside the AI SDK you already use) covers the same ground with looser
  styling; prefer it when the product is on Next.js + AI SDK and the lock is far from beautiful-
  ui's look. Use beautiful-ui when you want the *behavior* of a specific piece (approval-card,
  diff-table, thinking-state) that ai-elements lacks.
- Every piece has a "nothing yet" state and a "failed" state. Mock both; agents fail visibly.

Status 2026-09-12: 171★, one author, active weekly. The checklist is the durable part.
