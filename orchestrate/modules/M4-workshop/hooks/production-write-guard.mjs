// The production-write guard (design v4 §14.1.5, launch check 10, R-0b-36). Registered on every
// tool in every role file and in the machine-wide file as a fallback (there as `--machine-wide --snapshot <root's copy>`,
// L1031). It reads ONLY the rules snapshot, never GitHub or the network.
//
// Snapshot shape M4 reads (lane 1 publishes it; assumed until the shared reader lands):
//   rules.production = { env_files: [absolute paths], programs: [hosting / database program names],
//                        hosts: [production host names] }
// A missing or stale snapshot, or one without that block, blocks every call (fail closed).

import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isMain, runHook, MACHINE_WIDE_WAY_OUT, block, pass, toolPaths, shellCommands, shellWords, bothWords, programOf, landingPath, realFolder, inside, joinLines, unreadable, heredocs, expandBraces, fold, globRe } from './lib.mjs';
import { readSnapshot } from './snapshot.mjs';

// ---- whole-folder writes (LEAD-CALLS L41 G2: deny by default) ----
//
// A command that writes, deletes, moves or unpacks a whole folder never names the file inside it, so the name
// checks below can't see it touch a production settings file. Such a command is refused when its target folder
// holds a protected file (a production settings file or a listed secret path), and a recursive delete of the
// session's folder, the project or any folder above them is always refused. A copy of a whole folder (`cp -R`,
// `ditto`, `rsync`) is judged on what it copies as well: one holding a protected file is refused, since the copy
// lands where nothing guards it. Other reads of a whole folder (`grep -r`, `tar c`) are left to the sandbox's
// read-deny list, the wall for reads.

// A long option counts under every name it shortens (`--ext` is `--extract`, `--al` is `--all`): GNU tools, bsdtar
// and git all take a short form (L45; audit of L41, round 2, MAT-7, MAT-12, MAT-13).
const longIs = (w, name) => { const part = w.split('=')[0]; return part.length >= 3 && part.startsWith('--') && name.startsWith(part); };
const RECURSIVE = (w) => /^-[A-Za-z]*[rR]/.test(w) || longIs(w, '--recursive');
// A lone `-` is a name (`cd -`), not an option.
const isOpt = (w) => w.startsWith('-') && w !== '-';
const opts = (c) => { const i = c.indexOf('--'); return (i < 0 ? c.slice(1) : c.slice(1, i)).filter(isOpt); };
const args = (c) => { const i = c.indexOf('--'); return [...(i < 0 ? c.slice(1) : c.slice(1, i)).filter((w) => !isOpt(w)), ...(i < 0 ? [] : c.slice(i + 1))]; };
// Every value of a one-letter option, however written: `-C dir`, `-Cdir`, inside a cluster (`-xC dir`, `-xvCdir`),
// or by a long name (`--directory dir`, `--directory=dir`). All of them, since the last one may be the one that counts
// (audit of L41, MAT-3).
function optValues(c, letter, longs = []) {
  const out = [];
  for (let i = 1; i < c.length; i += 1) {
    const w = c[i];
    if (w === '--') break;
    if (longs.some((l) => longIs(w, l))) { out.push(w.includes('=') ? w.slice(w.indexOf('=') + 1) : c[i + 1]); continue; }
    if (/^-[A-Za-z0-9]+/.test(w) && !w.startsWith('--')) {
      const k = w.indexOf(letter, 1);
      if (k > 0) out.push(k + 1 < w.length ? w.slice(k + 1) : c[i + 1]);
    }
  }
  return out.filter((x) => typeof x === 'string');
}
const clusterHas = (o, letter) => o.some((w) => /^-[^-]/.test(w) && w.includes(letter));
// Folders given one after another where each counts from the one before (`tar -C sub -C ../../work`, `git -C a -C b`;
// round 3 MAT-4): every step, as a path from where the command runs.
const chain = (vals) => { const out = []; let at = ''; for (const v of vals) { at = isAbsolute(v) || !at ? v : `${at}/${v}`; out.push(at); } return out; };

// tar's short options that take a value, in GNU tar and in bsdtar (the Mac's tar). In a cluster the rest of the word
// is the value (`-fCa.tar` is `-f Ca.tar`, with no -C; round 3 MAT-5), else the next word. Both readings are judged.
const TAR_VALUE_LETTERS = ['bCfFgHIKLNTVX', 'bCfIsTX'];
// The folders tar unpacks into, read as tar reads its words; the folder it runs in too when a name comes before the
// first -C (GNU tar takes -C in order).
function tarDirs(c, letters) {
  const dirs = [];
  let named = false;
  let i = 1;
  // The old form (`tar xf a.tar`): its letters' values are the next words, in order.
  if (c[1] && !c[1].startsWith('-')) i = 2 + [...c[1]].filter((x) => letters.includes(x)).length;
  for (; i < c.length; i += 1) {
    const w = c[i];
    if (w === '--') { if (i + 1 < c.length && !dirs.length) named = true; break; }
    if (['--directory', '--cd'].some((l) => longIs(w, l))) { const v = w.includes('=') ? w.slice(w.indexOf('=') + 1) : c[++i]; if (typeof v === 'string') dirs.push(v); continue; }
    // Another long option may take the next word as its value (`--exclude x`): that word is not a name.
    if (w.startsWith('--')) { if (!w.includes('=')) i += 1; continue; }
    if (!/^-[^-]/.test(w)) { if (!w.startsWith('-') && !dirs.length) named = true; continue; }
    for (let k = 1; k < w.length; k += 1) {
      if (!letters.includes(w[k])) continue;
      const v = k + 1 < w.length ? w.slice(k + 1) : c[++i];
      if (w[k] === 'C' && typeof v === 'string') dirs.push(v);
      break;
    }
  }
  const steps = chain(dirs);
  return !steps.length || named ? ['.', ...steps] : steps;
}

/**
 * What a copy program copies out as a whole (lane 2 follow-up: rsync vs cp -r): the names before where it lands, or
 * every name when the landing folder is given by `-t`. A copy of a folder holding a protected file puts that file
 * where nothing guards it, so `cp -R`, `ditto` and `rsync` are judged the same way on what they copy.
 */
