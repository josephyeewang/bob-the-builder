// restart.mjs — when the Front Door is restarted after a quiet spell, and the handoff a script makes for it
// (R-0b-82; design v4 §5.5, R6; review-0b-8 MAT-1, MAT-2, MAT-3, minors 1 and 2).
//
// The pure decision and the handoff text sit here in M1 although the row is tagged M11 (lane constraint, review
// cosmetic 1). Stopping and starting the session under its fixed name, and delivering the handoff (its first prompt,
// or a read-only file outside the outbox, which is emptied at start), are lane 2's launcher's: join item.
//
// One path only: size past 150k AND Joe quiet 15+ minutes AND no question box open AND the last turn finished.
// Front Door 250k = launch compaction limit, owned by lane 2's launcher and the role profile; it fires whether or
// not a question is open. Nothing here restarts at 250k.

import { joeTurns, joeTurnsWithReplies, lastTurnFinished, openQuestions } from './transcript.mjs';
import { cleanOutside } from '../M12-sensors/escape.mjs';

export const RESTART_TOKENS = 150_000;
export const QUIET_MIN = 15;
export const HANDOFF_BUDGET_CHARS = 9_000; // the 3k-token cap, estimated at ~3 characters a token
export const LAST_TURNS = 5;

export function shouldRestartFrontDoor({ sizeTokens, entries, now = () => new Date(), startedAt = null }) {
  const no = (reason) => ({ restart: false, reason });
  if (!Number.isFinite(sizeTokens)) return no('size unknown');
  if (sizeTokens <= RESTART_TOKENS) return no(`size ${sizeTokens} is not past ${RESTART_TOKENS}`);
  if (openQuestions(entries).length) return no('question open; compaction at 250k is the launcher\'s');
  if (!lastTurnFinished(entries)) return no('the last turn has not finished');
  const last = joeTurns(entries).at(-1)?.at ?? (startedAt ? Date.parse(startedAt) : null);
  if (!Number.isFinite(last)) return no('no turn of Joe\'s to measure quiet from');
  const quiet = (now().getTime() - last) / 60e3;
  if (quiet < QUIET_MIN) return no(`Joe was last active ${Math.floor(quiet)} min ago (needs ${QUIET_MIN})`);
  return { restart: true, reason: `size ${sizeTokens}, quiet ${Math.floor(quiet)} min, no question open, last turn finished` };
}

// openAsks: [{ id, what, link }] from the record (M13 waiting list). strikes: from the tried-and-failed log, if any.
// rereadList: paths, from config. Returns text only; writes nothing.
export function makeFrontDoorHandoff({ entries, openAsks = [], strikes = 0, rereadList = [], now = () => new Date(), budget = HANDOFF_BUDGET_CHARS }) {
  const clean = (s) => cleanOutside(String(s ?? ''), 'front-door-turn');
  const turns = joeTurnsWithReplies(entries).slice(-LAST_TURNS);
  const asks = openAsks.map((a) => `- ${a.id}: ${cleanOutside(String(a.what ?? ''), 'record-ask')}${a.link ? ` (${a.link})` : ''}`);

  const render = (ts, askLines, dropped, askMore) => [
    `# Front Door handoff (script-made, ${now().toISOString()}; size cap 3k tokens, estimated as ${budget} characters)`,
    '',
    '## 1. Decisions made in this conversation, not yet in the record',
    'The script cannot tell decisions apart; Joe\'s last messages and the replies are below. Ask Joe before treating any as decided.',
    ...(dropped ? [`(${dropped} older message(s) left out to stay under the cap.)`] : []),
    ...ts.flatMap((t) => [`- Joe (${t.kind === 'answer' ? 'question-box answer' : 'message'}, ${t.at ? new Date(t.at).toISOString() : 'time unknown'}): ${clean(t.text)}`,
      `  Reply: ${t.reply ? clean(t.reply) : '(none)'}`]),
    '',
    '## 2. Open questions waiting on Joe',
    ...(askLines.length ? askLines : ['- none in the record']),
    ...(askMore ? [`- and ${askMore} more: see the waiting list`] : []),
    '',
    '## 3. Current step and next action',
    '- Restarted after a quiet spell; no question box was open and nothing was mid-turn. Next: wait for Joe.',
    '',
    `## 4. Tried and failed\n- strikes: ${strikes}`,
    '',
    '## 5. Re-read list',
    ...(rereadList.length ? rereadList.map((p) => `- ${p}`) : ['- none']),
    '',
    '## 6. Don\'t redo, don\'t re-ask',
    '- Do not ask again what Joe answered above; do not re-file ideas he already filed.',
    '',
  ].join('\n');

  // Cut order: older turns first, then asks from the end (the waiting list has them all), then Joe's newest turn last.
  let ts = turns; let askLines = asks; let askMore = 0;
  let text = render(ts, askLines, 0, 0);
  const again = () => { text = render(ts, askLines, turns.length - ts.length, askMore); };
  while (text.length > budget && ts.length > 1) { ts = ts.slice(1); again(); }
  while (text.length > budget && askLines.length) { askLines = askLines.slice(0, -1); askMore += 1; again(); }
  while (text.length > budget && ts.length) { ts = ts.slice(1); again(); }
  if (text.length > budget) text = `${text.slice(0, budget - 40)}\n…[cut to stay under the cap]\n`;
  return text;
}
