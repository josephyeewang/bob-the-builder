#!/usr/bin/env node
// render-blueprint.mjs — the page builder: builds the Blueprint's phone view and its rich page from the fact files
// (Blueprint & Roadmap, design §3.2–§3.5: "the phone view" and "built, not saved in the repo: the rich page").
//
// WHY. A page typed by hand drifts from its data: a date moves in one place and not in the other, and the reader
// can't tell which is true. So every short fact on the page is GENERATED from docs/blueprint/ (decided.yaml,
// blueprint.yaml, exit-tests.yaml, one file per row in rows/), by this one fixed script, and never typed. Its
// output is byte-identical for the same input, so a check can rebuild it at the commit the page names and fail
// a hand edit ("generated means generated"). The data is read as DATA: every string is escaped, so text in a
// fact file can never become page code, and the only script on the rich page is the stale-stamp check below,
// which reads no data.
//
// WHAT IT WRITES:
//   • docs/blueprint/BLUEPRINT.md — the phone view, saved in the repo; plain text GitHub draws, with the map as
//     mermaid text and folds as <details>; header "as of [date], built from [commit]".
//   • <out>/index.html and <out>/history.html — the rich page and its "History & evidence" page; built, not
//     saved in the repo. One self-contained file each: inline CSS from templates/blueprint-roadmap/
//     visual-devices.md's colour tokens (light and dark), no outside scripts, fonts or images. Each shows
//     "built from main at [commit], [time]" and its header turns red when that stamp is over 2 hours old, both
//     when built (--built-at older than --now) and when opened later (a small inline check of the viewer's clock).
// LIGHTS: a module's light is generated as the colour of its worst part (blueprint.yaml modules[].parts); a
// module with no parts listed shows "◌ Not scored". The judgment fields (the biggest risk, the one-line read) are
// read from blueprint.yaml summary, where the daily roadmap change writes them; card prose files are linked, not
// copied. Not yet in the data, said plainly: row value and size (so no ranked "next" list), checkpoints held and
// "where you touch it" (those card lines say so).
//
// Usage:  node scripts/blueprint/render-blueprint.mjs <product-root> [--commit <sha>] [--now <ISO time>]
//                [--built-at <ISO time>] [--out <dir>]
//   --commit    the commit the data was read at (default: git HEAD of the product, "+uncommitted" when the
//               fact files have local changes; "no commit given" outside git)
//   --now       the time of this build; the only clock the script reads (no wall clock is ever read)
//   --built-at  when main's data was read for this build (default: --now); over 2 hours before --now → red
//   --out       where the rich page goes (default: <product-root>/.blueprint-pages; keep it out of git)
// Exit:   0 = pages written · 1 = (unused: rendering has no findings) · 2 = setup error or invalid data
//         (schema-check.mjs runs first; the builder refuses data that fails it)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, YamlLiteError } from './yaml-lite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STALE_MS = 2 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function setupError(msg) {
  console.error(`render-blueprint: ${msg}`);
  process.exit(2);
}

// ── arguments ────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { root: null, commit: null, now: null, builtAt: null, out: null };
  const flags = { '--commit': 'commit', '--now': 'now', '--built-at': 'builtAt', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in flags) {
      if (i + 1 >= argv.length) setupError(`${a} needs a value`);
      opts[flags[a]] = argv[++i];
    } else if (a.startsWith('--')) setupError(`unknown option ${a}`);
    else if (opts.root === null) opts.root = a;
    else setupError(`unexpected argument ${a}`);
  }
  if (!opts.root) setupError('usage: render-blueprint.mjs <product-root> [--commit <sha>] [--now <ISO>] [--built-at <ISO>] [--out <dir>]');
  opts.root = path.resolve(opts.root);
  if (opts.commit !== null && !/^[0-9a-f]{4,40}$/i.test(opts.commit)) setupError(`--commit must be a commit hash, not "${opts.commit}"`);
  for (const k of ['now', 'builtAt']) {
    if (opts[k] !== null && !(ISO_TIME.test(opts[k]) && !Number.isNaN(Date.parse(opts[k])))) {
      setupError(`--${k === 'now' ? 'now' : 'built-at'} must be an ISO time like 2031-03-02T09:00Z, not "${opts[k]}"`);
    }
  }
  if (opts.builtAt === null) opts.builtAt = opts.now;
  opts.out = path.resolve(opts.out || path.join(opts.root, '.blueprint-pages'));
  return opts;
}

function commitOf(root) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', '--short=12', 'HEAD');
  if (head.status !== 0) return 'no commit given';
  const dirty = git('status', '--porcelain', '--', 'docs/blueprint');
  const changed = dirty.status === 0 && dirty.stdout.split('\n').some((l) => l.trim() && !l.endsWith('docs/blueprint/BLUEPRINT.md'));
  return head.stdout.trim() + (changed ? '+uncommitted' : '');
}

// ── reading the data (schema-check first; refuse data that fails it) ─────────────────────────────────────────
function loadData(root) {
  const sc = spawnSync(process.execPath, [path.join(HERE, 'schema-check.mjs'), root], { encoding: 'utf8' });
  if (sc.status !== 0) {
    const why = (sc.stdout + sc.stderr).trim().split('\n').map((l) => `  ${l}`).join('\n');
    setupError(`the fact files fail schema-check.mjs, so nothing was rendered:\n${why}`);
  }
  const bp = path.join(root, 'docs', 'blueprint');
  const read = (rel) => {
    try { return parseYaml(fs.readFileSync(path.join(bp, rel), 'utf8'), `docs/blueprint/${rel}`); } catch (e) {
      if (e instanceof YamlLiteError) setupError(e.message);
      throw e;
    }
  };
  const rowsDir = path.join(bp, 'rows');
  const rowFiles = fs.existsSync(rowsDir) ? fs.readdirSync(rowsDir).filter((n) => n.endsWith('.yaml')).sort() : [];
  return {
    decided: read('decided.yaml'),
    exitTests: read('exit-tests.yaml'),
    blueprint: read('blueprint.yaml'),
    rows: rowFiles.map((n) => read(path.join('rows', n))), // one file per row, read one at a time
    cards: listMd(path.join(bp, 'cards')),
    history: listMd(path.join(bp, 'history')),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
  };
}

function listMd(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];
}

function readTokens() {
  const file = path.join(HERE, '..', '..', 'templates', 'blueprint-roadmap', 'visual-devices.md');
  if (!fs.existsSync(file)) setupError(`missing ${file} (the colour tokens live there, once)`);
  const m = fs.readFileSync(file, 'utf8').match(/```css\n([\s\S]*?)```/);
  if (!m) setupError('visual-devices.md has no ```css block of colour tokens');
  return m[1].trim();
}

