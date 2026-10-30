// round4.test.mjs — planted cases for the 0b-8 audit round 4 findings and lead calls L22 (the brief pushed to Joe's
// phone) and L23 (the Air's health result written by a machine, dated by its own check). Each fails on the old code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { airHealthFile, checkAirHealthFile, airFactFromFile } from '../M12-sensors/air-health.mjs';
import { airCheck, AIR_FACT, nextTripPush, briefAnswers } from './trip.mjs';
import { outboxFile, checkOutboxFile } from './outbox.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { FAKE } from '../M12-sensors/fakes.mjs';

const tmp = (prefix) => realpathSync(tempDir(prefix)); // removed after the file, even on failure (shared/test-tmp.mjs)

const T0 = Date.parse('2026-11-03T12:00:00Z');
const at = (h) => new Date(T0 + h * 3600e3);

test('0b-8 audit round 4 M-1, L23: a count checked two days ago is dated two days ago, however late it is taken in', () => {
  const f = airHealthFile({ red_count: 0, at: at(-48) });
  assert.equal(f.name, 'request-airhealth-20261101-1200-air.json');
  const c = checkAirHealthFile(f.name, f.text, () => at(0));
  assert.equal(c.ok, true);
  const fact = airFactFromFile(c.doc, () => at(0));
  assert.equal(fact.checked_at, at(-48).toISOString());
  const a = airCheck({ facts: new Map([[AIR_FACT, fact]]), now: () => at(0.5) });
  assert.equal(a.passed, false, 'older than 24 h');
  assert.match(a.text, /2026-11-01T12:00/);
  const g = airHealthFile({ red_count: 0, at: at(-1) });
  const fresh = airFactFromFile(checkAirHealthFile(g.name, g.text, () => at(0)).doc, () => at(0));
  assert.equal(airCheck({ facts: new Map([[AIR_FACT, fresh]]), now: () => at(0) }).passed, true);
});

test('L23 planted: the air-health check refuses a wrong name, a mismatched or future date, extra fields and bad counts', () => {
  const ok = airHealthFile({ red_count: 3, at: at(-1) });
  const body = (o) => `${JSON.stringify({ request: 'airhealth', red_count: 0, checked_at: at(-1).toISOString(), ...o })}\n`;
  const cases = [
    ['request-airhealth-20261103-1100-ab.json', ok.text, /name/],
    ['request-airhealth-20261103-1000-air.json', ok.text, /differ/],
    [airHealthFile({ red_count: 0, at: at(2) }).name, airHealthFile({ red_count: 0, at: at(2) }).text, /future/],
    [ok.name, body({ note: 'x' }), /fields/],
    [ok.name, body({ red_count: -1 }), /whole number/],
    [ok.name, body({ red_count: '0' }), /whole number/],
    [ok.name, body({ checked_at: '2026-11-03T11:00:00+01:00' }), /UTC/],
    [ok.name, body({ request: 'wrapup' }), /fields/],
    [ok.name, 'not json', /JSON/],
    [ok.name, body({ checked_at: FAKE.github }), /UTC/],
  ];
  for (const [n, t, re] of cases) { const r = checkAirHealthFile(n, t, () => at(0)); assert.equal(r.ok, false, String(re)); assert.match(r.reason, re); }
  for (const bad of [-1, 1000, 1.5, '0', null]) assert.equal(airHealthFile({ red_count: bad }).ok, false, String(bad));
  assert.equal(airFactFromFile({ red_count: 0, checked_at: at(2).toISOString() }, () => at(0)), null, 'future');
});

test('L23: the command the Air runs writes one checked file to the folder it is given', () => {
  const dir = tmp('air-');
  const cli = fileURLToPath(new URL('../M12-sensors/air-health.mjs', import.meta.url));
  const name = execFileSync(process.execPath, [cli, '2', dir], { encoding: 'utf8' }).trim();
  assert.deepEqual(readdirSync(dir), [name]);
  const c = checkAirHealthFile(name, readFileSync(join(dir, name), 'utf8'));
  assert.equal(c.ok, true); assert.equal(c.doc.red_count, 2);
  assert.throws(() => execFileSync(process.execPath, [cli, 'two', dir], { stdio: 'pipe' }));
});

const brief = (ids) => `Brief made ${at(0).toISOString()}; answers state files: ${ids.join(', ')}.\nMini check: ...`;
test('L22: the brief is pushed once per new set of state files, and only when it names every id', () => {
  const ids = ['20261103-0915-kr', '20261103-0915-kq'];
  const away = (xs) => xs.map((id) => ({ id, state: 'away' }));
  const p = nextTripPush({ states: away(ids), lastPushedIds: [], build: brief });
  assert.deepEqual(p.ids, ['20261103-0915-kq', '20261103-0915-kr']);
  assert.equal(briefAnswers(p.text, ids), true);
  assert.equal(nextTripPush({ states: away(ids), lastPushedIds: p.ids, build: brief }), null, 'the same request is not pushed twice');
  assert.ok(nextTripPush({ states: away([...ids, '20261103-0920-ks']), lastPushedIds: p.ids, build: brief }), 'a new state file (the time zone answer) pushes again');
  assert.equal(nextTripPush({ states: away(ids), lastPushedIds: [], build: () => brief(['20261103-0915-kq']) }).failed, true, 'a brief missing an id is never sent; the failure is (round 8 minor 3)');
  assert.equal(nextTripPush({ states: [], build: brief }), null);
  assert.equal(nextTripPush({ states: away(['../x']), build: brief }).failed, true); // round 9 minor 2: said, not silent
  assert.equal(nextTripPush({ states: away(ids), build: () => { throw new Error('x'); } }).failed, true); // round 7 minor 1: pushed as a failure
  const skill = readFileSync(new URL('./skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Filed: away <the products>\. The Mini confirms in a minute\./); // L26 replaced "Checking the Mini"
});

test('0b-8 audit round 4 minor 1: a key split by invisible characters is still masked in an idea', () => {
  const split = FAKE.github.replace(/(.{6})/g, '$1​');
  const f = outboxFile('idea', '20261103-0915-kq', `my key ${split}`);
  const seen = (t) => t.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  assert.equal(seen(f.text).includes(FAKE.github), false);
  const c = checkOutboxFile('idea-20261103-0915-kq.md', `> my key ${split}\n`);
  assert.equal(c.ok, true); assert.equal(seen(c.doc.quoted).includes(FAKE.github), false);
});

test('0b-8 audit round 4 minor 3, cosmetic: rotate refusal names the underscore; a request word only in request names', () => {
  const r = outboxFile('request', '20261103-0915-kq', { request: 'rotate', name: 'VERCEL' });
  assert.equal(r.ok, false); assert.match(r.reason, /at least one _/);
  assert.equal(checkOutboxFile('state-resume-20261103-0915-kq.json', '{"product":"x","state":"paused","until":null,"tz":null}').ok, false);
  assert.equal(checkOutboxFile('idea-rotate-20261103-0915-kq.md', '> x\n').ok, false);
  assert.equal(checkOutboxFile('state-20261103-0915-kq.json', '{"product":"x","state":"paused","until":null,"tz":null}').ok, true);
  assert.equal(checkOutboxFile('request-wrapup-20261103-0915-kq.json', '{"request":"wrapup","product":null,"name":null}').ok, true);
});
