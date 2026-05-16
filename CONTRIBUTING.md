# Contributing

Bob is a personal protocol that I maintain based on real projects I'm building. Outside contributions are welcome, but please read this first so we don't waste each other's time.

## Before you open a PR

**Open an issue first** describing what you want to change and why. I'd rather agree on direction up front than reject a finished PR.

Likely-to-be-accepted contributions:
- Bug fixes in `scripts/` (clear repro, narrow change)
- Typos, broken links, formatting issues
- New entries in Appendix L (Integration Playbooks) for services you've used — bring real evidence: what broke, what worked, env vars, gotchas.
- New entries in Appendix K (Project Profiles) for archetypes Bob doesn't cover well yet.

Likely-to-be-rejected contributions:
- Adding new top-level sections without an issue discussion first — Bob's structure is intentional and additive-only doesn't always serve the non-engineer reader.
- Removing or weakening human gates (`→ HG`), reconciliation steps, or audit requirements. These are load-bearing based on real project pain.
- Adding tool-specific advice that will rot fast. Bob owns methodology; Anthropic skills (vercel:*, claude-api, etc.) own current tactical detail — see §10.5.

## Style

- **Plain English.** Bob is for non-engineers. If a rule needs jargon to be understood, simplify it.
- **Cite the failure mode.** New rules should reference a real project failure they would have prevented. "EMBT had 70% fix-commit rate because X" is better than "best practice says X."
- **Update the changelog.** New behaviors land in `build-protocol.md`'s version table with a one-line "Triggered By" reason.

## Code in `scripts/`

- Shell scripts use `bash` (not `sh`) and `set -euo pipefail`.
- Stay POSIX-portable across macOS BSD and Linux GNU userlands.
- No external dependencies beyond standard Unix tools + `git`.

## Reviews

I review on weekends, usually. If you don't hear back within a week, ping the issue.

## Code of conduct

Be kind. Be specific. Show your work. Don't waste people's time.
