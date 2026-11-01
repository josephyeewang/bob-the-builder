// L137 MAT-1, L140, L141: every outbox kind a role may write has a record rule, or says it is not a record
// (`record: 'none'`, with the module that handles it). A kind with neither is one the real Record refuses: a Lead's
// think- request would raise a false "record refused" alert on every pass. The kinds come from all three places that
// say who writes what: the role profiles (M10 roles/*.json, outbox_kinds), shared OUTBOX_KINDS' own role lists
// (learning has no M10 profile; NEVER_STARTED), and M4's DESIGN_PROFILES (what M11 intake lets a session hand in).
//
// L140 condition 1: no kind is a black hole. A kind stored as a report is inert, so it names its reader, the join item
// that wires one, or why nothing writes it; `kept` is only for the three kinds written before L140 (L141).
// L140 condition 2: the report-create grant derives from OUTBOX_KINDS, so the roles it reaches are pinned here.
// L151: tags are checked for truth, not just form. A pending or refused kind's join item must name the kind; a latent
// reason is one of the claims below, each checked against the code; state- and request- are refused until their
// consumers land (M-1); the cross-check reads each role's own list for the kind (m4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITIES, NOT_A_RECORD, OUTBOX_KINDS, isNotARecord, memoryRecord, notARecord } from '../../shared/record.mjs';
import { NEVER_STARTED, ROLE_FILES } from '../M10-rules/roles.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';
import { WRITERS, fieldsAllowed } from './permissions.mjs';
import { outboxFile, setup } from './fixtures.test-helper.mjs';
import { namesKind } from '../../shared/kinds.test-helper.mjs';

const MODULES = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES_DIR = join(MODULES, 'M10-rules/roles');
const WHO_READS = ['reader', 'pending', 'latent', 'kept'];
const KEPT_KINDS = ['report-', 'report-compact-', 'state-compact-'];
// The kinds refused until their consumer lands (L151 M-1): pinned, so one flips only in the PR that lands it.
const REFUSED_KINDS = ['request-', 'state-'];

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

