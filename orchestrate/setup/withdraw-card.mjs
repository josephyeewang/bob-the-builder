// withdraw-card.mjs — the owner withdraws a card the owner's go command made, from the Terminal (L1343). For the first
// run only, as go-card.mjs is: a card written with a mistake (R-S1-1's one-line text brief, which no worker prompt can
// be made from) can't be fixed, because a card's plan is frozen once it leaves draft, and nothing else may cancel it.
//
//   sudo -k -u orchestrate node <installed copy>/setup/withdraw-card.mjs <the Dispatcher's config> <card id> <reason…>
//
// THE GUARD IS SUDO'S PASSWORD, as for go-card (its header's THE GUARD, L1132): `-k` makes sudo ask again, and the
// retyped id is a second check that the owner read what is withdrawn, not the guard. The process checks, the config
// reading and the terminal confirm are go-card's own, imported (one home).
//
// WHAT IT DOES, in order, and refuses on any failure (nothing is guessed):
//   1. It runs as the Dispatcher's user (orchestrate), started through sudo by the owner (go-card whoFromConfig).
//   2. The product's own rules mark it the test product (M9 TEST_PRODUCT_KEY, exactly true).
//   3. The card is one the owner's go command made (its first diary line names owner_command), an ordinary Tier-2 card,
//      in draft or ready: no session holds it. A claimed or running card is not withdrawn here.
//   4. No go is being asked for it (an open or pushed go ask): M2 has no way for another writer to withdraw an ask, and a
//      card cancelled under a live ask would leave the owner's phone asking about a card that has gone. Answer the ask
//      (or let it expire), then withdraw.
//   5. The reason is one plain line (M9 cancelReasonProblem, the writer's own rule). The card, its state, its brief and
//      the reason are shown, and the owner retypes the card id at the terminal (go-card ttyConfirm).
//   6. The card moves to cancelled with cancel_reason, under the Record actor owner_command, which M9 lets make exactly
//      this change (moves.mjs, permissions.mjs, writer.mjs checkCardUpdate), so the diary names who withdrew it.
//
// Exit: 0 the card is withdrawn; 1 refused or failed (one line saying why on stderr).

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { OWNER_COMMAND } from '../modules/M2-approvals/owner-command.mjs';
import { CARD_ID } from '../modules/M9-record/outbox.mjs';
import { TEST_PRODUCT_KEY, cancelReasonProblem } from '../modules/M9-record/permissions.mjs';
import { activeKind } from '../shared/asks.mjs';
import { DISPATCHER_SELF, RUN_AS, ownerConfig, ownerContext, ttyConfirm, notTestProductText, unreadableCardText } from './go-card.mjs';

export const USAGE = `sudo -k -u ${RUN_AS} node …/setup/withdraw-card.mjs <the Dispatcher's config> <card id> <reason…>`;
// What the retype confirms, in go-card ttyConfirm's words.
export const WITHDRAW_WORDS = Object.freeze({ thing: 'withdrawal', doing: 'withdraw a card', ask: 'To withdraw this card', none: 'nothing was withdrawn' });
// The states a card is withdrawn from: before any session holds it (moves.mjs gives owner_command these two only).
export const WITHDRAW_FROM = Object.freeze(['draft', 'ready']);
const fail = (reason) => ({ ok: false, reason });
const LIVE_ASK = Object.freeze(['open', 'pushed']);
const WRITE_TRIES = 20;
// A Dispatcher pass may hold a ready card as claimed while it tries a launch: a refused launch gives it back as it was
// (M9 endClaim), a started one keeps it. The command waits a bounded time for the first, then refuses (L1343 audit m1).
const CLAIM_WAIT_MS = 3000;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** What the owner reads before retyping the id. */
export function withdrawText({ product, cardId, card, reason }) {
  const brief = card.brief === undefined ? '(none)' : typeof card.brief === 'string' ? card.brief : JSON.stringify(card.brief);
  return [
    `Card ${cardId} (${product}, Tier ${card.tier}, module ${card.module}), now ${card.state}: ${card.what}`,
    `Its brief: ${brief}`,
    `Reason given: ${reason}`,
    'It moves to cancelled, written by owner command; nothing else about it changes, and no session will start on it.',
  ].join('\n');
}

/**
 * Everything after the process checks. ctx is an M2 context ({ record, rules, product }); confirm({ cardId, text,
 * words }) → { ok } (ttyConfirm in production). → { ok: true, card, from } | { ok: false, reason }
 */
