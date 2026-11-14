// products-entry.test.mjs — `setup.mjs products-entry <product>` (L1199 (2), L1200): the line built from the setup
// config only, the list read as it is and only added to, main's rules read as a filter (test product, same GitHub
// id), and every read or parse failure a refusal with nothing written. GitHub is a stand-in; the list file and its
// folder are real, in a temp folder, owned by the test's own user (standing in for orchestrate's).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { blobSha, readProducts, RULES_PATH } from '../modules/M10-rules/reader.mjs';
import { entryFor, folderProblem, parseGithub, productsEntry, readProductsFile, writeProductsFile } from './products-entry.mjs';
import { parseArgs } from './setup.mjs';

const P = ENTRY.product;
const ME = process.getuid();          // orchestrate in these tests: the list's folder and file are the test's own
const COMMIT = 'c'.repeat(40);
const swap = (t, a, b) => { assert.equal(t.split(a).length, 2, `one ${a}`); return t.replace(a, b); };
const TEST_RULES = swap(FIRST, 'product:\n  cutover_stage: first\n', 'product:\n  cutover_stage: first\n  test_product: true\n');
const GITHUB = { ownerId: ENTRY.joe_github_id, repos: { [P]: `${ENTRY.owner}/${ENTRY.repo}` } };
const OTHER = { product: 'other-app', owner: 'o', repo: 'other-app', joe_github_id: 5 };

const userText = (uid) => `UniqueID: ${uid}\nPrimaryGroupID: 20\nUserShell: /bin/zsh\nNFSHomeDirectory: /Users/x\n`;
function ioOf({ euid = 0, users = { orchestrate: ME } } = {}) {
  return {
    rootUid: 0, euid: () => euid, at: (p) => p,
    run: (cmd, args) => {
      const name = /^\/Users\/(.+)$/.exec(args[2] ?? '')?.[1];
      return name in users ? { status: 0, stdout: userText(users[name]), stderr: '' } : { status: 56, stdout: '', stderr: '' };
    },
  };
}
const contents = (text) => { const buf = Buffer.from(text); return { type: 'file', path: RULES_PATH, sha: blobSha(buf), encoding: 'base64', size: buf.length, content: buf.toString('base64') }; };

/** A world: a real private folder for the list, a GitHub stand-in, the setup config. */
function world(opts = {}) {
  const { text = TEST_RULES, list, cfgOver = {}, ghOver } = opts;
  const github = 'github' in opts ? opts.github : GITHUB;   // undefined given means no entry at all
  const dir = tempDir('orch-products-');
  const priv = join(dir, 'private');
  mkdirSync(priv, { mode: 0o700 }); chmodSync(priv, 0o700);
  const file = join(priv, 'products.json');
  if (list !== undefined) writeFileSync(file, typeof list === 'string' ? list : JSON.stringify(list), { mode: 0o644 });
  const tokenFile = join(dir, 'keys', 'read-token');
  const cfg = { owner: 'joe', products: [P, 'other-app'], dispatcher: { product: P, productsFile: file, tokenFile, rulesStateDir: join(priv, 'rules-state'), approvalsStateDir: join(priv, 'ap') }, ...cfgOver };
  const gh = { calls: [], tokens: [] };
  gh.get = async (path) => {
    gh.calls.push(path);
    if (ghOver) return ghOver(path);
    if (path === `/repos/${ENTRY.owner}/${ENTRY.repo}/git/ref/heads/main`) return { status: 200, json: { object: { sha: COMMIT } } };
    if (path === `/repos/${ENTRY.owner}/${ENTRY.repo}/contents/${RULES_PATH}?ref=${COMMIT}`) return { status: 200, json: contents(text) };
    return { status: 404, json: null };
  };
  const ports = {
    gh: (path, uid) => { gh.tokens.push([path, uid]); return gh; },
    folderProblem: (d, uids) => folderProblem(d, { uids }),
    readList: (f, uids) => readProductsFile(f, { uids }),
    writeList: (f, t) => writeProductsFile(f, t, { uid: ME, gid: process.getgid() }),
    readBack: (f) => readProducts(f),
  };
  const out = []; const err = [];
  const run = (o = {}) => productsEntry({ io: ioOf(o.io), cfg, githubRaw: github, product: o.product ?? P, dry: o.dry ?? false, ports, out: (l) => out.push(l), err: (l) => err.push(l) });
  const listText = () => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  return { dir, priv, file, tokenFile, cfg, gh, ports, out, err, run, listText, blob: blobSha(Buffer.from(text)) };
}

