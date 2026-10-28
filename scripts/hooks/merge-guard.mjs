#!/usr/bin/env node
// The merge guard's hook entry (Bob Step 6b default hook, D-018) — run by the PreToolUse hook in .claude/settings.json.
// The logic is lib/merge-guard.mjs; this file only runs it, unconditionally, so it can never import-and-exit without
// deciding (a re-export that drops the call is a known way for a guard to go silent). Plain JavaScript on purpose: it
// runs with bare `node`, before or without node_modules, in well under a second.
import { main } from "./lib/merge-guard.mjs";

main();
