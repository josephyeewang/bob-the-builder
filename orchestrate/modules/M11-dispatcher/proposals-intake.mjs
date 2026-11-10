// proposals-intake.mjs — the proposals folder: files from Joe's own tabs (MAIN, PRODUCT, LAB), taken in by the
// Dispatcher (R-0b-128 part 1; LEAD-CALLS L76 (3) (5), L77 (1) m1, L78 n2 n5 n6, L215).
//
// WHY. Joe's tabs are not sessions the Dispatcher started, so they have no outbox, no session id and no role. A file
// here is data, never a writer identity (L215 1): the Dispatcher checks it and writes every record that comes from it,
// as itself. Every AI session `orchestrate` starts is `orchestrate` too, so the Mac can't keep a worker out of this
// folder by user (L65): the folder is Joe-only write, and every product's folder is on every AI session's read-deny
// (render-settings.mjs `paths.deny.proposals`, L78 n5).
//
// The folder, per product, at the rules key `proposals.outbox`: a plain folder (not a link), owned by Joe's uid, with
// no write for anyone else and nothing for others (mode 0750 or tighter). Joe's uid is the one config value `ownerUid`
// (the review runner's), checked at start and never read from the folder's own owner (L78 n6).
//
// Every file: opened without following a link; a plain file with one link, owned by Joe's uid; a name of exactly one
// of the forms in NAMES. Anything else, and any `verdict-*`, is refused with a logged reason (D12). The Dispatcher never
// writes or deletes in the folder. A dot-name (an editor's or Finder's own file) is skipped unread, as outbox-intake does.
//
// Each file taken in is an `intake-applied-proposals-<product>-<name>` fact with its sha256 (L74; the Dispatcher's
// `intake-applied-` family). Per kind (L78 n2): a heartbeat with the same name and new bytes is a new poll, and its one
// fact is updated in place; any other kind with new bytes on a used name is refused with an alert, outbox-intake.mjs's
// rule (a file never used, refused or interrupted, may come again with new bytes). A refusal is recorded with its
// text and told once; a refused file is not looked at again until its bytes change. A refusal or interruption whose
// tell was lost (the queue write refused, or the cap dropped it) is told again at the start of each pass, until its
// told mark is written (L260 MAT-1): outbox-intake's retell no longer finds these facts, whose ids are hashes (L233 M-4).
// A folder problem or a kind with nothing to take it in is likewise told until delivered (L260 MAT-2), and two products
// whose rules name the same folder are both refused, so no file is taken in twice (L260 MAT-3). A folder is, for good,
// the first product's that takes files in from it: a product whose rules name it later is refused and told until its
// rules give it a new folder, so files the first used are never taken in again (L268 MAT-B). Bytes are one product's for
// good too: by sha256, whatever happened to the folders, bytes another product handed in are refused (L279; the per-name
// used list covers only the same name in the same product, so a product's own bytes under a new name go in again,
// L254). Heartbeats are not checked: a poll's bytes come again by design. An interruption whose
// tell was lost is carried by every later write of the file's fact, so a claim or refusal never hides it (L268 MAT-A).
// A file name goes into an alert or the diary only fenced (`shownName`: one line, stripped, masked; R-0b-126, probe P7).
//
// A proposal must name a ready card of its own product (R-0b-129): `proposal-<card>.md` for a card in the record that is
// this product's and `ready`. Anything else (no such card, another product's, a card in any other state, or a research
// copy, which only the copier lands) is refused at intake, before the docs check or review; a card that can't be read
// keeps the proposal unused this pass and is told. "Claimed by the lane handing in" waits on R-0b-130's tab claims:
// until then only a ready card is taken, so a card claimed by anyone is refused (L215 3).
//
// Day 1 (`product.cutover_stage` first; L76 (5)):
//   - research-, claim- and heartbeat- files go to their handlers (R-0b-135, R-0b-130, R-0b-131);
//   - idea- files are refused: idea filing stays off until #95-b lands (L212, L215 2);
//   - a proposal goes to the docs-lane check, run on the push script's real changed files for its bundle's net change
//     (L77 m1): `docsCheck`, built by proposal-route.mjs. Until it is passed in, every proposal is refused
//     with FIRST_CUTOVER before any review starts, which fails closed. A bundle is taken in only with its proposal.
// A proposal that passes goes to review (`toReview`, built by proposal-route.mjs, at either cutover); until it is
// passed in, refused. Its way to review after that is proposalRoutePass's, not this file's.
// A docs check that could not finish, or met a cause that may pass by itself (a pause, one read or rules error, the
// bundle moving during the check), answers { retry }: the file waits for the next pass, its cause on a wait fact, and
// Joe is told at once, then daily while it waits (L325 m2, L597). Only a real answer about the change is final; the
// refusal names it (MAIN merges code by hand, or the push script refused the bundle). A proposal refused over its
// bundle is looked at again once the bundle held is other bytes, and a held bundle never handed on may be replaced.
// A proposal whose route ended refused at the push, or lost its card to another holder (routeReopened), gives its
// names back, so they take new bytes (L549, L718 M1). A cancelled one keeps them.
// A kind whose handler is not passed in is left untouched and unrecorded, so it is taken in once the handler lands.
//
//   proposalsPass({ rec, rules, products, ownerUid, wait, alert, note, handlers, docsCheck, toReview, now }) → [result]
//   proposalsReadBack({ dir, ownerUid, canRead, canWrite, settings }) → [] | every problem (Joe's setup batch)

