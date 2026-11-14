// review-install-closure.test.mjs — LEAD-CALLS L92 item 4 and L106 M-1: the install closure.
//
// WHY. The LaunchDaemons start the review runner, the account copy and the updater from the installed copy, which the
// updater makes from main's `orchestrate/` plus a short list of outside files (install-check.mjs OUTSIDE_FILES). An
// import that reaches a file the updater does not install (M6 gather.mjs and M10 policy.mjs import Bob's
// scripts/blueprint/yaml-lite.mjs) fails only on the Mac, at the first run, with ERR_MODULE_NOT_FOUND: no review ever
// starts. Here a repository is made from this checkout's own orchestrate/ and scripts/ files, the real updater
// installs it as on the Mac (owner = this test's uid, `top` = the test folder), and then the repository it was made
// from, the bare origin and the updater's clone are deleted. Every non-test module of the copy is then imported for
// real by node, one child process each, named through the copy's link as the plists name their scripts. A load hook in
// the child lists every file node loads; each must be inside the copy's versioned folder (so an import that names this
// checkout by an absolute path fails too).
//
// What a real import cannot see, two scans read (L106 M-1 (b), (c)): an `import()` or require that runs only later,
// whose target is not a plain string (only a module the config names, on CONFIG_IMPORTS, may be), and a path written in the
// code that leads from the module's folder out of orchestrate/ to a file the updater does not install. The scans read
// code through a small reader (`lex`) that knows strings, templates, regular expressions and comments, so text inside
// a string can't hide code from them, and code can't hide inside what looks like a comment. The reader is itself
// checked against node: for every module, the files its static imports reach, as the reader finds them, are exactly
// the files node loaded.
//
// What the scans do not see (audit r2 m-a): a path built from pieces ('../../' + '../x'), a dirname(dirname(...))
// chain, a template that starts `${import.meta.dirname}/../`, a lazy import() of a package name or of an absolute path.
// None of these shapes is in the code today; each would fail only when its code runs, not at load.
//
// Started as launchd starts it (L132 M-2): every program a LaunchDaemon or the Dispatcher's job starts (ENTRY_POINTS)
// is run by node from the installed copy, named through the copy's link as the plist names it, with no arguments. Each
// must refuse: a non-zero exit and a message saying why. A program whose start check compares the link path with its
// own real path, without resolving the link, takes itself for an imported module there, and exits 0 with nothing
// said, every time it is started; importing it can't show that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, realpathSync, statSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { gitOk } from '../git/safe-git.mjs';
import { SCRIPTS, reviewDaemonPlists, updaterPlist } from './review-daemons.mjs';
import { NODE, UPDATER_CONFIG, RUNNER_CONFIG, STAMP, SOURCE, OUTSIDE_FILES, TEST_FOLDERS, currentCopy, readInstallStamp } from './install-check.mjs';
import { loginJobPlist } from '../../M11-dispatcher/login-job.mjs';
import { watchPlist } from '../../../setup/watch-setup.mjs';
import { robotPlist, ROBOT_MAIN } from '../../../setup/robot-setup.mjs';
import { dispatcherPlist } from '../../../setup/dispatcher-setup.mjs';
import { sensorsPlist } from '../../../setup/sensors-setup.mjs';
import { ownerJobPlist, OWNER_SCRIPT } from '../../../setup/owner-answer-setup.mjs';
import { copierPlist, COPIER_SCRIPT } from '../../../setup/host-lock-copy.mjs';
import { sensorsJobPlist } from '../../M12-sensors/sensors-job.mjs';
import { workerRunnerPlist } from '../../../wiring/runner-job.mjs';
import { wallPlist } from '../../../setup/builder-wall.mjs';
import { updateOnce, MAIN } from './review-updater.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ME = process.getuid();
const ID = [['user.name', 'test'], ['user.email', 'test@example.invalid']];
const GIT = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// The only `import()` calls whose target is not a plain string: a module named by its program's config, the wiring
// (M11's and the review runner's) and the runner's budget module (check 12's inputs, L83 M-3). The runner's own check
// (`programsProblem`) refuses a wiring or a budget module outside the installed copy or not root's alone, and a module
// of the repository that one of them names is imported for real here like every other. Each is listed with its file
// and its exact call, so a second computed import in the same file is still refused, and an entry no longer in its
// file fails.
const CONFIG_IMPORTS = Object.freeze([
  ['modules/M11-dispatcher/main.mjs', 'import(pathToFileURL(config.wiring).href)'],
  ['modules/M12-sensors/loop.mjs', 'import(pathToFileURL(config.wiring).href)'], // R-0b-169: the Sensors job's wiring, named like M11's
  ['wiring/robot-main.mjs', 'import(pathToFileURL(config.wiring).href)'],
  ['modules/M4-workshop/launcher/review-runner-main.mjs', 'import(pathToFileURL(c.wiring).href)'],
  ['modules/M4-workshop/launcher/review-runner-main.mjs', 'import(pathToFileURL(c.budget).href)'],
  ['wiring/runner-main.mjs', 'import(pathToFileURL(file).href)'], // L1001: the worker runner's budget module, as the review runner's
]);
// Every program a job file starts from the installed copy (L132 M-2), taken from the job files themselves (L136 m1):
// each module of the copy that builds a launchd job file is called here with a sample config, and the script each job
// starts is read from the file's start command (ProgramArguments). A new builder must be added to JOB_BUILDERS: the
// tripwire test below fails while any module of the copy that writes a start command is missing from it.
const SAMPLE_BASE = '/sample';
const SAMPLE_ROOT = join(SAMPLE_BASE, 'install', SOURCE);   // where setup/install.mjs installPaths puts the copy's link
const LABEL = 'org.example.orch';
// The Dispatcher's job file takes its script from its caller, and no setup step calls it yet (the first cutover
// does): until one does, the script it is given is named here.
const DISPATCHER_MAIN = 'modules/M11-dispatcher/main.mjs';
// The Sensors loop's job file also takes its script from its caller (sensors-job.mjs), and the caller that will give it
// is not written yet either, so the script it starts is named here (L734 self-review c2).
const SENSORS_LOOP = 'modules/M12-sensors/loop.mjs';
const RUNNER_MAIN = 'wiring/runner-main.mjs';
const JOB_BUILDERS = Object.freeze({
  'modules/M4-workshop/launcher/review-daemons.mjs': () => [
    ...Object.values(reviewDaemonPlists({ label: LABEL, installRoot: SAMPLE_ROOT, config: join(SAMPLE_ROOT, RUNNER_CONFIG), reviewRoot: join(SAMPLE_BASE, 'review'),
      reviewHome: join(SAMPLE_BASE, 'home', 'review'), accountCopy: join(SAMPLE_BASE, 'account-copy.json'), ownerHome: join(SAMPLE_BASE, 'owner-home'), ownerUid: 1000, logDir: join(SAMPLE_BASE, 'logs') })),
    updaterPlist({ label: LABEL, installRoot: SAMPLE_ROOT, logDir: join(SAMPLE_BASE, 'logs') }),
  ],
  'setup/watch-setup.mjs': () => [watchPlist(null, { base: SAMPLE_BASE, label: LABEL, watch: { repo: 'owner/repo', rulesSha256: '0'.repeat(64) } })],
  'modules/M11-dispatcher/login-job.mjs': () => [loginJobPlist({ label: LABEL, node: join(SAMPLE_ROOT, NODE), script: join(SAMPLE_ROOT, DISPATCHER_MAIN),
    config: join(SAMPLE_BASE, 'dispatcher.json'), path: '/usr/bin:/bin', logDir: join(SAMPLE_BASE, 'logs'), workDir: SAMPLE_BASE })],
  // L734: the robot job's file is built through loginJobPlist, so its module never names a start command itself and the
  // tripwire below can't find it; it is listed by hand, and its script (robot-main) is started like the others.
  'setup/robot-setup.mjs': () => [robotPlist({ base: SAMPLE_BASE, label: LABEL })],
  // L877: setup's Dispatcher job (#343) is built the same way, through loginJobPlist.
  'setup/dispatcher-setup.mjs': () => [dispatcherPlist({ base: SAMPLE_BASE, label: LABEL })],
  // L734 self-review M1: the Sensors loop's job is built the same way, through loginJobPlist.
  'modules/M12-sensors/sensors-job.mjs': () => [sensorsJobPlist({ label: LABEL, node: join(SAMPLE_ROOT, NODE), script: join(SAMPLE_ROOT, SENSORS_LOOP),
    config: join(SAMPLE_BASE, 'sensors.json'), path: '/usr/bin:/bin', logDir: join(SAMPLE_BASE, 'logs'), workDir: SAMPLE_BASE })],
  // L1049: setup's Sensors job is built through the Sensors loop's own builder, which is built through loginJobPlist.
  'setup/sensors-setup.mjs': () => [sensorsPlist({ base: SAMPLE_BASE, label: LABEL })],
  // L1051: the owner's answer job, in the owner's own LaunchAgents, through loginJobPlist.
  'setup/owner-answer-setup.mjs': () => [ownerJobPlist({ base: SAMPLE_BASE, label: LABEL }, { home: join(SAMPLE_BASE, 'owner-home') })],
  // L874: the worker runner's LaunchAgent is built the same way, through loginJobPlist (#364, #378).
  'wiring/runner-job.mjs': () => [workerRunnerPlist({ label: LABEL, node: join(SAMPLE_ROOT, NODE), script: join(SAMPLE_ROOT, RUNNER_MAIN),
    config: join(SAMPLE_BASE, 'runner.json'), path: '/usr/bin:/bin', logDir: join(SAMPLE_BASE, 'logs'), workDir: SAMPLE_BASE, home: join(SAMPLE_BASE, 'home', 'builder') })],
  // L1029 E: the owner's host.lock copier, a LaunchAgent built the same way, through loginJobPlist.
  'setup/host-lock-copy.mjs': () => [copierPlist({ label: LABEL, installRoot: SAMPLE_ROOT, node: NODE, configPath: join(SAMPLE_BASE, 'setup.json'),
    copy: join(SAMPLE_BASE, 'owner-home', '.orchestrate', 'host.lock'), home: join(SAMPLE_BASE, 'owner-home') })],
});
// R-0b-179: modules that name a start command but start no script of the copy, so nothing they start goes through the
// link above. Each is checked below: a job builder here must still start no copy script, and a reader must write none.
const NO_COPY_SCRIPT = Object.freeze({
  // The pf wall's LaunchDaemon runs /bin/sh with its own script text, as root, and loads no module of the copy.
  'setup/builder-wall.mjs': () => [wallPlist({ base: SAMPLE_BASE, label: LABEL })],
});
const READS_JOB_FILES = Object.freeze({
  'shared/credential-args.mjs': 'the no-credential-as-argument scan reads every job file\'s start command; it builds none',
});
/** The one script of the copy a job file starts: the .mjs file under the copy's link in its start command. */
function startedScript(text) {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  assert.ok(args, `a job file with no start command: ${text.slice(0, 200)}`);
  const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const scripts = strings.filter((s) => s.startsWith(`${SAMPLE_ROOT}/`) && s.endsWith('.mjs')).map((s) => s.slice(SAMPLE_ROOT.length + 1));
  assert.equal(scripts.length, 1, `each job starts exactly one script of the copy: ${strings.join(' ')}`);
  return scripts[0];
}
// Builders that write their start command through another listed builder (so they never name one themselves), each with
// the builder it uses; the tripwire checks each still imports it.
const BUILT_THROUGH = Object.freeze({ 'setup/robot-setup.mjs': 'modules/M11-dispatcher/login-job.mjs', 'setup/dispatcher-setup.mjs': 'modules/M11-dispatcher/login-job.mjs', 'modules/M12-sensors/sensors-job.mjs': 'modules/M11-dispatcher/login-job.mjs', 'wiring/runner-job.mjs': 'modules/M11-dispatcher/login-job.mjs',
  'setup/owner-answer-setup.mjs': 'modules/M11-dispatcher/login-job.mjs', 'setup/sensors-setup.mjs': 'modules/M12-sensors/sensors-job.mjs',
  'setup/host-lock-copy.mjs': 'modules/M11-dispatcher/login-job.mjs' });
