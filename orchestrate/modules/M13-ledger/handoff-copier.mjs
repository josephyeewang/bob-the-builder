#!/usr/bin/env node
// handoff-copier.mjs — the read-only copier (R-1-32; design v4 §7.2 R6, §14.3 "R6 read-only copier (Joe's user)").
//
// A plain script, no AI, run as the owner's own Mac user every 15 minutes (copierAgentPlist below). For each product it
// copies the Ledger's `<from>/<product>.md` (handoff-copy.mjs, R-1-31) to Dropbox's `<to>/<product>.md` and leaves
// the copy read-only (0444), so a write to it from a session, a Terminal redirect or another app on the Mini fails.
//
// Dropbox does not carry the permission to the Air, so an edit made there syncs back. So does a deliberate permission
// change on the Mini. Either way the next run finds a copy that is not the one it last wrote, puts the Ledger's back,
// and logs the difference (one JSON line in `<state>/handoff-copier.log`): at most 15 minutes of a wrong copy.
//
// It only ever replaces `<to>/<product>.md`, by a temp file renamed over it; a copy that is a link or not a plain file,
// a source that is a link, a folder that is a link, or a product name not on the record's pattern is refused and
// reported, nothing written. A missing source copies nothing (the copy stays the last good one). It never runs as root.
//
//   node handoff-copier.mjs --from <Ledger's handoff folder> --to <Dropbox handoffs folder> --state <its own folder> --product <p> [--product <q> …]
//   exit 0: every product copied or already current; exit 1: any problem (each said on stderr: a refused product, a
//   difference not logged, what was written not saved or not readable); exit 2: bad arguments or run as root.

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../../shared/product-paths.mjs';

export const READ_ONLY = 0o444;
export const EVERY_S = 15 * 60;
export const LOG_NAME = 'handoff-copier.log';
export const STATE_NAME = 'handoff-copier.json';
const DIFF_LINES = 40;
const LINE_CHARS = 200;

const sha = (s) => createHash('sha256').update(s).digest('hex');

export const nodeCopierFs = () => ({
  lstat: (p) => { try { return lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } },
  /** A plain file's text, opened without following a link → { text, mode } | null when absent. */
  readPlain: (p) => {
    let fd;
    try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw Object.assign(new Error('not a plain file'), { code: 'ENOTFILE' });
      return { text: readFileSync(fd, 'utf8'), mode: st.mode & 0o7777 };
    } finally { closeSync(fd); }
  },
  replace: (dir, name, text, mode) => {
    const tmp = join(dir, `.${name}.tmp-${process.pid}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(tmp, mode);
      renameSync(tmp, join(dir, name));
    } catch (e) { rmSync(tmp, { force: true }); throw e; }
  },
  append: (p, line) => appendFileSync(p, line, { mode: 0o600 }),
  saveState: (dir, obj) => {
    const tmp = join(dir, `.${STATE_NAME}.tmp-${process.pid}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeSync(fd, JSON.stringify(obj)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, join(dir, STATE_NAME));
    } catch (e) { rmSync(tmp, { force: true }); throw e; }
  },
});

/** The lines in one text and not the other, capped: what an edit changed, for the log. */
export function lineDiff(copy, ledger) {
  const a = copy.split('\n'); const b = ledger.split('\n');
  const inA = new Set(a); const inB = new Set(b);
  const out = [...a.filter((l) => !inB.has(l)).map((l) => `+ ${l}`), ...b.filter((l) => !inA.has(l)).map((l) => `- ${l}`)];
  return { lines: out.slice(0, DIFF_LINES).map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l)), more: Math.max(0, out.length - DIFF_LINES) };
}

const isDir = (st) => st && st.isDirectory() && !st.isSymbolicLink();

/**
 * One product, once. state: { [product]: sha of the copy last written } (read by the caller; an unknown entry means
 * "can't tell what was last written", so any difference is logged).
 * → { ok: true, product, wrote: bool, logged: null | { … } , last } | { ok: false, product, reason }
 */
