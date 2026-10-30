// The secret-file block (design v4 §14.1.5). Refuses any tool call that names a secret file:
// key files, env files, credential stores, and every path the rules list under `secrets.paths`.
// Belt and braces: the sandbox's read-deny list covers the same folders for the shell.

import { basename, sep, isAbsolute, resolve } from 'node:path';
import { isMain, runHook, block, pass, toolPaths, shellWords, landingPath, inside, fold, joinLines, unreadable, expandBraces, oddPath, oddWord } from './lib.mjs';
import { readSnapshot } from './snapshot.mjs';

const SECRET_NAME = [
  /^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /^\.netrc$/, /^\.npmrc$/,
  /^\.pgpass$/, /^credentials(\.json)?$/, /^\.git-credentials$/,
];
const ALLOWED_NAME = [/^\.env\.example$/, /^\.env\.sample$/];
const SECRET_FOLDERS = ['.ssh', '.aws', '.gnupg', '.docker', '.kube'];

// Names are compared folded: a Mac disk opens a folder named in capitals as the lower-case one
// (audit R-0b-44 round 2 MAT-2).
function builtIn(p) {
  const parts = fold(p).split(sep);
  const name = parts[parts.length - 1];
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
  return listed.some((l) => [real, abs, p].some((x) => x && inside(fold(x), fold(l))));
}

// A path part with a pattern (`.ss?`, `.e*`) is tried against the secret names it could match.
const SAMPLES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', '.netrc', '.npmrc', '.pgpass', 'credentials',
  'credentials.json', '.git-credentials', 'gh', 'key.pem', 'x.key', ...SECRET_FOLDERS];
const globPart = (x) => new RegExp(`^${x.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')}$`);
function patternMeetsSecret(w, listed) {
  const parts = fold(w).split(sep);
  const names = [...SAMPLES, ...listed.map((l) => basename(fold(l)))];
  return parts.some((x) => {
    if (!/[*?[]/.test(x)) return false;
    let re; try { re = globPart(x); } catch { return true; }
    return names.some((n) => re.test(n));
  });
}

// A short name a `cd` beforehand could point at a secret (audit R-0b-44 round 3 MIN-1), as the production
// guard's `namesEnv` does: `gh/hosts.yml`, or the last part of a path the rules list.
function shortName(w, listed) {
  const parts = fold(w).split(sep).filter(Boolean);
  const name = parts[parts.length - 1];
  if (!name || w.startsWith('-')) return false;
  if (name === 'hosts.yml' && parts[parts.length - 2] === 'gh') return true;
  return listed.some((l) => basename(fold(l)) === name);
}

export function decide(input, args) {
  const snap = readSnapshot(args.snapshot);
  if (!snap.ok) return block(snap.reason);
  const listed = snap.rules.secrets?.paths;
  if (!Array.isArray(listed)) return block('the rules snapshot lists no secret paths');
  const t = input.tool_input ?? {};
  for (const p of toolPaths(input)) {
    // Plain names first (L37): a look-alike letter the disk folds onto a secret's name never reaches the lists.
    const odd = oddPath(input.tool_name === 'Glob' && p === t.pattern ? p.replace(/[*?{},!]/g, '') : p);
    if (odd) return block(odd);
    if (isSecretPath(p, listed, input.cwd)) return block(`"${p}" is a secret file`);
  }
  // A search pattern counts with its wildcards taken out: `.env*` names `.env`.
  const bare = (g) => g.replace(/[*?[\]{}!]/g, '');
  for (const g of [input.tool_name === 'Grep' ? t.glob : null, input.tool_name === 'Glob' ? t.pattern : null]) {
    if (typeof g === 'string' && oddPath(g.replace(/[*?{},!]/g, ''))) return block(oddPath(g.replace(/[*?{},!]/g, '')));
    if (typeof g === 'string' && g.split(/[,{}]/).some((x) => isSecretPath(bare(x), listed) || isSecretPath(x, listed))) return block('the search names secret files');
  }
  if (input.tool_name === 'Bash') {
    // Every word is checked, as written and as a path from the session's folder, so a short name
    // that is a link to a secret is caught too.
    // Shapes no hook can read are refused as a class first (lib.mjs `unreadable`; round 2 MIN-3).
    const why = unreadable(t.command);
    if (why) return block(`${why}; write the command out plainly`);
    for (const word of shellWords(joinLines(t.command))) {
      for (const w of expandBraces(word)) {
        const odd = oddWord(w);
        if (odd) return block(odd);
        if (w.length > 1 && isSecretPath(w, listed, input.cwd)) return block(`the command names a secret file (${word})`);
        if (shortName(w, listed)) return block(`the command names a secret file by its short name (${word})`);
        if (patternMeetsSecret(w, listed)) return block(`the command's pattern could name a secret file (${word})`);
      }
    }
  }
  return pass();
}

if (isMain(import.meta.url)) runHook(decide);
