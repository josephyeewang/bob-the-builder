// L137 MAT-1: every outbox kind a role may write has a record rule, or says it is not a record (`record: 'none'`, with
// the module that handles it). A kind with neither is one the real Record refuses: a Lead's think- request would raise
// a false "record refused" alert on every pass. The kinds come from all three places that say who writes what: the
// role profiles (M10 roles/*.json, outbox_kinds), shared OUTBOX_KINDS' own role lists (learning has no M10 profile;
// NEVER_STARTED), and M4's DESIGN_PROFILES (what M11 intake lets a session hand in).
//
// This is a todo until the per-kind fix (L137, after the M11 typed-reads PR): it runs and lists the gaps, but does
// not fail the run yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_KINDS } from '../../shared/record.mjs';
import { ROLE_FILES } from '../M10-rules/roles.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../M10-rules/roles');

// Every (role, kind) pair any role may write, from both places that say so.
function writable() {
  const pairs = [];
  for (const role of ROLE_FILES) {
    const p = JSON.parse(readFileSync(join(ROLES_DIR, `${role}.json`), 'utf8'));
    for (const k of p.outbox_kinds ?? []) pairs.push([role, k, 'profile']);
  }
  for (const [k, spec] of Object.entries(OUTBOX_KINDS)) for (const role of spec.roles) pairs.push([role, k, 'OUTBOX_KINDS']);
  // M4's design table, which M11 intake's kindsFor() reads: since main 27878ca it holds full kinds, trailing dash included.
  for (const [role, p] of Object.entries(DESIGN_PROFILES)) for (const k of p.outbox) pairs.push([role, k, 'M4 DESIGN_PROFILES']);
  return pairs;
}

test('L137: the role profiles name some outbox kinds (the cross-check below reads something)', () => {
  assert.ok(writable().filter(([, , from]) => from === 'profile').length > 0);
});

test('L137 MAT-1: every kind a role may write has a record rule or record: \'none\' with handledBy', {
  todo: 'L137: the per-kind table goes to the lead first; the fix gives each kind a rule or record: \'none\'',
}, () => {
  const gaps = new Set();
  for (const [role, k, from] of writable()) {
    const spec = OUTBOX_KINDS[k];
    const ok = spec && (spec.entity || (spec.record === 'none' && typeof spec.handledBy === 'string' && spec.handledBy));
    if (!ok) gaps.add(`${role}: ${k} (${spec ? 'no record rule' : 'not in OUTBOX_KINDS'}; from ${from})`);
  }
  assert.deepEqual([...gaps].sort(), [], `kinds a role may write that the Record refuses:\n${[...gaps].sort().join('\n')}`);
});
