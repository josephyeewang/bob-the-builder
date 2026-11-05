// required-keys.mjs — the rules keys the Workshop's push reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L601, the audit of #244 M-2; L165's class line: the fit check covers every file that reads rules).
//
// WHY. A rules file with no product.repo passed M10's first-cutover fit check, then every push was refused. The fit
// check asks each module that reads the rules with that module's own list, so this is the Workshop's.
//
//   REQUIRED_KEYS   the keys a push can't work without
//   OPTIONAL_KEYS   keys it reads but handles when missing (each says what happens)
//   policyProblems(rules, product) → [] when a push can use these rules, else every reason it can't

export const REQUIRED_KEYS = Object.freeze([
  'product.repo',             // with none, every push is refused
  'product.mirror',           // the mirror the scan and the push read from
  'product.onboarded',        // must be true, or every push is refused
  'product.allowed_binaries', // says which images may go; [] allows none, and a missing list must not mean that unseen
  'outside_check.workflow',   // the pinned workflow the start gate compares the outside check's run with
  'product.vercel_project',   // the project the start gate's Vercel facts must name
]);

export const OPTIONAL_KEYS = Object.freeze([
  'product.default_branch',   // missing reads as main
  'proposals.outbox',         // read only for a card that hands in a proposal; a missing one is refused there
]);

export function policyProblems(rules, product) {
  return rules.flag('product.onboarded', { product }) === true ? [] : ['product.onboarded must be true: anything else and every push is refused'];
}
