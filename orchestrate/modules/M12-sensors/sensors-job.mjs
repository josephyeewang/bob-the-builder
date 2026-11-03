// sensors-job.mjs — the Sensors loop's background job file (R-0b-169).
//
// Laid out exactly as the Dispatcher's job (M11 login-job.mjs, the one builder of these files): node runs loop.mjs with
// its one config argument, every 60 s and once at load, with the same PATH, working folder and user rules. Only the
// label and the two log file names differ, so the Sensors' log is not mixed into the Dispatcher's. Every path is passed
// in (config); nothing here names a machine.

import { loginJobPlist } from '../M11-dispatcher/login-job.mjs';
import { EVERY_S } from './loop.mjs';

const LOGS = Object.freeze({ out: 'dispatcher.out.log', err: 'dispatcher.err.log' });

/** { label, node, script, config, path, logDir, workDir, userName? } → the plist text. Refuses what loginJobPlist refuses. */
export function sensorsJobPlist(o) {
  if (EVERY_S !== 60) throw new Error('the Sensors beat no longer matches the job file (StartInterval 60)');
  const text = loginJobPlist(o);
  const out = `${o.logDir}/${LOGS.out}`; const err = `${o.logDir}/${LOGS.err}`;
  // Each log path appears once, as written by loginJobPlist; anything else means its layout changed, so stop.
  const lines = text.split('\n');
  const at = (p) => lines.findIndex((l) => l.includes(`<string>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</string>`));
  const iOut = at(out); const iErr = at(err);
  if (iOut < 0 || iErr < 0 || text.split(LOGS.out).length !== 2 || text.split(LOGS.err).length !== 2) throw new Error('the Dispatcher job layout changed; update sensors-job.mjs');
  lines[iOut] = lines[iOut].replace(LOGS.out, 'sensors.out.log');
  lines[iErr] = lines[iErr].replace(LOGS.err, 'sensors.err.log');
  return lines.join('\n');
}
