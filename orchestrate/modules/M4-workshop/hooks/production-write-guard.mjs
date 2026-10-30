// The production-write guard (design v4 §14.1.5, launch check 10, R-0b-36). Registered on every
// tool in every role file and in the machine-wide file as a fallback. It reads ONLY the rules
// snapshot, never GitHub or the network.
//
// Snapshot shape M4 reads (lane 1 publishes it; assumed until the shared reader lands):
//   rules.production = { env_files: [absolute paths], programs: [hosting / database program names],
//                        hosts: [production host names] }
// A missing or stale snapshot, or one without that block, blocks every call (fail closed).

import { pathToFileURL } from 'node:url';
import { basename, isAbsolute, resolve } from 'node:path';
import { runHook, block, pass, toolPaths, shellCommands, shellWords, programOf, landingPath, inside, wrapperOf, builtCommandName } from './lib.mjs';

// A wildcard word as a pattern for one file name.
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')}$`);
import { readSnapshot } from './snapshot.mjs';

export function decide(input, args) {
  const snap = readSnapshot(args.snapshot);
  if (!snap.ok) return block(snap.reason);
  const prod = snap.rules.production;
  if (!prod || !Array.isArray(prod.env_files) || !Array.isArray(prod.programs) || !Array.isArray(prod.hosts)) {
    return block('the rules snapshot has no production block');
  }
  const touchesEnv = (p) => {
    const abs = isAbsolute(p) ? p : (typeof input.cwd === 'string' && isAbsolute(input.cwd) ? resolve(input.cwd, p) : p);
    const real = landingPath(abs) ?? abs;
    return prod.env_files.some((f) => inside(real, f) || inside(abs, f) || inside(p, f));
  };
  // A word naming a production settings file by its short name or a wildcard (`p*.x`), which a
  // `cd` beforehand could point at the real file (audit R-0b-44 M-5).
  const namesEnv = (w) => {
    const name = basename(w);
    if (!name) return false;
    let re = null;
    try { re = /[*?[]/.test(name) ? globRe(name) : null; } catch { return true; }
    return prod.env_files.some((f) => (re ? re.test(basename(f)) : basename(f) === name));
  };
  for (const p of toolPaths(input)) if (touchesEnv(p)) return block(`"${p}" is a production settings file`);

  if (input.tool_name === 'Bash') {
    const cmd = String(input.tool_input?.command ?? '');
    const wrap = wrapperOf(cmd, { inline: true });
    if (wrap) return block(`"${wrap}" runs code the guard can't check; run the command directly`);
    if (builtCommandName(cmd)) return block('a command name built from a variable or substitution can\'t be checked');
    for (const c of shellCommands(cmd)) {
      const prog = programOf(c);
      if (prod.programs.includes(prog)) return block(`"${prog}" reaches production`);
      // Package runners that would start the program: npx <p>, bunx <p>, pnpm dlx <p>, npm exec <p>.
      if (['npx', 'bunx', 'pnpx'].includes(prog) || (['pnpm', 'npm', 'yarn'].includes(prog) && ['dlx', 'exec', 'x'].includes(c[1]))) {
        if (c.slice(1).some((w) => prod.programs.includes(basename(w.replace(/^--?[a-z-]+=/, '').split('@')[0])))) return block('a package runner starts a production program');
      }
    }
    for (const w of shellWords(cmd)) {
      if (prod.hosts.some((h) => w.toLowerCase().includes(h.toLowerCase()))) return block('the command names a production host');
      if (!w.startsWith('-') && (touchesEnv(w) || namesEnv(w))) return block(`the command names a production settings file (${w})`);
    }
  }
  const url = input.tool_input?.url;
  if (typeof url === 'string' && prod.hosts.some((h) => url.toLowerCase().includes(h.toLowerCase()))) return block('the call names a production host');
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
