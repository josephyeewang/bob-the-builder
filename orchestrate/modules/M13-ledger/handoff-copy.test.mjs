// handoff-copy.test.mjs — R-1-31 and R-1-32, the read-only handoff copy (design v4 §7.2 R6): the Ledger writes
// `<product>.md` from the record into its folder; the copier puts it in the Dropbox folder read-only; a stray write on
// the Mini fails; an edit made on the Air (or a forced permission change on the Mini) is overwritten at the next run and
// the difference logged. Real files in a temp folder; the "Dropbox" here is a plain folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';
import { writeHandoffCopy, newestLeadHandoff } from './handoff-copy.mjs';
import { EVERY_S, LOG_NAME, READ_ONLY, copierAgentPlist, lineDiff, parseArgs, runCopier } from './handoff-copier.mjs';

const SCRIPT = fileURLToPath(new URL('./handoff-copier.mjs', import.meta.url));
const ROOT = process.getuid?.() === 0;
const T = Date.parse('2026-11-13T12:00:00Z');

// A handoff as M9's applyParsed stores one (kind, role, session, text), in the order the Record took them.
const handoff = (id, role, text) => ({ id, rev: 1, doc: { kind: 'handoff-', role, session_id: id, card: null, text } });
const recOf = (list) => ({ list: (e) => (e === 'handoff' ? (typeof list === 'function' ? list() : list) : []) });
const NOTE = (n) => `# Lead handoff\n\n## Claim\np1 lead\n\n## Open card\nC-${n}\n\n## Next step\nstep ${n}\n\n## Decisions\nnone\n\n## Messages\nnone\n`;

function world() {
  const root = tempDir('m13-handoff-copy-');
  const w = { root, ledger: join(root, 'ledger'), dropbox: join(root, 'dropbox', 'handoffs'), state: join(root, 'copier') };
  for (const d of [w.ledger, w.dropbox, w.state]) mkdirSync(d, { recursive: true, mode: 0o700 });
  w.copy = join(w.dropbox, 'p1.md');
  w.log = () => (existsSync(join(w.state, LOG_NAME)) ? readFileSync(join(w.state, LOG_NAME), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.run = (over = {}) => runCopier({ products: ['p1'], from: w.ledger, to: w.dropbox, stateDir: w.state, now: () => T, ...over });
  w.lead = (list) => writeHandoffCopy({ rec: recOf(list), product: 'p1', dir: w.ledger });
  w.done = () => { try { chmodSync(w.copy, 0o644); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); };
  return w;
}
const mode = (p) => statSync(p).mode & 0o777;

test('R-1-31: the Ledger writes the newest Lead handoff, word for word, to <its folder>/<product>.md', () => {
  const w = world();
  try {
    const r = w.lead([handoff('h-1', 'lead', NOTE(1)), handoff('h-2', 'learning', 'not the Lead'), handoff('h-3', 'lead', NOTE(3))]);
    assert.deepEqual(r, { ok: true, wrote: join(w.ledger, 'p1.md'), id: 'h-3' });
    assert.equal(readFileSync(join(w.ledger, 'p1.md'), 'utf8'), NOTE(3));
    assert.deepEqual(newestLeadHandoff(recOf([handoff('h-2', 'learning', 'x')])), { ok: true, none: true });
  } finally { w.done(); }
});

test('R-1-31 planted: an unreadable handoff list, a corrupt entry or an empty newest handoff writes nothing and keeps the last good copy', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    for (const list of [() => { throw new Error('store unreadable'); }, [handoff('h-1', 'lead', NOTE(1)), { id: 'h-2', corrupt: true, reason: 'bad json' }],
      [handoff('h-1', 'lead', NOTE(1)), handoff('h-2', 'lead', '  ')]]) {
      const r = w.lead(list);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(readFileSync(join(w.ledger, 'p1.md'), 'utf8'), NOTE(1));
    }
    assert.match(writeHandoffCopy({ rec: recOf([]), product: '../p1', dir: w.ledger }).reason, /not a product name/);
    symlinkSync(w.ledger, join(w.root, 'ledger-link'));
    assert.match(writeHandoffCopy({ rec: recOf([handoff('h-1', 'lead', NOTE(1))]), product: 'p1', dir: join(w.root, 'ledger-link') }).reason, /link or not a folder/);
  } finally { w.done(); }
});

