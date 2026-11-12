// budget.test.mjs — launch check 12's inputs for the runners (L995, L1001, L1002): the Dispatcher's rules snapshot,
// written and read on the disk, and budget() over it with a real Record and M10's real engine.
// Run: node --test orchestrate/modules/M11-dispatcher/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FETCH_GRACE_MS } from '../M10-rules/reader.mjs';
import { KEYS, need } from './keys.mjs';
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_REUSE_MS, budget, readRulesSnapshot, rulesAclProblem, rulesSnapshotFolderProblem, writeRulesSnapshot } from './budget.mjs';
import { PRODUCT, UID, must, product, setup } from '../M9-record/fixtures.test-helper.mjs';
import { ACCOUNT_FACT } from './tick.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8');
const withShakedown = (on) => FIXTURE.replace(/^caps:\n/m, `caps:\n  shakedown: ${on}\n`);
const C1 = 'c'.repeat(40); const B1 = 'b'.repeat(40); const C2 = 'd'.repeat(40); const B2 = 'e'.repeat(40);
const T0 = Date.parse('2026-11-11T12:00:00Z');
const okState = (text = FIXTURE, commit = C1, blob = B1, status = 'ok', fetchedAt = T0) => ({ status, text, commit, blob, fetchedAt, policy: {}, rev: 'x', reason: 'fresh' });
const T0ISO = new Date(T0).toISOString();

function folder() {
  const dir = join(tempDir('m11-budget-'), 'rules');
  mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
  return { dir, file: join(dir, 'dispatcher-rules.json') };
}
const write = (file, { now = T0, state = () => okState(), products = [PRODUCT] } = {}) => writeRulesSnapshot(file, { product: PRODUCT, products, state, now });
const read = (file, now = T0, uid = UID) => readRulesSnapshot(file, { uid, now });

test('L1001: a write with no change still writes the file again, so its written_at stays fresh; it holds the rules and nothing else', () => {
  const { dir, file } = folder();
  assert.deepEqual(write(file), { ok: true });
  const first = read(file);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.writtenAt, new Date(T0).toISOString());
  const ino = lstatSync(file).ino;
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(write(file, { now: T0 + 60_000 }), { ok: true });
  const second = read(file, T0 + 60_000);
  assert.equal(second.writtenAt, new Date(T0 + 60_000).toISOString(), 'written again with nothing changed');
  assert.deepEqual(second.rules, first.rules);
  assert.notEqual(lstatSync(file).ino, ino, 'a new file renamed over, never written in place');
  assert.deepEqual(readdirSync(dir), ['dispatcher-rules.json'], 'no new file left beside it');
  // Exactly what it holds (L1001: the text, its commit and blob, the status; no token or reader internals).
  const d = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(d).sort(), ['format', 'product', 'products', 'rules', 'written_at']);
  assert.deepEqual(d.products, [PRODUCT]);
  assert.deepEqual(d.rules, { [PRODUCT]: { status: 'ok', text: FIXTURE, commit: C1, blob: B1, fetched_at: T0ISO } });
});