// ── the model: everything both pages show, computed once ─────────────────────────────────────────────────────
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const slug = (s) => str(s).replace(/[^A-Za-z0-9_-]/g, '-') || 'x';
const LIGHTS = {
  green: { sym: '●', word: 'Green', cls: 'green' },
  amber: { sym: '◐', word: 'Amber', cls: 'amber' },
  red: { sym: '○', word: 'Red', cls: 'red' },
  none: { sym: '◌', word: 'Not scored', cls: 'none' },
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isDay = (s) => typeof s === 'string' && ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
function fmtDay(s) {
  if (!isDay(s)) return str(s);
  const d = new Date(`${s}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fmtTime(iso) {
  if (!iso) return null;
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
const byDateThenId = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : str(a.id) < str(b.id) ? -1 : str(a.id) > str(b.id) ? 1 : 0);

function buildModel(data, opts) {
  const { decided, blueprint, exitTests, rows } = data;
  const planes = [];
  const modules = list(blueprint.modules).map((m) => {
    const plane = str(m.plane);
    if (!planes.includes(plane)) planes.push(plane);
    const stage = m.stage && typeof m.stage === 'object' ? m.stage : {};
    return { ...m, parts: list(m.parts), stage, reads: list(stage.reads_from).map(str), light: worstPart(m.parts), anchor: `card-${slug(m.id)}` };
  });
  const zoneOf = (plane) => (/shared|every/i.test(plane) ? 'shared' : String((planes.indexOf(plane) % 3) + 1));
  for (const m of modules) m.zone = zoneOf(str(m.plane));

  const rowById = new Map(rows.map((r) => [str(r.id), r]));
  const adopted = new Set(list(decided.capabilities_adopted).map(str));
  const capabilities = list(blueprint.capabilities).map((c) => ({
    ...c,
    adopted: adopted.has(str(c.id)),
    status: c.row ? (rowById.has(str(c.row)) ? str(rowById.get(str(c.row)).status) : 'no row file') : 'no row',
  }));

  const open = rows.filter((r) => !['done', 'dropped', 'not done'].includes(str(r.status)));
  const done = rows.filter((r) => str(r.status) === 'done');
  const loop = list(blueprint.steps).map((st) => ({ n: str(st.n), name: str(st.name), owner: str(st.owner), supports: list(st.supports).map(str) }));
  const rowsOf = (m) => {
    const mine = rows.filter((r) => str(r.module) === str(m.id));
    const dated = mine.filter((r) => isDay(r.date)).map((r) => ({ ...r, date: r.date })).sort(byDateThenId);
    const undated = mine.filter((r) => !isDay(r.date)).sort((a, b) => (str(a.id) < str(b.id) ? -1 : 1));
    return { dated, undated, open: mine.filter((r) => open.includes(r)) };
  };

  const testsFor = (id) => list(exitTests.exit_tests).filter((t) => str(t.milestone) === str(id));
  const milestones = list(blueprint.milestones).map((ms) => ({ ...ms, tests: testsFor(ms.id), slips: list(ms.slips) }));

  const plan = [
    ...milestones.filter((ms) => isDay(ms.estimate)).map((ms) => ({ date: ms.estimate, id: ms.id, kind: 'milestone', what: ms.name, cond: ms.condition })),
    ...open.filter((r) => isDay(r.date)).map((r) => ({ date: r.date, id: r.id, kind: 'row', what: r.what, cond: null })),
  ].sort(byDateThenId);

  const strip = {
    now: open.filter((r) => str(r.status) === 'building').sort((a, b) => (str(a.id) < str(b.id) ? -1 : 1)),
    next: open.filter((r) => str(r.status) === 'planned' && isDay(r.date)).sort(byDateThenId).slice(0, 3),
    later: open.filter((r) => !isDay(r.date)).sort((a, b) => (str(a.id) < str(b.id) ? -1 : 1)),
  };
  const recentlyShipped = done.filter((r) => isDay(r.date)).sort(byDateThenId).reverse().slice(0, 3);

  const chapterFor = (m) => {
    for (const c of list(blueprint.chapters)) {
      const p = str(c.path);
      if (p.endsWith('/')) {
        const f = `${p}${str(m.id)}.md`;
        if (data.exists(f)) return f;
      }
    }
    return null;
  };

  const nowMs = opts.now ? Date.parse(opts.now) : null;
  const builtMs = opts.builtAt ? Date.parse(opts.builtAt) : null;
  const stale = builtMs === null || nowMs === null || nowMs - builtMs > STALE_MS;

  return {
    title: str(blueprint.product),
    asOf: str(blueprint.as_of),
    commit: opts.commit || commitOf(opts.root),
    builtAt: opts.builtAt,
    stale,
    goal: str(decided.goal),
    forWhom: str(decided.for_whom),
    objectives: list(decided.objectives),
    notDoing: list(decided.not_doing),
    modules, planes, capabilities, rows, open, done, milestones, plan, strip, recentlyShipped, rowsOf, chapterFor, loop,
    risk: str(blueprint.summary?.risk),
    read: str(blueprint.summary?.read),
    rowsUnder: (ms) => rows.filter((r) => str(r.milestone) === str(ms.id)),
    rowsUnplaced: rows.filter((r) => !milestones.some((ms) => str(ms.id) === str(r.milestone))),
    research: list(blueprint.research),
    chapters: list(blueprint.chapters),
    cards: data.cards,
    history: data.history,
    today: opts.now ? opts.now.slice(0, 10) : isDay(str(blueprint.as_of)) ? str(blueprint.as_of) : null,
    todayLabel: opts.now ? 'today' : 'as of',
  };
}

const NOT_YET = 'not in the fact files yet';
// A module takes the colour of its worst part (design §3.2); no parts listed → not scored.
function worstPart(parts) {
  const ls = list(parts).map((p) => str(p?.light).trim());
  for (const k of ['red', 'amber', 'green']) if (ls.includes(k)) return LIGHTS[k];
  return LIGHTS.none;
}
const partCounts = (mod) => {
  const c = { green: 0, amber: 0, red: 0 };
  for (const p of mod.parts) { const k = str(p?.light).trim(); if (k in c) c[k]++; }
  return `${c.green} green, ${c.amber} amber, ${c.red} red`;
};
// Field 0 and the map's path, from the step list: which steps a module owns or supports, what it takes in and
// hands on (the neighbouring steps owned by another module).
function loopFacts(m, mod) {
  const id = str(mod.id);
  const owns = m.loop.filter((st) => st.owner === id);
  const supports = m.loop.filter((st) => st.owner !== id && st.supports.includes(id));
  const takesIn = [], handsOn = [];
  m.loop.forEach((st, i) => {
    if (st.owner !== id) return;
    const prev = m.loop[i - 1], next = m.loop[i + 1];
    if (prev && prev.owner !== id) takesIn.push({ what: prev.name, mod: prev.owner, n: st.n });
    if (next && next.owner !== id) handsOn.push({ what: st.name, mod: next.owner, n: next.n });
  });
  const strip = m.loop.map((st) => ({ st, mark: st.owner === id ? '●' : st.supports.includes(id) ? '◯' : '·' }));
  return { owns, supports, takesIn, handsOn, strip };
}
const ownsChip = (lf) => (lf.owns.length ? `owns step ${lf.owns.map((st) => st.n).join(', ')}` : lf.supports.length ? 'shared: no step of its own' : '');
const gapsOf = (mod) => mod.parts.filter((p) => str(p?.light).trim() !== 'green').map((p) => str(p?.name));
const NOT_IN_DATA = '—';
const researchFields = (r) => (r && typeof r === 'object' && !Array.isArray(r)
  ? { date: str(r.date), finding: str(r.finding ?? r.what ?? r.title), informs: str(r.informs ?? r.module ?? r.row), link: str(r.path ?? r.link), superseded: str(r.superseded_by) }
  : { date: '', finding: str(r), informs: '', link: '', superseded: '' });
const rowWhen = (r) => (isDay(r.date) ? fmtDay(r.date) : r.trigger ? `when: ${str(r.trigger)}` : str(r.date));
const healthCounts = (m) => {
  const c = { green: 0, amber: 0, red: 0, none: 0 };
  for (const mod of m.modules) c[mod.light.cls]++;
  return c;
};

// ── the phone view (Markdown GitHub draws) ───────────────────────────────────────────────────────────────────
// md(): data → inert Markdown text. HTML characters become entities (so <script> or <details> in data is text),
// Markdown marks are backslash-escaped, and a line break can't end a table row.
function md(v) {
  return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]|~]/g, '\\$&').replace(/\r?\n/g, ' ').trim();
}
// mm(): data → a mermaid label: mermaid's own #entity; codes, so quotes, tags and backticks stay text.
function mm(v) {
  return str(v).replace(/\r?\n/g, ' ').replace(/#/g, '#35;').replace(/&/g, '#38;').replace(/"/g, '#quot;')
    .replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/`/g, '#96;').trim();
}
// gl(): data → a gantt task name, where ":" ";" and "#" are syntax: drop them.
const gl = (v) => str(v).replace(/[\r\n:;#<>"`]/g, ' ').replace(/\s+/g, ' ').trim() || 'item';
const code = (v) => `\`${str(v).replace(/[`\r\n]/g, ' ')}\``;
const table = (head, rowsOut) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rowsOut.map((r) => `| ${r.join(' | ')} |`)];
const chipMd = (l) => `${l.sym} ${l.word}`;