test('root adds the test product\'s line from the setup config: main\'s commit and blob shown, the reader reads it back', async () => {
  const w = world();
  assert.equal(await w.run(), 0, w.err.join('\n'));
  assert.deepEqual(readProducts(w.file), [ENTRY]);
  assert.equal(w.listText(), `${JSON.stringify([ENTRY], null, 2)}\n`);
  assert.equal(statSync(w.file).mode & 0o777, 0o644);
  const shown = w.out.join('\n');
  assert.match(shown, new RegExp(`main {9}commit ${COMMIT}`));
  assert.match(shown, new RegExp(`blob ${w.blob}`));
  assert.match(shown, /a filter only: nothing is approved/);
  // L1200 (c): the read uses the token the Dispatcher entry names, as orchestrate's file.
  assert.deepEqual(w.gh.tokens, [[w.tokenFile, ME]]);
  // Only reads: the branch and the rules file at that commit.
  assert.deepEqual(w.gh.calls, [`/repos/${ENTRY.owner}/${ENTRY.repo}/git/ref/heads/main`, `/repos/${ENTRY.owner}/${ENTRY.repo}/contents/${RULES_PATH}?ref=${COMMIT}`]);
});

test('another product\'s line is kept as it is, and this one is added at the end', async () => {
  const w = world({ list: [OTHER] });
  assert.equal(await w.run(), 0, w.err.join('\n'));
  assert.deepEqual(readProducts(w.file), [OTHER, ENTRY]);
});

test('the line already there, the same: nothing written; different: refused, nothing written (it only adds)', async () => {
  const text = JSON.stringify([ENTRY]);
  const w = world({ list: text });
  assert.equal(await w.run(), 0, w.err.join('\n'));
  assert.equal(w.listText(), text);
  assert.match(w.out.join('\n'), /already listed/);
  for (const changed of [{ ...ENTRY, joe_github_id: 7 }, { ...ENTRY, owner: 'elsewhere' }, { ...ENTRY, repo: 'elsewhere' }]) {
    const t = JSON.stringify([changed]);
    const v = world({ list: t });
    assert.equal(await v.run(), 1);
    assert.match(v.err.join('\n'), /only adds a line; it never changes one/);
    assert.equal(v.listText(), t);
  }
});

test('--dry-run: everything read and checked, nothing written', async () => {
  const w = world();
  assert.equal(await w.run({ dry: true }), 0, w.err.join('\n'));
  assert.equal(w.listText(), null);
  assert.match(w.out.join('\n'), /dry run: nothing written/);
  assert.equal(w.gh.calls.length, 2);
});