test('L1001: rules that are not usable are not written: the own product\'s stop the write; another\'s are left out of the rules but kept on the list', () => {
  const { file } = folder();
  // GitHub not reached: nothing is written, and a snapshot already there is left to go stale (L1001).
  assert.deepEqual(write(file), { ok: true });
  const before = readFileSync(file, 'utf8');
  const r = write(file, { now: T0 + 60_000, state: () => ({ status: 'deny_all', reason: 'GitHub unreachable: offline' }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /so no snapshot is written \(it goes stale\)/);
  assert.equal(readFileSync(file, 'utf8'), before, 'left as it was');
  // PR-2 r2 M1: any other refusal of the own rules (deleted, a reader error, none known) removes it: the runners refuse at once.
  for (const own of [{ status: 'deny_all', reason: 'rules file not found' }, { status: 'deny_all', reason: 'reader_error: boom' }, { status: 'deny_all' }, null]) {
    assert.deepEqual(write(file), { ok: true });
    const g = write(file, { state: () => own });
    assert.equal(g.ok, false); assert.equal(g.removed, true, JSON.stringify(own));
    assert.match(g.reason, /so the rules snapshot is removed: the runners refuse at once/);
    assert.equal(existsSync(file), false, JSON.stringify(own));
    assert.match(read(file).reason, /missing|no such|ENOENT/i);
  }
  assert.equal(write(file, { state: () => null }).removed, true, 'nothing there to remove: still answered as removed');
  // A removal that fails is said, for the Dispatcher to queue.
  const dir2 = folder(); mkdirSync(dir2.file);
  writeFileSync(join(dir2.file, 'x'), 'y');
  const f = writeRulesSnapshot(dir2.file, { product: PRODUCT, products: [PRODUCT], state: () => ({ status: 'deny_all', reason: 'rules file not found' }), now: T0 });
  assert.equal(f.removeFailed, true, JSON.stringify(f));
  assert.match(f.reason, /could not be removed .*the runners may use it until it goes stale/);
  // The own product's last_good is usable; another product's deny_all has no rules, but is still listed, so the runners'
  // engine reads it as deny_all as the Dispatcher's does (L1001 review M1; budget() below).
  const state = (p) => (p === PRODUCT ? okState(FIXTURE, C1, B1, 'last_good') : { status: 'deny_all' });
  assert.deepEqual(write(file, { state, products: [PRODUCT, 'other-app'] }), { ok: true });
  assert.deepEqual(Object.keys(read(file).rules), [PRODUCT]);
  assert.deepEqual(read(file).products, [PRODUCT, 'other-app']);
  assert.equal(read(file).rules[PRODUCT].status, 'last_good');
  // A usable own state with no text, commit, blob or fetch time is refused, never written short.
  for (const k of ['text', 'commit', 'fetchedAt']) assert.match(write(file, { state: () => ({ ...okState(), [k]: undefined }) }).reason, /carries no text, commit, blob and fetch time/, k);
  // A list that does not name the own product, or names one twice, is refused.
  for (const products of [['other-app'], [PRODUCT, PRODUCT], [PRODUCT, '../x']]) assert.match(write(file, { products }).reason, /does not name/, String(products));
});

test('L1001: the snapshot goes stale once the writes stop, and is refused after the reader\'s grace', () => {
  const { file } = folder();
  write(file);
  // The Dispatcher can't reach GitHub: its writes stop and the file is left (above), so the last one ages.
  const off = write(file, { now: T0 + 60_000, state: () => ({ status: 'deny_all', reason: 'GitHub unreachable: ETIMEDOUT' }) });
  assert.equal(off.ok, false);
  assert.equal(off.removed, undefined, 'unreachable leaves the file');
  assert.equal(read(file, T0 + FETCH_GRACE_MS).ok, true, 'still inside the grace');
  const stale = read(file, T0 + FETCH_GRACE_MS + 1);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /is stale: written at 2026-11-11T12:00:00.000Z, over 300 s ago/);
  // One written ahead of the clock is refused too.
  assert.match(read(file, T0 - 1).reason, /ahead of this Mac's clock/);
  // Written fresh, but holding rules last fetched long ago (the reader's last_good near its own grace's end): its age
  // counts from that fetch, as the reader's does, never only from the write (L1001 review M2).
  assert.equal(write(file, { now: T0 + 200_000, state: () => okState(FIXTURE, C1, B1, 'last_good', T0) }).ok, true);
  assert.equal(read(file, T0 + FETCH_GRACE_MS).ok, true);
  assert.match(read(file, T0 + FETCH_GRACE_MS + 1).reason, /is stale: the rules for .* were last fetched at 2026-11-11T12:00:00\.000Z, over 300 s ago/);
  // Written ahead of the clock while its rules were fetched before it: the write time alone is ahead, and that is refused.
  assert.match(read(file, T0 + 100_000).reason, /was written at .*, ahead of this Mac's clock/);
});

test('L1002: an access list on the snapshot or its folder letting anyone but the two readers in, or letting them more than read, is refused', () => {
  const ls = (lines) => () => ({ status: 0, stdout: `drwx------+ 2 orchestrate staff 64 Nov 11 12:00 /x\n${lines.map((l, i) => ` ${i}: ${l}`).join('\n')}\n` });
  const mac = (lines, readers = ['review', 'owner1']) => rulesAclProblem('/x', readers, { run: ls(lines), platform: 'darwin' });
  assert.equal(mac([]), null);
  assert.equal(mac(['user:review allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit', 'user:owner1 inherited allow read,execute,readattr,readextattr,readsecurity']), null, 'setup\'s two entries, made or inherited');
  assert.equal(mac(['group:everyone deny read']), null, 'a deny entry closes, never opens');
  assert.match(mac(['group:everyone allow read']), /letting group:everyone in .* only user:review and user:owner1 may read it/);
  assert.match(mac(['user:someone allow read']), /letting user:someone in/);
  assert.match(mac(['user:review allow read,write']), /letting user:review do more than read it \(write\)/);
  assert.match(mac(['user:owner1 allow list,add_file']), /more than read it \(add_file\)/);
  assert.match(mac(['user:review allow read'], []), /only no one may read it/, 'readers that could not be named: refused');
  assert.match(mac(['garbled']), /can't be read/);
  assert.match(rulesAclProblem('/x', ['review'], { run: () => ({ status: 1, stderr: 'no' }), platform: 'darwin' }), /could not be read/);
  // Off macOS any access list is refused (it can't be read entry by entry).
  assert.match(rulesAclProblem('/x', ['review'], { run: () => ({ status: 0, stdout: 'drwx------+ 2 a b 64 x /x\n' }), platform: 'linux' }), /has an access list/);
  assert.equal(rulesAclProblem('/x', ['review'], { run: () => ({ status: 0, stdout: 'drwx------ 2 a b 64 x /x\n' }), platform: 'linux' }), null);
  // readRulesSnapshot checks both, folder first, after the mode checks.
  const { dir, file } = folder();
  write(file);
  const asked = [];
  const r = readRulesSnapshot(file, { uid: UID, now: T0, acl: (p) => { asked.push(p); return p === file ? `${p} has an access-list entry letting group:everyone in` : null; } });
  assert.deepEqual(asked, [dir, file]);
  assert.match(r.reason, /the Dispatcher's rules snapshot is refused: .* letting group:everyone in/);
});

test('L1002: a snapshot others can read or write, on the file or its folder, is refused; so are a link, a second name, a missing file and another user\'s', () => {
  const { dir, file } = folder();
  assert.match(read(file).reason, /is missing: the Dispatcher has not written it yet/);
  write(file);
  for (const mode of [0o644, 0o640, 0o604, 0o602, 0o620]) {
    chmodSync(file, mode);
    assert.match(read(file).reason, /can be read or written by group or others/, mode.toString(8));
  }
  chmodSync(file, 0o600);
  assert.equal(read(file).ok, true);
  for (const mode of [0o750, 0o705, 0o701, 0o770, 0o702]) {
    chmodSync(dir, mode);
    assert.match(read(file).reason, /folder .* can be read or written by group or others/, mode.toString(8));
    assert.match(write(file).reason, /folder .* can be read or written by group or others/, `the write refuses it too: ${mode.toString(8)}`);
  }
  chmodSync(dir, 0o700);
  assert.match(read(file, T0, UID + 1).reason, /is not the Dispatcher's user's/);
  const other = folder();
  write(other.file);
  const link = join(dir, 'linked.json'); symlinkSync(other.file, link);
  assert.match(read(link).reason, /is a link/);
  const two = join(dir, 'two.json'); linkSync(file, two);
  assert.match(read(file).reason, /has 2 names/);
  const linkedDir = join(dirname(dir), 'rules-link'); symlinkSync(other.dir, linkedDir);
  assert.match(read(join(linkedDir, 'dispatcher-rules.json')).reason, /is not a plain folder/);
  assert.equal(rulesSnapshotFolderProblem(other.dir, UID), null);
});

test('L1001: a snapshot that is not the format is refused plainly', () => {
  const { file } = folder();
  const put = (v) => { writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v), { mode: 0o600 }); chmodSync(file, 0o600); return read(file).reason; };
  const good = { format: 1, product: PRODUCT, written_at: T0ISO, products: [PRODUCT], rules: { [PRODUCT]: { status: 'ok', text: FIXTURE, commit: C1, blob: B1, fetched_at: T0ISO } } };
  assert.equal(put(good), undefined);
  assert.match(put('{not json'), /is not JSON/);
  assert.match(put({ ...good, format: 2 }), /is not format 1/);
  assert.match(put({ ...good, product: '' }), /names no product/);
  assert.match(put({ ...good, written_at: '2026-11-11T12:00:00Z' }), /has no written_at time/);
  assert.match(put({ ...good, rules: [] }), /holds no rules/);
  assert.match(put({ ...good, products: undefined }), /holds no product list/);
  assert.match(put({ ...good, products: [PRODUCT, PRODUCT] }), /holds no product list/);
  assert.match(put({ ...good, products: ['other-app'] }), /does not list its own product/);
  assert.match(put({ ...good, rules: { [PRODUCT]: { ...good.rules[PRODUCT], status: 'deny_all' } } }), /not a usable text, commit, blob and fetch time/);
  assert.match(put({ ...good, rules: { [PRODUCT]: { ...good.rules[PRODUCT], blob: 'x' } } }), /not a usable text, commit, blob and fetch time/);
  assert.match(put({ ...good, rules: { [PRODUCT]: { ...good.rules[PRODUCT], fetched_at: undefined } } }), /not a usable text, commit, blob and fetch time/);
  assert.match(put({ ...good, rules: { ...good.rules, 'other-app': good.rules[PRODUCT] } }), /holds rules for other-app, which it does not list/);
  assert.match(put({ ...good, products: [PRODUCT, 'other-app'], rules: { 'other-app': good.rules[PRODUCT] } }), /holds no rules for its own product/);
  assert.match(put(' '.repeat(MAX_SNAPSHOT_BYTES + 1)), /is over/);
});

function budgetWorld() {
  const env = setup({ prefix: 'm11-budget-rec-' });
  product(env);
  const { dir, file } = folder();
  const clock = { t: T0 };
  const config = { recordRoot: env.root, recordUid: UID, dispatcherRules: file, workerStatusFile: join(dir, 'w.json'), workerUid: UID,
    reviewStatusFile: join(dir, 'r.json'), reviewUid: UID, outboxRoot: env.outRoot };
  return { env, file, clock, config };
}
const snap = (w, state, products = [PRODUCT]) => writeRulesSnapshot(w.file, { product: PRODUCT, products, state, now: w.clock.t });
const at = (w, text = FIXTURE, commit = C1, blob = B1) => okState(text, commit, blob, 'ok', w.clock.t);
const startOf = (b, p = PRODUCT) => b.rules.may('start_session', { product: p, role: 'reviewer', tier: 2, editing: false });

test('L995: budget() reads the snapshot on every use, builds the rules again when it changes, and refuses one gone stale', () => {
  const w = budgetWorld();
  snap(w, () => at(w, withShakedown(false)));
  // The signed-in account, as the sensors write it (tick.mjs signedInAccount reads it through the Record view).
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { account: 'acct-1', observed_at: new Date(w.clock.t).toISOString() } }));
  const b = budget(w.config, { now: () => w.clock.t });
  assert.deepEqual(Object.keys(b).sort(), ['bandsNow', 'rec', 'rules', 'runningNow']);
  assert.equal(typeof b.bandsNow().band, 'string', 'the bands, from the snapshot\'s rules and the Record');
  const shake = () => need(b.rules, KEYS.shakedown, { product: PRODUCT, type: 'boolean' });
  assert.equal(shake(), false);
  assert.deepEqual(b.rec.read('product', PRODUCT)?.doc, { state: 'active' }, 'the Record, read only');
  w.clock.t += 60_000;
  snap(w, () => at(w, withShakedown(true), C2, B2));
  assert.equal(shake(), true, 'the new rules, built again');
  // The rules carry the snapshot's own commit and blob (never a stand-in's).
  assert.equal(b.rules.rev, `${PRODUCT}=${C2.slice(0, 7)}:${B2.slice(0, 7)}`);
  w.clock.t += FETCH_GRACE_MS + 1;
  assert.throws(shake, /is stale/);
  assert.throws(() => b.bandsNow(), /is stale/, 'the bands read the rules, so they refuse too');
  // may and classify never throw (shared/rules.mjs makeRules' promise): a deny, and Tier 1, with the snapshot's reason.
  const refused = b.rules.may('start_session', { product: PRODUCT, role: 'reviewer', tier: 2, editing: false });
  assert.equal(refused.decision, 'deny');
  assert.match(refused.reason, /rules error: .*is stale/);
  assert.equal(b.rules.rev, null, 'a refused snapshot names no version, never a throw (PR-2 r2 m2)');
  assert.equal(b.rules.classify({ product: PRODUCT, files: [] }).tier, 1);
  // A start the rules would count is refused as the Dispatcher's engine refuses it: the count is not wired.
  snap(w, () => at(w));
  const ed = b.rules.may('start_session', { product: PRODUCT, role: 'worker', tier: 2, editing: true });
  assert.equal(ed.decision, 'deny');
  assert.match(ed.reason, /running count is not wired/);
});

