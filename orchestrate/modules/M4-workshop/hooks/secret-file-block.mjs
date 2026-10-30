// The secret-file block (design v4 §14.1.5). Refuses any tool call that names a secret file:
// key files, env files, credential stores, and every path the rules list under `secrets.paths`.
// Belt and braces: the sandbox's read-deny list covers the same folders for the shell.

import { pathToFileURL } from 'node:url';
import { basename, sep } from 'node:path';
import { runHook, block, pass, toolPaths, shellWords, landingPath, inside } from './lib.mjs';
import { readSnapshot } from './snapshot.mjs';

const SECRET_NAME = [
  /^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /^\.netrc$/, /^\.npmrc$/,
  /^\.pgpass$/, /^credentials(\.json)?$/, /^\.git-credentials$/,
];
const ALLOWED_NAME = [/^\.env\.example$/, /^\.env\.sample$/];
const SECRET_FOLDERS = ['.ssh', '.aws', '.gnupg', '.docker', '.kube'];

export function isSecretPath(p, listed = []) {
  const parts = p.split(sep);
  const name = basename(p);
  if (parts.includes('gh') && parts.includes('.config')) return true;
  if (parts.some((x) => SECRET_FOLDERS.includes(x))) return true;
  if (ALLOWED_NAME.some((r) => r.test(name))) return false;
  if (SECRET_NAME.some((r) => r.test(name))) return true;
  const real = landingPath(p) ?? p;
  return listed.some((l) => inside(real, l) || inside(p, l));
}

export function decide(input, args) {
  const snap = readSnapshot(args.snapshot);
  if (!snap.ok) return block(snap.reason);
  const listed = snap.rules.secrets?.paths;
  if (!Array.isArray(listed)) return block('the rules snapshot lists no secret paths');
  const t = input.tool_input ?? {};
  for (const p of toolPaths(input)) if (isSecretPath(p, listed)) return block(`"${p}" is a secret file`);
  // A search pattern counts with its wildcards taken out: `.env*` names `.env`.
  const bare = (g) => g.replace(/[*?[\]{}!]/g, '');
  for (const g of [input.tool_name === 'Grep' ? t.glob : null, input.tool_name === 'Glob' ? t.pattern : null]) {
    if (typeof g === 'string' && g.split(/[,{}]/).some((x) => isSecretPath(bare(x), listed) || isSecretPath(x, listed))) return block('the search names secret files');
  }
  if (input.tool_name === 'Bash') {
    for (const w of shellWords(t.command)) {
      if (w.includes('/') || w.startsWith('.') || /\.(pem|key)$/.test(w)) if (isSecretPath(w, listed)) return block(`the command names a secret file (${w})`);
    }
  }
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
