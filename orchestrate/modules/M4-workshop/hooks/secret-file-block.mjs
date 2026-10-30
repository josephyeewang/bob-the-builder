// The secret-file block (design v4 §14.1.5). Refuses any tool call that names a secret file:
// key files, env files, credential stores, and every path the rules list under `secrets.paths`.
// Belt and braces: the sandbox's read-deny list covers the same folders for the shell.

import { pathToFileURL } from 'node:url';
import { basename, sep, isAbsolute, resolve } from 'node:path';
import { runHook, block, pass, toolPaths, shellWords, landingPath, inside } from './lib.mjs';
import { readSnapshot } from './snapshot.mjs';

const SECRET_NAME = [
  /^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /^\.netrc$/, /^\.npmrc$/,
  /^\.pgpass$/, /^credentials(\.json)?$/, /^\.git-credentials$/,
];
const ALLOWED_NAME = [/^\.env\.example$/, /^\.env\.sample$/];
const SECRET_FOLDERS = ['.ssh', '.aws', '.gnupg', '.docker', '.kube'];

function builtIn(p) {
  const parts = p.split(sep);
  const name = basename(p);
  if (parts.includes('gh') && parts.includes('.config')) return true;
  if (parts.some((x) => SECRET_FOLDERS.includes(x))) return true;
  if (ALLOWED_NAME.some((r) => r.test(name))) return false;
  return SECRET_NAME.some((r) => r.test(name));
}

/**
 * The built-in checks run on the path as written AND where it really leads, so a file link
 * (`notes.txt` -> a key file) is caught (audit R-0b-44 M-3). A relative path is taken from `cwd`.
 */
export function isSecretPath(p, listed = [], cwd = null) {
  const abs = isAbsolute(p) ? p : (cwd && isAbsolute(cwd) ? resolve(cwd, p) : null);
  const real = abs ? landingPath(abs) : null;
  if (builtIn(p) || (real && builtIn(real))) return true;
  return listed.some((l) => (real && inside(real, l)) || (abs && inside(abs, l)) || inside(p, l));
}

export function decide(input, args) {
  const snap = readSnapshot(args.snapshot);
  if (!snap.ok) return block(snap.reason);
  const listed = snap.rules.secrets?.paths;
  if (!Array.isArray(listed)) return block('the rules snapshot lists no secret paths');
  const t = input.tool_input ?? {};
  for (const p of toolPaths(input)) if (isSecretPath(p, listed, input.cwd)) return block(`"${p}" is a secret file`);
  // A search pattern counts with its wildcards taken out: `.env*` names `.env`.
  const bare = (g) => g.replace(/[*?[\]{}!]/g, '');
  for (const g of [input.tool_name === 'Grep' ? t.glob : null, input.tool_name === 'Glob' ? t.pattern : null]) {
    if (typeof g === 'string' && g.split(/[,{}]/).some((x) => isSecretPath(bare(x), listed) || isSecretPath(x, listed))) return block('the search names secret files');
  }
  if (input.tool_name === 'Bash') {
    // Every word is checked, as written and as a path from the session's folder, so a short name
    // that is a link to a secret is caught too.
    for (const w of shellWords(t.command)) {
      if (w.length > 1 && isSecretPath(w, listed, input.cwd)) return block(`the command names a secret file (${w})`);
    }
  }
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
