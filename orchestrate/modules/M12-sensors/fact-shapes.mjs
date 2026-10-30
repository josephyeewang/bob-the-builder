// fact-shapes.mjs — the allow-list every fact passes before it is written (lead call L25, after 0b-7 audit rounds 5–6).
//
// WHY. Masking by secret-sounding names kept missing new names and shapes (round 5: count-like names; round 6: nested
// values, deploy_key, passphrase). A list of bad words is never finished; a list of known-safe fields is. So every
// fact kind the Sensors and the Ledger write declares its fields here, and only those are stored as written. Every
// other value, at any depth, is masked. Unknown fields keep their (masked) name, so nothing is dropped silently. A
// kind with no shape here keeps only `kind` and `ts`. The name and token masking in mask.mjs still runs over the
// result (facts.mjs) as the second layer.
//
// Field types:
//   'id'    our own identifiers: a number, or up to 128 of letters, digits, space and . _ : / # | @ + -
//   'time'  an ISO time       'count'  a whole number ≥ 0       'num'  any finite number       'bool'  true or false
//   'text'  free text our code wrote or outside text already fenced by cleanOutside; only the second layer masks it
//   { … }   an object with these fields           [shape]   a list of that shape
//   { map: shape }   an object with any keys (each key is masked as text) whose values all have that shape
// null is allowed for every type. A value that doesn't fit its type is masked as 'wrong-shape'.

export const UNKNOWN = '[REDACTED:unknown-field]';
export const WRONG = '[REDACTED:wrong-shape]';
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9 ._:/#|@+-]{0,127}$/;

const alert = { key: 'id', title: 'text', body: 'text', status_text: 'text', status: 'id', since: 'time', last: 'time',
  cleared: 'time', count: 'count', issue: 'count' };
const check = { name: 'text', status: 'id', conclusion: 'id', summary: 'text' };

export const SHAPES = Object.freeze({
  'fact.air-health': { red_count: 'count', checked_at: 'time' },
  'fact.alert': alert,
  'fact.heartbeat-account': { product: 'id', login: 'text' },
  'fact.heartbeat-issue': { product: 'id', issue: 'count' },
  'fact.heartbeat-status': { product: 'id', at: 'time', front_door_reachable: 'bool', signed_in: 'bool', login: 'text', red: ['id'] },
  'fact.idea-issue': { number: 'count', state: 'id', title: 'text', body: 'text' },
  'fact.outside-no-push': { green: 'bool', reason: 'text', at: 'time' },
  'fact.outside-robot-merges': { product: 'id', label: 'id', at: 'time', run_id: 'id', run_at: 'time', green: 'bool',
    last_green_at: 'time', red_runs: 'count', red_since: 'time', latch_reason: 'text', last_red_at: 'time', reason: 'text' },
  'fact.power-source': { at: 'time', source: 'text', ups_present: 'bool', on_ups_power: 'bool', internal_battery: 'bool' },
  'fact.pr': { number: 'count', title: 'text', author: 'text', head_sha: 'id', base: 'text', branch: 'text',
    changed_files: [{ path: 'text', from: 'text', status: 'id', added: 'count', removed: 'count' }],
    diff_summary: { files: 'count', added: 'count', removed: 'count' }, checks_at_head: [check],
    unresolved_threads: [{ author: 'text', body: 'text', path: 'text' }], behind_main: 'count' },
  'fact.prod-watch': { product: 'id', stage: 'id', live: 'id', newest_supported: 'id', env: { map: { key: 'text', print: 'id' } },
    settings: { map: 'id' }, seen: ['id'], baseline: 'bool' },
  'fact.push-request': { idempotency_key: 'id', state: 'id', product: 'id', text: 'text' },
  'fact.signed-out': { product: 'id', signed_out: 'bool', since: 'time' },
  'fact.start-gate-env': { product: 'id', vercel_project: 'id', read_at: 'time', result: 'bool', reason: 'text', both: ['text'] },
  'fact.start-gate-skip': { product: 'id', vercel_project: 'id', read_at: 'time', result: 'bool', reason: 'text', command_sha256: 'id', pinned_sha256: 'id' },
});

// Every string and number at any depth is masked; names are kept (masked as text), so the fact still shows what was there.
function maskUnknown(v, maskText) {
  if (Array.isArray(v)) return v.map((x) => maskUnknown(x, maskText));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [maskText(k), maskUnknown(x, maskText)]));
  if (typeof v === 'string' ? v.length > 0 : typeof v === 'number') return UNKNOWN;
  return v;
}

function fit(shape, v, maskText) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(shape)) return Array.isArray(v) ? v.map((x) => fit(shape[0], x, maskText)) : WRONG;
  if (shape && typeof shape === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return WRONG;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      let key = maskText(k);
      while (Object.hasOwn(out, key)) key += '~';
      const s = shape.map ?? (Object.hasOwn(shape, k) ? shape[k] : undefined);
      out[key] = s === undefined ? maskUnknown(x, maskText) : fit(s, x, maskText);
    }
    return out;
  }
  const ok = shape === 'text' ? typeof v === 'string'
    : shape === 'id' ? (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && ID.test(v))
      : shape === 'time' ? typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v))
        : shape === 'count' ? Number.isInteger(v) && v >= 0
          : shape === 'num' ? typeof v === 'number' && Number.isFinite(v)
            : shape === 'bool' ? typeof v === 'boolean' : false;
  return ok ? v : WRONG;
}

// doc → the doc with every field outside its kind's shape masked. maskText masks a field name (mask.mjs maskSecrets).
export function shapeFact(doc, maskText = (s) => s) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { kind: null, ts: null, value: maskUnknown(doc, maskText) };
  const kind = typeof doc.kind === 'string' && Object.hasOwn(SHAPES, doc.kind) ? doc.kind : null;
  const shape = { ...(kind ? SHAPES[kind] : {}), kind: 'id', ts: 'time' };
  const out = fit(shape, doc, maskText);
  if (!kind && typeof doc.kind === 'string' && ID.test(doc.kind)) out.kind = doc.kind;
  return out;
}
