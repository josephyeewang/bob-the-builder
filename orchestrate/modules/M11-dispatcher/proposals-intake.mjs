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
// rules give it a new folder, so files the first used are never taken in again (L268 MAT-B). An interruption whose
// tell was lost is carried by every later write of the file's fact, so a claim or refusal never hides it (L268 MAT-A).
// A file name goes into an alert or the diary only fenced (`shownName`: one line, stripped, masked; R-0b-126, probe P7).
//
// Day 1 (`product.cutover_stage` first; L76 (5)):
//   - research-, claim- and heartbeat- files go to their handlers (R-0b-135, R-0b-130, R-0b-131);
//   - idea- files are refused: idea filing stays off until #95-b lands (L212, L215 2);
//   - a proposal goes to the docs-lane check, run on the push script's real changed files for its bundle's net change
//     (L77 m1). That check is part 2, after R-0b-127; until it is passed in as `docsCheck`, every proposal is refused
//     with FIRST_CUTOVER before any review starts, which fails closed. A bundle is taken in only with its proposal.
// At the second cutover a proposal goes to review (`toReview`, M5), also part 2; until it is passed in, refused.
// A kind whose handler is not passed in is left untouched and unrecorded, so it is taken in once the handler lands.
//
//   proposalsPass({ rec, rules, products, ownerUid, wait, alert, note, handlers, docsCheck, toReview, now }) → [result]
//   proposalsReadBack({ dir, ownerUid, canRead, canWrite, settings }) → [] | every problem (Joe's setup batch)

import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants as C } from 'node:fs';
import { join } from 'node:path';
import { KEYS, need } from './keys.mjs';
import { tellThen, dropCause, isQueued } from './alerts.mjs';
import { sha256 } from './outbox-intake.mjs';
import { BUNDLE_CAP } from '../M4-workshop/git/push.mjs';
import { cleanOutside, SOURCES } from '../M12-sensors/escape.mjs';

export const FIRST_CUTOVER = 'First cutover: MAIN merges code by hand.';
export const IDEAS_OFF = 'idea filing is off until #95-b lands (L212, L215)';
export const TEXT_CAP = 1024 * 1024;
export const SETTLE_MS = 2000;
// A bundle with no proposal is waited for this long (by its own write time), then refused.
export const BUNDLE_ALONE_MS = 10 * 60_000;

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
/** The fenced copy of a file's text, with its kind's own source; throws for a kind with none, or one that is bytes. */
/** A file name as alert text shows it: one line, stripped, masked and fenced (R-0b-126, probe P7). */
export const shownName = (name) => cleanOutside(name, 'proposal-name');
export function fenceFor(kind, text) {
  const source = Object.hasOwn(SOURCE_OF, kind) ? SOURCE_OF[kind] : null;
  if (!source || source === BYTES || !SOURCES.includes(source)) throw new Error(`no outside-text source for a ${kind} file`);
  return { source, fenced: cleanOutside(text, source) };
}
const PLAIN_DIR = /^\/[A-Za-z0-9._/-]+$/;

/** The kind and id a name stands for, or null. */
export function proposalName(name) {
  for (const [kind, re] of Object.entries(NAMES)) { const m = re.exec(name); if (m) return { kind, id: m[1] }; }
  return null;
}

export const sourceOf = (product) => `proposals-${product}`;
// Fact ids (L233 M-4): a product name may hold a hyphen, so `a` + `b-x.md` and `a-b` + `x.md` must not share one. Each
// id is its role plus a hash of its parts, each part length-prefixed, so no two different pairs, and no file and
// folder, can meet.
const idHash = (...parts) => sha256(parts.map((p) => `${String(p).length}:${p}`).join('|')).slice(0, 32);
/** The fact a file's intake is kept in. */
export const intakeFactId = (product, name) => `intake-applied-proposals-file-${idHash(product, name)}`;
/** The fact a product's folder problem is kept in. */
export const folderFactId = (product) => `intake-applied-proposals-folder-${idHash(product)}`;
/** The fact that says files of `kind` sit in a product's folder with nothing to take them in yet. */
export const waitingFactId = (product, kind) => `intake-applied-proposals-waiting-${idHash(product, kind)}`;
/** The fact that says which product first took files in from a folder, by its device and file number (L268 MAT-B). */
export const ownerFactId = (dev, ino) => `intake-applied-proposals-owner-${idHash(dev, ino)}`;
/** The fact a tell is marked on when the record refused the file's own fact (told once, not every pass). */
export const toldFactId = (product, name) => `intake-applied-proposals-told-${idHash(product, name)}`;
// The row that will take each handed-on kind in (L233 M-2: until then, told once per product and kind).
export const HANDLER_ROW = Object.freeze({ research: 'R-0b-135', claim: 'R-0b-130', heartbeat: 'R-0b-131' });
// Bundles first, so a proposal's bundle is checked and recorded in the same pass before the proposal reads it.
const ORDER = (name) => (name.startsWith('bundle-') ? 0 : 1);

