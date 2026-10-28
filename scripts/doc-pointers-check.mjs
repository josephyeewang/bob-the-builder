#!/usr/bin/env node
// doc-pointers-check.mjs — two doc-honesty checks for the files every session reads first (Bob Rule 23(c), D-018).
//
// Adapted by Joe Wang (MIT, as the rest of Bob) from two tests he wrote for one of his own private projects. The
// checks and their reasons are kept; the project's own file names and the test runner were removed, so this runs
// with bare `node` in any project, whatever its language.
//
// WHY. The root instruction file (AGENTS.md / CLAUDE.md) is loaded into EVERY session, so it is the one place a rule
// is reliably read — which makes its pointers load-bearing and, without a check, unguarded. Two ways it goes wrong:
//   • a STALE pointer: it names a file that moved or a section that was renumbered. It misroutes a reader who IS
//     looking, and a broken pointer silently turns guidance into guidance nobody can find.
//   • a STALE STATUS: a status paragraph restated in an always-read file has nothing keeping it true, so it decays
//     while being read more than anything else in the repo. In the source project the always-read file described a
//     phase that had finished months earlier, long after the decision log had moved on; the coherence sweep
//     that would have caught it scanned docs/ only, and the root file sat outside it.
// The cure for the second is: the always-read file holds POINTERS, not status; the one status page carries an
// as-of date; and a check fails when that date trails the newest decision by more than N days.
//
// CHECK 1 — pointers (always on). In each always-read file (default: AGENTS.md and CLAUDE.md at the root):
//   (a) every path it names must exist. A path with a "/" must resolve from the root (or from the file's own folder)
//       — a miss FAILS. A bare file name in backticks (`decision-log.md`) that exists nowhere in the repo is a WARNING
//       only: a bare name often means a file in another tool's install (Bob's own `build-protocol-core.md`). Skipped: URLs, ~ and
//       absolute paths, globs and placeholders (<x>, {x}, *), and any path listed in `.bob-optional-pointers` at the
//       root (one per line — for files that legitimately may never exist, e.g. an AI-only spec in a non-AI product).
//   (b) every "§N of path" (or "§N … `path`") names a section that exists: a markdown heading that starts with N
//       ("## 3. …", "## §3 …"), or in .html an element with id="sN" / id="section-N" / class="snum" text "N —".
// CHECK 2 — status as-of (when --status is given). The status page must carry an as-of date:
//   markdown `Status as of: YYYY-MM-DD` (bold and HTML-comment forms accepted) or html
//   `<time id="status-as-of" datetime="YYYY-MM-DD">`. It fails when that date is more than --max-lag days (default 7)
//   behind the newest dated entry in the decision log (`| D-n | YYYY-MM-DD |` rows or `**Date:** YYYY-MM-DD` lines)
//   and any --also file (`> **YYYY-MM-DD` entries or `## YYYY-MM-DD` headings). A missing as-of date is a failure
//   with --require-asof, a warning otherwise (so existing projects are told, not broken).
//
// Usage:
//   node doc-pointers-check.mjs [--root DIR] [--files AGENTS.md,CLAUDE.md]
//        [--status docs/build-manifest.md --log docs/decision-log.md [--also docs/PROJECT-STATE.md] [--max-lag 7]
//         [--require-asof]] [--today YYYY-MM-DD]
// Exit: 0 = clean (warnings may print) · 1 = a broken pointer, a missing section, or a stale status · 2 = bad usage.
// Self-test: scripts/selftest-gate-scripts.sh runs it against each defect it exists for and against clean cases.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const o = { root: ".", files: ["AGENTS.md", "CLAUDE.md"], status: null, log: null, also: [], maxLag: 7, requireAsof: false, today: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x == null) throw new Error(`${a} needs a value`); return x; };
    if (a === "--root") o.root = v();
    else if (a === "--files") o.files = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--status") o.status = v();
    else if (a === "--log") o.log = v();
    else if (a === "--also") o.also.push(v());
    else if (a === "--max-lag") { o.maxLag = Number(v()); if (!Number.isInteger(o.maxLag) || o.maxLag < 0) throw new Error("--max-lag must be a whole number of days"); }
    else if (a === "--require-asof") o.requireAsof = true;
    else if (a === "--today") o.today = v();
    else if (a === "-h" || a === "--help") { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.status && !o.log) throw new Error("--status needs --log (the decision log it is compared against)");
  return o;
}

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** Every file name in the repo (skips .git and node_modules), for resolving a bare `name.md`. */
function allBasenames(root) {
  const names = new Set();
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else names.add(e.name);
    }
  };
  walk(root, 0);
  return names;
}

