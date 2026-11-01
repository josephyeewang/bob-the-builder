// Cleaning up a worker's copy after its card is done (R-0b-57; review 0b-6 M12, m15).
//
// The Merge Gate always squash-merges, so "the branch head is on main" proves nothing. A copy is
// deleted only when all five hold:
//   (a) the record's merge attempt (M6's merge document) has an audit result (audited_ok or audit_flagged,
//       m15), names a merge_commit, and Sensors' PR fact agrees;
//   (b) that commit is on the mirror's main;
//   (c) a fresh "save unsaved work" bundle, written inside the lock-down just now, has its head
//       equal to the attempt's judged_head (no extra commit), and the copy's files match that head's
//       tree (no uncommitted edit);
//   (d) the bundle carries only refs/heads/<card branch>;
//   (e) the folder is this card's copy.
// Not proven -> the bundle is sealed (moved to an orchestrate-owned folder, read-only, sha256 in the
// record) and rules.may('delete_copy') gives an ask, made by M2 (createAsk: only approvals writes asks, L74) as a
// yes/no tap with purpose delete_copy (Yes = delete). Still in flight (PR open, merge not yet audited) -> the copy is
// kept, untouched.
//
// Delete is a plain folder delete. No git command here has its working folder inside a copy: the
// mirror is read with GIT_DIR set to the mirror, and the copy's files are hashed in Node. The one
// git call inside a copy is M4's save-work, which runs in the lock-down from a private folder.

import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { git as safeGit } from '../M4-workshop/git/safe-git.mjs';
import { readBundleHeader } from '../M4-workshop/git/push.mjs';
import { isProtectedName } from '../M4-workshop/launcher/worker-copy.mjs';
import { PR_FACT } from './merges.mjs';
import { note } from './moves.mjs';
import { createAsk } from '../M2-approvals/binding.mjs';
import { writeDoc } from '../M2-approvals/ask-store.mjs';
import { sensorsFact } from './sensor-facts.mjs';

export const ASK_ID = (card) => `delete-copy-${card}`;
export const CLEANUP_FACT = (card) => `cleanup-${card}`;
const AUDITED = ['audited_ok', 'audit_flagged'];
const IN_FLIGHT = ['requested', 'checking', 'merging', 'merged'];
const ENDED = ['cancelled', 'closed', 'closed_no_answer'];
const SHA = /^[0-9a-f]{40}$/;
const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const iso = (ms) => new Date(ms).toISOString();
const st = (p) => { try { return lstatSync(p); } catch { return null; } };
const inside = (root, p) => !!p && (resolve(p) === resolve(root) || resolve(p).startsWith(resolve(root) + sep));

/** The card's newest merge attempt (by the gate's requested_at, then the Record's own time), or null. */
export function latestAttempt(rec, card) {
  const mine = rec.list('merge').filter((m) => m.doc.card === card);
  const at = (m) => Date.parse(m.doc.requested_at ?? '') || Date.parse(rec.meta?.('merge', m.id)?.ts ?? '') || 0;
  mine.sort((x, y) => at(y) - at(x));
  return mine[0] ?? null;
}

// Sensors' reading of a pull request: proof only from Sensors' own family, made by Sensors (L74 addendum).
function prFact(rec, n) {
  if (n == null) return null;
  return sensorsFact(rec, PR_FACT(n), 'pr-')?.doc ?? null;
}
// The card's newest delete-copy ask: a yes/no ask M2 made for this purpose (its id delete-copy-<card>[-n]).
function copyAsks(rec, card) {
  return rec.list('ask').filter((a) => (a.id === ASK_ID(card) || a.id.startsWith(`${ASK_ID(card)}-`)) && a.doc?.purpose === 'delete_copy' && a.doc.card === card
    && (rec.meta?.('ask', a.id)?.createdBy ?? 'approvals') === 'approvals');
}
export function copyAsk(rec, card) {
  const n = (a) => (a.id === ASK_ID(card) ? 1 : Number(a.id.slice(ASK_ID(card).length + 1)) || 0);
  return copyAsks(rec, card).sort((x, y) => n(y) - n(x))[0] ?? null;
}
function copyAskId(rec, card) {
  let i = 1;
  const taken = (id) => !!rec.read('ask', id);
  while (taken(i === 1 ? ASK_ID(card) : `${ASK_ID(card)}-${i}`)) i++;
  return i === 1 ? ASK_ID(card) : `${ASK_ID(card)}-${i}`;
}
// When the card last changed, by the Record's clock: a kept copy is asked about again only after that.
const cardChange = (rec, card) => rec.meta?.('card', card)?.ts ?? null;

