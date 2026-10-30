// The production-write guard (design v4 §14.1.5, launch check 10, R-0b-36). Registered on every
// tool in every role file and in the machine-wide file as a fallback. It reads ONLY the rules
// snapshot, never GitHub or the network.
//
// Snapshot shape M4 reads (lane 1 publishes it; assumed until the shared reader lands):
//   rules.production = { env_files: [absolute paths], programs: [hosting / database program names],
//                        hosts: [production host names] }
// A missing or stale snapshot, or one without that block, blocks every call (fail closed).

import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { runHook, block, pass, toolPaths, shellCommands, shellWords, programOf, landingPath, inside } from './lib.mjs';
import { readSnapshot } from './snapshot.mjs';

export function decide(input, args) {
  const snap = readSnapshot(args.snapshot);
  if (!snap.ok) return block(snap.reason);
  const prod = snap.rules.production;
  if (!prod || !Array.isArray(prod.env_files) || !Array.isArray(prod.programs) || !Array.isArray(prod.hosts)) {
    return block('the rules snapshot has no production block');
  }
  const touchesEnv = (p) => {
    const real = landingPath(p) ?? p;
    return prod.env_files.some((f) => inside(real, f) || inside(p, f));
  };
  for (const p of toolPaths(input)) if (touchesEnv(p)) return block(`"${p}" is a production settings file`);

  if (input.tool_name === 'Bash') {
    const cmd = String(input.tool_input?.command ?? '');
    for (const c of shellCommands(cmd)) {
      const prog = programOf(c);
      if (prod.programs.includes(prog)) return block(`"${prog}" reaches production`);
      // Package runners that would start the program: npx <p>, bunx <p>, pnpm dlx <p>, npm exec <p>.
      if (['npx', 'bunx', 'pnpx'].includes(prog) || (['pnpm', 'npm', 'yarn'].includes(prog) && ['dlx', 'exec', 'x'].includes(c[1]))) {
        if (c.slice(1).some((w) => prod.programs.includes(basename(w.split('@')[0])))) return block('a package runner starts a production program');
      }
    }
    for (const w of shellWords(cmd)) {
      if (prod.hosts.some((h) => w.toLowerCase().includes(h.toLowerCase()))) return block('the command names a production host');
      if (w.startsWith('/') || w.startsWith('.')) if (touchesEnv(w)) return block(`the command names a production settings file (${w})`);
    }
  }
  const url = input.tool_input?.url;
  if (typeof url === 'string' && prod.hosts.some((h) => url.toLowerCase().includes(h.toLowerCase()))) return block('the call names a production host');
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
