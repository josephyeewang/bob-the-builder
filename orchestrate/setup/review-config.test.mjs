// review-config (L709): the review runner's review.json, each field from one source, read back with the runner's own readConfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { join } from 'node:path';
import { INSTALL_LATER, OWNER_INPUT, SOURCES, buildReviewConfig, ownerFields, pinFields, pinProblem, reviewConfigCommand, setupFields, writingName } from './review-config.mjs';
import { CONFIG_FIELDS, readConfig } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { TOOLS_CHECKED } from '../modules/M10-rules/roles.mjs';
import { RUNNER_ROLES } from '../shared/review-roles.mjs';
import { COPY_CLAUDE_CODE, COPY_HOOKS, REVIEW_SNAPSHOT_FILE, folderTable, parseConfig, storePath } from './layout.mjs';
import { planInstall } from './install.mjs';
import { pinnedBinary } from '../modules/M4-workshop/launcher/hooks-check.mjs';
import { SNAPSHOT_FILE } from '../modules/M10-rules/snapshot.mjs';
import { main, parseArgs } from './setup.mjs';
import { bobManifestPath } from './bob-manifest.mjs';

const FIXED = '/Library/Application Support/ClaudeCode/managed-settings.json';
// #419 r3 m1: near misses of the fixed file, each refused by this layer's own check.
const NEAR_MISSES = [FIXED + '/', FIXED.toLowerCase(), FIXED.replace(' ', '\u00a0'), FIXED + '.bak'];
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

const PIN = TOOLS_CHECKED.claude_code;
const me = process.getuid();
const OWNER_UID = me + 1;   // a different number, so the uid map shows which role got which user

function world() {
  const top = realpathSync(tempDir('orch-review-config-'));
  const base = join(top, 'orchestrate');
  for (const d of ['', 'review', 'outboxes', 'review-copies', 'worker-copies', 'bob', 'keys', 'private', 'out']) mkdirSync(join(base, d), { recursive: true, mode: 0o755 });
  const cfg = parseConfig({ base, owner: 'joe', products: ['acme', 'beta'] });
  const users = { review: { exists: true, uid: me, home: join(base, 'home/review') }, orchestrate: { exists: true, uid: me + 2, home: join(base, 'home/orchestrate') }, joe: { exists: true, uid: OWNER_UID, home: '/Users/joe' } };
  const userOf = (n) => users[n] ?? { exists: false };
  // The runner's own readConfig, with its ports pointed at this folder (the walls stop at `top`; no access lists here).
  const check = (f) => readConfig(f, { top: base, acl: () => null });
  const input = () => ({ product: 'acme', machineWide: '/Library/Application Support/ClaudeCode/managed-settings.json', rules: { production: { env_files: ['/srv/acme/.env'], programs: ['vercel'], hosts: ['api.example.com'] }, secrets: { paths: [] } } });
  const run = ({ pin = PIN, give = input(), dry = false, forInstall = false, euid = me, outFile = join(base, 'out', 'review.json'), useCheck = check, bobThere } = {}) => {
    const inFile = join(base, 'out', 'input.json'); writeFileSync(inFile, typeof give === 'string' ? give : JSON.stringify(give));
    const lines = { out: [], err: [] };
    const code = reviewConfigCommand(cfg, { pin, input: inFile, out: outFile, dry, forInstall }, { euid, userOf, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s), ...(useCheck ? { check: useCheck } : {}), ...(bobThere ? { bobThere } : {}) });
    return { code, ...lines, outFile, text: existsSync(outFile) ? readFileSync(outFile, 'utf8') : null };
  };
  return { top, base, cfg, users, userOf, check, input, run, done: () => rmSync(top, { recursive: true, force: true }) };
}

