// asks.mjs — the names every module uses for the owner's asks: the ask kinds and the question-box statuses (0b-5 spec
// review, round 2 m2-6, round 5 m5-4). Defined once here, beside record.mjs's names, so M2 Approvals (which writes asks),
// M10 Rules (which says which answer channel an ask needs) and M1 Front Door (which shows the boxes) can't disagree.
//
// WHY. Each kind has its own rules: how the owner answers it, whether it lapses after 12 hours, whether the 24-hour
// "approved but not merged" rule applies, whether it is urgent. One table, so no module retypes a kind's rules. An ask of
// a kind not in this table, or of an inactive kind, is refused when written (M2's writer).
//
//   channel        'tap'           a tap on M2's own question box in a Front Door or thinking session (round 1 M1)
//                  'github_review' the owner's Approve in the GitHub app (round 1 M4); go_t1 and decision on a decision PR
//   lapse          true: lapses 12 h after it is raised, once re-asked, then expires (round 1 M5). Go asks never lapse.
//   merge_approve  true: the answer authorises a merge, so the 24-hour rule applies from raised_at (L12, round 2 m2-11)
//   decision_pr    true: asked as a decision pull request the robot opens and closes unmerged (round 1 M9, round 2 M2-3)
//   go             true: the answer is the owner's go on a plan fingerprint (R-0b-52)
//   urgent         the default urgent set, in order (`undo` first); approvals.urgent in the rules may list the same kinds
//   choices        the box's labels, in order; the first is the one that approves (`positive`)
//   active         false: named now, built later (R-0b-114, the cutover kit); refused in 0b

const kind = (k) => Object.freeze({ lapse: false, merge_approve: false, decision_pr: false, go: false, urgent: false, active: true, ...k,
  choices: k.choices ? Object.freeze([...k.choices]) : null });

export const ASK_KINDS = Object.freeze({
  go_t2: kind({ channel: 'tap', go: true, choices: ['Go', 'Change', 'Not now'] }),
  go_t1: kind({ channel: 'github_review', go: true, decision_pr: true, choices: ['go'] }),
  risky_approve: kind({ channel: 'github_review', lapse: true, merge_approve: true }),
  decision: kind({ channel: 'github_review', lapse: true, decision_pr: true }),
  tap_yes_no: kind({ channel: 'tap', lapse: true, choices: ['Yes', 'No'] }),
  undo: kind({ channel: 'tap', lapse: true, urgent: true, choices: ['Undo', 'Keep'] }),
  incident_repair: kind({ channel: 'tap', lapse: true, urgent: true, choices: ['Repair', 'Leave it'] }),
  back_to_active: kind({ channel: 'tap', lapse: true, choices: ['Back to active', 'Not yet'] }),
  jobs_list: kind({ channel: 'tap', active: false }),
  lessons_list: kind({ channel: 'tap', active: false }),
});

export const URGENT_DEFAULT = Object.freeze(Object.keys(ASK_KINDS).filter((k) => ASK_KINDS[k].urgent));

// A known kind that 0b builds.
export const activeKind = (k) => typeof k === 'string' && Object.hasOwn(ASK_KINDS, k) && ASK_KINDS[k].active ? ASK_KINDS[k] : null;

// Question-box statuses (round 5 m5-4). Only `approvals` sets any of them. `answered` and `released` are final: a counted
// tap is never undone (M5-2), and a released box never binds again. `mismatched_question` is a box that bound nothing.
export const BOX_STATUSES = Object.freeze({
  bound: Object.freeze({ final: false, setBy: 'approvals' }),
  answered: Object.freeze({ final: true, setBy: 'approvals' }),
  released: Object.freeze({ final: true, setBy: 'approvals' }),
  mismatched_question: Object.freeze({ final: true, setBy: 'approvals' }),
});

// Why a box was released (round 3 M3-1, round 4 m4-1, round 5 M5-1 — a closed list; a push or re-push is never one).
export const RELEASE_REASONS = Object.freeze(['typed', 'declined', 'session_replaced', 'session_ended', 'tampered',
  'lapsed', 'withdrawn', 'expired', 'answered_elsewhere']);

// The ask document's fields, written only by `approvals` (round 1 m6). Listed so a reader knows what it may rely on.
export const ASK_FIELDS = Object.freeze([
  'kind', 'product', 'card', 'title', 'state', 'created_at', 'raised_at', 'raised_reask', 'first_pushed_at', 'reask_count',
  'choices', 'recommended', 'payload', 'payload_sha256', 'payload_still_open', 'payload_still_open_sha256',
  'origin_session', 'boxes', 'released_typed', 'answer', 'pr', 'fingerprint', 'fingerprint_inputs', 'rows', 'files',
  'modules', 'window_pushes', 'last_push_at', 'lapsed_at',
]);