import { createHash } from 'node:crypto';
import { routeReopened, shownName, textOr } from './proposal-route.mjs';
import { readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants as C } from 'node:fs';
import { join } from 'node:path';
import { KEYS, need } from './keys.mjs';
import { tellThen, dropCause, isQueued } from './alerts.mjs';
import { pastTime, stillWaiting, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';
// Git's blob id for a file's bytes, the id refusal 10 compares at merge (M6 gather `blob`; L290 M-1).
import { blobSha } from '../M10-rules/reader.mjs';
import { BUNDLE_CAP, SETTLE_MS, FOLDER_LOOSE, plainError } from '../M4-workshop/git/push.mjs';
import { idHash, intakeFactId } from './intake-facts.mjs';
import { plainFolder } from '../M4-workshop/launcher/proposal-wall.mjs';
import { cleanOutside, SOURCES } from '../M12-sensors/escape.mjs';

export const FIRST_CUTOVER = 'First cutover: MAIN merges code by hand.';

/** The card as a refusal is keyed on: its id and revision (0 when there is none), or null when it can't be read. */
export function proposalCardKey(rec, card) {
  try { const o = rec.read('card', card); return o?.corrupt ? null : `${card}@${Number.isSafeInteger(o?.rev) ? o.rev : 0}`; } catch { return null; }
}

/**
 * Why a proposal from `product`'s folder can't name `card` (R-0b-129): { refuse, key } when it can't, keyed on the card's
 * revision so the refusal is looked at again once the card changes (#159 audit Minor 2); { broke } when the card can't
 * be read (looked at again next pass); or { rev } when it is a ready card of this product, the revision it was seen at.
 */
export function proposalCardProblem(rec, product, card) {
  let o;
  try { o = rec.read('card', card); } catch (e) { return { broke: `card ${card} could not be read (${plainError(e?.message ?? e)})` }; }
  if (!o) return { refuse: `no card ${card} in the record: a proposal must name a ready card`, key: `${card}@0` };
  // A card with no product is one the record's writer can't make (it sets `product` at create): read as can't be read.
  if (o.corrupt || !o.doc || typeof o.doc !== 'object' || typeof o.doc.product !== 'string' || !o.doc.product || !Number.isSafeInteger(o.rev)) {
    return { broke: `card ${card} could not be read (${plainError(String(o.reason ?? (o.doc && typeof o.doc === 'object' && Number.isSafeInteger(o.rev) ? 'no product named' : 'no document'))).slice(0, 200)})` };
  }
  const key = `${card}@${o.rev}`;
  if (o.doc.product !== product) return { refuse: `card ${card} is ${o.doc.product.slice(0, 100)}'s, not ${product}'s`, key };
  if (o.doc.kind === 'research_copy') return { refuse: `card ${card} is a research copy, which only the copier lands (L286)`, key };
  if (!PROPOSAL_CARD_STATES.includes(o.doc.state)) return { refuse: `card ${card} is ${String(o.doc.state).slice(0, 40)}, not ready: a proposal must name a ready card`, key };
  return { rev: o.rev };
}
export const IDEAS_OFF = 'idea filing is off until #95-b lands (L212, L215)';
export const TEXT_CAP = 1024 * 1024;
export { SETTLE_MS };
// A bundle with no proposal is waited for this long (by its own write time), then refused.
export const BUNDLE_ALONE_MS = 10 * 60_000;
// The one card state a proposal may name until R-0b-130's claims (L215 3).
export const PROPOSAL_CARD_STATES = Object.freeze(['ready']);

// The six names (L76 (3)). An id is a card, ask, slug or tab id, in the push script's own card id shape.
const ID = '([A-Za-z0-9][A-Za-z0-9-]{0,63})';
export const NAMES = Object.freeze({
  proposal: new RegExp(`^proposal-${ID}\\.md$`),
  bundle: new RegExp(`^bundle-${ID}\\.bundle$`),
  research: new RegExp(`^research-${ID}\\.md$`),
  idea: new RegExp(`^idea-${ID}\\.md$`),
  claim: new RegExp(`^claim-${ID}\\.md$`),
  heartbeat: new RegExp(`^heartbeat-${ID}\\.md$`),
});
// What each kind's text is, as outside text (R-0b-126). Every kind in NAMES names its source here, so none falls to
// 'unknown'; a bundle is git's bytes, handed on only as a path and never read as text, so it is BYTES. The text a
// handler or review gets is only ever cleanOutside's fenced copy (stripped, masked, escaped); the sha256 is of the
// raw bytes. A kind with no source here is refused (fenceFor throws), and proposals-intake.test.mjs fails.
export const BYTES = 'bytes';
export const SOURCE_OF = Object.freeze({
  proposal: 'proposal-file', bundle: BYTES, research: 'research-file', idea: 'idea-file', claim: 'proposal-file', heartbeat: 'proposal-file',
});
// A file name as alert text shows it: one line, stripped, masked and fenced (R-0b-126, probe P7). Defined in the route,
// which fences the push script's reasons the same way (L718 M2), and named here as before.
export { shownName };
/** The fenced copy of a file's text, with its kind's own source; throws for a kind with none, or one that is bytes. */
export function fenceFor(kind, text) {
  const source = Object.hasOwn(SOURCE_OF, kind) ? SOURCE_OF[kind] : null;
  // `source === BYTES` is also refused by the SOURCES check today ('bytes' is not an outside-text source). It stays so
  // the rule "a bundle is never read as text" does not rest on M12's list never gaining that word.
  if (!source || source === BYTES || !SOURCES.includes(source)) throw new Error(`no outside-text source for a ${kind} file`);
  return { source, fenced: cleanOutside(text, source) };
}

/** The kind and id a name stands for, or null. */
export function proposalName(name) {
  for (const [kind, re] of Object.entries(NAMES)) { const m = re.exec(name); if (m) return { kind, id: m[1] }; }
  return null;
}

export const sourceOf = (product) => `proposals-${product}`;
export { intakeFactId };
/** The fact a product's folder problem is kept in. */
export const folderFactId = (product) => `intake-applied-proposals-folder-${idHash(product)}`;
/** The fact that says files of `kind` sit in a product's folder with nothing to take them in yet. */
export const waitingFactId = (product, kind) => `intake-applied-proposals-waiting-${idHash(product, kind)}`;
/** The fact that says which product first took files in from a folder, by its file number; its creation time is kept inside and checked (L268 MAT-B, L275, L279). */
export const ownerFactId = (ino) => `intake-applied-proposals-owner-${idHash(ino)}`;
/** The product that first handed these bytes in, for good, across every product (L279). */
export const bytesFactId = (sha256) => `intake-applied-proposals-bytes-${idHash(sha256)}`;
/** The fact a file waiting on a cause that may pass by itself is kept and told on, once then daily (L325 m2, L597 (1)). */
export const retryFactId = (product, name) => `intake-applied-proposals-retry-${idHash(product, name)}`;
/** The fact a tell is marked on when the record refused the file's own fact (told once, not every pass). */
export const toldFactId = (product, name) => `intake-applied-proposals-told-${idHash(product, name)}`;
// The row that will take each handed-on kind in (L233 M-2: until then, told once per product and kind).
export const HANDLER_ROW = Object.freeze({ research: 'R-0b-135', claim: 'R-0b-130', heartbeat: 'R-0b-131' });
// Bundles first, so a proposal's bundle is checked and recorded in the same pass before the proposal reads it.
const ORDER = (name) => (name.startsWith('bundle-') ? 0 : 1);

/** The folder's own problem, or null. `look` is lstat. */
export function folderProblem(dir, ownerUid, look = lstatSync) {
  if (!plainFolder(dir)) return 'proposals.outbox is not a plain absolute folder path';
  let st; try { st = look(dir); } catch { return 'the proposals folder is missing'; }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'the proposals folder is not a plain folder';
  if (st.uid !== ownerUid) return `the proposals folder is owned by user ${st.uid}, not the owner's user`;
  if ((st.mode & FOLDER_LOOSE) !== 0) return `the proposals folder's mode ${(st.mode & 0o777).toString(8)} is looser than 750`;
  return null;
}

/**
 * Reads one file through a handle opened without following a link. → { ok, sha256, size, text?, blob? } | { ok: false, reason }.
 * A bundle is hashed in pieces and never held as text; every other kind is text, at most TEXT_CAP bytes, and also gets
 * `blob`, git's blob id of the same bytes (L290 M-1): sha256, blob and text all come from the one read of one handle.
 * `fs` is the four calls it makes, so a test can make a file look owned by another user.
 */
export function readProposalFile(dir, name, { ownerUid, kind, fs = { openSync, fstatSync, readSync, closeSync } }) {
  const cap = kind === 'bundle' ? BUNDLE_CAP : TEXT_CAP;
  // Its reasons never carry the name: the caller names the file, fenced (R-0b-126, probe P7; L260 m-g).
  let fd;
  try { fd = fs.openSync(join(dir, name), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch { return { ok: false, reason: 'it could not be opened without following a link' }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'it is not a plain file' };
    if (st.nlink !== 1) return { ok: false, reason: 'it has more than one link' };
    if (st.uid !== ownerUid) return { ok: false, reason: `it is owned by user ${st.uid}, not the owner's user` };
    if (st.size > cap) return { ok: false, reason: `it is larger than ${cap} bytes` };
    const h = createHash('sha256');
    const keep = kind === 'bundle' ? null : [];
    const buf = Buffer.alloc(1 << 20);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      total += n;
      if (total > cap) return { ok: false, reason: `it is larger than ${cap} bytes` };
      h.update(buf.subarray(0, n));
      keep?.push(Buffer.from(buf.subarray(0, n)));
    }
    if (!keep) return { ok: true, sha256: h.digest('hex'), size: total };
    const bytes = Buffer.concat(keep);
    return { ok: true, sha256: h.digest('hex'), size: total, text: bytes.toString('utf8'), blob: blobSha(bytes) };
  } finally { fs.closeSync(fd); }
}

const statOf = (p) => { try { const s = lstatSync(p); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return null; } };

// The cutover stage: anything but an exact `second` is the first cutover, as M6 gather.mjs reads it. Not an M11
// required key: a missing or odd value is the first cutover, which fails closed.
export function stageOf(rules, product) {
  try { return rules.get('product.cutover_stage', { product }) === 'second' ? 'second' : 'first'; } catch { return 'first'; }
}

/**
 * One pass over every product's proposals folder.
 * `products`: the product ids. `ownerUid`: Joe's uid from the Dispatcher's config. `wait(ms)`: a sleep.
 * `alert(text, { mark })`: the queueing alert. `note(text)`: a diary line.
 * `handlers`: { research, claim, heartbeat }, each ({ rec, product, kind, id, name, source, fenced, sha256, blob, size, now }) → { ok, reason? } (`now`: the pass's clock):
 *   `fenced` is the file's text as cleanOutside's fenced copy (R-0b-126); a handler never sees the raw text or bytes.
 *   `sha256`, `blob` (git's blob id) and `size` are of the raw bytes, from the same read (L290 M-1): a handler that
 *   needs the file itself (the research copy) records them on its card, and M6 refusal 10 compares the blob at merge.
 *   Open (lane 2, L286 follow-up): the copier, push.mjs, is not built; it will read the file again through M9's safe
 *   side-file open and copy it only when its sha256 still matches the card's.
 * A proposal must name a ready card of its own product (R-0b-129, proposalCardProblem), checked before the docs check
 *   and again just before the claim; a card refusal is keyed on the card's revision, so it is looked at again once the
 *   card changes. A card that can't be read keeps the file unused, told once.
 * `docsCheck({ product, card, bundle })` → null | reason | { refuse: reason } | { retry: reason } (proposal-route.mjs), and `toReview({ rec, product, card, cardRev, proposal, bundle })` → { ok, reason? } (`proposal` fenced too):
 *   `cardRev` is the card's revision at the last check: the card move expects it, so a card changed since is refused.
 *   `bundle` is { path, sha256 }: the bytes this pass checked and recorded (L233 M-5), so the push takes the bytes that were checked.
 *   Not passed in, every proposal is refused. Its refusal is keyed on the card, so it is looked at again once the card changes.
 * Returns what happened to each file.
 */
export async function proposalsPass({ rec, rules, products, ownerUid, wait, alert, note = () => {}, handlers = {}, docsCheck, toReview,
  now = Date.now(), list = (d) => readdirSync(d), look = statOf, lookDir = lstatSync, fs }) {
  if (!Number.isInteger(ownerUid) || ownerUid <= 0) throw new Error('proposalsPass: ownerUid must be the owner\'s uid from the config');
  const out = [];
  const seen = [];
  retellFiles(rec, alert, products);
  const folders = products.map((product) => {
    let dir;
    let why = null;
    // No proposals.outbox, or one that is not text, is a folder that is never read: told once like any other folder
    // problem (lane 2's #124 review, Material; L233 m3).
    try { dir = need(rules, KEYS.proposalsOutbox, { product, type: 'text' }); } catch {
      let raw;
      try { raw = rules.get(KEYS.proposalsOutbox, { product }); } catch { raw = null; }
      why = raw === undefined ? 'no proposals.outbox in the rules' : 'proposals.outbox is set but is not a folder path';
    }
    if (!why) why = folderProblem(dir, ownerUid, lookDir);
    return { product, dir, why };
  });
  // Two products whose rules name the same folder (by file number, so a second path to it counts too) would each take
  // every file in once: both are refused until the rules give each its own folder (L260 MAT-3).
  // A folder is known by its file number, never its device number: macOS numbers devices in the order they attach, so
  // the device can change after a restart (L275 MAT-C). Its creation time is kept in the owner record and checked, not
  // used to find it: macOS rewrites it when something dates the folder earlier (L279 MAT-D). None of this is what keeps
  // a file from being used twice; the bytes record below is (L279).
  const byFolder = new Map();
  for (const f of folders) {
    if (f.why) continue;
    let st; try { st = lookDir(f.dir); } catch { st = null; }
    // A folder that can't be told apart from another is not read: no owner could be checked for it (L268 MAT-B).
    if (!Number.isInteger(st?.ino) || st.ino <= 0 || !Number.isFinite(st?.birthtimeMs) || st.birthtimeMs <= 0) { f.why = 'the proposals folder could not be identified'; continue; }
    f.at = { ino: st.ino, birth: st.birthtimeMs };
    const k = String(st.ino);
    byFolder.set(k, [...(byFolder.get(k) ?? []), f]);
  }
  for (const group of byFolder.values()) {
    if (group.length < 2) continue;
    for (const f of group) f.why = `the proposals folder is also ${group.filter((g) => g !== f).map((g) => g.product).join(', ')}'s, so its files would be taken in once per product`;
  }
  // The folder's first product owns it for good (L268 MAT-B): the used memory is per product, so another product that
  // named it later would take every file the first one used in again. Recorded before any file is read; a write the
  // record refuses keeps the folder unread this pass. The cost (L268): a folder stays its first product's for good, so
  // another product needs a new folder, never a used one. A folder copied or restored has a new file number and counts
  // as new, even at the same path; MAT-3 has the same limit, and the bytes record covers what it lets through.
  for (const f of folders) {
    if (f.why) continue;
    const id = ownerFactId(f.at.ino);
    const o = rec.read('fact', id);
    const first = o?.doc?.product;
    if (first === f.product) continue;
    if (first != null && o.doc.birth !== f.at.birth) { f.why = `the proposals folder has ${first}'s file number but a different creation time (re-dated or replaced), so it may be ${first}'s; give ${f.product} a new folder`; continue; }
    if (first != null) { f.why = `the proposals folder was ${first}'s first, so the files ${first} took in from it would be taken in again; give ${f.product} a new folder`; continue; }
    const w = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: o?.rev ?? 0, doc: { product: f.product, ino: f.at.ino, birth: f.at.birth, at: new Date(now).toISOString() }, kind: 'proposal_folder_owner' });
    if (!w.ok) f.why = `the proposals folder's first product could not be recorded (${plainError(String(w.reason))})`;
  }
  for (const f of folders) {
    const { product, dir } = f;
    let why = f.why;
    let names = null;
    // Kept on the folder too, so endWaits doesn't read one failed listing as every wait in it ended (L669 minor).
    if (!why) { try { names = list(dir); } catch { why = f.why = 'the proposals folder could not be read'; } }
    tellCause(rec, folderFactId(product), { product, folder: true }, why, `${product}'s proposals folder is not taken in: ${why}`, alert, now);
    if (why) { out.push({ product, skipped: why }); continue; }
    names = names.filter((n) => !n.startsWith('.')).sort((x, y) => ORDER(x) - ORDER(y));
    for (const name of names) seen.push({ product, dir, name, names, first: look(join(dir, name)) });
  }
  if (seen.length) await wait(SETTLE_MS);
  const waiting = new Map(products.map((p) => [p, new Set()]));
  const rows = new Map();
  // The files that wait this pass on a cause that may pass by itself (waitOn): every other wait fact is ended below.
  const waitingOn = new Set();
  for (const { product, dir, name, names, first } of seen) {
    const r = { product, name };
    out.push(r);
    rows.set(`${product}/${name}`, r);
    // The name as alert and note text may carry it: fenced, so a planted line in a name is never read as an instruction.
    const shown = shownName(name);
    if (first === null || look(join(dir, name)) !== first) { r.waiting = 'still being written'; continue; }
    const id = intakeFactId(product, name);
    let prev = rec.read('fact', id);
    // Every put carries the bytes this name has ever used, or may have (L254): a later write of the fact, a refusal, a
    // claim of new bytes after an interruption, never erases them, so those bytes are never handed on again.
    const put = (doc, kind) => {
      const used = usedOf(prev?.doc);
      // An interruption not yet told goes with every write too, so a claim or refusal never hides it (L268 MAT-A).
      const w = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: prev?.rev ?? 0, doc: { session: sourceOf(product), product, name, ...untoldOf(prev?.doc), ...doc, ...(used.length ? { used } : {}) }, kind });
      if (w.ok) prev = rec.read('fact', id);
      return w;
    };
    // The used note on the bytes' own fact (L736 m3): its time, or null. Written only for bytes this product handed in.
    // The note names the file and is no older than its claim: the bytes fact is shared by every name with these bytes,
    // so another name's use is never read as this one's (self-review m2). It goes once the mark is made.
    const usedMark = (h, since) => { try { const o = rec.read('fact', bytesFactId(h)); return o && !o.corrupt && o.doc?.product === product && o.doc.used_name === name && typeof o.doc.used_at === 'string' && typeof since === 'string' && o.doc.used_at >= since ? o.doc.used_at : null; } catch { return null; } };
    const noteUsed = (h, on = true) => {
      try {
        const o = rec.read('fact', bytesFactId(h));
        if (!o || o.corrupt || o.doc?.product !== product) return false;
        const { used_at: _a, used_name: _n, ...rest } = o.doc;
        if (!on && _a === undefined && _n === undefined) return true;
        return rec.write({ actor: 'dispatcher', entity: 'fact', id: bytesFactId(h), expectRev: o.rev, doc: on ? { ...rest, used_name: name, used_at: new Date(now).toISOString() } : rest, kind: 'proposal_bytes' }).ok === true;
      } catch { return false; }
    };
    // The record refused this file's own fact: the tell is marked on its told fact instead, so it is told once per
    // cause, not every pass (L233 M-3, m4). `daily`: told again once its told time is 24 h old, as stillWaiting does
    // (L702 minor 5), for a wait that goes on.
    const tellUnrecorded = (said, key, { daily = false } = {}) => {
      note(`proposals ${product}: ${shown}: ${said}`);
      const mark = rec.read('fact', toldFactId(product, name))?.doc;
      const at = daily ? pastTime(mark?.told_at, now) : null;
      if ((mark?.told === key && (!daily || (at !== null && now - at < STILL_WAITING_MS))) || isQueued(rec, toldFactId(product, name))) return undefined;
      return tellThen(alert, said, { fact: toldFactId(product, name), fields: { told: key, ...(daily ? { told_at: new Date(now).toISOString() } : {}) }, kind: 'proposal_told' });
    };
    // A refusal is recorded once per reason and bytes, and told once (not every pass while the file sits there).
    // A refusal with no bytes to name (a bad name, too big, a link, another owner) never erases a recorded state (L254):
    // it is added beside it, so a used file's "already used" still holds when its bytes come back.
    // Told once per reason and file: the bytes' hash, or for a file never read, its size, change time and file number
    // (L259). A new file refused for the same reason is a new request, and told again; one sitting there is not.
    const refuse = (reason, hash = null, extra = null) => {
      r.refused = reason;
      const told = `${reason}\n${hash ?? first}`;
      const keep = hash === null && prev?.doc?.sha256 != null && prev.doc.state !== 'refused';
      if ((keep || prev?.doc?.state === 'refused') && prev.doc.refused_key === told) {
        // Told already; a card refusal keeps the card's newest key, so it is not looked at again until the card changes.
        if (extra && Object.entries(extra).some(([k, v]) => prev.doc[k] !== v)) put({ ...prev.doc, ...extra }, 'proposal_refused');
        return;
      }
      const said = `${shown} in ${product}'s proposals folder was refused: ${reason}`;
      note(`proposals ${product}: ${shown} refused: ${reason}`);
      const at = new Date(now).toISOString();
      // Its own text and key, apart from an interruption's, so each is told again until delivered (L260 MAT-1).
      const w = put(keep ? { ...prev.doc, refused_why: reason, refused_at: at, refused_key: told, refused_text: said } : { sha256: hash, state: 'refused', why: reason, at, refused_key: told, refused_text: said, ...(extra ?? {}) }, 'proposal_refused');
      if (w.ok) tellThen(alert, said, { fact: intakeFactId(product, name), fields: { told_key: told }, kind: 'proposal_told' });
      else tellUnrecorded(said, `refused ${told}`);
    };
    // A wait that may pass by itself (L325 m2): the file stays unused, the cause is kept on its wait fact, and Joe is told
    // at once, then each day while it waits (the shared stillWaiting). `why` is already fenced where it quotes outside text
    // (a check's own words, as a broken card or bytes record's, need none).
    const waitOn = (why, hash) => {
      r.waiting = why;
      waitingOn.add(`${product}/${name}`);
      const fid = retryFactId(product, name);
      let cur; try { cur = rec.read('fact', fid); } catch { cur = null; }
      const old = cur?.corrupt ? null : cur?.doc;
      // The start, from the wait fact, else from the delivered mark (which carries it): a wait fact the Record refused
      // must not restart the wait each pass, told and noted every pass (L669 M2).
      const markSince = typeof old?.since === 'string' ? old.since.split(WAIT_KEY_SEP)[0] : undefined;
      const since = typeof old?.waiting_since === 'string' ? old.waiting_since : pastTime(markSince, now) !== null ? markSince : new Date(now).toISOString();
      // The causes told in this wait, each with when (L680 M2): a cause told within the day is not told again when it
      // comes back, so two causes that take turns are told at most once each a day, never every pass.
      const cause = idHash(why).slice(0, 8);
      const markCause = typeof old?.since === 'string' ? old.since.split(WAIT_KEY_SEP)[1] : undefined;
      const toldCauses = plainObject(old?.told_causes);
      const toldLately = (h) => { const t = pastTime(toldCauses[h], now); return t !== null && now - t < STILL_WAITING_MS; };
      const fresh = cause !== markCause && !toldLately(cause);
      if (old?.waiting_since !== since || old?.why !== why) {
        const w = putWait(rec, fid, cur?.rev ?? 0, { ...(old ?? {}), product, name, waiting_since: since, why });
        // Noted when the wait begins or its cause is new to Joe today; a cause that comes back is not noted each pass.
        if (w?.ok && (old?.waiting_since !== since || fresh)) note(`proposals ${product}: ${shown} waits: ${why}`);
        else if (!w?.ok && old?.waiting_since === undefined && markSince === undefined) {
          // Nothing kept says when it began: told once a day for these bytes, never once a pass (the L233 M-3 rule;
          // L680 minor: once a day, as any wait is).
          tellUnrecorded(`${shown} in ${product}'s proposals folder waits and was not used: ${why}. Its wait could not be recorded (${plainError(w?.reason ?? 'no answer')})`, `wait ${hash}`, { daily: true });
          return;
        }
      }
      // Keyed on the start and the cause told: a new cause is told at once (L669 minor); one told within the day keeps
      // the mark's key, so stillWaiting tells it only at the daily repeat.
      const key = fresh || markCause === undefined ? cause : markCause;
      const kept = Object.fromEntries(Object.entries(toldCauses).filter(([h]) => toldLately(h)).slice(-8));
      stillWaiting({
        waiting: true, now, since: `${since}${WAIT_KEY_SEP}${key}`,
        read: () => rec.read('fact', fid)?.doc ?? null,
        tell: (fields) => tellThen(alert, `${shown} in ${product}'s proposals folder has waited since ${since} and was not used: ${why}. It is checked again each pass; told again each day while it waits`, { fact: retryFactId(product, name), fields: { ...fields, told_causes: { ...kept, [cause]: new Date(now).toISOString() } }, kind: 'proposal_told' }),
        clear: () => {},
      });
    };
    // The bytes this product's bundle for `pk` is held or refused with now, or null: what a proposal's refusal is keyed on.
    const bundleKeyOf = (pk) => { try { const s = rec.read('fact', intakeFactId(product, `bundle-${pk}.bundle`))?.doc?.sha256; return typeof s === 'string' ? s : null; } catch { return null; } };
    // Whether a held bundle's bytes may have gone on with a proposal: their bytes record is written just before the claim
    // (bytesSeen below), so with none they never did. One that can't be read counts as gone, so nothing is replaced.
    const mayHaveGone = (sha) => { if (typeof sha !== 'string') return true; try { return rec.read('fact', bytesFactId(sha)) != null; } catch { return true; } };
    const parsed = proposalName(name);
    if (!parsed) { refuse(name.startsWith('verdict-') ? 'a verdict comes only from a review session\'s own outbox' : 'it is not a proposals file name'); continue; }
    r.kind = parsed.kind;
    const file = readProposalFile(dir, name, { ownerUid, kind: parsed.kind, ...(fs ? { fs } : {}) });
    if (!file.ok) { refuse(file.reason); continue; }
    const hash = file.sha256;
    // A pass that used the file but could not mark it applied left that on the bytes' own fact (L736 m3): the mark is
    // tried again now, and nothing is told as an interruption, since the file is known to have been used.
    const usedAt = prev?.doc?.state === 'applying' && parsed.kind !== 'heartbeat' ? usedMark(prev.doc.sha256, prev.doc.at) : null;
    if (usedAt) {
      const usedSha = prev.doc.sha256;
      const m = put({ sha256: usedSha, state: 'applied', applied_at: usedAt }, 'proposal_applied');
      if (m.ok && !noteUsed(usedSha, false)) note(`proposals ${product}: ${shown}: its "used" note could not be taken off the bytes record; it is left, and never read for a later claim, which is newer`);
      r.marked = m.ok ? 'used in an earlier pass; marked applied now' : `used in an earlier pass, and still could not be marked applied (${plainError(String(m.reason))}); tried again next pass`;
      // Never used twice: still unmarked, it is left for the next pass.
      if (!m.ok) { r.already = true; note(`proposals ${product}: ${shown}: ${r.marked}`); continue; }
    }
    if (prev?.doc?.state === 'applying' && parsed.kind !== 'heartbeat') {
      // A pass that stopped between its claim and the hand-over (outbox-intake's MAT-7): whether the file was used is
      // not known, so it is never used twice. Told once. A heartbeat is a poll, so it is simply taken again.
      const said = `the intake of ${shown} from ${product}'s proposals folder was interrupted (version ${String(prev.doc.sha256).slice(0, 12)}); it may or may not have been used, and was not used again`;
      // Keyed on the interrupted bytes; one still untold from before is told in the same alert (L268 MAT-A). A claim
      // never carries a told mark, so the key need only differ from the mark this fact holds now.
      const old = untoldOf(prev.doc);
      const key = String(prev.doc.sha256);
      const text = old.interrupted_text ? `${old.interrupted_text}; ${said}` : said;
      const w = put({ ...prev.doc, state: 'interrupted', at: new Date(now).toISOString(), interrupted_text: text, interrupted_key: key }, 'proposal_interrupted');
      if (!w.ok) { r.refused = `could not record the interruption: ${plainError(String(w.reason))}`; tellUnrecorded(said, `interrupted ${prev.doc.sha256}`); continue; }
      tellThen(alert, text, { fact: intakeFactId(product, name), fields: { told_interrupted: key }, kind: 'proposal_told' });
    }
    // Bytes this name used, or may have, before: never again, whatever the fact says now (L254). A heartbeat is a poll.
    if (parsed.kind !== 'heartbeat' && usedOf(prev?.doc).includes(hash)) { r.already = true; continue; }
    if (prev && prev.doc?.sha256 != null) {
      const was = prev.doc.state;
      if (prev.doc.sha256 === hash && ['applied', 'interrupted'].includes(was)) { r.already = true; continue; }
      // Refused for good, except a card refusal, looked at again once its card has changed (#159 audit Minor 2).
      const cardKey = typeof prev.doc.card_key === 'string' && parsed.kind === 'proposal' ? proposalCardKey(rec, parsed.id) : null;
      // Likewise a refusal that came from its bundle, once the bundle held is other bytes (L597 (2)).
      const bundleMoved = parsed.kind === 'proposal' && Object.hasOwn(prev.doc, 'bundle_key') && bundleKeyOf(parsed.id) !== prev.doc.bundle_key;
      if (prev.doc.sha256 === hash && was === 'refused' && !(cardKey !== null && cardKey !== prev.doc.card_key) && !bundleMoved) { r.refused = prev.doc.why; continue; }
      // L78 n2: a heartbeat's new bytes are a new poll. Every other kind: new bytes on a used name are refused, and so
      // is a held bundle's, once its bytes may have gone on with a proposal. A bundle held but never handed on is not
      // used, so a corrected one replaces it (the header's rule; L597 (2)). A proposal whose route ended refused or lost:
      // its bytes went nowhere, so its two names take new bytes (L549, L718 M1).
      const refiled = ['proposal', 'bundle'].includes(parsed.kind) && routeReopened(rec, parsed.id);
      const replaceable = ['refused', 'interrupted'].includes(was) || (parsed.kind === 'bundle' && was === 'held' && !mayHaveGone(prev.doc.sha256)) || refiled;
      if (prev.doc.sha256 !== hash && parsed.kind !== 'heartbeat' && !replaceable) {
        r.refused = 'the same name with new content';
        // Told once for these bytes: the mark lands when the alert is sent, and one still waiting is not queued again.
        if (prev.doc.told_new !== hash && !isQueued(rec, intakeFactId(product, name))) {
          const said = `${shown} in ${product}'s proposals folder was written again with different content; the second copy was not used`;
          tellThen(alert, said, { fact: intakeFactId(product, name), fields: { told_new: hash }, kind: 'proposal_told' });
        }
        continue;
      }
    }
    let use;
    let useBundle = null;
    let cardRev = null;
    // Which product handed these bytes in (L279). `record` writes this product's mark for bytes nobody has; without it the
    // check only reads, so a proposal's duplicate is refused as one before the first-cutover docs check (r6 m-1).
    const bytesSeen = (hashes, record) => {
      for (const h of hashes) {
        let o;
        try { o = rec.read('fact', bytesFactId(h)); } catch (e) { return { broke: `the check that no other product handed these bytes in could not be read (${plainError(e?.message ?? e)})` }; }
        if (o && (o.corrupt || typeof o.doc?.product !== 'string' || !o.doc.product)) return { broke: `the check that no other product handed these bytes in could not be read (${o.corrupt ? plainError(String(o.reason)).slice(0, 200) : 'no product named'})` };
        if (o && o.doc.product !== product) return { other: o.doc };
        if (o || !record) continue;
        const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: bytesFactId(h), expectRev: 0, doc: { product, name, sha256: h, at: new Date(now).toISOString() }, kind: 'proposal_bytes' });
        if (!w.ok) return { broke: `which product handed these bytes in could not be recorded (${plainError(String(w.reason))})` };
      }
      return {};
    };
    // Refused or told; true when the file must not be used this pass.
    const bytesStop = ({ other, broke }) => {
      if (other) {
        const as = typeof other.name === 'string' ? ` (as ${shownName(other.name)})` : '';
        refuse(`these bytes were already handed in by ${other.product}${as} on ${String(other.at ?? '').slice(0, 10) || 'an unknown date'}`, hash);
        return true;
      }
      // A check that could not be read is no outcome: the file waits, told daily, its wait kept (L680 minor).
      if (broke) { waitOn(broke, hash); return true; }
      return false;
    };
    if (parsed.kind === 'idea') { refuse(IDEAS_OFF, hash); continue; }
    if (parsed.kind === 'bundle') {
      const pair = `proposal-${parsed.id}.md`;
      // Held already, with these bytes: its proposal taken out for a while doesn't end it (L669 minor).
      if (!names.includes(pair) && prev?.doc?.state === 'held' && prev.doc.sha256 === hash) { r.held = `held; ${pair} is not in the folder`; continue; }
      if (!names.includes(pair)) {
        // Its proposal may still be on the way (lane 2's #124 review, m3): wait, unrecorded, while the bundle is young.
        // Its file time through the shared pastTime (L329): one that can't be read, or lies ahead (a clock that went back,
        // a re-dated file), counts as old enough, so the bundle is refused and told, never "waiting" for ever.
        const mtime = Number(String(first).split(':')[1]);
        const at = Number.isFinite(mtime) && Math.abs(mtime) <= 8.64e15 ? pastTime(new Date(mtime).toISOString(), now) : null;
        if (at !== null && now - at < BUNDLE_ALONE_MS) { r.waiting = `waiting for ${pair}`; continue; }
        refuse(`no ${pair} names this bundle's card`, hash); continue;
      }
      // Recorded, so new bytes under its name are refused and told like any other kind's (L233 M-5).
      if (!(prev?.doc?.state === 'held' && prev.doc.sha256 === hash)) {
        const w = put({ sha256: hash, state: 'held', at: new Date(now).toISOString() }, 'proposal_bundle');
        if (!w.ok) { r.refused = `could not record the bundle: ${plainError(String(w.reason))}`; tellUnrecorded(`${shown} in ${product}'s proposals folder could not be recorded (${plainError(String(w.reason))}); its proposal waits`, `bundle ${hash}`); continue; }
      }
      r.held = `taken in with ${pair}`;
      continue;
    }
    if (parsed.kind === 'proposal') {
      const card = parsed.id;
      const pair = `bundle-${card}.bundle`;
      // The bundle as this pass checked and recorded it: settled, read safely, held with these bytes (L233 M-5).
      // A held fact from an earlier pass is not enough: the bundle's row in this pass must say held.
      let bundle = null;
      if (names.includes(pair)) {
        const b = rec.read('fact', intakeFactId(product, pair))?.doc;
        const bundleRow = rows.get(`${product}/${pair}`);
        // Keyed on the bundle's bytes, so a corrected bundle has this proposal looked at again (L597 (2)).
        if (bundleRow?.refused || ['refused', 'interrupted'].includes(b?.state)) { refuse(`its ${pair} was refused`, hash, { bundle_key: bundleKeyOf(card) }); continue; }
        if (!bundleRow?.held || b?.state !== 'held') { r.waiting = `waiting for ${pair} to be taken in`; continue; }
        bundle = { path: join(dir, pair), sha256: b.sha256 };
      }
      if (bytesStop(bytesSeen([hash, ...(bundle ? [bundle.sha256] : [])], false))) continue;
      // It names a ready card of this product, or it goes no further (R-0b-129), after the duplicate-bytes check so
      // bytes another product handed in are told as that first.
      const named = proposalCardProblem(rec, product, card);
      if (named?.refuse) { refuse(named.refuse, hash, { card_key: named.key }); continue; }
      if (named?.broke) { waitOn(named.broke, hash); continue; }
      if (stageOf(rules, product) !== 'second') {
        if (typeof docsCheck !== 'function') { refuse(`${FIRST_CUTOVER} (A docs proposal is taken in once the docs check on the push script's changed files is wired: R-0b-128 part 2.)`, hash); continue; }
        if (!bundle) { refuse(`no ${pair} carries this proposal's change`, hash, { bundle_key: null }); continue; }
        let docs;
        // A check that throws has said nothing about the change: the file waits, never passes, never ends (L597 (2)).
        try { docs = await docsCheck({ product, card, bundle }); } catch (e) { docs = { retry: `the docs check failed: ${plainError(e?.message ?? e)}` }; }
        // Only null passes. The reasons quote names from inside the bundle, which its proposer wrote: they reach the
        // alert, the diary and the record only fenced, masked, on one line (R-0b-126; L597 (3)).
        if (docs !== null) {
          const extra = { bundle_key: bundle.sha256 };
          // A look that couldn't finish, or any cause that may pass by itself: the file waits, and Joe is told (L325 m2).
          if (typeof docs === 'object' && docs && Object.hasOwn(docs, 'retry')) { waitOn(shownName(textOr(docs.retry, 'the docs check could not finish')), hash); continue; }
          if (typeof docs === 'object' && docs && Object.hasOwn(docs, 'refuse')) { refuse(`its ${pair} was refused by the push script's check: ${shownName(textOr(docs.refuse, 'no reason given'))}`, hash, extra); continue; }
          // An answer that is no reason says nothing about the change: never a pass, never final (L669 minor).
          if (typeof docs !== 'string' || !docs) { waitOn(shownName('the docs check gave no answer'), hash); continue; }
          // Not the docs lane's: the reason may come from the card (its tier, a label), so a changed card is looked at again.
          refuse(`${FIRST_CUTOVER} (${shownName(docs)})`, hash, { ...extra, card_key: proposalCardKey(rec, card) }); continue;
        }
      }
      if (typeof toReview !== 'function') { refuse('a proposal\'s route to review is not wired in yet (R-0b-162)', hash); continue; }
      useBundle = bundle?.sha256 ?? null;
      use = () => toReview({ rec, product, card, cardRev, proposal: fenceFor('proposal', file.text).fenced, bundle });
    } else {
      const h = handlers[parsed.kind];
      if (typeof h !== 'function') { r.waiting = `no ${parsed.kind} handler yet`; waiting.get(product)?.add(parsed.kind); continue; }
      use = () => h({ rec, product, kind: parsed.kind, id: parsed.id, name, ...fenceFor(parsed.kind, file.text), sha256: hash, blob: file.blob, size: file.size, now });
    }
    // Bytes any other product already handed in never reach this one's handlers, whatever happened to the folders
    // (L279: three misses telling folders apart, MAT-B, C, D). Checked across all products by sha256, the bundle's too
    // when one goes with a proposal, and recorded before the claim. A check that can't be read or written keeps the file
    // unused this pass and is told once (fail closed). A heartbeat is a poll: the same bytes come again by design.
    if (parsed.kind === 'proposal') {
      // The card again, after the docs check's wait (#159 audit Minor 1): it may have changed meanwhile.
      const again = proposalCardProblem(rec, product, parsed.id);
      if (again.refuse) { refuse(again.refuse, hash, { card_key: again.key }); continue; }
      if (again.broke) { waitOn(again.broke, hash); continue; }
      cardRev = again.rev;
    }
    if (parsed.kind !== 'heartbeat' && bytesStop(bytesSeen([hash, ...(useBundle ? [useBundle] : [])], true))) continue;
    // Claim first, so a crash after the hand-over cannot use the file twice.
    const claim = put({ sha256: hash, state: 'applying', at: new Date(now).toISOString() }, 'proposal_claim');
    if (!claim.ok) { r.refused = `could not record the intake: ${plainError(String(claim.reason))}`; tellUnrecorded(`the intake of ${shown} from ${product}'s proposals folder could not be recorded (${plainError(String(claim.reason))}); it was not used`, `claim ${hash}`); continue; }
    let done;
    try { done = await use(); } catch (e) { done = { ok: false, reason: e.message }; }
    if (done?.ok) {
      r.applied = true;
      // The mark's answer is read (L736 m3): refused, the file was still used, so that goes on the bytes' own fact and
      // the next pass marks it then; said in this pass's lines, never left to read as an interruption.
      const m = put({ sha256: hash, state: 'applied', applied_at: new Date(now).toISOString() }, 'proposal_applied');
      if (!m.ok) {
        const why = plainError(String(m.reason));
        const kept = parsed.kind !== 'heartbeat' && noteUsed(hash);
        r.unmarked = `used, but it could not be marked applied (${why}); ${kept ? 'the mark is tried again next pass' : 'that could not be noted either, so the next pass says it was interrupted'}`;
        note(`proposals ${product}: ${shown}: ${r.unmarked}`);
      }
    } else refuse(done?.reason ?? 'no answer', hash, parsed.kind === 'proposal' ? { card_key: proposalCardKey(rec, parsed.id) } : null);
  }
  // Files of a kind nothing takes in yet sit in the folder: told once per product and kind, and cleared when none wait.
  for (const [product, kinds] of waiting) {
    if (out.some((r) => r.product === product && r.skipped)) continue;
    for (const kind of Object.keys(HANDLER_ROW)) {
      const why = kinds.has(kind) ? `${kind} files aren't taken in yet (${HANDLER_ROW[kind]})` : null;
      tellCause(rec, waitingFactId(product, kind), { product, kind }, why, `${product}'s proposals folder: ${why}`, alert, now);
    }
  }
  endWaits(rec, folders, rows, waitingOn, now);
  return out;
}

