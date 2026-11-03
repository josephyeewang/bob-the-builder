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
// text and told once; a refused file is not looked at again until its bytes change. outbox-intake's retell finds a
// refusal whose tell was not queued by the same `session`/`name` shape.
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
//   intakeProposals({ rec, rules, products, ownerUid, wait, alert, note, handlers, docsCheck, toReview, now }) → [result]
//   proposalsReadBack({ dir, ownerUid, canRead, canWrite, settings }) → [] | every problem (Joe's setup batch)

import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants as C } from 'node:fs';
import { join } from 'node:path';
import { KEYS, need } from './keys.mjs';
import { tellThen, dropCause, isQueued } from './alerts.mjs';
import { BUNDLE_CAP } from '../M4-workshop/git/push.mjs';

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
const PLAIN_DIR = /^\/[A-Za-z0-9._/-]+$/;

/** The kind and id a name stands for, or null. */
export function proposalName(name) {
  for (const [kind, re] of Object.entries(NAMES)) { const m = re.exec(name); if (m) return { kind, id: m[1] }; }
  return null;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const sourceOf = (product) => `proposals-${product}`;
/** The fact a file's intake is kept in: the name itself when it makes a legal id, else a hash of the name. */
export function intakeFactId(product, name) {
  const id = `intake-applied-${sourceOf(product)}-${name}`;
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && id.length <= 200 ? id : `intake-applied-${sourceOf(product)}-name-${sha256(name).slice(0, 16)}`;
}
/** The fact a product's folder problem is kept in. */
export const folderFactId = (product) => `intake-applied-${sourceOf(product)}`;

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
  let fd;
  try { fd = fs.openSync(join(dir, name), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch { return { ok: false, reason: `"${name}" could not be opened without following a link` }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: `"${name}" is not a plain file` };
    if (st.nlink !== 1) return { ok: false, reason: `"${name}" has more than one link` };
    if (st.uid !== ownerUid) return { ok: false, reason: `"${name}" is owned by user ${st.uid}, not the owner's user` };
    if (st.size > cap) return { ok: false, reason: `"${name}" is larger than ${cap} bytes` };
    const h = createHash('sha256');
    const keep = kind === 'bundle' ? null : [];
    const buf = Buffer.alloc(1 << 20);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      total += n;
      if (total > cap) return { ok: false, reason: `"${name}" is larger than ${cap} bytes` };
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
 * `handlers`: { research, claim, heartbeat }, each ({ rec, product, kind, id, name, text, sha256 }) → { ok, reason? }.
 * `docsCheck({ product, card, bundle })` → null | reason, and `toReview({ rec, product, card, proposal, bundle })` → { ok, reason? }:
 *   part 2's; not passed in, every proposal is refused.
 * Returns what happened to each file.
 */
export async function intakeProposals({ rec, rules, products, ownerUid, wait, alert, note = () => {}, handlers = {}, docsCheck, toReview,
  now = Date.now(), list = (d) => readdirSync(d), look = statOf, lookDir = lstatSync, fs }) {
  if (!Number.isInteger(ownerUid) || ownerUid <= 0) throw new Error('intakeProposals: ownerUid must be the owner\'s uid from the config');
  const out = [];
  const seen = [];
  for (const product of products) {
    let dir;
    let why = null;
    // A product with no proposals.outbox has no folder: a quiet skip. A value that is there but is not text is a
    // folder that is never read, so it is told like any other folder problem (lane 2's #124 review, Material).
    try { dir = need(rules, KEYS.proposalsOutbox, { product, type: 'text' }); } catch {
      let raw;
      try { raw = rules.get(KEYS.proposalsOutbox, { product }); } catch { raw = null; }
      if (raw === undefined) { out.push({ product, skipped: 'no proposals.outbox in the rules' }); continue; }
      why = 'proposals.outbox is set but is not a folder path';
    }
    if (!why) why = folderProblem(dir, ownerUid, lookDir);
    let names = null;
    if (!why) { try { names = list(dir); } catch { why = 'the proposals folder could not be read'; } }
    tellFolder(rec, product, why, alert, now);
    if (why) { out.push({ product, skipped: why }); continue; }
    names = names.filter((n) => !n.startsWith('.'));
    for (const name of names) seen.push({ product, dir, name, names, first: look(join(dir, name)) });
  }
  if (seen.length) await wait(SETTLE_MS);
  for (const { product, dir, name, names, first } of seen) {
    const r = { product, name };
    out.push(r);
    if (first === null || look(join(dir, name)) !== first) { r.waiting = 'still being written'; continue; }
    const id = intakeFactId(product, name);
    let prev = rec.read('fact', id);
    const put = (doc, kind) => {
      const w = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: prev?.rev ?? 0, doc: { session: sourceOf(product), product, name, ...doc }, kind });
      if (w.ok) prev = rec.read('fact', id);
      return w;
    };
    // A refusal is recorded once per reason and bytes, and told once (not every pass while the file sits there).
    const refuse = (reason, hash = null) => {
      r.refused = reason;
      if (prev?.doc?.state === 'refused' && prev.doc.why === reason && prev.doc.sha256 === hash) return;
      const said = `a file in ${product}'s proposals folder was refused: ${reason}`;
      note(`proposals ${product}: ${name} refused: ${reason}`);
      const w = put({ sha256: hash, state: 'refused', why: reason, at: new Date(now).toISOString(), alert_text: said }, 'proposal_refused');
      if (w.ok) tellThen(alert, said, { fact: intakeFactId(product, name), fields: { told_state: 'refused' }, kind: 'proposal_told' });
      else alert(said);
    };
    const parsed = proposalName(name);
    if (!parsed) { refuse(name.startsWith('verdict-') ? `"${name}": a verdict comes only from a review session's own outbox` : `"${name}" is not a proposals file name`); continue; }
    r.kind = parsed.kind;
    const file = readProposalFile(dir, name, { ownerUid, kind: parsed.kind, ...(fs ? { fs } : {}) });
    if (!file.ok) { refuse(file.reason); continue; }
    const hash = file.sha256;
    if (prev?.doc?.state === 'applying' && parsed.kind !== 'heartbeat') {
      // A pass that stopped between its claim and the hand-over (outbox-intake's MAT-7): whether the file was used is
      // not known, so it is never used twice. Told once. A heartbeat is a poll, so it is simply taken again.
      const said = `the intake of ${name} from ${product}'s proposals folder was interrupted; it may or may not have been used, and was not used again`;
      const w = put({ ...prev.doc, state: 'interrupted', at: new Date(now).toISOString(), alert_text: said }, 'proposal_interrupted');
      if (!w.ok) { r.refused = `could not record the interruption: ${w.reason}`; alert(said); continue; }
      tellThen(alert, said, { fact: intakeFactId(product, name), fields: { told_state: 'interrupted' }, kind: 'proposal_told' });
    }
    if (prev && prev.doc?.sha256 != null) {
      const was = prev.doc.state;
      if (prev.doc.sha256 === hash && ['applied', 'interrupted'].includes(was)) { r.already = true; continue; }
      if (prev.doc.sha256 === hash && was === 'refused') { r.refused = prev.doc.why; continue; }
      // L78 n2: a heartbeat's new bytes are a new poll. Every other kind: new bytes on a used name are refused.
      if (prev.doc.sha256 !== hash && parsed.kind !== 'heartbeat' && !['refused', 'interrupted'].includes(was)) {
        r.refused = 'the same name with new content';
        // Told once for these bytes: the mark lands when the alert is sent, and one still waiting is not queued again.
        if (prev.doc.told_new !== hash && !isQueued(rec, intakeFactId(product, name))) {
          const said = `${name} in ${product}'s proposals folder was written again with different content; the second copy was not used`;
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
      r.held = `taken in with ${pair}`;
      continue;
    }
    if (parsed.kind === 'proposal') {
      const card = parsed.id;
      const pair = `bundle-${card}.bundle`;
      if (stageOf(rules, product) !== 'second') {
        if (typeof docsCheck !== 'function') { refuse(`${FIRST_CUTOVER} (A docs proposal is taken in once the docs check on the push script's changed files is wired: R-0b-128 part 2.)`, hash); continue; }
        if (!names.includes(pair)) { refuse(`no ${pair} carries this proposal's change`, hash); continue; }
        let docs;
        try { docs = await docsCheck({ product, card, bundle: join(dir, pair) }); } catch (e) { docs = `the docs check failed: ${e.message}`; }
        if (docs) { refuse(`${FIRST_CUTOVER} (${docs})`, hash); continue; }
      }
      if (typeof toReview !== 'function') { refuse('a proposal\'s route to review is not built yet (R-0b-128 part 2)', hash); continue; }
      use = () => toReview({ rec, product, card, proposal: file.text, bundle: names.includes(pair) ? join(dir, pair) : null });
    } else {
      const h = handlers[parsed.kind];
      if (typeof h !== 'function') { r.waiting = `no ${parsed.kind} handler yet`; continue; }
      use = () => h({ rec, product, kind: parsed.kind, id: parsed.id, name, text: file.text, sha256: hash });
    }
    // Claim first, so a crash after the hand-over cannot use the file twice.
    const claim = put({ sha256: hash, state: 'applying', at: new Date(now).toISOString() }, 'proposal_claim');
    if (!claim.ok) { r.refused = `could not record the intake: ${claim.reason}`; continue; }
    let done;
    try { done = await use(); } catch (e) { done = { ok: false, reason: e.message }; }
    if (done?.ok) {
      put({ sha256: hash, state: 'applied', applied_at: new Date(now).toISOString() }, 'proposal_applied');
      r.applied = true;
    } else refuse(done?.reason ?? 'no answer', hash);
  }
  return out;
}

// A folder problem is told when it starts or changes, and its end is recorded; never every pass.
function tellFolder(rec, product, why, alert, now) {
  const id = folderFactId(product);
  const prev = rec.read('fact', id);
  if ((why ?? null) === (prev?.doc?.why ?? null)) return undefined;
  const w = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: prev?.rev ?? 0, doc: { product, folder: true, why: why ?? null, at: new Date(now).toISOString() }, kind: 'proposal_folder' });
  // The problem cleared: a tell still queued for it leaves unsent (the r7 M2 rule).
  if (!why) { dropCause(rec, folderFactId(product)); return undefined; }
  const said = `${product}'s proposals folder is not taken in: ${why}`;
  // The alert's answer goes back as it is (false when it was lost); nothing to tell answers undefined.
  if (!w.ok) return alert(said);
  return tellThen(alert, said, { fact: folderFactId(product), fields: { told_why: why }, kind: 'proposal_told' });
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
