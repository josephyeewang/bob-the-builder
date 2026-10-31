// review-roles.mjs — the AI roles whose verdict lets a change merge (lead calls L44, L65).
//
// One list, so the launcher (M4), the record (M9) and the Dispatcher (M11) can't drift. A session in one of these roles
// runs only as the separate Mac user `review`, started by the review runner (M4 review-runner.mjs), never by the
// Dispatcher or the launcher's own user.

export const REVIEW_ROLES = Object.freeze(['reviewer', 'auditor']);
