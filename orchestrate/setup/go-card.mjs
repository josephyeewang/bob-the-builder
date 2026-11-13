// go-card.mjs — the owner gives his go on one Tier-2 card of the test product, from the Terminal (lane N, N2; LEAD-CALLS
// L1078, L1082, L1096). For the first run only: no phone channel is wired yet, so nothing else can give a go.
//
//   sudo -u orchestrate node <installed copy>/setup/go-card.mjs <the Dispatcher's config> <card id>
//
// The card is one a Lead already wrote the normal way (its outbox's roadmap- or plan- file). The Record takes a card from
// an AI role only through its outbox (shared/record.mjs: "AI roles write only through their outbox"), so this command
// writes no card. It must be a draft, ordinary, Tier-2 card of the test product whose pass test the Dispatcher has set
// from its rows (M11 plan-go.mjs).
//
// WHAT IT CHECKS, in order, and refuses on any failure (I1: nothing is guessed):
//   1. It runs as the Dispatcher's user (orchestrate), started through sudo by the owner: SUDO_UID is the config's
//      ownerUid. A builder session runs as its own user and can't sudo.
//   2. The product is the test product (L1082), and the card is a draft, ordinary, Tier-2 card of it.
//   3. Its rows are read at main the way the Merge Gate reads them (wiring/review-ports.mjs planRows), and its pass test
//      is theirs.
//   4. M2 raiseGo asks for the go exactly as the Dispatcher would (rows, pass test, fingerprint, file list at main).
//   5. The card, its files, its pass test and the plan's fingerprint are shown, and the owner retypes the card id at
//      the terminal. It is read from /dev/tty only, never stdin (L1096 Q11): with no terminal, or another id, nothing
//      is given. A Claude session's shell has no terminal, so a session can't give its own go even while sudo's
//      password is still cached.
//   6. M2 answerByOwnerCommand records the answer on channel 'tap' with binding kind 'owner_command' (L1096 Q10), its
//      card_json_sha256 the sha256 of the card as the Record held it when shown (canonical JSON). M10's
//      count_approval counts it exactly as it counts a tap (and refuses it for a risky class or Tier 1), and M2
//      recordGo writes the go record, whose binding says it came from this command. recordGo checks the plan is still
//      the one asked on, so a card changed since it was shown gets no go.
// The Dispatcher's own pass then moves the card to ready (M11 plan-go.mjs), as it does for any covered draft card.
// A stop after step 4 leaves the card in draft and its ask open; running the command again picks the ask up.
//
// Exit: 0 the go is recorded; 1 refused or failed (one line saying why on stderr).

import { closeSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { doneBar, raiseGo, recordGo } from '../modules/M2-approvals/go.mjs';
import { answerByOwnerCommand, OWNER_COMMAND } from '../modules/M2-approvals/owner-command.mjs';
import { canonicalJson } from '../shared/plan-fingerprint.mjs';

// The one product this command may give a go on (L1082: the first run, the test product only).
export const GO_CARD_PRODUCT = 'orchestrate-test';
export const USAGE = 'sudo -u orchestrate node …/setup/go-card.mjs <the Dispatcher\'s config> <card id>';
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LINE = 256;
const fail = (reason) => ({ ok: false, reason });
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Why this process may not give the go, or null. `sudoUid` is the SUDO_UID text sudo set. */
export function whoProblem({ uid, sudoUid, dispatcherUid, ownerUid }) {
  if (!Number.isSafeInteger(dispatcherUid) || dispatcherUid <= 0) return 'the Dispatcher\'s user (orchestrate) could not be found on this Mac';
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0 || ownerUid === dispatcherUid) return 'the config\'s ownerUid is not the owner\'s user';
  if (uid !== dispatcherUid) return `run it as the Dispatcher's user: ${USAGE}`;
  if (typeof sudoUid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(sudoUid)) return 'it was not started through sudo, so who ran it is unknown';
  if (Number(sudoUid) !== ownerUid) return `it was started through sudo by user ${sudoUid}, not by the owner`;
  return null;
}