// A wait (waitOn) ends when its file has gone from a folder this pass read, or had any outcome but a wait: its queued
// tell is dropped and its start and told mark go, so a wait that comes back is told afresh (stillWaiting's rule).
// A file still waiting for another reason (being written, its bundle not taken in yet) keeps its wait as it is.
const RETRY_PREFIX = 'intake-applied-proposals-retry-';
// Between a wait's start and its cause's short hash in the key stillWaiting compares (ISO time text holds no '|').
const WAIT_KEY_SEP = '|';
function endWaits(rec, folders, rows, waitingOn, now) {
  const read = new Set(folders.filter((f) => !f.why).map((f) => f.product));
  let facts;
  try { facts = rec.list('fact'); } catch { return; }
  for (const f of facts) {
    const d = f.doc;
    if (typeof f?.id !== 'string' || !f.id.startsWith(RETRY_PREFIX) || !d || !read.has(d.product) || typeof d.name !== 'string' || f.id !== retryFactId(d.product, d.name)) continue;
    const key = `${d.product}/${d.name}`;
    if (waitingOn.has(key) || rows.get(key)?.waiting || d.waiting_since === undefined) continue;
    // Its told mark's cause goes with the wait, so a late mark can't outlive it (the r7 M2 sweep).
    if (!dropCause(rec, retryFactId(d.product, d.name))) continue;
    putWait(rec, f.id, f.rev ?? 0, { product: d.product, name: d.name, why: null, ended_at: new Date(now).toISOString() });
  }
}

