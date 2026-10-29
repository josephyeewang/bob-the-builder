// yaml-lite.mjs — a small, strict reader for the Blueprint's data files (templates/blueprint-roadmap/).
//
// WHY. Bob's checkers run with bare `node` and no installed packages, and Node has no YAML reader. The Blueprint's
// fact files only need a small part of YAML, so this reads exactly that part and REFUSES the rest, loudly, rather
// than guessing: a file that uses anchors, flow maps or tabs fails with its line number, so a check can never pass
// because the data was half-read.
//
// Supported: block maps (`key: value`, `key:` + nested block), block lists (`- value`, `- key: value` items),
// flow lists of scalars (`[a, "b c"]`, `[]`), plain / 'single' / "double" scalars, `|` and `>` block text,
// full-line and trailing ` #` comments. Every scalar stays a string (dates included); an empty value is null.
//
// Usage: import { parseYaml } from './yaml-lite.mjs'; parseYaml(text, 'docs/blueprint/blueprint.yaml')

export class YamlLiteError extends Error {}

export function parseYaml(text, name = '<input>') {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*\t/.test(raw)) throw new YamlLiteError(`${name}:${i + 1}: tab used for indentation (use spaces)`);
    if (/^\s*(#.*)?$/.test(raw)) { lines.push({ blank: true, raw, no: i + 1 }); return; }
    if (/^(---|\.\.\.)\s*$/.test(raw)) { lines.push({ blank: true, raw, no: i + 1 }); return; }
    const indent = raw.match(/^ */)[0].length;
    lines.push({ indent, text: raw.slice(indent), raw, no: i + 1 });
  });
  const p = { lines, i: 0, name };
  skipBlank(p);
  if (p.i >= lines.length) return null;
  const v = parseBlock(p, lines[p.i].indent);
  skipBlank(p);
  if (p.i < lines.length) fail(p, lines[p.i], 'unexpected indentation');
  return v;
}

function fail(p, line, msg) {
  throw new YamlLiteError(`${p.name}:${line.no}: ${msg} — outside the Blueprint's YAML subset (scripts/blueprint/yaml-lite.mjs)`);
}

function skipBlank(p) {
  while (p.i < p.lines.length && p.lines[p.i].blank) p.i++;
}

function parseBlock(p, indent) {
  const first = p.lines[p.i];
  return first.text.startsWith('- ') || first.text === '-' ? parseList(p, indent) : parseMap(p, indent);
}

function parseList(p, indent) {
  const out = [];
  for (;;) {
    skipBlank(p);
    const line = p.lines[p.i];
    if (!line || line.indent < indent) return out;
    if (line.indent > indent) fail(p, line, 'unexpected indentation');
    if (!(line.text.startsWith('- ') || line.text === '-')) fail(p, line, 'expected a list item ("- ")');
    const rest = line.text === '-' ? '' : line.text.slice(2);
    const restTrim = rest.trimStart();
    const itemIndent = indent + 2 + (rest.length - restTrim.length);
    if (restTrim === '') {
      p.i++; skipBlank(p);
      const next = p.lines[p.i];
      out.push(next && next.indent > indent ? parseBlock(p, next.indent) : null);
    } else if (keyMatch(restTrim)) {
      // A map item: re-read this line as the first key of a map at the item's own indentation.
      p.lines[p.i] = { indent: itemIndent, text: restTrim, raw: line.raw, no: line.no };
      out.push(parseMap(p, itemIndent));
    } else {
      p.i++;
      out.push(scalar(p, line, restTrim, indent));
    }
  }
}

function keyMatch(text) {
  return text.match(/^([A-Za-z0-9_][A-Za-z0-9_.\- ]*?)\s*:(\s+|$)(.*)$/);
}

