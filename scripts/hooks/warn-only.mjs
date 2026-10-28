#!/usr/bin/env node
// warn-only.mjs — run one of Bob's blocking hooks in WARN-ONLY mode (D-019).
//
// Why: when `/bob UPGRADE` adds a hook that can stop work (block a command, keep Claude
// working until the build is green) to a project that has been running without it, the
// hook starts here first: it still runs and still says what it WOULD have blocked, but
// the action goes ahead. Once the owner has seen it behave, they switch it to enforce:
//   node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs --enforce <item>
//
// Usage (as .claude/settings.json writes it):
//   node "$CLAUDE_PROJECT_DIR/.claude/hooks/warn-only.mjs" <hook-file-in-.claude/hooks>
//
// Contract: reads the hook input on stdin, runs the real hook with the same input, and
// ALWAYS exits 0. If the real hook would have blocked (exit 2), it prints one JSON line
// with a `systemMessage` so the person sees the warning. The merge guard never runs
// through this wrapper — it has no off switch (D-018); its soft start is an empty
// .claude/required-checks.json.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2] || "";
const say = (msg) => process.stdout.write(JSON.stringify({ systemMessage: msg }) + "\n");

if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
  say(`Bob warn-only: no valid hook name given ("${name}") — nothing was checked.`);
  process.exit(0);
}
const file = join(dirname(fileURLToPath(import.meta.url)), name);
if (!existsSync(file)) {
  say(`Bob warn-only: .claude/hooks/${name} is missing, so it was not checked. Re-run /bob UPGRADE to restore it.`);
  process.exit(0);
}

let input = "";
try { input = readFileSync(0, "utf8"); } catch { /* no input */ }

const cmd = name.endsWith(".sh") ? "bash" : process.execPath;
const r = spawnSync(cmd, [file], { input, encoding: "utf8", env: process.env, timeout: 115000 });

if (r.status === 2) {
  const reason = (r.stderr || "").trim().split("\n").filter(Boolean).slice(-6).join(" / ").slice(0, 700);
  say(
    `Bob warn-only: the ${name} hook WOULD HAVE BLOCKED this, but it is in warn-only mode for this project, so it went ahead.` +
      (reason ? ` What it said: ${reason}` : "") +
      ` To make it block for real: node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs --enforce <item> (the item name is in the UPGRADE report).`,
  );
}
process.exit(0);