// An object as read from the Record, or {} for anything else (an array, text, null).
const plainObject = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

// A proposal's wait fact (retryFactId): its cause and since while it waits, or its end. One write site for both.
function putWait(rec, id, expectRev, doc) {
  return rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev, doc, kind: 'proposal_wait' });
}

// The bytes a fact says were used, or may have been (applied, interrupted), with those it carried. A claim still out
// (applying) is not listed: the pass turns it into interrupted before anything reads this.
const USED_STATES = ['applied', 'interrupted'];
const USED_MAX = 50;
function usedOf(d) {
  const list = Array.isArray(d?.used) ? d.used.filter((x) => typeof x === 'string') : [];
  if (d && USED_STATES.includes(d.state) && typeof d.sha256 === 'string' && !list.includes(d.sha256)) list.push(d.sha256);
  return list.slice(-USED_MAX);
}

// An interruption whose told mark is not written: its text and key, or nothing (L268 MAT-A). Every write of the fact
// carries it until the mark lands, whatever the state becomes.
function untoldOf(d) {
  if (typeof d?.interrupted_key !== 'string' || typeof d.interrupted_text !== 'string' || d.told_interrupted === d.interrupted_key) return {};
  return { interrupted_text: d.interrupted_text, interrupted_key: d.interrupted_key };
}

