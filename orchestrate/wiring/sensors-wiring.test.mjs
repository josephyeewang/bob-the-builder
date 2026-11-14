// sensors-wiring.test.mjs — the Sensors job starts from its real entry point with the real wiring (LEAD-CALLS L1049).
// Run: node --test orchestrate/wiring/sensors-wiring.test.mjs
//
// The boot test runs `node loop.mjs <config>` as its own process, as the Sensors job does, with the real wiring, the real
// Record, the real rules reader and the real owner's-answer reader. The stand-ins are the outside world only: GitHub (a
// fake fetch put in with `node --import`, fake-github.test-helper.mjs) and the network (a second `--import` that makes
// every TCP connection fail as "no name lookup"), so no test reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedLayout } from '../shared/job-config.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { fakeGitHubFetch, blobOf } from './fake-github.test-helper.mjs';
import { writeAnswer, ANSWER_FILE } from './owner-answer.mjs';
import { sensorsPass } from '../modules/M12-sensors/loop.mjs';
import { FACTS } from '../modules/M11-dispatcher/phone-link.mjs';
import { wire, checkConfig, CONFIG_KEYS, NETWORK_HOSTS } from './sensors-wiring.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-github.test-helper.mjs');
const COMMIT = 'b'.repeat(40);
const P = ENTRY.product;
const ME = process.getuid();

// One Mac's worth of files: products.json, the rules folder, the token, the owner's answer (this user's, so a test that
// stands in another user for this job can read it as the owner's), and the config.
function world({ source = false, extra = {} } = {}) {
  const L = source ? installedLayout('orch-sensors-wiring-', { source: true }) : null;
  const dir = L ? L.base : tempDir('orch-sensors-wiring-');
  const f = (n) => join(dir, n);
  writeFileSync(f('products.json'), JSON.stringify([ENTRY]));
  const rulesStateDir = f('rules-state');
  mkdirSync(rulesStateDir, { mode: 0o700 });
  writeFileSync(f('token'), 'x'.repeat(40), { mode: 0o600 });
  chmodSync(f('token'), 0o600);
  mkdirSync(f('owner-answer'), { mode: 0o755 });
  chmodSync(f('owner-answer'), 0o755);
  const answerFile = join(f('owner-answer'), ANSWER_FILE);
  assert.equal(writeAnswer({ to: answerFile, answer: { v: 1, account: 'a', signed_in: true, observed_at: new Date().toISOString(), usage: null } }).ok, true);
  const config = { installRoot: L ? L.installRoot : f('install'), wiring: L ? L.path('wiring/sensors-wiring.mjs') : join(here, 'sensors-wiring.mjs'), product: P,
    recordRoot: f('record'), ownerUid: ME, productsFile: f('products.json'), rulesStateDir, tokenFile: f('token'), answerFile, answerUid: ME, ...extra };
  const fake = { owner: ENTRY.owner, repo: ENTRY.repo, commit: COMMIT, text: FIRST, logFile: f('github.log') };
  writeFileSync(f('fake-github.json'), JSON.stringify(fake));
  writeFileSync(join(rulesStateDir, 'approved-rules.json'), JSON.stringify({ [P]: [blobOf(FIRST)] }));
  return { L, dir, f, config, fake };
}
const readRecord = (w) => openRecord({ root: w.config.recordRoot, product: P, ownerUid: ME, rules: fakeRules() }).record;
const factOf = (rec, id) => rec.read('fact', id)?.doc;

