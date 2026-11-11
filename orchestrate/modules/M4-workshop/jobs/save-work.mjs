#!/usr/bin/env node
// The save-work job (L969): run only by the lock-down runner (wiring/runner-locked.mjs), inside a worker's lock-down, as
// `node <this file> <base64 JSON arguments> <result file>`. It runs M4's saveWorkJob and writes its answer, as one JSON
// line, into the result file (new, never through a link). It is orchestrate's code, outside every copy; it imports only
// node's own modules and orchestrate's, by relative path, so nothing in the copy it runs in is loaded.
import { writeFileSync } from 'node:fs';
import { saveWorkJob } from '../git/save-work.mjs';

const [b64, out] = process.argv.slice(2);
let answer;
try {
  if (typeof b64 !== 'string' || typeof out !== 'string' || !out.startsWith('/')) throw new Error('the save-work job is run as: node save-work.mjs <arguments> <result file>');
  answer = await saveWorkJob(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
} catch (e) { answer = { ok: false, reason: String(e?.message ?? e).slice(0, 500) }; }
if (typeof out === 'string' && out.startsWith('/')) writeFileSync(out, `${JSON.stringify(answer)}\n`, { flag: 'wx', mode: 0o600 });
process.exitCode = answer.ok ? 0 : 1;