/**
 * The owner's retyped card id, read from the terminal only (L1096 Q11). → { ok: true } | { ok: false, reason }.
 * `open`, `isTty` and `show` (the prompt's writer) are for a test; production passes none.
 */
export function ttyConfirm({ cardId, text, open = () => openSync('/dev/tty', 'r+'), isTty = isatty, show = writeSync }) {
  let fd;
  try { fd = open(); } catch { fd = null; }
  if (fd === null || fd === undefined || !isTty(fd)) {
    if (fd !== null && fd !== undefined) closeSync(fd);
    return fail('no terminal is attached, so the go can\'t be confirmed. Run this yourself in the Terminal app; a session can\'t give a go');
  }
  try {
    show(fd, `${text}\n\nTo give your go, type the card id (${cardId}) and press Return. Anything else stops here: `);
    const bytes = []; const one = Buffer.alloc(1);
    for (;;) {
      if (readSync(fd, one, 0, 1, null) !== 1) break;
      if (one[0] === 10 || one[0] === 13) break;
      if (bytes.length >= MAX_LINE) return fail('the line typed was far longer than a card id; no go was given');
      bytes.push(one[0]);
    }
    const typed = Buffer.from(bytes).toString('utf8').trim();
    return typed === cardId ? { ok: true } : fail(`the id typed was not ${cardId}; no go was given`);
  } finally { closeSync(fd); }
}

/** What the owner reads before retyping the id: the card, its files, its pass test, and how the go will be recorded. */
export function goText({ product, cardId, card, fingerprint, askId }) {
  return [
    `Card ${cardId} (${product}, Tier 2, module ${card.module}): ${card.what}`,
    'Files it may change:',
    ...[...card.files].sort().map((f) => `  ${f}`),
    'Its pass test (from its rows):',
    ...String(card.done_when).split('\n').map((l) => `  ${l}`),
    `Plan fingerprint: ${fingerprint}   (ask ${askId})`,
    `This go is recorded as given by owner command (binding kind ${OWNER_COMMAND}), not as a phone tap.`,
  ].join('\n');
}

/**
 * Everything after the process checks: ask, confirmation, answer, go. ctx is an M2 context ({ record, rules, product,
 * now, alert }); readRows({ product, card }) → rows; view and mainSha as M2 raiseGo takes them; confirm({ cardId, text })
 * → { ok } (ttyConfirm in production). `onlyProduct` is for a test, whose Record is another product's; main passes none.
 * → { ok: true, card, ask, go, fingerprint } | { ok: false, reason }
 */
