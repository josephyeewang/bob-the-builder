// owner-sessions.mjs — sessions the owner starts, found by the name of their outbox folder (Track A steps 6 and 8;
// L1370). The one listing both the Front Door (M1 sessions.mjs, role front_door, prefix fd) and the one-shot Lead (M3
// sessions.mjs, role lead, prefix ld) use.
//
// Each start makes one outbox folder, <outboxRoot>/<role>/<prefix>-<product>-<YYYYMMDDHHMMSS>, as the owner's own Mac
// user. The folder's name is the registration: each pass, the product's Dispatcher lists the role's folder and hands
// every folder named for its product to intake (M11 outbox-intake.mjs) as a session of that role whose files must be
// the owner's (hostLockUid). What a role may hand in is its own (shared/record-names.mjs OUTBOX_KINDS).
//
// What this trusts (said plainly): any program running as the owner's Mac user can make such a folder and put a file in
// it. Neither role's kinds hold a go, a move to ready or a merge (M9 moves.mjs: draft → ready is the Dispatcher's).

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STAMP = /^\d{14}$/;
const PRODUCT = /^[a-z0-9][a-z0-9-]*$/;
const PREFIX = /^[a-z]+$/;
const two = (n) => String(n).padStart(2, '0');

/** The session id (and its outbox folder's name) of a start at `date`, in the Mac's own time zone. */
export function ownerSessionId(prefix, product, date = new Date()) {
  if (!PREFIX.test(String(prefix))) throw new Error(`not a session prefix: ${String(prefix).slice(0, 20)}`);
  if (typeof product !== 'string' || !PRODUCT.test(product)) throw new Error(`not a product name: ${String(product).slice(0, 80)}`);
  const d = date;
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  return `${prefix}-${product}-${stamp}`;
}

/** Whether `name` is a `prefix` session of `product`: <prefix>-<product>-<14 digits>, so product a's never matches a-b's. */
export function isOwnerSession(prefix, name, product) {
  const head = `${prefix}-${product}-`;
  return typeof name === 'string' && name.startsWith(head) && STAMP.test(name.slice(head.length));
}

/**
 * This product's sessions of `role`, as intake's session list has them (wiring/owner-ports.mjs outboxSessions):
 * [{ sessionId, role, outbox, uid, card: null, product }]. Only plain folders count (a link is left out; the Record
 * refuses one anyway). No role folder yet (none was set up) is none; any other failure to list throws. `label` is the
 * role as the owner reads it ("Front Door", "Lead"), for the errors.
 */
export function ownerSessions({ role, prefix, label = role, outboxRoot, product, uid, list = (d) => readdirSync(d), lstat = (p) => lstatSync(p) }) {
  if (typeof outboxRoot !== 'string' || !outboxRoot.startsWith('/')) throw new Error(`the ${label} sessions need the outbox root`);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`the ${label} sessions need the owner's Mac user id`);
  const dir = join(outboxRoot, role);
  let names;
  try { names = list(dir); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of [...names].sort()) {
    if (!isOwnerSession(prefix, name, product)) continue;
    const outbox = join(dir, name);
    let st; try { st = lstat(outbox); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    out.push({ sessionId: name, role, outbox, uid, card: null, product });
  }
  return out;
}