export function folderCopies(c) {
  const prog = programOf(c);
  const o = opts(c);
  const a = args(c);
  const recursive = prog === 'cp' && o.some((w) => RECURSIVE(w) || /^-[A-Za-z]*a/.test(w) || longIs(w, '--archive'));
  if (!recursive && !['ditto', 'rsync'].includes(prog)) return [];
  const toFolder = prog === 'cp' && optValues(c, 't', ['--target-directory']).length;
  return toFolder ? a : a.slice(0, -1);
}

/**
 * The folders a command writes as a whole, or [] when it writes none. `'.'` stands for the folder it runs in.
 * `deletes` marks a removal, which is refused on the session's folder or any folder above it whatever it holds.
 */
export function folderWrites(c) {
  const prog = programOf(c);
  const o = opts(c);
  const a = args(c);
  if (prog === 'rm' && o.some((w) => RECURSIVE(w) || /^-[A-Za-z]*d/.test(w) || longIs(w, '--dir'))) return { targets: a, deletes: true };
  if (['rmdir', 'mv', 'trash'].includes(prog)) return { targets: [...a, ...(prog === 'mv' ? optValues(c, 't', ['--target-directory']) : [])], deletes: true };
  // rsync reads options after the names too (`… dest/ --exclude x`), so its last word may not be where it writes,
  // and `--remove-source-files` deletes what it copies: every name it is given is judged (audit of L41, MAT-2, MAT-7).
  // Every value of a long option too (`--backup-dir=dir`, `--temp-dir=dir`), and `-T` joined (`-T.tmp`, `-aT.tmp`; L60).
  if (prog === 'rsync') return { targets: [...a, ...o.filter((w) => /^--[^=]+=/.test(w)).map((w) => w.slice(w.indexOf('=') + 1)), ...optValues(c, 'T', ['--temp-dir'])], deletes: o.some((w) => longIs(w, '--remove-source-files')) };
  // zip -m moves the files into the archive, deleting them (MAT-7).
  if (prog === 'zip' && (clusterHas(o, 'm') || o.some((w) => longIs(w, '--move')))) return { targets: a, deletes: true };
  // A copy onto a folder: the last name is where it lands (cp only when it copies folders), or GNU cp's and install's
  // `-t dir` (install's added under L60).
  if (['ditto', 'install'].includes(prog) || (prog === 'cp' && o.some((w) => RECURSIVE(w) || /^-[A-Za-z]*a/.test(w) || longIs(w, '--archive')))) {
    return { targets: [...a.slice(-1), ...(['cp', 'install'].includes(prog) ? optValues(c, 't', ['--target-directory']) : [])], deletes: false };
  }
  if (['tar', 'bsdtar', 'gtar'].includes(prog)) {
    // The mode letters: a first word without a dash (`tar xf`), or the short options (`-xf`), never a long one.
    const old = c[1] && !c[1].startsWith('-') ? c[1] : '';
    const mode = old + o.filter((w) => /^-[^-]/.test(w)).join('');
    if (/x/.test(mode) || o.some((w) => longIs(w, '--extract') || longIs(w, '--get'))) {
      // `-P` keeps the archive's full paths, so it writes anywhere: judged from the top (MAT-8).
      if (/P/.test(mode) || o.some((w) => longIs(w, '--absolute-paths'))) return { targets: [sep], deletes: false };
      // The old form (`tar xCf dir a.tar`) takes its values in letter order; not worked out, so judged from the top.
      if (old.includes('C')) return { targets: [sep], deletes: false };
      return { targets: [...new Set(TAR_VALUE_LETTERS.flatMap((l) => tarDirs(c, l)))], deletes: false };
    }
    return { targets: [], deletes: false };
  }
  if (prog === 'unzip') {
    if (o.some((w) => /^-[ltvpZ]/.test(w))) return { targets: [], deletes: false };
    const dirs = optValues(c, 'd');
    return { targets: dirs.length ? dirs : ['.'], deletes: false };
  }
  if (prog === 'find' && c.some((w) => w === '-delete')) {
    const starts = [];
    for (const w of c.slice(1)) { if (/^[-(!]/.test(w)) break; starts.push(w); }
    return { targets: starts.length ? starts : ['.'], deletes: true };
  }
  if (['chmod', 'chown', 'chgrp', 'chflags'].includes(prog) && o.some(RECURSIVE)) return { targets: a.slice(1), deletes: false };
  // `git clean -x` deletes the ignored files, settings files among them; any `git clean` is refused where it runs.
  // `git stash --all` stashes the ignored files too, then removes them, as `git clean -x` does (MAT-6).
  const stashAll = c.includes('stash') && c.slice(c.indexOf('stash') + 1).some((w) => longIs(w, '--all') || /^-[A-Za-z]*a[A-Za-z]*$/.test(w));
  if (prog === 'git' && (c.includes('clean') || stashAll)) return { targets: ['.', ...chain(optValues(c, 'C'))], deletes: true };
  return { targets: [], deletes: false };
}

// `~`, `$HOME`, `$PWD`, `$USER` and `$TMPDIR`, as the shell expands them (the class rule lets only these through).
// The line is rewritten before it is split: `$HOME`, `$USER` and `$TMPDIR` become their values and `$PWD` a
// mark that stands for every folder the command may be in by then. A variable left over (one with no value
// here, `$?`) makes its path unknown, and an unknown path is refused (L46 round 4 confirm: deny by default).
const PWD_MARK = '@pwd@';
const varRe = (name) => new RegExp(String.raw`\$(\{${name}\}|${name}(?![A-Za-z0-9_]))`, 'g');
const spellOut = (cmd, vars) => Object.entries(vars).reduce((c, [name, v]) => (typeof v === 'string' && v ? c.replace(varRe(name), () => v) : c), cmd);
const unknownWord = (w) => /[$`]/.test(w);
// bash 3.2 (/bin/bash on a Mac) lets a pattern part that starts with `.` match `.` and `..`: `.*` gives `. ..`, `.?`,
// `.[.]` and `.[!x]` give `..` (zsh and bash 5.2 never do). Such a part may mean this folder or the one above, and a
// word may hold several, so it is refused rather than read each way (LEAD-CALLS L59). The word comes with its quotes
// and backslashes taken out, as the shell reads it (`\.?`, `'.'?` are `.?`). Inside `[...]` that quoting changes what
// bash matches (`.[\^.]` holds `^` and `.`, and lists `..`), so a dot part holding `[` is refused whatever it holds
// (L60; `.[!.]` too). One the pattern maker can't read counts as one that can match.
const dotMayClimb = (part) => {
  if (!part.startsWith('.') || !/[*?[]/.test(part)) return false;
  if (part.includes('[')) return true;
  try { const re = globRe(part); return re.test('.') || re.test('..'); } catch { return true; }
};
// The word's full forms, or why it can't be placed: another user's home folder (`~name/…`; audit of L41, MAT-4), or a
// pattern part that may be `.` or `..` (lane 2 follow-up: dot-glob), so every command the folder rule judges gets it.
function expand(w, home, cwds) {
  if (/^~[^/]/.test(w)) return 'is written as a whole in a folder the guard can\'t place';
  const h = w.replace(/^~(?=\/|$)/, home);
  if (h.split(sep).some(dotMayClimb)) return 'holds a pattern starting with a dot, which can mean this folder or the one above (name the files)';
  return h.startsWith(PWD_MARK) ? cwds.map((c) => c + h.slice(PWD_MARK.length)) : [h];
}
// The fixed front of a path with a wildcard: `proj/a*/b` gives `proj`. A wildcard target is judged by that folder.
const fixedFront = (p) => { const parts = p.split(sep); const i = parts.findIndex((x) => /[*?[]/.test(x)); return i < 0 ? p : parts.slice(0, i).join(sep) || sep; };

// While the command may run in a folder holding a protected file, a program that unpacks files it does not name
// (`cpio -idm`, `pax -r`, `aa extract`) is refused (L45, MAT-8). Only unpackers: ordinary tools run there (L46; round 3
// MAT-11). The commands that write a whole folder are judged below in any case.
const UNPACKERS = new Set(['cpio', 'bsdcpio', 'pax', 'aa', 'ar', '7z', '7za', '7zr', '7zz', 'unrar', 'unar', 'xar', 'jar', 'lha', 'cabextract',
  'unshar', 'pkgutil', 'installer', 'hdiutil', 'dpkg-deb']);
// Programs that can make a link or a folder by another name, which a whole-folder write later in the same line could
// go through when it did not exist yet as the guard looked (MAT-5, MAT-10). Any other earlier command (`git pull`,
// `rm`) leaves the later write alone (L46; round 3 MAT-10).
const MAKES_LINKS = new Set(['ln', 'link', 'cp', 'mv', 'ditto', 'rsync', 'install', ...UNPACKERS]);

// Where a path really leads, as the system reads it: one part at a time from the folder's real path, a link followed
// before the next part, so a `..` after a link climbs from the link's target (round 3 MAT-1, MAT-2). The part from
// the first missing name on is kept as written.
function physical(base, p) {
  let cur = isAbsolute(p) ? sep : (realFolder(base) ?? base);
  let missing = false;
  for (const part of p.split(sep)) {
    if (!part || part === '.') continue;
    if (part === '..') { cur = dirname(cur); continue; }
    cur = join(cur, part);
    if (!missing) { const r = realFolder(cur); if (r) cur = r; else missing = true; }
  }
  return cur;
}
// A `..` after a pattern (`l*/../work`) can climb out of whatever the pattern matched: not worked out, refused.
const dotsAfterPattern = (p) => { const parts = p.split(sep); const k = parts.findIndex((x) => /[*?[]/.test(x)); return k >= 0 && parts.slice(k + 1).includes('..'); };

const linkTarget = (p) => { const r = realFolder(p); return r && r !== p ? r : null; };

/**
 * Why the command writes a folder holding a protected file, or null. `cwd` is where the call runs; every `cd`
 * or `pushd` adds where it leads (a subshell's `cd` may or may not still hold, so both count), and a `cd` the
 * guard can't follow makes every relative target unknown, which is refused.
 */
export function folderWriteWhy(cmd, { cwd, protectedFiles, home = homedir(), user = process.env.USER || userInfo().username, tmpdir = process.env.TMPDIR, projectDir = null, cdpath = process.env.CDPATH }) {
  // Where the guard and the shell could split the line differently (a comment holding a quote, …), the command list
  // below is not the shell's: refused here too, not only by `unreadable` (lane 2 follow-up: comment-quote).
  const split = heredocs(cmd).why;
  if (split) return `${split}; write the command out plainly`;
  // A Set: each `cd` would otherwise double the list (audit of L41, round 2, minor).
  const cwds = new Set([cwd]);
  let lost = false;
  // A whole-folder write after a command that can make a link is refused: the link may not exist yet when the guard
  // looks (`ln`, `cp -R <link> l`, an unpacked link; MAT-5, MAT-10). See MAKES_LINKS.
  let wrote = null;
  // A `cd` searched through CDPATH (set any way: `CDPATH+=`, zsh's `cdpath`), after a shell option is changed
  // (`cdable_vars`), or `cd -` to a folder this line did not visit, lands where the guard can't tell (MAT-4, MAT-9).
  const viaCdpath = Boolean(cdpath) || /cdpath/i.test(cmd);
  const optsChanged = /(^|[ \t\n;&|(])(setopt|unsetopt|shopt|enable)([ \t\n]|$)|(^|[ \t\n;&|(])set[ \t\n]+[-+]o/.test(cmd);
  const setOld = /(^|[ \t\n;&|(])(export[ \t\n]+)?OLDPWD=/.test(cmd);
  let moved = false;
  const shielded = [cwd, ...(projectDir && isAbsolute(projectDir) ? [projectDir] : [])];
  const holdsProtected = (d) => [d, realFolder(d)].filter(Boolean).some((x) => protectedFiles.some((f) => inside(f, fold(x))));
  for (const c of shellCommands(spellOut(cmd, { HOME: home, PWD: PWD_MARK, USER: user, TMPDIR: tmpdir }))) {
    const prog = programOf(c);
    // A word list starting with an option is the rest of a command split at a quoted bracket (`find . \( -name a \)`).
    if (UNPACKERS.has(prog) && (lost || [...cwds].some(holdsProtected))) {
      return `"${prog}" may write files it does not name, in a folder holding a protected file; run it from another folder`;
    }
    if (prog === 'cd' || prog === 'pushd') {
      const words = args(c);
      const to = words[0];
      const forms = to === undefined || to === '-' ? [] : expand(to, home, [...cwds]);
      // zsh: `cd old new` swaps a part of the folder's path, `cd +1` goes to a folder on the stack.
      const odd = words.length > 1 || /^\+\d/.test(to ?? '') || opts(c).some((w) => !['-P', '-L', '-e', '-@', '-q', '-s'].includes(w)) || optsChanged;
      if (odd) lost = true;
      else if (to === undefined) cwds.add(home);
      else if (to === '-') { if (setOld || !moved) lost = true; /* else back to a folder already counted */ }
      else if (/[*?[]/.test(to) || unknownWord(to) || typeof forms === 'string' || (viaCdpath && !/^(\/|~|@pwd@|\.\.?(\/|$))/.test(to))) lost = true;
      // Where the cd really lands counts too: after `cd <link>`, a later `..` is taken on disk from the link's target.
      // `cd -P l/..` goes up from the link's target: where the system takes the path counts too (round 3 MAT-2).
      else for (const x of forms) for (const base of [...cwds]) { const to2 = resolve(base, x); cwds.add(to2); const r = realFolder(to2); if (r) cwds.add(r); cwds.add(physical(base, x)); }
      moved = true;
      continue;
    }
    const { targets, deletes } = folderWrites(c);
    // What a copy copies out is judged first, so its refusal says "copied out" (rsync's names are judged as written
    // too, below, since any of them may be where it writes).
    const items = [...folderCopies(c).map((x) => [x, true]), ...targets.map((x) => [x, false])].flatMap(([x, copied]) => expandBraces(x).map((y) => [y, copied]));
    for (const [t, copied] of items) {
      const how = copied ? 'copied out' : 'written';
      if (wrote) return `"${t}" is ${how} as a whole after "${wrote}" in the same command; run it as a command of its own`;
      if (unknownWord(t)) return `"${t}" is ${how} as a whole, and the guard can't tell where a variable in it leads`;
      const forms = expand(t, home, [...cwds]);
      if (typeof forms === 'string') return `"${t}" ${forms.replace('written', how)}`;
      if (forms.some((f) => !isAbsolute(f)) && lost) return `"${t}" is ${how} as a whole after a folder change the guard can't follow`;
      for (const f of forms) {
        if (dotsAfterPattern(f)) return `"${t}" has a ".." after a pattern, which the guard can't place`;
        for (const abs of (isAbsolute(f) ? [sep] : [...cwds]).flatMap((b) => [resolve(b, f), physical(b, f)])) {
          const why = judge(t, abs, !copied && deletes, protectedFiles, shielded, how);
          if (why) return why;
        }
      }
    }
    if (MAKES_LINKS.has(prog) || (targets.length && ['tar', 'bsdtar', 'gtar', 'unzip'].includes(prog))) wrote = prog;
  }
  return null;
}

