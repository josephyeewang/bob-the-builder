// L151 class rule: a kind may be `pending` (stored, nothing reads it yet) only if no text shown to Joe for it promises
// an action. If the shown text promises something nothing performs, the kind stays refused until its consumer lands.
// The shown texts are the Front Door skill's quoted replies in each section that writes the kind, and the M1 intake
// push for it (the "Confirmed: …" line). A plant that turns state- or request- back to pending goes red here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_KINDS } from './record.mjs';
import { namesKind } from './kinds.test-helper.mjs';
import { intakePush } from '../modules/M1-front-door/outbox.mjs';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ORCH, 'modules/M1-front-door/skill/orchestrate/SKILL.md');

// Words that promise something happens to a product, a key or the owner's day.
const ACTION = /\b(pause[sd]?|away|resum(e|es|ed)|rotat(e|es|ed)|wrap(s|ped)? up|undo(ne)?|brings? it back|trip brief|steps|research|start(s|ed)?|opens?|runs?)\b/i;

// The quoted replies in each skill section (## heading to the next) that writes the kind, heading line left out.
export function skillTexts(k, skill = readFileSync(SKILL, 'utf8')) {
  const out = [];
  for (const section of skill.split(/^(?=## )/m)) {
    const body = section.split('\n').slice(1).join('\n');
    if (!namesKind(body.replace(/`/g, ' '), k)) continue;
    for (const m of body.matchAll(/"([^"\n]+)"/g)) if (/^(Filed|Confirmed|Request taken|Not filed)\b/.test(m[1].replace(/\*/g, ''))) out.push(m[1]);
    // A sentence right after the reply is shown too ("Only the owner's tap brings it back.").
    for (const m of body.matchAll(/^Reply: [^\n]*?"\s*([^"\n]+)$/gm)) out.push(m[1]);
  }
  return out;
}

// What the M1 intake pushes for a taken-in Front Door file of this kind.
const DOCS = [{ product: 'app', state: 'paused' }, { product: 'app', state: 'away', tz: 'Europe/Prague' }, { request: 'resume', product: 'app' }, { request: 'wrapup' }, { request: 'rotate', name: 'K' }];
export function pushTexts(k) {
  if (!OUTBOX_KINDS[k]?.roles.includes('front_door')) return [];
  const ok = (doc) => ({ ok: true, kind: k.slice(0, -1), id: 'X-1', doc, checked: { products: true, seenIds: true } });
  return [...new Set(DOCS.map((d) => intakePush(`${k}X-1.json`, ok(d))))];
}

// A "Not filed: … isn't available … yet" line denies the action, so it is never a promise (lane 3's L151 wording).
export const NOT_AVAILABLE = /^Not filed: .+ isn't available from the Front Door yet\./;
const promising = (t) => !/^Not filed\b/.test(t.replace(/\*/g, '')) && ACTION.test(t);
export const promises = (k, skill) => [...skillTexts(k, skill), ...pushTexts(k)].filter(promising);

test('L151: no text shown to Joe for a pending kind promises an action', () => {
  const pending = Object.entries(OUTBOX_KINDS).filter(([, s]) => s.pending !== undefined).map(([k]) => k);
  assert.ok(pending.includes('idea-'), 'idea- is pending');
  for (const k of pending) assert.deepEqual(promises(k), [], k);
  // The scan is not empty: idea-'s replies are read, and say only that it was filed.
  assert.ok(skillTexts('idea-').some((t) => /^Filed: idea/.test(t.replace(/\*/g, ''))), 'the idea- reply is read');
  assert.ok(pushTexts('idea-').some((t) => /^Confirmed: idea/.test(t)), 'the idea- push is read');
});

test('L151 M-1: a refused kind is refused because its shown text promises an action, or says it is not available', () => {
  for (const k of ['state-', 'request-']) {
    assert.equal(OUTBOX_KINDS[k].entity, null, k);
    const shown = pushTexts(k);
    assert.ok(shown.length > 0, `${k}: the intake push is read`);
    // Today's wording promises (so pending would be wrong); lane 3's says "not available" (so nothing is promised).
    for (const t of shown) assert.ok(promising(t) || NOT_AVAILABLE.test(t), `${k}: "${t}" neither promises nor says it is not available`);
  }
});

test('L151: the scan catches a promise and lets a "not available" line through (plants on the text itself)', () => {
  const skill = (reply) => `## Pause\n\nWrite \`state-<id>.json\`.\nReply: "${reply}"\n`;
  assert.deepEqual(promises('idea-', skill('Filed: pause X. The Mini confirms in a minute.')).filter((t) => /pause X/.test(t)), [], 'a state- section is not an idea- text');
  assert.deepEqual(skillTexts('state-', skill('Filed: pause X. The Mini confirms in a minute.')), ['Filed: pause X. The Mini confirms in a minute.']);
  assert.ok(promising('Filed: pause X. The Mini confirms in a minute.'));
  assert.ok(promising('Confirmed: pause app. Only your tap brings it back.'));
  assert.ok(promising('Request taken: rotate K. The key is NOT rotated yet; the steps follow.'));
  assert.equal(promising("Not filed: pausing app isn't available from the Front Door yet. Nothing changed."), false);
  assert.ok(NOT_AVAILABLE.test("Not filed: rotating K isn't available from the Front Door yet. The key is NOT rotated."));
  // A shown line for idea- that promised an action would go red.
  const planted = readFileSync(SKILL, 'utf8').replace(/"\*{0,2}Filed: idea <id>[^"]*"/, '"Filed: idea <id>. The Lead starts on it tonight."');
  assert.ok(promises('idea-', planted).length > 0, 'a planted promise in the idea- reply is caught');
});
