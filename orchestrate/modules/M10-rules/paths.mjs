// paths.mjs — how M10 Rules matches a changed file against a pattern in the rules (tiers, protected files, lanes,
// effect paths). One matcher, so the Mini and the GitHub-side checker agree on every path.
//
// The pattern language (spec review 0b-1, MAT-7):
//   `**` = zero or more whole segments; `*` = any characters inside one segment; `?` = one character; `{a,b}` = either.
//   A pattern with no `/` matches that name as any segment at any depth (`.mcp.json`, `vercel.{json,ts}`).
//   A pattern ending in `/` is a folder entry: `.claude/` = `**/.claude/**`; `docs/research/` = `docs/research/**`.
//   Any other pattern is anchored at the repo root, unless it starts with `**/`.
//   Matching ignores case and Unicode form (the Mac's file system does), so `.CLAUDE/settings.json` is protected.

// The floor M10 always protects; a product's rules file can add to it, never remove from it (MAT-2).
export const PROTECTED_FLOOR = Object.freeze([
  'orchestrate/**', '**/.github/**', '**/.claude/**', '**/.mcp.json', '**/AGENTS.md', '**/CLAUDE.md',
  '**/CLAUDE.local.md', '**/.codex/**', '**/vercel.{json,ts,js,mjs,cjs,mts}', 'docs/blueprint/decided.yaml',
  'docs/blueprint/exit-tests.yaml', 'tests/exit/**',
]);

const fold = (s) => s.normalize('NFC').toLowerCase();

// A path the matcher can trust: relative, `/`-separated, no `..`, no empty segment, no backslash or NUL.
function shapeProblem(p) {
  if (typeof p !== 'string' || p === '') return 'empty path';
  if (p.includes('\\') || p.includes('\0')) return 'backslash or NUL in path';
  if (p.startsWith('/')) return 'absolute path';
  const segs = p.split('/');
  if (segs.some((s) => s === '')) return 'empty path segment';
  if (segs.some((s) => s === '..' || s === '.')) return 'dot segment in path';
  return null;
}

// What a changed file's path must pass before any answer. Stricter than the matcher: letters outside plain ASCII are
// refused, because the Mac's file system treats some pairs as the same name (ſ and s, ß and ss, ﬁ and fi) that no
// simple fold can match, so a look-alike could slip past a protected path or a lane. The matcher itself still matches
// such names, folding case and Unicode form where it can.
export function pathProblem(p) {
  return shapeProblem(p) ?? (/[^\x20-\x7e]/.test(p) ? 'non-ASCII letter or control character in path' : null);
}

function expandBraces(pat) {
  const open = pat.indexOf('{');
  if (open < 0) return [pat];
  let depth = 0;
  for (let i = open; i < pat.length; i++) {
    if (pat[i] === '{') depth++;
    else if (pat[i] === '}' && --depth === 0) {
      const parts = [];
      let start = open + 1; let d = 0;
      for (let j = open + 1; j < i; j++) {
        if (pat[j] === '{') d++;
        else if (pat[j] === '}') d--;
        else if (pat[j] === ',' && d === 0) { parts.push(pat.slice(start, j)); start = j + 1; }
      }
      parts.push(pat.slice(start, i));
      return parts.flatMap((part) => expandBraces(pat.slice(0, open) + part + pat.slice(i + 1)));
    }
  }
  throw new Error(`unclosed { in pattern "${pat}"`);
}

function segRegex(seg) {
  const body = seg.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`, 'u');
}

// Compile one pattern from the rules into a function path → boolean. Throws on a pattern it can't read, so the
// validator can call the rules file corrupt instead of matching nothing.
export function compile(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') throw new Error('empty pattern');
  let p = fold(pattern.trim());
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = (p.slice(0, -1).includes('/') ? '' : '**/') + p.slice(0, -1) + '/**';
  else if (!p.includes('/')) p = `**/${p}/**`;          // a bare name: that segment anywhere, file or folder
  const alternatives = expandBraces(p).map((alt) => {
    const segs = alt.split('/');
    if (segs.some((s) => s === '')) throw new Error(`empty segment in pattern "${pattern}"`);
    return segs.map((s) => (s === '**' ? '**' : segRegex(s)));
  });
  return (path) => {
    if (shapeProblem(path)) return false;
    const segs = fold(path).split('/');
    return alternatives.some((pat) => matchSegs(pat, 0, segs, 0, new Map()));
  };
}

function matchSegs(pat, i, segs, j, memo) {
  const key = `${i},${j}`;
  if (memo.has(key)) return memo.get(key);
  let r;
  if (i === pat.length) r = j === segs.length;
  else if (pat[i] === '**') r = matchSegs(pat, i + 1, segs, j, memo) || (j < segs.length && matchSegs(pat, i, segs, j + 1, memo));
  else r = j < segs.length && pat[i].test(segs[j]) && matchSegs(pat, i + 1, segs, j + 1, memo);
  memo.set(key, r);
  return r;
}

// A list of patterns → path → the first pattern that matched (or null).
export function compileList(patterns) {
  const compiled = (patterns ?? []).map((p) => [p, compile(p)]);
  return (path) => compiled.find(([, m]) => m(path))?.[0] ?? null;
}
