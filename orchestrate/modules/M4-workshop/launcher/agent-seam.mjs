// The agent seam (R-0b-31): the launcher talks to an AI program only through these five calls,
// so a second program could be added later without touching the launch checks. Today the only
// adapter is Claude's; any other name is refused.

export const SEAM_CALLS = Object.freeze(['start', 'stop', 'status', 'report', 'usage']);

/** Builds the Claude adapter from injected parts (real ones in production, fakes in tests). */
export function claudeAdapter(parts) {
  for (const c of SEAM_CALLS) if (typeof parts?.[c] !== 'function') throw new Error(`claude adapter needs ${c}()`);
  return Object.freeze(Object.fromEntries(SEAM_CALLS.map((c) => [c, parts[c]])));
}

const ADAPTERS = Object.freeze({ claude: claudeAdapter });

export function agentAdapter(name, parts) {
  if (!Object.hasOwn(ADAPTERS, name)) return { ok: false, reason: `no adapter for "${name}"; only claude is allowed` };
  return { ok: true, adapter: ADAPTERS[name](parts) };
}

export const adapterNames = () => Object.keys(ADAPTERS);
