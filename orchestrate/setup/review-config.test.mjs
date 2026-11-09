// review-config (L709): the review runner's review.json, each field from one source, read back with the runner's own readConfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { join } from 'node:path';
import { OWNER_INPUT, SOURCES, buildReviewConfig, ownerFields, pinFields, reviewConfigCommand, setupFields } from './review-config.mjs';
import { CONFIG_FIELDS, readConfig } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { TOOLS_CHECKED } from '../modules/M10-rules/roles.mjs';
import { REVIEW_ROLES } from '../shared/review-roles.mjs';
import { parseConfig } from './layout.mjs';
import { parseArgs } from './setup.mjs';

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
  const run = ({ pin = PIN, give = input(), dry = false, euid = me, outFile = join(base, 'out', 'review.json') } = {}) => {
    const inFile = join(base, 'out', 'input.json'); writeFileSync(inFile, typeof give === 'string' ? give : JSON.stringify(give));
    const lines = { out: [], err: [] };
    const code = reviewConfigCommand(cfg, { pin, input: inFile, out: outFile, dry }, { euid, userOf, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s), check });
    return { code, ...lines, outFile, text: existsSync(outFile) ? readFileSync(outFile, 'utf8') : null };
  };
  return { top, base, cfg, users, userOf, check, input, run, done: () => rmSync(top, { recursive: true, force: true }) };
}

test('every field the runner reads has exactly one source, and the built file holds exactly the fields with one', () => {
  const w = world();
  try {
    assert.deepEqual(Object.keys(SOURCES).sort(), [...CONFIG_FIELDS].sort(), 'SOURCES names every field readConfig reads, and no other');
    for (const [k, s] of Object.entries(SOURCES)) assert.ok(['setup', 'pin', 'owner', 'later'].includes(s), `${k}: ${s}`);
    const s = setupFields(w.cfg, { pin: PIN, userOf: w.userOf }).fields;
    const o = ownerFields(w.cfg, w.input()).fields;
    const p = pinFields(w.cfg, PIN);
    const all = [...Object.keys(s), ...Object.keys(o), ...Object.keys(p)];
    assert.equal(new Set(all).size, all.length, 'no field comes from two sources');
    for (const [src, part] of [['setup', s], ['owner', o], ['pin', p]]) assert.deepEqual(Object.keys(part).sort(), Object.keys(SOURCES).filter((k) => SOURCES[k] === src).sort(), `${src} gives exactly its fields`);
    const { config } = buildReviewConfig(w.cfg, { pin: PIN, input: w.input(), userOf: w.userOf });
    assert.deepEqual(Object.keys(config).sort(), CONFIG_FIELDS.filter((k) => SOURCES[k] !== 'later').sort());
    assert.deepEqual(OWNER_INPUT.filter((k) => k !== 'product').sort(), Object.keys(SOURCES).filter((k) => SOURCES[k] === 'owner' && k !== 'recordRoot').sort(), 'the input keys are the owner fields (product stands for recordRoot)');
  } finally { w.done(); }
});

