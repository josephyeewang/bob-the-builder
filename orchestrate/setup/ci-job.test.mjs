// ci-job.test.mjs — the setup commands need a Mac's own tools, so the Linux check skips those tests ("needs macOS tools;
// run by the macOS job"). That is only safe while the macOS job exists and runs them: this test fails if it goes missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '../../.github/workflows/scripts-ci.yml');

/** The text of each job in the workflow (a job starts at two spaces and a name, under `jobs:`). */
export function jobsOf(text) {
  const rest = text.split(/^jobs:\s*$/m)[1] ?? '';
  const out = {};
  let name = null;
  for (const line of rest.split('\n')) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; } else if (name) out[name] += `${line}\n`;
  }
  return out;
}

test('a macOS job runs every setup test; the Linux check cannot be the only place they run', () => {
  const jobs = jobsOf(readFileSync(WORKFLOW, 'utf8'));
  const macJobs = Object.entries(jobs).filter(([, body]) => /^\s+runs-on:\s*macos-/m.test(body));
  assert.ok(macJobs.length > 0, 'scripts-ci.yml has no macOS job: the tests that need the Mac\'s tools would be skipped everywhere');
  assert.ok(macJobs.some(([, body]) => /node --test[^\n]*orchestrate\/setup\//.test(body)), 'no macOS job runs `node --test` over orchestrate/setup/');
});

test('PLANT the macOS job removed or pointed at another folder → the check above fails', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const noMac = text.replace(/macos-latest/g, 'ubuntu-latest');
  const macJobs = (t) => Object.values(jobsOf(t)).filter((b) => /^\s+runs-on:\s*macos-/m.test(b) && /node --test[^\n]*orchestrate\/setup\//.test(b));
  assert.equal(macJobs(text).length > 0, true);
  assert.equal(macJobs(noMac).length, 0, 'a workflow with no Mac runner passes the guard');
  assert.equal(macJobs(text.replace('orchestrate/setup/*.test.mjs', 'orchestrate/shared/')).length, 0, 'a Mac job over another folder passes the guard');
});
