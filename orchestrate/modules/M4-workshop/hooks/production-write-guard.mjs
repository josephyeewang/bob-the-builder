// The production-write guard (design v4 §14.1.5, launch check 10, R-0b-36). Registered on every
// tool in every role file and in the machine-wide file as a fallback. It reads ONLY the rules
// snapshot, never GitHub or the network.
//
// Snapshot shape M4 reads (lane 1 publishes it; assumed until the shared reader lands):
//   rules.production = { env_files: [absolute paths], programs: [hosting / database program names],
//                        hosts: [production host names] }
// A missing or stale snapshot, or one without that block, blocks every call (fail closed).

import { basename, isAbsolute, resolve } from 'node:path';
import { isMain, runHook, block, pass, toolPaths, shellCommands, shellWords, programOf, landingPath, inside, joinLines, unreadable, expandBraces, fold } from './lib.mjs';

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
  // A Mac disk does not care about letter case, so names are compared folded (audit R-0b-44 round 2 MAT-2).
  const envFiles = prod.env_files.map((f) => fold(f));
  const programs = prod.programs.map((p) => fold(p));
  const touchesEnv = (p) => {
    const abs = isAbsolute(p) ? p : (typeof input.cwd === 'string' && isAbsolute(input.cwd) ? resolve(input.cwd, p) : p);
    const real = landingPath(abs) ?? abs;
    return envFiles.some((f) => [real, abs, p].some((x) => inside(fold(x), f)));
  };
  // A word naming a production settings file by its short name or a wildcard (`p*.x`), which a
  // `cd` beforehand could point at the real file (audit R-0b-44 M-5).
  const namesEnv = (w) => {
    const name = basename(w);
    if (!name) return false;
    let re = null;
    try { re = /[*?[]/.test(name) ? new RegExp(globRe(fold(name)).source, 'i') : null; } catch { return true; }
    return envFiles.some((f) => (re ? re.test(basename(f)) : basename(f) === fold(name)));
  };
  for (const p of toolPaths(input)) if (touchesEnv(p)) return block(`"${p}" is a production settings file`);

  if (input.tool_name === 'Bash') {
    // A short name is read from the session's folder; without it the guard can't tell (lane 3, R-0b-70).
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return block('the call gives no working folder, so a short file name can\'t be checked');
    const cmd = joinLines(input.tool_input?.command);
    // Shapes no hook can read are refused as a class (lib.mjs `unreadable`; R-0b-44 round 2 MAT-1, R-0b-70).
    const why = unreadable(cmd);
    if (why) return block(`${why}; write the command out plainly`);
    for (const c of shellCommands(cmd)) {
      const prog = programOf(c);
      if (programs.includes(fold(prog))) return block(`"${prog}" reaches production`);
      // Package runners that would start the program: npx <p>, bunx <p>, pnpm dlx <p>, npm exec <p>.
      if (['npx', 'bunx', 'pnpx'].includes(prog) || (['pnpm', 'npm', 'yarn'].includes(prog) && ['dlx', 'exec', 'x'].includes(c[1]))) {
        if (c.slice(1).some((w) => programs.includes(fold(basename(w.replace(/^--?[a-z-]+=/, '').split('@')[0]))))) return block('a package runner starts a production program');
      }
    }
    // Each word as the shell would expand its braces, and the value after `=` too (`of=<file>`, `F=<file>`).
    for (const word of shellWords(cmd)) {
      for (const w of expandBraces(word)) {
        if (prod.hosts.some((h) => fold(w).includes(fold(h)))) return block('the command names a production host');
        const forms = [w, ...(w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [])];
        if (forms.some((x) => x && !x.startsWith('-') && (touchesEnv(x) || namesEnv(x)))) return block(`the command names a production settings file (${word})`);
      }
    }
  }
  const url = input.tool_input?.url;
  if (typeof url === 'string' && prod.hosts.some((h) => fold(url).includes(fold(h)))) return block('the call names a production host');
  return pass();
}

if (isMain(import.meta.url)) runHook(decide);
