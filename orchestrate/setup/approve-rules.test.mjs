// approve-rules.test.mjs — `setup.mjs approve-rules <product>` (L1127 c): who may run it, what it reads, what it shows,
// the typed yes, main moving, the list forward only, and the reader's own check afterwards. GitHub is a stand-in; the
// list file, its folder and the reader's verifier are the real ones, in a temp folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { blobSha, allowListVerifier, RULES_PATH } from '../modules/M10-rules/reader.mjs';
import { reviewConfig } from '../wiring/review-ports.test-helper.mjs';
import { APPROVED_FILE, approveRules, mainRules, parseList, readListFile, writeListFile } from './approve-rules.mjs';
import { main as setupMain, parseArgs } from './setup.mjs';

const P = ENTRY.product;
const ME = process.getuid();          // the Dispatcher's user (orchestrate) in these tests
const OWNER = ME + 7;                 // the owner's Mac user id
const COMMIT = 'a'.repeat(40);

const userText = (uid) => `UniqueID: ${uid}\nPrimaryGroupID: 20\nUserShell: /bin/zsh\nNFSHomeDirectory: /Users/x\n`;
function ioOf({ euid = ME, users = { orchestrate: ME, joe: OWNER } } = {}) {
  return {
    rootUid: 0,
    euid: () => euid,
    run: (cmd, args) => {
      const name = /^\/Users\/(.+)$/.exec(args[2] ?? '')?.[1];
      return name in users ? { status: 0, stdout: userText(users[name]), stderr: '' } : { status: 56, stdout: '', stderr: '' };
    },
  };
}
const CFG = { owner: 'joe' };
const contents = (text) => { const buf = Buffer.from(text); return { type: 'file', path: RULES_PATH, sha: blobSha(buf), encoding: 'base64', size: buf.length, content: buf.toString('base64') }; };

