// outbox-kinds.test.mjs — LEAD-CALLS L82 M-1: one answer to "may this role hand in this outbox file".
//
// Three places judge an outbox file's name: the plain-files hook (as the launcher renders its command), M4's intake read
// (launcher/outbox.mjs readOutboxFile) and M9's intake (the real Record's applyOutbox). All three read the kind as the
// longest listed name prefix (shared outboxKindOf) and the role's kinds from the one shared table (shared OUTBOX_KINDS).
// This file sweeps every role against every listed kind, plus look-alike names, and checks the three agree with the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_ROLES, OUTBOX_KINDS, outboxKindOf } from '../../../shared/record.mjs';
import { DESIGN_PROFILES, outboxKindsFor, shadowKindsFor } from './role-profiles.mjs';
import { renderRoleSettings, POLICY_HOOKS, HOOK_FAILS_CLOSED } from './render-settings.mjs';
import { SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { readOutboxFile } from './outbox.mjs';
import { decide, kindIn } from '../hooks/plain-files.mjs';
import { parseArgs } from '../hooks/lib.mjs';
import { setup, UID } from '../../M9-record/fixtures.test-helper.mjs';

// The roles M4 launches. `script` is an outbox role too (a plain script's reports), but M4 starts no session for it, so
// it has no profile and no hook; M9 alone judges its files.
const LAUNCHED = AI_ROLES.filter((r) => r !== 'script');
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'plain-files.mjs');
const REVIEW_WALLS = { outboxRoot: '/r/outbox', runnerRoot: '/r/review' };