/** The folder's own problem, or null. `look` is lstat. */
export function folderProblem(dir, ownerUid, look = lstatSync) {
  if (typeof dir !== 'string' || !PLAIN_DIR.test(dir) || dir.split('/').includes('..')) return 'proposals.outbox is not a plain absolute folder path';
  let st; try { st = look(dir); } catch { return 'the proposals folder is missing'; }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'the proposals folder is not a plain folder';
  if (st.uid !== ownerUid) return `the proposals folder is owned by user ${st.uid}, not the owner's user`;
  if ((st.mode & 0o027) !== 0) return `the proposals folder's mode ${(st.mode & 0o777).toString(8)} is looser than 750`;
  return null;
}

/**
 * Reads one file through a handle opened without following a link. → { ok, sha256, size, text? } | { ok: false, reason }.
 * A bundle is hashed in pieces and never held as text; every other kind is text, at most TEXT_CAP bytes.
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
    return { ok: true, sha256: h.digest('hex'), size: total, ...(keep ? { text: Buffer.concat(keep).toString('utf8') } : {}) };
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
 * `handlers`: { research, claim, heartbeat }, each ({ rec, product, kind, id, name, source, fenced, sha256 }) → { ok, reason? }:
 *   `fenced` is the file's text as cleanOutside's fenced copy (R-0b-126); a handler never sees the raw text.
 * `docsCheck({ product, card, bundle })` → null | reason, and `toReview({ rec, product, card, proposal, bundle })` → { ok, reason? } (`proposal` fenced too):
 *   `bundle` is { path, sha256 }: the bytes this pass checked and recorded (L233 M-5), so part 2 checks the bytes it merges.
 *   part 2's; not passed in, every proposal is refused.
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
  // Two products whose rules name the same folder (by device and file number, so a second path to it counts too)
  // would each take every file in once: both are refused until the rules give each its own folder (L260 MAT-3).
  const byFolder = new Map();
  for (const f of folders) {
    if (f.why) continue;
    let st; try { st = lookDir(f.dir); } catch { st = null; }
    // A folder that can't be told apart from another is not read: no owner could be checked for it (L268 MAT-B).
    if (!Number.isInteger(st?.ino) || st.ino <= 0 || !Number.isInteger(st?.dev)) { f.why = 'the proposals folder could not be identified'; continue; }
    f.at = { dev: st.dev, ino: st.ino };
    const k = `${st.dev}:${st.ino}`;
    byFolder.set(k, [...(byFolder.get(k) ?? []), f]);
  }
  for (const group of byFolder.values()) {
    if (group.length < 2) continue;
    for (const f of group) f.why = `the proposals folder is also ${group.filter((g) => g !== f).map((g) => g.product).join(', ')}'s, so its files would be taken in once per product`;
  }
  // The folder's first product owns it for good (L268 MAT-B): the used memory is per product, so another product that
  // named it later would take every file the first one used in again. Recorded before any file is read; a write the
  // record refuses keeps the folder unread this pass. The cost (L268): a folder stays its first product's for good, so
  // another product needs a new folder, never a used one. And the folder is known by device and file number: a remount
  // (an external disk, a rebuilt volume) can change them, and the folder then counts as new. MAT-3 has the same limit.
  for (const f of folders) {
    if (f.why) continue;
    const id = ownerFactId(f.at.dev, f.at.ino);
    const o = rec.read('fact', id);
    const first = o?.doc?.product;
    if (first === f.product) continue;
    if (first != null) { f.why = `the proposals folder was ${first}'s first, so the files ${first} took in from it would be taken in again; give ${f.product} a new folder`; continue; }
    const w = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: o?.rev ?? 0, doc: { product: f.product, dev: f.at.dev, ino: f.at.ino, at: new Date(now).toISOString() }, kind: 'proposal_folder_owner' });
    if (!w.ok) f.why = `the proposals folder's first product could not be recorded (${w.reason})`;
  }
  for (const { product, dir, why: cause } of folders) {
    let why = cause;
    let names = null;
    if (!why) { try { names = list(dir); } catch { why = 'the proposals folder could not be read'; } }
    tellCause(rec, folderFactId(product), { product, folder: true }, why, `${product}'s proposals folder is not taken in: ${why}`, alert, now);
    if (why) { out.push({ product, skipped: why }); continue; }
    names = names.filter((n) => !n.startsWith('.')).sort((x, y) => ORDER(x) - ORDER(y));
    for (const name of names) seen.push({ product, dir, name, names, first: look(join(dir, name)) });
  }
  if (seen.length) await wait(SETTLE_MS);
  const waiting = new Map(products.map((p) => [p, new Set()]));
  const rows = new Map();
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
    // The record refused this file's own fact: the tell is marked on its told fact instead, so it is told once per
    // cause, not every pass (L233 M-3, m4).
    const tellUnrecorded = (said, key) => {
      note(`proposals ${product}: ${shown}: ${said}`);
      if (rec.read('fact', toldFactId(product, name))?.doc?.told === key || isQueued(rec, toldFactId(product, name))) return undefined;
      return tellThen(alert, said, { fact: toldFactId(product, name), fields: { told: key }, kind: 'proposal_told' });
    };
    // A refusal is recorded once per reason and bytes, and told once (not every pass while the file sits there).
    // A refusal with no bytes to name (a bad name, too big, a link, another owner) never erases a recorded state (L254):
    // it is added beside it, so a used file's "already used" still holds when its bytes come back.
    // Told once per reason and file: the bytes' hash, or for a file never read, its size, change time and file number
    // (L259). A new file refused for the same reason is a new request, and told again; one sitting there is not.
    const refuse = (reason, hash = null) => {
      r.refused = reason;
      const told = `${reason}\n${hash ?? first}`;
      const keep = hash === null && prev?.doc?.sha256 != null && prev.doc.state !== 'refused';
      if ((keep || prev?.doc?.state === 'refused') && prev.doc.refused_key === told) return;
      const said = `${shown} in ${product}'s proposals folder was refused: ${reason}`;
      note(`proposals ${product}: ${shown} refused: ${reason}`);
      const at = new Date(now).toISOString();
      // Its own text and key, apart from an interruption's, so each is told again until delivered (L260 MAT-1).
      const w = put(keep ? { ...prev.doc, refused_why: reason, refused_at: at, refused_key: told, refused_text: said } : { sha256: hash, state: 'refused', why: reason, at, refused_key: told, refused_text: said }, 'proposal_refused');
      if (w.ok) tellThen(alert, said, { fact: intakeFactId(product, name), fields: { told_key: told }, kind: 'proposal_told' });
      else tellUnrecorded(said, `refused ${told}`);
    };
    const parsed = proposalName(name);
    if (!parsed) { refuse(name.startsWith('verdict-') ? 'a verdict comes only from a review session\'s own outbox' : 'it is not a proposals file name'); continue; }
    r.kind = parsed.kind;
    const file = readProposalFile(dir, name, { ownerUid, kind: parsed.kind, ...(fs ? { fs } : {}) });
    if (!file.ok) { refuse(file.reason); continue; }
    const hash = file.sha256;
    if (prev?.doc?.state === 'applying' && parsed.kind !== 'heartbeat') {
      // A pass that stopped between its claim and the hand-over (outbox-intake's MAT-7): whether the file was used is
      // not known, so it is never used twice. Told once. A heartbeat is a poll, so it is simply taken again.
      const said = `the intake of ${shown} from ${product}'s proposals folder was interrupted; it may or may not have been used, and was not used again`;
      // Keyed on the interrupted bytes; one still untold from before is told in the same alert (L268 MAT-A). A claim
      // never carries a told mark, so the key need only differ from the mark this fact holds now.
      const old = untoldOf(prev.doc);
      const key = String(prev.doc.sha256);
      const text = old.interrupted_text ? `${old.interrupted_text}; ${said}` : said;
      const w = put({ ...prev.doc, state: 'interrupted', at: new Date(now).toISOString(), interrupted_text: text, interrupted_key: key }, 'proposal_interrupted');
      if (!w.ok) { r.refused = `could not record the interruption: ${w.reason}`; tellUnrecorded(said, `interrupted ${prev.doc.sha256}`); continue; }
      tellThen(alert, text, { fact: intakeFactId(product, name), fields: { told_interrupted: key }, kind: 'proposal_told' });
    }
    // Bytes this name used, or may have, before: never again, whatever the fact says now (L254). A heartbeat is a poll.
    if (parsed.kind !== 'heartbeat' && usedOf(prev?.doc).includes(hash)) { r.already = true; continue; }
    if (prev && prev.doc?.sha256 != null) {
      const was = prev.doc.state;
      if (prev.doc.sha256 === hash && ['applied', 'interrupted'].includes(was)) { r.already = true; continue; }
      if (prev.doc.sha256 === hash && was === 'refused') { r.refused = prev.doc.why; continue; }
      // L78 n2: a heartbeat's new bytes are a new poll. Every other kind: new bytes on a used name are refused.
      if (prev.doc.sha256 !== hash && parsed.kind !== 'heartbeat' && !['refused', 'interrupted'].includes(was)) {
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
    if (parsed.kind === 'idea') { refuse(IDEAS_OFF, hash); continue; }
    if (parsed.kind === 'bundle') {
      const pair = `proposal-${parsed.id}.md`;
      if (!names.includes(pair)) {
        // Its proposal may still be on the way (lane 2's #124 review, m3): wait, unrecorded, while the bundle is young.
        const mtime = Number(String(first).split(':')[1]);
        if (now - mtime < BUNDLE_ALONE_MS) { r.waiting = `waiting for ${pair}`; continue; }
        refuse(`no ${pair} names this bundle's card`, hash); continue;
      }
      // Recorded, so new bytes under its name are refused and told like any other kind's (L233 M-5).
      if (!(prev?.doc?.state === 'held' && prev.doc.sha256 === hash)) {
        const w = put({ sha256: hash, state: 'held', at: new Date(now).toISOString() }, 'proposal_bundle');
        if (!w.ok) { r.refused = `could not record the bundle: ${w.reason}`; tellUnrecorded(`${shown} in ${product}'s proposals folder could not be recorded (${w.reason}); its proposal waits`, `bundle ${hash}`); continue; }
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
        if (bundleRow?.refused || ['refused', 'interrupted'].includes(b?.state)) { refuse(`its ${pair} was refused`, hash); continue; }
        if (!bundleRow?.held || b?.state !== 'held') { r.waiting = `waiting for ${pair} to be taken in`; continue; }
        bundle = { path: join(dir, pair), sha256: b.sha256 };
      }
      if (stageOf(rules, product) !== 'second') {
        if (typeof docsCheck !== 'function') { refuse(`${FIRST_CUTOVER} (A docs proposal is taken in once the docs check on the push script's changed files is wired: R-0b-128 part 2.)`, hash); continue; }
        if (!bundle) { refuse(`no ${pair} carries this proposal's change`, hash); continue; }
        let docs;
        try { docs = await docsCheck({ product, card, bundle }); } catch (e) { docs = `the docs check failed: ${e.message}`; }
        if (docs) { refuse(`${FIRST_CUTOVER} (${docs})`, hash); continue; }
      }
      if (typeof toReview !== 'function') { refuse('a proposal\'s route to review is not built yet (R-0b-128 part 2)', hash); continue; }
      use = () => toReview({ rec, product, card, proposal: fenceFor('proposal', file.text).fenced, bundle });
    } else {
      const h = handlers[parsed.kind];
      if (typeof h !== 'function') { r.waiting = `no ${parsed.kind} handler yet`; waiting.get(product)?.add(parsed.kind); continue; }
      use = () => h({ rec, product, kind: parsed.kind, id: parsed.id, name, ...fenceFor(parsed.kind, file.text), sha256: hash });
    }
    // Claim first, so a crash after the hand-over cannot use the file twice.
    const claim = put({ sha256: hash, state: 'applying', at: new Date(now).toISOString() }, 'proposal_claim');
    if (!claim.ok) { r.refused = `could not record the intake: ${claim.reason}`; tellUnrecorded(`the intake of ${shown} from ${product}'s proposals folder could not be recorded (${claim.reason}); it was not used`, `claim ${hash}`); continue; }
    let done;
    try { done = await use(); } catch (e) { done = { ok: false, reason: e.message }; }
    if (done?.ok) {
      put({ sha256: hash, state: 'applied', applied_at: new Date(now).toISOString() }, 'proposal_applied');
      r.applied = true;
    } else refuse(done?.reason ?? 'no answer', hash);
  }
  // Files of a kind nothing takes in yet sit in the folder: told once per product and kind, and cleared when none wait.
  for (const [product, kinds] of waiting) {
    if (out.some((r) => r.product === product && r.skipped)) continue;
    for (const kind of Object.keys(HANDLER_ROW)) {
      const why = kinds.has(kind) ? `${kind} files aren't taken in yet (${HANDLER_ROW[kind]})` : null;
      tellCause(rec, waitingFactId(product, kind), { product, kind }, why, `${product}'s proposals folder: ${why}`, alert, now);
    }
  }
  return out;
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
  if (!why) { dropCause(rec, causeFact); return undefined; }
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
    if (!f.id.startsWith(FILE_PREFIX) || !d || !products.includes(d.product) || f.id !== intakeFactId(d.product, d.name)) continue;
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
