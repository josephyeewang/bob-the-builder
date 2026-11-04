// sensors-job.mjs — the Sensors loop's background job file (R-0b-169).
//
// Laid out exactly as the Dispatcher's job (M11 login-job.mjs, the one builder of these files): node runs loop.mjs with
// its one config argument, every 60 s and once at load, with the same PATH, working folder and user rules. Only the
// label and the two log file names differ, so the Sensors' log is not mixed into the Dispatcher's. Every path is passed
// in (config); nothing here names a machine.

import { loginJobPlist } from '../M11-dispatcher/login-job.mjs';
import { EVERY_S } from './loop.mjs';

/** { label, node, script, config, path, logDir, workDir, userName? } → the plist text. Refuses what loginJobPlist refuses. */
export function sensorsJobPlist(o) {
  if (EVERY_S !== 60) throw new Error('the Sensors beat no longer matches the job file (StartInterval 60)');
  return loginJobPlist({ ...o, logName: 'sensors' });
}