test('every field the runner reads has exactly one source, and the built file holds exactly the fields with one', () => {
  const w = world();
  try {
    assert.deepEqual(Object.keys(SOURCES).sort(), [...CONFIG_FIELDS].sort(), 'SOURCES names every field readConfig reads, and no other');
    for (const [k, s] of Object.entries(SOURCES)) assert.ok(['setup', 'pin', 'owner', 'bob', 'later'].includes(s), `${k}: ${s}`);
    const s = setupFields(w.cfg, { pin: PIN, userOf: w.userOf }).fields;
    const o = ownerFields(w.cfg, w.input()).fields;
    const p = pinFields(w.cfg, PIN);
    const all = [...Object.keys(s), ...Object.keys(o), ...Object.keys(p)];
    assert.equal(new Set(all).size, all.length, 'no field comes from two sources');
    for (const [src, part] of [['setup', s], ['owner', o], ['pin', p]]) assert.deepEqual(Object.keys(part).sort(), Object.keys(SOURCES).filter((k) => SOURCES[k] === src).sort(), `${src} gives exactly its fields`);
    const { config } = buildReviewConfig(w.cfg, { pin: PIN, input: w.input(), userOf: w.userOf });
    assert.deepEqual(Object.keys(config).sort(), CONFIG_FIELDS.filter((k) => SOURCES[k] !== 'later' && SOURCES[k] !== 'bob').sort(), 'no Bob list named before the bob step has run');
    // L995: once the bob step's list is in the installed copy, bobManifest names exactly it, and nothing else changes.
    assert.deepEqual(Object.keys(SOURCES).filter((k) => SOURCES[k] === 'bob'), ['bobManifest']);
    const withBob = buildReviewConfig(w.cfg, { pin: PIN, input: w.input(), userOf: w.userOf, bobInstalled: true }).config;
    assert.deepEqual(withBob, { ...config, bobManifest: bobManifestPath(w.cfg) });
    assert.equal(bobManifestPath(w.cfg), join(w.base, 'install/orchestrate/bob-manifest.json'));
    assert.deepEqual(OWNER_INPUT.filter((k) => k !== 'product').sort(), Object.keys(SOURCES).filter((k) => SOURCES[k] === 'owner' && k !== 'recordRoot').sort(), 'the input keys are the owner fields (product stands for recordRoot)');
  } finally { w.done(); }
});

test('the file written is the one the runner\'s own readConfig takes, with setup\'s values, the pin\'s and the owner\'s', () => {
  const w = world();
  try {
    const r = w.run();
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.out.join('\n'), /the review runner's own check takes it/);
    assert.match(r.out.join('\n'), /Left out \(no source yet, or its step not run yet\): budget, bobManifest/);
    const c = w.check(r.outFile);
    assert.deepEqual(JSON.parse(r.text), JSON.parse(JSON.stringify(c)));
    const B = w.base;
    assert.equal(c.installRoot, join(B, 'install/orchestrate'));
    assert.equal(c.claudeBin, join(B, 'install/orchestrate/claude-code', PIN, 'claude'), 'where add-to-install puts the program');
    assert.equal(c.hooksDir, join(B, 'install/orchestrate/hooks'));
    assert.equal(c.wiring, join(B, 'install/orchestrate/modules/M4-workshop/launcher/review-wiring.mjs'));
    assert.equal(c.root, join(B, 'review'));
    assert.equal(c.snapshot, join(B, 'review', REVIEW_SNAPSHOT_FILE));
    assert.notEqual(REVIEW_SNAPSHOT_FILE, SNAPSHOT_FILE, 'M4\'s runner snapshot and M10\'s signed snapshot are two formats: never one file name (L731 M2)');
    assert.equal(c.outboxRoot, join(B, 'outboxes'));
    assert.equal(c.recordRoot, join(B, 'products/acme/store'));
    assert.equal(c.recordUid, me + 2);
    assert.equal(c.ownerUid, OWNER_UID); assert.equal(c.ownerHome, '/Users/joe');
    assert.deepEqual(c.deny, [join(B, 'keys'), join(B, 'private'), '/Users/joe']);
    assert.equal(c.pin, PIN);
    assert.deepEqual(Object.keys(c.uids).sort(), Object.keys(DESIGN_PROFILES).sort());
    for (const [role, uid] of Object.entries(c.uids)) assert.equal(uid, RUNNER_ROLES.includes(role) ? me : OWNER_UID, role);
    assert.equal(c.budget, undefined); assert.equal(c.bobManifest, undefined);
    assert.equal(r.text.includes('2.1.316') && !/"(budget|bobManifest)"/.test(r.text), true);
  } finally { w.done(); }
});

