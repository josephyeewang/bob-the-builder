// required-keys.mjs — the rules keys the Workshop's push reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L601, the audit of #244 M-2; L165's class line: the fit check covers every file that reads rules).
//
// WHY. The fit check asks each module that reads the rules with that module's own list, so this is the Workshop's.
// Under L612 only product.vercel_project is a rules line. Repo, mirror and the outside check's workflow come from the
// wiring (productPlace, outsideWorkflow), so a rules file can no longer leave them out (L568, #237).
//
//   REQUIRED_KEYS   the keys a push can't work without
//   OPTIONAL_KEYS   keys it reads but handles when missing (each says what happens)
//   policyProblems(rules, product) → [] when a push can use these rules, else every reason it can't: today, a Vercel
//                                    project that is not non-empty text, which the start gate refuses (L719 m4)

export const REQUIRED_KEYS = Object.freeze([
  'product.vercel_project',   // the project the start gate's Vercel facts must name
]);

// L568: repo, mirror and the outside check's workflow come from code, not the rules file, and left this list with their
// reads (#237). Onboarded is the one "on" switch M2 reads too.
export const OPTIONAL_KEYS = Object.freeze([
  'bob.method_files',         // the Bob fetch (bob-method/fetch.mjs, R-0b-141): missing fetches nothing, so check 13 refuses the roles that read Bob
  'bob.pin',                  // the same: missing, short or the placeholder fetches nothing
  'onboarding.state',         // anything but the exact word active is not onboarded: the push waits
  'product.allowed_binaries', // missing allows no images
  'product.default_branch',   // missing reads as main
  'proposals.outbox',         // read only for a card that hands in a proposal; a missing one is refused there
]);

// L719 m4 (L612): the go/no-go check must agree with the start gate, which shuts for good unless the project is non-empty
// text (start-gate.mjs vercelFact). Read as push.mjs reads it, so the two can't differ.
export const VERCEL_PROJECT_LINE = 'M4: product.vercel_project must name the Vercel project';
export function policyProblems(rules, product) {
  let v;
  try { v = rules.get('product.vercel_project', { product }); } catch { v = undefined; }
  return typeof v === 'string' && v ? [] : [VERCEL_PROJECT_LINE];
}
