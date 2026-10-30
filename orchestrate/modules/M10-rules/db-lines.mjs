// db-lines.mjs — the deny-by-default reading of a code file's lines for database changes (lead call L32).
//
// WHY. Rounds 3 to 11 of the 0b-1 audit each found one more way of writing a database change that a list of patterns
// missed: escaped names, quoted names, account commands, library calls with a suffix. A list of bad forms can never be
// complete, so this reads the other way round: a line counts as a possible database change unless it is proven
// harmless. A false alarm costs Joe one Approve tap; a miss costs live data. The specific patterns in classify.mjs
// stay, as clearer reasons in the read-back.
//
// A line is harmless only when it is blank (spaces and tabs only). Every other line counts, even a comment or a
// line with no listed word: it may sit inside a multi-line SQL string, so no list of words can prove it harmless.
// Rounds 12 and 13 of the audit tried narrower allowances and broke each one: a SELECT can call any function; a
// comment can hold a line break some language honours (CR, U+2028), be run (`/*!` in MySQL, `//go:generate`, a cgo
// preamble, a Python coding line), or change which nearby lines are code (`// */` after a `/*`); a quoted string runs
// in shell, Ruby and YAML. A line can't be proven harmless on its own, so the only allowance left is a blank one.
// The word lists below only name the reason. Words are read after undoing escapes (`\u0064rop`, `U&"d\0072op"`),
// folding look-alike letters (NFKC) and splitting camelCase, PascalCase and snake_case, so `dropTable`,
// `CreateTable`, `drop_table` and `"DROP"` all read as `drop`. Every check here runs in time proportional to the
// line's length.

// Every PostgreSQL command word except the read-only ones (SELECT, SHOW, EXPLAIN, VALUES, TABLE, WITH), plus the
// effect words other databases and libraries use. A word that is also ordinary code (`set`, `do`, `end`, `import`)
// is listed on purpose: deny by default.
export const EFFECT_WORDS = Object.freeze(new Set([
  'abort', 'alter', 'analyze', 'analyse', 'begin', 'call', 'checkpoint', 'close', 'cluster', 'comment', 'commit', 'copy',
  'create', 'deallocate', 'declare', 'delete', 'discard', 'do', 'drop', 'end', 'execute', 'exec', 'fetch', 'grant',
  'import', 'insert', 'listen', 'load', 'lock', 'merge', 'move', 'notify', 'prepare', 'reassign', 'refresh', 'reindex',
  'release', 'reset', 'revoke', 'rollback', 'savepoint', 'security', 'set', 'start', 'truncate', 'unlisten', 'update',
  'vacuum', 'upsert', 'replace', 'into', 'rename', 'owner', 'owned', 'add', 'remove', 'change', 'modify', 'destroy',
  'purge', 'wipe', 'seed', 'migrate', 'migration', 'migrations', 'constraint', 'restore', 'dump', 'flush',
]));

// Words that name a database client or a raw-query call.
export const CLIENT_WORDS = Object.freeze(new Set([
  'query', 'queries', 'sql', 'raw', 'unsafe', 'rpc', 'knex', 'prisma', 'sequelize', 'drizzle', 'kysely', 'typeorm',
  'supabase', 'pg', 'postgres', 'postgresql', 'psql', 'mysql', 'sqlite', 'mongo', 'mongoose', 'redis', 'pool', 'db',
  'database', 'datasource', 'repository', 'orm', 'schema', 'alembic', 'op', 'interface', 'connection', 'cursor', 'tx',
  'transaction',
]));

const BUILT = /(['"`])\s*(\+|\|\|)\s*['"`]|\b(format|concat|concat_ws|chr|char|fromCharCode|fromCodePoint|atob|decode|unescape|quote_ident|quote_literal)\s*\(/i;
const MAX_LINE = 20_000;      // a longer line is not read: it counts
const MAX_TOTAL = 1_000_000;  // nor is a side of a file with more text than this

const codePoint = (hex) => { const n = parseInt(hex, 16); return n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' '; };

// Undo the escapes a name can hide behind, then fold look-alike letters.
function unescape(text) {
  return text
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, h) => codePoint(h))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => codePoint(h))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => codePoint(h))
    .replace(/\\\+([0-9a-f]{6})/gi, (_, h) => codePoint(h))
    .replace(/\\([0-9a-f]{4})/gi, (_, h) => codePoint(h))
    .normalize('NFKC');
}

// The lower-case words of a line: camelCase and PascalCase split, then every run of letters.
export function wordsOf(text) {
  return unescape(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/(?<![A-Z])([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[a-z]+/g) ?? [];
}

const effectWord = (words) => words.find((w) => EFFECT_WORDS.has(w));
const clientWord = (words) => words.find((w) => CLIENT_WORDS.has(w));

// Why a line can't be proven harmless, or null when it can.
export function lineRisk(line) {
  if (typeof line !== 'string') return 'not text';
  if (line.length > MAX_LINE) return 'too long to read';
  if (/^[ \t]*$/.test(line)) return null;
  const t = line.trim();
  if (BUILT.test(unescape(t))) return 'text built at run time';
  // Anything else counts. A line with no listed word still can't be proven harmless: it may sit inside a multi-line
  // SQL string, where an unlisted command (`optimize table t`) would run. The word, when there is one, is the reason.
  const words = wordsOf(t);
  const w = effectWord(words) ?? clientWord(words);
  return w ? `"${w}"` : 'not a line known to be harmless';
}

// The first line of a list that can't be proven harmless, as { n, why } (n counts from 1), or null.
export function firstRiskyLine(lines) {
  let total = 0;
  for (const l of lines) if ((total += typeof l === 'string' ? l.length : 0) > MAX_TOTAL) return { n: lines.length, why: 'too much text to read' };
  for (let i = 0; i < lines.length; i++) {
    const why = lineRisk(lines[i]);
    if (why) return { n: i + 1, why };
  }
  return null;
}