test('the test product only (#537\'s refusal): test_product missing, false or not a flag is refused, nothing written', async () => {
  for (const [rules, why] of [
    [FIRST, /do not say product\.test_product: true \(it is null\)/],
    [swap(FIRST, 'product:\n  cutover_stage: first\n', 'product:\n  cutover_stage: first\n  test_product: false\n'), /do not say product\.test_product: true/],
    [swap(FIRST, 'product:\n  cutover_stage: first\n', 'product:\n  cutover_stage: first\n  test_product: "yes"\n'), /can't be parsed/],
  ]) {
    const w = world({ text: rules });
    assert.equal(await w.run(), 1, rules.slice(0, 40));
    assert.match(w.err.join('\n'), why);
    assert.equal(w.listText(), null);
  }
});

test('the rules\' owner GitHub id must be the setup config\'s; a repo can\'t name its own trust root', async () => {
  const w = world({ github: { ...GITHUB, ownerId: ENTRY.joe_github_id + 1 } });
  assert.equal(await w.run(), 1);
  assert.match(w.err.join('\n'), /name the owner's GitHub id 1000001, but the setup config's github\.ownerId is 1000002/);
  assert.equal(w.listText(), null);
});

test('L1200 (d): any read or parse that fails refuses, with nothing written', async () => {
  const cases = [
    [(p) => (p.endsWith('/heads/main') ? { status: 404, json: null } : { status: 200, json: null }), /branch read answered 404/],
    [(p) => (p.endsWith('/heads/main') ? { status: 200, json: { object: { sha: 'nope' } } } : null), /gave no commit/],
    [(p) => (p.endsWith('/heads/main') ? { status: 200, json: { object: { sha: COMMIT } } } : { status: 404, json: null }), /no .* on main/],
    [(p) => (p.endsWith('/heads/main') ? { status: 200, json: { object: { sha: COMMIT } } } : { status: 200, json: { ...contents(TEST_RULES), sha: 'd'.repeat(40) } }), /can't be used/],
    [() => { throw new Error('the watch-only token file could not be opened'); }, /token file could not be opened/],
  ];
  for (const [ghOver, why] of cases) {
    const w = world({ ghOver });
    assert.equal(await w.run(), 1);
    assert.match(w.err.join('\n'), /GitHub main can't be read/);
    assert.match(w.err.join('\n'), why);
    assert.equal(w.listText(), null);
  }
  const bad = world({ text: 'product: [unclosed' });
  assert.equal(await bad.run(), 1);
  assert.match(bad.err.join('\n'), /can't be parsed/);
  assert.equal(bad.listText(), null);
});

test('refused before reading anything: not root, no orchestrate, no dispatcher entry, a product or repo the config does not give', async () => {
  const cases = [
    [{ io: { euid: ME + 3 } }, {}, /root's file: run this with sudo/],
    [{ io: { users: {} } }, {}, /has not made the orchestrate user/],
    [{}, { cfgOver: { dispatcher: undefined } }, /dispatcher/],
    [{ product: 'third-app' }, {}, /third-app is not one of the setup config's products/],
    [{ product: 'other-app' }, {}, /github\.repos has no repository for other-app/],
    [{}, { github: undefined }, /there is no "github" entry/],
  ];
  for (const [o, wo, why] of cases) {
    const w = world(wo);
    assert.equal(await w.run(o), 2, String(why));
    assert.match(w.err.join('\n'), why);
    assert.equal(w.gh.calls.length, 0);
    assert.equal(w.listText(), null);
  }
});

test('parseGithub: ownerId a whole number, repos only the config\'s products, each owner/name, no other keys', () => {
  const cfg = { products: [P] };
  assert.deepEqual(parseGithub(GITHUB, cfg), GITHUB);
  for (const [raw, why] of [
    [null, /must be an object/], [[], /must be an object/],
    [{ ...GITHUB, extra: 1 }, /keys it does not take: "extra"/],
    [{ ...GITHUB, ownerId: '1000001' }, /ownerId must be/], [{ ...GITHUB, ownerId: 0 }, /ownerId must be/], [{ ...GITHUB, ownerId: 1.5 }, /ownerId must be/],
    [{ ...GITHUB, repos: [] }, /repos must be an object/],
    [{ ...GITHUB, repos: { [P]: 'no-slash' } }, /must look like owner\/name/],
    [{ ...GITHUB, repos: { [P]: 'a/../b' } }, /must look like owner\/name/],
    [{ ...GITHUB, repos: { 'not-mine': 'a/b' } }, /not one of the config's products/],
  ]) assert.throws(() => parseGithub(raw, cfg), why);
  assert.deepEqual(entryFor({ products: [P] }, GITHUB, P), ENTRY);
});

test('the list as it is must be one the reader takes, a plain file of root\'s or orchestrate\'s, one name, no one else writing', async () => {
  const cases = [
    ['not json', (w) => writeFileSync(w.file, '{'), /not valid JSON/],
    ['not a list', (w) => writeFileSync(w.file, '{}'), /must be a list/],
    ['a bad line', (w) => writeFileSync(w.file, JSON.stringify([{ product: P }])), /needs product, owner, repo/],
    ['others write it', (w) => { writeFileSync(w.file, '[]'); chmodSync(w.file, 0o664); }, /can be written by others than root or orchestrate/],
    ['a link', (w) => { writeFileSync(join(w.dir, 'real.json'), '[]'); symlinkSync(join(w.dir, 'real.json'), w.file); }, /link/],
    ['two names', (w) => { writeFileSync(w.file, '[]'); linkSync(w.file, join(w.dir, 'second.json')); }, /another name/],
    ['a folder', (w) => mkdirSync(w.file), /not a plain file/],
  ];
  for (const [name, plant, why] of cases) {
    const w = world();
    plant(w);
    const before = existsSync(w.file) && statSync(w.file).isFile() ? readFileSync(w.file, 'utf8') : null;
    assert.equal(await w.run(), 1, name);
    assert.match(w.err.join('\n'), why, name);
    assert.equal(w.gh.calls.length, 0, name);
    if (before !== null) assert.equal(readFileSync(w.file, 'utf8'), before, name);
  }
  // Someone else's file: not root's, not orchestrate's.
  const w = world({ list: '[]' });
  assert.equal(await w.run({ io: { users: { orchestrate: ME + 9 } } }), 2);   // the folder is refused first: it is not orchestrate's either
  assert.match(w.err.join('\n'), new RegExp(`belongs to uid ${ME}, not to root or orchestrate`));
});

test('the list\'s folder: a link, or one others can write, is refused before anything is read', async () => {
  const w = world();
  chmodSync(w.priv, 0o770);
  assert.equal(await w.run(), 2);
  assert.match(w.err.join('\n'), /open to writes by others than root or orchestrate/);
  const v = world();
  const real = join(v.dir, 'real-private'); mkdirSync(real, { mode: 0o700 });
  v.cfg.dispatcher.productsFile = join(v.dir, 'linked', 'products.json');
  symlinkSync(real, join(v.dir, 'linked'));
  assert.equal(await v.run(), 2);
  assert.match(v.err.join('\n'), /not a plain folder/);
  assert.equal(v.gh.calls.length, 0);
});

test('the list changing while this reads is refused; a write the reader can\'t read back is a FAIL', async () => {
  const w = world({ list: '[]' });
  const read = w.ports.readList; let n = 0;
  w.ports.readList = (f, u) => { n += 1; if (n === 2) writeFileSync(w.file, JSON.stringify([OTHER])); return read(f, u); };
  assert.equal(await w.run(), 1);
  assert.match(w.err.join('\n'), /changed while this was reading/);
  assert.deepEqual(readProducts(w.file), [OTHER]);

  const v = world();
  v.ports.readBack = () => [OTHER];
  assert.equal(await v.run(), 1);
  assert.match(v.err.join('\n'), /FAIL .* does not find this line/);
  const u = world();
  u.ports.readBack = () => { throw new Error('boom'); };
  assert.equal(await u.run(), 1);
  assert.match(u.err.join('\n'), /FAIL .* the reader can't read it \(boom\)/);
});

test('setup.mjs: products-entry takes the product first, --dry-run, and no --config or --root-prefix', () => {
  assert.deepEqual([parseArgs(['products-entry', P]).product, parseArgs(['products-entry', P, '--dry-run']).dry], [P, true]);
  assert.throws(() => parseArgs(['products-entry']), /needs the product's name first: products-entry <product>/);
  assert.throws(() => parseArgs(['products-entry', 'Bad_Name']), /needs the product's name first/);
  assert.throws(() => parseArgs(['products-entry', P, '--config', '/x.json']), /products-entry reads only root's setup config/);
  assert.throws(() => parseArgs(['products-entry', P, '--root-prefix', '/x']), /products-entry reads only root's setup config/);
  assert.throws(() => parseArgs(['products-entry', P, '--main', 'a'.repeat(40)]), /--main is only for check-install/);
});

test('a list file of anyone but root or orchestrate is refused, in approve-rules\' own words for the owners named', () => {
  const dir = tempDir('orch-products-own-');
  const f = join(dir, 'products.json'); writeFileSync(f, '[]', { mode: 0o644 });
  assert.deepEqual(readProductsFile(f, { uids: [0, ME] }), { text: '[]' });
  assert.throws(() => readProductsFile(f, { uids: [0, ME + 9] }), new RegExp(`belongs to uid ${ME}, not to root or orchestrate`));
  assert.deepEqual(readProductsFile(join(dir, 'none.json'), { uids: [0, ME] }), { text: null });
});
