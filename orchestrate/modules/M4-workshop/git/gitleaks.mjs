// The secret scan inside the push script (review 0b-4 M3, m5, m7).
//
// A branch can try to silence the scanner four ways: an allow-list in its own .gitleaks.toml, a
// fingerprint in a .gitleaksignore, an inline `gitleaks:allow` comment, or a GITLEAKS_CONFIG
// variable. So the scan always runs the pinned binary by absolute path, with the Do-plane's own
// config (gitleaks' default rules, no allow-lists of its own, checked byte for byte each run), an
// empty ignore file of the Do-plane's, inline comments ignored, and an environment built from
// scratch (safe-git's, which carries no GITLEAKS_* variable). The push script also refuses any
// added line holding `gitleaks:allow` itself, in case a later version drops the flag.
// Capability note: --ignore-gitleaks-allow checked against gitleaks 8.30.1 on 29 Oct 2026.
// Clean means exit 0 and a report that reads as zero findings; anything else refuses.

import { spawn } from 'node:child_process';
import { readFileSync, lstatSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { safeGitEnv } from './safe-git.mjs';

export const DO_PLANE_TOML = '# The Do-plane\'s own gitleaks config: the default rules, no allow-lists.\n[extend]\nuseDefault = true\n';
const refuse = (reason) => ({ ok: false, reason });

function run(bin, args, { env, input, timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, cwd: env.HOME });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    c.on('close', (code, signal) => resolve({ code: signal ? -1 : code, out, err }));
    c.stdin.end(input ?? '');
  });
}

/**
 * `setup` = { bin, version, config, ignoreFile }: the pinned binary, its pinned version, the
 * Do-plane config file and the Do-plane's empty ignore file. Checks them all before any scan.
 */
export async function checkScanner({ bin, version, config, ignoreFile }) {
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
function verdict(r, report) {
  const found = readReport(report);
  if (r.code === 0 && found && found.length === 0) return { ok: true };
  if (r.code === 1 && found && found.length) {
    return refuse(`the secret scan found ${found.length} likely secret(s): ${found.slice(0, 5).map((f) => `${f.RuleID ?? 'rule'} in ${f.File || 'a commit message'}`).join('; ')}`);
  }
  return refuse(`the secret scan did not finish cleanly (exit ${r.code})`);
}

/**
 * Scans the commits `shas` (all new, already checked) in the mirror, then each commit's message
 * and author fields through stdin. `messages` is [[sha, text]].
 */
export async function scanSecrets({ setup, mirror, shas, messages, privateDir }) {
  const c = await checkScanner(setup);
  if (!c.ok) return c;
  const dir = mkdtempSync(join(privateDir, 'scan-'));
  try {
    const env = safeGitEnv({ gitDir: mirror });
    const report = join(dir, 'git.json');
    const logOpts = `--no-walk=unsorted ${shas.join(' ')}`;
    const r = await run(setup.bin, ['git', mirror, '--log-opts', logOpts, ...common(setup, report)], { env });
    const v = verdict(r, report);
    if (!v.ok) return v;
    for (const [sha, text] of messages) {
      const rep = join(dir, `msg-${sha}.json`);
      const m = await run(setup.bin, ['stdin', ...common(setup, rep)], { env, input: text });
      const mv = verdict(m, rep);
      if (!mv.ok) return refuse(`commit ${sha.slice(0, 12)} message: ${mv.reason}`);
    }
    return { ok: true };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
