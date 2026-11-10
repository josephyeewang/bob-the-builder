// review-roles.mjs — the AI roles whose verdict lets a change merge (lead calls L44, L65).
//
// One list, so the launcher (M4), the record (M9) and the Dispatcher (M11) can't drift. A session in one of these roles
// runs only as the separate Mac user `review`, started by the review runner (M4 review-runner.mjs), never by the
// Dispatcher or the launcher's own user.

export const REVIEW_ROLES = Object.freeze(['reviewer', 'auditor']);
// The plan reviewer (L683, L688) reads one Tier-1 card's plan before its go. It runs as the review user, started by the
// review runner, so a worker can't write its answer; but its answer is a plan check, never a verdict, so it stays out of
// REVIEW_ROLES: nothing it writes can count toward a merge. RUNNER_ROLES is every role the runner starts.
export const PLAN_REVIEW_ROLE = 'plan_reviewer';
export const RUNNER_ROLES = Object.freeze([...REVIEW_ROLES, PLAN_REVIEW_ROLE]);
