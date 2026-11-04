# M5-review-audit

See LANES.md for who builds this folder, and the build rows for what.

- `findings.mjs`: the finding-checker and finalize. When a review session ends, the runner finalizes that session's own verdict file before its sha256 goes into the ended record: a finding whose quote can't be found in the code is labelled, so the owner can check it. Finalize never removes a finding or changes a count or a pass, and the runner refuses a verdict that changed in any other way (R-0b-145, L469, L482).
- `local-view.mjs`: the runner's git view over its mirror, with the same contract as M10 `git-view.mjs`, because the runner has no token (L80). `local-view.test.mjs` runs both on one repository.
