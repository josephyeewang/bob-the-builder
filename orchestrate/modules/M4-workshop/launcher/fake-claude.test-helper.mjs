import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCKED_PROMPT } from './launch.mjs';

// The stand-in claude the review launch tests share (review-launch.test.mjs, review-wiring.test.mjs): one file, so the
// smoke both test through is the same.
// A fake claude. Asked to run the smoke (L1352: the guard's one command, the smoke's line its base64 job), it runs the
// guard as the Bash tool does (detached, so its record and the runner's go-ahead are real), with a job standing in for
// what the sandbox lets through, per FAKE_SMOKE: 'sandboxed' marks only that it ran (the walls held), 'open' writes all
// three files, 'net' marks it ran and reached the network, 'none' runs but writes nothing; 'skip' never runs the command.
// Otherwise it prints its start message (FAKE_INIT) and waits to be stopped.
export function fakeClaude(dir) {
  const f = join(dir, 'fake-claude.mjs');
  writeFileSync(f, `
import { spawn } from 'node:child_process';
const prompt = process.argv.at(-1);
if (prompt.startsWith(${JSON.stringify(LOCKED_PROMPT)})) {
  const words = [...prompt.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const [ran, outside, net] = [...Buffer.from(words.at(-1), 'base64').toString('utf8').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const mode = process.env.FAKE_SMOKE;
  if (mode === 'skip') process.exit(0);
  const put = (p) => ": > '" + p + "'";
  const job = { sandboxed: [put(ran)], open: [put(ran), put(outside), put(net)], net: [put(ran), put(net)], none: ['true'] }[mode].join('; ');
  const cmd = prompt.slice(${JSON.stringify(LOCKED_PROMPT)}.length).replace(words.at(-1), Buffer.from(job, 'utf8').toString('base64'));
  const c = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
  c.on('exit', () => process.exit(0));
} else {
console.log('not json at all');
console.log(process.env.FAKE_INIT);
setTimeout(() => {}, 60000);
}
`);
  return f;
}

