// secret-guard.mjs — a secret this process has read can't be put on a program's command line (R-0b-179, L1176).
//
// WHY. On the Mini every Mac user can read every process's command line (/bin/ps is setuid root), so a token passed as
// an argument is a token handed to every user, the builder sessions included. credential-args.mjs reads the source for
// that before it merges; this is the same rule at run time, for what a source scan can't follow (a value carried through
// an object, an env built from config pairs and spread into `env -i K=V …`, a header made from a token).
//
// HOW. Each place that reads a secret registers it here (the watch-only token from its file or from the terminal, the
// robot's key, its signed request and its installation token, the push header made from that token). Loading this
// module wraps node:child_process's start functions (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork)
// on the module object and then updates the named imports every ES module holds (syncBuiltinESMExports), so
// `import { spawn } from 'node:child_process'` anywhere in the process gets the wrapped one. A start whose program,
// any argument, command string or argv0 holds a registered value throws before anything starts; the message never
// carries the value. The environment is not checked: a child's environment is not on the command line.
//
//   registerSecret(value)       → value (unchanged), for `return registerSecret(x)`; a value under MIN_SECRET is ignored
//   holdsSecret(text)           → true when text holds a registered value
//   refuseSecretArgs(what, parts) throws when any part holds one (for a runner handed a start function, see sync-limit)
//
// Limits, said plainly: a start function taken off the module object before this module loaded (a `const { spawn } =
// require(...)`, or a reference stored at load time) is not wrapped, so the files that start programs with a token
// import this module themselves, and sync-limit, which is handed its spawnSync, checks for itself. A worker thread has
// its own copy of this module and of child_process. The value is checked as text: a secret re-encoded on the way (other
// than the forms registered) is not seen.

import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

/** Shorter values are not registered: they would match ordinary text, and no token or key is this short. */
export const MIN_SECRET = 12;
const SECRETS = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= MIN_SECRET) SECRETS.add(value);
  return value;
}

export function holdsSecret(text) {
  if (!SECRETS.size || text === undefined || text === null) return false;
  let s;
  try { s = typeof text === 'string' ? text : Buffer.isBuffer(text) ? text.toString('utf8') : String(text); } catch { return true; }
  for (const x of SECRETS) if (s.includes(x)) return true;
  return false;
}

export function refuseSecretArgs(what, parts) {
  for (const p of parts) if (holdsSecret(p)) throw new Error(`refused to start ${what}: its command line would hold a secret, which every Mac user can read`);
}

// The parts of one call's command line: the program, each argument, and argv0 when options name one.
function partsOf(name, a) {
  const parts = [a[0]];
  let opts;
  if (name === 'exec' || name === 'execSync') opts = a[1];
  else if (Array.isArray(a[1])) { parts.push(...a[1]); opts = a[2]; } else opts = a[1];
  if (opts && typeof opts === 'object' && 'argv0' in opts) parts.push(opts.argv0);
  return parts;
}

const STARTS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
const WRAPPED = Symbol.for('orchestrate.secret-guard.wrapped');
const PROMISIFIED = Symbol.for('nodejs.util.promisify.custom');

function install() {
  for (const name of STARTS) {
    const real = cp[name];
    if (typeof real !== 'function' || real[WRAPPED]) continue;
    // The label is the start function's name only: the program's own name could be the secret.
    const check = (a) => { if (SECRETS.size) refuseSecretArgs(`a program (${name})`, partsOf(name, a)); };
    const guarded = function (...a) { check(a); return Reflect.apply(real, this, a); };
    // exec and execFile carry their own promisified form (util.promisify uses it), which starts the program without
    // going through the function above, so it is wrapped too.
    const custom = real[PROMISIFIED];
    if (typeof custom === 'function') guarded[PROMISIFIED] = function (...a) { check(a); return Reflect.apply(custom, this, a); };
    guarded[WRAPPED] = true;
    cp[name] = guarded;
  }
  syncBuiltinESMExports();
}
install();

/** True when the start functions are the wrapped ones (a test, and a program's start check, can ask). */
export const guardInstalled = () => STARTS.every((n) => cp[n]?.[WRAPPED] === true);
