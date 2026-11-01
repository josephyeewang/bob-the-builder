// probes/network.mjs — "is the network up?" for the Sensors loop (R-0b-169). Answers true, false or null (could not tell).
//
// It opens a plain TCP connection to each named host and sends nothing. The hosts come from the caller (config); none is
// named here. Up if any host answers. Down only when EVERY host fails in a way that means "no route to the network"
// (no route, no name lookup, network down). A refusal, a time-out or anything else is "could not tell" (null), because
// M11 treats a false network as a reason to stop and wait, and a wrong "down" is not harmless.

import net from 'node:net';

// Failures that mean the network itself is not there (not that one host is unwell).
export const NO_NETWORK_CODES = Object.freeze(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN']);

/** One TCP connection attempt → { ok: true } or { ok: false, code }. Never throws; always ends within timeoutMs. */
export function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host, port });
    const end = (r) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(r); };
    const t = setTimeout(() => end({ ok: false, code: 'TIMEOUT' }), timeoutMs);
    s.once('connect', () => end({ ok: true }));
    s.once('error', (e) => end({ ok: false, code: e?.code ?? 'ERROR' }));
  });
}

export function networkProbe({ hosts, port = 443, timeoutMs = 5000, connect = tcpConnect } = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((h) => typeof h === 'string' && h)) throw new Error('the network probe needs at least one host name');
  return async () => {
    const results = await Promise.all(hosts.map(async (h) => { try { return await connect(h, port, timeoutMs); } catch { return { ok: false, code: 'ERROR' }; } }));
    if (results.some((r) => r?.ok === true)) return true;
    return results.every((r) => NO_NETWORK_CODES.includes(r?.code)) ? false : null;
  };
}
