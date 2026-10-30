# Bob ORCHESTRATE

ORCHESTRATE runs a Bob product through one loop: talk, roadmap, build, check, back to the roadmap. This folder holds its code, every module except M8. M8, the Blueprint & Roadmap, is Bob's `templates/blueprint-roadmap/` and `scripts/blueprint/`.

**Status: being built.** Nothing here is switched on for any product yet.

## Rules for this folder
- **Code:** plain Node with **no dependencies**, written as ES modules (`.mjs`). Tests sit beside the code as `*.test.mjs`. Run them with `node --test $(find orchestrate -name '*.test.mjs')`.
- **Generic only:** this folder is part of public Bob. It holds no product names, numbers, accounts, keys or machine paths. Everything particular to one product or one owner (its rules entry, its accounts, its schedule) lives in that product's own repo or the owner's private setup, and is read as data.
- **Folders:** each module folder has one writer, listed in `LANES.md`. Never edit another lane's folder.
- **Test first:** every safety rail is proven on a test repo and test product before it touches a real product.
- **Secrets:** never read a secrets file or print a key.
- **Audits:** every change to a check is Tier 1. Each milestone ends with a fresh audit, by a session that did none of the work, repeated until 0 Material.
- **Merging:** branch, pull request, CI green, then merge. Bob's `main` takes no direct pushes.