const EXT = "md|html|json|mjs|cjs|js|ts|tsx|sh|py|yml|yaml|tsv|csv|toml|sql";
/** Paths a file names: any token with a "/" and a known extension, plus bare `name.ext` inside backticks. */
function pointersIn(text) {
  const out = new Set();
  const pathRe = new RegExp(`(?:^|[\\s\`'"(\\[|])((?:\\.{1,2}/)?[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)+\\.(?:${EXT}))(?=$|[\\s\`'")\\]|,;:.!?#])`, "gm");
  for (const m of text.matchAll(pathRe)) out.add(m[1]);
  const bareRe = new RegExp(`\`([A-Za-z0-9_.@-]+\\.(?:${EXT}))\``, "g");
  for (const m of text.matchAll(bareRe)) out.add(m[1]);
  return [...out].filter((p) => !/^(https?:|~|\/)/.test(p) && !/[<>{}*]/.test(p) && !/^\.+$/.test(p));
}

/** "§N of path", "§N of `path`", "§N … path" within 40 characters on one line. */
function sectionRefsIn(text) {
  const re = new RegExp(`§\\s*(\\d+)[^\\n§]{0,40}?((?:\\.{1,2}/)?[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)*\\.(?:md|html))`, "g");
  return [...text.matchAll(re)].map((m) => ({ num: m[1], file: m[2] }));
}

/** Does the target carry section N? @param {string} target @param {string} file @param {string} num */
function hasSection(target, file, num) {
  if (file.endsWith(".html")) {
    return new RegExp(`<span class="snum">\\s*${num}\\s*[—–-]`).test(target)
      || new RegExp(`\\bid="(?:s|sec|section)-?${num}"`).test(target)
      || new RegExp(`<h[1-6][^>]*>\\s*(?:§\\s*)?${num}(?:\\.|\\s*[—–:-])`).test(target);
  }
  return new RegExp(`^#{1,6}\\s+(?:§\\s*)?${num}(?:\\.|:|\\)|\\s+[—–-])(?:\\s|$)`, "m").test(target);
}