// The functions that build a job file's text, each with the module that exports it (L734 self-review M1; #352 m1, r2 M1).
// The scan reads each module of the copy through lex() below, so comments, strings and template text are never read as
// code. A module that brings a builder in, by a named import or re-export (`import { … } from`, `import d, { … } from`,
// `export { … } from`), by `import * as` / `import d, * as` / `export * from` its module, or by an `import()` of its
// module named by a plain string or a backtick string with no `${}`, anywhere on a line, is a builder through it
// (BUILT_THROUGH) or only writes the files it is given (USES_JOB_FILES), and must be on one list or the other. A name
// may be written as a string (`{ "loginJobPlist" as lj }`), with `\u` / `\u{…}` escapes, or with `\x` escapes in a
// quoted name. A line comment, and the hashbang line, end at LF, a lone CR, U+2028 or U+2029, as in JavaScript. What the
// scan does not see:
// - other spellings of a quoted name: an identity escape (`"\l…"`), a line continuation inside it, or a quoted name
//   followed by `as` with no space (`"x"as y`);
// - an `import()` whose name is built at run time (`${}`, `+`, `new URL(…)`); hiddenLoads refuses those unless
//   CONFIG_IMPORTS lists them;
// - a path spelled other than as the lists spell it (percent-encoded, another letter case, a `file:` URL), since paths
//   are joined as written (the L92 check, that the reader and node load the same files, catches a lone such import);
// - a module that imports a builder through a re-exporter. An unlisted re-exporter is caught itself, but one already on
//   a list (say setup/daemons.mjs) can add a re-export, and a new module importing from it is then not flagged;
// - `import defer * as m from …` (a capability note: Node v26.7.0 rejects that syntax, so it can't load today; revisit
//   when node ships import defer).
const JOB_FILE_FNS = Object.freeze({ loginJobPlist: 'modules/M11-dispatcher/login-job.mjs', watchPlist: 'setup/watch-setup.mjs',
  reviewDaemonPlists: 'modules/M4-workshop/launcher/review-daemons.mjs', updaterPlist: 'modules/M4-workshop/launcher/review-daemons.mjs',
  sensorsJobPlist: 'modules/M12-sensors/sensors-job.mjs', robotPlist: 'setup/robot-setup.mjs', dispatcherPlist: 'setup/dispatcher-setup.mjs', workerRunnerPlist: 'wiring/runner-job.mjs', copierPlist: 'setup/host-lock-copy.mjs' });
