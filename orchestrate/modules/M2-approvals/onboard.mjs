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
//   onboardNotices(ctx, made)   what Joe is told about it, each once (below)
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
//     re-tells a product that has long been on (L295 Minor 3; it is cleared unsent). Cleared only once the sink took
//     it, so a lost send is sent again next pass, never lost (a lost clear sends it twice);
//   - the key is there but is not exactly `active` (`Active`, `[active]`, `active `) and there is no record: one alert
//     per distinct value. A missing key stays silent: a product not yet onboarded is normal (L129);
//   - the create was refused: one alert per distinct reason (its numbers out, so a moving rev is one reason). M9's own
//     `refused` alert still goes out from the store each time; this one says which product was not turned on.
// Kept in ctx.stateDir (onboard-notices.json). With no stateDir nothing is kept, so each is told every pass.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ONBOARD_KEY = 'onboarding.state';
const NOTICES = 'onboard-notices.json';
const MAX_SEEN = 200;

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
  if (ctx.stateDir) { const n = readNotices(ctx); n.due = { after: lastSeq(ctx.record), at: ctx.now?.() ?? Date.now() }; saveNotices(ctx, n); }
  const w = ctx.record.write({ actor: 'approvals', entity: 'product', id: ctx.product, expectRev: 0, doc: { state: 'active' }, kind: 'onboard' });
  return w.ok ? { type: 'onboarded', product: ctx.product } : { type: 'onboard_refused', product: ctx.product, reason: w.reason };
}

// The diary's last line number, and whether this product's onboard line came after `after` (L295 Minor 3). A record
// with no diary (a test's stand-in) reads 0 and "after".
const lastSeq = (record) => (typeof record?.diary === 'function' ? (record.diary({ since: 0 }).at(-1)?.seq ?? 0) : 0);
const isOnboard = (p) => (l) => l.actor === 'approvals' && l.kind === 'onboard'
  && ((l.entity === 'product' && l.id === p) || (l.writes ?? []).some((w) => w.entity === 'product' && w.id === p));
// The onboard line must also be within DUE_MS of the mark: a mark from another Record whose numbers happen to be lower
// is not this product's create.
const DUE_MS = 10 * 60_000;
const near = (at) => (l) => at === undefined || Math.abs((Date.parse(l.ts ?? '') || -Infinity) - at) <= DUE_MS;
const onboardedAfter = (record, p, { after, at }) => typeof record?.diary !== 'function'
  || record.diary({ since: after }).some((l) => isOnboard(p)(l) && near(at)(l));
const DUE = (v) => (v && typeof v === 'object' && Number.isSafeInteger(v.after) && v.after >= 0 && Number.isFinite(v.at) ? { after: v.after, at: v.at } : false);

function readNotices(ctx) {
  if (!ctx.stateDir) return { seen: [], due: false };
  try {
    const f = join(ctx.stateDir, NOTICES);
    const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    return { seen: Array.isArray(v?.seen) ? v.seen.filter((x) => typeof x === 'string') : [], due: DUE(v?.due) };
  } catch { return { seen: [], due: false }; }
}

function saveNotices(ctx, n) {
  if (!ctx.stateDir) return;
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileSync(join(ctx.stateDir, NOTICES), `${JSON.stringify({ seen: n.seen.slice(-MAX_SEEN), due: n.due })}\n`);
}

const sent = (ctx, alert) => { try { return ctx.alert(alert) === true; } catch { return false; } };

export function onboardNotices(ctx, made) {
  const p = ctx.product;
  const n = readNotices(ctx);
  // With no stateDir nothing is kept: the notice goes out on the pass that made the record.
  if (!ctx.stateDir && made?.type === 'onboarded') n.due = { after: 0, at: undefined };
  if (n.due) {
    const rec = ctx.record.read('product', p);
    // No record yet: the write was refused or never ran; the mark waits for the next create (which marks it again).
    if (rec && !rec.corrupt) {
      if (!onboardedAfter(ctx.record, p, n.due)) { n.due = false; saveNotices(ctx, n); }   // a stale mark: on long before it
      else if (sent(ctx, { type: 'product_on', product: p, text: ONBOARD_SHOWN.on(p) })) { n.due = false; saveNotices(ctx, n); }
    }
  }
  let key = null;
  let notice = null;
  if (made?.type === 'onboard_near_miss') {
    key = `value:${shownValue(made.value)}`;
    notice = { type: 'onboard_near_miss', product: p, text: ONBOARD_SHOWN.nearMiss(p, made.value) };
  } else if (made?.type === 'onboard_refused') {
    const reason = String(made.reason ?? 'no reason given');
    key = `refused:${reason.replace(/\d+/g, 'N')}`;
    notice = { type: 'onboard_refused', product: p, text: ONBOARD_SHOWN.refused(p, reason) };
  }
  if (!key || n.seen.includes(key)) return;
  if (sent(ctx, notice)) { n.seen.push(key); saveNotices(ctx, n); }
}
