// The production-write guard (design v4 §14.1.5, launch check 10, R-0b-36). Registered on every
// tool in every role file and in the machine-wide file as a fallback. It reads ONLY the rules
// snapshot, never GitHub or the network.
//
// Snapshot shape M4 reads (lane 1 publishes it; assumed until the shared reader lands):
//   rules.production = { env_files: [absolute paths], programs: [hosting / database program names],
//                        hosts: [production host names] }
// A missing or stale snapshot, or one without that block, blocks every call (fail closed).

import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isMain, runHook, block, pass, toolPaths, shellCommands, bothWords, programOf, landingPath, realFolder, inside, joinLines, unreadable, heredocs, expandBraces, fold, globRe } from './lib.mjs';
import { readSnapshot } from './snapshot.mjs';

// ---- whole-folder writes (LEAD-CALLS L41 G2: deny by default) ----
//
// A command that writes, deletes, moves or unpacks a whole folder never names the file inside it, so the name
// checks below can't see it touch a production settings file. Such a command is refused when its target folder
// holds a protected file (a production settings file or a listed secret path), and a recursive delete of the
// session's folder, the project or any folder above them is always refused. Reads of a whole folder (`grep -r`,
// `tar c`) are left to the sandbox's read-deny list, the wall for reads.

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
    for (const t of targets.flatMap((x) => expandBraces(x))) {
      if (wrote) return `"${t}" is written as a whole after "${wrote}" in the same command; run it as a command of its own`;
      if (unknownWord(t)) return `"${t}" is written as a whole, and the guard can't tell where a variable in it leads`;
      const forms = expand(t, home, [...cwds]);
      if (typeof forms === 'string') return `"${t}" ${forms}`;
      if (forms.some((f) => !isAbsolute(f)) && lost) return `"${t}" is written as a whole after a folder change the guard can't follow`;
      for (const f of forms) {
        if (dotsAfterPattern(f)) return `"${t}" has a ".." after a pattern, which the guard can't place`;
        for (const abs of (isAbsolute(f) ? [sep] : [...cwds]).flatMap((b) => [resolve(b, f), physical(b, f)])) {
          const why = judge(t, abs, deletes, protectedFiles, shielded);
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
function judge(t, abs, deletes, protectedFiles, shielded) {
  const parts = abs.split(sep);
  const first = parts.findIndex((x) => /[*?[]/.test(x));
  const front = fixedFront(abs);
  let pp = null;
  if (first >= 0) {
    try { pp = parts.slice(first).filter(Boolean).map((x) => (x === '**' ? '**' : globRe(fold(x), 'i'))); } catch { return `"${t}" holds a pattern the guard can't read`; }
  }
  const folders = [front, realFolder(front) ?? front].map(fold);
  const reached = (x) => folders.some((d) => (pp ? x !== d && inside(x, d) && matchesFront(pp, x.slice(d.length).split(sep).filter(Boolean)) : inside(x, d)));
  if (protectedFiles.some(reached)) return `"${t}" is a folder holding a protected file, written as a whole`;
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

export function decide(input, args) {
  const snap = readSnapshot(args.snapshot);
  if (!snap.ok) return block(snap.reason);
  const prod = snap.rules.production;
  if (!prod || !Array.isArray(prod.env_files) || !Array.isArray(prod.programs) || !Array.isArray(prod.hosts)) {
    return block('the rules snapshot has no production block');
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
  const namesEnv = (w) => {
    const name = basename(w);
    // A name of stars alone (`dist/*`) names no file in particular (L46; round 3 MAT-14).
    if (!name || /^\*+$/.test(name)) return false;
    let re = null;
    try { re = /[*?[]/.test(name) ? globRe(fold(name), 'i') : null; } catch { return true; }
    return envFiles.some((f) => (re ? re.test(basename(f)) : basename(f) === fold(name)));
  };
  for (const p of toolPaths(input)) if (touchesEnv(p)) return block(`"${p}" is a production settings file`);

  if (input.tool_name === 'Bash') {
    // A short name is read from the session's folder; without it the guard can't tell (lane 3, R-0b-70).
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return block('the call gives no working folder, so a short file name can\'t be checked');
    // Read raw where a here-document matters: joining lines first could move where its body ends (L46).
    const raw = String(input.tool_input?.command ?? '');
    const cmd = joinLines(raw);
    // Shapes no hook can read are refused as a class (lib.mjs `unreadable`; R-0b-44 round 2 MAT-1, R-0b-70).
    const why = unreadable(raw);
    if (why) return block(`${why}; write the command out plainly`);
    // Each protected file as listed and where it really is (a folder link, or /tmp on a Mac), folded.
    const listed = [...prod.env_files, ...(Array.isArray(snap.rules.secrets?.paths) ? snap.rules.secrets.paths : [])].filter((f) => typeof f === 'string' && isAbsolute(f));
    const protectedFiles = [...new Set(listed.flatMap((f) => [f, landingPath(f)]).filter(Boolean).map(fold))];
    const folderWhy = folderWriteWhy(raw, { cwd: input.cwd, protectedFiles, home: process.env.HOME || homedir(), projectDir: process.env.CLAUDE_PROJECT_DIR });
    if (folderWhy) return block(folderWhy);
    for (const c of shellCommands(raw)) {
      const prog = programOf(c);
      if (programs.includes(fold(prog))) return block(`"${prog}" reaches production`);
      // Package runners that would start the program: npx <p>, bunx <p>, pnpm dlx <p>, npm exec <p>.
      if (['npx', 'bunx', 'pnpx'].includes(prog) || (['pnpm', 'npm', 'yarn'].includes(prog) && ['dlx', 'exec', 'x'].includes(c[1]))) {
        if (c.slice(1).some((w) => programs.includes(fold(basename(w.replace(/^--?[a-z-]+=/, '').split('@')[0]))))) return block('a package runner starts a production program');
      }
    }
    // Each word as the shell would expand its braces, and the value after `=` too (`of=<file>`, `F=<file>`).
    for (const word of bothWords(cmd)) {
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

if (isMain(import.meta.url)) runHook(decide);