const USES_JOB_FILES = Object.freeze({ 'setup/daemons.mjs': 'places the job files the listed builders make; it builds none of its own',
  'setup/setup.mjs': 'prints the copier\'s job file (host-lock-copier, L1029 E) for the owner to place; it builds none of its own' });
/**
 * The job-file functions module `r`'s real imports bring in, each with the module (copy-relative) it imports them
 * from. An `import * as` or an `import()` of a builder's module brings in every function that module exports.
 */
// A name in code, escapes and all (`\u006c`, `\u{6c}`), for the import shapes below (#352 r4 m1).
const NAME = String.raw`(?:[\w$]|\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4})+`;
// A name as JavaScript reads it: `\uXXXX`, `\u{…}` and `\xXX` escapes decoded (#352 r3 M2).
const unescaped = (s) => s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_, a, b, c) => String.fromCodePoint(parseInt(a ?? b ?? c, 16)));
function jobFileImports(text, r) {
  const { code, lits } = lex(text);
  // A name in a list, as written or as a string (`{ "loginJobPlist" as lj }`, ES2022).
  const nameOf = (x) => { const t = x.trim().split(/\s+as\s+/)[0]; const q = /^"#(\d+)"$/.exec(t); return unescaped(q ? lits[+q[1]].v : t); };
  const target = (n) => {
    const from = lits[+n].v.replace(/[?#].*$/, '');
    return from.startsWith('.') ? join(dirname(r), from).split(sep).join('/') : from;
  };
  const out = [];
  for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])(?:import|export)\s*(?:${NAME}\s*,\s*)?\{((?:\\u\{[0-9a-fA-F]+\}|[^}])*)\}\s*from\s*"#(\d+)"`, 'g'))) {
    for (const name of m[1].split(',').map(nameOf)) if (Object.hasOwn(JOB_FILE_FNS, name)) out.push({ name, from: target(m[2]) });
  }
  const whole = [
    ...code.matchAll(new RegExp(String.raw`(?<![\w$.])(?:import|export)\s*(?:${NAME}\s*,\s*)?\*\s*(?:as\s+${NAME}\s*)?from\s*"#(\d+)"`, 'g')),
    ...code.matchAll(/(?<![\w$.])import\s*\(\s*"#(\d+)"\s*[,)]/g),
  ];
  for (const m of whole) {
    const from = target(m[1]);
    for (const [name, mod] of Object.entries(JOB_FILE_FNS)) if (mod === from) out.push({ name, from });
  }
  return out;
}
const ENTRY_POINTS = Object.freeze([...new Set(Object.values(JOB_BUILDERS).flatMap((b) => b().map(startedScript)))].sort());

// Modules whose whole body is a test fixture's hook: each reads a hook's input on stdin and exits while it loads. Each
// child is given such an input; a module on this list must exit while it loads, and any other module must not.
const EXITS_ON_LOAD = Object.freeze({
  'modules/M12-sensors/shell-guard/fixtures/naive-hook.mjs': 'a planted weak hook for the shell-guard runner: reads stdin, exits',
  'modules/M12-sensors/shell-guard/fixtures/strict-hook.mjs': 'a planted strict hook for the shell-guard runner: reads stdin, exits',
});
const HOOK_INPUT = `${JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } })}\n`;

/** The tracked files of this checkout under `dirs`, as they are on disk now (so a planted change is in the copy). */
function tracked(dirs) {
  const r = spawnSync(GIT, ['ls-files', '-z', '--', ...dirs], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter(Boolean).filter((f) => existsSync(join(REPO, f)));
}

/**
 * A repository whose main holds this checkout's orchestrate/ and scripts/, installed by the real updater; then the
 * repository, the origin, the updater's clone and the seed are deleted, so only the installed copy is left.
 */
async function installed() {
  const root = realpathSync.native(tempDir('m4-closure-'));
  const origin = join(root, 'origin.git');
  await gitOk(['init', '--bare', '-q', origin], { gitDir: origin });
  const src = join(root, 'src');
  mkdirSync(src);
  const sg = { gitDir: join(src, '.git'), workTree: src, cwd: src, extraConfig: ID };
  await gitOk(['init', '-q', src], sg);
  for (const f of tracked([SOURCE, 'scripts'])) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), readFileSync(join(REPO, f)));
    chmodSync(join(src, f), statSync(join(REPO, f)).mode & 0o755);
  }
  await gitOk(['add', '-A'], sg);
  await gitOk(['commit', '-q', '-m', 'this checkout'], sg);
  await gitOk(['push', '-q', origin, `HEAD:${MAIN}`], sg);

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'bin'), { recursive: true });
  writeFileSync(join(seed, NODE), 'a node\n');
  writeFileSync(join(seed, RUNNER_CONFIG), '{}\n');
  const installRoot = join(root, 'inst', SOURCE);
  mkdirSync(dirname(installRoot));
  const c = { installRoot, clone: join(root, 'clone.git'), address: origin, keep: ['bin', RUNNER_CONFIG, UPDATER_CONFIG], gitBin: GIT };
  writeFileSync(join(seed, UPDATER_CONFIG), `${JSON.stringify(c)}\n`);
  const r = await updateOnce(c, { first: seed, owner: ME, top: root, localAddress: true });
  assert.equal(r.ok, true, r.reason);
  const cur = currentCopy(installRoot, { owner: ME });
  assert.ok(cur.link && cur.folder, cur.problem);
  for (const gone of [src, origin, c.clone, `${c.clone}.home`, seed]) rmSync(gone, { recursive: true, force: true });
  assert.deepEqual(readdirSync(root).sort(), ['inst'], 'only the installed copy is left');
  return { root, installRoot, cur };
}

// ---- The reader. -------------------------------------------------------------------------------------------------

// After one of these words a `/` starts a regular expression; after any other word, or after `)`, `]`, `}`, a value or
// a string, it divides.
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'export', 'default', 'extends']);

/**
 * `text` (a module) as { code, lits }. `code` is the text with every comment taken out and every string literal put
 * as `"#<n>"` (lits[n] its text), a template with no `${}` too; a template with `${}` keeps its backticks and its
 * `${…}` code, each piece of text as `#<n>` (a lit of kind 'tpl'; the first piece `head`). A regular expression is `/R/`.
 * Line breaks are kept, so a line of `code` is a line of the module. Throws on an unterminated string, template,
 * comment or regular expression, so a reader that loses its place fails rather than reads past code.
 */
