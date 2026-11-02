import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkOutboxFile } from './outbox.mjs';
import { checkPhoneReadback } from './readback.mjs';

const SKILL = readFileSync(new URL('./skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
// L151: the pause, away, back, wrap up and rotate wording is parked outside the skill until each kind is wired.
const PARKED = readFileSync(new URL('./parked-skill-wording.md', import.meta.url), 'utf8');
const front = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)?.[1] ?? '';

test('minor 8: the skill runs no shell lines and declares no hooks or extra tools', () => {
  assert.ok(front, 'frontmatter present');
  assert.match(front, /^name: orchestrate$/m);
  assert.doesNotMatch(front, /^\s*hooks\s*:/m);
  assert.doesNotMatch(front, /allowed-tools/);
  assert.doesNotMatch(SKILL, /!`/, 'no backticked ! lines (Claude Code would run them)');
  assert.doesNotMatch(SKILL, /^\s*!/m);
});

test('the skill names no machine path or account', () => {
  assert.doesNotMatch(SKILL, /\/Users\/|\/home\/|~\/|@[a-z0-9-]+\.[a-z]{2,}/i);
});

test('every file shape in the parked wording passes intake as written (it and outbox.mjs agree; L151)', () => {
  const examples = [...PARKED.matchAll(/`(\{"[^`]+\})`/g)].map((m) => m[1]).filter((j) => !j.includes('<'));
  assert.ok(examples.length >= 3, String(examples.length));
  for (const j of examples) {
    const doc = JSON.parse(j);
    const name = doc.request ? `request-${doc.request}-20261103-0915-kq.json` : 'state-20261103-0915-kq.json';
    const r = checkOutboxFile(name, j.replace('"X"', '"test-product"'));
    assert.equal(r.ok, true, `${j}: ${r.reason}`);
  }
  // the away and rotate shapes, filled in
  assert.equal(checkOutboxFile('request-rotate-20261103-0915-ro.json', '{"request":"rotate","product":null,"name":"STRIPE_KEY"}').ok, true);
  assert.ok(PARKED.includes('{"request":"rotate","product":null,"name":"<NAME>"}'));
  assert.equal(SKILL.includes('{"request":"rotate"'), false, 'the live skill writes no rotate file (L151)');
  assert.equal(checkOutboxFile('state-20261103-0915-an.json', '{"product":"test-product","state":"away","until":"2026-11-07","tz":"Europe/Prague"}').ok, true);
  assert.equal(examples.some((j) => JSON.parse(j).state === 'active'), false, 'no example sets a product active');
});

test('the skill carries the binding replies (MAT-6, MAT-7, minors 5–7)', () => {
  for (const s of ['Filed: idea <id>, saved for the Lead. The Mini confirms in a minute.', 'bob NEW X', 'isn\'t wired yet', 'Never write `"state":"active"`']) assert.ok(SKILL.includes(s), s);
  for (const s of ['request-wrapup-', 'request-rotate-', 'Never write `"state":"active"`']) assert.ok(PARKED.includes(s), s);
  assert.match(PARKED, /^\*\*Not loaded by the Front Door\.\*\*/m);
});

const PROFILE = { tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification', 'Skill'], skills: ['orchestrate'] };
const good = { tools: [...PROFILE.tools, 'EndConversation'], skills: ['orchestrate'], mcp_servers: [], plugins: [], connectors: [], setting_sources: ['managed', 'flag'] };

test('MAT-5 phone read-back: matches the profile passed in; tolerates EndConversation', () => {
  assert.deepEqual(checkPhoneReadback(`Here is my set-up:\n${JSON.stringify(good)}\nAnything else?`, PROFILE), { ok: true, problems: [] });
});

test('MAT-5 planted failures: extra tool, missing skill, a connector, project settings, absent lists, no profile', () => {
  const bad = (patch) => checkPhoneReadback({ ...good, ...patch }, PROFILE);
  assert.match(bad({ tools: [...good.tools, 'Bash'] }).problems.join(), /tools differ/);
  assert.match(bad({ skills: ['orchestrate', 'bob'] }).problems.join(), /skills differ/);
  assert.match(bad({ connectors: ['mail'] }).problems.join(), /connectors loaded: mail/);
  assert.match(bad({ mcp_servers: [{ name: 'files' }] }).problems.join(), /mcp_servers loaded: files/);
  assert.match(bad({ setting_sources: ['managed', 'flag', 'project'] }).problems.join(), /machine-wide \+ --settings only/);
  assert.match(bad({ setting_sources: ['flag'] }).problems.join(), /machine-wide \+ --settings only/);
  assert.match(bad({ plugins: undefined }).problems.join(), /plugins: missing/);
  assert.equal(checkPhoneReadback(good, null).ok, false);
  assert.equal(checkPhoneReadback('no json here', PROFILE).ok, false);
});
