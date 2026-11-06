// Tests for watch-cutover.sh (L643), the one root script for the watch job's cutover to the watcher App. It needs root and
// the host's real paths, so it is not run here end to end: its steps were rehearsed one by one on a copy of the host's
// install (L630). These tests pin what can go wrong in the script itself: the order of the steps, that every setup
// command it runs is one setup.mjs takes, that the updater runs as its job does, that it refuses without root, and that
// it never reads the key.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './setup.mjs';
import { SCRIPTS } from '../modules/M4-workshop/launcher/review-daemons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'watch-cutover.sh');
const TEXT = readFileSync(FILE, 'utf8');
const lines = TEXT.split('\n');
const value = (name) => { const m = new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm').exec(TEXT); return m ? m[1] : null; };

// Each `step <name> <args…>` / `check <name> <args…>` line, with its variables put in as the script has them.
const VARS = { APP_ID: value('APP_ID'), APP_INSTALLATION: value('APP_INSTALLATION'), KEY_NAME: value('KEY_NAME'), PIN: value('PIN'), TMP: '/private/var/root/watch-cutover.x' };
const calls = lines.filter((l) => /^(step|check) /.test(l)).map((l) => {
  const words = l.match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, '').replace(/\$([A-Z_]+)/g, (_, k) => VARS[k] ?? `$${k}`));
  return { kind: words[0], name: words[1], args: words.slice(2) };
});

test('L643: the script is sound shell (bash -n; shellcheck when it is on this Mac)', () => {
  assert.equal(spawnSync('/bin/bash', ['-n', FILE]).status, 0);
  const sc = spawnSync('shellcheck', ['-S', 'warning', FILE], { encoding: 'utf8' });
  if (sc.error) return;   // not installed here
  assert.equal(sc.status, 0, sc.stdout);
});

test('L643: without root it refuses at once with one plain line, and runs nothing', { skip: process.getuid() === 0 }, () => {
  const r = spawnSync('/bin/bash', [FILE], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^STOPPED at step start: it must run as root: sudo bash /m);
  assert.doesNotMatch(r.stdout, /====/);
});

test('L643: the steps run in the rehearsed order b, a, a2, c, d, and every one is a command setup.mjs takes', () => {
  const order = ['b: the updater', 'step a watch-app', 'step a2 watch-rules', 'check a2-check check-watch-rules', 'step c-place daemons place', 'step c-load daemons load',
    'check d-rules check-watch-rules', 'check d-install check-install', 'check d-job daemons check', 'launchctl kickstart'];
  const at = order.map((s) => TEXT.indexOf(s));
  for (let i = 0; i < order.length; i++) assert.notEqual(at[i], -1, order[i]);
  assert.deepEqual([...at].sort((x, y) => x - y), at, 'out of order');
  assert.equal(calls.length, 8);
  for (const c of calls) {
    const o = parseArgs(c.args);                                  // throws on a command or flag setup.mjs does not take
    if (c.kind === 'step') assert.equal(parseArgs([...c.args, '--dry-run']).dry, true, `${c.name} has a dry run`);
    else assert.throws(() => parseArgs([...c.args, '--dry-run']), /does not apply/, `${c.name} is read only`);
    if (c.args[0] === 'daemons') assert.deepEqual(o.jobs ?? [o.only], ['watch-only'], `${c.name} is for the watch job only`);
  }
  const app = parseArgs(calls[0].args);
  assert.deepEqual(app.app, { id: '5635934', installation: '179103836', keyFile: ['watch-app', 'pem'].join('.') });
  assert.match(app.pin, /^120df760[0-9a-f]{56}$/);
});

test('L643: a step that fails stops the script; the real run comes only after its dry run passes', () => {
  const body = TEXT.slice(TEXT.indexOf('step() {'), TEXT.indexOf('# A read-only check'));
  assert.ok(body.indexOf('--dry-run') < body.indexOf('"$NODE" "$SETUP" "$@" 2>&1'));
  assert.equal((body.match(/\|\| stop /g) ?? []).length, 2);
  const checkBody = TEXT.slice(TEXT.indexOf('check() {'), TEXT.indexOf('[ "$(id -u)" = 0 ]'));
  assert.match(checkBody, /\[ "\$r" = 0 \] \|\| stop "\$name"/, 'a failed check stops the script');
  assert.match(TEXT, /^set -u$/m);
  assert.doesNotMatch(TEXT, /\|\| true/);
});

test('L643: step b runs the updater exactly as its job does, then hands over to the copy\'s own file', () => {
  assert.equal(value('UPDATER'), `$COPY/${SCRIPTS.updater}`);
  assert.match(TEXT, /\(cd \/ && env -i PATH="\$PATH" "\$NODE" "\$UPDATER" "\$COPY\/updater\.json"\)/);
  assert.match(TEXT, /^export PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  assert.match(TEXT, /^umask 022$/m);
  assert.match(TEXT, /NEW="\$COPY\/setup\/watch-cutover\.sh"/);
  assert.match(TEXT, /exec \/bin\/bash "\$NEW" --after-b/);
  assert.match(TEXT, /\[ "\$IN_COPY" = 1 \] \|\| stop a /, 'steps a to d never run from a file outside the copy');
});

test('L643: the rules source is the copy in place, checked against the pin before and after it is taken', () => {
  const a2 = TEXT.slice(TEXT.indexOf('# a2:'), TEXT.indexOf('step a2'));
  assert.equal((a2.match(/shasum -a 256/g) ?? []).length, 2);
  assert.match(a2, /mktemp -d \/private\/var\/root\//, 'a folder only root can open, so root\'s strict read takes it');
  assert.match(a2, /\[ "\$GOT" = "\$PIN" \] \|\| stop a2/);
});

test('L643: the key is only checked to be there; nothing reads it, and printed lines pass through the hider', () => {
  const uses = lines.filter((l) => l.includes('KEY_NAME') && !/^KEY_NAME=/.test(l));
  assert.equal(uses.length, 2);
  for (const l of uses) assert.match(l, /^\[ -f "\$BASE\/keys\/\$KEY_NAME" \]|--app-key-name "\$KEY_NAME"/);
  assert.doesNotMatch(TEXT, /\bcat\b/);
  for (const l of lines.filter((x) => /"\$NODE"|tail /.test(x) && !/wc -l|grep -c/.test(x))) assert.match(l, /\| hide/, l);
  const hide = spawnSync('/bin/bash', ['-c', `${/^hide\(\).*$/m.exec(TEXT)[0]}\nhide`], { input: `a ${['ghs', 'x'.repeat(36)].join('_')} b\n-----BEGIN ${'RSA PRI'}VATE KEY-----\n`, encoding: 'utf8' });
  assert.equal(hide.stdout, 'a <token hidden> b\n<key hidden>\n');
});

test('L643: the end waits for a real pass and fails on a 403 or a pass that did not end with exit 0', () => {
  assert.match(TEXT, /\[ "\$n403" = 0 \] \|\| stop pass/);
  assert.match(TEXT, /\[ "\$\{code:-x\}" = 0 \] \|\| stop pass/);
  assert.match(TEXT, /^LABEL=com\.orchestrate\.watch-only$/m);
});
