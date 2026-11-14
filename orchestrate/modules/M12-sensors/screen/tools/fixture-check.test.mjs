// R-0b-150: the publish gate for captured screens, and every committed fixture passing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureProblems, scrubScreen } from './fixture-check.mjs';
import { reached, SCENARIOS, still } from './capture.mjs';

test('the blinking tool-call marker does not count as the screen moving; anything else does', () => {
  assert.equal(still('⏺ Calling fixture…\n  ❯ * Name'), still('  Calling fixture…\n  ❯ * Name'));
  assert.notEqual(still('⏺ Calling fixture…\n ✻ 3s'), still('⏺ Calling fixture…\n ✻ 4s'));
});

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures');
const opts = { home: '/Users/someone', user: 'someone', values: ['Someones-Mac', 'Someone', 'Person'] };
// Built at run time so no key-shaped text sits in this file.
const fakeKey = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');

test('a clean screen passes', () => {
  assert.deepEqual(fixtureProblems(' ❯ \n ? for shortcuts\n <repo>', opts), []);
});

test('planted: a fixture holding a fake key is refused', () => {
  assert.ok(fixtureProblems(`token: ${fakeKey}`, opts).some((p) => p.startsWith('key-shaped text')));
});

test('planted: the home folder, a /Users/ path, the user name and an email are each refused', () => {
  assert.ok(fixtureProblems('cwd /Users/someone/x', opts).includes('the home folder'));
  assert.ok(fixtureProblems('/Users/other/y', opts).includes('a /Users/ path'));
  assert.ok(fixtureProblems('signed in as Someone today', opts).includes('the Mac user name'));
  assert.ok(fixtureProblems('a.b@example.com', opts).includes('an email address'));
});

test('planted: the network name (it shows as the pane title) and the owner\'s name are refused', () => {
  assert.ok(fixtureProblems('Someones-Mac.local', opts).includes('a named private value'));
  assert.ok(fixtureProblems('Person\'s Organization', opts).includes('a named private value'));
});

test('scrubbing swaps the repo, /private repo, home and network name for stand-ins, and masks keys', () => {
  const s = scrubScreen(`/private/tmp/r1 /tmp/r1 /Users/someone/a Someones-Mac.local Someones-Mac ${fakeKey}`, { repo: '/tmp/r1', home: '/Users/someone', host: 'Someones-Mac.local' });
  assert.equal(s.text.startsWith('<repo> <repo> ~/a <host> <host> '), true);
  assert.ok(!s.text.includes(fakeKey));
  assert.ok(s.masked.length > 0);
});

test('colour codes alone are not key-shaped; a key or name split by colour codes is still refused', () => {
  const colour = `\x1b[38;2;215;119;87m ❯ \x1b[39m\x1b[38;2;153;153;153m? for shortcuts\x1b[0m`.repeat(20);
  const s = scrubScreen(colour, { repo: '/tmp/r1', home: '/Users/someone', host: 'Someones-Mac.local' });
  assert.deepEqual(s.masked, []);
  assert.equal(s.text, colour);
  assert.deepEqual(fixtureProblems(colour, opts), []);
  const split = `${fakeKey.slice(0, 10)}\x1b[1m${fakeKey.slice(10)}`;
  assert.ok(scrubScreen(split, {}).masked.length > 0);
  assert.ok(fixtureProblems(split, opts).some((p) => p.startsWith('key-shaped text')));
  assert.ok(fixtureProblems('Some\x1b[1mone', opts).includes('the Mac user name'));
});

test('planted: the trust question is never saved as idle (2.1.322 shows ❯ on its "No, exit" line)', () => {
  const trust = ' Accessing workspace:\n <repo>\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel';
  const idle = SCENARIOS.find((s) => s.label === 'idle');
  assert.match(reached(idle, trust), /must not show/);
  assert.equal(reached(idle, '──────\n ❯ \n──────\n  ? for shortcuts'), null);
  assert.match(reached(SCENARIOS.find((s) => s.label === 'question-permission'), ' ❯ '), /expected text never showed/);
});

test('every scenario saves under its own label, and every question kind R-0b-150 names is there', () => {
  const labels = SCENARIOS.map((s) => s.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const l of ['question-permission', 'question-plan-approval', 'question-multiple-choice', 'question-named-session', 'question-mcp-input', 'question-folder-trust', 'working', 'idle', 'idle-newer-version']) {
    assert.ok(labels.includes(l), l);
  }
});

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

test('every committed fixture passes the gate on this machine too', () => {
  if (!existsSync(FIXTURES)) return;
  const here = { home: homedir(), user: userInfo().username, values: [hostname(), hostname().split('.')[0]] };
  const bad = walk(FIXTURES).filter((f) => fixtureProblems(readFileSync(f, 'utf8'), here).length);
  assert.deepEqual(bad.map((f) => f.slice(FIXTURES.length + 1)), []);
});
