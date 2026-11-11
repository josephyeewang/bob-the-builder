# Independent Tier-1 transport review

Verdict: zero Material findings. Material: 0. Minor: 0. Cosmetic: 0.

Scope: scripts/skill_publish.py diff against bc4f343d672faf4c32dd9937616361d4162a7fed and new scripts/test_skill_publish_transport.py, plus surrounding publisher/exporter tests and publishing workflow. Reviewer authored none of the repository changes and made no repository edits.

Evidence:

- Independently ran `python3 -m unittest discover -s scripts -p 'test_skill*.py' -v`: 30 tests passed, including real installed gh 2.97.0 against loopback.
- Independently authored and ran independent_loopback.py in this review directory. It uses actual gh subprocesses for every HTTP request and the production publisher, with endpoint substitution restricted to loopback and isolated fake auth/config. Server state uses the existing synthetic FakeApi contract; request framing/body reads are actual HTTP.
- Reproduced the old upload construction: actual gh sends stdin chunked without Content-Length, the strict server returns 411, gh exits nonzero. The new construction sends exact Content-Length and no Transfer-Encoding, preserving binary ZIP bytes, JSON catalogue bytes and SHA256SUMS bytes.
- Exercised entire production publish through actual CLI/HTTP: partial second-asset 503 leaves pointer absent; retry reuses first asset, uploads remaining assets, re-downloads and compares bytes, then publishes exact catalogue bytes. Identical retry makes GET requests only. Stale main makes one GET and no mutations. 503 status survives without echoing synthetic private response text.
- Existing tests independently pass remote byte mismatch rejection, inner-file digest checking, preview/tamper refusal before HTTP, source-main movement during upload, newer-pointer rollback prevention, compare divergence, pointer write conflict and failed-pointer retry. Exporter tests cover private installation context, unlisted/uncommitted source exclusion, dangerous paths, symlinks, and receipt coverage.
- Reviewed the actual narrow diff: load_assets, publish, immutable-byte readback, stale-main checks and pointer guards are unchanged. Only upload Content-Length and safe CLI error construction change. No raw CLI/server output is reflected in ApiError. Unknown transport status is None rather than fictitious HTTP0; existing optional/422 logic still distinguishes actual HTTP statuses.
- Workflow still publishes only main push after verification, with top-level read-only permissions and job-specific write permissions. Pull requests cannot execute publishing. `git diff --check` passed.

Limits:

- No actual GitHub mutations, real auth-store reads or paid requests were performed. This demonstrates the CLI/HTTP byte-framing mechanism and publisher contract, not a successful hosted GitHub deployment. Root must verify the next hosted run and public download/pointer bytes.
- The synthetic server deliberately enforces the missing-length failure; it does not independently prove the historical hosted failure's exact HTTP status, because old diagnostics discarded that status. The corrected request eliminates the reproduced framing defect and preserves useful safe diagnostics for any remaining hosted failure.
- The end-to-end loopback scenario uses the existing FakeApi state machine behind actual HTTP. It is independent transport verification, not an independent implementation of GitHub's service.
- Verified CLI version is local gh 2.97.0; hosted CLI version may differ. Actual HTTP framing is checked by committed transport tests when gh is installed.

Artifacts: independent_loopback.py (synthetic-only, repeatable). No secret values or HTTP authorization headers are recorded.
