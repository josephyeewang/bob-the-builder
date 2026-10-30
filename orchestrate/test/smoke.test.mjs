import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Every module folder exists, so each lane can start in its own folders.
test('every module folder is present', () => {
  const want = ['M1-front-door', 'M2-approvals', 'M3-lead', 'M4-workshop', 'M5-review-audit', 'M6-merge-gate', 'M7-live-check',
    'M9-record', 'M10-rules', 'M11-dispatcher', 'M12-sensors', 'M13-ledger', 'M14-learning'];
  assert.deepEqual(readdirSync(new URL('../modules/', import.meta.url)).sort(), want.sort());
});
