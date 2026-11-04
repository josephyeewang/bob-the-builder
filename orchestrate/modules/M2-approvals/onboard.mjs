// onboard.mjs — a product's record is made the first time its rules file says it is on (LEAD-CALLS L204-b, L209, L221).
//
// WHY. Nothing made a product's record before: every module reads `product` in M9 and finds none, so a newly onboarded
// product never started. The one "on" switch is `onboarding.state: active` in the product's rules file (first-cutover.mjs
// requires it), and Approvals, which owns the product record's states, makes the record from it: state active, written
// as `approvals`, diary kind `onboard`. The Dispatcher's `approvals` step runs the schedule pass that calls this, every
// tick, before its main pass (M11 tick.mjs, L221 MAT-1).
//
//   onboard(ctx) → null | { type: 'onboarded', product } | { type: 'onboard_refused', product, reason }
//                       | { type: 'onboard_near_miss', product, value }
//   onboardNotices(ctx, made)   what Joe is told about it (below)
//   ctx = { record, rules, product, alert, stateDir }
//
// Create-if-missing only (L209 1): a record in any state, a corrupt one included, is never touched, so a product the
// owner paused stays paused whatever its rules file says. Only the exact text `active` turns it on; a missing key, any
// other text or type, or rules that can't be read make nothing. Rules M10 kept from the last good file count (last_good).
//
// What Joe is told (L221 m-1, m-2, c-4), each sentence on ONBOARD_SHOWN (pinned in shared/no-promise.test.mjs):
//   - the record was made: one "now on" notice. It is marked due BEFORE the record is written (L295 MAT-1): a mark
//     that can't be saved throws, so the product is not turned on and the step's failure alert tells Joe; a product
//     on with no mark to tell it can't happen. The mark holds the diary's last line number at that moment, and the
//     notice goes out only while the record's onboard line comes after it, so a mark left in an old folder never
//     re-tells a product that has long been on (L295 Minor 3; it is cleared unsent). A mark that can't be read, has the
//     wrong shape or is missing is unsure: a product approvals turned on is told once more (L309 Minor 3, L331 Minor 1).
//     Cleared only once the sink took it, so a lost send is sent again next pass, never lost (a lost clear sends it twice);
//   - the key is there but is not exactly `active` (`Active`, `[active]`, `active `) and there is no record: told at
//     once for each new value, then again each day while it stands (L315). A missing key stays silent: a product not
//     yet onboarded is normal (L129);
//   - the create was refused: told at once for each new reason (its numbers out, so a moving rev is one reason), then
//     again each day while it stands (L326): the product never turns on, so a once-ever message is a silent hold. M9's
//     own `refused` alert still goes out from the store each time; this one says which product was not turned on.
//   Both are one wait on shared stillWaiting, with one mark. It goes once the product is on or the cause goes.
// Kept in ctx.stateDir (onboard-notices.json). With no stateDir nothing is kept, so each is told every pass.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stillWaiting } from '../../shared/still-waiting.mjs';

export const ONBOARD_KEY = 'onboarding.state';
const NOTICES = 'onboard-notices.json';

