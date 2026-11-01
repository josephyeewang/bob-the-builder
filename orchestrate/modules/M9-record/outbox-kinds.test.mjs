// L137 MAT-1, L140, L141: every outbox kind a role may write has a record rule, or says it is not a record
// (`record: 'none'`, with the module that handles it). A kind with neither is one the real Record refuses: a Lead's
// think- request would raise a false "record refused" alert on every pass. The kinds come from all three places that
// say who writes what: the role profiles (M10 roles/*.json, outbox_kinds), shared OUTBOX_KINDS' own role lists
// (learning has no M10 profile; NEVER_STARTED), and M4's DESIGN_PROFILES (what M11 intake lets a session hand in).
//
// L140 condition 1: no kind is a black hole. A kind stored as a report is inert, so it names its reader, the join item
// that wires one, or why nothing writes it; `kept` is only for the three kinds written before L140 (L141).
// L140 condition 2: the report-create grant derives from OUTBOX_KINDS, so the roles it reaches are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITIES, NOT_A_RECORD, OUTBOX_KINDS, isNotARecord, memoryRecord, notARecord } from '../../shared/record.mjs';
import { NEVER_STARTED, ROLE_FILES } from '../M10-rules/roles.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';
import { WRITERS, fieldsAllowed } from './permissions.mjs';
import { outboxFile, setup } from './fixtures.test-helper.mjs';

const MODULES = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES_DIR = join(MODULES, 'M10-rules/roles');
const WHO_READS = ['reader', 'pending', 'latent', 'kept'];
const KEPT_KINDS = ['report-', 'report-compact-', 'state-compact-'];

// Every (role, kind) pair any role may write, from all three places that say so.
function writable() {
  const pairs = [];
  for (const role of ROLE_FILES) {
    const p = JSON.parse(readFileSync(join(ROLES_DIR, `${role}.json`), 'utf8'));
    for (const k of p.outbox_kinds ?? []) pairs.push([role, k, 'profile']);
  }
  for (const [k, spec] of Object.entries(OUTBOX_KINDS)) for (const role of spec.roles) pairs.push([role, k, 'OUTBOX_KINDS']);
  // M4's design table, which M11 intake's kindsFor() reads: its kinds have no trailing dash ('ask' is the file kind ask-).
  for (const [role, p] of Object.entries(DESIGN_PROFILES)) for (const k of p.outbox) pairs.push([role, `${k}-`, 'M4 DESIGN_PROFILES']);
  return pairs;
}

