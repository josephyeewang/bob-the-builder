# Security

Bob the Builder is a markdown protocol plus a couple of shell scripts (`scripts/bob-init.sh`, `scripts/repo-map.sh`). It does not run as a server, does not collect data, and does not phone home.

## Reporting a vulnerability

If you find a security issue — for example, a way the install one-liner, `bob-init.sh`, or the SKILL.md can be abused to run unintended commands on a user's machine — please report it privately:

📧 **joe@joe.wang**

Please do **not** open a public GitHub issue for security reports. I'll respond within a few days and credit you in the fix commit if you'd like.

## Scope

In scope:
- Anything in this repo that runs on a user's machine — scripts, install commands in the README, the SKILL.md instructions Claude executes.
- Anything that could trick a user into running unsafe commands.

Out of scope:
- Issues with Claude Code itself ([report to Anthropic](https://github.com/anthropics/claude-code/issues)).
- Issues with the user's own project (Bob doesn't ship runtime code).

## What "secure" means for this repo

- The install one-liner only writes to `~/tools/` and `~/.claude/skills/`. It does not run code from third parties.
- `bob-init.sh` only creates files inside a project directory the user names. It never deletes existing files. `$PROJECT_NAME` is validated against a safe-directory-name regex.
- The SKILL.md tells Claude how to read protocol files and (on user request) run `git pull` inside Bob's own repo. It does not ask Claude to run commands outside Bob's install location. The `update bob` command is divergence-aware — it refuses to pull on top of a diverged or uncommitted install and surfaces the state instead.

If any of the above stops being true in a future change, treat that as a security regression and report it.

## Supply chain (v2.12)

Bob propagates to users via `update bob` (which runs `git pull` from this repo). That means **any commit merged here can reach every user on their next update**. The trust model rests on the maintainer's discipline. To make that discipline legible:

**Maintainer side (Joe):**
- PRs touching `scripts/`, `skill/SKILL.md`, the install one-liner in `README.md`, or this `SECURITY.md` get extra scrutiny — review the diff in full, not just the summary
- New contributors land docs-only changes first; only after a few clean PRs do they get review credibility for scripts/skill changes
- Pre-merge: re-read the diff, not just the description
- Releases are tagged (`vX.Y` annotated tags). Untagged commits between releases are work-in-progress.

**User side (cautious adopters):**
- Pin to a tagged version instead of `main` if you want predictability. The install one-liner clones HEAD by default; to pin, replace the clone command with: `git clone --branch v2.12 --depth 1 https://github.com/josephyeewang/bob-the-builder.git` (substitute the latest tag).
- When `update bob` reports new commits, glance at the changelog (`build-protocol.md` Appendix I) before accepting big changes. The divergence-aware `update bob` will tell you how many commits are coming in.
- If you've forked Bob and customized it, `update bob` will refuse to pull on top of your local changes — that's intentional. Resolve merges manually so your customizations don't get clobbered.

**Verify the canonical repo URL** is `https://github.com/josephyeewang/bob-the-builder` before running the install one-liner. Forks with similar names can ship modified install scripts.
