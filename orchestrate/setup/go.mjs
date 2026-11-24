// go.mjs — the owner's go on a draft card already in the Record, typed by its id, with no card file (Track A step 9,
// design v4 §10.0).
//
//   sudo -k -u orchestrate node <installed copy>/setup/go.mjs <the Dispatcher's config> <card id>
//
// Joe types it in a Ghostty shell tab (a shell function `go <card>` runs exactly this line; the owner step says how).
// It is go-card.mjs's go without the card file: the card is the one the Record already holds, made by a Lead's plan or
// by go-card itself, and it is read from the Record, never from anything a session wrote.
//
// THE GUARD IS THE SAME AS GO-CARD'S (go-card.mjs header, L1132): sudo asks for the owner's password every time (-k),
// the process must be the Dispatcher's user started through sudo by the owner (SUDO_UID is the config's hostLockUid),
// and the owner retypes the card id at the terminal (/dev/tty, stdin a terminal). An AI session can't give the go: it
// has no shell in the Front Door, and anywhere else sudo's password stops it.
//
// WHAT IT DOES, in order, and refuses on any failure (nothing is guessed):
//   1. the config and the process checks: go-card's ownerConfig;
//   2. the product's rules mark it the test product (as go-card: the first runs are the test product's only);
//   3. the card is in the Record, readable, a draft, ordinary and Tier 2 (a Tier-1 card's go is not a command's; M2
//      answerByOwnerCommand answers only a Tier-2 go);
//   4. its pass test is its rows' at main (M2 doneBar, read as the Merge Gate reads them), and the runner can word it
//      for a worker: a card that changed or can't be started is refused before the go is asked;
//   5. go-card's goOnCard: the card and its plan's fingerprint are shown, the id is retyped, M2 raiseGo asks the go as
//      the Dispatcher would (the fingerprint must be the one shown, no risky class), answerByOwnerCommand answers it with
//      the sha256 of the card as the Record holds it, and recordGo writes the go record.
// The Dispatcher's own pass then moves the card to ready (M11 plan-go.mjs). Running it again after a stop finishes only
// what this owner's command began (goOnCard's rule).
//
// Exit: 0 the go is recorded; 1 refused or failed (one line saying why on stderr).

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { doneBar } from '../modules/M2-approvals/go.mjs';
import { TEST_PRODUCT_KEY } from '../modules/M9-record/permissions.mjs';
import { canonicalJson } from '../shared/plan-fingerprint.mjs';
import { DISPATCHER_SELF, RUN_AS, cantStartText, goOnCard, goRecordedText, notDraftText, notTestProductText, ownerCardId, ownerConfig, ownerContext, promptProblem, rowsUnreadText, ttyConfirm, unreadableCardText } from './go-card.mjs';

export const USAGE = `sudo -k -u ${RUN_AS} node …/setup/go.mjs <the Dispatcher's config> <card id>`;
const fail = (reason) => ({ ok: false, reason });
export const NOT_CHECKED_YET = 'the Dispatcher hasn\'t checked this card\'s plan yet; try again in a minute';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The go on draft card `cardId`, from the Record. → goOnCard's answer, or { ok: false, reason }. */
export async function goById({ ctx, cardId, sudoUid, readRows, view, mainSha, confirm }) {
  const product = ctx.product;
  if (!ownerCardId(cardId)) return fail('that is not a card id');
  if (ctx.rules.flag(TEST_PRODUCT_KEY, { product }) !== true) return fail(notTestProductText(product));
  const had = ctx.record.read('card', cardId);
  if (!had) return fail(`there is no card ${cardId} in ${product}'s Record`);
  if (had.corrupt || !had.doc) return fail(unreadableCardText(cardId));
  const { round: _r, ...doc } = had.doc;
  if (doc.state !== 'draft') return fail(notDraftText(cardId, doc.state));
  if (doc.kind !== 'ordinary' || doc.tier !== 2) return fail(`card ${cardId} is a ${doc.kind ?? 'kindless'} Tier-${doc.tier ?? '?'} card; this command gives the go on an ordinary Tier-2 card only`);
  let rows;
  try { rows = await readRows({ product, cardId }); } catch (e) { return fail(rowsUnreadText(e)); }
  const bar = doneBar(rows);
  // A Lead's card holds its plan's own pass test until the Dispatcher's next pass sets it from the rows (M11 plan-go.mjs
  // doneFromRows); until then it is not checked, not changed (#659 audit 1).
  if (bar !== doc.done_when && doc.done_when === doc.brief?.done_when) return fail(NOT_CHECKED_YET);
  if (bar !== doc.done_when) return fail(`card ${cardId}'s pass test is not its rows' at main any more, so the go would bind a plan that changed; nothing was given`);
  const words = promptProblem(product, cardId, doc);
  if (words) return fail(cantStartText(words, 'no go was given'));
  return goOnCard({ ctx, cardId, doc, rows, view, mainSha, sudoUid, cardJsonSha256: sha256(canonicalJson(doc)), confirm, write: false });
}

/** The Record, GitHub reads and rows the go reads, after go-card's config and process checks. */
async function wireRecord(configPath, { uid, sudoUid, self, log, fetchFn, now }) {
  const { githubReads, planRows } = await import('../wiring/review-ports.mjs');
  const c = await ownerConfig(configPath, { uid, sudoUid, self, usage: USAGE });
  const { rec, gh, entry, ctx } = await ownerContext(c, { name: 'go', log, fetchFn, now });
  const reads = githubReads({ gh, entry });
  const readRows = ({ product, cardId }) => planRows({ gh, entry, rec })({ product, card: cardId });
  return { ctx, readRows, view: await reads.planView({ product: c.product }), mainSha: await reads.mainSha({ product: c.product }) };
}

/** The command. Ports are for a test; production passes none. → exit code. */
export async function main(argv, {
  env = process.env, uid = process.getuid(), now = () => Date.now(), fetchFn = globalThis.fetch,
  log = (s) => process.stderr.write(`${s}\n`), out = (s) => process.stdout.write(`${s}\n`), confirm = ttyConfirm, self = DISPATCHER_SELF,
  wire = wireRecord, byId = goById,
} = {}) {
  try {
    if (argv.length !== 2) throw new Error(`usage: ${USAGE}`);
    const { ctx, readRows, view, mainSha } = await wire(argv[0], { uid, sudoUid: env.SUDO_UID, self, log, fetchFn, now });
    const r = await byId({ ctx, cardId: argv[1], sudoUid: Number(env.SUDO_UID), readRows, view, mainSha, confirm });
    if (!r.ok) throw new Error(r.reason);
    out(`Your go on card ${r.card} is recorded ${goRecordedText(r)}`);
    return 0;
  } catch (e) {
    log(`go: ${String(e?.message ?? e).slice(0, 500)}`);
    return 1;
  }
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