// A cause (a folder problem, or a kind with nothing to take it in) is told when it starts or changes, and its end is
// recorded; never every pass.
// A tell that was lost (the queue write refused, or the cap dropped it) is asked again each pass until its told mark,
// `told_why`, is written (L260 MAT-2): `why` is written before the send, so it alone can't say the cause was told.
function tellCause(rec, causeFact, doc, why, said, alert, now) {
  const prev = rec.read('fact', causeFact);
  if ((why ?? null) === (prev?.doc?.why ?? null)) {
    if (!why || prev.doc.told_why === why || isQueued(rec, causeFact)) return undefined;
    return tellThen(alert, said, { fact: causeFact, fields: { told_why: why }, kind: 'proposal_told' });
  }
  const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: causeFact, expectRev: prev?.rev ?? 0, doc: { ...doc, why: why ?? null, at: new Date(now).toISOString() }, kind: 'proposal_cause' });
  // The cause cleared: a tell still queued for it leaves unsent (the r7 M2 rule).
  if (!why) return dropCause(rec, causeFact) ? undefined : alert(`the queued alert for ${causeFact} could not be dropped`);
  // The alert's answer goes back as it is (false when it was lost); nothing to tell answers undefined.
  if (!w.ok) return alert(said);
  return tellThen(alert, said, { fact: causeFact, fields: { told_why: why }, kind: 'proposal_told' });
}

