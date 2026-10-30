// The plain-files check (launch check 3, R-0b-38; PreToolUse on Write|Edit|NotebookEdit).
//
// A role writes plain files only: never a tool or setup file (git, editor, package-manager, hook
// or Claude config), and in its outbox only a flat file named `<kind>-<id>.md|json|txt` of one of
// its own kinds. The Lead, Front Door, thinking room and Learning write nowhere but the outbox;
// other roles write only inside their code copy (--copy) or the outbox.

import { pathToFileURL } from 'node:url';
import { basename, dirname, sep } from 'node:path';
import { runHook, block, pass, landingPath, inside, realFolder } from './lib.mjs';

export const OUTBOX_ONLY_ROLES = Object.freeze(['lead', 'front_door', 'thinking', 'learning']);

// Folder names that hold tool settings, anywhere in a path (lower-cased compare).
const SETUP_FOLDERS = ['.git', '.claude', '.vscode', '.idea', '.husky', '.devcontainer', '.config'];
// File names that tools load on their own (lower-cased compare).
const SETUP_FILES = ['.envrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.mcp.json', 'claude.local.md',
  'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.pre-commit-config.yaml', 'pyrightconfig.json', '.gitconfig',
  '.gitattributes', '.gitmodules', '.git', 'skill.md', '.tool-versions', '.nvmrc', '.node-version', '.direnv'];

const fold = (s) => s.normalize('NFC').replace(/[​-‏⁠﻿]/g, '').toLowerCase();

export function isSetupPath(p) {
  const parts = p.split(sep).map(fold);
  if (parts.some((x) => SETUP_FOLDERS.includes(x))) return true;
  const name = parts[parts.length - 1];
  return SETUP_FILES.includes(name) || /^\.env(\..*)?$/.test(name);
}

export const OUTBOX_NAME = /^([a-z]+)-[A-Za-z0-9-]+\.(md|json|txt)$/;

export function decide(input, args) {
  const t = input.tool_input ?? {};
  const raw = typeof t.file_path === 'string' ? t.file_path : t.notebook_path;
  if (typeof raw !== 'string' || !raw) return block('no file path in the write');
  const p = landingPath(raw);
  if (!p) return block(`"${raw}" is not a plain absolute path`);
  const outbox = realFolder(args.outbox);
  if (!outbox) return block('the outbox is missing');

  if (inside(p, outbox)) {
    if (dirname(p) !== outbox) return block('outbox files must sit directly in the outbox');
    const m = OUTBOX_NAME.exec(basename(p));
    if (!m) return block(`"${basename(p)}" is not an outbox file name`);
    if (!args.kinds.includes(m[1])) return block(`the ${args.role} role may not hand in "${m[1]}" files`);
    return pass();
  }
  if (OUTBOX_ONLY_ROLES.includes(args.role)) return block(`the ${args.role} role writes only to its outbox`);
  if (isSetupPath(p)) return block(`"${raw}" is a tool or setup file`);
  const copy = args.copy ? realFolder(args.copy) : null;
  if (!copy || !inside(p, copy)) return block(`"${raw}" is outside the code copy`);
  return pass();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook(decide);
