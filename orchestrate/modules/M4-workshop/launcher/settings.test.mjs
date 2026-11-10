// R-0b-32, R-0b-39, R-0b-40 and R-0b-42 (the parts that run without a real Claude Code): role
// profiles against the design ceiling, the rules snapshot, and the rendered role settings file.
// The sandbox, network and compaction behaviour themselves are live checks (owner steps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DESIGN_PROFILES, NEVER_TOOLS, checkProfile, profilePort, fakeProfilePort, sha256, hasShell } from './role-profiles.mjs';
import { parseSnapshot, readSnapshot, makeSnapshot, snapshotHash, SNAPSHOT_MAX_AGE_MS } from '../hooks/snapshot.mjs';
import { apart, renderAllowRules, renderRoleSettings, checkSettings, writeRoleSettings, POLICY_HOOKS, HOOK_TIMEOUT, checkRunnerWall, runnerWallDeny, runnerWallDirs, runnerWallShell, bobFolderDeny, bobFolderShell } from './render-settings.mjs';
import { SETTINGS as S, ENV, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { checkMachineWide } from './env-check.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';

const tmp = () => tempDir('orch-set-');

// Sandbox setting names claude 2.1.322 reads (from its own code, #410 r2 M1) that the renderer never writes: each one is
// refused in a role file and in the machine-wide file. Recheck on every pinned upgrade.
const WIDENING_TOP = ['enabledPlatforms', 'allowAppleEvents', 'autoAllowBashIfSandboxed', 'enableWeakerNestedSandbox', 'enableWeakerNetworkIsolation',
  'allowNestedUserNamespaces', 'credentials', 'ripgrep', 'bwrapPath', 'socatPath', 'ignoreViolations', 'tlsTerminate', 'somethingNew'];
const WIDENING_NETWORK = ['allowUnixSockets', 'allowAllUnixSockets', 'allowLocalBinding', 'allowMachLookup', 'httpProxyPort', 'socksProxyPort'];
const WIDENING_FILESYSTEM = ['allowWrite', 'allowRead', 'allowManagedReadPathsOnly', 'somethingNew'];
const PATHS = {
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', ownerTaps: '/w/owner-taps', reviewAgainConfig: '/w/review-again.json', notes: '/w/notes',
  deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: ['/w/copy2'] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git',
  reviewWalls: { outboxRoot: '/r/outbox', runnerRoot: '/r/review' },
};
const PRODUCT = { commands: { test: 'npm test', build: 'npm run build' }, hosts: ['registry.example.com'] };
const render = (role, extra = {}) => renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role, profile: DESIGN_PROFILES[role], paths: PATHS, product: PRODUCT, rulesHosts: ['registry.example.com'], ...extra });

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
  assert.match(checkProfile('worker', { ...w, outbox: ['report-', 'roadmap-'] }).reason, /outbox kinds/);
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
  assert.equal(renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role: 'nobody', profile: DESIGN_PROFILES.worker, paths: PATHS }).reason, 'no such role "nobody"');
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

// Does a sandbox write-deny list cover a path? An entry is a path (itself), or `<path>/**` (everything under it).
const covers = (list, p) => list.some((e) => e === p || (e.endsWith('/**') && p.startsWith(`${e.slice(0, -3)}/`)));

test('L66 M3: a reviewer\'s and an auditor\'s shell may write none of the review folders; the Write tool only the outbox', () => {
  for (const role of ['reviewer', 'auditor']) {
    const r = render(role);
    assert.equal(r.ok, true, r.reason);
    const sb = r.settings.sandbox;
    const dw = sb.filesystem.denyWrite;
    // Bash, and every program it starts (the sandbox covers the whole process tree), trying to write a verdict into the
    // outbox, a launch record, the status or a request: each path is on the no-write list.
    for (const p of ['/r/outbox/reviewer/R-1/verdict-C-1.json', '/r/outbox/auditor/A-1/verdict-C-1.md', '/r/outbox/reviewer', '/r/review/launches/R-1.json',
      '/r/review/status.json', '/r/review/state.json', '/r/review/requests/q-1.json', '/r/review/requests', '/r/review/rejected/x', '/r/review']) assert.ok(covers(dw, p), `${role}: ${p}`);
    assert.equal(covers(dw, '/w/copy/src/a.mjs'), false, 'the code copy stays writable');
    assert.equal(sb.allowUnsandboxedCommands, false);
    assert.equal(checkSettings(r.settings, { profile: DESIGN_PROFILES[role] }).ok, true);
    // The Write and Edit tools: never the launches, status or request folders; the outbox stays open for the verdict.
    const deny = r.settings.permissions.deny;
    for (const t of ['Write', 'Edit']) assert.ok(deny.includes(`${t}(//r/review/**)`), `${role} ${t} the runner's folder`);
    assert.equal(deny.some((d) => /^(Write|Edit)\(\/\/r\/outbox\/\*\*\)$/.test(d)), false, 'the Write tool may write the verdict');
    // Without the folders named, a review role is refused; a path that is not plain is refused.
    const { reviewWalls, ...noWalls } = PATHS;
    assert.match(render(role, { paths: noWalls }).reason, new RegExp(`a ${role}'s settings need the review folder outboxRoot`));
    assert.match(render(role, { paths: { ...PATHS, reviewWalls: { ...reviewWalls, runnerRoot: 'r/review' } } }).reason, /review folder runnerRoot as a plain absolute path/);
    assert.match(render(role, { paths: { ...PATHS, reviewWalls: { ...reviewWalls, runnerRoot: '/r/../review' } } }).reason, /review folder runnerRoot/);
    assert.match(render(role, { paths: { ...PATHS, reviewWalls: { outboxRoot: '/r/outbox' } } }).reason, /review folder runnerRoot/);
  }
  // The other roles don't need them, and get no such entries.
  const { reviewWalls, ...noWalls } = PATHS;
  const wk = render('worker', { paths: noWalls });
  assert.equal(wk.ok, true, wk.reason);
  assert.equal(covers(wk.settings.sandbox.filesystem.denyWrite, '/r/review/launches/R-1.json'), false);
});