test('a missing owner field is refused by name, never defaulted, and nothing is written', () => {
  const w = world();
  try {
    const cut = [
      ['product', (i) => { delete i.product; }], ['machineWide', (i) => { delete i.machineWide; }], ['rules', (i) => { delete i.rules; }],
      ['rules.production', (i) => { delete i.rules.production; }], ['rules.secrets', (i) => { delete i.rules.secrets; }],
      ['rules.production.env_files', (i) => { delete i.rules.production.env_files; }], ['rules.production.programs', (i) => { delete i.rules.production.programs; }],
      ['rules.production.hosts', (i) => { delete i.rules.production.hosts; }], ['rules.secrets.paths', (i) => { delete i.rules.secrets.paths; }],
    ];
    for (const [name, f] of cut) {
      const give = w.input(); f(give);
      const r = w.run({ give });
      assert.equal(r.code, 1, name);
      assert.ok(r.err.some((l) => l.includes(`must set ${name} (there is no default`)), `${name}: ${r.err.join(' | ')}`);
      assert.match(r.err.at(-1), /nothing was written/);
      assert.equal(r.text, null, `${name}: no file`);
    }
  } finally { w.done(); }
});

test('the input file may not set a field setup or the pin gives, nor any field the runner does not read', () => {
  const w = world();
  try {
    for (const [k, v, why] of [['installRoot', '/x', /comes from setup/], ['deny', ['/x'], /comes from setup/], ['uids', {}, /comes from setup/], ['claudeBin', '/x', /comes from --pin/], ['pin', '9.9.9', /comes from --pin/], ['budget', '/x.mjs', /no source yet/], ['recordRoot', '/x', /may not set recordRoot: it comes from the product named \(set product instead\)/], ['colour', 'red', /no field of the runner's config/]]) {
      const r = w.run({ give: { ...w.input(), [k]: v } });
      assert.equal(r.code, 1, k);
      assert.ok(r.err.some((l) => why.test(l)), `${k}: ${r.err.join(' | ')}`);
      assert.equal(r.text, null);
    }
    const bad = [
      ['product not in the setup config', (i) => { i.product = 'other'; }, /product must be one of .*acme, beta/],
      ['relative machineWide', (i) => { i.machineWide = 'settings.json'; }, /machineWide must be the full path/],
      // L909: any file but claude's fixed one, whose guard would never apply.
      ['another machineWide', (i) => { i.machineWide = '/etc/claude/managed-settings.json'; }, /the input file's machineWide must be \/Library\/Application Support\/ClaudeCode\/managed-settings\.json: claude 2\.1\.316 reads only that file/],
      ...NEAR_MISSES.map((m) => [`machineWide near miss ${JSON.stringify(m)}`, (i) => { i.machineWide = m; }, new RegExp(`the input file's machineWide must be ${esc(FIXED)}: claude 2\\.1\\.316 reads only that file`)]),
      ['a rules list that is not a list', (i) => { i.rules.production.hosts = 'api'; }, /rules\.production\.hosts must be a list/],
      ['an unknown rules part', (i) => { i.rules.extra = {}; }, /rules hold "extra"/],
      ['an unknown rules list', (i) => { i.rules.secrets.more = []; }, /rules\.secrets holds "more"/],
    ];
    for (const [name, f, why] of bad) { const give = w.input(); f(give); const r = w.run({ give }); assert.equal(r.code, 1, name); assert.ok(r.err.some((l) => why.test(l)), `${name}: ${r.err.join(' | ')}`); }
    for (const give of ['[1]', 'null', '"x"', '{not json']) { const r = w.run({ give }); assert.equal(r.code, 1, give); assert.equal(r.text, null); assert.ok(!r.err.join('\n').includes('not json'), 'never quotes the file'); }
  } finally { w.done(); }
});

test('m-5: a pin other than the one the tool lists were checked on is refused, the dry run too (L731 m1), and nothing is written', () => {
  const w = world();
  try {
    const moved = new RegExp(`--pin is 2\\.1\\.999, but the role tool lists were checked on Claude Code ${PIN.replaceAll('.', '\\.')}`);
    const r = w.run({ pin: '2.1.999' });
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), moved);
    assert.match(r.err.join('\n'), /nothing was written/);
    assert.equal(r.text, null);
    for (const forInstall of [false, true]) {
      const d = w.run({ pin: '2.1.999', dry: true, forInstall });
      assert.equal(d.code, 1, 'the dry run refuses what the real run refuses'); assert.match(d.err.join('\n'), moved); assert.deepEqual(d.out, []);
    }
    assert.equal(pinProblem(PIN), null);
    assert.equal(buildReviewConfig(w.cfg, { pin: '2.1.317', input: w.input(), userOf: w.userOf }).config, null);
    assert.deepEqual(readdirSync(join(w.base, 'out')).filter((n) => n !== 'input.json'), [], 'no temporary file left');
    // readConfig itself, at daemon start: the same file with the checked pin passes, a moved pin does not.
    const ok = w.run(); assert.equal(ok.code, 0);
    const c = JSON.parse(ok.text); c.pin = '2.1.317'; writeFileSync(ok.outFile, JSON.stringify(c), { mode: 0o644 });
    assert.throws(() => w.check(ok.outFile), /config: pin is 2\.1\.317, but the role tool lists were checked/);
  } finally { w.done(); }
});

test('a wall the runner would refuse: nothing is written, the dry run refuses it too (the review folder missing)', () => {
  const w = world();
  try {
    rmSync(join(w.base, 'review'), { recursive: true });
    const r = w.run();
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /the review runner would refuse it: config: root: .* is missing/);
    assert.equal(r.text, null);
    const d = w.run({ dry: true });
    assert.equal(d.code, 1); assert.match(d.err.join('\n'), /the review runner would refuse it: config: root: .* is missing/); assert.deepEqual(d.out, []);
  } finally { w.done(); }
});

