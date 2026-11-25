// The Lead's read-only copy of main (Track A step 8 G1, L1370).
//
// One Dispatcher step keeps <leadMainRoot>/<product> a plain copy of main's files, with a `.head` file in it naming the
// main commit they are. It reads the product's mirror (the one the cleanup step reads): `git rev-parse` for main's
// commit, `git archive` for its files. A one-shot Lead reads the folder and writes the `.head` it saw into its launch
// file; the intake records that launch only when `exportedHead` says the head is one this step exported (outbox-intake.mjs
// launchFromFile).
//
// The copy is swapped in whole, never written in place. It is made in a temp folder beside it (same disk), its modes
// set, `.head` written last, and only then renamed into place: the old copy is first renamed aside, then deleted. So a
// half-written tree is never seen at <product>, and never with a `.head` beside it. For a moment between the two renames
// there is no <product> folder at all; a reader then finds no `.head` and starts nothing. A temp or old folder a stopped
// pass left is deleted on the next pass.
//
// Read-only for the Lead, readable by the owner: the folder under it is orchestrate's (setup layout.mjs, 0755, no
// access list), and every folder this step makes is set to 0755 and every file to 0644 (0755 when git marks it
// runnable), whatever the Dispatcher job's umask (63). So the owner's user can read and enter all of it and write none
// of it. A root that is a link, not this job's, writable by others or not readable by others is refused, not used
// (worker-ports.mjs leadMainRootProblem, which also holds the tar this step unpacks with).
//
// Which heads were exported is kept in the Record, in the Dispatcher's fact lead-main-<product>: the newest KEEP_HEADS,
// newest first. A Lead that started on the copy before the last swap still has its head there. A head is noted only
// after its copy is in place, so a failed swap never vouches for a head nobody could read.

import { lstatSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { factFrom } from '../M9-record/permissions.mjs';
import { writeFrom } from './alerts.mjs';

export const HEAD_FILE = '.head';
export const KEEP_HEADS = 5;
export const LEAD_MAIN_FAMILY = 'lead-main-';
export const LEAD_MAIN_FACT = (product) => `${LEAD_MAIN_FAMILY}${product}`;
// The two git commands this step runs on the mirror; the port refuses any other (worker-ports.mjs leadMainPorts).
export const LEAD_MAIN_GIT = Object.freeze(['rev-parse', 'archive']);
export const LEAD_MAIN_GIT_MS = 120_000;
export const NOT_CONFIGURED = 'not configured: the Dispatcher\'s config names no leadMainRoot (rerun setup\'s dispatcher step to write it)';

const TEMP = (product) => `.tmp-${product}-`;
const OLD = (product) => `.old-${product}-`;
const iso = (ms) => new Date(ms).toISOString();

/** The head a copy folder names in its `.head`, or null (none, a link, or not one commit id). */
export function copyHead(dir, { lstat = lstatSync, read = readFileSync } = {}) {
  const f = join(dir, HEAD_FILE);
  try {
    if (!lstat(f).isFile()) return null;
    const t = String(read(f, 'utf8')).trim();
    return /^[0-9a-f]{40}$/.test(t) ? t : null;
  } catch { return null; }
}

/** Every folder 0755, every file 0644 (0755 if it was runnable), links left as they are: so the owner reads it all, writes none. */
export function openForReading(dir) {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) openForReading(p);
    else if (e.isFile()) chmodSync(p, (lstatSync(p).mode & 0o100) ? 0o755 : 0o644);
    else throw new Error(`the archive made ${p}, which is not a file, folder or link`);
  }
}

/** Deletes the temp and old folders an earlier pass left for this product. Answers their names. */
export function sweepLeftovers(root, product) {
  const gone = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(TEMP(product)) && !name.startsWith(OLD(product))) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    gone.push(name);
  }
  return gone;
}

