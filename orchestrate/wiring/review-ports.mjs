// The ports for reviews, plans and the checks around them (group A of the wiring split).
//
// `wire()` calls `reviewPorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_REVIEW, in the same change. dispatcher-wiring.mjs stays as it is.

export const NOT_WIRED_REVIEW = Object.freeze(['hasReviewer', 'requestReview', 'reviewAlerts', 'startPlanReview', 'planReviewAnswer',
  'planRows', 'planView', 'mainSha', 'filesOf', 'gateAlive', 'wait', 'healthy', 'resume']);

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function reviewPorts(ctx) {
  void ctx;
  return {};
}
