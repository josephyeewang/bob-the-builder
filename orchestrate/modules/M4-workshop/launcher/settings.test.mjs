// R-0b-32, R-0b-39, R-0b-40 and R-0b-42 (the parts that run without a real Claude Code): role
// profiles against the design ceiling, the rules snapshot, and the rendered role settings file.
// The sandbox, network and compaction behaviour themselves are live checks (owner steps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESIGN_PROFILES, NEVER_TOOLS, checkProfile, profilePort, fakeProfilePort, sha256, hasShell } from './role-profiles.mjs';
import { parseSnapshot, readSnapshot, makeSnapshot, snapshotHash, SNAPSHOT_MAX_AGE_MS } from '../hooks/snapshot.mjs';
import { renderAllowRules, renderRoleSettings, checkSettings, writeRoleSettings, POLICY_HOOKS, HOOK_TIMEOUT } from './render-settings.mjs';
import { SETTINGS as S, ENV } from './settings-names.mjs';
import { tmpFolder } from '../tmp-folders.test-helper.mjs';

const tmp = () => tmpFolder('orch-set-');

const PATHS = {
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node',
  deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: ['/w/copy2'] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git',
};
const PRODUCT = { commands: { test: 'npm test', build: 'npm run build' }, hosts: ['registry.example.com'] };
const render = (role, extra = {}) => renderRoleSettings({ role, profile: DESIGN_PROFILES[role], paths: PATHS, product: PRODUCT, rulesHosts: ['registry.example.com'], ...extra });

// ---- role profiles ----

test('every design profile passes its own ceiling, holds no never-list tool and is restricted', () => {
  for (const [role, prof] of Object.entries(DESIGN_PROFILES)) {
    assert.equal(checkProfile(role, prof).ok, true, role);
    assert.equal(prof.tools.some((t) => NEVER_TOOLS.includes(t)), false, role);
  }
  assert.equal(DESIGN_PROFILES.lead.compactWindow, 400000);
  assert.equal(DESIGN_PROFILES.thinking.compactWindow, 400000);
  assert.equal(DESIGN_PROFILES.front_door.compactWindow, 250000);
  assert.equal(DESIGN_PROFILES.worker.compactWindow, 300000);
  for (const r of ['lead', 'front_door', 'thinking']) assert.equal(DESIGN_PROFILES[r].setupFileRefusals, true, r);
  assert.deepEqual(DESIGN_PROFILES.front_door.skills, ['orchestrate']);
});

test('a published profile can never widen a role', () => {
  const w = DESIGN_PROFILES.worker;
  assert.match(checkProfile('worker', { ...w, tools: [...w.tools, 'Agent'] }).reason, /never-list/);
  assert.match(checkProfile('lead', { ...DESIGN_PROFILES.lead, tools: [...DESIGN_PROFILES.lead.tools, 'Bash'] }).reason, /outside the design/);
  assert.match(checkProfile('worker', { ...w, outbox: ['report', 'roadmap'] }).reason, /outbox kinds/);
  assert.match(checkProfile('worker', { ...w, mode: 'bypassPermissions' }).reason, /mode/);
  assert.match(checkProfile('worker', { ...w, restricted: false }).reason, /not restricted/);
  assert.match(checkProfile('worker', { ...w, compactWindow: 0 }).reason, /compaction/);
  assert.match(checkProfile('nobody', w).reason, /no such role/);
  assert.match(checkProfile('worker', { tools: 'Bash' }).reason, /malformed/);
  // A narrower profile is fine.
  assert.equal(checkProfile('worker', { ...w, tools: ['Read'] }).ok, true);
});

test('the profile reader fails closed: missing, wrong hash, bad JSON or unknown role', () => {
  const good = Buffer.from(JSON.stringify(DESIGN_PROFILES.scout));
  const files = { 'roles/scout.json': good, 'roles/writer.json': Buffer.from('{not json') };
  const hashes = { scout: sha256(good), writer: sha256(files['roles/writer.json']) };
  const port = profilePort({ readFile: (n) => { if (!files[n]) throw new Error('missing'); return files[n]; }, expectHash: (r) => hashes[r] });
  assert.equal(port.loadRoleProfile('scout').ok, true);
  assert.match(port.loadRoleProfile('writer').reason, /not JSON/);
  assert.match(port.loadRoleProfile('lead').reason, /missing/);
  assert.match(port.loadRoleProfile('__proto__').reason, /no such role/);
  hashes.scout = sha256(Buffer.from('other'));
  assert.match(port.loadRoleProfile('scout').reason, /published hash/);
  const noHash = profilePort({ readFile: () => good, expectHash: () => { throw new Error('x'); } });
  assert.match(noHash.loadRoleProfile('scout').reason, /published hash/);
  assert.equal(fakeProfilePort().loadRoleProfile('lead').ok, true);
  assert.equal(fakeProfilePort({ lead: { ...DESIGN_PROFILES.lead, tools: ['WebFetch'] } }).loadRoleProfile('lead').ok, false);
});