test('L1049: checkConfig refuses a config the Sensors cannot trust, before anything is opened', () => {
  const w = world();
  const good = { ...w.config, answerUid: ME + 1 };
  assert.equal(checkConfig(good, { selfUid: ME }), good);
  assert.deepEqual([...CONFIG_KEYS].sort(), Object.keys(good).sort(), 'the config setup writes is exactly the keys the wiring takes');
  const cases = [
    [{ ...good, recordRot: '/x' }, /config: unknown key recordRot/],
    [{ ...good, product: '..' }, /config: product must be a product name/],
    [{ ...good, product: 'Sample-app' }, /config: product must be a product name/],
    [{ ...good, ownerUid: -1 }, /config: ownerUid must be a Mac user id/],
    [{ ...good, answerUid: '501' }, /config: answerUid must be a Mac user id/],
    [{ ...good, answerUid: ME }, /config: answerUid must be the owner's user, not this job's own/],
    [{ ...good, answerUid: 0 }, /config: answerUid must be the owner's user, not root/],
    [null, /config: must be an object/],
    [[], /config: must be an object/],
  ];
  for (const k of ['installRoot', 'wiring', 'recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile', 'answerFile']) {
    cases.push([{ ...good, [k]: 'relative/path' }, new RegExp(`config: ${k} must be an absolute path`)]);
    const gone = { ...good }; delete gone[k];
    cases.push([gone, new RegExp(`config: ${k} must be an absolute path`)]);
  }
  for (const [c, re] of cases) assert.throws(() => checkConfig(c, { selfUid: ME }), re, JSON.stringify(c));
});

test('L1049: wire() refuses an answerUid that is this job\'s own before it opens the Record', async () => {
  const w = world();
  let fetched = 0;
  await assert.rejects(wire(w.config, { selfUid: ME, log: () => {}, fetchFn: (...a) => { fetched++; return fakeGitHubFetch(w.fake)(...a); } }), /answerUid must be the owner's user, not this job's own/);
  assert.equal(fetched, 0);
  assert.throws(() => readFileSync(join(w.config.recordRoot, 'x')), /ENOENT/);
});

test('L1049: wire() joins the loop to the real Record, the owner\'s answer and the product\'s repository, and one pass writes the facts', async () => {
  const w = world();
  const logs = [];
  const now = Date.now();
  // The job's own user stood in as another (ME + 2), so the answer file, this user's, is the owner's.
  const wired = await wire(w.config, { selfUid: ME + 2, log: (s) => logs.push(s), fetchFn: fakeGitHubFetch(w.fake), now: () => now,
    hosts: ['no-such-host.invalid'] });
  assert.deepEqual(Object.keys(wired.ports).sort(), ['github', 'probes', 'readUsage', 'whoIsSignedIn']);
  assert.deepEqual(Object.keys(wired.ports.probes), ['network'], 'the Front Door and Mini Base are not wired: no stand-in answers');
  assert.equal(wired.ports.github.owner, ENTRY.owner);
  assert.equal(wired.ports.github.repo, ENTRY.repo);
  assert.equal(wired.ports.checksGh, undefined, 'no App client is named');
  assert.equal((await wired.ports.whoIsSignedIn()).account, 'a', 'the owner\'s answer, read for real');
  wired.ports.probes.network = async () => null;   // built from the hosts above; never asked here, so no test reaches the network
  const r = await sensorsPass({ ...wired, now: () => new Date(now) });
  assert.equal(r.wrote['signed-in-account']?.ok, true, JSON.stringify(r));
  const rec = readRecord(w);
  assert.equal(factOf(rec, 'signed-in-account')?.account, 'a');
  // The Record was opened under the approved rules: the write carries their revision, as the Dispatcher's do.
  const line = rec.diary({ since: 0 }).filter((l) => l.id === 'signed-in-account').at(-1);
  assert.equal(line.rules_rev, `${P}=${COMMIT.slice(0, 7)}:${blobOf(FIRST).slice(0, 7)}`);
  assert.match(readFileSync(w.fake.logFile, 'utf8'), new RegExp(`GET /repos/${ENTRY.owner}/${ENTRY.repo}/git/ref/heads/main`));
  assert.deepEqual([...NETWORK_HOSTS], ['api.github.com', 'api.anthropic.com']);
});

test('L1049: the owner\'s answer from a user that is not answerUid is not believed: signed-in is written unknown', async () => {
  const w = world({ extra: { answerUid: ME + 1 } });
  const now = Date.now();
  const wired = await wire(w.config, { selfUid: ME + 2, log: () => {}, fetchFn: fakeGitHubFetch(w.fake), now: () => now, hosts: ['no-such-host.invalid'] });
  const who = await wired.ports.whoIsSignedIn();
  assert.equal(who.account, null); assert.match(who.reason, /is not the owner's/);
  wired.ports.probes.network = async () => null;
  await sensorsPass({ ...wired, now: () => new Date(now) });
  assert.equal(factOf(readRecord(w), 'signed-in-account')?.account ?? null, null);
});

// The boot: `node loop.mjs <config>` from the installed copy, as the job runs it. The job's own user is this one, so the
// answer is set to another user's (ME + 1), which this process can't be: the job runs, writes every reading, and writes
// signed-in as unknown, since the answer file is not that user's.
test('L1049: `node loop.mjs <config>` with the real wiring runs one pass and exits 0; the same config with answerUid this job\'s own does not start', () => {
  const w = world({ source: true, extra: { answerUid: ME + 1 } });
  const configFile = w.L.write('sensors.json', w.config);
  const noNet = join(w.dir, 'no-network.mjs');
  writeFileSync(noNet, "import net from 'node:net';\nimport { EventEmitter } from 'node:events';\nnet.connect = () => { const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))); return s; };\n");
  const boot = (file) => spawnSync(process.execPath, ['--import', FAKE, '--import', noNet, w.L.path('modules/M12-sensors/loop.mjs'), file], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ORCH_FAKE_GITHUB: w.f('fake-github.json') }, encoding: 'utf8', timeout: 60_000 });
  const r = boot(configFile);
  assert.equal(r.status, 0, `${r.stderr}${r.error ?? ''}${r.signal ?? ''}`);
  assert.doesNotMatch(r.stderr, /not started/);
  const rec = readRecord(w);
  assert.equal(factOf(rec, 'signed-in-account')?.account ?? null, null);
  assert.equal(factOf(rec, FACTS.network)?.value, false, 'every connection failed as no name lookup: down, from the real probe');
  assert.match(readFileSync(w.fake.logFile, 'utf8'), /GET \/repos\//);

  const mine = w.L.write('sensors-mine.json', { ...w.config, answerUid: ME });
  const r2 = boot(mine);
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(r2.stderr, /sensors: not started: config: answerUid must be the owner's user, not this job's own/);
});
