# Standalone skill exports

Portable modules live in `skills/<id>/`. They are the maintained source used by
Bob and other assistant setups, not generated paraphrases of private commands.
`skills/exports.json` is the public export contract. It declares metadata, an exact
file allowlist, required license notices and optional companion modules.

## Add a module

1. Put the generic capability in `skills/<id>/SKILL.md` and its relative resources.
   Move personal paths, project discovery, memory destinations and publishing
   integrations into private adapters outside this repository. Keep existing
   callers compatible when changing a maintained capability.
2. Test a standalone copy with synthetic context. A module must work without Bob,
   another module, private settings, a specific assistant's native tools, or the
   author's project history. Mark optional lanes, providers and costs explicitly;
   preserve a supported fallback for the core workflow.
3. Add one registry entry with an exact relative file list and all required
   notices. No directory glob exports. New files require an explicit registry edit.
   Bundle tests only when useful to the recipient; run all source tests in CI.
4. Run the exporter tests, the module's own tests and a preview export. Inspect
   archive contents and use a fresh-context privacy/behavior review before release.
5. Merge reviewed source through the normal approval path. The source-change
   workflow validates committed files and publishes versioned ZIPs. A website
   listing is a separate reviewed editorial choice; registration does not add it.

Set `BOB_ROOT` to the resolved checkout folder; these commands then work from
any project folder. This is a local shell variable, not an assistant install path.

```sh
BOB_ROOT="/absolute/path/to/bob-checkout"
python3 -m unittest discover -s "$BOB_ROOT/scripts" -p 'test_skill_*.py'
python3 "$BOB_ROOT/scripts/skill_export.py" --root "$BOB_ROOT" --working-tree --output "$BOB_ROOT/.audit/skill-preview"
# From a verified committed checkout:
python3 "$BOB_ROOT/scripts/skill_export.py" --root "$BOB_ROOT" --output "$BOB_ROOT/.audit/skill-release"
```

Python 3.10+ and Git are required for exporting. Module runtime requirements are
in each skill. Development previews carry `preview: true` and cannot be published.
Committed exports read exact Git blobs, so untracked/local files cannot enter them.
ZIP entries have deterministic order, timestamps and modes. `module.json` records
the source revision and each file hash; `catalogue.json` records each archive hash.
The public-file scanner is an extra guard, not proof of privacy: review the actual
allowlist and contents. Exporting does not run arbitrary module instructions.

## Update flow

`skills/**` → read-only validation → immutable `skills-<full commit>` release
assets → atomic `skill-downloads` branch `catalogue.json` update → consumers.

The same-repository workflow uses GitHub's built-in token, with write permission
only in its publication job. Pull requests never receive publication permission.
It does not read a private machine or require a personal access token. The
catalogue advances only after every archive is uploaded and verified. Retries
accept identical assets; different bytes under the same version are an error.
Publication must refuse stale source so an older run cannot roll the catalogue back.
GitHub service availability and repository policies can still block publication;
a successful local export is not proof that the hosted workflow has run.

Downloaded copies are snapshots. Updating the source changes future downloads,
not files someone has already installed. Users review and replace those explicitly.
Consumers should validate the repository, schema, revision and immutable download
URL; they must not execute content merely because it appears in a catalogue.

## Private integrations

A personal command may select a mode or provide explicit project roots and a
private memory directory to the public module. It must delegate the core procedure
or import the public implementation rather than copying it. Keep personal discovery,
site publishing and native assistant registration private. If the portable module
is absent, report the missing dependency; do not silently revive an old fork.

Use module-relative resource paths. Do not require a particular install directory.
Provider credentials, if an optional lane needs them, remain outside source and
archives and follow the caller's credential setup process.

## Website contract

The website keeps an explicit reviewed list of skill IDs and a generated display
snapshot. It fetches `https://raw.githubusercontent.com/josephyeewang/bob-the-builder/skill-downloads/catalogue.json`
for current versioned downloads; a failed or invalid fetch leaves source links
available and reports downloads unavailable. No site redeploy is needed to advance
an existing skill's download. Adding a listing or changing its visible copy still
follows the site's approval rules.

PushAll covers only the current session save-and-handoff procedure. Whole-project closeout is a separate caller; it may reuse that procedure without placing merge/cleanup modes inside the public PushAll module.
