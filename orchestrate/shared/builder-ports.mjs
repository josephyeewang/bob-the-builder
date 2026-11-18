// builder-ports.mjs — the builder's loopback port range and the allow-list proxy's ports: the one home (builder wall v2).
//
// WHY. The builder wall (setup/builder-wall.mjs) can no longer tell the builder's packets by a pf tag: a tag does not
// survive lo0 on macOS (measured on macOS 27.0.1, 2026-11-16, wall-diag W1/W2 and V1-V5). It tells them by PORT instead:
// on loopback the builder reaches only ports in WALL_RANGE, and only its own sockets may listen there. So every place that
// needs the range or a port in it (the wall's rules, its read-back, the proxy job, the role settings that point a builder
// session at the proxy, daemons check) imports it from here, never a copy.
//
// The range must sit wholly below the Mac's ephemeral range (sysctl net.inet.ip.portrange.first/last, 49152-65535 on a
// stock Mac): a port the kernel hands out for an outgoing connection must never be one the wall treats as the builder's.
// The wall's place refuses when it does not (builder-wall.mjs ephemeralProblem).

/** The builder's loopback ports, both ends included. */
export const WALL_RANGE = Object.freeze({ first: 47000, last: 47999 });

/**
 * The allow-list proxy's ports (setup/builder-proxy.mjs), in WALL_RANGE: one for a session's shell, one for a worker's
 * install step (the session's hosts plus the registry hosts). Claude Code 2.1.316 serves HTTP and SOCKS5 on one port when
 * it runs its own proxy, so a role file sets httpProxyPort and socksProxyPort both to the same one of these, and the proxy
 * tells the two apart by the first byte (checked: claude-code 2.1.316).
 */
export const PROXY_PORTS = Object.freeze({ session: 47000, install: 47001 });

/** Ports the wall's read-back may listen on: in the range, clear of the proxy's (and of a few kept spare). */
export const PROBE_FIRST = WALL_RANGE.first + 16;

/**
 * The destination ports of the builder's UDP replies: the stock macOS ephemeral range. A UDP server of the builder's in
 * the range answers a client whose port the kernel picked; nothing else may leave a range port for a port outside it.
 */
export const EPHEMERAL = Object.freeze({ first: 49152, last: 65535 });

export const inRange = (port) => Number.isInteger(port) && port >= WALL_RANGE.first && port <= WALL_RANGE.last;
