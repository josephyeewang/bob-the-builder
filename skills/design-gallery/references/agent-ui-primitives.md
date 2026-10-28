# Agent / chat surface primitives — the checklist (from beautiful-ui)

**When to open this file.** Any product surface where a person talks to an AI and watches it
work: a chat panel, an "ask the data" view, an assistant that runs multi-step tasks, a
human-approves-the-agent flow. If the surface has none of that, close this file — it does not
apply to dashboards, reports, or marketing pages.

**What it is.** The vocabulary of pieces an agent screen needs, distilled from
[beautiful-ui](https://www.beautifului.dev/) (Shane Levine / Turbo, MIT, Next.js 15 + React 19 +
Tailwind v4 + `motion`). Its download list has 27 entries: **24 pieces** plus 3 helpers
(`foundation`, `button`, `glide-menu`). Use it two ways:

1. **As a checklist during the HTML-mockup lane** — before drawing an agent surface, walk the
   list and decide which pieces the page needs and what each looks like *in the locked design*.
   Mock every piece the page will show, including the boring states (loading, streaming,
   waiting-for-an-answer, tool running, nothing found, failed).
2. **As a source to copy from during the transfer** — install a piece via the shadcn registry
   (`npx shadcn add https://www.beautifului.dev/r/<name>.json`), then **re-tokenize it to the
   lock before it ships**. Its own look is fixed (cool-blue-tinted neutrals, Inter + JetBrains
   Mono, tight radii) and its raw color literals WILL fail the CI token gate. Treat it as
   structure + behavior, never as the design.

**Every piece is a scripted demo.** Each ships with built-in sample data (an ice-cream shop) and
timers that play the animation once; to use one you rewire it to real data and real events.

## The 24 pieces, grouped by what the visitor is doing

Each line is taken from the piece's own header comment in the source (re-checked 2026-10-27
against slev12397/beautiful-ui @ `44a274e`), not from the demo page.

**Reading the AI think and work**
- `thinking-state` — expandable agent trace in four versions: a step list (spinner → checks),
  prose reasoning, a web-search trace (query + sources read), a coding trace (files read, edits,
  commands). Runs once, settles, stays expandable
- `streaming-text` — an answer whose words resolve out of a blur, with inline source chips
  (citations) appearing in place, then action buttons and follow-up prompts once it finishes
- `stream-text` — the small building block under it: reveals characters fast with a soft blurred
  leading edge and a caret that blinks once the text settles
- `shimmer` — a shimmering text label meaning "the agent is working"
- `loading-state` — a pixel-grid loader for long jobs (Drive / Dots / Orbit / Surfer versions)
  with a shimmering label and a live elapsed-time counter
- `tool-chips` — an agent run as compact rows: tool calls with inline chips, then chips that
  summarize file edits; every row expands to show what the tool did. **Has no status at all**
  (no running / failed) — add one yourself
- `task-rows` — a multi-step job as rows with a progress ring each; a row expands to show its
  detail steps; a row can go **Failed with a retry** before completing (the only piece with a
  failed state)
- `flowchart` — an agent workflow on a dotted canvas: a Trigger card joined to an If/Else
  condition card; cards drag and the connector follows; condition chips open real dropdowns

**Answering the agent and steering it**
- `approval-card` — despite the name, a **clarifying-questions card**: the agent asks one
  question at a time (single-choice or multi-select answers), a step counter, and a quiet Skip
  plus a dark Continue. Single-choice answers move on by themselves. It is not an
  Approve / Edit / Reject card — build that yourself if the page needs one
- `recommendation-card` — one recommended option with a primary confirm button; "Alternatives"
  opens a drawer of other options, and picking one promotes it to the recommendation
- `selection-actions` — an AI action bar that appears **under selected text** (Explain, Improve,
  Shorten, Fix grammar, or a typed prompt); the rewrite streams in place, with a try-again button. Not a bulk-actions bar for
  selected table rows
- `fine-tune-card` — a compact settings inspector: number fields you drag on the label to
  adjust, nudge with arrow keys, or type into

**Asking**
- `prompt-bar` — the full input: attach, `@` data sources, `/` commands, a model picker,
  dictation and send; rounded or pill shape
- `chat-composer` — a whole chat panel: context tabs along the top, the message thread with
  scripted agent replies, and a simple input at the bottom
- `search` — command-style search with live filtering, a clear button, and a "No results found"
  state

**Seeing the evidence**
- `context-cards` — the retrieved chunks the answer used: title, size, the text, and the source
  file with a type badge (PDF, CSV). They enter once and stay available
- `insight-cards` — a carousel ("Insights N ‹ ›") of small embedded charts with hover readouts;
  autoplay stops as soon as a person touches it
- `records-table` — an AI spreadsheet: each column is a property you configure (type, tool,
  grounding, inputs, prompt), a + header adds a new AI column, and cells fill row by row while
  it runs. Not a plain data table
- `filter-table` — a task table filtered by status chips above it
- `diff-table` — the agent's proposed edit to a table: rows it would **remove** (red) and rows
  it would **add** (green) shown among the rows that stay; click each change to include or
  exclude it, then "Apply N changes". Whole rows, not before → after per cell
- `code-block` — a code panel with two views: line-numbered code, or a unified diff (old/new line
  numbers, red/green bars, word-level highlights); also the right container for SQL / JSON the
  agent ran
- `entity-chip` / `value-pill` — inline tokens in running text: a named thing (monogram + name)
  or a plain value (a date, a count)

**Chrome**
- `sidebar-nav` — workspace switcher, main navigation, searchable chat history, collapses to icons

**Helpers (installed automatically, not pieces):** `foundation` (its global CSS — do NOT adopt
wholesale; it is the collision with the lock), `button`, `glide-menu` (the hover highlight that
slides between menu rows). The source also has an `AgentScreen` live screen-viewer that is not in
the download list.

## What to watch
- **Every piece pulls in `foundation`** (the global CSS) when installed. Strip or re-map it in
  the same change, or the product's look shifts.
- `sidebar-nav` depends on `@central-icons-react`, a **paid** icon set whose license check runs
  at `npm install`. Swap icons before adding it. Three others pull small free packages:
  `insight-cards` (liveline), `prompt-bar` (glimm), `selection-actions` (iconoir-react).
- Vercel's `ai-elements` (inside the AI SDK you already use) covers the same ground with looser
  styling; prefer it when the product is on Next.js + AI SDK and the lock is far from beautiful-
  ui's look. Use beautiful-ui when you want the *behavior* of a specific piece (the
  clarifying-questions card, diff-table, thinking-state) that ai-elements lacks.
- **Mock a "nothing yet" and a "failed" state for every piece you use** — agents fail visibly.
  beautiful-ui will not hand you these: only `task-rows` has a failed state and only `search` has
  an empty one. For a tool trace, give every call one of three honest statuses — worked, worked but
  found nothing, failed — which `tool-chips` does not model.

Status 2026-10-22 (piece descriptions re-verified from source 2026-10-27): 328★ (github.com/slev12397/beautiful-ui, MIT, created July 2026), one author, active. The checklist is the durable part.