test('round 2 MIN-4: the Bob folder is on the sandbox no-write list, so the shell cannot write it either', () => {
  for (const role of ['worker', 'reviewer', 'lead']) {
    const w = render(role).settings[S.sandbox][S.filesystem][S.denyWrite];
    assert.ok(w.includes(PATHS.bobFolder) && w.includes(`${PATHS.bobFolder}/**`), role);
  }
});

test('round 3 MIN-2: a production file the rules list but the role file does not deny refuses the launch', () => {
  assert.equal(renderRoleSettings({ role: 'worker', profile: DESIGN_PROFILES.worker, paths: PATHS, product: PRODUCT, rulesHosts: ['registry.example.com'] }).reason, 'the rules\' production file list was not given');
  assert.equal(render('worker', { productionFiles: ['/p/settings.production'] }).reason, 'the rules list production files the role file does not deny: /p/settings.production');
  assert.equal(render('worker', { productionFiles: ['/w/secrets/settings.production', '/w/secrets'] }).ok, true, 'inside a denied folder, or the folder itself');
  assert.equal(render('worker', { productionFiles: ['/w/secretsX/settings.production'] }).ok, false, 'a folder whose name only starts the same');
});

// L751: the workers run as the worker runner's own Mac user, so its status and requests folders are walled off from them.
const RUNNER = { requestsDir: '/u/runner/requests', statusFile: '/u/runner/state/status.json' };
test('L751: every role the runner starts is denied the worker runner\'s requests and status folders; the Lead and review roles are not given them', () => {
  for (const role of Object.keys(DESIGN_PROFILES).filter((r) => r !== 'lead' && !REVIEW_ROLES.includes(r))) {
    const r = render(role, { paths: { ...PATHS, workerRunner: RUNNER } });
    assert.equal(r.ok, true, `${role}: ${r.reason}`);
    const deny = r.settings[S.permissions][S.deny];
    const fs = r.settings[S.sandbox][S.filesystem];
    for (const dir of ['/u/runner/requests', '/u/runner/state']) {
      for (const tool of ['Read', 'Edit', 'Write']) assert.ok(deny.includes(`${tool}(/${dir}/**)`), `${role} ${tool} ${dir}`);
      assert.deepEqual(runnerWallDeny(dir), ['Read', 'Edit', 'Write'].map((t) => `${t}(/${dir}/**)`), 'the shared helper writes the "//path" form');
      assert.ok(fs[S.denyRead].includes(dir), `${role}: the shell may not read ${dir}`);
      assert.ok(fs[S.denyWrite].includes(dir) && fs[S.denyWrite].includes(`${dir}/**`), `${role}: the shell may not write ${dir}`);
    }
  }
  for (const role of ['lead', ...REVIEW_ROLES]) {
    const r = render(role, { paths: { ...PATHS, workerRunner: RUNNER } });
    assert.equal(r.ok, true, `${role}: ${r.reason}`);
    assert.ok(!JSON.stringify(r.settings).includes('/u/runner'), `${role} is not a runner role`);
  }
  // Malformed paths, a top-level folder, or one holding the session's own outbox are refused, never rendered open.
  for (const [wr, why] of [[{ requestsDir: '/u/runner/requests' }, /statusFile is not a plain absolute path/], [{ ...RUNNER, requestsDir: 'runner/requests' }, /requestsDir is not a plain/],
    [{ ...RUNNER, statusFile: '/u/../status.json' }, /statusFile is not a plain/], [{ ...RUNNER, statusFile: '/status.json' }, /below a folder of their own/],
    [{ ...RUNNER, requestsDir: '/w/copy' }, /apart from the session's own folders/], [{ ...RUNNER, requestsDir: `${PATHS.hooksDir}/requests` }, /apart from the session's own folders/], [{ ...RUNNER, requestsDir: PATHS.hooksDir }, /apart from the session's own folders/], [null, /requestsDir is not a plain/]]) {
    assert.match(render('worker', { paths: { ...PATHS, workerRunner: wr } }).reason ?? '', why, JSON.stringify(wr));
  }
  // Both ways: a runner folder that holds one of the session's own folders is refused too.
  assert.match(render('worker', { paths: { ...PATHS, notes: '/u/runner/state/notes', workerRunner: RUNNER } }).reason ?? '', /apart from the session's own folders/);
  // Without regard to case, both ways (#410 r2 m3): the Mac's disk ignores it.
  assert.match(render('worker', { paths: { ...PATHS, notes: '/U/RUNNER/state/notes', workerRunner: RUNNER } }).reason ?? '', /apart from the session's own folders/);
  assert.match(render('worker', { paths: { ...PATHS, workerRunner: { ...RUNNER, requestsDir: '/W/COPY/requests' } } }).reason ?? '', /apart from the session's own folders/);
  // The same rule at the renderer's other two apart checks: the notes folder and the tap handler's config.
  assert.match(render('lead', { paths: { ...PATHS, notes: '/W/OUTBOX/notes' } }).reason ?? '', /notes folder must be apart from the outbox/);
  assert.match(render('lead', { paths: { ...PATHS, notes: '/W' } }).reason ?? '', /notes folder must be apart from the outbox/);
  assert.match(render('front_door', { paths: { ...PATHS, reviewAgainConfig: '/W/OWNER-TAPS/x.json' } }).reason ?? '', /outside the taps folder/);
});

// The closest real check on this Mac (L751): macOS's own sandbox (Seatbelt, which Claude Code's shell sandbox runs on)
// is given a profile built from the rendered denyWrite list, and a shell writes into the runner's folders and its own
// outbox. The proof inside a real Claude session, with the rendered file, is pinned for the Mini.
test('L751: under macOS\'s sandbox, a worker\'s shell write to the runner\'s status or requests folder is blocked; its outbox is not', {
  skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') ? 'needs macOS sandbox-exec' : false,
}, () => {
  const d = realpathSync(tmp());
  const runner = { requestsDir: join(d, 'runner', 'requests'), statusFile: join(d, 'runner', 'state', 'status.json') };
  const outbox = join(d, 'outbox');
  for (const p of [runner.requestsDir, join(d, 'runner', 'state'), outbox]) mkdirSync(p, { recursive: true });
  const r = render('worker', { paths: { ...PATHS, outbox, workerRunner: runner } });
  assert.equal(r.ok, true, r.reason);
  const rules = r.settings[S.sandbox][S.filesystem][S.denyWrite].filter((p) => !/[*]/.test(p) && p.startsWith(d)).map((p) => `(deny file-write* (subpath "${p}"))`);
  assert.equal(rules.length, 2, 'the runner folders, and only they, are on the denyWrite list as plain folders here');
  const profile = `(version 1)(allow default)${rules.join('')}`;
  const write = (file) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', 'printf forged > "$1"', 'sh', file], { encoding: 'utf8' });
  for (const f of [runner.statusFile, join(runner.requestsDir, 'launch-forged.json')]) {
    const w = write(f);
    assert.notEqual(w.status, 0, `${f} was written`);
    assert.equal(existsSync(f), false, `${f} exists`);
  }
  const ok = write(join(outbox, 'report-1.md'));
  assert.equal(ok.status, 0, `control: the outbox write failed: ${ok.stderr}`);
});

// Review of #320 M1, M2: the launch-time check of the runner wall: present in the role file, and spelled as real paths.
test('L751: checkRunnerWall passes a rendered worker file with real runner folders, and refuses a missing wall or a linked spelling', () => {
  const d = realpathSync(tmp());
  const runner = { requestsDir: join(d, 'runner', 'requests'), statusFile: join(d, 'runner', 'state', 'status.json') };
  for (const p of [runner.requestsDir, join(d, 'runner', 'state')]) mkdirSync(p, { recursive: true });
  const r = render('worker', { paths: { ...PATHS, workerRunner: runner } });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(checkRunnerWall({ settings: r.settings, workerRunner: runner }), { ok: true });
  const bare = render('worker');
  assert.match(checkRunnerWall({ settings: bare.settings, workerRunner: runner }).reason ?? '', /does not deny the tools/, 'a file rendered without the wall');
  const noShell = structuredClone(r.settings);
  noShell[S.sandbox][S.filesystem][S.denyWrite] = noShell[S.sandbox][S.filesystem][S.denyWrite].filter((p) => !p.startsWith(join(d, 'runner', 'state')));
  assert.match(checkRunnerWall({ settings: noShell, workerRunner: runner }).reason ?? '', /does not deny the shell/);
  const noRead = structuredClone(r.settings);
  noRead[S.sandbox][S.filesystem][S.denyRead] = noRead[S.sandbox][S.filesystem][S.denyRead].filter((p) => !p.startsWith(join(d, 'runner')));
  assert.match(checkRunnerWall({ settings: noRead, workerRunner: runner }).reason ?? '', /does not deny the shell/, 'the shell read wall too');
  assert.match(checkRunnerWall({ settings: r.settings, workerRunner: runner, realpath: (p) => `/private${p}` }).reason ?? '', /not its real path/, 'a linked spelling, as /tmp for /private/tmp');
  assert.match(checkRunnerWall({ settings: r.settings, workerRunner: { ...runner, requestsDir: join(d, 'gone') } }).reason ?? '', /is missing/);
  assert.match(checkRunnerWall({ settings: r.settings, workerRunner: null }).reason ?? '', /not a plain absolute path/);
});

// L763 (#320 m1): every rule is needed. Drop any single one, for either folder, and the check refuses (plant Q5: every -> some).
test('L763: checkRunnerWall refuses when any one runner-wall rule is dropped', () => {
  const d = realpathSync(tmp());
  const runner = { requestsDir: join(d, 'runner', 'requests'), statusFile: join(d, 'runner', 'state', 'status.json') };
  for (const p of [runner.requestsDir, join(d, 'runner', 'state')]) mkdirSync(p, { recursive: true });
  const r = render('worker', { paths: { ...PATHS, workerRunner: runner } });
  assert.equal(r.ok, true, r.reason);
  const without = (pick, rule) => { const s = structuredClone(r.settings); const o = pick(s); o.list.splice(0, o.list.length, ...o.list.filter((x) => x !== rule)); return s; };
  const tools = (s) => ({ list: s[S.permissions][S.deny] });
  const read = (s) => ({ list: s[S.sandbox][S.filesystem][S.denyRead] });
  const write = (s) => ({ list: s[S.sandbox][S.filesystem][S.denyWrite] });
  const { dirs } = runnerWallDirs(runner);
  assert.equal(dirs.length, 2);
  let n = 0;
  for (const dir of dirs) {
    for (const rule of runnerWallDeny(dir)) { n++; assert.match(checkRunnerWall({ settings: without(tools, rule), workerRunner: runner }).reason ?? '', /does not deny the tools/, rule); }
    n++; assert.match(checkRunnerWall({ settings: without(read, dir), workerRunner: runner }).reason ?? '', /does not deny the shell/, `denyRead ${dir}`);
    for (const rule of runnerWallShell(dir)) { n++; assert.match(checkRunnerWall({ settings: without(write, rule), workerRunner: runner }).reason ?? '', /does not deny the shell/, `denyWrite ${rule}`); }
  }
  assert.equal(n, 12, 'three tool rules, one read and two write rules, for each of the two folders');
});

test('L746 (audit R-0b-148 slice 1, m1): an empty proposals list is refused for every role but a reviewer or auditor', () => {
  for (const role of Object.keys(DESIGN_PROFILES).filter((r) => !REVIEW_ROLES.includes(r))) {
    const r = render(role, { proposalOutboxes: [], paths: { ...PATHS, deny: { ...PATHS.deny, proposals: [] } } });
    assert.equal(r.ok, false, role);
    assert.equal(r.reason, 'the rules\' proposals folders are an empty list, so nothing would deny them', role);
  }
  // A reviewer or auditor runs as the review user, which the folders already shut out: an empty list is fine there.
  for (const role of ['reviewer', 'auditor']) assert.equal(render(role, { proposalOutboxes: [] }).ok, true, role);
  // A non-empty list on the deny list still renders, and its folder is denied.
  const ok = render('worker');
  assert.equal(ok.ok, true, ok.reason);
  for (const rule of ['Read(//w/proposals/**)', 'Edit(//w/proposals/**)']) assert.ok(ok.settings[S.permissions][S.deny].includes(rule), rule);
});

// L760: a script card's session is walled as a worker is: secrets, proposals, the Bob folder and the worker runner's
// folders, checked through checkRunnerWall; and nothing a reviewer has.
test('L760: the script profile renders with the worker\'s walls, passes checkRunnerWall, and holds nothing of a reviewer\'s', () => {
  const d = realpathSync(tmp());
  const runner = { requestsDir: join(d, 'runner', 'requests'), statusFile: join(d, 'runner', 'state', 'status.json') };
  for (const p of [runner.requestsDir, join(d, 'runner', 'state')]) mkdirSync(p, { recursive: true });
  assert.equal(checkProfile('script', DESIGN_PROFILES.script).ok, true);
  assert.deepEqual(DESIGN_PROFILES.script.outbox, ['report-', 'handin-']);
  const r = render('script', { paths: { ...PATHS, workerRunner: runner } });
  assert.equal(r.ok, true, r.reason);
  // It asks nobody (dontAsk), and with no shell it reaches no host, even with the rules' hosts given (#331 audit m2).
  assert.equal(r.settings[S.permissions][S.defaultMode], 'dontAsk');
  assert.deepEqual(r.settings[S.sandbox][S.network][S.allowedDomains], []);
  assert.deepEqual(checkRunnerWall({ settings: r.settings, workerRunner: runner }), { ok: true });
  const w = render('worker', { paths: { ...PATHS, workerRunner: runner } });
  const deny = r.settings[S.permissions][S.deny];
  const fs = r.settings[S.sandbox][S.filesystem];
  for (const dir of ['/w/secrets', '/w/proposals', '/h/.ssh', '/w/keys', '/w/record', '/w/copy2']) {
    for (const t of ['Read', 'Edit']) assert.ok(deny.includes(`${t}(/${dir}/**)`), `${t} ${dir}`);
    assert.ok(fs[S.denyRead].includes(dir), `the shell may not read ${dir}`);
  }
  for (const rule of bobFolderDeny('/w/bob')) assert.ok(deny.includes(rule), rule);
  assert.ok(fs[S.denyWrite].includes('/w/bob'), 'the shell may not write the Bob folder');
  // Every deny the worker has, the script has too, but for the shell and install walls of a role with a shell.
  for (const rule of w.settings[S.permissions][S.deny]) if (!/^Bash\(/.test(rule)) assert.ok(deny.includes(rule), `the worker's ${rule}`);
  assert.ok(!JSON.stringify(r.settings).includes('/r/'), 'no review runner or review outbox folder');
  assert.equal(hasShell(DESIGN_PROFILES.script), false, 'no shell');
  assert.equal(r.settings[S.permissions][S.allow].some((x) => /^Bash/.test(x)), false, 'no shell rule');
  // Without the proposals folders, or with an empty list, it is refused like a worker.
  assert.equal(render('script', { proposalOutboxes: undefined }).ok, false);
  assert.equal(render('script', { proposalOutboxes: [], paths: { ...PATHS, deny: { ...PATHS.deny, proposals: [] } } }).ok, false);
  // It writes its copy (the Dispatcher counts a script card as writing its files): the plain-files hook gets --copy.
  const hook = r.settings[S.hooks][E.preToolUse].find((e) => e[H.matcher] === POLICY_HOOKS['plain-files'])[H.hooks][0][H.command];
  assert.ok(hook.includes(' --copy /w/copy'), hook);
  // M10's published script.json lists Workflow: still refused here, as on the never-list.
  assert.match(checkProfile('script', { ...DESIGN_PROFILES.script, tools: [...DESIGN_PROFILES.script.tools, 'Workflow'] }).reason, /never-list/);
});

test('L881: the shell\'s write wall between sessions: the only added folders are the session\'s own outbox and the read-only Bob folder', () => {
  const w = render('worker');
  assert.equal(w.ok, true, w.reason);
  const s = w.settings;
  // What a worker's shell may write (claude's sandbox: the working folder, a per-user temp folder and the added
  // folders) holds its own outbox and no sibling's: a sibling outbox can't be written, renamed or deleted.
  assert.deepEqual(s[S.permissions][S.additionalDirectories], [PATHS.outbox, PATHS.bobFolder]);
  const writable = [PATHS.copy, ...s[S.permissions][S.additionalDirectories]];
  const inside = (x, d) => x === d || x.startsWith(`${d}/`);
  for (const sibling of ['/w/outbox-2', '/w/outbox2/x', '/w', '/w/copy2']) assert.equal(writable.some((d) => inside(sibling, d)), false, sibling);
  assert.equal(Object.keys(s[S.sandbox][S.filesystem]).some((k) => /allow/i.test(k)), false, 'no shell write is added by an allow list');
  assert.equal(s[S.permissions][S.allow].every((r) => r.startsWith('Bash(')), true, 'no file write is allowed by rule');
  assert.equal(checkSettings(s, { profile: DESIGN_PROFILES.worker }).ok, true);
  // Every rendered role passes the same check.
  const rendered = [];
  for (const role of Object.keys(DESIGN_PROFILES)) {
    const r = render(role);
    if (!r.ok) continue;
    rendered.push(role);
    assert.equal(checkSettings(r.settings, { profile: DESIGN_PROFILES[role] }).ok, true, role);
  }
  // Every role renders with this test's paths (L881 review m6): none drops out of the loop unseen.
  assert.deepEqual(rendered.sort(), Object.keys(DESIGN_PROFILES).sort());
  // Each drift is refused by checkSettings, which launch check 0 and every read-back run.
  const drift = (f) => { const c = structuredClone(s); f(c); return checkSettings(c, { profile: DESIGN_PROFILES.worker }); };
  const dirs = (c) => c[S.permissions][S.additionalDirectories];
  for (const [name, f] of [
    ['a sibling outbox added', (c) => dirs(c).push('/w/outbox-2')],
    ['the outbox root added', (c) => { dirs(c)[0] = '/w'; }],
    ['a sibling in the outbox\'s place', (c) => { dirs(c)[0] = '/w/outbox-2'; }],
    ['a sibling in the Bob folder\'s place', (c) => { dirs(c)[1] = '/w/outbox-2'; }],
    ['the outbox twice', (c) => { dirs(c)[1] = PATHS.outbox; }],
    ['the Bob folder\'s tools wall gone', (c) => { c[S.permissions][S.deny] = c[S.permissions][S.deny].filter((r) => !bobFolderDeny(PATHS.bobFolder).includes(r)); }],
    ['the Bob folder\'s shell wall gone', (c) => { c[S.sandbox][S.filesystem][S.denyWrite] = c[S.sandbox][S.filesystem][S.denyWrite].filter((r) => !r.startsWith(PATHS.bobFolder)); }],
    ['the first hook naming another outbox', (c) => { const h = Object.values(c[S.hooks])[0][0][H.hooks][0]; h[H.command] = h[H.command].replace(` --outbox ${PATHS.outbox}`, ' --outbox /w/outbox-2'); }],
    ['a later hook naming another outbox', (c) => { const h = Object.values(c[S.hooks]).at(-1).at(-1)[H.hooks].at(-1); h[H.command] = h[H.command].replace(` --outbox ${PATHS.outbox}`, ' --outbox /w/outbox-2'); }],
    ['the added folders a string', (c) => { c[S.permissions][S.additionalDirectories] = '/w'; }],
    ['the outbox spelled with ..', (c) => { for (const h of Object.values(c[S.hooks]).flat().flatMap((m) => m[H.hooks])) h[H.command] = h[H.command].replace(` --outbox ${PATHS.outbox}`, ' --outbox /w/x/../outbox'); dirs(c)[0] = '/w/x/../outbox'; }],
    ['a hook naming its outbox twice', (c) => { const h = Object.values(c[S.hooks])[0][0][H.hooks][0]; h[H.command] = h[H.command].replace(` --outbox ${PATHS.outbox}`, ` --outbox ${PATHS.outbox} --outbox /w/outbox-2`); }],
    ['a hook naming it as --outbox=', (c) => { const h = Object.values(c[S.hooks])[0][0][H.hooks][0]; h[H.command] = h[H.command].replace(` --outbox ${PATHS.outbox}`, ` --outbox=${PATHS.outbox}`); }],
    ['the Bob folder spelled with .., walls in that spelling', (c) => { const b = '/w/x/../bob'; dirs(c)[1] = b; c[S.permissions][S.deny].push(...bobFolderDeny(b)); c[S.sandbox][S.filesystem][S.denyWrite].push(...bobFolderShell(b)); }],
    ['only the Bob folder\'s /** shell wall gone', (c) => { c[S.sandbox][S.filesystem][S.denyWrite] = c[S.sandbox][S.filesystem][S.denyWrite].filter((r) => r !== `${PATHS.bobFolder}/**`); }],
    ['only the Bob folder\'s Edit rule gone (Write kept)', (c) => { c[S.permissions][S.deny] = c[S.permissions][S.deny].filter((r) => r !== bobFolderDeny(PATHS.bobFolder)[0]); }],
    ['the Bob folder in other capitals of the outbox\'s parent', (c) => { const b = '/W'; dirs(c)[1] = b; c[S.permissions][S.deny].push(...bobFolderDeny(b)); c[S.sandbox][S.filesystem][S.denyWrite].push(...bobFolderShell(b)); }],
    ['the Bob folder above the outbox', (c) => { dirs(c)[1] = '/w'; c[S.permissions][S.deny].push(...bobFolderDeny('/w')); c[S.sandbox][S.filesystem][S.denyWrite].push('/w', '/w/**'); }],
  ]) assert.match(drift(f).reason ?? '', /beyond the session's own outbox/, name);
  // Nothing in the sandbox's filesystem block but its two deny lists (L881 review M1): an allow list there would open
  // a sibling's outbox to the shell whatever the added folders say.
  for (const key of ['allowWrite', 'allowRead', 'somethingNew']) {
    assert.match(drift((c) => { c[S.sandbox][S.filesystem][key] = ['/w/outbox-2']; }).reason ?? '', new RegExp(`holds ${key}`), key);
    // With no added folders at all, too (#410 r1 A11).
    assert.match(drift((c) => { delete c[S.permissions][S.additionalDirectories]; c[S.sandbox][S.filesystem][key] = ['/w/outbox-2']; }).reason ?? '', new RegExp(`holds ${key}`), `${key}, no added folders`);
  }
  // Any sandbox key the renderer does not write (#410 r1 m3), each name claude 2.1.322 reads (#410 r2 m1).
  for (const k of WIDENING_TOP) assert.match(drift((c) => { c[S.sandbox][k] = true; }).reason ?? '', new RegExp(`sandbox holds ${k};`), k);
  for (const k of WIDENING_NETWORK) assert.match(drift((c) => { c[S.sandbox][S.network][k] = ['x']; }).reason ?? '', new RegExp(`network holds ${k};`), `network ${k}`);
  for (const k of WIDENING_FILESYSTEM) assert.match(drift((c) => { c[S.sandbox][S.filesystem][k] = true; }).reason ?? '', new RegExp(`filesystem holds ${k};`), `filesystem ${k}`);
  for (const part of [S.network, S.filesystem]) for (const v of [[], 'x', null]) {
    assert.match(drift((c) => { c[S.sandbox][part] = v; }).reason ?? '', new RegExp(`sandbox ${part} is not an object`), `${part} ${JSON.stringify(v)}`);
  }
  // The outbox in capitals, Bob inside it (#410 r2 m2): apart is checked without regard to case, both ways.
  const bobAt = (c, b) => { dirs(c)[1] = b; c[S.permissions][S.deny].push(...bobFolderDeny(b)); c[S.sandbox][S.filesystem][S.denyWrite].push(...bobFolderShell(b)); };
  assert.match(drift((c) => bobAt(c, '/w/outbox/bob')).reason ?? '', /beyond the session's own outbox/, 'Bob inside the outbox');
  assert.match(drift((c) => {
    for (const h of Object.values(c[S.hooks]).flat().flatMap((m) => m[H.hooks])) h[H.command] = h[H.command].replace(` --outbox ${PATHS.outbox}`, ' --outbox /W/OUTBOX');
    dirs(c)[0] = '/W/OUTBOX'; bobAt(c, '/w/outbox/bob');
  }).reason ?? '', /beyond the session's own outbox/, 'the outbox in capitals, Bob inside it');
  // With no profile (#410 r1 A8: writeRoleSettings may be called without one), the wall is still checked.
  const noProfile = structuredClone(s); noProfile[S.permissions][S.additionalDirectories].push('/w/outbox-2');
  assert.match(checkSettings(noProfile).reason ?? '', /beyond the session's own outbox/);
  // The machine-wide file (#410 r1 M1, r2 M1, launch check 10): its sandbox block is an allow-list, each key with its
  // one safe value; every other key claude 2.1.322 reads from it is refused (one case per name, r2 m1).
  const mw = (sb) => checkSettings({ [S.sandbox]: sb }, { machineWide: true });
  assert.equal(mw({ [S.sandboxEnabled]: true, [S.failIfUnavailable]: true, [S.allowUnsandboxedCommands]: false,
    [S.network]: { [S.strictAllowlist]: true, deniedDomains: ['example.com'], allowManagedDomainsOnly: true }, [S.filesystem]: { [S.denyRead]: ['/x'], [S.denyWrite]: ['/y'] } }).ok, true);
  for (const k of WIDENING_TOP) assert.match(mw({ [k]: true }).reason ?? '', new RegExp(`machine-wide sandbox holds ${k};`), k);
  for (const k of WIDENING_NETWORK) assert.match(mw({ [S.network]: { [k]: [] } }).reason ?? '', new RegExp(`machine-wide sandbox network holds ${k};`), `network ${k}`);
  // allowedDomains: an empty list only (#410 r3 m2); one domain in it is refused.
  assert.equal(mw({ [S.network]: { [S.allowedDomains]: [], allowManagedDomainsOnly: true } }).ok, true, 'an empty allowedDomains');
  for (const v of [['example.com'], [''], 'x', null, {}]) assert.match(mw({ [S.network]: { [S.allowedDomains]: v } }).reason ?? '', new RegExp(`sets ${S.allowedDomains} to a value that is not its safe one`), JSON.stringify(v));
  // A key that is only an Object property name is not on the list (#410 r3 c1).
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.match(mw(JSON.parse(`{"${k}": {}}`)).reason ?? '', new RegExp(`machine-wide sandbox holds ${k};`), k);
    assert.match(mw({ [S.network]: JSON.parse(`{"${k}": {}}`) }).reason ?? '', new RegExp(`machine-wide sandbox network holds ${k};`), `network ${k}`);
  }
  for (const k of WIDENING_FILESYSTEM) assert.match(mw({ [S.filesystem]: { [k]: ['/w'] } }).reason ?? '', new RegExp(`machine-wide sandbox filesystem holds ${k};`), `filesystem ${k}`);
  // The audit's probe cases as written (r2 M1).
  for (const sb of [{ enabledPlatforms: [] }, { enabledPlatforms: ['linux'], [S.failIfUnavailable]: false }, { allowAppleEvents: true },
    { [S.network]: { allowMachLookup: ['*'] } }, { [S.network]: { httpProxyPort: 8080, socksProxyPort: 1080 } }, { autoAllowBashIfSandboxed: true },
    { enableWeakerNetworkIsolation: true }, { allowNestedUserNamespaces: true }, { [S.failIfUnavailable]: false }, { credentials: {} }, { ripgrep: {} },
    { bwrapPath: '/x' }, { socatPath: '/x' }, { ignoreViolations: {} }, { tlsTerminate: true }, { [S.excludedCommands]: ['git'] }]) assert.equal(mw(sb).ok, false, JSON.stringify(sb));
  // Each allowed key only at its safe value.
  assert.match(mw({ [S.sandboxEnabled]: false }).reason ?? '', /switch the sandbox off/);
  for (const [sb, k] of [[{ [S.sandboxEnabled]: 'yes' }, S.sandboxEnabled], [{ [S.sandboxEnabled]: 0 }, S.sandboxEnabled], [{ [S.sandboxEnabled]: 'true' }, S.sandboxEnabled], [{ [S.sandboxEnabled]: null }, S.sandboxEnabled], [{ [S.failIfUnavailable]: false }, S.failIfUnavailable],
    [{ [S.allowUnsandboxedCommands]: 'no' }, S.allowUnsandboxedCommands], [{ [S.network]: { [S.strictAllowlist]: false } }, S.strictAllowlist],
    [{ [S.network]: { deniedDomains: 'x' } }, 'deniedDomains'], [{ [S.network]: { allowManagedDomainsOnly: 'yes' } }, 'allowManagedDomainsOnly'],
    [{ [S.filesystem]: { [S.denyRead]: '/x' } }, S.denyRead], [{ [S.filesystem]: { [S.denyWrite]: [1] } }, S.denyWrite]]) {
    assert.match(mw(sb).reason ?? '', new RegExp(`sets ${k} to a value that is not its safe one`), JSON.stringify(sb));
  }
  for (const part of [S.network, S.filesystem]) for (const v of [[], 'x', null]) {
    assert.match(mw({ [part]: v }).reason ?? '', new RegExp(`machine-wide sandbox ${part} is not an object`), `${part} ${JSON.stringify(v)}`);
  }
  for (const v of [[], 'x', null]) assert.match(mw(v).reason ?? '', /machine-wide sandbox block is not an object/, JSON.stringify(v));
  // A realistic hardened managed file still passes launch check 10: the guard hook, deny rules, the sandbox on and fail-closed.
  const guard = { [H.matcher]: '*', [H.hooks]: [{ [H.type]: 'command', [H.command]: '/o/node /o/hooks/production-write-guard.mjs --role any', [H.timeout]: 10, [H.onFailure]: 'block' }] };
  const hardened = { [S.hooks]: { [E.preToolUse]: [guard] }, [S.permissions]: { [S.deny]: ['Read(//w/held/**)', 'Edit(//w/held/**)'] },
    [S.sandbox]: { [S.sandboxEnabled]: true, [S.failIfUnavailable]: true, [S.allowUnsandboxedCommands]: false, [S.network]: { [S.strictAllowlist]: true },
      [S.filesystem]: { [S.denyRead]: ['/w/held'], [S.denyWrite]: ['/w/held'] } } };
  assert.deepEqual(checkMachineWide({ readFile: () => JSON.stringify(hardened), path: '/fake/managed.json' }), { ok: true });
});

test('#410 r3 m1: apart is one rule, both ways, without regard to case; a shared prefix is apart, a trailing slash is not', () => {
  const rows = [['/w/out', '/w/outbox', true], ['/w/out', '/w/out', false], ['/w/out', '/W/OUT', false], ['/W/OUT', '/w/out/x', false],
    ['/w/out/', '/w/out', false], ['/w/out/', '/w/out/x', false], ['/W/Out/', '/w/oUT/x', false], ['/w/OUTBOX', '/w/out', true],
    ['/w/out-2', '/w/out', true], ['/', '/w', false], ['/w/x', '/w/y', true], ['/w/outnotes', '/w/out', true]];
  for (const [a, b, want] of rows) {
    assert.equal(apart(a, b), want, `${a} ${b}`);
    assert.equal(apart(b, a), want, `${b} ${a}`);
  }
});
