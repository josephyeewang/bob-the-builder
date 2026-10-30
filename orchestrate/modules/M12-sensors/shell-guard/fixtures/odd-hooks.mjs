// Planted hook behaviours for the runner's protocol tests: node odd-hooks.mjs <crash|json-deny|json-deny-bare|continue-false|hang|allow-all>.
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
const mode = process.argv[2];
if (mode === 'crash') throw new Error('hook bug');
if (mode === 'json-deny') { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'production' } })); process.exit(0); }
if (mode === 'json-deny-bare') { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } })); process.exit(0); }
if (mode === 'continue-false') { console.log(JSON.stringify({ continue: false })); process.exit(0); }
if (mode === 'hang') setTimeout(() => {}, 60000);
if (mode === 'allow-all') process.exit(0);
