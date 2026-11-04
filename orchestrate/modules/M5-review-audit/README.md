# M5-review-audit

See LANES.md for who builds this folder, and the build rows for what.

- `findings.mjs`: the finding-checker and finalize. When a review session ends, the runner finalizes that session's own verdict file before its sha256 goes into the ended record: findings that don't hold up against the change are dropped, and a fail stays a fail while a Material finding is kept (R-0b-145, L92).
- `local-view.mjs`: the runner's git view over its mirror, with the same contract as M10 `git-view.mjs`, because the runner has no token (L80). `local-view.test.mjs` runs both on one repository.
