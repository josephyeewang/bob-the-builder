// review-settings.test.mjs — lead call L67 (addenda 1 and 2): a reviewer's or auditor's settings come from a committed
// template that root's updater copies in. The runner fills its placeholders with this session's and the config's paths,
// checks every value and spot, and writes the file to its own folder. Nothing here starts claude or runs as another user.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderTemplate, templateText, templateFile, spotsProblem, fillTemplate, onlySpotsChanged, realPathProblem, slotValues,
  readTemplate, sessionSettings, slotToken, SESSION_SLOTS, MACHINE_SLOTS, SETTINGS_DIR,
} from './review-settings.mjs';
import { renderRoleSettings, checkSettings, REVIEW_WALLS } from './render-settings.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { realPorts } from './review-runner-main.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const ME = process.getuid();
const HERE = dirname(fileURLToPath(import.meta.url));
const committed = (role) => join(HERE, 'templates', `${role}.settings.json`);

// renderRoleSettings for a review role with the given paths: what a filled template must equal.
function direct(role, v) {
  return renderRoleSettings({
    role, profile: DESIGN_PROFILES[role], productionFiles: [],
    paths: {
      copy: v.copy, outbox: v.outbox, hooksDir: v.hooks, snapshot: v.snapshot, node: v.node, bobFolder: v.bob,
      deny: { secrets: v.deny },
      reviewWalls: Object.fromEntries(REVIEW_WALLS.map((k) => [k, v[`wall_${k}`]])),
    },
  });
}

// A throwaway machine: the installed copy (with the committed templates), the runner's folder, the outboxes, the Bob
// folder, a secrets folder, and the review and workers' copies folders apart.
function machine(role = 'reviewer') {
  const base = realpathSync(tempDir('m4-tpl-'));
  const d = (...p) => { const x = join(base, ...p); mkdirSync(x, { recursive: true }); return x; };
  const installRoot = d('install');
  mkdirSync(dirname(templateFile(installRoot, 'reviewer')), { recursive: true });
  for (const r of REVIEW_ROLES) { copyFileSync(committed(r), templateFile(installRoot, r)); chmodSync(templateFile(installRoot, r), 0o644); }
  const node = join(d('install', 'bin'), 'node');
  writeFileSync(node, '');
  const hooksDir = d('install', 'hooks');
  const root = d('runner');
  chmodSync(root, 0o700);
  const snapshot = join(root, 'rules.json');
  writeFileSync(snapshot, '{}');
  const outboxRoot = d('outbox');
  const sid = 'sess-1';
  for (const r of REVIEW_ROLES) d('outbox', r, sid);
  const c = {
    installRoot, root, outboxRoot, hooksDir, snapshot, bobFolder: d('bob'),
    deny: [d('secrets'), join(base, 'not-made-yet')], reviewCopies: d('review-copies'), workerCopies: d('worker-copies'),
  };
  return { base, d, c, x: { role, sessionId: sid, copy: d('review-copies', 'card-1'), node } };
}
const run = (m, { c = {}, x = {} } = {}, opts = {}) => sessionSettings({ ...m.c, ...c }, { ...m.x, ...x }, { owner: ME, uid: ME, ...opts });

const MADE_UP = {
  outbox: '/o/reviewer/s-1', copy: '/rc/card-1', node: '/i/bin/node', hooks: '/i/hooks', snapshot: '/r/rules.json', bob: '/bob',
  deny: ['/sec/a', '/home/claude', '/wc'], wall_outboxRoot: '/o', wall_runnerRoot: '/r',
};

test('L67: each committed template is renderRoleSettings with a placeholder for every path, and names no machine', () => {
  assert.deepEqual([...SESSION_SLOTS, ...MACHINE_SLOTS].sort(), Object.keys(MADE_UP).sort(), 'every placeholder has a made-up value here');
  for (const role of REVIEW_ROLES) {
    const r = renderTemplate(role);
    assert.equal(r.ok, true, r.reason);
    const text = readFileSync(committed(role), 'utf8');
    assert.equal(text, templateText(r.settings), `${role}: the committed template is out of step (node review-settings.mjs --write-templates)`);
    assert.equal(spotsProblem(r.settings), null);
    // No real path: every absolute path in the file starts at a placeholder (or is a pattern under `//**`).
    for (const m of text.matchAll(/"(\/[^"]*)"|[ (](\/{1,2}[^ ")]*)/g)) {
      const p = m[1] ?? m[2];
      assert.match(p, /^(?:\/?\/__orch_|\/\/\*\*)/, `${role}: ${p} is not a placeholder`);
    }
  }
  assert.equal(renderTemplate('worker').ok, false, 'only review roles have a template');
});

