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
//
// WIRED (A3a): planRows({ product, card }) → { <row id>: row }, the rows the card names: the row files among its files
// (M2's ROW_FILE; cards have no rows field, L684), each read from docs/blueprint/rows/<id>.yaml at main's current
// commit with the Merge Gate's own row reader (M6 gather.mjs readRowAt), so the go asked and the go checked read a row
// the same way. A card the Record doesn't have, one with no row file among its files, and a row that is missing or
// can't be parsed at that commit throw: plan-go tells it under the card, and no go is asked on a row that wasn't read.
// M2 raiseGo then checks the rows against the card (plain ids, each row's done_when, the card's done_when is their
// pass tests). The read-only client refuses any `..` in a path, so a row id can't reach outside the rows folder.
// WIRED (A2, L615, L639): the review runner's three ports, from M11 review-requests.mjs. The Dispatcher only writes a
// request into the runner's requests folder and reads its status file; it never starts a reviewer (L65).
//   requestReview, hasReviewer, reviewAlerts   as in review-requests.mjs reviewPorts
// WIRED (A3b, L703): the plan reviewer's two ports, from the same file. startPlanReview writes a plan request (the card
// and its plan's fingerprint) into the same requests folder; the runner checks it against the Record and starts the
// reviewer. planReviewAnswer reads the answer from the runner's own ended record beside its status file. Another
// product's card is refused, as the GitHub reads refuse it.
// The stamp check (is the reviewers' installed copy at main?) compares the copy's stamp with root's own record beside
// that copy (install-check.mjs mainSeenFile), which root's updater writes each time it fetches main. Not with mainSha:
// the copy is the orchestrate code, fetched from the repository updater.json names, not the product's (L639). A record
// that can't be read, or whose last check is older than MAIN_SEEN_STALE_MS, can't say whether the copy is behind, so
// the stamp hold is kept and the owner is told, at once and then daily (statusAlerts' "main can't be read").
// NOT HERE: `gateAlive` asks whether the Merge Gate is running, and it runs in the robot job's gate pass, which is not
// wired; it has no sign of life to read yet. It moves to whoever wires that pass, which writes a "gate last ran at"
// mark for it (L639).
// NOT HERE: `filesOf` answers at once (undo.mjs calls it without waiting), from the local mirror, so it is not a GitHub
// read; it stays listed until the mirror is wired.

import { makeGitView, notRead } from '../modules/M10-rules/git-view.mjs';
import { BRANCH } from '../modules/M10-rules/reader.mjs';
import { mainSeenHead, reviewPorts as runnerPorts } from '../modules/M11-dispatcher/review-requests.mjs';
import { mainSeenFile, readMainSeen } from '../modules/M4-workshop/launcher/install-check.mjs';
import { UPDATE_EVERY_S } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { GIT_MS } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { pastTime } from '../shared/still-waiting.mjs';
import { readRowAt } from '../modules/M6-merge-gate/gather.mjs';
import { ROW_FILE } from '../modules/M2-approvals/go.mjs';

export const NOT_WIRED_REVIEW = Object.freeze(['filesOf', 'gateAlive', 'healthy', 'resume']);

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

/**
 * The planRows port for one product: `rec` the Record, for the card's files. A card names no rows of its own (M2
 * README), so its rows are the row files among its predicted files, read the way the Merge Gate reads them
 * (gather.mjs, ROW_FILE): the go and the gate agree on which rows a card covers. A card with no row file names no rows,
 * which is told, never asked on.
 * An id that is not plain is read like any other (the path is encoded); M2's go refuses it (checkRows).
 */
export function planRows({ gh, entry, rec }) {
  if (!rec || typeof rec.read !== 'function') throw new Error('planRows needs the Record');
  const { mainSha } = githubReads({ gh, entry });
  const base = `/repos/${entry.owner}/${entry.repo}`;
  return async ({ product, card } = {}) => {
    // One commit for every row: main is read first (which also refuses another product).
    const sha = await mainSha({ product });
    const doc = rec.read('card', card)?.doc;
    if (!doc) throw new Error(`the Record has no card ${card}`);
    if (!Array.isArray(doc.files)) throw new Error(`card ${card} has no file list`);
    const ids = new Set();
    for (const f of doc.files) { const m = typeof f === 'string' ? ROW_FILE.exec(f) : null; if (m) ids.add(m[1]); }
    if (!ids.size) throw new Error(`card ${card} names no row file (docs/blueprint/rows/<id>.yaml) among its files`);
    const rows = {};
    for (const id of [...ids].sort()) {
      const row = await readRowAt(gh, base, id, sha);
      if (!row) throw new Error(`row ${id} is missing at main ${sha.slice(0, 7)}, or can't be read`);
      rows[id] = row;
    }
    return rows;
  };
}

