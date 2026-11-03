// job-config.test-helper.mjs — a real installed layout for a test of a job that reads its config through
// shared/job-config.mjs (L253), owned by the test's own user (the reader accepts root or the job's own user).
//
//   const L = installedLayout('orch-jobcfg-', { files: { 'modules/x/wiring.mjs': 'export async function wire() {}' } });
//   L.write('dispatcher.json', { installRoot: L.installRoot, wiring: L.path('modules/x/wiring.mjs'), ... });
//   L.path(rel)   the file's path through the copy's link (installRoot/rel), as a job's config names it
//   dirs: ['wiring']   folders made in the copy (0755), for a test that writes its own files through L.path
//   source: true       the copy holds this checkout's orchestrate tree (as the install step copies it), so a real
//                      wiring in it imports its real modules, plus OUTSIDE_FILES at their repository paths beside it,
//                      as the install carries them; folders 0755, files 0644
//
// The layout is the install step's (install-check.mjs currentCopy): <base>/install → install.v-<commit>/orchestrate,
// the commit stamp in the versioned folder, every folder 0755 and every file 0644. `base` is the temp folder's real
// path, so no folder above it is a link (macOS's /var is one).
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempDir } from './test-tmp.mjs';
import { OUTSIDE_FILES, SOURCE, STAMP, installStamp, versionName } from '../modules/M4-workshop/launcher/install-check.mjs';

export const LAYOUT_COMMIT = 'c'.repeat(40);

const ORCH = fileURLToPath(new URL('..', import.meta.url));
const tidy = (p) => { const st = lstatSync(p); chmodSync(p, st.isDirectory() ? 0o755 : 0o644); if (st.isDirectory()) for (const n of readdirSync(p)) tidy(join(p, n)); };

export function installedLayout(prefix, { files = {}, dirs = [], source = false, commit = LAYOUT_COMMIT } = {}) {
  const base = realpathSync.native(tempDir(prefix));
  const installRoot = join(base, 'install');
  const folder = join(base, versionName(installRoot, commit));
  const copy = join(folder, SOURCE);
  mkdirSync(copy, { recursive: true });
  for (const d of [folder, copy]) chmodSync(d, 0o755);   // whatever the umask
  writeFileSync(join(folder, STAMP), installStamp(commit), { mode: 0o644 });
  symlinkSync(`${versionName(installRoot, commit)}/${SOURCE}`, installRoot);
  const path = (rel) => join(installRoot, rel);
  const write = (rel, body, mode = 0o644) => {
    mkdirSync(dirname(join(copy, rel)), { recursive: true });
    chmodSync(dirname(join(copy, rel)), 0o755);
    writeFileSync(join(copy, rel), typeof body === 'string' ? body : `${JSON.stringify(body, null, 1)}\n`, { mode });
    chmodSync(join(copy, rel), mode);   // the mode as asked, whatever the umask
    return path(rel);
  };
  if (source) {
    cpSync(ORCH, copy, { recursive: true, filter: (p) => !/\/(node_modules|\.git)(\/|$)/.test(p) }); tidy(copy);
    for (const rel of OUTSIDE_FILES) { const to = join(folder, rel); cpSync(join(ORCH, '..', rel), to); tidy(folder); }
  }
  for (const rel of dirs) { mkdirSync(join(copy, rel), { recursive: true }); chmodSync(join(copy, rel), 0o755); }
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return { base, installRoot, folder, copy, path, write };
}
