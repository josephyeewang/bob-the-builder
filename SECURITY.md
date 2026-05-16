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
- `bob-init.sh` only creates files inside a project directory the user names. It never deletes existing files.
- The SKILL.md tells Claude how to read protocol files and (on user request) run `git pull` inside Bob's own repo. It does not ask Claude to run commands outside Bob's install location.

If any of the above stops being true in a future change, treat that as a security regression and report it.
