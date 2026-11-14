// smoke.mjs — "does each page load": every declared page and route must answer without an error.
// A page must answer below 400 (redirects are followed). A route answers below 400 too, unless it declares the one
// status it should give (for example 401 for an API route that needs a login). A server error (500+) never passes,
// and neither does a page that doesn't answer at all.

import { pageUrl } from './quality-lib.mjs';

export async function smoke({ config, log = () => {} }) {
  const failures = [];
  const targets = [
    ...config.pages.map((p) => ({ label: `page ${p.name}`, path: p.path, expect: null })),
    ...config.routes.map((r) => ({ label: `route ${r.path}`, path: r.path, expect: r.expectStatus ?? null })),
  ];
  for (const t of targets) {
    const url = pageUrl(config, t.path);
    let status;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
      status = res.status;
      await res.arrayBuffer(); // a body that breaks off mid-way is a failure too
    } catch (e) {
      failures.push(`${t.label} (${t.path}) did not answer: ${e.cause?.code ?? e.message}`);
      continue;
    }
    const ok = t.expect !== null ? status === t.expect : status < 400;
    if (ok) log(`  ok    ${t.label} ${t.path} → ${status}`);
    else failures.push(`${t.label} (${t.path}) answered ${status}${t.expect !== null ? `, expected ${t.expect}` : ''}`);
  }
  return failures;
}
