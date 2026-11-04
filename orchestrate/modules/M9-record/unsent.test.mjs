// unsent.test.mjs — the store's unsent-alerts.jsonl reader (L240, L288): a file that can't be read as one plain file is
// an error, never read as "no alerts waiting", so an alert is never lost to a corrupt or replaced file.
// Run: node --test orchestrate/modules/M9-record/unsent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { UNSENT, markSent, readUnsent } from './unsent.mjs';

const line = (x) => `${JSON.stringify(x)}\n`;

test('readUnsent: waiting entries oldest first; a sent mark and a torn line take nothing away from the rest', () => {
  const root = tempDir('m9-unsent-');
  writeFileSync(join(root, UNSENT), line({ id: 'a', outcome: 'unsent', event: { type: 't' } }) + '{"id":"b","outc\n' + line({ id: 'c', outcome: 'unsent', event: { type: 'u' } }));
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['a', 'c']);
  markSent(root, 'a', '2026-11-03T00:00:00Z');
  assert.deepEqual(readUnsent(root).map((x) => x.id), ['c']);
});

test('L288: a folder, a link, a second name or a pipe in its place is refused, never read as empty', () => {
  const cases = {
    folder: (f) => mkdirSync(f),
    link: (f) => { writeFileSync(`${f}.real`, line({ id: 'z', outcome: 'unsent', event: { type: 't' } })); symlinkSync(`${f}.real`, f); },
    'second name': (f) => { writeFileSync(`${f}.real`, line({ id: 'z', outcome: 'unsent', event: { type: 't' } })); linkSync(`${f}.real`, f); },
    pipe: (f) => execFileSync('mkfifo', [f]),
  };
  for (const [name, make] of Object.entries(cases)) {
    const root = tempDir('m9-unsent-');
    make(join(root, UNSENT));
    assert.throws(() => readUnsent(root), undefined, name);
    assert.throws(() => markSent(root, 'z', 'x'), undefined, `${name}: no mark lands through it`);
  }
});
