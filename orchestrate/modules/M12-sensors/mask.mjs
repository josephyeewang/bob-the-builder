// mask.mjs — secret masking for every fact the Sensors write into the record (R-0b-125, design v3 Module 7, v4 §9.2 M12).
//
// WHY. The record, the repo-history file and fix cards carry outside text (log lines, commit messages, check output),
// and the Lead and the Front Door read the record. A key that lands there is a key every reader holds. Masking
// happens here, once, before anything is written, so no other module handles raw outside text.
//
// TWO LAYERS.
//   1. Exact values (ported from Archon `packages/paths/src/credential-redaction.ts`, MIT, commit f3179dc, as-is in
//      behaviour): the credential values in the Sensors' own environment (secret-named keys, DATABASE_URL, any key or
//      value the caller names) are replaced wherever they appear, even without their name. Longest first.
//   2. Known shapes: GitHub, Vercel, Supabase, Anthropic and other `sk-` keys, JWTs, Bearer headers, passwords inside
//      connection addresses, any value after a secret-sounding name, and generic high-entropy strings.
//
// NOT A SECRET (review-0b-7 M5). Commit SHAs, sha256 hashes, UUIDs and IDs with a known prefix (dpl_, prj_, team_) are
// never matched by the generic rule; they are masked only when a secret-sounding name sits right before them. Typed
// fields of a fact (sha, *_sha, id, uid, *_id, ts, *_at, created) are never masked by maskDeep at all: approval binding,
// the history file and the watchers' dedup all depend on them being exact. RESIDUAL, said plainly: a bare hex secret, or
// a bare 24-character Vercel classic token, with no name beside it is caught only if its exact value is known (layer 1).
// The Vercel prefixed-token shape (`vc?_`) is assumed from public examples, not checked against a live key
// (29 Oct 2026); Vercel's older 24-character tokens are caught by the name, flag and Bearer rules instead.

// ── Layer 1: Archon's exact-value redaction (port) ──
const CREDENTIAL_ENV_KEY_SUFFIX = /(?:TOKEN|KEY|SECRET|PASSWORD)$/i;
const CREDENTIAL_ENV_KEYS = new Set(['DATABASE_URL']);
// Ours, not Archon's: an exact value shorter than this is not masked (FEATURE_KEY=1 would turn every "1" into
// [REDACTED]); short secrets are left to the shape rules (0b-7 audit, minor).
export const MIN_EXACT = 8;

export function collectCredentialValues(env, protectedEnvKeys, protectedCredentialValues) {
  const explicitlyProtected = new Set(protectedEnvKeys);
  const values = Object.entries(env ?? {}).flatMap(([key, value]) =>
    value && (explicitlyProtected.has(key) || CREDENTIAL_ENV_KEYS.has(key) || CREDENTIAL_ENV_KEY_SUFFIX.test(key)) ? [value] : []);
  return [...new Set([...values, ...(protectedCredentialValues ?? [])])]
    .filter((value) => typeof value === 'string' && value.length >= MIN_EXACT)
    .sort((a, b) => b.length - a.length);
}

const GITHUB_INSTALLATION_TOKEN = /\bghs_[A-Za-z0-9]{20,}/g;

export function redactCredentialValues(input, credentialValues) {
  let result = input;
  for (const value of credentialValues) result = result.replaceAll(value, '[REDACTED]');
  return result.replace(GITHUB_INSTALLATION_TOKEN, '[REDACTED]');
}

