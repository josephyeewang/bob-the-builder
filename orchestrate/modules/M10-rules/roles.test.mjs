// roles.test.mjs — R-0b-14: the role profiles match the design's table, and the loader refuses any profile that
// could widen a role. Run: node --test orchestrate/modules/M10-rules/roles.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from '../../shared/test-tmp.mjs';
import { cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoles, profileFor, TOOLS_CHECKED, NEVER_TOOLS, ROLE_FILES } from './roles.mjs';
import { parsePolicy } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROLES = join(here, 'roles');
const PIN = TOOLS_CHECKED.claude_code;

// The design's table (v4 §14.1.2), written out as literal values; every file must match it.
const TABLE = {
  lead: { model: 'main', effort: 'high', tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion'], permission_mode: 'acceptEdits', restricted_mode: true, outbox_kinds: ['wish-', 'think-', 'scout-', 'write-', 'handoff-', 'roadmap-', 'history-'], auto_resume: false },
  worker: { model: 'main', effort: { 1: 'high', 2: 'medium' }, tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: ['report-', 'report-compact-', 'handin-'], auto_resume: { 1: false, 2: true } },
  reviewer: { model: 'main', effort: 'high', tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write'], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: ['verdict-'], auto_resume: false },
  incident: { model: 'main', effort: 'high', tools: ['Read', 'Glob', 'Grep'], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: ['ask-request-'], auto_resume: false },
  scout: { model: 'haiku', effort: 'low', tools: ['Read', 'Glob', 'Grep'], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: ['report-'], auto_resume: false },
  writer: { model: 'sonnet', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: ['report-'], auto_resume: false },
  front_door: { model: 'sonnet', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification', 'Skill'], permission_mode: 'acceptEdits', restricted_mode: true, outbox_kinds: ['request-', 'state-', 'idea-', 'state-compact-', 'ask-request-'], auto_resume: false },
  thinking: { model: 'main', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification'], permission_mode: 'acceptEdits', restricted_mode: true, outbox_kinds: ['report-', 'idea-'], auto_resume: false },
  script: { model: 'main', effort: 'per_row', tools: ['Read', 'Glob', 'Grep', 'Write', 'Workflow'], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: ['report-'], auto_resume: false },
  explore: { model: 'per_task', effort: 'as_asked', tools: [], permission_mode: 'dontAsk', restricted_mode: false, outbox_kinds: [], auto_resume: false },
};

function copyRoles() {
  const dir = tempDir('m10-roles-');
  cpSync(ROLES, dir, { recursive: true });
  return dir;
}
function withEdit(role, edit) {
  const dir = copyRoles();
  const f = join(dir, `${role}.json`);
  writeFileSync(f, JSON.stringify(edit(JSON.parse(readFileSync(f, 'utf8')))));
  const r = loadRoles(dir, { pin: PIN });
  return r;
}

test('every profile file matches the design table', () => {
  const r = loadRoles(ROLES, { pin: PIN });
  assert.ok(r.ok, r.reason);
  assert.deepEqual(Object.keys(TABLE).sort(), [...ROLE_FILES].sort());
  for (const [role, want] of Object.entries(TABLE)) {
    const got = r.profiles[role];
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${role}.${k}`);
  }
  assert.ok(!r.profiles.lead.tools.includes('Bash'), 'the Lead has no shell');
});

test('never-list tools, Workflow outside script, unknown tools, unknown fields and bad outbox kinds are refused', () => {
  for (const t of NEVER_TOOLS) assert.equal(withEdit('worker', (p) => ({ ...p, tools: [...p.tools, t] })).ok, false, t);
  assert.match(withEdit('worker', (p) => ({ ...p, tools: [...p.tools, 'Workflow'] })).reason, /Workflow/);
  assert.match(withEdit('worker', (p) => ({ ...p, tools: [...p.tools, 'bash'] })).reason, /unknown tool/);
  assert.match(withEdit('worker', (p) => ({ ...p, max_turns: 5 })).reason, /unknown field/);
  assert.match(withEdit('worker', (p) => ({ ...p, outbox_kinds: ['Report-'] })).reason, /bad outbox kind/);
  assert.match(withEdit('worker', (p) => ({ ...p, outbox_kinds: ['verdict-'] })).reason, /not listed for worker/);
  assert.match(withEdit('scout', (p) => ({ ...p, skills: ['orchestrate'] })).reason, /skill/);
  assert.match(withEdit('worker', (p) => ({ ...p, enforced: false })).reason, /explore/);
  assert.match(withEdit('worker', (p) => ({ ...p, role: 'lead' })).reason, /file says role/);
});

test('the compaction kinds load (0b-2 R2-M9 pattern), and a banned key in the text is refused', () => {
  assert.ok(loadRoles(ROLES, { pin: PIN }).profiles.worker.outbox_kinds.includes('report-compact-'));
  const dir = copyRoles();
  writeFileSync(join(dir, 'scout.json'), readFileSync(join(dir, 'scout.json'), 'utf8').replace('{', '{"__proto__": {"tools": ["Agent"]},'));
  assert.match(loadRoles(dir, { pin: PIN }).reason, /banned key/);
});

test('a missing or extra role file is refused', () => {
  const dir = copyRoles();
  rmSync(join(dir, 'explore.json'));
  assert.equal(loadRoles(dir, { pin: PIN }).ok, false);
  writeFileSync(join(dir, 'explore.json'), readFileSync(join(ROLES, 'explore.json')));
  writeFileSync(join(dir, 'learning.json'), '{}');
  assert.equal(loadRoles(dir, { pin: PIN }).ok, false);
});

test('the tool list expires with the Claude Code version it was checked against (R2-m8)', () => {
  const fixturePin = parsePolicy(readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8')).policy.claude_code.pin;
  assert.equal(TOOLS_CHECKED.claude_code, fixturePin, 'move TOOLS_CHECKED after re-checking the tool list');
  assert.match(loadRoles(ROLES, { pin: '2.1.301' }).reason, /re-check the list/);
  assert.equal(loadRoles(ROLES, {}).ok, false);
});

test('auditor maps to reviewer; learning is never started', () => {
  const r = loadRoles(ROLES, { pin: PIN });
  assert.equal(profileFor(r, 'auditor'), r.profiles.reviewer);
  assert.equal(profileFor(r, 'learning'), null);
  assert.equal(profileFor(r, 'nobody'), null);
  assert.equal(profileFor({ ok: false }, 'worker'), null);
});
