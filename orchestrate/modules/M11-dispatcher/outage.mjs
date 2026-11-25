// Dead sessions and outages (R-0b-56, R-0b-60; design v4 G1, R4; review 0b-6 M9, M10, m18).
//
// Dead (G1) = the process group is gone AND the session has ended AND its transcript has had no
// write for timeouts.dead_quiet_min. The board = sessions meant to run that were running at the
// previous pass, Mac-wide. If, within one pass, the newly dead reach max(3, outage.min_dead,
// ceil(max(0.5, outage.share) × running)), running being the board less the deaths already counted, it is an outage:
// nothing restarts, and Joe gets one alert per outage.
// Lead call L43(a): an outage needs at least 3 dead AND half the board or more, so a small Mac is never frozen by
// one or two dead sessions. The rules may raise either number, never lower it. Below that, each dead session is
// handled on its own and Joe gets one alert per card (tick.mjs `actOnDead`).
// The outage ends by itself after 2 passes in a row with the network up, the Mini signed in and
// usage readable, or on Joe's "resume". Outside an outage, a dead session's card is restarted only
// when `rerun_safe === true`; any other card becomes an ask (waiting on Joe), never a restart.
// The Record has no rerun_safe field and no writer for one yet (L72 census, a (b) for the lead): until it does,
// every dead session's card waits on Joe, the safe side. This file is the one outage rule (L72 (ii)): M9's
// breakIfDead only breaks the claim it is given.
// Counted once (L759, from lane 4's #324 r3 m3): a dead session the Record would not take off the board (its ask or
// its claim's break refused) stays on it, dead, every pass. The deaths already counted are kept in the outage fact
// (`counted_dead`: each as its session id and last write time, so a session restarted under the same id counts again
// only if it wrote to its transcript or a pass saw it alive), set by the last pass outside an outage, or by the
// outage's end. Only new deaths count toward an outage, against the board less the deaths already counted; the
// still-dead are still handed to `actOnDead` each pass, to try again. The list is written only when it changes (as a
// set); a refused write is returned as `countedRefused` (they would be counted again next pass, as before L759).
// The ending pass checks too (review of L759): if its new deaths (not held by the outage, not counted) reach the
// threshold, the outage stays open, its healthy passes start again, and they are held with its dead. Such a second
// wave only makes the outage last longer: Joe gets no new alert for it (the outage's one alert stands).
// A refused end (L765): the Record still holds the outage open, so this pass stays in it (nothing restarts, no card is
// decided; its new deaths are held and an undelivered outage alert is retold, as on any outage pass) and the end is
// tried again next pass; the refusal is returned as `endRefused`, for tick.mjs to tell Joe.
// A refused save of an outage pass (its held deaths and healthy count) is returned as `passRefused` on any outage pass,
// for tick.mjs to tell Joe: deaths not held would go undecided at the end.

import { KEYS, need, minutes } from './keys.mjs';
import { tellThen } from './alerts.mjs';

export const OUTAGE_FACT = 'outage';
export const HEALTHY_PASSES = 2;
export const OUTAGE_MIN_DEAD = 3;     // L43(a): the floor; the rules' outage.min_dead may raise it
export const OUTAGE_MIN_SHARE = 0.5;  // L43(a): half the board or more; the rules' outage.share may raise it

const deathKey = (s) => `${s.id}@${s.lastWriteAt}`;

// The one outage threshold: `fresh` new deaths among `running` sessions (L43(a); the rules may raise it, never lower).
function tripped(fresh, running, minDead, share) {
  return running > 0 && fresh >= Math.max(OUTAGE_MIN_DEAD, minDead, Math.ceil(Math.max(OUTAGE_MIN_SHARE, share) * running));
}

/** G1. `s` = { alive, ended, lastWriteAt } as observed this pass. Unknown parts are not dead. */
export function isDead(s, { now, quietMs }) {
  return s.alive === false && s.ended === true && Number.isFinite(s.lastWriteAt) && now - s.lastWriteAt >= quietMs;
}

/**
 * One pass's outage step. `board` = [{ id, card, alive, ended, lastWriteAt }] for the sessions on
 * the board. `healthy` = network up and signed in and usage readable, this pass. `resume` = Joe
 * said resume; it must stay set until the outage has ended, since a pass whose new deaths reach the threshold ignores
 * it. Returns { outage, ended, restart: [session ids], asks: [card ids], cards: {session id: card} }, plus
 * `countedRefused`, `endRefused` or `passRefused` (the reason) when that write was refused; writes the outage fact and raises at most
 * one alert per outage.
 */
