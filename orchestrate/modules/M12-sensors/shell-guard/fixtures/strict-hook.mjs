// A stand-in guard for the runner's own tests: allow-list, fail closed. Not the real guard (lane 2's R-0b-36).
import { readFileSync } from 'node:fs';
try {
  const { tool_input: { command } } = JSON.parse(readFileSync(0, 'utf8'));
  const allowed = [/^ls$/, /^git status$/, /^node --test$/, /^cat README\.md$/, /^echo hello > \/tmp\/scratch\.txt$/];
  process.exit(allowed.some((r) => r.test(command)) ? 0 : 2);
} catch { process.exit(2); }
