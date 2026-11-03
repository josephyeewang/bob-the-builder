// probes/reachable.mjs — "is the Front Door reachable?" for the Sensors loop (R-0b-169). true, false or null.
//
// One GET to a web address the caller names (config; none is named here), no sign-in sent, no redirect followed, the
// body never read. Any answer below 500 means the address is reachable (a 401 or 404 still came from the other end).
// A 500 or above, or a refused or unresolvable connection, is false. A time-out or anything else is null (could not
// tell): M11 reads null as "unknown" and does nothing, while a wrong false makes it restart the Front Door.
// A connection the other end closed under the request (UND_ERR_SOCKET) is tried once more: fetch reuses a kept-alive
// connection, and one the server dropped earlier says nothing about now. The second try opens a new one; if it fails
// the same way, the answer is null (lead's #89 run 41599790289: a closed server read null on Linux, not false).

import { NO_NETWORK_CODES } from './network.mjs';

const DOWN_CODES = Object.freeze([...NO_NETWORK_CODES, 'ECONNREFUSED', 'ECONNRESET']);
const STALE_CODE = 'UND_ERR_SOCKET';
const STALE = Symbol('stale connection');

export function reachableProbe({ url, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('the reachable probe needs a web address'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the reachable probe needs an http(s) address');
  if (u.username || u.password) throw new Error('the reachable probe takes no sign-in in the address');
  const once = async () => {
    try {
      const res = await fetchImpl(u.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'orchestrate-sensors' } });
      res.body?.cancel?.().catch?.(() => {});
      return Number.isInteger(res.status) ? res.status < 500 : null;
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return null;
      const code = e?.cause?.code ?? e?.code;
      return code === STALE_CODE ? STALE : DOWN_CODES.includes(code) ? false : null;
    }
  };
  return async () => { const r = await once(); if (r !== STALE) return r; const again = await once(); return again === STALE ? null : again; };
}
