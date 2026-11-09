// proposal-wall.mjs — every product's proposals folder, as the rules give it, for the read-deny wall (R-0b-128, L549).
//
// WHY. Every AI session runs as the same Mac user, which can read the owner's proposals folders, so the settings are the
// wall: renderRoleSettings refuses a launch unless every folder is on the read-deny list, the session's own product's and
// the others' (L78 n5). This is where that list comes from, so the launch port has one thing to pass as both
// `proposalOutboxes` and `paths.deny.proposals`. A product the rules can't name a usable folder for refuses here rather
// than being left out of the wall.
//
// A usable folder is one definition (L580), here, for the wall, the push script, the intake and the fit check. A real
// session proved why it is narrow: a Read rule written with a `.` segment or a `[` matches nothing, so the file reads.
//
//   plainFolder(path)                  → whether it is an absolute path of plain characters, with no `.` or `..` segment
//   proposalFolder(rules, product)     → the folder, or null when the rules give none that is plain
//   proposalWall(rules, products)      → { ok: true, folders } | { ok: false, reason }

const PLAIN = /^\/[A-Za-z0-9._/-]+$/;

export function plainFolder(path) {
  if (typeof path !== 'string' || !PLAIN.test(path)) return false;
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 && !parts.some((p) => p === '.' || p === '..');
}

export function proposalFolder(rules, product) {
  const f = rules.get('proposals.outbox', { product });
  return plainFolder(f) ? f : null;
}

export function proposalWall(rules, products) {
  if (!Array.isArray(products) || !products.length) return { ok: false, reason: 'the product list was not given' };
  const read = (p) => { try { return proposalFolder(rules, p); } catch { return null; } };
  const bad = products.filter((p) => read(p) === null);
  if (bad.length) return { ok: false, reason: `the rules give no usable proposals folder for ${bad.join(', ')}` };
  return { ok: true, folders: [...new Set(products.map(read))] };
}