// ---- rules snapshot (launch check 8) ----

test('the rules snapshot is refused when missing, tampered, stale or from the future', () => {
  const rules = { caps: { workers: 2 } };
  const now = Date.parse('2026-10-29T12:00:00Z');
  const fresh = makeSnapshot(rules, new Date(now - 1000));
  assert.deepEqual(parseSnapshot(fresh, { now }).rules, rules);
  const tampered = JSON.parse(fresh); tampered.rules.caps.workers = 9;
  assert.match(parseSnapshot(JSON.stringify(tampered), { now }).reason, /hash/);
  assert.match(parseSnapshot(makeSnapshot(rules, new Date(now - SNAPSHOT_MAX_AGE_MS - 1)), { now }).reason, /stale/);
  assert.match(parseSnapshot(makeSnapshot(rules, new Date(now + 120000)), { now }).reason, /future/);
  assert.match(parseSnapshot('nope', { now }).reason, /not JSON/);
  assert.match(parseSnapshot('{}', { now }).reason, /no rules/);
  assert.match(parseSnapshot(JSON.stringify({ rules, hash: snapshotHash(rules) }), { now }).reason, /no time/);
  assert.match(readSnapshot(join(tmp(), 'none.json')).reason, /missing/);
  const f = join(tmp(), 'rules.json'); writeFileSync(f, makeSnapshot(rules));
  assert.equal(readSnapshot(f).ok, true);
});

// ---- allow rules (R-0b-32) ----

test('allow rules are only the declared commands, exactly; wildcards and joiners are refused', () => {
  assert.deepEqual(renderAllowRules(PRODUCT.commands).rules, ['Bash(npm test)', 'Bash(npm run build)']);
  for (const bad of ['npm *', 'npm:*', 'npm test && curl x', 'npm test; rm -rf /', 'a | b', 'echo `id`', 'echo $(id)', 'a > f', ' npm test', 'npm test\nrm', 'ls?', '']) {
    assert.equal(renderAllowRules({ k: bad }).ok, false, JSON.stringify(bad));
  }
  // Undeclared `FOO=1 ls` gets no rule, so under dontAsk it is refused, never asked.
  const s = render('worker').settings;
  assert.equal(s[S.permissions][S.allow].includes('Bash(FOO=1 ls)'), false);
  assert.deepEqual(s[S.permissions][S.ask], []);
  assert.equal(s[S.permissions][S.defaultMode], 'dontAsk');
  // Only a worker gets allow rules; other shell roles get none.
  assert.deepEqual(render('reviewer').settings[S.permissions][S.allow], []);
});

// ---- the rendered settings ----

test('a worker settings file carries every lock-down field and passes the check', () => {
  const r = render('worker');
  assert.equal(r.ok, true, r.reason);
  const s = r.settings;
  const sb = s[S.sandbox];
  assert.equal(sb[S.sandboxEnabled], true);
  assert.equal(sb[S.failIfUnavailable], true);
  assert.equal(sb[S.allowUnsandboxedCommands], false);
  assert.equal(Object.hasOwn(sb, S.excludedCommands), false);
  assert.equal(sb[S.network][S.strictAllowlist], true);
  assert.deepEqual(sb[S.network][S.allowedDomains], ['registry.example.com']);
  for (const p of ['/w/secrets', '/h/.claude', '/h/.ssh', '/h/.config/gh', '/w/keys', '/w/record', '/w/copy2']) {
    assert.ok(sb[S.filesystem][S.denyRead].includes(p), p);
    assert.ok(s[S.permissions][S.deny].includes(`Read(/${p}/**)`), p);
    assert.ok(s[S.permissions][S.deny].includes(`Edit(/${p}/**)`), p);
  }
  assert.equal(sb[S.filesystem][S.denyRead].includes('/w/mirror.git'), false, 'the mirror stays readable');
  assert.ok(s[S.permissions][S.deny].includes('Write(//w/outbox/.*)'));
  assert.ok(s[S.permissions][S.deny].includes('Edit(//w/bob/**)'));
  assert.equal(s[S.env][ENV.disableUpdates], '1');
  assert.equal(s[S.env][ENV.autoCompactWindow], '300000');
  assert.equal(s[S.disableClaudeAiConnectors], true);
  assert.deepEqual(s[S.enabledPlugins], {});
  assert.equal(s[S.crossSessionInbound], 'refuse');
  assert.equal(s[S.disableSkillShellExecution], true);
  assert.equal(s[S.disableBundledSkills], true);
  assert.equal(checkSettings(s, { profile: DESIGN_PROFILES.worker }).ok, true);
});

