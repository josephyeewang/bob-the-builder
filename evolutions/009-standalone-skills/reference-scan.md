# Scoped reference scan

- Adopt: existing Bob skills folder/relative-resource convention; preserve one maintained module source.
- Adopt: the skill-creator specification's entrypoint + progressive references + explicit dependencies. Avoid a new assistant-specific packaging format.
- Adopt: Python standard-library zipfile deterministic metadata and hashlib receipts. No package-manager dependency is needed for plain-file skills.
- Adopt: GitHub Releases for immutable assets and repository Contents API for a single current catalogue. Official endpoint contracts checked before implementation: https://docs.github.com/en/rest/releases/assets and https://docs.github.com/en/rest/repos/contents .
- Reject: publishing a private repository/archive wholesale, manual duplicate instruction copies, cross-repository personal tokens and a bespoke download server. They add privacy or maintenance failure modes without helping the plain-file distribution goal.
- Defer: automatic modification of installed copies. Downloads stay reviewable snapshots; caller installation is a separate explicit action.