test('R-1-32: after a run the Dropbox copy is the record\'s handoff and read-only; a stray write on the Mini fails', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    const r = w.run();
    assert.equal(r.ok, true, r.problems.join('\n'));
    assert.equal(readFileSync(w.copy, 'utf8'), NOTE(1));
    assert.equal(mode(w.copy), READ_ONLY);
    if (!ROOT) {
      assert.throws(() => writeFileSync(w.copy, 'a session writes'), { code: 'EACCES' });
      assert.throws(() => appendFileSync(w.copy, 'appended'), { code: 'EACCES' });
      const sh = spawnSync('/bin/sh', ['-c', 'echo redirected > "$1"', 'sh', w.copy]);
      assert.notEqual(sh.status, 0, 'a Terminal redirect fails');
      assert.equal(readFileSync(w.copy, 'utf8'), NOTE(1));
    }
    // A second run with nothing changed writes nothing and logs nothing.
    const again = w.run();
    assert.deepEqual(again.results.map((x) => [x.wrote, x.logged]), [[false, null]]);
    assert.deepEqual(w.log(), []);
  } finally { w.done(); }
});

test('R-1-31/32: after a Lead restart (a new handoff in the record), the Dropbox copy and the record match, and nothing is logged as an edit', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    w.run();
    w.lead([handoff('h-1', 'lead', NOTE(1)), handoff('h-2', 'lead', NOTE(2))]);
    const r = w.run();
    assert.deepEqual(r.results.map((x) => [x.wrote, x.logged]), [[true, null]]);
    assert.equal(readFileSync(w.copy, 'utf8'), NOTE(2));
    assert.equal(mode(w.copy), READ_ONLY);
    assert.deepEqual(w.log(), []);
  } finally { w.done(); }
});

test('R-1-32: an edit made on the Air is overwritten at the next run and the difference is logged', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    w.run();
    // Dropbox does not carry the permission across: the synced file comes back writable, with the Air's edit in it.
    chmodSync(w.copy, 0o644);
    writeFileSync(w.copy, NOTE(1).replace('step 1', 'step typed on the Air'));
    const r = w.run();
    assert.equal(r.ok, true, r.problems.join('\n'));
    assert.equal(readFileSync(w.copy, 'utf8'), NOTE(1));
    assert.equal(mode(w.copy), READ_ONLY);
    const [l] = w.log();
    assert.equal(l.what, 'edited');
    assert.equal(l.mode, '0644');
    assert.deepEqual(l.diff.lines, ['+ step typed on the Air', '- step 1']);
    assert.equal(l.at, new Date(T).toISOString());
    // The run interval bounds a wrong copy to 15 minutes.
    assert.equal(EVERY_S, 900);
  } finally { w.done(); }
});

test('R-1-32: a forced permission change on the Mini is put back and logged; a copy deleted and written again is overwritten and logged', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    w.run();
    chmodSync(w.copy, 0o666);
    w.run();
    assert.equal(mode(w.copy), READ_ONLY);
    assert.deepEqual(w.log().map((l) => [l.mode, l.what, 'diff' in l]), [['0666', undefined, false]]);
    // The folder stays writable (Dropbox's), so a session can delete the copy and write a new one: caught the same way.
    rmSync(w.copy);
    writeFileSync(w.copy, 'a new file', { mode: 0o444 });
    w.run();
    assert.equal(readFileSync(w.copy, 'utf8'), NOTE(1));
    assert.equal(w.log().at(-1).what, 'edited');
  } finally { w.done(); }
});

test('R-1-32 planted: what was last written can\'t be read: the run says so and logs any difference as not known, then carries on', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    w.run();
    w.lead([handoff('h-2', 'lead', NOTE(2))]);
    writeFileSync(join(w.state, 'handoff-copier.json'), '{not json');
    const r = w.run();
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /what was last written can't be read/);
    assert.equal(readFileSync(w.copy, 'utf8'), NOTE(2));
    assert.equal(w.log().at(-1).what, 'differs, and what was last written is not known');
    assert.equal(w.run().ok, true, 'the next run reads what this one saved');
  } finally { w.done(); }
});