export function withdrawCard({ ctx, cardId, reason, confirm, wait = sleepMs, log = () => {} }) {
  const product = ctx.product;
  if (ctx.rules.flag(TEST_PRODUCT_KEY, { product }) !== true) return fail(notTestProductText(product));
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return fail('the card id must be one plain id (letters, digits, dots, dashes and underscores)');
  const why = cancelReasonProblem(reason);
  if (why) return fail(why);
  const first = settled(ctx, cardId, product, wait, log);
  if (!first.ok) return first;
  const { card } = first;
  const said = confirm({ cardId, text: withdrawText({ product, cardId, card, reason }), words: WITHDRAW_WORDS });
  if (!said?.ok) return fail(said?.reason ?? 'the withdrawal was not confirmed');
  // The owner reads and retypes between the first read and the write, and each Dispatcher pass claims and releases a
  // ready card (raising its rev), so the card is read again after the retype: written only if it still says what the
  // owner was shown, and no go ask for it opened meanwhile (L1343 audit m1, m2). A pass landing between this read and
  // the write is tried again, waiting while a pass holds the card claimed.
  let last = 'the card kept changing';
  for (let n = 0; n < WRITE_TRIES; n += 1) {
    const now = settled(ctx, cardId, product, wait, log);
    if (!now.ok) return now;
    if (JSON.stringify(now.card) !== JSON.stringify(card)) return fail(`card ${cardId} changed after you were shown it; nothing was withdrawn, run the command again`);
    const w = ctx.record.write({ actor: 'owner_command', entity: 'card', id: cardId, expectRev: now.cur.rev, doc: { ...now.card, state: 'cancelled', cancel_reason: reason } });
    if (w.ok) return { ok: true, card: cardId, from: card.state };
    last = w.reason;
    // Only a pass landing between the read and the write is worth another try; any other refusal is final.
    if (!/^changed since read/.test(String(w.reason))) break;
  }
  return fail(`the Record refused the withdrawal: ${last}; the Dispatcher may have been working on the card at that moment, so run the command again`);
}

/** cardNow, waiting while a Dispatcher pass holds the card claimed and that is the only thing in the way. */
function settled(ctx, cardId, product, wait, log) {
  for (let n = 0; ; n += 1) {
    const r = cardNow(ctx, cardId, product);
    if (r.ok || !r.onlyClaimed) return r;
    if (n >= WRITE_TRIES) return fail(`${r.reason}; waited ${(WRITE_TRIES * CLAIM_WAIT_MS) / 1000} s for the Dispatcher to give it back, so a session has probably started on it`);
    if (n === 0) log(`withdraw-card: a Dispatcher pass holds card ${cardId} (claimed); waiting up to ${(WRITE_TRIES * CLAIM_WAIT_MS) / 1000} s for it to be given back…`);
    wait(CLAIM_WAIT_MS);
  }
}

/** The card as it is now, with every check that it may be withdrawn. → { ok: true, cur, card } | { ok: false, reason } */
function cardNow(ctx, cardId, product) {
  const cur = ctx.record.read('card', cardId);
  if (!cur) return fail(`the Record has no card ${cardId}`);
  if (cur.corrupt || !cur.doc) return fail(unreadableCardText(cardId));
  const by = ctx.record.meta('card', cardId)?.createdBy ?? null;
  if (by !== OWNER_COMMAND) return fail(`card ${cardId} was made by ${by ?? 'an unknown writer'}, not by your go command; this command withdraws only a card that command made`);
  const card = cur.doc;
  if (card.product !== product) return fail(`card ${cardId} is not ${product}'s`);
  if (card.kind !== 'ordinary' || card.tier !== 2) return fail(`card ${cardId} is not an ordinary Tier-2 card`);
  if (card.state === 'cancelled') return fail(`card ${cardId} is already cancelled${card.cancel_reason ? ` (${card.cancel_reason})` : ''}`);
  if (!WITHDRAW_FROM.includes(card.state)) return { ...fail(`card ${cardId} is ${card.state}; only a draft or ready card is withdrawn here (no session may hold it)`), onlyClaimed: card.state === 'claimed' };
  const live = askStore(ctx.record).asks().filter((a) => a.doc.card === cardId && activeKind(a.doc.kind)?.go === true && LIVE_ASK.includes(a.doc.state));
  if (live.length) return fail(`your go is still being asked for card ${cardId} (ask ${live.map((a) => a.id).join(', ')}, ${live[0].doc.state}); M2 has no way for this command to withdraw an ask, so answer it or let it expire, then withdraw the card`);
  return { ok: true, cur, card };
}

/** The command. Ports are for a test; production passes none. → exit code. */
export async function main(argv, {
  env = process.env, uid = process.getuid(), now = () => Date.now(), fetchFn = globalThis.fetch,
  log = (s) => process.stderr.write(`${s}\n`), out = (s) => process.stdout.write(`${s}\n`), confirm = ttyConfirm, self = DISPATCHER_SELF,
} = {}) {
  try {
    if (argv.length < 3) throw new Error(`usage: ${USAGE}`);
    const [path, cardId, ...words] = argv;
    const c = await ownerConfig(path, { uid, sudoUid: env.SUDO_UID, self, usage: USAGE });
    const { ctx } = await ownerContext(c, { name: 'withdraw-card', log, fetchFn, now });
    const r = withdrawCard({ ctx, cardId, reason: words.join(' '), confirm, log });
    if (!r.ok) throw new Error(r.reason);
    out(`Card ${r.card} withdrawn (${r.from} → cancelled), by owner command. No session will start on it.`);
    return 0;
  } catch (e) {
    log(`withdraw-card: ${String(e?.message ?? e).slice(0, 500)}`);
    return 1;
  }
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
