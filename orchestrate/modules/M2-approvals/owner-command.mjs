// owner-command.mjs — a Tier-2 go the owner gives by typing a command on the Mac, not by tapping a question box
// (LEAD-CALLS L1082, L1096; lane N, N2). The command is setup/go-card.mjs; this file is its one write to an ask, here
// because only M2 writes asks (ask-store.mjs writeDoc).
//
//   answerByOwnerCommand(ctx, askId, { sudoUid, cardJsonSha256 }) → { ok: true, answer } | { ok: false, reason }
//
// WHY. The first run on the test product needs a go before any phone channel is wired. The lead allowed one path for it
// (L1082: the first run, Tier 2 cards only, the test product only) and fixed how it is recorded (L1096 Q10 (a)):
//   - the answer's channel is 'tap', the Tier-2 channel M10's count_approval knows, so the same rule that counts a tap
//     counts this one, and refuses it for a Tier-1 go or a risky class just as it would refuse a tap;
//   - the answer carries `binding: { kind: 'owner_command', sudo_uid, at, card_json_sha256 }`, which M2 recordGo copies onto
//     the go record. Anywhere a go is shown to the owner it must show binding.kind, so a command go is never presented as a
//     phone tap (L1096). Today no code shows a go to the owner; owner-command.test.mjs fails when a new reader of go
//     records appears, so that reader is made to show it.
// Who may run the command (the owner, through sudo, retyping the card id at a real terminal) is the command's to check;
// this file checks only the ask.
//
// HOW. The ask must be this product's live Tier-2 go ask. A tap ask moves open → pushed → answered (M9 moves.mjs), so an
// open one is first marked pushed (the command has just shown it on the owner's screen), then answered. Any question box
// still bound to it in a session is released as 'answered_elsewhere', as binding.mjs does when an ask is answered
// elsewhere. M2 recordGo then turns the answer into the go record, unchanged.

import { activeKind } from '../../shared/asks.mjs';
import { answerCounts } from '../../shared/approval.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { releaseBoxes } from './binding.mjs';

export const OWNER_COMMAND = 'owner_command';
// The one ask kind a command may answer (L1082: Tier 2 only).
export const OWNER_COMMAND_KIND = 'go_t2';
const SHA256 = /^[0-9a-f]{64}$/;
const iso = (ms) => new Date(ms).toISOString();
const fail = (reason) => ({ ok: false, reason });

export function answerByOwnerCommand(ctx, askId, { sudoUid, cardJsonSha256 } = {}) {
  if (!Number.isSafeInteger(sudoUid) || sudoUid <= 0) return fail('the owner\'s user id (sudo_uid) is missing');
  if (typeof cardJsonSha256 !== 'string' || !SHA256.test(cardJsonSha256)) return fail('the card file\'s sha256 is missing');
  const st = askStore(ctx.record);
  let a = st.ask(askId);
  if (!a) return fail(`no trusted ask ${askId}`);
  if (a.doc.kind !== OWNER_COMMAND_KIND) return fail(`a command may answer only a Tier-2 go, and ask ${askId} is a ${a.doc.kind} ask`);
  if (a.doc.product !== ctx.product) return fail(`ask ${askId} belongs to product ${a.doc.product}`);
  if (a.doc.tier !== 2) return fail(`ask ${askId} is not a Tier-2 go`);
  if (!['open', 'pushed'].includes(a.doc.state)) return fail(`ask ${askId} is ${a.doc.state}, so it can't be answered`);
  const k = activeKind(a.doc.kind);
  const choice = k?.choices?.[0];
  if (typeof choice !== 'string' || a.doc.choices?.[0] !== choice) return fail(`ask ${askId} does not offer ${JSON.stringify(choice ?? null)} first`);
  const at = iso(ctx.now());
  const answer = { channel: 'tap', choice, approves: true, at, binding: { kind: OWNER_COMMAND, sudo_uid: sudoUid, at, card_json_sha256: cardJsonSha256 } };
  const counted = answerCounts(ctx.rules, { ...a.doc, answer }, { product: ctx.product, approves: true });
  if (!counted.ok) return fail(`the rules do not count this go: ${counted.reason}`);
  if (counted.tier !== 2) return fail('the rules count this go only at Tier 1');
  if (a.doc.state === 'open') {
    const w = writeDoc(ctx.record, 'ask', a, { ...structuredClone(a.doc), state: 'pushed', shown_by: OWNER_COMMAND, shown_at: at });
    if (!w.ok) return fail(`the record refused the ask's shown mark: ${w.reason}`);
    a = st.ask(askId);
    if (!a || a.doc.state !== 'pushed') return fail(`ask ${askId} changed while it was being answered`);
  }
  const doc = structuredClone(a.doc);
  releaseBoxes(doc, 'answered_elsewhere', ctx.now(), { moveBack: false });
  const w = writeDoc(ctx.record, 'ask', a, { ...doc, state: 'answered', answer });
  return w.ok ? { ok: true, answer } : fail(`the record refused the answer: ${w.reason}`);
}
