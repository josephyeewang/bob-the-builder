// @ts-check
/**
 * THE MERGE GUARD (Bob the Builder, Step 6b default hook; D-018).
 *
 * Adapted by Joe Wang (MIT, as the rest of Bob) from the merge guard he wrote for one of his own private projects,
 * where it ran as the only thing standing between a red check and the main branch. Logic, refusal lines and the
 * block/allow table are kept; project names, the hard-coded file locations and the hard-coded branch name were
 * generalised, and the "no checks configured yet" stage was added for brand-new projects.
 *
 * WHAT: a Claude Code PreToolUse hook (wired by bob-init in .claude/settings.json) that refuses, before it runs, any
 * Bash or Monitor command that would merge a pull request — `gh pr merge N`, `gh api …/pulls/N/merge`, or a GraphQL
 * merge — unless `gh pr checks N` shows every REQUIRED check passing. It also refuses a direct push to the protected
 * branch (default `main`) and the other ways of moving it that skip a pull request (the GitHub "merges" and
 * "merge-upstream" endpoints, a write to refs/heads/<branch>, a commit straight to it through the contents API or
 * GraphQL, `gh repo sync` of a named repo).
 * WHY: on a personal free GitHub plan, GitHub itself cannot refuse a red merge on a private repo (branch protection
 * needs a paid plan there). "Merge on green" is then only a written rule — and a written rule is ~80% followed. This
 * hook is what "on green" rests on.
 *
 * THE ONE LIST: the required checks live in ONE file, `.claude/required-checks.json` (template:
 * templates/required-checks.json in Bob). This file only reads it. Adding or removing a check is an edit to that
 * file only — and an edit Claude cannot make (config-protection.js guards the file); the owner makes it.
 *
 * TWO STAGES (Bob addition):
 *   - "no CI yet" — `required` is an empty list. A brand-new project has no checks to wait for, so merges and pushes
 *     to the protected branch are ALLOWED, with a one-line notice each time saying nothing was checked. This is the
 *     scaffold's starting state.
 *   - "guarded" — `required` names at least one check. From then on every merge must show all of them passing, and a
 *     direct push to the protected branch is refused (open a PR instead).
 *   A MISSING or unreadable list is neither: any merge or push to the protected branch is refused (fails closed).
 *
 * HOW IT READS A COMMAND: a shell-word tokenizer splits the command the way bash would — quotes, escapes,
 * `;` `&&` `||` `|` `&`, subshells, `$(…)` and backticks (outside single quotes only: that is where bash runs them),
 * here-documents and here-strings, redirections — and the guard judges the COMMAND WORDS: the program and its own
 * arguments, after `env X=y`, `sudo`, `timeout 30` and the like. It reads into `bash -c '…'`, `sh -c`, `eval`, a
 * script piped or here-doc'd into a shell, `xargs`/`find -exec`/`ssh`/`watch`, git aliases given with `-c`, and the
 * code of `python -c` / `node -e` / a here-doc fed to an interpreter when that code starts a process. A merge phrase
 * that is only TEXT — an argument, a quoted string, a commit message, a here-document body written to a file, a
 * Python edit of a notes file — is not a merge, and is allowed. (An earlier version refused any command whose TEXT
 * contained such a phrase; harmless edits were blocked and builders learned to route around the guard.)
 *
 * FAILS CLOSED: if `gh` errors, times out, is missing, or prints something that is not the checks list; if the PR
 * cannot be identified (none named and the command changes folder first, or gh cannot say which PR); if the PR
 * number or a written endpoint is computed by a substitution; if a GraphQL query comes from a file or stdin the
 * guard cannot read; if the stdin is not the hook's JSON; if the guard itself throws — the command is refused.
 * There is no bypass switch: no environment variable, flag or file turns it off. A merge that must happen with a red
 * check (an outage on GitHub's side, say) is the owner's call, made by the owner outside Claude Code.
 *
 * WHAT IT CANNOT SEE (stated, not hidden): a script FILE that merges inside itself (`bash merge.sh 5`,
 * `python3 merge.py`), a program whose own code merges without the guard seeing that code, a script piped into a shell
 * from anything other than echo/printf/cat-of-a-here-doc (`curl … | bash`), a `git push` with no branch named or naming
 * `HEAD` (or a computed branch) while the protected branch is checked out, aliases set up before the command (in
 * ~/.gitconfig, `gh alias`), a deliberately disguised spelling that also dodges the hook's word filter in
 * .claude/settings.json, anything done outside Claude Code, a command run through a Claude Code tool other than Bash
 * or Monitor, and any session that started before this hook reached its checkout (Claude Code reads
 * .claude/settings.json at session start). It still fails closed on a few harmless commands that only look like
 * merges (a GET of a merge endpoint through curl, `python3 x.py gh pr merge 5`): reword or split them. It is a guard
 * for sessions that forget, not a lock against one that tries to get round it; GitHub's branch protection would be
 * the lock.
 *
 * Exit codes (Claude Code's contract): 0 = allow; 2 = block, and the one-line reason on stderr is shown to the
 * session. Any other failure of this script is turned into a block by the hook command itself (`|| exit 2`).
 *
 * MUTATION PROOF: every line that refuses ends in `// refusal:<id>`. scripts/hooks/merge-guard.test.mjs deletes each
 * such line in turn, re-imports the copy, and requires its block/allow table to notice. Keep each marked line a whole
 * statement on its own line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ name: string, may_skip?: boolean, why?: string, workflow?: string }} RequiredCheck */
/** @typedef {{ branch?: string, workflow?: string, workflow_file?: string, required: RequiredCheck[] }} RequiredSpec */
/** @typedef {{ name?: string, state?: string, bucket?: string, workflow?: string }} CheckRow */
/** @typedef {{ kind: "pr", ref: string | null, repo: string | null, via: string, movedDir?: boolean }} PrTarget */
/** @typedef {{ kind: "refuse", id: string, why: string }} Refusal */
/** @typedef {PrTarget | Refusal} MergeAction */

/** Where the one list lives in a project: `.claude/required-checks.json` (this file sits in `.claude/hooks/lib/`). */
export const REQUIRED_CHECKS_PATH = join(HERE, "..", "..", "required-checks.json");

/**
 * The required-check list — the one definition. Throws when the file is missing or malformed; the caller turns a
 * throw into a refusal of every merge and every push to the protected branch (fails closed).
 * @param {string} [path] @returns {RequiredSpec}
 */
export function loadRequiredSpec(path = REQUIRED_CHECKS_PATH) {
  /** @type {RequiredSpec} */
  const spec = JSON.parse(readFileSync(path, "utf8"));
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.required)) throw new Error(`${path} has no "required" list`);
  for (const r of spec.required) {
    if (!r || typeof r.name !== "string" || !r.name.trim()) throw new Error(`${path}: every required check needs a "name"`);
  }
  if (spec.branch != null && (typeof spec.branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(spec.branch))) {
    throw new Error(`${path}: "branch" is not a plain branch name`);
  }
  return spec;
}

/** The protected branch for the current decision (from the list's `branch`, default `main`). Set by guardCommand. */
let BRANCH = "main";
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Work done reading one command; past the cap the guard throws, and a throw is a refusal. */
const WORK = { n: 0 };
const WORK_CAP = 20_000;

/** @param {string} id @param {string} why @returns {Refusal} */
const refuse = (id, why) => ({ kind: "refuse", id, why });

// ── 1. Reading the command: a shell-word tokenizer ─────────────────────────────────────────────────────────────

/**
 * One simple command: its words (quotes removed), the command substitutions bash would run while building them
 * (`$(…)`, backticks, `<(…)` — never from inside single quotes), what it reads on stdin from a here-document or
 * here-string, whether stdin is redirected from a file, and the operator that came before it (`|` = piped into).
 * @typedef {{ words: string[], subs: string[], stdin: string[], stdinFile: boolean, op: string }} Segment
 */

