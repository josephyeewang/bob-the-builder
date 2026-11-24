// go-card.mjs — the owner writes one Tier-2 card of the test product and gives his go on it, from the Terminal (lane N,
// N2; LEAD-CALLS L1078, L1082, L1096, L1100). For the first run only: no Lead can be launched yet and no phone channel is
// wired, so nothing else can make the card or give the go.
//
//   sudo -k -u orchestrate node <installed copy>/setup/go-card.mjs <the Dispatcher's config> <card.json>
//
// THE GUARD IS SUDO'S PASSWORD (L1132). A Claude session can't give its own go only because sudo asks for the owner's
// password, and the owner types it. The Lead and lane sessions run as the owner's own Mac user, so a password sudo still
// remembers (its few-minute timestamp) would let one of them run this with no one typing anything. `-k` makes sudo ask
// again whatever it remembers; it is in USAGE and in every paste block that runs this, and must stay there. This command
// can't tell whether `-k` was given (sudo passes nothing that says so): the guard holds when the owner runs it as
// written. SUDO_UID is only an environment variable sudo sets; it says which user sudo let through, not who typed. The
// retyped card id (step 4) is a second check that the owner read the card, not the guard.
//
// The card file is a JSON object: { id, product, module, kind: "ordinary", tier: 2, what, files, brief, lane?,
// desired? } (the owner_command create row of M9 permissions.mjs, less the two this command sets). The pass test is not
// in it: it is the card's rows' (docs/blueprint/rows/<id>.yaml among its files), read at main. The brief is required
// (L1343): it is what the worker is given, an object { goal, done_when, files, not_in_scope } as M3 task-brief.mjs
// checks it, its files the card's files and its done_when the pass test from the rows, so the worker reads the test
// the reviewer checks. A card whose brief the runner can't put into a worker prompt is refused before anything is
// written (R-S1-1 was written with a one-line text brief, and every launch of it was refused).
//
// WHAT IT DOES, in order, and refuses on any failure (I1: nothing is guessed):
//   1. It runs as the Dispatcher's user (orchestrate), started through sudo by the owner: SUDO_UID is the config's
//      hostLockUid (L1324; its ownerUid is the Record's owner). A builder session runs as its own user and can't sudo; a session running as the owner's user is
//      stopped by sudo's password (above), not by this check.
//   2. The product's own rules mark it the test product (M9 TEST_PRODUCT_KEY, exactly true), and the card is ordinary,
//      Tier 2, of that product.
//   3. Its rows are read at main the way the Merge Gate reads them (wiring/review-ports.mjs planRows), and its pass
//      test is set to theirs (M2 doneBar), so the Dispatcher's pass has nothing to change and the go binds what was shown.
//      The brief's done_when must be that same text, and the worker prompt is built from the card with the runner's own
//      function (M5 worker-prompt.mjs, as wiring/runner-ports.mjs words it at launch); a card it can't word is refused.
//   4. The card, its files, its pass test, its brief and the plan's fingerprint are shown, and the owner retypes the card id at the
//      terminal. It is read from /dev/tty only, never stdin (L1096 Q11), and stdin must be a terminal too (L1132): with
//      stdin piped or redirected, no terminal, or another id, nothing is written. That stops a pipe, not a determined
//      program: a shell running as the owner can make a terminal of its own (`script`, or any pseudo-terminal) and type
//      into it. What stops a session there is sudo's password, asked again because of `-k` (above). The retype is a
//      second check that the owner read the card, not a lock (L1111, L1132).
//   5. The card is written under the Record actor `owner_command` (L1100), which M9 lets create only an ordinary Tier-2
//      draft on a test product (permissions CARD_CREATORS, writer checkNewCard), so the diary names who made it.
//   6. M2 raiseGo asks for the go exactly as the Dispatcher would; its fingerprint must be the one shown. M2
//      answerByOwnerCommand records the answer on channel 'tap' with binding kind 'owner_command' (L1096 Q10), its
//      card_json_sha256 the sha256 of the card file's bytes; M10's count_approval counts it as it counts a tap. M2
//      recordGo writes the go record, whose binding says it came from this command.
// The Dispatcher's own pass then moves the card to ready (M11 plan-go.mjs), as it does for any covered draft card.
// A stop after step 5 leaves the card in draft (and its ask open or answered). Running the command again with the same
// file takes that card up again: only a draft this command made, with the same plan; any other card of that id is
// refused. If the ask already holds this owner's command answer, only the go record is tried again (L1111).
//
// Exit: 0 the go is recorded; 1 refused or failed (one line saying why on stderr).

