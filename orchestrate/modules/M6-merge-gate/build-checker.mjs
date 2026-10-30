// build-checker.mjs — builds github-checker.mjs, the one-file copy of checker-entry.mjs the outside-check repo keeps
// (R-0b-93; 0b-9 M2, M4).
//
// WHY. There is one classifier (M10-rules/classify.mjs) and both sides of the merge check must use it. The outside-check
// repo can't import Bob's tree, so it keeps a single generated file with no dependencies; the audit workflow and the
// build-skip command download that file by pinned commit + sha256. A hand-kept copy would drift from the classifier, so
// nobody edits it: this script makes it, its header names the Bob commit it came from, and build-checker.test.mjs
// rebuilds it and checks the committed file is byte-identical.
//
//   buildChecker({ entry, sourceCommit, root? }) → the bundle's text
//     entry: path of the entry module; sourceCommit: 40-hex Bob commit; root: the repo folder (default: the nearest
//     folder above the entry holding .git). Every path in the bundle is relative to root.
//   node build-checker.mjs <40-hex commit>   → writes github-checker.mjs beside this file
//
// The committed github-checker.mjs was built with the zero commit (0000…0000): git can't be run where it was generated.
// Building it with the real commit is part of installing it into the outside-check repo (a later step by a person).
//
// How the bundle works. Each module becomes a function in its own scope (so `const SHA` in two modules can't collide),
// emitted in path order. They run in the order Node would run them (imports first, depth first, in source order); each
// fills an exports object whose getters read the module's own names. An import binds when the module it names has
// finished; across an import cycle (policy.mjs ↔ classify.mjs) that is later, exactly where Node's binding would still be
// uninitialised, so code that works unbundled works bundled. `node:` built-ins are hoisted to the top as namespace imports.
// Anything not understood (dynamic import, a default export, `export *`, a JSON or bare-package import, import.meta
// outside the entry, an import or export not at the start of a line) throws: the build never silently drops code.

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, basename, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OUTPUT_NAME = 'github-checker.mjs';
export const ZERO_COMMIT = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const ID = '[A-Za-z_$][\\w$]*';
const HERE = dirname(fileURLToPath(import.meta.url));

const fail = (file, msg) => { throw new Error(`build-checker: ${file}: ${msg}`); };