/**
 * Makes <root>/<product> main's files at `head` of the mirror, when it isn't already. `git(args)` runs git on the mirror
 * and answers { code, stdout, stderr }; `untar(tar, dir)` unpacks the archive into a folder (the wiring's untarInto: no
 * Dispatcher file starts a program itself, only-send-safe.test.mjs). Answers { head, changed }; throws when it can't, leaving the copy that was there.
 */
export async function exportMain({ root, product, git, untar, now = Date.now }) {
  sweepLeftovers(root, product);
  const r = await git(['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}']);
  const head = r?.code === 0 ? String(r.stdout).trim() : '';
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`could not read main in the mirror (${String(r?.stderr ?? '').trim().slice(0, 200) || `code ${r?.code}`})`);
  const dest = join(root, product);
  if (copyHead(dest) === head) return { head, changed: false };
  const a = await git(['archive', '--format=tar', head]);
  if (a?.code !== 0) throw new Error(`git archive of ${head.slice(0, 12)} failed (${String(a?.stderr ?? '').trim().slice(0, 200)})`);
  const tmp = mkdtempSync(join(root, TEMP(product)));
  try {
    await untar(a.stdout, tmp);
    openForReading(tmp);
    // Last into the temp folder: a copy with a .head is a whole one.
    writeFileSync(join(tmp, HEAD_FILE), `${head}\n`, { mode: 0o644, flag: 'wx' });
    chmodSync(join(tmp, HEAD_FILE), 0o644);
    let old = null;
    try { lstatSync(dest); old = join(root, `${OLD(product)}${now()}`); renameSync(dest, old); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    renameSync(tmp, dest);
    if (old) rmSync(old, { recursive: true, force: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { head, changed: true };
}

/** Notes `head` as exported for `product`, newest first, keeping KEEP_HEADS. Throws when the Record refuses. */
export function noteExported(rec, { product, head, now }) {
  const id = LEAD_MAIN_FACT(product);
  const cur = rec.read('fact', id)?.doc;
  const was = Array.isArray(cur?.heads) ? cur.heads.filter((h) => typeof h === 'string') : [];
  if (was[0] === head) return { ok: true, unchanged: true };
  const heads = [head, ...was.filter((h) => h !== head)].slice(0, KEEP_HEADS);
  const w = writeFrom(rec, id, cur, { ...(cur ?? {}), type: 'lead_main_export', product, heads, at: iso(now) }, 'lead_main_export');
  if (w?.ok !== true) throw new Error(`the exported head could not be noted (${w?.reason ?? 'no answer'})`);
  return w;
}

/**
 * The tick's check for a one-shot Lead's head (outbox-intake.mjs launchFromFile): { ok: true } when it is one of the
 * heads the Dispatcher noted for this product, in its own fact. Anything else is a no with a reason.
 */
export function exportedHead(rec, { head, product } = {}) {
  if (typeof head !== 'string' || typeof product !== 'string') return { ok: false, reason: 'no head or product named' };
  const id = LEAD_MAIN_FACT(product);
  const f = rec.read('fact', id);
  if (!f) return { ok: false, reason: `no lead-main export has been noted for ${product}` };
  if (f.corrupt || !factFrom('dispatcher', { id, createdBy: rec.meta?.('fact', id)?.createdBy ?? null }, LEAD_MAIN_FAMILY)) return { ok: false, reason: `the lead-main export fact for ${product} is not the Dispatcher's own` };
  const heads = Array.isArray(f.doc?.heads) ? f.doc.heads : [];
  return heads.includes(head) ? { ok: true } : { ok: false, reason: `not one of the last ${KEEP_HEADS} heads the lead-main export gave` };
}

/** The tick's step: the port exports main if it moved, then the head is noted (again, when an earlier note failed). */
export async function leadMainStep({ rec, now, leadMain }) {
  const r = await leadMain.exportMain();
  noteExported(rec, { product: leadMain.product, head: r.head, now });
  return r;
}