/** A plain timer. A wait that can't be read waits no time at all, rather than for ever. */
export const wait = (ms) => new Promise((ok) => { setTimeout(ok, Number.isFinite(ms) && ms > 0 ? ms : 0); });

// Root's updater fetches main every UPDATE_EVERY_S (M4 review-daemons.mjs, its LaunchDaemon's interval), and stamps its
// record at the end of a run, which can take up to its fetch limit (GIT_MS). A record older than two turns plus that run
// has missed a turn, so the updater may have stopped, and a copy left behind would never be told (L639, L668: 25 min).
export const MAIN_SEEN_STALE_MS = 2 * UPDATE_EVERY_S * 1000 + GIT_MS;
const stopped = (text) => Object.assign(new Error(`Root's updater may have stopped: ${text}.`), { lead: true });

/**
 * Main's commit as root's updater last saw it, from its record beside the review copy; throws when the record can't be
 * read or is stale, so statusAlerts keeps the stamp hold and tells it. `owner` and `top` stand in for root and `/` in a
 * test.
 */
export function mainSeen({ installRoot, now, owner = 0, top = '/' }) {
  return () => {
    const s = readMainSeen(mainSeenFile(installRoot), { owner, top });
    if (!s) throw stopped("its record of main is missing or can't be trusted");
    // In ms in root's record (readMainSeen checks it is a whole number); read through pastTime as every stored time is
    // (L321). A time beyond Date's range can't be read either (audit #263 c1).
    const at = new Date(s.checked_at);
    const t = Number.isFinite(at.getTime()) ? pastTime(at.toISOString(), now()) : null;
    if (t === null) throw stopped("its last check of main has a time that can't be read");
    // Rounded up, so a record just past the limit never reads as the limit itself.
    if (now() - t > MAIN_SEEN_STALE_MS) throw stopped(`it last checked main ${Math.ceil((now() - t) / 60_000)} min ago; it checks every ${UPDATE_EVERY_S / 60} min`);
    return s.commit;
  };
}

/**
 * The review runner's ports, from the config's review keys (dispatcher-wiring.mjs). `selfUid` is the Dispatcher's own
 * user; a test stands in for it, since a test can't make files another user owns. The review user must be neither the
 * Dispatcher's nor the workers' (ownerUid): either could then write the status that says a reviewer runs (L668, L674).
 */
export function reviewRunner({ config: c, now, owner = 0, top = '/', selfUid = process.getuid() }) {
  if (!Number.isSafeInteger(c.reviewUid) || c.reviewUid < 0) throw new Error('config: reviewUid must be a Mac user id');
  if (c.reviewUid === selfUid) throw new Error('config: reviewUid is the Dispatcher\'s own user; the review user must be its own');
  if (c.reviewUid === c.ownerUid) throw new Error('config: reviewUid is the workers\' user (ownerUid); the review user must be its own');
  const main = mainSeen({ installRoot: c.reviewInstallRoot, now, owner, top });
  return runnerPorts({ requests: c.reviewRequestsDir, status: c.reviewStatusFile, reviewUid: c.reviewUid, runnerLog: c.reviewRunnerLog, now,
    mainHead: mainSeenHead({ installRoot: c.reviewInstallRoot, main, owner, top }) });
}

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function reviewPorts(ctx) {
  const runner = reviewRunner({ config: ctx.config, now: ctx.now, selfUid: ctx.selfUid });
  const own = (product) => {
    if (product !== ctx.entry.product) throw new Error(`this Dispatcher runs product ${ctx.entry.product}, so it can't ask about product ${product}'s plans`);
  };
  return { ...githubReads({ gh: ctx.gh, entry: ctx.entry }), planRows: planRows({ gh: ctx.gh, entry: ctx.entry, rec: ctx.rec }), wait, ...runner,
    startPlanReview: (x) => { own(x?.product); return runner.startPlanReview(x); },
    planReviewAnswer: (x) => { own(x?.product); return runner.planReviewAnswer(x); } };
}
