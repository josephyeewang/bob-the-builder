// db-lines.mjs — the deny-by-default reading of a code file's lines for database changes (lead call L32).
//
// WHY. Rounds 3 to 11 of the 0b-1 audit each found one more way of writing a database change that a list of patterns
// missed: escaped names, quoted names, account commands, library calls with a suffix. A list of bad forms can never be
// complete, so this reads the other way round: a line counts as a possible database change unless it is proven
// harmless. A false alarm costs Joe one Approve tap; a miss costs live data. The specific patterns in classify.mjs
// stay, as clearer reasons in the read-back.
//
// A line is harmless only when it is one of:
//   - blank, or a comment by itself (`//` outside .sql files, `--` in .sql files, `#` in script files, or a whole
//     `/* … */` with nothing after it);
//   - a plain SELECT read, outside the migration and repair folders: the word `select`, no effect word, and no call
//     except the read calls listed below;
//   - in a test folder or test file, a line whose effect and client words all sit inside plain string literals (a
//     fixture).
// Every other line counts, even one with no listed word: it may sit inside a multi-line SQL string, so no list of
// words can prove it harmless. The word lists below only name the reason, and keep plain SELECTs and fixtures apart.
// Words are read after undoing escapes (`drop`, `U&"d\0072op"`), folding look-alike letters (NFKC) and splitting
// camelCase, PascalCase and snake_case, so `dropTable`, `CreateTable`, `drop_table` and `"DROP"` all read as `drop`.
// Two string literals joined with `+` or `||`, or a call that builds text from parts, counts too: text built at run
// time can't be proven harmless.

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

// Calls a plain SELECT line may make: SQL read functions and the read steps of query builders.
const READ_CALLS = new Set(['select', 'from', 'where', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is',
  'not', 'order', 'limit', 'range', 'single', 'maybe', 'filter', 'match', 'count', 'sum', 'min', 'max', 'avg', 'coalesce',
  'lower', 'upper', 'now', 'length', 'query', 'sql', 'knex', 'db', 'then', 'await', 'map', 'json', 'log']);

const SCRIPT = /\.(py|rb|sh|bash|zsh|ya?ml|toml|r|pl|ps1|conf|ini)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|fixtures|__fixtures__)\/|\.(test|spec)\.[a-z0-9]+$/i;
export const isTestPath = (p) => typeof p === 'string' && TEST_PATH.test(p);
const BUILT = /(['"`])\s*(\+|\|\|)\s*['"`]|\b(format|concat|concat_ws|chr|char|fromCharCode|fromCodePoint|atob|decode|unescape|quote_ident|quote_literal)\s*\(/i;
const MAX_LINE = 20_000;   // a longer line is not read: it counts

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
  return unescape(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[a-z]+/g) ?? [];
}

const effectWord = (words) => words.find((w) => EFFECT_WORDS.has(w));
const clientWord = (words) => words.find((w) => CLIENT_WORDS.has(w));

function commentOnly(t, path) {
  if (t.startsWith('//')) return !/\.sql$/i.test(path);
  if (t.startsWith('--')) return /\.sql$/i.test(path);
  if (t.startsWith('#')) return SCRIPT.test(path);
  if (t.startsWith('/*')) { const end = t.indexOf('*/', 2); return end >= 0 && !t.slice(end + 2).trim(); }
  return false;
}

// A plain SELECT read: `select`, no effect word, and every call is a read call.
function plainSelect(t, words) {
  if (!words.includes('select') || effectWord(words)) return false;
  for (const m of unescape(t).matchAll(/([A-Za-z_][\w$]*)\s*\(/g)) {
    if (!wordsOf(m[1]).every((w) => READ_CALLS.has(w))) return false;
  }
  return true;
}

const withoutStrings = (t) => t.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`/g, ' ');

// Why a line can't be proven harmless, or null when it can.
export function lineRisk(line, { path = '', migration = false, test = isTestPath(path) } = {}) {
  if (typeof line !== 'string') return 'not text';
  if (line.length > MAX_LINE) return 'too long to read';
  const t = line.trim();
  if (!t || commentOnly(t, path)) return null;
  if (BUILT.test(unescape(t))) return 'text built at run time';
  const words = wordsOf(t);
  if (!migration && plainSelect(t, words)) return null;
  if (test) {
    const bare = wordsOf(withoutStrings(t));
    if (!effectWord(bare) && !clientWord(bare)) return null;
  }
  // Anything else counts. A line with no listed word still can't be proven harmless: it may sit inside a multi-line
  // SQL string, where an unlisted command (`optimize table t`) would run. The word, when there is one, is the reason.
  const w = effectWord(words) ?? clientWord(words);
  return w ? `"${w}"` : 'not a line known to be harmless';
}

// The first line of a list that can't be proven harmless, as { n, why } (n counts from 1), or null.
export function firstRiskyLine(lines, opts) {
  for (let i = 0; i < lines.length; i++) {
    const why = lineRisk(lines[i], opts);
    if (why) return { n: i + 1, why };
  }
  return null;
}