test('L731 m2: a refused run keeps the file --out held before, and leaves no new file beside it', () => {
  const w = world();
  try {
    const good = w.run(); assert.equal(good.code, 0);
    rmSync(join(w.base, 'review'), { recursive: true });
    for (const forInstall of [false, true]) {
      const r = w.run({ forInstall });
      assert.equal(r.code, 1);
      assert.match(r.err.join('\n'), /is as it was/);
      assert.equal(r.text, good.text, 'the earlier good file is kept, byte for byte');
      assert.equal(existsSync(writingName(r.outFile)), false, 'no new file left beside it');
    }
  } finally { w.done(); }
});

test('L731 m3: with no check passed in, the runner\'s own readConfig is the check', () => {
  const w = world();
  try {
    // The setup's real default, readConfig(file) with its real ports: with the runner's folder gone it refuses, so a
    // default that checks nothing would be seen writing the file.
    rmSync(join(w.base, 'review'), { recursive: true });
    const r = w.run({ useCheck: null });
    assert.equal(r.code, 1, r.out.join('\n'));
    assert.match(r.err.join('\n'), /the review runner would refuse it: config: /);
    assert.equal(r.text, null);
  } finally { w.done(); }
});

test('L731 m3: setup.mjs main runs review-config with the runner\'s own readConfig, and passes --for-install on', () => {
  const w = world();
  try {
    // A Mac stand-in for main: the setup config, and the user records dscl would answer.
    const io = {
      euid: () => me,
      readConfig: () => JSON.stringify({ base: w.base, owner: 'joe', products: ['acme', 'beta'] }),
      run: (bin, args) => {
        const u = w.users[String(args[2]).replace('/Users/', '')];
        return u ? { status: 0, stdout: `UniqueID: ${u.uid}\nPrimaryGroupID: 20\nNFSHomeDirectory: ${u.home}\n`, stderr: '' } : { status: 56, stdout: '', stderr: '' };
      },
    };
    const inFile = join(w.base, 'out', 'input.json'); writeFileSync(inFile, JSON.stringify(w.input()));
    const outFile = join(w.base, 'out', 'main.json');
    const go = (extra = []) => { const lines = []; const code = main(['review-config', '--config', '/x/setup.json', '--pin', PIN, '--input', inFile, '--out', outFile, ...extra], { io, out: (x) => lines.push(x), err: (x) => lines.push(x) }); return { code, text: lines.join('\n') }; };
    let r = go(['--for-install']);
    assert.equal(r.code, 0, r.text);
    const c = JSON.parse(readFileSync(outFile, 'utf8'));
    assert.equal(Object.hasOwn(c, 'claudeBin') || Object.hasOwn(c, 'hooksDir'), false, '--for-install reached the command');
    rmSync(outFile);
    rmSync(join(w.base, 'review'), { recursive: true });
    r = go();
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /the review runner would refuse it: config: root: /, 'main\'s check is readConfig itself');
    assert.equal(existsSync(outFile), false);
  } finally { w.done(); }
});

