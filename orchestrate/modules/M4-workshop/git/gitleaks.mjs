// The secret scan inside the push script (review 0b-4 M3, m5, m7).
//
// A branch can try to silence the scanner four ways: an allow-list in its own .gitleaks.toml, a
// fingerprint in a .gitleaksignore, an inline `gitleaks:allow` comment, or a GITLEAKS_CONFIG
// variable. So the scan always runs the pinned binary by absolute path, with the Do-plane's own
// config (gitleaks' default rules for the pinned version, vendored in rules-<v>.gitleaks.toml with
// every allow-list removed, checked byte for byte and by hash each run; R-0b-47 MAT-1), an
// empty ignore file of the Do-plane's, inline comments ignored, and an environment built from
// scratch (safe-git's, which carries no GITLEAKS_* variable). The push script also refuses any
// added line holding `gitleaks:allow` itself, in case a later version drops the flag.
// The git scan reads patches, and a patch skips a file git thinks is binary, so every new file's
// raw bytes are also written to the private scan folder and scanned there (R-0b-47 MAT-2). That
// Only plain text, and images or fonts a product allows, get this far (binary-files.mjs, L28): any
// other file is refused unread. The `gitleaks dir` scan in turn skips a file whose first bytes
// mark it as an archive, a program, a database or a PDF, and finds nothing in UTF-16 text, so
// each file is written three ways: as it
// is, under its own name (rules that look at the name still fire); and, under a plain .txt name
// (gitleaks also skips some endings, such as .tar), behind a text lead-in that hides the marker,
// once as is and once with every zero byte removed (UTF-16 then reads as plain text); round 2
// MAT-A. A .zip or .tar.gz is opened two levels deep. These views are a second line now that
// such files are refused: they still read the text inside an allowed image. A file over the size
// cap is refused, not read (MIN-d).
// Capability note: --ignore-gitleaks-allow, the default rules' allow-lists (global: node_modules,
// lock files, images, fonts and more), `gitleaks dir` reading a file with NUL bytes, a type marker
// at a file's start (but not after a 600-byte text lead-in) making `gitleaks dir` skip it, and
// --max-archive-depth opening archives by their ending only, were checked against gitleaks 8.30.1
// on 29 Oct 2026. Void at the next pin: take that version's rules again.
// Clean means exit 0 and a report that reads as zero findings; anything else refuses.

import { spawn } from 'node:child_process';
import { readFileSync, lstatSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { git, safeGitEnv } from './safe-git.mjs';
import { checkFile } from './binary-files.mjs';

export const RULES_VERSION = '8.30.1';
export const DO_PLANE_TOML = readFileSync(new URL(`./rules-${RULES_VERSION}.gitleaks.toml`, import.meta.url), 'utf8');
// The hash catches an accidental change to the rules file. It sits beside the code that reads it, so
// it is no guard against someone who can edit both; only the Do-plane can edit either.
export const DO_PLANE_SHA256 = 'b6dbe4e0be74fdcba5453b8ea0353ef6175bee578d292f63c2c24ccd74ce6081';
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const refuse = (reason) => ({ ok: false, reason });

function run(bin, args, { env, input, timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, cwd: env.HOME });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    c.on('close', (code, signal) => resolve({ code: signal ? -1 : code, out, err }));
    c.stdin.on('error', () => { /* the scanner closed its input early; its exit code decides */ });
    c.stdin.end(input ?? '');
  });
}

/**
 * `setup` = { bin, version, config, ignoreFile }: the pinned binary, its pinned version, the
 * Do-plane config file and the Do-plane's empty ignore file. Checks them all before any scan.
 */
