// restart.mjs — when the Front Door is restarted after a quiet spell, and the handoff a script makes for it
// (R-0b-82; design v4 §5.5, R6; review-0b-8 MAT-1, MAT-2, MAT-3, minors 1 and 2).
//
// The pure decision and the handoff text sit here in M1 although the row is tagged M11 (lane constraint, review
// cosmetic 1). Stopping and starting the session under its fixed name, and delivering the handoff (its first prompt,
// or a read-only file outside the outbox, which is emptied at start), are lane 2's launcher's: join item.
//
// One path only: size past 150k AND the owner quiet 15+ minutes AND no question box open AND the last turn finished.
// Front Door 250k = launch compaction limit, owned by lane 2's launcher and the role profile; it fires whether or
// not a question is open. Nothing here restarts at 250k.

import { ownerTurns, ownerTurnsWithReplies, lastTurnFinished, openQuestions } from './transcript.mjs';
import { stripControls, cleanOutside } from '../M12-sensors/escape.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';

const { maskSecrets } = makeMasker();

export const RESTART_TOKENS = 150_000;
export const QUIET_MIN = 15;
export const HANDOFF_BUDGET_CHARS = 9_000; // the 3k-token cap, estimated at ~3 characters a token
export const LAST_TURNS = 5;
export const KEEP_TURNS = LAST_TURNS; // asks are cut before any of these (the waiting list holds every ask)

export function shouldRestartFrontDoor({ sizeTokens, entries, now = () => new Date(), startedAt = null }) {
  const no = (reason) => ({ restart: false, reason });
  if (!Number.isFinite(sizeTokens)) return no('size unknown');
  if (sizeTokens <= RESTART_TOKENS) return no(`size ${sizeTokens} is not past ${RESTART_TOKENS}`);
  if (openQuestions(entries).length) return no('question open; compaction at 250k is the launcher\'s');
  if (!lastTurnFinished(entries)) return no('the last turn has not finished');
  // The latest timed turn of the owner's; session start only when none has a time (0b-8 audit round 1, minor 10). If their
  // newest turn has no time, quiet can't be measured from it: no restart (round 2 minor 1).
  const all = ownerTurns(entries);
  if (all.length && !Number.isFinite(all.at(-1).at)) return no('the owner\'s newest turn has no time');
  const timed = all.map((t) => t.at).filter(Number.isFinite);
  const last = timed.length ? Math.max(...timed) : (startedAt ? Date.parse(startedAt) : null);
  if (!Number.isFinite(last)) return no('no turn of the owner\'s to measure quiet from');
  const quiet = (now().getTime() - last) / 60e3;
  if (quiet < QUIET_MIN) return no(`the owner was last active ${Math.floor(quiet)} min ago (needs ${QUIET_MIN})`);
  return { restart: true, reason: `size ${sizeTokens}, quiet ${Math.floor(quiet)} min, no question open, last turn finished` };
}

// openAsks: [{ id, what, link }] from the record (M13 waiting list). strikes: from the tried-and-failed log, if any.
// rereadList: paths, from config. Returns text only; writes nothing.
export function makeFrontDoorHandoff({ entries, openAsks = [], strikes = 0, rereadList = [], now = () => new Date(), budget = HANDOFF_BUDGET_CHARS }) {
  const clean = (s) => cleanOutside(String(s ?? ''), 'front-door-turn');
  const turns = ownerTurnsWithReplies(entries).slice(-LAST_TURNS);
  // ids, links and paths come from the record and config: masked (never fenced, they are not prose); text is fenced.
  const m = (v) => maskSecrets(stripControls(String(v ?? ''))).text;
  const asks = openAsks.map((a) => `- ${m(a.id)}: ${cleanOutside(String(a.what ?? ''), 'record-ask')}${a.link ? ` (${m(a.link)})` : ''}`);

  const render = (ts, askLines, dropped, askMore) => [
    `# Front Door handoff (script-made, ${now().toISOString()}; size cap 3k tokens, estimated as ${budget} characters)`,
    '',
    '## 1. Decisions made in this conversation, not yet in the record',
    'The script cannot tell decisions apart; the owner\'s last messages and the replies are below. Ask the owner before treating any as decided.',
    ...(dropped ? [`(${dropped} older message(s) left out to stay under the cap.)`] : []),
    ...ts.flatMap((t) => [`- The owner (${t.kind === 'answer' ? 'question-box answer' : t.kind === 'declined' ? 'declined a question box' : 'message'}, ${t.at ? new Date(t.at).toISOString() : 'time unknown'}): ${clean(t.text)}`,
      `  Reply: ${t.reply ? clean(t.reply) : '(none)'}`]),
    '',
    '## 2. Open questions waiting on the owner',
    ...(askLines.length ? askLines : ['- none in the record']),
    ...(askMore ? [`- and ${askMore} more: see the waiting list`] : []),
    '',
    '## 3. Current step and next action',
    '- Restarted after a quiet spell; no question box was open and nothing was mid-turn. Next: wait for the owner.',
    '',
    `## 4. Tried and failed\n- strikes: ${strikes}`,
    '',
    '## 5. Re-read list',
    ...(rereadList.length ? rereadList.map((p) => `- ${m(p)}`) : ['- none']),
    '',
    '## 6. Don\'t redo, don\'t re-ask',
    '- Do not ask again what the owner answered above; do not re-file ideas they already filed.',
    '',
  ].join('\n');

  // Cut order: older turns down to KEEP_TURNS, then asks from the end (the waiting list has them all; the owner's words exist
  // only here), then older turns again, the owner's newest turn last (0b-8 audit round 1, minor 1).
  let ts = turns; let askLines = asks; let askMore = 0;
  let text = render(ts, askLines, 0, 0);
  const again = () => { text = render(ts, askLines, turns.length - ts.length, askMore); };
  while (text.length > budget && ts.length > KEEP_TURNS) { ts = ts.slice(1); again(); }
  while (text.length > budget && askLines.length) { askLines = askLines.slice(0, -1); askMore += 1; again(); }
  while (text.length > budget && ts.length > 1) { ts = ts.slice(1); again(); }
  while (text.length > budget && askLines.length) { askLines = askLines.slice(0, -1); askMore += 1; again(); }
  while (text.length > budget && ts.length) { ts = ts.slice(1); again(); }
  if (text.length > budget) text = `${text.slice(0, budget - 40)}\n…[cut to stay under the cap]\n`;
  return text;
}