test('L67: a template filled with made-up values equals renderRoleSettings with the same values', () => {
  for (const role of REVIEW_ROLES) {
    const t = JSON.parse(readFileSync(committed(role), 'utf8'));
    const v = { ...MADE_UP, outbox: `/o/${role}/s-1` };
    const want = direct(role, v);
    assert.equal(want.ok, true, want.reason);
    const got = fillTemplate(t, v);
    assert.deepEqual(got, want.settings, role);
    assert.equal(onlySpotsChanged(t, got, v), null);
    assert.equal(checkSettings(got, { profile: DESIGN_PROFILES[role] }).ok, true);
    assert.doesNotMatch(JSON.stringify(got), /__orch_/);
    // The list placeholder becomes one deny pair and one denyRead item per value.
    assert.deepEqual(got.sandbox.filesystem.denyRead, v.deny);
  }
});

test('L67: a session\'s settings are filled, checked and written to the runner\'s own folder, once', () => {
  for (const role of REVIEW_ROLES) {
    const m = machine(role);
    const r = run(m);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.file, join(m.c.root, SETTINGS_DIR, `${m.x.sessionId}.json`));
    assert.equal(lstatSync(r.file).mode & 0o777, 0o600);
    assert.equal(lstatSync(dirname(r.file)).mode & 0o777, 0o700);
    const v = slotValues(m.c, m.x).values;
    assert.equal(v.outbox, join(m.c.outboxRoot, role, m.x.sessionId));
    assert.deepEqual(v.deny, [...m.c.deny, m.c.workerCopies], 'the workers\' copies folder is denied whole');
    assert.equal(v.wall_outboxRoot, m.c.outboxRoot);
    assert.equal(v.wall_runnerRoot, m.c.root);
    assert.deepEqual(JSON.parse(readFileSync(r.file, 'utf8')), direct(role, v).settings);
    // A second write for the same session is refused, never over the first.
    const again = run(m);
    assert.equal(again.ok, false);
    assert.match(again.reason, /can't be made \(EEXIST\)/);
  }
});

