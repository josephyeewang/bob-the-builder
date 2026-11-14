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
// its own copy of this module and of child_process. The value is looked for as written and in its common encodings
// (base64 standard and URL-safe at any byte alignment, with or without padding; hex in either case; percent-encoding,
// L1191), the class of re-spelling a source scan can't close. The text is also read percent-decoded (any %XX or %uXXXX,
// so a value with only some characters encoded, or in encodeURI's, escape's or a query string's form with + for a space,
// is the value again; one level of decoding), and with its whitespace taken out (base64 wrapped at 64 or 76 columns,
// hex with spaces between the bytes) (L1196). A PEM key is registered as read, trimmed, as its base64 body alone, and
// as the key's bytes that body decodes to.
// Another encoding (base32, a cipher, a compressed form, twice percent-encoded) is not seen.
//
// Starts covered: the seven functions above, their promisified forms, and ChildProcess.prototype.spawn (the step every
// one of them goes through, for code that calls it on a ChildProcess it made itself). Parts checked: the program, each
// argument, and the options' argv0, shell (a string), execPath and execArgv (fork's).

import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

/** Shorter values are not registered: they would match ordinary text, and no token or key is this short. */
export const MIN_SECRET = 12;
const SECRETS = new Set();
// What is looked for in a command line: EXACT as written (the value, its base64 forms), LOWER in the text lowercased
// (hex and percent forms, whose letters may be either case).
const EXACT = new Set(); const LOWER = new Set();

/**
 * The value's base64 at each of the three byte alignments it can sit at inside a longer encoded run, standard and
 * URL-safe. Only the characters made wholly of the value's own bits are kept: the ones at either end mix in the bytes
 * around it or the padding, so the run is found with or without padding and whatever is next to it (#556 r10, L1191).
 */
function base64Forms(bytes) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const core = enc.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + bytes.length)) / 6));
    out.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}

/** A PEM's base64 body: the text between its BEGIN and END lines, whitespace taken out; null when it is not a PEM. */
function pemBody(value) {
  const m = /-----BEGIN [^-\r\n]+-----([\s\S]*?)-----END [^-\r\n]+-----/.exec(value);
  return m ? m[1].replace(/\s+/g, '') : null;
}

export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < MIN_SECRET || SECRETS.has(value)) return value;
  addSecret(value);
  // A PEM key also as it is trimmed (a reader that drops the last newline) and as its base64 body alone, the part
  // that is the key (L1196 Minor 2).
  addSecret(value.trim());
  const body = pemBody(value);
  if (body) { addSecret(body); addBytes(Buffer.from(body, 'base64')); }   // and the key's own bytes, re-encoded
  return value;
}

function addSecret(value) {
  if (value.length < MIN_SECRET || SECRETS.has(value)) return;
  SECRETS.add(value);
  EXACT.add(value);
  addBytes(Buffer.from(value, 'utf8'));
  LOWER.add(encodeURIComponent(value).toLowerCase());   // percent-encoded as a URL part would be
}

/** A value's bytes in their encodings: base64 (both alphabets, every alignment), hex, every byte percent-encoded. */
function addBytes(bytes) {
  if (bytes.length < MIN_SECRET) return;
  for (const f of base64Forms(bytes)) EXACT.add(f);
  const hex = bytes.toString('hex');
  LOWER.add(hex);                                   // hex, either case
  LOWER.add(hex.replace(/../g, '%$&'));             // every byte percent-encoded, either case
}

/**
 * The text with every %XX (and escape's %uXXXX) decoded, byte by byte: a % that starts no such run stays as it is, so
 * a malformed one never throws; bytes that are not valid UTF-8 read as U+FFFD, as the rest of the text does.
 */
function percentDecoded(s) {
  if (!s.includes('%')) return s;
  const out = []; let run = [];
  const flush = () => { if (run.length) { out.push(Buffer.from(run).toString('utf8')); run = []; } };
  for (let i = 0; i < s.length;) {
    const two = /^%([0-9a-fA-F]{2})/.exec(s.slice(i, i + 3));
    if (two) { run.push(parseInt(two[1], 16)); i += 3; continue; }
    flush();
    const u = /^%u([0-9a-fA-F]{4})/.exec(s.slice(i, i + 6));
    if (u) { out.push(String.fromCharCode(parseInt(u[1], 16))); i += 6; continue; }
    out.push(s[i]); i += 1;
  }
  flush();
  return out.join('');
}

/** True when this one spelling of the text holds a registered value as written or in a listed encoding. */
function spellingHolds(s) {
  for (const x of EXACT) if (s.includes(x)) return true;
  const low = s.toLowerCase();
  for (const x of LOWER) if (low.includes(x)) return true;
  return false;
}

export function holdsSecret(text) {
  if (!SECRETS.size || text === undefined || text === null) return false;
  let s;
  try { s = typeof text === 'string' ? text : Buffer.isBuffer(text) ? text.toString('utf8') : String(text); } catch { return true; }
  // The text as written, percent-decoded, and with + read as a space then percent-decoded (a query string's form); each
  // also with its whitespace taken out (L1196 M1, Minor 3).
  const spellings = new Set();
  for (const v of [s, percentDecoded(s), percentDecoded(s.replace(/\+/g, ' '))]) { spellings.add(v); spellings.add(v.replace(/\s+/g, '')); }
  for (const v of spellings) if (spellingHolds(v)) return true;
  return false;
}

export function refuseSecretArgs(what, parts) {
  for (const p of parts) if (holdsSecret(p)) throw new Error(`refused to start ${what}: its command line would hold a secret, which every Mac user can read`);
}

// The parts of one call's command line: the program, each argument, and what the options put on it (argv0, a shell
// named by path, fork's execPath and execArgv). Options sit after the arguments, or in their place: a skipped
// (undefined or null) argument list leaves them at a[2], as in spawn(cmd, undefined, { argv0 }) (L1196 Minor 1).
function partsOf(name, a) {
  const parts = [a[0]];
  let opts;
  if (Array.isArray(a[1])) { parts.push(...a[1]); opts = a[2]; } else if (a[1] === undefined || a[1] === null) opts = a[2]; else opts = a[1];
  return [...parts, ...optionParts(opts)];
}
function optionParts(opts) {
  if (!opts || typeof opts !== 'object') return [];
  const out = [];
  for (const k of ['argv0', 'execPath']) if (k in opts) out.push(opts[k]);
  if (typeof opts.shell === 'string') out.push(opts.shell);
  if (Array.isArray(opts.execArgv)) out.push(...opts.execArgv);
  return out;
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
  // ChildProcess.prototype.spawn: every start above ends here, and code holding a ChildProcess can call it directly.
  // Its one argument is the normalized options: file, then args (argv[0] first), and the shell's line inside args.
  const proto = cp.ChildProcess?.prototype; const realSpawn = proto?.spawn;
  if (typeof realSpawn === 'function' && !realSpawn[WRAPPED]) {
    const guarded = function (options) {
      if (SECRETS.size) refuseSecretArgs('a program (ChildProcess.spawn)', [options?.file, ...(Array.isArray(options?.args) ? options.args : [])]);
      return Reflect.apply(realSpawn, this, [options]);
    };
    guarded[WRAPPED] = true;
    proto.spawn = guarded;
  }
  syncBuiltinESMExports();
}
install();

/** True when the start functions are the wrapped ones (a test, and a program's start check, can ask). */
export const guardInstalled = () => STARTS.every((n) => cp[n]?.[WRAPPED] === true) && cp.ChildProcess.prototype.spawn?.[WRAPPED] === true;