function checkPointers(root, files) {
  const problems = [];
  const notes = [];
  const optionalFile = read(join(root, ".bob-optional-pointers")) ?? "";
  const optional = new Set(optionalFile.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  let names = null;
  let checked = 0;
  for (const f of files) {
    const src = join(root, f);
    const text = read(src);
    if (text == null) continue; // an always-read file the project does not have is not a failure
    for (const p of pointersIn(text)) {
      if (optional.has(p)) continue;
      checked++;
      if (p.includes("/")) {
        if (!existsSync(resolve(root, p)) && !existsSync(resolve(dirname(src), p))) problems.push(`${f} points at ${p}, which does not exist`);
      } else {
        names ??= allBasenames(root);
        if (!names.has(p)) notes.push(`${f} names \`${p}\`, and no file of that name exists in this repo (fine if it lives elsewhere, e.g. in Bob's install)`);
      }
    }
    for (const { num, file } of sectionRefsIn(text)) {
      if (optional.has(file)) continue;
      checked++;
      const target = read(resolve(root, file)) ?? read(resolve(dirname(src), file));
      if (target == null) { problems.push(`${f} cites §${num} of ${file}, and ${file} does not exist`); continue; }
      if (!hasSection(target, file, num)) problems.push(`${f} cites §${num} of ${file}, and ${file} has no section ${num}`);
    }
  }
  return { problems, notes, checked };
}

/** The status page's as-of date, or null. */
function asOfDate(text) {
  const html = text.match(/<time\b[^>]*\bid="status-as-of"[^>]*\bdatetime="(\d{4}-\d{2}-\d{2})"/)
    ?? text.match(/<time\b[^>]*\bdatetime="(\d{4}-\d{2}-\d{2})"[^>]*\bid="status-as-of"/);
  if (html) return html[1];
  const md = text.match(/status[ -]as[ -]of\b[^0-9\n]{0,12}(\d{4}-\d{2}-\d{2})/i);
  return md ? md[1] : null;
}

/** The newest date among decision rows / entries: `| D-n | YYYY-MM-DD |`, `**Date:** YYYY-MM-DD`, `> **YYYY-MM-DD`, `## YYYY-MM-DD`. */
function newestDate(text) {
  const dates = [
    ...[...text.matchAll(/^\|\s*D-\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*[-*]?\s*\*\*Date:?\*\*:?\s*(\d{4}-\d{2}-\d{2})/gim)].map((m) => m[1]),
    ...[...text.matchAll(/^>\s*\*\*(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^#{2,4}\s+(\d{4}-\d{2}-\d{2})\b/gm)].map((m) => m[1]),
  ].filter((d) => !Number.isNaN(Date.parse(d)));
  return dates.length ? dates.sort().at(-1) : null;
}

/** null when fresh enough, else a plain-English reason. */
function staleness(asOf, newest, maxLag, statusName) {
  if (!newest) return null;
  const lag = Math.round((Date.parse(newest) - Date.parse(asOf)) / DAY_MS);
  if (lag > maxLag) {
    return `${statusName} says "status as of ${asOf}", but the newest decision is dated ${newest} (${lag} days later; the limit is ${maxLag}). Bring the status up to date and move its as-of date.`;
  }
  return null;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`doc-pointers-check: ${e.message}`); process.exit(2); }
  const root = resolve(o.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) { console.error(`doc-pointers-check: '${o.root}' is not a directory`); process.exit(2); }
  const failures = [];
  const warnings = [];

  const { problems, notes, checked } = checkPointers(root, o.files);
  failures.push(...problems);
  warnings.push(...notes);
  const present = o.files.filter((f) => existsSync(join(root, f)));
  console.log(`pointers: ${present.length ? present.join(", ") : "(no always-read file found)"} — ${checked} pointer(s) checked, ${problems.length} broken`);

  if (o.status) {
    const status = read(resolve(root, o.status));
    const log = read(resolve(root, o.log));
    if (status == null) warnings.push(`no status page at ${o.status} yet — the as-of check starts once it exists`);
    else if (log == null) warnings.push(`no decision log at ${o.log} — the as-of check has nothing to compare against`);
    else {
      const asOf = asOfDate(status);
      const newest = [newestDate(log), ...o.also.map((a) => newestDate(read(resolve(root, a)) ?? ""))].filter(Boolean).sort().at(-1) ?? null;
      if (!asOf) {
        const msg = `${o.status} carries no "Status as of: YYYY-MM-DD" line, so nothing can tell when it went stale`;
        (o.requireAsof ? failures : warnings).push(msg);
      } else {
        const stale = staleness(asOf, newest, o.maxLag, o.status);
        if (stale) failures.push(stale);
        console.log(`status: ${o.status} as of ${asOf}; newest decision ${newest ?? "(none dated)"}; limit ${o.maxLag} days`);
      }
    }
  }

  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) { console.log(`doc-pointers-check: FAIL (${failures.length})`); process.exit(1); }
  console.log("doc-pointers-check: OK");
}

// Called unconditionally — never behind an "am I the main module?" test. Bob runs its scripts through a symlink
// (~/.claude/skills/bob/../scripts/…), and that test compares the symlink path with the real one, reads false, and
// exits 0 having checked nothing: a guard that goes silent exactly when it is installed.
main();
