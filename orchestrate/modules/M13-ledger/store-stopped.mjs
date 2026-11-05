// store-stopped.mjs — tells the owner about a Record that stopped the robot job's start (LEAD-CALLS L583, L587).
//
// WHY ITS OWN PATH. A store with a bad layout refuses to open, so there is no Record: no alert queue, no unsent file that
// is safe to touch, and deliverAlertsPass needs an open Record. This reads nothing from the store. The fault comes in
// on the error the open threw (store.mjs stopFor), and the one thing it does is raise an issue.
//
// ONE ISSUE PER REASON. The robot job starts again every round and finds the fault again, so it looks for an open issue
// first. A look that fails opens nothing, as an unknown answer would otherwise flood the repository. A failed look or
// send is logged and left for the next start; nothing retries here. An issue the owner closes with the fault still there
// is opened again on the next start: closing it does not silence it.
//
// Only the robot job comes here. The Dispatcher holds no writing token (L236, L237): its start logs the same fault, and
// the robot job, which opens the same folder, is what tells it.

import { createHash } from 'node:crypto';
import { lineIs } from './alerts.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';
import { ALERT_SEND_MS } from '../M11-dispatcher/alerts.mjs';

export const stopMarker = (product, reason) => `<!-- orch:store_stopped ${product} ${createHash('sha256').update(String(reason)).digest('hex').slice(0, 16)} -->`;

const msg = (e) => String(e?.message ?? e).slice(0, 200);
function inTime(ms, f) {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve().then(f), late]).finally(() => clearTimeout(timer));
}

/**
 * @param stop     { type, reason } from the error
 * @param channel  { gh, owner }: an M13 issues client and who to assign. Missing until the robot's writing token exists.
 * → 'opened' | 'already open' | 'not told'. Never throws: the job has already stopped, and this only reports that.
 */
export async function tellStoreStopped({ stop, product, channel, log, sendMs = ALERT_SEND_MS }) {
  const notTold = (why) => { log(`robot: the stopped Record could not be told: ${why}`); return 'not told'; };
  if (!channel?.gh) return notTold('no way to write to GitHub yet (robot.issues, R-0b-02)');
  const { gh, owner } = channel;
  const marker = stopMarker(product, stop.reason);
  try {
    const found = await inTime(sendMs, () => gh.findOpen(lineIs(marker)));
    if (found === false) return notTold(gh.lastAnswer ?? 'the open issues could not be read');
    if (found) return 'already open';
    const { text } = makeMasker().maskSecrets(`${product}'s Record has stopped (${stop.type}): ${stop.reason}\n\nThe Record refuses reads and writes until the owner fixes this, so the jobs that use it do not start.`);
    const n = await inTime(sendMs, () => gh.open({ title: `${product}'s Record has stopped: ${stop.type}`, body: `${text}\n\n${marker}`, assignee: owner }));
    return n ? 'opened' : notTold(gh.lastAnswer ?? 'GitHub refused the issue');
  } catch (e) { return notTold(msg(e)); }
}