const ROW_HEAD = ['ID', 'What', 'Module', 'Capability', 'Owner', 'Date or trigger', 'Done when', 'Status', 'Receipts'];
function rowsFoldMd(label, rs) {
  if (!rs.length) return [`${md(label)}: none yet.`, ''];
  return [`<details><summary>${md(label)} (${rs.length})</summary>`, '',
    ...table(ROW_HEAD, rs.map((r) => [code(r.id), md(r.what), code(r.module), r.capability ? code(r.capability) : NOT_IN_DATA, md(r.owner), md(rowWhen(r)), md(r.done_when), md(r.status), list(r.receipts).map((x) => md(x)).join(', ') || NOT_IN_DATA])),
    '', '</details>', ''];
}

function renderPhone(m) {
  const L = [];
  const h = healthCounts(m);
  L.push('<!-- GENERATED by Bob\'s scripts/blueprint/render-blueprint.mjs from docs/blueprint/ (decided.yaml,');
  L.push('     blueprint.yaml, exit-tests.yaml, rows/*.yaml). Never edit by hand: a hand edit fails');
  L.push('     "generated means generated". Change the fact files and rebuild instead. -->');
  L.push('', '<a id="s-0"></a>', `# ${md(m.title)}: Blueprint & Roadmap`, '');
  L.push(`**As of ${md(m.asOf)}, built from ${code(m.commit)}.** This page is the one current view, generated from the fact files in this folder. The rich page (clickable map, timeline, slip chart) is built from the same data.`, '');
  L.push('[Summary](#s-1) · [Objectives](#s-2) · [Not doing](#s-2a) · [Map](#s-3-0) · [Cards](#s-3-n) · [Capabilities](#s-3-c) · [Status](#s-5a) · [Plan](#s-5c) · [Waiting on you](#s-5d) · [Per module](#s-5e) · [Research](#s-r) · [History & evidence](history/)', '');

  L.push('<a id="s-1"></a>', '## 1 · Executive summary', '');
  L.push(`- **One-line purpose:** ${md(m.goal)}`);
  L.push(`- **Overall health (counts per light):** ● Green ${h.green} · ◐ Amber ${h.amber} · ○ Red ${h.red} · ◌ Not scored ${h.none}`);
  L.push(`- **Target dates for "done":** ${m.milestones.length ? m.milestones.map((ms) => `${md(ms.id)} ${md(ms.name)} by ${md(fmtDay(ms.estimate))}`).join(' · ') : 'no milestones yet'}`);
  L.push(`- **Recently shipped:** ${m.recentlyShipped.length ? m.recentlyShipped.map((r) => `${md(r.what)} ${code(r.id)}`).join(' · ') : 'no row marked done yet'}`);
  L.push(`- **Waiting on you:** as of ${md(m.asOf)}; live list: the project's digest or status page`);
  L.push(`- **As of ${md(m.asOf)};** newer changes are written down in the row files and the changelog`);
  L.push(`- **Biggest risk:** ${md(m.risk)}`);
  L.push(`- **The one-line read:** ${md(m.read)}`, '');

  L.push('<a id="s-2"></a>', '## 2 · Objectives', '', `> **Overall goal:** ${md(m.goal)}`, '');
  L.push(...table(['ID', 'Short name', 'One-line promise', 'Target, as a number', "How it's measured"],
    m.objectives.map((o) => [code(o.id), md(o.name), md(o.promise), md(o.target), md(o.measured_by)])), '');

  L.push('<a id="s-2a"></a>', '## 2a · Not doing', '');
  L.push(...(m.notDoing.length ? table(['What we are not doing', 'Why', 'What would make us revisit it'],
    m.notDoing.map((n) => [md(n.what), md(n.why), md(n.revisit_if)])) : ['Nothing ruled out yet.']), '');

  L.push('<a id="s-3-0"></a>', '## 3.0 · The map', '');
  L.push('Each box: ID · name · one-line role · light. Tap a box to open its card.', '');
  L.push('```mermaid', 'flowchart TB');
  m.planes.forEach((plane, zi) => {
    L.push(`  subgraph z${zi}["${mm(plane)}"]`);
    m.modules.forEach((mod, i) => {
      if (str(mod.plane) === plane) L.push(`    n${i}["<code>${mm(mod.id)}</code> · <b>${mm(mod.name)}</b><br/>${mm(mod.role)}<br/>${mod.light.sym} ${mod.light.word}"]`);
    });
    L.push('  end');
  });
  const node = new Map(m.modules.map((mod, i) => [str(mod.id), `n${i}`]));
  m.loop.forEach((st, i) => {
    const next = m.loop[i + 1];
    if (next && node.has(st.owner) && node.has(next.owner) && st.owner !== next.owner) L.push(`  ${node.get(st.owner)} -->|"${mm(`${st.n} · ${st.name}`)}"| ${node.get(next.owner)}`);
  });
  m.modules.forEach((mod, i) => L.push(`  click n${i} "#${mod.anchor}"`));
  L.push('```', '');
  L.push(`**The loop:** ${m.loop.length ? m.loop.map((st) => `${md(st.n)} · ${md(st.name)} ${code(st.owner)}`).join(' → ') : 'no steps listed yet'}`, '');
  L.push('**Legend:** ● Green · ◐ Amber · ○ Red · ◌ Not scored (no parts listed). A module takes the colour of its worst part.', '');

  L.push('<a id="s-3-n"></a>', '## 3.n · Module cards', '');
  for (const mod of m.modules) {
    const s = m.rowsOf(mod);
    const lf = loopFacts(m, mod);
    const caps = m.capabilities.filter((c) => str(c.module) === str(mod.id));
    const chapter = m.chapterFor(mod);
    const card = m.cards.includes(`${str(mod.id)}.md`) ? `cards/${str(mod.id)}.md` : null;
    L.push(`<a id="${mod.anchor}"></a>`, '', `### ${code(mod.id)} · **${md(mod.name)}** · ${md(mod.plane)} · ${chipMd(mod.light)}${ownsChip(lf) ? ` · ${ownsChip(lf)}` : ''}`, '');
    L.push(`**Role:** ${md(mod.role)}`, '');
    L.push('**0 · Where it sits in the loop**', '');
    L.push(`- **(a) The step strip:** ${lf.strip.length ? lf.strip.map(({ st, mark }) => `${mark} ${md(st.n)} ${md(st.name)}`).join(' · ') : 'no steps listed yet'}${!lf.owns.length && lf.supports.length ? ' (shared: no step of its own)' : ''}`);
    L.push(`- **(b) Takes in:** ${lf.takesIn.length ? lf.takesIn.map((t) => `${md(t.what)}, from ${code(t.mod)}, at step ${md(t.n)}`).join('; ') : 'nothing from another module'}`);
    L.push(`- **(c) Hands on:** ${lf.handsOn.length ? lf.handsOn.map((t) => `${md(t.what)}, to ${code(t.mod)}, at step ${md(t.n)}`).join('; ') : 'nothing to another module'}`);
    L.push(`- **(d) Checkpoints held** and **(e) where you touch it:** ${NOT_YET}`, '');
    L.push(`**5 · Health:** ${chipMd(mod.light)}${mod.parts.length ? ` · ${partCounts(mod)}` : ' (no parts listed yet)'}`, '');
    if (mod.parts.length) L.push(...table(['Part', 'Light', 'In one line'], mod.parts.map((p) => [md(p?.name), chipMd(worstPart([p])), md(p?.line)])), '');
    L.push(`<a id="${mod.anchor}-next"></a>`, '', '**7 · Next**', '');
    L.push(`- **Usable on:** ${isDay(mod.stage.usable_on) ? md(fmtDay(mod.stage.usable_on)) : 'no date yet'} · **Green on:** ${isDay(mod.stage.green_on) ? md(fmtDay(mod.stage.green_on)) : 'no date yet'}${mod.reads.length ? `, once ${mod.reads.map(code).join(', ')} ${mod.reads.length > 1 ? 'are' : 'is'} green` : ''}`);
    for (const r of s.dated) L.push(`- ${code(`${str(r.status) === 'done' ? 'Done ' : ''}${fmtDay(r.date)}:`)} ${md(r.what)} ${code(r.id)}`);
    for (const r of s.undated) L.push(`- ${code('After that · No date yet:')} ${md(r.what)}${r.trigger ? ` (when: ${md(r.trigger)})` : ''} ${code(r.id)}`);
    if (!s.dated.length && !s.undated.length) L.push('- No roadmap rows for this module yet.');
    L.push('', '<details><summary>8 · More detail</summary>', '');
    L.push(`- **Capabilities this module delivers:** ${caps.length ? caps.map((c) => `${code(c.id)} ${md(c.name)} · ${md(c.maturity)}`).join(' · ') : 'none listed'}`);
    L.push(`- **The module's detail spec (its chapter):** ${chapter ? `[${md(chapter)}](../${chapter.split('/').slice(1).join('/')})` : 'none found'}`);
    L.push(`- **Card text (hand-written):** ${card ? `[${md(card)}](${card})` : 'none yet'}`);
    L.push('', '</details>', '');
  }

  L.push('<a id="s-3-c"></a>', '## 3.c · Capability index', '');
  L.push(...(m.capabilities.length ? table(['ID', 'Capability', 'Module', 'Stage of maturity', 'Roadmap row', 'Status'],
    m.capabilities.map((c) => [code(c.id), md(c.name), code(c.module), `${md(c.maturity)}${c.adopted ? ' (adopted)' : ''}`, c.row ? code(c.row) : NOT_IN_DATA, md(c.status)])) : ['No capabilities listed yet.']), '');

  L.push('<a id="s-5a"></a>', '## 5a · Stage-by-stage status', '');
  L.push(...table(['Stage', 'Usable on', 'Green on', 'Reads from', 'done-test written yet?', 'Remaining steps', 'Known gaps after that'],
    m.modules.map((mod) => [`${code(mod.id)} ${md(mod.name)}`, isDay(mod.stage.usable_on) ? md(fmtDay(mod.stage.usable_on)) : NOT_IN_DATA,
      isDay(mod.stage.green_on) ? md(fmtDay(mod.stage.green_on)) : NOT_IN_DATA, mod.reads.map(code).join(' ') || 'nothing', md(mod.stage.done_test) || NOT_IN_DATA,
      m.rowsOf(mod).open.map((r) => code(r.id)).join(' ') || 'none', gapsOf(mod).map(md).join(', ') || (mod.parts.length ? 'none' : NOT_IN_DATA)])), '');
  L.push(`${NOT_IN_DATA} = no date or answer in the fact files yet. "Usable" means the module does its job end to end; "green" means its own test passes and everything it reads from is green. Known gaps are its parts that are not green.`, '');

  L.push('<a id="s-5c"></a>', '## 5c · The dated plan = the roadmap', '');
  const ids = (rs) => (rs.length ? rs.map((r) => `${md(r.what)} ${code(r.id)}`).join(', ') : 'nothing');
  L.push(`**Now:** ${ids(m.strip.now)} · **Next:** ${ids(m.strip.next)} · **Later:** ${m.strip.later.length ? m.strip.later.map((r) => `${md(r.what)} ${code(r.id)}${r.trigger ? ` (trigger: ${md(r.trigger)})` : ''}`).join(', ') : 'nothing'}`, '');
  L.push('### Milestones in sequence', '');
  for (const ms of m.milestones) {
    L.push(`#### ${code(ms.id)} · ${md(ms.name)}`, '');
    L.push(`- **Exit test:** ${ms.tests.length ? ms.tests.map((t) => `${md(t.passes_when)} (${code(t.test)})`).join('; ') : 'none written yet'}`);
    L.push(`- **Estimate:** ${md(fmtDay(ms.estimate))}${ms.condition ? `, ${md(ms.condition)}` : ''}`);
    L.push(`- **Slip history:** ${ms.slips.length ? ms.slips.map((sl) => `${md(fmtDay(sl?.from))} → ${md(fmtDay(sl?.to))}: ${md(sl?.reason)}`).join(' · ') : 'no slips'}`, '');
    L.push(...rowsFoldMd(`Rows under ${str(ms.id)}`, m.rowsUnder(ms)));
  }
  if (m.rowsUnplaced.length) L.push('#### Rows under no milestone', '', ...rowsFoldMd('Rows', m.rowsUnplaced));
  L.push('"A milestone ends when its test passes, never because a date arrived."', '');
  L.push('### The dated plan table', '');
  L.push(...table(['When', 'What'], [
    ...m.plan.map((p) => [md(fmtDay(p.date)), `${code(p.id)} ${md(p.what)}${p.kind === 'milestone' ? ' (milestone)' : ''}`]),
    ['', `**What's queued next:** ${m.strip.next.map((r) => code(r.id)).join(' ') || 'nothing'}`],
    ['', `**What's not starting, by your ruling:** ${m.notDoing.map((n) => md(n.what)).join(' · ') || 'nothing'}`],
    ['', '**Dates are estimates.**'],
  ]), '');
  L.push('### Timeline', '');
  const gantt = [];
  for (const ms of m.milestones) {
    if (isDay(ms.estimate)) gantt.push(`    ${gl(`${str(ms.id)} ${str(ms.name)}`)} : milestone, ${ms.estimate}, 0d`);
    for (const sl of ms.slips) if (isDay(sl?.from) && isDay(sl?.to) && sl.from < sl.to) gantt.push(`    ${gl(`${str(ms.id)} slipped`)} : crit, ${sl.from}, ${sl.to}`);
  }
  if (gantt.length) L.push('```mermaid', 'gantt', '  dateFormat YYYY-MM-DD', '  todayMarker off', '  section Milestones', ...gantt, '```', '');
  else L.push('No dated milestones yet.', '');

  L.push('<a id="s-5d"></a>', '## 5d · Waiting on you', '');
  L.push(`As of ${md(m.asOf)}; live list: the project's digest or status page. (This view can't read the live task list.)`, '');

  L.push('<a id="s-5e"></a>', '## 5e · Per module', '');
  L.push(m.modules.length ? m.modules.map((mod) => `[${md(mod.id)} → Next](#${mod.anchor}-next)`).join(' · ') : 'No modules yet.', '');

  L.push('<a id="s-r"></a>', '## R · Research library', '');
  L.push(...(m.research.length ? table(['Date', 'One-line finding', 'Module or row it informs', 'Link', 'Superseded by'],
    m.research.map((r) => { const f = researchFields(r); return [md(f.date) || NOT_IN_DATA, md(f.finding), md(f.informs) || NOT_IN_DATA, f.link ? code(f.link) : NOT_IN_DATA, md(f.superseded) || NOT_IN_DATA]; }))
    : ['No research entries yet.']), '');
  L.push('---', '', `_Generated from the fact files as of ${md(m.asOf)}, built from ${code(m.commit)}. Never deleted: the research library and history keep every entry._`);
  return L.join('\n') + '\n';
}

