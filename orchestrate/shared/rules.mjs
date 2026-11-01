// rules.mjs — the one interface every module uses to ask M10 Rules "may X happen?".
//
// WHY. M10 Rules decides; it never acts (design v4 §9.2 M10). Every Do-plane script (Dispatcher, Workshop, Merge
// Gate, Approvals, Sensors) asks it before an act, so the question has one shape everywhere and the answer is
// always safe to act on. This file is that shape. The real answers come from orchestrate/modules/M10-rules/,
// which plugs in through makeRules(); a test plugs in fakeRules().
//
// FAILS CLOSED (rail A6). Whatever the implementation does — throws, returns junk, is asked an action it doesn't
// know, or has no readable rules — the caller gets { decision: 'deny', reason }. A caller never has to guard.
//
//   const rules = makeRules(impl);
//   const d = rules.may('push_branch', { product, card, files });   // → { decision, tier?, reason, rev }
//   if (d.decision !== 'allow') refuse(d.reason);
//   rules.get('caps.editing_per_mac', { product })                  // → the value as the rules hold it, or undefined
//   rules.num('claims.stuck_min', { product })                      // → a whole number ≥ 0, or undefined (L96)
//   rules.dec('usage.pace_min_share', { product })                  // → a number ≥ 0 that may have a fraction, or undefined (L104)
//   rules.flag('product.onboarded', { product })                    // → true or false, or undefined (L96)
//   rules.classify(change)                                          // → { tier, risky: [...], reasons, protected } (D7)
//     change = { product, files: [{ path, previous_path?, status: added|modified|removed|renamed|copied, mode?,
//                added_lines?, removed_lines? }], truncated?, declared_tier?, labels? }
//     Always judged by the current rules. A caller can't hand in rules of its own: any `policy` or `atCommit` field is
//     dropped (round 2, R2-M10). The GitHub-side checker reads the parent commit's rules through M10's
//     classifyWithRulesText instead.
//   Gate only on may(). get() is for display and sizing; an undefined get() means "refuse", never "no limit".
//   The rules file is text, and its reader converts only some keys, so get() can hand back "30" or "true" (L96). Whole
//   numbers are read through num(), numbers with a fraction through dec(), and true/false through flag() (L104); get()
//   is for text, maps and lists only. orchestrate/test/rules-typed-reads.test.mjs fails on a module that checks a get()
//   value as a number or a flag, and fakeRules() hands every value back as text, as the real reader does.
//   rules.rev                                                      // the loaded rules version, for diary lines

export const ALLOW = 'allow';
export const ASK = 'ask';     // allowed only with the owner's answer; `tier` is the channel (1 = their GitHub Approve, 2 = a tap)
export const DENY = 'deny';

// The acts a module may ask about. Anything else is denied. Owners in brackets ask; M10 answers.
export const ACTIONS = Object.freeze({
  start_session: 'start an AI session for a role (and card) [M11 Dispatcher, M4 launcher]',
  write_production: 'write to production data or settings [M4 production-write guard, reads the snapshot]',
  push_branch: 'push a card branch to GitHub with the robot [M4 push script]',
  merge: 'merge a pull request to main [M6 Merge Gate]',
  count_approval: 'count an answer from Joe as an approval [M2 Approvals]',
  delete_copy: 'delete a code copy or branch [M11 cleanup]',
  flip_switch: 'flip a named production switch [M11 Switch Runner, from Phase 2]',
});

// The Approve-every-time classes (design v4 §14.1.6 risky_acts). One definition; M10 and M6 import it.
export const RISKY_CLASSES = Object.freeze(['production_data', 'schema', 'protected', 'secrets_settings', 'deletes',
  'first_customer_visible', 'messages_people', 'unclassifiable']);

// A deny whose reason is one of these means "wait, keep the place in the queue", not "refused" (0b-1 R3-m8). The
// Merge Gate tests membership here; it never parses reason text.
export const HOLD_REASONS = Object.freeze(['held_tier1_hours', 'rules_not_adopted']);

// The one definition of a rules number (L104): M10's parsePolicy checks the file with these two, and num() and dec()
// read with them, so "030" or "-30" is refused by both. A whole number is 0 or digits with no leading zero; a decimal
// adds an optional fraction (".5", "1.", "1e-3", "+1" and "-0.1" are refused). No rules number is negative.
export const WHOLE_TEXT = /^(0|[1-9]\d*)$/;
export const DECIMAL_TEXT = /^(0|[1-9]\d*)(\.\d+)?$/;