const shownValue = (v) => {
  let s;
  try { s = JSON.stringify(v); } catch { s = undefined; }
  if (typeof s !== 'string') s = String(typeof v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

export const ONBOARD_SHOWN = Object.freeze({
  on: (p) => `${p} is now on: its rules file says onboarding.state: active.`,
  nearMiss: (p, v) => `${p} was not turned on: onboarding.state is ${shownValue(v)}, and only the exact word active turns a product on.`,
  refused: (p, reason) => `${p} was not turned on: ${reason}`,
});

export function onboard(ctx) {
  if (ctx.record.read('product', ctx.product) !== null) return null;
  // makeRules().get already answers undefined for rules it can't read (shared/rules.mjs), so no catch here: a get that
  // throws is a broken rules port, and the pass fails loudly through the Dispatcher's step-error alert.
  const on = ctx.rules?.get?.('onboarding.state', { product: ctx.product });
  if (on === undefined) return null;
  if (on !== 'active') return { type: 'onboard_near_miss', product: ctx.product, value: on };
  // Due first (L295 MAT-1): saveNotices throws when the folder can't be written, and nothing is turned on.
  if (ctx.stateDir) { const n = readNotices(ctx); n.due = lastLine(ctx.record); saveNotices(ctx, n); }
  const w = ctx.record.write({ actor: 'approvals', entity: 'product', id: ctx.product, expectRev: 0, doc: { state: 'active' }, kind: 'onboard' });
  return w.ok ? { type: 'onboarded', product: ctx.product } : { type: 'onboard_refused', product: ctx.product, reason: w.reason };
}

// The mark names the diary's last line when it was made: its number and its time, both the Record's own (L309 MAT-1:
// no clock is compared, so a slow pass or a Mac asleep mid-pass can't drop it). It is this Record's mark when that line
// is still there with that time; then the notice goes out once this product's onboard line comes after it. A mark whose
// line is not there, or has another time, is from another Record and is cleared unsent (L295 Minor 3). A record with
// no diary (a test's stand-in) reads line 0, and "after".
const lastLine = (record) => {
  if (typeof record?.diary !== 'function') return { after: 0, ts: null };
  const l = record.diary({ since: 0 }).at(-1);
  return { after: l?.seq ?? 0, ts: l ? String(l.ts ?? '') : null };
};
const isOnboard = (p) => (l) => l.actor === 'approvals' && l.kind === 'onboard'
  && ((l.entity === 'product' && l.id === p) || (l.writes ?? []).some((w) => w.entity === 'product' && w.id === p));
const thisRecords = (record, { after, ts }) => {
  if (typeof record?.diary !== 'function') return true;
  if (after === 0) return ts === null;
  const l = record.diary({ since: after - 1 })[0];
  return l?.seq === after && String(l.ts ?? '') === ts;
};
const onboardedAfter = (record, p, due) => typeof record?.diary !== 'function'
  || (thisRecords(record, due) && record.diary({ since: due.after }).some(isOnboard(p)));
const DUE = (v) => (v && typeof v === 'object' && Number.isSafeInteger(v.after) && v.after >= 0
  && (v.after === 0 ? v.ts === null : typeof v.ts === 'string') ? { after: v.after, ts: v.ts } : false);
// What readNotices answers for a file that is there but can't be read or parsed (L309 Minor 3): "tell". The product
// may have been made on a pass whose mark is now unreadable, so a product made by approvals is told once more rather
// than never; the file is then rewritten whole.
const UNSURE = Object.freeze({ after: 0, ts: null, unsure: true });
// The mark of the wait (L315, L326): stillWaiting's own, its `since` naming the cause. Any other shape counts as not told.
const HELD = (v) => (v && typeof v === 'object' && typeof v.since === 'string' && typeof v.told_at === 'string' ? { since: v.since, told_at: v.told_at } : null);

function readNotices(ctx) {
  if (!ctx.stateDir) return { due: false, held: null };
  try {
    const f = join(ctx.stateDir, NOTICES);
    const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    // Nothing due is written as false. No file, or a mark of any other shape ({after:"3"}, null, []), is UNSURE (L331 Minor 1).
    const due = v?.due === false ? false : DUE(v?.due) || UNSURE;
    return { due, held: HELD(v?.held) };
  } catch { return { due: UNSURE, held: null }; }
}

function saveNotices(ctx, n) {
  if (!ctx.stateDir) return;
  mkdirSync(ctx.stateDir, { recursive: true });
  // Replaced whole (written beside, then renamed over), so a file that could not be read is replaced by one that can.
  const f = join(ctx.stateDir, NOTICES);
  const due = n.due && { after: n.due.after, ts: n.due.ts };
  writeFileSync(`${f}.new`, `${JSON.stringify({ due, held: n.held ?? null })}\n`, { mode: 0o600 });
  renameSync(`${f}.new`, f);
}

const sent = (ctx, alert) => { try { return ctx.alert(alert) === true; } catch { return false; } };

export function onboardNotices(ctx, made) {
  const p = ctx.product;
  const n = readNotices(ctx);
  // With no stateDir nothing is kept: the notice goes out on the pass that made the record.
  if (!ctx.stateDir && made?.type === 'onboarded') n.due = { after: 0, ts: null };
  if (n.due) {
    const rec = ctx.record.read('product', p);
    // No record yet: the write was refused or never ran; the mark waits for the next create (which marks it again).
    if (rec && !rec.corrupt) {
      const unsure = n.due.unsure && (typeof ctx.record?.diary !== 'function' || ctx.record.diary({ since: 0 }).some(isOnboard(p)));
      if (!unsure && !onboardedAfter(ctx.record, p, n.due)) { n.due = false; saveNotices(ctx, n); }   // another Record's mark
      else if (sent(ctx, { type: 'product_on', product: p, text: ONBOARD_SHOWN.on(p) })) { n.due = false; saveNotices(ctx, n); }
    }
  }
  // A near miss or a refused create: the product never turns on, so it is told again each day while the cause stands
  // (L315, L326). A new cause is told at once; with no stateDir nothing is kept, so it is told every pass.
  let cause;
  let notice;
  if (made?.type === 'onboard_near_miss') {
    cause = `near:${shownValue(made.value)}`;
    notice = { type: 'onboard_near_miss', product: p, text: ONBOARD_SHOWN.nearMiss(p, made.value) };
  } else if (made?.type === 'onboard_refused') {
    const reason = String(made.reason ?? 'no reason given');
    cause = `refused:${reason.replace(/\d+/g, 'N')}`;
    notice = { type: 'onboard_refused', product: p, text: ONBOARD_SHOWN.refused(p, reason) };
  }
  stillWaiting({
    waiting: cause !== undefined,
    since: cause,
    now: ctx.now?.() ?? Date.now(),
    read: () => n.held,
    tell: (mark) => {
      if (!sent(ctx, notice)) return false;
      n.held = mark;
      saveNotices(ctx, n);
      return true;
    },
    clear: () => { if (n.held) { n.held = null; saveNotices(ctx, n); } },
  });
}
