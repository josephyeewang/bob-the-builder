// readback.mjs — the phone-side read-back check for R-0b-81 (review-0b-8 MAT-5).
//
// From the phone, Joe asks the Front Door to read back its set-up; the reply carries one JSON object
// { tools, skills, mcp_servers, plugins, connectors, setting_sources }. This checks it against the role profile PASSED IN
// (lane 1's roles/front_door.json): M1 holds no tool list of its own. EndConversation is always tolerated (Claude Code
// adds it to every session). Settings sources must be exactly machine-wide and --settings ("managed" and "flag" in the
// start message), so no project or personal settings were loaded. Lane 2's launch read-back checker replaces this at
// the join (join item); until then the two must agree.

export const ALWAYS_TOLERATED = Object.freeze(['EndConversation']);
export const SETTING_SOURCES = Object.freeze(['flag', 'managed']);

// An entry that is not a name (a string, or an object with a string name) makes the whole list unreadable, never
// silently dropped (0b-8 audit round 2 M-4).
const name = (x) => (typeof x === 'string' ? x : typeof x?.name === 'string' ? x.name : null);
const list = (v) => (Array.isArray(v) && v.every((x) => name(x) !== null) ? v.map(name) : null);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// The reply's one read-back object: exactly one top-level {...} in it that parses as JSON (a ```json fence is fine).
// Two objects (say "expected" and "actual") or none → null, never a guess at which one (round 2 minor 11).
const topLevelSpans = (s) => {
  const spans = []; let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === '{') { if (depth++ === 0) start = k; }
    else if (c === '}' && depth > 0 && --depth === 0) spans.push(s.slice(start, k + 1));
  }
  return spans;
};
export function extractReadback(reply) {
  if (reply && typeof reply === 'object') return reply;
  const parse = (t) => { try { const o = JSON.parse(t); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  const objs = topLevelSpans(String(reply ?? '')).map(parse).filter(Boolean);
  return objs.length === 1 ? objs[0] : null;
}

export function checkPhoneReadback(reply, profile) {
  if (!profile || !Array.isArray(profile.tools)) return { ok: false, problems: ['no role profile given'] };
  const r = extractReadback(reply);
  if (!r) return { ok: false, problems: ['no read-back object in the reply'] };
  const problems = [];
  const tools = list(r.tools);
  if (!tools) problems.push('tools: missing or unreadable');
  else if (!same(tools.filter((t) => !ALWAYS_TOLERATED.includes(t)), profile.tools)) problems.push(`tools differ: got ${tools.join(', ')}; role has ${profile.tools.join(', ')}`);
  const skills = list(r.skills);
  if (!skills) problems.push('skills: missing or unreadable');
  else if (!same(skills, profile.skills ?? [])) problems.push(`skills differ: got ${skills.join(', ') || 'none'}; role has ${(profile.skills ?? []).join(', ')}`);
  for (const k of ['mcp_servers', 'plugins', 'connectors']) {
    const v = list(r[k]);
    if (!v) problems.push(`${k}: missing or unreadable (an empty list of names is required)`);
    else if (v.length) problems.push(`${k} loaded: ${v.join(', ')}`);
  }
  const src = list(r.setting_sources);
  if (!src) problems.push('setting_sources: missing');
  else if (!same(src, SETTING_SOURCES)) problems.push(`settings sources are ${src.join(', ') || 'none'}; want machine-wide + --settings only`);
  return { ok: problems.length === 0, problems };
}
