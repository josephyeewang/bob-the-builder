---
name: pushall
description: Save the current session's verified changes, push its branch, preserve unmerged work and leave a handoff. Use for wrap up, done for now, closing this tab, save where we are, or pushall. Does not close out the whole project or clean up branches.
---

# PushAll

Actually perform the authorized checks, saves and handoff in this turn. Report what happened; do not substitute a proposed command list for execution. If tools or permissions block an action, complete independent safe work and state the blocker and recovery step.

## Choose the scope

**Save this session and hand off.** Requests such as “done for now,” “wrap this up,” or “closing this tab” cover this session's work only. They do not authorize merging other branches, closing the whole project, or removing anything.

Read the project's instructions and existing current-state/handoff documents. Follow their verification, review and publishing rules. This skill grants no additional permission to launch a feature, publish public pages or copy, send messages, change production settings/data, create a remote repository, or delete anything. Establish the applicable boundary before taking an action that could trigger an automatic deployment.

## Save and hand off

1. **Establish ownership and the destination.** Determine the repository root, main repository when in a worktree, current branch, configured upstream, and working-tree state. Identify this session's intended changes and other active lanes. Inspect diffs; do not infer ownership from filenames alone. Keep another lane's edits and staged work intact. If ownership is unclear, leave those changes out and identify them in the handoff. Never resolve a collision by resetting, stashing, checking out over, or discarding another owner's work.

2. **Verify the exact work to save.** Run the project's documented checks for the change, including its type-check, build and tests where present. Consult documented commands or package scripts when needed. Fix failures within this session's scope and rerun affected checks after new edits. Do not change unrelated work to make checks pass. Do not bypass hooks, checks or review gates. Missing, blocked and unrun checks are distinct from passed checks.

   If verification is blocked, preserve unfinished files and the worktree, save the handoff, and report “saved locally; verification blocked.” Do not commit or push those unverified changes as completed work.

3. **Merge the handoff.** Use the project's existing handoff destination or a destination supplied by the caller. Without one, use a clearly named project-local Markdown handoff; do not create a global registry. For a non-repository folder, use a local document in that folder. Keep private context within the project's approved storage boundary; do not put private session details into a public tracked document. If a suitable private destination is unavailable, report that limitation rather than publishing the context.

   Read the existing handoff in full. Replace only this lane's block, preserving other lanes, open decisions and partly answered questions. Include the lane/owner, an ISO UTC update time, current branch/revision when applicable, verified results, unfinished work, blockers and one concrete next starting action. Identify corrections to another lane's statements explicitly. Recheck the file before writing; if it changed, read and merge the newer version. Prefer targeted edits, verify other lanes' distinctive content survived, and stop on unresolved collisions rather than overwriting. Ordinary file writes do not provide a cross-application lock; do not claim atomic merging unless the available mechanism provides it.

4. **Commit only this session's verified changes.** Inspect the staged diff as well as the working diff. Stage only intended paths or hunks. If unrelated changes are already staged, use a supported isolated commit method or stop the commit with a clear blocker; never accidentally include them or silently alter their staging. Ensure the committed snapshot is the one checked. Do not claim whole-project verification when another lane's edits affected the checks. If safe isolation is needed, use a project-approved isolated checkout containing only the intended changes. Keep interrupted work intact.

5. **Upload to the configured destination.** Push this branch to its approved upstream using the available Git/hosting tools. If the upstream is missing, use a known approved remote and target only when project instructions or the user's request establish them; otherwise report the missing destination. Do not create a repository or invent a backup service as a wrap-up side effect. A failed push means local-only work. Verify the remote branch/revision before reporting a successful upload; local tracking state alone is insufficient.

6. **Protect unmerged branch work.** Create or update its pull request (or equivalent review request) when the project's workflow calls for one. Inspect the actual target branch and merge history. A pushed branch, an open review request, or an empty comparison alone is not proof that the intended work merged. PushAll never removes branches or worktrees.

7. **Verify delivery where applicable.** Follow the project's approved deploy flow. Confirm the deployed revision and run available smoke/integration checks against it; a successful deployment listing alone does not prove product behavior. A branch awaiting review may correctly have no production deployment. Do not deploy unrelated services.

For a folder without Git, save the handoff and identify the actual saved files and verification results. Do not initialize Git, commit, push, or imply a remote backup. Preserve context in existing project records where appropriate; do not install a personal memory system.

## Report

State this session's scope, verification results and limitations, saved commit, verified upload, review-request and deployment states, handoff location, and unresolved questions. Explicitly identify local-only work, incomplete checks, unavailable hosting operations and missing approvals. Confirm other lanes' handoff content survived when applicable. Do not turn attempts or stored configuration into claims of successful delivery.
