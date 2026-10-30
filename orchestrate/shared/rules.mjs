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
//   rules.get('caps.editing_per_mac', { product })                  // → a number from the rules, or undefined
//   rules.classify(change)                                          // → { tier, risky: [...], reasons, protected } (D7)
//     change = { product, files: [{ path, previous_path?, status: added|modified|removed|renamed|copied, mode?,
//                added_lines?, removed_lines? }], truncated?, declared_tier?, labels? }
//     Always judged by the current rules. A caller can't hand in rules of its own: any `policy` or `atCommit` field is
//     dropped (round 2, R2-M10). The GitHub-side checker reads the parent commit's rules through M10's
//     classifyWithRulesText instead.
//   Gate only on may(). get() is for display and sizing; an undefined get() means "refuse", never "no limit".
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

// For other modules' tests: answers from a table { [action]: decision | (subject) => decision }, values from
// `values`, classification from `classify`. Unlisted actions are denied, as with the real rules.
export function fakeRules({ answers = {}, values = {}, classify, rev = 'fake-1' } = {}) {
  return makeRules({
    rev,
    may(action, subject) {
      const a = answers[action];
      if (a === undefined) return deny(`fake rules: no answer for "${action}"`);
      return typeof a === 'function' ? a(subject) : a;
    },
    get(key) { return values[key]; },
    classify(change) { return classify ? classify(change) : { tier: 2, risky: [], reasons: {} }; },
  });
}
