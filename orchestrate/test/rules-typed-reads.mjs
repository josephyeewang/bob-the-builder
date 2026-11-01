// rules-typed-reads.mjs — finds a module that checks a rules value as a number or a flag without going through
// rules.num(), rules.dec() or rules.flag() (lead calls L96, L104). The rules file is text and the reader converts only
// some keys, so a check like `Number.isInteger(rules.get('claims.stuck_min'))` refuses the "30" the file really holds.
// The test beside this file runs the scan over every module outside M10.
//
//   typedReadProblems(source) → [{ line, text, why }]
//
// It reads the source line by line, without a parser, so it is a net with known holes (below). The other half of the
// net is fakeRules(), which hands every value back as text (L104), so a reader the scan misses fails its own tests.
// What it catches:
//   - a rules read: rules.get( / rules?.get( / rules?.get?.( / ctx.rules.get( / this.rules?.get( / need(rules …);
//   - a local wrapper over one: `const get = (k) => rules.get(…)`, `k => …`, `function get(k) { … rules.get(…) }` with
//     the read on the same line or up to 3 lines below, `const { get } = rules`, `rules.get.bind(rules)`;
//   - a name given a rules read (`const stuckMin = get('claims.stuck_min')`), anywhere in the same file;
//   - checked as a number: Number.isInteger / isSafeInteger / isFinite / isNaN, the global isFinite / isNaN,
//     typeof … === 'number', or compared with < > <= >=;
//   - a second, lax conversion: Number(…), parseInt(…), parseFloat(…), or a unary + in front of the value;
//   - checked as a flag: compared === or !== with true or false (or with 'true' / 'false'), or typeof … === 'boolean'.
// Known holes: a value passed through a function call or an object before the check; a check split across lines; a
// rules object not named `rules`; a truthiness check (`if (!get('x'))`), which is also how text is checked for being
// there. fakeRules' text values are what close those.

// Block comments go (their line breaks stay, so line numbers hold), then `//` comments that start a line or follow a
// space. A code line that starts with `*` is kept (L104 Minor 2).
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((line) => {
    if (line.trimStart().startsWith('//')) return '';
    const i = line.search(/\s\/\/\s/);
    return i === -1 ? line : line.slice(0, i);
  });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `rules.get`, with optional chaining at either dot and any object path in front (`ctx.rules`, `this?.rules`).
const RULES_DOT_GET = '(?:[A-Za-z_$][\\w$]*\\??\\.)*rules\\??\\.get';
const RULES_GET = `${RULES_DOT_GET}(?:\\?\\.)?`;

export function typedReadProblems(source) {
  const lines = stripComments(source);
  const wrappers = new Set();
  const readsRules = new RegExp(`(?<![\\w$])${RULES_GET}\\s*\\(`);
  lines.forEach((l, i) => {
    const near = lines.slice(i, i + 4).join('\n');
    const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(l);
    if (arrow && readsRules.test(l.includes('{') ? near : l)) wrappers.add(arrow[1]);
    const fn = /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(l);
    if (fn && readsRules.test(near)) wrappers.add(fn[1]);
    const bound = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${RULES_DOT_GET}\\.bind\\(`).exec(l);
    if (bound) wrappers.add(bound[1]);
    // `const { get } = rules` / `const { get: read } = ctx.rules`.
    const destr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:[A-Za-z_$][\w$]*\??\.)*rules\b/.exec(l);
    if (destr) {
      for (const part of destr[1].split(',')) {
        const m = /^\s*get\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
        if (m) wrappers.add(m[1] ?? 'get');
      }
    }
  });
  // RAW is a read that hands back what the file holds; READ adds M11's need(rules, …), which checks the type itself
  // and so is swept inside need() (lane 2), not at each caller. Comparisons and second conversions are flagged only
  // on a RAW value: a number need() handed back may be compared.
  const getters = [RULES_GET, ...[...wrappers].map(esc)];
  const RAW = `(?<![\\w$.])(?:${getters.join('|')})\\s*\\(`;
  const READ = `(?<![\\w$.])(?:${[...getters, 'need(?=\\s*\\(\\s*(?:[A-Za-z_$][\\w$]*\\??\\.)*rules\\b)'].join('|')})\\s*\\(`;
  const taintBy = (call) => {
    const set = new Set();
    for (const l of lines) {
      for (const m of l.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${call}`, 'g'))) set.add(m[1]);
      // A plain re-assignment: `v = rules.get(…)`.
      for (const m of l.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${call}`, 'g'))) set.add(m[1]);
    }
    for (const w of wrappers) set.delete(w);
    return set;
  };
  const nameRe = (set) => (set.size ? `(?<![\\w$.])(?:${[...set].map(esc).join('|')})(?![\\w$(])` : '(?!)');
  const NAME = nameRe(taintBy(READ));
  const RAW_NAME = nameRe(taintBy(RAW));
  const VALUE = `(?:${READ}|${NAME})`;
  const RAW_VALUE = `(?:${RAW}|${RAW_NAME})`;
  const checks = [
    ['checked as a number', new RegExp(`Number\\.is(?:Safe)?Integer\\(\\s*${VALUE}`)],
    ['checked as a number', new RegExp(`Number\\.is(?:Finite|NaN)\\(\\s*${VALUE}`)],
    ['checked as a number', new RegExp(`(?<![\\w$.])is(?:Finite|NaN)\\(\\s*${VALUE}`)],
    ['checked as a number', new RegExp(`typeof\\s+\\(?\\s*${VALUE}[^;&|?]*?[!=]==?\\s*['"]number['"]`)],
    ['checked as a number', new RegExp(`${RAW_NAME}\\s*(?:[<>]=?)(?!=)`)],
    ['checked as a number', new RegExp(`(?<![<>=!])(?:[<>]=?)\\s*${RAW_NAME}`)],
    ['checked as a number', new RegExp(`${RAW}[^;&|?]*?\\)\\s*(?:[<>]=?)(?!=)`)],
    ['converted a second way', new RegExp(`(?<![\\w$.])(?:Number|parseInt|parseFloat)\\(\\s*${RAW_VALUE}`)],
    ['converted a second way', new RegExp(`(?:^|[(=,:?!&|]|\\breturn)\\s*\\+\\s*${RAW_VALUE}`)],
    ['checked as a flag', new RegExp(`typeof\\s+\\(?\\s*${VALUE}[^;&|?]*?[!=]==?\\s*['"]boolean['"]`)],
    ['checked as a flag', new RegExp(`${READ}[^;&|?]*?\\)\\s*[!=]==?\\s*(?:true|false|'true'|'false'|"true"|"false")(?![\\w$])`)],
    ['checked as a flag', new RegExp(`${NAME}\\s*[!=]==?\\s*(?:true|false|'true'|'false'|"true"|"false")(?![\\w$])`)],
    ['checked as a flag', new RegExp(`(?:\\b(?:true|false)|'true'|'false'|"true"|"false")\\s*[!=]==?\\s*${VALUE}`)],
  ];
  const out = [];
  lines.forEach((l, i) => {
    const hit = checks.find(([, re]) => re.test(l));
    if (hit) out.push({ line: i + 1, text: l.trim().slice(0, 160), why: hit[0] });
  });
  return out;
}
