# lens-retros/ — collection point for audit retros

This folder is where **audit retro JSONs** accumulate so `scripts/lens-retro.sh` can aggregate them across runs and projects. It is the Option B half of the v2.18 Audit Self-Learning Loop (see `audit-lenses/_lens-retro.md`).

## What goes here

`audit-retro-{YYYY-MM-DD}.json` files (schema in `audit-lenses/_lens-retro.md` §A). One per audit pass per project. Each one is a critique of **Bob's lenses as instruments** — not the findings about the audited product.

## How they get here

1. **Joe's own projects** — copy `audit-artifacts/audit-retro-*.json` from a Bob-built project (EMBT, DLL, …) into this folder. Or skip the copy and point the script at the project: `bash scripts/lens-retro.sh ~/Desktop/embt`.
2. **External users (PR-back)** — PR your `audit-retro-*.json` into this folder, or paste the retro into a GitHub issue and a maintainer drops it here. This is the audit-specific cousin of the Step [N+2]c PR-back.
3. **Email** — joe@joe.wang (private channel); the JSON gets dropped here.

No telemetry, no phone-home — retros arrive only when a human shares them.

## What to do once ≥3 have accumulated

Run the ritual:

```
bash scripts/lens-retro.sh
```

It prints a per-lens review board (which lenses are consistently Noise / swapped-out / change-requested) plus coverage gaps and ranked change-requests. Then a human decides which lenses to actually edit — convergence across retros is **signal, not a verdict** (D-004 / F35). Bob never auto-edits a lens (D-005). Full ritual in `audit-lenses/_lens-retro.md` §B.

> Filename convention note: retros named `audit-retro-*.json` are picked up automatically. To keep multiple projects distinct in this shared folder, prefix with the project: `embt-audit-retro-2026-05-25.json`.