// The numbered items under a module README's "## Join items" heading.
function joinItems(module) {
  const f = join(MODULES, module, 'README.md');
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  const at = text.search(/^## Join items\b/m);
  if (at < 0) return new Set();
  const rest = text.slice(at).split('\n').slice(1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return new Set((end < 0 ? rest : rest.slice(0, end)).map((l) => /^(\d+)\. /.exec(l)?.[1]).filter(Boolean));
}

// One kind's problems under condition 1; the test below also calls it with altered specs.
function whoReadsProblems(k, spec) {
  if (spec.record === 'none') return typeof spec.handledBy === 'string' && existsSync(join(MODULES, spec.handledBy)) ? [] : [`${k}: record 'none' with no handledBy file`];
  if (spec.entity !== 'report') return [];
  const given = WHO_READS.filter((f) => spec[f] !== undefined);
  if (given.length !== 1) return [`${k}: an inert report kind names ${given.length ? given.join(' and ') : 'none'} of ${WHO_READS.join(', ')}; it needs exactly one`];
  const [field] = given; const v = spec[field];
  if (typeof v !== 'string' || !v.trim()) return [`${k}: ${field} must be a sentence`];
  if (field === 'kept' && !KEPT_KINDS.includes(k)) return [`${k}: kept is only for ${KEPT_KINDS.join(', ')} (L141)`];
  if (field === 'reader') {
    const out = [];
    for (const part of v.split(', ')) {
      const m = /^(M\d+-[a-z-]+\/[a-z-]+\.mjs):([A-Za-z]\w*)$/.exec(part);
      if (!m) { out.push(`${k}: reader "${part}" is not <module>/<file>.mjs:<fn>`); continue; }
      const f = join(MODULES, m[1]);
      if (!existsSync(f) || !new RegExp(`export (async )?function ${m[2]}\\b`).test(readFileSync(f, 'utf8'))) out.push(`${k}: reader ${part} does not export ${m[2]}`);
    }
    return out;
  }
  if (field === 'pending') {
    const m = /^(M\d+) join items? (\d+(?:(?:, | and )\d+)*), lanes? \d+(?: and \d+)?$/.exec(v);
    if (!m) return [`${k}: pending "${v}" is not "<module> join item <n>, lane <n>"`];
    const module = m[1];
    const folder = readdirSync(MODULES).find((d) => d.startsWith(`${module}-`)) ?? null;
    if (!folder) return [`${k}: pending names ${module}, which has no module folder`];
    const items = joinItems(folder);
    const missing = m[2].split(/, | and /).filter((n) => !items?.has(n));
    return missing.length ? [`${k}: pending names ${module} join item ${missing.join(', ')}, which ${folder}/README.md does not list under "## Join items"`] : [];
  }
  if (field === 'latent' && /NEVER_STARTED/.test(v) && !spec.roles.every((r) => NEVER_STARTED.includes(r))) return [`${k}: latent says NEVER_STARTED, but not every role is`];
  return [];
}

test('L137: the role profiles name some outbox kinds (the cross-check below reads something)', () => {
  assert.ok(writable().filter(([, , from]) => from === 'profile').length > 0);
});

test('L137 MAT-1: every kind a role may write has a record rule or record: \'none\' with handledBy', () => {
  const gaps = new Set();
  for (const [role, k, from] of writable()) {
    const spec = OUTBOX_KINDS[k];
    const ok = spec && (spec.entity || (spec.record === 'none' && typeof spec.handledBy === 'string' && spec.handledBy));
    if (!ok) gaps.add(`${role}: ${k} (${spec ? 'no record rule' : 'not in OUTBOX_KINDS'}; from ${from})`);
  }
  // L140: ask- needs nothing added. These two come only from M4 DESIGN_PROFILES, which still lists ask- for the lead
  // and incident; #83 derives DESIGN_PROFILES from OUTBOX_KINDS and removes them. The list is pinned exactly, so the
  // test goes red the day #83 lands (delete this exception then) and on any new gap.
  const UNTIL_83 = ['incident: ask- (not in OUTBOX_KINDS; from M4 DESIGN_PROFILES)', 'lead: ask- (not in OUTBOX_KINDS; from M4 DESIGN_PROFILES)'];
  assert.deepEqual([...gaps].sort(), UNTIL_83, `kinds a role may write that the Record refuses:\n${[...gaps].sort().join('\n')}`);
});

test('L140 condition 1: every inert report kind names its reader, its join item, why it is latent, or (three old kinds) why it is kept', () => {
  const problems = Object.entries(OUTBOX_KINDS).flatMap(([k, s]) => whoReadsProblems(k, s));
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.entries(OUTBOX_KINDS).filter(([, s]) => s.kept !== undefined).map(([k]) => k).sort(), [...KEPT_KINDS].sort());
  assert.deepEqual(Object.entries(OUTBOX_KINDS).filter(([, s]) => s.record === 'none').map(([k]) => k).sort(), ['scout-', 'think-', 'write-']);
});

test('L140 condition 1: the check refuses a black hole, a second kept kind, a missing join item and a reader that is not there', () => {
  const r = OUTBOX_KINDS['request-'];
  const bare = { roles: r.roles, entity: 'report', mode: 'create' };
  assert.match(whoReadsProblems('request-', bare).join(), /names none of/);
  assert.match(whoReadsProblems('request-', { ...bare, kept: 'stored' }).join(), /kept is only for/);
  assert.match(whoReadsProblems('request-', { ...bare, pending: 'M1 join item 99, lane 2' }).join(), /join item 99, which M1-front-door\/README\.md does not list/);
  assert.match(whoReadsProblems('request-', { ...bare, pending: 'M1 join items 7 and 99, lane 2' }).join(), /join item 99/);
  assert.match(whoReadsProblems('request-', { ...bare, pending: 'soon' }).join(), /is not "<module> join item/);
  assert.match(whoReadsProblems('request-', { ...bare, reader: 'M2-approvals/research-ask.mjs:noSuchFn' }).join(), /does not export noSuchFn/);
  assert.match(whoReadsProblems('request-', { ...bare, latent: 'x', pending: 'M1 join item 9, lane 2' }).join(), /pending and latent/);
  assert.match(whoReadsProblems('wish-', { ...OUTBOX_KINDS['wish-'], latent: 'learning is NEVER_STARTED' }).join(), /not every role is/);
  assert.match(whoReadsProblems('think-', { ...OUTBOX_KINDS['think-'], handledBy: 'M11-dispatcher/nope.mjs' }).join(), /no handledBy file/);
});

test('L140: applyOutbox answers not_a_record for a none kind, in the real M9 and the stand-in, and stores nothing', () => {
  const env = setup({ prefix: 'm9-nar-' });
  const before = env.record.diary({ since: 0 }).length;
  for (const k of ['think-', 'scout-', 'write-']) {
    const real = env.record.applyOutbox({ role: 'lead', sessionId: 'L-9' }, outboxFile(env, 'lead', 'L-9', `${k}1.md`, 'look into the pricing page\n'));
    assert.deepEqual(real, notARecord(k));
    assert.ok(isNotARecord(real));
    assert.equal(real.reason, NOT_A_RECORD);
    assert.equal(real.handledBy, 'M11-dispatcher/outbox-intake.mjs');
    const mem = memoryRecord().applyOutbox({ role: 'lead', sessionId: 'L-9' }, `/x/${k}1.md`);
    assert.deepEqual(mem, real, 'the stand-in answers what the real Record answers');
    // Asked again it is the same answer: never marked seen, so never "skipped".
    assert.deepEqual(env.record.applyOutbox({ role: 'lead', sessionId: 'L-9' }, outboxFile(env, 'lead', 'L-9', `${k}1.md`, 'look into the pricing page\n')), notARecord(k));
  }
  assert.equal(env.record.diary({ since: 0 }).length, before, 'no diary line');
  assert.equal(env.alerts.length, 0, 'no alert');
  assert.equal(env.record.list('report').length, 0);
  // The role check still comes first: a worker's think- is refused, not handed back.
  const w = env.record.applyOutbox({ role: 'worker', sessionId: 'S-9' }, outboxFile(env, 'worker', 'S-9', 'think-1.md', 'x\n'));
  assert.equal(isNotARecord(w), false);
  assert.match(w.reason, /think- is not listed for worker/);
  // A refusal is never read as not_a_record, whatever its reason text says.
  assert.equal(isNotARecord({ ok: false, reason: NOT_A_RECORD }), false);
});

test('L140: every inert kind is stored as a report through the real Record, by each role that may write it', () => {
  const env = setup({ prefix: 'm9-inert-' });
  let n = 0;
  for (const [k, s] of Object.entries(OUTBOX_KINDS).filter(([, x]) => x.entity === 'report')) {
    for (const role of s.roles) {
      const sid = `I-${++n}`;
      const r = env.record.applyOutbox({ role, sessionId: sid }, outboxFile(env, role, sid, `${k}x${n}.md`, 'words\n'));
      assert.equal(r.ok, true, `${role} ${k}: ${r.reason}`);
    }
  }
  assert.equal(env.record.list('report').length, n);
});

test('L140 condition 2: report create reaches exactly these roles, and they gained no other entity', () => {
  assert.deepEqual(Object.keys(WRITERS.report).sort(), ['front_door', 'incident', 'lead', 'learning', 'reviewer', 'scout', 'script', 'thinking', 'worker', 'writer']);
  const creates = (role) => ENTITIES.filter((e) => fieldsAllowed(e, `${role}:X-1`, { create: true }) !== null).sort();
  assert.deepEqual(creates('lead'), ['card', 'handoff', 'report']);
  assert.deepEqual(creates('front_door'), ['report']);
  assert.deepEqual(creates('learning'), ['handoff', 'lesson', 'report']);
  // Create only: none of them may change a report once it is written.
  for (const role of ['lead', 'front_door', 'learning']) assert.equal(fieldsAllowed('report', `${role}:X-1`, { create: false }), null, role);
});
