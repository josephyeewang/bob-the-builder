# Security

Bob the Builder is a method written in markdown plus the scripts that check it. It does not run as a server, does not collect data, and does not phone home (the one network call is the update check below, a plain `git fetch` from this repo). But it is more than text: it installs hooks and checks into every project it sets up, and Claude runs its scripts on your machine. This page says what runs where, so you can judge it.

## Reporting a vulnerability

If you find a security issue — for example, a way the install prompt, `bob-init.sh`, a hook Bob installs, or the SKILL.md can be abused to run unintended commands on a user's machine — please report it privately:

📧 **joe@joe.wang**

Please do **not** open a public GitHub issue for security reports. I'll respond within a few days and credit you in the fix commit if you'd like.

## What runs, and where

**On your machine, in Bob's own folder (every `/bob` session):**
- `scripts/bob-update-check.sh` — at most once a day, a `git fetch` from this repo to see whether a newer Bob exists. It only reports; it never pulls.
- `update bob` (only when you ask) — `git pull --ff-only` in Bob's folder. It refuses to pull on top of local changes or a diverged copy and tells you instead.
- Bob's checks (`scripts/*.sh`, `scripts/*.mjs`) when a step calls for them. They read files and git history; the ones that write say so in their header.

**In your project, set up once by `scripts/bob-init.sh` (or `/bob UPGRADE`):**
- `.claude/settings.json` with Claude Code hooks that run on every Claude action in that project:
  - **block-no-verify** — refuses commands that skip the commit checks (`--no-verify` and its variants).
  - **config-protection** — refuses edits that loosen existing lint or format settings.
  - **merge guard** — refuses a merge or push to main unless the checks listed in `.claude/required-checks.json` passed.
  - **green gate** — when Claude tries to finish, runs your project's test command (`.claude/hooks/green-gate.sh`) and sends Claude back if it fails, up to a capped number of tries.
  - a format hook that only prints a reminder until you set it.

  The hook files are **copied into** `.claude/hooks/`, not pointed at Bob's folder, so a later Bob update never changes them silently; `/bob UPGRADE` shows you the difference and asks first.
- A **git pre-commit hook** that runs `coherence-check.sh` (a consistency check of the project's docs). It blocks a commit only where `.bob/installed.json` says so; otherwise it warns.
- A **daily GitHub Actions check** (`.github/workflows/loop-check.yml`) — read-only permissions, no secrets; it fails the run (and GitHub emails you) when work has been dropped.
- `.bob/installed.json` — a record of what was installed and from which Bob commit. Nothing reads it but Bob.

`bob-init.sh` only creates files; it never deletes or overwrites an existing file. The project name is checked against a safe-folder-name pattern.

**The design skills (only when you use them):** `design-mockups` sends your prompts and reference images to Google's image API with your own key, which is read from a file you name and never printed. `design-gallery` may query the Inspo reference-site service with the search text of your brief; it skips that for confidential client work.

If any of the above stops being true in a future change without this page changing, treat that as a security regression and report it.

## Scope

In scope:
- Anything in this repo that runs on a user's machine or in their project — scripts, hooks, the install prompt in the README, the SKILL.md instructions Claude follows.
- Anything that could trick a user into running unsafe commands.

Out of scope:
- Issues with Claude Code itself ([report to Anthropic](https://github.com/anthropics/claude-code/issues)).
- Issues with the user's own product code.

## Supply chain

Bob reaches users through `update bob` (a `git pull` from this repo). So **any commit merged here reaches every user on their next update**, and that includes the hooks a later `/bob UPGRADE` offers to install. The trust model rests on the maintainer's discipline. To make it visible:

**Maintainer side:**
- Every change goes through a pull request and the checks in `.github/workflows/scripts-ci.yml`; nothing merges with a failing check.
- Changes to `scripts/`, `scripts/hooks/`, `skill/SKILL.md`, the README install prompt or this file get the full diff read, not just the summary.
- New contributors land docs-only changes first.

**User side:**
- Bob has no release tags. Each version is a commit on `main`; `VERSION` names it and `CHANGELOG.md` says what changed. If you want to stay on a version you trust, don't run `update bob` until you have read the changelog entries it would bring in (it tells you how many commits are coming).
- If you have changed your copy of Bob, `update bob` will refuse to pull over your changes — that's intentional.
- **Check the repo address** is `https://github.com/josephyeewang/bob-the-builder` before installing. Forks with similar names can ship changed scripts.
