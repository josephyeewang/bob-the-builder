// research-ask.mjs — research asks (R-0b-136): the owner says "find out X" to the Front Door, and the ask, with its brief,
// goes on the owner's "waiting on you" list. The owner runs it by saying "run research ask R-12" in a desktop session on
// the Mini; that session leaves `research-R-12.md` in the proposals folder, and the Dispatcher takes it in only while the
// ask is open (lane 2's R-0b-135), copying it into the product's docs/research/ on a go-free research_copy card.
//
// WHY HERE. Only M2 (actor `approvals`) writes asks. The Front Door's `ask-request-` file is kept by the record as an
// inert report (0b-2 R3-M2); this pass is the one place that turns it into an ask, after checking its text again with
// the Front Door's own check (M1 outbox.mjs), so a report that was changed or never checked opens nothing.
//
//   openResearchAsks(ctx) → { opened: [{ id, push }], refused: [{ report, reason }] }   one ask per report, restart-safe;
//                           a refused report is never opened; it is alerted once per report and reason (kept in
//                           ctx.stateDir, like schedule.mjs's config alert), or on every pass when there is no stateDir
//   researchBrief(record, id) → { ok, id, product, brief, file } | { ok: false, reason }  for the desktop session
//   landResearch(ctx, id) → the record's answer                                         the ask leaves the waiting list
//
// The ask's `wait` is what the waiting list shows (M13 waiting.mjs): who (joe), what (the run line and the brief), since.
// A research ask is not an ASK_KINDS kind: nothing pushes a question box for it or lapses it (M2 schedule.mjs skips
// kinds it doesn't know); the owner answers by running it, not by a tap.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOutboxFile } from '../M1-front-door/outbox.mjs';
import { askStore, writeDoc } from './ask-store.mjs';

export const RESEARCH_ID = /^R-[1-9]\d{0,5}$/;
export const runLine = (id) => `run research ask ${id}`;
export const researchFileName = (id) => `research-${id}.md`;
const DAY_MS = 24 * 3600_000;
const iso = (ms) => new Date(ms).toISOString();

function nextId(record) {
  // Every ask id counts, trusted or not, so a new ask never lands on an existing one.
  const n = record.list('ask').map((a) => /^R-(\d+)$/.exec(String(a.id))?.[1]).filter(Boolean).map(Number);
  return `R-${(n.length ? Math.max(...n) : 0) + 1}`;
}

export const claimedAsk = (text) => { try { return JSON.parse(String(text ?? ''))?.ask; } catch { return undefined; } };

// A refused report is alerted once per report and reason, not every pass (audit kit-lane3 r1 Minor 11). The file
// holds the reports still refused, so a report that stops being refused (it opened, or left the record) is dropped,
// and one refused for a new reason is alerted again.
function refusedAlerts(ctx, refused) {
  if (!ctx.stateDir) { for (const f of refused) ctx.alert?.({ kind: 'ask_request_refused', ...f }); return; }
  const file = join(ctx.stateDir, 'research-refused.json');
  let last = {};
  try { last = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) ?? {} : {}; } catch { last = {}; }
  const now = {};
  for (const f of refused) {
    now[f.report] = f.reason;
    if (last[f.report] !== f.reason) ctx.alert?.({ kind: 'ask_request_refused', ...f });
  }
  // A state file that can't be saved is alerted, never thrown: the pass must still hand back the asks it opened, so
  // their "on your waiting list" push goes out (L84 3). The cost is only that a refusal may be alerted again.
  try { mkdirSync(ctx.stateDir, { recursive: true }); writeFileSync(file, `${JSON.stringify(now)}\n`); }
  catch (e) { ctx.alert?.({ kind: 'research_refused_state_not_saved', reason: String(e?.code ?? e?.message ?? e) }); }
}

export function openResearchAsks(ctx) {
  const { record, product, now } = ctx;
  const st = askStore(record);
  const done = new Set(record.list('ask').map((a) => a.doc?.request).filter(Boolean));
  const opened = []; const refused = [];
  for (const rep of record.list('report')) {
    const d = rep.doc;
    if (!d || d.kind !== 'ask-request-' || done.has(rep.id)) continue;
    // An undo request is undo-flag.mjs's (R-0b-140), which runs every check itself; this pass only routes on the claim.
    if (claimedAsk(d.text) === 'undo') continue;
    const no = (reason) => { refused.push({ report: rep.id, reason }); };
    if (d.role !== 'front_door') { no('an ask request comes only from the Front Door'); continue; }
    const r = checkOutboxFile(String(d.source ?? ''), String(d.text ?? ''));
    if (!r.ok) { no(r.reason); continue; }
    if (r.kind !== 'ask-request') { no('not an ask request'); continue; }
    if (r.doc.product !== product) { no('that product is not this record\'s'); continue; }
    const id = nextId(record);
    const t = now();
    const doc = { kind: 'research', product, title: r.doc.brief, state: 'open', created_at: iso(t), request: rep.id,
      origin_session: d.session_id ?? null,
      wait: { who: 'joe', what: `"${runLine(id)}" in a desktop session on the Mini: ${r.doc.brief}`, since: iso(t), next_check: iso(t + DAY_MS) } };
    const w = writeDoc(record, 'ask', { id, rev: 0 }, doc);
    if (!w.ok) { no(`the record refused the ask: ${w.reason}`); continue; }
    done.add(rep.id);
    opened.push({ id, push: `On your waiting list: research ask ${id} for ${product}: ${r.doc.brief}. To run it, open a desktop session on the Mini and say "${runLine(id)}".` });
  }
  if (st.untrusted.length) ctx.alert?.({ kind: 'untrusted_ask', items: st.untrusted });
  refusedAlerts(ctx, refused);
  return { opened, refused };
}

// What the desktop session needs when the owner says "run research ask R-12": nothing pasted, all from the record.
export function researchBrief(record, id) {
  if (!RESEARCH_ID.test(String(id))) return { ok: false, reason: 'a research ask is R- and a number, such as R-12' };
  const a = askStore(record).ask(id);
  if (!a || a.doc.kind !== 'research') return { ok: false, reason: `there is no research ask ${id}` };
  if (a.doc.state !== 'open' || !a.doc.wait) return { ok: false, reason: `research ask ${id} is not open` };
  return { ok: true, id, product: a.doc.product, brief: a.doc.title, file: researchFileName(id) };
}

// Once the Dispatcher has the report on its research_copy card, the ask stops waiting on the owner. It stays open, so
// the record still binds that card to it; a second report for it is refused (one copy card per ask, M9 writer).
export function landResearch(ctx, id) {
  const { record, now } = ctx;
  const a = askStore(record).ask(id);
  if (!a || a.doc.kind !== 'research' || a.doc.state !== 'open') return { ok: false, reason: `no open research ask ${id}` };
  if (!a.doc.wait) return { ok: true, already: true };
  const card = record.list('card').find((c) => c.doc?.kind === 'research_copy' && c.doc.research_ask === id);
  if (!card) return { ok: false, reason: `research ask ${id} has no research_copy card yet` };
  const { wait, ...rest } = a.doc;
  return writeDoc(record, 'ask', a, { ...rest, landed: { card: card.id, at: iso(now()) } });
}
