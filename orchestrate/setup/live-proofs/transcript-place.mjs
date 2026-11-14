#!/usr/bin/env node
// Live proof (L1134, L1137, L1141): where the pinned claude keeps a session's conversation file, against
// runner-ports.mjs's transcriptPath. Joe runs it on the Mini (the run sheet's step); a session here may not start
// claude. Each case starts the pinned claude once, in a folder of its own, with a fresh config folder and a session
// id it chooses, then looks for <config>/projects/*/<id>.jsonl and compares the folder's name with
// projectFolderName(the folder's real path). One PASS / FAIL / NOT TRIED line per case, then what the run settles:
//   1. the hash: a name over 200 characters ends in "-" and a hash of the path; PASS on the long cases means the hash
//      is the 31-multiplier string hash runner-ports uses (the exported Zhe in 2.1.316's code);
//   2. the real path: every case starts in a folder named through the temp folder's link (/var → /private/var on a
//      Mac), with PWD set to that linked name as a shell would; PASS means claude keys on the real path;
//   3. NFC: one case's folder name has a decomposed accented e (e + U+0301); PASS means claude puts the path in NFC
//      first, as 2.1.316's code reads (the real path of the cwd, then NFC) and runner-ports does.
// Read in 2.1.316's code, not proved live until this passes (checked: claude-code 2.1.316). Only after it passes may
// TRANSCRIPT_PLACE_CHECKED_AGAINST name the pin, in a follow-up carrying this run's output (L1137).
//
// node transcript-place.mjs --claude <the pinned claude> [--config-dir <account folder>]
// The pin is read from the rules (modules/M10-rules/fixtures/policy.yaml claude_code.pin, as capability-notes.mjs
// reads it); any other claude version runs nothing. A --pin, if given, must be that same version.
// Without --config-dir each case gets a fresh, empty config folder (no account), all removed afterwards. If claude then
// writes no conversation file because it is not signed in, the cases are NOT TRIED and say so; run again with
// --config-dir naming a signed-in account's folder. Then every new file or folder in it whose path holds one of this
// run's session ids is removed afterwards, and so is each new folder left empty. Anything else the run changed there is
// left and printed by name: the account's .claude.json, at least, which claude rewrites to list the run's temp folders.
// It is not edited back, because the account's own sessions may be writing it at the same time.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { folderNameAsGiven, projectFolderName } from '../../wiring/runner-ports.mjs';
import { parsePolicy } from '../../modules/M10-rules/policy.mjs';

const MAX = 200;
const ascii = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const POLICY = fileURLToPath(new URL('../../modules/M10-rules/fixtures/policy.yaml', import.meta.url));

/** The case folders' last parts, sized from the real path of their parent so the names land where each case needs. */
export function caseLeaves(realParent) {
  const used = ascii(realParent).length + 1; // the "/" before the leaf
  const pad = (n, ch) => ch.repeat(Math.max(1, n));
  return [
    { id: 'short', leaf: 'short' },
    { id: 'exactly-200', leaf: pad(MAX - used, 'x') },
    { id: 'over-200', leaf: pad(MAX + 60 - used, 'y') },
    { id: 'non-ascii-over-200', leaf: `caf\u00e9-\u{1F600}-${pad(MAX + 40 - used - 8, 'z')}` },
    { id: 'decomposed-short', leaf: 'cafe\u0301' },
  ];
}

/** One case's verdict from where its conversation file is. `found` is the folder name holding <id>.jsonl, or null. */
export function judgeCase({ given, real, found }) {
  const want = projectFolderName(real);
  if (found === null) return { result: 'NOT TRIED', why: 'claude wrote no conversation file for this session' };
  if (found === want) return { result: 'PASS', why: `at ${want.length > 60 ? `${want.slice(0, 28)}…${want.slice(-28)}` : want}` };
  const notes = [];
  if (given !== real && found === projectFolderName(given)) notes.push('claude keys on the path as given (the link), not the real path');
  if (found === folderNameAsGiven(real)) notes.push('claude keeps the decomposed name as is (no NFC step)');
  if (want.length > MAX && found.length > MAX && found.slice(0, MAX) === want.slice(0, MAX)) notes.push(`the same first 200, another ending ("${found.slice(MAX)}" for "${want.slice(MAX)}"): not the 31-multiplier hash`);
  return { result: 'FAIL', why: `found in "${found}", want "${want}"${notes.length ? `; ${notes.join('; ')}` : ''}` };
}

/** Which folder under <config>/projects holds <id>.jsonl, or null. */
export function findTranscript(configDir, id) {
  const projects = join(configDir, 'projects');
  let names; try { names = readdirSync(projects); } catch { return null; }
  for (const n of names) if (existsSync(join(projects, n, `${id}.jsonl`))) return n;
  return null;
}

/** Every file and folder under dir (links not followed), by relative path → "d" or "f:<size>:<mtime>". */
export function listAll(dir, out = new Map(), base = dir) {
  let names; try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n); let st; try { st = lstatSync(p); } catch { continue; }
    out.set(relative(base, p), st.isDirectory() ? 'd' : `f:${st.size}:${st.mtimeMs}`);
    if (st.isDirectory()) listAll(p, out, base);
  }
  return out;
}

/** After a run in an account folder: remove what this run made (paths holding one of its ids, then new folders left
 *  empty) and return what else changed there, by relative path, for the output to name. */
