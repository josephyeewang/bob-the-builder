// rules-typed-reads.mjs — finds a module that checks a rules value as a number or a flag without going through
// rules.num() or rules.flag() (lead call L96). The rules file is text and the reader converts only some keys, so a
// check like `Number.isInteger(rules.get('claims.stuck_min'))` refuses the "30" the file really holds, and no test
// that hands over a JS number sees it. The test beside this file runs the scan over every module outside M10.
//
//   typedReadProblems(source) → [{ line, text, why }]
//
// It reads the source line by line, without a parser, so it is a net with known holes: a value passed through a
// function call or an object before the check is not followed, and the rules object must be named `rules`, as every
// module names it. What it does catch:
//   - a rules read: rules.get( / rules?.get( / need(rules …) / a local wrapper `const get = (k) => … rules.get(…)`;
//   - a name given a rules read (`const stuckMin = get('claims.stuck_min')`), anywhere in the same file;
//   - checked as a number: Number.isInteger / isSafeInteger / isFinite of either, or typeof … === 'number';
//   - checked as a flag: either compared === or !== with true or false, or typeof … === 'boolean'.

const stripComment = (line) => {
  const t = line.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  const i = line.search(/\s\/\/\s/);
  return i === -1 ? line : line.slice(0, i);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function typedReadProblems(source) {
  const lines = source.split('\n').map(stripComment);
  const wrappers = new Set();
  for (const l of lines) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>[^\n]*\brules\??\.get\(/.exec(l);
    if (m) wrappers.add(m[1]);
  }
  const callers = ['rules\\??\\.get', 'need(?=\\s*\\(\\s*rules\\b)', ...[...wrappers].map(esc)];
  const READ = `(?<![\\w$.])(?:${callers.join('|')})\\s*\\(`;
  const tainted = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${READ}`, 'g'))) tainted.add(m[1]);
    // A plain re-assignment: `v = rules.get(…)`.
    for (const m of l.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${READ}`, 'g'))) tainted.add(m[1]);
  }
  for (const w of wrappers) tainted.delete(w);
  const NAME = tainted.size ? `(?<![\\w$.])(?:${[...tainted].map(esc).join('|')})(?![\\w$(])` : '(?!)';
  const VALUE = `(?:${READ}|${NAME})`;
  const checks = [
    ['checked as a number', new RegExp(`Number\\.is(?:Safe)?Integer\\(\\s*${VALUE}`)],
    ['checked as a number', new RegExp(`Number\\.isFinite\\(\\s*${VALUE}`)],
    ['checked as a number', new RegExp(`typeof\\s+\\(?\\s*${VALUE}[^;&|?]*?[!=]==?\\s*['"]number['"]`)],
    ['checked as a flag', new RegExp(`typeof\\s+\\(?\\s*${VALUE}[^;&|?]*?[!=]==?\\s*['"]boolean['"]`)],
    ['checked as a flag', new RegExp(`${READ}[^;&|?]*?\\)\\s*[!=]==?\\s*(?:true|false)\\b`)],
    ['checked as a flag', new RegExp(`${NAME}\\s*[!=]==?\\s*(?:true|false)\\b`)],
    ['checked as a flag', new RegExp(`\\b(?:true|false)\\s*[!=]==?\\s*${VALUE}`)],
  ];
  const out = [];
  lines.forEach((l, i) => {
    const hit = checks.find(([, re]) => re.test(l));
    if (hit) out.push({ line: i + 1, text: l.trim().slice(0, 160), why: hit[0] });
  });
  return out;
}