test('L731 M1: --for-install builds the file a first install takes; the plain file is for add-to-install', () => {
  const w = world();
  try {
    const full = w.run(); assert.equal(full.code, 0);
    const first = w.run({ forInstall: true, outFile: join(w.base, 'out', 'first.json') });
    assert.equal(first.code, 0, first.err.join('\n'));
    assert.match(first.out.join('\n'), /checked whole, then written without claudeBin and hooksDir/);
    assert.match(first.out.join('\n'), /Then: install\. After it, run review-config again without --for-install/);
    // L783 (#291 audit m1): the dry run of the first-install file checks the whole file and prints the short one.
    const dryOut = join(w.base, 'out', 'first-dry.json');
    const dry = w.run({ forInstall: true, dry: true, outFile: dryOut });
    assert.equal(dry.code, 0, dry.err.join('\n'));
    const shown = JSON.parse(dry.out.slice(0, -1).join('\n'));
    for (const k of INSTALL_LATER) assert.equal(Object.hasOwn(shown, k), false, `the dry run shows the short file: ${k}`);
    assert.match(dry.out.at(-1), /dry run: nothing written\. .*claudeBin and hooksDir/);
    assert.equal(existsSync(dryOut), false, 'and writes nothing');
    const a = JSON.parse(full.text); const b = JSON.parse(first.text);
    assert.deepEqual(INSTALL_LATER, ['claudeBin', 'hooksDir']);
    for (const k of INSTALL_LATER) assert.equal(Object.hasOwn(b, k), false, k);
    for (const k of INSTALL_LATER) delete a[k];
    assert.deepEqual(b, a, 'every other field is the full file\'s, read back whole');
    // Install's own plan, on a fresh Mac (no copy yet), reading each file as the runner config.
    // install reads the review user's id to check the map against it (main's L726/L737): the world's review user answers.
    const dsclRead = (name) => `UniqueID: ${w.users[name].uid}\nPrimaryGroupID: 20\nUserShell: /usr/bin/false\nNFSHomeDirectory: /var/empty\nIsHidden: 1\n`;
    const io = { at: (p) => p, rootUid: 0, nodeBinProblem: () => null, run: (cmd, args) => (cmd === '/usr/bin/dscl' && args[1] === '-read' && w.users[args[2].replace('/Users/', '')] ? { status: 0, stdout: dsclRead(args[2].replace('/Users/', '')), stderr: '' } : { status: 56, stdout: '', stderr: '' }) };
    const plan = (file) => planInstall(io, { ...w.cfg, runnerConfig: file, extras: [], nodeBin: '/usr/local/bin/node', address: 'https://example.invalid/o/r.git', gitBin: '/usr/bin/git' }, { readSource: (f) => readFileSync(f, 'utf8'), runUpdater: () => ({ status: 0 }) });
    const p1 = plan(first.outFile);
    assert.deepEqual(p1.problems, [], 'install takes the --for-install file');
    assert.ok(p1.ops.length > 0, 'and plans its steps');
    const p2 = plan(full.outFile);
    assert.deepEqual(p2.problems.map((p) => /the runner config's (claudeBin|hooksDir) .* is not inside any of the extras/.exec(p)?.[1]), ['claudeBin', 'hooksDir'], 'the plain file is not for a first install');
    // The two places the plain file names are the ones add-to-install fills: one spelling each.
    assert.equal(JSON.parse(full.text).claudeBin, join(w.base, 'install/orchestrate', COPY_CLAUDE_CODE, PIN, 'claude'));
    assert.equal(pinnedBinary('/r', PIN), join('/r', COPY_CLAUDE_CODE, PIN, 'claude'), 'M4 pinnedBinary still spells the folder as layout does');
    assert.equal(JSON.parse(full.text).hooksDir, join(w.base, 'install/orchestrate', COPY_HOOKS));
  } finally { w.done(); }
});

test('L731 m4: the Record\'s folder is spelled once (layout storePath), for the folder table and the runner alike', () => {
  const w = world();
  try {
    assert.equal(JSON.parse(w.run().text).recordRoot, storePath(w.cfg, 'acme'));
    assert.ok(folderTable(w.cfg).some((r) => r.path === storePath(w.cfg, 'acme') && r.owner === 'orchestrate'));
  } finally { w.done(); }
});

test('refused as root, without the Mac users, with --out naming the installed copy\'s review.json; a dry run writes nothing', () => {
  const w = world();
  try {
    let r = w.run({ euid: 0 });
    assert.equal(r.code, 2); assert.match(r.err[0], /runs without sudo/); assert.equal(r.text, null);
    r = w.run({ outFile: join(w.base, 'install/orchestrate/review.json') });
    assert.equal(r.code, 2); assert.match(r.err[0], /not the installed copy's review.json/);
    r = w.run({ outFile: 'review.json' }); assert.equal(r.code, 2);
    delete w.users.review;
    r = w.run(); assert.equal(r.code, 1); assert.match(r.err.join('\n'), /the Mac user review .* was not found; run users-folders first/); assert.equal(r.text, null);
    w.users.review = { exists: true, uid: me, home: '/x' }; w.users.joe.home = '';
    r = w.run(); assert.equal(r.code, 1); assert.match(r.err.join('\n'), /has no home folder set/);
    w.users.joe.home = '/Users/joe';
    r = w.run({ dry: true });
    assert.equal(r.code, 0); assert.equal(r.text, null); assert.match(r.out.at(-1), /dry run: nothing written/);
    assert.equal(JSON.parse(r.out.slice(0, -1).join('\n')).pin, PIN);
  } finally { w.done(); }
});

test('setup.mjs: review-config needs --pin, --input and --out, and --input, --out and --for-install belong to it alone (--pin it shares with add-to-install)', () => {
  const o = parseArgs(['review-config', '--pin', PIN, '--input', '/a/in.json', '--out', '/a/review.json', '--dry-run']);
  assert.deepEqual([o.cmd, o.claudePin, o.input, o.out, o.dry], ['review-config', PIN, '/a/in.json', '/a/review.json', true]);
  assert.throws(() => parseArgs(['review-config', '--pin', PIN, '--input', '/a']), /review-config needs --pin/);
  assert.throws(() => parseArgs(['review-config', '--pin', 'latest', '--input', '/a', '--out', '/b']), /--pin must be a version/);
  assert.throws(() => parseArgs(['check', '--input', '/a']), /only for review-config/);
  assert.throws(() => parseArgs(['install', '--pin', PIN]), /--pin is only for review-config/);
  assert.equal(parseArgs(['review-config', '--pin', PIN, '--input', '/a', '--out', '/b', '--for-install']).forInstall, true);
  assert.throws(() => parseArgs(['install', '--for-install']), /--for-install is only for review-config/);
});

test('L995: bobManifest is named once the bob step\'s list is in the copy, and the runner\'s own check takes it', () => {
  const w = world();
  try {
    const asked = [];
    const r = w.run({ bobThere: (p) => { asked.push(p); return true; } });
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(asked, [bobManifestPath(w.cfg)], 'it looks where the bob step writes the list');
    assert.equal(w.check(r.outFile).bobManifest, join(w.base, 'install/orchestrate/bob-manifest.json'));
    assert.match(r.out.join('\n'), /Left out \(no source yet, or its step not run yet\): budget\. Until they are, launch check 12 refuses every review/);
    const none = w.run({ bobThere: () => false });
    assert.equal(none.code, 0, none.err.join('\n'));
    assert.equal(Object.hasOwn(JSON.parse(none.text), 'bobManifest'), false, 'no list named before the step has run');
    assert.match(none.out.join('\n'), /bobManifest \(run the bob step first, then this again\)\. Until they are, launch check 12 and 13 refuse every review/);
    assert.match(ownerFields(w.cfg, { ...w.input(), bobManifest: '/x' }).problems.join('\n'), /may not set bobManifest: it comes from the bob step/);
  } finally { w.done(); }
});
