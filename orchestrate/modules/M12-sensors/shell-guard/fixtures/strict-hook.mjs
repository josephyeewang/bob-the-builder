// A stand-in guard for the runner's own tests: allows exactly the corpus's allow cases for the target (argv, default
// the usual one) asked from the folder each is asked from, and refuses everything else, failing closed. Not the real guard (lane 2's
// R-0b-36).
import { readFileSync } from 'node:fs';
import { cases } from '../runner.mjs';
try {
  const { tool_input: { command }, cwd } = JSON.parse(readFileSync(0, 'utf8'));
  // The same command can be refused from one folder and allowed from another, so the folder is part of the match.
  const allowed = cases(process.argv[2] ?? '.env.production').filter((c) => c.expect === 'allow').some((c) => c.command === command && (c.cwd ?? process.cwd()) === cwd);
  process.exit(allowed ? 0 : 2);
} catch { process.exit(2); }