/**
 * What to do with a card's copy before any bundle is made: 'keep' (still in flight), 'check'
 * (finished: bundle, prove, then delete or seal and ask) or 'ask' (finished without a merge).
 */
export function stage(rec, card) {
  const a = latestAttempt(rec, card);
  const pr = prFact(rec, a?.doc?.pr);
  if (a && AUDITED.includes(a.doc.state)) return 'check';
  if (a && IN_FLIGHT.includes(a.doc.state)) return 'keep';
  if (pr && pr.merged !== true && pr.state === 'closed') return 'ask';
  if (pr && pr.merged === true) return 'keep'; // merged on GitHub, the record not caught up yet
  if (!a && ENDED.includes(rec.read('card', card)?.doc?.state)) return 'ask';
  return 'keep';
}

// A git blob id for a file's bytes, the way git computes it (sha1 object format).
const blobId = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/** The copy's files as path -> "mode sha", hashed without git. Skips .git and Claude's own files. */
export function hashCopy(copy) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      if (!rel && name === '.git') continue;
      if (isProtectedName(name)) continue; // the launcher replaces these with main's own copies
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const s = lstatSync(abs);
      if (s.isSymbolicLink()) out.set(r, `120000 ${blobId(Buffer.from(readlinkSync(abs)))}`);
      else if (s.isDirectory()) walk(abs, r);
      else if (s.isFile()) out.set(r, `${s.mode & 0o111 ? '100755' : '100644'} ${blobId(readFileSync(abs))}`);
      else out.set(r, 'other');
    }
  };
  walk(copy, '');
  return out;
}

/** The tree at `sha` in the mirror, as path -> "mode sha". Null if the mirror lacks it. */
export async function mirrorTree(git, mirror, sha) {
  const r = await git(['ls-tree', '-r', '-z', '--full-tree', sha], { gitDir: mirror, purpose: 'cleanup-tree' });
  if (r.code !== 0) return null;
  const out = new Map();
  for (const e of r.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(e);
    if (!m) return null;
    if (m[4].split('/').some(isProtectedName)) continue;
    out.set(m[4], m[2] === 'commit' ? 'submodule' : `${m[1]} ${m[3]}`);
  }
  return out;
}

