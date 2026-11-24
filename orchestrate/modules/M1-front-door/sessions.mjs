// sessions.mjs — the Front Door's sessions, by the name of their outbox folder (Track A step 6, design v4 §10.0).
//
// Joe starts the Front Door in a Ghostty tab (setup/front-door.mjs). Each start makes one outbox folder,
// <outboxRoot>/front_door/fd-<product>-<YYYYMMDDHHMMSS>, as Joe's own Mac user, and the AI writes its ideas, asks and
// compaction notes there. The folder's name is the registration: each pass, the product's Dispatcher lists the Front
// Door folder and hands every folder named for its product to intake (M11 outbox-intake.mjs) as a front_door session
// whose files must be the owner's (hostLockUid). So only an idea filed in that product's Front Door reaches its Record.
//
// What this trusts (said plainly): any program running as Joe's own Mac user can make such a folder and put a file in
// it, as it can type into his tab. The kinds a Front Door may hand in are ideas, asks and its notes (shared/record-names.mjs
// OUTBOX_KINDS): never a go, a card change or a merge. The go stays Joe's alone (setup/go-card.mjs, setup/go.mjs).
//
// A session folder stays after its tab is closed, so a file written just before the close is still taken. Ended
// folders are left; clearing them is a later step's (STILL OWED: the folders build up, one per start).

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const FRONT_DOOR_ROLE = 'front_door';
export const FRONT_DOOR_PREFIX = 'fd';
const STAMP = /^\d{14}$/;
const PRODUCT = /^[a-z0-9][a-z0-9-]*$/;

const two = (n) => String(n).padStart(2, '0');
/** The session id (and its outbox folder's name) of a start at `date`, in the Mac's own time zone. */
export function frontDoorSessionId(product, date = new Date()) {
  if (typeof product !== 'string' || !PRODUCT.test(product)) throw new Error(`not a product name: ${String(product).slice(0, 80)}`);
  const d = date;
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  return `${FRONT_DOOR_PREFIX}-${product}-${stamp}`;
}

/** Whether `name` is a Front Door session of `product`: fd-<product>-<14 digits>, so product a's never matches a-b's. */
export function isFrontDoorSession(name, product) {
  const head = `${FRONT_DOOR_PREFIX}-${product}-`;
  return typeof name === 'string' && name.startsWith(head) && STAMP.test(name.slice(head.length));
}

/** The Front Door folder: every session's outbox is directly inside it. */
export const frontDoorFolder = (outboxRoot) => join(outboxRoot, FRONT_DOOR_ROLE);

/**
 * This product's Front Door sessions, as intake's session list has them (wiring/owner-ports.mjs outboxSessions):
 * [{ sessionId, role, outbox, uid, card: null, product }]. Only plain folders count (a link is left out; the Record
 * refuses one anyway). No Front Door folder yet (none was set up) is none; any other failure to list throws.
 */
export function frontDoorSessions({ outboxRoot, product, uid, list = (d) => readdirSync(d), lstat = (p) => lstatSync(p) }) {
  if (typeof outboxRoot !== 'string' || !outboxRoot.startsWith('/')) throw new Error('the Front Door sessions need the outbox root');
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('the Front Door sessions need the owner\'s Mac user id');
  const dir = frontDoorFolder(outboxRoot);
  let names;
  try { names = list(dir); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of [...names].sort()) {
    if (!isFrontDoorSession(name, product)) continue;
    const outbox = join(dir, name);
    let st; try { st = lstat(outbox); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    out.push({ sessionId: name, role: FRONT_DOOR_ROLE, outbox, uid, card: null, product });
  }
  return out;
}
