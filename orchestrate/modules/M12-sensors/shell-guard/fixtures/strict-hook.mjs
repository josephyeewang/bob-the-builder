// A stand-in guard for the runner's own tests: allow-list (the corpus's allow cases, word for word), fail closed.
// Not the real guard (lane 2's R-0b-36).
import { readFileSync } from 'node:fs';
try {
  const { tool_input: { command } } = JSON.parse(readFileSync(0, 'utf8'));
  const { allow } = JSON.parse(readFileSync(new URL('../corpus.json', import.meta.url), 'utf8'));
  process.exit(allow.includes(command) ? 0 : 2);
} catch { process.exit(2); }
