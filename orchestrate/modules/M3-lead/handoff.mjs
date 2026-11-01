// The Lead's handoff note and resume card (R-0b-143), so a Lead that restarts (compaction, a crash, a new day) picks up
// where it stopped without asking the owner anything already settled.
//
// The Lead writes its handoff as a `handoff-` outbox file (role profile compactKind 'handoff') in this one shape:
//   # Lead handoff
//   ## Claim          what this Lead holds: product and session
//   ## Open card      the card it was working on, or "none"
//   ## Next step      the one next thing it was about to do
//   ## Decisions      "- <about>: <what was decided> (<when>)", one per line, or "none"
//   ## Messages       the messages still to answer or act on, one per line, or "none"
// Every heading must be there, once, in this order; a handoff missing one is refused, so a restart never starts from
// half a note. The resume card is what the restarted Lead reads first.

const HEADS = Object.freeze(['Claim', 'Open card', 'Next step', 'Decisions', 'Messages']);
const NONE = 'none';
const DECISION = /^- (.+?): (.+) \(([^()]+)\)$/;

/** h: { claim, open_card, next, decisions: [{ about, decided, when }], messages: [] } → the note's text. */
export function handoffText(h) {
  const list = (xs, f) => (xs?.length ? xs.map(f).join('\n') : NONE);
  const one = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
  return [
    '# Lead handoff',
    `## Claim\n${one(h.claim)}`,
    `## Open card\n${one(h.open_card) || NONE}`,
    `## Next step\n${one(h.next)}`,
    `## Decisions\n${list(h.decisions, (d) => `- ${one(d.about).replace(/:/g, ' -')}: ${one(d.decided)} (${one(d.when).replace(/[()]/g, '')})`)}`,
    `## Messages\n${list(h.messages, (m) => `- ${one(m)}`)}`,
  ].join('\n\n') + '\n';
}

/** → { ok: true, claim, open_card, next, decisions, messages } | { ok: false, reason } */
export function readHandoff(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!s.startsWith('# Lead handoff\n')) return { ok: false, reason: 'not a Lead handoff' };
  const found = [...s.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  if (found.join('|') !== HEADS.join('|')) return { ok: false, reason: `the headings must be exactly ${HEADS.join(', ')}, in that order` };
  const body = Object.fromEntries(s.split(/^## /m).slice(1).map((part) => {
    const [head, ...rest] = part.split('\n');
    return [head.trim(), rest.join('\n').trim()];
  }));
  for (const k of ['Claim', 'Next step']) if (!body[k]) return { ok: false, reason: `the handoff has no ${k}` };
  const lines = (k) => (body[k] === NONE || !body[k] ? [] : body[k].split('\n').map((l) => l.trim()).filter(Boolean));
  const decisions = [];
  for (const l of lines('Decisions')) {
    const m = DECISION.exec(l);
    if (!m) return { ok: false, reason: `a decision line is not "- <about>: <decided> (<when>)": ${l}` };
    decisions.push({ about: m[1], decided: m[2], when: m[3] });
  }
  const messages = lines('Messages').map((l) => l.replace(/^- /, ''));
  return { ok: true, claim: body.Claim, open_card: body['Open card'] === NONE ? null : body['Open card'], next: body['Next step'], decisions, messages };
}

/** The decision about `topic` (its words, any case), or null. */
export function decisionAbout(h, topic) {
  const t = String(topic ?? '').toLowerCase().trim();
  return h.decisions.find((d) => d.about.toLowerCase() === t) ?? h.decisions.find((d) => t && d.about.toLowerCase().includes(t)) ?? null;
}

/** The resume card: what a restarted Lead reads before anything else. Throws on a handoff that does not read. */
export function resumeCard(text) {
  const h = readHandoff(text);
  if (!h.ok) throw new Error(`the handoff can't be resumed from: ${h.reason}`);
  return [
    '# Resume card',
    `You are the Lead, restarted. You hold: ${h.claim}.`,
    h.open_card ? `Your open card is ${h.open_card}. Carry on with it: ${h.next}` : `You have no open card. Next: ${h.next}`,
    'What was already decided. When anyone asks what was decided about one of these, answer from this list; do not ask the owner again:',
    h.decisions.length ? h.decisions.map((d) => `- ${d.about}: ${d.decided} (${d.when})`).join('\n') : '- nothing yet',
    'Messages still to answer or act on:',
    h.messages.length ? h.messages.map((m) => `- ${m}`).join('\n') : '- none',
  ].join('\n\n') + '\n';
}
