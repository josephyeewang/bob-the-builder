// A planted WEAK guard: refuses only when the protected path appears as plain text. The runner must report its misses.
import { readFileSync } from 'node:fs';
const { tool_input: { command } } = JSON.parse(readFileSync(0, 'utf8'));
process.exit(command.includes(process.argv[2]) ? 2 : 0);