function parseMap(p, indent) {
  const out = {};
  for (;;) {
    skipBlank(p);
    const line = p.lines[p.i];
    if (!line || line.indent < indent) return out;
    if (line.indent > indent) fail(p, line, 'unexpected indentation');
    if (line.text.startsWith('- ')) return out; // a sibling list item of the parent
    const m = keyMatch(line.text);
    if (!m) fail(p, line, 'expected "key: value"');
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) fail(p, line, `duplicate key "${key}"`);
    const rest = m[3];
    p.i++;
    if (stripComment(rest) === '') {
      skipBlank(p);
      const next = p.lines[p.i];
      if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) {
        out[key] = parseBlock(p, next.indent);
      } else out[key] = null;
    } else {
      out[key] = scalar(p, line, rest, indent);
    }
  }
}

function stripComment(s) {
  // Only for unquoted text: a comment starts at " #".
  const i = s.search(/(^|\s)#/);
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function scalar(p, line, rest, indent) {
  const t = rest.trim();
  if (/^[&*!]/.test(t)) fail(p, line, 'anchors, aliases and tags are not supported');
  if (t.startsWith('{')) fail(p, line, 'flow maps ({…}) are not supported');
  if (/^[|>][+-]?(\s+#.*)?$/.test(t)) return blockText(p, indent, t[0]);
  if (t.startsWith('[')) return flowList(p, line, t);
  if (t.startsWith('"') || t.startsWith("'")) {
    const { value, end } = quoted(p, line, t, 0);
    if (stripComment(t.slice(end)) !== '') fail(p, line, 'text after a quoted value');
    return value;
  }
  const v = stripComment(t);
  return v === '' || v === '~' || v === 'null' ? null : v;
}

function quoted(p, line, t, start) {
  const q = t[start];
  let i = start + 1, value = '';
  while (i < t.length) {
    const c = t[i];
    if (q === "'" && c === "'" && t[i + 1] === "'") { value += "'"; i += 2; continue; }
    if (q === '"' && c === '\\') {
      const n = t[i + 1];
      const map = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' };
      if (!(n in map)) fail(p, line, `unsupported escape \\${n}`);
      value += map[n]; i += 2; continue;
    }
    if (c === q) return { value, end: i + 1 };
    value += c; i++;
  }
  fail(p, line, 'unclosed quote');
}

function flowList(p, line, t) {
  const body = stripComment(t);
  if (!body.endsWith(']')) fail(p, line, 'a flow list must open and close on one line');
  const inner = body.slice(1, -1).trim();
  if (inner === '') return [];
  const out = [];
  let i = 0;
  while (i < inner.length) {
    while (inner[i] === ' ') i++;
    if (inner[i] === '"' || inner[i] === "'") {
      const { value, end } = quoted(p, line, inner, i);
      out.push(value); i = end;
    } else {
      const j = inner.indexOf(',', i);
      const v = (j === -1 ? inner.slice(i) : inner.slice(i, j)).trim();
      if (/[[\]{}]/.test(v)) fail(p, line, 'nested flow collections are not supported');
      out.push(v); i = j === -1 ? inner.length : j;
    }
    while (inner[i] === ' ') i++;
    if (i < inner.length) {
      if (inner[i] !== ',') fail(p, line, 'expected "," in flow list');
      i++;
    }
  }
  return out;
}

function blockText(p, indent, style) {
  const parts = [];
  let textIndent = null;
  while (p.i < p.lines.length) {
    const l = p.lines[p.i];
    if (l.blank) {
      // Inside block text a "# …" line is text, not a comment, when it is indented past the key.
      const ind = l.raw.match(/^ */)[0].length;
      if (l.raw.trim() !== '' && ind > indent && (textIndent === null || ind >= textIndent)) {
        if (textIndent === null) textIndent = ind;
        parts.push(l.raw.slice(textIndent)); p.i++; continue;
      }
      if (l.raw.trim() !== '') break;
      parts.push(''); p.i++; continue;
    }
    if (l.indent <= indent) break;
    if (textIndent === null) textIndent = l.indent;
    if (l.indent < textIndent) break;
    parts.push(l.raw.slice(textIndent));
    p.i++;
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return style === '|' ? parts.join('\n') + '\n' : parts.join(' ').replace(/ {2,}/g, ' ').trim() + '\n';
}