test('L67: the template must be root\'s plain file, not writable by others, and JSON', () => {
  const m = machine();
  const f = templateFile(m.c.installRoot, 'reviewer');
  assert.match(run(m, {}, { owner: ME + 1 }).reason, /the reviewer template is not root's/);
  chmodSync(f, 0o664);
  assert.match(run(m).reason, /can be written by others than root/);
  chmodSync(f, 0o644);
  writeFileSync(f, 'not json');
  assert.match(run(m).reason, /is not JSON/);
  unlinkSync(f);
  assert.match(run(m).reason, /can't be opened \(ENOENT\)/);
  const elsewhere = join(m.base, 'elsewhere.json');
  copyFileSync(committed('reviewer'), elsewhere);
  symlinkSync(elsewhere, f);
  assert.match(run(m).reason, /can't be opened \(ELOOP\)/);
  unlinkSync(f);
  mkdirSync(f);
  assert.match(run(m).reason, /is not a plain file/);
  assert.match(readTemplate(m.c.installRoot, 'worker').reason, /not a review role/);
});

test('L67: a placeholder outside its allowed spots, unknown, in a key or misspelt is refused', () => {
  const base = renderTemplate('reviewer').settings;
  const edit = (fn) => { const t = structuredClone(base); fn(t); return t; };
  const cases = [
    [(t) => t.sandbox.filesystem.denyRead.push(slotToken('copy')), /denyRead\[\] holds a placeholder where none may be/],
    [(t) => t.permissions.deny.push(`Read(/${slotToken('copy')}/**)`), /permissions\.deny\[\] holds a placeholder where none may be/],
    [(t) => t.permissions.additionalDirectories.push(slotToken('deny')), /additionalDirectories\[\] holds a placeholder where none may be/],
    [(t) => t.sandbox.filesystem.denyWrite.push(slotToken('secrets')), /holds an unknown placeholder secrets/],
    [(t) => { t.env[slotToken('bob')] = '1'; }, /a placeholder in the key env\./],
    [(t) => t.permissions.deny.push('Read(//__orch_bob_/**)'), /holds a placeholder that is not one/],
    [(t) => { t.permissions.defaultMode = slotToken('bob'); }, /permissions\.defaultMode holds a placeholder where none may be/],
  ];
  for (const [fn, re] of cases) assert.match(spotsProblem(edit(fn)) ?? 'null', re);
  // The runner refuses such a template before it fills anything.
  const m = machine();
  writeFileSync(templateFile(m.c.installRoot, 'reviewer'), templateText(edit(cases[0][0])), { mode: 0o644 });
  const r = run(m);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^the reviewer template: sandbox\.filesystem\.denyRead\[\] holds a placeholder where none may be/);
});

test('L67: the outbox must be the session\'s own folder in its role\'s outbox, and a plain folder', () => {
  const m = machine();
  const ob = join(m.c.outboxRoot, 'reviewer', m.x.sessionId);
  assert.match(run(m, { x: { sessionId: 'sess-2' } }).reason, /outbox: .* is not the session's folder in its role's outbox/, 'not made');
  assert.match(run(m, { x: { sessionId: '../sess-1' } }).reason, /not a session id/);
  assert.match(run(m, { x: { role: 'worker' } }).reason, /worker is not a review role/);
  // The auditor's folder for the same session is not the reviewer's.
  const a = slotValues(m.c, { ...m.x, role: 'auditor' });
  assert.equal(a.values.outbox, join(m.c.outboxRoot, 'auditor', m.x.sessionId));
  rmSync(ob, { recursive: true });
  symlinkSync(m.d('elsewhere-outbox'), ob);
  assert.match(run(m).reason, /outbox: .* runs through a link/);
});

test('L67: the copy must be a plain folder inside the review copies, which sit apart from the workers\' copies', () => {
  const m = machine();
  const rc = m.c.reviewCopies;
  assert.match(run(m, { x: { copy: `${m.x.copy}/x/..` } }).reason, /copy: .* is not in its plain form|not a plain absolute path/);
  assert.match(run(m, { x: { copy: m.d('worker-copies', 'card-1') } }).reason, /copy: .* is not a folder inside the review copies' folder/);
  assert.match(run(m, { x: { copy: m.d('elsewhere') } }).reason, /copy: .* is not a folder inside the review copies' folder/);
  assert.match(run(m, { x: { copy: rc } }).reason, /copy: .* is not a folder inside the review copies' folder/, 'the folder itself is not a copy');
  writeFileSync(join(rc, 'a-file'), '');
  assert.match(run(m, { x: { copy: join(rc, 'a-file') } }).reason, /is not a folder inside the review copies' folder/);
  symlinkSync(m.x.copy, join(rc, 'card-2'));
  assert.match(run(m, { x: { copy: join(rc, 'card-2') } }).reason, /copy: .* runs through a link/);
  assert.match(run(m, { x: { copy: 'review-copies/card-1' } }).reason, /copy: .* is not a plain absolute path/);
  // Nested either way, or the same folder: refused, so the workers' deny can't cover the review copy or the reverse.
  assert.match(run(m, { c: { workerCopies: m.d('review-copies', 'workers') } }).reason, /must be apart/);
  assert.match(run(m, { c: { reviewCopies: m.d('worker-copies', 'review') }, x: { copy: m.d('worker-copies', 'review', 'card-1') } }).reason, /must be apart/);
  assert.match(run(m, { c: { workerCopies: rc } }).reason, /must be apart/);
  // A name that only starts like the workers' folder is apart from it.
  const v = slotValues({ ...m.c, reviewCopies: m.d('worker-copies-x') }, { ...m.x, copy: m.d('worker-copies-x', 'c') });
  assert.equal(v.ok, true, v.reason);
});

test('L67: each machine value is a real plain path under its expected root', () => {
  const m = machine();
  assert.match(run(m, { c: { deny: [] } }).reason, /the config has no deny list/);
  assert.match(run(m, { c: { deny: undefined } }).reason, /the config has no deny list/);
  symlinkSync(m.c.deny[0], join(m.base, 'secrets-link'));
  assert.match(run(m, { c: { deny: [join(m.base, 'secrets-link')] } }).reason, /deny: .* runs through a link/);
  symlinkSync(m.c.reviewCopies, join(m.base, 'rc-link'));
  assert.match(run(m, { c: { reviewCopies: join(m.base, 'rc-link') } }).reason, /reviewCopies: .* runs through a link/);
  assert.match(run(m, { c: { workerCopies: 'worker-copies' } }).reason, /workerCopies: .* is not a plain absolute path/);
  assert.match(run(m, { c: { bobFolder: '/a b' } }).reason, /bob: .* is not a plain absolute path/);
  assert.match(run(m, { x: { node: join(m.base, 'node') } }).reason, /node: .* is not inside the installed copy/);
  assert.match(run(m, { c: { hooksDir: m.d('hooks') } }).reason, /hooks: .* is not inside the installed copy/);
  assert.match(run(m, { c: { snapshot: join(m.base, 'rules.json') } }).reason, /snapshot: .* is not inside the runner's folder/);
  assert.match(run(m, { c: { outboxRoot: `${m.c.outboxRoot}/` } }).reason, /is not in its plain form/);
  assert.equal(realPathProblem('/a/./b'), '/a/./b is not in its plain form');
  assert.equal(realPathProblem('/a//b'), '/a//b is not in its plain form');
});

test('L67: a fill that changes anything but the placeholders is refused, and nothing is written', () => {
  const m = machine();
  const plants = [
    [(t, v) => { const s = fillTemplate(t, v); s.permissions.deny.push('Read(//x/**)'); return s; }, /permissions\.deny holds more than the template/],
    [(t, v) => { const s = fillTemplate(t, v); const i = s.permissions.deny.indexOf(`Edit(/${v.bob}/**)`); assert.ok(i >= 0); s.permissions.deny[i] = `Read(/${v.bob}/**)`; return s; }, /permissions\.deny\[\d+\] is not the template's value filled in/],
    [(t, v) => { const s = fillTemplate(t, v); s.sandbox.network.strictAllowlist = false; return s; }, /sandbox\.network\.strictAllowlist differs from the template/],
    [(t, v) => { const s = fillTemplate(t, v); s.permissions.defaultMode = 'bypassPermissions'; return s; }, /permissions\.defaultMode differs from the template/],
    [(t, v) => { const s = fillTemplate(t, v); s.sandbox.filesystem.denyRead.pop(); return s; }, /denyRead\[\d+\] is not the template's .* filled in/],
    [(t, v) => { const s = fillTemplate(t, v); s.extra = true; return s; }, /the file has other keys than the template/],
    [(t, v) => { const s = fillTemplate(t, v); s.permissions.additionalDirectories[0] = '/elsewhere'; return s; }, /additionalDirectories\[0\] is not the template's value filled in/],
    [(t) => structuredClone(t), /is not the template's/],
  ];
  for (const [fill, re] of plants) {
    const r = run(m, {}, { fill });
    assert.equal(r.ok, false, String(re));
    assert.match(r.reason, /^the filled settings differ from the template beyond its placeholders: /);
    assert.match(r.reason, re);
  }
  assert.throws(() => lstatSync(join(m.c.root, SETTINGS_DIR, `${m.x.sessionId}.json`)), /ENOENT/);
});

test('L67: a template that is root\'s but loosened is still refused by the settings check', () => {
  const m = machine();
  const t = renderTemplate('reviewer').settings;
  t.sandbox.enabled = false;
  writeFileSync(templateFile(m.c.installRoot, 'reviewer'), templateText(t), { mode: 0o644 });
  const r = run(m);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^the filled settings were refused: /);
});

test('L67: the settings folder must be the runner\'s own, 0700, and not a link', () => {
  const m = machine();
  const dir = join(m.c.root, SETTINGS_DIR);
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  assert.match(run(m).reason, /is not the runner's own folder \(0700\)/);
  chmodSync(dir, 0o700);
  assert.match(run(m, {}, { uid: ME + 1 }).reason, /is not the runner's own folder/);
  assert.equal(run(m).ok, true);
  const m2 = machine();
  symlinkSync(m2.d('elsewhere-settings'), join(m2.c.root, SETTINGS_DIR));
  assert.match(run(m2).reason, /is not the runner's own folder/);
});

test('L67: the runner hands the wiring a settings maker bound to the session\'s role and id', () => {
  const m = machine('auditor');
  let got;
  const ports = realPorts({ ...m.c, uids: { reviewer: ME } }, { start: (x) => { got = x; return { ok: true, pid: 1 }; } }, { node: m.x.node });
  ports.start({ role: 'auditor', sessionId: m.x.sessionId });
  // Root owns the real template; this test's user does not, so the maker refuses by the auditor's template.
  const r = got.settingsFor(m.x.copy);
  assert.equal(r.ok, false);
  assert.match(r.reason, /the auditor template is not root's/);
});
