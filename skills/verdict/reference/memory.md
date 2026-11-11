# Private memory and recall

Choose an explicit private memory folder outside publicly tracked content. Do not assume any cloud provider, native assistant memory layout or home-folder registry. Project/user sources are authoritative; evaluation records are sourced snapshots. Keep private context off public pages and respect the user’s data zones.

## Read only what matters

Resolve <skill> to the installed skill folder, <project> to a relevant explicitly scoped project and <verdicts> to the chosen private memory folder. Run `python3 -I "<skill>/scripts/fit-profile.py" --project-root "<project>" --memory-root "<verdicts>"`. Repeat --project-root for other relevant known projects and --skill-root for specific capability source folders. With no known project, use --no-project-context instead of --project-root and disclose the limit. This helper prints without writing; optional --output "<verdicts>/fit-profile.md" saves only that generated view. It reads bounded fixed project documents and explicit skill sources; it does not discover home folders, read native configuration or execute project code. Read relevant lessons.md and matching tool/space records. File presence is not actual use or priority. A private local adapter may supply explicit roots, but is optional and never distributed with this module.

Generate component-index.md/.json with `python3 -I "<skill>/scripts/component-index.py" --memory-root "<verdicts>"`; use them for components, project queues and pain observations, following source links before acting.

Run `python3 -I "<skill>/scripts/component-index.py" --memory-root "<verdicts>" --query "<behavior words>" --stdout` for lexical AND search; try synonyms and simpler queries. --project matches exact known labels. Include a behavior search without a project filter for new reuse. Old Markdown remains independently searchable even when partial structured records exist; its matches are historical hints, not verified states or project assignments. Missing/malformed records are coverage warnings, not no value/no pain.

Pain basis/status/freshness and product fit are defined in relevance.md. Inspect original records for conflicts and recheck current canonical sources; generated views do not decide truth, relevance or authorization.

## Write once, generate views

- tools/<slug>.md: readable latest evaluation and preserved dated History.
- tools/<slug>.json: completion evidence using evaluation-record.json and record-fields.md. Keep legacy records compatible; new records carry the current opportunity/context/application extensions. Record trial plans and observed outcomes using record-fields.md.
- evidence/<slug>/<revision>/<part>/: original source bundles per source-capture.md.
- spaces/<space>.md: update only changed comparisons/lessons; no forced landscape rewrite for narrow requests.
- lessons.md: merge new corrections, retaining historical context.
- component-index.json/.md: regenerate from sidecars via component-index.py; never manually maintain component/pain/queue status.
- fit-profile.md: refresh when the selected roots or relevant project/source documents change; generation alone does not revalidate claims.

Save every evaluation, including unpublished skips, partial access and useful parts not yet integrated. Keep reusable/future opportunities searchable without assigning an invented current project; retain their checked date and concrete revisit trigger. Preserve old decisions/history and explicitly explain reversals; don't silently rerate old mixed ratings. New opportunity/pain observations point to inspected evidence, never fabricate a history or change unrelated projects.

Receipt/state fields and checker usage live in record-fields.md; capture/Harvested definitions live in source-capture.md. Failed writes are disclosed with a scratch copy, never reported as saved. When transferring/rebasing reviews, preserve all load-bearing evidence, including superseded or comparison bundles, batch-level receipts and nested inspection/scan inputs, not only bundles linked by recommended parts. Reconcile manifest/input inventories and reopen local artifact references after transfer; verify history and record counts before claiming the save succeeded. Recheck rules live in relevance.md and SKILL.md.