test('L1001 review M1: a product whose rules are not usable refuses every start on the Mac, in the runners as in the Dispatcher', () => {
  const w = budgetWorld();
  const b = budget(w.config, { now: () => w.clock.t, io: { userName: () => null } });
  snap(w, () => at(w), [PRODUCT]);
  assert.equal(startOf(b).decision, 'allow', 'one product, its rules usable: a reviewer start passes');
  w.clock.t += SNAPSHOT_REUSE_MS;
  snap(w, (p) => (p === PRODUCT ? at(w) : { status: 'deny_all' }), [PRODUCT, 'other-app']);
  const d = startOf(b);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /rules unusable for other-app: every start on this Mac is refused/);
  // Both usable again, but their Claude Code pins differ: refused as a mismatch, as the Dispatcher's engine refuses it.
  w.clock.t += SNAPSHOT_REUSE_MS;
  const other = FIXTURE.replace(/^(\s*pin:\s*)2\.1\.316$/m, '$12.1.317');
  assert.notEqual(other, FIXTURE, 'the fixture names a pin');
  snap(w, (p) => at(w, p === PRODUCT ? FIXTURE : other, C1, p === PRODUCT ? B1 : B2), [PRODUCT, 'other-app']);
  assert.match(startOf(b).reason, /pin mismatch/);
});

