// The plain-files check (launch check 3, R-0b-38; PreToolUse on Write|Edit|NotebookEdit).
//
// A role writes plain files only: never a tool or setup file (git, editor, package-manager, hook
// or Claude config), and in its outbox only a flat file named `<kind><id>.md|json|txt` of one of
// its own kinds. The Lead, Front Door, thinking room and Learning write nowhere but the outbox;
// other roles write only inside their code copy (--copy) or the outbox.

import { basename, dirname, sep } from 'node:path';
import { isMain, runHook, block, pass, landingPath, inside, realFolder, linkedFile, fold, oddPath } from './lib.mjs';

export const OUTBOX_ONLY_ROLES = Object.freeze(['lead', 'front_door', 'thinking', 'learning']);

// Folder names that hold tool settings, anywhere in a path (lower-cased compare).
const SETUP_FOLDERS = ['.git', '.claude', '.vscode', '.idea', '.husky', '.devcontainer', '.config'];
// File names that tools load on their own (lower-cased compare).
const SETUP_FILES = ['.envrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.pnpmfile.cjs', '.mcp.json', 'claude.local.md',
  'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.pre-commit-config.yaml', 'pyrightconfig.json', '.gitconfig',
  '.gitattributes', '.gitmodules', '.git', 'skill.md', '.tool-versions', '.nvmrc', '.node-version', '.direnv'];


export function isSetupPath(p) {
  const parts = p.split(sep).map(fold);
  if (parts.some((x) => SETUP_FOLDERS.includes(x))) return true;
  const name = parts[parts.length - 1];
  return SETUP_FILES.includes(name) || /^\.env(\..*)?$/.test(name);
}

export const OUTBOX_NAME = /^[a-z]+-[A-Za-z0-9-]+\.(md|json|txt)$/;

// A name's kind, read as M9 reads it (L82 M-1): the longest listed prefix the name starts with. `kinds` is the role's
// own list (--kinds), `notKinds` the longer listed kinds it may not hand in (--not-kinds); both come from the one
// shared table through the launcher. Null when the name is none of the role's own.
export function kindIn(name, kinds, notKinds = []) {
  let best = null;
  // A kind is a name prefix, so it ends in a dash; anything else (an old first-word list) matches nothing.
  for (const k of [...kinds, ...notKinds]) if (typeof k === 'string' && /^[a-z]+(-[a-z]+)*-$/.test(k) && name.startsWith(k) && name.length > k.length && (!best || k.length > best.length)) best = k;
  return best !== null && kinds.includes(best) ? best : null;
}

export function decide(input, args) {
  const t = input.tool_input ?? {};
  const raw = typeof t.file_path === 'string' ? t.file_path : t.notebook_path;
  if (typeof raw !== 'string' || !raw) return block('no file path in the write');
  // Plain names only (L37): checked before anything is folded or looked up.
  const odd = oddPath(raw);
  if (odd) return block(odd);
  const p = landingPath(raw);
  if (!p) return block(`"${raw}" is not a plain absolute path, or is a link to nowhere yet`);
  // The Write tool runs outside the shell sandbox, so a link or a second name here would land the
  // write wherever it points (audit R-0b-44 M-2).
  const linked = linkedFile(raw) ?? linkedFile(p);
  if (linked) return block(`"${raw}" ${linked}`);
  const outbox = realFolder(args.outbox);
  if (!outbox) return block('the outbox is missing');

  if (inside(p, outbox)) {
    if (dirname(p) !== outbox) return block('outbox files must sit directly in the outbox');
    const name = basename(p);
    if (!OUTBOX_NAME.test(name)) return block(`"${name}" is not an outbox file name`);
    if (!kindIn(name, args.kinds, args.notKinds)) return block(`the ${args.role} role may not hand in "${name}"`);
    return pass();
  }
  if (OUTBOX_ONLY_ROLES.includes(args.role)) return block(`the ${args.role} role writes only to its outbox`);
  if (isSetupPath(p)) return block(`"${raw}" is a tool or setup file`);
  const copy = args.copy ? realFolder(args.copy) : null;
  if (!copy || !inside(p, copy)) return block(`"${raw}" is outside the code copy`);
  return pass();
}

if (isMain(import.meta.url)) runHook(decide);
