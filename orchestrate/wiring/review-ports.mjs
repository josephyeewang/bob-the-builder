// The ports for reviews, plans and the checks around them (group A of the wiring split).
//
// `wire()` calls `reviewPorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_REVIEW, in the same change. dispatcher-wiring.mjs stays as it is.
//
// WIRED (A1, L615): the GitHub reads, through the read-only client the rules reader uses (ctx.gh), so they reach
// api.github.com only and can't write.
//   mainSha({ product })  → main's commit, 40 hex. The launch record and a go ask name it. Throws when it can't be read.
//   planView({ product }) → M10's git view of the product's repository; plan-go asks it `isDir(sha, path)`.
//   wait(ms)              → a plain timer, for intake's settle wait.
// A product other than this Dispatcher's is refused: one Dispatcher runs one product (M9), and reading another
// product's repository would answer for the wrong one.
// NOT HERE: `filesOf` answers at once (undo.mjs calls it without waiting), from the local mirror, so it is not a GitHub
// read; it stays listed until the mirror is wired.

import { makeGitView, notRead } from '../modules/M10-rules/git-view.mjs';
import { BRANCH } from '../modules/M10-rules/reader.mjs';

export const NOT_WIRED_REVIEW = Object.freeze(['hasReviewer', 'requestReview', 'reviewAlerts', 'startPlanReview', 'planReviewAnswer',
  'planRows', 'filesOf', 'gateAlive', 'healthy', 'resume']);

const SHA = /^[0-9a-f]{40}$/;

/** The GitHub reads for one product: `gh` the read-only client, `entry` the product's products.json entry. */
export function githubReads({ gh, entry }) {
  if (!gh || typeof gh.get !== 'function') throw new Error('the GitHub reads need the read-only client');
  const own = (product) => {
    if (product !== entry.product) throw new Error(`this Dispatcher runs product ${entry.product}, so it can't read product ${product}'s repository`);
  };
  return {
    mainSha: async ({ product } = {}) => {
      own(product);
      let r;
      try { r = await gh.get(`/repos/${entry.owner}/${entry.repo}/git/ref/heads/${BRANCH}`); } catch (e) { throw notRead(e); }
      if (r?.status !== 200) throw new Error(`GitHub answered ${r?.status} for the ${BRANCH} branch`);
      const sha = r.json?.object?.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`GitHub named no commit for the ${BRANCH} branch`);
      return sha;
    },
    // A new view each call: its answers are kept for the call's own pass only, so a later pass reads GitHub again.
    planView: async ({ product } = {}) => { own(product); return makeGitView({ gh, owner: entry.owner, repo: entry.repo }); },
  };
}

/** A plain timer. A wait that can't be read waits no time at all, rather than for ever. */
export const wait = (ms) => new Promise((ok) => { setTimeout(ok, Number.isFinite(ms) && ms > 0 ? ms : 0); });

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function reviewPorts(ctx) {
  return { ...githubReads({ gh: ctx.gh, entry: ctx.entry }), wait };
}
