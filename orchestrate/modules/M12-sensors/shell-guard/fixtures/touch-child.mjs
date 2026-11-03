// touch-child.mjs — one piece of runner.test.mjs's touch check, run as its own process (L299 follow-up to #144):
// `node touch-child.mjs <name> <mode> <shell> <out.json>` writes touchCheck's cases for that one name, mode and shell.
//
// WHY a child. touchCheck spawns one shell per case and waits for each (spawnSync): about 4,000 cases per name and
// shell. In the test's own process that blocks the event loop for ~10 minutes on a Mac, so no test timeout can fire
// and a killed run leaves its folders behind. As eight children (two names, two modes, two shells) they run at once,
// and the test can kill one that overruns and remove its folder. Its temp folders go under TMPDIR, which the test sets
// to a folder of its own.
import { writeFileSync } from 'node:fs';
import { touchCheck } from '../selfcheck.mjs';
import { corpus } from '../runner.mjs';
import { tempDir } from '../../../../shared/test-tmp.mjs';

const [name, mode, shell, out] = process.argv.slice(2);
// Every case, the dead pairs included: the test judges which pairs touch nothing against corpus.dead.
corpus.dead = {};
const cases = touchCheck(name, { mode, shells: [shell], newFolder: () => tempDir('sg-self-') });
writeFileSync(out, JSON.stringify(cases));