// Do the pattern's parts (each a RegExp for one name, or `**` for any number of them) match the first parts of `segs`?
function matchesFront(pp, segs) {
  if (!pp.length) return true;
  if (pp[0] === '**') return matchesFront(pp.slice(1), segs) || (segs.length > 0 && matchesFront(pp, segs.slice(1)));
  return segs.length > 0 && pp[0].test(segs[0]) && matchesFront(pp.slice(1), segs.slice(1));
}

// The folders on disk a pattern names, below `front`, up to its first `**`; capped, null past the cap.
function onDisk(front, pp, cap = 500) {
  let out = [front];
  for (const part of pp) {
    if (part === '**') break;
    const next = [];
    for (const d of out) {
      let names = [];
      try { names = readdirSync(d); } catch { continue; }
      for (const n of names) if (part.test(fold(n))) next.push(join(d, n));
      if (next.length > cap) return null;
    }
    out = next;
  }
  return out;
}

// One target, as a full path. A path with wildcards stands for what it can match: a protected file is reached when
// the start of its path below the fixed front matches the pattern (`**` any number of parts, so `**/node_modules`
// reaches only what is inside a node_modules; MAT-15), and each match on disk is followed to where it really leads
// (a link among the matches; MAT-11).
function judge(t, abs, deletes, protectedFiles, shielded, how = 'written') {
  const parts = abs.split(sep);
  const first = parts.findIndex((x) => /[*?[]/.test(x));
  const front = fixedFront(abs);
  let pp = null;
  if (first >= 0) {
    try { pp = parts.slice(first).filter(Boolean).map((x) => (x === '**' ? '**' : globRe(fold(x), 'i'))); } catch { return `"${t}" holds a pattern the guard can't read`; }
  }
  const folders = [front, realFolder(front) ?? front].map(fold);
  const reached = (x) => folders.some((d) => (pp ? x !== d && inside(x, d) && matchesFront(pp, x.slice(d.length).split(sep).filter(Boolean)) : inside(x, d)));
  if (protectedFiles.some(reached)) return `"${t}" is a folder holding a protected file, ${how} as a whole`;
  if (pp) {
    const found = onDisk(front, pp);
    if (found === null) return `"${t}" matches too many names to check`;
    for (const m of found) {
      const real = linkTarget(m);
      if (real && protectedFiles.some((f) => inside(f, fold(real)))) return `"${t}" matches a link to a folder holding a protected file`;
    }
  }
  // A delete of every name in a shielded folder (`*`, `?*`, `[a-z]*`, `.*`): its pattern has no plain letters.
  const broad = pp && first === parts.length - 1 && parts[first].replace(/\[[^\]]*\]|[*?.]/g, '') === '';
  if (deletes && shielded.some((s) => reached(fold(s)) || (broad && folders.includes(fold(s))))) {
    return `"${t}" is the working folder or a folder above it`;
  }
  return null;
}