// The one conversion for a rules number or flag (L96, L104). A whole number is a safe integer ≥ 0 the reader already
// converted, or text matching WHOLE_TEXT; a decimal is a finite number ≥ 0, or text matching DECIMAL_TEXT. Anything else
// ("3x", "1.5" for a whole number, " 3", "") is missing, so the caller refuses as it does for a key that isn't there.
// A flag is exactly true or false, as the reader's text or as a value; "yes", "True", 1 and "" are missing.
export function wholeNumber(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v + 0 : undefined;   // + 0 turns -0 into 0
  if (typeof v !== 'string' || !WHOLE_TEXT.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}
export function decimal(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v + 0 : undefined;
  if (typeof v !== 'string' || !DECIMAL_TEXT.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
export function exactFlag(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

// Mac-wide keys and how M10 combines them across products (MAT-10, R2-M5(b)). `*` = every key under that map. A read
// of any other key needs its product: with none it is missing, in the engine and in fakeRules alike (L104 O-1, L110).
// The Dispatcher-wide keys (L131) govern nothing with one product: the Front Door, an outage, the account's usage. Most
// are the smallest value across products, which acts and tells Joe soonest: a stuck Front Door is restarted sooner; an
// outage is declared sooner; a card waits on Joe sooner while usage is unreadable; the pace check starts earlier in the
// week. timeouts.dead_quiet_min is the largest (L131 follow-up): calling a working session dead and restarting it could
// put two sessions on one card, while a longer wait only tells Joe later, and the outage floors still apply.
export const MAC_MIN = Object.freeze(['caps.editing_per_mac', 'caps.scripts_per_mac', 'caps.script_agents_max',
  'usage.bands.*.*', 'usage.no_tier1_prod_above', 'usage.stale_after_min',
  'timeouts.front_door_stuck_min', 'timeouts.usage_unknown_max_min',
  'outage.min_dead', 'outage.share', 'usage.pace_min_share']);
export const MAC_MAX = Object.freeze(['usage.reserve_pct.*', 'claude_code.required_minimum', 'timeouts.dead_quiet_min']);
export const MAC_MATCH = Object.freeze(['claude_code.pin', 'models.*', 'accounts.current', 'accounts.joe.tz']);
// Lists read for the whole Mac, combined strictest-wins: only what every product's list names (L96). usage.red_runs is
// the kinds of session that may still start in the red band; the band is the account's, not one product's, so a read
// with no product answers it. An item one product leaves out is held for all.
export const MAC_LIST_ALL = Object.freeze(['usage.red_runs']);
export const keyMatches = (list, key) => list.some((pat) => {
  const a = pat.split('.'); const b = key.split('.');
  return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]);
});
export const isMacKey = (key) => typeof key === 'string'
  && [MAC_MIN, MAC_MAX, MAC_MATCH, MAC_LIST_ALL].some((list) => keyMatches(list, key));

const errText = (e) => { try { return String(e?.message ?? e); } catch { return 'unreadable error'; } };

export function allow(reason = 'allowed') { return { decision: ALLOW, reason }; }
export function ask(tier, reason) { return { decision: ASK, tier, reason }; }
export function deny(reason) { return { decision: DENY, reason }; }

// A decision is valid only in exactly these shapes; anything else is treated as deny.
export function isDecision(d) {
  if (!d || typeof d !== 'object' || typeof d.reason !== 'string' || !d.reason) return false;
  if (d.decision === ALLOW || d.decision === DENY) return true;
  return d.decision === ASK && (d.tier === 1 || d.tier === 2);
}

// Wrap an implementation { may(action, subject), get(key, opts), classify(change), rev } so every call fails closed.
// num() and flag() are built here over the implementation's get(), so a fake and the real engine convert the same way.
export function makeRules(impl) {
  const rev = () => { try { return impl?.rev ?? null; } catch { return null; } };
  return Object.freeze({
    get rev() { return rev(); },
    may(action, subject = {}) {
      if (!Object.hasOwn(ACTIONS, action)) return { ...deny(`unknown action "${action}"`), rev: rev() };
      // Every field is read inside the try, so an answer whose getter throws is a deny too (audit round 9).
      let d;
      try {
        const a = impl.may(action, subject);
        d = a && typeof a === 'object' ? (a.decision === ASK ? { decision: a.decision, tier: a.tier, reason: a.reason } : { decision: a.decision, reason: a.reason }) : a;
      } catch (e) { return { ...deny(`rules error: ${errText(e)}`), rev: rev() }; }
      if (!isDecision(d)) return { ...deny('rules gave no valid answer'), rev: rev() };
      return { ...d, rev: rev() };
    },
    get(key, opts = {}) {
      try { return impl.get(key, opts); } catch { return undefined; }
    },
    num(key, opts = {}) {
      try { return wholeNumber(impl.get(key, opts)); } catch { return undefined; }
    },
    dec(key, opts = {}) {
      try { return decimal(impl.get(key, opts)); } catch { return undefined; }
    },
    flag(key, opts = {}) {
      try { return exactFlag(impl.get(key, opts)); } catch { return undefined; }
    },
    // A change the rules can't classify counts as risky (D7), so a failure here is "unclassifiable", Tier 1.
    // Any risky class or protected path makes it Tier 1, whatever the implementation said (R2-m2).
    classify(change) {
      // With no trusted classification, every named file may be protected: never answer with an empty list (audit round 6).
      // Reading the change can throw too (a getter), so the names are read inside a try (audit round 9).
      const named = () => {
        try { return Array.isArray(change?.files) ? Array.from(change.files, (f) => f?.path).filter((p) => typeof p === 'string') : []; } catch { return []; }
      };
      const failed = (reason) => ({ tier: 1, risky: ['unclassifiable'], reasons: { unclassifiable: [reason] }, protected: named() });
      // Everything that reads the change or the answer sits inside the try, so any throw is a fail-closed answer.
      try {
        let asked = change;
        if (change && typeof change === 'object') {
          const { policy, atCommit, ...rest } = change;   // eslint-disable-line no-unused-vars
          asked = rest;
        }
        let c;
        try { c = impl.classify(asked); } catch (e) { return failed(`rules error: ${errText(e)}`); }
        if (!c || (c.tier !== 1 && c.tier !== 2) || !Array.isArray(c.risky)) return failed('rules gave no valid classification');
        const risky = [...c.risky];
        if (risky.some((k) => !RISKY_CLASSES.includes(k))) return failed('unknown risky class in classification');
        const reasons = c.reasons;
        if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) return failed('classification gave no reasons');
        const prot = c.protected ?? [];
        if (!Array.isArray(prot) || prot.some((p) => typeof p !== 'string')) return failed('classification gave a bad protected list');
        return { tier: risky.length || prot.length ? 1 : c.tier, risky, reasons, protected: [...prot] };
      } catch (e) { return failed(`rules error: ${errText(e)}`); }
    },
  });
}

// What the rules file's reader (yaml-lite) gives for a value: every number and true/false as its text, inside lists and
// maps too. fakeRules hands values back this way, so a test that passes 30 sees "30", as a module does on the real
// file, and a reader that skips num/dec/flag fails its own tests (L104). M10's rulesFromText builds from real text.
export function asReaderText(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(asReaderText);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asReaderText(x)]));
  }
  return v;
}

