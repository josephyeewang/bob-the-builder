// The secret scanner the push step runs (L1083): the pinned gitleaks program and the Do-plane's own config and empty
// ignore file, put in place by root and checked fail-closed.
//
//   scanner --from <file>   (root) copies the gitleaks program named, only when its bytes hash to the pin below, into
//                           <base>/scanner, root:wheel 0755, and writes the Do-plane config (DO_PLANE_TOML, the push step's
//                           own copy, never retyped) and the empty ignore file beside it, root:wheel 0644. Nothing when
//                           all three already match.
//   check-scanner           (without sudo) every file's owner, mode, single name and hash, no access list, and then the push
//                           step's own check (gitleaks.mjs checkScanner): the config byte for byte, the ignore file empty,
//                           and the program run once with `version`, which must say the pinned version. Any doubt FAILs.
//
// The paths are layout.mjs's scannerPaths(cfg), the one place both this file and the push step's wiring read them (I7):
// no config key names them.
//
// The pin: gitleaks 8.30.1, darwin arm64 (the always-on Mac is Apple silicon). The tarball's hash is the one gitleaks
// publishes in gitleaks_8.30.1_checksums.txt; that file lists archives only, so the program's own hash was taken from
// the program inside that verified tarball (13 Nov 2026). A program of any other build or machine type FAILs, which is
// the point: a new pin takes a new version's rules too (gitleaks.mjs header) and both hashes again.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scannerDir, scannerPaths } from './layout.mjs';
import { aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { DO_PLANE_TOML, RULES_VERSION, checkScanner } from '../modules/M4-workshop/git/gitleaks.mjs';

export const SCANNER_VERSION = RULES_VERSION;
export const SCANNER_TARBALL = `gitleaks_${SCANNER_VERSION}_darwin_arm64.tar.gz`;
export const SCANNER_TARBALL_SHA256 = 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5';
export const SCANNER_BIN_SHA256 = 'ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f';
// Far above the program's 21 MB; a file past it is not read.
const MAX_BIN_BYTES = 64 * 1024 * 1024;

const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (h) => h.slice(0, 12);
const op = (text, run) => ({ text, run });

/** The three files, each with the mode and the bytes it must hold. `binSha` is the program's pin (a port for tests). */
function wanted(cfg, binSha) {
  const p = scannerPaths(cfg);
  return [
    { path: p.bin, mode: 0o755, sha: binSha, name: `the gitleaks ${SCANNER_VERSION} program` },
    { path: p.config, mode: 0o644, sha: sha(DO_PLANE_TOML), name: 'the Do-plane scanner config', text: DO_PLANE_TOML },
    { path: p.ignoreFile, mode: 0o644, sha: sha(''), name: 'the Do-plane\'s empty ignore file', text: '' },
  ];
}

/** Why the file at logical path `w.path` is not exactly as wanted, or null. Reads its bytes only once it is a plain file of root's. */
function fileProblem(io, w) {
  let st; try { st = io.lstat(w.path); } catch (e) { return e?.code === 'ENOENT' ? 'is missing' : `can't be looked at (${e?.code ?? e.message})`; }
  if (st.isSymbolicLink()) return 'is a link';
  if (!st.isFile()) return 'is not a plain file';
  if (st.uid !== io.rootUid || st.gid !== 0) return `is not root:wheel's (it is ${st.uid}:${st.gid})`;
  if ((st.mode & 0o7777) !== w.mode) return `has mode ${(st.mode & 0o7777).toString(8)}, want ${w.mode.toString(8)}`;
  if (st.nlink !== 1) return `has ${st.nlink} names (a second name could be changed apart from setup)`;
  if (st.size > MAX_BIN_BYTES) return 'is too big to be the pinned file';
  let got; try { got = sha(readFileSync(io.at(w.path))); } catch (e) { return `can't be read (${e?.code ?? e.message})`; }
  return got === w.sha ? null : `hashes to ${short(got)}…, want ${short(w.sha)}…`;
}

function folderProblem(io, dir) {
  let st; try { st = io.lstat(dir); } catch (e) { return e?.code === 'ENOENT' ? 'is missing' : `can't be looked at (${e?.code ?? e.message})`; }
  if (st.isSymbolicLink()) return 'is a link';
  if (!st.isDirectory()) return 'is not a folder';
  if (st.uid !== io.rootUid || st.gid !== 0) return `is not root:wheel's (it is ${st.uid}:${st.gid})`;
  if ((st.mode & 0o7777) !== 0o755) return `has mode ${(st.mode & 0o7777).toString(8)}, want 755`;
  return null;
}

/**
 * `scanner --from <file>`: root puts the pinned program and the push step's config in place. → { ops, problems }.
 * `readFrom(path)` reads the named program (a real path, outside the prefix; a port for tests). The program's bytes are
 * read once, hashed, and those same bytes are written: a file swapped after the hash is never the one copied.
 */
export function planScanner(io, cfg, { from, readFrom = (p) => readFileSync(p), binSha = SCANNER_BIN_SHA256 } = {}) {
  if (typeof from !== 'string' || !from.startsWith('/')) return { ops: [], problems: ['--from must be the full path of the gitleaks program taken out of the checked download'] };
  let st; try { st = io.lstatReal(from); } catch (e) { return { ops: [], problems: [`${from} can't be looked at (${e?.code ?? e.message})`] }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ops: [], problems: [`${from} is not a plain file (a link is not taken: name the program itself)`] };
  if (st.size > MAX_BIN_BYTES) return { ops: [], problems: [`${from} is too big to be the gitleaks program; nothing was read`] };
  let bytes; try { bytes = readFrom(from); } catch (e) { return { ops: [], problems: [`${from} can't be read (${e?.code ?? e.message})`] }; }
  const got = sha(bytes);
  if (got !== binSha) return { ops: [], problems: [`${from} hashes to ${short(got)}…, but the pinned gitleaks ${SCANNER_VERSION} (darwin arm64) program is ${short(binSha)}…; nothing was changed. Take it out of ${SCANNER_TARBALL} after checking that file's hash (README)`] };
  const dir = scannerDir(cfg);
  const ops = [];
  const fp = folderProblem(io, dir);
  if (fp === 'is missing') ops.push(op(`make ${dir}   (root:wheel 0755)`, () => { io.mkdir(dir, 0o700); io.secure(dir, { uid: io.rootUid, gid: 0, mode: 0o755 }); }));
  else if (fp) return { ops: [], problems: [`${dir} ${fp}; move it away and run this again (nothing was changed)`] };
  for (const w of wanted(cfg, binSha)) {
    if (fp === null && fileProblem(io, w) === null && aclProblem([io.at(w.path)]) === null) continue;
    const data = w.text ?? bytes;
    ops.push(op(`write ${w.path}   (root:wheel ${w.mode.toString(8)}, hash ${short(w.sha)}…)`, () => { io.unlink(w.path); io.writeOwned(w.path, data, { uid: io.rootUid, gid: 0, mode: w.mode }); }));
  }
  // The folder's own access list is never cleared here: one that is there was put there by hand, and someone should look.
  if (fp === null) { const acl = aclProblem([io.at(dir)]); if (acl) return { ops: [], problems: [`${acl}; nothing was changed`] }; }
  return { ops, problems: [] };
}

/** The files alone, read only → [{ ok, what, why? }]: the folder, each file, and no access list on any of them. */
export function checkScannerFiles(io, cfg, { binSha = SCANNER_BIN_SHA256 } = {}) {
  const dir = scannerDir(cfg);
  const fp = folderProblem(io, dir);
  const rows = [{ ok: fp === null, what: `${dir} is root:wheel 0755`, ...(fp ? { why: `it ${fp} (sudo node setup.mjs scanner --from <the program>, README)` } : {}) }];
  const ws = wanted(cfg, binSha);
  for (const w of ws) {
    const p = fp === null ? fileProblem(io, w) : 'was not looked at (its folder is not right)';
    rows.push({ ok: p === null, what: `${w.path}: ${w.name}, root:wheel ${w.mode.toString(8)}, hash ${short(w.sha)}…`, ...(p ? { why: `it ${p}` } : {}) });
  }
  if (rows.every((r) => r.ok)) {
    const acl = aclProblem([dir, ...ws.map((w) => w.path)].map((p) => io.at(p)));
    rows.push({ ok: acl === null, what: `${dir} and its files have no access list (ACL)`, ...(acl ? { why: acl } : {}) });
  }
  return rows;
}

/**
 * `check-scanner`: the files, then the push step's own check on them (checkScanner, which runs the program once with
 * `version`). Never as root: it runs a downloaded program. → Promise<[{ ok, what, why? }]>.
 */
export async function checkScannerSetup(io, cfg, { binSha = SCANNER_BIN_SHA256, gate = checkScanner } = {}) {
  const rows = checkScannerFiles(io, cfg, { binSha });
  const what = `the push step's own check passes: gitleaks reports ${SCANNER_VERSION}, the config is the Do-plane's byte for byte, the ignore file is empty`;
  if (!rows.every((r) => r.ok)) return [...rows, { ok: false, what, why: 'not run: put the files right first' }];
  const p = scannerPaths(cfg);
  let r; try { r = await gate({ bin: io.at(p.bin), version: SCANNER_VERSION, config: io.at(p.config), ignoreFile: io.at(p.ignoreFile) }); } catch (e) { r = { ok: false, reason: e?.message ?? 'it threw' }; }
  return [...rows, { ok: r?.ok === true, what, ...(r?.ok === true ? {} : { why: r?.reason ?? 'no answer' }) }];
}