// `a, b as c` → [{ from: 'a', to: 'a' }, { from: 'b', to: 'c' }]. `default` either side is not understood.
function specList(file, text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`).exec(s);
    if (!m) fail(file, `odd name list entry: ${s}`);
    const one = { from: m[1], to: m[2] ?? m[1] };
    if (one.from === 'default' || one.to === 'default') fail(file, 'default imports and exports are not supported');
    return one;
  });
}

// Statement text from line i to the line that ends it (`end` tests the joined text).
function gather(lines, i, end) {
  let j = i;
  let text = lines[i];
  while (!end(text)) {
    if (++j >= lines.length) return null;
    text += `\n${lines[j]}`;
  }
  return { text, last: j };
}

// One module's imports, exports and remaining body.
function parseModule(file, src, { isEntry }) {
  const lines = src.split('\n');
  const imports = [];   // { spec, kind: 'named'|'ns'|'bare'|'default', names }
  const exportsLocal = [];   // { local, name }
  const reexports = [];   // { spec, from, name }
  const body = [];
  const endsWithString = (t) => /(['"])[^'"\n]+\1\s*;?\s*(\/\/.*)?$/.test(t);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^import\b(?!\s*[.(])/.test(line)) {
      const g = gather(lines, i, endsWithString);
      if (!g) fail(file, `unfinished import at line ${i + 1}`);
      const t = g.text.replace(/\s*\/\/[^\n'"]*$/, '').replace(/;\s*$/, '').trim();
      let m;
      if ((m = /^import\s+(['"])([^'"]+)\1$/.exec(t))) imports.push({ spec: m[2], kind: 'bare', names: [] });
      else if ((m = new RegExp(`^import\\s+\\*\\s+as\\s+(${ID})\\s+from\\s+(['"])([^'"]+)\\2$`).exec(t))) imports.push({ spec: m[3], kind: 'ns', names: [{ from: '*', to: m[1] }] });
      else if ((m = /^import\s*\{([^}]*)\}\s*from\s+(['"])([^'"]+)\2$/.exec(t))) imports.push({ spec: m[3], kind: 'named', names: specList(file, m[1]) });
      else if ((m = new RegExp(`^import\\s+(${ID})\\s+from\\s+(['"])([^'"]+)\\2$`).exec(t))) imports.push({ spec: m[3], kind: 'default', names: [{ from: 'default', to: m[1] }] });
      else fail(file, `import form not understood at line ${i + 1}: ${t.slice(0, 80)}`);
      i = g.last;
      continue;
    }
    if (/^export\b/.test(line)) {
      let m;
      if (/^export\s+default\b/.test(line)) fail(file, `default export at line ${i + 1}`);
      if (/^export\s*\*/.test(line)) fail(file, `export * at line ${i + 1}`);
      if (/^export\s*\{/.test(line)) {
        const g = gather(lines, i, (t) => /\}\s*;?\s*(\/\/.*)?$/.test(t) || endsWithString(t));
        if (!g) fail(file, `unfinished export at line ${i + 1}`);
        const t = g.text.replace(/\s*\/\/[^\n'"]*$/, '').replace(/;\s*$/, '').trim();
        if ((m = /^export\s*\{([^}]*)\}\s*from\s+(['"])([^'"]+)\2$/.exec(t))) {
          for (const n of specList(file, m[1])) reexports.push({ spec: m[3], from: n.from, name: n.to });
        } else if ((m = /^export\s*\{([^}]*)\}$/.exec(t))) {
          for (const n of specList(file, m[1])) exportsLocal.push({ local: n.from, name: n.to });
        } else fail(file, `export form not understood at line ${i + 1}: ${t.slice(0, 80)}`);
        i = g.last;
        continue;
      }
      if ((m = new RegExp(`^export\\s+((?:async\\s+)?function\\s*\\*?\\s*(${ID})|class\\s+(${ID})|(?:const|let|var)\\s+(${ID})\\s*=)`).exec(line))) {
        const name = m[2] ?? m[3] ?? m[4];
        exportsLocal.push({ local: name, name });
        body.push(line.replace(/^export\s+/, ''));
        continue;
      }
      fail(file, `export form not understood at line ${i + 1}: ${line.slice(0, 80)}`);
    }
    if (/^\s+(import|export)\s*[{*\w'"]/.test(line) && !/^\s+import\s*[.(]/.test(line)) fail(file, `import or export not at the start of line ${i + 1}`);
    // A usage example in a comment ("import { x } from './y.mjs'") is marked, so the bundle names no relative import.
    body.push(/^\s*\/\//.test(line) ? line.replace(/\bfrom (['"])(\.\.?\/)/g, 'from (bundled) $1$2') : line);
  }
  // Every kept line, an export declaration's included.
  body.forEach((line, k) => {
    if (/\bimport\s*\(/.test(line)) fail(file, `dynamic import: ${line.trim().slice(0, 80)}`);
    if (/\bimport\s*\.\s*meta\b/.test(line) && !isEntry) fail(file, `import.meta outside the entry: ${line.trim().slice(0, 80)}`);
    if (/\b__bob_/.test(line)) fail(file, `uses the reserved prefix __bob_ (kept line ${k + 1})`);
  });
  return { imports, exportsLocal, reexports, body };
}

function findRoot(start) {
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) throw new Error('build-checker: no repo folder (.git) above the entry; pass root');
  }
}

const nodeVar = (spec) => `__bob_${spec.replace(/[^A-Za-z0-9]/g, '_')}`;

export function buildChecker({ entry, sourceCommit, root } = {}) {
  if (typeof sourceCommit !== 'string' || !SHA.test(sourceCommit)) throw new Error('build-checker: sourceCommit must be a 40-hex commit id');
  if (typeof entry !== 'string' || !entry) throw new Error('build-checker: no entry');
  const entryAbs = resolve(entry);
  const rootAbs = resolve(root ?? findRoot(dirname(entryAbs)));
  const rel = (abs) => {
    const r = relative(rootAbs, abs);
    if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error(`build-checker: a module outside the repo folder: ${basename(abs)}`);
    return r.split(sep).join('/');
  };

  const mods = new Map();   // repo path → parsed module
  const builtins = new Set();
  const visit = (abs) => {
    const path = rel(abs);
    if (mods.has(path)) return path;
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch { throw new Error(`build-checker: cannot read ${path}`); }
    const mod = parseModule(path, src, { isEntry: abs === entryAbs });
    mods.set(path, mod);
    const target = (spec) => {
      if (spec.startsWith('node:')) { builtins.add(spec); return { builtin: spec }; }
      if (!spec.startsWith('./') && !spec.startsWith('../')) fail(path, `not a relative or node: import: ${spec}`);
      if (!/\.m?js$/.test(spec)) fail(path, `only .mjs/.js modules can be bundled: ${spec}`);
      return { path: visit(resolve(dirname(abs), spec)) };
    };
    mod.deps = [];
    for (const im of mod.imports) {
      Object.assign(im, target(im.spec));
      if (im.path && !mod.deps.includes(im.path)) mod.deps.push(im.path);
      if (im.kind === 'default' && !im.builtin) fail(path, `default import of ${im.spec}`);
    }
    for (const re of mod.reexports) {
      Object.assign(re, target(re.spec));
      if (re.builtin) fail(path, `re-export from a built-in: ${re.spec}`);
      if (!mod.deps.includes(re.path)) mod.deps.push(re.path);
    }
    return path;
  };
  const entryPath = visit(entryAbs);

  // Every imported name must be exported: a declaration form the parser missed fails here, not at run time.
  const exportNames = (path) => {
    const m = mods.get(path);
    return [...m.exportsLocal.map((e) => e.name), ...m.reexports.map((e) => e.name)];
  };
  for (const [path, m] of mods) {
    const all = exportNames(path);
    if (new Set(all).size !== all.length) fail(path, 'an export name appears twice');
    for (const im of m.imports) if (im.kind === 'named' && im.path) {
      for (const n of im.names) if (!exportNames(im.path).includes(n.from)) fail(path, `imports ${n.from}, which ${im.path} does not export`);
    }
    for (const re of m.reexports) if (!exportNames(re.path).includes(re.from)) fail(path, `re-exports ${re.from}, which ${re.path} does not export`);
  }
  const vars = [...builtins].sort().map(nodeVar);
  if (new Set(vars).size !== vars.length) throw new Error('build-checker: two built-ins map to one name');

  const out = [];
  out.push(`// ${OUTPUT_NAME} — GENERATED by build-checker.mjs from ${basename(entryAbs)} — do not edit`);
  out.push(`// source commit: ${sourceCommit}`);
  out.push(`// ${mods.size} modules (paths from the repo root), each in its own scope, run in the order Node would run them.`);
  out.push('');
  for (const spec of [...builtins].sort()) out.push(`import * as ${nodeVar(spec)} from '${spec}';`);
  out.push('');
  out.push('const __bob_mods = new Map();');
  out.push('function __bob_def(path, deps, fn) { __bob_mods.set(path, { deps, fn, e: {}, state: 0, waiters: [] }); }');
  out.push('// Runs a module after its imports (depth first); an import of an unfinished module (a cycle) binds when it finishes.');
  out.push('function __bob_run(path) {');
  out.push('  const m = __bob_mods.get(path);');
  out.push('  if (m.state) return m.e;');
  out.push('  m.state = 1;');
  out.push('  for (const d of m.deps) __bob_run(d);');
  out.push('  m.fn(m.e, (dep, set, now) => { const t = __bob_mods.get(dep); if (now || t.state === 2) set(t.e); else t.waiters.push(set); });');
  out.push('  m.state = 2;');
  out.push('  for (const set of m.waiters.splice(0)) set(m.e);');
  out.push('  return m.e;');
  out.push('}');

  for (const path of [...mods.keys()].sort()) {
    const m = mods.get(path);
    out.push('');
    out.push(`// ---- ${path} ----`);
    out.push(`__bob_def('${path}', ${JSON.stringify(m.deps).replace(/"/g, "'").replace(/,/g, ', ')}, function (__bob_e, __bob_i) {`);
    const locals = [];
    for (const im of m.imports) {
      if (im.builtin) {
        const v = nodeVar(im.builtin);
        if (im.kind === 'named' && im.names.length) out.push(`const { ${im.names.map((n) => (n.from === n.to ? n.from : `${n.from}: ${n.to}`)).join(', ')} } = ${v};`);
        else if (im.kind === 'ns') out.push(`const ${im.names[0].to} = ${v};`);
        else if (im.kind === 'default') out.push(`const ${im.names[0].to} = ${v}.default;`);
        continue;
      }
      if (im.kind === 'bare' || !im.names.length) continue;
      locals.push(...im.names.map((n) => n.to));
    }
    if (locals.length) out.push(`let ${locals.join(', ')};`);
    for (const im of m.imports) {
      if (im.builtin || im.kind === 'bare' || !im.names.length) continue;
      if (im.kind === 'ns') out.push(`__bob_i('${im.path}', (m) => { ${im.names[0].to} = m; }, true);`);
      else out.push(`__bob_i('${im.path}', (m) => { ${im.names.map((n) => `${n.to} = m.${n.from};`).join(' ')} });`);
    }
    const getters = [
      ...m.exportsLocal.map((e) => `${e.name}: { get: () => ${e.local}, enumerable: true }`),
      ...m.reexports.map((e) => `${e.name}: { get: () => __bob_mods.get('${e.path}').e.${e.from}, enumerable: true }`),
    ];
    if (getters.length) {
      out.push('Object.defineProperties(__bob_e, {');
      for (const g of getters) out.push(`  ${g},`);
      out.push('});');
    }
    while (m.body.length && m.body[m.body.length - 1].trim() === '') m.body.pop();
    out.push(...m.body);
    out.push('});');
  }

  out.push('');
  out.push(`const __bob_entry = __bob_run('${entryPath}');`);
  for (const name of exportNames(entryPath).sort()) out.push(`export const ${name} = __bob_entry.${name};`);
  out.push('');
  return out.join('\n');
}

// Run as a script: write github-checker.mjs beside this file from checker-entry.mjs.
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) {
  try {
    const text = buildChecker({ entry: join(HERE, 'checker-entry.mjs'), sourceCommit: process.argv[2] });
    writeFileSync(join(HERE, OUTPUT_NAME), text);
    console.log(`build-checker: wrote ${OUTPUT_NAME} (${text.length} characters)`);
  } catch (e) {
    console.log(String(e?.message ?? e));
    process.exitCode = 1;
  }
}
