# lens-retros/ — local collection point for audit retros

This folder is where **audit retro JSONs** accumulate *locally* so `scripts/lens-retro.sh` can aggregate them across runs and projects. It is the Option B half of the v2.18 Audit Self-Learning Loop (see `audit-lenses/_lens-retro.md`).

> ⚠️ **PRIVATE BY DEFAULT — never commit raw retros.** This is a **public** repo. A raw retro embeds project-specific detail: which routes/tables had vulnerabilities, finding descriptions, commit hashes, still-open issues. Committing one publishes a live product's security map. `*.json` here is gitignored for that reason — only `.gitkeep` and this README are tracked. (This rule exists because it was learned the hard way: an EMBT retro was briefly committed here on 2026-05-25 and had to be purged from history.)

## What goes here (locally)

`audit-retro-{YYYY-MM-DD}.json` files (schema in `audit-lenses/_lens-retro.md` §A). One per audit pass per project. Each one is a critique of **Bob's lenses as instruments** — not the findings about the audited product. They stay on your machine; the script reads them locally.

## How they get here

1. **Your own projects** — copy `audit-artifacts/audit-retro-*.json` from a Bob-built project into this folder (gitignored, stays local). Or skip the copy and point the script at the project: `bash scripts/lens-retro.sh ~/Desktop/embt`.
2. **External users** — do **not** PR a raw retro into this public repo. Instead, hand-write a **sanitized** change-request set (lens IDs + signal verdicts + generic "this check question was ambiguous" notes, with NO finding details, table names, routes, or hashes) into a GitHub issue, or email joe@joe.wang. A maintainer folds sanitized signal into the lenses.

No telemetry, no phone-home — retros arrive only when a human shares them, and only in sanitized form upstream.

## What to do once ≥3 have accumulated

Run the ritual:

```
bash scripts/lens-retro.sh
```

It prints a per-lens review board (which lenses are consistently Noise / swapped-out / change-requested) plus coverage gaps and ranked change-requests. Then a human decides which lenses to actually edit — convergence across retros is **signal, not a verdict** (D-004 / F35). Bob never auto-edits a lens (D-005). Full ritual in `audit-lenses/_lens-retro.md` §B.

> Filename convention note: retros named `audit-retro-*.json` are picked up automatically. To keep multiple projects distinct in this shared folder, prefix with the project: `embt-audit-retro-2026-05-25.json`.