// The plain-files hook's arguments exactly as the launcher renders them for this role and outbox.
function hookArgv(role, outbox) {
  const r = renderRoleSettings({ productionFiles: [], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
    paths: { copy: '/w/copy', outbox, hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes', deny: { secrets: ['/w/secrets'] }, reviewWalls: REVIEW_WALLS } });
  assert.equal(r.ok, true, r.reason);
  const entry = r.settings[S.hooks][E.preToolUse].find((e) => e[H.matcher] === POLICY_HOOKS['plain-files']);
  // The command ends with the shell's fail-closed tail (HOOK_FAILS_CLOSED), which is not one of the hook's arguments.
  const cmd = entry[H.hooks][0][H.command];
  assert.ok(cmd.endsWith(HOOK_FAILS_CLOSED));
  const words = cmd.slice(0, -HOOK_FAILS_CLOSED.length).split(' ');
  assert.match(words[1], /plain-files\.mjs$/);
  return words.slice(2);
}

const write = (file) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
// What M9 says about the name alone: refused as unlisted, or anything else (a later check may still refuse the body).
const m9Listed = (r) => !(r.ok === false && /is not listed for|no outbox kind/.test(r.reason ?? ''));

// One probe: a file in the role's session outbox, judged by all three in the order a write meets them.
function judge(env, role, sid, name) {
  const outbox = join(env.outRoot, role, sid);
  mkdirSync(outbox, { recursive: true });
  const file = join(outbox, name);
  const args = parseArgs(hookArgv(role, outbox));
  const hook = !decide(write(file), args).block;
  writeFileSync(file, 'some text\n');
  const m4 = readOutboxFile(outbox, name, { kinds: DESIGN_PROFILES[role].outbox, uid: UID }).ok;
  const m9 = m9Listed(env.record.applyOutbox({ role, sessionId: sid, card: 'C-x' }, file));
  return { hook, m4, m9 };
}

test('L82 M-1: for every role, M4\'s kinds are exactly the shared table\'s, and every AI role has a profile', () => {
  assert.deepEqual(Object.keys(DESIGN_PROFILES).sort(), [...LAUNCHED].sort(), 'one profile per role M4 launches');
  const listed = [...new Set(Object.values(OUTBOX_KINDS).flatMap((k) => k.roles))];
  for (const r of listed) assert.ok(AI_ROLES.includes(r), `${r} in the table is a known role`);
  for (const role of LAUNCHED) {
    const table = Object.keys(OUTBOX_KINDS).filter((k) => OUTBOX_KINDS[k].roles.includes(role));
    assert.deepEqual([...DESIGN_PROFILES[role].outbox].sort(), table.sort(), `${role}: M4's kinds = M9's list`);
    assert.deepEqual(outboxKindsFor(role).sort(), table.sort(), role);
    for (const k of DESIGN_PROFILES[role].outbox) assert.match(k, /^[a-z]+(-[a-z]+)*-$/, `${role}: ${k} is a name prefix`);
    for (const s of shadowKindsFor(role)) assert.ok(!table.includes(s) && table.some((o) => s.startsWith(o)), `${role}: ${s} is a longer kind it may not hand in`);
  }
});

test('L82 M-1: every role × every listed kind and look-alike: the hook, M4\'s intake read and M9 agree with the table', () => {
  const env = setup({ prefix: 'm4-kinds-' });
  const looks = ['ask-other-1.md', 'notes-1.md', 'report-compact-1.md', 'state-compact-1.md', 'handoff-compact-1.md', 'reports-1.md', 'ask-1.md',
    'verdict-compact-S1.md', 'proposal-compact-1.md', 'report-x-compact-1.md', 'state-compact-compact-1.md'];
  const names = [...Object.keys(OUTBOX_KINDS).map((k, i) => `${k}p${i}.md`), ...looks];
  let n = 0;
  const swept = [];
  for (const role of LAUNCHED) {
    for (const name of names) {
      const want = OUTBOX_KINDS[outboxKindOf(name)]?.roles.includes(role) ?? false;
      const got = judge(env, role, `K-${++n}`, name);
      assert.deepEqual(got, { hook: want, m4: want, m9: want }, `${role} handing in ${name}`);
      if (want) swept.push(`${role}:${outboxKindOf(name)}`);
    }
  }
  // Every (role, kind) pair in the table was reached as an allowed hand-in.
  const pairs = Object.entries(OUTBOX_KINDS).flatMap(([k, v]) => v.roles.filter((r) => r !== 'script').map((r) => `${r}:${k}`));
  for (const p of pairs) assert.ok(swept.includes(p), `${p} was swept`);
});

// L101: a compaction note (`-compact-` in its name) is only ever a `-compact-` kind, at the hook, M4's read and M9.
test('L101: a reviewer\'s verdict-compact- note is refused everywhere; a Lead\'s handoff-compact- is no handoff; the worker\'s and Front Door\'s notes pass', () => {
  const env = setup({ prefix: 'm4-kinds-' });
  const none = { hook: false, m4: false, m9: false };
  const all = { hook: true, m4: true, m9: true };
  for (const [role, name, want] of [
    ['reviewer', 'verdict-compact-S1.md', none], ['auditor', 'verdict-compact-S1.md', none],
    ['lead', 'handoff-compact-L1.md', none], ['thinking', 'proposal-compact-T1.md', none],
    ['worker', 'report-compact-W1.md', all], ['front_door', 'state-compact-F1.md', all],
  ]) {
    assert.deepEqual(judge(env, role, `N-${role}`, name), want, `${role} handing in ${name}`);
  }
  assert.equal(outboxKindOf('verdict-compact-S1.md'), null, 'never a verdict');
  assert.equal(outboxKindOf('handoff-compact-L1.md'), null, 'never a handoff');
  assert.equal(outboxKindOf('report-compact-W1.md'), 'report-compact-');
  // And a verdict the reviewer really hands in still is one.
  assert.deepEqual(judge(env, 'reviewer', 'N-v', 'verdict-S1.md'), all);
});

test('L101: the hook\'s kindIn and the shared outboxKindOf give every role the same kind for every name', () => {
  const names = [...Object.keys(OUTBOX_KINDS).flatMap((k) => [`${k}a.md`, `${k}compact-a.md`, `${k.replace(/-$/, '')}-compact-a.md`]), 'verdict-compact-S1.md', 'x-1.md'];
  for (const role of LAUNCHED) {
    for (const name of names) {
      const shared = outboxKindOf(name);
      const want = shared !== null && OUTBOX_KINDS[shared].roles.includes(role) ? shared : null;
      assert.equal(kindIn(name, outboxKindsFor(role), shadowKindsFor(role)), want, `${role}: ${name}`);
    }
  }
});

test('L101: the rendered compaction hooks name a notes folder apart from the outbox for every role without a -compact- kind', () => {
  for (const role of LAUNCHED) {
    const outbox = `/w/outbox/${role}`;
    const r = renderRoleSettings({ productionFiles: [], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
      paths: { copy: '/w/copy', outbox, hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: `/w/notes/${role}`, deny: { secrets: ['/w/secrets'] }, reviewWalls: REVIEW_WALLS } });
    assert.equal(r.ok, true, r.reason);
    const inOutbox = DESIGN_PROFILES[role].outbox.includes(`${DESIGN_PROFILES[role].compactKind}-compact-`);
    assert.equal(inOutbox, ['worker', 'front_door'].includes(role), `${role}: only the worker and the Front Door keep the note in the outbox`);
    for (const ev of [E.preCompact, E.postCompact, E.sessionStart]) {
      let seen = 0;
      for (const e of r.settings[S.hooks][ev] ?? []) {
        const cmd = e[H.hooks][0][H.command];
        if (!cmd.includes('compact-note.mjs')) continue;
        seen += 1;
        assert.equal(cmd.includes(` --notes /w/notes/${role}`), !inOutbox, `${role} ${ev}: ${cmd}`);
      }
      assert.equal(seen, 1, `${role}: one ${ev} compaction hook`);
    }
    if (!inOutbox) {
      const bare = renderRoleSettings({ productionFiles: [], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
        paths: { copy: '/w/copy', outbox, hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', deny: { secrets: ['/w/secrets'] }, reviewWalls: REVIEW_WALLS } });
      assert.equal(bare.ok, false, `${role}: no notes folder is refused`);
      const inside = renderRoleSettings({ productionFiles: [], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
        paths: { copy: '/w/copy', outbox, hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: `${outbox}/notes`, deny: { secrets: ['/w/secrets'] }, reviewWalls: REVIEW_WALLS } });
      assert.equal(inside.ok, false, `${role}: a notes folder inside the outbox is refused`);
    }
  }
});

test('L82 M-1: a published profile that lists fewer kinds is refused at the hook for the ones it leaves out, as at M4\'s read', () => {
  const env = setup({ prefix: 'm4-kinds-' });
  const outbox = join(env.outRoot, 'worker', 'N-1');
  mkdirSync(outbox, { recursive: true });
  const profile = { ...DESIGN_PROFILES.worker, outbox: ['report-'] };
  const r = renderRoleSettings({ productionFiles: [], role: 'worker', profile, product: { commands: { test: 'npm test' } },
    paths: { copy: '/w/copy', outbox, hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes', deny: { secrets: ['/w/secrets'] }, reviewWalls: REVIEW_WALLS } });
  assert.equal(r.ok, true, r.reason);
  const cmd = r.settings[S.hooks][E.preToolUse].find((e) => e[H.matcher] === POLICY_HOOKS['plain-files'])[H.hooks][0][H.command];
  const args = parseArgs(cmd.slice(0, -HOOK_FAILS_CLOSED.length).split(' ').slice(2));
  for (const [name, want] of [['report-a.md', true], ['report-compact-a.md', false], ['handin-a.md', false]]) {
    assert.equal(!decide(write(join(outbox, name)), args).block, want, `hook: ${name}`);
    writeFileSync(join(outbox, name), 'x\n');
    assert.equal(readOutboxFile(outbox, name, { kinds: profile.outbox, uid: UID }).ok, want, `M4 read: ${name}`);
  }
});

test('L82 M-1: a Front Door `ask-request-` passes the real hook, M4\'s read and the Record; `ask-other-` stops at the hook', () => {
  const env = setup({ prefix: 'm4-kinds-' });
  const outbox = join(env.outRoot, 'front_door', 'F-1');
  mkdirSync(outbox, { recursive: true });
  const argv = hookArgv('front_door', outbox);
  const run = (name) => spawnSync(process.execPath, [HOOK, ...argv], { input: JSON.stringify(write(join(outbox, name))), encoding: 'utf8', timeout: 30_000 });

  const ok = run('ask-request-R1.json');
  assert.equal(ok.status, 0, `the hook passes it: ${ok.stderr}`);
  writeFileSync(join(outbox, 'ask-request-R1.json'), '{"question":"may I?"}\n');
  const read = readOutboxFile(outbox, 'ask-request-R1.json', { kinds: DESIGN_PROFILES.front_door.outbox, uid: UID });
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.kind, 'ask-request-');
  const applied = env.record.applyOutbox({ role: 'front_door', sessionId: 'F-1' }, join(outbox, 'ask-request-R1.json'));
  assert.equal(applied.ok, true, applied.reason);
  const doc = env.record.list('report').find((d) => d.doc.session_id === 'F-1');
  assert.equal(doc?.doc.kind, 'ask-request-', 'stored as an inert request report');

  const no = run('ask-other-R2.json');
  assert.equal(no.status, 2, 'the hook blocks it');
  assert.match(no.stderr, /front_door role may not hand in "ask-other-R2\.json"/);
});
