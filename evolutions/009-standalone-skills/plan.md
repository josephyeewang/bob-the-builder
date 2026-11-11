# Standalone skills — EVOLVE Large

## Outcome and scope
A repeatable source-to-download path for portable capabilities maintained inside the existing framework. Initial modules: Verdict, Design Gallery, Design Mockups and PushAll. Personal integration remains outside the public repository.

## Plan
1. Generalize module roots and preserve useful independent behavior.
2. Register exact public files, license notices and optional companion modules.
3. Implement deterministic exports, source/file/archive hashes and standalone install guidance.
4. Validate committed exports on pull requests; publish versioned assets from main before advancing the public catalogue.
5. Prepare compatibility adapters privately; activate only after canonical source is available.
6. Run synthetic boundary tests, standalone checks and a fresh privacy/behavior audit; reconcile findings before publication.

The maintained interface, author workflow and verification commands live in [skills/EXPORTS.md](../../skills/EXPORTS.md). They are not duplicated here. No new provider runtime, hosting service or private credential integration is introduced.

## Publication boundary
Implementation and local verification are authorized. First public distribution and any consuming website launch remain subject to the owner's publication approval. A prepared workflow is not evidence of a successful hosted release.

## Remaining evidence
Local package/behavior tests and source-to-download validation are recorded in reconciliation.md. The first hosted workflow run must be verified after approved merge. Private adapters remain outside public history.

## Scope refinement
PushAll is a standalone save-and-handoff module. Whole-project closeout remains a separate private command that reuses PushAll. There is no combined closeout mode in the download.
