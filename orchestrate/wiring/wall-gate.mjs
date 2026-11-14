// The builder wall's start-of-session gate (L1170 m5, L1193): before the worker runner starts a session, it confirms that
// lane A's per-uid pf wall (R-0b-179, setup/builder-wall.mjs) is in force for the user it runs as. It can't look itself:
// the runner runs as the builder (L1079), and pf answers root alone (/dev/pf is root's 0600). And a probe from the builder
// can't tell a block from a listener that is down (both are a refused connect), so a probe would pass falsely. So root's
// wall job, at each beat, checks the wall (pf on, its token held, the anchor's rules exactly the wall's, and the read-back
// probes with their controls) and writes what it found to a status file; this gate reads that file and holds every start
// unless the file says, freshly, that the wall stands for this very uid and these very rules.
//
// It refuses (a held start, through the start port's productHeld: told as the other holds are) when:
//   - the wall's code can't be loaded from the installed copy, or the config names no status file;
//   - the status file, or any folder above it, is not root's, can be written by others, is a link or has an access list
//     (install-check.mjs chainProblem), or the file is not root's own plain file when opened (runner-main readRootFile);
//   - it can't be read or is not exactly the shape below;
//   - its time is in the future, or older than two of the wall job's beats;
//   - it is not ok, names another uid, or its rules' hash is not anchorText(this uid)'s.
// Any error on the way is a refusal, never a pass.
//
// Stated limit (L1193): the wall job writes at each beat, so a wall switched off just after a beat is not seen for up to
// two beats (about 10 minutes). Accepted for the test product.
//
// The status file is root's wall job's (lane A, setup/builder-wall.mjs): its place (STATUS_FILE, which setup writes into this
// runner's config as wallStatus), its shape and its reader (parseStatus) are that module's, one home for the format. This
// gate takes what parseStatus gives, { v, time, builderUid, anchorSha256, ok, why }, and judges it: fresh within two of
// the job's beats (2 x RECHECK_EVERY_S), not after this clock, ok, for this uid and for anchorText(this uid)'s hash. A wall
// check that could not run is written ok: false with its reason, so it holds as a failed one does.

import { createHash } from 'node:crypto';
import { pastTime } from '../shared/still-waiting.mjs';

const HELD = 'so no session starts until the builder wall is confirmed (L1170 m5)';
const clip = (s, n = 160) => String(s).replace(/\s+/g, ' ').slice(0, n);
const whyOf = (w) => (Array.isArray(w) ? w.filter((x) => typeof x === 'string' && x).join('; ') : typeof w === 'string' ? w : '') || 'no reason given';

/** sha256 of the anchor's rules for `uid`, as the wall job loads them (lane A's anchorText). */
export const anchorHash = (anchorText, uid) => createHash('sha256').update(anchorText(uid), 'utf8').digest('hex');

/**
 * Null, or why the status text does not confirm the wall for `uid` at `now` (ms). `wall`: { anchorText, beatMs,
 * parseStatus } (wallFrom). Pure: the file's reading and its owners are wallProblem's.
 */
export function wallStatusProblem(text, { uid, now, wall }) {
  let s; try { s = wall.parseStatus(text); } catch (e) { return `the builder wall's status is not one the wall job writes (${clip(e?.message ?? e)}), ${HELD}`; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return `the builder wall's status reads as nothing, ${HELD}`;
  if (!Number.isFinite(now)) return `this runner's clock can't be read, ${HELD}`;
  if (typeof s.time !== 'string') return `the builder wall's status names no time it was written, ${HELD}`;
  // The one stored-time read (I4, pastTime); its skew allowance is not taken: a time after this clock at all is refused (L1193).
  const at = pastTime(s.time, now);
  if (at === null) return `the builder wall's status is dated ${clip(s.time, 40)}, which is no date or is after this runner's clock, ${HELD}`;
  if (at > now) return `the builder wall's status is dated ${clip(s.time, 40)}, after this runner's clock, ${HELD}`;
  const fresh = 2 * wall.beatMs;
  if (now - at > fresh) return `the builder wall's status is from ${clip(s.time, 40)}, older than two of the wall job's beats (${Math.round(fresh / 60_000)} minutes): the wall job may have stopped, ${HELD}`;
  if (s.ok !== true) return `the builder wall's last check failed (${clip(whyOf(s.why))}), ${HELD}`;
  if (s.builderUid !== uid) return `the builder wall's status is for uid ${clip(JSON.stringify(s.builderUid), 20)}, not this runner's (${uid}), ${HELD}`;
  let want; try { want = anchorHash(wall.anchorText, uid); } catch (e) { return `the builder wall's rules for uid ${uid} can't be built (${clip(e?.message ?? e)}), ${HELD}`; }
  if (s.anchorSha256 !== want) return `the builder wall's status is for other rules than this copy's wall (its hash is not anchorText(${uid})'s), ${HELD}`;
  return null;
}

/**
 * Null, or why the wall is not confirmed. file: the status file's full path (config wallStatus). wall: { anchorText,
 * beatMs, parseStatus } from lane A's module, or null when it could not be loaded (`wallWhy` says why). Ports: chain(p) (root's all the
 * way up: null or why), readRoot(p) (root's own plain file's text, or a throw), now() (ms), uid.
 */
export function wallProblem({ file, wall, wallWhy, uid, chain, readRoot, now }) {
  if (!wall || typeof wall.anchorText !== 'function' || typeof wall.parseStatus !== 'function' || !Number.isInteger(wall.beatMs) || wall.beatMs <= 0) return `the builder wall's code can't be loaded from the installed copy (${clip(wallWhy ?? 'no anchorText, parseStatus or beat')}), ${HELD}`;
  if (typeof file !== 'string' || !file.startsWith('/')) return `the runner's config names no builder wall status file (wallStatus), ${HELD}`;
  if (!Number.isInteger(uid) || uid <= 0) return `this runner's uid can't be read, ${HELD}`;
  let why; try { why = chain(file); } catch (e) { why = `it can't be checked (${clip(e?.code ?? e?.message ?? e)})`; }
  if (why) return `the builder wall's status file is not root's alone (${clip(why)}), ${HELD}`;
  let text; try { text = readRoot(file); } catch (e) { return `the builder wall's status can't be read (${clip(e?.code === 'ENOENT' ? 'it is not there' : e?.code ?? e?.message ?? e)}), ${HELD}`; }
  let t; try { t = now(); } catch { t = NaN; }
  return wallStatusProblem(text, { uid, now: t, wall });
}

/** The start port's productHeld with the wall gate first: `gate()` → null or why; `inner(product)` the rest. */
export const wallHeld = (gate, inner) => (product) => {
  let why; try { why = gate(); } catch (e) { why = `the builder wall can't be checked (${clip(e?.message ?? e)}), ${HELD}`; }
  return why ?? inner(product);
};

/** Lane A's module's names this gate takes → { anchorText, beatMs, parseStatus }, or a throw saying which is missing. */
export function wallFrom(mod) {
  if (typeof mod?.anchorText !== 'function') throw new Error('setup/builder-wall.mjs exports no anchorText');
  if (typeof mod?.parseStatus !== 'function') throw new Error('setup/builder-wall.mjs exports no parseStatus');
  if (!Number.isInteger(mod?.RECHECK_EVERY_S) || mod.RECHECK_EVERY_S <= 0) throw new Error('setup/builder-wall.mjs exports no RECHECK_EVERY_S');
  return { anchorText: mod.anchorText, parseStatus: mod.parseStatus, beatMs: mod.RECHECK_EVERY_S * 1000 };
}