export function lex(text) {
  const lits = [];
  let out = '';
  let i = 0;
  let depth = 0;
  const subs = [];                       // brace depth at which each open template `${` began
  let prev = '';                         // the last character of code, or 'x' after a value
  let word = '';                         // the last word of code
  const breaks = (s) => '\n'.repeat((s.match(/\n/g) ?? []).length);
  const lit = (v, kind, head = false) => { lits.push({ v, kind, head }); return lits.length - 1; };
  const tplPiece = () => {
    let s = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { s += text.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i += 1; return { s, end: true }; }
      if (c === '$' && text[i + 1] === '{') { i += 2; return { s, end: false }; }
      s += c; i += 1;
    }
    throw new Error('an unterminated template');
  };
  const afterPiece = (p, first) => {
    if (first && p.end) { out += `"#${lit(p.s, 'str')}"${breaks(p.s)}`; prev = 'x'; word = ''; return; }
    out += `${first ? '`' : ''}#${lit(p.s, 'tpl', first)}${breaks(p.s)}`;
    if (p.end) { out += '`'; prev = 'x'; word = ''; return; }
    out += '${'; subs.push(depth); depth += 1; prev = '{'; word = '';
  };
  // Where the line from `k` ends: at LF, a lone CR, U+2028 or U+2029, as in JavaScript (#352 r3 M1, r4 M1).
  const lineEnd = (k) => { const e = text.slice(k).search(/[\n\r\u2028\u2029]/); return e < 0 ? text.length : k + e; };
  if (text.startsWith('#!')) i = lineEnd(0);
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') { i = lineEnd(i); continue; }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      if (e < 0) throw new Error('an unterminated comment');
      out += ` ${breaks(text.slice(i, e))}`; i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      let s = ''; i += 1;
      for (;;) {
        if (i >= text.length || text[i] === '\n') throw new Error('an unterminated string');
        if (text[i] === '\\') { s += text.slice(i, i + 2); i += 2; continue; }
        if (text[i] === c) { i += 1; break; }
        s += text[i]; i += 1;
      }
      out += `"#${lit(s, 'str')}"${breaks(s)}`; prev = 'x'; word = ''; continue;
    }
    if (c === '`') { i += 1; afterPiece(tplPiece(), true); continue; }
    if (c === '/' && (prev === '' || (/[\w$]/.test(prev) ? BEFORE_EXPR.has(word) : !/[)\]}x]/.test(prev)))) {
      i += 1;
      for (let cls = false; ; i += 1) {
        if (i >= text.length || text[i] === '\n') throw new Error('an unterminated regular expression');
        if (text[i] === '\\') { i += 1; continue; }
        if (text[i] === '[') cls = true;
        else if (text[i] === ']') cls = false;
        else if (text[i] === '/' && !cls) { i += 1; break; }
      }
      while (i < text.length && /[a-z]/.test(text[i])) i += 1;
      out += '/R/'; prev = 'x'; word = ''; continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (subs.length && subs[subs.length - 1] === depth - 1) { subs.pop(); depth -= 1; out += '}'; i += 1; afterPiece(tplPiece(), false); continue; }
      depth -= 1;
    }
    out += c; i += 1;
    if (/[\w$]/.test(c)) { word = /[\w$]/.test(prev) ? word + c : c; prev = c; } else if (!/\s/.test(c)) { prev = c; word = ''; }
  }
  if (subs.length) throw new Error('an unterminated template');
  return { code: out, lits };
}

const lineOf = (code, at) => code.slice(0, at).split('\n').length;
const callAt = (code, at) => {               // the call that starts at `at`, up to its closing parenthesis
  let k = code.indexOf('(', at);
  for (let n = 0; k < code.length; k += 1) { if (code[k] === '(') n += 1; if (code[k] === ')' && --n === 0) break; }
  return code.slice(at, k + 1).replace(/\s+/g, '');
};