// Each pass, before any folder is read: a file's refusal or interruption, recorded with its text, whose told mark is not
// written and that is not queued, is told again (L260 MAT-1; outbox-intake's retellHandIns, L130 M7 M8, for these ids).
const FILE_PREFIX = 'intake-applied-proposals-file-';
function retellFiles(rec, alert, products) {
  let facts;
  try { facts = rec.list('fact'); } catch { return; }
  for (const f of facts) {
    const d = f.doc;
    if (typeof f?.id !== 'string' || !f.id.startsWith(FILE_PREFIX) || !d || !products.includes(d.product) || f.id !== intakeFactId(d.product, d.name)) continue;
    if (isQueued(rec, f.id)) continue;
    const u = untoldOf(d);
    if (u.interrupted_key) tellThen(alert, u.interrupted_text, { fact: intakeFactId(d.product, d.name), fields: { told_interrupted: u.interrupted_key }, kind: 'proposal_told' });
    if (d.refused_key && d.refused_text && d.told_key !== d.refused_key) tellThen(alert, d.refused_text, { fact: intakeFactId(d.product, d.name), fields: { told_key: d.refused_key }, kind: 'proposal_told' });
  }
}

/**
 * Joe's setup batch reads this back after making a product's folder (R-0b-128): Joe owns it with mode 0750 or tighter;
 * `orchestrate` can read and can't write; `review` can't read; the deny is in a rendered worker settings file.
 * `canRead(user, dir)` and `canWrite(user, dir)` run as that user on the Mini (the batch's `sudo -u <user> test`), and
 * an answer that isn't true or false counts as the unsafe one. `settings` is a rendered worker settings object.
 * → [] | every problem.
 */
export function proposalsReadBack({ dir, ownerUid, canRead, canWrite, settings, look = lstatSync }) {
  const out = [];
  const f = folderProblem(dir, ownerUid, look);
  if (f) out.push(f);
  const ask = (fn, user) => { try { const v = fn(user, dir); return v === true || v === false ? v : null; } catch { return null; } };
  if (ask(canRead, 'orchestrate') !== true) out.push('orchestrate can\'t read the proposals folder');
  if (ask(canWrite, 'orchestrate') !== false) out.push('orchestrate can write the proposals folder');
  if (ask(canRead, 'review') !== false) out.push('review can read the proposals folder');
  const rule = `Read(//${String(dir).replace(/^\/+/, '')}/**)`;
  const deny = settings?.permissions?.deny;
  if (!Array.isArray(deny) || !deny.includes(rule)) out.push(`the rendered worker settings do not deny ${rule}`);
  return out;
}