export async function checkScanner({ bin, version, config, ignoreFile }) {
  if (sha256(DO_PLANE_TOML) !== DO_PLANE_SHA256 || /allowlist/i.test(DO_PLANE_TOML.replace(/^#.*$/gm, ''))) return refuse('the vendored scanner rules have changed');
  if (version !== RULES_VERSION) return refuse(`the scanner rules were taken from gitleaks ${RULES_VERSION}; the pin is ${version}`);
  if (typeof bin !== 'string' || !isAbsolute(bin)) return refuse('the secret scanner is not pinned by absolute path');
  try { if (!statSync(bin).isFile()) return refuse('the secret scanner is missing'); } catch { return refuse('the secret scanner is missing'); }
  try { if (readFileSync(config, 'utf8') !== DO_PLANE_TOML) return refuse('the Do-plane scanner config has changed'); } catch { return refuse('the Do-plane scanner config is missing'); }
  try { const st = lstatSync(ignoreFile); if (!st.isFile() || st.size !== 0) return refuse('the Do-plane ignore file is not empty'); } catch { return refuse('the Do-plane ignore file is missing'); }
  const r = await run(bin, ['version'], { env: safeGitEnv({ gitDir: '/dev/null' }) });
  const m = /(\d+\.\d+\.\d+)/.exec(r.out);
  if (r.code !== 0 || !m) return refuse('the secret scanner did not report its version');
  if (m[1] !== version) return refuse(`the secret scanner is ${m[1]}, the pin is ${version}`);
  return { ok: true };
}

function readReport(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

const common = (setup, report) => ['--config', setup.config, '--gitleaks-ignore-path', setup.ignoreFile, '--ignore-gitleaks-allow',
  '--redact', '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report];

/** One verdict from one gitleaks run. Findings come back redacted, with file and rule only. */
function verdict(r, report, where = (f) => f || 'a commit message') {
  const found = readReport(report);
  if (r.code === 0 && found && found.length === 0) return { ok: true };
  if (r.code === 1 && found && found.length) {
    const list = [...new Set(found.map((f) => `${f.RuleID ?? 'rule'} in ${where(f.File)}`))];
    return refuse(`the secret scan found ${found.length} likely secret(s): ${list.slice(0, 5).join('; ')}`);
  }
  return refuse(`the secret scan did not finish cleanly (exit ${r.code})`);
}

// A file name safe to write: the path's last part with anything unusual replaced, so rules that
// look at the name (a key file's ending) still see it.
const safeName = (p) => (String(p).split('/').at(-1).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_') || '_').slice(0, 120);

// 600 bytes of plain text: far past where gitleaks looks for a file-type marker (up to byte 262).
const LEAD_IN = Buffer.from('scan view, not part of the file\n'.repeat(19));
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const VIEWS = ['raw', 'text', 'nul'];
const view = (k, buf) => (k === 'raw' ? buf : Buffer.concat([LEAD_IN, k === 'nul' ? buf.filter((x) => x !== 0) : buf]));

// A finding's file, put back as the repo path: the scan folder's own path never reaches a refusal (MIN-b).
const repoPath = (blobs) => (file) => {
  const m = /(?:^|\/)files\/(?:raw|text|nul)\/(\d+)\//.exec(String(file ?? ''));
  return m && blobs[Number(m[1])] ? String(blobs[Number(m[1])].path).slice(0, 200) : 'a new file';
};

/**
 * Scans the commits `shas` (all new, already checked) in the mirror, then every new file's raw
 * bytes (`blobs`: [{ id, path }], each added or changed file under each of its names; one that is
 * not plain text and not allowed by `allowedBinaries`, from binary-files.mjs, refuses), then each
 * commit's own text through stdin. `messages` is [[sha, text]]: the whole commit object (every
 * header line, the message) and the names of the files it touches. Clean is { ok: true, binaries }:
 * the allowed non-text files, for the read-back.
 */
export async function scanSecrets({ setup, mirror, shas, blobs = [], messages, privateDir, allowedBinaries = [], maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES }) {
  const c = await checkScanner(setup);
  if (!c.ok) return c;
  const dir = mkdtempSync(join(privateDir, 'scan-'));
  const binaries = [];
  try {
    const env = safeGitEnv({ gitDir: mirror });
    const report = join(dir, 'git.json');
    const logOpts = `--no-walk=unsorted ${shas.join(' ')}`;
    const r = await run(setup.bin, ['git', mirror, '--log-opts', logOpts, ...common(setup, report)], { env });
    const v = verdict(r, report);
    if (!v.ok) return v;
    if (blobs.length) {
      const files = join(dir, 'files');
      mkdirSync(files, { mode: 0o700 });
      for (const k of VIEWS) mkdirSync(join(files, k), { mode: 0o700 });
      let total = 0;
      for (const [i, b] of blobs.entries()) {
        const name = String(b.path).slice(0, 80);
        if (!/^[0-9a-f]{40}$/.test(String(b.id))) return refuse('a new file has no readable id');
        const size = await git(['cat-file', '-s', b.id], { gitDir: mirror, purpose: 'push-scan-files' });
        const n = Number(String(size.stdout).trim());
        if (size.code !== 0 || !Number.isSafeInteger(n)) return refuse(`could not read the new file ${name}`);
        total += n;
        if (n > maxFileBytes) return refuse(`the new file ${name} is larger than ${maxFileBytes} bytes, too large to scan`);
        if (total > maxTotalBytes) return refuse(`the new files come to more than ${maxTotalBytes} bytes, too much to scan`);
        const cat = await git(['cat-file', 'blob', b.id], { gitDir: mirror, purpose: 'push-scan-files' });
        if (cat.code !== 0 || cat.stdout.length !== n) return refuse(`could not read the new file ${name}`);
        const kind = checkFile(String(b.path), cat.stdout, allowedBinaries);
        if (!kind.ok) return refuse(kind.reason);
        if (kind.binary) binaries.push(kind.binary);
        for (const k of VIEWS) {
          const sub = join(files, k, String(i));
          mkdirSync(sub, { mode: 0o700 });
          writeFileSync(join(sub, k === 'raw' ? safeName(b.path) : 'view.txt'), view(k, cat.stdout), { mode: 0o600, flag: 'wx' });
        }
      }
      const fr = join(dir, 'files.json');
      const f = await run(setup.bin, ['dir', files, '--max-archive-depth', '2', ...common(setup, fr)], { env });
      const fv = verdict(f, fr, repoPath(blobs));
      if (!fv.ok) return refuse(`the file scan: ${fv.reason}`);
    }
    for (const [sha, text] of messages) {
      const rep = join(dir, `msg-${sha}.json`);
      const m = await run(setup.bin, ['stdin', ...common(setup, rep)], { env, input: text });
      const mv = verdict(m, rep);
      if (!mv.ok) return refuse(`commit ${sha.slice(0, 12)} message, header lines or file names: ${mv.reason}`);
    }
    return { ok: true, binaries };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