// L1364 amended (#674 review M1): `canEnd` false (no health reading can be had: the healthy port is not wired) opens no
// new outage, since one opened then could never end (healthy and resume both refuse) and would hold every start for ever.
// Those deaths are decided one card at a time, as outside an outage. An outage already open is handled as before.
export function outageStep({ rec, rules, board, now, healthy, resume = false, alert, canEnd = true }) {
  const quietMs = minutes(rules, KEYS.deadQuietMin);
  const minDead = need(rules, KEYS.outageMinDead);
  const share = need(rules, KEYS.outageShare);
  const dead = board.filter((s) => isDead(s, { now, quietMs }));
  const cur = rec.read('fact', OUTAGE_FACT);
  const open = cur?.doc?.state === 'open';
  const write = (doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id: OUTAGE_FACT, expectRev: cur?.rev ?? 0, doc, kind });

  const counted = new Set(Array.isArray(cur?.doc?.counted_dead) ? cur.doc.counted_dead : []);
  if (open) {
    // New deaths this pass: not held by the outage and not counted. Enough of them keep the outage open (review of L759).
    const held0 = cur.doc.dead ?? [];
    const fresh = dead.filter((s) => !held0.some((d) => d.id === s.id) && !counted.has(deathKey(s)));
    const surge = tripped(fresh.length, board.length - (dead.length - fresh.length), minDead, share);
    const passes = healthy && !surge ? (cur.doc.healthy_passes ?? 0) + 1 : 0;
    const ending = !surge && (resume || passes >= HEALTHY_PASSES);
    let endRefused;
    if (ending) {
      const ew = write({ ...cur.doc, state: 'ended', healthy_passes: passes, ended_at: new Date(now).toISOString(), ended_by: resume ? 'joe' : 'healthy', counted_dead: [...new Set(dead.map(deathKey))] }, 'outage_end');
      // Refused (L765), the pass goes on as one inside the outage: its new deaths are held, an undelivered alert retold.
      if (!ew?.ok) endRefused = ew?.reason ?? 'refused';
    }
    if (ending && !endRefused) {
      // Sessions that died in the outage left the board; they are decided now, with the newly dead.
      const held = held0.filter((d) => !dead.some((s) => s.id === d.id));
      return { outage: false, ended: true, ...decide(rec, [...held, ...dead]) };
    }
    const more = dead.filter((s) => !held0.some((d) => d.id === s.id)).map((s) => ({ id: s.id, card: s.card ?? null }));
    const pw = write({ ...cur.doc, healthy_passes: passes, dead: [...held0, ...more] }, 'outage_pass');
    const passRefused = pw?.ok ? undefined : (pw?.reason ?? 'refused');
    // An outage whose alert the queue refused is told each pass until delivered (L130); the mark names the outage.
    if (cur.doc.told_id !== cur.doc.id) tellThen(alert, cur.doc.alert_text ?? `running sessions stopped at once (${cur.doc.id}); nothing is restarted until you say resume`, { fact: OUTAGE_FACT, fields: { told_id: cur.doc.id }, kind: 'outage_told' });
    return { outage: true, ended: false, restart: [], asks: [], ...(endRefused ? { endRefused } : {}), ...(passRefused ? { passRefused } : {}) };
  }
  const fresh = dead.filter((s) => !counted.has(deathKey(s)));
  // The board less the deaths already counted: those were not running at the previous pass (review of L759).
  const running = board.length - (dead.length - fresh.length);
  if (canEnd && tripped(fresh.length, running, minDead, share)) {
    const id = `outage-${new Date(now).toISOString()}`;
    const text = `${fresh.length} of ${running} running sessions stopped at once (${id}). Nothing will be restarted until the network, sign-in and usage are back, or you say resume.`;
    const w = write({ id, state: 'open', started_at: new Date(now).toISOString(), dead: dead.map((s) => ({ id: s.id, card: s.card ?? null })), board: board.length, running, healthy_passes: 0, alert_text: text }, 'outage_start');
    if (w.ok) tellThen(alert, text, { fact: OUTAGE_FACT, fields: { told_id: id }, kind: 'outage_told' });
    return { outage: true, ended: false, restart: [], asks: [] };
  }
  const keys = [...new Set(dead.map(deathKey))];
  let countedRefused;
  // Kept on an ended outage's fact as it is (only 'open' is read, and a new outage replaces the whole fact); 'none'
  // when there has been no outage.
  if (keys.length !== counted.size || keys.some((k) => !counted.has(k))) {
    const w = write({ ...(cur?.doc ?? {}), state: cur?.doc?.state ?? 'none', counted_dead: keys }, 'outage_counted');
    if (!w.ok) countedRefused = w.reason ?? 'refused';
  }
  return { outage: false, ended: false, ...decide(rec, dead), ...(countedRefused ? { countedRefused } : {}) };
}

// M10: restart only a card marked safe to re-run; any other becomes an ask (m18).
function decide(rec, dead) {
  const restart = [];
  const asks = [];
  const cards = {};
  for (const s of dead) {
    const card = s.card ? rec.read('card', s.card)?.doc : null;
    if (card?.rerun_safe === true) { restart.push(s.id); cards[s.id] = s.card; }
    else if (s.card) asks.push(s.card);
  }
  // `cards` maps each restarted session to its card: a session held through an outage is off the board.
  return { restart, asks, cards };
}
