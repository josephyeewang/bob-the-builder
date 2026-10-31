// The LaunchDaemon files for the review side (L65). Both are root's and sit in the system folder; both run code
// only from the installed copy (`installRoot`, a root-owned copy of the orchestrate folder, with its own node at
// bin/node), never from the repository or a node the workers' Mac user can write: either would let a worker change what
// runs as `review`, or as root.
//
//   review runner   runs as `review` once a minute, and when a request arrives (WatchPaths on requests/)
//   account copy    runs as root when the owner switches account (WatchPaths on the owner's account file) and every
//                   5 minutes; copies a or b into a file anyone can read and only root can write (accounts.mjs copy-to)
//
//   updater         runs as root every 10 minutes; keeps the installed copy at main (review-updater.mjs, item 19)
//
// Every path is passed in; nothing here names a machine. The install itself is one of Joe's steps (README).

import { join } from 'node:path';
import { ACCOUNT_FILE } from './accounts.mjs';
import { REVIEW_USER } from './review-user.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s) => `<string>${esc(s)}</string>`;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const ABS = /^\/[^\0\n]*$/;
export const SCRIPTS = Object.freeze({
  runner: 'modules/M4-workshop/launcher/review-runner-main.mjs',
  accounts: 'modules/M4-workshop/launcher/accounts.mjs',
  updater: 'modules/M4-workshop/launcher/review-updater.mjs',
});
// The updater's own config, one of the copy's own items (review-updater.mjs `keep`).
export const UPDATER_CONFIG = 'updater.json';
export const UPDATE_EVERY_S = 600;
export const NODE = 'bin/node';
// The commit stamp (L66): the install writes the commit it copied, 40 hex and a newline, into this file at the top of
// the installed copy, root's like the rest. The runner shows it in its status; the Dispatcher tells Joe when it is not
// main's. `installStamp(commit)` is the file's text.
export const STAMP = 'installed-commit';
export function installStamp(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('the commit stamp must be a 40-hex commit');
  return `${commit}\n`;
}

function plist(entries) {
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>', ...entries.map((e) => `  ${e}`), '</dict>', '</plist>', ''].join('\n');
}
const arr = (xs) => `<array>${xs.map(str).join('')}</array>`;

/**
 * { label, installRoot, config, reviewRoot, reviewHome, accountCopy, ownerHome, ownerUid, logDir } → { runner, accountCopy }
 * (the two plist texts). `label` is a prefix: the jobs are <label>.review-runner and <label>.review-account.
 */
export function reviewDaemonPlists({ label, installRoot, config, reviewRoot, reviewHome, accountCopy, ownerHome, ownerUid, logDir }) {
  if (!LABEL.test(String(label))) throw new Error('bad job label');
  for (const [k, v] of Object.entries({ installRoot, config, reviewRoot, reviewHome, accountCopy, ownerHome, logDir })) if (!ABS.test(String(v))) throw new Error(`${k} must be an absolute path`);
  if (!Number.isInteger(ownerUid) || ownerUid <= 0) throw new Error('ownerUid must be the owner\'s uid');
  const node = join(installRoot, NODE);
  const path = '/usr/bin:/bin:/usr/sbin:/sbin';
  const runner = plist([
    `<key>Label</key>${str(`${label}.review-runner`)}`,
    `<key>UserName</key>${str(REVIEW_USER)}`,
    `<key>ProgramArguments</key>${arr([node, join(installRoot, SCRIPTS.runner), config])}`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key>${str(path)}<key>HOME</key>${str(reviewHome)}</dict>`,
    `<key>WorkingDirectory</key>${str(reviewHome)}`,
    '<key>Umask</key><integer>18</integer>',
    '<key>StartInterval</key><integer>60</integer>',
    `<key>WatchPaths</key>${arr([join(reviewRoot, 'requests')])}`,
    '<key>RunAtLoad</key><true/>',
    `<key>StandardOutPath</key>${str(join(logDir, 'review-runner.out.log'))}`,
    `<key>StandardErrorPath</key>${str(join(logDir, 'review-runner.err.log'))}`,
  ]);
  const copy = plist([
    `<key>Label</key>${str(`${label}.review-account`)}`,
    `<key>ProgramArguments</key>${arr([node, join(installRoot, SCRIPTS.accounts), 'copy-to', accountCopy, '--home', ownerHome, '--owner', String(ownerUid)])}`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key>${str(path)}</dict>`,
    '<key>WorkingDirectory</key><string>/</string>',
    '<key>Umask</key><integer>18</integer>',
    '<key>StartInterval</key><integer>300</integer>',
    `<key>WatchPaths</key>${arr([join(ownerHome, ACCOUNT_FILE)])}`,
    '<key>RunAtLoad</key><true/>',
    `<key>StandardErrorPath</key>${str(join(logDir, 'review-account.err.log'))}`,
  ]);
  return { runner, accountCopy: copy };
}

/**
 * The third LaunchDaemon (item 19): the updater, as root (no UserName), every 10 minutes and once when loaded. It runs
 * from the installed copy too, so it is updated with it, and only from main. → the plist text.
 */
export function updaterPlist({ label, installRoot, logDir }) {
  if (!LABEL.test(String(label))) throw new Error('bad job label');
  for (const [k, v] of Object.entries({ installRoot, logDir })) if (!ABS.test(String(v))) throw new Error(`${k} must be an absolute path`);
  return plist([
    `<key>Label</key>${str(`${label}.review-updater`)}`,
    `<key>ProgramArguments</key>${arr([join(installRoot, NODE), join(installRoot, SCRIPTS.updater), join(installRoot, UPDATER_CONFIG)])}`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key>${str('/usr/bin:/bin:/usr/sbin:/sbin')}</dict>`,
    '<key>WorkingDirectory</key><string>/</string>',
    '<key>Umask</key><integer>18</integer>',
    `<key>StartInterval</key><integer>${UPDATE_EVERY_S}</integer>`,
    '<key>RunAtLoad</key><true/>',
    `<key>StandardErrorPath</key>${str(join(logDir, 'review-updater.err.log'))}`,
  ]);
}