// The test files that still read numbers and flags the old way, so the text values above turn them red (L104). Until
// the PR named on each entry moves its module onto num/dec/flag, a fake made from one of these files hands values
// back as given. This list only shrinks (L123): orchestrate/test/rules-typed-reads.test.mjs fails on a file named here
// that is gone, on an entry with no owner or no PR, and on a list longer than its pinned count.
export const OLD_VALUES_UNTIL_STEP_2 = Object.freeze({
  'modules/M4-workshop/git/push.test.mjs': { owner: 'lane 2', pr: 'M4 push.mjs typed reads (L96 step 2)' },
  // M11 reads typed (L123); these five stay red only because their modules read per-product keys with no product
  // (merges.mjs time limits, pass.mjs:149-151, lead-restart.mjs context.*). Lane 2 passes the product (L104 O-1, L131).
  // The helper is for tick.test's child `node main.mjs`, which runs a whole pass on the helper's rules.
  ...Object.fromEntries(['pass.test', 'tick.test', 'merges.test', 'lead-restart.test', 'account-ports.test', 'fixtures.test-helper']
    .map((n) => [`modules/M11-dispatcher/${n}.mjs`, { owner: 'lane 2', pr: 'M11 per-product reads pass the product (L104 O-1 step 2, L131)' }])),
});
// Whether a fake is being made from one of those files: read once, from where fakeRules was called. A listed test
// file counts wherever it is on the call stack. A listed helper counts only in a child process a test started (no
// test file on the stack at all), so the helper's other callers still get text.
function madeFromOldValuesFile() {
  const stack = String(new Error().stack ?? '').replaceAll('\\', '/');
  const on = (f) => stack.includes(`/orchestrate/${f}:`);
  const listed = Object.keys(OLD_VALUES_UNTIL_STEP_2);
  if (listed.some((f) => f.endsWith('.test.mjs') && on(f))) return true;
  return !/\.test\.mjs:/.test(stack) && listed.some((f) => f.endsWith('.test-helper.mjs') && on(f));
}

// For other modules' tests: answers from a table { [action]: decision | (subject) => decision }, values from
// `values` (handed back as the reader's text, above), classification from `classify`. Unlisted actions are denied, as
// with the real rules. A per-product key read with no product is missing, as with the real rules (L110), so with the
// text values the fake refuses what the engine refuses.
export function fakeRules({ answers = {}, values = {}, classify, rev = 'fake-1' } = {}) {
  const old = madeFromOldValuesFile();
  const asRead = old ? (v) => v : asReaderText;
  return makeRules({
    rev,
    may(action, subject) {
      const a = answers[action];
      if (a === undefined) return deny(`fake rules: no answer for "${action}"`);
      return typeof a === 'function' ? a(subject) : a;
    },
    // As the engine: a per-product key read with no product is missing (L110); a Mac-wide key needs none.
    get(key, { product } = {}) {
      if (!old && !isMacKey(key) && (product === undefined || product === null)) return undefined;
      return Object.hasOwn(values, key) ? asRead(values[key]) : undefined;
    },
    classify(change) { return classify ? classify(change) : { tier: 2, risky: [], reasons: {} }; },
  });
}
