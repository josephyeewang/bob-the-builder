// The Dispatcher's login job file (R-0b-55, R-0b-65; review 0b-6 m4).
//
// launchd starts a pass every 60 s and once at load. Every path is passed in (config); nothing here
// names a machine. Built for the Dispatcher and, with its own label and log names, for setup's robot
// job (setup/robot-setup.mjs, a system job running as orchestrate: `userName` set). `home` and
// `umask` are added only when a caller passes them (the robot job does, L734 answer 1), so the
// Dispatcher's job text is unchanged. `every` and `configFlag` likewise: the owner's answer job (setup/owner-answer-setup.mjs,
// L1051) runs every 300 s as `owner-answer.mjs --to <file>`; left out, the text is the 60 s one with the bare config argument.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s) => `<string>${esc(s)}</string>`;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const ABS = /^\/[^\0\n]*$/;
// One plain file-name part: no "/", "..", dot-name or space, so each log stays a file directly in logDir.
const LOG_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/**
 * { label, node, script, config, path, logDir, workDir, userName?, logName?, home?, umask?, every?, configFlag? } -> the plist text.
 * `every` is StartInterval in seconds (default 60, 60 to 3600); `configFlag` (a "--word") goes before `config` in the arguments.
 * `home` sets HOME beside PATH; `umask` (0..0o777) sets the job's Umask. Left out, neither key is written.
 * `config` is main.mjs's one argument; without it every run stops at once (audit 0b-6 r2 MAT-1).
 * `logName` names the two logs in logDir (<logName>.out.log, <logName>.err.log); left out, they are the Dispatcher's.
 * Another job built here passes its own, so no caller edits the text this returns (L246).
 * Refuses (throws) a bad label, a bad log name or a non-absolute path.
 */
export function loginJobPlist({ label, node, script, config, path, logDir, workDir, userName, logName = 'dispatcher', home, umask, every = 60, configFlag }) {
  if (!LABEL.test(String(label))) throw new Error('bad job label');
  if (typeof logName !== 'string' || !LOG_NAME.test(logName)) throw new Error('bad log name (letters, digits, "-" and "_", not starting with "-")');
  for (const [k, v] of Object.entries({ node, script, config, logDir, workDir })) if (!ABS.test(String(v))) throw new Error(`${k} must be an absolute path`);
  if (typeof path !== 'string' || !path || path.split(':').some((p) => !ABS.test(p))) throw new Error('PATH must be absolute folders joined by ":"');
  if (home !== undefined && !ABS.test(String(home))) throw new Error('home must be an absolute path');
  if (umask !== undefined && !(Number.isInteger(umask) && umask >= 0 && umask <= 0o777)) throw new Error('umask must be a whole number from 0 to 0o777');
  if (!(Number.isInteger(every) && every >= 60 && every <= 3600)) throw new Error('every must be a whole number of seconds from 60 to 3600');
  if (configFlag !== undefined && !/^--[a-z][a-z-]{0,30}$/.test(String(configFlag))) throw new Error('configFlag must be one "--word"');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(label)}`,
    `  <key>ProgramArguments</key><array>${str(node)}${str(script)}${configFlag === undefined ? '' : str(configFlag)}${str(config)}</array>`,
    `  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(path)}${home === undefined ? '' : `<key>HOME</key>${str(home)}`}</dict>`,
    `  <key>WorkingDirectory</key>${str(workDir)}`,
    `  <key>StartInterval</key><integer>${every}</integer>`,
    '  <key>RunAtLoad</key><true/>',
    ...(umask === undefined ? [] : [`  <key>Umask</key><integer>${umask}</integer>`]),
    `  <key>StandardOutPath</key>${str(`${logDir}/${logName}.out.log`)}`,
    `  <key>StandardErrorPath</key>${str(`${logDir}/${logName}.err.log`)}`,
  ];
  if (userName != null) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(userName))) throw new Error('bad user name');
    lines.push(`  <key>UserName</key>${str(userName)}`);
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}
