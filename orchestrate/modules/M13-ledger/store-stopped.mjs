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
// day (GitHub's created_at says when; its body's "Opened at" line when GitHub gives none). The day is counted by GitHub's
// clock, so a computer clock ahead or behind still reminds once a day (L768, L801 M1); one more than a few minutes ahead
// is said in the log, once each start. With no Date header from GitHub, the computer's clock stands, as before. A
// comment that notifies is the point; the body is never edited.
//
// The reason is cut and fenced as a push reason is (L720 n2): local paths become <path>, a cut for length says so, and
// the words are fenced as outside text. A look that fails opens nothing, as an unknown answer would otherwise flood the
// repository. A failed look or send is logged and left for the next start; nothing retries here. An issue the owner
// closes with the fault still there is opened again on the next start: closing it does not silence it.
//
// Only the robot job comes here. The Dispatcher holds no writing token (L236, L237): its start logs the same fault, and
// the robot job, which opens the same folder, is what tells it.

import { createHash } from 'node:crypto';
import { CLOCK_AHEAD_MS, clockAhead, lineIs } from './alerts.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';
import { ALERT_SEND_MS } from '../M11-dispatcher/alerts.mjs';
import { pushReason } from '../M11-dispatcher/proposal-route.mjs';

export const STORE_KEEPS = Object.freeze(['recovery_stopped']);
export const stopMarker = (product, type, key) => `<!-- orch:store_stopped ${product} ${createHash('sha256').update(`${type}\n${key}`).digest('hex').slice(0, 16)} -->`;

const msg = (e) => String(e?.message ?? e).slice(0, 200);
/**
 * A store reason or value as GitHub text, the one form for the stop issue and the store's alerts (L732 m1, self-review m1
 * m2): a quoted path is cut whole (a folder name with a space in it, such as "Application Support", would otherwise leak
 * its tail), line breaks become spaces (so no line of it can pass for the issue's own "Opened at" line; U+2028 and U+2029
 * too, since cleanOutside's stripControls turns them into line breaks, L783), then pushReason
 * cuts other local paths and the length, and the words are fenced as outside text.
 */
export const storeWords = (v) => cleanOutside(pushReason(String(typeof v === 'string' ? v : JSON.stringify(v))
  .replace(/(['"])\/[^'"\n]*\1/g, '$1<path>$1').replace(/[\r\n\u2028\u2029]+/g, ' ')), 'log-line');
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
  const said = storeWords(stop.reason);
  try {
    const found = await inTime(sendMs, () => gh.findOpen(lineIs(marker)));
    if (found === false) return notTold(gh.lastAnswer ?? 'the open issues could not be read');
    if (found) return await remind(found);
    const text = `${product}'s Record has stopped (${stop.type}): ${said}\n\nThe Record refuses reads and writes until the owner fixes this, so the jobs that use it do not start.`;
    const n = await inTime(sendMs, () => gh.open({ title: `${product}'s Record has stopped: ${stop.type}`, body: `${text}\n\nOpened at ${new Date(now()).toISOString()}.\n\n${marker}`, assignee: owner }));
    return n ? 'opened' : notTold(gh.lastAnswer ?? 'GitHub refused the issue');
  } catch (e) { return notTold(msg(e)); }

  // Once a day at most, counting the opening itself; a look that fails says nothing rather than risk a flood. The day is
  // counted by GitHub's times (L768): its clock on the read, the issue's created_at and the comments' own times. A robot
  // clock more than CLOCK_AHEAD_MS ahead of GitHub's is logged, and still reminds once a day (L801 M1).
  async function remind(n) {
    const t = now();
    const issue = await inTime(sendMs, () => gh.read(n));
    if (!issue) { log(`robot: the stopped Record's issue #${n} could not be read: ${gh.lastAnswer ?? 'no answer'}`); return 'already open'; }
    if (issue.open === false) return 'already open';   // closed since the search: the next start opens a new one
    const ahead = clockAhead(gh, t);
    if (ahead !== null && ahead > CLOCK_AHEAD_MS) log(`robot: the stopped Record's issue #${n} is open; this computer's clock is ${Math.round(ahead / 60_000)} minutes ahead of GitHub's; the day is counted by GitHub's time. Set the clock right.`);
    // GitHub's time now, or this computer's when GitHub gave none. Not clamped at 0 as alerts' githubNow is: every time this
    // count reads is GitHub's own (created_at, the comments), so a slow computer is put right too.
    const g = ahead === null ? t : t - ahead;
    const opened = Date.parse(issue.created_at ?? OPENED.exec(issue.body)?.[1] ?? '');
    if (Number.isFinite(opened) && g - opened < STOP_REMIND_MS) return 'already open';
    const last = await inTime(sendMs, () => gh.latestOwnComment(n, new Date(g - STOP_REMIND_MS).toISOString()));
    if (last === false) { log(`robot: the stopped Record's issue #${n} is open; its comments could not be read: ${gh.lastAnswer ?? 'no answer'}`); return 'already open'; }
    if (last) return 'already open';
    const c = await inTime(sendMs, () => gh.comment(n, `Still stopped (${stop.type}): ${said}`));
    return c === false ? notTold(gh.lastAnswer ?? 'GitHub refused the comment') : 'reminded';
  }
}