test('every policy hook and the compaction hooks block on failure with a 10 s limit', () => {
  for (const role of Object.keys(DESIGN_PROFILES)) {
    const s = render(role).settings;
    const pre = s[S.hooks].PreToolUse;
    assert.deepEqual(pre.map((h) => h.matcher), Object.values(POLICY_HOOKS), role);
    for (const ev of ['PreToolUse', 'PreCompact', 'PostCompact', 'SessionStart']) {
      for (const h of s[S.hooks][ev]) for (const x of h.hooks) {
        assert.equal(x.onFailure, 'block');
        assert.equal(x.timeout, HOOK_TIMEOUT);
        assert.ok(x.command.startsWith('/w/node /w/hooks/'), x.command);
        assert.ok(x.command.includes(`--role ${role} --outbox /w/outbox`));
      }
    }
    assert.equal(s[S.hooks].SessionStart[0].matcher, 'compact');
    assert.ok(s[S.hooks].PreCompact[0].hooks[0].command.includes(`--kind ${DESIGN_PROFILES[role].compactKind}`));
    assert.equal(s[S.env][ENV.autoCompactWindow], String(DESIGN_PROFILES[role].compactWindow));
  }
});

test('the Lead, Front Door and thinking room refuse every Claude setup and skill file (R-0b-39)', () => {
  for (const role of ['lead', 'front_door', 'thinking', 'learning']) {
    const deny = render(role).settings[S.permissions][S.deny];
    for (const pat of ['//**/.claude/**', '//**/.mcp.json', '//**/SKILL.md']) for (const t of ['Read', 'Edit', 'Write']) assert.ok(deny.includes(`${t}(${pat})`), `${role} ${t}(${pat})`);
  }
  assert.equal(render('worker').settings[S.permissions][S.deny].includes('Read(//**/.claude/**)'), false);
  // Removing one refusal is caught by the check.
  const s = render('lead').settings;
  s[S.permissions][S.deny] = s[S.permissions][S.deny].filter((r) => r !== 'Read(//**/SKILL.md)');
  assert.match(checkSettings(s, { profile: DESIGN_PROFILES.lead }).reason, /setup-file refusal/);
});