test('R-1-32 planted: a copy that is a link, a source that is a link, a missing source and a bad product name are refused or left; nothing is written through a link', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    const elsewhere = join(w.root, 'elsewhere.md');
    writeFileSync(elsewhere, 'someone else\'s file');
    symlinkSync(elsewhere, w.copy);
    let r = w.run();
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /p1: the Dropbox copy is not a plain file/);
    assert.equal(readFileSync(elsewhere, 'utf8'), 'someone else\'s file');
    rmSync(w.copy);
    // The Ledger's copy as a link.
    rmSync(join(w.ledger, 'p1.md'));
    symlinkSync(elsewhere, join(w.ledger, 'p1.md'));
    r = w.run();
    assert.match(r.problems[0], /the Ledger's copy can't be read/);
    assert.equal(existsSync(w.copy), false);
    // No Ledger copy yet: nothing copied, an existing copy kept.
    rmSync(join(w.ledger, 'p1.md'));
    writeFileSync(w.copy, 'the last good copy', { mode: 0o444 });
    r = w.run();
    assert.equal(r.ok, true);
    assert.equal(readFileSync(w.copy, 'utf8'), 'the last good copy');
    r = w.run({ products: ['../p1'] });
    assert.match(r.problems[0], /not a product name/);
    r = w.run({ to: join(w.root, 'missing') });
    assert.match(r.problems[0], /Dropbox folder is missing/);
    // A Dropbox folder that is a link to somewhere else: refused, nothing written there.
    const away = join(w.root, 'away'); mkdirSync(away);
    symlinkSync(away, join(w.root, 'dropbox-link'));
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    r = w.run({ to: join(w.root, 'dropbox-link') });
    assert.match(r.problems[0], /Dropbox folder is missing, a link or not a folder/);
    assert.equal(existsSync(join(away, 'p1.md')), false);
  } finally { w.done(); }
});

test('R-1-32: the script runs as the owner\'s user: exit 0 on a good run, 2 on bad arguments; its agent runs it every 15 minutes', () => {
  const w = world();
  try {
    w.lead([handoff('h-1', 'lead', NOTE(1))]);
    const ok = spawnSync(process.execPath, [SCRIPT, '--from', w.ledger, '--to', w.dropbox, '--state', w.state, '--product', 'p1'], { encoding: 'utf8' });
    if (!ROOT) {
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(readFileSync(w.copy, 'utf8'), NOTE(1));
    } else assert.equal(ok.status, 2, 'never as root');
    const bad = spawnSync(process.execPath, [SCRIPT, '--from', w.ledger], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    // A refused product is an error, never a success: exit 1, said on stderr.
    const refused = spawnSync(process.execPath, [SCRIPT, '--from', w.ledger, '--to', join(w.root, 'missing'), '--state', w.state, '--product', 'p1'], { encoding: 'utf8' });
    assert.equal(refused.status, ROOT ? 2 : 1, refused.stderr);
    if (!ROOT) assert.match(refused.stderr, /Dropbox folder is missing/);
    // Started through a link (#261): still runs, never a silent exit 0.
    const link = join(w.root, 'copier-link.mjs'); symlinkSync(SCRIPT, link);
    const viaLink = spawnSync(process.execPath, [link, '--from', w.ledger, '--to', join(w.root, 'missing'), '--state', w.state, '--product', 'p1'], { encoding: 'utf8' });
    assert.equal(viaLink.status, ROOT ? 2 : 1, viaLink.stderr);
    assert.throws(() => parseArgs(['--from', 'a', '--to', 'b', '--state', 'c']), /at least one --product/);
    const plist = copierAgentPlist({ label: 'orchestrate.handoff-copier', node: '/usr/local/bin/node', script: SCRIPT, from: '/a&b', to: '/c', stateDir: '/s', products: ['p1', 'p2'] });
    assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
    assert.ok(plist.includes('<string>/a&amp;b</string>') && plist.includes('<string>--product</string>\n    <string>p2</string>'));
    assert.ok(!/UserName|sudo|root/.test(plist), 'an agent of the owner\'s own user, not a root job');
  } finally { w.done(); }
});

test('R-1-32: the logged difference is capped', () => {
  const big = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(300)}`).join('\n');
  const d = lineDiff(big, 'other');
  assert.equal(d.lines.length, 40);
  assert.equal(d.more, 61);
  assert.ok(d.lines.every((l) => l.length <= 201));
});
