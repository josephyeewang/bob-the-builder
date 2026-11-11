# Preserve execution, not just a description

For a promising part, actually save inspected exact originals, supporting imports/helpers, tests/fixtures, styles/assets and applicable LICENSE/NOTICE files at the same immutable revision. Keep originals separate from patches. Don't capture whole repositories by default or read prohibited sensitive files. Confirm per-file copying permission for the intended destination; a flag is an evaluator attestation, not automatic legal clearance.

Use the local helper after a source-only clone or equivalent inspected Git repository is available:

```text
python3 -I "<skill>/scripts/capture-source.py" --repo "<scratch clone>" --revision "<full commit hash>" --source-url "https://github.com/owner/repo" --output "<private evidence dir>/<slug>/<commit>/<part>" --license-reviewed --file "src/part.ts" --file "src/helper.ts" --file "tests/part.test.ts" --file "LICENSE"
```

The evaluator runs this, replacing paths with checked real values. It reads selected Git blobs without running project code, refuses unsafe paths/modes/overwrites and writes originals/ plus manifest.json with byte hashes. It never fetches from the network. Check the manifest and compare originals against the pinned source. If Git/download access fails, state capture blocked and retain exact references; never reconstruct source from memory, compressed text or a prose description.

Durable evidence belongs in private verdict memory `verdicts/evidence/<slug>/<revision>/<part>/`; session experiments/clones stay in scratch. No client work product or personal inputs in a source bundle. Record source URL, full revision, selected paths and file-level terms; attribution/license notices travel with any actual copies. Confirm tests and dependencies listed are sufficient by inspecting the selected part's imports and callers. The helper preserves bytes, not dependency completeness.

For each candidate record: named destination or reason unknown, what behavior must survive, proposed changes and why, safe regression check, safety repairs, attribution and integration order. “Wrong language”/“easy to rewrite” alone is not evidence that original code is unsuitable. Ideas and architecture may still merit independent reuse; explain why code is not the right carrier and what execution is lost.

States:
- recommended: useful, source inspected, next action named
- blocked: capture/access/permission unavailable, with reason
- captured: manifest and original bytes verified
- integrated: adaptation actually present in destination with source mapping
- verified: destination behavior, safety repairs and attribution checked with receipts

Capture and integration are separate fields. A source bundle does not mean installed or harvested. Only verified destination integration may be called Harvested. Copy/adapt into another product only under that product's authorized scope; evaluation alone does not authorize unrelated edits or installs. Retest adapted behavior/security at the destination, including all changed callers and retained dependencies. Rechecks compare the captured revision, upstream changes and destination code before recommending updates.