const sameFiles = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * One copy. Ports: `git` (safe-git's runner, mirror reads only), `saveWork({clone, mirror, card,
 * branch, outbox})` (M4's lock-down save-work), `alert(text)`. Returns { result, reasons }.
 * result: 'kept' | 'deleted' | 'asked' | 'refused'.
 */
export async function cleanupCopy({ rec, rules, now, card, copiesRoot, sealRoot, mirror, git = safeGit, saveWork, alert }) {
  const done = (result, reasons = []) => {
    if (result !== 'kept') note(rec, CLEANUP_FACT(card), `${result}${reasons.length ? `: ${reasons.join('; ')}` : ''}`, { now });
    return { result, reasons };
  };
  if (!CARD.test(String(card))) return done('refused', ['bad card id']);
  const copy = join(copiesRoot, card);
  const cardDoc = rec.read('card', card)?.doc;
  // The copy the record names for the card is on its newest worker launch (`copy`, from the launch port): the card
  // itself has no copy field (L72 census), so no script could write one there.
  const named = cardDoc ? { ...cardDoc, copy: namedCopy(rec, card) } : null;
  const ask = copyAsk(rec, card);

  // An ask already answered: act on Joe's answer, once. The ask is approvals' (M2): it is closed through M2's own
  // writer (L74), never written as the Dispatcher. Yes is delete.
  if (ask && ask.doc.state === 'answered') {
    const del = ask.doc.answer?.choice === 'Yes' && ask.doc.answer?.approves === true;
    const consume = (extra = {}) => writeDoc(rec, 'ask', ask, { ...ask.doc, state: 'consumed', consumed_at: iso(now), kept_at_card_change: cardChange(rec, card), ...extra });
    if (!del) { consume(); return done('kept', ['Joe said keep']); }
    // A delete needs an answer M2 counted, as the undo tap does (audit MIN-5).
    const counted = rules.may('count_approval', { ask: { id: ASK_ID(card), ...ask.doc } });
    if (counted.decision !== 'allow') return done('refused', [`the delete answer was not counted: ${counted.reason}`]);
    const own = ownCopy(copy, copiesRoot, card, named);
    consume(own.ok ? {} : { not_deleted: own.reason });
    if (!own.ok) return done('refused', [`Joe said delete, but ${own.reason}`]); // audit MIN-6
    rmSync(copy, { recursive: true, force: true });
    return done('deleted', ['Joe said delete']);
  }
  if (ask && ['open', 'pushed'].includes(ask.doc.state)) return { result: 'kept', reasons: ['waiting on the delete-copy ask'] };
  // Any answer but delete keeps it (audit 0b-6 r2 MAT-5, as the README says): the copy is left alone until
  // the card moves again (audit MAT-9), never re-asked each pass.
  if (ask && ask.doc.state === 'consumed' && ask.doc.answer?.choice !== 'Yes' && ask.doc.kept_at_card_change === cardChange(rec, card)) {
    return { result: 'kept', reasons: ['Joe said keep'] };
  }

  const what = stage(rec, card);
  if (what === 'keep') return { result: 'kept', reasons: ['the card is still in flight'] };

  // (e) first: never bundle or seal a folder that is not this card's copy.
  const own = ownCopy(copy, copiesRoot, card, named);
  if (!own.ok) return done('refused', [own.reason]);

  const branch = `card/${card.toLowerCase()}`;
  const reasons = [];
  // A fresh bundle, always, inside the lock-down; this also covers a worker that died with none.
  mkdirSync(sealRoot, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(sealRoot, `.staging-${card}-`));
  // The staging folder goes on every path, a thrown error included.
  let sealed;
  try {
  const startedAt = Date.now();
  const saved = await saveWork({ clone: copy, mirror, card, branch, outbox: staging });
  let bundle = saved?.ok ? saved.bundle : null;
  if (!bundle || !inside(staging, bundle) || !st(bundle)?.isFile()) { reasons.push(`no fresh bundle: ${saved?.reason ?? 'save-work gave none'}`); bundle = null; }
  else if (statSync(bundle).mtimeMs < startedAt - 1000) { reasons.push('the bundle is not fresh'); }

  let head = null;
  if (bundle) {
    try { head = readBundleHeader(bundle, branch); } catch (e) { reasons.push(`the bundle: ${e.message}`); } // (d)
  }
  if (what === 'ask') reasons.push('the card ended without a merge');
  else {
    const a = latestAttempt(rec, card).doc;
    const pr = prFact(rec, a.pr);
    // (a) The gate's merge document: merge_commit and the judged head (M6's names).
    if (!SHA.test(String(a.merge_commit))) reasons.push('the merge attempt names no merge commit');
    else if (pr?.merged !== true || pr.merge_commit_sha !== a.merge_commit) reasons.push('the PR fact does not agree the merge happened');
    // (b)
    else if ((await git(['merge-base', '--is-ancestor', a.merge_commit, 'refs/heads/main'], { gitDir: mirror, purpose: 'cleanup-on-main' })).code !== 0) reasons.push("the merge commit is not on the mirror's main");
    // (c)
    if (head && head !== a.judged_head) reasons.push(`the copy has commits after the merged head (${head.slice(0, 12)})`);
    else if (head) {
      const tree = await mirrorTree(git, mirror, a.judged_head);
      if (!tree) reasons.push('the merged head is not in the mirror');
      else if (!sameFiles(hashCopy(copy), tree)) reasons.push('the copy has edits that were never committed');
    }
  }

  if (!reasons.length) {
    rmSync(copy, { recursive: true, force: true });
    return done('deleted', ['proven merged on the mirror']);
  }
  sealed = bundle ? seal(bundle, sealRoot, card, now) : null;
  } finally { rmSync(staging, { recursive: true, force: true }); }
  const d = rules.may('delete_copy', { card, copy, reasons });
  if (d.decision === 'deny') {
    alert(`card ${card}: its copy could not be proven safe to delete and the rules refuse to ask (${d.reason}); it is kept`);
    return done('kept', [...reasons, `rules: ${d.reason}`]);
  }
  // Even an "allow" is never a delete here: an unproven copy is only deleted on Joe's answer. The ask is M2's (only
  // approvals writes asks, L74): a yes/no tap, Yes = delete. An ask already closed for this card is asked anew under
  // the card's next change, under the next free id (delete-copy-<card>, then -2, -3 ...).
  const w = createAsk({ record: rec, product: cardDoc?.product ?? null, now: () => now }, {
    id: copyAskId(rec, card), kind: 'tap_yes_no', card,
    title: `Delete the work copy of card ${card}? It could not be proven safe: ${reasons.join('; ')}`, tier: d.tier ?? 2,
    extra: { purpose: 'delete_copy', copy, reasons, sealed, rules_rev: d.rev ?? null } });
  if (!w.ok) return done('refused', [...reasons, `the ask was not recorded: ${w.reason}`]);
  return done('asked', reasons);
}

// The copy folder the newest worker launch for the card names, or null when no launch names one.
function namedCopy(rec, card) {
  const mine = rec.list('launch').filter((l) => l.doc?.card === card && l.doc.role === 'worker')
    .sort((a, b) => String(b.doc.launched_at ?? '').localeCompare(String(a.doc.launched_at ?? '')));
  return mine[0]?.doc?.copy ?? null;
}

/** (e) The folder is copiesRoot/<card>, a real folder, and the one the record names for the card (`named.copy`). */
export function ownCopy(copy, copiesRoot, card, named) {
  const s = st(copy);
  if (!s) return { ok: false, reason: 'no copy folder' };
  if (s.isSymbolicLink() || !s.isDirectory()) return { ok: false, reason: 'the copy is not a real folder' };
  let real;
  try { real = realpathSync(copy); } catch { return { ok: false, reason: 'the copy folder is unreadable' }; }
  if (real !== join(realpathSync(copiesRoot), card)) return { ok: false, reason: 'the copy folder is not this card\'s' };
  if (!named) return { ok: false, reason: 'the card is not in the record' };
  if (named.copy != null && resolve(named.copy) !== resolve(copy)) return { ok: false, reason: 'the record names another copy for this card' };
  return { ok: true };
}

function seal(bundle, sealRoot, card, now) {
  const dest = join(sealRoot, `${card}-${iso(now).replace(/[:.]/g, '-')}.bundle`);
  renameSync(bundle, dest);
  chmodSync(dest, 0o444);
  return { path: dest, sha256: createHash('sha256').update(readFileSync(dest)).digest('hex') };
}

// A staging folder older than this was left by a run that was killed (audit 0b-6 r3 MIN-6): the pass
// lock means no other pass is using it, and the margin is far past any one pass.
export const STALE_STAGING_MS = 60 * 60_000;

/** Removes `.staging-*` folders in sealRoot older than STALE_STAGING_MS; never a link, never throws. */
export function sweepStaging(sealRoot, now) {
  const gone = [];
  let names = [];
  try { names = readdirSync(sealRoot).filter((n) => n.startsWith('.staging-')); } catch { return gone; }
  for (const n of names) {
    const p = join(sealRoot, n);
    const s = st(p);
    if (!s?.isDirectory() || now - s.mtimeMs <= STALE_STAGING_MS) continue;
    try { rmSync(p, { recursive: true, force: true }); gone.push(n); } catch { /* tried again next pass */ }
  }
  return gone;
}

/** Every copy folder under copiesRoot, one at a time. `mirrorFor(cardDoc)` names the product's mirror. */
export async function cleanupPass({ rec, rules, now, copiesRoot, sealRoot, mirrorFor, git, saveWork, alert }) {
  const out = [];
  if (sealRoot) for (const n of sweepStaging(sealRoot, now)) out.push([n, { result: 'removed', reasons: ['a staging folder left by a killed run'] }]);
  let names = [];
  try { names = readdirSync(copiesRoot).filter((n) => !n.startsWith('.')); } catch { return out; }
  for (const card of names.sort()) {
    const doc = rec.read('card', card)?.doc;
    const mirror = doc ? mirrorFor(doc) : null;
    if (!mirror) { out.push([card, { result: 'kept', reasons: ['no record or mirror for this copy'] }]); continue; }
    out.push([card, await cleanupCopy({ rec, rules, now, card, copiesRoot, sealRoot, mirror, git, saveWork, alert })]);
  }
  return out;
}
