// The one way the wiring runs a synchronous port's command (lead's item 3 for 0b-6; audit 0b-6 r4 MAT-1).
// A port that answers synchronously blocks the thread, and no timer here can cut it short, so every such
// command runs as a child with its own time limit, a kill that cannot be ignored, and a cap on what it
// prints. This file never starts a process itself (only-send-safe.test.mjs): the wiring hands in Node's
// `spawnSync`, and `main.mjs` hands this maker to `wire()`.

export const SYNC_PORT_TIMEOUT_MS = 20_000;
export const SYNC_PORT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * `limitedSync(spawnSync)` returns `run(cmd, args, { timeoutMs, cwd, input })`, which never takes longer
 * than its limit: { ok: true, stdout } when the command ran and exited 0, else { ok: false, why }.
 * A port that gets `ok: false` answers "no answer", and its step fails and tells Joe as any failed step does.
 */
export function limitedSync(spawnSync) {
  if (typeof spawnSync !== 'function') throw new Error('limitedSync needs the spawnSync to run commands with');
  return function run(cmd, args = [], { timeoutMs = SYNC_PORT_TIMEOUT_MS, cwd, input } = {}) {
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return { ok: false, why: 'no time limit given' };
    let r;
    try {
      r = spawnSync(cmd, args, {
        cwd, input, encoding: 'utf8', shell: false, windowsHide: true,
        timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: SYNC_PORT_MAX_BUFFER,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, why: `could not run: ${e?.message ?? e}` };
    }
    if (r.error?.code === 'ETIMEDOUT') return { ok: false, why: `no answer within ${timeoutMs} ms` };
    if (r.error?.code === 'ENOBUFS') return { ok: false, why: 'printed more than the limit' };
    if (r.error) return { ok: false, why: `could not run: ${r.error.message}` };
    if (r.signal) return { ok: false, why: `stopped by ${r.signal}` };
    if (r.status !== 0) return { ok: false, why: `exited ${r.status}` };
    return { ok: true, stdout: r.stdout };
  };
}
