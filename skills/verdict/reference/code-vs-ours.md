# Discover and compare parts

For every repository, map entry points, meaningful modules, journeys/screens, prompts, assets, examples and tests before selecting claims. Explore implementation, architecture/method, ideas, UI/workflow and product angle. Follow promising paths beyond the README/category; examples are seeds, not a fixed checklist. Identify whether the inspected repository implements the product or only wraps a hosted service; do not transfer wrapper behavior or license claims to the inaccessible product or its third-party catalog. Record inspected/omitted areas and reasons for rejecting plausible candidates. No invented positive quota.

For recommended source reuse, inspect callers, local dependencies, tests and output. Compare with the user's actual delivery path under relevance.md. Judge correctness, edge cases, enforcement, complexity, operability and user experience with evidence. A useful part can fill a new need. Existing code is not presumed better.

Detailed visual review lives in ui-ux.md; product angle and sourced pain fit live in relevance.md. Give strong opportunities a concrete before/after, adaptation burden, next action and prerequisite. Use plain behavior tags and explicit projects for recall, not popularity ranking.

| Decision | Evidence required |
|---|---|
| TAKE AS-IS | Exact source/revision, benefit, supporting files, destination and permission |
| TAKE AND ADAPT | Same plus named changes, preserved behavior and regression check |
| TAKE THE IDEA, WRITE OUR OWN | Inspected source, concrete rewrite advantage/restriction and execution potentially lost |
| OURS IS BETTER | Both sources plus specific implementation/behavioral advantage |
| DON'T NEED | Reason tied to the user's use, with adjacent uses considered |
| INVESTIGATE | Missing evidence and next check; unknown is not absent |

Whole-tool decisions are separate; group repetitive parts openly. Wrong language, short code or “we can write it” alone is insufficient reason to discard tested execution. Ideas and positioning can be useful even when copying code isn't the right carrier. Capture/permission/state details live in source-capture.md.

When safe/practical, compare both implementations on representative identical inputs, save outputs and use blind-judge.md. Say what cases remain untested; declarations, test counts and green builds do not prove behavior.

