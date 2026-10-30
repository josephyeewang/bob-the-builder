// Dead sessions and outages (R-0b-56, R-0b-60; design v4 G1, R4; review 0b-6 M9, M10, m18).
//
// Dead (G1) = the process group is gone AND the session has ended AND its transcript has had no
// write for timeouts.dead_quiet_min. The board = sessions meant to run that were running at the
// previous pass, Mac-wide. If, within one pass, the newly dead reach max(outage.min_dead,
// ceil(outage.share × board)), it is an outage: nothing restarts, and Joe gets one alert per outage.
// The outage ends by itself after 2 passes in a row with the network up, the Mini signed in and
// usage readable, or on Joe's "resume". Outside an outage, a dead session's card is restarted only
// when `rerun_safe === true`; any other card becomes an ask (waiting on Joe), never a restart.

import { KEYS, need, minutes } from './keys.mjs';

export const OUTAGE_FACT = 'outage';
export const HEALTHY_PASSES = 2;

/** G1. `s` = { alive, ended, lastWriteAt } as observed this pass. Unknown parts are not dead. */
export function isDead(s, { now, quietMs }) {
  return s.alive === false && s.ended === true && Number.isFinite(s.lastWriteAt) && now - s.lastWriteAt >= quietMs;
}

/**
 * One pass's outage step. `board` = [{ id, card, alive, ended, lastWriteAt }] for the sessions on
 * the board. `healthy` = network up and signed in and usage readable, this pass. `resume` = Joe
 * said resume. Returns { outage, ended, restart: [session ids], asks: [card ids], cards: {session id: card} }; writes the
 * outage fact and raises at most one alert per outage.
 */
export function outageStep({ rec, rules, board, now, healthy, resume = false, alert }) {
  const quietMs = minutes(rules, KEYS.deadQuietMin);
  const minDead = need(rules, KEYS.outageMinDead);
  const share = need(rules, KEYS.outageShare);
  const dead = board.filter((s) => isDead(s, { now, quietMs }));
  const cur = rec.read('fact', OUTAGE_FACT);
  const open = cur?.doc?.state === 'open';
  const write = (doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id: OUTAGE_FACT, expectRev: cur?.rev ?? 0, doc, kind });

  if (open) {
    const passes = healthy ? (cur.doc.healthy_passes ?? 0) + 1 : 0;
    if (resume || passes >= HEALTHY_PASSES) {
      write({ ...cur.doc, state: 'ended', healthy_passes: passes, ended_at: new Date(now).toISOString(), ended_by: resume ? 'joe' : 'healthy' }, 'outage_end');
      // Sessions that died in the outage left the board; they are decided now, with the newly dead.
      const held = (cur.doc.dead ?? []).filter((d) => !dead.some((s) => s.id === d.id));
      return { outage: false, ended: true, ...decide(rec, [...held, ...dead]) };
    }
    const more = dead.filter((s) => !(cur.doc.dead ?? []).some((d) => d.id === s.id)).map((s) => ({ id: s.id, card: s.card ?? null }));
    write({ ...cur.doc, healthy_passes: passes, dead: [...(cur.doc.dead ?? []), ...more] }, 'outage_pass');
    return { outage: true, ended: false, restart: [], asks: [] };
  }
  const threshold = Math.max(minDead, Math.ceil(share * board.length));
  if (board.length && dead.length >= threshold) {
    const id = `outage-${new Date(now).toISOString()}`;
    const w = write({ id, state: 'open', started_at: new Date(now).toISOString(), dead: dead.map((s) => ({ id: s.id, card: s.card ?? null })), board: board.length, healthy_passes: 0 }, 'outage_start');
    if (w.ok) alert(`${dead.length} of ${board.length} running sessions stopped at once (${id}). Nothing will be restarted until the network, sign-in and usage are back, or you say resume.`);
    return { outage: true, ended: false, restart: [], asks: [] };
  }
  return { outage: false, ended: false, ...decide(rec, dead) };
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