// ── the rich page (HTML, self-contained) ─────────────────────────────────────────────────────────────────────
// esc(): data → inert HTML text, safe in element content and in quoted attributes.
function esc(v) {
  return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const chip = (l) => `<span class="chip ${l.cls}">${l.sym} ${l.word}</span>`;
const rid = (v) => `<code class="rcpt">${esc(v)}</code>`;
const htable = (head, rowsOut) => `<div class="tw"><table><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rowsOut.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// The one script on the page. It reads no data: only the stamp's ISO time, which the builder checked is ISO.
const STALE_SCRIPT = `(function(){var s=document.getElementById("stamp");if(!s)return;var t=Date.parse(s.getAttribute("data-built")||"");if(isNaN(t)||Date.now()-t>${STALE_MS}){document.documentElement.className+=" stale";if(!document.getElementById("stale-note")){var n=document.createElement("p");n.id="stale-note";n.textContent="\u25CB Red: this page is more than 2 hours old; the page builder may have stopped.";s.parentNode.appendChild(n);}}})();`;
const SCRIPT_HASH = crypto.createHash('sha256').update(STALE_SCRIPT).digest('base64');

const LAYOUT_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1,h2,h3,h4{font-family:"Avenir Next Condensed","Arial Narrow","Roboto Condensed",system-ui,sans-serif;font-stretch:condensed;line-height:1.2}
h2{margin-top:2.2rem;border-bottom:1px solid color-mix(in srgb,var(--muted) 30%,transparent);padding-bottom:.25rem}
code,.rcpt,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}
.rcpt{color:var(--muted)}
a{color:var(--zone-1)}
main{padding:0 16px 4rem;max-width:72rem;margin:0 auto}
p,li,.prose{max-width:72ch}
header.top{padding:1rem 16px;background:var(--zone-shared-soft);border-bottom:3px solid var(--zone-shared)}
header.top h1{margin:0 0 .25rem}
header.top .stamp{margin:.25rem 0 0}
html.stale header.top{background:var(--red);color:var(--bg);border-bottom-color:var(--red)}
html.stale header.top a{color:var(--bg)}
#stale-note{font-weight:700;margin:.5rem 0 0}
.neutral{margin:.5rem 0 0;color:var(--muted)}
nav.bar{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid color-mix(in srgb,var(--muted) 30%,transparent);padding:.4rem 16px;overflow-x:auto;white-space:nowrap;font-size:.9rem}
nav.bar a{margin-right:.8rem;text-decoration:none}
.chip{display:inline-block;padding:0 .5em;border-radius:1em;font-size:.85em;white-space:nowrap}
.chip.green{color:var(--green);background:var(--green-soft)}
.chip.amber{color:var(--amber);background:var(--amber-soft)}
.chip.red{color:var(--red);background:var(--red-soft)}
.chip.none{color:var(--muted);background:var(--zone-shared-soft)}
.ph{color:var(--muted);font-style:italic}
.tw{overflow-x:auto;margin:.75rem 0}
table{border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;vertical-align:top;padding:.35rem .6rem;border-bottom:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}
th{color:var(--muted);font-weight:600}
blockquote{margin:1rem 0;padding:.5rem 1rem;border-left:4px solid var(--zone-1);background:var(--zone-1-soft)}
details{margin:.5rem 0}
summary{cursor:pointer;font-weight:600}
.map{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem;margin:1rem 0}
.zone{border-radius:.5rem;padding:.75rem;border-top:4px solid var(--zone-shared);background:var(--zone-shared-soft)}
.zone h4{margin:0 0 .5rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:.8rem}
.box{display:block;margin:.5rem 0;padding:.6rem .7rem;border-radius:.4rem;background:var(--bg);color:var(--ink);text-decoration:none;border:1px solid color-mix(in srgb,var(--muted) 30%,transparent)}
.box:hover,.box:focus{outline:2px solid var(--zone-1)}
.box b{display:block}
.z1{border-top-color:var(--zone-1);background:var(--zone-1-soft)} .z1 .zid{color:var(--zone-1)}
.z2{border-top-color:var(--zone-2);background:var(--zone-2-soft)} .z2 .zid{color:var(--zone-2)}
.z3{border-top-color:var(--zone-3);background:var(--zone-3-soft)} .z3 .zid{color:var(--zone-3)}
.zshared{border-top-color:var(--zone-shared);background:var(--zone-shared-soft)} .zshared .zid{color:var(--zone-shared)}
.card{border:1px solid color-mix(in srgb,var(--muted) 30%,transparent);border-radius:.5rem;padding:.25rem 1rem .75rem;margin:1rem 0}
.card>h3{margin:.75rem 0 .5rem}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.75rem}
.strip>div{padding:.6rem .8rem;border-radius:.4rem;background:var(--zone-shared-soft)}
.tl{position:relative;margin:1rem 0;padding:1.6rem 0 .5rem;min-width:36rem}
.tl-row{position:relative;height:2.1rem;border-bottom:1px dashed color-mix(in srgb,var(--muted) 25%,transparent)}
.tl-label{position:absolute;left:0;top:.15rem;font-size:.8rem;color:var(--muted);width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-track{position:absolute;left:9.5rem;right:.5rem;top:0;bottom:0}
.tl-dot{position:absolute;top:.55rem;width:.9rem;height:.9rem;margin-left:-.45rem;transform:rotate(45deg);background:var(--zone-1)}
.tl-old{position:absolute;top:.55rem;width:.9rem;height:.9rem;margin-left:-.45rem;transform:rotate(45deg);border:2px solid var(--muted)}
.tl-slip{position:absolute;top:.9rem;height:.25rem;background:var(--red)}
.tl-row-dot{position:absolute;top:.7rem;width:.6rem;height:.6rem;margin-left:-.3rem;border-radius:50%;background:var(--zone-2)}
.tl-today{position:absolute;top:0;bottom:0;border-left:2px solid var(--amber)}
.tl-today span{position:absolute;top:0;left:.25rem;font-size:.75rem;color:var(--amber);white-space:nowrap}
.tl-axis{position:absolute;top:0;font-size:.72rem;color:var(--muted);white-space:nowrap}
.dot{font-size:1.1em;color:var(--muted)} .dot.own{color:var(--zone-1)} .dot.sup{color:var(--zone-2)}
.path .step{white-space:nowrap}
.banner{padding:.75rem 1rem;background:var(--amber-soft);color:var(--ink);border-left:4px solid var(--amber)}
footer{color:var(--muted);font-size:.85rem;margin-top:3rem}
@media print{nav.bar{position:static}}
`;

function htmlPage(m, tokens, title, body) {
  const builtTime = fmtTime(m.builtAt);
  const stampText = `built from main at <code>${esc(m.commit)}</code>, ${builtTime ? esc(builtTime) : 'at a time not given (so it counts as stale)'}`;
  return `<!doctype html>
<html lang="en" class="${m.stale ? 'stale' : 'fresh'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<style>
${tokens}
${LAYOUT_CSS.trim()}
</style>
</head>
<body>
<!-- GENERATED by Bob's scripts/blueprint/render-blueprint.mjs from docs/blueprint/. Never edit by hand. -->
<header class="top" id="s-0">
<h1>${esc(title)}</h1>
<p class="stamp" id="stamp" data-built="${esc(m.builtAt || '')}"><b>As of ${esc(m.asOf)}</b> · ${stampText}</p>
${m.stale ? '<p id="stale-note">○ Red: this page was built more than 2 hours ago (or at an unknown time); the page builder may have stopped.</p>' : '<noscript><p class="neutral">Freshness can\'t be checked here (scripts are off): compare the build time above with your clock.</p></noscript>'}
</header>
${body}
<script>${STALE_SCRIPT}</script>
</body>
</html>
`;
}

function renderIndex(m, tokens) {
  const h = healthCounts(m);
  const B = [];
  B.push('<nav class="bar" aria-label="Contents"><a href="#s-1">Summary</a><a href="#s-2">Objectives</a><a href="#s-2a">Not doing</a><a href="#s-3-0">Map</a><a href="#s-3-n">Cards</a><a href="#s-3-c">Capabilities</a><a href="#s-5a">Status</a><a href="#s-5c">Plan</a><a href="#s-5d">Waiting on you</a><a href="#s-5e">Per module</a><a href="#s-r">Research</a><a href="history.html">History &amp; evidence</a></nav>');
  B.push('<main>');
  B.push('<p class="prose">This page is the one current view, generated from the fact files. Phone view: <code>docs/blueprint/BLUEPRINT.md</code> in the repo · <a href="history.html">History &amp; evidence</a></p>');

  B.push('<h2 id="s-1">1 · Executive summary</h2><ul>');
  B.push(`<li><b>One-line purpose:</b> ${esc(m.goal)}</li>`);
  B.push(`<li><b>Overall health (counts per light):</b> ${chip(LIGHTS.green)} ${h.green} · ${chip(LIGHTS.amber)} ${h.amber} · ${chip(LIGHTS.red)} ${h.red} · ${chip(LIGHTS.none)} ${h.none}</li>`);
  B.push(`<li><b>Target dates for "done":</b> ${m.milestones.length ? m.milestones.map((ms) => `${rid(ms.id)} ${esc(ms.name)} by ${esc(fmtDay(ms.estimate))}`).join(' · ') : 'no milestones yet'}</li>`);
  B.push(`<li><b>Recently shipped:</b> ${m.recentlyShipped.length ? m.recentlyShipped.map((r) => `${esc(r.what)} ${rid(r.id)}`).join(' · ') : 'no row marked done yet'}</li>`);
  B.push(`<li><b>Waiting on you:</b> as of ${esc(m.asOf)}; live list: the project's digest or status page</li>`);
  B.push(`<li><b>Biggest risk:</b> ${esc(m.risk)}</li>`);
  B.push(`<li><b>The one-line read:</b> ${esc(m.read)}</li></ul>`);

  B.push(`<h2 id="s-2">2 · Objectives</h2><blockquote><b>Overall goal:</b> ${esc(m.goal)}</blockquote>`);
  B.push(htable(['ID', 'Short name', 'One-line promise', 'Target, as a number', "How it's measured"],
    m.objectives.map((o) => [rid(o.id), esc(o.name), esc(o.promise), esc(o.target), esc(o.measured_by)])));
  B.push('<h2 id="s-2a">2a · Not doing</h2>');
  B.push(m.notDoing.length ? htable(['What we are not doing', 'Why', 'What would make us revisit it'], m.notDoing.map((n) => [esc(n.what), esc(n.why), esc(n.revisit_if)])) : '<p>Nothing ruled out yet.</p>');

  B.push('<h2 id="s-3-0">3.0 · The map</h2><p class="prose">Each box: ID · name · one-line role · light. Click a box to open its card.</p>');
  B.push(`<p class="path"><b>The loop:</b> ${m.loop.length ? m.loop.map((st) => `<span class="step">${esc(st.n)} · ${esc(st.name)} ${m.modules.some((x) => str(x.id) === st.owner) ? `<a href="#card-${esc(slug(st.owner))}">${rid(st.owner)}</a>` : rid(st.owner)}</span>`).join(' → ') : 'no steps listed yet'}</p><div class="map">`);
  for (const plane of m.planes) {
    const mods = m.modules.filter((mod) => str(mod.plane) === plane);
    B.push(`<section class="zone z${mods[0].zone}"><h4>${esc(plane)}</h4>`);
    for (const mod of mods) { const oc = ownsChip(loopFacts(m, mod)); B.push(`<a class="box" href="#${esc(mod.anchor)}"><code class="zid">${esc(mod.id)}</code><b>${esc(mod.name)}</b><span>${esc(mod.role)}</span><br>${chip(mod.light)}${oc ? ` <span class="rcpt">${esc(oc)}</span>` : ''}</a>`); }
    B.push('</section>');
  }
  B.push('</div><p class="prose"><b>Legend:</b> ● Green · ◐ Amber · ○ Red · ◌ Not scored (no parts listed). A module takes the colour of its worst part.</p>');

  B.push('<h2 id="s-3-n">3.n · Module cards</h2>');
  for (const mod of m.modules) {
    const s = m.rowsOf(mod);
    const lf = loopFacts(m, mod);
    const oc = ownsChip(lf);
    const caps = m.capabilities.filter((c) => str(c.module) === str(mod.id));
    const chapter = m.chapterFor(mod);
    const card = m.cards.includes(`${str(mod.id)}.md`) ? `docs/blueprint/cards/${str(mod.id)}.md` : null;
    B.push(`<article class="card z${mod.zone}" id="${esc(mod.anchor)}"><h3><code class="zid">${esc(mod.id)}</code> · ${esc(mod.name)} · <span class="chip none">${esc(mod.plane)}</span> ${chip(mod.light)}${oc ? ` <span class="chip none">${esc(oc)}</span>` : ''}</h3>`);
    B.push(`<p><b>Role:</b> ${esc(mod.role)}</p>`);
    B.push('<h4>0 · Where it sits in the loop</h4><ul>');
    B.push(`<li><b>(a) The step strip:</b> ${lf.strip.length ? lf.strip.map(({ st, mark }) => `<span class="dot${mark === '●' ? ' own' : mark === '◯' ? ' sup' : ''}" title="${esc(`${st.n} · ${st.name}`)}">${mark}</span> ${esc(st.n)}`).join(' ') : 'no steps listed yet'}${!lf.owns.length && lf.supports.length ? ' (shared: no step of its own)' : ''}</li>`);
    B.push(`<li><b>(b) Takes in:</b> ${lf.takesIn.length ? lf.takesIn.map((t) => `${esc(t.what)}, from ${rid(t.mod)}, at step ${esc(t.n)}`).join('; ') : 'nothing from another module'}</li>`);
    B.push(`<li><b>(c) Hands on:</b> ${lf.handsOn.length ? lf.handsOn.map((t) => `${esc(t.what)}, to ${rid(t.mod)}, at step ${esc(t.n)}`).join('; ') : 'nothing to another module'}</li>`);
    B.push(`<li><b>(d) Checkpoints held</b> and <b>(e) where you touch it:</b> ${NOT_YET}</li></ul>`);
    B.push(`<p><b>5 · Health:</b> ${chip(mod.light)}${mod.parts.length ? ` · ${partCounts(mod)}` : ' (no parts listed yet)'}</p>`);
    if (mod.parts.length) B.push(htable(['Part', 'Light', 'In one line'], mod.parts.map((p) => [esc(p?.name), chip(worstPart([p])), esc(p?.line)])));
    B.push(`<h4 id="${esc(mod.anchor)}-next">7 · Next</h4><ul><li><b>Usable on:</b> ${isDay(mod.stage.usable_on) ? esc(fmtDay(mod.stage.usable_on)) : 'no date yet'} · <b>Green on:</b> ${isDay(mod.stage.green_on) ? esc(fmtDay(mod.stage.green_on)) : 'no date yet'}${mod.reads.length ? `, once ${mod.reads.map(rid).join(', ')} ${mod.reads.length > 1 ? 'are' : 'is'} green` : ''}</li>`);
    for (const r of s.dated) B.push(`<li><code>${esc(`${str(r.status) === 'done' ? 'Done ' : ''}${fmtDay(r.date)}:`)}</code> ${esc(r.what)} ${rid(r.id)}</li>`);
    for (const r of s.undated) B.push(`<li><code>After that · No date yet:</code> ${esc(r.what)}${r.trigger ? ` (when: ${esc(r.trigger)})` : ''} ${rid(r.id)}</li>`);
    if (!s.dated.length && !s.undated.length) B.push('<li>No roadmap rows for this module yet.</li>');
    B.push('</ul><details><summary>8 · More detail</summary><ul>');
    B.push(`<li><b>Capabilities this module delivers:</b> ${caps.length ? caps.map((c) => `${rid(c.id)} ${esc(c.name)} · ${esc(c.maturity)}`).join(' · ') : 'none listed'}</li>`);
    B.push(`<li><b>The module's detail spec (its chapter):</b> ${chapter ? `<code>${esc(chapter)}</code>` : 'none found'}</li>`);
    B.push(`<li><b>Card text (hand-written):</b> ${card ? `<code>${esc(card)}</code>` : 'none yet'}</li></ul></details></article>`);
  }

  B.push('<h2 id="s-3-c">3.c · Capability index</h2>');
  B.push(m.capabilities.length ? htable(['ID', 'Capability', 'Module', 'Stage of maturity', 'Roadmap row', 'Status'],
    m.capabilities.map((c) => [rid(c.id), esc(c.name), rid(c.module), `${esc(c.maturity)}${c.adopted ? ' (adopted)' : ''}`, c.row ? rid(c.row) : NOT_IN_DATA, esc(c.status)])) : '<p>No capabilities listed yet.</p>');

  B.push('<h2 id="s-5a">5a · Stage-by-stage status</h2>');
  B.push(htable(['Stage', 'Usable on', 'Green on', 'Reads from', 'done-test written yet?', 'Remaining steps', 'Known gaps after that'],
    m.modules.map((mod) => [`${rid(mod.id)} ${esc(mod.name)}`, isDay(mod.stage.usable_on) ? esc(fmtDay(mod.stage.usable_on)) : NOT_IN_DATA,
      isDay(mod.stage.green_on) ? esc(fmtDay(mod.stage.green_on)) : NOT_IN_DATA, mod.reads.map(rid).join(' ') || 'nothing', esc(mod.stage.done_test) || NOT_IN_DATA,
      m.rowsOf(mod).open.map((r) => rid(r.id)).join(' ') || 'none', gapsOf(mod).map(esc).join(', ') || (mod.parts.length ? 'none' : NOT_IN_DATA)])));
  B.push(`<p class="prose">${NOT_IN_DATA} = no date or answer in the fact files yet. "Usable" means the module does its job end to end; "green" means its own test passes and everything it reads from is green. Known gaps are its parts that are not green.</p>`);

  B.push('<h2 id="s-5c">5c · The dated plan = the roadmap</h2><div class="strip">');
  const items = (rs, trig) => (rs.length ? rs.map((r) => `${esc(r.what)} ${rid(r.id)}${trig && r.trigger ? ` <span class="rcpt">(trigger: ${esc(r.trigger)})</span>` : ''}`).join('<br>') : 'nothing');
  B.push(`<div><b>Now</b><br>${items(m.strip.now)}</div><div><b>Next</b><br>${items(m.strip.next)}</div><div><b>Later</b><br>${items(m.strip.later, true)}</div></div>`);
  B.push('<h3>Timeline and slip chart</h3>', timeline(m));
  B.push('<h3>Milestones in sequence</h3>');
  for (const ms of m.milestones) {
    B.push(`<h4>${rid(ms.id)} · ${esc(ms.name)}</h4><ul>`);
    B.push(`<li><b>Exit test:</b> ${ms.tests.length ? ms.tests.map((t) => `${esc(t.passes_when)} (<code>${esc(t.test)}</code>)`).join('; ') : 'none written yet'}</li>`);
    B.push(`<li><b>Estimate:</b> ${esc(fmtDay(ms.estimate))}${ms.condition ? `, ${esc(ms.condition)}` : ''}</li>`);
    B.push(`<li><b>Slip history:</b> ${ms.slips.length ? ms.slips.map((sl) => `${esc(fmtDay(sl?.from))} → ${esc(fmtDay(sl?.to))}: ${esc(sl?.reason)}`).join(' · ') : 'no slips'}</li></ul>`);
    B.push(rowsFoldHtml(`Rows under ${str(ms.id)}`, m.rowsUnder(ms)));
  }
  if (m.rowsUnplaced.length) B.push('<h4>Rows under no milestone</h4>', rowsFoldHtml('Rows', m.rowsUnplaced));
  B.push('<p class="prose">"A milestone ends when its test passes, never because a date arrived."</p>');
  B.push('<h3>The dated plan table</h3>');
  B.push(htable(['When', 'What'], [
    ...m.plan.map((p) => [esc(fmtDay(p.date)), `${rid(p.id)} ${esc(p.what)}${p.kind === 'milestone' ? ' (milestone)' : ''}`]),
    ['', `<b>What's queued next:</b> ${m.strip.next.map((r) => rid(r.id)).join(' ') || 'nothing'}`],
    ['', `<b>What's not starting, by your ruling:</b> ${m.notDoing.map((n) => esc(n.what)).join(' · ') || 'nothing'}`],
    ['', '<b>Dates are estimates.</b>'],
  ]));

  B.push(`<h2 id="s-5d">5d · Waiting on you</h2><p class="prose">As of ${esc(m.asOf)}; live list: the project's digest or status page. (Live asks are added to this page once the builder may read the live task list.)</p>`);
  B.push(`<h2 id="s-5e">5e · Per module</h2><p>${m.modules.length ? m.modules.map((mod) => `<a href="#${esc(mod.anchor)}-next">${esc(mod.id)} → Next</a>`).join(' · ') : 'No modules yet.'}</p>`);
  B.push('<h2 id="s-r">R · Research library</h2>', researchTable(m));
  B.push(`<footer>Generated from the fact files as of ${esc(m.asOf)}, built from <code>${esc(m.commit)}</code>. Builders' notes: rebuilt by Bob's render-blueprint.mjs; never edited by hand.</footer></main>`);
  return htmlPage(m, tokens, `${m.title}: Blueprint & Roadmap`, B.join('\n'));
}

function rowsFoldHtml(label, rs) {
  if (!rs.length) return `<p>${esc(label)}: none yet.</p>`;
  return `<details><summary>${esc(label)} (${rs.length})</summary>${htable(ROW_HEAD,
    rs.map((r) => [rid(r.id), esc(r.what), rid(r.module), r.capability ? rid(r.capability) : NOT_IN_DATA, esc(r.owner), esc(rowWhen(r)), esc(r.done_when), esc(r.status), list(r.receipts).map(rid).join(' ') || NOT_IN_DATA]))}</details>`;
}

function researchTable(m) {
  return m.research.length ? htable(['Date', 'One-line finding', 'Module or row it informs', 'Link', 'Superseded by'],
    m.research.map((r) => { const f = researchFields(r); return [esc(f.date) || NOT_IN_DATA, esc(f.finding), esc(f.informs) || NOT_IN_DATA, f.link ? `<code>${esc(f.link)}</code>` : NOT_IN_DATA, esc(f.superseded) || NOT_IN_DATA]; }))
    : '<p>No research entries yet.</p>';
}

// The timeline: milestones (filled diamonds), their earlier estimates (outlined) joined by a red slip bar, row
// dates (dots) and today's line, all on one date scale. Positions are computed, never taken from data.
function timeline(m) {
  const day = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
  const all = [];
  for (const ms of m.milestones) {
    if (isDay(ms.estimate)) all.push(ms.estimate);
    for (const sl of ms.slips) for (const d of [sl?.from, sl?.to]) if (isDay(d)) all.push(d);
  }
  const datedRows = m.rows.filter((r) => isDay(r.date)).sort(byDateThenId);
  for (const r of datedRows) all.push(r.date);
  if (!all.length) return '<p>No dated milestones or rows yet.</p>';
  if (m.today) all.push(m.today);
  all.sort();
  const lo = day(all[0]);
  const span = Math.max(1, day(all[all.length - 1]) - lo);
  const pct = (s) => `${(((day(s) - lo) / span) * 100).toFixed(2)}%`;
  const R = ['<div class="tw"><div class="tl" role="img" aria-label="Timeline of milestones, slips and rows">'];
  R.push(`<div class="tl-row" style="height:1.2rem;border:0"><div class="tl-track"><span class="tl-axis" style="left:0">${esc(fmtDay(all[0]))}</span><span class="tl-axis" style="right:0">${esc(fmtDay(all[all.length - 1]))}</span></div></div>`);
  for (const ms of m.milestones) {
    const parts = [];
    for (const sl of ms.slips) {
      if (isDay(sl?.from)) parts.push(`<span class="tl-old" style="left:${pct(sl.from)}" title="earlier estimate ${esc(fmtDay(sl.from))}"></span>`);
      if (isDay(sl?.from) && isDay(sl?.to) && sl.from < sl.to) parts.push(`<span class="tl-slip" style="left:${pct(sl.from)};width:${(((day(sl.to) - day(sl.from)) / span) * 100).toFixed(2)}%" title="slipped: ${esc(sl.reason)}"></span>`);
    }
    if (isDay(ms.estimate)) parts.push(`<span class="tl-dot" style="left:${pct(ms.estimate)}" title="${esc(ms.id)} ${esc(fmtDay(ms.estimate))}"></span>`);
    R.push(`<div class="tl-row"><span class="tl-label">${esc(ms.id)} · ${esc(ms.name)}</span><div class="tl-track">${parts.join('')}</div></div>`);
  }
  if (datedRows.length) {
    R.push(`<div class="tl-row"><span class="tl-label">Rows</span><div class="tl-track">${datedRows.map((r) => `<span class="tl-row-dot" style="left:${pct(r.date)}" title="${esc(r.id)} ${esc(fmtDay(r.date))}"></span>`).join('')}</div></div>`);
  }
  if (m.today) R.push(`<div class="tl-track" style="top:0;bottom:0"><div class="tl-today" style="left:${pct(m.today)}"><span>${esc(m.todayLabel)} ${esc(fmtDay(m.today))}</span></div></div>`);
  R.push('</div></div>');
  R.push('<p class="prose"><span class="mono">◆</span> current estimate · <span class="mono">◇</span> earlier estimate, joined by a red bar for each slip · <span class="mono">•</span> a row\'s date · the amber line is today.</p>');
  return R.join('');
}

function renderHistory(m, tokens) {
  const B = [];
  B.push('<nav class="bar" aria-label="Contents"><a href="index.html">Front page</a><a href="#app-a">A · Document info</a><a href="#app-g">G · Roadmap detail</a><a href="#app-j">J · Chapters</a><a href="#app-r">Research library</a><a href="#app-files">History files</a></nav><main>');
  B.push('<p class="banner prose"><b>Not needed for a first read.</b> The front page is the one current view; this page keeps the history and the evidence behind it, so every old link still lands. <a href="index.html">Back to the front page</a></p>');
  B.push(`<h2 id="app-a">A · Document info</h2><ul><li><b>The as-of date:</b> ${esc(m.asOf)}; its test fails when it is more than 7 days behind the newest merged change.</li><li><b>Built from:</b> main at <code>${esc(m.commit)}</code>${m.builtAt ? `, ${esc(fmtTime(m.builtAt))}` : ''}.</li><li><b>Notes on the repo copy:</b> the phone view, <code>docs/blueprint/BLUEPRINT.md</code>, is generated from the same fact files; these pages are built, not saved in the repo.</li><li><b>Version, adoption, update rules:</b> <span class="ph">(hand-written; ${NOT_YET})</span></li></ul>`);
  B.push('<h2 id="app-g">G · Roadmap detail: every slip, newest first</h2>');
  const slips = [];
  for (const ms of m.milestones) for (const sl of ms.slips) slips.push({ ms, sl, date: str(sl?.date), id: str(ms.id) });
  slips.sort(byDateThenId).reverse();
  B.push(slips.length ? htable(['Recorded', 'Milestone', 'From', 'To', 'Reason'],
    slips.map(({ ms, sl }) => [esc(fmtDay(sl?.date)) || NOT_IN_DATA, `${rid(ms.id)} ${esc(ms.name)}`, esc(fmtDay(sl?.from)), esc(fmtDay(sl?.to)), esc(sl?.reason)])) : '<p>No slips recorded.</p>');
  B.push('<p class="prose">The decisions log: <span class="ph">(kept in the decision log; not in the fact files)</span></p>');
  B.push('<h2 id="app-j">J · Chapters and where the detail lives</h2>');
  B.push(m.chapters.length ? htable(['Chapter', 'Path'], m.chapters.map((c) => [esc(c.name), `<code>${esc(c.path)}</code>`])) : '<p>No chapters listed.</p>');
  B.push('<p class="prose">Where a file disagrees with the front page, the front page wins.</p>');
  B.push('<h2 id="app-r">Research library (never deleted)</h2>', researchTable(m));
  B.push('<h2 id="app-files">Hand-written history and archive files</h2>');
  B.push(m.history.length ? `<ul>${m.history.map((f) => `<li><code>docs/blueprint/history/${esc(f)}</code></li>`).join('')}</ul>` : '<p>None yet.</p>');
  B.push('<p class="prose">Frozen blocks and the other appendices (status log, scorecard, glossary, corrections, changelog) live in those files, word for word.</p>');
  B.push(`<footer>Generated from the fact files as of ${esc(m.asOf)}, built from <code>${esc(m.commit)}</code>.</footer></main>`);
  return htmlPage(m, tokens, `${m.title}: History & evidence`, B.join('\n'));
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts.root, 'docs', 'blueprint'))) setupError(`no docs/blueprint/ under ${opts.root}`);
  const data = loadData(opts.root);
  const tokens = readTokens();
  const model = buildModel(data, opts);
  // Render everything first, then write: a failure leaves the old pages in place, never half a page.
  const phone = renderPhone(model);
  const index = renderIndex(model, tokens);
  const history = renderHistory(model, tokens);
  fs.writeFileSync(path.join(opts.root, 'docs', 'blueprint', 'BLUEPRINT.md'), phone);
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, 'index.html'), index);
  fs.writeFileSync(path.join(opts.out, 'history.html'), history);
  console.log(`render-blueprint: wrote docs/blueprint/BLUEPRINT.md, ${path.join(opts.out, 'index.html')} and history.html (as of ${model.asOf}, built from ${model.commit}${model.stale ? '; stamp stale → red header' : ''})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