// ── Layer 2: known shapes ──
// Each rule: kind, a global regex, and which capture group is the secret (0 = the whole match).
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?key)[A-Za-z0-9_.-]*';
const SHAPES = [
  { kind: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{8,}/g, group: 0 },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{8,}/g, group: 0 },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, group: 0 },
  { kind: 'sk-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/g, group: 0 },
  { kind: 'supabase', re: /\bsbp_[A-Za-z0-9]{20,}/g, group: 0 },
  { kind: 'supabase', re: /\bsb_secret_[A-Za-z0-9_-]{12,}/g, group: 0 },
  { kind: 'vercel', re: /\bvc[a-z]_[A-Za-z0-9]{20,}/g, group: 0 },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0 },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, group: 0 },
  { kind: 'bearer', re: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{12,}=*)/g, group: 1 },
  { kind: 'bearer', re: /\bAuthorization:\s*token\s+([A-Za-z0-9_]{20,})/gi, group: 1 },
  { kind: 'flag', re: /--(?:token|password|api-key|secret)(?:=|\s+)("?)([^\s"']{6,})\1/g, group: 2 },
  { kind: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1 },
  { kind: 'named', re: new RegExp(`(?:^|[^A-Za-z0-9_])(${SECRET_NAME})("?\\s*[=:]\\s*)(["']?)([^\\s"',;}]{4,})`, 'gi'), group: 4 },
];

const GENERIC = /[A-Za-z0-9+/_=-]{32,}/g;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// A generic high-entropy run: mixed case and a digit (so never a hex SHA), high entropy, and not a path
// (a run holding '/' together with '-' or '_' mixes two encodings, which no single key format does).
// Things that look random but are identifiers, not secrets.
export function isKnownId(t) {
  return /^[0-9a-f]+$/i.test(t)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
    || /^(?:dpl|prj|team|icfg|env|hook)_[A-Za-z0-9]+$/.test(t);
}

export function looksHighEntropy(s) {
  const t = s.replace(/=+$/, '');
  if (t.length < 32) return false;
  if (isKnownId(t)) return false;
  if (!/[A-Z]/.test(t) || !/[a-z]/.test(t) || !/[0-9]/.test(t)) return false;
  if (t.includes('/') && /[-_]/.test(t)) return false;
  return entropy(t) >= 4.0;
}

function maskShapes(text, hits) {
  let out = text;
  for (const { kind, re, group } of SHAPES) {
    out = out.replace(re, (...m) => {
      const whole = m[0];
      const secret = m[group];
      if (!secret || secret.startsWith('[REDACTED')) return whole;
      hits.push(kind);
      const at = group === 0 ? 0 : whole.lastIndexOf(secret);
      return whole.slice(0, at) + `[REDACTED:${kind}]` + whole.slice(at + secret.length);
    });
  }
  out = out.replace(GENERIC, (run) => {
    if (looksHighEntropy(run)) { hits.push('high-entropy'); return '[REDACTED:high-entropy]'; }
    if (!run.includes('/')) return run;
    // A token at the end of a URL path is taken into one run with the path before it (round 3 M-B): judge each segment.
    return run.split('/').map((seg) => {
      if (!looksHighEntropy(seg)) return seg;
      hits.push('high-entropy');
      return '[REDACTED:high-entropy]';
    }).join('/');
  });
  return out;
}

// A key that names a secret (password, api_key, STRIPE_SECRET_KEY…) masks its whole value, as the "named" rule does
// for the same pair written as text (round 3 M-A; R-0b-125 "any value after a secret-sounding name").
const SECRET_KEY = new RegExp(`^${SECRET_NAME}$`, 'i');
export const isSecretKey = (k) => SECRET_KEY.test(k) || (/^[A-Z0-9_]+$/.test(k) && CREDENTIAL_ENV_KEY_SUFFIX.test(k));

export const TYPED_KEY = /^(?:sha|id|uid|ts|created|[a-z0-9]+(?:_sha|_id|_at))$/;
// A field is exempt only when BOTH its name is typed AND its value has a typed shape (review round 2: outside systems
// put free text under names like `external_id`, so a name alone would let a token through unmasked).
export function isTypedField(key, value) {
  return TYPED_KEY.test(key) && typeof value === 'string' && value.length <= 128
    && (isKnownId(value) || /^\d+$/.test(value) || /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value));
}

// The Sensors' known credential values, gathered once per process from the environment the Sensors run in. That
// environment is the default, so layer 1 is on wherever a masker is made without one (0b-7 audit M-4).
// Tests pass their own planted env; nothing here prints or stores a value.
export function makeMasker({ env = process.env, protectedEnvKeys = [], protectedValues = [] } = {}) {
  const values = collectCredentialValues(env, protectedEnvKeys, protectedValues);
  function maskSecrets(text) {
    if (text === null || text === undefined) return { text: text, hits: [] };
    const hits = [];
    let out = String(text);
    const before = out;
    out = redactCredentialValues(out, values);
    if (out !== before) hits.push('exact-value');
    out = maskShapes(out, hits);
    return { text: out, hits };
  }
  // Every string in a fact, at any depth, keys included (a key name can carry a value too) — except typed fields,
  // whose short, space-free values are identifiers our own code put there.
  function maskDeep(v) {
    if (typeof v === 'string') return maskSecrets(v).text;
    if (Array.isArray(v)) return v.map(maskDeep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        let key = maskSecrets(k).text;
        while (Object.hasOwn(o, key)) key += '~';
        if (isSecretKey(k) && x !== null && x !== undefined && typeof x !== 'object' && !(typeof x === 'string' && x.length < 4) && typeof x !== 'boolean') o[key] = '[REDACTED:named-key]';
        else o[key] = isTypedField(k, x) ? x : maskDeep(x);
      }
      return o;
    }
    return v;
  }
  return Object.freeze({ maskSecrets, maskDeep });
}

// Find credential-like strings without changing anything: the week-of-record scan. Returns [{ kind, at }].
export function findCredentials(text, { env = {}, protectedValues = [] } = {}) {
  const found = [];
  const s = String(text ?? '');
  for (const v of collectCredentialValues(env, [], protectedValues)) { let i = s.indexOf(v); while (i >= 0) { found.push({ kind: 'exact-value', at: i }); i = s.indexOf(v, i + v.length); } }
  for (const { kind, re, group } of SHAPES) {
    for (const m of s.matchAll(re)) { if (m[group] && !m[group].startsWith('[REDACTED')) found.push({ kind, at: m.index }); }
  }
  for (const m of s.matchAll(GENERIC)) {
    if (looksHighEntropy(m[0])) { found.push({ kind: 'high-entropy', at: m.index }); continue; }
    let at = m.index;
    for (const seg of m[0].split('/')) { if (looksHighEntropy(seg)) found.push({ kind: 'high-entropy', at }); at += seg.length + 1; }
  }
  return found;
}

// Scan every string in a whole record (every entity's docs and the diary): the "a week's record finds 0" check.
export function scanRecord(rec, entities, opts = {}) {
  const hits = [];
  const walk = (v, where) => {
    if (typeof v === 'string') { for (const f of findCredentials(v, opts)) hits.push({ ...f, where }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k, `${where}.<key>`); walk(x, `${where}.${k}`); }
  };
  for (const e of entities) for (const d of rec.list(e)) walk(d.doc, `${e}/${d.id}`);
  for (const l of rec.diary({ since: 0 })) walk(l, `diary#${l.seq}`);
  return hits;
}
