// The Dispatcher's login job file (R-0b-55, R-0b-65; review 0b-6 m4).
//
// launchd starts a pass every 60 s and once at load. Every path is passed in (config); nothing here
// names a machine. Whether this is a per-user agent (needs the orchestrate user logged in) or a
// system job running as orchestrate is decided at the live proof and recorded (G-m7); `userName`
// is set only for the system-job form.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s) => `<string>${esc(s)}</string>`;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const ABS = /^\/[^\0\n]*$/;

/**
 * { label, node, script, path, logDir, workDir, userName? } -> the plist text.
 * Refuses (throws) a bad label or a non-absolute path.
 */
export function loginJobPlist({ label, node, script, path, logDir, workDir, userName }) {
  if (!LABEL.test(String(label))) throw new Error('bad job label');
  for (const [k, v] of Object.entries({ node, script, logDir, workDir })) if (!ABS.test(String(v))) throw new Error(`${k} must be an absolute path`);
  if (typeof path !== 'string' || !path || path.split(':').some((p) => !ABS.test(p))) throw new Error('PATH must be absolute folders joined by ":"');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(label)}`,
    `  <key>ProgramArguments</key><array>${str(node)}${str(script)}</array>`,
    `  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(path)}</dict>`,
    `  <key>WorkingDirectory</key>${str(workDir)}`,
    '  <key>StartInterval</key><integer>60</integer>',
    '  <key>RunAtLoad</key><true/>',
    `  <key>StandardOutPath</key>${str(`${logDir}/dispatcher.out.log`)}`,
    `  <key>StandardErrorPath</key>${str(`${logDir}/dispatcher.err.log`)}`,
  ];
  if (userName != null) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(userName))) throw new Error('bad user name');
    lines.push(`  <key>UserName</key>${str(userName)}`);
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}