export async function goCard({ ctx, cardId, sudoUid, readRows, view, mainSha, confirm, onlyProduct = GO_CARD_PRODUCT }) {
  if (ctx.product !== onlyProduct) return fail(`this command gives a go on ${onlyProduct} only, and this Dispatcher runs ${ctx.product}`);
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return fail('the card id must be letters, digits, dots, dashes and underscores');
  const c = ctx.record.read('card', cardId);
  if (!c) return fail(`the Record has no card ${cardId}; a Lead writes it first (its outbox's roadmap- or plan- file)`);
  if (c.corrupt || !c.doc) return fail(`card ${cardId} can't be read`);
  const d = c.doc;
  if (d.product !== ctx.product) return fail(`card ${cardId} belongs to product ${d.product}`);
  if (d.tier !== 2) return fail(`card ${cardId} is Tier ${d.tier}; this command gives a go on a Tier-2 card only`);
  if (d.kind !== 'ordinary') return fail(`card ${cardId} is a ${d.kind} card; only an ordinary card is given a go here`);
  if (d.state !== 'draft') return fail(`card ${cardId} is ${d.state}; a go is given on a draft card`);
  let rows;
  try { rows = await readRows({ product: ctx.product, card: cardId }); } catch (e) { return fail(`the card's rows could not be read: ${String(e?.message ?? e).slice(0, 300)}`); }
  if (d.done_when !== doneBar(rows)) return fail(`card ${cardId}'s pass test is not yet its rows' (the Dispatcher sets it on its next pass); run this again after that`);
  const g = await raiseGo(ctx, { cardId, rows, view, mainSha });
  if (!g.ok) return fail(`the go could not be asked: ${g.reason}`);
  const ask = askStore(ctx.record).ask(g.id);
  if (!ask) return fail(`ask ${g.id} could not be read back`);
  if (Array.isArray(ask.doc.risky) && ask.doc.risky.length) return fail(`the go is for a risky class (${ask.doc.risky.join(', ')}), which needs your own Approve on GitHub`);
  const shown = ctx.record.read('card', cardId);
  if (!shown?.doc || shown.corrupt) return fail(`card ${cardId} can't be read`);
  const said = confirm({ cardId, text: goText({ product: ctx.product, cardId, card: shown.doc, fingerprint: ask.doc.fingerprint, askId: g.id }) });
  if (!said?.ok) return fail(said?.reason ?? 'the go was not confirmed');
  const a = answerByOwnerCommand(ctx, g.id, { sudoUid, cardJsonSha256: sha256(canonicalJson(shown.doc)) });
  if (!a.ok) return a;
  const go = recordGo(ctx, g.id);
  if (!go.ok) return fail(`the answer is recorded, but the go is not: ${go.reason}`);
  return { ok: true, card: cardId, ask: g.id, go: go.go, fingerprint: ask.doc.fingerprint };
}

/** The command. Ports are for a test; production passes none. → exit code. */
export async function main(argv, {
  env = process.env, uid = process.getuid(), now = () => Date.now(), fetchFn = globalThis.fetch,
  log = (s) => process.stderr.write(`${s}\n`), out = (s) => process.stdout.write(`${s}\n`), confirm = ttyConfirm, self = SELF,
} = {}) {
  try {
    if (argv.length !== 2) throw new Error(`usage: ${USAGE}`);
    // Loaded here, not at the top, so a test of the checks above needs none of the Mac's setup code.
    const { readConfig } = await import('../modules/M11-dispatcher/main.mjs');
    const { checkConfig, recordAndRules } = await import('../wiring/dispatcher-wiring.mjs');
    const { githubReads, planRows } = await import('../wiring/review-ports.mjs');
    const { readUser } = await import('./users-folders.mjs');
    const { realIo } = await import('./mac.mjs');
    const { DISPATCHER_USER } = await import('./dispatcher-setup.mjs');
    const c = readConfig(argv[0], { self });
    checkConfig(c);
    const who = whoProblem({ uid, sudoUid: env.SUDO_UID, dispatcherUid: readUser(realIo(), DISPATCHER_USER).uid, ownerUid: c.ownerUid });
    if (who) throw new Error(who);
    if (c.product !== GO_CARD_PRODUCT) throw new Error(`this command gives a go on ${GO_CARD_PRODUCT} only, and this config runs ${c.product}`);
    const { rec, rules, gh, entry } = await recordAndRules(c, { who: 'go-card', log, fetchFn, now });
    const reads = githubReads({ gh, entry });
    const ctx = { record: rec, rules, product: c.product, now, alert: (a) => { log(`go-card: alert not sent: ${JSON.stringify(a)}`); return false; } };
    const r = await goCard({ ctx, cardId: argv[1], sudoUid: Number(env.SUDO_UID), readRows: planRows({ gh, entry, rec }),
      view: await reads.planView({ product: c.product }), mainSha: await reads.mainSha({ product: c.product }), confirm });
    if (!r.ok) throw new Error(r.reason);
    out(`Go recorded for card ${r.card} (go ${r.go}, fingerprint ${r.fingerprint.slice(0, 12)}), given by owner command, not a phone tap. The Dispatcher moves the card to ready on its next pass.`);
    return 0;
  } catch (e) {
    log(`go-card: ${String(e?.message ?? e).slice(0, 500)}`);
    return 1;
  }
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