/**
 * Each command in `raw`, and each command in a string a shell is handed to run (`bash -c "<s>"`, `sh -lc '<s>'`, `eval <s>`),
 * read the same way, a few levels deep. The role form refuses those shapes outright (`unreadable`); the machine-wide form
 * lets them run (L1044 M1), so it reads inside them for a production program (#487 r2).
 */
export function* commandsWithin(raw, depth = 0) {
  for (const c of shellCommands(raw)) {
    yield c;
    if (depth >= 4) continue;
    const word = programOf(c) ?? '';
    const prog = basename(word);
    const rest = c.slice(c.indexOf(word) + 1);
    if (prog === 'eval') { yield* commandsWithin(rest.join(' '), depth + 1); continue; }
    if (!['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(prog)) continue;
    const flag = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/i.test(w));
    if (flag >= 0 && typeof rest[flag + 1] === 'string') yield* commandsWithin(rest[flag + 1], depth + 1);
  }
}

// The first production program any word of `raw` names: words split at anything that is not part of a name, read as
// written and with quotes and backslashes taken out (`v'e'rcel`, `v\\ercel`), the program part of a path
// (`./node_modules/.bin/<p>`) and of a versioned package (`<p>@latest`). Folded, as every name here is.
const FOLDER_CHANGERS = ['cd', 'pushd', 'popd', 'chdir', 'z', 'zi'];
const PATTERN_TAKERS = ['find', 'fd', 'locate', 'mdfind', 'rsync', 'tar', 'bsdtar', 'zip', 'unzip', 'ditto', 'git', 'rg', 'ag', 'du', 'pax', 'cpio'];

export function programNamedIn(raw, programs) {
  for (const t of wordsIn(raw)) {
    const name = fold(basename(t).replace(/^@/, '').split('@')[0]);
    if (name && programs.includes(name)) return name;
  }
  return null;
}

// Every word-like run of `raw`'s text (letters, digits and `._+@/-`), as written and with quotes and backslashes taken out.
// No wildcard characters: in code (`a[0]`, `x*y`) they are not file patterns.
export function wordsIn(raw) {
  const s = String(raw);
  return [s, s.replace(/['"\\]/g, '')].flatMap((text) => text.split(/[^A-Za-z0-9._+@/-]+/)).filter(Boolean);
}

// ---- the machine-wide form's runners and text (#487 r4, LEAD-CALLS L1066) ----
//
// Programs that start another program from words the plain read below does not take as a command. In the machine-wide
// form a line using one is read like an unreadable shape: any word naming a production program refuses it (M1). Role
// sessions refuse these through their own settings and have the sandbox's network list as the wall.
const INSTALLERS = new Set(['add', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'install', 'isntall', 'ci', 'clean-install', 'remove', 'rm', 'r', 'un',
  'uninstall', 'unlink', 'link', 'ln', 'ls', 'list', 'll', 'la', 'view', 'v', 'info', 'show', 'why', 'explain', 'update', 'up', 'upgrade',
  'outdated', 'audit', 'init', 'pack', 'publish', 'config', 'c', 'cache', 'help', 'search', 'whoami', 'login', 'logout', 'version',
  'dedupe', 'ddp', 'prune', 'store', 'rebuild', 'rb', 'test', 't', 'tst', 'start', 'stop', 'restart', 'doctor', 'fund', 'set', 'get',
  'ping', 'root', 'bin', 'prefix', 'owner', 'team', 'token', 'profile', 'pkg', 'query', 'sbom', 'shrinkwrap', 'star', 'unstar',
  'stars', 'deprecate', 'dist-tag', 'docs', 'repo', 'bugs', 'org', 'access', 'adduser', 'completion', 'diff', 'find-dupes',
  'unpublish', 'patch', 'patch-commit', 'licenses', 'import', 'fetch', 'setup', 'plugin', 'workspaces', 'global', 'licenses', 'pm', 'outdated']);
// Package-manager options that take a value, so the word after them is not the subcommand.
const PM_VALUE_OPTS = new Set(['--dir', '--prefix', '-C', '--cwd', '--filter', '-F', '--workspace', '--package', '-p', '--registry',
  '--loglevel', '--userconfig', '--cache', '--config']);
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun|lua|luajit|Rscript|R|osascript|tclsh|pwsh|powershell)$/;
const CODE_FLAG = /^-{1,2}(e|c|command|encodedcommand|ec|eval)$/i;
const WATCHERS = ['watchexec', 'nodemon', 'entr', 'tmux', 'screen', 'at', 'batch', 'crontab', 'ssh', 'npx', 'bunx', 'pnpx'];

/** The first runner of `raw` (a command that starts another from words the guard does not take as a command), or null. */
export function runnerIn(raw) {
  for (const c of commandsWithin(raw)) {
    const prog = programOf(c);
    const rest = c.slice(1);
    if (WATCHERS.includes(prog)) return `"${prog}" starts another program`;
    if (['pnpm', 'npm', 'yarn', 'bun', 'corepack'].includes(prog)) {
      let k = 0;
      while (k < rest.length && rest[k].startsWith('-')) { k += PM_VALUE_OPTS.has(rest[k]) ? 2 : 1; }
      const sub = rest[k];
      // `corepack pnpm …` is read as the package manager it starts.
      if (prog === 'corepack' && ['pnpm', 'npm', 'yarn'].includes(sub)) { if (runnerIn(rest.slice(k).join(' '))) return '"corepack" starts a package runner'; continue; }
      if (prog === 'corepack') continue;
      if (sub !== undefined && !INSTALLERS.has(sub)) return `"${prog} ${sub}" runs a program or script`;
      continue;
    }
    if (INTERPRETERS.test(prog) && rest.includes('-')) return `"${prog} -" reads code from its input`;
    if (/^(lua|luajit|Rscript|R|pwsh|powershell|expect)$/.test(prog) && rest.some((w) => CODE_FLAG.test(w))) return `"${prog}" runs code given on the line`;
    if (['fd', 'fdfind'].includes(prog) && rest.some((w) => /^(-[a-zA-Z]*[xX]|--exec(-batch)?(=.*)?)$/.test(w))) return '"fd -x" runs a command for each file';
    if (prog === 'rg' && rest.some((w) => /^--pre(=.*)?$/.test(w))) return '"rg --pre" runs a command for each file';
    if (prog === 'launchctl' && rest.some((w) => ['asuser', 'bsexec', 'submit'].includes(w))) return '"launchctl" starts a program';
    if (prog === 'git') {
      const sub = gitSub(c);
      if (c[sub] === 'bisect' && c.slice(sub + 1).includes('run')) return '"git bisect run" runs a command';
      if (c[sub] === 'rebase' && c.slice(sub + 1).some((w) => /^(--exec(=.*)?|-[a-z]*x.*)$/.test(w))) return '"git rebase --exec" runs a command';
    }
  }
  return null;
}

// Where git's subcommand sits in a command (past its own options and their values), or -1.
function gitSub(c) {
  return c.findIndex((w, k) => k > 0 && !w.startsWith('-') && !['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(c[k - 1]));
}

// Words that are only text: they never count as naming a program (m2). A word holding a substitution (`$(…)`, a
// backtick) is a command after all, except a `$(cat <<'X' … X)` body, the usual way to pass a long message.
const CAT_BODY = /\$\(\s*cat\s+<<-?\s*'([A-Za-z_][\w.-]*)'\s*;([\s\S]*?);\s*\1\s*(;\s*)?\)/g;
function onlyText(word) {
  const left = word.replace(CAT_BODY, (whole, delim, body) => (body.split(';').some((l) => l.trim() === delim) ? whole : ' '));
  return !/\$\(|`/.test(left);
}
const SEARCHERS = ['grep', 'egrep', 'fgrep', 'rg', 'ag'];
// Search options that take a value: the word after them is not the pattern (`--pre` names a program).
const SEARCH_VALUE_OPTS = new Set(['-f', '--file', '-A', '-B', '-C', '-m', '--max-count', '-d', '-D', '--include', '--exclude', '--exclude-dir',
  '-t', '--type', '-T', '--type-not', '-g', '--glob', '--iglob', '-M', '--max-columns', '-j', '--threads', '--context', '--after-context',
  '--before-context', '--pre', '--pre-glob', '-E', '--encoding', '--color', '--colors', '-G', '--file-search-regex', '--ignore', '--path-to-ignore']);
// Indexes (into `c`) of a search command's pattern: each `-e <p>` / `--regexp <p>`, or else the first plain word.
function patternAt(c, from) {
  const out = [];
  let plain = -1;
  for (let k = from + 1; k < c.length; k += 1) {
    const w = c[k];
    if (w === '-e' || w === '--regexp') { out.push(k + 1); k += 1; continue; }
    if (w === '--') { if (plain < 0 && !out.length) plain = k + 1; break; }
    if (w.startsWith('-')) { if (SEARCH_VALUE_OPTS.has(w)) k += 1; continue; }
    if (plain < 0) plain = k;
    break;
  }
  return out.length ? out : (plain >= 0 && plain < c.length ? [plain] : []);
}
// Indexes (into `c`) of the words that are only text in one command, read as the shell lists it (`shellCommands` raw).
function textAt(c, { lookups = true } = {}) {
  let i = 0;
  // `command -v x` (and -V) looks a name up; it runs nothing.
  for (;;) {
    if (i < c.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i])) { i += 1; continue; }
    if (i < c.length && ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'].includes(c[i])) { i += 1; continue; }
    if (c[i] === 'command' && /^-[pvV]*[vV][pvV]*$/.test(c[i + 1] ?? '')) return lookups ? c.map((_, k) => k).filter((k) => k > i + 1) : [];
    if (i < c.length && ['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'xargs', 'nice', 'builtin'].includes(programOf([c[i]]))) { i += 1; while (i < c.length && c[i].startsWith('-')) i += 1; continue; }
    break;
  }
  const prog = programOf(c.slice(i));
  const out = [];
  const valuesOf = (from, shorts, longs) => {
    for (let k = from; k < c.length; k += 1) {
      const w = c[k];
      if (shorts.some((s) => new RegExp(`^-[A-Za-z]*${s}$`).test(w)) || longs.includes(w)) { out.push(k + 1); k += 1; continue; }
      if (shorts.some((s) => w.startsWith(`-${s}`) && w.length > 2) || longs.some((l) => w.startsWith(`${l}=`))) out.push(k);
    }
  };
  if (prog === 'git') {
    const sub = gitSub(c.slice(i));
    const at = sub < 0 ? -1 : i + sub;
    if (['commit', 'tag'].includes(c[at])) valuesOf(at + 1, ['m', 'F'], ['--message', '--file']);
    if (c[at] === 'grep') out.push(...patternAt(c, at));
  }
  if (prog === 'gh' && ['pr', 'issue'].includes(c[i + 1]) && ['create', 'comment', 'edit'].includes(c[i + 2])) valuesOf(i + 3, ['t', 'b', 'F'], ['--title', '--body', '--body-file']);
  if (SEARCHERS.includes(prog)) out.push(...patternAt(c, i));
  if (lookups && ['which', 'type', 'whence', 'where'].includes(prog)) out.push(...c.map((_, k) => k).filter((k) => k > i && !c[k].startsWith('-')));
  // find -exec grep <p> {} +: the pattern of the search it runs.
  if (prog === 'find') {
    for (let k = i + 1; k < c.length; k += 1) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(c[k]) || !SEARCHERS.includes(programOf([c[k + 1] ?? '']))) continue;
      out.push(...patternAt(c, k + 1));
    }
  }
  return out.filter((k) => k < c.length && onlyText(c[k]));
}
// A `for … in` list's words (`for f in src/lib/supabase/*.ts`): read by their last part only, since the loop may run
// one (`for f in a/vercel; do $f deploy`), but a folder on the way names nothing.
const forListAt = (c) => (['for', 'select'].includes(c[0]) && c[2] === 'in' ? c.map((_, k) => k).filter((k) => k > 2) : []);
// A name lookup's answer used as a command (`$(which <p>) deploy`, `which <p> | xargs …`) is a call after all: lookups
// are text only in a line with no substitution and no pipe.
const lookupsInert = (raw) => !/\$\(|`|(^|[^|])\|(?!\|)/.test(String(raw));
// A command that reads its message from its input (`git commit -F -`, `gh pr create --body-file -`): the here-document
// fed to it is text.
function readsTextIn(c) {
  const k = textAt(c);
  return k.some((x) => c[x] === '-' || /^(-[mFtb]|--(message|file|body|title|body-file)=)-$/.test(c[x]));
}

/**
 * The words of `raw` that could start a program, for the name check of the machine-wide form: every word as the shell
 * splits it (quotes and backslashes taken out, a string handed to a shell kept whole) and every here-document body, but
 * not the words that are only text (m2: a commit or tag message, a gh title or body, a search pattern, a `command -v` /
 * `which` / `type` name, a `for … in` list), nor a quoted here-document fed to a command that reads its message from it.
 * The same word anywhere else still counts.
 */
export function callWords(raw) {
  const h = heredocs(raw);
  const out = [];
  for (const c of shellCommands(raw, { raw: true })) {
    const skip = new Set(textAt(c, { lookups: lookupsInert(raw) }));
    const last = new Set(forListAt(c));
    c.forEach((w, k) => { if (last.has(k)) out.push(w.endsWith('/') ? '' : basename(w)); else if (!skip.has(k)) out.push(w); });
  }
  // A redirection's word (`bash <<< "<p> deploy"`, `< file`) is not in a command's list: read it too.
  const all = shellWords(joinLines(h.text).replace(/\n/g, ' ; '));
  all.forEach((w, k) => { if (['<', '>'].includes(all[k - 1]) && !['<', '>', '&'].includes(w)) out.push(w); });
  // Each here-document's owner: the command its `<<` sits in.
  const text = h.text;
  const owners = [];
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"') i += 1; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') { i += 2; continue; }
      owners.push(shellCommands(text.slice(0, i).replace(/<</g, '< '), { raw: true }).at(-1) ?? []);
      i += 1;
    }
  }
  h.bodies.forEach((b, n) => {
    const owner = owners[n] ?? [];
    if (!(b.quoted || !/[$`]/.test(b.text)) || !readsTextIn(owner)) out.push(b.text);
  });
  return out;
}

// Where the first command of `raw` ends: the first `;`, `&`, `|`, line break, bracket, backtick or `$(` outside quotes.
export function firstCommandEnd(raw) {
  const s = String(raw);
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"') i += 1; else if (q === '"' && (ch === '`' || (ch === '$' && s[i + 1] === '('))) return i; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (';&|\n()`'.includes(ch) || (ch === '$' && s[i + 1] === '(')) return i;
  }
  return s.length;
}

export function decide(input, args) {
  // The machine-wide form (L1031) reads root's copy, written once by setup.mjs managed-settings and never refreshed: no age
  // limit, but root's alone. `ownerUid` is a test's stand-in for root; parseArgs never sets it. A copy that can't be used
  // blocks, saying how to switch the machine-wide guard off (guard b).
  const snap = args.machineWide ? readSnapshot(args.snapshot, { maxAgeMs: Infinity, ownerUid: args.ownerUid ?? 0 }) : readSnapshot(args.snapshot);
  const broken = (why) => block(args.machineWide ? `${why}; ${MACHINE_WIDE_WAY_OUT}` : why);
  if (!snap.ok) return broken(snap.reason);
  const prod = snap.rules.production;
  if (!prod || !Array.isArray(prod.env_files) || !Array.isArray(prod.programs) || !Array.isArray(prod.hosts)) {
    return broken('the rules snapshot has no production block');
  }
  // A Mac disk does not care about letter case, so names are compared folded (audit R-0b-44 round 2 MAT-2).
  const envFiles = prod.env_files.map((f) => fold(f));
  const programs = prod.programs.map((p) => fold(p));
  const touchesEnv = (p) => {
    const abs = isAbsolute(p) ? p : (typeof input.cwd === 'string' && isAbsolute(input.cwd) ? resolve(input.cwd, p) : p);
    const real = landingPath(abs) ?? abs;
    return envFiles.some((f) => [real, abs, p].some((x) => inside(fold(x), f)));
  };
  // A word naming a production settings file by its short name or a wildcard (`p*.x`), which a
  // `cd` beforehand could point at the real file (audit R-0b-44 M-5).
  // The machine-wide form (#487 r2 m1) judges a wildcard only in the folder it is read in, when that folder is certain:
  // `wildFolder` is the call's own folder when the command is plainly readable and changes folder nowhere (no cd, pushd,
  // popd), else null and the wildcard matches by name alone, as in the role form. So `ls -d .*` in a project passes for
  // every session, and `ls -d .*` in the production file's own folder, or `cat /srv/app/p*` anywhere, is still blocked.
  let wildFolder = null;
  // A wildcard the shell itself expands: every place it is written in the command stands alone, unquoted and not after
  // `=` (`'.p*'`, `.p\*` and `--include=.p*` are patterns a program matches in some other folder).
  let wildRaw = '';
  // Only in the first command of the line (#487 r4 m1): a command before a later one may have changed folder in a way the
  // guard does not know (a function, an alias, a tool of its own).
  let wildEnd = 0;
  const expandedHere = (w) => {
    const at = [...wildRaw.matchAll(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
    return at.length > 0 && at.every((m) => m.index + w.length <= wildEnd && /(^|[\s;&|(])$/.test(wildRaw.slice(0, m.index)) && /^($|[\s;&|)])/.test(wildRaw.slice(m.index + w.length)));
  };
  const namesEnv = (w) => {
    const name = basename(w);
    // A name of stars alone (`dist/*`) names no file in particular (L46; round 3 MAT-14).
    if (!name || /^\*+$/.test(name)) return false;
    let re = null;
    try { re = /[*?[]/.test(name) ? globRe(fold(name), 'i') : null; } catch { return true; }
    if (!re) return envFiles.some((f) => basename(f) === fold(name));
    const dir = dirname(w);
    if (wildFolder === null || /[*?[~$]/.test(dir) || !expandedHere(w)) return envFiles.some((f) => re.test(basename(f)));
    const at = resolve(wildFolder, dir);
    const here = [at, realFolder(at)].filter(Boolean).map(fold);
    return envFiles.some((f) => re.test(basename(f)) && [f, landingPath(f)].filter(Boolean).some((x) => here.includes(fold(dirname(x)))));
  };
  for (const p of toolPaths(input)) if (touchesEnv(p)) return block(`"${p}" is a production settings file`);

  // The machine-wide form (L1044 M1) blocks production names only: a production settings file on a tool path or in a
  // command's words, a production program (also through a package runner) and a host. It never applies the role guard's
  // shell-shape and whole-folder rules to every session on the Mac (the owner's and the lead's normal work); role sessions
  // keep them through their own settings. Words are read as written, so a name behind `$VAR` or `$(…)` is not seen: the
  // ruled trade (L1044), and the role guard is the one that refuses such shapes.
  const wide = args.machineWide === true;
  if (input.tool_name === 'Bash') {
    // A short name is read from the session's folder; without it the guard can't tell (lane 3, R-0b-70).
    if (!wide && (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))) return block('the call gives no working folder, so a short file name can\'t be checked');
    // Read raw where a here-document matters: joining lines first could move where its body ends (L46).
    const raw = String(input.tool_input?.command ?? '');
    const cmd = joinLines(raw);
    // Shapes no hook can read are refused as a class (lib.mjs `unreadable`; R-0b-44 round 2 MAT-1, R-0b-70).
    const why = unreadable(raw);
    if (why && !wide) return block(`${why}; write the command out plainly`);
    // The machine-wide form lets those shapes run (L1044 M1), but not with a production program named anywhere in them
    // (#487 r2 M1, L1057 option a): a wrapper (`timeout 300 <p>`, `sudo -u x <p>`), find -exec, a string or here-doc
    // handed to a shell, or code handed to an interpreter (`python3 -c`, `node -e`, `osascript -e`) would otherwise start
    // it unseen. Every word of the raw command counts, inside quotes and here-doc bodies too. A plain command keeps the
    // narrow read below, so `grep vercel` or `npm i vercel` still pass.
    // A runner (#487 r4 M1, L1066: a package runner, an interpreter reading `-`, tmux, ssh, at, a watcher, …) is read the
    // same way. Words that are only text (m2: a commit message, a search pattern, a `which` name, a `for … in` list) are
    // left out, unless the same word is used as a call elsewhere in the line.
    const runner = wide && !why ? runnerIn(raw) : null;
    if (why || runner) {
      const named = programNamedIn(wide ? callWords(raw).join(' ') : raw, programs);
      if (named) return block(`${why ?? runner}, and it names the production program "${named}"; run it plainly, where the guard can read it`);
    }
    // Each protected file as listed and where it really is (a folder link, or /tmp on a Mac), folded.
    const listed = [...prod.env_files, ...(Array.isArray(snap.rules.secrets?.paths) ? snap.rules.secrets.paths : [])].filter((f) => typeof f === 'string' && isAbsolute(f));
    const protectedFiles = [...new Set(listed.flatMap((f) => [f, landingPath(f)]).filter(Boolean).map(fold))];
    // The folder a wildcard is read in is certain (m1 above) only when nothing changes folder, a string handed to a shell
    // included (its words are read below too).
    const within = [...commandsWithin(raw)];
    // Nor when a program that matches patterns in folders of its own runs (`find /srv -name .p*`: bash hands an unmatched
    // wildcard on as written).
    if (wide && !why && typeof input.cwd === 'string' && isAbsolute(input.cwd)
      && !within.some((c) => FOLDER_CHANGERS.includes(fold(programOf(c) ?? '')) || PATTERN_TAKERS.includes(fold(programOf(c) ?? '')))) { wildFolder = input.cwd; wildRaw = raw; wildEnd = firstCommandEnd(raw); }
    const folderWhy = wide ? null : folderWriteWhy(raw, { cwd: input.cwd, protectedFiles, home: process.env.HOME || homedir(), projectDir: process.env.CLAUDE_PROJECT_DIR });
    if (folderWhy) return block(folderWhy);
    // `command -v <p>` looks a name up and runs nothing (#487 r4 m2): read as `which <p>` here.
    for (const c of commandsWithin(wide && lookupsInert(raw) ? raw.replace(/(^|[\s;&|(])command([ \t]+-[pvV]*[vV][pvV]*)(?=[ \t])/g, '$1which$2') : raw)) {
      const prog = programOf(c);
      if (programs.includes(fold(prog))) return block(`"${prog}" reaches production`);
      // Package runners that would start the program: npx <p>, bunx <p>, pnpm dlx <p>, npm exec <p>.
      if (['npx', 'bunx', 'pnpx'].includes(prog) || (['pnpm', 'npm', 'yarn'].includes(prog) && ['dlx', 'exec', 'x'].includes(c[1]))) {
        if (c.slice(1).some((w) => programs.includes(fold(basename(w.replace(/^--?[a-z-]+=/, '').split('@')[0]))))) return block('a package runner starts a production program');
      }
    }
    // Each word as the shell would expand its braces, and the value after `=` too (`of=<file>`, `F=<file>`). The machine-wide
    // form reads the words of a string handed to a shell (`bash -c "cd /srv && cat p*"`) too (#487 r3: the role form refuses
    // those shapes), and in a shape no hook can read (`python3 -c "open('/srv/x')"`) every word-like run of its text.
    // A substitution inside quotes (`echo "$(cat p*)"`) is read as its own words too (#487 r4).
    const words = wide ? [...bothWords(cmd), ...within.flat(), ...(why ? [...wordsIn(raw), ...shellWords(raw.replace(/["']/g, ' '))] : [])] : bothWords(cmd);
    for (const word of words) {
      for (const w of expandBraces(word)) {
        if (prod.hosts.some((h) => fold(w).includes(fold(h)))) return block('the command names a production host');
        const forms = [w, ...(w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [])];
        if (forms.some((x) => x && !x.startsWith('-') && (touchesEnv(x) || namesEnv(x)))) return block(`the command names a production settings file (${word})`);
      }
    }
  }
  const url = input.tool_input?.url;
  if (typeof url === 'string' && prod.hosts.some((h) => fold(url).includes(fold(h)))) return block('the call names a production host');
  return pass();
}

// The one hook with a machine-wide form (L1031): `--machine-wide --snapshot <root's copy>`, from managed-settings.json.
if (isMain(import.meta.url)) runHook(decide, {}, { machineWide: true });
