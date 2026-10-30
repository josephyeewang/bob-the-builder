// child.test-helper.mjs — a separate Node process for the crash, stop and race tests (0b-2 M-4, M-6, R2-M11).
// It is run by the tests only: node child.test-helper.mjs '<json args>'. Prints one JSON line with its result.
//   { op: 'write', root, faultAt?, w }            one record.write
//   { op: 'commit', root, faultAt?, writes }      one raw commit of several documents (the merge pair, other entities)
//   { op: 'recover', root, lockTimeoutMs? }       recover() and report what it changed
//   { op: 'race', root, go, w, testNoLock?, testNoRevCheck? }   wait for the `go` file, then write
import { existsSync } from 'node:fs';
import { openRecord } from './writer.mjs';
import { rulesFor, PRODUCT, UID } from './rules.test-helper.mjs';
import { sleepMs } from './lock.mjs';

const a = JSON.parse(process.argv[2]);
const opened = openRecord({ root: a.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), host: 'mac-a', now: () => a.now ?? Date.now(),
  faultAt: a.faultAt, testNoLock: a.testNoLock, testNoRevCheck: a.testNoRevCheck, lockTimeoutMs: a.lockTimeoutMs ?? 20000 });
let out;
try {
  if (a.op === 'write') out = opened.record.write(a.w);
  else if (a.op === 'commit') out = opened.store.transaction((tx) => tx.commit(a.writes, { actor: 'test', kind: 'seed' }));
  else if (a.op === 'recover') out = opened.recover();
  else if (a.op === 'race') {
    while (!existsSync(a.go)) sleepMs(2);
    out = opened.record.write(a.w);
  }
} catch (e) { out = { threw: String(e?.message ?? e) }; }
process.stdout.write(`${JSON.stringify(out)}\n`);
