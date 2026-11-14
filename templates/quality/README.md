# Bob's quality checks

Checks on what the user sees and on the code's tidiness, run on every pull request inside a GitHub check job. They catch, before a change merges:

| Check | Fails when | File |
|---|---|---|
| **Does each page load** (smoke) | a declared page or route answers with an error (a server error never passes) or doesn't answer | `smoke.mjs` |
| **Looks like the locked design** (visual) | a page's screenshot differs from its reference image by more than the declared tolerance, or has no reference image | `visual-check.mjs`, `png.mjs` |
| **Accessibility** | the axe-core scan finds a serious or critical problem, such as a form control with no label | `a11y-scan.mjs` |
| **Speed budget** | a declared page loads slower than its budget (1 second unless the page says otherwise) | `speed-budget.mjs` |
| **Dead and duplicated code** | Knip finds a new unused file, export or dependency, or jscpd finds a new copied block; what the code had when you adopted the scan is baselined | `code-scan.mjs` |
| **Live-figure list** | the product's list of live figures to re-check after each deploy has an empty or malformed field | `live-figures-check.mjs`, `live-figures.json` |

`run.mjs` is the one entry point for the page checks and `quality-lib.mjs` holds what they share. `quality-check.yml` is the GitHub workflow.

**No secrets, no production.** The job builds and starts the product on GitHub's machine with test data from a committed file, reads no secret, and its token can only read the repository. Hosting (for example Vercel) keeps deploying only from `main`. Each check **fails closed**: a missing config, a product that never starts, a tool that isn't installed or output it can't read is a failure, never "all clear".

## Adopt

From the product's folder, with Bob at `~/Desktop/bob-the-builder` (adjust the path to where Bob lives):

```bash
BOB=~/Desktop/bob-the-builder/templates/quality
mkdir -p scripts/quality .quality .github/workflows
cp $BOB/quality-lib.mjs $BOB/run.mjs $BOB/smoke.mjs $BOB/visual-check.mjs $BOB/png.mjs $BOB/a11y-scan.mjs \
   $BOB/speed-budget.mjs $BOB/code-scan.mjs $BOB/live-figures-check.mjs scripts/quality/
cp $BOB/quality-check.yml .github/workflows/quality-check.yml
```

Then write three things, using `fixtures/quality-app/.quality/` in the Bob repo as a worked example:

1. **`.quality/config.json`**: how to build and start the product (`start.build`, `start.command`, `start.url` on localhost, `start.testDataFile`), the pages to check (`pages`: a `name` and `path` each, with an optional `speedBudgetMs` and `"visual": false` for a page whose look isn't locked), and any API routes (`routes`, with `expectStatus` for one that should answer, say, 401). Optional: `visual` (`maxDiffRatio`, default 0.001 = 0.1% of pixels; `pixelThreshold`, default 0.1; `width` × `height`, default 1280 × 800), `speed` (`defaultBudgetMs`, `runs`), `a11y` (`failOn`). An unknown key is refused, so a typo can't switch a check off.
2. **`.quality/test-data`**: `KEY=VALUE` lines the product needs to start with test data (a test database address, fake keys). It is committed, so nothing in it may be real.
3. **Reference images and the code baseline**, made once: run the workflow by hand with "update_references" ticked, download the `screenshots` artifact into `.quality/reference/`, and run `node scripts/quality/code-scan.mjs --update-baseline` (after installing the scanners with the `npm install --no-save` line in `quality-check.yml`, which holds the pinned versions) to write `.quality/code-scan-baseline.json`. Commit all of them.

For a product with live figures people act on, copy `live-figures.json` to `.quality/live-figures.json` and fill in every field; the check job validates it, and the after-deploy re-check reads it.

Make **Quality checks / quality** a required check (Bob Step 6b, `.claude/required-checks.json`) once it passes on `main`.

## When a check fails

- **visual:** the job's `screenshots` artifact holds each page's new screenshot (`.quality/out/`) next to its reference. If the change was meant to alter the look, make new references as in step 3 above and commit them with the change; the change's approval should name them.
- **code scan:** delete the dead code or reuse the copied block. Rewrite the baseline only to drop findings that were fixed, never to accept a new one silently.
- **speed:** the job prints each run's time; the middle of the runs counts, so one slow run alone doesn't fail it.

## How Bob proves these checks

`scripts/quality-tools.test.mjs` (no dependencies) and `scripts/quality-tools-e2e.mjs`, which adopts the checks into a copy of `fixtures/quality-app`, plants one fault at a time (a route returning a server error, a screen drift, an unlabelled control, a slow page, a dead export, a duplicated block, an empty live-figure field) and requires each to fail while the clean copy passes. Both run in Bob's CI.