/** The module names `code` imports when it loads: `import … from`, `export … from` and a bare `import '…'`. */
function staticImports({ code, lits }) {
  const out = [];
  for (const m of code.matchAll(/(?<![\w$.])(?:import|export)(?![\w$])(?:[^;"`]|"#\d+"(?=\s*(?:as(?![\w$])|[,}])))*?(?<![\w$])from\s*"#(\d+)"/g)) out.push(lits[+m[1]].v);
  for (const m of code.matchAll(/(?<![\w$.])import\s*"#(\d+)"/g)) out.push(lits[+m[1]].v);
  return out;
}

/**
 * What the two scans find in the module `file` (`rel` its path in orchestrate/), whose copy is `real` inside `folder`:
 * every load that runs later and names a file node can't know until then, and every path written from the module's
 * folder that leaves orchestrate/ for a file the updater does not install. → [why…]
 */
export function hiddenLoads(text, { file, rel, real, folder, outside = OUTSIDE_FILES, wiring = CONFIG_IMPORTS }) {
  const bad = [];
  let lx;
  try { lx = lex(text); } catch (e) { return [`${rel}: the reader could not read it (${e.message})`]; }
  const { code, lits } = lx;
  const allowed = wiring.filter(([f]) => f === rel).map(([, call]) => call);
  for (const m of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
    if (/^import\s*\(\s*"#\d+"\s*[,)]/.test(code.slice(m.index))) continue;
    const call = callAt(code, m.index);
    if (allowed.includes(call)) continue;
    bad.push(`${rel}:${lineOf(code, m.index)} imports a name made at run time (${call.slice(0, 120)}), which neither node nor this test can follow`);
  }
  for (const [f, call] of wiring) if (f === rel && !code.replace(/\s+/g, '').includes(call)) bad.push(`${rel}: the config-named import ${call} listed for it is not there`);
  for (const m of code.matchAll(/(?<![\w$.])(?:createRequire|require)\s*\(/g)) bad.push(`${rel}:${lineOf(code, m.index)} loads with require, which this test does not follow`);
  const leaves = (p) => {
    const to = resolve(dirname(file), p);
    const inCopy = relative(real, to);
    if (inCopy === '' || (!inCopy.startsWith('..') && !isAbsolute(inCopy))) return null;
    const inFolder = relative(folder, to);
    return outside.includes(inFolder.split(sep).join('/')) ? null : inFolder;
  };
  // Strings next to each other in a call are taken as one path (`join(here, '..', '..', 'README.md')`).
  for (const m of code.matchAll(/"#(\d+)"(?:\s*,\s*"#\d+")*/g)) {
    const parts = [...m[0].matchAll(/#(\d+)/g)].map((x) => lits[+x[1]].v);
    if (parts[0] !== '..' && !parts[0].startsWith('../')) continue;
    const to = leaves(parts.join('/'));
    if (to !== null) bad.push(`${rel}:${lineOf(code, m.index)} names ${JSON.stringify(parts.join('/'))}, outside ${SOURCE}/ (${to}), which the updater does not install`);
  }
  // A template's first piece, up to its last `/`: the folder a computed name starts from.
  for (const m of code.matchAll(/`#(\d+)/g)) {
    const head = lits[+m[1]].v;
    if (!head.startsWith('../')) continue;
    const to = leaves(head.slice(0, head.lastIndexOf('/') + 1));
    if (to !== null) bad.push(`${rel}:${lineOf(code, m.index)} builds a path from ${JSON.stringify(head)}, outside ${SOURCE}/ (${to}), which the updater does not install`);
  }
  return bad;
}

/** The files `entry`'s static imports reach, as the reader finds them (real paths). Bad names are left to node. */
function readerClosure(entry) {
  const seen = new Set();
  const todo = [realpathSync.native(entry)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of staticImports(lex(readFileSync(f, 'utf8')))) {
      if (BUILTIN.has(spec) || !(spec.startsWith('./') || spec.startsWith('../'))) continue;
      const to = resolve(dirname(f), spec);
      if (existsSync(to)) todo.push(realpathSync.native(to));
    }
  }
  return seen;
}

/** Every .mjs file under `dir` that is not a test file or a test helper. */
function modulesOf(dir) {
  const out = [];
  const walk = (p) => {
    for (const n of readdirSync(p).sort()) {
      const q = join(p, n);
      const st = lstatSync(q);
      if (st.isDirectory()) walk(q);
      else if (st.isFile() && n.endsWith('.mjs') && !/\.test(-helper)?\.mjs$/.test(n)) out.push(q);
    }
  };
  walk(dir);
  return out;
}

// ---- The real import. ----------------------------------------------------------------------------------------------

// The child: a load hook lists every file node loads, then the module is imported. Whether it finished, exited while
// it loaded, or failed, the list and the outcome are written on exit. Nothing is passed on argv, so no module takes
// itself for the program started.
const PROBE = `import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const seen = [];
const r = { loaded: false, error: null };
registerHooks({ load(url, ctx, next) { if (url.startsWith('file:')) seen.push(url); return next(url, ctx); } });
process.on('exit', (code) => writeFileSync(process.env.CLOSURE_OUT, JSON.stringify({ ...r, code, seen })));
try { await import(process.env.CLOSURE_TARGET); r.loaded = true; process.exit(0); }
catch (e) { r.error = String(e?.code ?? '') + ' ' + String(e?.message ?? e).slice(0, 600); process.exit(1); }
`;

function importOne(probe, target, out, cwd) {
  return new Promise((done) => {
    const ch = spawn(process.execPath, [probe], { cwd, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, CLOSURE_TARGET: target, CLOSURE_OUT: out } });
    let err = '';
    const t = setTimeout(() => ch.kill('SIGKILL'), 60_000);
    ch.stderr.on('data', (b) => { err += b; });
    ch.stdin.on('error', () => {});
    ch.stdin.end(HOOK_INPUT);
    ch.on('close', (status, signal) => {
      clearTimeout(t);
      let r = null; try { r = JSON.parse(readFileSync(out, 'utf8')); } catch { /* the child wrote nothing */ }
      done({ status, signal, r, err: err.slice(0, 600) });
    });
  });
}

/**
 * What is wrong with one module's real import (`res`, from importOne): it failed, loaded a file outside `folder`, exited
 * or not as EXITS_ON_LOAD says, or loaded other files than the reader finds (the reader, checked against node). Adds
 * the files it loaded, as paths in `folder`, to `used`. A list of findings; empty when all is well.
 */
function loadFindings(m, res, { folder, used = new Set() }) {
  const { r, status, signal, err } = res;
  if (!r) return [`${m.rel}: the child wrote nothing (status ${status}, ${signal ?? 'no signal'}): ${err}`];
  const exits = Object.hasOwn(EXITS_ON_LOAD, m.rel);
  if (r.error) return [`${m.rel} does not load from the copy: ${r.error}`];
  const fails = [];
  if (exits && r.loaded) fails.push(`${m.rel} is on EXITS_ON_LOAD but loaded without exiting`);
  if (!exits && !r.loaded) fails.push(`${m.rel} exited (${r.code}) while it loaded`);
  const files = r.seen.map((u) => fileURLToPath(u));
  for (const f of files) {
    const inFolder = relative(folder, f);
    if (inFolder.startsWith('..') || isAbsolute(inFolder)) fails.push(`${m.rel} loaded ${f}, outside the installed copy`);
    else used.add(inFolder.split(sep).join('/'));
  }
  const byReader = [...readerClosure(m.file)].sort();
  const byNode = [...new Set(files)].sort();
  if (byReader.join('\n') !== byNode.join('\n')) {
    fails.push(`${m.rel}: the reader and node differ (reader only: ${byReader.filter((f) => !byNode.includes(f)).map((f) => relative(folder, f)).join(', ') || '-'}; node only: ${byNode.filter((f) => !byReader.includes(f)).map((f) => relative(folder, f)).join(', ') || '-'})`);
  }
  return fails;
}

/** Runs `script` by node with no arguments, as a job file starts it: { status, signal, out }. */
function startBare(script, cwd) {
  const r = spawnSync(process.execPath, [script], { cwd, input: '', encoding: 'utf8', timeout: 60_000, env: { PATH: '/usr/bin:/bin', HOME: cwd } });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function importAll(items, probe, root, width = 8) {
  const res = new Array(items.length);
  let next = 0;
  const lane = async () => { for (let k = next++; k < items.length; k = next++) res[k] = await importOne(probe, items[k].target, join(root, `loaded-${k}.json`), root); };
  await Promise.all(Array.from({ length: width }, lane));
  return res;
}

test('L92 item 4, L106 M-1: every module of the installed copy loads from the copy alone, the source deleted', { timeout: 280_000 }, async () => {
  const w = await installed();
  const { folder, real } = w.cur;
  // The layout: the link names <v>/orchestrate; the outside files sit at their repository paths in <v>; the stamp too.
  assert.equal(real, join(folder, SOURCE));
  for (const f of OUTSIDE_FILES) assert.ok(existsSync(join(folder, f)), `${f} is installed beside ${SOURCE}`);
  assert.ok(existsSync(join(folder, STAMP)) && !existsSync(join(real, STAMP)), 'the stamp is at the top of the versioned folder');
  assert.match(readInstallStamp(w.installRoot, { owner: ME }), /^[0-9a-f]{40}$/);

  const mods = modulesOf(real).map((f) => ({ file: f, rel: relative(real, f).split(sep).join('/') }));
  for (const s of ENTRY_POINTS) assert.ok(mods.some((m) => m.rel === s), `the job script ${s} is in the copy`);

  // L132 M-2: each program, started through the link with no arguments, refuses and says why (a usage line, or
  // the check it failed); none goes quiet, and none fails while it loads.
  const started = ENTRY_POINTS.map((s) => ({ s, ...startBare(join(w.installRoot, s), w.root) }));
  const quiet = started.filter((x) => x.signal || x.status === 0 || x.out === '' || /ERR_[A-Z_]+|^\s+at |node:internal/m.test(x.out));
  assert.deepEqual(quiet.map((x) => `${x.s}: exit ${x.status ?? x.signal}, said ${JSON.stringify(x.out.slice(0, 300))}`), [], 'every job script, started through the link, refuses and says why');
  for (const f of Object.keys(EXITS_ON_LOAD)) assert.ok(mods.some((m) => m.rel === f), `${f}, on EXITS_ON_LOAD, is in the copy`);
  for (const [f] of CONFIG_IMPORTS) assert.ok(mods.some((m) => m.rel === f), `${f}, on CONFIG_IMPORTS, is in the copy`);

  // The scans, over every module.
  const hidden = mods.flatMap((m) => hiddenLoads(readFileSync(m.file, 'utf8'), { ...m, real, folder }));
  assert.deepEqual(hidden, [], 'no load the real import cannot see');

  // The real import, each module named through the copy's link, as a plist names its script.
  const probe = join(w.root, 'probe.mjs');
  writeFileSync(probe, PROBE);
  const items = mods.map((m) => ({ ...m, target: pathToFileURL(join(w.installRoot, m.rel)).href }));
  const res = await importAll(items, probe, w.root);
  const fails = [];
  const used = new Set();
  const reached = new Set();
  const scripts = new Set(Object.values(SCRIPTS));
  items.forEach((m, k) => {
    fails.push(...loadFindings(m, res[k], { folder, used }));
    if (scripts.has(m.rel) && res[k].r) for (const u of res[k].r.seen) reached.add(fileURLToPath(u));
  });
  assert.deepEqual(fails, [], 'every module loads from the copy, and only from it');
  // Every listed outside file is loaded by a module of the copy, so the list holds no stale entry.
  for (const f of OUTSIDE_FILES) assert.ok(used.has(f), `${f} is loaded by a module of the copy`);
  assert.ok(reached.size > 10, 'the plist scripts reach the modules they import');
  assert.ok(mods.length > 100, `the copy's modules were all imported (${mods.length})`);
});

// ---- The reader and the scans on small modules. -----------------------------------------------------------------

// m-c (audit r2 N25): the reader-against-node check, on a module whose computed import node follows and the reader's
// static imports do not, and on the same module without it.
test('L136 m1: the programs to start come from every job-file builder of the copy, and a new builder must be listed', () => {
  // Every launchd job file of today, read from its builder: the three LaunchDaemons, the watch-only week, the Dispatcher, the robot job and the Sensors loop.
  assert.deepEqual(ENTRY_POINTS, [...new Set([...Object.values(SCRIPTS), DISPATCHER_MAIN, 'modules/M6-merge-gate/watch-run.mjs', ROBOT_MAIN, SENSORS_LOOP, RUNNER_MAIN, OWNER_SCRIPT, COPIER_SCRIPT])].sort());
  // The tripwire: a module of the copy (test code aside) that writes a launchd start command is a job-file builder, and
  // each one must be on JOB_BUILDERS, so the script its jobs start is started through the link above. A listed
  // builder that no longer writes one is stale.
  const isTestCode = (r) => /\.test(-helper)?\.mjs$/.test(r) || r.split('/').slice(0, -1).some((d) => TEST_FOLDERS.includes(d));
  const writers = tracked([SOURCE]).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(SOURCE.length + 1))
    .filter((r) => !isTestCode(r) && /ProgramArguments/.test(readFileSync(join(REPO, SOURCE, r), 'utf8')));
  const direct = Object.keys(JOB_BUILDERS).filter((f) => !(f in BUILT_THROUGH));
  assert.deepEqual(writers.sort(), [...direct, ...Object.keys(NO_COPY_SCRIPT), ...Object.keys(READS_JOB_FILES)].sort(),
    'every module that builds a job file is on JOB_BUILDERS (or NO_COPY_SCRIPT), every other that names a start command is on READS_JOB_FILES, and only those');
  for (const [f, build] of Object.entries(NO_COPY_SCRIPT)) {
    const jobs = build();
    assert.ok(jobs.length >= 1, `${f} builds a job file`);
    for (const j of jobs) {
      const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(j)?.[1];
      assert.ok(args, `${f}: its job file has a start command`);
      assert.ok(!args.includes(SAMPLE_ROOT) && !/\.mjs\b/.test(args), `${f}: its job starts no script of the copy, so it belongs on JOB_BUILDERS if it ever does`);
    }
  }
  for (const f of Object.keys(READS_JOB_FILES)) {
    assert.ok(!/<key>ProgramArguments<\/key>/.test(readFileSync(join(REPO, SOURCE, f), 'utf8')), `${f} writes no start command`);
  }
  // Builders through another builder, found from their real import lines (L734 self-review M1, m1).
  const users = tracked([SOURCE]).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(SOURCE.length + 1))
    .filter((r) => !isTestCode(r) && !writers.includes(r))
    .map((r) => ({ r, uses: jobFileImports(readFileSync(join(REPO, SOURCE, r), 'utf8'), r) })).filter((x) => x.uses.length);
  assert.deepEqual(users.map((x) => x.r).sort(), [...Object.keys(BUILT_THROUGH), ...Object.keys(USES_JOB_FILES)].sort(),
    'every module that imports a job-file builder is on BUILT_THROUGH or USES_JOB_FILES, and only those');
  for (const [f, via] of Object.entries(BUILT_THROUGH)) {
    assert.ok(f in JOB_BUILDERS && (writers.includes(via) || via in BUILT_THROUGH), `${f} builds through ${via}, a listed builder`);   // or through one that is itself through one, checked in this same loop (L1049)
    const uses = users.find((x) => x.r === f)?.uses ?? [];
    assert.ok(uses.some((u) => JOB_FILE_FNS[u.name] === via && u.from === via), `${f} imports its job file's builder from ${via}`);
  }
  // The scan's own shapes (#352 m1): a comment is no import; either quote; any indent; `import * as` and `import()` of a
  // builder's module bring in all it exports; a module that is not a builder's brings in none.
  const at = 'setup/x.mjs';
  assert.deepEqual(jobFileImports(`// import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';\n/* import('./robot-setup.mjs') */\n  // const later = await import('./watch-setup.mjs');\nimport { x } from "./y.mjs";\nimport { watchPlist as w } from "./watch-setup.mjs";`, at), [{ name: 'watchPlist', from: 'setup/watch-setup.mjs' }]);
  assert.deepEqual(jobFileImports(`if (a) {\n  import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';\n}`, at), [{ name: 'loginJobPlist', from: 'modules/M11-dispatcher/login-job.mjs' }], 'indented');
  assert.deepEqual(jobFileImports(`import * as rs from './robot-setup.mjs';`, at), [{ name: 'robotPlist', from: 'setup/robot-setup.mjs' }], 'namespace');
  assert.deepEqual(jobFileImports(`const m = await import( "../modules/M12-sensors/sensors-job.mjs" );`, at), [{ name: 'sensorsJobPlist', from: 'modules/M12-sensors/sensors-job.mjs' }], 'dynamic');
  assert.deepEqual(jobFileImports(`import * as y from './y.mjs';\nawait import('./z.mjs');`, at), []);
  assert.deepEqual(jobFileImports(`import { sensorsJobPlist } from '../modules/M12-sensors/sensors-job.mjs';\nimport { robotPlist } from './robot-setup.mjs';`, at).map((u) => u.name), ['sensorsJobPlist', 'robotPlist'], 'the two builders through loginJobPlist are on the list');
  // Read through lex() (#352 r2 M1, m2, c1): a `/*` or `*/` in a string hides nothing; a backtick name with no `${}` is
  // a plain name; text that only looks like an import (a string, a template, a comment after code) is none; and the
  // other shapes of an import or re-export.
  const L = "'../modules/M11-dispatcher/login-job.mjs'";
  const IMP = 'im' + 'port(';            // so consume-ask's writeDoc scan does not count this text as an import()
  const lj = [{ name: 'loginJobPlist', from: 'modules/M11-dispatcher/login-job.mjs' }];
  assert.deepEqual(jobFileImports(`const A = '~/Library/LaunchAgents/*';\nimport { loginJobPlist } from ${L};\nconst E = '*/5 * * * *';`, at), lj, 'glob and cron strings');
  assert.deepEqual(jobFileImports(`const m = await ${IMP}\`../modules/M11-dispatcher/login-job.mjs\`);`, at), lj, 'a backtick name with no ${}');
  assert.deepEqual(jobFileImports(`const m = await ${IMP}\`../modules/\${n}/login-job.mjs\`);`, at), [], 'a name built at run time is not read');
  assert.deepEqual(jobFileImports(`const help = "run ${IMP}${L}) to see";\nx(); // later: ${IMP}${L})\nconst src = \`\nimport { loginJobPlist } from ${L};\n\`;`, at), [], 'text that only looks like an import');
  assert.deepEqual(jobFileImports(`import d, * as ns from ${L};`, at), lj, 'default and namespace');
  assert.deepEqual(jobFileImports(`import d, { loginJobPlist } from ${L};`, at), lj, 'default and named');
  assert.deepEqual(jobFileImports(`const a = 1; import { loginJobPlist } from ${L};`, at), lj, 'after code on its line');
  assert.deepEqual(jobFileImports(`export { loginJobPlist as make } from ${L};`, at), lj, 're-export');
  assert.deepEqual(jobFileImports(`export * from ${L};`, at), lj, 'export *');
  // #352 r3 M1: a lone CR, U+2028 or U+2029 ends a line comment; M2: a string name and an escaped name.
  for (const end of ['\r', '\u2028', '\u2029', '\r\n']) assert.deepEqual(jobFileImports(`// note${end}import { loginJobPlist } from ${L};`, at), lj, JSON.stringify(end));
  assert.deepEqual(jobFileImports(`import { "loginJobPlist" as lj } from ${L};`, at), lj, 'a string name');
  assert.deepEqual(jobFileImports(`import { "\\u006coginJobPlist" as lj } from ${L};`, at), lj, 'an escaped string name');
  assert.deepEqual(jobFileImports(`import { \\u006coginJobPlist as lj } from ${L};`, at), lj, 'an escaped name');
  assert.deepEqual(staticImports(lex(`import { "x y" as z } from './a.mjs';\n// c\rimport './b.mjs';\n`)).sort(), ['./a.mjs', './b.mjs'], 'staticImports reads both');
  // #352 r4 M1: the hashbang line ends where a line comment does; m1: a `\u{…}` escape in an unquoted name; c1.
  for (const end of ['\r', '\u2028', '\u2029', '\r\n', '\n']) assert.deepEqual(jobFileImports(`#!/usr/bin/env node${end}import { loginJobPlist } from ${L};`, at), lj, `hashbang ${JSON.stringify(end)}`);
  assert.deepEqual(jobFileImports(`import { \\u{6c}oginJobPlist as lj } from ${L};`, at), lj, 'a \\u{} escape');
  assert.deepEqual(jobFileImports(`import d\\u{31}, { \\u{6c}oginJobPlist } from ${L};`, at), lj, 'escapes in both names');
  assert.deepEqual(jobFileImports(`import * as \\u{6c}j from ${L};`, at), lj, 'an escaped namespace name');
  assert.deepEqual(staticImports(lex(`export { "x" } from './a.mjs';\nexport { "a", "b" as "c" } from './b.mjs';\n`)).sort(), ['./a.mjs', './b.mjs'], 'quoted names before , and }');
  assert.deepEqual(jobFileImports(`import {\n  ROBOT_MAIN,\n  loginJobPlist as make,\n} from '../modules/M11-dispatcher/login-job.mjs?v=1';`, at), lj, 'over lines, with a query');
  // Each builder's jobs each start one script of the copy, read from the job file's start command.
  for (const [f, build] of Object.entries(JOB_BUILDERS)) assert.ok(build().length >= 1, `${f} builds a job file`);
  assert.equal(startedScript(`<key>ProgramArguments</key><array><string>${join(SAMPLE_ROOT, NODE)}</string><string>${join(SAMPLE_ROOT, 'modules', 'x.mjs')}</string><string>${SAMPLE_ROOT}</string></array>`), 'modules/x.mjs');
});

test('L132 m-c: the reader-against-node check reports a module that loads a file the reader does not find', async () => {
  const root = realpathSync.native(tempDir('m4-closure-rn-'));
  const folder = join(root, 'v');
  const dir = join(folder, SOURCE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'b.mjs'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'c.mjs'), 'export const c = 1;\n');
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, PROBE);
  const m = { file: join(dir, 'a.mjs'), rel: 'a.mjs' };
  const run = async (text, k) => {
    writeFileSync(m.file, text);
    return loadFindings(m, await importOne(probe, pathToFileURL(m.file).href, join(root, `out-${k}.json`), root), { folder });
  };
  assert.deepEqual(await run("import './b.mjs';\nconst n = 'c';\nawait import(`./${n}.mjs`);\n", 1), [`a.mjs: the reader and node differ (reader only: -; node only: ${SOURCE}/c.mjs)`]);
  assert.deepEqual(await run("import './b.mjs';\n", 2), [], 'the control: the reader finds what node loads');
});

test('L106 M-1 (d): the reader keeps strings, templates and regular expressions apart from code and comments', () => {
  // The auditor's plant G: a string with "/*" in it and a later one with "*/" no longer hide the import between them.
  const g = lex(`const a = "docs/*"; import { x } from '../../../scripts/hidden.mjs'; const b = "*/x";\n`);
  assert.deepEqual(staticImports(g), ['../../../scripts/hidden.mjs']);
  // Comments are not code; an import in one is not an import.
  assert.deepEqual(staticImports(lex(`// import './a.mjs';\n/* import './b.mjs'; */\nimport './c.mjs';\nexport { y } from "./d.mjs";\n`)).sort(), ['./c.mjs', './d.mjs']);
  // A regular expression with quotes, a "//" and a "/*" in it, and a division, read as such.
  const r = lex(`const re = /['"]\\/\\*[/]/g; const half = n / 2 / 1; import './e.mjs';\n`);
  assert.deepEqual(staticImports(r), ['./e.mjs']);
  assert.match(r.code, /\/R\/g?;/);
  // A template's text and its code: an import inside ${} is code; text that looks like code is not.
  const t = lex('const s = `import \'./not.mjs\' ${await import(`../${n}`)} done`;\n');
  assert.deepEqual(staticImports(t), []);
  assert.match(t.code, /import\(`#\d+\$\{n\}#\d+`\)/);
  // Line breaks are kept, so a line of the code is a line of the module.
  const l = lex('const a = `x\ny`;\n/* one\ntwo */\nimport("z" + q);\n');
  assert.equal(lineOf(l.code, l.code.indexOf('import')), 5);
  for (const bad of ['const a = "open;\n', 'const a = `open;\n', '/* open\n', 'const r = /open\n', 'const s = `${a`;\n']) assert.throws(() => lex(bad), /unterminated/, bad);
});

test('L106 M-1 (b), (c): the scans find a load the real import cannot see', () => {
  const folder = '/v';
  const real = join(folder, SOURCE);
  const at = (rel) => ({ file: join(real, rel), rel, real, folder });
  const scan = (rel, text, more = {}) => hiddenLoads(text, { ...at(rel), ...more });
  // The auditor's plants A and A2: a template and a variable import() of a file outside the copy.
  assert.match(scan('modules/M10-rules/policy.mjs', 'export const f = () => import(`../../../scripts/blueprint/${n}.mjs`);\n').join('|'), /policy\.mjs:1 imports a name made at run time/);
  assert.match(scan('modules/M10-rules/policy.mjs', 'const p = "../../../scripts/blueprint/schema-check.mjs";\nexport const f = () => import(p);\n').join('|'), /policy\.mjs:2 imports a name made at run time \(import\(p\)\)/);
  // A plain-string import() is not refused by this scan. It runs only when called, so the real import above does not
  // load it either: the path scan reads its string like any other path in the code, so one that leads out of
  // orchestrate/ is still found. A bare package name or an absolute path in it is not checked (audit r2 m-a).
  assert.deepEqual(scan('modules/M10-rules/policy.mjs', "export const f = () => import('./engine.mjs');\n"), []);
  // The wiring call is allowed in its own file only, and only that exact call.
  const wiring = 'const mod = await import(pathToFileURL(config.wiring).href);\n';
  assert.deepEqual(scan('modules/M11-dispatcher/main.mjs', wiring), []);
  assert.equal(scan('modules/M11-dispatcher/other.mjs', wiring).length, 1);
  assert.equal(scan('modules/M11-dispatcher/main.mjs', `${wiring}const b = await import(pathToFileURL(config.more).href);\n`).length, 1);
  assert.match(scan('modules/M11-dispatcher/main.mjs', 'export const none = 1;\n').join('|'), /the config-named import .* is not there/);
  // The runner's budget import is allowed in the runner only, not in M11's main.
  const budget = 'budget = await (await import(pathToFileURL(c.budget).href)).budget(c);\n';
  assert.equal(scan('modules/M11-dispatcher/main.mjs', `${wiring}${budget}`).length, 1);
  const runner = 'modules/M4-workshop/launcher/review-runner-main.mjs';
  const runnerWiring = 'wiring = await import(pathToFileURL(c.wiring).href);\n';
  assert.deepEqual(scan(runner, `${runnerWiring}${budget}`), []);
  assert.match(scan(runner, runnerWiring).join('|'), /the config-named import import\(pathToFileURL\(c\.budget\)\.href\) listed for it is not there/);
  assert.equal(scan('a/b.mjs', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('./x.cjs');\n").length, 2);
  // The auditor's plant B: a read, done later, of a file outside orchestrate/, in each way a path is written.
  for (const text of [
    "export const f = () => readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');\n",
    "export const f = () => readFileSync(join(here, '..', '..', '..', 'README.md'), 'utf8');\n",
    "export const f = () => readFileSync(join(here, '../../..', 'README.md'), 'utf8');\n",
    'export const f = (n) => readFileSync(new URL(`../../../docs/${n}`, import.meta.url));\n',
  ]) assert.match(scan('modules/M4-workshop/x.mjs', text).join('|'), /x\.mjs:1 (names|builds a path from) .*outside orchestrate\//, text);
  // Paths that stay in orchestrate/, an outside file the updater installs, and a check on a name are all allowed.
  assert.deepEqual(scan('modules/M10-rules/policy.mjs', [
    "import { parse } from '../../../scripts/blueprint/yaml-lite.mjs';",
    "const p = new URL('../../M10-rules/fixtures/policy.yaml', import.meta.url);",
    "const h = join(here, '..', 'hooks');",
    "const ok = (r) => !r.startsWith('../') && r !== '..';",
    'const t = `../${x}`;',
  ].join('\n')), []);
  // A file the updater does not install, next to one it does, is refused.
  assert.equal(scan('modules/M10-rules/policy.mjs', "import { s } from '../../../scripts/blueprint/schema-check.mjs';\n").length, 1);
  // Text the reader can't read is a finding, not a pass.
  assert.match(scan('a/b.mjs', 'const s = "open;\n').join('|'), /could not read it \(an unterminated string\)/);
});