/** @param {string} c */
const isBlank = (c) => c === " " || c === "\t";
/** Characters that end an unquoted word. */
const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/** From the index of an opening backtick, the index just past its closing one. @param {string} s @param {number} j */
function backtickEnd(s, j) {
  let k = j + 1;
  while (k < s.length && s[k] !== "`") k += s[k] === "\\" ? 2 : 1;
  return Math.min(k + 1, s.length);
}

/**
 * From the index of an opening `(` (the one after `$`, `<` or `>`), the inside and the index just past the matching
 * `)`. Quotes, nested substitutions and here-documents inside (`$(cat <<'EOF' … EOF)`, the commit-message idiom) are
 * skipped whole, so an apostrophe or a parenthesis in a here-document body cannot end it early.
 * @param {string} s @param {number} open
 */
function parenEnd(s, open) {
  let j = open + 1;
  let depth = 1;
  /** @type {{ delim: string, strip: boolean }[]} */
  let pend = [];
  while (j < s.length) {
    const d = s[j];
    if (d === "\\") { j += 2; continue; }
    if (d === "'") { const k = s.indexOf("'", j + 1); j = k < 0 ? s.length : k + 1; continue; }
    if (d === '"') { j = readQuoted(s, j + 1, '"').end; continue; }
    if (d === "`") { j = backtickEnd(s, j); continue; }
    if (d === "<" && s[j + 1] === "<" && s[j + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s'"<>;&|()]+))/.exec(s.slice(j));
      if (m) { pend.push({ delim: m[2] ?? m[3] ?? m[4] ?? "", strip: m[1] === "-" }); j += m[0].length; continue; }
    }
    if (d === "\n" && pend.length) { j = skipHeredocBodies(s, j + 1, pend).end; pend = []; continue; }
    if (d === "(") depth++;
    else if (d === ")") { depth--; if (depth === 0) return { inner: s.slice(open + 1, j), end: j + 1 }; }
    j++;
  }
  return { inner: s.slice(open + 1), end: s.length };
}

/**
 * Read here-document bodies starting at `pos` (the line after the one that opened them), one per delimiter, in order.
 * @param {string} s @param {number} pos @param {{ delim: string, strip: boolean }[]} pend
 */
function skipHeredocBodies(s, pos, pend) {
  /** @type {string[]} */
  const bodies = [];
  for (const { delim, strip } of pend) {
    /** @type {string[]} */
    const lines = [];
    while (pos < s.length) {
      let nl = s.indexOf("\n", pos);
      if (nl < 0) nl = s.length;
      const line = s.slice(pos, nl);
      pos = nl + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
      lines.push(line);
    }
    bodies.push(lines.join("\n"));
  }
  return { bodies, end: Math.min(pos, s.length) };
}

/**
 * Read text the way bash reads the inside of double quotes (terminator `"`) or an unquoted here-document body
 * (terminator null): `$(…)`, backticks and `${…}` are substitutions bash runs; a backslash escapes only $ ` " \ and
 * the newline. Returns the text, the substitutions, and the index just past the terminator.
 * @param {string} s @param {number} start @param {string | null} terminator
 */
function readQuoted(s, start, terminator) {
  let k = start;
  let text = "";
  /** @type {string[]} */
  const subs = [];
  while (k < s.length && s[k] !== terminator) {
    const d = s[k];
    if (d === "\\" && k + 1 < s.length) {
      const e = s[k + 1];
      if (e === "\n") { k += 2; continue; }
      text += "$`\"\\".includes(e) ? e : d + e;
      k += 2;
      continue;
    }
    if (d === "$" && s[k + 1] === "(") {
      const p = parenEnd(s, k + 1);
      if (s[k + 2] !== "(") subs.push(p.inner); // $(( … )) is arithmetic
      else subs.push(...substitutionsIn(p.inner.slice(1, -1)));
      text += s.slice(k, p.end);
      k = p.end;
      continue;
    }
    if (d === "$" && s[k + 1] === "{") {
      const e = braceEnd(s, k + 1);
      subs.push(...substitutionsIn(s.slice(k + 2, e - 1)));
      text += s.slice(k, e);
      k = e;
      continue;
    }
    if (d === "`") {
      const e = backtickEnd(s, k);
      subs.push(s.slice(k + 1, e - 1).replace(/\\([$`\\])/g, "$1"));
      text += s.slice(k, e);
      k = e;
      continue;
    }
    text += d;
    k++;
  }
  return { text, subs, end: Math.min(k + 1, s.length) };
}

/** From an opening `{` (of `${`), the index just past its `}`. @param {string} s @param {number} open */
function braceEnd(s, open) {
  let j = open + 1;
  let depth = 1;
  while (j < s.length) {
    const d = s[j];
    if (d === "\\") { j += 2; continue; }
    if (d === "'") { const k = s.indexOf("'", j + 1); j = k < 0 ? s.length : k + 1; continue; }
    if (d === '"') { j = readQuoted(s, j + 1, '"').end; continue; }
    if (d === "$" && s[j + 1] === "(") { j = parenEnd(s, j + 1).end; continue; }
    if (d === "{") depth++;
    else if (d === "}") { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return s.length;
}

/** The substitutions bash would run inside an expansion's text (`${X:-$(cmd)}`). @param {string} text */
function substitutionsIn(text) {
  if (++WORK.n > WORK_CAP) throw new Error("the command is too complex to read");
  return tokenize(text).flatMap((g) => g.subs);
}

/** Decode a `$'…'` (ANSI-C) string from the index after its opening quote. @param {string} s @param {number} k */
function readAnsiC(s, k) {
  let text = "";
  /** @type {Record<string, string>} */
  const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  while (k < s.length && s[k] !== "'") {
    if (s[k] === "\\" && k + 1 < s.length) {
      const e = s[k + 1];
      const hex = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(k + 1));
      const uni = /^[uU]([0-9a-fA-F]{1,8})/.exec(s.slice(k + 1));
      const oct = /^([0-7]{1,3})/.exec(s.slice(k + 1));
      if (hex) { text += String.fromCharCode(parseInt(hex[1], 16)); k += 1 + hex[0].length; continue; }
      if (uni) { text += String.fromCodePoint(parseInt(uni[1], 16)); k += 1 + uni[0].length; continue; }
      if (oct) { text += String.fromCharCode(parseInt(oct[1], 8)); k += 1 + oct[0].length; continue; }
      text += simple[e] ?? "\\" + e;
      k += 2;
      continue;
    }
    text += s[k];
    k++;
  }
  return { text, end: Math.min(k + 1, s.length) };
}

/**
 * Read one shell word from `i`: quotes removed, substitutions collected.
 * @param {string} s @param {number} i
 * @returns {{ text: string, subs: string[], quoted: boolean, end: number }}
 */
function readWord(s, i) {
  let text = "";
  /** @type {string[]} */
  const subs = [];
  let quoted = false;
  let j = i;
  while (j < s.length && !WORD_END.has(s[j])) {
    const c = s[j];
    if (c === "\\") {
      if (s[j + 1] !== "\n" && j + 1 < s.length) text += s[j + 1];
      quoted = true;
      j += 2;
      continue;
    }
    if (c === "'") {
      const k = s.indexOf("'", j + 1);
      const e = k < 0 ? s.length : k;
      text += s.slice(j + 1, e);
      quoted = true;
      j = e + 1;
      continue;
    }
    if (c === "$" && s[j + 1] === "'") {
      const a = readAnsiC(s, j + 2);
      text += a.text;
      quoted = true;
      j = a.end;
      continue;
    }
    if (c === '"' || (c === "$" && s[j + 1] === '"')) {
      const q = readQuoted(s, j + (c === "$" ? 2 : 1), '"');
      text += q.text;
      subs.push(...q.subs);
      quoted = true;
      j = q.end;
      continue;
    }
    if (c === "$" && s[j + 1] === "(") {
      const p = parenEnd(s, j + 1);
      if (s[j + 2] !== "(") subs.push(p.inner);
      else subs.push(...substitutionsIn(p.inner.slice(1, -1)));
      text += s.slice(j, p.end);
      j = p.end;
      continue;
    }
    if (c === "$" && s[j + 1] === "{") {
      const e = braceEnd(s, j + 1);
      subs.push(...substitutionsIn(s.slice(j + 2, e - 1)));
      text += s.slice(j, e);
      j = e;
      continue;
    }
    if (c === "`") {
      const e = backtickEnd(s, j);
      subs.push(s.slice(j + 1, e - 1).replace(/\\([$`\\])/g, "$1"));
      text += s.slice(j, e);
      j = e;
      continue;
    }
    text += c;
    j++;
  }
  return { text, subs, quoted, end: j };
}

/**
 * Split a shell command into simple commands, the way bash would at the level that matters here.
 * Not a full shell grammar (no `case` patterns, no arrays); where a construct is unusual the words still come out,
 * and the judging below fails closed on anything it cannot place.
 * @param {string} cmd
 * @returns {Segment[]}
 */
export function tokenize(cmd) {
  /** @type {Segment[]} */
  const out = [];
  /** @returns {Segment} @param {string} op */
  const fresh = (op) => ({ words: [], subs: [], stdin: [], stdinFile: false, op });
  let cur = fresh("");
  /** @type {{ delim: string, strip: boolean, expands: boolean, seg: Segment }[]} */
  let pending = [];
  /** @param {string} op */
  const finish = (op) => {
    if (cur.words.length || cur.subs.length || cur.stdin.length || cur.stdinFile) { out.push(cur); cur = fresh(op); }
    else cur.op = cur.op === "|" && op === "(" ? "|" : op; // `a | (b)` stays piped
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (isBlank(c)) { i++; continue; }
    if (c === "\\" && cmd[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") {
      finish("\n");
      i++;
      if (pending.length) {
        const h = skipHeredocBodies(cmd, i, pending);
        pending.forEach((p, n) => {
          const body = h.bodies[n] ?? "";
          p.seg.stdin.push(body);
          if (p.expands) p.seg.subs.push(...readQuoted(body, 0, null).subs);
        });
        pending = [];
        i = h.end;
      }
      continue;
    }
    if (c === "#") { const nl = cmd.indexOf("\n", i); i = nl < 0 ? cmd.length : nl; continue; } // a comment
    if (c === ";") { finish(";"); i += cmd[i + 1] === ";" || cmd[i + 1] === "&" ? 2 : 1; continue; }
    if (c === "|") {
      if (cmd[i + 1] === "|") { finish("||"); i += 2; } else { finish("|"); i += cmd[i + 1] === "&" ? 2 : 1; }
      continue;
    }
    if (c === "&" && cmd[i + 1] !== ">") {
      if (cmd[i + 1] === "&") { finish("&&"); i += 2; } else { finish("&"); i++; }
      continue;
    }
    if ((c === "<" || c === ">") && cmd[i + 1] === "(") {
      const p = parenEnd(cmd, i + 1); // a process substitution runs its command
      cur.subs.push(p.inner);
      i = p.end;
      continue;
    }
    if (c === "(" || c === ")") { finish(c); i++; continue; }
    const r = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/.exec(cmd.slice(i, i + 12));
    if (r) {
      const op = r[2];
      i += r[0].length;
      while (i < cmd.length && isBlank(cmd[i])) i++;
      const t = readWord(cmd, i);
      i = t.end;
      if (op === "<<" || op === "<<-") {
        pending.push({ delim: t.text, strip: op === "<<-", expands: !t.quoted, seg: cur });
        continue;
      }
      cur.subs.push(...t.subs);
      if (op === "<<<") cur.stdin.push(t.text);
      else if (op === "<" || op === "<>") cur.stdinFile = true;
      continue;
    }
    const w = readWord(cmd, i);
    if (w.end === i) { i++; continue; } // never stall
    i = w.end;
    cur.words.push(w.text);
    cur.subs.push(...w.subs);
  }
  finish("");
  return out;
}

// ── 2. Judging the words ────────────────────────────────────────────────────────────────────────────────────────

/** Words that run the command after them; the value-taking options each one may carry before it. */
/** @type {Record<string, string[]>} */
const WRAPPERS = {
  env: ["-u", "--unset", "-C", "--chdir"], command: [], builtin: [], exec: ["-a"], time: ["-o", "-f"], nohup: [],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"], doas: ["-u", "-C"], nice: ["-n"],
  ionice: ["-c", "-n", "-p"], caffeinate: ["-t", "-w"], stdbuf: ["-i", "-o", "-e"], unbuffer: [], chronic: [],
  noglob: [], then: [], do: [], else: [], if: [], elif: [], while: [], until: [], "!": [], "{": [], "}": [],
};
/** Wrappers whose first non-option word is an argument, not the command (`timeout 30 gh …`). */
/** @type {Record<string, string[]>} */
const WRAPPERS_WITH_ARG = { timeout: ["-s", "--signal", "-k", "--kill-after"], gtimeout: ["-s", "--signal", "-k", "--kill-after"] };
/** Shells: their `-c` string, a here-doc, or a script piped in, is itself a command. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "busybox"]);
/** Interpreters: their inline code is read for a started process that merges. */
const INTERPRETERS = /^(python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|tsx|ts-node|perl[\d.]*|ruby|php|osascript)$/;
/** Commands that run another command (often with arguments from elsewhere): a merge inside one is refused. */
const INDIRECT = new Set(["xargs", "parallel", "watch", "find", "ssh", "su", "runuser", "script", "flock", "tmux",
  "screen", "at", "batch"]);
/** Commands whose arguments are text: a mention of a merge in them is not a merge. */
const TEXT_COMMANDS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "cat", "head", "tail", "less",
  "more", "sed", "awk", "jq", "wc", "sort", "uniq", "cut", "tr", "test", "[", "[[", "ls", "diff", "tee", "true", ":",
  "false", "touch", "mkdir", "cp", "mv", "rm", "open", "pbcopy", "export", "local", "declare", "readonly", "unset",
  "read", "set", "shift", "return", "exit", "printenv", "which", "type", "file", "stat", "basename", "dirname",
  "realpath", "date", "sleep", "column", "fold", "fmt", "nl", "paste", "join", "comm", "base64", "shasum", "md5"]);
/** Programs that, met as an ARGUMENT of an unknown program, mean "it runs this next" (`arch -arm64 gh pr merge 5`). */
const RUNNERS = new Set(["gh", "hub", "git", "curl", "wget", "http", "https", "eval", ...SHELLS, ...INDIRECT,
  ...Object.keys(WRAPPERS).filter((k) => /^[a-z]/.test(k) && !["then", "do", "else", "if", "elif", "while", "until"].includes(k)),
  ...Object.keys(WRAPPERS_WITH_ARG)]);
/** `gh` subcommands that only write or read text. */
const GH_TEXT = new Set(["pr create", "pr edit", "pr comment", "pr review", "pr view", "pr list", "pr checks", "pr diff",
  "pr status", "pr close", "pr reopen", "pr ready", "pr checkout", "issue", "release", "run", "workflow", "search",
  "label", "gist", "browse", "auth", "secret", "variable", "cache", "status", "repo view", "repo clone", "repo list",
  "repo create", "repo fork", "repo edit"]);
/** `git` subcommands that only write or read text, or touch only the local checkout. */
const GIT_TEXT = new Set(["commit", "tag", "log", "show", "grep", "notes", "diff", "status", "add", "stash", "branch",
  "checkout", "switch", "fetch", "rebase", "merge", "cherry-pick", "revert", "reset", "worktree", "rev-parse", "remote",
  "config", "blame", "ls-files", "restore", "rm", "mv", "pull", "clone", "describe", "shortlog", "reflog", "init",
  "merge-base", "rev-list", "ls-remote", "show-ref", "cat-file", "for-each-ref", "symbolic-ref", "apply", "am",
  "format-patch", "range-diff", "clean", "gc", "bisect", "submodule", "sparse-checkout", "maintenance", "var", "help",
  "version", "check-ignore", "ls-tree", "show-branch", "cherry", "name-rev", "whatchanged", "difftool", "mergetool", "merge-tree", "merge-file"]);

/** In a git or gh command's own ARGUMENTS (never a here-doc body), any of these means it might merge or move the
 *  protected branch. A function, because the branch name comes from the required-check list. */
const mergeWords = () => new RegExp(String.raw`\bpr\s+merge\b|pulls\/[^/\s]+\/merge\b|\bmergePullRequest\b|\benablePullRequestAutoMerge\b|\bmergeBranch\b|\/merges\b|\/merge-upstream\b|refs\/heads\/` + esc(BRANCH) + String.raw`\b`, "i");
/** GraphQL mutations that merge or move a branch. */
const GRAPHQL_MOVES = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRefs?|createCommitOnBranch|createRef|deleteRef)\b/i;
/** Code that starts another process (Python, Node, Perl, Ruby, PHP, Deno, Bun, AppleScript). */
const SPAWNS = /subprocess|os\.(system|popen|exec\w*|spawn\w*)|pty\.spawn|child_process|\bexec(Sync|File|FileSync|a)?\s*\(|\bspawn(Sync)?\s*\(|\bsystem\s*\(|\bshell_exec\b|\bpassthru\b|\bproc_open\b|Deno\.(run|Command)|Bun\.(spawn|\$)|\bqx\b|\bIO\.popen|Open3|do shell script|\$\s*`|\bsh\s*\(|\bplumbum\b|\bsh\.\w+\(/;
/** Code that hands a whole STRING to a shell (so a lone string literal may be a command line). */
const SHELL_STRING = /shell\s*=\s*True|os\.(system|popen)|["'`]\s*\)?\.split\(|shlex|getoutput|getstatusoutput|execSync\s*\(|\bexec\s*\(|\bsystem\s*\(|shell_exec|passthru|popen|do shell script|\bsh\s*\(|Bun\.\$|\bqx\b/;
/** Code that talks to an HTTP API. */
const HTTP_CODE = /requests\.|urllib|httpx|http\.client|\bfetch\s*\(|axios|got\(|Net::HTTP|LWP|HTTP::Tiny|curl_|Octokit|octokit|PyGithub|github3|ghapi/;

/** The program's name, path removed (`/opt/homebrew/bin/gh` → gh). @param {string} w */
const base = (w) => w.split("/").pop() ?? w;
/** Quote a word back for the shell (used when a word list is re-read as a command string). @param {string} w */
const shq = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
/** A word whose value is only known when the command runs. @param {string} w */
const computed = (w) => /[$`]/.test(w);

/**
 * @typedef {{ movedDir: boolean, vars: Map<string, string> }} State
 * @typedef {{ depth: number, state: State, stdinText: string | null, cwd: string }} Env
 */

/**
 * Strip `env X=1`, `sudo -u x`, `timeout -s KILL 30` and assignments from the front.
 * @param {string[]} w @param {State} state @returns {string[]}
 */
function commandWords(w, state) {
  let k = 0;
  while (k < w.length) {
    const t = w[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t)) { k++; continue; }
    const b = base(t);
    if (Object.prototype.hasOwnProperty.call(WRAPPERS, b)) {
      const opts = WRAPPERS[b];
      k++;
      while (k < w.length && w[k].startsWith("-") && w[k] !== "-") {
        const o = w[k];
        if (o === "--") { k++; break; }
        if (b === "env" && (o === "-S" || o === "--split-string")) {
          // `env -S "gh pr merge 5"` splits its string into the command
          return commandWords([...tokenize(w[k + 1] ?? "").flatMap((g) => g.words), ...w.slice(k + 2)], state);
        }
        if (b === "env" && (o === "-C" || o.startsWith("--chdir"))) state.movedDir = true;
        k += opts.includes(o) ? 2 : 1;
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(WRAPPERS_WITH_ARG, b)) {
      const opts = WRAPPERS_WITH_ARG[b];
      k++;
      while (k < w.length && w[k].startsWith("-")) k += opts.includes(w[k]) ? 2 : 1;
      k++; // its duration
      continue;
    }
    break;
  }
  return w.slice(k);
}

/** gh flags that take a value, for reading positionals. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A",
  "--author-email", "--match-head-commit", "-X", "--method", "-f", "--raw-field", "--field", "-H", "--header",
  "--input", "-q", "--jq", "--template", "--cache", "--hostname", "-p", "--preview", "--source", "-b", "--branch"]);
const FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field"]);

/**
 * @param {string[]} args
 * @returns {{ pos: string[], flags: Map<string, string | true>, fields: { flag: string, value: string }[] }}
 */
function readArgs(args) {
  const pos = [];
  /** @type {Map<string, string | true>} */
  const flags = new Map();
  /** @type {{ flag: string, value: string }[]} */
  const fields = [];
  /** @param {string} f @param {string} v */
  const set = (f, v) => { flags.set(f, v); if (FIELD_FLAGS.has(f)) fields.push({ flag: f, value: v }); };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") { pos.push(...args.slice(k + 1)); break; }
    if (a.startsWith("--") && a.includes("=")) { set(a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)); continue; }
    // a short flag with its value attached: -XPUT, -X=PUT, -Rowner/repo
    const attached = /^(-[A-Za-z])=?(.+)$/.exec(a);
    if (attached && GH_VALUE_FLAGS.has(attached[1])) { set(attached[1], attached[2]); continue; }
    if (a.startsWith("-") && a.length > 1) {
      if (GH_VALUE_FLAGS.has(a) && k + 1 < args.length) { set(a, args[k + 1]); k++; }
      else flags.set(a, true);
      continue;
    }
    pos.push(a);
  }
  return { pos, flags, fields };
}

/** @param {Map<string, string | true>} flags */
const repoFlag = (flags) => {
  const v = flags.get("-R") ?? flags.get("--repo");
  return typeof v === "string" ? v : null;
};

/** `repos/OWNER/REPO/…` → OWNER/REPO; the `{owner}/{repo}` placeholders (gh's current repo) → null. @param {string} p */
function repoOfApiPath(p) {
  const m = /(?:^|\/)repos\/([^/]+)\/([^/]+)\//.exec(p);
  if (!m || m[1].startsWith("{") || m[1].startsWith(":")) return null;
  return `${m[1]}/${m[2]}`;
}

/** Read a file the command names, relative to the session's folder; null when it cannot. @param {string} p @param {string} cwd */
function readLocal(p, cwd) {
  try { return readFileSync(isAbsolute(p) ? p : resolve(cwd, p), "utf8"); } catch { return null; }
}

/**
 * What a command's stdin carries, when the guard can see it: a here-document or here-string, or the text of
 * echo/printf/cat-of-a-here-doc piped in. null = nothing the guard can read.
 * @param {Segment} seg @param {Segment | null} prev @param {State} state
 */
function stdinOf(seg, prev, state) {
  if (seg.stdin.length) return seg.stdin.join("\n");
  if (!prev || seg.stdinFile) return null;
  const pw = commandWords(prev.words, { ...state, vars: state.vars });
  const p = base(pw[0] ?? "");
  if (p === "echo") return pw.slice(1).filter((x, n) => !(n === 0 && /^-[neE]+$/.test(x))).join(" ");
  if (p === "printf") return pw.slice(1).join(" ");
  if (p === "cat" && pw.length === 1 && prev.stdin.length) return prev.stdin.join("\n");
  return null;
}

/**
 * Every merge (and every way of moving main) in a command, with the PR it names. A command with none returns [].
 * @param {string} command
 * @param {number} [depth]
 * @param {{ movedDir?: boolean, cwd?: string }} [opts]
 * @returns {MergeAction[]}
 */
export function findMergeActions(command, depth = 0, opts = {}) {
  /** @type {MergeAction[]} */
  const found = [];
  if (depth > 6) {
    found.push(refuse("too-deep", "the command nests shells too deeply to read")); // refusal:too-deep
    return found;
  }
  /** @type {State} */
  if (depth === 0) WORK.n = 0;
  const state = { movedDir: !!opts.movedDir, vars: new Map() };
  const cwd = opts.cwd ?? process.cwd();
  const segs = tokenize(command);
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    // a command substitution runs even inside a double-quoted word (`echo "$(gh pr merge 5)"`): read it as a command
    for (const sub of seg.subs) found.push(...findMergeActions(sub, depth + 1, { movedDir: state.movedDir, cwd }));
    // a segment of only assignments (`B=main`) records them, so a later `git push origin HEAD:$B` can be read
    if (seg.words.length && seg.words.every((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x) || x === "export")) {
      for (const a of seg.words) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
        if (m && !computed(m[2])) state.vars.set(m[1], m[2]);
      }
      continue;
    }
    const prev = seg.op === "|" && s > 0 ? segs[s - 1] : null;
    /** @type {Env} */
    const env = { depth, state, stdinText: stdinOf(seg, prev, state), cwd };
    found.push(...judgeWords(seg.words, env));
  }
  return found;
}

/**
 * Judge one simple command's words.
 * @param {string[]} words @param {Env} env @returns {MergeAction[]}
 */
function judgeWords(words, env) {
  /** @type {MergeAction[]} */
  const found = [];
  const w = commandWords(words, env.state);
  if (!w.length) return found;
  const prog = base(w[0]);
  if (prog === "cd" || prog === "pushd" || prog === "popd") { env.state.movedDir = true; return found; }
  // a branch switch earlier in the command changes "the current branch's PR" just as a cd does
  if (prog === "gh" && w[1] === "pr" && w[2] === "checkout") env.state.movedDir = true;
  if (prog === "git" && w.some((x) => x === "checkout" || x === "switch" || x === "worktree")) env.state.movedDir = true;
  // GH_REPO=o/r gh pr merge 5 merges in o/r
  const ghRepo = words.slice(0, words.length - w.length).map((x) => /^GH_REPO=(.+)$/.exec(x)?.[1]).find(Boolean) ?? env.state.vars.get("GH_REPO") ?? null; // also `export GH_REPO=…;` earlier
  if (computed(w[0])) {
    // `$GH pr merge 5`, `"$(which gh)" pr merge 5`, `$GIT push origin main`: a program under another name
    found.push(...judgeGh(["gh", ...w.slice(1)], env), ...judgeGit(["git", ...w.slice(1)], env));
    return found;
  }
  if (prog === "gh") return judgeGh(w, env, ghRepo);
  if (prog === "hub") return w[1] === "api" || w[1] === "pr" ? judgeGh(w, env) : judgeGit(w, env); // hub wraps both
  if (prog === "git") return judgeGit(w, env);
  if (SHELLS.has(prog) || prog === "eval" || prog === "source" || prog === ".") return judgeShell(w, env, prog);
  if (INTERPRETERS.test(prog)) return judgeInterpreter(w, env, prog);
  if (INDIRECT.has(prog)) return judgeIndirect(w, env, prog);
  if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https") return judgeHttp(w, env);
  if (TEXT_COMMANDS.has(prog)) return found;
  // an unknown program: if one of its arguments is a program it would run (`arch -arm64 gh pr merge 5`,
  // `op run -- git push origin main`), judge from there; a merge phrase that is only text in its arguments is allowed
  for (let j = 1; j < w.length; j++) {
    const b = base(w[j]);
    if (RUNNERS.has(b) || INTERPRETERS.test(b)) return judgeWords(w.slice(j), env);
  }
  return found;
}

/** @param {string[]} w @param {Env} env @param {string | null} [ghRepo] @returns {MergeAction[]} */
function judgeGh(w, env, ghRepo = null) {
  /** @type {MergeAction[]} */
  const found = [];
  const { pos, flags, fields } = readArgs(w.slice(1));
  const sub = pos.slice(0, 2).join(" ");
  if (pos[0] === "pr" && pos[1] === "merge") {
    if (flags.has("--disable-auto")) return found; // turns auto-merge off: not a merge
    const ref = pos[2] ?? null;
    if (ref && computed(ref)) {
      found.push(refuse("pr-computed", "the PR number comes from a substitution the guard cannot evaluate — write the number itself (`gh pr merge 123`)")); // refusal:pr-computed
      return found;
    }
    found.push({ kind: "pr", ref, repo: repoFlag(flags) ?? ghRepo, via: "gh pr merge", movedDir: env.state.movedDir }); // refusal:gh-pr-merge
    return found;
  }
  if (pos[0] === "api") return judgeGhApi(w, pos, flags, fields, env);
  if (pos[0] === "repo" && pos[1] === "sync" && pos[2]) {
    found.push(refuse("repo-sync", "`gh repo sync <repo>` moves a branch on GitHub without a pull request — open a PR")); // refusal:repo-sync
    return found;
  }
  if (!GH_TEXT.has(sub) && !GH_TEXT.has(pos[0] ?? "") && mergeWords().test(w.slice(1).join(" "))) {
    found.push(refuse("gh-unknown", `\`gh ${sub}\` names a merge in a way the guard cannot read`)); // refusal:gh-unknown
  }
  return found;
}

/**
 * `gh api …`: a write to a merge endpoint, a GraphQL mutation that merges or moves a branch.
 * @param {string[]} w @param {string[]} pos @param {Map<string, string | true>} flags
 * @param {{ flag: string, value: string }[]} fields @param {Env} env @returns {MergeAction[]}
 */
function judgeGhApi(w, pos, flags, fields, env) {
  /** @type {MergeAction[]} */
  const found = [];
  const raw = pos[1] ?? "";
  const endpoint = raw.replace(/^https?:\/\/[^/]+\/(api\/v3\/)?/, "").replace(/^\/+/, "");
  // the request body: every field, and --input; files are read, `-`/`@-` is the stdin the guard can see
  /** @type {string[]} */
  const body = [];
  let unreadable = "";
  for (const f of fields) {
    const v = f.value;
    const at = /^[^=]*=@([\s\S]*)$/.exec(v);
    if ((f.flag === "-F" || f.flag === "--field") && at) {
      const t = at[1] === "-" ? env.stdinText : readLocal(at[1], env.cwd);
      if (t == null) unreadable = at[1];
      else body.push(t);
    } else body.push(v);
  }
  const input = flags.get("--input");
  if (typeof input === "string") {
    const t = input === "-" ? env.stdinText : readLocal(input, env.cwd);
    if (t == null) unreadable = input;
    else body.push(t);
  }
  const method = flags.get("-X") ?? flags.get("--method");
  const writes = typeof method === "string" ? method.toUpperCase() !== "GET" : fields.length > 0 || typeof input === "string";
  if (endpoint === "graphql") {
    if (GRAPHQL_MOVES.test([...w, ...body].join(" "))) {
      found.push(refuse("graphql", "a GraphQL merge (or branch move) cannot be checked — merge with `gh pr merge <number>`")); // refusal:graphql
      return found;
    }
    if (fields.some((f) => /^query=/.test(f.value) && computed(f.value))) {
      found.push(refuse("graphql-computed", "the GraphQL query is built by a substitution or variable the guard cannot read — put the query in the command")); // refusal:graphql-computed
      return found;
    }
    if (unreadable) {
      found.push(refuse("graphql-unreadable", `the GraphQL query comes from ${unreadable === "-" ? "stdin" : `"${unreadable}"`}, which the guard cannot read — put the query in the command`)); // refusal:graphql-unreadable
    }
    return found;
  }
  if (!writes) return found;
  if (computed(endpoint)) {
    found.push(refuse("api-computed", "a write to an endpoint computed by a substitution cannot be checked — write the endpoint out")); // refusal:api-computed
    return found;
  }
  const pm = /(?:^|\/)pulls\/(\d+)\/merge\b/.exec(endpoint);
  if (pm) {
    found.push({ kind: "pr", ref: pm[1], repo: repoOfApiPath(endpoint) ?? repoFlag(flags), via: "gh api pulls/N/merge" }); // refusal:api-pulls-merge
    return found;
  }
  if (/(?:^|\/)pulls\/[^/]+\/merge\b/.test(endpoint)) {
    found.push(refuse("api-merge-noref", "the merge endpoint names no PR number that can be checked")); // refusal:api-merge-noref
    return found;
  }
  if (/\/(merges|merge-upstream)\b/.test(endpoint)) {
    found.push(refuse("merges", "the merges / merge-upstream endpoint moves a branch without a pull request — open a PR")); // refusal:merges
    return found;
  }
  if (new RegExp(`git/refs/heads/${esc(BRANCH)}(?:$|[?#/])`).test(endpoint)) {
    found.push(refuse("ref-main", `writing refs/heads/${BRANCH} moves ${BRANCH} without a pull request — open a PR`)); // refusal:ref-main
    return found;
  }
  if (/git\/refs\/?$/.test(endpoint) && new RegExp(`refs/heads/${esc(BRANCH)}\\b`).test(body.join(" "))) {
    found.push(refuse("ref-create-main", `creating refs/heads/${BRANCH} moves ${BRANCH} without a pull request — open a PR`)); // refusal:ref-create-main
    return found;
  }
  if (/\/contents\//.test(endpoint)) {
    const all = body.join("\n");
    const branch = /(?:^|\n)branch=([^\n]*)/.exec(body.join("\n")) ?? /"branch"\s*:\s*"([^"]*)"/.exec(all);
    if (!branch || new RegExp(`^(refs/heads/)?${esc(BRANCH)}$`).test(branch[1]) || computed(branch[1])) {
      found.push(refuse("contents", `a contents-API write commits straight to ${BRANCH} (or the default branch) — commit on a branch and open a PR`)); // refusal:contents
    }
  }
  return found;
}

/** @param {string[]} w @param {Env} env @returns {MergeAction[]} */
function judgeGit(w, env) {
  /** @type {MergeAction[]} */
  const found = [];
  // git's own options before the subcommand: -C <dir>, -c <k=v>, --git-dir=…; `-c alias.x=…` defines a command
  /** @type {Map<string, string>} */
  const aliases = new Map();
  let k = 1;
  while (k < w.length && w[k].startsWith("-")) {
    const a = w[k];
    if (a === "-c") {
      const m = /^alias\.([^=]+)=([\s\S]*)$/.exec(w[k + 1] ?? "");
      if (m) aliases.set(m[1], m[2]);
      k += 2;
      continue;
    }
    k += ["-C", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"].includes(a) ? 2 : 1;
  }
  let sub = w[k] ?? "";
  let rest = w.slice(k + 1);
  const alias = aliases.get(sub);
  if (alias != null) {
    if (alias.startsWith("!")) return findMergeActions(`${alias.slice(1)} ${rest.map(shq).join(" ")}`, env.depth + 1, { movedDir: env.state.movedDir, cwd: env.cwd });
    const t = tokenize(alias).flatMap((g) => g.words);
    sub = t[0] ?? "";
    rest = [...t.slice(1), ...rest];
  }
  if (sub === "push") return judgePush(rest, env);
  if (sub === "send-pack" || sub === "http-push" || (sub === "subtree" && rest[0] === "push")) {
    const args = (sub === "subtree" ? rest.slice(1) : rest).filter((a) => !a.startsWith("-"));
    if (args.slice(1).some((spec) => isMain(dstOf(spec, env)))) {
      found.push(refuse("git-send-main", `\`git ${sub}\` to ${BRANCH} skips the pull request and its checks — push a branch and open a PR`)); // refusal:git-send-main
    }
    return found;
  }
  if (!GIT_TEXT.has(sub) && mergeWords().test(rest.join(" "))) {
    found.push(refuse("git-unknown", `\`git ${sub}\` names a merge or ${BRANCH} in a way the guard cannot read`)); // refusal:git-unknown
  }
  return found;
}

/** Expand `$X` / `${X}` from assignments made earlier in the same command. @param {string} s @param {Env} env */
function expandVars(s, env) {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => env.state.vars.get(a ?? b) ?? m);
}
/** The destination of a refspec (`+src:dst` → dst; `name` → name). @param {string} spec @param {Env} env */
function dstOf(spec, env) {
  const s = expandVars(spec, env).replace(/^\+/, "");
  return s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
}
/** The protected branch, as git would resolve a destination: main, heads/main, refs/heads/main. @param {string} d */
const isMain = (d) => new RegExp(`^(refs/)?(heads/)?${esc(BRANCH)}$`).test(d);

/** @param {string[]} args @param {Env} env @returns {MergeAction[]} */
function judgePush(args, env) {
  /** @type {MergeAction[]} */
  const found = [];
  if (args.some((a) => a === "--mirror" || a === "--all" || a === "--branches")) {
    found.push(refuse("push-all", `\`git push --all/--mirror\` can move ${BRANCH} without a pull request`)); // refusal:push-all
  }
  const pos = [];
  let repoGiven = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "--") { pos.push(...args.slice(j + 1)); break; }
    if (a === "--repo") { repoGiven = true; j++; continue; }
    if (a.startsWith("--repo=")) { repoGiven = true; continue; }
    if (a === "-o" || a === "--push-option" || a === "--receive-pack" || a === "--exec") { j++; continue; }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  for (const spec of repoGiven ? pos : pos.slice(1)) {
    const dst = dstOf(spec, env);
    const pre = dst.split("*")[0];
    const wildMain = dst.includes("*") && [BRANCH, `heads/${BRANCH}`, `refs/heads/${BRANCH}`].some((m) => m.startsWith(pre));
    if (isMain(dst) || dst === "" || wildMain) {
      found.push(refuse("push-main", `a direct push to ${BRANCH} skips the pull request and its checks — push a branch and open a PR`)); // refusal:push-main
      break;
    }
  }
  return found;
}

/** `bash -c '…'`, `sh -lc "…"`, `eval …`, a here-doc or echo piped into a shell. @param {string[]} w @param {Env} env @param {string} prog */
function judgeShell(w, env, prog) {
  const again = /** @param {string} s */ (s) => findMergeActions(s, env.depth + 1, { movedDir: env.state.movedDir, cwd: env.cwd });
  if (prog === "eval") return again(w.slice(1).join(" "));
  if (prog === "source" || prog === ".") return w[1] === "/dev/stdin" && env.stdinText != null ? again(env.stdinText) : [];
  let cflag = false;
  let readsStdin = false;
  let k = 1;
  if (prog === "busybox") k = 2; // `busybox sh -c …`
  for (; k < w.length; k++) {
    const a = w[k];
    if (a === "--") { k++; break; }
    if (a === "-o" || a === "+o" || a === "-O" || a === "+O" || a === "--rcfile" || a === "--init-file") { k++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { cflag = true; continue; }
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) { readsStdin = true; continue; }
    if (/^[-+]/.test(a)) continue;
    break;
  }
  if (cflag && computed(w[k] ?? "") && mergeWords().test(w.join(" "))) {
    return [refuse("shell-computed", `\`${prog} -c\` runs a command built by a substitution that names a merge — run \`gh pr merge <number>\` on its own`)]; // refusal:shell-computed
  }
  if (cflag) return again(w[k] ?? "");
  if ((k >= w.length || readsStdin || w[k] === "-") && env.stdinText != null) return again(env.stdinText);
  return []; // a script file: stated as unseen in the header
}

/**
 * `python3 -c '…'`, `node -e '…'`, a here-doc fed to `python3 -`: refused only when the code starts a process AND
 * a merge sits in one of its strings, or it calls GitHub's API at a merge endpoint. A Python edit of a notes file
 * that mentions merging starts no process, so it is allowed.
 * @param {string[]} w @param {Env} env @param {string} prog @returns {MergeAction[]}
 */
function judgeInterpreter(w, env, prog) {
  /** @type {MergeAction[]} */
  const found = [];
  /** @type {string[]} */
  const codes = [];
  const py = /^(python|pypy)/.test(prog);
  const perlish = /^(perl|ruby)/.test(prog);
  let script = null;
  let k = 1;
  if (prog === "deno" && w[1] === "eval") { codes.push(w[2] ?? ""); k = w.length; }
  for (; k < w.length; k++) {
    const a = w[k];
    const isCode = py ? /^-[A-Za-z]*c$/.test(a)
      : perlish ? /^-[A-Za-z]*[eE]$/.test(a)
        : prog === "php" ? a === "-r"
          : prog === "osascript" ? a === "-e"
            : ["-e", "--eval", "-p", "--print"].includes(a);
    if (isCode) { codes.push(w[k + 1] ?? ""); k++; if (py) break; continue; }
    if (a === "-") { script = "-"; break; }
    if (a === "--") { script = w[k + 1] ?? null; break; }
    if (a.startsWith("-")) { if (["-m", "-W", "-X", "-r", "--require", "--import", "-I"].includes(a)) { if (a === "-m") { script = w[k + 1] ?? ""; break; } k++; } continue; }
    script = a;
    // a script file the guard cannot read, handed a command as its arguments: judge those
    for (let j = k + 1; j < w.length; j++) {
      const b = base(w[j]);
      if (RUNNERS.has(b)) {
        if (judgeWords(w.slice(j), { ...env, state: { movedDir: true, vars: env.state.vars } }).length) {
          found.push(refuse("script-args", `\`${prog} ${a}\` is handed a merge as its arguments, which the guard cannot check — run \`gh pr merge <number>\` on its own`)); // refusal:script-args
        }
        return found;
      }
    }
    break;
  }
  if (!codes.length && (script == null || script === "-") && env.stdinText != null) codes.push(env.stdinText);
  for (const code of codes) {
    if (codeMerges(code, env, perlish || prog === "php")) {
      found.push(refuse("interpreter", `a merge started from inside ${prog} code cannot be checked — run \`gh pr merge <number>\` on its own`)); // refusal:interpreter
      break;
    }
  }
  return found;
}

/**
 * Does this inline code merge? It must start a process (or call GitHub's API), and one of its strings — alone, or a
 * list of strings joined as an argument vector — must be a merge when read as a shell command.
 * @param {string} code @param {Env} env @param {boolean} backticksRun
 */
function codeMerges(code, env, backticksRun) {
  if (/api\.github\.com|\/api\/graphql/.test(code) && HTTP_CODE.test(code)
    && (mergeWords().test(code) || GRAPHQL_MOVES.test(code) || /\/contents\//.test(code))) return true;
  if (!(SPAWNS.test(code) || (backticksRun && /`/.test(code)))) return false;
  const lits = [...code.matchAll(/(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g)];
  /** @type {string[][]} */
  const runs = [];
  let last = -1;
  for (const m of lits) {
    const idx = m.index ?? 0;
    const text = m[2].replace(/\\(["'`\\])/g, "$1");
    // `["gh", "pr", "merge", "5"]` and `execFileSync("gh", ["pr", "merge", "5"])` are one argument vector
    if (runs.length && /^(?=[^]*,)[\s,[]*$/.test(code.slice(last, idx))) runs[runs.length - 1].push(text);
    else runs.push([text]);
    last = idx + m[0].length;
  }
  const lone = SHELL_STRING.test(code) || (backticksRun && /`/.test(code));
  // a program name standing alone ("gh", "git") with its arguments built elsewhere in the code:
  // read every other string as that program's arguments
  const progs = runs.filter((r) => r.length === 1 && /^(gh|git|hub)$/.test(r[0])).map((r) => r[0]);
  for (const p of progs) {
    for (const run of runs) {
      if (run.length === 1 && run[0] === p) continue;
      const args = run.length === 1 ? run[0] : run.map(shq).join(" ");
      if (findMergeActions(`${p} ${args}`, env.depth + 1, { movedDir: true, cwd: env.cwd }).length) return true;
    }
  }
  for (const run of runs) {
    if (run.length === 1 && !lone) continue; // a lone string is a command only when a shell runs it
    const asCommand = run.length === 1 ? run[0] : run.map(shq).join(" ");
    if (findMergeActions(asCommand, env.depth + 1, { movedDir: true, cwd: env.cwd }).length) return true;
  }
  return false;
}

/**
 * `xargs gh pr merge`, `find … -exec gh pr merge {} ;`, `ssh host 'gh pr merge 5'`, `watch 'gh pr merge 5'`: the PR
 * comes from elsewhere, or the command runs somewhere the guard cannot follow — refused when what it runs merges.
 * @param {string[]} w @param {Env} env @param {string} prog @returns {MergeAction[]}
 */
function judgeIndirect(w, env, prog) {
  /** @type {MergeAction[]} */
  const found = [];
  const inner = { ...env, depth: env.depth + 1, stdinText: null, state: { movedDir: true, vars: env.state.vars } };
  /** @type {MergeAction[]} */
  let hits = [];
  if (prog === "find") {
    for (let j = 1; j < w.length; j++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(w[j])) continue;
      let e = j + 1;
      while (e < w.length && w[e] !== ";" && w[e] !== "+") e++;
      hits.push(...judgeWords(w.slice(j + 1, e), inner));
      j = e;
    }
  } else if (prog === "xargs") {
    const vals = ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--replace"];
    let k = 1;
    while (k < w.length && w[k].startsWith("-")) k += vals.includes(w[k]) ? 2 : 1;
    hits = judgeWords(w.slice(k), inner);
  } else {
    // the rest of the words, read again as one command line (ssh, watch, su -c, tmux, script … all hand it to a shell)
    hits = findMergeActions(w.slice(1).join(" "), env.depth + 1, { movedDir: true, cwd: env.cwd });
    for (const x of w.slice(1)) if (/\s/.test(x)) hits.push(...findMergeActions(x, env.depth + 1, { movedDir: true, cwd: env.cwd }));
  }
  if (hits.length) {
    found.push(refuse("indirect", `a merge run through \`${prog}\` cannot be checked — run \`gh pr merge <number>\` directly`)); // refusal:indirect
  }
  return found;
}

/** curl/wget/httpie straight at GitHub's API. @param {string[]} w @param {Env} env @returns {MergeAction[]} */
function judgeHttp(w, env) {
  /** @type {MergeAction[]} */
  const found = [];
  const text = [...w, env.stdinText ?? ""].join(" ");
  if (/api\.github\.com|github\.com\/api/.test(text) && (mergeWords().test(text) || /graphql|\/contents\//.test(text))) {
    found.push(refuse("http", "a merge sent straight to GitHub's API cannot be checked — use `gh pr merge <number>`")); // refusal:http
  }
  return found;
}

// ── 3. Judging the checks ───────────────────────────────────────────────────────────────────────────────────────

/** A PR reference → its number and repo, when it can be read without asking GitHub. @param {string} ref */
export function parsePrRef(ref) {
  if (/^#?\d+$/.test(ref)) return { number: Number(ref.replace("#", "")), repo: null };
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(ref);
  if (m) return { number: Number(m[3]), repo: `${m[1]}/${m[2]}` };
  return null; // a branch name: GitHub has to say which PR
}

/**
 * The decision on one PR's checks (the output of `gh pr checks N --json name,state,bucket,workflow`).
 * Every required check must be reported by the required workflow and pass; a `may_skip` check may be skipped.
 * @param {unknown} checks
 * @param {RequiredSpec} spec
 * @returns {{ ok: true } | { ok: false, check: string | null, why: string }}
 */
export function decideChecks(checks, spec) {
  if (!Array.isArray(checks)) return { ok: false, check: null, why: "GitHub did not return a list of checks" }; // refusal:checks-not-list
  /** @type {{ check: string, why: string, rank: number }[]} */
  const bad = [];
  for (const req of spec.required) {
    /** @type {CheckRow[]} */
    const wf = req.workflow ?? spec.workflow; // no workflow named = a check of that name from any workflow counts
    const rows = checks.filter((c) => c && typeof c === "object" && c.name === req.name && (wf == null || c.workflow === wf));
    if (!rows.length) {
      bad.push({ check: req.name, why: "has not reported (not started, or missing)", rank: 2 }); // refusal:check-missing
      continue;
    }
    for (const r of rows) {
      const b = String(r.bucket ?? "").toLowerCase();
      if (b === "pass") continue;
      if (b === "skipping" && req.may_skip) continue;
      /** @type {Record<string, [string, number]>} */
      const states = { skipping: ["was skipped, and it must run", 1], pending: ["is still running", 3], fail: ["failed", 0], cancel: ["was cancelled", 0] };
      const [why, rank] = states[b] ?? [`is in an unknown state (${r.bucket ?? r.state ?? "none"})`, 1];
      bad.push({ check: req.name, why, rank }); // refusal:check-not-passing
      break;
    }
  }
  if (!bad.length) return { ok: true };
  bad.sort((a, b) => a.rank - b.rank);
  const more = bad.length > 1 ? ` (+${bad.length - 1} more not passing)` : "";
  return { ok: false, check: bad[0].check, why: `required check "${bad[0].check}" ${bad[0].why}${more}` };
}

// ── 4. Asking GitHub (injectable, so the tests need no network) ─────────────────────────────────────────────────

/** @typedef {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} GhRunner */

/** Total time the guard may spend asking GitHub (one process = one hook call). */
export const GH_BUDGET_MS = 75_000;
const GH_DEADLINE = Date.now() + GH_BUDGET_MS;

/**
 * Run gh in the session's folder (the hook input's `cwd`), so "the current branch's PR" is the session's branch.
 * @param {string[]} args @param {string} [cwd]
 */
export const realGh = (args, cwd) => {
  // The whole guard stays inside GH_BUDGET_MS, well under the hook's own `timeout` in .claude/settings.json (120 s):
  // a hook that hits Claude Code's limit is a NON-blocking error, so running out here must refuse instead.
  const left = GH_DEADLINE - Date.now();
  if (left < 1_000) return { ok: false, stdout: "", stderr: "the guard's time budget for asking GitHub ran out" };
  try {
    const stdout = execFileSync("gh", args, { encoding: "utf8", timeout: Math.min(25_000, left), stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    const err = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (e);
    return { ok: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr || err.message || "gh failed") };
  }
};

/** First line of a message, trimmed (the refusal is one line). @param {string} s */
const firstLine = (s) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200);

/**
 * The whole decision for one hook call. Returns null to allow, or the one-line refusal.
 * @param {string} command
 * `deps.notice` receives the one-line "nothing was checked" notice of the no-CI-yet stage (an empty `required` list).
 * @param {{ gh?: GhRunner, spec?: RequiredSpec, specPath?: string, cwd?: string, notice?: (m: string) => void }} [deps]
 * @returns {string | null}
 */
export function guardCommand(command, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const gh = deps.gh ?? ((/** @type {string[]} */ args) => realGh(args, cwd));
  /** @type {RequiredSpec | null} */
  let spec = deps.spec ?? null;
  let specError = "";
  if (!spec) {
    try { spec = loadRequiredSpec(deps.specPath); } catch (e) { specError = firstLine(String(/** @type {Error} */ (e)?.message ?? e)); }
  }
  BRANCH = spec?.branch ?? "main";
  WORK.n = 0;
  const actions = findMergeActions(command, 0, { cwd });
  if (!actions.length) return null;
  if (!spec) {
    return `BLOCKED (merge guard): the required-check list could not be read (${specError}) — every merge and every push to ${BRANCH} is refused until .claude/required-checks.json is back.`; // refusal:no-spec
  }
  if (!spec.required.length) {
    // the "no CI yet" stage: nothing to wait for, so nothing is refused — but say so every time
    deps.notice?.(`merge guard: no required checks are listed yet in .claude/required-checks.json, so this merge or push to ${BRANCH} went ahead unchecked. Once the project has CI, the owner names its checks there and the guard starts refusing red merges.`);
    return null;
  }
  const names = spec.required.map((r) => r.name).join(", ");
  const tail = `merge only when every required check passes (${names}; .claude/required-checks.json).`;
  for (const a of actions) {
    if (a.kind === "refuse") return `BLOCKED (merge guard): ${a.why}.`; // refusal:report-refusal
    // a branch switch anywhere in the command — even in a child shell, since it changes the checkout itself — makes
    // "the current branch's PR" unreadable from here
    if (!a.ref && (a.movedDir || /\b(checkout|switch|worktree|symbolic-ref)\b|\bbranch\s+-[mMcC]\b|\bGIT_DIR=/.test(command))) {
      return `BLOCKED (merge guard): name the PR — \`gh pr merge <number>\` — since the command changes folder first, so "the current branch's PR" cannot be read from here; ${tail}`; // refusal:moved-dir
    }
    const parsed = a.ref ? parsePrRef(a.ref) : null;
    const repo = parsed?.repo ?? a.repo;
    const repoArgs = repo ? ["-R", repo] : [];
    /** @type {number | null} */
    let number = parsed ? parsed.number : null;
    if (number == null) {
      // a branch name, or no PR named at all (`gh pr merge` merges the current branch's PR — ask gh the same way)
      const v = gh(["pr", "view", ...(a.ref ? [a.ref] : []), ...repoArgs, "--json", "number"]);
      try { number = v.ok ? Number(JSON.parse(v.stdout).number) || null : null; } catch { number = null; }
      if (number == null) return `BLOCKED (merge guard): could not find the PR for "${a.ref ?? "the current branch"}" (gh: ${firstLine(v.stderr) || "no answer"}) — refusing, since its checks cannot be read.`; // refusal:no-pr
    }
    const r = gh(["pr", "checks", String(number), ...repoArgs, "--json", "name,state,bucket,workflow"]);
    /** @type {unknown} */
    let rows;
    try { rows = JSON.parse(r.stdout); } catch { rows = undefined; }
    if (!Array.isArray(rows)) {
      return `BLOCKED (merge guard): PR #${number} — could not read its checks (gh: ${firstLine(r.stderr) || firstLine(r.stdout) || "no answer"}); refusing rather than guessing.`; // refusal:checks-unreadable
    }
    const d = decideChecks(rows, spec);
    if (!d.ok) return `BLOCKED (merge guard): PR #${number} — ${d.why}; ${tail}`; // refusal:checks-red
  }
  return null;
}

/** The hook's stdin (Claude Code's PreToolUse JSON) → the Bash command, or null when it is not one. @param {string} raw */
export function commandFromHookInput(raw) {
  const j = JSON.parse(raw);
  const c = j?.tool_input?.command;
  return typeof c === "string" ? c : null;
}

/** The session's folder from the hook's stdin (Claude Code sends `cwd`), or null. @param {string} raw */
export function cwdFromHookInput(raw) {
  try { const c = JSON.parse(raw)?.cwd; return typeof c === "string" && c ? c : null; } catch { return null; }
}

/** The hook's entry: read stdin, decide, exit 0 (allow) or 2 (block). Called unconditionally by ../merge-guard.mjs
 *  — never behind an "am I the main module?" test, which can read false through a symlinked path and so fail OPEN. */
export function main() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
  let command;
  try { command = commandFromHookInput(raw); }
  catch {
    process.stderr.write("BLOCKED (merge guard): could not read the hook input, so the command could not be checked.\n");
    process.exit(2);
  }
  if (command == null) process.exit(0);
  let refusal;
  /** @type {string | null} */
  let notice = null;
  try { refusal = guardCommand(command, { cwd: cwdFromHookInput(raw) ?? process.cwd(), notice: (m) => { notice = m; } }); }
  catch (e) {
    process.stderr.write(`BLOCKED (merge guard): the guard itself failed (${firstLine(String(/** @type {Error} */ (e)?.message ?? e))}); refusing.\n`);
    process.exit(2);
  }
  if (refusal) { process.stderr.write(refusal + "\n"); process.exit(2); }
  // allowed: the no-CI-yet notice goes to the user as a system message (Claude Code reads JSON on stdout at exit 0)
  if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice }) + "\n");
  process.exit(0);
}
