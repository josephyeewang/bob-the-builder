// device-checks.mjs — the logic the owner's private `/host` and `/configaudit` commands call for orchestrated products
// (R-0b-78; design v4 §7.2 R1, R7; review-0b-7 M15). Bob is public, so this file holds only the decisions; the private
// commands gather the facts on the machine and print what comes back. Wiring them in is an owner step (README).
//
//   hostStatusLine(products)   the line `/host status` adds: orchestrated products stay on the Mini.
//   prePushMessage(...)        the Air's pre-push hook. It is a MESSAGE, not the guard: `git push --no-verify` skips
//                              any hook, so the real guard is that nothing on the Air can push a product (no
//                              push-capable credential), which `/configaudit` checks. The owner's real test pushes
//                              with --no-verify and must still be refused by GitHub.
//   checkAirSetup(facts)       `/configaudit` on the Air: one red item per miss; any red means "keep the Air off
//                              products". A fact the command could not gather is red ("unknown"), never green.

export function hostStatusLine(orchestrated = []) {
  if (!orchestrated.length) return 'No orchestrated products yet.';
  return `orchestrated products stay on the Mini (${orchestrated.join(', ')}): claiming home elsewhere does not move them, and pushes to them from another machine are refused.`;
}

export function prePushMessage({ machine, remoteRepo, orchestratedRepos }) {
  if (machine === 'mini' || !orchestratedRepos.includes(remoteRepo)) return { refuse: false, message: '' };
  return { refuse: true, message: `Refused: ${remoteRepo} is an orchestrated product and stays on the Mini. Ask the Front Door from the phone instead. (This message is a courtesy; GitHub itself refuses a push from this machine.)` };
}

// facts, gathered by the private command on the Air:
//   githubTokenScopes: string[] | null   — the logged-in GitHub CLI token's repos/permissions; push to a product = red
//   pushCapableCredentials: string[] | null — every credential found that can push a product repo (SSH keys, tokens,
//                                           credential-helper entries), by label; any = red
//   chromeBlocksGithub: boolean | null   — github.com blocked in the browser extension
//   sessionNames: string[] | null        — current session names; each must contain "Air"
//   denyFileDecision: 'mini-only' | 'both' | null — the recorded decision on the deny file
// An allow-list (round 3 M-D): anything not read-only by name is red, so public_repo, workflow, repo, a write
// permission in any spelling, or an unknown scope all fail. The private command reports each scope as one lowercase
// token: a fine-grained permission as "<name>:read" (e.g. "contents:read"), a classic scope as GitHub names it
// ("read:org"). user:email is the one classic scope without "read:" that can't write anything.
export function readOnlyScope(s) {
  return typeof s === 'string' && (/^[a-z_]+:read$/.test(s) || /^read:[a-z_]+$/.test(s) || s === 'user:email');
}

export function checkAirSetup(facts = {}) {
  const red = [];
  const unknown = (k) => facts[k] === null || facts[k] === undefined;
  if (unknown('pushCapableCredentials')) red.push('push-capable credentials: unknown (could not check)');
  else if (facts.pushCapableCredentials.length) red.push(`can push a product: ${facts.pushCapableCredentials.join(', ')}`);
  if (unknown('githubTokenScopes')) red.push('GitHub login: unknown (could not check)');
  else if (!Array.isArray(facts.githubTokenScopes) || facts.githubTokenScopes.some((s) => !readOnlyScope(s))) red.push('GitHub login is not narrowed to read-only');
  if (facts.chromeBlocksGithub !== true) red.push(`github.com not blocked in the browser extension${unknown('chromeBlocksGithub') ? ' (unknown)' : ''}`);
  if (unknown('sessionNames')) red.push('session names: unknown');
  else { const bad = facts.sessionNames.filter((n) => !/\bAir\b/.test(n)); if (bad.length) red.push(`session names without "Air": ${bad.length}`); }
  if (!['mini-only', 'both'].includes(facts.denyFileDecision)) red.push('the Mini-only deny-file decision is not recorded');
  return { ok: red.length === 0, red };
}