export function copyOne({ product, from, to, state, fs, now }) {
  const no = (reason) => ({ ok: false, product, reason });
  if (typeof product !== 'string' || !PRODUCT.test(product)) return no(`not a product name: ${JSON.stringify(product)}`);
  for (const [what, d] of [['the Ledger\'s folder', from], ['the Dropbox folder', to]]) {
    let st; try { st = fs.lstat(d); } catch (e) { return no(`${what} can't be read: ${e?.code ?? e}`); }
    if (!isDir(st)) return no(`${what} is missing, a link or not a folder: ${d}`);
  }
  const name = `${product}.md`;
  let src; let dst;
  try { src = fs.readPlain(join(from, name)); } catch (e) { return no(`the Ledger's copy can't be read (${e?.code ?? e}): it must be a plain file`); }
  if (!src) return { ok: true, product, wrote: false, logged: null, none: true, last: state[product] ?? null };
  try { dst = fs.readPlain(join(to, name)); } catch (e) { return no(`the Dropbox copy is not a plain file (${e?.code ?? e}); it was left as it is`); }
  const want = sha(src.text);
  const last = typeof state[product] === 'string' ? state[product] : null;
  let logged = null;
  if (dst) {
    const have = sha(dst.text);
    const edited = have !== want && have !== last;
    const opened = (dst.mode & 0o222) !== 0;
    if (edited || opened) {
      logged = { at: new Date(now()).toISOString(), product, ...(edited ? { what: last ? 'edited' : 'differs, and what was last written is not known' } : {}),
        ...(opened ? { mode: `0${dst.mode.toString(8)}` } : {}), copy_sha256: have, ledger_sha256: want,
        ...(edited ? { diff: lineDiff(dst.text, src.text) } : {}) };
    }
    if (have === want && !opened) return { ok: true, product, wrote: false, logged: null, last: want };
  }
  try { fs.replace(to, name, src.text, READ_ONLY); } catch (e) { return no(`the Dropbox copy could not be written: ${e?.code ?? e?.message ?? e}`); }
  return { ok: true, product, wrote: true, logged, last: want };
}

/** Every product, once: copies, logs each difference, saves what it wrote. → { ok, results, problems } */
export function runCopier({ products, from, to, stateDir, fs = nodeCopierFs(), now = () => Date.now() }) {
  const problems = [];
  let st; try { st = fs.lstat(stateDir); } catch { st = null; }
  if (!isDir(st)) return { ok: false, results: [], problems: [`the copier's own folder is missing, a link or not a folder: ${stateDir}`] };
  let state = {};
  try {
    const s = fs.readPlain(join(stateDir, STATE_NAME));
    if (s) { const v = JSON.parse(s.text); if (v && typeof v === 'object' && !Array.isArray(v)) state = v; else throw new Error('not an object'); }
  } catch (e) { problems.push(`what was last written can't be read (${e?.code ?? e?.message ?? e}): every difference is logged this run`); state = {}; }
  const results = products.map((product) => copyOne({ product, from, to, state, fs, now }));
  const next = { ...state };
  for (const r of results) {
    if (!r.ok) { problems.push(`${r.product}: ${r.reason}`); continue; }
    if (r.last) next[r.product] = r.last;
    if (r.logged) {
      try { fs.append(join(stateDir, LOG_NAME), `${JSON.stringify(r.logged)}\n`); } catch (e) { problems.push(`${r.product}: the difference could not be logged (${e?.code ?? e})`); }
    }
  }
  try { fs.saveState(stateDir, next); } catch (e) { problems.push(`what was written could not be saved (${e?.code ?? e}): the next run logs each copy as not known`); }
  return { ok: problems.length === 0, results, problems };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The owner's LaunchAgent that runs the copier every 15 minutes, as the owner's own user (owner step in the README). */
export function copierAgentPlist({ label, node, script, from, to, stateDir, products }) {
  const args = [node, script, '--from', from, '--to', to, '--state', stateDir, ...products.flatMap((p) => ['--product', p])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>${EVERY_S}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xml(join(stateDir, 'handoff-copier.err'))}</string>
</dict>
</plist>
`;
}

export function parseArgs(argv) {
  const o = { products: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
    if (k === '--from') o.from = v; else if (k === '--to') o.to = v; else if (k === '--state') o.stateDir = v;
    else if (k === '--product') o.products.push(v); else throw new Error(`unknown option ${k}`);
  }
  if (!o.from || !o.to || !o.stateDir || !o.products.length) throw new Error('--from, --to, --state and at least one --product are needed');
  return o;
}

// Started through a link (#261), argv[1] is the link: resolved before comparing, or the script would do nothing and exit 0.
const runAsScript = () => { try { return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch { return false; } };
if (runAsScript()) {
  if (process.getuid?.() === 0) { process.stderr.write('handoff-copier: runs as the owner\'s own user, never as root\n'); process.exit(2); }
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`handoff-copier: ${e.message}\n`); process.exit(2); }
  const r = runCopier(o);
  for (const p of r.problems) process.stderr.write(`handoff-copier: ${p}\n`);
  process.exit(r.ok ? 0 : 1);
}
