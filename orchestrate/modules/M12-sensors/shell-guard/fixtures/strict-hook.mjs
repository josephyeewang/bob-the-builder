// A stand-in guard for the runner's own tests: allows exactly the corpus's allow cases for the target (argv, default
// the usual one) asked from where it runs, and refuses everything else, failing closed. Not the real guard (lane 2's
// R-0b-36).
import { readFileSync } from 'node:fs';
import { cases } from '../runner.mjs';
try {
  const { tool_input: { command } } = JSON.parse(readFileSync(0, 'utf8'));
  const allowed = new Set(cases(process.argv[2] ?? '.env.production').filter((c) => c.expect === 'allow').map((c) => c.command));
  process.exit(allowed.has(command) ? 0 : 2);
} catch { process.exit(2); }
