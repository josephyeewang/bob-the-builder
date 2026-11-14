# Skill craft: writing, testing, reviewing and diagnosing skills

How Bob writes and changes skills (its own, a project's, or a change a self-improvement run proposes). Open the
file for the job in hand:

| Job | File |
|---|---|
| Write a new skill or change one, test first | `writing-skills.md` |
| Run the red and green tests it asks for, with fresh helper sessions | `testing-skills-with-helpers.md` |
| Add or change a rule in an always-read instruction file (CLAUDE.md, AGENTS.md) | `testing-instruction-files.md` |
| Review a new or changed skill before merge | `skill-reviewer.md` |
| Find out why a skill misfired in a past session | `diagnosing-a-skill.md` |

Two scripts do the counting: `scripts/skill-review-check.mjs` (frontmatter, description, body size, missing
files) and `scripts/skill-size/test-skill-size.sh` (the byte limit a compaction cuts at, for Bob's own skills).
Sources and licences: `third_party/README.md`.