test('an off-list host is refused, not asked; a role with no shell gets no network', () => {
  assert.match(render('worker', { product: { ...PRODUCT, hosts: ['github.com'] } }).reason, /not on the rules' allowed list/);
  assert.match(render('worker', { product: { ...PRODUCT, hosts: ['*.example.com'] }, rulesHosts: ['*.example.com'] }).reason, /plain host name/);
  assert.deepEqual(render('lead').settings[S.sandbox][S.network][S.allowedDomains], []);
  // The install step adds the registry hosts, for a worker only.
  const inst = render('worker', { phase: 'install', registryHosts: ['npm.example.org'] });
  assert.deepEqual(inst.settings[S.sandbox][S.network][S.allowedDomains], ['registry.example.com', 'npm.example.org']);
  assert.match(render('reviewer', { phase: 'install' }).reason, /only a worker/);
  assert.match(render('worker', { paths: { ...PATHS, deny: { ...PATHS.deny, otherCopies: ['/w/mirror.git'] } } }).reason, /mirror/);
});

test('a planted escape in the machine-wide file refuses every role (R-0b-32)', () => {
  const planted = [
    { [S.sandbox]: { [S.excludedCommands]: ['git'] } },
    { [S.sandbox]: { [S.allowUnsandboxedCommands]: true } },
    { [S.permissions]: { [S.allow]: ['Bash(curl *)'] } },
    { [S.permissions]: { [S.ask]: ['Bash'] } },
    { [S.sandbox]: { [S.network]: { [S.allowedDomains]: ['github.com'] } } },
    { [S.apiKeyHelper]: '/bin/echo' },
  ];
  // Round 2 MIN-5: each with the reason it refuses for.
  const more = [
    [{ [S.env]: { X: '1' } }, /set variables/],
    [{ [S.disableAllHooks]: true }, /hold disableAllHooks/],
    [{ [S.permissions]: { [S.additionalDirectories]: ['/'] } }, /add folders/],
    [{ [S.permissions]: { [S.defaultMode]: 'bypassPermissions' } }, /permission mode/],
    [{ [S.sandbox]: { [S.sandboxEnabled]: false } }, /sandbox off/],
  ];
  for (const [m, why] of more) assert.match(checkSettings(m, { machineWide: true }).reason ?? '', why, JSON.stringify(m));
  for (const m of planted) assert.equal(checkSettings(m, { machineWide: true }).ok, false, JSON.stringify(m));
  assert.equal(checkSettings({ [S.permissions]: { [S.deny]: ['Read(//x/**)'] } }, { machineWide: true }).ok, true);
});

test('every lock-down field, broken one at a time, is caught by the check', () => {
  const breaks = [
    (s) => { s[S.sandbox][S.sandboxEnabled] = false; },
    (s) => { s[S.sandbox][S.failIfUnavailable] = false; },
    (s) => { s[S.sandbox][S.allowUnsandboxedCommands] = true; },
    (s) => { s[S.sandbox][S.excludedCommands] = []; },
    (s) => { s[S.sandbox][S.network][S.strictAllowlist] = false; },
    (s) => { s[S.permissions][S.ask] = ['Bash(ls)']; },
    (s) => { s[S.permissions][S.allow].push('Bash(npm *)'); },
    (s) => { s[S.permissions][S.allow].push('Read(//etc/**)'); },
    (s) => { s[S.permissions][S.defaultMode] = 'bypassPermissions'; },
    (s) => { s[S.disableClaudeAiConnectors] = false; },
    (s) => { s[S.crossSessionInbound] = 'allow'; },
    (s) => { s[S.disableSkillShellExecution] = false; },
    (s) => { s[S.disableBundledSkills] = false; },
    (s) => { s[S.enabledPlugins] = { x: true }; },
    (s) => { delete s[S.env][ENV.disableUpdates]; },
    (s) => { s[S.env][ENV.autoCompactWindow] = '999'; },
    (s) => { s[S.apiKeyHelper] = '/bin/echo'; },
  ];
  for (const [i, b] of breaks.entries()) {
    const s = structuredClone(render('worker').settings);
    b(s);
    assert.equal(checkSettings(s, { profile: DESIGN_PROFILES.worker }).ok, false, `break ${i}`);
  }
});

test('the role file is written, read back from disk and checked', () => {
  const dir = tmp();
  const f = join(dir, 'worker.json');
  const s = render('worker').settings;
  const w = writeRoleSettings(f, s, { profile: DESIGN_PROFILES.worker });
  assert.equal(w.ok, true, w.reason);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), s);
  const bad = structuredClone(s); bad[S.sandbox][S.failIfUnavailable] = false;
  assert.match(writeRoleSettings(f, bad, { profile: DESIGN_PROFILES.worker }).reason, /failIfUnavailable/);
  assert.equal(hasShell(DESIGN_PROFILES.lead), false);
});

// ---- planted failures for each refusal line, checked by their own reasons (audit R-0b-44 M-6) ----

test('render and check: an unknown role, a bad phase, a path with a space, a missing unsandboxed refusal and a read-back that differs each refuse with their own reason', () => {
  assert.equal(renderRoleSettings({ role: 'nobody', profile: DESIGN_PROFILES.worker, paths: PATHS }).reason, 'no such role "nobody"');
  assert.equal(render('worker', { phase: 'later' }).reason, 'bad phase');
  assert.match(render('worker', { paths: { ...PATHS, outbox: '/w/out box' } }).reason, /^path "\/w\/out box" is not a plain absolute path$/);
  const s = structuredClone(render('worker').settings);
  assert.equal(checkSettings(s).ok, true);
  delete s[S.sandbox][S.allowUnsandboxedCommands];
  assert.equal(checkSettings(s).reason, 'allowUnsandboxedCommands is not false');
  // A settings object that reads differently each time: what came back from disk is not it.
  const shifting = structuredClone(render('worker').settings);
  let n = 0;
  Object.defineProperty(shifting, 'shifting', { get: () => n++, enumerable: true });
  assert.equal(writeRoleSettings(join(tmp(), 'role.json'), shifting).reason, 'role settings read back differently');
});

test('round 2 MIN-4: the Bob folder is on the sandbox no-write list, so the shell cannot write it either', () => {
  for (const role of ['worker', 'reviewer', 'lead']) {
    const w = render(role).settings[S.sandbox][S.filesystem][S.denyWrite];
    assert.ok(w.includes(PATHS.bobFolder) && w.includes(`${PATHS.bobFolder}/**`), role);
  }
});
