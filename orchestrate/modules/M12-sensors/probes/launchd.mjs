// probes/launchd.mjs — "is this background job running?" (Mini Base, R-0b-169). true, false or null.
//
// Reads `launchctl print <domain>/<label>` and nothing else (a read-only command). The job's label and its domain
// (`gui/<uid>` for a login job, `system` for a machine job) come from the caller; none is named here.
//   state = running                        → true
//   any other state                        → false (loaded, but not running)
//   "Could not find service" (exit 113)    → false (not loaded at all)
//   anything else (no launchctl, time-out) → null (could not tell)

import { spawn } from 'node:child_process';

const LABEL = /^[A-Za-z0-9._-]{1,200}$/;
const DOMAIN = /^(system|gui\/\d{1,10}|user\/\d{1,10})$/;

/** The real command: no shell, no input, an end time. → { code, stdout, stderr } or { error }. */
export function runLaunchctl(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const c = spawn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const end = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { c.kill('SIGKILL'); end({ error: 'TIMEOUT' }); }, timeoutMs);
    c.stdout.on('data', (d) => { if (out.length < 1_000_000) out += d; });
    c.stderr.on('data', (d) => { if (err.length < 100_000) err += d; });
    c.once('error', (e) => end({ error: e?.code ?? 'ERROR' }));
    c.once('close', (code) => end({ code, stdout: out, stderr: err }));
  });
}

/** The job's own state line (one tab in), from `launchctl print`'s text, or null. */
export function stateOf(text) {
  const m = /^\tstate = (.+)$/m.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

export function launchdProbe({ label, domain, run = runLaunchctl } = {}) {
  if (typeof label !== 'string' || !LABEL.test(label)) throw new Error('the job probe needs a job label');
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) throw new Error('the job probe needs a domain: system, gui/<uid> or user/<uid>');
  return async () => {
    let r;
    try { r = await run(['print', `${domain}/${label}`]); } catch { return null; }
    if (!r || r.error) return null;
    if (r.code === 0) { const s = stateOf(r.stdout); return s === null ? null : s === 'running'; }
    return /Could not find service/.test(r.stderr ?? '') ? false : null;
  };
}
