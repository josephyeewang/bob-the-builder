// fakes.mjs — planted fake credentials for the tests. Built at run time from pieces, so no file in public Bob holds a
// whole key-shaped string (secret scanners would flag it, and a reader can't tell a fake from a leak). None of these
// is, or was ever, a real key.

// A deterministic mixed-case run: upper, lower and digits, high entropy, never hex-only.
export function run(n, seed = 7) {
  const abc = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += abc[(x >>> 16) % abc.length]; }
  return s;
}

const j = (...p) => p.join('');

export const FAKE = Object.freeze({
  github: j('gh', 'p_', run(36, 1)),
  githubShort: j('gh', 'p_', run(10, 2)),
  githubApp: j('gh', 's_', run(36, 3)),
  githubPat: j('github', '_pat_', run(22, 4), '_', run(40, 5)),
  vercelPrefixed: j('vc', 'p_', run(24, 6)),
  vercelClassic: run(24, 7),
  supabasePat: j('sb', 'p_', run(40, 8)),
  supabaseSecret: j('sb_', 'secret_', run(30, 9)),
  supabaseJwt: j('ey', 'J', run(20, 10), '.ey', 'J', run(40, 11), '.', run(43, 12)),
  anthropic: j('sk', '-ant-api03-', run(60, 13)),
  skShort: j('sk', '-', run(9, 14)),
  generic: run(48, 15),
  dbPassword: j('pw', run(14, 16)),
});

// A fixture's `{{FAKE.name}}` becomes that fake key; `{{FAKE.name:ansi}}` (or `:zw`, `:bel`) is the same key split in the
// middle by a terminal code, a zero-width character or a bell, which a lane that masks before stripping lets through
// whole (R-0b-126 audit round 7).
const SPLIT = { ansi: '\u001b[0m', zw: '\u200b', bel: '\u0007' };
export const fillFakes = (s) => s.replace(/\{\{FAKE\.(\w+)(?::(\w+))?\}\}/g, (_, k, sp) => {
  const key = FAKE[k]; const h = key.length >> 1;
  return sp ? `${key.slice(0, h)}${SPLIT[sp]}${key.slice(h)}` : key;
});