import { closeSync, openSync, readFileSync, readSync, realpathSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { doneBar, raiseGo, recordGo } from '../modules/M2-approvals/go.mjs';
import { answerByOwnerCommand, OWNER_COMMAND } from '../modules/M2-approvals/owner-command.mjs';
import { briefProblems, briefText } from '../modules/M3-lead/task-brief.mjs';
import { workerPrompt } from '../modules/M5-review-audit/worker-prompt.mjs';
import { TEST_PRODUCT_KEY, WRITERS } from '../modules/M9-record/permissions.mjs';
import { canonicalJson, planFingerprint, unfingerprinted } from '../shared/plan-fingerprint.mjs';
import { TTY_PATH } from './layout.mjs';

// The Dispatcher's user. Written here, as dispatcher-check.mjs does, not imported from dispatcher-setup.mjs: that module
// builds job files, and a module that loads one must be a listed job builder (M4 review-install-closure.test, L136 m1).
// go-card.test pins it to dispatcher-setup's DISPATCHER_USER.
export const RUN_AS = 'orchestrate';
// `-k`: sudo asks for the owner's password even if it remembers it (L1132; the header's THE GUARD).
export const USAGE = 'sudo -k -u orchestrate node …/setup/go-card.mjs <the Dispatcher\'s config> <card.json>';
// The terminal the retype is read from (L1096 Q11). openTty is ttyConfirm's real port: it throws when this process has
// no terminal (go-card.test.mjs checks both).
export { TTY_PATH };
export const openTty = () => openSync(TTY_PATH, 'r+');
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LINE = 256;
const MAX_CARD_FILE = 64 * 1024;
// The fields the card file may hold: the Record actor's own create row (one source), less the two set here, plus the id.
const SET_HERE = Object.freeze(['state', 'done_when']);
export const CARD_FILE_FIELDS = Object.freeze(['id', ...[...WRITERS.card[OWNER_COMMAND].create].filter((f) => !SET_HERE.includes(f))]);
const fail = (reason) => ({ ok: false, reason });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * whoProblem read from the Dispatcher's config (L1324). Its `ownerUid` is the Record's owner, the Dispatcher's own user
 * (dispatcher-setup writes orchestrate's uid; M9's Store Writer runs only as it), not the person: the owner's Mac user is
 * `hostLockUid` (host.lock's owner). A config whose Record is not the Dispatcher's user's is refused too.
 */
export function whoFromConfig({ uid, sudoUid, dispatcherUid, config, usage = USAGE }) {
  if (config?.ownerUid !== dispatcherUid) return `the config's ownerUid (the Record's owner) is not the Dispatcher's user (${RUN_AS})`;
  return whoProblem({ uid, sudoUid, dispatcherUid, ownerUid: config.hostLockUid, usage });
}

/**
 * Why this process may not act for the owner, or null. `sudoUid` is the SUDO_UID text sudo set; `ownerUid` the
 * person's uid; `usage` the command's own usage line (withdraw-card passes its own, L1343).
 */
export function whoProblem({ uid, sudoUid, dispatcherUid, ownerUid, usage = USAGE }) {
  if (!Number.isSafeInteger(dispatcherUid) || dispatcherUid <= 0) return 'the Dispatcher\'s user (orchestrate) could not be found on this Mac';
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0 || ownerUid === dispatcherUid) return 'the config\'s hostLockUid is not the owner\'s user';
  if (uid !== dispatcherUid) return `run it as the Dispatcher's user: ${usage}`;
  if (typeof sudoUid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(sudoUid)) return 'it was not started through sudo, so who ran it is unknown';
  if (Number(sudoUid) !== ownerUid) return `it was started through sudo by user ${sudoUid}, not by the owner`;
  return null;
}

// What the retype confirms: go-card's go (the default) or withdraw-card's withdrawal (L1343), in the owner's words.
export const GO_WORDS = Object.freeze({ thing: 'go', doing: 'give a go', ask: 'To write this card and give your go', none: 'no go was given' });

/**
 * The owner's retyped card id, read from the terminal only (L1096 Q11), with stdin a terminal too (L1132).
 * → { ok: true } | { ok: false, reason }. A second check that the owner read the card; the guard is sudo's password.
 * `words` says what is being confirmed (GO_WORDS by default). `open`, `isTty`, `stdinIsTty` and `show` (the prompt's
 * writer) are for a test; production passes none.
 */
export function ttyConfirm({ cardId, text, words = GO_WORDS, open = openTty, isTty = isatty, stdinIsTty = () => isatty(0), show = writeSync }) {
  if (!stdinIsTty()) return fail(`its input is piped or redirected, not the Terminal, so the ${words.thing} can't be confirmed. Run this yourself in the Terminal app; a session can't ${words.doing}`);
  let fd;
  try { fd = open(); } catch { fd = null; }
  if (fd === null || fd === undefined || !isTty(fd)) {
    if (fd !== null && fd !== undefined) closeSync(fd);
    return fail(`no terminal is attached, so the ${words.thing} can't be confirmed. Run this yourself in the Terminal app; a session can't ${words.doing}`);
  }
  try {
    show(fd, `${text}\n\n${words.ask}, type the card id (${cardId}) and press Return. Anything else stops here: `);
    const bytes = []; const one = Buffer.alloc(1);
    for (;;) {
      if (readSync(fd, one, 0, 1, null) !== 1) break;
      if (one[0] === 10 || one[0] === 13) break;
      if (bytes.length >= MAX_LINE) return fail(`the line typed was far longer than a card id; ${words.none}`);
      bytes.push(one[0]);
    }
    const typed = Buffer.from(bytes).toString('utf8').trim();
    return typed === cardId ? { ok: true } : fail(`the id typed was not ${cardId}; ${words.none}`);
  } finally { closeSync(fd); }
}

/**
 * The card file's text → { ok: true, id, doc } (doc without state and done_when) | { ok: false, reason }. Only the
 * listed fields; an ordinary Tier-2 card of `product` with a module, a what, a file list and a brief (L1343) that M3's
 * brief check passes, listing the same files.
 */
export function readCardFile(text, product) {
  let v;
  try { v = JSON.parse(text); } catch { return fail('the card file is not JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('the card file is not one JSON object');
  const extra = Object.keys(v).filter((k) => !CARD_FILE_FIELDS.includes(k));
  if (extra.length) return fail(`the card file may not set ${extra.join(', ')}${extra.includes('done_when') ? ' (the pass test comes from the card\'s rows)' : ''}`);
  if (typeof v.id !== 'string' || !CARD_ID.test(v.id)) return fail('the card id must be letters, digits, dots, dashes and underscores');
  if (v.product !== product) return fail(`the card is for product ${JSON.stringify(v.product ?? null)}, and this Dispatcher runs ${product}`);
  if (v.kind !== 'ordinary') return fail(`the card is a ${JSON.stringify(v.kind ?? null)} card; this command makes an ordinary card only`);
  if (v.tier !== 2) return fail(`the card is Tier ${JSON.stringify(v.tier ?? null)}; this command makes a Tier-2 card only`);
  for (const k of ['module', 'what']) if (typeof v[k] !== 'string' || !v[k].trim()) return fail(`the card has no ${k}`);
  if (!Array.isArray(v.files) || !v.files.length || v.files.some((f) => typeof f !== 'string' || !f)) return fail('the card has no file list');
  if (v.brief === undefined) return fail('the card has no brief: it needs { goal, done_when, files, not_in_scope }, what the worker is given');
  const bad = briefProblems(v.brief);
  if (bad.length) return fail(`the card's brief can't be given to a worker: ${bad.join('; ').slice(0, 400)}`);
  const sorted = (a) => JSON.stringify([...a].sort());
  if (sorted(v.brief.files) !== sorted(v.files)) return fail('the brief\'s files are not the card\'s files; list the same files in both');
  const { id, ...doc } = v;
  return { ok: true, id, doc };
}

/** What the owner reads before retyping the id: the card, its files, its pass test, and how it will be recorded. */
export function goText({ product, cardId, card, fingerprint }) {
  return [
    `Card ${cardId} (${product}, Tier 2, module ${card.module}): ${card.what}`,
    'Files it may change:',
    ...[...card.files].sort().map((f) => `  ${f}`),
    'Its pass test (from its rows):',
    ...String(card.done_when).split('\n').map((l) => `  ${l}`),
    'The brief the worker is given:',
    ...briefText(cardId, card.brief).split('\n').map((l) => (l ? `  ${l}` : '')),
    `Plan fingerprint: ${fingerprint}`,
    `The card is written by owner command, and this go is recorded as given by owner command (binding kind ${OWNER_COMMAND}), not as a phone tap.`,
  ].join('\n');
}

/**
 * Everything after the process checks. ctx is an M2 context ({ record, rules, product, now, alert }); cardText is the
 * card file's bytes (a Buffer or string); readRows({ product, cardId, doc }) → rows for that card as planned; view and
 * mainSha as M2 raiseGo takes them; confirm({ cardId, text }) → { ok } (ttyConfirm in production).
 * → { ok: true, card, ask, go, fingerprint } | { ok: false, reason }
 */
export async function goCard({ ctx, cardText, sudoUid, readRows, view, mainSha, confirm }) {
  const product = ctx.product;
  if (ctx.rules.flag(TEST_PRODUCT_KEY, { product }) !== true) return fail(notTestProductText(product));
  const text = Buffer.isBuffer(cardText) ? cardText : Buffer.from(String(cardText ?? ''), 'utf8');
  if (text.length > MAX_CARD_FILE) return fail('the card file is far larger than a card');
  const f = readCardFile(text.toString('utf8'), product);
  if (!f.ok) return f;
  const cardId = f.id;
  let rows;
  try { rows = await readRows({ product, cardId, doc: f.doc }); } catch (e) { return fail(rowsUnreadText(e)); }
  const doc = { state: 'draft', ...f.doc, done_when: doneBar(rows) };
  // The worker reads the brief's done_when, the reviewer checks the card's (L1343): one text.
  if (doc.brief.done_when !== doc.done_when) return fail(`the brief's done_when is not the card's pass test from its rows; set it to exactly: ${JSON.stringify(doc.done_when).slice(0, 400)}`);
  const words = promptProblem(product, cardId, doc);
  if (words) return fail(cantStartText(words, 'nothing was written'));
  // A card already there is taken up only if this command made it and it is still the same draft (a rerun after a stop).
  const had = ctx.record.read('card', cardId);
  if (had) {
    if (had.corrupt || !had.doc) return fail(unreadableCardText(cardId));
    const by = ctx.record.meta('card', cardId)?.createdBy ?? null;
    if (by !== OWNER_COMMAND) return fail(`card ${cardId} is already in the Record, made by ${by ?? 'an unknown writer'}; pick another id`);
    if (had.doc.state !== 'draft') return fail(notDraftText(cardId, had.doc.state));
    const { round: _r, ...stored } = had.doc;
    if (canonicalJson(stored) !== canonicalJson(doc)) return fail(`card ${cardId} is already in the Record with another plan; pick another id`);
  }
  return goOnCard({ ctx, cardId, doc, rows, view, mainSha, sudoUid, cardJsonSha256: sha256(text), confirm, write: !had });
}

/**
 * The go itself, once the card is checked: its plan's fingerprint is shown and the id retyped, the card written when
 * `write` (go-card's new card), the go asked as the Dispatcher asks it, answered by this owner's command with
 * `cardJsonSha256`, and recorded. Shared with go.mjs, the go on a card already in the Record (Track A step 9).
 */
export async function goOnCard({ ctx, cardId, doc, rows, view, mainSha, sudoUid, cardJsonSha256, confirm, write }) {
  const product = ctx.product;
  const fp = planFingerprint({ product, card_id: cardId, tier: doc.tier, files: doc.files, done_when: doc.done_when, plan_sha256: doc.plan_sha256, main_commit: doc.main_commit });
  if (!fp.ok) return fail(unfingerprinted(fp.reason));
  const said = confirm({ cardId, text: goText({ product, cardId, card: doc, fingerprint: fp.sha256 }) });
  if (!said?.ok) return fail(said?.reason ?? 'the go was not confirmed');
  if (write) {
    const w = ctx.record.write({ actor: 'owner_command', entity: 'card', id: cardId, expectRev: 0, doc });
    if (!w.ok) return fail(`the Record refused the card: ${w.reason}`);
  }
  const g = await raiseGo(ctx, { cardId, rows, view, mainSha });
  if (!g.ok) return fail(`the card is written, but the go could not be asked: ${g.reason}`);
  const ask = askStore(ctx.record).ask(g.id);
  if (!ask) return fail(`ask ${g.id} could not be read back`);
  // Backstop: raiseGo fingerprints the same card the same way, so this can't fail while M2 is correct (L1111).
  if (ask.doc.fingerprint !== fp.sha256) return fail(`the go asked is on fingerprint ${ask.doc.fingerprint}, not the ${fp.sha256} shown; no go was given`);
  if (Array.isArray(ask.doc.risky) && ask.doc.risky.length) return fail(`the go is for a risky class (${ask.doc.risky.join(', ')}), which needs your own Approve on GitHub`);
  // A rerun after a stop between the answer and the go record (L1111 2): the ask already holds this owner's command
  // answer, so only recordGo is tried again (it is idempotent on a consumed ask). An answer given any other way is not
  // this command's to finish.
  if (['answered', 'consumed'].includes(ask.doc.state)) {
    const b = ask.doc.answer?.binding;
    if (b?.kind !== OWNER_COMMAND || b.sudo_uid !== sudoUid) return fail(`ask ${g.id} is already ${ask.doc.state}, and not by your owner command; this command can't finish it`);
  } else {
    const a = answerByOwnerCommand(ctx, g.id, { sudoUid, cardJsonSha256 });
    if (!a.ok) return a;
  }
  const go = recordGo(ctx, g.id);
  if (!go.ok) return fail(`the answer is recorded, but the go is not: ${go.reason}`);
  return { ok: true, card: cardId, ask: g.id, go: go.go, fingerprint: fp.sha256 };
}

// The worker prompt is built as the runner builds it at launch (wiring/runner-ports.mjs promptFor → M5 workerPrompt),
// with a stand-in commit and outbox: the card's own fields are what can refuse it. → null, or why it can't be worded.
const STAND_IN = Object.freeze({ head: '0'.repeat(40), outbox: '/var/empty/orchestrate-prompt-check' });
// The two refusals go-card and withdraw-card share, worded once here (I7, L1343).
export const notTestProductText = (product) => `this command works only on a product whose rules mark it the test product (${TEST_PRODUCT_KEY}: true), and ${product}'s don't`;
export const unreadableCardText = (cardId) => `card ${cardId} is in the Record but can't be read`;
// And the ones go.mjs, the go on a card already in the Record, shares (Track A step 9).
export const notDraftText = (cardId, state) => `card ${cardId} is ${state}; a go is given on a draft card`;
export const rowsUnreadText = (e) => `the card's rows could not be read: ${String(e?.message ?? e).slice(0, 300)}`;
export const cantStartText = (words, none) => `the runner could not give this card to a worker (${words}); ${none}`;
export const goRecordedText = (r) => `(go ${r.go}, fingerprint ${r.fingerprint.slice(0, 12)}), by owner command, not a phone tap. The Dispatcher moves the card to ready on its next pass.`;

export function promptProblem(product, cardId, doc) {
  const p = workerPrompt({ role: 'worker', kind: 'editing', card: cardId, cardDoc: doc, product, ...STAND_IN });
  return p.ok ? null : p.reason;
}

/** The Record as planRows reads it, with the planned card in it before it is written. */
export const withPlannedCard = (rec, cardId, doc) => ({ ...rec, read: (entity, id) => (entity === 'card' && id === cardId ? { id, doc } : rec.read(entity, id)) });

/**
 * The Dispatcher's config at `path`, read and checked as its job reads it, with the process checks (whoFromConfig)
 * passed; throws one plain reason otherwise. Shared with withdraw-card.mjs (L1343). Loaded inside, not at the top, so a
 * test of the checks above needs none of the Mac's setup code.
 */
export async function ownerConfig(path, { uid, sudoUid, self, usage = USAGE }) {
  const { readConfig } = await import('../modules/M11-dispatcher/main.mjs');
  const { checkConfig } = await import('../wiring/dispatcher-wiring.mjs');
  const { readUser } = await import('./users-folders.mjs');
  const { realIo } = await import('./mac.mjs');
  const c = readConfig(path, { self });
  checkConfig(c);
  const who = whoFromConfig({ uid, sudoUid, dispatcherUid: readUser(realIo(), RUN_AS).uid, config: c, usage });
  if (who) throw new Error(who);
  return c;
}

/** The Record and rules of that config's product, as an M2 context whose alerts are logged, not sent. `name`: the command's. */
export async function ownerContext(c, { name, log, fetchFn, now }) {
  const { recordAndRules } = await import('../wiring/dispatcher-wiring.mjs');
  const { rec, rules, gh, entry } = await recordAndRules(c, { who: name, log, fetchFn, now });
  const ctx = { record: rec, rules, product: c.product, now, alert: (a) => { log(`${name}: alert not sent: ${JSON.stringify(a)}`); return false; } };
  return { rec, gh, entry, ctx };
}

/** The command. Ports are for a test; production passes none. → exit code. */
export async function main(argv, {
  env = process.env, uid = process.getuid(), now = () => Date.now(), fetchFn = globalThis.fetch,
  log = (s) => process.stderr.write(`${s}\n`), out = (s) => process.stdout.write(`${s}\n`), confirm = ttyConfirm, self = DISPATCHER_SELF,
} = {}) {
  try {
    if (argv.length !== 2) throw new Error(`usage: ${USAGE}`);
    const { githubReads, planRows } = await import('../wiring/review-ports.mjs');
    const c = await ownerConfig(argv[0], { uid, sudoUid: env.SUDO_UID, self });
    let cardText;
    try { cardText = readFileSync(argv[1]); } catch (e) { throw new Error(`the card file can't be read (${e?.code ?? 'unknown error'})`); }
    const { rec, gh, entry, ctx } = await ownerContext(c, { name: 'go-card', log, fetchFn, now });
    const reads = githubReads({ gh, entry });
    const readRows = ({ product, cardId, doc }) => planRows({ gh, entry, rec: withPlannedCard(rec, cardId, doc) })({ product, card: cardId });
    const r = await goCard({ ctx, cardText, sudoUid: Number(env.SUDO_UID), readRows,
      view: await reads.planView({ product: c.product }), mainSha: await reads.mainSha({ product: c.product }), confirm });
    if (!r.ok) throw new Error(r.reason);
    out(`Card ${r.card} written and its go recorded ${goRecordedText(r)}`);
    return 0;
  } catch (e) {
    log(`go-card: ${String(e?.message ?? e).slice(0, 500)}`);
    return 1;
  }
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
// The config is the Dispatcher's, so it is checked as the Dispatcher's job reads it: against the job's own script in this
// same copy (L1323). This file is in setup/, which the copy's own-code check (copyModuleProblem) rightly refuses as a job.
export const DISPATCHER_SELF = realOf(fileURLToPath(new URL('../modules/M11-dispatcher/main.mjs', import.meta.url)));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
