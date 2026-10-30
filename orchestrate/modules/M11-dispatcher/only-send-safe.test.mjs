// Static check: the Dispatcher never types into a session itself. Every message goes through a
// `send` port that the wiring connects to M4's sendSafe guard; no Dispatcher file reaches the
// messenger, tmux or a keystroke tool directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.endsWith('.test-helper.mjs'));
const FORBIDDEN = [/messenger/i, /\btmux\b/, /send-keys/, /osascript/, /send-safe\/guard/, /child_process/];

test('only send-safe calls the messenger: no Dispatcher file reaches it directly', () => {
  assert.ok(sources.length >= 10, 'the check sees the Dispatcher files');
  for (const f of sources) {
    const text = readFileSync(join(here, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const re of FORBIDDEN) assert.doesNotMatch(text, re, `${f} must not use ${re}`);
  }
});

test('the check catches a planted direct call', () => {
  const planted = "import { tmuxMessenger } from '../M4-workshop/send-safe/guard.mjs';\nawait messenger.send(id, 'x');";
  assert.ok(FORBIDDEN.some((re) => re.test(planted)));
});