export function tidyAccount(config, before, ids) {
  const now = listAll(config);
  const isNew = (r) => !before.has(r);
  const ours = [...now.keys()].filter((r) => isNew(r) && ids.some((id) => r.includes(id)));
  for (const r of ours) rmSync(join(config, r), { recursive: true, force: true });
  const newDirs = [...now.keys()].filter((r) => isNew(r) && now.get(r) === 'd').sort((a, b) => b.split(sep).length - a.split(sep).length);
  for (const r of newDirs) { try { rmdirSync(join(config, r)); } catch {} }
  const after = listAll(config);
  return [...after.keys()].filter((r) => (isNew(r) || (after.get(r) !== 'd' && before.get(r) !== after.get(r)))).sort()
    .map((r) => `${r}${isNew(r) ? ' (new)' : ' (changed)'}`);
}

const REAL = {
  version: (bin) => /^(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim())?.[1] ?? null,
  pin: () => parsePolicy(readFileSync(POLICY, 'utf8')).policy.claude_code.pin,
  run: (bin, args, opts) => spawnSync(bin, args, { ...opts, encoding: 'utf8', timeout: 180_000 }),
  tmp: () => tmpdir(),
  real: (p) => realpathSync(p),
};

export function main(argv, { print = (t) => process.stdout.write(t), deps = REAL } = {}) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const bin = arg('--claude'); const typed = arg('--pin'); const shared = arg('--config-dir');
  if (!bin) { print('Usage: transcript-place.mjs --claude <the pinned claude> [--config-dir <account folder>]\n'); return 2; }
  let pin; try { pin = (deps.pin ?? REAL.pin)(); } catch (e) { pin = null; }
  if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin)) { print(`NOT DONE: the pin can't be read from ${POLICY}; nothing was run\n`); return 1; }
  if (typed !== undefined && typed !== pin) { print(`NOT DONE: --pin ${typed} is not the rules' pin, ${pin}; nothing was run\n`); return 1; }
  let v; try { v = deps.version(bin); } catch (e) { v = null; }
  if (v !== pin) { print(`NOT DONE: ${bin} is ${v ?? 'not runnable'}, not the pinned ${pin}; nothing was run\n`); return 1; }
  // The parent folder by its linked name (os.tmpdir() on a Mac is /var/folders/…, a link to /private/var/…).
  const parent = mkdtempSync(join(deps.tmp(), 'transcript-place-'));
  const realOf = deps.real ?? REAL.real;
  const realParent = realOf(parent);
  const before = shared ? listAll(shared) : null;
  const lines = []; const ids = []; let left = [];
  try {
    for (const c of caseLeaves(realParent)) {
      const given = join(parent, c.leaf); mkdirSync(given);
      const real = realOf(given);
      const config = shared ?? join(parent, `.config-${c.id}`);
      if (!shared) mkdirSync(config);
      const id = randomUUID(); ids.push(id);
      const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', PWD: given, CLAUDE_CONFIG_DIR: config };
      const r = deps.run(bin, ['-p', 'Reply with the word ok.', '--max-turns', '1', '--session-id', id, '--setting-sources', '', '--output-format', 'stream-json', '--verbose'], { cwd: given, env });
      const found = findTranscript(config, id);
      const j = judgeCase({ given, real, found });
      const said = found === null ? ` (claude: ${String(r?.stderr || r?.stdout || r?.error?.message || '').trim().split('\n').slice(-2).join(' ').slice(0, 200) || 'nothing'})` : '';
      lines.push({ ...c, ...j, given, real });
      print(`${j.result} ${c.id}: ${j.why}${said}\n`);
    }
  } finally {
    if (shared) left = tidyAccount(shared, before, ids);
    rmSync(parent, { recursive: true, force: true });
  }
  if (shared) print(left.length ? `Left in ${shared} (not this run's own files, so not removed): ${left.join(', ')}\n` : `Left in ${shared}: nothing\n`);
  const by = (id) => lines.find((l) => l.id === id);
  const long = ['over-200', 'non-ascii-over-200'].map(by);
  const settled = (cases, yes, no) => (cases.every((l) => l.result === 'PASS') ? yes : cases.some((l) => l.result === 'FAIL') ? no : 'not settled (NOT TRIED)');
  print(`The hash: ${settled(long, 'the 31-multiplier string hash of the path, as runner-ports has it', 'not as runner-ports has it (see the FAIL lines)')}\n`);
  const linked = parent !== realParent;
  print(`The real path: ${linked ? settled(lines, 'claude keys on the real path', 'not settled as wanted (see the FAIL lines)') : `not settled: the temp folder ${parent} is not a link here`}\n`);
  const nfd = by('decomposed-short');
  const kept = nfd.real.includes('e\u0301');
  print(`NFC: ${kept ? settled([nfd], 'claude puts the path in NFC first, as runner-ports does', 'not as runner-ports has it (see the decomposed-short line)') : 'not settled: this disk stored the decomposed name another way'}\n`);
  const pass = lines.every((l) => l.result === 'PASS') && linked && kept;
  print(pass ? `PASS: every case's conversation file is where transcriptPath says, on claude ${pin}\n` : `NOT DONE: ${lines.filter((l) => l.result !== 'PASS').map((l) => `${l.id} ${l.result}`).join(', ') || 'a question above is not settled'}\n`);
  return pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