test('L1001 review m3: one read of the snapshot serves the uses inside a second, so one check decides on one snapshot', () => {
  const w = budgetWorld();
  let reads = 0;
  const b = budget(w.config, { now: () => w.clock.t, io: { userName: () => null, readSnapshot: (f, o) => { reads += 1; return readRulesSnapshot(f, { ...o, acl: () => null }); } } });
  const shake = () => need(b.rules, KEYS.shakedown, { product: PRODUCT, type: 'boolean' });
  snap(w, () => at(w, withShakedown(false)));
  assert.equal(shake(), false);
  w.clock.t += SNAPSHOT_REUSE_MS - 1;
  snap(w, () => at(w, withShakedown(true), C2, B2));
  assert.equal(shake(), false, 'the same read, inside the second');
  assert.equal(reads, 1);
  w.clock.t += 1;
  assert.equal(shake(), true, 'read again after it');
  assert.equal(reads, 2);
  // Its age is checked on every use, so a reused read never outlives the grace: read 500 ms inside the grace, then used
  // again 600 ms later, inside the same second (no new read), it is past the grace and refused.
  w.clock.t += FETCH_GRACE_MS - 500;
  assert.equal(shake(), true, 'read again, still inside the grace');
  assert.equal(reads, 3);
  w.clock.t += 600;
  assert.throws(shake, /is stale/);
  assert.equal(reads, 3, 'refused on the reused read, not a new one');
});

test('L995: budget() needs every path and uid it reads, and runningNow reads both runners\' status the one way (sessionsNow)', () => {
  const w = budgetWorld();
  for (const k of Object.keys(w.config)) {
    const c = { ...w.config }; delete c[k];
    assert.throws(() => budget(c), new RegExp(`budget: ${k} must be a`), k);
  }
  const b = budget(w.config, { now: () => w.clock.t });
  // No status file of the worker runner's: the count is not known, a throw, which check 12 refuses on.
  assert.throws(() => b.runningNow());
  const seen = [];
  const st = (dir) => ({ uid: UID, mode: dir ? 0o755 : 0o644, nlink: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });
  const io = {
    stat: (p) => { seen.push(p); return st(true); }, realpath: (p) => p,
    open: () => ({ st: st(false), text: JSON.stringify({ written_at: new Date(w.clock.t - 1000).toISOString(), sessions: [], requests: {} }) }),
    reviewStatus: () => ({ running: [] }),
  };
  const withIo = budget(w.config, { now: () => w.clock.t, io });
  assert.deepEqual(withIo.runningNow(), []);
  assert.ok(seen.includes(dirname(w.config.workerStatusFile)), 'the worker runner\'s status file\'s folder was read');
});
