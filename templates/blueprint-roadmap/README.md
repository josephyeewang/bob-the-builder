# Blueprint & Roadmap: the fact files

Copy this folder into a product as `docs/blueprint/`. Each short fact has one home here; the product, market,
behaviour and architecture documents are chapters that hold depth and link to these facts instead of re-typing them.

| File | Holds | Who changes it |
|---|---|---|
| `decided.yaml` | the goal, objectives and targets, "not doing", who it's for, the rules, adopted capabilities | only a decision the owner approves, with its decision-log entry in the same change |
| `exit-tests.yaml` | each milestone's pass/fail exit test (files in `tests/exit/` only) | only with the owner's approval |
| `blueprint.yaml` | milestones, dates and slips, modules, capabilities, competitors, research, chapter paths, the as-of date | the daily roadmap change |
| `rows/<row-id>.yaml` | one roadmap row each | the change whose task names that row |

Two checks keep it true; run both in the product's tests:

- `node <bob>/scripts/blueprint/schema-check.mjs .`: every file has its fields.
- `node <bob>/scripts/blueprint/fact-twice-check.mjs .`: no owned fact is typed again in a chapter or card.

The files use a small part of YAML (maps, lists, quoted or plain text, `|` blocks, comments); anything else is
refused with its line number. Why: `decision-log.md` D-029.