test('the file written is the one the runner\'s own readConfig takes, with setup\'s values, the pin\'s and the owner\'s', () => {
  const w = world();
  try {
    const r = w.run();
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.out.join('\n'), /the review runner's own check takes it/);
    assert.match(r.out.join('\n'), /Left out \(no source yet\): budget, bobManifest/);
    const c = w.check(r.outFile);
    assert.deepEqual(JSON.parse(r.text), JSON.parse(JSON.stringify(c)));
    const B = w.base;
    assert.equal(c.installRoot, join(B, 'install/orchestrate'));
    assert.equal(c.claudeBin, join(B, 'install/orchestrate/claude-code', PIN, 'claude'), 'where add-to-install puts the program');
    assert.equal(c.hooksDir, join(B, 'install/orchestrate/hooks'));
    assert.equal(c.wiring, join(B, 'install/orchestrate/modules/M4-workshop/launcher/review-wiring.mjs'));
    assert.equal(c.root, join(B, 'review'));
    assert.equal(c.snapshot, join(B, 'review/rules-snapshot.json'));
    assert.equal(c.outboxRoot, join(B, 'outboxes'));
    assert.equal(c.recordRoot, join(B, 'products/acme/store'));
    assert.equal(c.recordUid, me + 2);
    assert.equal(c.ownerUid, OWNER_UID); assert.equal(c.ownerHome, '/Users/joe');
    assert.deepEqual(c.deny, [join(B, 'keys'), join(B, 'private'), '/Users/joe']);
    assert.equal(c.pin, PIN);
    assert.deepEqual(Object.keys(c.uids).sort(), Object.keys(DESIGN_PROFILES).sort());
    for (const [role, uid] of Object.entries(c.uids)) assert.equal(uid, REVIEW_ROLES.includes(role) ? me : OWNER_UID, role);
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
      ['a rules list that is not a list', (i) => { i.rules.production.hosts = 'api'; }, /rules\.production\.hosts must be a list/],
      ['an unknown rules part', (i) => { i.rules.extra = {}; }, /rules hold "extra"/],
      ['an unknown rules list', (i) => { i.rules.secrets.more = []; }, /rules\.secrets holds "more"/],
    ];
    for (const [name, f, why] of bad) { const give = w.input(); f(give); const r = w.run({ give }); assert.equal(r.code, 1, name); assert.ok(r.err.some((l) => why.test(l)), `${name}: ${r.err.join(' | ')}`); }
    for (const give of ['[1]', 'null', '"x"', '{not json']) { const r = w.run({ give }); assert.equal(r.code, 1, give); assert.equal(r.text, null); assert.ok(!r.err.join('\n').includes('not json'), 'never quotes the file'); }
  } finally { w.done(); }
});

test('m-5: a pin other than the one the tool lists were checked on is refused by the runner\'s check, and the file is removed', () => {
  const w = world();
  try {
    const r = w.run({ pin: '2.1.999' });
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), new RegExp(`pin is 2\\.1\\.999, but the role tool lists were checked on Claude Code ${PIN.replaceAll('.', '\\.')}`));
    assert.match(r.err.join('\n'), /was removed; nothing is left to install/);
    assert.equal(r.text, null);
    assert.deepEqual(readdirSync(join(w.base, 'out')).filter((n) => n !== 'input.json'), [], 'no temporary file left');
    // readConfig itself, at daemon start: the same file with the checked pin passes, a moved pin does not.
    const ok = w.run(); assert.equal(ok.code, 0);
    const c = JSON.parse(ok.text); c.pin = '2.1.317'; writeFileSync(ok.outFile, JSON.stringify(c), { mode: 0o644 });
    assert.throws(() => w.check(ok.outFile), /config: pin is 2\.1\.317, but the role tool lists were checked/);
  } finally { w.done(); }
});

test('a wall the runner would refuse removes the file too: the review folder missing', () => {
  const w = world();
  try {
    rmSync(join(w.base, 'review'), { recursive: true });
    const r = w.run();
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /the review runner would refuse it: config: root: .* is missing/);
    assert.equal(r.text, null);
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

test('setup.mjs: review-config needs --pin, --input and --out, and those flags belong to it alone', () => {
  const o = parseArgs(['review-config', '--pin', PIN, '--input', '/a/in.json', '--out', '/a/review.json', '--dry-run']);
  assert.deepEqual([o.cmd, o.claudePin, o.input, o.out, o.dry], ['review-config', PIN, '/a/in.json', '/a/review.json', true]);
  assert.throws(() => parseArgs(['review-config', '--pin', PIN, '--input', '/a']), /review-config needs --pin/);
  assert.throws(() => parseArgs(['review-config', '--pin', 'latest', '--input', '/a', '--out', '/b']), /--pin must be a version/);
  assert.throws(() => parseArgs(['check', '--input', '/a']), /only for review-config/);
  assert.throws(() => parseArgs(['install', '--pin', PIN]), /--pin is only for review-config/);
});
