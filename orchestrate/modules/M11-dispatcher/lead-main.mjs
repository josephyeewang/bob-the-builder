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
// pass left is deleted on the next pass; their names end the product with a `.`, which no product name has (shared
// product-paths.mjs PRODUCT), so product `alpha` never matches `alpha-beta`'s (L1370 audit m1).
//
// One time budget, from the `until` the tick's step passes in (L1370 audit m2): each git and the tar get only what is
// left of it and are killed when it runs out, and nothing is renamed once it has; so no part of the step outlives the
// step's own deadline. The archive held in memory is capped at LEAD_MAIN_MAX_BYTES (git is stopped past it).
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
// The step's budget when no `until` is passed (a test, a direct call): the tick's own STEP_DEADLINE_MS.
export const LEAD_MAIN_MS = 120_000;
// The most archive bytes held in memory: a main bigger than this is refused, told by the step's error.
export const LEAD_MAIN_MAX_BYTES = 256 * 1024 * 1024;
export const TOO_BIG = `main is larger than the ${LEAD_MAIN_MAX_BYTES / (1024 * 1024)} MB limit for the Lead's copy`;
export const NOT_CONFIGURED = 'not configured: the Dispatcher\'s config names no leadMainRoot (rerun setup\'s dispatcher step to write it)';

// `.` ends the product: no product name has one, so one product's prefix is never another's (L1370 audit m1).
export const TEMP = (product) => `.tmp-${product}.`;
export const OLD = (product) => `.old-${product}.`;
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
export async function exportMain({ root, product, git, untar, now = Date.now, until = Date.now() + LEAD_MAIN_MS }) {
  // What is left of the step's budget, for the next child; none left is a throw naming what was not done.
  const left = (what) => {
    const ms = Math.floor(until - Date.now());
    if (!(ms > 0)) throw new Error(`the lead-main step ran out of time before ${what}`);
    return ms;
  };
  sweepLeftovers(root, product);
  const r = await git(['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}'], { timeoutMs: left('reading main') });
  const head = r?.code === 0 ? String(r.stdout).trim() : '';
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`could not read main in the mirror (${String(r?.stderr ?? '').trim().slice(0, 200) || `code ${r?.code}`})`);
  const dest = join(root, product);
  if (copyHead(dest) === head) return { head, changed: false };
  const a = await git(['archive', '--format=tar', head], { timeoutMs: left('the archive'), maxOutBytes: LEAD_MAIN_MAX_BYTES });
  // The cause first, in lead-main's own words, so no cut of the step's error can drop it (L1370 audit #681 r2 m-a).
  if (a?.tooBig === true) throw new Error(`${TOO_BIG} (git archive of ${head.slice(0, 12)} was stopped)`);
  if (a?.code !== 0) throw new Error(`git archive of ${head.slice(0, 12)} failed (${String(a?.stderr ?? '').trim().slice(0, 200)})`);
  const tmp = mkdtempSync(join(root, TEMP(product)));
  try {
    await untar(a.stdout, tmp, { timeoutMs: left('unpacking') });
    // A `.head` at the top of main itself would stand where the copy's own goes (L1370 audit m3): named, not a bare EEXIST.
    let own = true;
    try { lstatSync(join(tmp, HEAD_FILE)); } catch (e) { if (e?.code === 'ENOENT') own = false; else throw e; }
    if (own) throw new Error(`main ${head.slice(0, 12)} has a ${HEAD_FILE} at its top, the name the copy keeps for the commit it is; no copy can be made until main renames or removes it`);
    openForReading(tmp);
    // Last into the temp folder: a copy with a .head is a whole one.
    writeFileSync(join(tmp, HEAD_FILE), `${head}\n`, { mode: 0o644, flag: 'wx' });
    chmodSync(join(tmp, HEAD_FILE), 0o644);
    // Nothing is renamed once the budget is spent: the tick has already called the step failed (L1370 audit m2).
    left('swapping the copy in');
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

/**
 * The tick's step: the port exports main if it moved, within the step's `until`, then the head is noted (again, when an
 * earlier note failed). A port with no leadMainRoot (`configured: false`: a config written before the key, until setup's
 * dispatcher step runs again, which needs Joe's admin password) is skipped silently: no alert, no failed step, no log
 * line (each pass is its own process, so even "once per start" would be a line a minute; L1370 audit C2). The tick then
 * leaves exportedHead unwired, so no one-shot Lead's launch is recorded. A root that is configured but bad still fails
 * the step, and is told.
 */
export async function leadMainStep({ rec, now, leadMain, until }) {
  if (leadMain?.configured === false) return { skipped: true };
  const r = await leadMain.exportMain({ until });
  noteExported(rec, { product: leadMain.product, head: r.head, now });
  return r;
}
