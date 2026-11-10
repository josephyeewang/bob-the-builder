// store-stopped.mjs — tells the owner about a Record that stopped the robot job's start (LEAD-CALLS L583, L587).
//
// WHY ITS OWN PATH. A store with a bad layout refuses to open, so there is no Record: no alert queue, no unsent file that
// is safe to touch, and deliverAlertsPass needs an open Record. This reads nothing from the store. The fault comes in
// on the error the open threw (store.mjs stopFor), and the one thing it does is raise an issue.
//
// ONE ISSUE PER FAULT. The robot job starts again every round and finds the fault again, so it looks for an open issue
// first, by a marker made of the fault's type and its stable key (store.mjs stopFor), never of the reason's words, which
// can carry an error text or a temp name that changes each start (L724).
//
// TOLD ONCE. A fault the store keeps for the delivery pass itself (STORE_KEEPS: recovery_stopped, kept once a day) is not
// told here too. A store write never throws, so such a fault does not stop the start, and the deliver pass of the same
// round sends it; only a fault found when the store opens (store_layout) has no queue and comes here (L724).
//
// STILL THERE, TOLD AGAIN (L732 m3). An issue the owner left open after fixing the store would otherwise hide the same
// fault coming back: every start would find it and say nothing. So a start that finds the issue open comments on it once
// a day while the fault lasts: not when the robot commented in the last day, nor when the issue was opened in the last
// day (its body says when). A comment that notifies is the point; the body is never edited.
//
// The reason is cut and fenced as a push reason is (L720 n2): local paths become <path>, a cut for length says so, and
// the words are fenced as outside text. A look that fails opens nothing, as an unknown answer would otherwise flood the
// repository. A failed look or send is logged and left for the next start; nothing retries here. An issue the owner
// closes with the fault still there is opened again on the next start: closing it does not silence it.
//
// Only the robot job comes here. The Dispatcher holds no writing token (L236, L237): its start logs the same fault, and
// the robot job, which opens the same folder, is what tells it.

import { createHash } from 'node:crypto';
import { lineIs } from './alerts.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';
import { ALERT_SEND_MS } from '../M11-dispatcher/alerts.mjs';
import { pushReason } from '../M11-dispatcher/proposal-route.mjs';

export const STORE_KEEPS = Object.freeze(['recovery_stopped']);
export const stopMarker = (product, type, key) => `<!-- orch:store_stopped ${product} ${createHash('sha256').update(`${type}\n${key}`).digest('hex').slice(0, 16)} -->`;

const msg = (e) => String(e?.message ?? e).slice(0, 200);
export const STOP_REMIND_MS = 24 * 60 * 60 * 1000;
const OPENED = /^Opened at (\d{4}-\d\d-\d\dT[\d:.]+Z)\.$/m;
function inTime(ms, f) {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve().then(f), late]).finally(() => clearTimeout(timer));
}

/**
 * @param stop     { type, reason, key } from the error (store.mjs stopFor)
 * @param channel  { gh, owner }: an M13 issues client and who to assign. Missing until the robot's writing token exists.
 * → 'opened' | 'reminded' (a comment on the open issue, once a day) | 'already open' | 'kept' (the store's delivery tells
 *   it) | 'not told'. Never throws: the job has already stopped, and this only reports that.
 */
export async function tellStoreStopped({ stop, product, channel, log, sendMs = ALERT_SEND_MS, now = () => Date.now() }) {
  const notTold = (why) => { log(`robot: the stopped Record could not be told: ${why}`); return 'not told'; };
  if (STORE_KEEPS.includes(stop.type)) { log(`robot: ${stop.type} is kept by the store and told by the delivery pass`); return 'kept'; }
  if (!channel?.gh) return notTold('no way to write to GitHub yet (robot.issues, R-0b-02)');
  const { gh, owner } = channel;
  const marker = stopMarker(product, stop.type, stop.key ?? stop.reason);
  const said = cleanOutside(pushReason(stop.reason), 'log-line');
  try {
    const found = await inTime(sendMs, () => gh.findOpen(lineIs(marker)));
    if (found === false) return notTold(gh.lastAnswer ?? 'the open issues could not be read');
    if (found) return await remind(found);
    const text = `${product}'s Record has stopped (${stop.type}): ${said}\n\nThe Record refuses reads and writes until the owner fixes this, so the jobs that use it do not start.`;
    const n = await inTime(sendMs, () => gh.open({ title: `${product}'s Record has stopped: ${stop.type}`, body: `${text}\n\nOpened at ${new Date(now()).toISOString()}.\n\n${marker}`, assignee: owner }));
    return n ? 'opened' : notTold(gh.lastAnswer ?? 'GitHub refused the issue');
  } catch (e) { return notTold(msg(e)); }

  // Once a day at most, counting the opening itself; a look that fails says nothing rather than risk a flood.
  async function remind(n) {
    const t = now();
    const since = new Date(t - STOP_REMIND_MS).toISOString();
    const last = await inTime(sendMs, () => gh.latestOwnComment(n, since));
    if (last === false) { log(`robot: the stopped Record's issue #${n} is open; its comments could not be read: ${gh.lastAnswer ?? 'no answer'}`); return 'already open'; }
    if (last) return 'already open';
    const issue = await inTime(sendMs, () => gh.read(n));
    if (!issue || issue === false) { log(`robot: the stopped Record's issue #${n} could not be read: ${gh.lastAnswer ?? 'no answer'}`); return 'already open'; }
    const opened = Date.parse(OPENED.exec(issue.body)?.[1] ?? '');
    if (Number.isFinite(opened) && t - opened < STOP_REMIND_MS) return 'already open';
    const c = await inTime(sendMs, () => gh.comment(n, `Still stopped (${stop.type}): ${said}`));
    return c === false ? notTold(gh.lastAnswer ?? 'GitHub refused the comment') : 'reminded';
  }
}
