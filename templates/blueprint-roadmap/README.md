# Blueprint & Roadmap: the fact files

Copy this folder into a product as `docs/blueprint/`. Each short fact has one home here; the product, market,
behaviour and architecture documents are chapters that hold depth and link to these facts instead of re-typing them.

| File | Holds | Who changes it |
|---|---|---|
| `decided.yaml` | the goal, objectives and targets, "not doing", who it's for, the rules, adopted capabilities | only a decision the owner approves, with its decision-log entry in the same change |
| `exit-tests.yaml` | each milestone's pass/fail exit test (files in `tests/exit/` only) | only with the owner's approval |
| `blueprint.yaml` | the product name, the summary's judgment fields (risk, one-line read), the loop's steps, milestones, dates and slips, modules with their part lights and stage dates, capabilities, competitors, research, chapter paths, the as-of date | the daily roadmap change |
| `rows/<row-id>.yaml` | one roadmap row each | the change whose task names that row |
| `front-page.md` | the front page, the read for deciding: sections 0 to 8 and R, with their [C]/[G]/[O] marks | its generated parts by the page builder only; the rest by the daily roadmap change |
| `history-page.md` | the second page, "History & evidence": appendices A to M and the Z archive, each with its frozen banner and a stable anchor | frozen blocks never; the rest by the daily roadmap change |
| `module-card.md` | the module card's fixed fields, Head then 0 to 8, in order | the module's own change; generated fields by the page builder only |
| `competitor-card.md` | the competitor card's fixed fields, Head then 1 to 9, in order (cards live in the Market chapter) | the Market chapter's change; generated fields by the page builder only |
| `map.md` | the main architecture diagram as text [mermaid], wide (desktop) and tall (phone) layouts, and the one-cut rule | the page builder only (generated from the module and step lists) |
| `visual-devices.md` | colour tokens (light and dark, defined once), light chips with symbol and word, receipts, folds, the 72-character prose rule | a change the owner approves |
| `chapters/product-spec.md` | the Product chapter: depth only; copy to `docs/product-spec.md` | ordinary docs changes |
| `chapters/market.md` | the Market chapter: landscape, comparison, "why not just ask a general AI", what we take, positioning, coverage, watch list, competitor cards; copy to `docs/market.md` | ordinary docs changes |

**The owner's words, one format.** A change to a decided fact (`decided.yaml`, `exit-tests.yaml` or `tests/exit/`)
adds an entry to the product's decision log in the same change, and that entry carries exactly one line:

```
Owner's words (YYYY-MM-DD, <where it was said>): "<the exact words>"
```

The date is the day the owner said it, as `YYYY-MM-DD`; the place names where it was said (for example, the session or
thread); the quote is the owner's own words, never empty. Every check that looks for the owner's approval reads this
line and nothing else: Bob's decided-facts check, and any post-merge audit a product runs. Their shared test fixture
plants three failing cases (the line missing, a malformed date, an empty quote) and one passing case. The check can
tell that the line is there and well formed; it can't tell a real quote from an invented one, so the owner reading
the notice is what catches that.

Parts of the Markdown templates between `<!-- generated -->` and `<!-- /generated -->` are built from the fact
files and are never typed by hand. Frozen history sits between `<!-- frozen -->` and `<!-- /frozen -->`. For a
small product, only the core [C] sections appear, and the Product and Market chapters may be one file with two
headings.

Two checks keep it true; run both in the product's tests:

- `node <bob>/scripts/blueprint/schema-check.mjs .`: every file has its fields.
- `node <bob>/scripts/blueprint/fact-twice-check.mjs .`: no owned fact is typed again in a chapter or card.

The page builder makes the pages from these files and refuses data that fails the schema check:
`node <bob>/scripts/blueprint/render-blueprint.mjs . --commit <sha> --now <ISO time> --out <dir>` writes the phone
view (`docs/blueprint/BLUEPRINT.md`, saved in the repo, never hand-edited) and the rich page (`<dir>/index.html`,
`<dir>/history.html`, built, not saved in the repo). Same input, byte-identical output.

The files use a small part of YAML (maps, lists, quoted or plain text, `|` blocks, comments); anything else is
refused with its line number. Why: `decision-log.md` D-029.
