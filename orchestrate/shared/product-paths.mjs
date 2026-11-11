// The one definition of the worker runner's per-product places (L836, L848), shared by the wiring (the start port, the
// start answer check, the status reader), setup (the folders it makes) and M11 (copies, intake and push outboxes).
// Every product has its own copies folder and outbox folder, so a session can be denied every other product's whole
// folder, copies made after it started included:
//   copy    <copiesRoot>/<product>/<card>          outbox  <outboxRoot>/<product>/<role>/<sessionId>
// A product's folder sits beside the role folders under the outbox root, so a product may not be named as a role (in
// any letter case). A product name is a folder name setup makes: lower case only, so a name in a config is the name on
// the Mac's disk, which matches without regard to letter case (#378 M1), and each deny is spelled as the folder is.
// A card, role or session id is one plain folder name: no `/`, no `..`, no leading `.` (L848).
import { join } from 'node:path';
import { AI_ROLES } from './record.mjs';

/** A product name setup makes a folder for (setup/layout.mjs parseConfig checks the products against it). */
export const PRODUCT = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The roles the worker runner starts, whose outboxes sit in a folder per product (L836): the one list. setup makes their
 * product folders, and intake names the product only for them; every other role's outbox keeps the layout with no
 * product (a Lead's included, #406 land). wiring/owner-status.mjs RUNNER_ROLE_OF maps onto exactly these (setup.test). */
export const PRODUCT_OUTBOX_ROLES = Object.freeze(['worker', 'script']);
/** True when a product name is an AI role's, in any letter case. */
export const productRoleClash = (product) => typeof product === 'string' && AI_ROLES.some((r) => r.toLowerCase() === product.toLowerCase());
// The card and session id characters (CARD_ID, SESSION_ID), with no leading `.` (#378 r1 c1): safe by itself.
const PLAIN = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,200}$/;
const plain = (what, n) => {
  if (typeof n !== 'string' || !PLAIN.test(n)) throw new Error(`not a ${what} that names one plain folder`);
  return n;
};

/** → { copies, outboxes }: the product's own copies folder and outbox folder, or a throw for a name setup can't make. */
export function runnerPlaces({ copiesRoot, outboxRoot, product }) {
  if (typeof product !== 'string' || !PRODUCT.test(product)) throw new Error('not a product name setup makes a folder for (lower case letters, digits and -)');
  if (productRoleClash(product)) throw new Error(`product ${product} is named as a role, and its outbox folder would be that role's`);
  return { copies: join(copiesRoot, product), outboxes: join(outboxRoot, product) };
}
export const runnerCopy = ({ copiesRoot, product, card }) => join(runnerPlaces({ copiesRoot, outboxRoot: '/', product }).copies, plain('card', card));
export const runnerOutbox = ({ outboxRoot, product, role, sessionId }) =>
  join(runnerPlaces({ copiesRoot: '/', outboxRoot, product }).outboxes, plain('role', role), plain('session id', sessionId));
