// review-settings.test.mjs — lead call L67 (addenda 1 and 2): a reviewer's or auditor's settings come from a committed
// template that root's updater copies in. The runner fills its placeholders with this session's and the config's paths,
// checks every value and spot, and writes the file to its own folder. Nothing here starts claude or runs as another user.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

// A throwaway machine: the installed copy (with the committed templates) as the updater lays it out, a versioned folder
// and root's link to it (L75 M-1), the runner's folder, the outboxes, the Bob folder, a secrets folder, and the review
// and workers' copies folders apart. node and the hooks are named through the link, as the runner's config names them.
const V = `install.v-${'c'.repeat(40)}`;
function machine(role = 'reviewer') {
  const base = realpathSync(tempDir('m4-tpl-'));
  const d = (...p) => { const x = join(base, ...p); mkdirSync(x, { recursive: true }); return x; };
  // L92 item 4: the link names orchestrate/ inside the versioned folder.
  const real = d(V, 'orchestrate');
  const installRoot = join(base, 'install');
  symlinkSync(`${V}/orchestrate`, installRoot);
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
  return { base, d, c, real, x: { role, sessionId: sid, copy: d('review-copies', 'card-1'), node } };
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
    const v = slotValues(m.c, m.x, { owner: ME }).values;
    // L75 M-1: node and the hooks by the copy folder's real path, never through root's link.
    assert.equal(v.node, join(m.real, 'bin', 'node'));
    assert.equal(v.hooks, join(m.real, 'hooks'));
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
  const a = slotValues(m.c, { ...m.x, role: 'auditor' }, { owner: ME });
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
  const v = slotValues({ ...m.c, reviewCopies: m.d('worker-copies-x') }, { ...m.x, copy: m.d('worker-copies-x', 'c') }, { owner: ME });
  assert.equal(v.ok, true, v.reason);
  // X1: "apart" is compared without case, even where the disk's case check is not there to catch it first (a realpath
  // that answers any name as it is).
  const wc = m.c.workerCopies;
  const shout = join(dirname(wc), basename(wc).toUpperCase(), 'review');
  assert.match(slotValues({ ...m.c, reviewCopies: shout }, { ...m.x, copy: join(shout, 'card-1') }, { owner: ME, realpath: (p) => p }).reason ?? 'ok', /must be apart/);
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
  // node or the hooks named by another copy folder's real path, beside the one the link names.
  const other = m.d(`install.v-${'d'.repeat(40)}`, 'hooks');
  assert.match(run(m, { c: { hooksDir: other } }).reason, /hooks: .* is not inside the installed copy \(.*install\.v-c{40}\/orchestrate\)/);
  assert.equal(realPathProblem('/a/./b'), '/a/./b is not in its plain form');
  assert.equal(realPathProblem('/a//b'), '/a//b is not in its plain form');
});

test('L73 point 7(a), C2: a value in another case than the disk holds, or / itself, is refused', (t) => {
  assert.equal(realPathProblem('/'), '/ is the whole disk, not a folder a setting may name');
  const d = realpathSync.native(tempDir('m4-case-'));
  mkdirSync(join(d, 'sub'));
  assert.equal(realPathProblem(join(d, 'sub')), null, 'the control');
  assert.equal(realPathProblem(join(d, 'sub', 'not-made-yet')), null);
  const upper = join(dirname(d), basename(d).toUpperCase());
  if (!existsSync(upper)) { t.skip('this disk tells case apart'); return; }
  assert.match(realPathProblem(upper), /is not in the disk's own case/);
  assert.match(realPathProblem(join(d, 'SUB')), /is not in the disk's own case/);
  assert.match(realPathProblem(join(d, 'SUB', 'not-made-yet')), /is not in the disk's own case/);
  // So two copies' folders can't be set apart by case alone.
  const m = machine();
  const wc = m.c.workerCopies;
  const shout = join(dirname(wc), basename(wc).toUpperCase(), 'review');
  assert.match(run(m, { c: { reviewCopies: shout }, x: { copy: join(shout, 'card-1') } }).reason, /is not in the disk's own case|must be apart/);
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

test('L75 M-1: the installed copy must be root\'s link to a versioned folder; a plain folder or a bad link is refused', () => {
  const m = machine();
  assert.equal(run(m).ok, true, 'through the link, as the config names it');
  // The reviewer's probe: the runner's config naming the paths by the folder's real path works the same.
  const m2 = machine();
  assert.equal(run(m2, { c: { hooksDir: join(m2.real, 'hooks') }, x: { node: join(m2.real, 'bin', 'node') } }).ok, true);
  // A plain folder where the link should be.
  const m3 = machine();
  assert.match(run(m3, { c: { installRoot: m3.real } }).reason, /is a plain folder, not the installed copy's link/);
  // The link of another owner's, or naming a folder that is missing.
  assert.match(run(m, {}, { owner: ME + 1 }).reason, /not root's|is not owned by uid/);
  rmSync(m.c.installRoot);
  symlinkSync(`install.v-${'e'.repeat(40)}/orchestrate`, m.c.installRoot);
  assert.match(run(m).reason, /the reviewer template can't be opened|the installed copy: .* is missing/);
  assert.match(slotValues(m.c, m.x, { owner: ME }).reason, /^the installed copy: .*install\.v-e{40}\/orchestrate, and install\.v-e{40} is missing/);
});

test('L75 caveat (c): every hook command exits 2 when its node or script is gone or crashes, so a hook never fails open', () => {
  for (const role of REVIEW_ROLES) {
    const m = machine(role);
    const r = run(m);
    assert.equal(r.ok, true, r.reason);
    const cmds = [];
    for (const groups of Object.values(r.settings.hooks)) for (const g of groups) for (const h of g.hooks) cmds.push(h.command);
    assert.ok(cmds.length >= 3, role);
    const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { input: '{}', encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin' } });
    const node = join(m.real, 'bin', 'node');
    // A node that runs and allows: the wrapper lets its answer through.
    writeFileSync(node, '#!/bin/sh\nexit 0\n');
    chmodSync(node, 0o755);
    for (const cmd of cmds) assert.equal(sh(cmd).status, 0, `${role}: ${cmd}`);
    // One that blocks (2), and one that crashes (1): both exit 2.
    writeFileSync(node, '#!/bin/sh\nexit 2\n');
    for (const cmd of cmds) assert.equal(sh(cmd).status, 2, cmd);
    writeFileSync(node, '#!/bin/sh\nkill -SEGV $$\n');
    for (const cmd of cmds) assert.equal(sh(cmd).status, 2, cmd);
    // The session's copy folder gone (an update after the one that kept it): node is missing (127), still 2.
    rmSync(m.real, { recursive: true });
    for (const cmd of cmds) {
      const x = sh(cmd);
      assert.equal(x.status, 2, `${cmd}: ${x.stderr}`);
    }
  }
  // The check refuses settings with a hook command that is not wrapped.
  const m = machine();
  const r = run(m);
  const t = structuredClone(r.settings);
  const h = Object.values(t.hooks)[0][0].hooks[0];
  h.command = h.command.replace(/ \|\| exit 2$/, '');
  assert.match(checkSettings(t, { profile: DESIGN_PROFILES.reviewer }).reason ?? 'ok', /does not exit 2 when it fails to run/);
});