// The numbered items under a module README's "## Join items" heading, each with its text (number → text).
function joinItems(module) {
  const f = join(MODULES, module, 'README.md');
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  const at = text.search(/^## Join items\b/m);
  const items = new Map();
  if (at < 0) return items;
  const rest = text.slice(at).split('\n').slice(1);
  const end = rest.findIndex((l) => /^## /.test(l));
  let n = null;
  for (const l of end < 0 ? rest : rest.slice(0, end)) {
    const m = /^(\d+)\. /.exec(l);
    if (m) { n = m[1]; items.set(n, l); } else if (n) items.set(n, `${items.get(n)}\n${l}`);
  }
  return items;
}

// "<module> join item(s) <n>, lane <n>" → its problems: the items exist and at least one names the kind (L151).
function joinItemProblems(k, field, v) {
  const m = /^(M\d+) join items? (\d+(?:(?:, | and )\d+)*), lanes? \d+(?: and \d+)?$/.exec(v);
  if (!m) return [`${k}: ${field} "${v}" is not "<module> join item <n>, lane <n>"`];
  const module = m[1];
  const folder = readdirSync(MODULES).find((d) => d.startsWith(`${module}-`)) ?? null;
  if (!folder) return [`${k}: ${field} names ${module}, which has no module folder`];
  const items = joinItems(folder);
  const nums = m[2].split(/, | and /);
  const missing = nums.filter((n) => !items?.has(n));
  if (missing.length) return [`${k}: ${field} names ${module} join item ${missing.join(', ')}, which ${folder}/README.md does not list under "## Join items"`];
  if (!nums.some((n) => namesKind(items.get(n), k))) return [`${k}: ${field} names ${module} join item ${nums.join(', ')}, and none of them names ${k}`];
  return [];
}

// The latent claims a kind may make, each checked against the code (L151 m3). Any other latent text is a problem.
const SOURCE_EXT = /\.(mjs|js|cjs|md|json|txt)$/;
function sourceFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') sourceFiles(p, out); } else if (SOURCE_EXT.test(e.name) && !/\.test(-helper)?\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}
// Where a kind may be named without writing it: the kind lists, their READMEs, and M6's bundle of shared/.
const LISTS = ['shared/record.mjs', 'shared/README.md', 'modules/M10-rules/roles/lead.json', 'modules/M4-workshop/launcher/role-profiles.mjs', 'modules/M6-merge-gate/github-checker.mjs'];
const ORCH = join(MODULES, '..');
const BOB = join(ORCH, '..');
// Every file outside the lists that names the kind: a prompt, a skill or code that would write it.
export function kindMentions(k, files = [...sourceFiles(ORCH), ...sourceFiles(join(BOB, 'skill')), ...sourceFiles(join(BOB, 'skills'))]) {
  return files.filter((p) => !LISTS.some((l) => p === join(ORCH, l)) && namesKind(readFileSync(p, 'utf8').replace(/`/g, ' '), k)).map((p) => p.slice(BOB.length + 1));
}
export const LATENT_CLAIMS = Object.freeze({
  'its only role, learning, is NEVER_STARTED (M10 roles.mjs)': (k, spec) => spec.roles.every((r) => NEVER_STARTED.includes(r)) ? [] : [`${k}: latent says NEVER_STARTED, but not every role is`],
  'no Lead prompt writes one yet; only the role lists (M10 lead profile, M4 DESIGN_PROFILES) name it': (k) => kindMentions(k).map((p) => `${k}: latent says no prompt writes one, but ${p} names it`),
  'no Lead prompt writes one yet, and M12 history.mjs answer() has no caller': (k) => [
    ...kindMentions(k).map((p) => `${k}: latent says no prompt writes one, but ${p} names it`),
    ...sourceFiles(ORCH).filter((p) => !p.endsWith('M12-sensors/history.mjs') && /import[^;]*\bmakeHistory\b[^;]*from ['"][^'"]*history\.mjs['"]/.test(readFileSync(p, 'utf8'))).map((p) => `${k}: latent says history.mjs answer() has no caller, but ${p.slice(BOB.length + 1)} imports makeHistory`),
  ],
});

// One kind's problems under condition 1; the test below also calls it with altered specs.
function whoReadsProblems(k, spec) {
  if (spec.record === 'none') return typeof spec.handledBy === 'string' && existsSync(join(MODULES, spec.handledBy)) ? [] : [`${k}: record 'none' with no handledBy file`];
  if (spec.refused !== undefined) {
    if (spec.entity !== null) return [`${k}: a refused kind has entity null, not ${spec.entity}`];
    if (WHO_READS.some((f) => spec[f] !== undefined)) return [`${k}: a refused kind names no reader`];
    return joinItemProblems(k, 'refused', String(spec.refused));
  }
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
      if (!existsSync(f) || !new RegExp(`export (?:(?:async )?function ${m[2]}\\b|const ${m[2]}\\s*=)`).test(readFileSync(f, 'utf8'))) out.push(`${k}: reader ${part} does not export ${m[2]}`);
    }
    return out;
  }
  if (field === 'pending') return joinItemProblems(k, 'pending', v);
  if (field === 'latent') return LATENT_CLAIMS[v] ? LATENT_CLAIMS[v](k, spec) : [`${k}: latent "${v}" is not one of the checked claims (LATENT_CLAIMS)`];
  return [];
}

test('L137: the role profiles name some outbox kinds (the cross-check below reads something)', () => {
  assert.ok(writable().filter(([, , from]) => from === 'profile').length > 0);
});

test('L137 MAT-1: every kind a role may write has a record rule or record: \'none\' with handledBy', () => {
  const gaps = new Set();
  for (const [role, k, from] of writable()) {
    const spec = OUTBOX_KINDS[k];
    // A refused kind (L151) is refused on purpose: Joe hears "Not filed", never a false alert or a false promise.
    const ok = spec && (spec.entity || spec.refused || (spec.record === 'none' && typeof spec.handledBy === 'string' && spec.handledBy));
    if (!ok) gaps.add(`${role}: ${k} (${spec ? 'no record rule' : 'not in OUTBOX_KINDS'}; from ${from})`);
    // The kind exists, but M9 still refuses it for a role not on its own list (L151 m4).
    else if (!spec.roles.includes(role)) gaps.add(`${role}: ${k} (not listed for ${role} in OUTBOX_KINDS; from ${from})`);
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
  assert.deepEqual(Object.entries(OUTBOX_KINDS).filter(([, s]) => s.refused !== undefined).map(([k]) => k).sort(), REFUSED_KINDS);
  // Every kind is a record kind, not a record, or refused with its join item: none is refused by accident.
  assert.deepEqual(Object.entries(OUTBOX_KINDS).filter(([, s]) => !s.entity && s.record !== 'none' && s.refused === undefined).map(([k]) => k), []);
});

test('L151 M-1: the refused kinds are refused by the real Record and the stand-in, and nothing is stored', () => {
  const env = setup({ prefix: 'm9-refk-' });
  const mem = memoryRecord({ outboxRoot: env.outRoot });
  for (const [k, name] of [['state-', 'state-1.json'], ['request-', 'request-resume-1.json']]) {
    const p = outboxFile(env, 'front_door', 'F-1', name, '{"product":"app","state":"paused"}\n');
    const real = env.record.applyOutbox({ role: 'front_door', sessionId: 'F-1' }, p);
    assert.equal(real.ok, false, k);
    assert.equal(isNotARecord(real), false, k);
    assert.match(real.reason, new RegExp(`outbox kind ${k} has no record rule yet`), k);
    assert.equal(mem.applyOutbox({ role: 'front_door', sessionId: 'F-1' }, p).reason, real.reason, k);
  }
  assert.equal(env.record.list('report').length, 0);
});

test('L151: a join item must name the kind; state-compact- in item 1 is not state-', () => {
  const st = OUTBOX_KINDS['state-'];
  assert.match(whoReadsProblems('state-', { ...st, refused: 'M1 join item 1, lane 2' }).join(), /none of them names state-/);
  assert.match(whoReadsProblems('state-', { ...st, refused: 'M1 join item 3, lane 2' }).join(), /none of them names state-/);
  assert.deepEqual(whoReadsProblems('state-', { ...st, refused: 'M1 join item 4, lane 2' }), [], 'item 4 names state- (the trip brief)');
  assert.match(whoReadsProblems('idea-', { ...OUTBOX_KINDS['idea-'], pending: 'M1 join item 5, lane 2' }).join(), /none of them names idea-/);
  assert.match(whoReadsProblems('state-', { ...st, entity: 'report' }).join(), /refused kind has entity null/);
  assert.match(whoReadsProblems('state-', { ...st, pending: 'M1 join item 13, lane 2' }).join(), /names no reader/);
  assert.equal(namesKind('the `state-compact-` kind', 'state-'), false);
  assert.equal(namesKind('the newest `state-` file', 'state-'), true);
  assert.equal(namesKind('ask-request-<id>.json', 'request-'), false, 'ask-request- is its own kind');
});

test('L151 m3: a latent reason is a checked claim; each goes red when it stops being true', () => {
  assert.match(whoReadsProblems('history-', { ...OUTBOX_KINDS['history-'], latent: 'x' }).join(), /not one of the checked claims/);
  // A prompt that starts writing wish- (or history-) turns the claim false.
  const prompt = join(MODULES, 'M3-lead/prompts-plant.md');
  const files = [prompt];
  const claim = LATENT_CLAIMS[OUTBOX_KINDS['wish-'].latent];
  assert.deepEqual(kindMentions('wish-', []), []);
  writeFileSync(prompt, 'When the owner wishes for X, write `wish-<id>.md` to your outbox.\n');
  try {
    assert.deepEqual(kindMentions('wish-', files), ['orchestrate/modules/M3-lead/prompts-plant.md']);
    assert.equal(kindMentions('history-', files).length, 0);
    assert.ok(claim('wish-', OUTBOX_KINDS['wish-']).length > 0, 'the real scan sees the plant too');
  } finally { rmSync(prompt); }
  assert.deepEqual(claim('wish-', OUTBOX_KINDS['wish-']), []);
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
  assert.match(whoReadsProblems('wish-', { ...OUTBOX_KINDS['wish-'], latent: 'its only role, learning, is NEVER_STARTED (M10 roles.mjs)' }).join(), /not every role is/);
  assert.match(whoReadsProblems('think-', { ...OUTBOX_KINDS['think-'], handledBy: 'M11-dispatcher/nope.mjs' }).join(), /no handledBy file/);
});

test('L140: applyOutbox answers not_a_record for a none kind, in the real M9 and the stand-in, and stores nothing', () => {
  const env = setup({ prefix: 'm9-nar-' });
  const before = env.record.diary({ since: 0 }).length;
  let badAlerts = 0;
  for (const k of ['think-', 'scout-', 'write-']) {
    const file = outboxFile(env, 'lead', 'L-9', `${k}1.md`, 'look into the pricing page\n');
    const real = env.record.applyOutbox({ role: 'lead', sessionId: 'L-9' }, file);
    assert.deepEqual(real, notARecord(k));
    assert.ok(isNotARecord(real));
    assert.equal(real.reason, NOT_A_RECORD);
    assert.equal(real.handledBy, 'M11-dispatcher/outbox-intake.mjs');
    // Not stored is never ok (L151 m2): a caller that reads r.ok as "stored" is not fooled.
    assert.equal(real.ok, false);
    assert.equal(isNotARecord({ ...real, ok: true }), false, 'an ok answer is never not_a_record');
    // The stand-in on the same real file (L151 m7), and on files the real Record refuses before the name.
    const mem = memoryRecord({ outboxRoot: env.outRoot });
    assert.deepEqual(mem.applyOutbox({ role: 'lead', sessionId: 'L-9' }, file), real, 'the stand-in answers what the real Record answers');
    for (const bad of [`${env.outRoot}/lead/L-9/${k}missing.md`, outboxFile(env, 'lead', 'L-8', `${k}2.md`, 'x\n')]) {
      const was = env.alerts.length;
      const r1 = env.record.applyOutbox({ role: 'lead', sessionId: 'L-9' }, bad);
      // The real Record alerts on a bad file (it is refused, not handed back); only the good file must raise none.
      assert.equal(env.alerts.length, was + 1, bad);
      badAlerts += 1;
      const r2 = mem.applyOutbox({ role: 'lead', sessionId: 'L-9' }, bad);
      assert.equal(isNotARecord(r1), false, bad);
      assert.equal(r2.reason, r1.reason, bad);
    }
    // Asked again it is the same answer: never marked seen, so never "skipped".
    assert.deepEqual(env.record.applyOutbox({ role: 'lead', sessionId: 'L-9' }, outboxFile(env, 'lead', 'L-9', `${k}1.md`, 'look into the pricing page\n')), notARecord(k));
  }
  assert.equal(env.record.diary({ since: 0 }).length, before, 'no diary line');
  assert.equal(env.alerts.length, badAlerts, 'no alert for a none kind');
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
  // Every role report create reaches, with every entity it may create (L151 m8): a role that gains one goes red here.
  const CREATES = {
    front_door: ['report'], incident: ['report'], lead: ['card', 'handoff', 'report'], learning: ['handoff', 'lesson', 'report'],
    reviewer: ['report', 'verdict'], scout: ['report'], script: ['report'], thinking: ['report'], worker: ['report'], writer: ['report'],
  };
  assert.deepEqual(Object.keys(CREATES).sort(), Object.keys(WRITERS.report).sort());
  for (const [role, list] of Object.entries(CREATES)) assert.deepEqual(creates(role), list, role);
  // Create only: none of them may change a report once it is written.
  for (const role of Object.keys(CREATES)) assert.equal(fieldsAllowed('report', `${role}:X-1`, { create: false }), null, role);
});