/** A world: the config, a real rules-state folder, a GitHub stand-in whose main can move, and what was typed. */
function world({ text = FIRST, typed = P, list, lastGood, config = {} } = {}) {
  const dir = tempDir('orch-approve-');
  const rulesStateDir = join(dir, 'rules-state');
  mkdirSync(rulesStateDir, { mode: 0o700 });
  chmodSync(rulesStateDir, 0o700);
  const file = join(rulesStateDir, APPROVED_FILE);
  if (list !== undefined) writeFileSync(file, typeof list === 'string' ? list : JSON.stringify(list), { mode: 0o600 });
  if (lastGood !== undefined) writeFileSync(join(rulesStateDir, `${P}.last-good.json`), JSON.stringify({ text: 'x', commit: COMMIT, blob: lastGood }), { mode: 0o600 });
  const gh = { main: { commit: COMMIT, text }, calls: [], afterFirst: null };
  gh.get = async (path) => {
    gh.calls.push(path);
    if (path === `/repos/${ENTRY.owner}/${ENTRY.repo}/git/ref/heads/main`) {
      const reads = gh.calls.filter((c) => c.endsWith('/heads/main')).length;
      if (reads === 2 && gh.afterFirst) Object.assign(gh.main, gh.afterFirst);
      return { status: 200, json: { object: { sha: gh.main.commit } } };
    }
    if (path === `/repos/${ENTRY.owner}/${ENTRY.repo}/contents/${RULES_PATH}?ref=${gh.main.commit}`) return { status: 200, json: contents(gh.main.text) };
    return { status: 404, json: null };
  };
  const asked = [];
  const ports = {
    dispatcherConfig: () => ({ installRoot: join(dir, 'copy'), wiring: join(dir, 'copy/w.mjs'), lockFile: join(dir, 'l'), product: P, recordRoot: join(dir, 'rec'), ownerUid: ME,
      productsFile: join(dir, 'products.json'), rulesStateDir, tokenFile: join(dir, 'token'), approvalsStateDir: join(dir, 'ap'), ...reviewConfig(dir, { reviewUid: ME + 1 }), ...config }),
    products: () => [ENTRY],
    gh: () => gh,
    folder: (path, uid) => { if (uid !== ME) throw new Error('wrong uid'); return path; },
    readList: readListFile,
    writeList: writeListFile,
    lastGood: (d, product) => { const f = join(d, `${product}.last-good.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).blob : null; },
    verify: allowListVerifier,
    ask: (prompt) => { asked.push(prompt); if (typed instanceof Error) throw typed; return typed; },
  };
  const out = []; const err = [];
  const run = (o = {}) => approveRules({ io: ioOf(o.io), cfg: CFG, product: o.product ?? P, dry: o.dry ?? false, env: o.env ?? { SUDO_UID: String(OWNER) }, ports, out: (l) => out.push(l), err: (l) => err.push(l) });
  const listNow = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  return { dir, rulesStateDir, file, gh, ports, asked, out, err, run, listNow, blob: blobSha(Buffer.from(text)) };
}

test('the owner, through sudo as orchestrate, approves main\'s version: shown, typed, appended, and the reader\'s check approves it', async () => {
  const w = world();
  assert.equal(await w.run(), 0, w.err.join('\n'));
  assert.deepEqual(w.listNow(), { [P]: [w.blob] });
  assert.equal(allowListVerifier(w.file)({ product: P, blob: w.blob, lastGoodBlob: null }), true);
  const shown = w.out.join('\n');
  assert.match(shown, new RegExp(`main {9}commit ${COMMIT}`));
  assert.match(shown, new RegExp(`blob ${w.blob}`));
  assert.match(shown, /it parses/);
  assert.match(shown, new RegExp(`--- the first 25 lines of main's ${RULES_PATH} ---`));
  assert.ok(w.out.includes(`  ${FIRST.split('\n')[0]}`), 'the file\'s top lines are shown');
  assert.match(w.asked[0], new RegExp(`type the product's name \\(${P}\\)`));
  assert.match(w.out.at(-1), /^approved: /);
  assert.equal(readdirSync(w.rulesStateDir).filter((n) => n.endsWith('.new')).length, 0, 'no temp file left');
});

test('forward only: the new blob goes on the end of the product\'s list; other products and earlier entries are kept', async () => {
  const old = 'b'.repeat(40);
  const w = world({ list: { [P]: [old], other: ['c'.repeat(40)] }, lastGood: old });
  assert.equal(await w.run(), 0, w.err.join('\n'));
  assert.deepEqual(w.listNow(), { [P]: [old, w.blob], other: ['c'.repeat(40)] });
  assert.equal(allowListVerifier(w.file)({ product: P, blob: w.blob, lastGoodBlob: old }), true, 'the reader moves forward to it');
});

test('the read-back: a write the reader\'s own check doesn\'t approve, or a check that throws, is a FAIL (exit 1), never "approved"', async () => {
  for (const verify of [() => () => false, () => () => { throw new Error('boom'); }]) {
    const w = world();
    w.ports.verify = verify;
    assert.equal(await w.run(), 1);
    assert.match(w.err.at(-1), /^FAIL {2}.* does not approve /);
    assert.ok(!w.out.some((l) => l.startsWith('approved:')));
  }
});

test('already last on the list: nothing asked, nothing written, exit 0', async () => {
  const w0 = world();
  const w = world({ list: { [P]: ['b'.repeat(40), w0.blob] } });
  const before = readFileSync(w.file, 'utf8');
  assert.equal(await w.run(), 0);
  assert.equal(w.asked.length, 0);
  assert.equal(readFileSync(w.file, 'utf8'), before);
  assert.match(w.out.at(-1), /already approved/);
});

test('a version approved before and later replaced is shown as going back, and still needs the yes', async () => {
  const w0 = world();
  const later = 'b'.repeat(40);
  const w = world({ list: { [P]: [w0.blob, later] }, lastGood: later });
  assert.equal(await w.run(), 0, w.err.join('\n'));
  assert.ok(w.out.some((l) => /approved before and later replaced/.test(l)));
  assert.equal(w.asked.length, 1);
  assert.deepEqual(w.listNow()[P], [w0.blob, later, w0.blob]);
});

test('who: not orchestrate, root, no sudo, sudo by someone other than the owner, or an owner that is orchestrate: refused before any read', async () => {
  const cases = [
    [{ io: { euid: OWNER } }, /run this as orchestrate/],
    [{ io: { euid: 0 } }, /run this as orchestrate/],
    [{ env: {} }, /SUDO_UID is not set/],
    [{ env: { SUDO_UID: String(OWNER + 1) } }, /SUDO_UID is another user/],
    [{ env: { SUDO_UID: String(ME) } }, /SUDO_UID is another user/],
    [{ io: { users: { orchestrate: ME } } }, /joe is not a user/],
    [{ io: { users: { joe: OWNER } } }, /orchestrate is not a user/],
    [{ io: { users: { orchestrate: ME, joe: ME } }, env: { SUDO_UID: String(ME) } }, /can't be orchestrate or root/],
    [{ io: { users: { orchestrate: ME, joe: 0 } }, env: { SUDO_UID: '0' } }, /can't be orchestrate or root/],
  ];
  for (const [o, re] of cases) {
    const w = world();
    assert.equal(await w.run(o), 2, JSON.stringify(o));
    assert.match(w.err.join('\n'), re, JSON.stringify(o));
    assert.equal(w.gh.calls.length, 0, 'GitHub not read');
    assert.equal(w.asked.length, 0);
    assert.equal(existsSync(w.file), false);
  }
});

test('which: a Dispatcher config for another product, a product products.json lacks, or a bad config: refused before GitHub', async () => {
  for (const [o, re] of [[{ product: 'other-app' }, /config is for sample-app, not other-app/]]) {
    const w = world();
    assert.equal(await w.run(o), 2);
    assert.match(w.err.join('\n'), re);
    assert.equal(w.gh.calls.length, 0);
  }
  const w = world();
  w.ports.products = () => [{ ...ENTRY, product: 'x' }];
  assert.equal(await w.run(), 2);
  assert.match(w.err.join('\n'), /does not list sample-app/);
  const w2 = world({ config: { tokenFile: 'relative' } });
  assert.equal(await w2.run(), 2);
  assert.match(w2.err.join('\n'), /tokenFile must be an absolute path/);
  assert.equal(w2.gh.calls.length, 0);
});

test('the typed yes: anything but the product\'s exact name, or no terminal, writes nothing', async () => {
  for (const typed of ['', `${P} `, P.toUpperCase(), 'yes', Object.assign(new Error('there is no terminal to type the answer into; run this in the Terminal app'))]) {
    const w = world({ typed });
    assert.equal(await w.run(), 1, String(typed));
    assert.equal(existsSync(w.file), false, String(typed));
    assert.match(w.err.join('\n'), typed instanceof Error ? /no terminal/ : /not approved/);
  }
});

test('--dry-run shows everything and asks nothing, writes nothing', async () => {
  const w = world();
  assert.equal(await w.run({ dry: true }), 0);
  assert.equal(w.asked.length, 0);
  assert.equal(existsSync(w.file), false);
  assert.match(w.out.at(-1), /dry run: nothing asked, nothing written/);
});

test('main moved between the look and the yes (a new commit, or a new blob at the same commit): refused, nothing written', async () => {
  for (const after of [{ commit: 'd'.repeat(40) }, { commit: 'd'.repeat(40), text: `${FIRST}# more\n` }]) {
    const w = world();
    w.gh.afterFirst = after;
    assert.equal(await w.run(), 1);
    assert.match(w.err.join('\n'), /main moved while you were reading/);
    assert.equal(existsSync(w.file), false);
  }
});

test('the list changed between the look and the write: refused, the other change kept', async () => {
  const w = world({ list: { [P]: [] } });
  const someone = JSON.stringify({ [P]: ['e'.repeat(40)] });
  w.ports.ask = () => { writeFileSync(w.file, someone); return P; };
  assert.equal(await w.run(), 1);
  assert.match(w.err.join('\n'), /approval list changed while you were reading/);
  assert.equal(readFileSync(w.file, 'utf8'), someone);
});

test('rules on main that don\'t parse, or a contents answer that doesn\'t hash to its blob, are refused before the yes', async () => {
  const w = world({ text: 'this: [is not\n' });
  assert.equal(await w.run(), 1);
  assert.match(w.err.join('\n'), /don't parse/);
  assert.equal(w.asked.length, 0);
  const w2 = world();
  const real = w2.gh.get;
  w2.gh.get = async (p) => { const r = await real(p); if (p.includes('/contents/')) r.json = { ...r.json, sha: 'f'.repeat(40) }; return r; };
  assert.equal(await w2.run(), 1);
  assert.match(w2.err.join('\n'), /contents do not match the named version/);
  assert.equal(w2.asked.length, 0);
});

test('mainRules: no branch, no file, or no commit is a throw naming it', async () => {
  const gh = (answers) => ({ get: async (p) => answers.find(([re]) => re.test(p))?.[1] ?? { status: 404 } });
  await assert.rejects(mainRules(gh([]), ENTRY), /main branch read answered 404/);
  await assert.rejects(mainRules(gh([[/heads/, { status: 200, json: { object: {} } }]]), ENTRY), /gave no commit/);
  await assert.rejects(mainRules(gh([[/heads/, { status: 200, json: { object: { sha: COMMIT } } }]]), ENTRY), /no orchestrate\/policy\.yaml on main/);
});

test('a version the reader holds that the list does not name: refused (the reader could never move forward from it)', async () => {
  const w = world({ list: { [P]: ['b'.repeat(40)] }, lastGood: 'c'.repeat(40) });
  assert.equal(await w.run(), 1);
  assert.match(w.err.join('\n'), /not on the list, so the reader can't move forward/);
  assert.equal(w.asked.length, 0);
});

test('a list that can\'t be trusted is never written over: not JSON, not lists of blobs, a link, a hard link, writable by others', async () => {
  for (const bad of ['{', '[]', JSON.stringify({ [P]: 'x' }), JSON.stringify({ [P]: ['short'] })]) {
    const w = world({ list: bad });
    assert.equal(await w.run(), 1, bad);
    assert.match(w.err.join('\n'), /approval list can't be used/);
    assert.equal(readFileSync(w.file, 'utf8'), bad);
  }
  const w = world();
  writeFileSync(join(w.dir, 'elsewhere.json'), '{}', { mode: 0o600 });
  symlinkSync(join(w.dir, 'elsewhere.json'), w.file);
  assert.equal(await w.run(), 1);
  assert.match(w.err.join('\n'), /is a link/);
  const h = world({ list: {} });
  linkSync(h.file, join(h.dir, 'other-name.json'));
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /another name/);
  const g = world({ list: {} });
  chmodSync(g.file, 0o622);
  assert.equal(await g.run(), 1);
  assert.match(g.err.join('\n'), /can be written by others/);
});

test('parseList and writeListFile: lists of 40-hex blobs only; the written file is 0600 and replaces the old by rename', () => {
  assert.deepEqual(parseList('{"a":["' + 'a'.repeat(40) + '"]}'), { a: ['a'.repeat(40)] });
  assert.throws(() => parseList('null'), /not an object/);
  const d = tempDir('orch-approve-');
  const f = join(d, APPROVED_FILE);
  writeListFile(f, '{}\n');
  writeListFile(f, '{"x":[]}\n');
  assert.equal(readFileSync(f, 'utf8'), '{"x":[]}\n');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readListFile(f, { uid: ME }).text, '{"x":[]}\n');
  assert.deepEqual(readListFile(join(d, 'none.json'), { uid: ME }), { text: null });
  assert.throws(() => readListFile(f, { uid: ME + 1 }), /belongs to uid/);
});

test('setup.mjs: approve-rules <product> parses; no --config or --root-prefix; the product name is checked', () => {
  assert.equal(parseArgs(['approve-rules', P]).product, P);
  assert.equal(parseArgs(['approve-rules', P, '--dry-run']).dry, true);
  assert.throws(() => parseArgs(['approve-rules']), /needs the product's name first/);
  assert.throws(() => parseArgs(['approve-rules', '--dry-run']), /needs the product's name first/);
  assert.throws(() => parseArgs(['approve-rules', P, '--config', '/x']), /no --config or --root-prefix/);
  assert.throws(() => parseArgs(['approve-rules', P, '--root-prefix', '/x']), /no --config or --root-prefix/);
  assert.throws(() => parseArgs(['approve-rules', P, P]), /is not one this command takes/);
});

test('setup.mjs main reads root\'s config strictly at its fixed place, then runs approve-rules with the config\'s owner', async () => {
  const raw = { base: '/Library/orch-test', owner: 'joe', products: [P], address: 'https://example.invalid/org/repo.git', label: 'com.example.orch', runnerConfig: '/Library/orch-test/review.json' };
  const read = [];
  const io = { ...ioOf(), readConfig: (p, o) => { read.push([p, o.strict]); return JSON.stringify(raw); } };
  const w = world();
  const code = await setupMain(['approve-rules', P], { io, approvePorts: w.ports, env: { SUDO_UID: String(OWNER) }, out: (l) => w.out.push(l), err: (l) => w.err.push(l) });
  assert.equal(code, 0, w.err.join('\n'));
  assert.deepEqual(read, [['/Library/orchestrate-setup.json', true]]);
  assert.deepEqual(w.listNow(), { [P]: [w.blob] });
  // The owner is root's config's: another owner there, and the same sudo is refused.
  const w2 = world();
  const io2 = { ...ioOf({ users: { orchestrate: ME, joe: OWNER, sam: OWNER + 1 } }), readConfig: () => JSON.stringify({ ...raw, owner: 'sam' }) };
  assert.equal(await setupMain(['approve-rules', P], { io: io2, approvePorts: w2.ports, env: { SUDO_UID: String(OWNER) }, out: () => {}, err: (l) => w2.err.push(l) }), 2);
  assert.match(w2.err.join('\n'), /only the owner \(sam\)/);
  // A bad root config stops it before the command.
  const w3 = world();
  assert.equal(await setupMain(['approve-rules', P], { io: { ...ioOf(), readConfig: () => '{}' }, approvePorts: w3.ports, env: { SUDO_UID: String(OWNER) }, out: () => {}, err: () => {} }), 2);
  assert.equal(w3.gh.calls.length, 0);
});
